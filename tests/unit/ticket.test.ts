import { describe, expect, it } from 'vitest';
import { KEY_ID, issueTicket, verifyTicket } from '../../src/services/orders/ticket.js';

/**
 * A assinatura do ingresso e a unica coisa que separa um QR legitimo de um
 * falsificado. A portaria valida offline, sem consultar o servidor, entao a
 * prova precisa estar no proprio codigo.
 */

function novoIngresso(overrides: Partial<Parameters<typeof issueTicket>[0]> = {}) {
  return issueTicket({
    ticketId: 'ticket-1',
    orderId: 'order-1',
    eventId: 'show-do-seculo',
    seatId: 'PISTA-1-1',
    userId: 'ana',
    issuedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe('assinatura do ingresso', () => {
  it('emite um QR que valida', () => {
    const ingresso = novoIngresso();
    const result = verifyTicket(ingresso.qrCode);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.seatId).toBe('PISTA-1-1');
      expect(result.payload.alg).toBe('Ed25519');
    }
  });

  it('carrega o identificador da chave dentro do payload assinado', () => {
    // E o que permitiria trocar a chave sem invalidar ingressos ja emitidos:
    // o validador olha o keyId e escolhe o verificador certo.
    const ingresso = novoIngresso();
    const result = verifyTicket(ingresso.qrCode);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.payload.keyId).toBe(KEY_ID);
  });

  it('recusa um QR com a assinatura trocada', () => {
    const ingresso = novoIngresso();
    const [payload] = ingresso.qrCode.split('.');
    const result = verifyTicket(`${payload}.${'A'.repeat(86)}`);
    expect(result.ok).toBe(false);
  });

  it('recusa um QR com o assento alterado', () => {
    // O ataque obvio: comprar o lugar barato e reescrever o payload para o caro.
    const ingresso = novoIngresso();
    const [, signature] = ingresso.qrCode.split('.');
    const adulterado = JSON.parse(ingresso.qrPayload);
    adulterado.seatId = 'CAMAROTE-1-1';
    const payload = Buffer.from(JSON.stringify(adulterado)).toString('base64url');
    const result = verifyTicket(`${payload}.${signature}`);
    expect(result).toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('recusa um QR assinado com outra chave', () => {
    const ingresso = novoIngresso();
    const payload = JSON.parse(ingresso.qrPayload);
    payload.keyId = 'chave-desconhecida';
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const result = verifyTicket(`${encoded}.${ingresso.signature}`);
    expect(result).toEqual({ ok: false, reason: 'unknown-key' });
  });

  it('recusa lixo malformado', () => {
    expect(verifyTicket('sem-ponto')).toEqual({ ok: false, reason: 'malformed' });
    expect(verifyTicket('$$$.###')).toEqual({ ok: false, reason: 'malformed' });
  });

  it('e deterministica entre instancias', () => {
    // Todas as replicas do `orders` derivam a mesma chave do ambiente. Sem
    // isso, um ingresso emitido por uma replica seria recusado pela portaria
    // se outra replica tivesse assinado.
    const a = novoIngresso({ ticketId: 'x' });
    const b = novoIngresso({ ticketId: 'x' });
    expect(a.signature).toBe(b.signature);
    expect(a.keyId).toBe(b.keyId);
  });
});
