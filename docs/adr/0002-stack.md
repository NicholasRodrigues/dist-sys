# ADR-0002 — Adotar TypeScript, Fastify, PostgreSQL, Redis e Redpanda

- **Status:** Aceito
- **Data:** 2026-08-04
- **Dono:** T1 — Plataforma e Deployment
- **Área técnica:** Escalabilidade e Desempenho

## Contexto

Seis serviços, cinco pessoas, execução em paralelo e uma demonstração que precisa subir por
completo em uma máquina de desenvolvimento comum. A escolha da stack é menos sobre desempenho
absoluto e mais sobre **quantas decisões ela poupa** e quanto atrito ela remove entre trilhas.

Existe também uma restrição de honestidade experimental: o projeto mede latência e vazão e usa
esses números para sustentar ADRs. A stack não pode introduzir ruído grande o suficiente para
distorcer a conclusão — se a fila virtual melhora o p99, isso precisa ser efeito da arquitetura,
não do runtime.

## Decisão

Um único idioma nos serviços de aplicação — **TypeScript sobre Node.js com Fastify** — com
**PostgreSQL** como banco transacional (um por serviço), **Redis** para cache e estado efêmero, e
**Redpanda** como barramento de eventos.

| Componente | Escolha | Razão determinante |
|---|---|---|
| Linguagem e framework | TypeScript + Fastify | Um idioma só mantém cinco pessoas circulando entre trilhas sem custo de troca de contexto; tipos compartilhados tornam os contratos entre serviços verificáveis em tempo de compilação |
| Banco transacional | PostgreSQL | `SELECT ... FOR UPDATE` e *constraints* únicas parciais resolvem o overselling de forma direta e auditável (ADR-0003) |
| Cache e estado efêmero | Redis | As estruturas certas para os problemas certos: `ZSET` para posição na fila, chaves com TTL para cache-aside e para holds rápidos |
| Barramento | Redpanda | Compatível com Kafka, binário único sem ZooKeeper, e log particionado e ordenado por chave — o modelo exato de que a Transactional Outbox e o Event Sourcing precisam |
| Borda | Traefik | Balanceamento, pesos de canary e roteamento por header por configuração declarativa |
| Identidade | JWT assinado, emitido por um módulo do `edge` | Cobre assinatura, expiração e validação de claims sem o custo de configurar um provedor OIDC. A troca por Keycloak é o item 3 do caminho de volta em [`escopo.md`](../escopo.md) |
| Observabilidade | OpenTelemetry → Prometheus, Grafana, Jaeger | Não é enfeite: a dimensão de Testes exige métricas coletadas e o videocast exige demonstração funcional. Instrumentar desde a Fase 0 evita cegueira na fase em que ela custa caro |
| Execução | Docker Compose | O checklist da Seção 7 pede "Docker Compose ou equivalente". Kubernetes não é exigido e ficou fora |

## Alternativas consideradas

| Alternativa | Por que foi rejeitada |
|---|---|
| Go nos serviços de núcleo | Melhor desempenho e concorrência mais previsível sob contenção. Rejeitado porque introduziria duas stacks, dois pipelines e duas curvas de aprendizado numa equipe de cinco pessoas — o custo de coordenação superaria o ganho de latência, que a fila virtual já regula |
| Java com Spring Boot | Ecossistema maduro para os padrões da disciplina, mas consumo de memória por serviço tornaria a execução da stack inteira em Compose desconfortável na máquina de um estudante |
| Kafka original | Mesmo modelo, com ZooKeeper ou KRaft e consumo de recursos bem maior. Redpanda entrega o mesmo protocolo com uma fração do peso |
| RabbitMQ | Excelente como fila de trabalho, mas não oferece log particionado retido, que é o que a outbox e o Event Sourcing exigem |
| MongoDB no inventário | Transações existem, mas o modelo de bloqueio e as garantias sob contenção alta são menos previsíveis do que `SELECT ... FOR UPDATE` — e previsibilidade é o requisito, não flexibilidade de schema |

## Consequências

**Esperadas**

- Contratos entre serviços verificáveis em tempo de compilação, por tipos compartilhados no monorepo
- Um único pipeline de CI, um único conjunto de ferramentas de lint e teste
- Node.js é de thread única por processo: trabalho pesado de CPU — cálculo de risk score,
  assinatura em lote — precisa ir para worker threads ou aceitar bloqueio do event loop
- Uma instância de Postgres com bancos lógicos separados por credencial mantém o isolamento de schema sem multiplicar contêineres
- A stack não é a mais rápida possível, e isso precisa ser declarado na apresentação para que os
  números medidos sejam lidos corretamente: comparações relativas entre configurações do **mesmo**
  sistema, não benchmarks absolutos

**Observadas**

_A preencher após a Fase 3._

## Condição de reversão

Se o cenário C2 mostrar o `inventory` limitado por CPU e não por contenção de banco, esse serviço
específico é candidato a reescrita em Go — é o único do sistema em que a diferença de runtime
apareceria no resultado. Os demais permanecem.
