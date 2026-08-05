import { urls } from './pools.js';

/**
 * Controla a injecao de falha no PSP falso.
 *
 *   node dist/tools/psp.js                       -> estado atual
 *   node dist/tools/psp.js reset                 -> zera tudo
 *   node dist/tools/psp.js latencyMs=5000        -> latencia artificial
 *   node dist/tools/psp.js errorRate=0.5         -> metade das chamadas falha
 *   node dist/tools/psp.js timeoutRate=1         -> processa e nunca responde
 *   node dist/tools/psp.js down=true             -> indisponivel
 *
 * Substitui o Toxiproxy. O PSP e nosso, entao ele mesmo oferece os controles —
 * mais simples de operar e muito mais legivel na demonstracao.
 */
async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args[0] === 'reset') {
    const res = await fetch(`${urls.psp}/admin/reset`, { method: 'POST' });
    console.log('  injecao de falha zerada:', JSON.stringify(await res.json()));
    return;
  }

  const pairs = args.filter((a) => a.includes('='));
  if (pairs.length === 0) {
    const res = await fetch(`${urls.psp}/admin/config`);
    console.log('  estado do psp:', JSON.stringify(await res.json()));
    return;
  }

  const body: Record<string, number | boolean> = {};
  for (const pair of pairs) {
    const [key, raw] = pair.split('=');
    body[key] = raw === 'true' ? true : raw === 'false' ? false : Number(raw);
  }

  const res = await fetch(`${urls.psp}/admin/config`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log('  psp configurado:', JSON.stringify(await res.json()));
}

main().catch((err) => {
  console.error('falha:', err);
  process.exit(1);
});
