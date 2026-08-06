# Roadmap de Execução

## Como este plano é organizado

Não por dias, mas por **fases com dependência explícita**. Cinco pessoas trabalhando em paralelo
não são limitadas por tempo de digitação — são limitadas por bloqueio mútuo. O que este documento
resolve é a ordem: o que precisa existir antes de que, e o que pode acontecer ao mesmo tempo sem
ninguém esperar por ninguém.

A regra que mantém cinco trilhas paralelas destravadas: **contratos primeiro, implementação
depois.** Os schemas de evento e os contratos de API dos serviços são definidos e mergeados na
Fase 0, antes de qualquer lógica. A partir daí cada trilha implementa contra um contrato estável
e pode gerar *mocks* das dependências que ainda não existem.

---

## Trilhas e donos

Cada integrante é dono de uma trilha ponta a ponta: código, testes, ADRs e o trecho
correspondente da apresentação. Isso garante contribuição visível de todos no histórico de
commits — item explícito do checklist da Seção 7 e da nota individual.

| Trilha | Dono | Escopo | ADRs de responsabilidade |
|---|---|---|---|
| **T1 — Plataforma e Deployment** | | Docker Compose, Traefik, CI, observabilidade, canary e blue-green | 0001 (serviços), 0002 (stack), 0009 (escopo), 0010 (deployment) |
| **T2 — Borda e Admissão** | | `edge` — gateway, fila virtual, rate limit, load shedding, JWT — e a interface estática | 0007 (fila virtual), 0011 (segurança de borda) |
| **T3 — Núcleo de Vendas** | | `inventory` e `catalog` | 0003 (consistência forte), 0006 (idempotência) |
| **T4 — Transações e Ingresso** | | `orders` — SAGA, emissão do QR, check-in — barramento, outbox e DLQ | 0004 (SAGA), 0005 (outbox), 0011 (cripto do ingresso) |
| **T5 — Dinheiro e Presença** | | `payments` — ledger e ACL do PIX — o `psp-sandbox` e o `realtime` | 0008 (ledger) |

Seis serviços para cinco pessoas, com o `realtime` sendo o menor deles. O front-end é de
responsabilidade compartilhada, atribuído conforme cada trilha atinge seu marco.

A divisão não é por serviço, e sim por **trilha**: cada integrante é dono de um conjunto coerente
de decisões, não de um diretório. É por isso que a emissão do ingresso pertence a T4 mesmo sendo um
módulo dentro do `orders` — quem entende a SAGA é quem entende por que o QR é emitido na mesma
transação da confirmação.

---

## Fase 0 — Fundação

**Destrava todo o resto. Nada em paralelo antes disso estar mergeado.**

- Monorepo com workspaces, TypeScript, ESLint, Prettier, Vitest
- `docker-compose.yml` com Postgres, Redis, Redpanda, Traefik, `psp-sandbox`, Prometheus, Grafana e Jaeger
- **Contratos**: schemas de todos os eventos e OpenAPI de todos os serviços — o artefato mais
  importante da fase
- Esqueleto dos seis serviços com `/health`, `/metrics` e OpenTelemetry já instrumentado
- GitHub Actions rodando lint, teste e build
- `Makefile` com `up`, `seed`, `test`, `load`, `demo`

**Marco:** `make up` sobe tudo, `/health` verde em todos os serviços, um trace atravessando dois
serviços aparece no Jaeger.

## Fase 1 — Caminho feliz

Todas as trilhas em paralelo, cada uma contra os contratos da Fase 0.

- T3: `inventory` com reserva ACID, hold com TTL, reaper de expiração; `catalog` com read model
- T4: `orders` com a máquina de estados e a SAGA completa, incluindo compensações
- T5: `payments` com PSP PIX simulado e ledger de dupla entrada
- T4: emissão do QR assinado na mesma transação da confirmação
- T2: `edge` com autenticação e roteamento
- T1: seed de 40.000 assentos, painéis do Grafana, pipeline publicando imagens

**Marco:** uma compra ponta a ponta, do catálogo ao QR, com trace distribuído completo e as cinco
consultas de invariante vazias.

## Fase 2 — Resiliência

O sistema já vende; agora ele precisa sobreviver.

- Transactional Outbox nos três serviços que publicam
- Circuit breaker, timeout e retry com backoff em todos os clientes
- DLQ com *parking lot* e comando de replay
- Bulkhead: pools separados por dependência
- Reconciliação: o orquestrador consulta o estado real antes de compensar
- Cenários R1 a R8 do plano de testes, com falhas injetadas pelo `psp-sandbox` e por `docker compose stop`

**Marco:** todos os cenários de resiliência passam, e a bateria de invariantes continua vazia
após cada injeção de falha.

## Fase 3 — Escala e desempenho

- Módulo de fila virtual no `edge`: fila em Redis, taxa de admissão configurável e token de admissão
- Cache-aside no `catalog`, com métrica de taxa de acerto
- Load shedding por prioridade no gateway
- Réplicas e balanceamento no Traefik
- Particionamento por `eventId` no barramento
- `realtime` com WebSocket para mapa e posição na fila
- Cenários C1 a C4 do k6, com coleta de percentis

**Marco:** o gráfico do C3 — com e sem fila — pronto e reproduzível. É a evidência central da
apresentação.

## Fase 4 — Deployment e segurança de borda

Duas coisas pequenas, juntas porque nenhuma das duas ocupa uma fase inteira.

- Emissão e validação de JWT no `edge`, com claims, escopos e expiração
- Assinatura Ed25519 do QR e validação idempotente no check-in
- Blue-green do `catalog` por peso no Traefik, com rollback
- Canary progressivo com métrica de erro observada
- Imagens versionadas por digest, nunca `latest`
- Opcional: SBOM com Syft e varredura com Grype no CI — cinco linhas de YAML, e a única porta de
  entrada barata para a "valorização especial" de supply chain da Seção 8
- Cenários D1 a D3

**Marco:** um canary com erro injetado é revertido, com o gráfico registrando o momento.

## Fase 5 — Evidência e narrativa

- Rodada final completa de todos os cenários, com evidências arquivadas em `docs/resultados/`
- ADRs revisados: o campo de consequências preenchido com o que **realmente** aconteceu, não com
  o que se esperava. Um ADR cuja consequência foi escrita antes do teste é ficção
- C4 atualizado para refletir o sistema como construído
- README final com instruções verificadas em máquina limpa
- Seção de uso de IA preenchida com honestidade — **a omissão desclassifica a entrega**
- Videocast gravado

---

## Congelamento

A partir do início da Fase 5, nenhuma funcionalidade nova entra. O que estiver incompleto é
documentado como trabalho futuro, com justificativa. Um sistema menor que funciona na demo vale
mais que um sistema maior que falha ao vivo — e a Seção 8 permite explicitamente adaptar escopo
com justificativa documentada, o que [`escopo.md`](escopo.md) faz item por item.

Se sobrar tempo antes do congelamento, a ordem de reintrodução dos itens cortados está no mesmo
documento. Depois do congelamento, nada entra: um bônus pela metade custa mais em credibilidade do
que rende em pontos.

---

## Roteiro do videocast

A entrega é a **POC 2 — antifraude**. O roteiro reflete isso: a bilheteria é
apresentada como domínio hospedeiro em dois minutos, e o resto do tempo vai para
o Risk-Shield. Ensaiar com cronômetro; o tempo é critério de avaliação.

> **Pendência com o professor:** a Seção 1.2 diz 12–15 min e o checklist da
> Seção 7 diz 15–30. Os dois roteiros abaixo cobrem os dois casos — o de 15 min
> é o de 25 sem os blocos marcados como opcionais.

| Bloco | Min | Quem | Conteúdo |
|---|---|---|---|
| 1. O problema real do antifraude | 2 | T2 | Não é pegar fraude — é pegar fraude **sem bloquear a família que comprou seis lugares do mesmo notebook**. O custo do falso positivo é imediato e visível |
| 2. O domínio hospedeiro, rápido | 2 | T1 | A bilheteria em uma tela: 40.000 assentos, overselling zero, SAGA com PIX externo. **Por que ela existe:** o antifraude precisa de vendas reais para observar, e é a SAGA que torna o cenário de estorno possível |
| 3. Arquitetura do Risk-Shield | 4 | T4 | C4 níveis 1 e 2; os três serviços e a regra de extração; por que a Event API **não** chama o motor de forma síncrona; CQRS entre worker e API; evidência append-only com score derivado |
| 4. O modelo de score | 3 | T4 | Os quatro fatores da Seção 4.2. **Os pesos como regra de decisão:** nenhum fator sozinho quarentena, dois quaisquer sim. Por que a versão que somava 100 era cega ao bot solitário. Mostrar o teste unitário que trava a propriedade |
| 5. Demonstração — ele discrimina | 4 | T3 | `make scenarios` ao vivo. Passar rápido pelos quatro ataques e **parar nos dois falsos positivos**: abrir o painel, mostrar a família com 22,5 e a explicação em texto — "4 contas usaram o mesmo instrumento de pagamento". O sistema notou, pontuou e não agiu |
| 6. Demonstração — ele muda a venda | 4 | T3 e T5 | `make risk-gate`. Comprador quarentenado leva 403 com o motivo. **O momento alto:** quarentena que chega depois do pagamento, e a SAGA compensando com estorno — mostrar o `saga_log` e o trace de 43 spans no Jaeger |
| 7. Quando o antifraude cai | 3 | T5 | Parar o `risk-api` ao vivo. `fail_open` vende, `fail_closed` bloqueia, chave virando em tempo de execução. **Não há resposta técnica — é decisão de produto**, e por isso mora numa flag. O breaker segurando o checkout em 268 ms |
| 8. Resultados e métricas | 3 | T1 | Custo do antifraude no caminho crítico (abaixo do ruído; o custo real é +1,7 p.p. de erro). A fila virtual nos **dois pontos de operação**: a 200 VUs atrapalha, a 600 vende 63% mais com p99 5× menor |
| 9. *(opcional)* Deployment | 2 | T1 | Canary a 10%, blue-green, rollback por peso no Traefik |
| 10. Lições aprendidas | 3 | todos | Os bugs que os testes encontraram: o estorno que nunca funcionara, o laço infinito de compensação, o Traefik sobrescrevendo o IP. **E o melhor deles:** a própria bateria de fumaça foi quarentenada pelo antifraude, e o detector estava certo |

**Versão de 15 minutos:** blocos 1, 2 (1 min), 3, 4, 5, 6 e 10 (1 min). Cortar 7,
8 e 9 — e mencionar em uma frase que estão no repositório.

Os blocos 5 e 6 decidem a nota de demonstração funcional. Gravar com o sistema já
aquecido (`make up && make scenarios` antes) e ter uma gravação reserva, para o
caso de a demo ao vivo falhar.

### O que NÃO fazer na apresentação

- Não abrir pelo domínio. A entrega é a POC 2; a bilheteria é cenário.
- Não mostrar só os ataques sendo pegos. Qualquer regra paranoica pega ataque —
  o que diferencia este trabalho são os dois falsos positivos passando.
- Não dizer "score 87" sem ler a explicação em texto junto. O ponto do painel é
  que ninguém decide nada com um número.

---

## Datas da disciplina

| Entrega | Data | Peso |
|---|---|---|
| Projeto 01 — grupo e tema | 26/06/2026 | 10% |
| Projeto 02 — documentação inicial | 10/07/2026 | 20% |
| Projeto 03 — documentação final | 07/08/2026 | 70% |

A [`proposta.md`](proposta.md) atende ao formato de uma página exigido para tema próprio; os C4,
os ADRs e a definição de stack atendem ao escopo do Projeto 02; o restante deste roadmap conduz
ao Projeto 03.
