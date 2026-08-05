import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RemoteError, breakerSnapshot, request, resetBreakers } from '../../src/shared/httpClient.js';

/**
 * Circuit breaker e classificacao de erro.
 *
 * O teste mais importante do arquivo e o de regressao no meio: um 4xx nao pode
 * zerar o contador de falhas. Essa exata confusao mascarou uma dependencia
 * doente durante os cenarios de caos — o PSP fora do ar respondia 404 numa
 * rota e 503 na outra, e o 404 zerava o contador antes de o 503 conseguir
 * abrir o breaker.
 */

const fetchMock = vi.fn();

beforeEach(() => {
  resetBreakers();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function resposta(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('classificacao de erro', () => {
  it('trata timeout como indeterminado, e nao como falha', async () => {
    fetchMock.mockImplementation(() => {
      const err = new Error('abortado');
      err.name = 'AbortError';
      return Promise.reject(err);
    });

    await expect(
      request('http://x/y', { target: 'alvo', retries: 0, timeoutMs: 10 }),
    ).rejects.toMatchObject({ kind: 'timeout' });

    try {
      await request('http://x/y', { target: 'alvo', retries: 0, timeoutMs: 10 });
    } catch (err) {
      // E esta propriedade que obriga o orquestrador a reconciliar antes de
      // compensar: nao sabemos se o efeito colateral aconteceu.
      expect((err as RemoteError).indeterminate).toBe(true);
    }
  });

  it('nao retenta um 4xx: e resposta definitiva do servidor', async () => {
    fetchMock.mockResolvedValue(resposta(409, { error: 'assento indisponivel' }));
    await expect(
      request('http://x/y', { target: 'alvo', retries: 3 }),
    ).rejects.toMatchObject({ kind: 'http', status: 409 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('retenta um 5xx ate o limite configurado', async () => {
    fetchMock.mockResolvedValue(resposta(500));
    await expect(request('http://x/y', { target: 'alvo', retries: 2 })).rejects.toMatchObject({
      status: 500,
    });
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 tentativa + 2 retentativas
  });
});

describe('circuit breaker', () => {
  it('abre depois de falhas consecutivas e passa a recusar rapido', async () => {
    fetchMock.mockResolvedValue(resposta(500));
    for (let i = 0; i < 10; i++) {
      await request('http://x/y', { target: 'instavel', retries: 0 }).catch(() => undefined);
    }
    expect(breakerSnapshot().instavel).toBe('open');

    const chamadasAntes = fetchMock.mock.calls.length;
    await expect(
      request('http://x/y', { target: 'instavel', retries: 0 }),
    ).rejects.toMatchObject({ kind: 'breaker-open' });
    // Com o breaker aberto nem chega a tentar a rede: e esse o ganho.
    expect(fetchMock.mock.calls.length).toBe(chamadasAntes);
  });

  it('REGRESSAO: um 4xx nao zera o contador de falhas', async () => {
    // Simula exatamente o PSP fora do ar: a consulta responde 404 (recurso
    // inexistente) e a cobranca responde 503. Se o 404 zerasse o contador, o
    // breaker nunca abriria e o sistema martelaria uma dependencia morta.
    let chamada = 0;
    fetchMock.mockImplementation(() => {
      chamada++;
      return Promise.resolve(chamada % 2 === 1 ? resposta(404) : resposta(503));
    });

    for (let i = 0; i < 20; i++) {
      await request('http://x/consulta', { target: 'psp', retries: 0 }).catch(() => undefined);
      await request('http://x/cobranca', { target: 'psp', retries: 0 }).catch(() => undefined);
    }

    expect(breakerSnapshot().psp).toBe('open');
  });

  it('fecha de novo quando a dependencia volta', async () => {
    fetchMock.mockResolvedValue(resposta(500));
    for (let i = 0; i < 10; i++) {
      await request('http://x/y', { target: 'volatil', retries: 0 }).catch(() => undefined);
    }
    expect(breakerSnapshot().volatil).toBe('open');

    // Passa o tempo de espera para o breaker entrar em meio-aberto.
    await new Promise((r) => setTimeout(r, 5100));
    fetchMock.mockResolvedValue(resposta(200, { ok: true }));
    await request('http://x/y', { target: 'volatil', retries: 0 });
    expect(breakerSnapshot().volatil).toBe('closed');
  }, 10_000);

  it('mantem um breaker por alvo, sem contaminacao cruzada', async () => {
    fetchMock.mockResolvedValue(resposta(500));
    for (let i = 0; i < 10; i++) {
      await request('http://x/y', { target: 'quebrado', retries: 0 }).catch(() => undefined);
    }
    fetchMock.mockResolvedValue(resposta(200, {}));
    await request('http://x/y', { target: 'saudavel', retries: 0 });

    expect(breakerSnapshot().quebrado).toBe('open');
    expect(breakerSnapshot().saudavel).toBe('closed');
  });
});
