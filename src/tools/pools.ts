import pg from 'pg';

/**
 * As ferramentas de operacao falam com varios bancos ao mesmo tempo — os
 * servicos, nao. Cada servico so conhece o proprio banco; estes utilitarios
 * existem fora dessa fronteira de proposito, para poder verificar invariantes
 * que cruzam servicos.
 */

const { Pool } = pg;

pg.types.setTypeParser(20, (v) => Number(v));
pg.types.setTypeParser(1700, (v) => Number(v));

const host = process.env.POSTGRES_HOST ?? 'localhost';
const port = Number(process.env.POSTGRES_PORT ?? 5432);
const user = process.env.POSTGRES_USER ?? 'bilheteria';
const password = process.env.POSTGRES_PASSWORD ?? 'bilheteria';

export function poolFor(database: string): pg.Pool {
  return new Pool({ host, port, user, password, database, max: 4 });
}

export const urls = {
  edge: process.env.EDGE_URL ?? 'http://localhost:8080',
  catalog: process.env.CATALOG_URL ?? 'http://localhost:3001',
  inventory: process.env.INVENTORY_URL ?? 'http://localhost:3002',
  orders: process.env.ORDERS_URL ?? 'http://localhost:3003',
  payments: process.env.PAYMENTS_URL ?? 'http://localhost:3004',
  realtime: process.env.REALTIME_URL ?? 'http://localhost:3005',
  psp: process.env.PSP_URL ?? 'http://localhost:3010',
  riskEventApi: process.env.RISK_EVENT_API_URL ?? 'http://localhost:3020',
  riskWorker: process.env.RISK_WORKER_URL ?? 'http://localhost:3021',
  riskApi: process.env.RISK_API_URL ?? 'http://localhost:3022',
};

export async function waitFor(url: string, label: string, attempts = 90): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
      if (res.ok) return;
    } catch {
      /* ainda subindo */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${label} nao ficou disponivel em ${attempts}s (${url})`);
}
