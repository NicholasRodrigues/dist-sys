import { config } from './config.js';
import { RemoteError, request } from './httpClient.js';
import { log } from './log.js';
import { businessEvents } from './metrics.js';
import { getFlag } from './redis.js';
import type { BuyerRisk, ExternalRiskEvent } from './riskEvents.js';
import { currentContext } from './trace.js';

/**
 * Cliente do Risk-Shield, usado pela Bilheteria.
 *
 * Este arquivo e a fronteira entre os dois sistemas, e concentra a decisao mais
 * interessante do projeto inteiro:
 *
 *     Se o antifraude cair, a venda para?
 *
 * Nao ha resposta tecnica. E uma decisao de produto:
 *
 *   fail_open   uma indisponibilidade do antifraude deixa as vendas passarem.
 *               Prefere-se perder deteccao a perder receita. E o padrao, porque
 *               um sistema de seguranca que derruba a venda quando ele mesmo
 *               falha causa mais prejuizo do que a fraude que ele evita.
 *
 *   fail_closed o checkout e bloqueado. Faz sentido nos minutos de abertura de
 *               um show muito disputado, quando o custo de deixar um cambista
 *               passar supera o de perder algumas vendas legitimas.
 *
 * Por ser uma decisao de produto, ela vive numa feature flag e pode mudar em
 * tempo de execucao — inclusive durante a venda.
 *
 * O circuit breaker (herdado do `request`) e o que impede que a decisao vire
 * um travamento por timeout: sem ele, "fail_open" na teoria seria "cada
 * checkout espera 3 segundos" na pratica.
 */

export type RiskDecision =
  | { allow: true; reason: 'clear' | 'fail-open' | 'disabled'; risk?: BuyerRisk }
  | { allow: false; reason: 'quarantined' | 'fail-closed'; risk?: BuyerRisk; detail: string };

/** Publica um evento de comportamento. Nunca bloqueia o caminho da compra. */
export function emitRiskEvent(event: ExternalRiskEvent): void {
  const correlationId = currentContext()?.traceId ?? '-';
  // Deliberadamente sem await: o antifraude e observador, nao participante. Se
  // a Event API estiver lenta, a compra nao pode esperar por ela.
  void request(`${config.riskEventApiUrl}/events`, {
    method: 'POST',
    target: 'risk-event-api',
    retries: 0,
    timeoutMs: 1500,
    headers: { 'x-correlation-id': correlationId },
    body: event,
  }).catch((err) => {
    // Perder um evento de risco degrada a deteccao; derrubar a venda por causa
    // disso seria muito pior.
    log.debug('falha ao publicar evento de risco', { error: String(err) });
  });
}

/**
 * Consulta o estado de risco antes de liberar uma acao sensivel.
 *
 * Sincrona de proposito: a resposta muda o que acontece a seguir.
 */
export async function checkBuyer(buyerId: string): Promise<RiskDecision> {
  const mode = await getFlag('risk_check_mode', 'fail_open');

  if (mode === 'disabled') {
    return { allow: true, reason: 'disabled' };
  }

  try {
    const risk = await request<BuyerRisk>(
      `${config.riskApiUrl}/risk/status/${encodeURIComponent(buyerId)}`,
      { target: 'risk-api', retries: 1, timeoutMs: 1200 },
    );

    if (risk.status === 'QUARANTINED') {
      businessEvents.inc({ event: 'checkout_blocked_by_risk' });
      return {
        allow: false,
        reason: 'quarantined',
        risk,
        detail: risk.topFactors[0]?.explanation ?? 'comprador em quarentena',
      };
    }
    return { allow: true, reason: 'clear', risk };
  } catch (err) {
    const indisponivel =
      err instanceof RemoteError &&
      (err.kind === 'breaker-open' || err.kind === 'timeout' || err.kind === 'network');

    if (!indisponivel) throw err;

    if (mode === 'fail_closed') {
      businessEvents.inc({ event: 'checkout_blocked_fail_closed' });
      log.warn('antifraude indisponivel e modo fail_closed: checkout bloqueado', {
        buyerId,
        error: String(err),
      });
      return {
        allow: false,
        reason: 'fail-closed',
        detail: 'verificacao antifraude indisponivel',
      };
    }

    businessEvents.inc({ event: 'risk_check_failed_open' });
    log.warn('antifraude indisponivel, seguindo em fail_open', {
      buyerId,
      error: String(err),
    });
    return { allow: true, reason: 'fail-open' };
  }
}
