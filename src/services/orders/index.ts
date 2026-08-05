import { randomUUID } from 'node:crypto';
import { closeBus, ensureTopics, startConsumer, waitForBus } from '../../shared/bus.js';
import { config } from '../../shared/config.js';
import { query, transaction, waitForDatabase } from '../../shared/db.js';
import type { OrderConfirmedPayload } from '../../shared/events.js';
import { IdempotencyConflict, withIdempotency } from '../../shared/idempotency.js';
import { log } from '../../shared/log.js';
import { businessEvents } from '../../shared/metrics.js';
import { startOutboxPublisher, stopOutboxPublisher } from '../../shared/outbox.js';
import { bootstrap, createServer } from '../../shared/server.js';
import { advanceSaga, load, startSagaSweeper, stopSagaSweeper, type OrderRow } from './saga.js';
import { KEY_ID, issueTicket, publicKeyPem, verifyTicket } from './ticket.js';

/**
 * orders — dono do processo de compra.
 *
 * Conduz a SAGA, emite o ingresso e valida o check-in na portaria. E o servico
 * mais denso do sistema, e o unico lugar onde se le o estado de qualquer compra.
 */

interface TicketRow {
  id: string;
  order_id: string;
  event_id: string;
  seat_id: string;
  user_id: string;
  qr_payload: string;
  signature: string;
  status: 'VALID' | 'USED' | 'INVALIDATED';
  used_at: Date | null;
}

function serializeOrder(o: OrderRow, ticket?: TicketRow) {
  return {
    orderId: o.id,
    sagaId: o.saga_id,
    userId: o.user_id,
    eventId: o.event_id,
    seatId: o.seat_id,
    amountCents: o.amount_cents,
    status: o.status,
    failureReason: o.failure_reason,
    attempts: o.attempts,
    createdAt: o.created_at.toISOString(),
    ticket: ticket
      ? {
          ticketId: ticket.id,
          status: ticket.status,
          qrCode: `${Buffer.from(ticket.qr_payload).toString('base64url')}.${ticket.signature}`,
        }
      : null,
  };
}

async function ticketFor(orderId: string): Promise<TicketRow | undefined> {
  const rows = await query<TicketRow>(`SELECT * FROM tickets WHERE order_id = $1`, [orderId]);
  return rows[0];
}

bootstrap(async () => {
  await waitForDatabase();
  await waitForBus();
  await ensureTopics();

  let consumer: Awaited<ReturnType<typeof startConsumer>> | undefined;

  return createServer({
    async ready() {
      startOutboxPublisher();
      startSagaSweeper();
      // Consumidor de notificacao: reage a OrderConfirmed sem orquestrador.
      // "Dinheiro orquestra, o resto coreografa."
      consumer = await startConsumer({
        groupId: 'orders-notifier',
        async onEvent(event) {
          if (event.type !== 'OrderConfirmed') return;
          const payload = event.payload as unknown as OrderConfirmedPayload;
          // A chave primaria e o id do evento: a mesma entrega repetida nao
          // gera um segundo envio. E assim que se prova consumidor idempotente.
          const rows = await query<{ event_id: string }>(
            `INSERT INTO notifications (event_id, order_id, channel)
             VALUES ($1, $2, 'email')
             ON CONFLICT (event_id) DO NOTHING
             RETURNING event_id`,
            [event.id, payload.orderId],
          );
          if (rows.length > 0) {
            businessEvents.inc({ event: 'notification_sent' });
            log.info('ingresso enviado', { orderId: payload.orderId, userId: payload.userId });
          }
        },
      });
    },
    async shutdown() {
      stopSagaSweeper();
      stopOutboxPublisher();
      if (consumer) await consumer.disconnect();
      await closeBus();
    },
    routes(app) {
      /**
       * Inicia uma compra.
       *
       * A SAGA e avancada de forma sincrona ate um estado terminal quando da
       * tempo, para que o comprador receba o ingresso na propria resposta. Se
       * algo demorar, ela fica persistida e o varredor termina o trabalho —
       * a resposta rapida e otimizacao, a persistencia e a garantia.
       */
      app.post('/orders', async (req, reply) => {
        const body = req.body as { userId?: string; eventId?: string; seatId?: string };
        const idempotencyKey = req.headers['idempotency-key'];

        if (!body?.userId || !body.eventId || !body.seatId) {
          return reply.code(400).send({ error: 'userId, eventId e seatId sao obrigatorios' });
        }
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
          return reply.code(400).send({ error: 'header Idempotency-Key e obrigatorio' });
        }

        try {
          const result = await withIdempotency(idempotencyKey, body, async () => {
            const orderId = randomUUID();
            const sagaId = randomUUID();

            await query(
              `INSERT INTO orders (id, saga_id, user_id, event_id, seat_id, amount_cents, status)
               VALUES ($1, $2, $3, $4, $5, $6, 'PENDING')`,
              [orderId, sagaId, body.userId, body.eventId, body.seatId, config.ticketPriceCents],
            );
            businessEvents.inc({ event: 'order_created' });

            const finalState = (await advanceSaga(orderId)) ?? (await load(orderId))!;
            const ticket = await ticketFor(orderId);
            return serializeOrder(finalState, ticket);
          });

          const status = result.value.status;
          const code = result.replayed ? 200 : status === 'CONFIRMED' ? 201 : status === 'FAILED' ? 409 : 202;
          return reply.code(code).send({ ...result.value, replayed: result.replayed });
        } catch (err) {
          if (err instanceof IdempotencyConflict) {
            return reply.code(422).send({ error: err.message });
          }
          throw err;
        }
      });

      app.get('/orders/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const order = await load(id);
        if (!order) return reply.code(404).send({ error: 'pedido inexistente' });
        return serializeOrder(order, await ticketFor(id));
      });

      /** Empurra a SAGA manualmente. Util na demonstracao de resiliencia. */
      app.post('/orders/:id/advance', async (req, reply) => {
        const { id } = req.params as { id: string };
        const order = await load(id);
        if (!order) return reply.code(404).send({ error: 'pedido inexistente' });
        await query(`UPDATE orders SET next_attempt_at = now() WHERE id = $1`, [id]);
        const advanced = (await advanceSaga(id)) ?? order;
        return serializeOrder(advanced, await ticketFor(id));
      });

      app.get('/orders/:id/saga', async (req) => {
        const { id } = req.params as { id: string };
        const order = await load(id);
        const steps = order
          ? await query<{ step: string; outcome: string; detail: string | null; created_at: Date }>(
              `SELECT step, outcome, detail, created_at FROM saga_log WHERE saga_id = $1 ORDER BY id`,
              [order.saga_id],
            )
          : [];
        return {
          orderId: id,
          status: order?.status ?? 'unknown',
          steps: steps.map((s) => ({
            step: s.step,
            outcome: s.outcome,
            detail: s.detail,
            at: s.created_at.toISOString(),
          })),
        };
      });

      app.get('/users/:userId/orders', async (req) => {
        const { userId } = req.params as { userId: string };
        const rows = await query<OrderRow>(
          `SELECT * FROM orders WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
          [userId],
        );
        return { orders: rows.map((o) => serializeOrder(o)) };
      });

      // ---------------------------------------------------------------------
      // Portaria
      // ---------------------------------------------------------------------

      /** Chave publica de verificacao: permite validar o QR offline. */
      app.get('/checkin/public-key', async () => ({ keyId: KEY_ID, publicKey: publicKeyPem() }));

      /**
       * Check-in. Duas defesas independentes:
       *  1. a assinatura prova que o ingresso foi emitido por nos;
       *  2. o UPDATE condicional garante que ele so entra UMA vez.
       */
      app.post('/checkin', async (req, reply) => {
        const body = req.body as { qrCode?: string };
        if (!body?.qrCode) return reply.code(400).send({ error: 'qrCode e obrigatorio' });

        const verified = verifyTicket(body.qrCode);
        if (!verified.ok) {
          businessEvents.inc({ event: 'checkin_rejected' });
          return reply.code(403).send({ error: 'ingresso invalido', reason: verified.reason });
        }

        const result = await transaction(async (client) => {
          const rows = await query<TicketRow>(
            `UPDATE tickets SET status = 'USED', used_at = now()
              WHERE id = $1 AND status = 'VALID'
              RETURNING *`,
            [verified.payload.ticketId],
            client,
          );
          if (rows.length > 0) return { outcome: 'admitted' as const, ticket: rows[0] };

          const current = await query<TicketRow>(`SELECT * FROM tickets WHERE id = $1`, [
            verified.payload.ticketId,
          ], client);
          if (current.length === 0) return { outcome: 'unknown' as const };
          return { outcome: 'already-used' as const, ticket: current[0] };
        });

        if (result.outcome === 'unknown') {
          businessEvents.inc({ event: 'checkin_rejected' });
          // Assinatura valida mas ingresso desconhecido: so acontece se o banco
          // foi limpo. Ainda assim, recusa.
          return reply.code(404).send({ error: 'ingresso nao encontrado' });
        }
        if (result.outcome === 'already-used') {
          businessEvents.inc({ event: 'checkin_rejected' });
          return reply.code(409).send({
            error: 'ingresso ja utilizado',
            usedAt: result.ticket.used_at?.toISOString(),
          });
        }

        businessEvents.inc({ event: 'checkin_admitted' });
        return {
          admitted: true,
          ticketId: result.ticket.id,
          eventId: result.ticket.event_id,
          seatId: result.ticket.seat_id,
        };
      });

      // ---------------------------------------------------------------------
      // Apoio a testes e a demonstracao
      // ---------------------------------------------------------------------

      /** Assina um QR arbitrario com uma chave FALSA, para provar a rejeicao. */
      app.post('/checkin/forge', async (req) => {
        const body = (req.body ?? {}) as Record<string, string>;
        const forged = issueTicket({
          ticketId: body.ticketId ?? randomUUID(),
          orderId: body.orderId ?? randomUUID(),
          eventId: body.eventId ?? 'evt',
          seatId: body.seatId ?? 'A-1',
          userId: body.userId ?? 'atacante',
          issuedAt: new Date().toISOString(),
        });
        // Corrompe a assinatura: o payload continua plausivel, a prova nao.
        const [payload] = forged.qrCode.split('.');
        return { qrCode: `${payload}.${'A'.repeat(86)}` };
      });

      app.get('/stats', async () => {
        const rows = await query<{ status: string; count: number }>(
          `SELECT status, count(*)::bigint AS count FROM orders GROUP BY status`,
        );
        const byStatus: Record<string, number> = {};
        for (const r of rows) byStatus[r.status] = Number(r.count);
        const [tickets] = await query<{ count: number }>(
          `SELECT count(*)::bigint AS count FROM tickets WHERE status IN ('VALID','USED')`,
        );
        return { orders: byStatus, tickets: Number(tickets?.count ?? 0) };
      });
    },
  });
});
