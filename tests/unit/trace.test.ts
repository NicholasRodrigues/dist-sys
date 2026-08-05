import { describe, expect, it } from 'vitest';
import { currentContext, parseTraceparent, traceparent, withSpan } from '../../src/shared/trace.js';

/**
 * Propagacao de contexto de trace.
 *
 * Sem isto, o trace da SAGA compensada — a imagem mais eloquente do projeto —
 * apareceria como cinco fragmentos soltos em vez de uma arvore.
 */

describe('traceparent W3C', () => {
  it('le um header valido', () => {
    const ctx = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
    expect(ctx).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
  });

  it('recusa headers invalidos em vez de inventar um contexto', () => {
    expect(parseTraceparent(undefined)).toBeUndefined();
    expect(parseTraceparent('lixo')).toBeUndefined();
    expect(parseTraceparent('00-curto-demais-01')).toBeUndefined();
    // Tudo zero e o "invalido" definido pela especificacao.
    expect(parseTraceparent('00-00000000000000000000000000000000-0000000000000000-01')).toBeUndefined();
  });

  it('aceita o header como array, que e como o Node entrega repetidos', () => {
    const ctx = parseTraceparent(['00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01']);
    expect(ctx?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });
});

describe('propagacao de contexto', () => {
  it('spans aninhados herdam o mesmo traceId', async () => {
    await withSpan('pai', {}, async () => {
      const pai = currentContext()!;
      await withSpan('filho', {}, async () => {
        const filho = currentContext()!;
        expect(filho.traceId).toBe(pai.traceId);
        expect(filho.spanId).not.toBe(pai.spanId);
      });
    });
  });

  it('continua o trace recebido de outro servico', async () => {
    const recebido = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')!;
    await withSpan('servidor', { parent: recebido }, async () => {
      expect(currentContext()!.traceId).toBe(recebido.traceId);
      // O header que sai carrega o mesmo trace, com um span novo.
      const header = traceparent()!;
      expect(header).toContain(recebido.traceId);
      expect(header).not.toContain(recebido.spanId);
    });
  });

  it('inicia um trace novo quando nao ha pai', async () => {
    await withSpan('raiz', {}, async () => {
      const ctx = currentContext()!;
      expect(ctx.traceId).toHaveLength(32);
      expect(ctx.spanId).toHaveLength(16);
    });
  });

  it('fecha o span mesmo quando a operacao lanca', async () => {
    await expect(
      withSpan('falha', {}, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // O contexto nao pode vazar para fora do span.
    expect(currentContext()).toBeUndefined();
  });
});
