\connect orders

-- ============================================================================
-- orders: dono do PROCESSO, nao do dado.
--
-- A garantia que este servico oferece e diferente em natureza da do inventory:
-- ele nao promete uma invariante fisica, promete que toda SAGA chega a um
-- estado terminal. Por isso a maquina de estados e persistida, e nao mantida
-- em memoria.
-- ============================================================================

CREATE TABLE IF NOT EXISTS orders (
  id            uuid PRIMARY KEY,
  saga_id       text NOT NULL UNIQUE,
  user_id       text NOT NULL,
  event_id      text NOT NULL,
  seat_id       text NOT NULL,
  amount_cents  int  NOT NULL,
  -- PENDING -> RESERVED -> PAID -> CONFIRMED  (terminal, sucesso)
  --                     \-> COMPENSATING -> FAILED  (terminal, falha)
  status        text NOT NULL CHECK (status IN
                  ('PENDING','RESERVED','PAID','CONFIRMED','COMPENSATING','FAILED')),
  failure_reason text,
  attempts      int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  -- Quando a SAGA pode ser retomada por um trabalhador de fundo.
  next_attempt_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS orders_user ON orders (user_id, created_at DESC);
-- O varredor de sagas travadas usa este indice: so estados nao terminais.
CREATE INDEX IF NOT EXISTS orders_stuck ON orders (next_attempt_at)
  WHERE status IN ('PENDING','RESERVED','PAID','COMPENSATING');

-- Trilha append-only de transicoes: e o Event Sourcing do processo, e o que
-- permite responder "por que este pedido parou aqui" olhando uma tabela so.
CREATE TABLE IF NOT EXISTS saga_log (
  id         bigserial PRIMARY KEY,
  saga_id    text NOT NULL,
  step       text NOT NULL,
  outcome    text NOT NULL,
  detail     text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS saga_log_saga ON saga_log (saga_id, id);

CREATE TABLE IF NOT EXISTS tickets (
  id          uuid PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders (id),
  event_id    text NOT NULL,
  seat_id     text NOT NULL,
  user_id     text NOT NULL,
  -- Assinatura Ed25519 do payload do QR: verificavel offline na portaria.
  qr_payload  text NOT NULL,
  signature   text NOT NULL,
  key_id      text NOT NULL,
  status      text NOT NULL CHECK (status IN ('VALID','USED','INVALIDATED')),
  issued_at   timestamptz NOT NULL DEFAULT now(),
  used_at     timestamptz
);

-- Segunda linha de defesa contra overselling, deste lado da fronteira: mesmo
-- que o inventory falhasse, dois ingressos validos para o mesmo assento sao
-- impossiveis de gravar.
CREATE UNIQUE INDEX IF NOT EXISTS one_valid_ticket_per_seat
  ON tickets (event_id, seat_id)
  WHERE status IN ('VALID','USED');

CREATE UNIQUE INDEX IF NOT EXISTS one_ticket_per_order ON tickets (order_id);

CREATE TABLE IF NOT EXISTS outbox (
  id           uuid PRIMARY KEY,
  type         text NOT NULL,
  key          text NOT NULL,
  payload      jsonb NOT NULL,
  traceparent  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);

CREATE INDEX IF NOT EXISTS outbox_pending ON outbox (created_at) WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key          text PRIMARY KEY,
  fingerprint  text NOT NULL,
  state        text NOT NULL,
  response     jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

-- Notificacoes enviadas, para provar que o consumidor e idempotente: o mesmo
-- evento entregue duas vezes nao gera dois envios.
CREATE TABLE IF NOT EXISTS notifications (
  event_id   text PRIMARY KEY,
  order_id   uuid NOT NULL,
  channel    text NOT NULL,
  sent_at    timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON ALL TABLES IN SCHEMA public TO orders_svc;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO orders_svc;
GRANT ALL ON SCHEMA public TO orders_svc;
