import { closeBus, ensureRiskTopics, startRawConsumer, waitForBus } from '../../shared/bus.js';
import { query, transaction, waitForDatabase } from '../../shared/db.js';
import { log } from '../../shared/log.js';
import { businessEvents } from '../../shared/metrics.js';
import type { NormalizedRiskEvent } from '../../shared/riskEvents.js';
import { RISK_TOPIC } from '../../shared/riskEvents.js';
import { bootstrap, createServer } from '../../shared/server.js';
import { deriveScore, evaluate, type RuleFlag } from './rules.js';

/**
 * risk-worker — o lado de COMANDO do CQRS.
 *
 * Consome eventos normalizados, aplica as regras, grava as evidencias, atualiza
 * a projecao de leitura e aplica quarentena quando o score cruza o threshold.
 *
 * Tres propriedades sustentam a correcao deste servico:
 *
 * 1. **Idempotencia.** `processed_events` tem o `event_id` como chave
 *    primaria, e a insercao e condicional. O barramento entrega pelo menos uma
 *    vez; o efeito acontece exatamente uma.
 *
 * 2. **Transacao unica.** Registro do evento, gravacao das evidencias e
 *    atualizacao da projecao acontecem num so commit. Nao existe estado em que
 *    a evidencia foi gravada e a projecao nao.
 *
 * 3. **Score derivado.** O score nao e um contador que se soma a cada evento —
 *    ele e recalculado a partir das evidencias correntes. Isso torna o
 *    processamento concorrente de eventos do mesmo comprador seguro, e permite
 *    recalcular tudo quando um peso muda.
 */

interface FlagRow {
  name: string;
  enabled: boolean;
  weight: number;
}

/**
 * Le flags e configuracoes a cada mensagem.
 *
 * Parece desperdicio e nao e: sao duas leituras de tabelas minusculas, e e o
 * que garante que desligar uma regra no Painel tenha efeito imediato, sem
 * reiniciar nada. Cachear aqui trocaria uma consulta barata por um bug de
 * "mudei a flag e nao aconteceu nada".
 */
async function loadConfig(): Promise<{ flags: Map<string, RuleFlag>; threshold: number; windowMinutes: number; autoQuarantine: boolean }> {
  const [flagRows, settingRows] = await Promise.all([
    query<FlagRow>(`SELECT name, enabled, weight FROM rule_flags`),
    query<{ key: string; value: string }>(`SELECT key, value FROM settings`),
  ]);

  const flags = new Map<string, RuleFlag>();
  for (const row of flagRows) {
    flags.set(row.name, { name: row.name, enabled: row.enabled, weight: Number(row.weight) });
  }

  const settings = new Map(settingRows.map((r) => [r.key, r.value]));
  return {
    flags,
    threshold: Number(settings.get('quarantine_threshold') ?? 70),
    windowMinutes: Number(settings.get('window_minutes') ?? 10),
    autoQuarantine: (settings.get('auto_quarantine') ?? 'true') === 'true',
  };
}

async function handleEvent(event: NormalizedRiskEvent, correlationId: string): Promise<void> {
  const { flags, threshold, windowMinutes, autoQuarantine } = await loadConfig();

  await transaction(async (client) => {
    // Idempotencia. Se a chave ja existe, esta mensagem e uma reentrega e nao
    // pode produzir efeito nenhum — nem evidencia, nem mudanca de score.
    const claimed = await query<{ event_id: string }>(
      `INSERT INTO processed_events (event_id) VALUES ($1)
       ON CONFLICT (event_id) DO NOTHING RETURNING event_id`,
      [event.eventId],
      client,
    );
    if (claimed.length === 0) {
      businessEvents.inc({ event: 'risk_event_duplicate' });
      log.debug('evento ja processado, ignorando', { eventId: event.eventId, correlationId });
      return;
    }

    await client.query(
      `INSERT INTO risk_events
         (event_id, schema_version, correlation_id, event_type, buyer_id, show_id, seat_id,
          device_fingerprint, ip_address, payment_hash, occurred_at, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [
        event.eventId,
        event.schemaVersion,
        correlationId,
        event.eventType,
        event.buyerId,
        event.showId,
        event.seatId,
        event.deviceFingerprint,
        event.ipAddress,
        event.paymentHash,
        event.occurredAt,
        JSON.stringify(event.metadata),
      ],
    );

    // Trava a linha do comprador. Dois eventos da mesma conta chegando em
    // paralelo por particoes diferentes seriam uma corrida na projecao.
    await client.query(
      `INSERT INTO buyer_risk_summary (buyer_id) VALUES ($1) ON CONFLICT (buyer_id) DO NOTHING`,
      [event.buyerId],
    );
    await client.query(`SELECT 1 FROM buyer_risk_summary WHERE buyer_id = $1 FOR UPDATE`, [
      event.buyerId,
    ]);

    const evidences = await evaluate(client, event, flags, windowMinutes);

    for (const evidence of evidences) {
      await client.query(
        `INSERT INTO risk_evidence
           (buyer_id, event_id, correlation_id, factor, severity, weight, points, observed, explanation)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          event.buyerId,
          event.eventId,
          correlationId,
          evidence.factor,
          evidence.severity,
          evidence.weight,
          evidence.points,
          JSON.stringify(evidence.observed),
          evidence.explanation,
        ],
      );
    }

    // Score derivado: para cada fator, vale a evidencia mais recente. A soma
    // usa o peso ATUAL, e nao o gravado — e o que faz uma mudanca de peso no
    // Painel refletir sem reprocessar evento nenhum.
    const latest = await query<{ factor: string; severity: number; explanation: string; points: number }>(
      `SELECT DISTINCT ON (factor) factor, severity, explanation, points
         FROM risk_evidence
        WHERE buyer_id = $1
        ORDER BY factor, id DESC`,
      [event.buyerId],
      client,
    );

    const score = deriveScore(
      latest.map((r) => ({ factor: r.factor, severity: Number(r.severity) })),
      flags,
    );

    const topFactors = latest
      .filter((r) => flags.get(r.factor)?.enabled)
      .map((r) => ({
        factor: r.factor,
        points: Number((Number(r.severity) * (flags.get(r.factor)?.weight ?? 0)).toFixed(2)),
        explanation: r.explanation,
      }))
      .sort((a, b) => b.points - a.points);

    const [current] = await query<{ status: string }>(
      `SELECT status FROM buyer_risk_summary WHERE buyer_id = $1`,
      [event.buyerId],
      client,
    );

    // Quarentena automatica. So entra — nunca sai sozinha: liberar exige uma
    // decisao humana no Painel, porque falso positivo aqui custa caro.
    const shouldQuarantine =
      autoQuarantine && score >= threshold && current?.status !== 'QUARANTINED';

    await client.query(
      `UPDATE buyer_risk_summary
          SET score = $2,
              top_factors = $3,
              status = CASE WHEN $4 THEN 'QUARANTINED' ELSE status END,
              events_seen = events_seen + 1,
              last_event_at = $5,
              updated_at = now()
        WHERE buyer_id = $1`,
      [
        event.buyerId,
        score,
        JSON.stringify(topFactors),
        shouldQuarantine,
        event.occurredAt,
      ],
    );

    if (shouldQuarantine) {
      const motivo = topFactors[0]?.explanation ?? 'score acima do threshold';
      await client.query(
        `INSERT INTO quarantine_history (buyer_id, action, reason, actor, score)
         VALUES ($1, 'QUARANTINE', $2, 'automatico', $3)`,
        [event.buyerId, motivo, score],
      );
      businessEvents.inc({ event: 'quarantine_applied' });
      log.warn('comprador em quarentena', {
        buyerId: event.buyerId,
        score,
        threshold,
        motivo,
        correlationId,
      });
    }

    businessEvents.inc({ event: 'risk_event_processed' });
  });
}

async function recordDeadLetter(raw: string, reason: string, correlationId: string): Promise<void> {
  try {
    await query(
      `INSERT INTO dead_letters (payload, reason, correlation_id) VALUES ($1, $2, $3)`,
      [raw.slice(0, 20000), reason, correlationId],
    );
  } catch (err) {
    log.error('falha ao registrar dead letter', { error: String(err) });
  }
}

bootstrap(async () => {
  await waitForDatabase();
  await waitForBus();
  await ensureRiskTopics();

  let consumer: Awaited<ReturnType<typeof startRawConsumer>> | undefined;

  return createServer({
    async ready() {
      consumer = await startRawConsumer<NormalizedRiskEvent>({
        topic: RISK_TOPIC,
        groupId: 'risk-worker',
        onMessage: handleEvent,
        onDeadLetter: recordDeadLetter,
      });
      log.info('motor antifraude consumindo eventos');
    },
    async shutdown() {
      if (consumer) await consumer.disconnect();
      await closeBus();
    },
    routes(app) {
      /**
       * Recalcula o score de todos os compradores com os pesos atuais.
       *
       * E a demonstracao pratica do Event Sourcing: as evidencias sao a fonte
       * da verdade, entao mudar um peso e reprojetar nao exige reprocessar um
       * evento sequer. Sem isso, alterar um peso no Painel so afetaria quem
       * gerasse eventos novos.
       */
      app.post('/recalculate', async () => {
        const { flags, threshold } = await loadConfig();

        const buyers = await query<{ buyer_id: string }>(
          `SELECT DISTINCT buyer_id FROM risk_evidence`,
        );

        let atualizados = 0;
        for (const { buyer_id: buyerId } of buyers) {
          await transaction(async (client) => {
            const latest = await query<{ factor: string; severity: number; explanation: string }>(
              `SELECT DISTINCT ON (factor) factor, severity, explanation
                 FROM risk_evidence WHERE buyer_id = $1 ORDER BY factor, id DESC`,
              [buyerId],
              client,
            );
            const score = deriveScore(
              latest.map((r) => ({ factor: r.factor, severity: Number(r.severity) })),
              flags,
            );
            const topFactors = latest
              .filter((r) => flags.get(r.factor)?.enabled)
              .map((r) => ({
                factor: r.factor,
                points: Number((Number(r.severity) * (flags.get(r.factor)?.weight ?? 0)).toFixed(2)),
                explanation: r.explanation,
              }))
              .sort((a, b) => b.points - a.points);

            await client.query(
              `UPDATE buyer_risk_summary
                  SET score = $2, top_factors = $3, updated_at = now()
                WHERE buyer_id = $1`,
              [buyerId, score, JSON.stringify(topFactors)],
            );
            atualizados++;
          });
        }

        log.info('scores recalculados a partir das evidencias', { compradores: atualizados, threshold });
        return { recalculados: atualizados, threshold };
      });
    },
  });
});
