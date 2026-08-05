import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { config } from './config.js';
import { log } from './log.js';
import { breakerSnapshot } from './httpClient.js';
import { httpDuration, httpRequests, inFlight, registry } from './metrics.js';
import { parseTraceparent, runInContext, startSpan, startTracing, stopTracing, type Span } from './trace.js';

type ReqExtras = FastifyRequest & { startTime?: bigint; span?: Span };

/**
 * Fabrica de servidor: todo servico ganha /health, /metrics, trace distribuido
 * e desligamento gracioso pelo mesmo caminho.
 */

export interface ServerOptions {
  /** Executado antes de aceitar trafego. Falha aqui impede o boot. */
  ready?: () => Promise<void>;
  /** Executado no desligamento, na ordem inversa da inicializacao. */
  shutdown?: () => Promise<void>;
  /** Registra rotas e plugins. */
  routes: (app: FastifyInstance) => Promise<void> | void;
}

export async function createServer(opts: ServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    // O corpo maximo e pequeno de proposito: nenhum endpoint recebe payload grande.
    bodyLimit: 256 * 1024,
    disableRequestLogging: true,
  });

  // Um span de servidor por requisicao, ligado ao traceparent recebido. Abre no
  // onRequest e fecha no onResponse; `runInContext` faz o contexto acompanhar
  // todo o resto do ciclo, incluindo as chamadas HTTP que o handler dispara.
  app.addHook('onRequest', (req, _reply, done) => {
    (req as ReqExtras).startTime = process.hrtime.bigint();
    inFlight.inc();

    const parent = parseTraceparent(req.headers.traceparent);
    const span = startSpan(`${req.method} ${req.routeOptions?.url ?? req.url}`, {
      kind: 'server',
      parent,
      attributes: { 'http.method': req.method, 'http.target': req.url },
    });
    (req as ReqExtras).span = span;
    runInContext(span.ctx, done);
  });

  app.addHook('onResponse', async (req, reply) => {
    inFlight.dec();
    const extras = req as ReqExtras;
    const route = req.routeOptions?.url ?? 'unknown';
    const labels = { method: req.method, route, status: String(reply.statusCode) };
    httpRequests.inc(labels);
    if (extras.startTime) {
      httpDuration.observe(labels, Number(process.hrtime.bigint() - extras.startTime) / 1e9);
    }
    if (extras.span) {
      extras.span.setAttribute('http.status', reply.statusCode);
      if (reply.statusCode >= 500) extras.span.setError(`status ${reply.statusCode}`);
      extras.span.end();
    }
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: config.serviceName,
    version: config.appVersion,
  }));

  // Estado dos circuit breakers DESTE servico. Cada um tem os seus: o que abre
  // quando o PSP cai vive no `payments`, e nao na borda.
  app.get('/diagnostics', async () => ({
    service: config.serviceName,
    version: config.appVersion,
    breakers: breakerSnapshot(),
  }));

  app.get('/metrics', async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  await opts.routes(app);

  startTracing();
  if (opts.ready) await opts.ready();

  await app.listen({ port: config.port, host: '0.0.0.0' });
  log.info('servico no ar', { port: config.port });

  const close = async (signal: string): Promise<void> => {
    log.info('desligando', { signal });
    try {
      await app.close();
      if (opts.shutdown) await opts.shutdown();
      await stopTracing();
    } catch (err) {
      log.error('erro no desligamento', { error: String(err) });
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => void close('SIGTERM'));
  process.on('SIGINT', () => void close('SIGINT'));

  return app;
}

/** Encerra o processo com log claro quando o boot falha. */
export function bootstrap(main: () => Promise<unknown>): void {
  main().catch((err) => {
    log.error('falha ao iniciar', { error: err instanceof Error ? err.stack : String(err) });
    process.exit(1);
  });
}
