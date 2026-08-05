import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { config } from './config.js';

export const registry = new Registry();
registry.setDefaultLabels({ service: config.serviceName });
collectDefaultMetrics({ register: registry });

export const httpRequests = new Counter({
  name: 'http_requests_total',
  help: 'Requisicoes HTTP recebidas',
  labelNames: ['method', 'route', 'status'],
  registers: [registry],
});

export const httpDuration = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'Latencia das requisicoes HTTP',
  labelNames: ['method', 'route', 'status'],
  // Buckets escolhidos em torno das metas: p95 < 100ms na leitura, < 500ms no checkout.
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2, 5],
  registers: [registry],
});

export const inFlight = new Gauge({
  name: 'http_requests_in_flight',
  help: 'Requisicoes em voo, base do load shedding',
  registers: [registry],
});

export const businessEvents = new Counter({
  name: 'business_events_total',
  help: 'Eventos de negocio por tipo',
  labelNames: ['event'],
  registers: [registry],
});

export const sagaSteps = new Counter({
  name: 'saga_steps_total',
  help: 'Passos da SAGA por resultado',
  labelNames: ['step', 'outcome'],
  registers: [registry],
});

export const breakerState = new Gauge({
  name: 'circuit_breaker_state',
  help: 'Estado do circuit breaker: 0 fechado, 1 meio-aberto, 2 aberto',
  labelNames: ['target'],
  registers: [registry],
});

export const cacheOps = new Counter({
  name: 'cache_operations_total',
  help: 'Operacoes de cache por resultado',
  labelNames: ['result'],
  registers: [registry],
});

export const queueDepth = new Gauge({
  name: 'waiting_room_depth',
  help: 'Pessoas esperando na fila virtual',
  labelNames: ['event_id'],
  registers: [registry],
});

export const admissionsTotal = new Counter({
  name: 'waiting_room_admissions_total',
  help: 'Admissoes liberadas pela fila virtual',
  registers: [registry],
});

export const rateLimited = new Counter({
  name: 'rate_limited_total',
  help: 'Requisicoes barradas pelo rate limit',
  labelNames: ['scope'],
  registers: [registry],
});

export const loadShed = new Counter({
  name: 'load_shed_total',
  help: 'Requisicoes descartadas por load shedding',
  registers: [registry],
});

export const outboxLag = new Gauge({
  name: 'outbox_pending',
  help: 'Eventos na outbox aguardando publicacao',
  registers: [registry],
});

export const dlqTotal = new Counter({
  name: 'dlq_messages_total',
  help: 'Mensagens enviadas para a dead letter queue',
  labelNames: ['topic'],
  registers: [registry],
});
