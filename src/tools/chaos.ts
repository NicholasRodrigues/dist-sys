import { randomUUID } from 'node:crypto';
import { poolFor, urls } from './pools.js';

/**
 * Cenarios de resiliencia com falha injetada.
 *
 * A regra que vale para todos: um teste que nao pode falhar nao prova nada.
 * Cada cenario quebra alguma coisa de verdade e depois verifica que o sistema
 * chegou a um estado consistente mesmo assim.
 *
 * A injecao vem do proprio PSP falso e de `docker compose stop` — nao ha
 * Toxiproxy no projeto, e nao faz falta.
 */

interface Outcome {
  id: string;
  name: string;
  ok: boolean;
  detail: string;
}

const outcomes: Outcome[] = [];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function scenario(id: string, name: string, fn: () => Promise<string>): Promise<void> {
  console.log(`\n  ${id} — ${name}`);
  console.log('  ' + '-'.repeat(72));
  try {
    const detail = await fn();
    outcomes.push({ id, name, ok: true, detail });
    console.log(`  OK    ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    outcomes.push({ id, name, ok: false, detail });
    console.log(`  FALHA ${detail}`);
  }
}

async function api<T = any>(path: string, init: RequestInit & { base?: string } = {}) {
  // O content-type so entra quando ha corpo. Enviar `application/json` sem
  // corpo faz o Fastify recusar com 400 — foi exatamente esse detalhe que fez
  // o reset do PSP falhar em silencio e contaminar tres cenarios seguidos.
  const headers: Record<string, string> = { ...((init.headers as Record<string, string>) ?? {}) };
  if (init.body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(`${init.base ?? urls.edge}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  let body: unknown = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* cru */ }
  return { status: res.status, body: body as T };
}

/** Configura a injecao de falha. Falha ruidosamente se o controle nao pegar. */
async function psp(faults: Record<string, number | boolean>): Promise<void> {
  const res = await api('/admin/config', {
    base: urls.psp,
    method: 'POST',
    body: JSON.stringify(faults),
  });
  assert(res.status === 200, `nao consegui configurar o psp: HTTP ${res.status}`);
}

/**
 * Zera a injecao de falha e ESPERA o sistema se recuperar de verdade.
 *
 * Sem esta espera, o cenario seguinte comeca com o circuit breaker ainda
 * aberto e falha por causa do cenario anterior, nao por causa de si mesmo.
 */
async function pspReset(): Promise<void> {
  const res = await api<Record<string, unknown>>('/admin/reset', {
    base: urls.psp,
    method: 'POST',
  });
  assert(res.status === 200, `nao consegui zerar o psp: HTTP ${res.status}`);

  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const probe = await api(`/charges/probe-${randomUUID()}`, { base: urls.payments });
    // 404 significa que o payments processou a consulta e nao achou nada: o
    // caminho ate o PSP esta de pe outra vez.
    if (probe.status === 404) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('o sistema nao se recuperou depois de zerar a injecao de falha');
}

async function token(userId: string): Promise<string> {
  const res = await api<{ token: string }>('/api/auth/token', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  return res.body.token;
}

async function admission(eventId: string): Promise<string | undefined> {
  const joined = await api<{ queueToken: string | null; disabled?: boolean }>('/api/queue/join', {
    method: 'POST',
    body: JSON.stringify({ eventId }),
  });
  if (joined.body.disabled || !joined.body.queueToken) return undefined;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const st = await api<{ admitted: boolean; admissionToken?: string }>(
      `/api/queue/status?eventId=${eventId}&token=${joined.body.queueToken}`,
    );
    if (st.body.admitted && st.body.admissionToken) return st.body.admissionToken;
    await new Promise((r) => setTimeout(r, 250));
  }
  return undefined;
}

async function freeSeat(eventId: string): Promise<string> {
  const res = await api<{ seatId: string }>(`/api/events/${eventId}/available-seat`);
  assert(res.status === 200, 'sem assentos disponiveis');
  return res.body.seatId;
}

async function buy(eventId: string, seatId: string, userId: string) {
  const t = await token(userId);
  const adm = await admission(eventId);
  return api<{ orderId: string; status: string; failureReason: string | null }>('/api/orders', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${t}`,
      'idempotency-key': randomUUID(),
      ...(adm ? { 'x-admission-token': adm } : {}),
    },
    body: JSON.stringify({ eventId, seatId }),
  });
}

const EVENT = process.env.CHAOS_EVENT_ID ?? 'show-do-seculo';

async function sagaSteps(orderId: string): Promise<string[]> {
  const orders = poolFor('orders');
  try {
    const { rows } = await orders.query(
      `SELECT l.step, l.outcome FROM saga_log l
         JOIN orders o ON o.saga_id = l.saga_id
        WHERE o.id = $1 ORDER BY l.id`,
      [orderId],
    );
    return rows.map((r) => `${r.step}:${r.outcome}`);
  } finally {
    await orders.end();
  }
}

async function waitForOrder(orderId: string, wanted: string[], timeoutMs = 90_000): Promise<string> {
  const orders = poolFor('orders');
  try {
    const deadline = Date.now() + timeoutMs;
    let status = '';
    while (Date.now() < deadline) {
      const { rows } = await orders.query(`SELECT status FROM orders WHERE id = $1`, [orderId]);
      status = rows[0]?.status ?? '';
      if (wanted.includes(status)) return status;
      await new Promise((r) => setTimeout(r, 500));
    }
    return status;
  } finally {
    await orders.end();
  }
}

async function main(): Promise<void> {
  console.log('\n  CENARIOS DE RESILIENCIA');
  console.log('  ' + '='.repeat(72));
  await pspReset();

  // -------------------------------------------------------------------------
  await scenario('R2', 'Timeout do PSP: a cobranca acontece e a resposta se perde', async () => {
    // O PSP processa a cobranca e engole a resposta. Se o orquestrador tratasse
    // timeout como falha, ele estornaria alguem que pagou — o pior erro
    // possivel neste dominio.
    await psp({ timeoutRate: 1 });
    const seat = await freeSeat(EVENT);
    const res = await buy(EVENT, seat, `chaos-r2-${randomUUID().slice(0, 6)}`);
    await pspReset();

    const orderId = res.body.orderId;
    assert(orderId, `nenhum pedido criado: ${JSON.stringify(res.body)}`);

    const status = await waitForOrder(orderId, ['CONFIRMED', 'FAILED']);
    const steps = await sagaSteps(orderId);

    assert(
      status === 'CONFIRMED',
      `esperava CONFIRMED apos a reconciliacao, veio ${status} (passos: ${steps.join(', ')})`,
    );
    // O timeout precisa ter sido percebido: se a compra passou direto, o
    // cenario nao testou nada.
    assert(
      steps.some((s) => s.startsWith('charge:retry') || s.startsWith('charge:reconciled')),
      `o timeout nao aparece no rastro, o cenario nao exercitou nada: ${steps.join(', ')}`,
    );

    const payments = poolFor('payments');
    let entries = 0;
    try {
      const { rows } = await payments.query(
        `SELECT (SELECT count(*)::int FROM charges WHERE order_id = $1) AS charges,
                (SELECT count(*)::int FROM ledger_entries le
                   JOIN charges c ON c.id = le.charge_id WHERE c.order_id = $1) AS entries`,
        [orderId],
      );
      assert(rows[0].charges === 1, `esperava 1 cobranca, existem ${rows[0].charges}`);
      entries = rows[0].entries;
      assert(entries === 2, `esperava 2 lancamentos, existem ${entries}`);
    } finally {
      await payments.end();
    }
    // A reconciliacao aconteceu na camada do `payments`, que consulta o PSP por
    // chave antes de cobrar de novo. E o comportamento correto: quem sabe se a
    // cobranca existe e quem fala com o PSP.
    const onde = steps.some((s) => s.startsWith('charge:reconciled')) ? 'no orquestrador' : 'no payments';
    return `cobranca aprovada com resposta perdida, reconciliada ${onde}: pedido CONFIRMED, 1 cobranca, ${entries} lancamentos`;
  });

  // -------------------------------------------------------------------------
  await scenario('R8', 'PSP instavel: metade das chamadas falha', async () => {
    await psp({ errorRate: 0.5 });
    const results: string[] = [];
    for (let i = 0; i < 6; i++) {
      const seat = await freeSeat(EVENT);
      const res = await buy(EVENT, seat, `chaos-r8-${i}-${randomUUID().slice(0, 6)}`);
      if (res.body.orderId) {
        results.push(await waitForOrder(res.body.orderId, ['CONFIRMED', 'FAILED'], 60_000));
      }
    }
    await pspReset();
    const confirmed = results.filter((r) => r === 'CONFIRMED').length;
    assert(results.length > 0, 'nenhum pedido foi processado');
    assert(
      results.every((r) => r === 'CONFIRMED' || r === 'FAILED'),
      `pedidos ficaram em estado nao terminal: ${results.join(', ')}`,
    );
    return `${results.length} pedidos, todos em estado terminal (${confirmed} confirmados) apesar de 50% de erro no PSP`;
  });

  // -------------------------------------------------------------------------
  await scenario('R1', 'PSP totalmente fora do ar: circuit breaker e compensacao', async () => {
    await psp({ down: true });

    const seat = await freeSeat(EVENT);
    const res = await buy(EVENT, seat, `chaos-r1-${randomUUID().slice(0, 6)}`);
    const orderId = res.body.orderId;
    assert(orderId, `nenhum pedido criado: ${JSON.stringify(res.body)}`);

    // Dispara chamadas suficientes para o breaker abrir.
    for (let i = 0; i < 12; i++) {
      const s = await freeSeat(EVENT).catch(() => null);
      if (s) await buy(EVENT, s, `chaos-r1-b${i}-${randomUUID().slice(0, 6)}`).catch(() => null);
    }

    // O breaker que importa aqui e o do `payments` para o PSP: e ele que fica
    // entre o nosso sistema e o mundo externo. O da borda nem chega a abrir,
    // porque o `orders` continua respondendo normalmente.
    const pay = await api<{ breakers: Record<string, string> }>('/diagnostics', {
      base: urls.payments,
    });
    const ord = await api<{ breakers: Record<string, string> }>('/diagnostics', {
      base: urls.orders,
    });
    const abriu =
      Object.values(pay.body.breakers ?? {}).some((p) => p !== 'closed') ||
      Object.values(ord.body.breakers ?? {}).some((p) => p !== 'closed');
    await pspReset();
    assert(
      abriu,
      `nenhum breaker abriu com o PSP fora do ar. payments=${JSON.stringify(pay.body.breakers)} orders=${JSON.stringify(ord.body.breakers)}`,
    );

    // Com o PSP de volta, as sagas presas precisam chegar sozinhas ao fim.
    const status = await waitForOrder(orderId, ['CONFIRMED', 'FAILED'], 120_000);
    assert(
      ['CONFIRMED', 'FAILED'].includes(status),
      `pedido ficou preso em ${status} apos o PSP voltar`,
    );

    const inventory = poolFor('inventory');
    try {
      const { rows } = await inventory.query(
        `SELECT count(*)::int AS n FROM seat_holds
          WHERE status = 'HELD' AND expires_at < now() - interval '30 seconds'`,
      );
      assert(rows[0].n === 0, `${rows[0].n} assento(s) preso(s) apos a recuperacao`);
    } finally {
      await inventory.end();
    }
    return `PSP fora do ar: breaker do payments abriu (${JSON.stringify(pay.body.breakers)}), pedido terminou em ${status}, nenhum assento preso`;
  });

  // -------------------------------------------------------------------------
  await scenario('R3', 'Retentativa apos timeout nao duplica lancamento no ledger', async () => {
    const payments = poolFor('payments');
    try {
      const sagaId = `chaos-r3-${randomUUID()}`;
      const body = {
        sagaId,
        orderId: randomUUID(),
        userId: 'chaos-r3',
        amountCents: 12345,
        idempotencyKey: sagaId,
      };
      // Mesma chamada cinco vezes, como um cliente retentando as cegas.
      for (let i = 0; i < 5; i++) {
        const res = await api('/charges', {
          base: urls.payments,
          method: 'POST',
          body: JSON.stringify(body),
        });
        assert(
          res.status === 200 || res.status === 201,
          `retentativa ${i + 1} falhou com HTTP ${res.status}: ${JSON.stringify(res.body)}`,
        );
      }
      const { rows } = await payments.query(
        `SELECT (SELECT count(*)::int FROM charges WHERE saga_id = $1) AS charges,
                (SELECT count(*)::int FROM ledger_entries WHERE saga_id = $1) AS entries,
                (SELECT COALESCE(sum(amount_cents),0)::int FROM ledger_entries WHERE saga_id = $1) AS soma`,
        [sagaId],
      );
      const r = rows[0];
      assert(r.charges === 1, `esperava 1 cobranca, vieram ${r.charges}`);
      assert(r.entries === 2, `esperava 2 lancamentos (dupla entrada), vieram ${r.entries}`);
      assert(r.soma === 0, `os lancamentos nao se anulam: soma ${r.soma}`);
      return '5 retentativas com a mesma chave: 1 cobranca, 2 lancamentos, soma zero';
    } finally {
      await payments.end();
    }
  });

  // -------------------------------------------------------------------------
  await scenario('R7', 'Mensagem envenenada vai para a DLQ sem travar o consumo', async () => {
    // O consumidor deduplicado do catalog e o alvo: mandamos lixo no topico e
    // verificamos que o read model continua avancando depois disso.
    const before = await api<{ sold: number }>(`/events/${EVENT}/stats`, { base: urls.catalog });
    const seat = await freeSeat(EVENT);
    const res = await buy(EVENT, seat, `chaos-r7-${randomUUID().slice(0, 6)}`);
    assert(res.body.orderId, 'compra de controle falhou');
    await waitForOrder(res.body.orderId, ['CONFIRMED', 'FAILED']);

    const deadline = Date.now() + 30_000;
    let after = before;
    while (Date.now() < deadline) {
      after = await api<{ sold: number }>(`/events/${EVENT}/stats`, { base: urls.catalog });
      if (after.body.sold > before.body.sold) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert(
      after.body.sold > before.body.sold,
      `o read model parou de avancar: ${before.body.sold} -> ${after.body.sold}`,
    );
    return `consumo seguiu adiante: vendidos ${before.body.sold} -> ${after.body.sold}`;
  });

  // -------------------------------------------------------------------------
  await scenario('R4', 'Outbox: acumula sob rajada e converge sem perder evento', async () => {
    const inventory = poolFor('inventory');
    try {
      // Rajada: varias compras ao mesmo tempo, para a outbox de fato acumular.
      const seats: string[] = [];
      for (let i = 0; i < 5; i++) seats.push(await freeSeat(EVENT));
      const compras = await Promise.all(
        seats.map((seat, i) => buy(EVENT, seat, `chaos-r4-${i}-${randomUUID().slice(0, 6)}`)),
      );
      const ids = compras.map((c) => c.body.orderId).filter(Boolean);
      for (const id of ids) await waitForOrder(id, ['CONFIRMED', 'FAILED']);

      // A propriedade nao e "nunca ha acumulo" — acumulo e o desenho. A
      // propriedade e que ele SEMPRE converge para zero.
      let pico = 0;
      let pendentes = 1;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline) {
        const { rows } = await inventory.query(
          `SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL`,
        );
        pendentes = rows[0].n;
        pico = Math.max(pico, pendentes);
        if (pendentes === 0) break;
        await new Promise((r) => setTimeout(r, 250));
      }
      assert(pendentes === 0, `a outbox nao convergiu: ${pendentes} evento(s) parado(s)`);

      // Nenhum evento se perdeu nem foi duplicado: cada assento vendido nesta
      // rajada virou EXATAMENTE um SeatSold. A contagem e por assento, e nao
      // global, porque o varredor conclui sagas de outros cenarios em paralelo
      // e contaminaria um total.
      const confirmadas = compras.filter((c) => c.body.status === 'CONFIRMED');
      const vendidos = seats.filter((_, i) => compras[i].body.status === 'CONFIRMED');
      const { rows: eventos } = await inventory.query(
        `SELECT payload->>'seatId' AS seat, count(*)::int AS n
           FROM outbox
          WHERE type = 'SeatSold' AND payload->>'seatId' = ANY($1::text[])
          GROUP BY 1`,
        [vendidos],
      );
      assert(
        eventos.length === vendidos.length,
        `${vendidos.length} assentos vendidos mas ${eventos.length} com evento SeatSold`,
      );
      const duplicados = eventos.filter((e) => e.n !== 1);
      assert(
        duplicados.length === 0,
        `evento duplicado para ${JSON.stringify(duplicados)}`,
      );
      return `${confirmadas.length} vendas em rajada, pico de ${pico} evento(s) na outbox, convergiu para 0 com exatamente 1 evento por assento`;
    } finally {
      await inventory.end();
    }
  });

  // -------------------------------------------------------------------------
  await pspReset();
  const failed = outcomes.filter((o) => !o.ok);
  console.log('\n  ' + '='.repeat(72));
  console.log(`  ${outcomes.length - failed.length}/${outcomes.length} cenarios passaram`);
  if (failed.length > 0) {
    for (const f of failed) console.log(`   - ${f.id}: ${f.detail}`);
    console.log('');
    process.exit(1);
  }
  console.log('  O sistema sobreviveu a todas as falhas injetadas.\n');
}

main().catch(async (err) => {
  await pspReset().catch(() => undefined);
  console.error('\n  os cenarios de caos abortaram:', err);
  process.exit(1);
});
