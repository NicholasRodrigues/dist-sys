import { closeBus, ensureTopics, startConsumer, waitForBus } from '../../shared/bus.js';
import { query, transaction, waitForDatabase } from '../../shared/db.js';
import type { SeatHeldPayload, SeatReleasedPayload, SeatSoldPayload } from '../../shared/events.js';
import { log } from '../../shared/log.js';
import { cacheOps } from '../../shared/metrics.js';
import { redis, waitForRedis } from '../../shared/redis.js';
import { bootstrap, createServer } from '../../shared/server.js';

/**
 * catalog — o lado de LEITURA do CQRS.
 *
 * Existe como servico proprio por perfil de escala: leitura e ordens de
 * magnitude maior que escrita e tolera defasagem. Nunca e consultado de forma
 * sincrona no caminho da compra.
 *
 * Duas camadas de leitura:
 *  1. cache-aside no Redis, com TTL curto;
 *  2. read model desnormalizado no Postgres, mantido por eventos.
 *
 * O mapa exibido na tela e, por construcao, levemente defasado. Isso e
 * aceitavel e e comunicado: a confirmacao de que o assento e seu acontece na
 * reserva, nao na visualizacao.
 */

const SEATMAP_TTL_SECONDS = 5;

interface SeatViewRow {
  seat_id: string;
  section: string;
  row_label: string;
  seat_no: number;
  status: 'AVAILABLE' | 'HELD' | 'SOLD';
}

async function readSeatmap(eventId: string, section?: string): Promise<unknown> {
  const cacheKey = `seatmap:${eventId}:${section ?? 'all'}`;

  // Cache-aside: le do cache, cai para o banco, repopula.
  try {
    const cached = await redis.get(cacheKey);
    if (cached) {
      cacheOps.inc({ result: 'hit' });
      return JSON.parse(cached);
    }
    cacheOps.inc({ result: 'miss' });
  } catch {
    cacheOps.inc({ result: 'error' });
  }

  const seats = section
    ? await query<SeatViewRow>(
        `SELECT seat_id, section, row_label, seat_no, status
           FROM seat_view WHERE event_id = $1 AND section = $2
          ORDER BY row_label, seat_no`,
        [eventId, section],
      )
    : await query<SeatViewRow>(
        `SELECT seat_id, section, row_label, seat_no, status
           FROM seat_view WHERE event_id = $1
          ORDER BY section, row_label, seat_no`,
        [eventId],
      );

  const stats = await query<{ available: number; held: number; sold: number }>(
    `SELECT available, held, sold FROM event_stats WHERE event_id = $1`,
    [eventId],
  );

  const payload = {
    eventId,
    section: section ?? null,
    // Contadores vem da materialized view, e nao de um count() sobre 40.000
    // linhas a cada carregamento de tela.
    stats: stats[0] ?? { available: 0, held: 0, sold: 0 },
    seats: seats.map((s) => ({
      seatId: s.seat_id,
      section: s.section,
      row: s.row_label,
      number: s.seat_no,
      status: s.status,
    })),
  };

  try {
    await redis.setex(cacheKey, SEATMAP_TTL_SECONDS, JSON.stringify(payload));
  } catch {
    /* cache indisponivel nao pode derrubar a leitura */
  }
  return payload;
}

/**
 * Aplica a mudanca de estado do assento no read model.
 *
 * Idempotente por id de evento: o barramento entrega "pelo menos uma vez", e
 * contar a mesma venda duas vezes estragaria a estatistica para sempre.
 */
async function applySeatChange(
  eventUuid: string,
  eventId: string,
  seatId: string,
  status: 'AVAILABLE' | 'HELD' | 'SOLD',
): Promise<void> {
  await transaction(async (client) => {
    const claimed = await query<{ event_uuid: string }>(
      `INSERT INTO processed_events (event_uuid) VALUES ($1)
       ON CONFLICT (event_uuid) DO NOTHING RETURNING event_uuid`,
      [eventUuid],
      client,
    );
    if (claimed.length === 0) return; // ja processado

    const previous = await query<{ status: string }>(
      `SELECT status FROM seat_view WHERE event_id = $1 AND seat_id = $2 FOR UPDATE`,
      [eventId, seatId],
      client,
    );
    const from = previous[0]?.status;
    if (!from || from === status) return;

    await client.query(
      `UPDATE seat_view SET status = $3, updated_at = now() WHERE event_id = $1 AND seat_id = $2`,
      [eventId, seatId, status],
    );

    const column = (s: string): string =>
      s === 'AVAILABLE' ? 'available' : s === 'HELD' ? 'held' : 'sold';
    await client.query(
      `UPDATE event_stats
          SET ${column(from)} = GREATEST(${column(from)} - 1, 0),
              ${column(status)} = ${column(status)} + 1,
              updated_at = now()
        WHERE event_id = $1`,
      [eventId],
    );
  });

  // Invalidacao do cache: sem isso, a tela ficaria ate 5s desatualizada mesmo
  // depois de o read model ja saber da mudanca.
  try {
    const keys = await redis.keys(`seatmap:${eventId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    /* ignorado */
  }
}

bootstrap(async () => {
  await waitForDatabase();
  await waitForRedis();
  await waitForBus();
  await ensureTopics();

  let consumer: Awaited<ReturnType<typeof startConsumer>> | undefined;

  return createServer({
    async ready() {
      consumer = await startConsumer({
        groupId: 'catalog-read-model',
        async onEvent(event) {
          if (event.type === 'SeatHeld') {
            const p = event.payload as unknown as SeatHeldPayload;
            await applySeatChange(event.id, p.eventId, p.seatId, 'HELD');
          } else if (event.type === 'SeatSold') {
            const p = event.payload as unknown as SeatSoldPayload;
            await applySeatChange(event.id, p.eventId, p.seatId, 'SOLD');
          } else if (event.type === 'SeatReleased') {
            const p = event.payload as unknown as SeatReleasedPayload;
            await applySeatChange(event.id, p.eventId, p.seatId, 'AVAILABLE');
          }
        },
      });
      log.info('read model consumindo eventos');
    },
    async shutdown() {
      if (consumer) await consumer.disconnect();
      await closeBus();
    },
    routes(app) {
      app.get('/events', async () => {
        const rows = await query<{
          id: string;
          name: string;
          venue: string;
          starts_at: Date;
          price_cents: number;
          total_seats: number;
        }>(`SELECT * FROM events ORDER BY starts_at`);
        return {
          events: rows.map((e) => ({
            eventId: e.id,
            name: e.name,
            venue: e.venue,
            startsAt: e.starts_at.toISOString(),
            priceCents: e.price_cents,
            totalSeats: e.total_seats,
          })),
        };
      });

      app.get('/events/:eventId', async (req, reply) => {
        const { eventId } = req.params as { eventId: string };
        const rows = await query<{
          id: string;
          name: string;
          venue: string;
          starts_at: Date;
          price_cents: number;
          total_seats: number;
        }>(`SELECT * FROM events WHERE id = $1`, [eventId]);
        if (rows.length === 0) return reply.code(404).send({ error: 'evento inexistente' });
        const stats = await query<{ available: number; held: number; sold: number }>(
          `SELECT available, held, sold FROM event_stats WHERE event_id = $1`,
          [eventId],
        );
        const e = rows[0];
        return {
          eventId: e.id,
          name: e.name,
          venue: e.venue,
          startsAt: e.starts_at.toISOString(),
          priceCents: e.price_cents,
          totalSeats: e.total_seats,
          stats: stats[0] ?? { available: 0, held: 0, sold: 0 },
        };
      });

      app.get('/events/:eventId/seatmap', async (req) => {
        const { eventId } = req.params as { eventId: string };
        const { section } = req.query as { section?: string };
        return readSeatmap(eventId, section);
      });

      /** Um assento disponivel qualquer: o que o teste de carga usa. */
      app.get('/events/:eventId/available-seat', async (req, reply) => {
        const { eventId } = req.params as { eventId: string };
        const { section } = req.query as { section?: string };
        const rows = section
          ? await query<{ seat_id: string }>(
              `SELECT seat_id FROM seat_view
                WHERE event_id = $1 AND section = $2 AND status = 'AVAILABLE'
                ORDER BY random() LIMIT 1`,
              [eventId, section],
            )
          : await query<{ seat_id: string }>(
              `SELECT seat_id FROM seat_view
                WHERE event_id = $1 AND status = 'AVAILABLE'
                ORDER BY random() LIMIT 1`,
              [eventId],
            );
        if (rows.length === 0) return reply.code(404).send({ error: 'sem assentos disponiveis' });
        return { eventId, seatId: rows[0].seat_id };
      });

      app.get('/events/:eventId/stats', async (req) => {
        const { eventId } = req.params as { eventId: string };
        const rows = await query<{ available: number; held: number; sold: number; updated_at: Date }>(
          `SELECT available, held, sold, updated_at FROM event_stats WHERE event_id = $1`,
          [eventId],
        );
        const s = rows[0];
        return {
          eventId,
          available: s?.available ?? 0,
          held: s?.held ?? 0,
          sold: s?.sold ?? 0,
          updatedAt: s?.updated_at?.toISOString() ?? null,
        };
      });
    },
  });
});
