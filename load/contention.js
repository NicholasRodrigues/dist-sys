import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { textSummary } from './summary.js';

/**
 * C2 — Contencao maxima.
 *
 * Todos os usuarios virtuais disputam o MESMO conjunto pequeno de assentos.
 *
 * E o teste que quebra sistemas que dependem de otimismo. Carga distribuida
 * esconde o problema: cada um pega um assento diferente e nada colide. Aqui a
 * colisao e o ponto — mede-se a degradacao sob contencao real, e se a
 * invariante do assento sobrevive a ela.
 *
 * O resultado esperado nao e "tudo passa". E: muita gente recebe 409, ninguem
 * recebe 500, e o numero de ingressos emitidos e exatamente o numero de
 * assentos do setor.
 */

const EDGE = __ENV.EDGE_URL || 'http://traefik:80';
const EVENT_ID = __ENV.K6_EVENT_ID || 'show-do-seculo';
const SECTION = __ENV.K6_SECTION || 'CAMAROTE';
const VUS = Number(__ENV.K6_VUS || 100);

const ganhou = new Counter('assento_conquistado');
const perdeu = new Counter('assento_ja_tomado');
const erroServidor = new Counter('erro_de_servidor');

export const options = {
  scenarios: {
    contencao: {
      executor: 'constant-vus',
      vus: VUS,
      duration: __ENV.K6_DURATION || '45s',
    },
  },
  thresholds: {
    // A meta aqui nao e latencia, e correcao: nenhum 5xx e nenhum overselling.
    erro_de_servidor: ['count==0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],
};

function json(res) {
  try {
    return res.json();
  } catch {
    return {};
  }
}

export default function () {
  const userId = `contencao-${__VU}-${__ITER}`;

  const auth = http.post(
    `${EDGE}/api/auth/token`,
    JSON.stringify({ userId }),
    { headers: { 'content-type': 'application/json' } },
  );
  if (auth.status !== 200) return;
  const token = json(auth).token;
  const authHeaders = { 'content-type': 'application/json', authorization: `Bearer ${token}` };

  let admissionToken = null;
  const entrada = http.post(
    `${EDGE}/api/queue/join`,
    JSON.stringify({ eventId: EVENT_ID }),
    { headers: authHeaders },
  );
  const entradaBody = json(entrada);
  if (!entradaBody.disabled && entradaBody.queueToken) {
    const limite = Date.now() + 45_000;
    while (Date.now() < limite) {
      const st = http.get(
        `${EDGE}/api/queue/status?eventId=${EVENT_ID}&token=${entradaBody.queueToken}`,
        { headers: authHeaders },
      );
      const body = json(st);
      if (body.admitted && body.admissionToken) {
        admissionToken = body.admissionToken;
        break;
      }
    }
    if (!admissionToken) return;
  }

  // Todos no mesmo setor: e daqui que vem a contencao.
  const mapa = http.get(
    `${EDGE}/api/events/${EVENT_ID}/available-seat?section=${SECTION}`,
    { headers: authHeaders },
  );
  if (mapa.status !== 200) return;
  const seatId = json(mapa).seatId;
  if (!seatId) return;

  const headers = {
    ...authHeaders,
    'idempotency-key': `${userId}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  };
  if (admissionToken) headers['x-admission-token'] = admissionToken;

  const compra = http.post(
    `${EDGE}/api/orders`,
    JSON.stringify({ eventId: EVENT_ID, seatId }),
    { headers },
  );

  const corpo = json(compra);
  if (compra.status === 201 && corpo.status === 'CONFIRMED') ganhou.add(1);
  else if (compra.status === 409) perdeu.add(1);
  else if (compra.status >= 500) erroServidor.add(1);

  check(compra, {
    'sem erro de servidor sob contencao': (r) => r.status < 500,
  });
}

export function handleSummary(data) {
  return {
    stdout: textSummary(data, { indent: '  ', enableColors: false }),
    '/resultados/contencao.json': JSON.stringify(data, null, 2),
    '/resultados/contencao.txt': textSummary(data, { indent: '  ', enableColors: false }),
  };
}
