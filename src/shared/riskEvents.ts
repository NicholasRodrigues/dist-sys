import { randomUUID } from 'node:crypto';

/**
 * Contratos do Risk-Shield e a camada de anticorrupcao.
 *
 * Existem DOIS formatos externos — a Bilheteria e o Simulador — e UM formato
 * interno. Toda divergencia entre eles morre aqui: nomes de campo diferentes,
 * fuso horario, campos ausentes. O motor antifraude nunca ve o formato externo.
 *
 * Ter duas origens distintas e o que prova que o Anti-Corruption Layer faz
 * trabalho de verdade, em vez de ser um mapeamento identidade. Se um dia a
 * Bilheteria mudar o contrato dela, muda este arquivo — e o motor de risco nem
 * fica sabendo.
 */

export const RISK_SCHEMA_VERSION = '1.0';
export const RISK_TOPIC = 'risk.events';
export const RISK_DLQ_TOPIC = 'risk.events.dlq';

/**
 * O que o comprador FEZ, e nao o que o sistema fez com aquilo.
 *
 * `SEATMAP_VIEW` parece supérfluo e e o evento mais importante do conjunto: a
 * AUSENCIA dele antes de uma compra e o sinal mais limpo de automacao que este
 * dominio oferece.
 */
export type RiskEventType =
  | 'QUEUE_JOIN'
  | 'QUEUE_ADMITTED'
  | 'SEATMAP_VIEW'
  | 'CHECKOUT_ATTEMPT'
  | 'PURCHASE_CONFIRMED'
  | 'PURCHASE_FAILED'
  | 'CHECKIN';

const KNOWN_TYPES: RiskEventType[] = [
  'QUEUE_JOIN',
  'QUEUE_ADMITTED',
  'SEATMAP_VIEW',
  'CHECKOUT_ATTEMPT',
  'PURCHASE_CONFIRMED',
  'PURCHASE_FAILED',
  'CHECKIN',
];

/** Formato aceito na borda. Deliberadamente tolerante. */
export interface ExternalRiskEvent {
  eventType?: string;
  /** A Bilheteria manda `event_type`; o Simulador manda `eventType`. */
  event_type?: string;
  buyerId?: string;
  buyer_id?: string;
  showId?: string;
  show_id?: string;
  seatId?: string;
  seat_id?: string;
  deviceFingerprint?: string;
  device_fingerprint?: string;
  ipAddress?: string;
  ip_address?: string;
  paymentHash?: string;
  payment_hash?: string;
  occurredAt?: string;
  occurred_at?: string;
  timestamp?: string;
  eventId?: string;
  event_id?: string;
  metadata?: Record<string, unknown>;
}

/** Formato interno, versionado. E o unico que o worker conhece. */
export interface NormalizedRiskEvent {
  eventId: string;
  schemaVersion: string;
  correlationId: string;
  eventType: RiskEventType;
  buyerId: string;
  showId: string | null;
  seatId: string | null;
  deviceFingerprint: string | null;
  ipAddress: string | null;
  paymentHash: string | null;
  occurredAt: string;
  metadata: Record<string, unknown>;
}

export class NormalizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NormalizationError';
  }
}

function pick(...values: (string | undefined)[]): string | undefined {
  for (const v of values) if (v !== undefined && v !== null && v !== '') return v;
  return undefined;
}

/**
 * Converte o formato externo no interno.
 *
 * Quatro normalizacoes, cada uma com um motivo concreto:
 *
 * 1. **Nomes de campo.** `camelCase` e `snake_case` convivem porque as duas
 *    origens escrevem diferente. O motor nao precisa saber disso.
 *
 * 2. **Fuso horario.** Um timestamp sem fuso e tratado como UTC. Sem essa
 *    regra, um evento em horario de Brasilia entraria com tres horas de
 *    diferenca — e a regra de velocidade acusaria bot em todo mundo.
 *
 * 3. **`eventId` obrigatorio.** Se vier ausente, geramos. A idempotencia do
 *    consumidor depende dele existir, entao ele nunca pode ser opcional
 *    depois desta camada.
 *
 * 4. **Tipo validado.** Um `eventType` desconhecido e recusado aqui, na borda,
 *    e nao descoberto la na frente por um worker que nao sabe o que fazer.
 */
export function normalizeRiskEvent(
  external: ExternalRiskEvent,
  correlationId: string,
): NormalizedRiskEvent {
  const rawType = pick(external.eventType, external.event_type);
  if (!rawType) throw new NormalizationError('eventType e obrigatorio');
  const eventType = rawType.toUpperCase() as RiskEventType;
  if (!KNOWN_TYPES.includes(eventType)) {
    throw new NormalizationError(`eventType desconhecido: ${rawType}`);
  }

  const buyerId = pick(external.buyerId, external.buyer_id);
  if (!buyerId) throw new NormalizationError('buyerId e obrigatorio');

  const rawTime = pick(external.occurredAt, external.occurred_at, external.timestamp);
  let occurredAt: Date;
  if (rawTime) {
    // Sem indicador de fuso, assume UTC em vez de deixar o runtime decidir
    // pelo fuso do contentor.
    const hasZone = /(Z|[+-]\d{2}:?\d{2})$/.test(rawTime);
    occurredAt = new Date(hasZone ? rawTime : `${rawTime}Z`);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new NormalizationError(`occurredAt invalido: ${rawTime}`);
    }
  } else {
    occurredAt = new Date();
  }

  return {
    eventId: pick(external.eventId, external.event_id) ?? randomUUID(),
    schemaVersion: RISK_SCHEMA_VERSION,
    correlationId,
    eventType,
    buyerId,
    showId: pick(external.showId, external.show_id) ?? null,
    seatId: pick(external.seatId, external.seat_id) ?? null,
    deviceFingerprint: pick(external.deviceFingerprint, external.device_fingerprint) ?? null,
    ipAddress: pick(external.ipAddress, external.ip_address) ?? null,
    paymentHash: pick(external.paymentHash, external.payment_hash) ?? null,
    occurredAt: occurredAt.toISOString(),
    metadata: external.metadata ?? {},
  };
}

/** Uma regra que pontuou, com o motivo legivel por um humano. */
export interface RiskEvidence {
  factor: string;
  severity: number;
  weight: number;
  points: number;
  observed: Record<string, unknown>;
  explanation: string;
}

export type RiskStatus = 'CLEAR' | 'QUARANTINED';

/** Resposta consultada pela Bilheteria antes de liberar o checkout. */
export interface BuyerRisk {
  buyerId: string;
  score: number;
  status: RiskStatus;
  topFactors: { factor: string; points: number; explanation: string }[];
  eventsSeen: number;
  updatedAt: string | null;
}
