import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../shared/config.js';
import { hasScope, verifyToken, type Claims } from '../../shared/jwt.js';
import { loadShed, rateLimited } from '../../shared/metrics.js';
import { getFlagBool, getFlagInt, redis } from '../../shared/redis.js';

/**
 * Defesas de borda: rate limiting e load shedding.
 *
 * As duas parecem a mesma coisa e nao sao. Rate limiting protege contra UM
 * cliente abusivo e e sempre justo. Load shedding protege contra a SOMA de
 * clientes legitimos, e e deliberadamente injusto: sob sobrecarga, derruba a
 * navegacao para manter o checkout de pe.
 */

// ---------------------------------------------------------------------------
// Rate limiting: janela deslizante aproximada em Redis
// ---------------------------------------------------------------------------

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
}

export async function checkRateLimit(
  scope: string,
  identity: string,
  limitOverride?: number,
): Promise<RateLimitResult> {
  const limit = limitOverride ?? (await getFlagInt('rate_limit_max', config.rateLimitMax));
  if (limit <= 0) return { allowed: true, remaining: -1, limit };

  const window = config.rateLimitWindowSeconds;
  // Janela fixa alinhada ao relogio: aproximacao boa o suficiente e barata,
  // uma chave por janela em vez de um ZSET por cliente.
  const bucket = Math.floor(Date.now() / 1000 / window);
  const key = `rl:${scope}:${identity}:${bucket}`;

  try {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, window * 2);
    if (count > limit) {
      rateLimited.inc({ scope });
      return { allowed: false, remaining: 0, limit };
    }
    return { allowed: true, remaining: limit - count, limit };
  } catch {
    // Redis fora do ar nao pode barrar trafego legitimo: falha aberto.
    return { allowed: true, remaining: -1, limit };
  }
}

// ---------------------------------------------------------------------------
// Load shedding
// ---------------------------------------------------------------------------

let inFlightCount = 0;

export function trackInFlight(delta: number): void {
  inFlightCount += delta;
  if (inFlightCount < 0) inFlightCount = 0;
}

export function currentInFlight(): number {
  return inFlightCount;
}

export async function shouldShed(priority: 'high' | 'low'): Promise<boolean> {
  if (priority === 'high') return false; // checkout nunca e descartado
  const enabled = await getFlagBool('load_shed_enabled', true);
  if (!enabled) return false;
  const threshold = await getFlagInt('load_shed_threshold', config.loadShedThreshold);
  if (inFlightCount <= threshold) return false;
  loadShed.inc();
  return true;
}

// ---------------------------------------------------------------------------
// Autenticacao
// ---------------------------------------------------------------------------

export interface AuthOk {
  ok: true;
  claims: Claims;
}
export interface AuthFail {
  ok: false;
  code: number;
  error: string;
}

export function authenticate(req: FastifyRequest, requiredScope = 'orders'): AuthOk | AuthFail {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return { ok: false, code: 401, error: 'authorization ausente' };
  }
  const result = verifyToken(header.slice(7));
  if (!result.ok) {
    const code = result.reason === 'expired' ? 401 : 403;
    return { ok: false, code, error: `token invalido: ${result.reason}` };
  }
  if (!hasScope(result.claims, requiredScope)) {
    return { ok: false, code: 403, error: `escopo insuficiente, exige ${requiredScope}` };
  }
  return { ok: true, claims: result.claims };
}

/**
 * Valida o token de admissao da fila.
 *
 * O escopo `checkout` e separado do escopo de usuario de proposito: ter uma
 * conta valida nao autoriza a comprar, so ter chegado a vez autoriza. E o que
 * impede alguem pular a fila chamando a API diretamente.
 */
export function checkAdmission(req: FastifyRequest, eventId: string): AuthOk | AuthFail {
  const token = req.headers['x-admission-token'];
  if (typeof token !== 'string' || token.length === 0) {
    return { ok: false, code: 428, error: 'token de admissao ausente: entre na fila' };
  }
  const result = verifyToken(token);
  if (!result.ok) {
    return { ok: false, code: 403, error: `admissao invalida: ${result.reason}` };
  }
  if (!hasScope(result.claims, 'checkout')) {
    return { ok: false, code: 403, error: 'token de admissao com escopo errado' };
  }
  if (result.claims.eventId !== eventId) {
    return { ok: false, code: 403, error: 'token de admissao e de outro evento' };
  }
  return { ok: true, claims: result.claims };
}

export function clientIp(req: FastifyRequest): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim();
  }
  return req.ip;
}

export function sendAuthFailure(reply: FastifyReply, failure: AuthFail): FastifyReply {
  return reply.code(failure.code).send({ error: failure.error });
}
