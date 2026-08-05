/**
 * Formatador de sumario do k6, local.
 *
 * A biblioteca oficial vive em jslib.k6.io e seria baixada a cada execucao.
 * Manter isto no repositorio significa que `make load` funciona sem internet —
 * e util para quem roda a demo em rede restrita, e remove uma dependencia
 * externa do caminho de um teste que precisa ser reproduzivel.
 */

function fmtNumber(value) {
  if (value === undefined || value === null || Number.isNaN(value)) return '-';
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

function fmtDuration(ms) {
  if (ms === undefined || ms === null || Number.isNaN(ms)) return '-';
  if (ms < 1000) return `${ms.toFixed(1)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function isDuration(name) {
  return name.includes('duration') || name.endsWith('_ms') || name.includes('waiting');
}

export function textSummary(data, options = {}) {
  const indent = options.indent ?? '  ';
  const lines = [];
  const metrics = data.metrics ?? {};

  lines.push('');
  lines.push(`${indent}RESULTADO DA CARGA`);
  lines.push(`${indent}${'='.repeat(72)}`);

  // --- Contadores de negocio -------------------------------------------------
  const contadores = Object.keys(metrics)
    .filter((name) => metrics[name].type === 'counter' && !name.startsWith('http_') && !name.startsWith('data_'))
    .sort();

  if (contadores.length > 0) {
    lines.push('');
    lines.push(`${indent}Negocio`);
    for (const name of contadores) {
      const v = metrics[name].values ?? {};
      lines.push(`${indent}  ${name.padEnd(28)} ${fmtNumber(v.count)}`);
    }
  }

  // --- Taxas -----------------------------------------------------------------
  const taxas = Object.keys(metrics)
    .filter((name) => metrics[name].type === 'rate')
    .sort();

  if (taxas.length > 0) {
    lines.push('');
    lines.push(`${indent}Taxas`);
    for (const name of taxas) {
      const v = metrics[name].values ?? {};
      const pct = (v.rate ?? 0) * 100;
      lines.push(`${indent}  ${name.padEnd(28)} ${pct.toFixed(2)}%  (${v.passes ?? 0} de ${(v.passes ?? 0) + (v.fails ?? 0)})`);
    }
  }

  // --- Latencias -------------------------------------------------------------
  const trends = Object.keys(metrics)
    .filter((name) => metrics[name].type === 'trend')
    .sort();

  if (trends.length > 0) {
    lines.push('');
    lines.push(`${indent}Latencias`);
    lines.push(
      `${indent}  ${'metrica'.padEnd(32)} ${'med'.padStart(9)} ${'p95'.padStart(9)} ${'p99'.padStart(9)} ${'max'.padStart(9)}`,
    );
    for (const name of trends) {
      const v = metrics[name].values ?? {};
      const dur = isDuration(name);
      const f = dur ? fmtDuration : fmtNumber;
      lines.push(
        `${indent}  ${name.slice(0, 32).padEnd(32)} ${f(v.med).padStart(9)} ${f(v['p(95)']).padStart(9)} ${f(v['p(99)']).padStart(9)} ${f(v.max).padStart(9)}`,
      );
    }
  }

  // --- Volume ----------------------------------------------------------------
  const reqs = metrics.http_reqs?.values ?? {};
  const falhas = metrics.http_req_failed?.values ?? {};
  lines.push('');
  lines.push(`${indent}Volume`);
  lines.push(`${indent}  requisicoes                  ${fmtNumber(reqs.count)}`);
  lines.push(`${indent}  vazao                        ${fmtNumber(reqs.rate)} req/s`);
  lines.push(`${indent}  taxa de erro HTTP            ${((falhas.rate ?? 0) * 100).toFixed(2)}%`);

  // --- Limiares --------------------------------------------------------------
  const comLimiar = Object.keys(metrics).filter(
    (name) => metrics[name].thresholds && Object.keys(metrics[name].thresholds).length > 0,
  );
  if (comLimiar.length > 0) {
    lines.push('');
    lines.push(`${indent}Limiares`);
    for (const name of comLimiar) {
      for (const [expr, result] of Object.entries(metrics[name].thresholds)) {
        const passou = result.ok !== false;
        lines.push(`${indent}  ${passou ? 'OK   ' : 'FALHA'} ${name} ${expr}`);
      }
    }
  }

  lines.push('');
  return lines.join('\n');
}
