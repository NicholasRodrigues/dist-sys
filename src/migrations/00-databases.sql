-- Um banco logico por servico, com credencial propria.
--
-- Rodam na mesma instancia PostgreSQL para economizar conteineres na demo. O
-- padrao Database per Service e sobre acoplamento por schema, nao sobre
-- contagem de processos: nenhum servico tem permissao de ler o banco do outro,
-- e nenhuma query atravessa a fronteira.

CREATE DATABASE inventory;
CREATE DATABASE orders;
CREATE DATABASE payments;
CREATE DATABASE catalog;

CREATE USER inventory_svc WITH PASSWORD 'inventory_svc';
CREATE USER orders_svc    WITH PASSWORD 'orders_svc';
CREATE USER payments_svc  WITH PASSWORD 'payments_svc';
CREATE USER catalog_svc   WITH PASSWORD 'catalog_svc';

GRANT ALL PRIVILEGES ON DATABASE inventory TO inventory_svc;
GRANT ALL PRIVILEGES ON DATABASE orders    TO orders_svc;
GRANT ALL PRIVILEGES ON DATABASE payments  TO payments_svc;
GRANT ALL PRIVILEGES ON DATABASE catalog   TO catalog_svc;
