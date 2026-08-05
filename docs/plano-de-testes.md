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

Rampa de 0 a 1.000 usuários virtuais em 60 segundos, mantidos por 5 minutos, contra um evento de
40.000 assentos.

| Métrica | Meta |
|---|---|
| p50 / p95 / p99 do checkout | p95 < 500 ms |
| p95 do mapa de assentos | < 100 ms |
| Taxa de erro 5xx | < 1% |
| Overselling | zero |

### C2 — Contenção máxima

Todos os usuários virtuais disputam **o mesmo setor de 500 lugares**. É o teste que quebra sistemas
que dependem de otimismo: mede a degradação sob contenção real, não sob carga distribuída.

Meta: zero overselling, e latência que degrada de forma previsível em vez de colapsar.

### C3 — Fila virtual: com e sem

O gráfico mais importante da apresentação. Mesmo cenário do C1, executado duas vezes, com a fila
desligada e ligada pela feature flag.

**Resultado medido** (250 VUs, 45 s, PSP com latência realista de 250 ms, pool de 8 conexões):

| | Sem fila | Com fila | |
|---|---|---|---|
| p99 do checkout | 5,01 s | **2,70 s** | −46% |
| Erro no checkout | 1,46% | **0,36%** | −75% |
| Pior caso | 8,62 s | **2,76 s** | −68% |
| Compras confirmadas | 2.355 | 1.926 | −18% |
| Espera na fila (p95) | — | 5,57 s | custo declarado |

O ponto a dizer em voz alta na apresentação **não** é "a fila faz vender mais" — a medição mostrou
que não é isso que acontece nesta faixa de carga. O ponto verdadeiro é melhor:

**A fila não aumenta a capacidade do sistema — ela escolhe o ponto de operação dele.**

Sem fila, o sistema roda além do joelho da curva: entrega mais compras brutas, com o checkout em 5
segundos no p99. A fila de espera não desapareceu — ela está escondida *dentro* de um checkout
lento, onde o usuário não entende o que está acontecendo. Com fila, a espera fica visível,
comunicada e mensurável, e o checkout responde em menos de um terço do tempo.

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

## Integração

Exigido nominalmente pelo checklist. O teste ponta a ponta (`make smoke`) **é** a bateria de
integração: ele roda contra o sistema completo no ar — Postgres, Redis e Redpanda reais, seis
serviços em processos separados — e verifica 28 propriedades, incluindo as consultas de invariante
nos quatro bancos.

| # | Coberto por |
|---|---|
| I1 | `inventory` contra Postgres: hold, expiração, confirmação e liberação |
| I2 | SAGA completa e compensações, verificadas no `saga_log` |
| I3 | Ledger fecha em zero após as compras |
| I4 | Outbox publica e converge (cenário R4) |
| I5 | Read model do `catalog` reflete as vendas |
| I6 | QR válido, forjado e reapresentado |

Os testes **unitários** (`make test-unit`, 28 testes) cobrem o que não precisa de infraestrutura:
JWT, assinatura do ingresso, classificação de erro e circuit breaker.

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
[`resultados/`](resultados/README.md): 28 verificações ponta a ponta, 6 cenários
de resiliência, 6 invariantes e a comparação de carga com e sem fila virtual.

Resumo do que foi medido:

| Cenário | Resultado |
|---|---|
| C1 flash sale, 250 VUs | p99 do checkout 5,01 s sem fila contra 2,70 s com fila |
| C2 contenção máxima, 120 VUs | 0 erros de servidor, invariantes intactas |
| C3 com e sem fila | erro no checkout −75%, pior caso −68% |
| R1 a R8 resiliência | 6/6 passaram |
| Invariantes | 6/6 vazias |

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
