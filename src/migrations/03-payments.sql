\connect payments

-- ============================================================================
-- payments: dono do dinheiro.
--
-- Ledger de dupla entrada. O saldo nao e uma coluna que se atualiza — e uma
-- consequencia derivavel do historico. Cada movimentacao tem contrapartida, e a
-- soma de TODOS os lancamentos e sempre zero. Isso transforma a verificacao de
-- consistencia financeira do sistema inteiro em uma consulta de uma linha.
-- ============================================================================

CREATE TABLE IF NOT EXISTS charges (
  id              uuid PRIMARY KEY,
  saga_id         text NOT NULL UNIQUE,
  order_id        text NOT NULL,
  user_id         text NOT NULL,
  amount_cents    int  NOT NULL CHECK (amount_cents > 0),
  status          text NOT NULL CHECK (status IN ('CAPTURED','REFUNDED','FAILED')),
  psp_reference   text,
  idempotency_key text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  refunded_at     timestamptz
);

-- Invariante 5 do plano de testes: nenhuma cobranca duplicada por chave.
CREATE UNIQUE INDEX IF NOT EXISTS one_charge_per_idempotency_key
  ON charges (idempotency_key);

CREATE TABLE IF NOT EXISTS ledger_entries (
  id           bigserial PRIMARY KEY,
  charge_id    uuid NOT NULL REFERENCES charges (id),
  saga_id      text NOT NULL,
  account      text NOT NULL,
  -- Positivo credita, negativo debita. A soma da tabela inteira e sempre zero.
  amount_cents int  NOT NULL,
  entry_type   text NOT NULL CHECK (entry_type IN ('CAPTURE','REFUND')),
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ledger_account ON ledger_entries (account, created_at);
CREATE INDEX IF NOT EXISTS ledger_saga ON ledger_entries (saga_id);

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

GRANT ALL ON ALL TABLES IN SCHEMA public TO payments_svc;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO payments_svc;
GRANT ALL ON SCHEMA public TO payments_svc;
