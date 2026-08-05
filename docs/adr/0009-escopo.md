# ADR-0009 — Reduzir o escopo ao necessário e declarar as ausências

- **Status:** Aceito
- **Data:** 2026-08-05
- **Dono:** T1 — Plataforma e Deployment
- **Área técnica:** Todas

## Contexto

O plano anterior somava cerca de vinte contêineres e uma trilha inteira de Kubernetes, com mTLS,
OPA, Cosign, Keycloak, Debezium, Unleash, Toxiproxy e criptografia pós-quântica empilhados em
cima. A justificativa para cada item, individualmente, era a Seção 8 do documento da disciplina,
que promete "diferencial", "pontuação adicional" e "valorização especial" para observabilidade,
estratégias de deployment e temas expandidos de segurança.

Ao reler a especificação separando **exigência** de **bônus**, três fatos mudaram o desenho:

1. **O checklist da Seção 7 pede "Docker Compose ou equivalente para execução local".**
   Kubernetes não aparece em nenhum requisito. A trilha inteira de kind — e com ela RBAC, Network
   Policies, Pod Security Standards e verificação de assinatura na admissão — era bônus apoiado
   sobre uma fundação que também era bônus.

2. **O mínimo exigido pela Seção 3 é de 3 padrões e 2 áreas.** O projeto entregava dezenas de
   tópicos antes de qualquer um desses itens caros. Não havia risco de ficar aquém do requisito;
   havia risco de ficar espalhado e não terminar.

3. **A Seção 8 autoriza explicitamente adaptar escopo "com justificativa documentada".** O corte é
   uma opção prevista pelo próprio documento, desde que escrita.

Há também um custo que não aparece em nenhuma planilha: cada peça de infraestrutura a mais é uma
peça a mais que pode falhar durante a demonstração ao vivo, e a demonstração vale 20% da nota.

## Decisão

O escopo passa a conter exatamente três categorias:

1. **O que a especificação exige** — a lista da Seção 7, sem exceção
2. **O que o domínio exige para estar correto** — inventário ACID, SAGA com compensações e reaper,
   idempotência, outbox, circuit breaker, retry com DLQ, assinatura do ingresso, fila virtual
3. **O bônus que sai quase de graça** — observabilidade, canary e blue-green por peso no Traefik,
   e opcionalmente SBOM no CI

Tudo o mais é cortado, e **cada ausência é declarada por escrito**, com o custo que teria e o
caminho de volta. O detalhamento item a item está em [`escopo.md`](../escopo.md).

A distinção entre as categorias 1 e 2 é o ponto que merece atenção: um sistema de venda de
ingressos sem SAGA, sem idempotência ou sem inventário ACID não é um sistema simplificado — é um
sistema **quebrado**. Cortar esses itens seria cortar qualidade, não escopo. A régua do corte foi
sempre essa.

## Alternativas consideradas

| Alternativa | Por que foi rejeitada |
|---|---|
| Manter o escopo completo | O risco não era técnico, era de conclusão: mais peças significam mais chance de a demonstração falhar ao vivo, e a demonstração vale 20% enquanto os bônus cortados valem, no máximo, parte dos 10% de Originalidade |
| Cortar também a observabilidade | Foi considerado seriamente, já que a Seção 8 a trata como "diferencial". Rejeitado porque a dimensão 4 exige "métricas coletadas" e a dimensão 3 exige "demonstração funcional": observabilidade não é o bônus, é o **instrumento que produz a evidência que essas duas dimensões cobram**. Sem ela, "o p95 ficou abaixo de 500 ms" vira uma afirmação sem prova |
| Cortar canary e blue-green | Rejeitado pelo custo: cerca de quinze linhas de configuração no Traefik que já está no Compose, em troca de "pontuação adicional na dimensão de Originalidade" prometida nominalmente pela Seção 8. É o melhor retorno por esforço do projeto |
| Manter um mTLS simbólico entre dois serviços | Rejeitado por honestidade: meia implementação de Zero Trust é pior que nenhuma, porque não sobrevive à primeira pergunta da banca sobre rotação de certificado |

## Consequências

**Esperadas**

- Catorze contêineres em vez de cerca de vinte; a demonstração cabe com folga na máquina de
  qualquer integrante
- Todo o esforço restante vai para os padrões que a disciplina avalia e para as evidências que ela
  cobra
- A "valorização especial" da Seção 8 para segurança expandida não será recebida por inteiro.
  Resta a porta barata do SBOM no CI
- Um tópico da Seção 6 é perdido de fato: **CDC**, com a saída do Debezium. O Transactional Outbox
  resolve o mesmo problema — tirar mudanças do banco de forma confiável — e também é tópico listado
- Cria-se uma obrigação de comunicação: cada ausência precisa ser dita em voz alta na apresentação,
  com o motivo. Uma ausência explicada é julgamento; uma ausência silenciosa é lacuna

**Observadas**

_A preencher após a Fase 4._

## Condição de reversão

O caminho de volta, em ordem de retorno decrescente, está em [`escopo.md`](../escopo.md): SBOM,
rolling update, Keycloak, mTLS entre dois serviços, Kubernetes em kind.

A regra que governa a reintrodução: **nada entra depois do congelamento da Fase 5.** Um bônus pela
metade custa mais em credibilidade, na dimensão de Arquitetura e Design, do que rende em pontos na
de Originalidade.

## Evidência

O próprio [`escopo.md`](../escopo.md) é o artefato, e a Seção 8 do documento da disciplina é o que
o exige: "adicionando ou removendo itens do escopo **com justificativa documentada**".
