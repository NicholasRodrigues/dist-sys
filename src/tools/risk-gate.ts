import { randomUUID } from 'node:crypto';
import { urls, waitFor } from './pools.js';

/**
 * O portao: prova que a Bilheteria e o Risk-Shield sao de fato um sistema so.
 *
 * O simulador prova que o motor CLASSIFICA bem. Este arquivo prova a outra
 * metade, que e a que interessa para a nota: que a classificacao MUDA o que
 * acontece na venda, e que o acoplamento entre os dois sistemas nao derruba
 * nenhum dos dois.
 *
 * Roda em tres fases porque a pergunta central so pode ser respondida com o
 * antifraude no chao:
 *
 *   normal        antifraude no ar
 *   indisponivel  antifraude parado (`docker compose stop risk-api`)
 *   restaurado    antifraude de volta
 *
 * O Makefile encadeia as tres. O identificador do comprador e fixo de proposito
 * — e o que permite as fases falarem do mesmo sujeito sem carregar estado entre
 * processos.
 */

/**
 * O sujeito das tres fases.
 *
 * Vem do ambiente, e o Makefile gera um valor novo a cada `make risk-gate`.
 * Precisa ser o MESMO nas tres fases (elas sao processos distintos e falam do
 * mesmo comprador) e DIFERENTE entre execucoes — evidencia de risco e
 * append-only, entao um identificador fixo acumularia o historico de todas as
 * rodadas anteriores e a segunda execucao mediria a sujeira da primeira.
 */
const BLOQUEADO = process.env.GATE_BUYER ?? 'gate-quarentenado';
const EVENT_ID = process.env.SMOKE_EVENT_ID ?? 'show-do-seculo';

/**
 * IP e dispositivo proprios por comprador.
 *
 * Todo o trafego de teste sai de um unico contentor. Sem estes cabecalhos, os
 * compradores deste arquivo herdariam o IP compartilhado com o gerador de carga
 * e com os 40 compradores do teste de contencao — e a regra de correlacao os
 * marcaria por associacao com trafego que nao e deles. O cabecalho aqui nao e
 * truque: e a mesma informacao que um proxy reverso real repassa.
 */
function identidade(buyerId: string): Record<string, string> {
  const n = Math.abs([...buyerId].reduce((a, c) => a * 31 + c.charCodeAt(0), 7)) % 200;
  return {
    'x-forwarded-for': `192.0.2.${n}`,
    'x-device-fingerprint': `dev-${buyerId}`,
    'x-payment-hash': `card-${buyerId}`,
  };
}

interface Http<T> {
  status: number;
  body: T;
}

async function http<T = any>(path: string, init: RequestInit & { base?: string } = {}): Promise<Http<T>> {
  const res = await fetch(`${init.base ?? urls.edge}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* mantem texto cru */
  }
  return { status: res.status, body: body as T };
}

// ---------------------------------------------------------------------------

const resultados: { nome: string; ok: boolean; detalhe: string }[] = [];

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

async function check(nome: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detalhe = await fn();
    resultados.push({ nome, ok: true, detalhe });
    console.log(`  OK    ${nome}`);
    if (detalhe) console.log(`        ${detalhe}`);
  } catch (err) {
    const detalhe = err instanceof Error ? err.message : String(err);
    resultados.push({ nome, ok: false, detalhe });
    console.log(`  FALHA ${nome}`);
    console.log(`        ${detalhe}`);
  }
}

// ---------------------------------------------------------------------------

async function modo(valor: 'fail_open' | 'fail_closed' | 'disabled'): Promise<void> {
  const res = await http('/api/admin/flags', {
    method: 'POST',
    body: JSON.stringify({ risk_check_mode: valor }),
  });
  assert(res.status === 200, `nao consegui mudar risk_check_mode: ${res.status}`);
}

async function tokenFor(userId: string): Promise<string> {
  const res = await http<{ token: string }>('/api/auth/token', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  assert(res.status === 200, `esperava 200 no token, veio ${res.status}`);
  return res.body.token;
}

async function admissionFor(buyerId: string): Promise<string | undefined> {
  const joined = await http<{ queueToken: string | null; disabled?: boolean }>('/api/queue/join', {
    method: 'POST',
    headers: identidade(buyerId),
    body: JSON.stringify({ eventId: EVENT_ID }),
  });
  if (joined.body.disabled || !joined.body.queueToken) return undefined;

  const limite = Date.now() + 30_000;
  while (Date.now() < limite) {
    const st = await http<{ admitted: boolean; admissionToken?: string }>(
      `/api/queue/status?eventId=${encodeURIComponent(EVENT_ID)}&token=${joined.body.queueToken}`,
    );
    if (st.body.admitted && st.body.admissionToken) return st.body.admissionToken;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('nao fui admitido pela fila em 30s');
}

interface Compra {
  status: number;
  body: {
    orderId?: string;
    status?: string;
    failureReason?: string | null;
    error?: string;
    reason?: string;
    detail?: string;
    score?: number;
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Tempo de leitura entre abrir o mapa e mandar a compra.
 *
 * Isto NAO e um `sleep` para estabilizar o teste. Sem ele o comprador aperta
 * "comprar" 46 ms depois de abrir o mapa, e o proprio antifraude o quarentena
 * no meio da SAGA — foi exatamente o que aconteceu na primeira execucao deste
 * arquivo. O detector estava certo: um cliente que decide em 46 ms nao e um
 * cliente. Um teste que se chama "comprador legitimo" precisa se comportar
 * como um.
 */
const TEMPO_DE_LEITURA_MS = 1_200;

/**
 * Prepara a compra e devolve o gatilho.
 *
 * A separacao existe para o cenario de quarentena em pleno voo: e preciso poder
 * disparar o POST e agir DURANTE a SAGA, e nao antes dela.
 */
async function prepararCompra(buyerId: string): Promise<() => Promise<Compra>> {
  const token = await tokenFor(buyerId);
  const admission = await admissionFor(buyerId);
  const ident = identidade(buyerId);

  await http(`/api/events/${EVENT_ID}/seatmap?section=PISTA-1`, {
    headers: { ...ident, authorization: `Bearer ${token}` },
  });

  const seat = await http<{ seatId: string }>(`/api/events/${EVENT_ID}/available-seat`);
  assert(seat.status === 200, `nenhum assento livre (${seat.status})`);

  await sleep(TEMPO_DE_LEITURA_MS);

  return () =>
    http('/api/orders', {
      method: 'POST',
      headers: {
        ...ident,
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
        ...(admission ? { 'x-admission-token': admission } : {}),
      },
      body: JSON.stringify({ eventId: EVENT_ID, seatId: seat.body.seatId }),
    });
}

/** Uma compra como um cliente de verdade faz: abre o mapa, le, e so entao decide. */
async function comprar(buyerId: string): Promise<Compra> {
  const disparar = await prepararCompra(buyerId);
  return disparar();
}

/** Latencia artificial no PSP, para abrir uma janela dentro da SAGA. */
async function pspLatencia(ms: number): Promise<void> {
  await http('/admin/config', {
    base: urls.psp,
    method: 'POST',
    body: JSON.stringify({ latencyMs: ms }),
  });
}

async function quarentenar(buyerId: string, motivo: string): Promise<void> {
  const res = await http(`/risk/buyers/${encodeURIComponent(buyerId)}/quarantine`, {
    base: urls.riskApi,
    method: 'POST',
    body: JSON.stringify({ reason: motivo, actor: 'teste-de-integracao' }),
  });
  assert(res.status === 200, `quarentena manual falhou: ${res.status}`);
}

async function liberar(buyerId: string): Promise<number> {
  const res = await http(`/risk/buyers/${encodeURIComponent(buyerId)}/release`, {
    base: urls.riskApi,
    method: 'POST',
    body: JSON.stringify({ reason: 'fim do teste', actor: 'teste-de-integracao' }),
  });
  return res.status;
}

// ---------------------------------------------------------------------------

async function faseNormal(): Promise<void> {
  console.log('\n  FASE 1 — antifraude no ar\n');
  await waitFor(`${urls.edge}/health`, 'edge');
  await waitFor(`${urls.riskApi}/health`, 'risk-api');
  await waitFor(`${urls.riskEventApi}/health`, 'risk-event-api');
  await modo('fail_open');
  await liberar(BLOQUEADO);

  const livre = `gate-livre-${randomUUID().slice(0, 8)}`;

  await check('um comprador sem historico compra normalmente', async () => {
    const res = await comprar(livre);
    assert(res.status === 201, `esperava 201, veio ${res.status}: ${JSON.stringify(res.body)}`);
    return `pedido ${res.body.orderId?.slice(0, 8)} confirmado`;
  });

  await check('a compra alimenta o antifraude pelo caminho assincrono', async () => {
    // Prova o desacoplamento: a Bilheteria nao esperou por nada, mas o evento
    // chegou. Se este teste falhar, o barramento entre os dois esta quebrado.
    const limite = Date.now() + 20_000;
    while (Date.now() < limite) {
      const r = await http<{ eventsSeen: number }>(
        `/risk/status/${encodeURIComponent(livre)}`,
        { base: urls.riskApi },
      );
      if (r.body.eventsSeen >= 3) return `${r.body.eventsSeen} eventos de comportamento registrados`;
      await new Promise((r2) => setTimeout(r2, 400));
    }
    throw new Error('os eventos da compra nao chegaram ao Risk-Shield em 20s');
  });

  await check('um comprador em quarentena e barrado no checkout com o motivo', async () => {
    await quarentenar(BLOQUEADO, 'bloqueio para o teste de integracao');
    const res = await comprar(BLOQUEADO);
    assert(res.status === 403, `esperava 403, veio ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.reason === 'quarantined', `motivo veio como ${res.body.reason}`);
    assert(typeof res.body.detail === 'string' && res.body.detail.length > 0, 'sem explicacao');
    return `HTTP 403 — ${res.body.detail}`;
  });

  await check('a quarentena nao consome assento nem gera pedido', async () => {
    // O bloqueio acontece ANTES da SAGA. Se o pedido fosse criado e depois
    // cancelado, cada tentativa de um cambista prenderia um assento por alguns
    // segundos — negacao de servico de graca.
    const res = await http<{ orders: unknown[] }>('/api/me/orders', {
      headers: { authorization: `Bearer ${await tokenFor(BLOQUEADO)}` },
    });
    assert(res.status === 200, `esperava 200, veio ${res.status}`);
    assert(res.body.orders.length === 0, `criou ${res.body.orders.length} pedido(s)`);
    return 'nenhum pedido criado';
  });

  await check('modo disabled: o portao sai do caminho sem mexer no score', async () => {
    await modo('disabled');
    const res = await comprar(BLOQUEADO);
    assert(res.status === 201, `esperava 201, veio ${res.status}: ${JSON.stringify(res.body)}`);
    const risco = await http<{ status: string }>(
      `/risk/status/${encodeURIComponent(BLOQUEADO)}`,
      { base: urls.riskApi },
    );
    assert(risco.body.status === 'QUARANTINED', 'a flag apagou a quarentena, e nao deveria');
    return 'vendeu com o comprador ainda em quarentena: a flag desliga a CONSULTA, nao a marcacao';
  });

  await check('liberacao manual devolve o direito de comprar', async () => {
    await modo('fail_open');
    const status = await liberar(BLOQUEADO);
    assert(status === 200, `liberacao devolveu ${status}`);
    const res = await comprar(BLOQUEADO);
    assert(res.status === 201, `esperava 201, veio ${res.status}: ${JSON.stringify(res.body)}`);
    return 'HTTP 201 apos a liberacao pelo painel';
  });

  await check('quarentena em pleno voo: a SAGA compensa com estorno', async () => {
    // O caso que justifica o passo de risco DENTRO da SAGA, e nao so um
    // porteiro na entrada. A borda olha uma vez, no comeco; uma compra pode
    // durar segundos, e a decisao pode mudar no meio.
    //
    // A janela e aberta de proposito: 2 segundos de latencia no PSP, e a
    // quarentena entra no meio dela. Quando a SAGA sai da cobranca, o dinheiro
    // ja foi capturado — entao a unica compensacao possivel e o estorno, que e
    // justamente o caminho caro que se quer ver funcionando.
    //
    // 2 segundos, e nao mais: o `payments` desiste do PSP em 4 s. Com latencia
    // maior a cobranca falharia por timeout e a SAGA compensaria pelo motivo
    // errado — o teste passaria a medir o PSP lento em vez do antifraude.
    const alvo = `gate-voo-${randomUUID().slice(0, 8)}`;
    await pspLatencia(2_000);
    try {
      const disparar = await prepararCompra(alvo);
      const emVoo = disparar();
      await sleep(1_500);
      await quarentenar(alvo, 'marcado enquanto a compra acontecia');
      const res = await emVoo;
      assert(res.body.orderId, `sem pedido: ${JSON.stringify(res.body)}`);

      // A SAGA e assincrona. Com o PSP lento, a resposta HTTP volta com o
      // pedido ainda em RESERVED e o varredor termina o trabalho — que e
      // exatamente o comportamento desejado, e por isso o teste espera o estado
      // terminal em vez de presumir que o POST resolve tudo.
      const token = await tokenFor(alvo);
      const auth = { authorization: `Bearer ${token}` };
      let final = res.body;
      const limite = Date.now() + 40_000;
      while (Date.now() < limite && final.status !== 'FAILED' && final.status !== 'CONFIRMED') {
        await sleep(500);
        const atual = await http<Compra['body']>(`/api/orders/${res.body.orderId}`, { headers: auth });
        final = atual.body;
      }

      assert(final.status === 'FAILED', `pedido terminou como ${final.status}`);
      assert(
        (final.failureReason ?? '').includes('antifraude'),
        `motivo do cancelamento: ${final.failureReason}`,
      );

      const saga = await http<{ steps: { step: string; outcome: string }[] }>(
        `/api/orders/${res.body.orderId}/saga`,
        { headers: auth },
      );
      const passos = saga.body.steps ?? [];
      const marcou = passos.some((s) => s.step === 'risk.post-payment' && s.outcome === 'quarantined');
      const estornou = passos.some((s) => s.step === 'compensate.refund' && s.outcome === 'ok');
      const liberou = passos.some((s) => s.step === 'compensate.release' && s.outcome === 'ok');

      assert(marcou, `sem passo risk.post-payment: ${passos.map((s) => s.step).join(', ')}`);
      assert(estornou, `sem estorno: ${passos.map((s) => `${s.step}=${s.outcome}`).join(', ')}`);
      assert(liberou, 'o assento nao foi devolvido ao estoque');

      await liberar(alvo);
      return 'pagamento capturado, quarentena aplicada, estorno emitido e assento devolvido';
    } finally {
      await pspLatencia(0);
    }
  });

  await check('deixa o comprador em quarentena para a proxima fase', async () => {
    await quarentenar(BLOQUEADO, 'preparacao da fase de indisponibilidade');
    return `${BLOQUEADO} em quarentena`;
  });
}

async function faseIndisponivel(): Promise<void> {
  console.log('\n  FASE 2 — antifraude fora do ar\n');
  console.log('  A pergunta que nao tem resposta tecnica: se o antifraude cai,');
  console.log('  a venda para? E decisao de produto, e por isso mora numa flag.\n');

  await check('fail_open: a venda continua, e a deteccao e que se perde', async () => {
    await modo('fail_open');
    const res = await comprar(BLOQUEADO);
    assert(res.status === 201, `esperava 201, veio ${res.status}: ${JSON.stringify(res.body)}`);
    return 'vendeu para um comprador em quarentena — prefere-se perder deteccao a perder receita';
  });

  await check('fail_closed: o checkout e bloqueado ate o antifraude voltar', async () => {
    await modo('fail_closed');
    const res = await comprar(BLOQUEADO);
    assert(res.status === 403, `esperava 403, veio ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.reason === 'fail-closed', `motivo veio como ${res.body.reason}`);
    return `HTTP 403 — ${res.body.detail}`;
  });

  await check('a decisao muda em tempo de execucao, sem reiniciar nada', async () => {
    await modo('fail_open');
    const aberto = await comprar(BLOQUEADO);
    await modo('fail_closed');
    const fechado = await comprar(BLOQUEADO);
    await modo('fail_open');
    assert(aberto.status === 201 && fechado.status === 403, `${aberto.status} e depois ${fechado.status}`);
    return 'mesma instancia, mesma versao, comportamento oposto conforme a flag';
  });

  await check('o circuit breaker impede que fail_open vire espera por timeout', async () => {
    // Sem breaker, "seguir em frente" custaria o timeout inteiro da consulta
    // (1200 ms, mais uma retentativa) em CADA checkout.
    //
    // A medicao cobre so o POST: incluir a preparacao mediria o tempo de
    // leitura simulado, e nao a dependencia no chao.
    const disparar = await prepararCompra(BLOQUEADO);
    const inicio = Date.now();
    const res = await disparar();
    const ms = Date.now() - inicio;
    assert(res.status === 201, `esperava 201, veio ${res.status}`);
    assert(ms < 1_200, `o checkout levou ${ms} ms: o breaker nao esta absorvendo a falha`);
    return `checkout completo em ${ms} ms com a dependencia no chao`;
  });
}

async function faseRestaurada(): Promise<void> {
  console.log('\n  FASE 3 — antifraude de volta\n');
  await waitFor(`${urls.riskApi}/health`, 'risk-api');
  await modo('fail_open');

  await check('a quarentena sobreviveu a indisponibilidade', async () => {
    // O estado vive no banco do Risk-Shield, nao na memoria de quem consulta.
    const res = await comprar(BLOQUEADO);
    assert(res.status === 403, `esperava 403, veio ${res.status}: ${JSON.stringify(res.body)}`);
    return `HTTP 403 — ${res.body.detail}`;
  });

  await check('o breaker fecha sozinho quando a dependencia volta', async () => {
    const risco = await http<{ status: string }>(
      `/risk/status/${encodeURIComponent(BLOQUEADO)}`,
      { base: urls.riskApi },
    );
    assert(risco.status === 200, `risk-api respondeu ${risco.status}`);
    return 'consultas voltaram a ser atendidas sem intervencao';
  });

  await check('limpa o estado do teste', async () => {
    await liberar(BLOQUEADO);
    await modo('fail_open');
    return 'comprador liberado, risk_check_mode=fail_open';
  });
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const fase = process.argv[2] ?? 'normal';

  if (fase === 'normal') {
    console.log('\n  PORTAO ANTIFRAUDE — integracao Bilheteria x Risk-Shield');
    console.log('  ' + '='.repeat(72));
    await faseNormal();
  } else if (fase === 'indisponivel') {
    await faseIndisponivel();
  } else if (fase === 'restaurado') {
    await faseRestaurada();
  } else {
    throw new Error(`fase desconhecida: ${fase}`);
  }

  const falhas = resultados.filter((r) => !r.ok);
  console.log(`\n  ${resultados.length - falhas.length}/${resultados.length} verificacoes da fase "${fase}"`);
  if (falhas.length > 0) {
    console.log('\n  Falhas:');
    for (const f of falhas) console.log(`   - ${f.nome}: ${f.detalhe}`);
    console.log('');
    process.exit(1);
  }
  console.log('');
}

main().catch((err) => {
  console.error('\n  o teste do portao abortou:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
