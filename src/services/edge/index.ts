import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from '../../shared/config.js';
import { RemoteError, breakerSnapshot, request } from '../../shared/httpClient.js';
import { issueToken } from '../../shared/jwt.js';
import { log } from '../../shared/log.js';
import { getFlag, redis, setFlag, waitForRedis } from '../../shared/redis.js';
import { bootstrap, createServer } from '../../shared/server.js';
import {
  authenticate,
  checkAdmission,
  checkRateLimit,
  clientIp,
  currentInFlight,
  sendAuthFailure,
  shouldShed,
  trackInFlight,
} from './guards.js';
import { join as joinQueue, queueEnabled, reset as resetQueue, startAdmissionLoop, status as queueStatus, stopAdmissionLoop } from './queue.js';

/**
 * edge — ponto unico de entrada.
 *
 * Existe como servico proprio por perfil de escala: absorve a enxurrada
 * inteira, e stateless, replicavel e descartavel. Acumula responsabilidades de
 * proposito (gateway, fila virtual, rate limit, load shedding, JWT), porque
 * todas elas tem exatamente o mesmo perfil de carga — separa-las so
 * acrescentaria um salto de rede no caminho mais quente do sistema.
 *
 * O custo dessa decisao esta declarado no ADR-0001: este e o ponto do sistema
 * com maior risco de virar um monolito de borda, e a mitigacao e disciplina de
 * modulos, nao arquitetura.
 */

const WEB_ROOT = join(process.cwd(), 'web');
const staticCache = new Map<string, { body: Buffer; type: string }>();

async function serveStatic(path: string): Promise<{ body: Buffer; type: string } | undefined> {
  const clean = path === '/' || path === '' ? '/index.html' : path;
  if (clean.includes('..')) return undefined;
  const cached = staticCache.get(clean);
  if (cached) return cached;
  try {
    const body = await readFile(join(WEB_ROOT, clean));
    const type = clean.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : clean.endsWith('.js')
        ? 'application/javascript; charset=utf-8'
        : clean.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'application/octet-stream';
    const entry = { body, type };
    staticCache.set(clean, entry);
    return entry;
  } catch {
    return undefined;
  }
}

/** Traduz o erro de uma dependencia numa resposta honesta para o cliente. */
function mapRemoteError(err: unknown, reply: import('fastify').FastifyReply) {
  if (err instanceof RemoteError) {
    if (err.kind === 'breaker-open') {
      return reply
        .code(503)
        .header('retry-after', '5')
        .send({ error: 'servico temporariamente indisponivel', detail: 'circuit breaker aberto' });
    }
    if (err.kind === 'timeout') {
      return reply.code(504).send({ error: 'tempo esgotado na dependencia' });
    }
    if (err.status) {
      const body = (err.body ?? { error: err.message }) as Record<string, unknown>;
      return reply.code(err.status).send(body);
    }
    return reply.code(502).send({ error: err.message });
  }
  throw err;
}

bootstrap(async () => {
  await waitForRedis();

  return createServer({
    async ready() {
      startAdmissionLoop();
    },
    async shutdown() {
      stopAdmissionLoop();
    },
    routes(app) {
      // Contabiliza requisicoes em voo: e o sinal que alimenta o load shedding.
      app.addHook('onRequest', async () => trackInFlight(1));
      app.addHook('onResponse', async () => trackInFlight(-1));

      // Marca qual instancia atendeu. E o que torna load balancing, blue-green
      // e canary visiveis sem adivinhacao: basta olhar o header da resposta.
      app.addHook('onSend', async (_req, reply, payload) => {
        reply.header('x-app-version', config.appVersion);
        return payload;
      });

      // Injecao de erro artificial na instancia verde. Existe para o cenario
      // D2: um canary que comeca a falhar precisa ser revertido, e provar isso
      // exige uma versao que realmente falhe.
      app.addHook('preHandler', async (req, reply) => {
        if (config.faultRate <= 0) return;
        if (!req.url.startsWith('/api/')) return;
        if (Math.random() < config.faultRate) {
          return reply.code(500).send({ error: 'falha injetada nesta versao', version: config.appVersion });
        }
      });

      // Rate limit por IP em toda a superficie da API. O limite por identidade
      // e aplicado depois, nos endpoints autenticados.
      app.addHook('preHandler', async (req, reply) => {
        if (!req.url.startsWith('/api/')) return;
        if (req.url.startsWith('/api/admin/')) return;
        const ip = clientIp(req);
        const result = await checkRateLimit('ip', ip);
        if (!result.allowed) {
          return reply
            .code(429)
            .header('retry-after', String(config.rateLimitWindowSeconds))
            .send({ error: 'limite de requisicoes excedido', scope: 'ip', limit: result.limit });
        }
        reply.header('x-ratelimit-remaining', String(result.remaining));
      });

      // ---------------------------------------------------------------------
      // Identidade
      // ---------------------------------------------------------------------

      /**
       * Emite um JWT. Login simulado: qualquer userId e aceito.
       *
       * O que o projeto demonstra aqui e a validacao — assinatura, expiracao e
       * escopo — e nao a autenticacao em si. A troca por um provedor OIDC de
       * verdade e o item 3 do caminho de volta em docs/escopo.md.
       */
      app.post('/api/auth/token', async (req, reply) => {
        const body = (req.body ?? {}) as { userId?: string; scope?: string; ttlSeconds?: number };
        const userId = body.userId?.trim();
        if (!userId) return reply.code(400).send({ error: 'userId e obrigatorio' });
        const token = issueToken(
          { sub: userId, scope: body.scope ?? 'orders' },
          body.ttlSeconds ?? config.jwtTtlSeconds,
        );
        return { token, userId, expiresIn: body.ttlSeconds ?? config.jwtTtlSeconds };
      });

      // ---------------------------------------------------------------------
      // Fila virtual
      // ---------------------------------------------------------------------

      app.post('/api/queue/join', async (req, reply) => {
        const body = (req.body ?? {}) as { eventId?: string };
        if (!body.eventId) return reply.code(400).send({ error: 'eventId e obrigatorio' });
        if (!(await queueEnabled())) {
          return { queueToken: null, admitted: true, position: 0, ahead: 0, estimatedWaitSeconds: 0, disabled: true };
        }
        return joinQueue(body.eventId);
      });

      app.get('/api/queue/status', async (req, reply) => {
        const { eventId, token } = req.query as { eventId?: string; token?: string };
        if (!eventId || !token) {
          return reply.code(400).send({ error: 'eventId e token sao obrigatorios' });
        }
        if (!(await queueEnabled())) {
          return { queueToken: token, admitted: true, position: 0, ahead: 0, estimatedWaitSeconds: 0, disabled: true };
        }
        return queueStatus(eventId, token);
      });

      // ---------------------------------------------------------------------
      // Leitura — prioridade baixa, primeira a ser descartada sob sobrecarga
      // ---------------------------------------------------------------------

      app.get('/api/events', async (_req, reply) => {
        if (await shouldShed('low')) {
          return reply.code(503).header('retry-after', '2').send({ error: 'carga descartada' });
        }
        try {
          return await request(`${config.catalogUrl}/events`, { target: 'catalog' });
        } catch (err) {
          return mapRemoteError(err, reply);
        }
      });

      app.get('/api/events/:eventId', async (req, reply) => {
        const { eventId } = req.params as { eventId: string };
        if (await shouldShed('low')) {
          return reply.code(503).header('retry-after', '2').send({ error: 'carga descartada' });
        }
        try {
          return await request(`${config.catalogUrl}/events/${encodeURIComponent(eventId)}`, {
            target: 'catalog',
          });
        } catch (err) {
          return mapRemoteError(err, reply);
        }
      });

      app.get('/api/events/:eventId/seatmap', async (req, reply) => {
        const { eventId } = req.params as { eventId: string };
        const { section } = req.query as { section?: string };
        if (await shouldShed('low')) {
          return reply.code(503).header('retry-after', '2').send({ error: 'carga descartada' });
        }
        const qs = section ? `?section=${encodeURIComponent(section)}` : '';
        try {
          return await request(
            `${config.catalogUrl}/events/${encodeURIComponent(eventId)}/seatmap${qs}`,
            { target: 'catalog' },
          );
        } catch (err) {
          return mapRemoteError(err, reply);
        }
      });

      app.get('/api/events/:eventId/available-seat', async (req, reply) => {
        const { eventId } = req.params as { eventId: string };
        const { section } = req.query as { section?: string };
        const qs = section ? `?section=${encodeURIComponent(section)}` : '';
        try {
          return await request(
            `${config.catalogUrl}/events/${encodeURIComponent(eventId)}/available-seat${qs}`,
            { target: 'catalog' },
          );
        } catch (err) {
          return mapRemoteError(err, reply);
        }
      });

      // ---------------------------------------------------------------------
      // Compra — prioridade alta, nunca descartada
      // ---------------------------------------------------------------------

      app.post('/api/orders', async (req, reply) => {
        const auth = authenticate(req, 'orders');
        if (!auth.ok) return sendAuthFailure(reply, auth);

        const body = (req.body ?? {}) as { eventId?: string; seatId?: string };
        if (!body.eventId || !body.seatId) {
          return reply.code(400).send({ error: 'eventId e seatId sao obrigatorios' });
        }

        // Segundo limite, agora por identidade: um unico usuario nao consegue
        // varrer o mapa comprando tudo, mesmo trocando de IP.
        const perUser = await checkRateLimit('user', auth.claims.sub);
        if (!perUser.allowed) {
          return reply
            .code(429)
            .send({ error: 'limite de requisicoes excedido', scope: 'user', limit: perUser.limit });
        }

        if (await queueEnabled()) {
          const admission = checkAdmission(req, body.eventId);
          if (!admission.ok) return sendAuthFailure(reply, admission);
        }

        const idempotencyKey = req.headers['idempotency-key'];
        if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 8) {
          return reply.code(400).send({ error: 'header Idempotency-Key e obrigatorio' });
        }

        try {
          const result = await request<Record<string, unknown>>(`${config.ordersUrl}/orders`, {
            method: 'POST',
            target: 'orders',
            retries: 0,
            timeoutMs: 15000,
            headers: { 'idempotency-key': idempotencyKey },
            body: { userId: auth.claims.sub, eventId: body.eventId, seatId: body.seatId },
          });
          return reply.code(201).send(result);
        } catch (err) {
          return mapRemoteError(err, reply);
        }
      });

      app.get('/api/orders/:orderId', async (req, reply) => {
        const auth = authenticate(req, 'orders');
        if (!auth.ok) return sendAuthFailure(reply, auth);
        const { orderId } = req.params as { orderId: string };
        try {
          const order = await request<{ userId: string }>(
            `${config.ordersUrl}/orders/${encodeURIComponent(orderId)}`,
            { target: 'orders' },
          );
          // Autorizacao de recurso: ter um token valido nao da acesso ao pedido
          // de outra pessoa.
          if (order.userId !== auth.claims.sub) {
            return reply.code(403).send({ error: 'este pedido nao e seu' });
          }
          return order;
        } catch (err) {
          return mapRemoteError(err, reply);
        }
      });

      app.get('/api/orders/:orderId/saga', async (req, reply) => {
        const auth = authenticate(req, 'orders');
        if (!auth.ok) return sendAuthFailure(reply, auth);
        const { orderId } = req.params as { orderId: string };
        try {
          return await request(`${config.ordersUrl}/orders/${encodeURIComponent(orderId)}/saga`, {
            target: 'orders',
          });
        } catch (err) {
          return mapRemoteError(err, reply);
        }
      });

      app.get('/api/me/orders', async (req, reply) => {
        const auth = authenticate(req, 'orders');
        if (!auth.ok) return sendAuthFailure(reply, auth);
        try {
          return await request(
            `${config.ordersUrl}/users/${encodeURIComponent(auth.claims.sub)}/orders`,
            { target: 'orders' },
          );
        } catch (err) {
          return mapRemoteError(err, reply);
        }
      });

      // ---------------------------------------------------------------------
      // Portaria
      // ---------------------------------------------------------------------

      app.post('/api/checkin', async (req, reply) => {
        const body = (req.body ?? {}) as { qrCode?: string };
        if (!body.qrCode) return reply.code(400).send({ error: 'qrCode e obrigatorio' });
        try {
          return await request(`${config.ordersUrl}/checkin`, {
            method: 'POST',
            target: 'orders',
            retries: 0,
            body,
          });
        } catch (err) {
          return mapRemoteError(err, reply);
        }
      });

      // ---------------------------------------------------------------------
      // Operacao — feature flags e diagnostico
      // ---------------------------------------------------------------------

      app.get('/api/admin/flags', async () => ({
        queue_enabled: await getFlag('queue_enabled', 'true'),
        admission_rate: await getFlag('admission_rate', '50'),
        rate_limit_max: await getFlag('rate_limit_max', String(config.rateLimitMax)),
        load_shed_enabled: await getFlag('load_shed_enabled', 'true'),
        load_shed_threshold: await getFlag('load_shed_threshold', String(config.loadShedThreshold)),
      }));

      /**
       * Altera uma flag em tempo de execucao, sem novo deploy.
       *
       * E o mecanismo que torna o teste C3 possivel: a mesma carga roda duas
       * vezes, com a fila ligada e desligada, e a unica coisa que muda entre as
       * duas rodadas e uma chave no Redis.
       */
      app.post('/api/admin/flags', async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, string | number | boolean>;
        const allowed = [
          'queue_enabled',
          'admission_rate',
          'rate_limit_max',
          'load_shed_enabled',
          'load_shed_threshold',
        ];
        const applied: Record<string, string> = {};
        for (const [key, value] of Object.entries(body)) {
          if (!allowed.includes(key)) {
            return reply.code(400).send({ error: `flag desconhecida: ${key}`, allowed });
          }
          await setFlag(key, String(value));
          applied[key] = String(value);
        }
        log.warn('feature flags alteradas', applied);
        return { applied };
      });

      app.post('/api/admin/queue/reset', async (req) => {
        const body = (req.body ?? {}) as { eventId?: string };
        if (body.eventId) await resetQueue(body.eventId);
        return { reset: true, eventId: body.eventId ?? null };
      });

      app.get('/api/admin/diagnostics', async () => ({
        version: config.appVersion,
        faultRate: config.faultRate,
        inFlight: currentInFlight(),
        breakers: breakerSnapshot(),
        queueEnabled: await queueEnabled(),
        redis: await redis.ping().then(() => 'ok').catch(() => 'erro'),
      }));

      // ---------------------------------------------------------------------
      // Interface
      // ---------------------------------------------------------------------

      app.get('/', async (_req, reply) => {
        const file = await serveStatic('/index.html');
        if (!file) return reply.code(404).send({ error: 'interface nao encontrada' });
        return reply.type(file.type).send(file.body);
      });

      app.get('/app.js', async (_req, reply) => {
        const file = await serveStatic('/app.js');
        if (!file) return reply.code(404).send({ error: 'nao encontrado' });
        return reply.type(file.type).send(file.body);
      });
    },
  });
});
