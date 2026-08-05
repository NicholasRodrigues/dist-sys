import { poolFor } from './pools.js';

/**
 * Popula o ambiente de demonstracao.
 *
 * Escreve nos dois lados do CQRS: os assentos no `inventory` (lado da escrita,
 * fonte da verdade) e o read model no `catalog`. Em producao o read model seria
 * construido a partir de eventos; aqui a carga inicial e direta, porque um seed
 * de 40.000 assentos por evento levaria minutos passando pelo barramento.
 */

const SECTIONS = ['PISTA', 'PISTA-VIP', 'ARQUIBANCADA-A', 'ARQUIBANCADA-B', 'CAMAROTE'];
const ROWS_PER_SECTION = Number(process.env.SEED_ROWS ?? 40);
const SEATS_PER_ROW = Number(process.env.SEED_SEATS_PER_ROW ?? 200);

interface EventSpec {
  id: string;
  name: string;
  venue: string;
  startsAt: string;
  priceCents: number;
  sections: string[];
}

const EVENTS: EventSpec[] = [
  {
    id: 'show-do-seculo',
    name: 'Show do Seculo',
    venue: 'Estadio Central',
    startsAt: '2026-12-20T22:00:00Z',
    priceCents: Number(process.env.TICKET_PRICE_CENTS ?? 25000),
    sections: SECTIONS,
  },
  {
    id: 'festival-verao',
    name: 'Festival de Verao',
    venue: 'Parque das Dunas',
    startsAt: '2027-01-15T18:00:00Z',
    priceCents: 18000,
    sections: ['PISTA', 'CAMAROTE'],
  },
];

async function main(): Promise<void> {
  const inventory = poolFor('inventory');
  const catalog = poolFor('catalog');

  try {
    console.log('limpando dados anteriores...');
    await inventory.query('TRUNCATE seat_holds, seats, outbox, idempotency_keys');
    await catalog.query('TRUNCATE seat_view, event_stats, events, processed_events');

    const orders = poolFor('orders');
    const payments = poolFor('payments');
    await orders.query('TRUNCATE tickets, saga_log, notifications, orders, outbox, idempotency_keys');
    await payments.query('TRUNCATE ledger_entries, charges, outbox, idempotency_keys');
    await orders.end();
    await payments.end();

    for (const spec of EVENTS) {
      const total = spec.sections.length * ROWS_PER_SECTION * SEATS_PER_ROW;

      await catalog.query(
        `INSERT INTO events (id, name, venue, starts_at, price_cents, total_seats)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (id) DO UPDATE SET total_seats = EXCLUDED.total_seats`,
        [spec.id, spec.name, spec.venue, spec.startsAt, spec.priceCents, total],
      );

      // generate_series faz os 40.000 assentos em uma unica ida ao banco.
      // Inserir linha a linha levaria minutos e nao provaria nada.
      for (const section of spec.sections) {
        await inventory.query(
          `INSERT INTO seats (event_id, seat_id, section, row_label, seat_no)
           SELECT $1,
                  $2 || '-' || r::text || '-' || s::text,
                  $2, r::text, s
             FROM generate_series(1, $3) AS r,
                  generate_series(1, $4) AS s
           ON CONFLICT DO NOTHING`,
          [spec.id, section, ROWS_PER_SECTION, SEATS_PER_ROW],
        );

        await catalog.query(
          `INSERT INTO seat_view (event_id, seat_id, section, row_label, seat_no, status)
           SELECT $1,
                  $2 || '-' || r::text || '-' || s::text,
                  $2, r::text, s, 'AVAILABLE'
             FROM generate_series(1, $3) AS r,
                  generate_series(1, $4) AS s
           ON CONFLICT DO NOTHING`,
          [spec.id, section, ROWS_PER_SECTION, SEATS_PER_ROW],
        );
      }

      await catalog.query(
        `INSERT INTO event_stats (event_id, available, held, sold)
         VALUES ($1, $2, 0, 0)
         ON CONFLICT (event_id) DO UPDATE SET available = EXCLUDED.available, held = 0, sold = 0`,
        [spec.id, total],
      );

      console.log(`  ${spec.id}: ${total.toLocaleString('pt-BR')} assentos em ${spec.sections.length} setores`);
    }

    console.log('seed concluido.');
  } finally {
    await inventory.end();
    await catalog.end();
  }
}

main().catch((err) => {
  console.error('falha no seed:', err);
  process.exit(1);
});
