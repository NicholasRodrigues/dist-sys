# Architecture Decision Records

Registros das decisões arquiteturais do projeto, no formato [MADR](https://adr.github.io/madr/).

Um ADR registra uma decisão **no momento em que ela foi tomada**, com as alternativas que estavam
realmente sobre a mesa e o contexto que existia então. Ele não é reescrito quando a decisão se
mostra errada — é marcado como substituído por outro. O valor está no rastro, não no acerto.

## Regras da equipe

1. Toda decisão que seja difícil de reverter depois vira um ADR **antes** do código.
2. O campo *Consequências* é preenchido em dois momentos: o esperado, ao decidir; e o observado,
   depois dos testes. Um ADR cuja consequência foi escrita apenas na expectativa é ficção.
3. Um ADR não é apagado nem editado no mérito. Se a decisão mudar, cria-se um novo com status
   `Substitui ADR-XXXX`.
4. Cada ADR tem um dono, que é quem defende a decisão na apresentação.

## Índice

| # | Decisão | Área | Status | Trilha |
|---|---|---|---|---|
| [0001](0001-microsservicos.md) | Seis serviços, cortados por consistência e escala | Escalabilidade | Aceito | T1 |
| [0002](0002-stack.md) | TypeScript, Fastify, Postgres, Redis e Redpanda | Todas | Aceito | T1 |
| [0003](0003-consistencia-forte-no-inventario.md) | Consistência forte no assento, eventual no resto | Confiabilidade | Aceito | T3 |
| [0004](0004-saga-orquestrada.md) | SAGA orquestrada para a compra | Confiabilidade | Aceito | T4 |
| 0005 | Transactional Outbox para publicação de eventos | Confiabilidade | Proposto | T4 |
| 0006 | Idempotência por chave explícita ponta a ponta | Confiabilidade | Proposto | T3 |
| 0007 | Fila virtual como controle de admissão | Desempenho | Proposto | T2 |
| 0008 | Ledger de dupla entrada para o fluxo financeiro | Confiabilidade | Proposto | T5 |
| [0009](0009-escopo.md) | Escopo reduzido ao necessário, com as ausências declaradas | Todas | Aceito | T1 |
| 0010 | Deployment em Compose: canary e blue-green por peso no Traefik | Deployment | Aceito | T1 |
| 0011 | Segurança de borda: JWT próprio em vez de provedor OIDC | Segurança | Aceito | T2 |
| [0012](0012-4xx-nao-zera-breaker.md) | Um 4xx é neutro para o circuit breaker | Confiabilidade | Aceito | T4 |
| [0013](0013-pesos-e-limiar-do-score.md) | Pesos e limiar do score antifraude | Confiabilidade | Aceito | T4 |
| [0014](0014-janelas-relativas-ao-evento.md) | Janelas de avaliação relativas ao evento, não ao relógio | Confiabilidade | Aceito | T4 |
| [0015](0015-fail-open-no-portao-antifraude.md) | `fail_open` como padrão do portão antifraude | Confiabilidade | Aceito | T2 |
| [0016](0016-risco-dentro-da-saga.md) | A verificação de risco é um passo da SAGA | Confiabilidade | Aceito | T4 |

Os ADRs 0001 a 0004 e o 0009 estão escritos por completo e servem de referência de formato e profundidade
para os demais. O [`template.md`](template.md) é o ponto de partida.

Os ADRs 0013 a 0016 são do POC 2 (antifraude). O 0013 é o que mais rende na banca: ele mostra que os
pesos não são um chute, e sim a codificação de uma regra de decisão — *nenhum fator sozinho quarentena,
dois fatores quaisquer sim* — e documenta por que a versão anterior, com pesos somando 100, era cega ao
bot solitário por construção. O 0016 registra dois bugs reais da Bilheteria que só apareceram porque o
antifraude obrigou a percorrer o caminho de compensação com estorno.

O ADR-0001 é o que mais rende na banca: ele documenta o corte de dez para seis serviços, a regra
usada para decidir o que é serviço e o que é módulo, e as quatro extrações que foram
deliberadamente rejeitadas — incluindo um caso em que a tentativa de justificar uma extração
revelou um erro de modelagem.
