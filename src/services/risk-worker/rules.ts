import type pg from 'pg';
import { query } from '../../shared/db.js';
import type { NormalizedRiskEvent, RiskEvidence } from '../../shared/riskEvents.js';

/**
 * Motor de scoring multifatorial.
 *
 * Os quatro fatores sao exatamente os que a Secao 4.2 da especificacao exige:
 * device fingerprint, velocidade de acao, padrao de escolhas e correlacao
 * entre contas.
 *
 * Cada regra devolve uma evidencia com:
 *
 *   severity     0 a 1, o quanto a regra considera aquilo anormal
 *   weight       peso vigente, vindo das feature flags
 *   points       severity x weight
 *   observed     os numeros crus que a regra viu
 *   explanation  o motivo, em portugues, legivel por um humano
 *
 * A explicacao nao e enfeite. Um antifraude que diz "score 87" e inutil para
 * quem precisa decidir se libera um comprador; um que diz "12 contas distintas
 * compartilham este dispositivo nos ultimos 10 minutos" e acionavel.
 *
 * Guardar `severity` separada de `points` e o que permite recalcular o score
 * com pesos novos sem reprocessar evento nenhum.
 *
 * ---------------------------------------------------------------------------
 * PESOS E LIMIAR
 *
 * Pesos: velocity 38, choice_pattern 37, device_fingerprint 35,
 * account_correlation 35. Limiar de quarentena: 70.
 *
 * Os numeros nao sao arbitrarios; eles codificam uma regra de decisao:
 *
 *     nenhum fator sozinho quarentena (o maior peso e 38);
 *     dois fatores quaisquer no maximo quarentenam (o menor par e 35+35=70).
 *
 * O motivo e que todo sinal isolado tem explicacao inocente. Um dispositivo
 * com varias contas pode ser uma familia. Um IP com varias contas pode ser um
 * escritorio. Uma compra rapida pode ser alguem decidido. Um antifraude que
 * age com um unico sinal e um gerador de falso positivo caro — aqui, negar a
 * venda a um cliente legitimo. Dois sinais independentes no maximo, nao: e a
 * coincidencia que deixa de ser coincidencia.
 *
 * Velocidade e padrao de escolha pesam um pouco mais porque sao evidencia
 * DIRETA sobre esta conta — o que ela mesma fez. Dispositivo e correlacao sao
 * CONTEXTUAIS: acusam por associacao com terceiros, e associacao erra mais.
 *
 * Os pesos somam 145, e o score e limitado a 100. Fazer a soma dar exatamente
 * 100 seria elegante e errado: obrigaria todo subconjunto de sinais a ser
 * insuficiente por construcao, e um bot solitario — que so pode disparar os
 * dois fatores comportamentais — jamais seria pego. O que precisa significar
 * algo e o limiar, nao o teto.
 *
 * As explicacoes inocentes ficam codificadas nos PISOS de cada regra (3 contas
 * por dispositivo, 4 por IP, 2 por cartao), nao nos pesos. E por isso que a
 * familia do cenario 6 pontua baixo: nao porque o peso e pequeno, mas porque a
 * severidade dela e pequena.
 * ---------------------------------------------------------------------------
 *
 * JANELAS RELATIVAS AO EVENTO
 *
 * Toda janela temporal e medida a partir do `occurred_at` do evento avaliado, e
 * nao de `now()`. Duas consequencias, ambas necessarias:
 *
 *   1. A avaliacao vira funcao pura de (evento, historico, configuracao). O
 *      mesmo evento reprocessado amanha produz a mesma evidencia. Sem isso, uma
 *      reentrega do barramento — que e at-least-once, entao acontece — poderia
 *      gerar uma evidencia diferente da original.
 *
 *   2. Atraso de processamento deixa de alterar o resultado. Se o worker
 *      acumula fila, os eventos continuam sendo julgados pela vizinhanca que
 *      eles tiveram de fato, e nao pela que sobrou quando chegou a vez deles.
 *
 * O limite superior (`occurred_at <= evento`) e igualmente deliberado: um
 * evento nunca e julgado por algo que aconteceu depois dele.
 */

/**
 * Tempo minimo plausivel entre abrir o mapa e concluir a compra.
 *
 * Uma pessoa precisa ler, escolher e clicar. O valor foi escolhido com folga
 * deliberada: e melhor deixar passar um humano muito rapido do que acusar
 * alguem decidido. Falso positivo aqui custa caro.
 */
export const HUMAN_MIN_DECISION_MS = 800;

/** Normaliza um valor observado para 0..1 entre dois limiares. */
export function ratio(value: number, floor: number, ceiling: number): number {
  if (value <= floor) return 0;
  if (value >= ceiling) return 1;
  return (value - floor) / (ceiling - floor);
}

export interface RuleFlag {
  name: string;
  enabled: boolean;
  weight: number;
}

type Rule = (
  client: pg.PoolClient,
  event: NormalizedRiskEvent,
  weight: number,
  windowMinutes: number,
) => Promise<RiskEvidence | null>;

const num = (v: unknown): number => Number(v ?? 0);

// ---------------------------------------------------------------------------
// F1 — Device fingerprint
// ---------------------------------------------------------------------------

/**
 * Duas anomalias opostas, e ambas sao sinal:
 *
 * - um dispositivo servindo muitas contas: cambista rodando varias contas na
 *   mesma maquina;
 * - uma conta aparecendo em muitos dispositivos: fazenda de celulares, ou
 *   fingerprint forjado a cada requisicao.
 */
const deviceFingerprint: Rule = async (client, event, weight, windowMinutes) => {
  if (!event.deviceFingerprint) return null;

  const rows = await query<{ contas: number; devices: number }>(
    `SELECT
       (SELECT count(DISTINCT buyer_id)::int FROM risk_events
         WHERE device_fingerprint = $1
           AND occurred_at >  $4::timestamptz - make_interval(mins => $3)
           AND occurred_at <= $4::timestamptz) AS contas,
       (SELECT count(DISTINCT device_fingerprint)::int FROM risk_events
         WHERE buyer_id = $2 AND device_fingerprint IS NOT NULL
           AND occurred_at >  $4::timestamptz - make_interval(mins => $3)
           AND occurred_at <= $4::timestamptz) AS devices`,
    [event.deviceFingerprint, event.buyerId, windowMinutes, event.occurredAt],
    client,
  );

  const contasNoDevice = num(rows[0]?.contas);
  const devicesDaConta = num(rows[0]?.devices);

  // Uma familia comprando do mesmo notebook chega a 3 ou 4 contas. Acima de
  // 10 nao ha explicacao inocente.
  const sevCompartilhado = ratio(contasNoDevice, 3, 10);
  // Trocar de celular durante a compra acontece; ter 8 aparelhos, nao.
  const sevMultiDevice = ratio(devicesDaConta, 3, 8);
  const severity = Math.max(sevCompartilhado, sevMultiDevice);
  if (severity <= 0) return null;

  const explanation =
    sevCompartilhado >= sevMultiDevice
      ? `${contasNoDevice} contas distintas compartilham este dispositivo nos ultimos ${windowMinutes} minutos`
      : `esta conta apareceu em ${devicesDaConta} dispositivos distintos nos ultimos ${windowMinutes} minutos`;

  return {
    factor: 'device_fingerprint',
    severity: Number(severity.toFixed(3)),
    weight,
    points: Number((severity * weight).toFixed(2)),
    observed: { contasNoDevice, devicesDaConta, janelaMin: windowMinutes },
    explanation,
  };
};

// ---------------------------------------------------------------------------
// F2 — Velocidade de acao
// ---------------------------------------------------------------------------

/**
 * Tres sinais de automacao no tempo:
 *
 * - decidir a compra em menos tempo do que um humano leva para ler o mapa;
 * - manter cadencia constante entre acoes, com variancia quase nula;
 * - tentar comprar mais vezes por minuto do que e plausivel.
 *
 * O primeiro e o mais forte: gente precisa olhar antes de escolher.
 */
const velocity: Rule = async (client, event, weight, windowMinutes) => {
  if (event.eventType !== 'CHECKOUT_ATTEMPT' && event.eventType !== 'PURCHASE_CONFIRMED') {
    return null;
  }

  const [ultimaLeitura] = await query<{ occurred_at: Date }>(
    `SELECT occurred_at FROM risk_events
      WHERE buyer_id = $1 AND event_type IN ('SEATMAP_VIEW', 'QUEUE_ADMITTED')
        AND occurred_at <= $2::timestamptz
      ORDER BY occurred_at DESC LIMIT 1`,
    [event.buyerId, event.occurredAt],
    client,
  );

  let decisaoMs: number | null = null;
  if (ultimaLeitura) {
    decisaoMs = Math.max(
      new Date(event.occurredAt).getTime() - ultimaLeitura.occurred_at.getTime(),
      0,
    );
  }

  const [agg] = await query<{ tentativas: number; desvio: number | null; media: number | null }>(
    `WITH intervalos AS (
       SELECT EXTRACT(EPOCH FROM (
                occurred_at - lag(occurred_at) OVER (ORDER BY occurred_at)
              )) AS gap
         FROM risk_events
        WHERE buyer_id = $1
          AND occurred_at >  $3::timestamptz - make_interval(mins => $2)
          AND occurred_at <= $3::timestamptz
     )
     SELECT
       (SELECT count(*)::int FROM risk_events
         WHERE buyer_id = $1 AND event_type = 'CHECKOUT_ATTEMPT'
           AND occurred_at >  $3::timestamptz - make_interval(mins => $2)
           AND occurred_at <= $3::timestamptz) AS tentativas,
       stddev_pop(gap) AS desvio,
       avg(gap) AS media
     FROM intervalos WHERE gap IS NOT NULL`,
    [event.buyerId, windowMinutes, event.occurredAt],
    client,
  );

  const tentativas = num(agg?.tentativas);
  const desvio = num(agg?.desvio);
  const media = num(agg?.media);

  // 0 ms = certeza de bot; 800 ms = limite humano plausivel.
  const sevDecisao = decisaoMs === null ? 0 : 1 - ratio(decisaoMs, 0, HUMAN_MIN_DECISION_MS);
  const sevTaxa = ratio(tentativas, 5, 25);

  // Coeficiente de variacao: desvio relativo a media. Abaixo de 5% e
  // regularidade de maquina — gente nao tem cadencia de metronomo.
  let sevCadencia = 0;
  if (tentativas >= 5 && media > 0) {
    sevCadencia = 1 - ratio(desvio / media, 0.05, 0.4);
  }

  const severity = Math.max(sevDecisao, sevTaxa, sevCadencia);
  if (severity <= 0) return null;

  let explanation: string;
  if (sevDecisao >= Math.max(sevTaxa, sevCadencia) && decisaoMs !== null) {
    explanation =
      `decidiu a compra em ${Math.round(decisaoMs)} ms apos abrir o mapa; ` +
      `o minimo plausivel para uma pessoa e ${HUMAN_MIN_DECISION_MS} ms`;
  } else if (sevTaxa >= sevCadencia) {
    explanation = `${tentativas} tentativas de compra nos ultimos ${windowMinutes} minutos`;
  } else {
    explanation =
      `intervalo entre acoes com variacao de apenas ${((desvio / media) * 100).toFixed(1)}%: ` +
      'cadencia constante demais para ser humana';
  }

  return {
    factor: 'velocity',
    severity: Number(severity.toFixed(3)),
    weight,
    points: Number((severity * weight).toFixed(2)),
    observed: {
      decisaoMs: decisaoMs === null ? null : Math.round(decisaoMs),
      tentativasNaJanela: tentativas,
      desvioIntervalosS: Number(desvio.toFixed(3)),
      mediaIntervalosS: Number(media.toFixed(3)),
    },
    explanation,
  };
};

// ---------------------------------------------------------------------------
// F3 — Padrao de escolhas
// ---------------------------------------------------------------------------

/**
 * O sinal mais limpo de automacao neste dominio: **comprar sem ter olhado**.
 *
 * Uma pessoa abre o mapa, procura, escolhe. Um bot ja sabe o que quer e vai
 * direto ao assento. Se nao existe evento de leitura do mapa antes da compra,
 * ninguem olhou.
 */
const choicePattern: Rule = async (client, event, weight, windowMinutes) => {
  if (event.eventType !== 'CHECKOUT_ATTEMPT' && event.eventType !== 'PURCHASE_CONFIRMED') {
    return null;
  }

  const [agg] = await query<{ leituras: number; compras: number; setores: number }>(
    `SELECT
       count(*) FILTER (WHERE event_type = 'SEATMAP_VIEW')::int AS leituras,
       count(*) FILTER (WHERE event_type IN ('CHECKOUT_ATTEMPT','PURCHASE_CONFIRMED'))::int AS compras,
       count(DISTINCT split_part(seat_id, '-', 1)) FILTER (WHERE seat_id IS NOT NULL)::int AS setores
     FROM risk_events
     WHERE buyer_id = $1
       AND occurred_at >  $3::timestamptz - make_interval(mins => $2)
       AND occurred_at <= $3::timestamptz`,
    [event.buyerId, windowMinutes, event.occurredAt],
    client,
  );

  const leituras = num(agg?.leituras);
  const compras = num(agg?.compras);
  const setores = num(agg?.setores);

  let sevCego = 0;
  if (compras >= 2 && leituras === 0) {
    // Comprou varias vezes sem nunca abrir o mapa. Nao ha como escolher um
    // assento sem ver o mapa, a menos que ja se soubesse qual era.
    sevCego = 1;
  } else if (compras >= 3 && leituras > 0) {
    // Muito mais compras do que leituras: olhou uma vez e automatizou o resto.
    sevCego = ratio(compras / leituras, 2, 8);
  }

  // Concentrar muitas compras em um unico setor e padrao de aquisicao para
  // revenda: o cambista quer o lote contiguo, nao o melhor lugar.
  let sevBloco = 0;
  if (compras >= 4 && setores === 1) {
    sevBloco = ratio(compras, 4, 15);
  }

  const severity = Math.max(sevCego, sevBloco);
  if (severity <= 0) return null;

  const explanation =
    sevCego >= sevBloco
      ? `${compras} compras com ${leituras} leituras do mapa: escolheu o assento sem olhar a disponibilidade`
      : `${compras} compras concentradas em ${setores} setor: padrao de aquisicao em bloco para revenda`;

  return {
    factor: 'choice_pattern',
    severity: Number(severity.toFixed(3)),
    weight,
    points: Number((severity * weight).toFixed(2)),
    observed: { leiturasDoMapa: leituras, compras, setores },
    explanation,
  };
};

// ---------------------------------------------------------------------------
// F4 — Correlacao entre contas
// ---------------------------------------------------------------------------

/**
 * O fator que so faz sentido olhando o conjunto.
 *
 * Isoladamente, cada compra e inocente. O padrao e que nao e: varias contas no
 * mesmo IP, o mesmo instrumento de pagamento em contas diferentes, ou contas
 * distintas levando assentos vizinhos em poucos segundos.
 *
 * E o unico fator que detecta conluio — e conluio e invisivel para qualquer
 * regra que olhe uma conta de cada vez.
 */
const accountCorrelation: Rule = async (client, event, weight, windowMinutes) => {
  const observed: Record<string, unknown> = {};
  const candidatos: { severity: number; explanation: string }[] = [];

  if (event.ipAddress) {
    const [row] = await query<{ n: number }>(
      `SELECT count(DISTINCT buyer_id)::int AS n FROM risk_events
        WHERE ip_address = $1
          AND occurred_at >  $3::timestamptz - make_interval(mins => $2)
          AND occurred_at <= $3::timestamptz`,
      [event.ipAddress, windowMinutes, event.occurredAt],
      client,
    );
    const contasNoIp = num(row?.n);
    observed.contasNoIp = contasNoIp;
    // Casa com internet compartilhada chega a 4 ou 5. Acima de 12, nao.
    candidatos.push({
      severity: ratio(contasNoIp, 4, 12),
      explanation: `${contasNoIp} contas distintas compraram do mesmo IP nos ultimos ${windowMinutes} minutos`,
    });
  }

  if (event.paymentHash) {
    const [row] = await query<{ n: number }>(
      `SELECT count(DISTINCT buyer_id)::int AS n FROM risk_events
        WHERE payment_hash = $1
          AND occurred_at >  $3::timestamptz - make_interval(mins => $2)
          AND occurred_at <= $3::timestamptz`,
      [event.paymentHash, windowMinutes, event.occurredAt],
      client,
    );
    const contasNoPagamento = num(row?.n);
    observed.contasNoPagamento = contasNoPagamento;
    // O mesmo instrumento de pagamento em contas diferentes e o sinal mais
    // dificil de justificar de forma inocente.
    candidatos.push({
      severity: ratio(contasNoPagamento, 2, 6),
      explanation: `${contasNoPagamento} contas usaram o mesmo instrumento de pagamento`,
    });
  }

  // Conluio: contas distintas levando assentos vizinhos quase ao mesmo tempo.
  //
  // 30 segundos, e nao a janela de 10 minutos das outras regras: o sinal aqui e
  // a SIMULTANEIDADE. Dez contas comprando no mesmo setor ao longo de dez
  // minutos e uma noite movimentada; as mesmas dez em trinta segundos e um
  // grupo agindo junto.
  if (event.seatId && event.showId) {
    const setor = event.seatId.split('-')[0];
    const [row] = await query<{ n: number }>(
      `SELECT count(DISTINCT buyer_id)::int AS n FROM risk_events
        WHERE show_id = $1 AND seat_id LIKE $2
          AND event_type IN ('CHECKOUT_ATTEMPT','PURCHASE_CONFIRMED')
          AND occurred_at >  $3::timestamptz - interval '30 seconds'
          AND occurred_at <= $3::timestamptz`,
      [event.showId, `${setor}-%`, event.occurredAt],
      client,
    );
    const vizinhos = num(row?.n);
    observed.contasNoSetor30s = vizinhos;
    candidatos.push({
      severity: ratio(vizinhos, 5, 15),
      explanation:
        `${vizinhos} contas distintas compraram no setor ${setor} em 30 segundos: aquisicao coordenada`,
    });
  }

  if (candidatos.length === 0) return null;
  const melhor = candidatos.reduce((a, b) => (b.severity > a.severity ? b : a));
  if (melhor.severity <= 0) return null;

  return {
    factor: 'account_correlation',
    severity: Number(melhor.severity.toFixed(3)),
    weight,
    points: Number((melhor.severity * weight).toFixed(2)),
    observed,
    explanation: melhor.explanation,
  };
};

export const RULES: Record<string, Rule> = {
  device_fingerprint: deviceFingerprint,
  velocity,
  choice_pattern: choicePattern,
  account_correlation: accountCorrelation,
};

/**
 * Roda as regras habilitadas e devolve as evidencias produzidas.
 *
 * As flags sao lidas a cada mensagem, entao desligar uma regra no Painel tem
 * efeito imediato, sem reiniciar nada.
 */
export async function evaluate(
  client: pg.PoolClient,
  event: NormalizedRiskEvent,
  flags: Map<string, RuleFlag>,
  windowMinutes: number,
): Promise<RiskEvidence[]> {
  const evidences: RiskEvidence[] = [];

  for (const [name, rule] of Object.entries(RULES)) {
    const flag = flags.get(name);
    if (!flag || !flag.enabled) continue;
    const evidence = await rule(client, event, flag.weight, windowMinutes);
    if (evidence) evidences.push(evidence);
  }

  return evidences;
}

/**
 * Score derivado das evidencias, e nao de um contador acumulado.
 *
 * Para cada fator, vale a evidencia mais recente — e a avaliacao atual daquele
 * fator. O score e a soma, limitada a 100.
 *
 * A soma usa `severity x peso ATUAL`, e nao os `points` gravados. E o que faz
 * uma mudanca de peso no Painel se refletir no score de todo mundo sem
 * reprocessar um evento sequer.
 */
export function deriveScore(
  latestPerFactor: { factor: string; severity: number }[],
  flags: Map<string, RuleFlag>,
): number {
  let total = 0;
  for (const { factor, severity } of latestPerFactor) {
    const flag = flags.get(factor);
    if (!flag || !flag.enabled) continue;
    total += severity * flag.weight;
  }
  return Math.min(100, Number(total.toFixed(2)));
}
