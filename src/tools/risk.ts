import { poolFor } from './pools.js';

/**
 * Inspeciona e zera o estado do antifraude.
 *
 * Existe por uma razao pratica: as demonstracoes precisam ser repetiveis. Sem
 * um `reset`, a segunda execucao dos cenarios encontra o dispositivo da familia
 * com oito contas em vez de quatro, e o falso positivo vira verdadeiro — nao
 * porque o sistema errou, mas porque o palco nao foi limpo.
 *
 * O reset apaga eventos, evidencias e scores, e NAO toca em pesos, limiar nem
 * historico de quarentena: configuracao e auditoria sobrevivem a uma limpeza de
 * dados de demonstracao.
 */

const pool = poolFor('riskshield');

async function relatorio(): Promise<void> {
  const { rows: flags } = await pool.query<{ name: string; enabled: boolean; weight: number }>(
    `SELECT name, enabled, weight FROM rule_flags ORDER BY weight DESC, name`,
  );
  const { rows: settings } = await pool.query<{ key: string; value: string }>(
    `SELECT key, value FROM settings ORDER BY key`,
  );
  const { rows: stats } = await pool.query<{
    compradores: number;
    quarentenados: number;
    eventos: number;
    evidencias: number;
    dead_letters: number;
  }>(
    `SELECT
       (SELECT count(*)::int FROM buyer_risk_summary) AS compradores,
       (SELECT count(*)::int FROM buyer_risk_summary WHERE status = 'QUARANTINED') AS quarentenados,
       (SELECT count(*)::int FROM risk_events) AS eventos,
       (SELECT count(*)::int FROM risk_evidence) AS evidencias,
       (SELECT count(*)::int FROM dead_letters) AS dead_letters`,
  );
  const { rows: topo } = await pool.query<{
    buyer_id: string;
    score: number;
    status: string;
    top_factors: { explanation: string }[];
  }>(
    `SELECT buyer_id, score, status, top_factors FROM buyer_risk_summary
      ORDER BY score DESC, updated_at DESC LIMIT 10`,
  );

  const limiar = Number(settings.find((s) => s.key === 'quarantine_threshold')?.value ?? 70);
  const somaPesos = flags.filter((f) => f.enabled).reduce((a, f) => a + Number(f.weight), 0);
  const maior = Math.max(...flags.filter((f) => f.enabled).map((f) => Number(f.weight)), 0);
  const menorPar = flags
    .filter((f) => f.enabled)
    .map((f) => Number(f.weight))
    .sort((a, b) => a - b)
    .slice(0, 2)
    .reduce((a, b) => a + b, 0);

  console.log('\n  RISK-SHIELD — configuracao vigente');
  console.log('  ' + '='.repeat(72));
  console.log('\n  Regras');
  for (const f of flags) {
    console.log(
      `    ${f.enabled ? 'on ' : 'off'}  ${f.name.padEnd(22)} peso ${String(f.weight).padStart(3)}`,
    );
  }
  console.log('\n  Configuracoes');
  for (const s of settings) console.log(`         ${s.key.padEnd(22)} ${s.value}`);

  console.log('\n  Propriedade do modelo');
  console.log(`         limiar de quarentena ....... ${limiar}`);
  console.log(
    `         maior peso isolado ......... ${maior}  ` +
      `(${maior >= limiar ? 'ATENCAO: um fator sozinho quarentena' : 'ok, nenhum fator age sozinho'})`,
  );
  console.log(
    `         menor par de pesos ......... ${menorPar}  ` +
      `(${menorPar >= limiar ? 'ok, dois fatores quaisquer quarentenam' : 'ATENCAO: dois fatores nao bastam'})`,
  );
  console.log(`         soma dos pesos ativos ...... ${somaPesos}  (score limitado a 100)`);

  const s = stats[0];
  console.log('\n  Estado');
  console.log(`         compradores avaliados ...... ${s.compradores}`);
  console.log(`         em quarentena .............. ${s.quarentenados}`);
  console.log(`         eventos processados ........ ${s.eventos}`);
  console.log(`         evidencias registradas ..... ${s.evidencias}`);
  console.log(`         dead letters ............... ${s.dead_letters}`);

  if (topo.length > 0) {
    console.log('\n  Maiores scores');
    for (const b of topo) {
      console.log(
        `    ${String(Number(b.score).toFixed(1)).padStart(6)}  ` +
          `${b.status === 'QUARANTINED' ? 'QUARENTENA' : 'livre     '}  ${b.buyer_id}`,
      );
      const motivo = b.top_factors?.[0]?.explanation;
      if (motivo) console.log(`            ${motivo}`);
    }
  }
  console.log('');
}

/**
 * Zera o estado do antifraude, com espera e retentativa.
 *
 * `TRUNCATE` exige lock exclusivo nas tabelas, e o worker esta escrevendo nelas
 * o tempo todo — cada mensagem abre uma transacao que grava evento, evidencia e
 * projecao. Sem cuidado, a limpeza e o consumo se travam mutuamente e o
 * PostgreSQL mata um dos dois com `deadlock detected`.
 *
 * Foi exatamente o que aconteceu ao encadear `risk-reset` antes de uma rodada
 * de carga: o reset morria, o `make` abortava, e a carga seguinte reaproveitava
 * o sumario antigo em silencio — duas rodadas "diferentes" com numeros
 * identicos ate o ultimo digito.
 *
 * A correcao e a que se aplica a qualquer manutencao concorrente com trafego
 * vivo: limitar quanto tempo se espera pelo lock e tentar de novo, em vez de
 * insistir ou desistir.
 */
async function reset(): Promise<void> {
  const TENTATIVAS = 8;

  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa++) {
    const client = await pool.connect();
    try {
      // Sem isto, o TRUNCATE fica na fila do lock indefinidamente e vira o lado
      // perdedor de um deadlock em vez de simplesmente esperar a sua vez.
      await client.query(`SET lock_timeout = '2s'`);
      await client.query('BEGIN');
      // Ordem importa: `processed_events` por ultimo garante que uma reentrega
      // que chegue no meio da limpeza ainda seja tratada como duplicata, em vez
      // de ressuscitar um score meio apagado.
      await client.query(
        `TRUNCATE risk_evidence, risk_events, buyer_risk_summary, dead_letters, processed_events`,
      );
      await client.query('COMMIT');
      console.log('\n  antifraude zerado: eventos, evidencias e scores apagados');
      console.log('  pesos, limiar e historico de quarentena preservados\n');
      return;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      const msg = String(err);
      const contencao = /deadlock detected|lock timeout|canceling statement/i.test(msg);
      if (!contencao || tentativa === TENTATIVAS) throw err;
      const espera = 300 * 2 ** (tentativa - 1);
      console.log(`  banco ocupado pelo worker, nova tentativa em ${espera} ms (${tentativa}/${TENTATIVAS})`);
      await new Promise((r) => setTimeout(r, espera));
    } finally {
      client.release();
    }
  }
}

async function main(): Promise<void> {
  const comando = process.argv[2];
  if (comando === 'reset') await reset();
  else await relatorio();
  await pool.end();
}

main().catch((err) => {
  console.error('falhou:', err instanceof Error ? err.message : err);
  process.exit(1);
});
