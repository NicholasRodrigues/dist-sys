\connect inventory

-- ============================================================================
-- inventory: dono da verdade sobre o assento.
--
-- A invariante do sistema inteiro mora neste arquivo: um assento tem no maximo
-- um dono. Ela e garantida por constraint de schema, nao por logica de
-- aplicacao, porque codigo com bug ainda respeita um indice unico.
-- ============================================================================

CREATE TABLE IF NOT EXISTS seats (
  event_id   text NOT NULL,
  seat_id    text NOT NULL,
  section    text NOT NULL,
  row_label  text NOT NULL,
  seat_no    int  NOT NULL,
  PRIMARY KEY (event_id, seat_id)
);

CREATE TABLE IF NOT EXISTS seat_holds (
  id          uuid PRIMARY KEY,
  event_id    text NOT NULL,
  seat_id     text NOT NULL,
  saga_id     text NOT NULL,
  user_id     text NOT NULL,
  status      text NOT NULL CHECK (status IN ('HELD', 'SOLD', 'RELEASED')),
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  released_at timestamptz,
  sold_at     timestamptz
);

-- ESTA e a linha que torna overselling impossivel.
--
-- Um assento so pode ter uma reserva ativa (HELD ou SOLD) por vez. Duas
-- transacoes concorrentes tentando reservar o mesmo lugar: uma vence, a outra
-- recebe violacao de unicidade. Nao ha janela, nao ha corrida, nao depende de
-- ordem de execucao.
CREATE UNIQUE INDEX IF NOT EXISTS one_active_hold_per_seat
  ON seat_holds (event_id, seat_id)
  WHERE status IN ('HELD', 'SOLD');

-- Uma saga so pode ter um hold: torna a reserva idempotente por natureza.
CREATE UNIQUE INDEX IF NOT EXISTS one_hold_per_saga ON seat_holds (saga_id);

-- O reaper varre por aqui. Indice parcial: so holds ativos interessam.
CREATE INDEX IF NOT EXISTS seat_holds_expiry ON seat_holds (expires_at) WHERE status = 'HELD';
CREATE INDEX IF NOT EXISTS seat_holds_event ON seat_holds (event_id, status);

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

GRANT ALL ON ALL TABLES IN SCHEMA public TO inventory_svc;
GRANT ALL ON SCHEMA public TO inventory_svc;
