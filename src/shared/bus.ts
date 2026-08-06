import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import { config } from './config.js';
import { log } from './log.js';
import { dlqTotal } from './metrics.js';
import type { DomainEvent } from './events.js';
import { RISK_DLQ_TOPIC, RISK_TOPIC } from './riskEvents.js';
import { parseTraceparent, traceparent, withSpan } from './trace.js';

const kafka = new Kafka({
  clientId: config.serviceName,
  brokers: config.kafkaBrokers,
  logLevel: logLevel.NOTHING,
  retry: { initialRetryTime: 300, retries: 10 },
});

let producer: Producer | undefined;

export async function getProducer(): Promise<Producer> {
  if (!producer) {
    producer = kafka.producer({ allowAutoTopicCreation: true });
    await producer.connect();
  }
  return producer;
}

export async function publish(events: DomainEvent[]): Promise<void> {
  if (events.length === 0) return;
  const p = await getProducer();
  await p.send({
    topic: config.kafkaTopic,
    messages: events.map((e) => ({
      // Particionar por chave preserva a ordem dos eventos de um mesmo show.
      key: e.key,
      value: JSON.stringify(e),
      headers: { type: e.type },
    })),
  });
}

export const DLQ_TOPIC = `${config.kafkaTopic}.dlq`;

export interface ConsumerOptions {
  groupId: string;
  /** Tentativas por mensagem antes de mandar para a DLQ. */
  maxAttempts?: number;
  onEvent: (event: DomainEvent) => Promise<void>;
}

/**
 * Consumidor com retry e dead letter queue.
 *
 * Uma mensagem envenenada nao pode travar a particao: apos N tentativas ela vai
 * para a DLQ (o "parking lot") e o consumo continua. O replay e manual, por
 * comando, porque reprocessar veneno automaticamente so repete o problema.
 */
export async function startConsumer(opts: ConsumerOptions): Promise<Consumer> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const consumer = kafka.consumer({ groupId: opts.groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: config.kafkaTopic, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      let event: DomainEvent;
      try {
        event = JSON.parse(message.value.toString()) as DomainEvent;
      } catch (err) {
        log.error('mensagem ilegivel, indo direto para a DLQ', { error: String(err) });
        await sendToDlq(message.value.toString(), 'json invalido');
        return;
      }

      const parent = parseTraceparent(event.traceparent);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await withSpan(
            `consume ${event.type}`,
            { kind: 'consumer', parent, attributes: { 'event.type': event.type, 'event.id': event.id } },
            async () => opts.onEvent(event),
          );
          return;
        } catch (err) {
          log.warn('falha ao processar evento', {
            type: event.type,
            attempt,
            maxAttempts,
            error: String(err),
          });
          if (attempt === maxAttempts) {
            await sendToDlq(message.value.toString(), String(err));
            return;
          }
          await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
        }
      }
    },
  });

  return consumer;
}

async function sendToDlq(payload: string, reason: string): Promise<void> {
  try {
    const p = await getProducer();
    await p.send({
      topic: DLQ_TOPIC,
      messages: [{ value: payload, headers: { reason } }],
    });
    dlqTotal.inc({ topic: config.kafkaTopic });
    log.error('mensagem enviada para a DLQ', { reason });
  } catch (err) {
    log.error('falha ao enviar para a DLQ', { error: String(err) });
  }
}

// ---------------------------------------------------------------------------
// Topico do Risk-Shield
//
// O antifraude tem o proprio topico, e nao reaproveita `bilheteria.events`.
// Sao dois sistemas: a Bilheteria publica fatos do dominio dela, o Risk-Shield
// consome eventos normalizados pela sua camada de anticorrupcao. Compartilhar
// topico acoplaria os dois contratos.
// ---------------------------------------------------------------------------

/** Publica um payload arbitrario num topico, com chave de particionamento. */
export async function publishRaw(
  topic: string,
  key: string,
  payload: unknown,
  correlationId: string,
): Promise<void> {
  const p = await getProducer();
  await p.send({
    topic,
    messages: [
      {
        // Particionar por comprador garante que os eventos de uma mesma conta
        // sao processados em ordem — a regra de velocidade depende disso.
        key,
        value: JSON.stringify(payload),
        headers: {
          'correlation-id': correlationId,
          // Propaga o trace atraves do barramento. Sem isto o rastro morre na
          // publicacao: o Jaeger mostraria a compra ate o `POST /events` e o
          // processamento do antifraude apareceria como um trace orfao,
          // impossivel de ligar ao checkout que o originou.
          ...(traceparent() ? { traceparent: traceparent()! } : {}),
        },
      },
    ],
  });
}

export async function ensureRiskTopics(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  const existing = await admin.listTopics();
  const wanted = [
    { topic: RISK_TOPIC, numPartitions: 3, replicationFactor: 1 },
    { topic: RISK_DLQ_TOPIC, numPartitions: 1, replicationFactor: 1 },
  ].filter((t) => !existing.includes(t.topic));
  if (wanted.length > 0) await admin.createTopics({ topics: wanted, waitForLeaders: true });
  await admin.disconnect();
}

export interface RawConsumerOptions<T> {
  topic: string;
  groupId: string;
  maxAttempts?: number;
  onMessage: (payload: T, correlationId: string) => Promise<void>;
  /** Chamado quando a mensagem esgota as tentativas. */
  onDeadLetter: (raw: string, reason: string, correlationId: string) => Promise<void>;
}

/**
 * Consumidor generico com retry e dead letter.
 *
 * O commit do offset so acontece depois do handler retornar sem erro, e o
 * handler faz todo o trabalho numa transacao unica. Se o processo morrer no
 * meio, a mensagem e reentregue — e a idempotencia do consumidor cuida da
 * duplicata. Entrega at-least-once + consumidor idempotente = efeito unico.
 */
export async function startRawConsumer<T>(opts: RawConsumerOptions<T>): Promise<Consumer> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const consumer = kafka.consumer({ groupId: opts.groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: opts.topic, fromBeginning: true });

  await consumer.run({
    eachMessage: async ({ message }) => {
      if (!message.value) return;
      const raw = message.value.toString();
      const correlationId = message.headers?.['correlation-id']?.toString() ?? '-';

      const parent = parseTraceparent(message.headers?.traceparent?.toString());

      let payload: T;
      try {
        payload = JSON.parse(raw) as T;
      } catch (err) {
        log.error('mensagem ilegivel, direto para a dead letter', { error: String(err) });
        await opts.onDeadLetter(raw, `json invalido: ${String(err)}`, correlationId);
        dlqTotal.inc({ topic: opts.topic });
        return;
      }

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await withSpan(
            `consume ${opts.topic}`,
            {
              kind: 'consumer',
              parent,
              attributes: { 'messaging.topic': opts.topic, 'correlation.id': correlationId },
            },
            async () => opts.onMessage(payload, correlationId),
          );
          return;
        } catch (err) {
          log.warn('falha ao processar mensagem', {
            topic: opts.topic,
            attempt,
            maxAttempts,
            correlationId,
            error: String(err),
          });
          if (attempt === maxAttempts) {
            // Parking lot: sai da fila principal para nao travar a particao, e
            // fica visivel no painel para inspecao manual. Reprocessar veneno
            // automaticamente so repete o problema.
            await opts.onDeadLetter(raw, String(err), correlationId);
            dlqTotal.inc({ topic: opts.topic });
            return;
          }
          await new Promise((r) => setTimeout(r, 200 * 2 ** (attempt - 1)));
        }
      }
    },
  });

  return consumer;
}

export async function waitForBus(retries = 60): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      const admin = kafka.admin();
      await admin.connect();
      await admin.listTopics();
      await admin.disconnect();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw new Error('barramento nao ficou disponivel a tempo');
}

export async function ensureTopics(): Promise<void> {
  const admin = kafka.admin();
  await admin.connect();
  const existing = await admin.listTopics();
  const wanted = [
    // 3 particoes: suficiente para demonstrar ordenacao por chave e paralelismo
    // de consumo sem custo de memoria relevante.
    { topic: config.kafkaTopic, numPartitions: 3, replicationFactor: 1 },
    { topic: DLQ_TOPIC, numPartitions: 1, replicationFactor: 1 },
  ].filter((t) => !existing.includes(t.topic));
  if (wanted.length > 0) await admin.createTopics({ topics: wanted, waitForLeaders: true });
  await admin.disconnect();
}

export async function closeBus(): Promise<void> {
  if (producer) await producer.disconnect();
  producer = undefined;
}
