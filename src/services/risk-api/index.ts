import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query, transaction, waitForDatabase } from '../../shared/db.js';
import { log } from '../../shared/log.js';
import { businessEvents } from '../../shared/metrics.js';
import type { BuyerRisk } from '../../shared/riskEvents.js';
import { bootstrap, createServer } from '../../shared/server.js';

/**
 * risk-api — o lado de CONSULTA do CQRS.
 *
 * Le exclusivamente a projecao `buyer_risk_summary`, nunca as tabelas
 * normalizadas. O padrao de acesso aqui e "estado atual de um comprador" e
 * "lista dos mais suspeitos"; o padrao de escrita e "um evento por vez". Sao
 * formatos diferentes, e por isso sao modelos diferentes.
 *
 * Duas audiencias:
 *
 * - a **Bilheteria**, que consulta o estado de um comprador antes de liberar o
 *   checkout. Essa consulta esta no caminho mais critico do sistema e precisa
 *   ser barata: um SELECT por chave primaria.
 * - o **Painel Administrativo**, que lista suspeitos, mostra as evidencias,
 *   ajusta pesos e threshold, libera compradores e inspeciona a dead letter.
 */

interface SummaryRow {
  buyer_id: string;
  score: number;
  status: 'CLEAR' | 'QUARANTINED';
  top_factors: { factor: string; points: number; explanation: string }[];
  events_seen: number;
  updated_at: Date | null;
}

function serialize(row: SummaryRow): BuyerRisk {
  return {
    buyerId: row.buyer_id,
    score: Number(row.score),
    status: row.status,
    topFactors: row.top_factors ?? [],
    eventsSeen: row.events_seen,
    updatedAt: row.updated_at?.toISOString() ?? null,
  };
}

const WEB_ROOT = join(process.cwd(), 'web');

bootstrap(async () => {
  await waitForDatabase();

  return createServer({
    routes(app) {
      // -----------------------------------------------------------------
      // Consulta usada pela Bilheteria antes do checkout
      // -----------------------------------------------------------------

      /**
       * Estado de risco de um comprador.
       *
       * Um comprador desconhecido responde `CLEAR` com score zero, e nao 404.
       * Isso e deliberado: a Bilheteria pergunta "posso deixar comprar?", e a
       * ausencia de historico e uma resposta valida — "nao ha motivo para
       * barrar". Devolver 404 obrigaria o chamador a tratar ausencia como caso
       * especial, e o primeiro que esquecesse criaria um bloqueio indevido.
       */
      app.get('/risk/status/:buyerId', async (req) => {
        const { buyerId } = req.params as { buyerId: string };
        const rows = await query<SummaryRow>(
          `SELECT buyer_id, score, status, top_factors, events_seen, updated_at
             FROM buyer_risk_summary WHERE buyer_id = $1`,
          [buyerId],
        );
        if (rows.length === 0) {
          return { buyerId, score: 0, status: 'CLEAR', topFactors: [], eventsSeen: 0, updatedAt: null };
        }
        return serialize(rows[0]);
      });

      // -----------------------------------------------------------------
      // Painel administrativo
      // -----------------------------------------------------------------

      app.get('/risk/buyers', async (req) => {
        const { status, limit } = req.query as { status?: string; limit?: string };
        const max = Math.min(Number(limit ?? 50), 500);
        const rows =
          status === 'QUARANTINED' || status === 'CLEAR'
            ? await query<SummaryRow>(
                `SELECT buyer_id, score, status, top_factors, events_seen, updated_at
                   FROM buyer_risk_summary WHERE status = $1
                  ORDER BY score DESC, updated_at DESC LIMIT $2`,
                [status, max],
              )
            : await query<SummaryRow>(
                `SELECT buyer_id, score, status, top_factors, events_seen, updated_at
                   FROM buyer_risk_summary
                  ORDER BY score DESC, updated_at DESC LIMIT $1`,
                [max],
              );
        return { buyers: rows.map(serialize) };
      });

      /**
       * Todas as evidencias de um comprador, com o motivo em texto.
       *
       * E a tela que responde "por que este comprador foi marcado". Sem ela, o
       * antifraude e uma caixa preta que cospe um numero, e ninguem consegue
       * decidir nada com um numero.
       */
      app.get('/risk/buyers/:buyerId/evidence', async (req) => {
        const { buyerId } = req.params as { buyerId: string };
        const rows = await query<{
          factor: string;
          severity: number;
          weight: number;
          points: number;
          observed: Record<string, unknown>;
          explanation: string;
          created_at: Date;
          correlation_id: string;
        }>(
          `SELECT factor, severity, weight, points, observed, explanation, created_at, correlation_id
             FROM risk_evidence WHERE buyer_id = $1 ORDER BY id DESC LIMIT 100`,
          [buyerId],
        );
        return {
          buyerId,
          evidence: rows.map((r) => ({
            factor: r.factor,
            severity: Number(r.severity),
            weight: r.weight,
            points: Number(r.points),
            observed: r.observed,
            explanation: r.explanation,
            correlationId: r.correlation_id,
            at: r.created_at.toISOString(),
          })),
        };
      });

      app.get('/risk/buyers/:buyerId/timeline', async (req) => {
        const { buyerId } = req.params as { buyerId: string };
        const rows = await query<{ event_type: string; seat_id: string | null; occurred_at: Date }>(
          `SELECT event_type, seat_id, occurred_at FROM risk_events
            WHERE buyer_id = $1 ORDER BY occurred_at DESC LIMIT 100`,
          [buyerId],
        );
        return {
          buyerId,
          events: rows.map((r) => ({
            eventType: r.event_type,
            seatId: r.seat_id,
            at: r.occurred_at.toISOString(),
          })),
        };
      });

      /**
       * Libera um comprador da quarentena.
       *
       * So um humano faz isso. A quarentena entra sozinha por score, mas nunca
       * sai sozinha — porque um score que cai nao prova inocencia, so prova que
       * a atividade parou.
       */
      app.post('/risk/buyers/:buyerId/release', async (req, reply) => {
        const { buyerId } = req.params as { buyerId: string };
        const body = (req.body ?? {}) as { reason?: string; actor?: string };

        const result = await transaction(async (client) => {
          const rows = await query<SummaryRow>(
            `UPDATE buyer_risk_summary SET status = 'CLEAR', updated_at = now()
              WHERE buyer_id = $1 AND status = 'QUARANTINED'
              RETURNING buyer_id, score, status, top_factors, events_seen, updated_at`,
            [buyerId],
            client,
          );
          if (rows.length === 0) return undefined;

          await client.query(
            `INSERT INTO quarantine_history (buyer_id, action, reason, actor, score)
             VALUES ($1, 'RELEASE', $2, $3, $4)`,
            [
              buyerId,
              body.reason ?? 'liberado manualmente',
              body.actor ?? 'administrador',
              rows[0].score,
            ],
          );
          return rows[0];
        });

        if (!result) {
          return reply.code(404).send({ error: 'comprador nao esta em quarentena' });
        }
        businessEvents.inc({ event: 'quarantine_released' });
        log.warn('comprador liberado da quarentena', { buyerId, actor: body.actor ?? 'administrador' });
        return serialize(result);
      });

      /** Coloca em quarentena manualmente, quando o analista viu algo que a regra nao viu. */
      app.post('/risk/buyers/:buyerId/quarantine', async (req) => {
        const { buyerId } = req.params as { buyerId: string };
        const body = (req.body ?? {}) as { reason?: string; actor?: string };

        const result = await transaction(async (client) => {
          await client.query(
            `INSERT INTO buyer_risk_summary (buyer_id, status) VALUES ($1, 'QUARANTINED')
             ON CONFLICT (buyer_id) DO UPDATE SET status = 'QUARANTINED', updated_at = now()`,
            [buyerId],
          );
          const rows = await query<SummaryRow>(
            `SELECT buyer_id, score, status, top_factors, events_seen, updated_at
               FROM buyer_risk_summary WHERE buyer_id = $1`,
            [buyerId],
            client,
          );
          await client.query(
            `INSERT INTO quarantine_history (buyer_id, action, reason, actor, score)
             VALUES ($1, 'QUARANTINE', $2, $3, $4)`,
            [
              buyerId,
              body.reason ?? 'quarentena manual',
              body.actor ?? 'administrador',
              rows[0].score,
            ],
          );
          return rows[0];
        });

        businessEvents.inc({ event: 'quarantine_applied' });
        return serialize(result);
      });

      app.get('/risk/buyers/:buyerId/history', async (req) => {
        const { buyerId } = req.params as { buyerId: string };
        const rows = await query<{
          action: string;
          reason: string;
          actor: string;
          score: number;
          created_at: Date;
        }>(
          `SELECT action, reason, actor, score, created_at FROM quarantine_history
            WHERE buyer_id = $1 ORDER BY id DESC LIMIT 50`,
          [buyerId],
        );
        return {
          buyerId,
          history: rows.map((r) => ({
            action: r.action,
            reason: r.reason,
            actor: r.actor,
            score: Number(r.score ?? 0),
            at: r.created_at.toISOString(),
          })),
        };
      });

      // -----------------------------------------------------------------
      // Feature flags e configuracao
      // -----------------------------------------------------------------

      app.get('/risk/config', async () => {
        const [flags, settings] = await Promise.all([
          query<{ name: string; enabled: boolean; weight: number }>(
            `SELECT name, enabled, weight FROM rule_flags ORDER BY name`,
          ),
          query<{ key: string; value: string }>(`SELECT key, value FROM settings ORDER BY key`),
        ]);
        return {
          rules: flags.map((f) => ({ name: f.name, enabled: f.enabled, weight: Number(f.weight) })),
          settings: Object.fromEntries(settings.map((s) => [s.key, s.value])),
        };
      });

      /**
       * Liga, desliga ou repondera uma regra.
       *
       * O worker le as flags a cada mensagem, entao o efeito e imediato — sem
       * novo deploy e sem reiniciar nada. E o padrao Feature Flag fazendo
       * trabalho de verdade: a demonstracao e desligar uma regra e ver o score
       * do bot cair na tela.
       */
      app.post('/risk/config/rules/:name', async (req, reply) => {
        const { name } = req.params as { name: string };
        const body = (req.body ?? {}) as { enabled?: boolean; weight?: number };

        const rows = await query<{ name: string; enabled: boolean; weight: number }>(
          `UPDATE rule_flags
              SET enabled = COALESCE($2, enabled),
                  weight  = COALESCE($3, weight),
                  updated_at = now()
            WHERE name = $1
            RETURNING name, enabled, weight`,
          [name, body.enabled ?? null, body.weight ?? null],
        );
        if (rows.length === 0) return reply.code(404).send({ error: `regra desconhecida: ${name}` });
        log.warn('regra alterada', { name, ...body });
        return { name: rows[0].name, enabled: rows[0].enabled, weight: Number(rows[0].weight) };
      });

      app.post('/risk/config/settings', async (req, reply) => {
        const body = (req.body ?? {}) as Record<string, string | number | boolean>;
        const permitidos = ['quarantine_threshold', 'window_minutes', 'auto_quarantine'];
        const aplicados: Record<string, string> = {};

        for (const [key, value] of Object.entries(body)) {
          if (!permitidos.includes(key)) {
            return reply.code(400).send({ error: `configuracao desconhecida: ${key}`, permitidos });
          }
          await query(
            `INSERT INTO settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
            [key, String(value)],
          );
          aplicados[key] = String(value);
        }
        log.warn('configuracao alterada', aplicados);
        return { aplicados };
      });

      // -----------------------------------------------------------------
      // Dead letter e diagnostico
      // -----------------------------------------------------------------

      app.get('/risk/dead-letters', async () => {
        const rows = await query<{
          id: number;
          payload: string;
          reason: string;
          correlation_id: string | null;
          created_at: Date;
        }>(`SELECT id, payload, reason, correlation_id, created_at
              FROM dead_letters ORDER BY id DESC LIMIT 50`);
        return {
          deadLetters: rows.map((r) => ({
            id: r.id,
            payload: r.payload,
            reason: r.reason,
            correlationId: r.correlation_id,
            at: r.created_at.toISOString(),
          })),
        };
      });

      app.get('/risk/stats', async () => {
        const [row] = await query<{
          compradores: number;
          quarentenados: number;
          eventos: number;
          evidencias: number;
          dead_letters: number;
          score_medio: number;
        }>(
          `SELECT
             (SELECT count(*)::int FROM buyer_risk_summary) AS compradores,
             (SELECT count(*)::int FROM buyer_risk_summary WHERE status = 'QUARANTINED') AS quarentenados,
             (SELECT count(*)::int FROM risk_events) AS eventos,
             (SELECT count(*)::int FROM risk_evidence) AS evidencias,
             (SELECT count(*)::int FROM dead_letters) AS dead_letters,
             (SELECT COALESCE(avg(score), 0) FROM buyer_risk_summary) AS score_medio`,
        );
        return {
          compradores: row.compradores,
          quarentenados: row.quarentenados,
          eventos: row.eventos,
          evidencias: row.evidencias,
          deadLetters: row.dead_letters,
          scoreMedio: Number(Number(row.score_medio).toFixed(2)),
        };
      });

      // -----------------------------------------------------------------
      // Painel
      // -----------------------------------------------------------------

      app.get('/', async (_req, reply) => {
        try {
          const body = await readFile(join(WEB_ROOT, 'admin.html'));
          return reply.type('text/html; charset=utf-8').send(body);
        } catch {
          return reply.code(404).send({ error: 'painel nao encontrado' });
        }
      });

      app.get('/admin.js', async (_req, reply) => {
        try {
          const body = await readFile(join(WEB_ROOT, 'admin.js'));
          return reply.type('application/javascript; charset=utf-8').send(body);
        } catch {
          return reply.code(404).send({ error: 'nao encontrado' });
        }
      });
    },
  });
});
