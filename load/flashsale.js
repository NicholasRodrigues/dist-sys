import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { textSummary } from './summary.js';

/**
 * C1 — Flash sale.
 *
 * Rampa agressiva contra o evento de 40.000 assentos. Cada usuario virtual faz
 * o caminho completo do comprador: autentica, entra na fila, espera a vez,
 * escolhe um assento e compra.
 *
 * Rodar este mesmo script com a fila ligada e desligada produz o grafico
 * central da apresentacao — ver `make compare`.
 */

const EDGE = __ENV.EDGE_URL || 'http://traefik:80';
const EVENT_ID = __ENV.K6_EVENT_ID || 'show-do-seculo';
const VUS = Number(__ENV.K6_VUS || 200);
const DURATION = __ENV.K6_DURATION || '60s';
const SCENARIO = __ENV.SCENARIO || 'flashsale';

const comprasConfirmadas = new Counter('compras_confirmadas');
const assentoIndisponivel = new Counter('assento_indisponivel');
const barradoPorLimite = new Counter('barrado_por_limite');
const cargaDescartada = new Counter('carga_descartada');
const esperaNaFila = new Trend('espera_na_fila_ms', true);
const checkoutOk = new Rate('checkout_sucesso');

export const options = {
  scenarios: {
    flashsale: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        // A abertura de vendas nao e uma rampa suave: e uma rajada.
        { duration: '20s', target: VUS },
        { duration: DURATION, target: VUS },
        { duration: '10s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
  },
  thresholds: {
    // As metas do plano de testes. Falhar aqui reprova a rodada.
    'http_req_duration{tipo:leitura}': ['p(95)<300'],
    // O mapa de assentos serve um setor inteiro a partir do cache; a meta e
    // mais folgada que a da consulta de assento livre porque o trabalho e
    // maior, nao porque o limite foi afrouxado para o teste passar.
    'http_req_duration{tipo:mapa}': ['p(95)<800'],
    'http_req_failed{tipo:checkout}': ['rate<0.50'],
    // Declarados para que o k6 gere as submetricas correspondentes: sem
    // aparecer aqui, um agrupamento por tag nao entra no sumario e a
    // comparacao entre as rodadas fica sem os numeros que mais importam.
    'http_req_duration{tipo:checkout}': ['p(95)<5000'],
    'http_req_failed{tipo:leitura}': ['rate<0.90'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
  discardResponseBodies: false,
};

function json(res) {
  try {
    return res.json();
  } catch {
    return {};
  }
}

/**
 * Identidade completa do comprador simulado: conta, dispositivo e endereco.
 *
 * As tres precisam variar JUNTAS, e essa foi uma licao cara. A primeira versao
 * derivava a conta de (VU, iteracao) mas o dispositivo e o IP apenas do VU —
 * o que fazia cada usuario virtual parecer um unico aparelho por onde passavam
 * doze contas diferentes em dez minutos. Ou seja: duzentas fazendas de contas.
 *
 * O antifraude fez o trabalho dele e quarentenou 2.519 compradores; 96% dos
 * checkouts passaram a falhar. O detector estava certo — o gerador e que
 * descrevia um ataque enquanto dizia descrever uma venda.
 *
 * Uma venda relampago sao milhares de PESSOAS DISTINTAS comprando uma vez cada,
 * e cada uma tem o proprio telefone e a propria conexao. E isso que os
 * cabecalhos abaixo representam.
 */
function identidade(vu, iter) {
  return {
    'x-forwarded-for': `10.${(vu >> 8) & 255}.${vu & 255}.${iter & 255}`,
    'x-device-fingerprint': `k6-dev-${vu}-${iter}`,
  };
}

export default function () {
  const userId = `k6-${__VU}-${__ITER}`;
  const rede = identidade(__VU, __ITER);

  // 1. Identidade
  const auth = http.post(
    `${EDGE}/api/auth/token`,
    JSON.stringify({ userId }),
    { headers: { 'content-type': 'application/json', ...rede }, tags: { tipo: 'auth' } },
  );
  if (auth.status !== 200) {
    if (auth.status === 429) barradoPorLimite.add(1);
    return;
  }
  const token = json(auth).token;
  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...rede };

  // 2. Fila virtual
  const inicioFila = Date.now();
  let admissionToken = null;

  const entrada = http.post(
    `${EDGE}/api/queue/join`,
    JSON.stringify({ eventId: EVENT_ID }),
    { headers: authHeaders, tags: { tipo: 'fila' } },
  );
  const entradaBody = json(entrada);

  if (entradaBody.disabled) {
    // Fila desligada: o checkout vai direto ao nucleo transacional. E a metade
    // "sem fila" da comparacao.
    admissionToken = null;
  } else if (entradaBody.queueToken) {
    const limite = Date.now() + 60_000;
    while (Date.now() < limite) {
      const st = http.get(
        `${EDGE}/api/queue/status?eventId=${EVENT_ID}&token=${entradaBody.queueToken}`,
        { headers: authHeaders, tags: { tipo: 'fila' } },
      );
      const body = json(st);
      if (body.admitted && body.admissionToken) {
        admissionToken = body.admissionToken;
        break;
      }
      sleep(1);
    }
    esperaNaFila.add(Date.now() - inicioFila);
    if (!admissionToken) return; // nao chegou a vez dentro do tempo do teste
  }

  // 3. Leitura do mapa: e a requisicao de baixa prioridade, a primeira a ser
  //    descartada quando o sistema entra em sobrecarga.
  //
  //    Sao duas chamadas de proposito. O `/seatmap` e o que uma pessoa de fato
  //    abre — e a unica rota que emite `SEATMAP_VIEW` para o antifraude. Sem
  //    ela, todo comprador gerado aqui compraria sem nunca ter olhado a
  //    disponibilidade, que e a assinatura mais limpa de bot que este dominio
  //    tem: a carga viraria um ataque, e nao uma medicao.
  //    Tag propria: o mapa e uma consulta bem mais pesada que `available-seat`
  //    (um setor inteiro contra uma unica linha). Medi-los sob a mesma tag
  //    esconderia qual dos dois degrada — e foi o que aconteceu na primeira
  //    rodada, em que o p95 de "leitura" estourou sem dizer por que.
  const visao = http.get(
    `${EDGE}/api/events/${EVENT_ID}/seatmap?section=PISTA-1`,
    { headers: authHeaders, tags: { tipo: 'mapa' } },
  );
  if (visao.status === 503) {
    cargaDescartada.add(1);
    return;
  }

  const mapa = http.get(
    `${EDGE}/api/events/${EVENT_ID}/available-seat`,
    { headers: authHeaders, tags: { tipo: 'leitura' } },
  );
  if (mapa.status === 503) {
    cargaDescartada.add(1);
    return;
  }
  if (mapa.status !== 200) return;
  const seatId = json(mapa).seatId;
  if (!seatId) return;

  // Tempo de leitura. Uma pessoa nao aperta "comprar" no mesmo milissegundo em
  // que o mapa termina de carregar, e o motor de risco trata decisao abaixo de
  // 800 ms como automacao. Sem esta pausa a carga mediria a taxa de quarentena.
  sleep(0.9 + Math.random() * 0.4);

  // 4. Checkout: prioridade alta, nunca descartado.
  const headers = {
    ...authHeaders,
    'idempotency-key': `${userId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  if (admissionToken) headers['x-admission-token'] = admissionToken;

  const compra = http.post(
    `${EDGE}/api/orders`,
    JSON.stringify({ eventId: EVENT_ID, seatId }),
    { headers, tags: { tipo: 'checkout' } },
  );

  const corpo = json(compra);
  const confirmada = compra.status === 201 && corpo.status === 'CONFIRMED';

  checkoutOk.add(confirmada);
  if (confirmada) comprasConfirmadas.add(1);
  // 409 aqui NAO e erro do sistema: e a invariante do assento funcionando.
  // Outra pessoa levou o lugar primeiro.
  else if (compra.status === 409) assentoIndisponivel.add(1);
  else if (compra.status === 429) barradoPorLimite.add(1);
  else if (compra.status === 503) cargaDescartada.add(1);

  check(compra, {
    'checkout nao devolveu 5xx inesperado': (r) => r.status !== 500 && r.status !== 502,
  });

  sleep(0.3 + Math.random() * 0.4);
}

export function handleSummary(data) {
  const nome = `/resultados/${SCENARIO}`;
  return {
    stdout: textSummary(data, { indent: '  ', enableColors: false }),
    [`${nome}.json`]: JSON.stringify(data, null, 2),
    [`${nome}.txt`]: textSummary(data, { indent: '  ', enableColors: false }),
  };
}
