import { poolFor } from './pools.js';

/**
 * As cinco consultas que nao podem retornar linha.
 *
 * Este e o teste mais barato e mais valioso do projeto: roda em segundos e
 * cobre a invariante que define o dominio. Qualquer resultado nao vazio reprova
 * a rodada inteira, independente do que os percentis disserem.
 */

interface Check {
  id: number;
  name: string;
  database: string;
  sql: string;
  /** Alguns checks nao procuram linhas, e sim um valor especifico. */
  expect?: (rows: Record<string, unknown>[]) => { ok: boolean; detail: string };
}

const CHECKS: Check[] = [
  {
    id: 1,
    name: 'Nenhum assento vendido duas vezes',
    database: 'orders',
    sql: `SELECT event_id, seat_id, count(*)::int AS n
            FROM tickets
           WHERE status IN ('VALID','USED')
           GROUP BY event_id, seat_id
          HAVING count(*) > 1`,
  },
  {
    id: 2,
    name: 'O ledger fecha: soma de todos os lancamentos e zero',
    database: 'payments',
    sql: `SELECT COALESCE(sum(amount_cents), 0)::bigint AS total FROM ledger_entries`,
    expect: (rows) => {
      const total = Number(rows[0]?.total ?? 0);
      return { ok: total === 0, detail: `soma = ${total} centavos` };
    },
  },
  {
    id: 3,
    name: 'Nenhum pedido pago sem ingresso emitido',
    database: 'orders',
    sql: `SELECT o.id, o.status, o.updated_at
            FROM orders o
            LEFT JOIN tickets t ON t.order_id = o.id
           WHERE o.status = 'PAID'
             AND t.id IS NULL
             AND o.updated_at < now() - interval '2 minutes'`,
  },
  {
    id: 4,
    name: 'Nenhum assento preso: hold vencido ainda bloqueando',
    database: 'inventory',
    sql: `SELECT id, event_id, seat_id, expires_at
            FROM seat_holds
           WHERE status = 'HELD'
             AND expires_at < now() - interval '30 seconds'`,
  },
  {
    id: 5,
    name: 'Nenhuma cobranca duplicada para a mesma chave',
    database: 'payments',
    sql: `SELECT idempotency_key, count(*)::int AS n
            FROM charges
           GROUP BY idempotency_key
          HAVING count(*) > 1`,
  },
  {
    id: 6,
    name: 'Nenhum assento vendido sem hold confirmado (consistencia cruzada)',
    database: 'inventory',
    sql: `SELECT event_id, seat_id, count(*)::int AS n
            FROM seat_holds
           WHERE status IN ('HELD','SOLD')
           GROUP BY event_id, seat_id
          HAVING count(*) > 1`,
  },
];

async function main(): Promise<void> {
  const pools = new Map<string, ReturnType<typeof poolFor>>();
  const get = (db: string) => {
    if (!pools.has(db)) pools.set(db, poolFor(db));
    return pools.get(db)!;
  };

  let failures = 0;
  console.log('\n  VERIFICACAO DE INVARIANTES');
  console.log('  ' + '-'.repeat(72));

  for (const check of CHECKS) {
    let ok = true;
    let detail = 'nenhuma linha';
    try {
      const res = await get(check.database).query(check.sql);
      if (check.expect) {
        const verdict = check.expect(res.rows as Record<string, unknown>[]);
        ok = verdict.ok;
        detail = verdict.detail;
      } else {
        ok = res.rows.length === 0;
        detail = ok ? 'nenhuma linha' : `${res.rows.length} violacao(oes): ${JSON.stringify(res.rows.slice(0, 3))}`;
      }
    } catch (err) {
      ok = false;
      detail = `erro ao consultar: ${String(err)}`;
    }

    if (!ok) failures++;
    const mark = ok ? 'OK  ' : 'FALHA';
    console.log(`  ${mark} ${String(check.id).padStart(2)}. ${check.name}`);
    console.log(`        ${detail}`);
  }

  console.log('  ' + '-'.repeat(72));
  for (const pool of pools.values()) await pool.end();

  if (failures > 0) {
    console.log(`\n  ${failures} invariante(s) violada(s). A rodada esta REPROVADA.\n`);
    process.exit(1);
  }
  console.log('\n  Todas as invariantes se mantiveram.\n');
}

main().catch((err) => {
  console.error('falha ao verificar invariantes:', err);
  process.exit(1);
});
