import { createHash, createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';
import { config } from '../../shared/config.js';

/**
 * Assinatura do ingresso com Ed25519.
 *
 * O ingresso circula FORA do sistema — impresso, em captura de tela, na
 * carteira do celular — e precisa ser verificavel na portaria sem rede. Por
 * isso assinatura assimetrica: o validador carrega so a chave publica e nao
 * consegue emitir ingresso nenhum.
 *
 * O `keyId` vai DENTRO do payload assinado. E o que permite trocar a chave (ou
 * o algoritmo) sem invalidar ingressos ja emitidos — o validador olha o keyId e
 * escolhe o verificador certo.
 */

/**
 * Deriva um par de chaves deterministico a partir do segredo do ambiente.
 *
 * Deterministico de proposito: todas as replicas do `orders` precisam assinar
 * com a mesma chave, e a portaria precisa verificar depois de um restart. Em
 * producao isso viria de um cofre; aqui vem do ambiente, e a diferenca esta
 * declarada em docs/escopo.md.
 */
function deriveKeyPair(): { privateKey: KeyObject; publicKey: KeyObject; keyId: string } {
  const seed = createHash('sha256').update(`ticket-key:${config.jwtSecret}`).digest();
  // Envelope PKCS8 de uma chave privada Ed25519: prefixo DER fixo + semente de 32 bytes.
  const der = Buffer.concat([
    Buffer.from('302e020100300506032b657004220420', 'hex'),
    seed,
  ]);
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const publicKey = createPublicKey(privateKey);
  const raw = publicKey.export({ format: 'der', type: 'spki' });
  const keyId = createHash('sha256').update(raw).digest('hex').slice(0, 16);
  return { privateKey, publicKey, keyId };
}

const keys = deriveKeyPair();

export const KEY_ID = keys.keyId;

export function publicKeyPem(): string {
  return keys.publicKey.export({ format: 'pem', type: 'spki' }).toString();
}

export interface TicketPayload {
  ticketId: string;
  orderId: string;
  eventId: string;
  seatId: string;
  userId: string;
  issuedAt: string;
  keyId: string;
  alg: 'Ed25519';
}

export function issueTicket(payload: Omit<TicketPayload, 'keyId' | 'alg'>): {
  qrPayload: string;
  signature: string;
  keyId: string;
  qrCode: string;
} {
  const full: TicketPayload = { ...payload, keyId: KEY_ID, alg: 'Ed25519' };
  const qrPayload = JSON.stringify(full);
  const signature = sign(null, Buffer.from(qrPayload), keys.privateKey).toString('base64url');
  return {
    qrPayload,
    signature,
    keyId: KEY_ID,
    // O que vai impresso no QR: payload e assinatura, autocontido.
    qrCode: `${Buffer.from(qrPayload).toString('base64url')}.${signature}`,
  };
}

export type TicketVerification =
  | { ok: true; payload: TicketPayload }
  | { ok: false; reason: 'malformed' | 'bad-signature' | 'unknown-key' };

export function verifyTicket(qrCode: string): TicketVerification {
  const parts = qrCode.split('.');
  if (parts.length !== 2) return { ok: false, reason: 'malformed' };
  const [encodedPayload, signature] = parts;

  let raw: string;
  let payload: TicketPayload;
  try {
    raw = Buffer.from(encodedPayload, 'base64url').toString();
    payload = JSON.parse(raw) as TicketPayload;
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  // Crypto-agility: o payload diz com que chave foi assinado. Hoje ha uma so,
  // mas o ponto de extensao existe e e o que tornaria uma rotacao possivel.
  if (payload.keyId !== KEY_ID) return { ok: false, reason: 'unknown-key' };

  let valid = false;
  try {
    valid = verify(null, Buffer.from(raw), keys.publicKey, Buffer.from(signature, 'base64url'));
  } catch {
    return { ok: false, reason: 'bad-signature' };
  }
  if (!valid) return { ok: false, reason: 'bad-signature' };
  return { ok: true, payload };
}
