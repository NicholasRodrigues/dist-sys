import { urls } from './pools.js';

/** Esvazia a fila virtual entre rodadas de teste de carga. */
async function main(): Promise<void> {
  const eventId = process.argv[2] ?? process.env.K6_EVENT_ID ?? 'show-do-seculo';
  const res = await fetch(`${urls.edge}/api/admin/queue/reset`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ eventId }),
  });
  console.log('  fila reiniciada:', JSON.stringify(await res.json()));
}

main().catch((err) => {
  console.error('falha:', err);
  process.exit(1);
});
