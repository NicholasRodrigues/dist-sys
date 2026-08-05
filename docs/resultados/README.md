# Resultados medidos

Evidências coletadas em execução real do sistema. A dimensão *Testes e Validação*
(15% da nota) exige "métricas coletadas", e o checklist da Seção 7 exige "plano
**e resultados** de testes".

**Ambiente de medição:** 4 vCPU, 16 GB de RAM, Docker Compose com os 14
contêineres no mesmo host — incluindo o gerador de carga. Os números absolutos
são, portanto, limitados pela máquina; o que vale é a **comparação relativa entre
configurações do mesmo sistema**, que é como todas as conclusões abaixo estão
construídas.

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

## Teste ponta a ponta — 28 verificações

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

## Carga — fila virtual com e sem

`make load-without-queue && make load-with-queue && make compare`

250 usuários virtuais, 45 segundos, evento de 40.000 assentos, PSP com latência
realista de 250 ms, pool de 8 conexões no núcleo transacional.

| Métrica | Sem fila | Com fila | Diferença |
|---|---|---|---|
| Compras confirmadas | 2.355 | 1.926 | −18,2% |
| Taxa de sucesso do checkout | 98,25% | 99,38% | +1,2% |
| Erro no checkout | 1,46% | 0,36% | **−75,3%** |
| p95 do checkout | 4,55 s | 2,31 s | **−49,4%** |
| p99 do checkout | 5,01 s | 2,70 s | **−46,2%** |
| Pior caso do checkout | 8,62 s | 2,76 s | **−68,0%** |
| Assentos perdidos na disputa | 35 | 7 | −80,0% |
| Espera na fila (p95) | — | 5,57 s | custo declarado |

### Leitura do resultado

**A fila virtual não aumenta a capacidade do sistema — ela escolhe o ponto de
operação dele.**

Sem fila, o sistema roda além do joelho da curva: entrega mais compras brutas,
mas o checkout chega a 5 segundos no p99 e a leitura do mapa degrada junto. A
fila de espera continua existindo — ela só está **escondida dentro de um checkout
lento**, onde o usuário não entende o que está acontecendo.

Com fila, o mesmo sistema entrega quase o mesmo número de compras com metade da
latência, um quarto dos erros, e a espera movida para um lugar visível e
comunicado.

As 429 compras a menos são o preço da taxa de admissão configurada (40/s).
Subi-la aproxima as duas vazões; passar do joelho devolve a latência ruim. **Esse
ajuste é a decisão de engenharia que a fila torna explícita** — sem ela, o
sistema opera onde a carga mandar.

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

- **Jaeger:** 7 serviços reportando. Um checkout produz um trace de **25 spans**
  atravessando `edge → orders → inventory → payments → psp-sandbox`, com a SAGA
  inteira visível em uma tela.
- **Prometheus:** 9 alvos, todos saudáveis.
- **Grafana:** painel `bilheteria` provisionado automaticamente, com latências por
  percentil, profundidade da fila, estado dos circuit breakers e passos da SAGA.

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
