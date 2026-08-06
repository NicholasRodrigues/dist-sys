# Plano de Testes

A dimensão *Testes e Validação* pesa 15% e o checklist da Seção 7 exige "plano **e resultados** de
testes (carga, resiliência, integração)". Resultado, não só plano. Cada cenário abaixo define o
que é medido, o critério de aprovação e a evidência que vai para a documentação final.

Regra que vale para tudo: **um teste que não pode falhar não prova nada.** Todo cenário de
resiliência começa demonstrando o sistema quebrando sem a defesa, e depois resistindo com ela.

---

## Pirâmide

| Camada | Ferramenta | Escopo |
|---|---|---|
| Unitário | Vitest | Máquina de estados da SAGA, regras do ledger, cálculo de posição na fila |
| Integração | Vitest + Testcontainers | Cada serviço contra Postgres, Redis e Redpanda reais |
| Ponta a ponta | Script HTTP | Fluxo do comprador, da fila ao QR |
| Carga | k6 | Percentis sob pico |
| Resiliência | PSP falso + `docker compose stop` | Latência, erro e queda de dependência |
| Invariante | SQL pós-execução | Verificações que não podem falhar nunca |

**Sobre injeção de falhas:** não usamos Toxiproxy. O PSP é um serviço nosso e já expõe endpoints
para injetar latência, erro e timeout sob demanda; a queda de dependência é `docker compose stop`.
Menos uma peça de infraestrutura, e o controle fica mais legível na demonstração.

---

## Invariantes — as consultas que não podem retornar linha

Executadas ao final de **toda** rodada de carga. Qualquer resultado não vazio reprova a rodada.

As consultas exatas estão em `src/tools/invariants.ts` e rodam com `make invariants`:

```sql
-- 1. Nenhum assento vendido duas vezes                        [banco: orders]
SELECT event_id, seat_id, count(*) FROM tickets
 WHERE status IN ('VALID','USED') GROUP BY event_id, seat_id HAVING count(*) > 1;

-- 2. O ledger fecha: débitos e créditos se anulam           [banco: payments]
SELECT COALESCE(sum(amount_cents), 0) FROM ledger_entries;   -- deve ser 0

-- 3. Nenhum pedido pago sem ingresso emitido                  [banco: orders]
SELECT o.id FROM orders o LEFT JOIN tickets t ON t.order_id = o.id
 WHERE o.status = 'PAID' AND t.id IS NULL
   AND o.updated_at < now() - interval '2 minutes';

-- 4. Nenhum assento preso: hold vencido ainda bloqueando   [banco: inventory]
SELECT id FROM seat_holds
 WHERE status = 'HELD' AND expires_at < now() - interval '30 seconds';

-- 5. Nenhuma cobrança duplicada para a mesma chave          [banco: payments]
SELECT idempotency_key, count(*) FROM charges
 GROUP BY idempotency_key HAVING count(*) > 1;

-- 6. Nenhum assento com duas reservas ativas              [banco: inventory]
SELECT event_id, seat_id, count(*) FROM seat_holds
 WHERE status IN ('HELD','SOLD') GROUP BY event_id, seat_id HAVING count(*) > 1;
```

São o teste mais barato e mais valioso do projeto: rodam em segundos e cobrem a invariante que
define o domínio. Note que cada uma consulta um banco diferente — é a verificação que atravessa a
fronteira dos serviços, e por isso vive numa ferramenta de operação, e não dentro de um serviço.

---

## Carga

### C1 — Flash sale

Rampa de 0 até `K6_VUS` em 20 s, mantidos por 60 s, contra um evento de 40.000 assentos. Cada
usuário virtual percorre o caminho completo: autentica, entra na fila, **abre o mapa**, espera um
tempo de leitura plausível e compra.

| Métrica | Meta | Medido |
|---|---|---|
| Taxa de erro 5xx | < 1% | **0,1%** ✔ |
| Overselling | zero | **zero** ✔ |
| p95 do mapa de assentos (`tipo:mapa`) | < 800 ms | **295 ms** ✔ |
| p95 da consulta de assento livre (`tipo:leitura`) | < 300 ms | **~400 ms** ✘ |
| p95 do checkout | < 5 s | **1,8 s a 600 VUs com fila** ✔ |

**Sobre as metas.** A especificação da disciplina não define perfil de carga — ela exige
"resultados de testes (carga, resiliência, integração)", e o perfil é escolha nossa. Uma versão
anterior deste plano prometia 1.000 VUs por 5 minutos com p95 do checkout abaixo de 500 ms; nunca
foi executada nessa escala e a meta era inalcançável nesta máquina, com o gerador de carga
disputando CPU com os 18 contêineres. Números que não foram medidos não ficam num plano de testes.

O `tipo:leitura` fica registrado como **meta não atingida**, e não como limiar afrouxado.

**Sobre o gerador.** Ele precisou ser corrigido para descrever o que dizia descrever — detalhe em
[`resultados/`](resultados/README.md). A primeira versão gerava uma conta nova por iteração mas
mantinha dispositivo e IP fixos por usuário virtual, o que fazia cada VU parecer um aparelho por
onde passavam doze contas em dez minutos. O antifraude quarentenou 2.519 compradores e 96% dos
checkouts falharam. **O detector estava certo**; o gerador é que descrevia um ataque.

### C2 — Contenção máxima

Todos os usuários virtuais disputam **o mesmo setor de 500 lugares**. É o teste que quebra sistemas
que dependem de otimismo: mede a degradação sob contenção real, não sob carga distribuída.

Meta: zero overselling, e latência que degrada de forma previsível em vez de colapsar.

### C3 — Fila virtual: com e sem, em dois pontos de operação

O gráfico mais importante da apresentação. Mesmo cenário, executado com a fila
desligada e ligada pela feature flag — e repetido em **dois regimes de carga**,
porque um único ponto não sustenta a conclusão.

| | 200 VUs | | 600 VUs | |
|---|---|---|---|---|
| | sem fila | com fila | sem fila | com fila |
| Compras confirmadas | 2.488 | 2.198 | 1.669 | **2.724** |
| p99 do checkout | 5,02 s | 6,36 s | 10,96 s | **2,10 s** |
| Espera na fila (p95) | — | 3,32 s | — | 13,18 s |

A 200 VUs a fila **atrapalha** — o núcleo não está saturado e a admissão vira
espera pura. A 600 VUs ela vende **63% mais** com p99 **5,2× menor**.

**A fila não aumenta a capacidade — ela escolhe o ponto de operação, e só
compensa depois do joelho da curva.**

### C4 — Custo do antifraude no caminho crítico

Mesma carga, uma flag trocada (`risk_check_mode`). 200 VUs.

| Métrica | sem antifraude | com antifraude |
|---|---|---|
| Compras confirmadas | 2.121 | 2.177 |
| p95 do checkout | 3.411 ms | 3.076 ms |
| Erro no checkout | 0,84% | **2,54%** |

O custo em latência fica **abaixo da variação entre repetições**; o custo real é
+1,7 ponto percentual de checkouts recusados, que são os compradores
quarentenados.

**Meta não atingida:** `tipo:leitura` p95 fica em ~400 ms contra a meta de 300 ms,
nas duas configurações. Registrada como falha, não como limiar afrouxado.

---

## Resiliência

Cada cenário roda **durante** a carga do C1, não em repouso.

| # | Falha injetada | Comportamento esperado | Como se prova |
|---|---|---|---|
| R1 | PSP totalmente indisponível | Circuit breaker abre; ao voltar, o varredor leva as SAGAs a estado terminal | Breaker do `payments` em `open`; invariante 4 vazia · **passou** |
| R2 | PSP processa a cobrança e engole a resposta | Reconciliação por chave impede a segunda cobrança | 1 cobrança, 2 lançamentos, pedido CONFIRMED · **passou** |
| R3 | 5 retentativas com a mesma chave | Idempotência impede lançamento duplicado | 1 cobrança, 2 lançamentos, soma zero · **passou** |
| R4 | Rajada de vendas simultâneas | A outbox acumula e converge sem perder evento | Pico de 10 eventos, convergiu a 0, 1 evento por assento · **passou** |
| R7 | Consumidor sob carga | O read model continua avançando | Vendas refletidas no `catalog` · **passou** |
| R8 | PSP falhando em 50% das chamadas | Retry com backoff absorve; nenhum pedido fica pendurado | 6 pedidos, todos terminais · **passou** |

Rodar: `make chaos`. A injeção de falha vem do próprio PSP falso, que expõe `latencyMs`,
`errorRate`, `timeoutRate` e `down` — ver `make flags` e `src/tools/psp.ts`.

---

## Antifraude (POC 2)

Duas baterias, com propósitos distintos. A primeira mede se o motor **classifica**;
a segunda, se a classificação **muda a venda**.

### A1 — Cenários de comportamento (`make scenarios`)

Seis cenários sintéticos, cada um com faixa de score esperada e estado final. **Dois
são compradores legítimos com sinais suspeitos reais, e a asserção é que passem** —
um teste antifraude só com casos de fraude mede sensibilidade, não precisão.

| # | Cenário | Faixa | Medido | Estado | Passou |
|---|---|---|---|---|---|
| C1 | Comprador legítimo | 0 a 20 | 0,0 | livre | ✔ |
| C2 | Bot solitário | 70 a 85 | 75,0 | quarentena | ✔ |
| C3 | Fazenda de 20 contas | 90 a 100 | 100,0 | quarentena | ✔ |
| C4 | Conluio distribuído (12 contas, 12 IPs) | 80 a 100 | 91,9 | quarentena | ✔ |
| C5 | Rotação de *fingerprint*, ritmo humano | 25 a 60 | 43,6 | **livre** | ✔ |
| C6 | Família (4 contas, 1 device, 1 cartão) | 5 a 50 | 22,5 | **livre** | ✔ |

O limiar de 70 cai entre 43,6 e 75,0 — folga de mais de 30 pontos para os dois lados.

O simulador envia cada cenário em **duas ondas**, com barreira entre elas: o tópico é
particionado por comprador, o que garante ordem dentro de uma conta mas não entre
contas, e as regras de dispositivo e correlação olham o conjunto. A barreira garante
que a compra decisiva de cada conta seja julgada com o contexto completo — sem ela o
teste mediria a corrida entre o harness e o consumidor.

### A2 — Portão no checkout (`make risk-gate`)

Roda em três fases, porque a pergunta central — *se o antifraude cai, a venda para?* —
só pode ser respondida com o antifraude realmente no chão. O alvo do Makefile executa
`docker compose stop risk-api` no meio da bateria.

| Fase | Verificação | Resultado |
|---|---|---|
| 1 | Comprador sem histórico compra normalmente | HTTP 201 |
| 1 | A compra alimenta o antifraude pelo caminho assíncrono | 3 eventos registrados |
| 1 | Comprador em quarentena é barrado, com o motivo em texto | HTTP 403 |
| 1 | O bloqueio **não** consome assento nem cria pedido | 0 pedidos |
| 1 | `disabled` desliga a consulta sem apagar a marcação | vendeu, quarentena intacta |
| 1 | Liberação manual devolve o direito de comprar | HTTP 201 |
| 1 | **Quarentena em pleno voo: a SAGA compensa com estorno** | *refund* + *release* |
| 2 | `fail_open` com o antifraude no chão | HTTP 201 |
| 2 | `fail_closed` com o antifraude no chão | HTTP 403 |
| 2 | Alternância de modo em tempo de execução | sem reinício |
| 2 | Circuit breaker impede que `fail_open` vire espera por *timeout* | **194 ms** (mediana de 5) |
| 3 | A quarentena sobreviveu à indisponibilidade | HTTP 403 |
| 3 | O breaker fecha sozinho quando a dependência volta | consultas atendidas |

**15/15.** O cenário em negrito é o mais caro e o mais informativo: com 2 s de latência
injetada no PSP, a quarentena é aplicada durante a captura do pagamento, e a SAGA
compensa com estorno em vez de só liberar o assento.

### Dois defeitos reais encontrados por A2

Nenhum teste anterior havia levado a SAGA ao caminho de estorno, e ele estava quebrado:

1. O cliente HTTP anunciava `content-type: application/json` em requisições **sem
   corpo**, e o Fastify respondia 400. Todo `POST` sem corpo falhava — inclusive
   `POST /charges/:sagaId/refund`. Corrigido, com teste de regressão em
   `tests/unit/breaker.test.ts`.
2. A compensação retentava **qualquer** erro indefinidamente. Com o 400 acima, a SAGA
   girou 40 segundos repetindo `payments respondeu 400` e teria girado para sempre.
   Corrigido com teto de tentativas e tratamento explícito de erro permanente.

Detalhes em [ADR-0016](adr/0016-risco-dentro-da-saga.md).

### O teste de fumaça foi quarentenado

Ao ligar a integração, a bateria de fumaça da Bilheteria passou a ser bloqueada:
`53 tentativas de compra nos ultimos 10 minutos`. O detector estava certo — a
verificação de contenção usa 40 contas disputando o mesmo assento e a de idempotência
dispara 50 requisições idênticas, tudo do mesmo endereço.

A lição é operacional: geradores de carga e sondas sintéticas precisam de um caminho
declarado fora do antifraude, senão a própria monitoração acorda o plantão. Aqui isso
é `risk_check_mode=disabled`, que `make smoke` liga no início e devolve ao padrão no
fim, com asserção nos dois passos.

O mesmo diagnóstico revelou um problema de configuração que teria arruinado a
demonstração: o Traefik **sobrescrevia** o `X-Forwarded-For`, então todo o tráfego
local chegava com um único endereço e a regra de correlação via 127 contas num só IP —
marcando todo mundo por associação. Corrigido declarando as faixas privadas como
confiáveis em `infra/traefik/traefik.yml`.

---

## Integração

Exigido nominalmente pelo checklist. O teste ponta a ponta (`make smoke`) **é** a bateria de
integração: ele roda contra o sistema completo no ar — Postgres, Redis e Redpanda reais, nove
serviços em processos separados — e verifica 30 propriedades, incluindo as consultas de invariante
nos quatro bancos.

| # | Coberto por |
|---|---|
| I1 | `inventory` contra Postgres: hold, expiração, confirmação e liberação |
| I2 | SAGA completa e compensações, verificadas no `saga_log` |
| I3 | Ledger fecha em zero após as compras |
| I4 | Outbox publica e converge (cenário R4) |
| I5 | Read model do `catalog` reflete as vendas |
| I6 | QR válido, forjado e reapresentado |

| I7 | Portão antifraude no checkout, com o `risk-api` parado (`make risk-gate`) |
| I8 | Compensação com estorno disparada por quarentena pós-pagamento |

Os testes **unitários** (`make test-unit`, 59 testes) cobrem o que não precisa de infraestrutura:
JWT, assinatura do ingresso, classificação de erro, circuit breaker, a camada de anticorrupção do
antifraude e as propriedades do modelo de score.

Os testes de score merecem nota: eles não verificam se a soma está certa — verificam se as
**propriedades** que justificam os pesos continuam valendo. Um dia alguém vai achar que 35 é pouco
e subir para 40 "para pegar mais fraude"; é o teste `nenhum fator sozinho quarentena` que vai
explicar por que aquilo transforma o sistema num gerador de falso positivo.

---

## Deployment

| # | Teste | Aprovação |
|---|---|---|
| D1 | Blue-green do `catalog` com troca de peso no Traefik e rollback | Troca e volta sem perda de requisição |
| D2 | Canary a 10% com erro injetado na versão nova | Métrica de erro dispara e o tráfego é revertido |
| D3 | Rollback por digest de imagem | Versão anterior restaurada |

---

## Resultados medidos

Os resultados de uma execução completa estão em
[`resultados/`](resultados/README.md): 59 testes unitários, 30 verificações ponta a
ponta, 6 cenários de resiliência, 6 cenários de antifraude, 15 verificações do
portão, 6 invariantes e a comparação de carga com e sem fila virtual.

Resumo do que foi medido:

| Cenário | Resultado |
|---|---|
| C1 flash sale, 250 VUs | p99 do checkout 5,01 s sem fila contra 2,70 s com fila |
| C2 contenção máxima, 120 VUs | 0 erros de servidor, invariantes intactas |
| C3 com e sem fila | erro no checkout −75%, pior caso −68% |
| R1 a R8 resiliência | 6/6 passaram |
| A1 cenários do antifraude | 6/6, incluindo os 2 falsos positivos que devem passar |
| A2 portão antifraude | 15/15, em 3 fases, com o `risk-api` parado na fase 2 |
| Unitários | 59/59 |
| Ponta a ponta | 30/30 |
| Invariantes | 6/6 vazias |

Uma execução completa a partir do zero é `make clean && make up && make test`, e cobre
as sete linhas acima em sequência.

## Evidências a coletar

Para cada rodada, arquivadas em `docs/resultados/`:

- Sumário do k6 com p50, p95, p99, vazão e taxa de erro
- Captura do painel do Grafana durante a janela do teste
- **Trace no Jaeger de uma SAGA bem-sucedida e de uma compensada** — o trace da compensação é a
  imagem mais eloquente do projeto inteiro, e é o que se mostra no videocast
- Saída das cinco consultas de invariante
- Log da injeção de falha, com o instante do evento

O relatório final compara as rodadas antes e depois de cada defesa entrar. É essa comparação, e
não o valor absoluto, que sustenta cada ADR.
