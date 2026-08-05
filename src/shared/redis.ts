import { Redis } from 'ioredis';
import { config } from './config.js';
import { log } from './log.js';

export const redis = new Redis({
  host: config.redisHost,
  port: config.redisPort,
  lazyConnect: false,
  maxRetriesPerRequest: 2,
  retryStrategy: (times: number) => Math.min(times * 200, 2000),
});

redis.on('error', (err: Error) => log.debug('erro no redis', { error: err.message }));

export async function waitForRedis(retries = 60): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await redis.ping();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('redis nao ficou disponivel a tempo');
}

/**
 * Feature flags em Redis: alternaveis em tempo de execucao, sem novo deploy.
 * Substitui um servidor de feature flags dedicado — o padrao e o mesmo.
 */
export async function getFlag(name: string, fallback: string): Promise<string> {
  try {
    const value = await redis.get(`flag:${name}`);
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

export async function setFlag(name: string, value: string): Promise<void> {
  await redis.set(`flag:${name}`, value);
}

export async function getFlagBool(name: string, fallback: boolean): Promise<boolean> {
  const raw = await getFlag(name, fallback ? 'true' : 'false');
  return raw === 'true' || raw === '1';
}

export async function getFlagInt(name: string, fallback: number): Promise<number> {
  const raw = await getFlag(name, String(fallback));
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}
