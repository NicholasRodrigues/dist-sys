# Resultados medidos

Evidências coletadas em execução real do sistema. A dimensão *Testes e Validação*
(15% da nota) exige "métricas coletadas", e o checklist da Seção 7 exige "plano
**e resultados** de testes".

**Ambiente de medição:** 4 vCPU, 16 GB de RAM, Docker Compose com os 18
contêineres no mesmo host — incluindo o gerador de carga. Os números absolutos
são, portanto, limitados pela máquina; o que vale é a **comparação relativa entre
configurações do mesmo sistema**, que é como todas as conclusões abaixo estão
construídas.

**Como reproduzir tudo:** `make clean && make up && make test`.

| Bateria | Comando | Resultado |
|---|---|---|
| Unitários | `make test-unit` | 59/59 |
| Ponta a ponta | `make smoke` | 30/30 |
| Resiliência | `make chaos` | 6/6 |
| Cenários do antifraude | `make scenarios` | 6/6 + dead letter |
| Portão antifraude | `make risk-gate` | 15/15 em 3 fases |
| Invariantes | `make invariants` | 6/6 vazias |

---

## Invariantes

As seis consultas que não podem retornar linha. Executadas ao final de cada
rodada de carga e ao final do teste ponta a ponta.

| # | Invariante | Resultado |
|---|---|---|
| 1 | Nenhum assento vendido duas vezes | vazio |
| 2 | Soma de todos os lançamentos do ledger é zero | 0 centavos |
| 3 | Nenhum pedido pago sem ingresso emitido | vazio |
| 4 | Nenhum assento preso por hold vencido | vazio |
| 5 | Nenhuma cobrança duplicada para a mesma chave | vazio |
| 6 | Nenhum assento com duas reservas ativas | vazio |

Reproduzir: `make invariants`

---

## Teste ponta a ponta — 30 verificações

`make smoke` · todas passaram.

Os resultados que mais importam são os casos que **não deveriam** funcionar:

| Verificação | Resultado |
|---|---|
| 40 compradores disputando o **mesmo** assento | exatamente 1 confirmado, 39 recusados com 409, 1 ingresso válido no banco |
| 50 requisições concorrentes com a **mesma** chave de idempotência | 1 pedido e 1 cobrança |
| Mesmo QR apresentado duas vezes na portaria | segunda tentativa recusada com 409 |
| QR com assinatura forjada | recusado com 403 |
| Token JWT expirado, adulterado e ausente | três recusas distintas |
| Checkout sem passar pela fila | recusado com 428 |
| Pedido de um usuário acessado por outro | recusado com 403 |
| Rajada de 60 requisições com limite de 20 | 20 passaram, 40 barradas com 429 |

---

## Resiliência — 6 cenários com falha injetada

`make chaos` · todos passaram. A injeção vem do PSP falso e de `docker compose stop`.

| # | Falha | Resultado observado |
|---|---|---|
| R1 | PSP totalmente fora do ar | circuit breaker do `payments` abriu; após a recuperação o pedido chegou a CONFIRMED sozinho; **nenhum assento preso** |
| R2 | PSP processa a cobrança e engole a resposta | reconciliado: pedido CONFIRMED, **1 cobrança**, 2 lançamentos, sem estorno indevido |
| R3 | 5 retentativas com a mesma chave | 1 cobrança, 2 lançamentos, soma zero |
| R4 | Rajada de vendas simultâneas | outbox acumulou até 10 eventos e convergiu para 0, com **exatamente 1 evento por assento** |
| R7 | Consumidor sob carga | read model continuou avançando |
| R8 | PSP falhando em 50% das chamadas | 6 pedidos, **todos** em estado terminal |

### O bug que os cenários encontraram

O cenário R1 falhava porque o circuit breaker nunca abria. A causa era real e
está corrigida: um `4xx` chamava `onSuccess()` e **zerava o contador de falhas**.
Com o PSP fora do ar, a consulta respondia `404` e a cobrança respondia `503` —
e o `404` zerava o contador antes de o `503` conseguir abrir o breaker.

Um `4xx` agora é neutro: prova que o servidor está vivo, mas não prova que a
operação que falha está saudável. O teste de regressão está em
`tests/unit/breaker.test.ts`.

---

## Antifraude — 6 cenários de comportamento

`make scenarios` · todos conforme o esperado.

**Dois dos seis são compradores legítimos com sinais suspeitos reais, e a
asserção é que passem.** Um antifraude que quarentena todo mundo acerta os
cambistas e é inútil; um teste só com casos de fraude mede sensibilidade, não
precisão.

| # | Cenário | Faixa esperada | Score | Estado |
|---|---|---|---|---|
| C1 | Comprador legítimo: fila, 3 leituras do mapa, compra | 0 a 20 | **0,0** | livre |
| C2 | Bot solitário: 14 tentativas a cada 300 ms, sem ler o mapa | 70 a 85 | **75,0** | quarentena |
| C3 | Fazenda: 20 contas, 1 dispositivo, 1 IP, 3 cartões | 90 a 100 | **100,0** | quarentena |
| C4 | Conluio distribuído: 12 contas, 12 devices, 12 IPs | 80 a 100 | **91,9** | quarentena |
| C5 | Rotação de *fingerprint*: 1 conta, 15 devices, ritmo humano | 25 a 60 | **43,6** | **livre** |
| C6 | Família: 4 contas, 1 notebook, 1 Wi-Fi, 1 cartão, 6 lugares | 5 a 50 | **22,5** | **livre** |
| D1 | Mensagem envenenada escrita direto no tópico | — | — | dead letter, consumo seguiu |

O limiar de 70 cai entre **43,6 e 75,0** — folga de mais de 30 pontos para os
dois lados. O caso mais apertado é o bot solitário, a 5 pontos, e é o certo para
ser apertado: é a decisão mais difícil do conjunto.

### As evidências, em texto

O painel não mostra só um número. Cada fator que pontuou traz o motivo:

| Cenário | Fator dominante | Explicação registrada |
|---|---|---|
| C2 | `velocity` 38,0 | *intervalo entre ações com variação de apenas 0,0%: cadência constante demais para ser humana* |
| C3 | `account_correlation` 35,0 | *20 contas distintas compraram do mesmo IP nos últimos 10 minutos* |
| C4 | `account_correlation` 24,5 | *12 contas distintas compraram no setor MEZANINO em 30 segundos: aquisição coordenada* |
| C5 | `device_fingerprint` 35,0 | *esta conta apareceu em 15 dispositivos distintos nos últimos 10 minutos* |
| C6 | `account_correlation` 17,5 | *4 contas usaram o mesmo instrumento de pagamento* |

C6 é o resultado mais informativo da tabela: o sistema **notou**, pontuou e
explicou — e não agiu. É exatamente o comportamento desejado, e a proteção não
vem do peso, vem do piso da regra (4 contas num cartão está acima do piso de 2, e
por isso pontua; 4 contas num dispositivo está abaixo do piso de 3+, e por isso
quase não pontua).

### Por que os pesos são o que são

Os pesos não são um chute; eles codificam uma regra de decisão, verificada por
teste unitário:

- **nenhum fator sozinho quarentena** — o maior peso é 38, e 38 < 70;
- **dois fatores quaisquer no máximo quarentenam** — o menor par é 35 + 35 = 70.

A primeira versão somava exatamente 100 (30/25/25/20) e era cega, **por
construção**, ao bot solitário: uma conta com um dispositivo e um IP não consegue
disparar os dois fatores contextuais, então alcançava no máximo 50. Bastava ao
cambista não repetir dispositivo. Detalhe em
[ADR-0013](../adr/0013-pesos-e-limiar-do-score.md).

---

## Antifraude — o portão no checkout

`make risk-gate` · 15/15, em três fases. A fase 2 roda com o `risk-api`
**realmente parado** (`docker compose stop risk-api`), porque a pergunta central
não tem resposta simulável.

| Fase | Verificação | Resultado |
|---|---|---|
| 1 | Comprador sem histórico compra normalmente | HTTP 201 |
| 1 | A compra alimenta o antifraude pelo caminho assíncrono | 3 eventos registrados |
| 1 | Comprador em quarentena é barrado, com o motivo em texto | HTTP 403 |
| 1 | O bloqueio **não** consome assento nem cria pedido | 0 pedidos |
| 1 | `disabled` desliga a consulta sem apagar a marcação | vendeu, quarentena intacta |
| 1 | Liberação manual devolve o direito de comprar | HTTP 201 |
| 1 | **Quarentena em pleno voo → SAGA compensa com estorno** | *refund* + *release* |
| 2 | `fail_open` com o antifraude no chão | HTTP 201 |
| 2 | `fail_closed` com o antifraude no chão | HTTP 403 |
| 2 | Alternância de modo em tempo de execução | sem reinício |
| 2 | Circuit breaker impede espera por *timeout* | **194 ms** (mediana de 5) |
| 3 | A quarentena sobreviveu à indisponibilidade | HTTP 403 |
| 3 | O breaker fecha sozinho quando a dependência volta | consultas atendidas |

### O cenário mais caro, passo a passo

Com 2 s de latência injetada no PSP, a quarentena é aplicada **durante** a captura
do pagamento. O `saga_log` do pedido:

```
reserve             ok
charge              ok
risk.post-payment   quarantined   comprador em quarentena
compensate.refund   ok
compensate.release  ok
```

Pagamento capturado, quarentena aplicada, estorno emitido, assento devolvido. É a
prova de que a verificação de risco é **um passo da SAGA**, e não um porteiro na
entrada — a borda olha uma vez, no começo, e uma compra dura segundos.

### Três bugs reais que estes testes encontraram

| # | Defeito | Como apareceu |
|---|---|---|
| 1 | O cliente HTTP anunciava `content-type: application/json` em POST **sem corpo**, e o Fastify respondia 400. Todo POST sem corpo estava quebrado — inclusive `POST /charges/:sagaId/refund`. **O estorno nunca havia funcionado.** | Nenhum teste anterior levava a SAGA ao caminho de compensação com estorno |
| 2 | A compensação retentava **qualquer** erro indefinidamente. Com o 400 acima, a SAGA girou 40 s repetindo `payments respondeu 400`, e teria girado para sempre | Visível no `saga_log` do pedido travado em `COMPENSATING` |
| 3 | O Traefik **sobrescrevia** o `X-Forwarded-For`: todo o tráfego local chegava com um endereço só, e a regra de correlação via 127 contas nele — marcando todo mundo por associação | O fator de correlação teria sido inútil na demonstração |

Os três estão corrigidos, o primeiro com teste de regressão em
`tests/unit/breaker.test.ts`. Detalhe em
[ADR-0016](../adr/0016-risco-dentro-da-saga.md).

### O teste de fumaça foi quarentenado

Ao ligar a integração, a própria bateria de fumaça da Bilheteria passou a ser
bloqueada: `53 tentativas de compra nos ultimos 10 minutos`.

**O detector estava certo.** A verificação de contenção usa 40 contas disputando
o mesmo assento e a de idempotência dispara 50 requisições idênticas, tudo do
mesmo endereço — por construção, indistinguível de fraude. Um antifraude que não
quarentenasse isso estaria quebrado.

A lição é operacional e vale para qualquer sistema real: geradores de carga e
sondas sintéticas precisam de um caminho declarado fora do antifraude, senão a
própria monitoração acorda o plantão. Aqui isso é `risk_check_mode=disabled`, que
`make smoke` liga no início e devolve ao padrão no fim, com asserção nos dois
passos — e o portão ganhou teste próprio, mais forte do que uma asserção
incidental.

---

## Carga — o custo do antifraude no caminho crítico

`make load-risk-off && make load-risk-on && make compare-risk`

A integração põe uma chamada **síncrona** dentro do checkout, mais duas dentro da
SAGA. A pergunta que isso obriga a responder é quanto custa — e a resposta só vem
medindo o mesmo sistema com a verificação ligada e desligada, que é o que a flag
`risk_check_mode` permite fazer sem tocar em código.

200 VUs, 60 s, PSP a 250 ms, fila ligada a 40/s.

| Métrica | sem antifraude | com antifraude | Diferença |
|---|---|---|---|
| Compras confirmadas | 2.121 | 2.177 | +56 |
| p95 do checkout | 3.411 ms | 3.076 ms | −335 ms |
| p99 do checkout | 3.790 ms | 3.695 ms | −95 ms |
| **Erro no checkout** | **0,84%** | **2,54%** | **+1,7 p.p.** |

### Leitura do resultado

**O custo em latência fica abaixo da variação entre repetições.** Não é que o
antifraude acelere nada — é que a consulta é um `SELECT` por chave primária numa
projeção de leitura, atrás de um circuit breaker, e some no ruído de um checkout
que já gasta segundos com fila, hold e PSP.

**O custo real é a taxa de erro:** +1,7 ponto percentual de checkouts recusados.
Esses são compradores quarentenados. É o preço de a verificação valer alguma
coisa — um antifraude que não recusa ninguém não custa nada e não serve para nada.

---

## Carga — fila virtual, em dois pontos de operação

`make load-without-queue && make load-with-queue && make compare`

Esta é a medição que mais ensina, e só ensina porque foi feita **duas vezes, em
regimes diferentes**.

| | 200 VUs | | 600 VUs | |
|---|---|---|---|---|
| | sem fila | com fila | sem fila | com fila |
| Compras confirmadas | 2.488 | 2.198 | 1.669 | **2.724** |
| Erro no checkout | 2,07% | 1,43% | 1,12% | 2,15% |
| p95 do checkout | 4,70 s | 5,11 s | 10,04 s | **1,82 s** |
| p99 do checkout | 5,02 s | 6,36 s | 10,96 s | **2,10 s** |
| Pior caso | 5,44 s | 6,69 s | 12,47 s | **2,52 s** |
| Espera na fila (p95) | — | 3,32 s | — | 13,18 s |

**A 200 VUs a fila atrapalha.** Vende 12% menos e o p99 piora. O núcleo não está
saturado, e o controle de admissão vira espera pura.

**A 600 VUs ela vende 63% mais, com p99 5,2× menor.** Sem fila, o sistema roda
muito além do joelho: 19.260 iterações produzem apenas 1.669 compras, com o
checkout em 11 segundos. Com fila, 2.833 iterações produzem 2.724 compras.

### A conclusão que os dois pontos permitem

**A fila virtual não aumenta a capacidade do sistema — ela escolhe o ponto de
operação dele, e só compensa depois do joelho da curva.**

Abaixo da saturação é custo puro; acima, é a diferença entre um sistema que
entrega e um que se debate. A fila de espera nunca desaparece: sem controle de
admissão ela está escondida *dentro* de um checkout de 11 segundos, onde o
usuário não entende o que está acontecendo. Com ele, fica visível, comunicada e
mensurável — 13,2 s de espera declarada em troca de comprar em 2 segundos.

Uma versão anterior deste documento reportava a fila vencendo a 250 VUs. Aquele
número foi medido com um gerador que comprava sem pausa de leitura; ao corrigir o
gerador para o ritmo de uma pessoa, o mesmo ponto de operação inverteu de sinal.
**Os dois resultados estão certos** — e é justamente por isso que um único ponto
de medição não sustenta a conclusão.

---

## Metas não atingidas

Registradas como falha, e não como limiar afrouxado:

| Meta | Medido | Nota |
|---|---|---|
| `http_req_duration{tipo:leitura}` p95 < 300 ms | **~400 ms** | A consulta de assento livre sob 200 VUs nesta máquina. Não é efeito do antifraude: o valor é o mesmo com a verificação ligada e desligada |

---

## Contenção máxima

`make contention` · 120 usuários virtuais disputando um único setor.

| Métrica | Resultado |
|---|---|
| Assentos conquistados | 1.258 |
| Recusados por assento já tomado | 3 |
| **Erros de servidor (5xx)** | **0** |
| Invariantes após a rodada | todas vazias |

Sob contenção real, o sistema recusa com `409` em vez de falhar com `5xx`, e a
invariante do assento se mantém. É o teste que quebra sistemas baseados em
reserva otimista.

---

## Observabilidade

- **Jaeger:** **10 serviços** reportando. Um checkout com compensação produz um
  trace único de **43 spans** atravessando `edge → orders → inventory → payments
  → psp-sandbox` e também `edge → risk-event-api → risk-worker` e
  `orders → risk-api` — a venda e a decisão de risco na mesma tela.

  O `traceparent` viaja no **cabeçalho da mensagem Kafka**, e é isso que costura
  as duas metades. Sem essa propagação o rastro morreria na publicação, e o
  processamento do antifraude apareceria como um trace órfão, impossível de ligar
  ao checkout que o originou.
- **Prometheus:** **12 alvos**, todos saudáveis, em dois jobs separados
  (`bilheteria` e `riskshield`). A separação é deliberada: permite perguntar
  "o antifraude está saudável?" sem arrastar a venda junto.
- **Grafana:** painel `bilheteria` provisionado automaticamente, com latências por
  percentil, profundidade da fila, estado dos circuit breakers e passos da SAGA.
- **Painel do antifraude:** `http://localhost:3022/` — estatísticas, regras e
  pesos com efeito imediato, limiar, compradores por score, as evidências em texto
  e a dead letter queue.

---

## Deployment

`make canary PCT=10` · `make blue-green TO=green` · `make rollback`

| Cenário | Resultado |
|---|---|
| Balanceamento padrão (50/50) | 20 azul / 20 verde em 40 requisições |
| Canary a 10% | 54 azul / 6 verde em 60 requisições |
| Blue-green para verde | 40/40 no verde, troca completa |
| Rollback | 40/40 no azul |

A versão que atendeu cada requisição vem no header `x-app-version`, então a
distribuição é verificável e não precisa ser acreditada.

---

## Arquivos brutos

| Arquivo | Conteúdo |
|---|---|
| `sem-fila.json` / `.txt` | Sumário completo do k6, rodada sem fila |
| `com-fila.json` / `.txt` | Sumário completo do k6, rodada com fila |
| `comparacao.txt` | Comparação lado a lado, gerada por `make compare` |
| `contencao.json` / `.txt` | Sumário do cenário de contenção máxima |
