import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';

/**
 * Tracer distribuido minimo, sem dependencias.
 *
 * Fala OTLP/HTTP em JSON direto com o Jaeger e propaga contexto pelo header
 * W3C `traceparent`. Escrito a mao de proposito: sao ~150 linhas contra uma
 * arvore de dependencias grande do SDK, e o trace da SAGA compensada e a
 * evidencia central do projeto, entao ele precisa funcionar sem surpresa de
 * compatibilidade de versao.
 */

export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

const KIND_CODE: Record<SpanKind, number> = {
  internal: 1,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

export interface SpanContext {
  traceId: string;
  spanId: string;
}

interface FinishedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  startNs: bigint;
  endNs: bigint;
  attributes: Record<string, string | number | boolean>;
  error?: string;
}

const storage = new AsyncLocalStorage<SpanContext>();
const buffer: FinishedSpan[] = [];
const MAX_BUFFER = 2048;

export function currentContext(): SpanContext | undefined {
  return storage.getStore();
}

/** Serializa o contexto atual no formato W3C traceparent. */
export function traceparent(ctx?: SpanContext): string | undefined {
  const c = ctx ?? currentContext();
  if (!c) return undefined;
  return `00-${c.traceId}-${c.spanId}-01`;
}

/** Le um traceparent recebido; devolve undefined se ausente ou malformado. */
export function parseTraceparent(header?: string | string[]): SpanContext | undefined {
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) return undefined;
  const parts = raw.split('-');
  if (parts.length < 4) return undefined;
  const [, traceId, spanId] = parts;
  if (!traceId || !spanId) return undefined;
  if (traceId.length !== 32 || spanId.length !== 16) return undefined;
  if (/^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId };
}

export interface Span {
  ctx: SpanContext;
  setAttribute(key: string, value: string | number | boolean): void;
  setError(message: string): void;
  end(): void;
}

export interface SpanOptions {
  kind?: SpanKind;
  parent?: SpanContext;
  attributes?: Record<string, string | number | boolean>;
}

/**
 * Cria um span com ciclo de vida manual. Necessario onde inicio e fim caem em
 * callbacks diferentes — o caso dos hooks do Fastify, em que o span abre em
 * `onRequest` e fecha em `onResponse`.
 */
export function startSpan(name: string, opts: SpanOptions = {}): Span {
  const parent = opts.parent ?? currentContext();
  const ctx: SpanContext = {
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
  };
  const startNs = BigInt(Date.now()) * 1_000_000n;
  const attributes: Record<string, string | number | boolean> = { ...(opts.attributes ?? {}) };
  let error: string | undefined;
  let ended = false;

  return {
    ctx,
    setAttribute(key, value) {
      attributes[key] = value;
    },
    setError(message) {
      error = message;
    },
    end() {
      if (ended) return;
      ended = true;
      if (buffer.length < MAX_BUFFER) {
        buffer.push({
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          parentSpanId: parent?.spanId,
          name,
          kind: opts.kind ?? 'internal',
          startNs,
          endNs: BigInt(Date.now()) * 1_000_000n,
          attributes,
          error,
        });
      }
    },
  };
}

/** Roda `fn` com `ctx` como contexto ativo. */
export function runInContext<T>(ctx: SpanContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

/**
 * Executa `fn` dentro de um span. O contexto viaja por AsyncLocalStorage, entao
 * qualquer chamada aninhada vira filha automaticamente.
 */
export async function withSpan<T>(
  name: string,
  opts: { kind?: SpanKind; parent?: SpanContext; attributes?: Record<string, string | number | boolean> },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const parent = opts.parent ?? currentContext();
  const ctx: SpanContext = {
    traceId: parent?.traceId ?? randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'),
  };
  const startNs = BigInt(Date.now()) * 1_000_000n;
  const attributes: Record<string, string | number | boolean> = { ...(opts.attributes ?? {}) };
  let error: string | undefined;
  let ended = false;

  const span: Span = {
    ctx,
    setAttribute(key, value) {
      attributes[key] = value;
    },
    setError(message) {
      error = message;
    },
    end() {
      if (ended) return;
      ended = true;
      if (buffer.length < MAX_BUFFER) {
        buffer.push({
          traceId: ctx.traceId,
          spanId: ctx.spanId,
          parentSpanId: parent?.spanId,
          name,
          kind: opts.kind ?? 'internal',
          startNs,
          endNs: BigInt(Date.now()) * 1_000_000n,
          attributes,
          error,
        });
      }
    },
  };

  try {
    return await storage.run(ctx, () => fn(span));
  } catch (err) {
    span.setError(err instanceof Error ? err.message : String(err));
    throw err;
  } finally {
    span.end();
  }
}

function toOtlpAttributes(attrs: Record<string, string | number | boolean>) {
  return Object.entries(attrs).map(([key, value]) => {
    if (typeof value === 'number') {
      return Number.isInteger(value)
        ? { key, value: { intValue: String(value) } }
        : { key, value: { doubleValue: value } };
    }
    if (typeof value === 'boolean') return { key, value: { boolValue: value } };
    return { key, value: { stringValue: String(value) } };
  });
}

async function flush(): Promise<void> {
  if (buffer.length === 0) return;
  const batch = buffer.splice(0, buffer.length);
  const payload = {
    resourceSpans: [
      {
        resource: {
          attributes: toOtlpAttributes({ 'service.name': config.serviceName }),
        },
        scopeSpans: [
          {
            scope: { name: 'bilheteria' },
            spans: batch.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: KIND_CODE[s.kind],
              startTimeUnixNano: s.startNs.toString(),
              endTimeUnixNano: s.endNs.toString(),
              attributes: toOtlpAttributes(
                s.error ? { ...s.attributes, 'error.message': s.error } : s.attributes,
              ),
              status: s.error ? { code: 2, message: s.error } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 4000);
    await fetch(config.otlpEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    // Observabilidade nunca pode derrubar o caminho de negocio.
    log.debug('falha ao exportar spans', { error: String(err) });
  }
}

let flushTimer: NodeJS.Timeout | undefined;

export function startTracing(): void {
  if (!config.tracingEnabled || flushTimer) return;
  flushTimer = setInterval(() => void flush(), 2000);
  flushTimer.unref();
}

export async function stopTracing(): Promise<void> {
  if (flushTimer) clearInterval(flushTimer);
  flushTimer = undefined;
  await flush();
}
