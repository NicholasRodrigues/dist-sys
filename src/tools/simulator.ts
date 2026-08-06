import { randomUUID } from 'node:crypto';
import { Kafka, logLevel } from 'kafkajs';
import { urls, waitFor } from './pools.js';

/**
 * Simulador de cenarios do Risk-Shield.
 *
 * Um antifraude so pode ser avaliado por duas perguntas, e a segunda importa
 * mais que a primeira:
 *
 *   1. Ele pega quem deve pegar?
 *   2. Ele DEIXA PASSAR quem deve passar?
 *
 * Um sistema que quarentena todo mundo acerta a primeira e e inutil. Por isso
 * dois dos seis cenarios aqui sao compradores legitimos que exibem sinais
 * suspeitos de verdade — e a asercao e que eles NAO sejam bloqueados.
 *
 * ---------------------------------------------------------------------------
 * O FORMATO EXTERNO
 *
 * O Simulador escreve `snake_case` e manda `timestamp` sem fuso horario. A
 * Bilheteria escreve `camelCase` e nao manda timestamp nenhum. Sao dois
 * formatos externos incompativeis chegando na mesma porta — e e exatamente
 * essa incompatibilidade que faz a camada de anticorrupcao existir. Se as duas
 * origens falassem igual, o ACL seria um mapeamento identidade e nao provaria
 * nada.
 *
 * ---------------------------------------------------------------------------
 * AS DUAS ONDAS
 *
 * Cada cenario e enviado em duas levas: primeiro tudo, depois o ULTIMO evento
 * de cada comprador.
 *
 * O motivo e o particionamento. O topico e particionado por `buyer_id`, o que
 * garante ordem DENTRO de uma conta mas nao ENTRE contas. As regras de
 * dispositivo e correlacao olham o conjunto: para a compra final de uma conta
 * ser julgada com o contexto completo da quadrilha, o contexto precisa ja estar
 * gravado. A barreira entre as ondas e o que garante isso.
 *
 * Note que a ordem de ENVIO nao e a ordem dos fatos: os `timestamp` descrevem a
 * linha do tempo real, e sao eles que as regras usam. Isso e possivel porque as
 * janelas das regras sao relativas ao `occurred_at` do evento, e nao a `now()`
 * — que e tambem o que faz uma reentrega do barramento produzir a mesma
 * evidencia da primeira vez.
 */

// ---------------------------------------------------------------------------

/** O formato que o Simulador fala. Deliberadamente diferente do da Bilheteria. */
interface SimEvent {
  event_type: string;
  buyer_id: string;
  show_id?: string;
  seat_id?: string;
  device_fingerprint?: string;
  ip_address?: string;
  payment_hash?: string;
  /** Sem indicador de fuso: o ACL assume UTC. */
  timestamp: string;
}

interface Cenario {
  id: string;
  nome: string;
  descricao: string;
  /** O que o cenario existe para provar. */
  prova: string;
  esperado: {
    status: 'CLEAR' | 'QUARANTINED';
    scoreMin: number;
    scoreMax: number;
  };
  eventos: SimEvent[];
}

interface BuyerRisk {
  buyerId: string;
  score: number;
  status: 'CLEAR' | 'QUARANTINED';
  topFactors: { factor: string; points: number; explanation: string }[];
  eventsSeen: number;
}

/** Sufixo de execucao: dois `make scenarios` seguidos nao podem se contaminar. */
const RUN = randomUUID().slice(0, 8);

/**
 * Origem da linha do tempo. Os cenarios ocupam ate ~40 segundos a partir daqui,
 * entao ancoramos no passado para que nada aconteca "no futuro".
 */
const T0 = Date.now() - 60_000;

function ts(offsetMs: number): string {
  // Sem o 'Z' final de proposito: exercita a normalizacao de fuso do ACL.
  return new Date(T0 + offsetMs).toISOString().replace('Z', '');
}

function ev(
  at: number,
  event_type: string,
  buyer_id: string,
  extra: Omit<Partial<SimEvent>, 'event_type' | 'buyer_id' | 'timestamp'> = {},
): SimEvent {
  return { event_type, buyer_id, timestamp: ts(at), ...extra };
}

// ---------------------------------------------------------------------------
// Cenario 1 — comprador legitimo
// ---------------------------------------------------------------------------

function cenarioLegitimo(): Cenario {
  const buyer = `ana.${RUN}`;
  const ctx = {
    show_id: `show-classico.${RUN}`,
    device_fingerprint: `dev-ana.${RUN}`,
    ip_address: `198.51.100.11`,
    payment_hash: `card-ana.${RUN}`,
  };

  return {
    id: 'C1',
    nome: 'Comprador legitimo',
    descricao: 'Uma pessoa: entra na fila, abre o mapa tres vezes, escolhe e compra',
    prova: 'o caso base nao gera evidencia nenhuma — score zero, sem falso positivo',
    esperado: { status: 'CLEAR', scoreMin: 0, scoreMax: 20 },
    eventos: [
      ev(0, 'QUEUE_JOIN', buyer, ctx),
      ev(1_200, 'QUEUE_ADMITTED', buyer, ctx),
      ev(2_500, 'SEATMAP_VIEW', buyer, ctx),
      ev(5_000, 'SEATMAP_VIEW', buyer, ctx),
      ev(8_200, 'SEATMAP_VIEW', buyer, ctx),
      ev(11_000, 'CHECKOUT_ATTEMPT', buyer, { ...ctx, seat_id: 'PLATEIA-12' }),
      ev(13_500, 'PURCHASE_CONFIRMED', buyer, { ...ctx, seat_id: 'PLATEIA-12' }),
    ],
  };
}

// ---------------------------------------------------------------------------
// Cenario 2 — bot solitario
// ---------------------------------------------------------------------------

/**
 * Uma conta so, um dispositivo so, um IP so. Estruturalmente invisivel para os
 * dois fatores contextuais: nao ha com quem correlacionar.
 *
 * E o cenario que justifica os pesos. Se o modelo exigisse tres ou quatro
 * fatores para chegar a 70, um bot solitario passaria sempre — bastaria ao
 * cambista nao repetir dispositivo. Aqui, dois fatores comportamentais no
 * maximo somam 38 + 37 = 75, e isso basta.
 */
function cenarioBot(): Cenario {
  const buyer = `bot.${RUN}`;
  const ctx = {
    show_id: `show-rock.${RUN}`,
    device_fingerprint: `dev-bot.${RUN}`,
    ip_address: `198.51.100.22`,
    payment_hash: `card-bot.${RUN}`,
  };

  const eventos: SimEvent[] = [
    ev(0, 'QUEUE_JOIN', buyer, ctx),
    ev(300, 'QUEUE_ADMITTED', buyer, ctx),
  ];

  // Cadencia de metronomo: 300 ms exatos entre tentativas, e nenhuma leitura do
  // mapa. Ninguem escolhe um assento sem ver quais estao livres.
  for (let i = 0; i < 14; i++) {
    eventos.push(
      ev(600 + i * 300, 'CHECKOUT_ATTEMPT', buyer, { ...ctx, seat_id: `PISTA-${i + 1}` }),
    );
  }

  return {
    id: 'C2',
    nome: 'Bot solitario',
    descricao: '14 tentativas a cada 300 ms exatos, nenhuma leitura do mapa',
    prova: 'comportamento sozinho quarentena: nao e preciso haver quadrilha',
    esperado: { status: 'QUARANTINED', scoreMin: 70, scoreMax: 85 },
    eventos,
  };
}

// ---------------------------------------------------------------------------
// Cenario 3 — fazenda de contas
// ---------------------------------------------------------------------------

function cenarioFazenda(): Cenario {
  const show = `show-pop.${RUN}`;
  const device = `dev-fazenda.${RUN}`;
  const ip = '198.51.100.33';
  const eventos: SimEvent[] = [];

  for (let i = 0; i < 20; i++) {
    const buyer = `mula-${String(i).padStart(2, '0')}.${RUN}`;
    // Tres cartoes girando entre vinte contas.
    const ctx = {
      show_id: show,
      device_fingerprint: device,
      ip_address: ip,
      payment_hash: `card-fazenda-${i % 3}.${RUN}`,
    };
    // Instantes IDENTICOS entre as contas: e assim que um script dispara.
    eventos.push(
      ev(0, 'QUEUE_JOIN', buyer, ctx),
      ev(200, 'QUEUE_ADMITTED', buyer, ctx),
      ev(260, 'CHECKOUT_ATTEMPT', buyer, { ...ctx, seat_id: `CAMAROTE-${i + 1}` }),
      ev(330, 'PURCHASE_CONFIRMED', buyer, { ...ctx, seat_id: `CAMAROTE-${i + 1}` }),
    );
  }

  return {
    id: 'C3',
    nome: 'Fazenda de contas',
    descricao: '20 contas, um dispositivo, um IP, tres cartoes — todas disparando juntas',
    prova: 'os quatro fatores acendem ao mesmo tempo e o score satura em 100',
    esperado: { status: 'QUARANTINED', scoreMin: 90, scoreMax: 100 },
    eventos,
  };
}

// ---------------------------------------------------------------------------
// Cenario 4 — conluio distribuido
// ---------------------------------------------------------------------------

/**
 * A quadrilha que fez o dever de casa: cada conta tem dispositivo proprio e IP
 * proprio, entao os dois fatores de identidade nao acendem. O que ela nao
 * conseguiu esconder foi o comportamento e a simultaneidade.
 *
 * A diferenca para o bot solitario e exatamente o fator de coordenacao: 12
 * contas levando assentos do mesmo setor em 30 segundos valem 24,5 pontos, e e
 * o que separa 75 de ~92.
 */
function cenarioConluio(): Cenario {
  const show = `show-festival.${RUN}`;
  const eventos: SimEvent[] = [];

  for (let i = 0; i < 12; i++) {
    const buyer = `conluio-${String(i).padStart(2, '0')}.${RUN}`;
    const ctx = {
      show_id: show,
      // Proxy residencial e fingerprint proprio por conta: evasao deliberada.
      device_fingerprint: `dev-conluio-${i}.${RUN}`,
      ip_address: `203.0.113.${10 + i}`,
      payment_hash: `card-conluio-${i}.${RUN}`,
    };
    eventos.push(
      ev(0, 'QUEUE_JOIN', buyer, ctx),
      ev(250, 'QUEUE_ADMITTED', buyer, ctx),
      ev(340, 'CHECKOUT_ATTEMPT', buyer, { ...ctx, seat_id: `MEZANINO-${i + 1}` }),
      ev(410, 'PURCHASE_CONFIRMED', buyer, { ...ctx, seat_id: `MEZANINO-${i + 1}` }),
    );
  }

  return {
    id: 'C4',
    nome: 'Conluio distribuido',
    descricao: '12 contas, cada uma com dispositivo e IP proprios, mesmo setor em segundos',
    prova: 'evadir dispositivo e IP nao adianta: sobra comportamento e simultaneidade',
    esperado: { status: 'QUARANTINED', scoreMin: 80, scoreMax: 100 },
    eventos,
  };
}

// ---------------------------------------------------------------------------
// Cenario 5 — rotacao de fingerprint sem automacao
// ---------------------------------------------------------------------------

/**
 * Falso positivo classico, e o mais dificil dos dois.
 *
 * Uma conta aparecendo em 15 dispositivos distintos e um sinal forte — o fator
 * de dispositivo satura em severidade 1. Mas navegadores com protecao contra
 * rastreamento randomizam fingerprint a cada aba, e uma rede corporativa faz o
 * mesmo efeito. O comportamento e humano: le o mapa, hesita, compra devagar.
 *
 * Um fator no maximo vale 35 pontos, metade do limiar. E de proposito: acusar
 * por associacao sozinha e como o antifraude vira um gerador de prejuizo.
 */
function cenarioFingerprintRotativo(): Cenario {
  const buyer = `lia.${RUN}`;
  const show = `show-teatro.${RUN}`;
  const ip = '198.51.100.55';
  const pagamento = `card-lia.${RUN}`;
  const eventos: SimEvent[] = [];

  // Navegacao humana: intervalos irregulares, de 400 ms a 3,3 s. A regra de
  // cadencia so acusa abaixo de 5% de variacao relativa.
  const intervalos = [1700, 400, 2600, 900, 3100, 500, 1400, 2900, 600, 2200, 800, 3300, 1100, 1900];
  let t = 0;
  for (let k = 0; k < 15; k++) {
    eventos.push(
      ev(t, 'SEATMAP_VIEW', buyer, {
        show_id: show,
        // Um fingerprint diferente por aba.
        device_fingerprint: `dev-lia-${String(k).padStart(2, '0')}.${RUN}`,
        ip_address: ip,
      }),
    );
    if (k < intervalos.length) t += intervalos[k];
  }

  // Compra seis lugares, em dois setores, com folga entre cada um.
  const ultimoDevice = `dev-lia-14.${RUN}`;
  const setores = ['FRISA', 'FRISA', 'FRISA', 'BALCAO', 'BALCAO', 'BALCAO'];
  let tc = t + 1_500;
  for (let j = 0; j < 6; j++) {
    const ctx = {
      show_id: show,
      device_fingerprint: ultimoDevice,
      ip_address: ip,
      payment_hash: pagamento,
      seat_id: `${setores[j]}-${j + 1}`,
    };
    eventos.push(ev(tc, 'CHECKOUT_ATTEMPT', buyer, ctx));
    eventos.push(ev(tc + 600, 'PURCHASE_CONFIRMED', buyer, ctx));
    tc += 2_500;
  }

  return {
    id: 'C5',
    nome: 'Rotacao de fingerprint (legitimo)',
    descricao: '1 conta em 15 dispositivos, mas lendo o mapa e comprando em ritmo humano',
    prova: 'um unico fator no maximo nao chega ao limiar: associacao sozinha nao acusa',
    esperado: { status: 'CLEAR', scoreMin: 25, scoreMax: 60 },
    eventos,
  };
}

// ---------------------------------------------------------------------------
// Cenario 6 — familia
// ---------------------------------------------------------------------------

/**
 * O falso positivo que quebra antifraude ingenuo: quatro contas no mesmo
 * notebook, no mesmo Wi-Fi, pagando com o mesmo cartao, comprando seis lugares
 * juntos.
 *
 * Note que a protecao aqui NAO vem dos pesos, e sim dos pisos das regras: 3
 * contas por dispositivo e 4 por IP sao tratadas como normais porque famililas
 * existem. O cartao compartilhado por 4 contas passa do piso (2) e pontua — o
 * sistema nota, registra a evidencia com a explicacao, e nao age. Que e
 * exatamente o comportamento desejado: visivel para um humano decidir, sem
 * bloquear ninguem sozinho.
 */
function cenarioFamilia(): Cenario {
  const show = `show-infantil.${RUN}`;
  const ctx = {
    show_id: show,
    device_fingerprint: `dev-familia.${RUN}`,
    ip_address: '198.51.100.66',
    payment_hash: `card-familia.${RUN}`,
  };

  const membros: { nome: string; inicio: number; assentos: number[] }[] = [
    { nome: 'pai', inicio: 0, assentos: [1, 2] },
    { nome: 'mae', inicio: 2_000, assentos: [3, 4] },
    { nome: 'filha', inicio: 6_000, assentos: [5] },
    { nome: 'filho', inicio: 8_000, assentos: [6] },
  ];

  const eventos: SimEvent[] = [];
  for (const m of membros) {
    const buyer = `${m.nome}.${RUN}`;
    eventos.push(
      ev(m.inicio, 'QUEUE_JOIN', buyer, ctx),
      ev(m.inicio + 1_500, 'QUEUE_ADMITTED', buyer, ctx),
      ev(m.inicio + 3_000, 'SEATMAP_VIEW', buyer, ctx),
      ev(m.inicio + 5_500, 'SEATMAP_VIEW', buyer, ctx),
    );
    let t = m.inicio + 8_000;
    for (const assento of m.assentos) {
      const comAssento = { ...ctx, seat_id: `TERRACO-${assento}` };
      eventos.push(ev(t, 'CHECKOUT_ATTEMPT', buyer, comAssento));
      eventos.push(ev(t + 1_200, 'PURCHASE_CONFIRMED', buyer, comAssento));
      t += 2_500;
    }
  }

  return {
    id: 'C6',
    nome: 'Familia (legitimo)',
    descricao: '4 contas, mesmo notebook, mesmo Wi-Fi, mesmo cartao, 6 lugares juntos',
    prova: 'o sistema nota, pontua e explica — mas nao bloqueia ninguem',
    esperado: { status: 'CLEAR', scoreMin: 5, scoreMax: 50 },
    eventos,
  };
}

// ---------------------------------------------------------------------------
// Execucao
// ---------------------------------------------------------------------------

async function enviar(eventos: SimEvent[]): Promise<void> {
  const res = await fetch(`${urls.riskEventApi}/events/batch`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ events: eventos }),
    signal: AbortSignal.timeout(30_000),
  });
  if (res.status !== 202) {
    throw new Error(`event api respondeu ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as { accepted: number; rejected: unknown[] };
  if (body.accepted !== eventos.length) {
    throw new Error(
      `event api aceitou ${body.accepted} de ${eventos.length}: ${JSON.stringify(body.rejected)}`,
    );
  }
}

async function status(buyerId: string): Promise<BuyerRisk> {
  const res = await fetch(`${urls.riskApi}/risk/status/${encodeURIComponent(buyerId)}`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`risk api respondeu ${res.status} para ${buyerId}`);
  return (await res.json()) as BuyerRisk;
}

/**
 * Barreira: espera o worker terminar de processar tudo o que ja foi enviado.
 *
 * Sem isso a asercao mediria a corrida entre o teste e o consumidor, e nao o
 * antifraude — o erro classico de testar sistema assincrono.
 */
async function aguardarProcessamento(
  esperado: Map<string, number>,
  estagnacaoMs = 45_000,
): Promise<void> {
  let faltando: string[] = [];
  let processados = -1;
  let ultimoProgresso = Date.now();

  // O criterio de desistencia e ESTAGNACAO, e nao tempo total.
  //
  // Um prazo fixo confunde "o worker travou" com "o worker esta ocupado", e as
  // duas coisas exigem reacoes opostas. Rodar os cenarios logo depois de uma
  // bateria de carga deixa dezenas de milhares de eventos na fila; o worker
  // consome tudo em ordem e chega nos nossos — so demora. Com prazo fixo, o
  // primeiro cenario falhava e os cinco seguintes passavam, o que e o retrato
  // de um teste medindo a fila em vez do antifraude.
  for (;;) {
    const atual = await Promise.all(
      [...esperado.keys()].map(async (b) => ({ buyer: b, risk: await status(b) })),
    );

    const vistos = atual.reduce((soma, { risk }) => soma + risk.eventsSeen, 0);
    if (vistos > processados) {
      processados = vistos;
      ultimoProgresso = Date.now();
    }

    faltando = atual
      .filter(({ buyer, risk }) => risk.eventsSeen < (esperado.get(buyer) ?? 0))
      .map(({ buyer, risk }) => `${buyer} (${risk.eventsSeen}/${esperado.get(buyer)})`);
    if (faltando.length === 0) return;

    if (Date.now() - ultimoProgresso > estagnacaoMs) {
      throw new Error(
        `worker parou de progredir por ${estagnacaoMs / 1000}s: ${faltando.join(', ')}`,
      );
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function contarPorComprador(eventos: SimEvent[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of eventos) m.set(e.buyer_id, (m.get(e.buyer_id) ?? 0) + 1);
  return m;
}

interface Resultado {
  cenario: Cenario;
  ok: boolean;
  compradores: BuyerRisk[];
  falhas: string[];
}

async function rodar(cenario: Cenario): Promise<Resultado> {
  // Onda 2 = o ultimo evento de cada comprador. Onda 1 = todo o resto.
  const ultimoIndice = new Map<string, number>();
  cenario.eventos.forEach((e, i) => ultimoIndice.set(e.buyer_id, i));
  const decisivos = new Set(ultimoIndice.values());

  const onda1 = cenario.eventos.filter((_, i) => !decisivos.has(i));
  const onda2 = cenario.eventos.filter((_, i) => decisivos.has(i));

  const totais = contarPorComprador(cenario.eventos);

  await enviar(onda1);
  await aguardarProcessamento(contarPorComprador(onda1));
  await enviar(onda2);
  await aguardarProcessamento(totais);

  const compradores = await Promise.all([...totais.keys()].map((b) => status(b)));
  compradores.sort((a, b) => b.score - a.score);

  const falhas: string[] = [];
  const fora = compradores.filter((c) => c.status !== cenario.esperado.status);
  if (fora.length > 0) {
    falhas.push(
      `esperado ${cenario.esperado.status} para os ${compradores.length} compradores, mas ` +
        fora.map((c) => `${c.buyerId}=${c.status} (score ${c.score})`).join(', '),
    );
  }

  const maior = compradores[0]?.score ?? 0;
  if (maior < cenario.esperado.scoreMin || maior > cenario.esperado.scoreMax) {
    falhas.push(
      `maior score ${maior} fora da faixa esperada ` +
        `[${cenario.esperado.scoreMin}, ${cenario.esperado.scoreMax}]`,
    );
  }

  return { cenario, ok: falhas.length === 0, compradores, falhas };
}

/**
 * Mensagem envenenada: prova o *parking lot* do consumidor.
 *
 * A camada de anticorrupcao recusa contrato invalido na borda, com 400 — entao
 * um evento malformado enviado pela API nunca chega ao topico. Para exercitar a
 * dead letter e preciso escrever direto no barramento, como faria um produtor
 * mal comportado ou uma versao antiga de outro servico.
 *
 * O que se quer ver: a mensagem sai da fila principal (nao trava a particao),
 * fica registrada para inspecao no painel, e o consumo continua.
 */
async function verificarDeadLetter(): Promise<{ ok: boolean; detalhe: string }> {
  const kafka = new Kafka({
    clientId: 'simulador',
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(',').filter(Boolean),
    logLevel: logLevel.NOTHING,
  });

  const antes = await fetch(`${urls.riskApi}/risk/dead-letters`).then((r) => r.json());
  const qtdeAntes = (antes as { deadLetters: unknown[] }).deadLetters.length;

  const marca = `veneno-${RUN}`;
  const producer = kafka.producer();
  await producer.connect();
  await producer.send({
    topic: 'risk.events',
    messages: [{ key: marca, value: `{ isto nao e json valido — ${marca}` }],
  });
  await producer.disconnect();

  // O consumo tem de continuar: um evento valido enviado logo depois precisa
  // ser processado normalmente. Se a particao travasse, ele nunca chegaria.
  const canario = `canario.${RUN}`;
  await enviar([ev(0, 'QUEUE_JOIN', canario, { show_id: `canario.${RUN}` })]);

  const limite = Date.now() + 30_000;
  let achou = false;
  let canarioOk = false;
  while (Date.now() < limite && !(achou && canarioOk)) {
    const dlq = (await fetch(`${urls.riskApi}/risk/dead-letters`).then((r) => r.json())) as {
      deadLetters: { payload: string; reason: string }[];
    };
    achou = dlq.deadLetters.some((d) => d.payload.includes(marca));
    canarioOk = (await status(canario)).eventsSeen >= 1;
    if (achou && canarioOk) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  if (!achou) return { ok: false, detalhe: `a mensagem envenenada nao chegou a dead letter (${qtdeAntes} antes)` };
  if (!canarioOk) return { ok: false, detalhe: 'o consumo travou: o evento seguinte nao foi processado' };
  return { ok: true, detalhe: 'veneno estacionado na dead letter e o consumo seguiu sem travar' };
}

async function main(): Promise<void> {
  console.log('\n  SIMULADOR DE CENARIOS — Risk-Shield');
  console.log('  ' + '='.repeat(76));
  console.log(`  execucao ${RUN}\n`);

  await waitFor(`${urls.riskEventApi}/health`, 'risk-event-api');
  await waitFor(`${urls.riskApi}/health`, 'risk-api');
  await waitFor(`${urls.riskWorker}/health`, 'risk-worker');

  const cenarios = [
    cenarioLegitimo(),
    cenarioBot(),
    cenarioFazenda(),
    cenarioConluio(),
    cenarioFingerprintRotativo(),
    cenarioFamilia(),
  ];

  const resultados: Resultado[] = [];

  for (const cenario of cenarios) {
    const compradores = new Set(cenario.eventos.map((e) => e.buyer_id)).size;
    console.log(`  ${cenario.id}  ${cenario.nome}`);
    console.log(`      ${cenario.descricao}`);
    console.log(
      `      ${cenario.eventos.length} eventos, ${compradores} comprador(es); ` +
        `esperado ${cenario.esperado.status} ` +
        `com score entre ${cenario.esperado.scoreMin} e ${cenario.esperado.scoreMax}`,
    );

    let resultado: Resultado;
    try {
      resultado = await rodar(cenario);
    } catch (err) {
      resultado = {
        cenario,
        ok: false,
        compradores: [],
        falhas: [err instanceof Error ? err.message : String(err)],
      };
    }
    resultados.push(resultado);

    const topo = resultado.compradores[0];
    if (topo) {
      console.log(
        `      -> maior score ${topo.score.toFixed(1)} (${topo.buyerId}), ` +
          `${resultado.compradores.filter((c) => c.status === 'QUARANTINED').length}` +
          `/${resultado.compradores.length} em quarentena`,
      );
      for (const f of topo.topFactors) {
        console.log(`         ${f.points.toFixed(1).padStart(5)} pts  ${f.factor}: ${f.explanation}`);
      }
      if (topo.topFactors.length === 0) {
        console.log('         nenhuma evidencia registrada');
      }
    }

    if (resultado.ok) {
      console.log(`      OK    ${cenario.prova}\n`);
    } else {
      for (const f of resultado.falhas) console.log(`      FALHA ${f}`);
      console.log('');
    }
  }

  // -------------------------------------------------------------------------
  console.log('  D1  Mensagem envenenada no barramento');
  console.log('      JSON invalido escrito direto no topico, contornando a validacao da borda');
  const dlq = await verificarDeadLetter();
  console.log(`      ${dlq.ok ? 'OK   ' : 'FALHA'} ${dlq.detalhe}\n`);

  console.log('  ' + '='.repeat(76));
  const passou = resultados.filter((r) => r.ok).length;
  for (const r of resultados) {
    const maior = r.compradores[0]?.score ?? 0;
    console.log(
      `  ${r.ok ? 'OK   ' : 'FALHA'} ${r.cenario.id}  ${r.cenario.nome.padEnd(34)} ` +
        `score ${maior.toFixed(1).padStart(5)}  ${r.compradores[0]?.status ?? '-'}`,
    );
  }
  console.log(
    `  ${dlq.ok ? 'OK   ' : 'FALHA'} D1  ${'Mensagem envenenada -> dead letter'.padEnd(34)} ` +
      'parking lot',
  );
  console.log(`\n  ${passou}/${resultados.length} cenarios conforme o esperado\n`);

  if (passou !== resultados.length || !dlq.ok) process.exit(1);
}

main().catch((err) => {
  console.error('\n  simulador falhou:', err instanceof Error ? err.message : err, '\n');
  process.exit(1);
});
