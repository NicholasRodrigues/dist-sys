import { readFile, writeFile } from 'node:fs/promises';
import { urls } from './pools.js';

/**
 * Estrategias de deployment, com pesos no Traefik.
 *
 *   node dist/tools/deploy.js status
 *   node dist/tools/deploy.js canary 10        -> 10% do trafego para o verde
 *   node dist/tools/deploy.js blue-green green -> troca atomica para o verde
 *   node dist/tools/deploy.js rollback         -> volta 100% para o azul
 *
 * Blue-green e canary sao a MESMA mecanica com pesos diferentes: um e uma
 * troca atomica (0 ou 100), o outro e progressivo. Ver isso explicitamente e
 * mais instrutivo do que tratar os dois como tecnologias distintas.
 *
 * O Traefik observa o arquivo e recarrega sozinho: nenhum contentor reinicia,
 * nenhuma conexao cai.
 */

const DYNAMIC = process.env.TRAEFIK_DYNAMIC ?? '/etc/traefik/dynamic.yml';

async function setWeights(blue: number, green: number): Promise<void> {
  const original = await readFile(DYNAMIC, 'utf8');
  // Substituicao cirurgica em vez de reescrever o YAML inteiro: preserva os
  // comentarios do arquivo, que explicam o que ele faz.
  const updated = original.replace(
    /(- name: edge-blue\s*\n\s*weight: )\d+([\s\S]*?- name: edge-green\s*\n\s*weight: )\d+/,
    `$1${blue}$2${green}`,
  );
  if (updated === original && !original.includes(`weight: ${blue}`)) {
    throw new Error('nao consegui localizar os pesos em dynamic.yml');
  }
  await writeFile(DYNAMIC, updated, 'utf8');
}

async function currentWeights(): Promise<{ blue: number; green: number }> {
  const raw = await readFile(DYNAMIC, 'utf8');
  const blue = Number(/- name: edge-blue\s*\n\s*weight: (\d+)/.exec(raw)?.[1] ?? 0);
  const green = Number(/- name: edge-green\s*\n\s*weight: (\d+)/.exec(raw)?.[1] ?? 0);
  return { blue, green };
}

/** Amostra o trafego real para provar que os pesos estao valendo. */
async function sample(n = 40): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    try {
      const res = await fetch(`${urls.edge}/health`, { signal: AbortSignal.timeout(3000) });
      const version = res.headers.get('x-app-version') ?? 'desconhecida';
      counts[version] = (counts[version] ?? 0) + 1;
    } catch {
      counts.erro = (counts.erro ?? 0) + 1;
    }
  }
  return counts;
}

async function waitForReload(): Promise<void> {
  // O watcher do Traefik nao e instantaneo.
  await new Promise((r) => setTimeout(r, 2500));
}

async function main(): Promise<void> {
  const [command, arg] = process.argv.slice(2);

  if (!command || command === 'status') {
    const weights = await currentWeights();
    const distribuicao = await sample(40);
    console.log('\n  ESTADO DO ROTEAMENTO');
    console.log('  ' + '-'.repeat(56));
    console.log(`  peso azul     ${weights.blue}`);
    console.log(`  peso verde    ${weights.green}`);
    console.log(`  amostra real  ${JSON.stringify(distribuicao)}`);
    console.log('');
    return;
  }

  if (command === 'canary') {
    const pct = Math.max(0, Math.min(100, Number(arg ?? 10)));
    await setWeights(100 - pct, pct);
    await waitForReload();
    const distribuicao = await sample(60);
    console.log(`\n  CANARY EM ${pct}%`);
    console.log('  ' + '-'.repeat(56));
    console.log(`  pesos: azul ${100 - pct}, verde ${pct}`);
    console.log(`  amostra de 60 requisicoes: ${JSON.stringify(distribuicao)}`);
    console.log('');
    return;
  }

  if (command === 'blue-green') {
    const alvo = arg === 'green' ? 'green' : 'blue';
    await setWeights(alvo === 'blue' ? 100 : 0, alvo === 'green' ? 100 : 0);
    await waitForReload();
    const distribuicao = await sample(40);
    console.log(`\n  TROCA BLUE-GREEN PARA ${alvo.toUpperCase()}`);
    console.log('  ' + '-'.repeat(56));
    console.log(`  amostra de 40 requisicoes: ${JSON.stringify(distribuicao)}`);
    const somenteAlvo = Object.keys(distribuicao).every((v) => v === alvo);
    console.log(`  troca ${somenteAlvo ? 'completa' : 'INCOMPLETA — ainda ha trafego na outra versao'}`);
    console.log('');
    if (!somenteAlvo) process.exit(1);
    return;
  }

  if (command === 'rollback') {
    await setWeights(100, 0);
    await waitForReload();
    console.log('\n  ROLLBACK: 100% do trafego de volta para o azul\n');
    return;
  }

  console.error(`comando desconhecido: ${command}. Use status, canary, blue-green ou rollback.`);
  process.exit(1);
}

main().catch((err) => {
  console.error('falha no deployment:', err);
  process.exit(1);
});
