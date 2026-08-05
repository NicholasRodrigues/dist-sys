import { urls } from './pools.js';

/**
 * Le ou altera feature flags em tempo de execucao.
 *
 *   node dist/tools/flags.js                          -> lista
 *   node dist/tools/flags.js admission_rate=100       -> altera
 *   node dist/tools/flags.js queue_enabled=false
 *
 * E o mecanismo que torna o teste C3 possivel: a mesma carga roda duas vezes e
 * a unica coisa que muda entre elas e uma chave no Redis.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2).filter((a) => a.includes('='));

  if (args.length === 0) {
    const res = await fetch(`${urls.edge}/api/admin/flags`);
    const flags = (await res.json()) as Record<string, string>;
    console.log('\n  FEATURE FLAGS');
    console.log('  ' + '-'.repeat(48));
    for (const [key, value] of Object.entries(flags)) {
      console.log(`  ${key.padEnd(24)} ${value}`);
    }
    console.log('');
    return;
  }

  const body: Record<string, string> = {};
  for (const arg of args) {
    const [key, ...rest] = arg.split('=');
    body[key] = rest.join('=');
  }

  const res = await fetch(`${urls.edge}/api/admin/flags`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const out = await res.json();
  if (!res.ok) {
    console.error('  falha ao alterar flags:', out);
    process.exit(1);
  }
  console.log('  flags aplicadas:', JSON.stringify(out));
}

main().catch((err) => {
  console.error('falha:', err);
  process.exit(1);
});
