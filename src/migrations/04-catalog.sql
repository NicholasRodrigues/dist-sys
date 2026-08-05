\connect catalog

-- ============================================================================
-- catalog: o lado de LEITURA do CQRS.
--
-- Modelo desnormalizado, alimentado por eventos, propositalmente defasado. Ele
-- nunca e consultado de forma sincrona no caminho da compra — a confirmacao de
-- que o assento e seu acontece na reserva, nao na visualizacao.
-- ============================================================================

CREATE TABLE IF NOT EXISTS events (
  id          text PRIMARY KEY,
  name        text NOT NULL,
  venue       text NOT NULL,
  starts_at   timestamptz NOT NULL,
  price_cents int NOT NULL,
  total_seats int NOT NULL DEFAULT 0
);

-- Read model do assento: uma linha por lugar, com o estado ja resolvido.
-- Ler o mapa inteiro de uma sessao e um unico SELECT por indice.
CREATE TABLE IF NOT EXISTS seat_view (
  event_id   text NOT NULL,
  seat_id    text NOT NULL,
  section    text NOT NULL,
  row_label  text NOT NULL,
  seat_no    int  NOT NULL,
  status     text NOT NULL CHECK (status IN ('AVAILABLE','HELD','SOLD')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (event_id, seat_id)
);

CREATE INDEX IF NOT EXISTS seat_view_event_status ON seat_view (event_id, status);
CREATE INDEX IF NOT EXISTS seat_view_section ON seat_view (event_id, section);

-- Materialized view mantida por evento: o contador que a tela mostra sem
-- precisar varrer 40.000 linhas a cada carregamento.
CREATE TABLE IF NOT EXISTS event_stats (
  event_id   text PRIMARY KEY,
  available  int NOT NULL DEFAULT 0,
  held       int NOT NULL DEFAULT 0,
  sold       int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Deduplicacao do consumidor: o mesmo evento entregue duas vezes pelo
-- barramento nao pode contar duas vezes na estatistica.
CREATE TABLE IF NOT EXISTS processed_events (
  event_uuid   text PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

GRANT ALL ON ALL TABLES IN SCHEMA public TO catalog_svc;
GRANT ALL ON SCHEMA public TO catalog_svc;
