-- ============================================================================
-- Risk-Shield — antifraude para bilheteria (POC 2)
--
-- Dois lados, conforme CQRS:
--
--   COMANDO  risk_events, risk_evidence, quarantine_history
--            normalizado, append-only, fonte da verdade
--
--   CONSULTA buyer_risk_summary
--            projecao desnormalizada, atualizada na MESMA transacao,
--            consultada pelo Painel e pela Bilheteria
--
-- O score nao e uma coluna que se soma. Ele e derivado da sequencia de
-- evidencias — e isso que permite recalcular tudo quando os pesos mudam, e
-- explicar POR QUE um comprador foi marcado.
-- ============================================================================

CREATE DATABASE riskshield;
CREATE USER risk_svc WITH PASSWORD 'risk_svc';
GRANT ALL PRIVILEGES ON DATABASE riskshield TO risk_svc;

\connect riskshield

-- Deduplicacao do consumidor: transforma a entrega at-least-once do barramento
-- em processamento effectively-once.
CREATE TABLE IF NOT EXISTS processed_events (
  event_id     uuid PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Evento normalizado pela camada de anticorrupcao. O formato externo — da
-- Bilheteria ou do Simulador — nao chega aqui.
CREATE TABLE IF NOT EXISTS risk_events (
  event_id           uuid PRIMARY KEY,
  schema_version     text NOT NULL,
  correlation_id     text NOT NULL,
  event_type         text NOT NULL,
  buyer_id           text NOT NULL,
  show_id            text,
  seat_id            text,
  device_fingerprint text,
  ip_address         text,
  payment_hash       text,
  occurred_at        timestamptz NOT NULL,
  received_at        timestamptz NOT NULL DEFAULT now(),
  metadata           jsonb NOT NULL DEFAULT '{}'
);

-- As regras consultam janelas recentes por comprador, device, IP e pagamento.
CREATE INDEX IF NOT EXISTS re_buyer   ON risk_events (buyer_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS re_device  ON risk_events (device_fingerprint, occurred_at DESC)
  WHERE device_fingerprint IS NOT NULL;
CREATE INDEX IF NOT EXISTS re_ip      ON risk_events (ip_address, occurred_at DESC)
  WHERE ip_address IS NOT NULL;
CREATE INDEX IF NOT EXISTS re_payment ON risk_events (payment_hash, occurred_at DESC)
  WHERE payment_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS re_show    ON risk_events (show_id, occurred_at DESC);

-- Evidencias: append-only, fonte da verdade do score.
--
-- `severity` (0 a 1) e o que a regra observou, independente de peso.
-- `points` = severity * peso vigente no momento.
--
-- Guardar os dois permite recalcular o score com pesos novos SEM reprocessar
-- os eventos: basta multiplicar a severidade pelo peso atual. E o que torna o
-- Event Sourcing util aqui, em vez de decorativo.
CREATE TABLE IF NOT EXISTS risk_evidence (
  id             bigserial PRIMARY KEY,
  buyer_id       text NOT NULL,
  event_id       uuid NOT NULL,
  correlation_id text NOT NULL,
  factor         text NOT NULL,
  severity       numeric(4,3) NOT NULL CHECK (severity >= 0 AND severity <= 1),
  weight         int NOT NULL,
  points         numeric(6,2) NOT NULL,
  observed       jsonb NOT NULL DEFAULT '{}',
  explanation    text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ev_buyer_factor ON risk_evidence (buyer_id, factor, id DESC);
CREATE INDEX IF NOT EXISTS ev_buyer        ON risk_evidence (buyer_id, id DESC);

-- Projecao de leitura. Cache derivado, nunca fonte da verdade.
CREATE TABLE IF NOT EXISTS buyer_risk_summary (
  buyer_id      text PRIMARY KEY,
  score         numeric(5,2) NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'CLEAR' CHECK (status IN ('CLEAR', 'QUARANTINED')),
  top_factors   jsonb NOT NULL DEFAULT '[]',
  events_seen   int NOT NULL DEFAULT 0,
  last_event_at timestamptz,
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS brs_score  ON buyer_risk_summary (score DESC);
CREATE INDEX IF NOT EXISTS brs_status ON buyer_risk_summary (status) WHERE status = 'QUARANTINED';

-- Toda entrada e saida de quarentena, com autor. Quarentena aplicada por score
-- e liberacao feita por um humano precisam ser distinguiveis na auditoria.
CREATE TABLE IF NOT EXISTS quarantine_history (
  id         bigserial PRIMARY KEY,
  buyer_id   text NOT NULL,
  action     text NOT NULL CHECK (action IN ('QUARANTINE', 'RELEASE')),
  reason     text NOT NULL,
  actor      text NOT NULL,
  score      numeric(5,2),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS qh_buyer ON quarantine_history (buyer_id, id DESC);

-- Feature flags e pesos. Lidos a CADA mensagem processada, para que uma
-- mudanca no Painel tenha efeito imediato sem reiniciar nada.
CREATE TABLE IF NOT EXISTS rule_flags (
  name       text PRIMARY KEY,
  enabled    boolean NOT NULL DEFAULT true,
  weight     int NOT NULL DEFAULT 25,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS settings (
  key        text PRIMARY KEY,
  value      text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Dead letter materializada, para inspecao no Painel.
CREATE TABLE IF NOT EXISTS dead_letters (
  id             bigserial PRIMARY KEY,
  payload        text NOT NULL,
  reason         text NOT NULL,
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Configuracao inicial
--
-- Os pesos codificam a regra de decisao (justificativa completa em
-- src/services/risk-worker/rules.ts):
--
--   nenhum fator sozinho quarentena  -> maior peso 38 < limiar 70
--   dois fatores no maximo, sim      -> menor par 35+35 = 70
--
-- Comportamento (velocity, choice_pattern) pesa mais do que associacao
-- (device_fingerprint, account_correlation) porque acusa a conta pelo que ela
-- mesma fez, e nao por quem esta perto dela.
--
-- Score limitado a 100. A soma dos pesos e 145 de proposito: exigir todos os
-- fatores para chegar ao teto tornaria impossivel pegar um bot solitario, que
-- por definicao so dispara os dois fatores comportamentais.
-- ---------------------------------------------------------------------------

INSERT INTO rule_flags (name, enabled, weight) VALUES
  ('velocity',            true, 38),
  ('choice_pattern',      true, 37),
  ('device_fingerprint',  true, 35),
  ('account_correlation', true, 35)
ON CONFLICT (name) DO NOTHING;

INSERT INTO settings (key, value) VALUES
  ('quarantine_threshold', '70'),
  ('window_minutes', '10'),
  ('auto_quarantine', 'true')
ON CONFLICT (key) DO NOTHING;

GRANT ALL ON ALL TABLES IN SCHEMA public TO risk_svc;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO risk_svc;
GRANT ALL ON SCHEMA public TO risk_svc;
