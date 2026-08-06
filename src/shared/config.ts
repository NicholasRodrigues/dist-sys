/**
 * Configuracao centralizada, lida do ambiente com defaults que funcionam
 * fora do Docker (localhost) para facilitar o desenvolvimento.
 */

function env(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

export const config = {
  serviceName: env('SERVICE_NAME', 'unknown'),
  /** Identifica a instancia (azul ou verde) nos cenarios de deployment. */
  appVersion: env('APP_VERSION', 'blue'),
  /** Taxa de erro artificial, usada para provar a reversao de um canary ruim. */
  faultRate: Number(env('FAULT_RATE', '0')) || 0,
  port: envInt('PORT', 3000),
  nodeEnv: env('NODE_ENV', 'development'),
  logLevel: env('LOG_LEVEL', 'info'),

  postgresHost: env('POSTGRES_HOST', 'localhost'),
  postgresPort: envInt('POSTGRES_PORT', 5432),
  postgresUser: env('POSTGRES_USER', 'bilheteria'),
  postgresPassword: env('POSTGRES_PASSWORD', 'bilheteria'),
  /** Cada servico transacional tem o proprio banco logico. */
  postgresDb: env('POSTGRES_DB', 'postgres'),
  /** Pool pequeno de proposito: bulkhead por dependencia. */
  postgresPoolMax: envInt('POSTGRES_POOL_MAX', 10),

  redisHost: env('REDIS_HOST', 'localhost'),
  redisPort: envInt('REDIS_PORT', 6379),

  kafkaBrokers: env('KAFKA_BROKERS', 'localhost:9092').split(',').filter(Boolean),
  kafkaTopic: env('KAFKA_TOPIC', 'bilheteria.events'),

  otlpEndpoint: env('OTLP_ENDPOINT', 'http://localhost:4318/v1/traces'),
  tracingEnabled: env('TRACING_ENABLED', 'true') === 'true',

  jwtSecret: env('JWT_SECRET', 'dev-secret-nao-use-em-producao'),
  jwtTtlSeconds: envInt('JWT_TTL_SECONDS', 3600),
  admissionTtlSeconds: envInt('ADMISSION_TTL_SECONDS', 300),

  /** Chave Ed25519 do ingresso, em PKCS8 PEM base64. Gerada no boot se ausente. */
  ticketPrivateKey: env('TICKET_PRIVATE_KEY', ''),

  catalogUrl: env('CATALOG_URL', 'http://localhost:3001'),
  inventoryUrl: env('INVENTORY_URL', 'http://localhost:3002'),
  ordersUrl: env('ORDERS_URL', 'http://localhost:3003'),
  paymentsUrl: env('PAYMENTS_URL', 'http://localhost:3004'),
  realtimeUrl: env('REALTIME_URL', 'http://localhost:3005'),
  pspUrl: env('PSP_URL', 'http://localhost:3010'),
  riskEventApiUrl: env('RISK_EVENT_API_URL', 'http://localhost:3020'),
  riskApiUrl: env('RISK_API_URL', 'http://localhost:3022'),

  /** Duracao do hold do assento. Parametro que so se acerta medindo. */
  holdTtlSeconds: envInt('HOLD_TTL_SECONDS', 600),
  /** Preco unico por ingresso, em centavos. */
  ticketPriceCents: envInt('TICKET_PRICE_CENTS', 25000),

  /** Rate limit padrao da borda: requisicoes por janela por identidade. */
  rateLimitMax: envInt('RATE_LIMIT_MAX', 120),
  rateLimitWindowSeconds: envInt('RATE_LIMIT_WINDOW_SECONDS', 10),
  /** Load shedding: requisicoes simultaneas em voo antes de descartar baixa prioridade. */
  loadShedThreshold: envInt('LOAD_SHED_THRESHOLD', 400),

  /** Circuit breaker: falhas consecutivas ate abrir, e quanto tempo fica aberto. */
  breakerThreshold: envInt('BREAKER_THRESHOLD', 8),
  breakerResetMs: envInt('BREAKER_RESET_MS', 5000),
  httpTimeoutMs: envInt('HTTP_TIMEOUT_MS', 3000),
  httpRetries: envInt('HTTP_RETRIES', 2),
};

export type Config = typeof config;
