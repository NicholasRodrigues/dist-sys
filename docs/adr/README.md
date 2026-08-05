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

Os ADRs 0001 a 0004 e o 0009 estão escritos por completo e servem de referência de formato e profundidade
para os demais. O [`template.md`](template.md) é o ponto de partida.

O ADR-0001 é o que mais rende na banca: ele documenta o corte de dez para seis serviços, a regra
usada para decidir o que é serviço e o que é módulo, e as quatro extrações que foram
deliberadamente rejeitadas — incluindo um caso em que a tentativa de justificar uma extração
revelou um erro de modelagem.
