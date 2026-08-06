import { randomUUID } from 'node:crypto';
import { closeBus, ensureRiskTopics, publishRaw, waitForBus } from '../../shared/bus.js';
import { log } from '../../shared/log.js';
import { businessEvents } from '../../shared/metrics.js';
import {
  NormalizationError,
  RISK_TOPIC,
  normalizeRiskEvent,
  type ExternalRiskEvent,
} from '../../shared/riskEvents.js';
import { bootstrap, createServer } from '../../shared/server.js';
import { currentContext } from '../../shared/trace.js';

/**
 * risk-event-api — ponto de entrada do Risk-Shield e camada de anticorrupcao.
 *
 * Recebe eventos de duas origens com formatos diferentes (a Bilheteria e o
 * Simulador), normaliza para um modelo interno versionado, gera o
 * `correlation_id` e publica no barramento.
 *
 * NAO chama o motor antifraude. Essa e a decisao central: uma chamada sincrona
 * faria com que uma lentidao do worker afetasse tambem o recebimento dos
 * eventos — e o recebimento nao pode parar, porque o evento ja aconteceu.
 * Perder um evento e pior do que processa-lo tarde.
 *
 * Por isso este servico e deliberadamente burro: valida, normaliza, publica e
 * responde. Nada mais.
 */

bootstrap(async () => {
  await waitForBus();
  await ensureRiskTopics();

  return createServer({
    async shutdown() {
      await closeBus();
    },
    routes(app) {
      /**
       * Recebe um evento.
       *
       * O `correlation_id` nasce aqui e acompanha o evento por todo o caminho:
       * header da mensagem no barramento, logs do worker, linhas do banco.
       * Quando existe um trace distribuido em curso, reaproveitamos o
       * `traceId` — assim o rastro do antifraude fica ligado ao da compra que
       * o originou, e uma quarentena pode ser explicada de volta ate o
       * checkout que a disparou.
       */
      app.post('/events', async (req, reply) => {
        const correlationId =
          (req.headers['x-correlation-id'] as string | undefined) ??
          currentContext()?.traceId ??
          randomUUID();

        try {
          const normalized = normalizeRiskEvent(req.body as ExternalRiskEvent, correlationId);
          await publishRaw(RISK_TOPIC, normalized.buyerId, normalized, correlationId);
          businessEvents.inc({ event: 'risk_event_received' });
          return reply.code(202).send({
            accepted: true,
            eventId: normalized.eventId,
            correlationId,
          });
        } catch (err) {
          if (err instanceof NormalizationError) {
            // Contrato externo invalido e recusado NA BORDA, com 400. Deixar
            // passar significaria descobrir o problema no worker, onde a unica
            // saida seria a DLQ.
            businessEvents.inc({ event: 'risk_event_rejected' });
            return reply.code(400).send({ error: err.message, correlationId });
          }
          throw err;
        }
      });

      /** Lote: o Simulador manda cenarios inteiros de uma vez. */
      app.post('/events/batch', async (req, reply) => {
        const body = req.body as { events?: ExternalRiskEvent[] };
        if (!Array.isArray(body?.events)) {
          return reply.code(400).send({ error: 'events deve ser um array' });
        }

        const correlationId =
          (req.headers['x-correlation-id'] as string | undefined) ??
          currentContext()?.traceId ??
          randomUUID();

        const accepted: string[] = [];
        const rejected: { index: number; error: string }[] = [];

        for (const [index, external] of body.events.entries()) {
          try {
            const normalized = normalizeRiskEvent(external, correlationId);
            await publishRaw(RISK_TOPIC, normalized.buyerId, normalized, correlationId);
            accepted.push(normalized.eventId);
          } catch (err) {
            rejected.push({
              index,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        businessEvents.inc({ event: 'risk_event_received' }, accepted.length);
        if (rejected.length > 0) {
          businessEvents.inc({ event: 'risk_event_rejected' }, rejected.length);
        }
        log.info('lote recebido', { aceitos: accepted.length, recusados: rejected.length });

        return reply.code(202).send({
          accepted: accepted.length,
          rejected,
          correlationId,
        });
      });
    },
  });
});
