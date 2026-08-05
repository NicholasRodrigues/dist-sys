import { config } from './config.js';

const LEVELS: Record<string, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? 20;

function emit(level: string, msg: string, extra?: Record<string, unknown>): void {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    service: config.serviceName,
    msg,
    ...extra,
  };
  // Uma linha de JSON por evento: legivel por humano no `docker compose logs`
  // e parseavel por maquina sem precisar de agregador.
  process.stdout.write(JSON.stringify(line) + '\n');
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => emit('debug', msg, extra),
  info: (msg: string, extra?: Record<string, unknown>) => emit('info', msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => emit('warn', msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => emit('error', msg, extra),
};
