import { randomUUID } from 'node:crypto';
import { bootstrap, createServer } from '../../shared/server.js';
import { log } from '../../shared/log.js';

/**
 * PSP PIX falso.
 *
 * Substitui o Toxiproxy: como o "sistema externo" e nosso, ele proprio expoe os
 * controles de injecao de falha. Fica mais simples de operar e muito mais
 * legivel na demonstracao — em vez de configurar um proxy, dizemos ao PSP
 * "responda com 5 segundos de latencia" e assistimos o circuit breaker abrir.
 *
 * O comportamento mais importante daqui e o `timeoutRate`: ele processa a
 * cobranca de verdade e SO ENTAO trava a resposta. E a simulacao fiel do modo de
 * falha que domina o desenho da SAGA — a cobranca aconteceu, mas o chamador
 * nunca ficou sabendo.
 */

interface Charge {
  id: string;
  amountCents: number;
  reference: string;
  status: 'APPROVED' | 'REFUNDED';
  createdAt: string;
}

const charges = new Map<string, Charge>();
// Deduplicacao por chave: o PSP real tambem e idempotente, e a SAGA depende disso.
const byIdempotencyKey = new Map<string, string>();

const faults = {
  /** Latencia artificial adicionada a toda resposta, em ms. */
  latencyMs: 0,
  /** Fracao de chamadas que respondem 500. */
  errorRate: 0,
  /** Fracao de chamadas que PROCESSAM e nunca respondem. */
  timeoutRate: 0,
  /** Recusa toda chamada, simulando indisponibilidade total. */
  down: false,
};

bootstrap(async () =>
  createServer({
    routes(app) {
      app.get('/admin/config', async () => ({ ...faults, charges: charges.size }));

      app.post('/admin/config', async (req) => {
        const body = (req.body ?? {}) as Partial<typeof faults>;
        if (typeof body.latencyMs === 'number') faults.latencyMs = Math.max(0, body.latencyMs);
        if (typeof body.errorRate === 'number') faults.errorRate = clamp01(body.errorRate);
        if (typeof body.timeoutRate === 'number') faults.timeoutRate = clamp01(body.timeoutRate);
        if (typeof body.down === 'boolean') faults.down = body.down;
        log.warn('configuracao de falha alterada', { ...faults });
        return { ...faults };
      });

      app.post('/admin/reset', async () => {
        faults.latencyMs = 0;
        faults.errorRate = 0;
        faults.timeoutRate = 0;
        faults.down = false;
        log.info('injecao de falha zerada');
        return { ...faults };
      });

      app.post('/pix/charges', async (req, reply) => {
        const body = req.body as { amountCents?: number; idempotencyKey?: string; reference?: string };

        if (faults.down) return reply.code(503).send({ error: 'psp indisponivel' });
        if (faults.latencyMs > 0) await sleep(faults.latencyMs);
        if (Math.random() < faults.errorRate) {
          return reply.code(500).send({ error: 'falha temporaria do psp' });
        }

        if (!body?.amountCents || body.amountCents <= 0) {
          return reply.code(400).send({ error: 'amountCents invalido' });
        }

        const key = body.idempotencyKey ?? randomUUID();
        const existingId = byIdempotencyKey.get(key);
        const charge: Charge = existingId
          ? charges.get(existingId)!
          : {
              id: randomUUID(),
              amountCents: body.amountCents,
              reference: body.reference ?? key,
              status: 'APPROVED',
              createdAt: new Date().toISOString(),
            };

        if (!existingId) {
          charges.set(charge.id, charge);
          byIdempotencyKey.set(key, charge.id);
        }

        // O modo de falha que define o projeto: a cobranca ESTA feita, e a
        // resposta nunca chega. Quem chamou vai ter um timeout, e nao pode
        // concluir dai que o pagamento falhou.
        if (Math.random() < faults.timeoutRate) {
          log.warn('cobranca aprovada, resposta engolida de proposito', { chargeId: charge.id });
          await sleep(120_000);
        }

        return { pspChargeId: charge.id, status: charge.status, reference: charge.reference };
      });

      app.get('/pix/charges/:id', async (req, reply) => {
        const { id } = req.params as { id: string };
        const charge = charges.get(id);
        if (!charge) return reply.code(404).send({ error: 'cobranca nao encontrada' });
        return { pspChargeId: charge.id, status: charge.status, amountCents: charge.amountCents };
      });

      /** Consulta por chave: e o que permite a reconciliacao apos um timeout. */
      app.get('/pix/charges/by-key/:key', async (req, reply) => {
        const { key } = req.params as { key: string };
        const id = byIdempotencyKey.get(key);
        if (!id) return reply.code(404).send({ error: 'nenhuma cobranca para esta chave' });
        const charge = charges.get(id)!;
        return { pspChargeId: charge.id, status: charge.status, amountCents: charge.amountCents };
      });

      app.post('/pix/charges/:id/refund', async (req, reply) => {
        const { id } = req.params as { id: string };
        const charge = charges.get(id);
        if (!charge) return reply.code(404).send({ error: 'cobranca nao encontrada' });
        charge.status = 'REFUNDED';
        return { pspChargeId: charge.id, status: charge.status };
      });
    },
  }),
);

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
