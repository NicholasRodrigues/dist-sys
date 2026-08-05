import { createHash } from 'node:crypto';
import { pool, query } from './db.js';

/**
 * Idempotencia por chave explicita, de ponta a ponta.
 *
 * A chave vem do cliente, e a resposta produzida fica gravada com ela. Uma
 * retentativa recebe **exatamente a mesma resposta**, e nao uma equivalente —
 * e a diferenca entre "cobrou uma vez" e "provavelmente cobrou uma vez".
 *
 * Tres caminhos possiveis:
 *  - chave nova            -> executa e grava
 *  - chave concluida       -> devolve a resposta gravada, sem reexecutar
 *  - chave em voo          -> espera o vencedor terminar e devolve a resposta dele
 *
 * Reuso de chave com corpo diferente e recusado: e quase sempre um bug do
 * cliente, e aceitar silenciosamente esconderia o bug.
 */

export class IdempotencyConflict extends Error {
  constructor() {
    super('chave de idempotencia reutilizada com um corpo diferente');
    this.name = 'IdempotencyConflict';
  }
}

export interface IdempotentResult<T> {
  value: T;
  replayed: boolean;
}

function fingerprintOf(body: unknown): string {
  return createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');
}

interface KeyRow {
  state: string;
  response: unknown;
  fingerprint: string;
}

export async function withIdempotency<T>(
  key: string,
  body: unknown,
  handler: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  const fingerprint = fingerprintOf(body);

  const claimed = await query<{ key: string }>(
    `INSERT INTO idempotency_keys (key, fingerprint, state)
     VALUES ($1, $2, 'in_flight')
     ON CONFLICT (key) DO NOTHING
     RETURNING key`,
    [key, fingerprint],
  );

  if (claimed.length > 0) {
    try {
      const value = await handler();
      await query(
        `UPDATE idempotency_keys SET state = 'done', response = $2, completed_at = now() WHERE key = $1`,
        [key, JSON.stringify(value)],
      );
      return { value, replayed: false };
    } catch (err) {
      // Libera a chave: um erro nao pode deixar o cliente preso para sempre.
      await query(`DELETE FROM idempotency_keys WHERE key = $1 AND state = 'in_flight'`, [key]);
      throw err;
    }
  }

  // Alguem chegou antes. Espera o vencedor concluir.
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const rows = await query<KeyRow>(
      `SELECT state, response, fingerprint FROM idempotency_keys WHERE key = $1`,
      [key],
    );
    const row = rows[0];
    if (!row) break; // o vencedor falhou e liberou a chave; tenta de novo
    if (row.fingerprint !== fingerprint) throw new IdempotencyConflict();
    if (row.state === 'done') return { value: row.response as T, replayed: true };
    await new Promise((r) => setTimeout(r, 40));
  }

  // O vencedor liberou a chave (erro) ou demorou demais: tenta assumir.
  return withIdempotency(key, body, handler);
}

export async function purgeIdempotencyKeys(olderThanHours = 24): Promise<number> {
  const rows = await query<{ count: number }>(
    `WITH deleted AS (
       DELETE FROM idempotency_keys WHERE created_at < now() - ($1 || ' hours')::interval RETURNING 1
     ) SELECT count(*)::bigint AS count FROM deleted`,
    [olderThanHours],
    pool,
  );
  return Number(rows[0]?.count ?? 0);
}
