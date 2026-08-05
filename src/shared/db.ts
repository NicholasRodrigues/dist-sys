import pg from 'pg';
import { config } from './config.js';
import { log } from './log.js';

const { Pool } = pg;

// Devolve BIGINT/NUMERIC como number: todos os valores do dominio (centavos,
// contadores) cabem com folga em double, e evita string vazando pelas APIs.
pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new Pool({
  host: config.postgresHost,
  port: config.postgresPort,
  user: config.postgresUser,
  password: config.postgresPassword,
  database: config.postgresDb,
  // Pool deliberadamente limitado: e o bulkhead do servico contra o banco.
  max: config.postgresPoolMax,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

pool.on('error', (err) => log.error('erro no pool do postgres', { error: err.message }));

export type Queryable = pg.PoolClient | pg.Pool;

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
  client: Queryable = pool,
): Promise<T[]> {
  const res = await client.query<T>(text, params as never[]);
  return res.rows;
}

/** Executa `fn` dentro de uma transacao, com rollback automatico em erro. */
export async function transaction<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      /* conexao ja perdida: o rollback acontece sozinho no servidor */
    }
    throw err;
  } finally {
    client.release();
  }
}

export async function waitForDatabase(retries = 60): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('postgres nao ficou disponivel a tempo');
}

export async function closeDatabase(): Promise<void> {
  await pool.end();
}
