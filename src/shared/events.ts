/**
 * Contratos de evento do barramento.
 *
 * Definidos aqui e compartilhados por todos os servicos: um contrato que o
 * compilador verifica vale mais que um contrato que so existe na documentacao.
 */

export type EventType =
  | 'SeatHeld'
  | 'SeatSold'
  | 'SeatReleased'
  | 'PaymentCaptured'
  | 'PaymentRefunded'
  | 'OrderConfirmed'
  | 'OrderFailed';

export interface DomainEvent<T = Record<string, unknown>> {
  id: string;
  type: EventType;
  /** Chave de particionamento: garante ordem por evento de show. */
  key: string;
  occurredAt: string;
  traceparent?: string;
  payload: T;
}

export interface SeatHeldPayload {
  eventId: string;
  seatId: string;
  sagaId: string;
  expiresAt: string;
}

export interface SeatSoldPayload {
  eventId: string;
  seatId: string;
  sagaId: string;
  orderId: string;
}

export interface SeatReleasedPayload {
  eventId: string;
  seatId: string;
  sagaId: string;
  reason: 'expired' | 'compensated' | 'cancelled';
}

export interface PaymentCapturedPayload {
  sagaId: string;
  orderId: string;
  amountCents: number;
}

export interface PaymentRefundedPayload {
  sagaId: string;
  orderId: string;
  amountCents: number;
}

export interface OrderConfirmedPayload {
  orderId: string;
  userId: string;
  eventId: string;
  seatId: string;
  ticketId: string;
}

export interface OrderFailedPayload {
  orderId: string;
  reason: string;
}
