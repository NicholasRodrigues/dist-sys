# Escopo — o que entra, o que fica de fora, e por quê

A Seção 8 do documento da disciplina autoriza explicitamente adaptar escopo "com justificativa
documentada". Este documento é essa justificativa.

A regra que governa tudo aqui: **implementar o que a especificação exige, mais o que o domínio
exige para estar correto, mais o bônus que sai quase de graça. Nada além disso.**

Escopo grande não impressiona — escopo *decidido* impressiona. Um projeto que abraça tudo e
entrega metade pela metade vale menos, em todas as cinco dimensões de avaliação, do que um
projeto menor que funciona ao vivo e sabe explicar cada ausência.

---

## O que a especificação realmente exige

Separar isto do que é opcional foi o primeiro passo, e mudou várias decisões.

### Requisitos duros (Seção 3, tema próprio)

| # | Exigência | Nosso número |
|---|---|---|
| 1 | Arquitetura de microsserviços ou sistema distribuído | 6 serviços |
| 2 | **Pelo menos 3** padrões arquiteturais da Seção 6 | ~40 tópicos |
| 3 | **Ao menos 2** das cinco áreas técnicas | 5 áreas, 4 delas com profundidade |
| 4 | Proposta escrita de 1 página | [`proposta.md`](proposta.md) |
| 5 | Plano de testes que valide as decisões arquiteturais | [`plano-de-testes.md`](plano-de-testes.md) |

Vale registrar a folga: o mínimo é **3 padrões e 2 áreas**. Mesmo depois de todos os cortes deste
documento, o projeto entrega mais de dez vezes o mínimo de padrões. Não havia risco de ficar
aquém — havia risco de ficar espalhado.

### Checklist de entrega (Seção 7)

Repositório acessível · README com descrição, execução e link do videocast · C4 níveis 1 e 2 ·
ADRs completos · código funcional com testes · **Docker Compose ou equivalente** · videocast com
todos os integrantes · histórico de commits de todos · plano e resultados de testes de carga,
resiliência e integração · trade-offs documentados.

### O que é bônus declarado (Seção 8)

| Bônus | Palavra usada | Peso real |
|---|---|---|
| Observabilidade (Prometheus, Grafana, Jaeger) | "diferencial" | — |
| Estratégias de deployment (CI/CD, Blue-Green, Canary) | "pontuação adicional" | Originalidade, 10% |
| Segurança expandida (Zero Trust, DevSecOps, Supply Chain) | "valorização especial" | não quantificado |

Três itens de bônus, e apenas um deles com peso nomeado. Isso é o que justifica tratá-los por
custo-benefício, e não como se fossem requisito.

---

## A descoberta que mais mudou o plano

**A especificação nunca pede Kubernetes.** O checklist diz "Docker Compose **ou equivalente** para
execução local".

O plano anterior tinha uma trilha inteira de Kubernetes em kind — e sobre ela estavam empilhados
RBAC, Network Policies, Pod Security Standards e verificação de assinatura na admissão. Nenhum
desses itens é exigido, e todos custavam caro. Pior: eram bônus apoiados sobre uma fundação que
também era bônus.

Cortar Kubernetes cortou cinco itens de uma vez, e não custou nenhum requisito.

E o que parecia perdido não se perdeu: **canary e blue-green continuam no projeto**, feitos com
pesos de roteamento no Traefik dentro do próprio Compose. Custam cerca de quinze linhas de
configuração e valem "pontuação adicional na dimensão de Originalidade" pela letra da Seção 8.

---

## Cortes

Cada linha responde: o que era, quanto custava, o que se perde.

| Item cortado | O que custava | O que se perde |
|---|---|---|
| **Kubernetes (kind), RBAC, Network Policies, Pod Security** | Uma trilha inteira, mais um segundo ambiente para manter em sincronia com o Compose | Nada exigido. Os tópicos de deployment continuam cobertos via Traefik |
| **mTLS e Zero Trust entre serviços** | Gerar, distribuir e rotacionar certificados; configuração de TLS em todos os seis serviços | Um bônus da Seção 8. Numa rede isolada do Compose, a demonstração se resumiria a uma conexão recusada |
| **OPA/Rego, política como código** | Uma linguagem nova, arquivos de política e uma etapa de CI | Bônus. O valor real de OPA aparece com admissão em Kubernetes, que também saiu |
| **Cosign, Sigstore, atestado SLSA** | Assinatura keyless e um ponto de verificação | Bônus. Sem admissão em Kubernetes não existe onde verificar a assinatura — assinar sem verificar é teatro |
| **Criptografia pós-quântica (ML-DSA)** | Biblioteca de PQC e um caminho de compatibilidade | Bônus. A assinatura Ed25519 do QR **permanece**, porque falsificação de ingresso é parte real do domínio |
| **Keycloak** | Um contêiner, mais realms, clients e escopos para configurar | OIDC completo. Mantemos JWT com assinatura, expiração e validação de claims, emitido por um módulo do `edge` — o padrão API Gateway continua demonstrado |
| **Debezium e CDC** | Kafka Connect, configuração de conector, `wal_level=logical` no Postgres | Um tópico da Seção 6. O Transactional Outbox já resolve o mesmo problema — tirar mudanças do banco de forma confiável — e é também um tópico listado |
| **Unleash** | Um contêiner e um painel | Nada. Feature flags viram configuração em Redis, alternável em tempo de execução. O padrão Feature Toggle continua demonstrável ao vivo |
| **Toxiproxy** | Um contêiner e uma camada de proxy | Nada. O PSP falso é **nosso**: ele já expõe endpoints para injetar latência e erro. Mais honesto e mais simples |
| **Loki** | Um contêiner e coleta de logs | Bônus. `docker compose logs` resolve na escala da demo |
| **Tempo → Jaeger** | — | Nada. Jaeger é um contêiner único e é o nome que a própria Seção 8 cita |
| **Next.js** | Toolchain, build, dependências | Nada relevante. A interface vira HTML e JavaScript estáticos servidos pelo `edge` |
| **Fingerprint de dispositivo e desafio de prova de trabalho** | Lógica de detecção e uma etapa a mais no fluxo do usuário | Parte do sabor da POC 2. Fica o **rate limiting por identidade e por IP**, que é o tópico da Seção 6 e é o que de fato contém abuso |
| **Quarentena financeira, log de auditoria encadeado, SAST, DAST, varredura de segredos** | Cada um pequeno; somados, uma trilha | Bônus. Nenhum é exigido |

**Contêineres: de cerca de vinte para catorze.** A demonstração ao vivo passa a caber com folga na
máquina de qualquer integrante, e isso protege os 20% do videocast.

---

## O que ficou, e o argumento de cada um

### Exigido pela especificação

Seis serviços, Docker Compose, README, C4 níveis 1 e 2, ADRs, trade-offs, plano e **resultados**
de testes de carga, resiliência e integração, histórico de commits de todos, declaração de uso de
IA. Nada disso é negociável — é a lista da Seção 7.

### Exigido pelo domínio, não pela especificação

Estes não estão em nenhuma lista, mas sem eles o sistema está **errado**, e não apenas menos
completo:

- **Inventário ACID com hold e expiração** — sem isso, overselling
- **SAGA orquestrada com compensações e reaper** — sem isso, assento preso para sempre quando uma
  compra morre no meio
- **Idempotência ponta a ponta** — sem isso, uma retentativa cobra duas vezes
- **Transactional Outbox** — sem isso, um crash entre o commit e a publicação perde o evento
- **Circuit breaker, timeout, retry com backoff e DLQ** — sem isso, o PSP lento derruba o sistema
- **Assinatura Ed25519 no QR** — sem isso, o ingresso é falsificável
- **Fila virtual** — é a tese do projeto

Um sistema de venda de ingressos sem estes itens não é um sistema simplificado; é um sistema
quebrado. É a diferença entre cortar escopo e cortar qualidade.

### Bônus que ficaram, por custo-benefício

**Observabilidade — e este é o item que eu argumentaria mesmo contra um pedido de corte.**

A Seção 8 chama observabilidade de "diferencial", o que soa opcional. Mas a dimensão 4 da
avaliação — Testes e Validação, 15% — exige "métricas coletadas", e a dimensão 3 — Videocast,
20% — exige "demonstração funcional". Observabilidade não é o bônus: é o **instrumento que produz
a evidência que essas duas dimensões cobram**. Sem ela, "o p95 ficou abaixo de 500 ms" é uma
afirmação sem prova, e a compensação de uma SAGA é impossível de mostrar na tela.

São três contêineres — Prometheus, Grafana e Jaeger — e nenhum exige código. O trace distribuído
de uma SAGA compensada é, com folga, a imagem mais eloquente que este projeto consegue produzir.

**Canary e blue-green no Traefik.** Cerca de quinze linhas de configuração, dentro do Compose que
já existe. A Seção 8 promete "pontuação adicional na dimensão de Originalidade" por exatamente
isso. É o melhor retorno por esforço do projeto inteiro.

**SBOM e varredura de vulnerabilidades no CI.** Cinco linhas de YAML — `syft` gera, `grype` varre.
É a única porta de entrada barata para a "valorização especial" de Supply Chain Security da Seção
8, agora que assinatura e verificação saíram. Se a equipe preferir ficar estritamente no exigido,
é o primeiro item a remover, e nada quebra.

---

## Cobertura resultante

| Área | Tópicos | Profundidade |
|---|---|---|
| Confiabilidade | ~12 | Muito forte — é o coração do projeto |
| Desempenho | ~10 | Forte |
| Escalabilidade | ~9 | Forte |
| Deployment | ~6 | Suficiente, e barata |
| Segurança | ~5 | Deliberadamente reduzida a API Gateway, JWT, rate limiting e ACL |

Cinco áreas onde o mínimo exigido são duas. Quarenta e poucos tópicos onde o mínimo são três.

Sobre segurança especificamente: a redução é **declarada, não escondida**. Na apresentação, a
frase é "cobrimos segurança de borda, e deixamos Zero Trust e supply chain de fora conscientemente
porque o custo não cabia no escopo, e aqui está o que teria custado". Isso demonstra mais
julgamento do que um mTLS meia-boca que ninguém consegue explicar sob pergunta.

---

## O caminho de volta

Se sobrar tempo, esta é a ordem de reintrodução — do melhor para o pior retorno:

1. **SBOM e varredura no CI** — cerca de cinco linhas, se ainda não estiver
2. **Rolling update** — `docker compose up --scale`, uma seção de README
3. **Keycloak** — troca o JWT caseiro por OIDC de verdade e recupera um tópico inteiro
4. **mTLS entre dois serviços** — o suficiente para demonstrar o conceito sem certificar os seis
5. **Kubernetes em kind** — só se todo o resto estiver fechado e testado

Nada aqui entra depois do congelamento da última fase.

---

## Uma pendência para o professor

O documento se contradiz sobre a duração do videocast: a Seção 1.2 diz **12 a 15 minutos**, com a
observação "mínimo/máximo rigoroso", enquanto o checklist da Seção 7 diz **15 a 30 minutos**.

Como a duração é critério de avaliação, isso precisa ser resolvido — e a Seção 8 exige que dúvidas
sejam enviadas com **48 horas de antecedência** da entrega. O planejamento assume 12 a 15 minutos,
por ser a única das duas marcada como rigorosa, com material preparado para estender caso a
resposta seja outra.
