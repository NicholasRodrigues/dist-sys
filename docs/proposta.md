# Proposta de Tema Próprio

**Disciplina:** Engenharia de Sistemas Distribuídos — 2026.1
**Formato:** proposta escrita exigida pela Seção 3 do documento da disciplina
**Título:** Bilheteria — Plataforma Distribuída de Venda de Ingressos sob Pico de Demanda

---

## Problema

A abertura de vendas de um evento de grande porte é um dos poucos cenários em que um sistema
comercial enfrenta, simultaneamente, todas as pressões clássicas de sistemas distribuídos. Em
uma janela de poucos minutos, o sistema recebe de 100 a 1000 vezes o tráfego médio; a demanda se
concentra em um subconjunto pequeno de recursos (os mesmos setores, os mesmos assentos), gerando
contenção severa; existe uma invariante de negócio que não admite violação — **o mesmo assento
não pode ser vendido duas vezes** — e existe dinheiro real trafegando por uma rede externa não
confiável, na qual um *timeout* não significa que a cobrança falhou. Somam-se a isso adversários
com incentivo econômico direto: bots de cambistas que consomem estoque para revenda.

O problema é interessante academicamente porque força uma decisão explícita de consistência: a
resposta ingênua ("use consistência forte em tudo") não escala no pico, e a resposta oposta
("consistência eventual, resolve depois") viola a invariante do assento. A arquitetura precisa
segmentar o sistema, colocando garantias ACID exatamente onde o assento e o dinheiro estão, e
consistência eventual em todo o resto.

## Solução proposta

Uma plataforma de seis microsserviços em que o tráfego passa por um **controle de admissão** (fila
virtual) antes de tocar o núcleo transacional. O caminho de leitura (catálogo, mapa de assentos) é
servido por um *read model* desnormalizado com cache, alimentado por eventos. O caminho de escrita
passa por um serviço de inventário com garantias ACID, que emite reservas temporárias com
expiração. A compra é conduzida por uma **SAGA orquestrada** que coordena reserva, cobrança via
PIX, emissão do ingresso e as compensações correspondentes a cada falha. O fluxo financeiro é
registrado em um **ledger de dupla entrada** imutável, com idempotência garantida ponta a ponta, de
forma que uma retentativa de cobrança nunca produz dois lançamentos.

O número de serviços é resultado de uma regra explícita, e não de uma preferência estética: **um
serviço só existe se tiver uma fronteira de consistência própria ou um perfil de escala próprio.**
Aplicar essa regra ao desenho inicial cortou quatro dos dez serviços originalmente previstos sem
perder um único padrão arquitetural. O mesmo critério de necessidade foi aplicado à
infraestrutura: o escopo contém o que a especificação exige, o que o domínio exige para estar
correto, e apenas o bônus que sai quase de graça — com cada ausência justificada por escrito.

## Padrões arquiteturais aplicados

O requisito mínimo é de três padrões da Seção 6; o projeto aplica cerca de quarenta tópicos,
distribuídos assim:

- **Confiabilidade:** SAGA/Orchestration, Transactional Outbox, Circuit Breaker, Retry + DLQ,
  Event Sourcing, Event Driven Architecture, Choreography, Bulkhead/Isolation, ACID, Idempotency,
  Anti-corruption Layer, Strong vs Eventual Consistency
- **Escalabilidade:** Load Balancing, Queues/PubSub/Fanout, Backends for Frontends, Aggregator,
  Database per Service, Stateless/Stateful, Service Discovery, Traffic Sharding, Containers
- **Desempenho:** Caching, Cache-Aside, CQRS, Materialized View, Polyglot Persistence,
  SYNC vs ASYNC, Streaming vs Messaging, Rate Limiting/Throttling, Load Shedding
- **Segurança:** API Gateway, JWT com validação de claims, Rate Limiting, Anti-corruption Layer,
  assinatura do ingresso
- **Deployment:** Blue-Green, Canary Release, pipeline de CI/CD, Immutable Deployment, Feature Flag

O escopo de segurança foi deliberadamente reduzido a segurança de borda; os temas expandidos
(Zero Trust, supply chain, DevSecOps) são bônus da Seção 8 e ficaram de fora, com o custo de cada
um documentado.

## Áreas técnicas cobertas

O requisito mínimo é de duas áreas; o projeto cobre as cinco — segurança, escalabilidade,
desempenho, confiabilidade e deployment — com profundidade documentada em
[`padroes.md`](padroes.md), que mapeia cada tópico da Seção 6 ao ponto do código onde ele é
implementado e ao teste que o comprova.

## Tecnologias previstas

TypeScript sobre Node.js (Fastify) nos serviços de aplicação; PostgreSQL com banco lógico por
serviço; Redis para cache e para o estado da fila virtual; Redpanda (compatível com Kafka) como
barramento de eventos; Traefik como balanceador e mecanismo de canary e blue-green; OpenTelemetry
com Prometheus, Grafana e Jaeger para observabilidade; k6 para os testes de carga; e um PSP PIX
falso, escrito por nós, que expõe injeção de latência e erro para os testes de resiliência.

Tudo executa em **Docker Compose**, que é o que o checklist da Seção 7 pede.

A POC 2 da Seção 4.2 — o **antifraude mínimo viável** — foi construída sobre este mesmo domínio,
como um segundo sistema de três serviços (`risk-event-api`, `risk-worker`, `risk-api`) ligado à
bilheteria por dois contratos estreitos: um tópico no barramento e uma consulta de status. Ver
[`poc2/plano.md`](poc2/plano.md).

São **dezoito contêineres** no total: quinze da bilheteria e três do antifraude. O PostgreSQL e o
Redpanda são reaproveitados, com banco lógico e tópico próprios.

## Critérios de sucesso mensuráveis

| # | Critério | Meta | Como é medido |
|---|---|---|---|
| 1 | Overselling | **Exatamente zero** assentos vendidos em duplicidade | Consulta de invariante no banco após cada rodada de carga |
| 2 | Latência de leitura | p95 < 100 ms no mapa de assentos sob pico | k6, percentis p50/p95/p99 |
| 3 | Latência de compra | p95 < 500 ms com 1.000 usuários simultâneos | k6, cenário de flash sale |
| 4 | Idempotência | 200 requisições concorrentes com a mesma chave produzem 1 pedido e 1 lançamento | Teste de concorrência + auditoria do ledger |
| 5 | Resiliência | Queda do serviço de pagamentos não produz assento preso nem pedido órfão | O serviço é derrubado no meio da SAGA durante a carga |
| 6 | Admissão | Com fila virtual, erro 5xx sob pico cai abaixo de 1% | Comparação A/B: mesmo cenário com e sem fila |
| 7 | Balanço contábil | Soma de débitos igual à soma de créditos em todo instante | Verificação contínua no ledger |

## Justificativa do tema próprio

O tema absorve o escopo de duas das POCs sugeridas — sincronia em tempo real (POC 1) e ledger com
PIX e idempotência (POC 3) — integrando-as em um domínio único e coerente, em vez de tratá-las
como exercícios isolados. Isso permite demonstrar como os padrões interagem
sob pressão: a fila virtual existe porque o inventário é ACID; a SAGA existe porque o PIX é
externo e falível; o rate limiting vive na borda porque o estoque é escasso e disputado, e conter
abuso depois de o assento ter sido consumido não serve para nada.
