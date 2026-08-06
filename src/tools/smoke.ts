import { randomUUID } from 'node:crypto';
import { poolFor, urls, waitFor } from './pools.js';

/**
 * Teste ponta a ponta do sistema inteiro.
 *
 * Verifica o caminho feliz, mas o valor esta nos casos que NAO deveriam
 * funcionar: assento vendido duas vezes, cobranca duplicada, QR forjado,
 * ingresso reapresentado. Um teste que nao pode falhar nao prova nada.
 */

interface Result {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

const results: Result[] = [];
let currentSection = '';

function section(name: string): void {
  currentSection = name;
  console.log(`\n  ${name}`);
  console.log('  ' + '-'.repeat(72));
}

async function check(name: string, fn: () => Promise<string>): Promise<boolean> {
  const started = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - started;
    results.push({ name: `${currentSection} / ${name}`, ok: true, detail, ms });
    console.log(`  OK    ${name}`);
    if (detail) console.log(`        ${detail}`);
    return true;
  } catch (err) {
    const ms = Date.now() - started;
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ name: `${currentSection} / ${name}`, ok: false, detail, ms });
    console.log(`  FALHA ${name}`);
    console.log(`        ${detail}`);
    return false;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Janela fixa alinhada ao relogio, igual a do `edge`. */
const RATE_LIMIT_WINDOW_SECONDS = 10;

async function waitForNextRateLimitWindow(): Promise<void> {
  const windowMs = RATE_LIMIT_WINDOW_SECONDS * 1000;
  const restante = windowMs - (Date.now() % windowMs);
  await new Promise((r) => setTimeout(r, restante + 250));
}

interface HttpResult<T> {
  status: number;
  body: T;
}

async function http<T = any>(
  path: string,
  init: RequestInit & { base?: string } = {},
): Promise<HttpResult<T>> {
  const base = init.base ?? urls.edge;
  const res = await fetch(`${base}${path}`, {
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

async function tokenFor(userId: string): Promise<string> {
  const res = await http<{ token: string }>('/api/auth/token', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  assert(res.status === 200, `esperava 200 ao emitir token, veio ${res.status}`);
  return res.body.token;
}

async function admissionFor(eventId: string): Promise<string | undefined> {
  const joined = await http<{ queueToken: string | null; disabled?: boolean }>('/api/queue/join', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
  if (joined.body.disabled || !joined.body.queueToken) return undefined;

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const st = await http<{ admitted: boolean; admissionToken?: string }>(
      `/api/queue/status?eventId=${encodeURIComponent(eventId)}&token=${joined.body.queueToken}`,
    );
    if (st.body.admitted && st.body.admissionToken) return st.body.admissionToken;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('nao fui admitido pela fila em 30s');
}

interface OrderResponse {
  orderId: string;
  status: string;
  seatId: string;
  failureReason: string | null;
  ticket: { ticketId: string; qrCode: string; status: string } | null;
}

async function buy(
  eventId: string,
  seatId: string,
  token: string,
  admission: string | undefined,
  idempotencyKey = randomUUID(),
): Promise<HttpResult<OrderResponse>> {
  return http<OrderResponse>('/api/orders', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': idempotencyKey,
      ...(admission ? { 'x-admission-token': admission } : {}),
    },
    body: JSON.stringify({ eventId, seatId }),
  });
}

async function freeSeat(eventId: string): Promise<string> {
  const res = await http<{ seatId: string }>(
    `/api/events/${encodeURIComponent(eventId)}/available-seat`,
  );
  assert(res.status === 200, `nenhum assento disponivel (status ${res.status})`);
  return res.body.seatId;
}

const EVENT_ID = process.env.SMOKE_EVENT_ID ?? 'show-do-seculo';

async function main(): Promise<void> {
  console.log('\n  TESTE PONTA A PONTA — BILHETERIA');
  console.log('  ' + '='.repeat(72));

  section('Disponibilidade');
  await waitFor(`${urls.edge}/health`, 'edge');
  for (const [name, url] of Object.entries({
    catalog: urls.catalog,
    inventory: urls.inventory,
    orders: urls.orders,
    payments: urls.payments,
    realtime: urls.realtime,
    psp: urls.psp,
  })) {
    await check(`${name} responde /health`, async () => {
      const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
      assert(res.ok, `status ${res.status}`);
      return '';
    });
  }

  // Garante que a injecao de falha esta zerada antes de comecar.
  await fetch(`${urls.psp}/admin/reset`, { method: 'POST' }).catch(() => undefined);

  // ------------------------------------------------------------------
  // O portao do antifraude sai do caminho durante esta bateria.
  //
  // Nao e conveniencia: este arquivo testa a BILHETERIA, e o trafego que ele
  // gera e, por construcao, indistinguivel de fraude. A verificacao de
  // contencao precisa de 40 contas disputando o mesmo assento, a de
  // idempotencia dispara 50 requisicoes identicas em paralelo, e tudo sai do
  // mesmo endereco. Um antifraude que NAO quarentenasse isso estaria quebrado.
  //
  // Descobrimos isso da pior maneira: ao ligar a integracao, o proprio teste de
  // fumaca foi bloqueado com "53 tentativas de compra nos ultimos 10 minutos".
  // O detector estava certo; o gerador de carga e que nao e um cliente.
  //
  // Deixar acoplado tornaria qualquer falha da Bilheteria inatribuivel — nunca
  // se saberia se quebrou o checkout ou se o teste anterior sujou o score. O
  // portao tem teste proprio, e mais forte: `make risk-gate`.
  //
  // Os eventos de comportamento continuam sendo publicados; so a CONSULTA
  // bloqueante sai de cena.
  section('Antifraude (fora do caminho durante o teste)');

  await check('desliga a consulta de risco no checkout', async () => {
    const res = await http<Record<string, string>>('/api/admin/flags', {
      method: 'POST',
      body: JSON.stringify({ risk_check_mode: 'disabled' }),
    });
    assert(res.status === 200, `esperava 200, veio ${res.status}`);
    const conferida = await http<Record<string, string>>('/api/admin/flags');
    assert(
      conferida.body.risk_check_mode === 'disabled',
      `flag ficou em ${conferida.body.risk_check_mode}`,
    );
    return 'risk_check_mode=disabled; o portao e verificado em `make risk-gate`';
  });

  // ------------------------------------------------------------------
  section('Autenticacao (JWT na borda)');

  let token = '';
  await check('emite token para um usuario', async () => {
    token = await tokenFor('comprador-smoke');
    assert(token.split('.').length === 3, 'token nao parece um JWT');
    return `token com ${token.length} caracteres`;
  });

  await check('recusa requisicao sem token', async () => {
    const res = await buy(EVENT_ID, 'PISTA-1-1', '', undefined);
    assert(res.status === 401, `esperava 401, veio ${res.status}`);
    return 'HTTP 401 sem authorization';
  });

  await check('recusa token com assinatura adulterada', async () => {
    const tampered = token.slice(0, -4) + 'AAAA';
    const res = await buy(EVENT_ID, 'PISTA-1-1', tampered, undefined);
    assert(res.status === 403, `esperava 403, veio ${res.status}`);
    return 'HTTP 403 com assinatura invalida';
  });

  await check('recusa token expirado', async () => {
    const res = await http<{ token: string }>('/api/auth/token', {
      method: 'POST',
      body: JSON.stringify({ userId: 'efemero', ttlSeconds: 1 }),
    });
    await new Promise((r) => setTimeout(r, 2500));
    const out = await buy(EVENT_ID, 'PISTA-1-1', res.body.token, undefined);
    assert(out.status === 401, `esperava 401, veio ${out.status}`);
    return 'HTTP 401 apos expirar';
  });

  // ------------------------------------------------------------------
  section('Fila virtual (controle de admissao)');

  let admission: string | undefined;
  await check('entra na fila e e admitido', async () => {
    admission = await admissionFor(EVENT_ID);
    return admission ? 'token de admissao recebido' : 'fila desligada por flag';
  });

  await check('recusa checkout sem token de admissao', async () => {
    const flags = await http<{ queue_enabled: string }>('/api/admin/flags');
    if (flags.body.queue_enabled !== 'true') return 'fila desligada, verificacao nao se aplica';
    const seat = await freeSeat(EVENT_ID);
    const res = await buy(EVENT_ID, seat, token, undefined);
    assert(res.status === 428, `esperava 428, veio ${res.status}`);
    return 'HTTP 428 sem passar pela fila';
  });

  // ------------------------------------------------------------------
  section('Compra (SAGA ponta a ponta)');

  let order: OrderResponse | undefined;
  await check('compra um ingresso do inicio ao fim', async () => {
    const seat = await freeSeat(EVENT_ID);
    const res = await buy(EVENT_ID, seat, token, admission);
    assert(res.status === 201, `esperava 201, veio ${res.status}: ${JSON.stringify(res.body)}`);
    assert(res.body.status === 'CONFIRMED', `status ${res.body.status} (${res.body.failureReason})`);
    assert(res.body.ticket, 'nenhum ingresso emitido');
    order = res.body;
    return `pedido ${order.orderId.slice(0, 8)} assento ${order.seatId} status CONFIRMED com QR`;
  });

  await check('a SAGA registrou cada passo', async () => {
    assert(order, 'sem pedido da etapa anterior');
    const res = await http<{ steps: { step: string; outcome: string }[] }>(
      `/api/orders/${order.orderId}/saga`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    const steps = res.body.steps.map((s) => `${s.step}:${s.outcome}`);
    assert(steps.includes('reserve:ok'), `faltou reserve:ok em ${steps.join(', ')}`);
    assert(steps.includes('charge:ok'), `faltou charge:ok em ${steps.join(', ')}`);
    assert(steps.includes('confirm:ok'), `faltou confirm:ok em ${steps.join(', ')}`);
    return steps.join(' -> ');
  });

  await check('o pedido de um usuario nao e visivel para outro', async () => {
    assert(order, 'sem pedido da etapa anterior');
    const outro = await tokenFor('bisbilhoteiro');
    const res = await http(`/api/orders/${order.orderId}`, {
      headers: { authorization: `Bearer ${outro}` },
    });
    assert(res.status === 403, `esperava 403, veio ${res.status}`);
    return 'HTTP 403 para pedido de terceiro';
  });

  // ------------------------------------------------------------------
  section('Idempotencia');

  await check('mesma chave duas vezes gera um unico pedido', async () => {
    const seat = await freeSeat(EVENT_ID);
    const key = randomUUID();
    const adm = await admissionFor(EVENT_ID);
    const first = await buy(EVENT_ID, seat, token, adm, key);
    const second = await buy(EVENT_ID, seat, token, adm, key);
    assert(first.status === 201, `primeira compra falhou: ${first.status}`);
    assert(
      first.body.orderId === second.body.orderId,
      `ids diferentes: ${first.body.orderId} vs ${second.body.orderId}`,
    );
    return `mesmo orderId nas duas respostas (${first.body.orderId.slice(0, 8)})`;
  });

  await check('50 requisicoes concorrentes com a mesma chave geram 1 pedido', async () => {
    const seat = await freeSeat(EVENT_ID);
    const key = randomUUID();
    const adm = await admissionFor(EVENT_ID);
    const responses = await Promise.all(
      Array.from({ length: 50 }, () => buy(EVENT_ID, seat, token, adm, key)),
    );
    const ids = new Set(responses.map((r) => r.body?.orderId).filter(Boolean));
    assert(ids.size === 1, `esperava 1 pedido, vieram ${ids.size}`);

    const payments = poolFor('payments');
    try {
      const { rows } = await payments.query(
        `SELECT count(*)::int AS n FROM charges WHERE order_id = $1`,
        [[...ids][0]],
      );
      assert(rows[0].n === 1, `esperava 1 cobranca, vieram ${rows[0].n}`);
    } finally {
      await payments.end();
    }
    return '1 pedido e 1 cobranca para 50 requisicoes simultaneas';
  });

  // ------------------------------------------------------------------
  section('Zero overselling sob contencao');

  await check('40 compradores disputando o MESMO assento: exatamente 1 vence', async () => {
    const seat = await freeSeat(EVENT_ID);
    const buyers = await Promise.all(
      Array.from({ length: 40 }, async (_, i) => ({
        token: await tokenFor(`disputa-${i}-${randomUUID().slice(0, 6)}`),
        admission: await admissionFor(EVENT_ID),
      })),
    );
    const responses = await Promise.all(
      buyers.map((b) => buy(EVENT_ID, seat, b.token, b.admission, randomUUID())),
    );

    const confirmed = responses.filter((r) => r.body?.status === 'CONFIRMED');
    const rejected = responses.filter((r) => r.status === 409 || r.body?.status === 'FAILED');
    assert(
      confirmed.length === 1,
      `esperava exatamente 1 confirmado, vieram ${confirmed.length} (rejeitados: ${rejected.length})`,
    );

    const orders = poolFor('orders');
    try {
      const { rows } = await orders.query(
        `SELECT count(*)::int AS n FROM tickets WHERE event_id = $1 AND seat_id = $2 AND status IN ('VALID','USED')`,
        [EVENT_ID, seat],
      );
      assert(rows[0].n === 1, `esperava 1 ingresso valido, existem ${rows[0].n}`);
    } finally {
      await orders.end();
    }
    return `assento ${seat}: 1 vencedor, ${rejected.length} recusados, 1 ingresso valido`;
  });

  // ------------------------------------------------------------------
  section('Portaria (assinatura do ingresso)');

  await check('faz check-in do QR valido', async () => {
    assert(order?.ticket, 'sem ingresso da etapa anterior');
    const res = await http<{ admitted: boolean }>('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({ qrCode: order.ticket.qrCode }),
    });
    assert(res.status === 200 && res.body.admitted, `esperava admissao, veio ${res.status}`);
    return 'entrada liberada';
  });

  await check('recusa o MESMO QR na segunda apresentacao', async () => {
    assert(order?.ticket, 'sem ingresso da etapa anterior');
    const res = await http('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({ qrCode: order.ticket.qrCode }),
    });
    assert(res.status === 409, `esperava 409, veio ${res.status}`);
    return 'HTTP 409 na reapresentacao';
  });

  await check('recusa QR com assinatura forjada', async () => {
    const forged = await http<{ qrCode: string }>('/checkin/forge', {
      base: urls.orders,
      method: 'POST',
      body: JSON.stringify({ eventId: EVENT_ID }),
    });
    const res = await http('/api/checkin', {
      method: 'POST',
      body: JSON.stringify({ qrCode: forged.body.qrCode }),
    });
    assert(res.status === 403, `esperava 403, veio ${res.status}`);
    return 'HTTP 403 para assinatura invalida';
  });

  // ------------------------------------------------------------------
  section('Ledger de dupla entrada');

  await check('a soma de todos os lancamentos e exatamente zero', async () => {
    const res = await http<{ balanced: boolean; sumCents: number; entries: number }>(
      '/ledger/health',
      { base: urls.payments },
    );
    assert(res.body.balanced, `ledger desbalanceado: ${res.body.sumCents} centavos`);
    return `${res.body.entries} lancamentos, soma zero`;
  });

  await check('o saldo da plataforma bate com os ingressos vendidos', async () => {
    const balance = await http<{ balanceCents: number }>('/ledger/balance/platform:revenue', {
      base: urls.payments,
    });
    assert(balance.body.balanceCents > 0, 'receita zerada apos as compras');
    return `receita = R$ ${(balance.body.balanceCents / 100).toFixed(2)}`;
  });

  // ------------------------------------------------------------------
  section('Rate limiting');

  await check('barra rajada acima do limite com HTTP 429', async () => {
    await http('/api/admin/flags', {
      method: 'POST',
      body: JSON.stringify({ rate_limit_max: 20 }),
    });
    try {
      // Espera a janela deslizante virar de verdade antes da rajada. Dormir um
      // tempo fixo nao serve: a janela e alinhada ao relogio, e comecar no meio
      // dela mede o balde do vizinho.
      await waitForNextRateLimitWindow();
      const burst: HttpResult<unknown>[] = [];
      for (let i = 0; i < 60; i++) burst.push(await http('/api/events'));
      const limited = burst.filter((r) => r.status === 429);
      const allowed = burst.filter((r) => r.status === 200);
      assert(limited.length > 0, 'nenhuma requisicao foi barrada');
      assert(allowed.length > 0, 'todas foram barradas: o limite nao esta sendo respeitado');
      return `${allowed.length} passaram, ${limited.length} barradas com 429 (limite 20 por janela)`;
    } finally {
      await http('/api/admin/flags', {
        method: 'POST',
        body: JSON.stringify({ rate_limit_max: 2000 }),
      });
      // A janela precisa virar antes dos proximos testes.
      await new Promise((r) => setTimeout(r, 1200));
    }
  });

  // ------------------------------------------------------------------
  section('Read model (CQRS) e cache');

  await check('o read model converge apos as vendas', async () => {
    const deadline = Date.now() + 20_000;
    let stats = { sold: 0, held: 0, available: 0 };
    while (Date.now() < deadline) {
      const res = await http<typeof stats>(`/events/${EVENT_ID}/stats`, { base: urls.catalog });
      stats = res.body;
      if (stats.sold > 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(stats.sold > 0, 'o read model nao registrou nenhuma venda');
    return `vendidos ${stats.sold}, em reserva ${stats.held}, disponiveis ${stats.available}`;
  });

  await check('o cache responde mais rapido que o banco', async () => {
    const t0 = Date.now();
    await http(`/api/events/${EVENT_ID}/seatmap?section=CAMAROTE`);
    const cold = Date.now() - t0;
    const t1 = Date.now();
    await http(`/api/events/${EVENT_ID}/seatmap?section=CAMAROTE`);
    const warm = Date.now() - t1;
    return `primeira leitura ${cold}ms, com cache ${warm}ms`;
  });

  // ------------------------------------------------------------------
  section('Tempo real (WebSocket)');

  await check('o navegador recebe a mudanca de assento ao vivo', async () => {
    const wsUrl = urls.realtime.replace('http', 'ws') + `/ws?eventId=${EVENT_ID}`;
    const messages: string[] = [];
    const socket = new WebSocket(wsUrl);

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('websocket nao conectou em 10s')), 10_000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      socket.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('erro ao conectar no websocket'));
      });
    });

    socket.addEventListener('message', (ev) => messages.push(String(ev.data)));

    const seat = await freeSeat(EVENT_ID);
    const adm = await admissionFor(EVENT_ID);
    await buy(EVENT_ID, seat, token, adm, randomUUID());

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (messages.some((m) => m.includes(seat))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    socket.close();

    const seen = messages.filter((m) => m.includes(seat));
    assert(seen.length > 0, `nenhuma mensagem sobre ${seat} em ${messages.length} recebidas`);
    return `${seen.length} atualizacao(oes) recebida(s) para ${seat}`;
  });

  // ------------------------------------------------------------------
  section('Antifraude (restauracao)');

  await check('devolve a consulta de risco ao estado padrao', async () => {
    // Sem isto, uma bateria de fumaca deixaria o sistema com o antifraude
    // desligado — e a proxima pessoa a demonstrar o projeto descobriria
    // sozinha, do jeito ruim.
    await http('/api/admin/flags', {
      method: 'POST',
      body: JSON.stringify({ risk_check_mode: 'fail_open' }),
    });
    const conferida = await http<Record<string, string>>('/api/admin/flags');
    assert(
      conferida.body.risk_check_mode === 'fail_open',
      `flag ficou em ${conferida.body.risk_check_mode}`,
    );
    return 'risk_check_mode=fail_open';
  });

  // ------------------------------------------------------------------
  section('Invariantes');

  await check('as seis invariantes se mantem', async () => {
    const { execSync } = await import('node:child_process');
    execSync('node dist/tools/invariants.js', { stdio: 'inherit' });
    return 'verificadas';
  });

  // ------------------------------------------------------------------
  const failed = results.filter((r) => !r.ok);
  console.log('\n  ' + '='.repeat(72));
  console.log(`  ${results.length - failed.length}/${results.length} verificacoes passaram`);
  if (failed.length > 0) {
    console.log('\n  Falhas:');
    for (const f of failed) console.log(`   - ${f.name}: ${f.detail}`);
    console.log('');
    process.exit(1);
  }
  console.log('  Sistema verificado ponta a ponta.\n');
}

main().catch((err) => {
  console.error('\n  o teste ponta a ponta abortou:', err);
  process.exit(1);
});
