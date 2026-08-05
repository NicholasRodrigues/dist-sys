import { readFile, writeFile } from 'node:fs/promises';

/**
 * O grafico central da apresentacao.
 *
 * Le os sumarios das duas rodadas de carga — com e sem fila virtual — e produz
 * a comparacao lado a lado.
 *
 * O resultado a demonstrar e contraintuitivo: admitindo MENOS usuarios por
 * segundo, o sistema conclui MAIS compras. Ele para de gastar capacidade em
 * requisicoes que iam falhar de qualquer forma.
 */

interface K6Summary {
  metrics: Record<string, { values?: Record<string, number>; type?: string }>;
}

async function load(path: string): Promise<K6Summary | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as K6Summary;
  } catch {
    return undefined;
  }
}

function metric(s: K6Summary, name: string, key: string): number {
  return s.metrics[name]?.values?.[key] ?? 0;
}

function fmtMs(v: number): string {
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(0)}ms`;
}

function delta(comFila: number, semFila: number, menorEhMelhor: boolean): string {
  if (semFila === 0) return '—';
  const variacao = ((comFila - semFila) / semFila) * 100;
  const melhorou = menorEhMelhor ? variacao < 0 : variacao > 0;
  const sinal = variacao > 0 ? '+' : '';
  return `${sinal}${variacao.toFixed(1)}%  ${melhorou ? '(melhor)' : '(pior)'}`;
}

async function main(): Promise<void> {
  const dir = process.env.RESULTS_DIR ?? '/resultados';
  const comFila = await load(`${dir}/com-fila.json`);
  const semFila = await load(`${dir}/sem-fila.json`);

  if (!comFila || !semFila) {
    console.error(`
  Faltam resultados para comparar.

  Rode as duas rodadas primeiro:

      make load-without-queue
      make load-with-queue
      make compare
`);
    process.exit(1);
  }

  const linhas: string[] = [];
  const p = (s: string) => {
    linhas.push(s);
    console.log(s);
  };

  p('');
  p('  FILA VIRTUAL: COM E SEM');
  p('  ' + '='.repeat(76));
  p('');
  p(`  ${'metrica'.padEnd(30)} ${'sem fila'.padStart(12)} ${'com fila'.padStart(12)}   diferenca`);
  p('  ' + '-'.repeat(76));

  const comparacoes: [string, number, number, boolean][] = [
    [
      'compras confirmadas',
      metric(comFila, 'compras_confirmadas', 'count'),
      metric(semFila, 'compras_confirmadas', 'count'),
      false,
    ],
    [
      'taxa de sucesso do checkout',
      metric(comFila, 'checkout_sucesso', 'rate') * 100,
      metric(semFila, 'checkout_sucesso', 'rate') * 100,
      false,
    ],
    [
      'erro no checkout (%)',
      metric(comFila, 'http_req_failed{tipo:checkout}', 'rate') * 100,
      metric(semFila, 'http_req_failed{tipo:checkout}', 'rate') * 100,
      true,
    ],
    [
      'p95 do checkout',
      metric(comFila, 'http_req_duration{tipo:checkout}', 'p(95)'),
      metric(semFila, 'http_req_duration{tipo:checkout}', 'p(95)'),
      true,
    ],
    [
      'p99 do checkout',
      metric(comFila, 'http_req_duration{tipo:checkout}', 'p(99)'),
      metric(semFila, 'http_req_duration{tipo:checkout}', 'p(99)'),
      true,
    ],
    [
      'pior caso do checkout',
      metric(comFila, 'http_req_duration{tipo:checkout}', 'max'),
      metric(semFila, 'http_req_duration{tipo:checkout}', 'max'),
      true,
    ],
    [
      'assentos perdidos na disputa',
      metric(comFila, 'assento_indisponivel', 'count'),
      metric(semFila, 'assento_indisponivel', 'count'),
      true,
    ],
  ];

  for (const [nome, com, sem, menorEhMelhor] of comparacoes) {
    const ehTempo = nome.includes('p95') || nome.includes('p99') || nome.includes('pior caso');
    const f = ehTempo ? fmtMs : (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(2));
    p(`  ${nome.padEnd(30)} ${f(sem).padStart(12)} ${f(com).padStart(12)}   ${delta(com, sem, menorEhMelhor)}`);
  }

  p('  ' + '-'.repeat(76));

  const comprasCom = metric(comFila, 'compras_confirmadas', 'count');
  const comprasSem = metric(semFila, 'compras_confirmadas', 'count');
  const p99Com = metric(comFila, 'http_req_duration{tipo:checkout}', 'p(99)');
  const p99Sem = metric(semFila, 'http_req_duration{tipo:checkout}', 'p(99)');
  const esperaFila = metric(comFila, 'espera_na_fila_ms', 'p(95)');

  p('');
  p('  LEITURA');
  p('  ' + '-'.repeat(76));

  const ganhoLatencia = p99Sem > 0 ? p99Sem / Math.max(p99Com, 1) : 1;

  if (ganhoLatencia > 1.5) {
    p('  A fila virtual nao aumenta a capacidade do sistema — ela ESCOLHE o ponto');
    p('  de operacao dele.');
    p('');
    p(`  Sem fila, o sistema roda ALEM do joelho da curva: entrega ${comprasSem} compras,`);
    p(`  mas o checkout chega a ${fmtMs(p99Sem)} no p99 e a leitura do mapa degrada junto.`);
    p(`  A fila de espera continua existindo — ela so esta escondida DENTRO de um`);
    p('  checkout lento, onde o usuario nao entende o que esta acontecendo.');
    p('');
    p(`  Com fila, o mesmo sistema entrega ${comprasCom} compras com p99 de ${fmtMs(p99Com)}:`);
    p(`  ${ganhoLatencia.toFixed(1)}x mais rapido, com a espera movida para um lugar visivel e`);
    p('  comunicado. O trabalho util por segundo e parecido; o que muda e a');
    p('  experiencia e a margem de seguranca.');
    if (comprasSem > comprasCom) {
      p('');
      p(`  A diferenca de ${comprasSem - comprasCom} compras a menos e o preco da taxa de admissao`);
      p('  configurada. Subi-la aproxima as duas vazoes; passar do joelho devolve');
      p('  a latencia ruim. Esse ajuste E a decisao de engenharia que a fila expoe.');
    }
  } else if (comprasCom > comprasSem) {
    p(`  Com a fila, o sistema concluiu ${comprasCom - comprasSem} compra(s) A MAIS, mesmo`);
    p('  admitindo menos gente por segundo: ele parou de gastar capacidade em');
    p('  requisicoes que iam falhar de qualquer forma.');
  } else {
    p(`  Nesta rodada a fila nao mudou o resultado de forma significativa`);
    p(`  (${comprasCom} compras contra ${comprasSem}). Isso acontece quando a carga ainda cabe`);
    p('  no nucleo transacional: sem saturacao, o controle de admissao so');
    p('  acrescenta espera. Suba K6_VUS ate o cenario sem fila degradar.');
  }
  if (esperaFila > 0) {
    p('');
    p(`  O custo da fila esta na espera: p95 de ${fmtMs(esperaFila)} antes de poder comprar.`);
    p('  E o trade-off declarado — pior experiencia percebida em troca de um sistema');
    p('  que nao colapsa. A fila nao torna a compra mais rapida; torna a compra');
    p('  POSSIVEL quando a demanda excede a capacidade do nucleo.');
  }
  p('');

  await writeFile(`${dir}/comparacao.txt`, linhas.join('\n'), 'utf8');
  console.log(`  Comparacao salva em docs/resultados/comparacao.txt\n`);
}

main().catch((err) => {
  console.error('falha ao comparar:', err);
  process.exit(1);
});
