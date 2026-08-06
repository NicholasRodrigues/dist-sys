import { describe, expect, it } from 'vitest';
import {
  NormalizationError,
  RISK_SCHEMA_VERSION,
  normalizeRiskEvent,
} from '../../src/shared/riskEvents.js';

/**
 * A camada de anticorrupcao.
 *
 * Duas origens escrevem formatos diferentes na mesma porta: a Bilheteria manda
 * `camelCase` sem timestamp, o Simulador manda `snake_case` com timestamp sem
 * fuso. O motor antifraude nao pode conhecer nenhum dos dois.
 *
 * Os testes que importam sao os de rejeicao e o de fuso horario. Este ultimo
 * ja seria um bug de producao silencioso: um evento em horario de Brasilia
 * lido como UTC entra com tres horas de diferenca, cai fora da janela de dez
 * minutos, e a deteccao de velocidade simplesmente para de funcionar sem
 * ninguem perceber.
 */

const CID = 'correlation-de-teste';

describe('nomes de campo das duas origens', () => {
  it('aceita o formato da Bilheteria (camelCase)', () => {
    const e = normalizeRiskEvent(
      {
        eventType: 'CHECKOUT_ATTEMPT',
        buyerId: 'ana',
        showId: 'show-1',
        seatId: 'PLATEIA-12',
        deviceFingerprint: 'dev-1',
        ipAddress: '10.0.0.1',
        paymentHash: 'card-1',
      },
      CID,
    );
    expect(e.buyerId).toBe('ana');
    expect(e.seatId).toBe('PLATEIA-12');
    expect(e.deviceFingerprint).toBe('dev-1');
  });

  it('aceita o formato do Simulador (snake_case)', () => {
    const e = normalizeRiskEvent(
      {
        event_type: 'CHECKOUT_ATTEMPT',
        buyer_id: 'ana',
        show_id: 'show-1',
        seat_id: 'PLATEIA-12',
        device_fingerprint: 'dev-1',
        ip_address: '10.0.0.1',
        payment_hash: 'card-1',
      },
      CID,
    );
    expect(e.buyerId).toBe('ana');
    expect(e.seatId).toBe('PLATEIA-12');
    expect(e.deviceFingerprint).toBe('dev-1');
  });

  it('produz o MESMO modelo interno para os dois formatos', () => {
    const camel = normalizeRiskEvent(
      { eventType: 'SEATMAP_VIEW', buyerId: 'ana', eventId: 'fixo', occurredAt: '2026-01-01T10:00:00Z' },
      CID,
    );
    const snake = normalizeRiskEvent(
      { event_type: 'SEATMAP_VIEW', buyer_id: 'ana', event_id: 'fixo', occurred_at: '2026-01-01T10:00:00Z' },
      CID,
    );
    expect(camel).toEqual(snake);
  });

  it('carimba a versao do schema interno', () => {
    const e = normalizeRiskEvent({ eventType: 'QUEUE_JOIN', buyerId: 'ana' }, CID);
    expect(e.schemaVersion).toBe(RISK_SCHEMA_VERSION);
    expect(e.correlationId).toBe(CID);
  });
});

describe('fuso horario', () => {
  it('trata timestamp sem fuso como UTC', () => {
    const e = normalizeRiskEvent(
      { event_type: 'SEATMAP_VIEW', buyer_id: 'ana', timestamp: '2026-01-01T10:00:00.000' },
      CID,
    );
    expect(e.occurredAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('respeita o fuso quando ele vem declarado', () => {
    const e = normalizeRiskEvent(
      { event_type: 'SEATMAP_VIEW', buyer_id: 'ana', occurred_at: '2026-01-01T07:00:00-03:00' },
      CID,
    );
    expect(e.occurredAt).toBe('2026-01-01T10:00:00.000Z');
  });

  it('usa o instante atual quando nao vem timestamp nenhum', () => {
    const antes = Date.now();
    const e = normalizeRiskEvent({ eventType: 'QUEUE_JOIN', buyerId: 'ana' }, CID);
    const t = new Date(e.occurredAt).getTime();
    expect(t).toBeGreaterThanOrEqual(antes);
    expect(t).toBeLessThanOrEqual(Date.now());
  });
});

describe('rejeicao na borda', () => {
  it('recusa evento sem tipo', () => {
    expect(() => normalizeRiskEvent({ buyerId: 'ana' }, CID)).toThrow(NormalizationError);
  });

  it('recusa evento sem comprador', () => {
    expect(() => normalizeRiskEvent({ eventType: 'QUEUE_JOIN' }, CID)).toThrow(NormalizationError);
  });

  it('recusa tipo desconhecido em vez de deixar chegar no worker', () => {
    // Se passasse, o worker so descobriria o problema com a mensagem em maos e
    // a unica saida seria a dead letter.
    expect(() => normalizeRiskEvent({ eventType: 'COMPROU_TALVEZ', buyerId: 'ana' }, CID)).toThrow(
      /desconhecido/,
    );
  });

  it('recusa timestamp ilegivel', () => {
    expect(() =>
      normalizeRiskEvent({ eventType: 'QUEUE_JOIN', buyerId: 'ana', timestamp: 'ontem' }, CID),
    ).toThrow(NormalizationError);
  });

  it('normaliza o tipo para maiusculas', () => {
    const e = normalizeRiskEvent({ eventType: 'seatmap_view', buyerId: 'ana' }, CID);
    expect(e.eventType).toBe('SEATMAP_VIEW');
  });
});

describe('eventId', () => {
  it('preserva o id quando ele vem', () => {
    const e = normalizeRiskEvent({ eventType: 'QUEUE_JOIN', buyerId: 'ana', eventId: 'meu-id' }, CID);
    expect(e.eventId).toBe('meu-id');
  });

  it('gera um id quando ele nao vem, porque a idempotencia depende dele', () => {
    const a = normalizeRiskEvent({ eventType: 'QUEUE_JOIN', buyerId: 'ana' }, CID);
    const b = normalizeRiskEvent({ eventType: 'QUEUE_JOIN', buyerId: 'ana' }, CID);
    expect(a.eventId).toBeTruthy();
    expect(a.eventId).not.toBe(b.eventId);
  });

  it('campos ausentes viram null, e nao undefined', () => {
    // O worker grava direto no banco: `undefined` viraria erro de bind.
    const e = normalizeRiskEvent({ eventType: 'QUEUE_JOIN', buyerId: 'ana' }, CID);
    expect(e.showId).toBeNull();
    expect(e.seatId).toBeNull();
    expect(e.deviceFingerprint).toBeNull();
    expect(e.ipAddress).toBeNull();
    expect(e.paymentHash).toBeNull();
  });
});
