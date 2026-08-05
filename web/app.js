/* Interface da Bilheteria.
 *
 * HTML e JavaScript estaticos, sem framework nem passo de build. A demonstracao
 * funcional vale 20% da nota e precisa mostrar o mapa atualizando ao vivo; nada
 * disso exige React.
 */

const $ = (id) => document.getElementById(id);
const state = { token: null, userId: null, queueToken: null, admission: null, eventId: null, socket: null };

function log(message, kind = '') {
  const el = document.createElement('div');
  const time = new Date().toLocaleTimeString('pt-BR');
  el.innerHTML = `<span class="pill ${kind}">${time}</span> ${message}`;
  $('log').prepend(el);
  while ($('log').children.length > 60) $('log').lastChild.remove();
}

function pill(el, text, kind = '') {
  el.className = `pill ${kind}`;
  el.textContent = text;
}

async function api(path, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  if (state.token) headers.authorization = `Bearer ${state.token}`;
  const res = await fetch(path, { ...options, headers });
  const text = await res.text();
  let body = text;
  try { body = text ? JSON.parse(text) : null; } catch { /* texto cru */ }
  return { status: res.status, ok: res.ok, body };
}

// --------------------------------------------------------------------------
// Catalogo e mapa
// --------------------------------------------------------------------------

async function loadEvents() {
  const res = await api('/api/events');
  if (!res.ok) return log('falha ao carregar eventos', 'bad');
  const select = $('eventId');
  select.innerHTML = '';
  for (const ev of res.body.events) {
    const option = document.createElement('option');
    option.value = ev.eventId;
    option.textContent = `${ev.name} — ${ev.venue}`;
    select.appendChild(option);
  }
  state.eventId = res.body.events[0]?.eventId ?? null;
  select.value = state.eventId;
  await refreshMap();
  connectRealtime();
}

let seatIndex = new Map();

async function refreshMap() {
  if (!state.eventId) return;
  // Um setor por vez: 40.000 quadradinhos na tela nao ajudam ninguem a
  // entender nada, e o ponto e ver o estado mudando ao vivo.
  const res = await api(`/api/events/${state.eventId}/seatmap?section=CAMAROTE`);
  if (!res.ok) return;
  const { seats, stats } = res.body;
  $('statAvailable').textContent = (stats.available ?? 0).toLocaleString('pt-BR');
  $('statHeld').textContent = (stats.held ?? 0).toLocaleString('pt-BR');
  $('statSold').textContent = (stats.sold ?? 0).toLocaleString('pt-BR');
  $('mapNote').textContent = `mostrando o setor CAMAROTE (${seats.length} lugares) — os contadores são do evento inteiro`;

  const map = $('seatmap');
  map.innerHTML = '';
  seatIndex = new Map();
  for (const seat of seats) {
    const el = document.createElement('div');
    el.className = `seat ${seat.status}`;
    el.title = `${seat.seatId} — ${seat.status}`;
    map.appendChild(el);
    seatIndex.set(seat.seatId, el);
  }
}

function connectRealtime() {
  if (state.socket) state.socket.close();
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  // O realtime tem porta propria: e um servico separado justamente porque o
  // perfil de escala dele (conexoes longas) e diferente do resto.
  const url = `${proto}://${location.hostname}:3005/ws?eventId=${encodeURIComponent(state.eventId)}`;
  const socket = new WebSocket(url);
  state.socket = socket;

  socket.onopen = () => { $('wsState').textContent = 'ligado'; $('wsState').className = 'ok'; };
  socket.onclose = () => {
    $('wsState').textContent = 'caiu'; $('wsState').className = 'bad';
    setTimeout(connectRealtime, 3000);
  };
  socket.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type !== 'seat') return;
    const el = seatIndex.get(msg.seatId);
    if (el) { el.className = `seat ${msg.status}`; el.title = `${msg.seatId} — ${msg.status}`; }
    const kind = msg.status === 'SOLD' ? 'bad' : msg.status === 'HELD' ? 'warn' : 'ok';
    log(`${msg.seatId} → ${msg.status}${msg.reason ? ` (${msg.reason})` : ''}`, kind);
  };
}

// --------------------------------------------------------------------------
// Fluxo do comprador
// --------------------------------------------------------------------------

$('btnLogin').onclick = async () => {
  const userId = $('userId').value.trim();
  if (!userId) return;
  const res = await api('/api/auth/token', { method: 'POST', body: JSON.stringify({ userId }) });
  if (!res.ok) return pill($('authState'), 'falhou', 'bad');
  state.token = res.body.token;
  state.userId = userId;
  pill($('authState'), `${userId} autenticado`, 'ok');
  log(`token JWT emitido para ${userId}`, 'ok');
};

$('eventId').onchange = async (e) => {
  state.eventId = e.target.value;
  state.queueToken = null; state.admission = null;
  pill($('queueState'), 'fora da fila');
  $('btnBuy').disabled = true;
  await refreshMap();
  connectRealtime();
};

$('btnQueue').onclick = async () => {
  const res = await api('/api/queue/join', {
    method: 'POST',
    body: JSON.stringify({ eventId: state.eventId }),
  });
  if (!res.ok) return pill($('queueState'), 'falhou', 'bad');

  if (res.body.disabled) {
    state.admission = null;
    pill($('queueState'), 'fila desligada por flag', 'warn');
    $('btnBuy').disabled = !state.token;
    log('fila virtual desligada: o checkout vai direto ao núcleo', 'warn');
    return;
  }

  state.queueToken = res.body.queueToken;
  log(`entrou na fila na posição ${res.body.position}`, 'warn');
  pollQueue();
};

async function pollQueue() {
  if (!state.queueToken) return;
  const res = await api(
    `/api/queue/status?eventId=${encodeURIComponent(state.eventId)}&token=${state.queueToken}`,
  );
  if (!res.ok) return;

  if (res.body.admitted) {
    state.admission = res.body.admissionToken;
    pill($('queueState'), 'admitido', 'ok');
    $('btnBuy').disabled = !state.token;
    log('sua vez chegou: token de admissão recebido', 'ok');
    return;
  }
  pill($('queueState'), `posição ${res.body.position} · ~${res.body.estimatedWaitSeconds}s`, 'warn');
  setTimeout(pollQueue, 700);
}

$('btnBuy').onclick = async () => {
  const btn = $('btnBuy');
  btn.disabled = true;
  pill($('buyState'), 'comprando...', 'warn');

  try {
    let seatId = $('seatId').value.trim();
    if (!seatId) {
      const pick = await api(`/api/events/${state.eventId}/available-seat?section=CAMAROTE`);
      if (!pick.ok) { pill($('buyState'), 'setor esgotado', 'bad'); return; }
      seatId = pick.body.seatId;
    }

    const headers = { 'idempotency-key': crypto.randomUUID() };
    if (state.admission) headers['x-admission-token'] = state.admission;

    const res = await api('/api/orders', {
      method: 'POST',
      headers,
      body: JSON.stringify({ eventId: state.eventId, seatId }),
    });

    if (!res.ok) {
      pill($('buyState'), `erro ${res.status}`, 'bad');
      log(`compra recusada (${res.status}): ${JSON.stringify(res.body)}`, 'bad');
      return;
    }

    const order = res.body;
    if (order.status !== 'CONFIRMED') {
      pill($('buyState'), order.status, 'bad');
      log(`pedido terminou em ${order.status}: ${order.failureReason ?? ''}`, 'bad');
    } else {
      pill($('buyState'), 'confirmado', 'ok');
      log(`ingresso emitido para o assento ${order.seatId}`, 'ok');
    }

    renderTicket(order);
    await showSaga(order.orderId);
    // O token de admissao vale uma compra: volta para a fila para comprar de novo.
    state.admission = null;
    if (!$('queueState').textContent.includes('desligada')) {
      pill($('queueState'), 'use a fila novamente', 'warn');
    }
  } finally {
    btn.disabled = !state.token;
  }
};

function renderTicket(order) {
  const box = $('ticket');
  if (!order.ticket) {
    box.innerHTML = `<p class="sub">Pedido <code>${order.orderId.slice(0, 8)}</code> terminou em <b>${order.status}</b>.</p>`;
    return;
  }
  box.innerHTML = `
    <div class="stat"><span>assento<b>${order.seatId}</b></span>
    <span>situação<b class="ok">${order.ticket.status}</b></span></div>
    <label style="margin-top:.75rem">QR assinado (Ed25519)</label>
    <pre style="max-height:110px">${order.ticket.qrCode}</pre>
    <button class="ghost" id="btnUseQr">Usar este QR na portaria</button>`;
  $('btnUseQr').onclick = () => { $('qr').value = order.ticket.qrCode; };
}

async function showSaga(orderId) {
  const res = await api(`/api/orders/${orderId}/saga`);
  if (!res.ok) return;
  const lines = res.body.steps.map(
    (s) => `${s.at.slice(11, 23)}  ${s.step.padEnd(22)} ${s.outcome}${s.detail ? '  — ' + s.detail : ''}`,
  );
  $('saga').textContent = lines.length ? lines.join('\n') : 'sem passos registrados';
}

$('btnCheckin').onclick = async () => {
  const qrCode = $('qr').value.trim();
  if (!qrCode) return;
  const res = await api('/api/checkin', { method: 'POST', body: JSON.stringify({ qrCode }) });
  if (res.ok) {
    pill($('checkinState'), 'entrada liberada', 'ok');
    log(`check-in aprovado para o assento ${res.body.seatId}`, 'ok');
  } else if (res.status === 409) {
    pill($('checkinState'), 'já utilizado', 'bad');
    log('check-in recusado: este ingresso já entrou', 'bad');
  } else {
    pill($('checkinState'), `recusado (${res.status})`, 'bad');
    log(`check-in recusado: ${JSON.stringify(res.body)}`, 'bad');
  }
};

// Recarrega os contadores periodicamente: o WebSocket cobre o mapa, mas as
// estatisticas do evento inteiro vem do read model.
setInterval(() => { refreshMap().catch(() => {}); }, 5000);
loadEvents().catch((err) => log(`falha ao iniciar: ${err}`, 'bad'));
