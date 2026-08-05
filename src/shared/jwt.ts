import { createHmac, timingSafeEqual } from 'node:crypto';
import { config } from './config.js';

/**
 * JWT HS256 em ~40 linhas, sem dependencia.
 *
 * Cobre o que a Secao 6 lista como topico: assinatura, expiracao e validacao de
 * claims. Nao e OIDC — a troca por um provedor completo esta registrada como
 * item do caminho de volta em docs/escopo.md.
 */

export interface Claims {
  sub: string;
  scope: string;
  iat: number;
  exp: number;
  [key: string]: unknown;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function sign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export function issueToken(
  payload: Omit<Claims, 'iat' | 'exp'> & Record<string, unknown>,
  ttlSeconds = config.jwtTtlSeconds,
  secret = config.jwtSecret,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const signature = sign(`${header}.${body}`, secret);
  return `${header}.${body}.${signature}`;
}

export type VerifyFailure =
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'expired' };
export type VerifyResult = { ok: true; claims: Claims } | VerifyFailure;

export function verifyToken(token: string, secret = config.jwtSecret): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, body, signature] = parts;

  const expected = sign(`${header}.${body}`, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  // Comparacao em tempo constante: comprimentos diferentes ja reprovam.
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad-signature' };

  let claims: Claims;
  try {
    claims = JSON.parse(Buffer.from(body, 'base64url').toString()) as Claims;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // `<=` e nao `<`: pela RFC 7519 o token deixa de valer quando o instante
  // atual alcanca `exp`. Com `<` havia uma janela de ate um segundo em que um
  // token ja vencido continuava sendo aceito.
  if (typeof claims.exp !== 'number' || claims.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims };
}

export function hasScope(claims: Claims, required: string): boolean {
  return String(claims.scope ?? '')
    .split(' ')
    .includes(required);
}
