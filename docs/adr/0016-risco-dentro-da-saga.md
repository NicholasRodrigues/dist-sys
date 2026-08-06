# ADR-0016 — A verificação de risco é um passo da SAGA, não só um porteiro na borda

- **Status:** Aceito
- **Data:** 2026-08-06
- **Dono:** T4 — Transações e Ingresso
- **Área técnica:** Confiabilidade (POC 2)

## Contexto

O caminho óbvio para ligar o antifraude à venda é verificar o comprador na borda, antes
de iniciar a compra. É barato, é uma linha, e cobre o caso normal.

O problema é a duração. Uma compra na Bilheteria é uma SAGA de três passos — reservar
assento, cobrar, confirmar — e cada passo fala com um serviço diferente. Sob PSP lento
ou retentativa, ela leva segundos. A borda olha **uma vez, no começo**; a decisão de
risco pode mudar no meio.

E ela muda justamente nos casos que importam. O evento `CHECKOUT_ATTEMPT` que a própria
compra gera é o que faz a regra de velocidade acender. Uma conta pode entrar no checkout
limpa e ser marcada por causa do checkout que está acontecendo.

## Decisão

A verificação de risco acontece em **três pontos**, e cada um compensa de forma
diferente:

| Ponto | Momento | Compensação se bloquear |
|---|---|---|
| Borda (`edge`) | antes de criar o pedido | nenhuma — devolve 403 e nada foi criado |
| `stepCharge` | depois de reservar, antes de cobrar | libera o assento |
| `stepConfirm` | depois de capturar o pagamento | **estorno** + libera o assento |

A verificação na borda existe para que o caso comum seja barato: um comprador em
quarentena leva 403 sem consumir assento, sem criar pedido e sem tocar no PSP. Se o
bloqueio só acontecesse dentro da SAGA, cada tentativa de um cambista prenderia um
assento por alguns segundos — negação de serviço de graça.

As verificações dentro da SAGA existem porque a borda não é suficiente. A de
`stepCharge` é a barata: compensar ali custa devolver o assento. A de `stepConfirm` é a
cara, e é a que prova que o passo de risco é parte da transação distribuída e não um
porteiro: o dinheiro já foi capturado, e a única compensação possível é o estorno.

Uma falha na **consulta** de risco dentro da SAGA nunca trava a SAGA. O modo de falha já
foi decidido dentro de `checkBuyer` (ADR-0015); um erro inesperado além disso é
registrado no log da SAGA e segue em frente. Uma compra não pode ficar pendurada porque
um serviço acessório respondeu algo inesperado.

## Consequências

**Esperadas.** Três consultas a mais por compra, todas atrás do mesmo circuit breaker.
Em compra normal são três leituras por chave primária.

**Observadas.** O teste `make risk-gate` exercita o caminho caro de forma determinística:
injeta 2 s de latência no PSP, dispara a compra, e aplica a quarentena 1,5 s depois —
dentro da janela em que o pagamento está sendo capturado. O resultado:

```
reserve             ok
charge              ok
risk.post-payment   quarantined   comprador em quarentena
compensate.refund   ok
compensate.release  ok
```

Pagamento capturado, quarentena aplicada, estorno emitido, assento devolvido ao estoque.

**Esse teste encontrou dois defeitos reais na Bilheteria**, ambos anteriores ao POC 2 e
invisíveis até então, porque nenhum teste havia levado a SAGA ao caminho de estorno:

1. O cliente HTTP anunciava `content-type: application/json` em requisições **sem
   corpo**, e o Fastify do outro lado respondia 400. Todo `POST` sem corpo estava
   quebrado — inclusive `POST /charges/:sagaId/refund`. O estorno nunca havia
   funcionado.
2. A compensação retentava **qualquer** erro indefinidamente. Com o 400 acima, a SAGA
   ficou 40 segundos repetindo `payments respondeu 400` e teria ficado para sempre: um
   pedido que nunca alcança estado terminal volta ao varredor a cada ciclo.

O primeiro está corrigido no cliente HTTP, com teste de regressão. O segundo virou um
teto de tentativas e um tratamento explícito de erro permanente: um `4xx` no estorno não
melhora com o tempo, então a SAGA termina com motivo explícito e log em nível de erro,
em vez de girar. Deliberadamente **não** fingimos que o dinheiro voltou — se o estorno
não foi aceito, isso é trabalho humano, e o log existe para que alguém saiba.

O valor deste ADR não é a decisão em si. É que a decisão de verificar risco dentro da
SAGA obrigou a escrever um teste que percorre a compensação com estorno, e esse caminho
estava quebrado desde antes.
