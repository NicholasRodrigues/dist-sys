/* Painel Administrativo do Risk-Shield.
 *
 * A tela que responde "por que este comprador foi marcado". Um antifraude que
 * so mostra um numero e uma caixa preta, e ninguem consegue decidir nada com
 * um numero — por isso as evidencias em texto ocupam o lugar de destaque.
 */

const $ = (id) => document.getElementById(id);
const EDGE = `http://${location.hostname}:8080`;

let selecionado = null;
let filtro = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: options.body ? { 'content-type': 'application/json' } : {},
  });
  const text = await res.text();
  try { return { status: res.status, body: text ? JSON.parse(text) : null }; }
  catch { return { status: res.status, body: text }; }
}

// --------------------------------------------------------------------------

async function carregarStats() {
  const { body } = await api('/risk/stats');
  if (!body) return;
  $('stCompradores').textContent = body.compradores;
  $('stQuarentena').textContent = body.quarentenados;
  $('stEventos').textContent = body.eventos.toLocaleString('pt-BR');
  $('stEvidencias').textContent = body.evidencias.toLocaleString('pt-BR');
  $('stScore').textContent = body.scoreMedio.toFixed(1);
  $('stDlq').textContent = body.deadLetters;
}

async function carregarConfig() {
  const { body } = await api('/risk/config');
  if (!body) return;

  $('regras').innerHTML = '';
  for (const rule of body.rules) {
    const el = document.createElement('div');
    el.className = 'rule-row';
    el.innerHTML = `
      <input type="checkbox" ${rule.enabled ? 'checked' : ''} data-rule="${rule.name}" />
      <span class="rule-name">${rule.name}</span>
      <input type="number" min="0" max="100" value="${rule.weight}" data-weight="${rule.name}" style="width:4rem" />
      <button class="ghost" data-save="${rule.name}">salvar</button>`;
    $('regras').appendChild(el);
  }

  $('regras').querySelectorAll('[data-save]').forEach((btn) => {
    btn.onclick = async () => {
      const name = btn.dataset.save;
      const enabled = $('regras').querySelector(`[data-rule="${name}"]`).checked;
      const weight = Number($('regras').querySelector(`[data-weight="${name}"]`).value);
      await api(`/risk/config/rules/${name}`, {
        method: 'POST',
        body: JSON.stringify({ enabled, weight }),
      });
      await recalcular();
    };
  });

  $('threshold').value = body.settings.quarantine_threshold ?? 70;
}

async function recalcular() {
  // O recalculo vive no worker, que e quem sabe derivar score de evidencia.
  await fetch(`http://${location.hostname}:3021/recalculate`, { method: 'POST' }).catch(() => {});
  await Promise.all([carregarStats(), carregarCompradores()]);
  if (selecionado) await carregarEvidencias(selecionado);
}

$('btnThreshold').onclick = async () => {
  await api('/risk/config/settings', {
    method: 'POST',
    body: JSON.stringify({ quarantine_threshold: Number($('threshold').value) }),
  });
  await carregarStats();
};

$('btnRecalc').onclick = recalcular;

// --------------------------------------------------------------------------

async function carregarModo() {
  try {
    const res = await fetch(`${EDGE}/api/admin/flags`);
    const flags = await res.json();
    const mode = flags.risk_check_mode ?? 'fail_open';
    $('riskMode').value = mode;
    const el = $('modeState');
    el.textContent = mode;
    el.className = `pill ${mode === 'fail_closed' ? 'bad' : mode === 'disabled' ? 'warn' : 'ok'}`;
  } catch {
    $('modeState').textContent = 'bilheteria fora do ar';
    $('modeState').className = 'pill bad';
  }
}

$('btnMode').onclick = async () => {
  await fetch(`${EDGE}/api/admin/flags`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ risk_check_mode: $('riskMode').value }),
  });
  await carregarModo();
};

// --------------------------------------------------------------------------

async function carregarCompradores() {
  const qs = filtro ? `?status=${filtro}&limit=100` : '?limit=100';
  const { body } = await api(`/risk/buyers${qs}`);
  const tbody = $('compradores');
  tbody.innerHTML = '';

  if (!body?.buyers?.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="empty">Nenhum comprador avaliado ainda.</td></tr>';
    return;
  }

  for (const b of body.buyers) {
    const tr = document.createElement('tr');
    const principal = b.topFactors[0];
    const cor = b.score >= 85 ? 'bad' : b.score >= 70 ? 'warn' : 'ok';
    tr.innerHTML = `
      <td class="mono">${b.buyerId}</td>
      <td class="mono ${cor}">${b.score.toFixed(1)}
        <div class="bar"><i style="width:${Math.min(b.score, 100)}%"></i></div></td>
      <td><span class="pill ${b.status === 'QUARANTINED' ? 'bad' : 'ok'}">${b.status}</span></td>
      <td>${principal ? principal.explanation : '<span class="empty">—</span>'}</td>
      <td class="mono">${b.eventsSeen}</td>
      <td>${b.status === 'QUARANTINED'
        ? `<button class="ghost" data-release="${b.buyerId}">liberar</button>`
        : `<button class="danger" data-quarantine="${b.buyerId}">quarentena</button>`}</td>`;
    tr.onclick = (ev) => {
      if (ev.target.tagName === 'BUTTON') return;
      selecionado = b.buyerId;
      carregarEvidencias(b.buyerId);
    };
    tbody.appendChild(tr);
  }

  tbody.querySelectorAll('[data-release]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      await api(`/risk/buyers/${btn.dataset.release}/release`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'revisado no painel', actor: 'administrador' }),
      });
      await Promise.all([carregarCompradores(), carregarStats()]);
    };
  });

  tbody.querySelectorAll('[data-quarantine]').forEach((btn) => {
    btn.onclick = async (ev) => {
      ev.stopPropagation();
      await api(`/risk/buyers/${btn.dataset.quarantine}/quarantine`, {
        method: 'POST',
        body: JSON.stringify({ reason: 'marcado manualmente', actor: 'administrador' }),
      });
      await Promise.all([carregarCompradores(), carregarStats()]);
    };
  });
}

$('fTodos').onclick = () => { filtro = null; carregarCompradores(); };
$('fQuarentena').onclick = () => { filtro = 'QUARANTINED'; carregarCompradores(); };

// --------------------------------------------------------------------------

async function carregarEvidencias(buyerId) {
  const [ev, hist] = await Promise.all([
    api(`/risk/buyers/${buyerId}/evidence`),
    api(`/risk/buyers/${buyerId}/history`),
  ]);

  const box = $('evidencias');
  box.innerHTML = `<p class="sub" style="margin-bottom:.75rem">
    <b class="mono">${buyerId}</b></p>`;

  if (!ev.body?.evidence?.length) {
    box.innerHTML += '<p class="empty">Nenhuma evidência registrada.</p>';
  } else {
    // Uma evidencia por fator: a mais recente e a avaliacao corrente daquele
    // fator. As anteriores ficam no historico, mas nao contam para o score.
    const vistos = new Set();
    for (const e of ev.body.evidence) {
      if (vistos.has(e.factor)) continue;
      vistos.add(e.factor);
      const el = document.createElement('div');
      el.className = 'evidence';
      el.innerHTML = `
        <div class="why">${e.explanation}</div>
        <div class="meta">${e.factor} &middot; severidade ${(e.severity * 100).toFixed(0)}%
          &times; peso ${e.weight} = <b>${e.points.toFixed(1)} pontos</b>
          &middot; correlation ${e.correlationId.slice(0, 12)}</div>`;
      box.appendChild(el);
    }
  }

  if (hist.body?.history?.length) {
    const h = document.createElement('div');
    h.style.marginTop = '.9rem';
    h.innerHTML = '<h2 style="font-size:.75rem">Histórico de quarentena</h2>';
    for (const item of hist.body.history) {
      const linha = document.createElement('div');
      linha.className = 'meta';
      linha.style.fontFamily = 'var(--mono)';
      linha.style.fontSize = '.7rem';
      linha.style.color = 'var(--muted)';
      linha.textContent = `${item.at.slice(0, 19).replace('T', ' ')}  ${item.action}  por ${item.actor}  — ${item.reason}`;
      h.appendChild(linha);
    }
    box.appendChild(h);
  }
}

// --------------------------------------------------------------------------

async function carregarDlq() {
  const { body } = await api('/risk/dead-letters');
  const box = $('dlq');
  if (!body?.deadLetters?.length) {
    box.innerHTML = '<p class="empty">Vazia — nenhuma mensagem falhou de forma persistente.</p>';
    return;
  }
  box.innerHTML = '';
  for (const d of body.deadLetters.slice(0, 10)) {
    const el = document.createElement('div');
    el.innerHTML = `<div class="meta" style="font-family:var(--mono);font-size:.7rem;color:var(--rose)">
        ${d.at.slice(0, 19).replace('T', ' ')} &middot; ${d.reason}</div>
      <pre>${d.payload.slice(0, 400)}</pre>`;
    box.appendChild(el);
  }
}

// --------------------------------------------------------------------------

async function atualizar() {
  await Promise.all([carregarStats(), carregarCompradores(), carregarDlq(), carregarModo()]);
}

carregarConfig().then(atualizar);
setInterval(atualizar, 4000);
