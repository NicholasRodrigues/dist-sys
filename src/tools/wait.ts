import { urls, waitFor } from './pools.js';

/** Bloqueia ate todo o sistema responder /health. Usado pelo `make up`. */
async function main(): Promise<void> {
  const targets: [string, string][] = [
    ['edge (via traefik)', `${urls.edge}/health`],
    ['catalog', `${urls.catalog}/health`],
    ['inventory', `${urls.inventory}/health`],
    ['orders', `${urls.orders}/health`],
    ['payments', `${urls.payments}/health`],
    ['realtime', `${urls.realtime}/health`],
    ['psp-sandbox', `${urls.psp}/health`],
  ];

  for (const [label, url] of targets) {
    process.stdout.write(`  aguardando ${label}... `);
    await waitFor(url, label);
    process.stdout.write('pronto\n');
  }
}

main().catch((err) => {
  console.error(`\n  ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
