import { randomUUID } from 'node:crypto';
import { config } from '../../shared/config.js';
import { query, transaction } from '../../shared/db.js';
import { RemoteError, request } from '../../shared/httpClient.js';
import { log } from '../../shared/log.js';
import { sagaSteps } from '../../shared/metrics.js';
import { enqueue } from '../../shared/outbox.js';
import { checkBuyer } from '../../shared/riskClient.js';
import { issueTicket } from './ticket.js';

/**
 * Orquestrador da SAGA de compra.
 *
 *   1. reservar assento   -> RESERVED     | compensacao: liberar assento
 *   2. cobrar via PIX     -> PAID         | compensacao: estornar e liberar
 *   3. emitir e confirmar -> CONFIRMED    | terminal
 *
 * Tres propriedades sao obrigatorias, e o codigo abaixo existe para garanti-las:
 *
 *  - **Idempotencia.** Todo passo carrega a `sagaId` como chave. Repetir nao
 *    duplica efeito.
 *
 *  - **Reconciliacao antes de compensar.** Um timeout NAO e uma falha. O
 *    orquestrador consulta o estado real no destino antes de decidir, porque
 *    "nao cobrou" e "cobrou e a resposta se perdeu" chegam aqui identicos — e
 *    tratar os dois como falha estornaria quem pagou.
 *
 *  - **Progresso garantido.** Nenhuma SAGA fica parada: o passo e reivindicado
 *    por lease, e o varredor retoma o que travou. Toda SAGA chega a um estado
 *    terminal, mesmo que o processo morra no meio.
 *
 * Regra estrutural: NENHUMA chamada de rede acontece com uma transacao de banco
 * aberta. O passo remoto roda fora, e a transicao de estado e um UPDATE
 * condicional curto — segurar lock de linha durante I/O de rede seria
 * exatamente o anti-padrao que a SAGA existe para evitar.
 */

export type OrderStatus =
  | 'PENDING'
  | 'RESERVED'
  | 'PAID'
  | 'CONFIRMED'
  | 'COMPENSATING'
  | 'FAILED';

export interface OrderRow {
  id: string;
  saga_id: string;
  user_id: string;
  event_id: string;
  seat_id: string;
  amount_cents: number;
  status: OrderStatus;
  failure_reason: string | null;
  attempts: number;
  created_at: Date;
  updated_at: Date;
}

const TERMINAL: OrderStatus[] = ['CONFIRMED', 'FAILED'];
/** Quanto tempo um trabalhador segura a SAGA antes de outro poder assumir. */
const LEASE_SECONDS = 15;

/**
 * Teto de tentativas da compensacao.
 *
 * Generoso de proposito: uma indisponibilidade passageira do `payments` deve
 * ser absorvida, e nao virar um pedido abandonado. Mas o teto existe, porque
 * uma SAGA que nunca alcanca estado terminal e um vazamento — ela volta ao
 * varredor a cada ciclo, para sempre.
 */
const MAX_COMPENSATION_ATTEMPTS = 12;

export function isTerminal(status: OrderStatus): boolean {
  return TERMINAL.includes(status);
}

async function logStep(sagaId: string, step: string, outcome: string, detail?: string): Promise<void> {
  await query(`INSERT INTO saga_log (saga_id, step, outcome, detail) VALUES ($1, $2, $3, $4)`, [
    sagaId,
    step,
    outcome,
    detail ?? null,
  ]);
  sagaSteps.inc({ step, outcome });
}

/**
 * Reivindica a SAGA por lease. Devolve undefined se ela ja e de outro
 * trabalhador ou se ja terminou. E o que impede dois processos avancarem o
 * mesmo pedido em paralelo, sem precisar de lock distribuido.
 */
async function claim(orderId: string): Promise<OrderRow | undefined> {
  const rows = await query<OrderRow>(
    `UPDATE orders
        SET next_attempt_at = now() + ($2 || ' seconds')::interval,
            attempts = attempts + 1,
            updated_at = now()
      WHERE id = $1
        AND status NOT IN ('CONFIRMED','FAILED')
        AND next_attempt_at <= now()
      RETURNING *`,
    [orderId, LEASE_SECONDS],
  );
  return rows[0];
}

/** Reagenda a SAGA para daqui a `seconds`, liberando o lease. */
async function reschedule(orderId: string, seconds: number): Promise<void> {
  await query(
    `UPDATE orders SET next_attempt_at = now() + ($2 || ' seconds')::interval WHERE id = $1`,
    [orderId, seconds],
  );
}

export async function advanceSaga(orderId: string, maxSteps = 6): Promise<OrderRow | undefined> {
  let current: OrderRow | undefined;

  for (let i = 0; i < maxSteps; i++) {
    const order = await claim(orderId);
    if (!order) {
      // Ja terminou, ou outro trabalhador esta com ela. Devolve o estado atual.
      const rows = await query<OrderRow>(`SELECT * FROM orders WHERE id = $1`, [orderId]);
      return current ?? rows[0];
    }
    current = order;
    if (isTerminal(order.status)) return order;

    const next = await runStep(order);
    if (!next) return current;
    current = next;
    if (isTerminal(next.status)) return next;
  }

  return current;
}

async function runStep(order: OrderRow): Promise<OrderRow | undefined> {
  switch (order.status) {
    case 'PENDING':
      return stepReserve(order);
    case 'RESERVED':
      return stepCharge(order);
    case 'PAID':
      return stepConfirm(order);
    case 'COMPENSATING':
      return stepCompensate(order);
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------
// Passo 1 — reservar o assento
// ---------------------------------------------------------------------------

async function stepReserve(order: OrderRow): Promise<OrderRow | undefined> {
  try {
    await request(`${config.inventoryUrl}/holds`, {
      method: 'POST',
      target: 'inventory',
      retries: 1,
      body: {
        sagaId: order.saga_id,
        eventId: order.event_id,
        seatId: order.seat_id,
        userId: order.user_id,
        ttlSeconds: config.holdTtlSeconds,
      },
    });
    await logStep(order.saga_id, 'reserve', 'ok');
    return transition(order.id, 'PENDING', 'RESERVED');
  } catch (err) {
    if (err instanceof RemoteError && err.status === 409) {
      // Assento indisponivel: falha de negocio, terminal, sem compensacao —
      // nada foi reservado e nada foi cobrado.
      await logStep(order.saga_id, 'reserve', 'conflict', 'assento indisponivel');
      return fail(order.id, 'assento indisponivel');
    }
    if (err instanceof RemoteError && err.status === 404) {
      await logStep(order.saga_id, 'reserve', 'not-found', 'assento inexistente');
      return fail(order.id, 'assento inexistente');
    }

    // Indeterminado: reconcilia antes de qualquer conclusao.
    const hold = await reconcileHold(order.saga_id);
    if (hold === 'HELD' || hold === 'SOLD') {
      await logStep(order.saga_id, 'reserve', 'reconciled', 'hold existia apesar do erro');
      return transition(order.id, 'PENDING', 'RESERVED');
    }

    await logStep(order.saga_id, 'reserve', 'retry', String(err));
    await reschedule(order.id, 2);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Passo de risco — antes de tocar no dinheiro
//
// A quarentena pode chegar DEPOIS de a compra ter comecado: o comprador
// reservou o assento e, entre a reserva e a cobranca, o motor antifraude
// acumulou evidencia suficiente para marca-lo. Isso e comum num ataque de
// cambista, em que as contas so ficam correlacionadas depois de varias
// compras.
//
// Quando isso acontece, nao basta recusar: e preciso COMPENSAR o que ja foi
// feito. E por isso que o antifraude cria uma transicao a mais na SAGA, e nao
// so uma validacao na borda.
// ---------------------------------------------------------------------------

async function assertNotQuarantined(order: OrderRow, step: string): Promise<string | undefined> {
  try {
    const decision = await checkBuyer(order.user_id);
    if (decision.allow) return undefined;
    await logStep(order.saga_id, step, 'quarantined', decision.detail);
    return decision.detail;
  } catch (err) {
    // Uma falha na consulta nao pode travar a SAGA. O modo de falha ja foi
    // decidido dentro de `checkBuyer`; aqui um erro inesperado deixa passar.
    await logStep(order.saga_id, step, 'risk-check-error', String(err));
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Passo 2 — cobrar
// ---------------------------------------------------------------------------

async function stepCharge(order: OrderRow): Promise<OrderRow | undefined> {
  // Antes de cobrar. Compensar aqui custa apenas liberar o assento — depois da
  // cobranca, custaria um estorno.
  const bloqueio = await assertNotQuarantined(order, 'risk');
  if (bloqueio) return compensate(order.id, `antifraude: ${bloqueio}`);

  try {
    await request(`${config.paymentsUrl}/charges`, {
      method: 'POST',
      target: 'payments',
      // Sem retry as cegas: se der timeout, reconciliamos em vez de recobrar.
      retries: 0,
      timeoutMs: 5000,
      body: {
        sagaId: order.saga_id,
        orderId: order.id,
        userId: order.user_id,
        amountCents: order.amount_cents,
        idempotencyKey: order.saga_id,
      },
    });
    await logStep(order.saga_id, 'charge', 'ok');
    return transition(order.id, 'RESERVED', 'PAID');
  } catch (err) {
    if (err instanceof RemoteError && err.status === 402) {
      await logStep(order.saga_id, 'charge', 'declined', 'pagamento recusado');
      return compensate(order.id, 'pagamento recusado');
    }

    // ESTA e a parte que importa. O timeout nao diz se cobrou.
    const charge = await reconcileCharge(order.saga_id);
    if (charge === 'CAPTURED') {
      await logStep(order.saga_id, 'charge', 'reconciled', 'cobranca existia apesar do timeout');
      return transition(order.id, 'RESERVED', 'PAID');
    }

    await logStep(order.saga_id, 'charge', 'retry', String(err));
    await reschedule(order.id, 3);
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Passo 3 — confirmar o assento e emitir o ingresso
// ---------------------------------------------------------------------------

async function stepConfirm(order: OrderRow): Promise<OrderRow | undefined> {
  // Ordem deliberada: confirma o assento no inventory ANTES de emitir.
  //
  // Se fosse ao contrario e a confirmacao remota falhasse, o hold expiraria e o
  // assento voltaria a ser vendido — com um ingresso valido ja emitido. Nesta
  // ordem, o pior caso e um ingresso ainda nao emitido para um assento ja
  // vendido, que a proxima tentativa resolve.
  // Segunda verificacao, agora com o pagamento ja capturado. Se a quarentena
  // chegou nesta janela, a compensacao inclui estorno — e o cenario que prova
  // que o passo de risco e parte da SAGA, e nao um porteiro na entrada.
  const bloqueio = await assertNotQuarantined(order, 'risk.post-payment');
  if (bloqueio) return compensate(order.id, `antifraude apos pagamento: ${bloqueio}`);

  try {
    await request(`${config.inventoryUrl}/holds/${order.saga_id}/confirm`, {
      method: 'POST',
      target: 'inventory',
      retries: 2,
      body: { orderId: order.id },
    });
  } catch (err) {
    if (err instanceof RemoteError && err.status === 409) {
      // O hold expirou antes de confirmarmos. Ja pagamos: compensa com estorno.
      await logStep(order.saga_id, 'confirm', 'hold-expired', 'hold vencido apos o pagamento');
      return compensate(order.id, 'reserva expirou antes da confirmacao');
    }
    await logStep(order.saga_id, 'confirm', 'retry', String(err));
    await reschedule(order.id, 2);
    return undefined;
  }

  // Emitir o ingresso e confirmar o pedido acontecem na MESMA transacao local.
  // E o que elimina a janela "pago, ingresso ainda nao emitido" — ela nao
  // existe porque nao ha salto de rede entre as duas coisas.
  const ticketId = randomUUID();
  const ticket = issueTicket({
    ticketId,
    orderId: order.id,
    eventId: order.event_id,
    seatId: order.seat_id,
    userId: order.user_id,
    issuedAt: new Date().toISOString(),
  });

  const updated = await transaction(async (client) => {
    await client.query(
      `INSERT INTO tickets (id, order_id, event_id, seat_id, user_id, qr_payload, signature, key_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'VALID')
       ON CONFLICT (order_id) DO NOTHING`,
      [
        ticketId,
        order.id,
        order.event_id,
        order.seat_id,
        order.user_id,
        ticket.qrPayload,
        ticket.signature,
        ticket.keyId,
      ],
    );

    const rows = await query<OrderRow>(
      `UPDATE orders SET status = 'CONFIRMED', updated_at = now() WHERE id = $1 AND status = 'PAID' RETURNING *`,
      [order.id],
      client,
    );

    await enqueue(client, 'OrderConfirmed', order.event_id, {
      orderId: order.id,
      userId: order.user_id,
      eventId: order.event_id,
      seatId: order.seat_id,
      ticketId,
    });

    return rows[0];
  });

  await logStep(order.saga_id, 'confirm', 'ok');
  return updated ?? (await load(order.id));
}

// ---------------------------------------------------------------------------
// Compensacao
// ---------------------------------------------------------------------------

async function stepCompensate(order: OrderRow): Promise<OrderRow | undefined> {
  // Estorna se houve cobranca. Idempotente dos dois lados.
  try {
    const charge = await reconcileCharge(order.saga_id);
    if (charge === 'CAPTURED') {
      await request(`${config.paymentsUrl}/charges/${order.saga_id}/refund`, {
        method: 'POST',
        target: 'payments',
        retries: 2,
      });
      await logStep(order.saga_id, 'compensate.refund', 'ok');
    }
  } catch (err) {
    // Um 4xx no estorno nao melhora com o tempo: e erro de contrato, nao de
    // disponibilidade. Retentar para sempre so mantem a SAGA girando no
    // varredor sem nunca terminar.
    //
    // Encontramos isso do jeito certo: o teste do portao antifraude levou a
    // SAGA ao caminho de estorno pela primeira vez, e ela ficou 40 segundos
    // repetindo `payments respondeu 400`. A causa era o cliente HTTP anunciar
    // JSON num POST sem corpo; a causa esta corrigida, mas o laco infinito era
    // um defeito por si so.
    //
    // O pedido para num estado terminal com o motivo explicito. NAO fingimos
    // que o dinheiro voltou: se o estorno nao foi aceito, isso vira trabalho
    // humano, e o log em nivel de erro existe para que alguem saiba.
    const permanente = err instanceof RemoteError && err.status !== undefined && err.status < 500;
    if (permanente || order.attempts >= MAX_COMPENSATION_ATTEMPTS) {
      await logStep(order.saga_id, 'compensate.refund', 'desistiu', String(err));
      log.error('estorno nao aceito: pedido precisa de intervencao manual', {
        orderId: order.id,
        sagaId: order.saga_id,
        attempts: order.attempts,
        error: String(err),
      });
      return fail(order.id, `estorno nao aceito, requer intervencao manual: ${String(err)}`);
    }
    await logStep(order.saga_id, 'compensate.refund', 'retry', String(err));
    await reschedule(order.id, 3);
    return undefined;
  }

  // Libera o assento. 404 aqui e sucesso: nao havia o que liberar.
  try {
    await request(`${config.inventoryUrl}/holds/${order.saga_id}/release`, {
      method: 'POST',
      target: 'inventory',
      retries: 2,
      body: { reason: 'compensated' },
    });
    await logStep(order.saga_id, 'compensate.release', 'ok');
  } catch (err) {
    if (!(err instanceof RemoteError && err.status === 404)) {
      await logStep(order.saga_id, 'compensate.release', 'retry', String(err));
      await reschedule(order.id, 3);
      return undefined;
    }
  }

  return fail(order.id, order.failure_reason ?? 'compensado');
}

// ---------------------------------------------------------------------------
// Reconciliacao — perguntar o estado real em vez de presumir
// ---------------------------------------------------------------------------

async function reconcileHold(sagaId: string): Promise<string | undefined> {
  try {
    const res = await request<{ status: string }>(`${config.inventoryUrl}/holds/${sagaId}`, {
      target: 'inventory',
      retries: 1,
    });
    return res.status;
  } catch {
    return undefined;
  }
}

async function reconcileCharge(sagaId: string): Promise<string | undefined> {
  try {
    const res = await request<{ status: string }>(`${config.paymentsUrl}/charges/${sagaId}`, {
      target: 'payments',
      retries: 1,
    });
    return res.status;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Transicoes de estado
// ---------------------------------------------------------------------------

async function transition(
  orderId: string,
  from: OrderStatus,
  to: OrderStatus,
): Promise<OrderRow | undefined> {
  const rows = await query<OrderRow>(
    `UPDATE orders
        SET status = $3, updated_at = now(), next_attempt_at = now()
      WHERE id = $1 AND status = $2
      RETURNING *`,
    [orderId, from, to],
  );
  return rows[0] ?? (await load(orderId));
}

async function compensate(orderId: string, reason: string): Promise<OrderRow | undefined> {
  const rows = await query<OrderRow>(
    `UPDATE orders
        SET status = 'COMPENSATING', failure_reason = $2, updated_at = now(), next_attempt_at = now()
      WHERE id = $1 AND status NOT IN ('CONFIRMED','FAILED')
      RETURNING *`,
    [orderId, reason],
  );
  return rows[0] ?? (await load(orderId));
}

async function fail(orderId: string, reason: string): Promise<OrderRow | undefined> {
  const updated = await transaction(async (client) => {
    const rows = await query<OrderRow>(
      `UPDATE orders
          SET status = 'FAILED', failure_reason = $2, updated_at = now()
        WHERE id = $1 AND status <> 'CONFIRMED'
        RETURNING *`,
      [orderId, reason],
      client,
    );
    if (rows[0]) {
      await enqueue(client, 'OrderFailed', rows[0].event_id, { orderId, reason });
    }
    return rows[0];
  });
  return updated ?? (await load(orderId));
}

export async function load(orderId: string): Promise<OrderRow | undefined> {
  const rows = await query<OrderRow>(`SELECT * FROM orders WHERE id = $1`, [orderId]);
  return rows[0];
}

// ---------------------------------------------------------------------------
// Varredor de SAGAs travadas
//
// A rede de seguranca do sistema. Se o processo morrer entre dois passos, ou se
// uma dependencia ficar fora do ar tempo demais, e este loop que garante que a
// SAGA chega a um estado terminal em vez de ficar pendurada para sempre.
// ---------------------------------------------------------------------------

let sweeperTimer: NodeJS.Timeout | undefined;

export function startSagaSweeper(intervalMs = 2000): void {
  if (sweeperTimer) return;
  sweeperTimer = setInterval(() => {
    void (async () => {
      try {
        const stuck = await query<{ id: string }>(
          `SELECT id FROM orders
            WHERE status IN ('PENDING','RESERVED','PAID','COMPENSATING')
              AND next_attempt_at <= now()
            ORDER BY next_attempt_at
            LIMIT 50`,
        );
        for (const { id } of stuck) {
          try {
            await advanceSaga(id, 3);
          } catch (err) {
            log.warn('falha ao retomar saga', { orderId: id, error: String(err) });
          }
        }
        if (stuck.length > 0) log.info('sagas retomadas pelo varredor', { count: stuck.length });
      } catch (err) {
        log.warn('falha no varredor de sagas', { error: String(err) });
      }
    })();
  }, intervalMs);
  sweeperTimer.unref();
}

export function stopSagaSweeper(): void {
  if (sweeperTimer) clearInterval(sweeperTimer);
  sweeperTimer = undefined;
}
