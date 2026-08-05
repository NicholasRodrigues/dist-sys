import { config } from './config.js';
import { log } from './log.js';
import { breakerState } from './metrics.js';
import { traceparent, withSpan } from './trace.js';

/**
 * Cliente HTTP entre servicos com timeout, retry com backoff, circuit breaker
 * e propagacao de trace.
 *
 * O detalhe que importa para a SAGA: um timeout NAO e uma falha conhecida.
 * Ele vira `RemoteError` com `kind: 'timeout'`, e o orquestrador e obrigado a
 * reconciliar consultando o estado real antes de compensar. Tratar timeout
 * como falha produziria o pior erro possivel: estornar quem pagou.
 */

export type RemoteErrorKind = 'timeout' | 'network' | 'http' | 'breaker-open';

export class RemoteError extends Error {
  constructor(
    readonly kind: RemoteErrorKind,
    message: string,
    readonly status?: number,
    readonly body?: unknown,
  ) {
    super(message);
    this.name = 'RemoteError';
  }

  /** Verdadeiro quando nao sabemos se o efeito colateral aconteceu. */
  get indeterminate(): boolean {
    return this.kind === 'timeout' || this.kind === 'network';
  }
}

type BreakerPhase = 'closed' | 'open' | 'half-open';

interface Breaker {
  phase: BreakerPhase;
  failures: number;
  openedAt: number;
}

const breakers = new Map<string, Breaker>();

function breakerFor(target: string): Breaker {
  let b = breakers.get(target);
  if (!b) {
    b = { phase: 'closed', failures: 0, openedAt: 0 };
    breakers.set(target, b);
  }
  return b;
}

function reportPhase(target: string, phase: BreakerPhase): void {
  breakerState.set({ target }, phase === 'closed' ? 0 : phase === 'half-open' ? 1 : 2);
}

function onSuccess(target: string): void {
  const b = breakerFor(target);
  b.failures = 0;
  if (b.phase !== 'closed') {
    b.phase = 'closed';
    log.info('circuit breaker fechou', { target });
  }
  reportPhase(target, b.phase);
}

function onFailure(target: string): void {
  const b = breakerFor(target);
  b.failures += 1;
  if (b.failures >= config.breakerThreshold && b.phase !== 'open') {
    b.phase = 'open';
    b.openedAt = Date.now();
    log.warn('circuit breaker abriu', { target, failures: b.failures });
  }
  reportPhase(target, b.phase);
}

function checkBreaker(target: string): void {
  const b = breakerFor(target);
  if (b.phase === 'open') {
    if (Date.now() - b.openedAt >= config.breakerResetMs) {
      b.phase = 'half-open';
      reportPhase(target, b.phase);
      log.info('circuit breaker em meio-aberto', { target });
      return;
    }
    throw new RemoteError('breaker-open', `circuit breaker aberto para ${target}`);
  }
}

export function breakerSnapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [target, b] of breakers) out[target] = b.phase;
  return out;
}

export function resetBreakers(): void {
  breakers.clear();
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Numero de retentativas. Use 0 onde a duplicidade nao e tolerada sem chave. */
  retries?: number;
  /** Nome curto do alvo, usado pelo breaker e pelas metricas. */
  target: string;
}

export async function request<T = unknown>(url: string, opts: RequestOptions): Promise<T> {
  const method = opts.method ?? 'GET';
  const retries = opts.retries ?? config.httpRetries;
  const timeoutMs = opts.timeoutMs ?? config.httpTimeoutMs;

  return withSpan(
    `${method} ${opts.target}`,
    { kind: 'client', attributes: { 'http.method': method, 'http.url': url, target: opts.target } },
    async (span) => {
      let lastError: RemoteError | undefined;

      for (let attempt = 0; attempt <= retries; attempt++) {
        checkBreaker(opts.target);

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method,
            headers: {
              'content-type': 'application/json',
              ...(traceparent() ? { traceparent: traceparent()! } : {}),
              ...(opts.headers ?? {}),
            },
            body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
            signal: controller.signal,
          });
          clearTimeout(timer);

          const text = await res.text();
          const parsed = text ? safeJson(text) : undefined;

          if (!res.ok) {
            span.setAttribute('http.status', res.status);
            // 4xx e resposta definitiva do servidor: nao e falha de dependencia
            // e nao deve ser retentada.
            //
            // Importante: tambem NAO zera o contador de falhas. A versao
            // anterior chamava onSuccess aqui, e isso mascarava uma dependencia
            // genuinamente doente — um PSP fora do ar respondia 404 na consulta
            // e 503 na cobranca, e o 404 zerava o contador antes de o 503
            // conseguir abrir o breaker. Um 4xx e neutro: prova que o servidor
            // esta vivo, mas nao prova que a operacao que falha esta saudavel.
            if (res.status < 500) {
              throw new RemoteError('http', `${opts.target} respondeu ${res.status}`, res.status, parsed);
            }
            onFailure(opts.target);
            lastError = new RemoteError('http', `${opts.target} respondeu ${res.status}`, res.status, parsed);
            if (attempt < retries) {
              await backoff(attempt);
              continue;
            }
            throw lastError;
          }

          span.setAttribute('http.status', res.status);
          onSuccess(opts.target);
          return parsed as T;
        } catch (err) {
          clearTimeout(timer);
          if (err instanceof RemoteError) {
            if (err.kind === 'http' && err.status && err.status < 500) throw err;
            if (err.kind === 'breaker-open') throw err;
            lastError = err;
          } else if (err instanceof Error && err.name === 'AbortError') {
            onFailure(opts.target);
            lastError = new RemoteError('timeout', `${opts.target} nao respondeu em ${timeoutMs}ms`);
          } else {
            onFailure(opts.target);
            lastError = new RemoteError('network', `falha de rede com ${opts.target}: ${String(err)}`);
          }

          if (attempt < retries) {
            await backoff(attempt);
            continue;
          }
          throw lastError;
        }
      }

      throw lastError ?? new RemoteError('network', `falha desconhecida com ${opts.target}`);
    },
  );
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Backoff exponencial com jitter, para nao sincronizar retentativas. */
async function backoff(attempt: number): Promise<void> {
  const base = Math.min(100 * 2 ** attempt, 1000);
  const jitter = Math.random() * base * 0.3;
  await new Promise((r) => setTimeout(r, base + jitter));
}
