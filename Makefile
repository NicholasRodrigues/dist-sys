# Bilheteria + Risk-Shield — todos os comandos do projeto.
#
# Regra do repositorio: qualquer tarefa e um comando so, e nenhuma exige nada
# instalado na maquina alem de Docker. As ferramentas rodam dentro da rede do
# Compose, com `docker compose run`.

SHELL := /bin/bash
COMPOSE := docker compose
RUN := $(COMPOSE) run --rm -T tools

APP_SERVICES := edge-blue edge-green catalog inventory orders payments realtime psp-sandbox \
                risk-event-api risk-worker risk-api

.DEFAULT_GOAL := help
.PHONY: help up down restart build ca seed test test-unit smoke invariants chaos \
        scenarios risk-gate risk-config risk-reset \
        load load-with-queue load-without-queue compare contention deploy-status canary \
        blue-green rollback flags logs ps urls demo clean reset psp-reset

## ---------------------------------------------------------------------------

help: ## Mostra este menu
	@echo ""
	@echo "  BILHETERIA + RISK-SHIELD — Engenharia de Sistemas Distribuidos"
	@echo "  ============================================================================"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[1m%-22s\033[0m %s\n", $$1, $$2}'
	@echo ""

ca: ## Copia a CA da rede local para o build, se houver (inspecao TLS)
	@mkdir -p docker/ca
	@src="$${NODE_EXTRA_CA_CERTS:-$$SSL_CERT_FILE}"; \
	 if [ -n "$$src" ] && [ -f "$$src" ]; then \
	   cp "$$src" docker/ca/local.crt; \
	   echo "==> CA da rede local adicionada ao build"; \
	 fi

up: ca ## Sobe o sistema inteiro e carrega os dados de demonstracao
	@echo "==> construindo a imagem"
	@$(COMPOSE) build edge-blue
	@echo "==> subindo os conteineres"
	@$(COMPOSE) up -d --remove-orphans
	@echo "==> aguardando os servicos ficarem prontos"
	@$(RUN) node dist/tools/wait.js
	@echo "==> carregando dados de demonstracao"
	@$(RUN) node dist/tools/seed.js
	@$(MAKE) --no-print-directory urls

down: ## Derruba tudo, preservando os dados
	@$(COMPOSE) down --remove-orphans

clean: ## Derruba tudo e apaga os volumes
	@$(COMPOSE) down -v --remove-orphans

restart: ## Reinicia os servicos de aplicacao
	@$(COMPOSE) restart $(APP_SERVICES)

build: ca ## Reconstroi a imagem
	@$(COMPOSE) build edge-blue

reset: ## Recarrega os dados de demonstracao do zero
	@$(RUN) node dist/tools/seed.js

## ---------------------------------------------------------------------------

test: test-unit smoke chaos scenarios risk-gate invariants ## Bateria completa do projeto

test-unit: ## Testes unitarios (nao precisam do sistema no ar)
	@docker run --rm -v "$(PWD):/app" -w /app \
	  -e NODE_EXTRA_CA_CERTS=/app/docker/ca/local.crt \
	  node:22-alpine sh -c \
	  "npm ci --no-audit --no-fund --silent 2>/dev/null || npm install --no-audit --no-fund --silent; npx vitest run tests/unit"

smoke: ## Ponta a ponta: compra, portaria, idempotencia, zero overselling
	@$(RUN) node dist/tools/smoke.js

invariants: ## As consultas que nao podem retornar linha
	@$(RUN) node dist/tools/invariants.js

chaos: ## Cenarios de resiliencia com falha injetada (R1 a R8)
	@$(RUN) node dist/tools/chaos.js

## ---------------------------------------------------------------------------
## Antifraude (POC 2)

scenarios: ## Os 6 cenarios do antifraude, com 2 falsos positivos que devem passar
	@$(RUN) node dist/tools/simulator.js

# A pergunta central da integracao — "se o antifraude cai, a venda para?" — so
# pode ser respondida com o antifraude realmente no chao. Por isso o alvo para o
# conteiner no meio do teste, em vez de simular a falha.
#
# O `start` roda mesmo se a fase 2 falhar: deixar o sistema mutilado depois de
# um teste vermelho seria pior do que o proprio teste vermelho.
#
# O comprador da rodada e sorteado aqui e repassado as tres fases: elas sao
# processos distintos que precisam falar do mesmo sujeito, mas duas execucoes
# nao podem compartilhar historico de risco.
GATE := $(COMPOSE) run --rm -T -e GATE_BUYER=$$buyer tools node dist/tools/risk-gate.js

risk-gate: ## Prova o portao antifraude no checkout, inclusive com o antifraude no chao
	@buyer=gate-$$(head -c 6 /dev/urandom | od -An -tx1 | tr -d ' \n'); \
	 $(GATE) normal || exit 1; \
	 echo "==> parando o risk-api para medir fail_open e fail_closed"; \
	 $(COMPOSE) stop risk-api >/dev/null 2>&1; \
	 $(GATE) indisponivel; status=$$?; \
	 echo "==> religando o risk-api"; \
	 $(COMPOSE) start risk-api >/dev/null 2>&1; \
	 [ $$status -eq 0 ] || exit $$status; \
	 $(GATE) restaurado

risk-config: ## Mostra pesos, limiar e estatisticas do antifraude
	@$(RUN) node dist/tools/risk.js

risk-reset: ## Apaga eventos, evidencias e scores do antifraude
	@$(RUN) node dist/tools/risk.js reset

## ---------------------------------------------------------------------------

load: ## Teste de carga: flash sale (K6_VUS, K6_DURATION)
	@mkdir -p docs/resultados
	@$(COMPOSE) run --rm -T k6 run /scripts/flashsale.js

# Preparacao comum das duas rodadas de carga.
#
# 1. O rate limit por IP e afrouxado: o gerador de carga inteiro sai de um unico
#    endereco, e mante-lo mediria o harness em vez da arquitetura.
#
# 2. O PSP recebe uma latencia realista. Um provedor de pagamento de verdade
#    leva centenas de milissegundos, e um PSP que responde instantaneamente
#    torna o nucleo transacional artificialmente rapido — a saturacao nunca
#    chega, e a fila virtual parece nao servir para nada. Com 250ms e um pool de
#    8 conexoes, a capacidade do nucleo fica em torno de 30 checkouts por
#    segundo, que e o regime em que o controle de admissao existe para operar.
LOAD_PSP_LATENCY ?= 250
LOAD_PREP := $(RUN) node dist/tools/flags.js rate_limit_max=1000000 >/dev/null && \
             $(RUN) node dist/tools/psp.js latencyMs=$(LOAD_PSP_LATENCY)

load-with-queue: ## Carga COM fila virtual, resultado em docs/resultados
	@mkdir -p docs/resultados
	@$(RUN) node dist/tools/seed.js >/dev/null
	@$(LOAD_PREP)
	@$(RUN) node dist/tools/flags.js queue_enabled=true admission_rate=$(or $(RATE),40)
	@$(RUN) node dist/tools/reset-queue.js >/dev/null
	@$(COMPOSE) run --rm -T -e SCENARIO=com-fila k6 run /scripts/flashsale.js

load-without-queue: ## Carga SEM fila virtual, resultado em docs/resultados
	@mkdir -p docs/resultados
	@$(RUN) node dist/tools/seed.js >/dev/null
	@$(LOAD_PREP)
	@$(RUN) node dist/tools/flags.js queue_enabled=false
	@$(COMPOSE) run --rm -T -e SCENARIO=sem-fila k6 run /scripts/flashsale.js

compare: ## O grafico da apresentacao: mesma carga com e sem fila
	@$(RUN) node dist/tools/compare.js
	@$(RUN) node dist/tools/psp.js reset >/dev/null
	@$(RUN) node dist/tools/flags.js queue_enabled=true rate_limit_max=2000 >/dev/null

contention: ## Carga de contencao maxima: todos disputando o mesmo setor
	@mkdir -p docs/resultados
	@$(COMPOSE) run --rm -T k6 run /scripts/contention.js
	@$(MAKE) --no-print-directory invariants

## ---------------------------------------------------------------------------

deploy-status: ## Mostra os pesos de roteamento e amostra o trafego real
	@$(RUN) node dist/tools/deploy.js status

canary: ## Envia PCT% do trafego para a versao verde. Ex: make canary PCT=10
	@$(RUN) node dist/tools/deploy.js canary $(or $(PCT),10)

blue-green: ## Troca atomica de versao. Ex: make blue-green TO=green
	@$(RUN) node dist/tools/deploy.js blue-green $(or $(TO),green)

rollback: ## Devolve 100% do trafego para a versao azul
	@$(RUN) node dist/tools/deploy.js rollback

## ---------------------------------------------------------------------------

flags: ## Le ou altera feature flags. Ex: make flags ARGS="admission_rate=100"
	@$(RUN) node dist/tools/flags.js $(ARGS)

psp-reset: ## Zera a injecao de falha no PSP
	@$(RUN) node dist/tools/psp.js reset

demo: ## Roteiro guiado da demonstracao, passo a passo
	@$(RUN) node dist/tools/demo.js

logs: ## Segue os logs dos servicos
	@$(COMPOSE) logs -f --tail=80 $(APP_SERVICES)

ps: ## Estado dos conteineres
	@$(COMPOSE) ps

urls: ## Enderecos uteis
	@echo ""
	@echo "  Interface .......... http://localhost:$${EDGE_PORT:-8080}/"
	@echo "  API ................ http://localhost:$${EDGE_PORT:-8080}/api/events"
	@echo "  Painel antifraude .. http://localhost:$${RISK_API_PORT:-3022}/"
	@echo "  Grafana ............ http://localhost:$${GRAFANA_PORT:-3030}/d/bilheteria"
	@echo "  Jaeger (traces) .... http://localhost:$${JAEGER_PORT:-16686}"
	@echo "  Prometheus ......... http://localhost:$${PROMETHEUS_PORT:-9090}"
	@echo "  Traefik ............ http://localhost:$${TRAEFIK_DASHBOARD_PORT:-8081}"
	@echo ""
