import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { publish } from './bus.js';
import { pool, query } from './db.js';
import type { DomainEvent, EventType } from './events.js';
import { log } from './log.js';
import { outboxLag } from './metrics.js';
import { traceparent } from './trace.js';

/**
 * Transactional Outbox.
 *
 * O evento e gravado na MESMA transacao que muda o estado. Sem isso, um crash
 * entre o commit e a publicacao perderia o evento para sempre — e o read model,
 * a tela ao vivo e a notificacao ficariam permanentemente dessincronizados.
 *
 * Publicar continua sendo "pelo menos uma vez": o publicador pode morrer depois
 * de enviar e antes de marcar. Por isso todo consumidor precisa ser idempotente.
 */

export async function enqueue(
  client: pg.PoolClient,
  type: EventType,
  key: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO outbox (id, type, key, payload, traceparent) VALUES ($1, $2, $3, $4, $5)`,
    [randomUUID(), type, key, JSON.stringify(payload), traceparent() ?? null],
  );
}

interface OutboxRow {
  id: string;
  type: EventType;
  key: string;
  payload: Record<string, unknown>;
  traceparent: string | null;
  created_at: Date;
}

/** Publica um lote pendente. Devolve quantos eventos saíram. */
export async function drainOnce(batchSize = 200): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // SKIP LOCKED permite varias replicas drenando a outbox em paralelo sem
    // que uma bloqueie a outra nem publique o mesmo evento duas vezes.
    const rows = await query<OutboxRow>(
      `SELECT id, type, key, payload, traceparent, created_at
         FROM outbox
        WHERE published_at IS NULL
        ORDER BY created_at
        LIMIT $1
        FOR UPDATE SKIP LOCKED`,
      [batchSize],
      client,
    );

    if (rows.length === 0) {
      await client.query('COMMIT');
      return 0;
    }

    const events: DomainEvent[] = rows.map((r) => ({
      id: r.id,
      type: r.type,
      key: r.key,
      occurredAt: r.created_at.toISOString(),
      traceparent: r.traceparent ?? undefined,
      payload: r.payload,
    }));

    await publish(events);
    await client.query(`UPDATE outbox SET published_at = now() WHERE id = ANY($1::uuid[])`, [
      rows.map((r) => r.id),
    ]);
    await client.query('COMMIT');
    return rows.length;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* ignorado */
    }
    log.warn('falha ao drenar a outbox, sera retentado', { error: String(err) });
    return 0;
  } finally {
    client.release();
  }
}

let timer: NodeJS.Timeout | undefined;

export function startOutboxPublisher(intervalMs = 250): void {
  if (timer) return;
  const tick = async (): Promise<void> => {
    try {
      const sent = await drainOnce();
      // Drena em rajada enquanto houver acumulo, para recuperar rapido depois
      // de uma indisponibilidade do barramento.
      if (sent > 0) setImmediate(() => void tick());
      const [{ count }] = await query<{ count: number }>(
        `SELECT count(*)::bigint AS count FROM outbox WHERE published_at IS NULL`,
      );
      outboxLag.set(Number(count));
    } catch {
      /* medicao nao pode derrubar o loop */
    }
  };
  timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
}

export function stopOutboxPublisher(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}
