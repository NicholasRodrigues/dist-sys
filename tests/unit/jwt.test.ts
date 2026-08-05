import { describe, expect, it } from 'vitest';
import { hasScope, issueToken, verifyToken } from '../../src/shared/jwt.js';

/**
 * Os testes que importam aqui sao os NEGATIVOS. Um verificador de token que so
 * foi testado com tokens validos nao foi testado.
 */

const SECRET = 'segredo-de-teste';

describe('JWT', () => {
  it('emite e valida um token integro', () => {
    const token = issueToken({ sub: 'ana', scope: 'orders' }, 60, SECRET);
    const result = verifyToken(token, SECRET);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('ana');
      expect(result.claims.scope).toBe('orders');
    }
  });

  it('recusa um token assinado com outro segredo', () => {
    const token = issueToken({ sub: 'ana', scope: 'orders' }, 60, SECRET);
    const result = verifyToken(token, 'outro-segredo');
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('recusa um token com o payload adulterado', () => {
    const token = issueToken({ sub: 'ana', scope: 'orders' }, 60, SECRET);
    const [header, , signature] = token.split('.');
    // Tenta escalar privilegio trocando o payload e mantendo a assinatura.
    const forjado = Buffer.from(
      JSON.stringify({ sub: 'ana', scope: 'admin', exp: Math.floor(Date.now() / 1000) + 60 }),
    ).toString('base64url');
    const result = verifyToken(`${header}.${forjado}.${signature}`, SECRET);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('recusa um token expirado', () => {
    const token = issueToken({ sub: 'ana', scope: 'orders' }, -1, SECRET);
    const result = verifyToken(token, SECRET);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('recusa um token no exato instante em que expira', () => {
    // Regressao: com `exp < agora` havia uma janela de ate um segundo em que um
    // token ja vencido continuava valendo.
    const token = issueToken({ sub: 'ana', scope: 'orders' }, 0, SECRET);
    const result = verifyToken(token, SECRET);
    expect(result).toEqual({ ok: false, reason: 'expired' });
  });

  it('recusa lixo que nao tem tres partes', () => {
    expect(verifyToken('nao-e-um-token', SECRET)).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyToken('a.b', SECRET)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('separa escopos corretamente', () => {
    const claims = { sub: 'a', scope: 'orders checkout', iat: 0, exp: 0 };
    expect(hasScope(claims, 'orders')).toBe(true);
    expect(hasScope(claims, 'checkout')).toBe(true);
    expect(hasScope(claims, 'admin')).toBe(false);
    // Nao pode casar por prefixo: 'order' nao e 'orders'.
    expect(hasScope(claims, 'order')).toBe(false);
  });
});
