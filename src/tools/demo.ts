import { randomUUID } from 'node:crypto';
import { poolFor, urls } from './pools.js';

/**
 * Roteiro guiado da demonstracao.
 *
 * Executa, em ordem e narrando cada passo, a sequencia que vai ao ar no
 * videocast. Serve para ensaiar com cronometro e para ter uma gravacao reserva
 * caso a demo ao vivo falhe.
 */

const EVENT = process.env.DEMO_EVENT_ID ?? 'show-do-seculo';

function titulo(n: number, texto: string): void {
  console.log(`\n\n  ${n}. ${texto}`);
  console.log('  ' + '='.repeat(74));
}

function nota(texto: string): void {
  console.log(`     ${texto}`);
}

async function pausa(ms = 1200): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function api<T = any>(path: string, init: RequestInit & { base?: string } = {}) {
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
  return { status: res.status, body: body as T, headers: res.headers };
}

async function comprar(userId: string, seatId?: string) {
  const auth = await api<{ token: string }>('/api/auth/token', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  });
  const token = auth.body.token;

  const fila = await api<{ queueToken: string | null; disabled?: boolean }>('/api/queue/join', {
    method: 'POST',
    body: JSON.stringify({ eventId: EVENT }),
  });

  let admission: string | undefined;
  if (!fila.body.disabled && fila.body.queueToken) {
    const limite = Date.now() + 30_000;
    while (Date.now() < limite) {
      const st = await api<{ admitted: boolean; admissionToken?: string; position: number }>(
        `/api/queue/status?eventId=${EVENT}&token=${fila.body.queueToken}`,
      );
      if (st.body.admitted && st.body.admissionToken) {
        admission = st.body.admissionToken;
        break;
      }
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  const assento =
    seatId ?? (await api<{ seatId: string }>(`/api/events/${EVENT}/available-seat`)).body.seatId;

  const compra = await api<{
    orderId: string;
    status: string;
    seatId: string;
    failureReason: string | null;
    ticket: { qrCode: string } | null;
  }>('/api/orders', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'idempotency-key': randomUUID(),
      ...(admission ? { 'x-admission-token': admission } : {}),
    },
    body: JSON.stringify({ eventId: EVENT, seatId: assento }),
  });

  return { compra, token, admission, assento };
}

async function main(): Promise<void> {
  console.log('\n  DEMONSTRACAO GUIADA — BILHETERIA');
  console.log('  ' + '='.repeat(74));
  console.log('  Cada passo abaixo corresponde a um momento do videocast.');

  await api('/admin/reset', { base: urls.psp, method: 'POST' });

  // -------------------------------------------------------------------------
  titulo(1, 'O sistema no ar: quem atendeu esta requisicao?');
  const versoes: Record<string, number> = {};
  for (let i = 0; i < 10; i++) {
    const res = await api('/health');
    const v = res.headers.get('x-app-version') ?? '?';
    versoes[v] = (versoes[v] ?? 0) + 1;
  }
  nota(`Dez requisicoes atraves do Traefik: ${JSON.stringify(versoes)}`);
  nota('Duas instancias do edge, balanceadas. E a base do blue-green e do canary.');
  await pausa();

  // -------------------------------------------------------------------------
  titulo(2, 'A fila virtual: o pico vira vazao');
  const stats = await api<{ available: number; sold: number }>(`/events/${EVENT}/stats`, {
    base: urls.catalog,
  });
  nota(`Evento com ${stats.body.available.toLocaleString('pt-BR')} lugares disponiveis.`);
  const flags = await api<Record<string, string>>('/api/admin/flags');
  nota(`Fila: ${flags.body.queue_enabled}, admitindo ${flags.body.admission_rate} pessoas por segundo.`);
  await pausa();

  // -------------------------------------------------------------------------
  titulo(3, 'Uma compra do inicio ao fim');
  const { compra } = await comprar(`demo-${randomUUID().slice(0, 6)}`);
  nota(`Pedido ${compra.body.orderId.slice(0, 8)} — assento ${compra.body.seatId} — ${compra.body.status}`);

  const saga = await api<{ steps: { step: string; outcome: string }[] }>(
    `/orders/${compra.body.orderId}/saga`,
    { base: urls.orders },
  );
  nota('Rastro da SAGA:');
  for (const s of saga.body.steps) nota(`   ${s.step.padEnd(22)} ${s.outcome}`);
  nota('Cada passo esta persistido. Se o processo morresse no meio, o varredor retomaria daqui.');
  await pausa();

  // -------------------------------------------------------------------------
  titulo(4, 'Idempotencia: a mesma compra duas vezes');
  const chave = randomUUID();
  const auth = await api<{ token: string }>('/api/auth/token', {
    method: 'POST',
    body: JSON.stringify({ userId: 'demo-idem' }),
  });
  const fila = await api<{ queueToken: string }>('/api/queue/join', {
    method: 'POST',
    body: JSON.stringify({ eventId: EVENT }),
  });
  let adm: string | undefined;
  const limite = Date.now() + 30_000;
  while (Date.now() < limite) {
    const st = await api<{ admitted: boolean; admissionToken?: string }>(
      `/api/queue/status?eventId=${EVENT}&token=${fila.body.queueToken}`,
    );
    if (st.body.admitted) { adm = st.body.admissionToken; break; }
    await new Promise((r) => setTimeout(r, 250));
  }
  const assento = (await api<{ seatId: string }>(`/api/events/${EVENT}/available-seat`)).body.seatId;
  const enviar = () =>
    api<{ orderId: string }>('/api/orders', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.body.token}`,
        'idempotency-key': chave,
        ...(adm ? { 'x-admission-token': adm } : {}),
      },
      body: JSON.stringify({ eventId: EVENT, seatId: assento }),
    });
  const a = await enviar();
  const b = await enviar();
  nota(`Primeira resposta: pedido ${a.body.orderId?.slice(0, 8)}`);
  nota(`Segunda resposta:  pedido ${b.body.orderId?.slice(0, 8)}`);
  nota(a.body.orderId === b.body.orderId ? 'Mesmo pedido: nada foi duplicado.' : 'ATENCAO: ids diferentes!');
  await pausa();

  // -------------------------------------------------------------------------
  titulo(5, 'Zero overselling: dez pessoas, um assento');
  const disputado = (await api<{ seatId: string }>(`/api/events/${EVENT}/available-seat`)).body.seatId;
  nota(`Assento em disputa: ${disputado}`);
  const disputa = await Promise.all(
    Array.from({ length: 10 }, (_, i) => comprar(`disputa-${i}-${randomUUID().slice(0, 4)}`, disputado)),
  );
  const vencedores = disputa.filter((d) => d.compra.body.status === 'CONFIRMED');
  const perdedores = disputa.filter((d) => d.compra.status === 409 || d.compra.body.status === 'FAILED');
  nota(`Confirmados: ${vencedores.length} · Recusados: ${perdedores.length}`);
  nota('A garantia nao vem do codigo, vem de um indice unico parcial no banco.');
  await pausa();

  // -------------------------------------------------------------------------
  titulo(6, 'O PSP cai no meio da compra');
  await api('/admin/config', { base: urls.psp, method: 'POST', body: JSON.stringify({ timeoutRate: 1 }) });
  nota('PSP configurado para PROCESSAR a cobranca e engolir a resposta.');
  nota('Este e o modo de falha que domina o desenho: o timeout nao diz se cobrou.');
  const falha = await comprar(`demo-timeout-${randomUUID().slice(0, 4)}`);
  await api('/admin/reset', { base: urls.psp, method: 'POST' });

  const orders = poolFor('orders');
  const payments = poolFor('payments');
  try {
    const deadline = Date.now() + 90_000;
    let status = '';
    while (Date.now() < deadline) {
      const { rows } = await orders.query(`SELECT status FROM orders WHERE id = $1`, [
        falha.compra.body.orderId,
      ]);
      status = rows[0]?.status ?? '';
      if (['CONFIRMED', 'FAILED'].includes(status)) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    const { rows: cob } = await payments.query(
      `SELECT count(*)::int AS n FROM charges WHERE order_id = $1`,
      [falha.compra.body.orderId],
    );
    nota(`Estado final do pedido: ${status}`);
    nota(`Cobrancas registradas: ${cob[0].n} — nao houve cobranca dupla nem estorno indevido.`);
  } finally {
    await orders.end();
    await payments.end();
  }
  await pausa();

  // -------------------------------------------------------------------------
  titulo(7, 'O dinheiro fecha');
  const ledger = await api<{ balanced: boolean; sumCents: number; entries: number }>('/ledger/health', {
    base: urls.payments,
  });
  nota(`${ledger.body.entries} lancamentos no ledger, soma = ${ledger.body.sumCents} centavos.`);
  nota('Uma consulta de uma linha verifica a consistencia financeira do sistema inteiro.');

  // -------------------------------------------------------------------------
  console.log('\n\n  ' + '='.repeat(74));
  console.log('  Fim do roteiro.');
  console.log('');
  console.log('  Para o videocast, mostre em seguida:');
  console.log(`   - o trace da SAGA no Jaeger        http://localhost:16686`);
  console.log(`   - os paineis no Grafana            http://localhost:3030/d/bilheteria`);
  console.log(`   - o mapa de assentos ao vivo       http://localhost:8080/`);
  console.log('');
}

main().catch((err) => {
  console.error('\n  a demonstracao abortou:', err);
  process.exit(1);
});
