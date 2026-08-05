import { randomUUID } from 'node:crypto';
import { config } from '../../shared/config.js';
import { query, transaction, waitForDatabase } from '../../shared/db.js';
import { closeBus, ensureTopics, waitForBus } from '../../shared/bus.js';
import { log } from '../../shared/log.js';
import { businessEvents } from '../../shared/metrics.js';
import { enqueue, startOutboxPublisher, stopOutboxPublisher } from '../../shared/outbox.js';
import { bootstrap, createServer } from '../../shared/server.js';

/**
 * inventory — dono da verdade sobre o assento.
 *
 * O servico mais curto do sistema e o mais importante. Toda a garantia de
 * "zero overselling" cabe na transacao de `POST /holds`, e ela e curta de
 * proposito: quanto menor a secao critica, maior a vazao sob contencao.
 */

interface HoldRow {
  id: string;
  event_id: string;
  seat_id: string;
  saga_id: string;
  user_id: string;
  status: 'HELD' | 'SOLD' | 'RELEASED';
  expires_at: Date;
}

function serialize(h: HoldRow) {
  return {
    holdId: h.id,
    eventId: h.event_id,
    seatId: h.seat_id,
    sagaId: h.saga_id,
    userId: h.user_id,
    status: h.status,
    expiresAt: h.expires_at.toISOString(),
  };
}

bootstrap(async () => {
  await waitForDatabase();
  await waitForBus();
  await ensureTopics();

  return createServer({
    async ready() {
      startOutboxPublisher();
      startReaper();
    },
    async shutdown() {
      stopReaper();
      stopOutboxPublisher();
      await closeBus();
    },
    routes(app) {
      /**
       * Reserva um assento.
       *
       * Idempotente por `sagaId`: repetir a chamada devolve o mesmo hold em vez
       * de criar um segundo. A SAGA depende disso — ela retenta este passo.
       */
      app.post('/holds', async (req, reply) => {
        const body = req.body as {
          sagaId?: string;
          eventId?: string;
          seatId?: string;
          userId?: string;
          ttlSeconds?: number;
        };

        if (!body?.sagaId || !body.eventId || !body.seatId || !body.userId) {
          return reply.code(400).send({ error: 'sagaId, eventId, seatId e userId sao obrigatorios' });
        }

        const ttl = body.ttlSeconds ?? config.holdTtlSeconds;

        try {
          const result = await transaction(async (client) => {
            // Retentativa da mesma saga: devolve o que ja existe.
            const existing = await query<HoldRow>(
              `SELECT * FROM seat_holds WHERE saga_id = $1`,
              [body.sagaId],
              client,
            );
            if (existing.length > 0) return { hold: existing[0], created: false };

            const seat = await query<{ seat_id: string }>(
              `SELECT seat_id FROM seats WHERE event_id = $1 AND seat_id = $2`,
              [body.eventId, body.seatId],
              client,
            );
            if (seat.length === 0) throw new SeatNotFound();

            const id = randomUUID();
            // O INSERT abaixo e a secao critica inteira. Se outra transacao ja
            // tem o assento, o indice parcial unico rejeita aqui.
            const rows = await query<HoldRow>(
              `INSERT INTO seat_holds (id, event_id, seat_id, saga_id, user_id, status, expires_at)
               VALUES ($1, $2, $3, $4, $5, 'HELD', now() + ($6 || ' seconds')::interval)
               RETURNING *`,
              [id, body.eventId, body.seatId, body.sagaId, body.userId, ttl],
              client,
            );

            const hold = rows[0];
            await enqueue(client, 'SeatHeld', body.eventId!, {
              eventId: body.eventId,
              seatId: body.seatId,
              sagaId: body.sagaId,
              expiresAt: hold.expires_at.toISOString(),
            });
            return { hold, created: true };
          });

          if (result.created) businessEvents.inc({ event: 'seat_held' });
          return reply.code(result.created ? 201 : 200).send(serialize(result.hold));
        } catch (err) {
          if (err instanceof SeatNotFound) {
            return reply.code(404).send({ error: 'assento inexistente' });
          }
          // 23505 = unique_violation. Aqui isso NAO e um erro do sistema: e a
          // invariante funcionando. Outra pessoa levou o assento primeiro.
          if (isUniqueViolation(err)) {
            businessEvents.inc({ event: 'seat_conflict' });
            return reply.code(409).send({ error: 'assento indisponivel', seatId: body.seatId });
          }
          throw err;
        }
      });

      /** Confirma a venda. Idempotente: chamar duas vezes mantem SOLD. */
      app.post('/holds/:sagaId/confirm', async (req, reply) => {
        const { sagaId } = req.params as { sagaId: string };
        const body = (req.body ?? {}) as { orderId?: string };

        const result = await transaction(async (client) => {
          const rows = await query<HoldRow>(
            `SELECT * FROM seat_holds WHERE saga_id = $1 FOR UPDATE`,
            [sagaId],
            client,
          );
          const hold = rows[0];
          if (!hold) return { status: 'not-found' as const };
          if (hold.status === 'SOLD') return { status: 'already' as const, hold };
          if (hold.status === 'RELEASED') return { status: 'released' as const, hold };

          const updated = await query<HoldRow>(
            `UPDATE seat_holds SET status = 'SOLD', sold_at = now() WHERE saga_id = $1 RETURNING *`,
            [sagaId],
            client,
          );
          await enqueue(client, 'SeatSold', hold.event_id, {
            eventId: hold.event_id,
            seatId: hold.seat_id,
            sagaId,
            orderId: body.orderId ?? '',
          });
          return { status: 'confirmed' as const, hold: updated[0] };
        });

        if (result.status === 'not-found') return reply.code(404).send({ error: 'hold inexistente' });
        if (result.status === 'released') {
          // O hold expirou antes de a SAGA confirmar. Nao da para vender: o
          // assento pode ja ser de outra pessoa.
          return reply.code(409).send({ error: 'hold ja liberado', sagaId });
        }
        if (result.status === 'confirmed') businessEvents.inc({ event: 'seat_sold' });
        return serialize(result.hold);
      });

      /** Compensacao: libera o assento. Idempotente. */
      app.post('/holds/:sagaId/release', async (req, reply) => {
        const { sagaId } = req.params as { sagaId: string };
        const body = (req.body ?? {}) as { reason?: 'expired' | 'compensated' | 'cancelled' };

        const result = await transaction(async (client) => {
          const rows = await query<HoldRow>(
            `SELECT * FROM seat_holds WHERE saga_id = $1 FOR UPDATE`,
            [sagaId],
            client,
          );
          const hold = rows[0];
          if (!hold) return { status: 'not-found' as const };
          if (hold.status === 'RELEASED') return { status: 'already' as const, hold };

          const updated = await query<HoldRow>(
            `UPDATE seat_holds SET status = 'RELEASED', released_at = now() WHERE saga_id = $1 RETURNING *`,
            [sagaId],
            client,
          );
          await enqueue(client, 'SeatReleased', hold.event_id, {
            eventId: hold.event_id,
            seatId: hold.seat_id,
            sagaId,
            reason: body.reason ?? 'compensated',
          });
          return { status: 'released' as const, hold: updated[0] };
        });

        if (result.status === 'not-found') return reply.code(404).send({ error: 'hold inexistente' });
        if (result.status === 'released') businessEvents.inc({ event: 'seat_released' });
        return serialize(result.hold);
      });

      /**
       * Consulta por saga.
       *
       * Existe para a reconciliacao: diante de um timeout, o orquestrador
       * pergunta o estado real em vez de presumir que a chamada falhou.
       */
      app.get('/holds/:sagaId', async (req, reply) => {
        const { sagaId } = req.params as { sagaId: string };
        const rows = await query<HoldRow>(`SELECT * FROM seat_holds WHERE saga_id = $1`, [sagaId]);
        if (rows.length === 0) return reply.code(404).send({ error: 'hold inexistente' });
        return serialize(rows[0]);
      });

      app.get('/events/:eventId/availability', async (req) => {
        const { eventId } = req.params as { eventId: string };
        const rows = await query<{ total: number; taken: number }>(
          `SELECT
             (SELECT count(*)::bigint FROM seats WHERE event_id = $1) AS total,
             (SELECT count(*)::bigint FROM seat_holds
               WHERE event_id = $1 AND status IN ('HELD','SOLD')) AS taken`,
          [eventId],
        );
        const total = Number(rows[0]?.total ?? 0);
        const taken = Number(rows[0]?.taken ?? 0);
        return { eventId, total, taken, available: total - taken };
      });
    },
  });
});

class SeatNotFound extends Error {}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

// ---------------------------------------------------------------------------
// Reaper de holds vencidos.
//
// Sem isto, uma SAGA que morre entre a reserva e a cobranca bloqueia o assento
// para sempre — o pior vazamento possivel num sistema de venda de ingresso,
// porque faz o evento parecer esgotado quando nao esta.
// ---------------------------------------------------------------------------

let reaperTimer: NodeJS.Timeout | undefined;

function startReaper(intervalMs = 2000): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(() => {
    void (async () => {
      try {
        const released = await transaction(async (client) => {
          const rows = await query<HoldRow>(
            `UPDATE seat_holds
                SET status = 'RELEASED', released_at = now()
              WHERE id IN (
                SELECT id FROM seat_holds
                 WHERE status = 'HELD' AND expires_at < now()
                 ORDER BY expires_at
                 LIMIT 500
                 FOR UPDATE SKIP LOCKED
              )
              RETURNING *`,
            [],
            client,
          );
          for (const hold of rows) {
            await enqueue(client, 'SeatReleased', hold.event_id, {
              eventId: hold.event_id,
              seatId: hold.seat_id,
              sagaId: hold.saga_id,
              reason: 'expired',
            });
          }
          return rows.length;
        });
        if (released > 0) {
          businessEvents.inc({ event: 'hold_expired' }, released);
          log.info('holds vencidos liberados', { count: released });
        }
      } catch (err) {
        log.warn('falha no reaper', { error: String(err) });
      }
    })();
  }, intervalMs);
  reaperTimer.unref();
}

function stopReaper(): void {
  if (reaperTimer) clearInterval(reaperTimer);
  reaperTimer = undefined;
}
