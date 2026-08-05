# Mapa de Padrões

Cada linha liga um tópico da Seção 6 do documento da disciplina ao ponto do sistema onde ele é
implementado e ao teste que o comprova. A coluna **prova** é o que importa na avaliação: um padrão
sem evidência é uma afirmação.

**Requisito mínimo: 3 padrões e 2 áreas. Cobertura do projeto: 5 áreas, ~40 tópicos.**

O que ficou de fora está listado no final, com o motivo — ver [`escopo.md`](escopo.md) para o
raciocínio completo.

---

## 6.4 Confiabilidade — a área central do projeto

| Tópico | Onde | Prova |
|---|---|---|
| SAGA / Orchestration | `orders` conduz reserva, cobrança, emissão e as compensações | Falha injetada em cada passo; assento sempre liberado |
| Transactional Outbox | `inventory`, `orders` e `payments` gravam o evento na mesma transação do estado | Crash entre commit e publicação; nenhum evento se perde |
| Circuit Breaker | Clientes de `payments`, `inventory` e do PSP | PSP falso adiciona latência; breaker abre e fecha, visível no Grafana |
| Retry Pattern e DLQ | Consumidores com backoff exponencial e *parking lot* | Mensagem envenenada vai para a DLQ e é reprocessada por comando |
| Bulkhead / Isolation | Pools de conexão separados por dependência; `realtime` isolado do núcleo | Saturação do `realtime` não afeta o checkout |
| Event Sourcing | Ledger do `payments` é append-only; a máquina de estados da SAGA guarda cada transição | Saldo reconstruído a partir dos lançamentos |
| Event Driven Architecture | Todo o caminho assíncrono, sobre Redpanda | Diagrama de fluxo com contratos de evento versionados |
| Choreography | Read model, notificação e presença reagem a eventos sem orquestrador | Novo consumidor entra sem alterar o produtor |
| Strong vs Eventual Consistency | Fronteira explícita entre núcleo ACID e periferia | Janela de convergência medida sob carga |
| ACID | Reserva e confirmação de assento em transação única | 200 requisições concorrentes no mesmo assento |
| Idempotency | `Idempotency-Key` do cliente até o ledger | Requisição repetida produz exatamente um efeito |
| Anti-corruption Layer | `payments` isola o contrato do PSP atrás de um modelo interno | Troca do PSP falso por outro sem tocar em `orders` |
| Tight vs Loose Coupling | Síncrono só onde a resposta é necessária para continuar | Adicionar consumidor não altera a latência do checkout |

## 6.3 Desempenho

| Tópico | Onde | Prova |
|---|---|---|
| Caching de dados e objetos | Mapa de assentos e catálogo em Redis | p95 com e sem cache, lado a lado |
| Cache-Aside Pattern | `catalog` lê do cache, cai para o banco e repopula | Taxa de acerto no painel do Grafana |
| SYNC vs ASYNC | Compra é síncrona; read model, presença e notificação são assíncronos | Latência do checkout não cresce ao adicionar consumidores |
| Streaming vs Messaging | Redpanda como log de eventos; fila de trabalho para notificação | Justificativa documentada da diferença de uso |
| CQRS | Escrita no `inventory`, leitura no `catalog`, modelos distintos | Schema de leitura difere do de escrita |
| Desnormalização / Materialized View | Mapa de assentos pré-computado por sessão | Uma leitura serve a tela inteira |
| Polyglot Persistence | Postgres para transacional, Redis para efêmero, Redpanda como log | Cada escolha justificada pelo padrão de acesso |
| Database-per-service | Bancos lógicos isolados por credencial, sem query cruzando fronteira | Nenhuma query atravessa serviço |
| Rate Limit / Throttling | `edge`, por identidade e por IP; e a taxa de admissão da fila | Curva de admissão contra curva de chegada |
| Load Shedding | `edge` descarta navegação quando a fila interna passa do limiar | Sob sobrecarga, checkout continua enquanto navegação degrada |

## 6.2 Escalabilidade

| Tópico | Onde | Prova |
|---|---|---|
| Load Balancing | Traefik distribui entre réplicas de `edge` e `catalog` | Réplica derrubada sob carga sem erro visível |
| Queues, PubSub e Fanout | Redpanda entrega o mesmo evento a `catalog`, `realtime` e ao consumidor de notificação | Um evento produzido, três consumidores independentes reagem |
| Arquitetura com Containers | Todo o sistema em Docker Compose | `docker compose up` sobe o ambiente completo |
| Stateless, Stateful e Imutabilidade | `edge` e `catalog` stateless; `realtime` explicitamente stateful | Serviço stateless reiniciado sob carga sem perda |
| Service Registry e Discovery | Descoberta por DNS da rede do Compose | Escala de 1 para 3 réplicas sem reconfiguração |
| Backends for Frontends | `edge` expõe agregadores distintos para comprador e organizador | Uma tela, uma requisição |
| Aggregator / API Composition | `edge` compõe o checkout a partir de `catalog`, `inventory` e do estado da fila | Número de chamadas com e sem composição |
| Traffic Sharding | Partição do tópico por `eventId` | Eventos do mesmo assento sempre na mesma partição |
| Monolito vs Microsserviços | [`adr/0001`](adr/0001-microsservicos.md), com a regra de extração e as extrações rejeitadas | Trade-off documentado com custo assumido |

## 6.5 Deployment

| Tópico | Onde | Prova |
|---|---|---|
| Esteira de Pipeline, Build e Deployment | GitHub Actions: lint, teste, build e publicação de imagem | Pipeline verde |
| Immutable Deployment | Imagens versionadas por digest, nunca `latest` | Rollback por digest |
| Estratégia de Deployment | Documentada em [`adr/0010`](adr/) com o critério de escolha | Comparação das opções |
| Blue-Green | Dois conjuntos do `catalog` com troca de peso no Traefik | Troca de tráfego e rollback demonstrados |
| Canary Release | Pesos progressivos 10% → 50% → 100%, com métrica de erro observada | Canary com erro injetado é revertido |
| Feature Flag / Toggle | Flags em Redis, alternáveis em tempo de execução | Fila virtual ligada e desligada ao vivo, sem novo deploy |

## 6.1 Segurança — deliberadamente reduzida

O escopo aqui foi cortado conscientemente, e o corte está justificado em [`escopo.md`](escopo.md).
O que ficou é segurança de borda, que é o que este domínio realmente exige.

| Tópico | Onde | Prova |
|---|---|---|
| API e API Gateway Pattern | `edge` — ponto único de entrada, autenticação, autorização e rate limiting | Requisição sem token barrada na borda; rate limit atinge 429 no limiar |
| JWT: assinatura, expiração e claims | Emitido por um módulo do `edge`, validado em cada serviço | Token expirado, com escopo insuficiente e com assinatura adulterada — três recusas |
| Rate Limiting como defesa | Por identidade e por IP, mais a admissão da fila | Cenário de abuso contido sem afetar tráfego legítimo |
| Anti-corruption Layer | Fronteira com o PSP | Modelo interno independente do contrato externo |
| Assinatura do ingresso | QR assinado com Ed25519, verificável offline na portaria | QR forjado é rejeitado; QR válido reapresentado é rejeitado na segunda vez |
| Supply Chain (opcional) | SBOM com Syft e varredura com Grype no CI | Artefato publicado pelo pipeline |

---

## Fora de escopo, e por quê

Declarar isto é parte da entrega, não uma omissão. A Seção 8 autoriza adaptar escopo com
justificativa documentada.

| Tópico da Seção 6 | Por que ficou de fora |
|---|---|
| Zero Trust, mTLS, Service Mesh | Custo de certificados em seis serviços; bônus não exigido |
| OAuth 2.0 e OIDC completos | Keycloak cortado; JWT cobre assinatura, expiração e claims |
| Secrets Management com Vault | Variáveis de ambiente fora do versionamento resolvem na escala da demo |
| Segurança de containers e Kubernetes | Kubernetes não é exigido — o checklist aceita Docker Compose |
| Criptografia pós-quântica | Bônus; a assinatura Ed25519 do QR permanece |
| Observabilidade de segurança, SIEM | Bônus |
| Change Data Capture | O Transactional Outbox resolve o mesmo problema e também é tópico listado |
| Database Sharding, Consistent Hashing, Shuffle Sharding | A contenção real se concentra em poucos setores; fragmentar não divide o ponto quente |
| Serverless, Multi-tenant | Incompatíveis com WebSocket longo e com o escopo do domínio |
| Request Hedging | Faz sentido com réplicas de leitura geograficamente distribuídas, que não existem aqui |
| Sidecar, Ambassador, Adapter, Strangler Fig | Padrões de migração e de malha; não há legado a estrangular nem malha a operar |
| Shadow Deployment | Exigiria duplicar tráfego de escrita, o que colide com a invariante do assento |

---

## Cobertura por dimensão de avaliação

| Dimensão | Peso | Onde este projeto entrega |
|---|---|---|
| Arquitetura e Design | 30% | ADRs, C4, trade-offs com custo assumido, e a regra de extração de serviços |
| Implementação e Código | 25% | Monorepo organizado, testes, Docker Compose, CI |
| Videocast | 20% | Roteiro em [`roadmap.md`](roadmap.md), com a compensação da SAGA vista no trace |
| Testes e Validação | 15% | [`plano-de-testes.md`](plano-de-testes.md), com métricas coletadas e arquivadas |
| Originalidade e Profundidade | 10% | Canary e blue-green (Seção 8), e o escopo decidido de [`escopo.md`](escopo.md) |
