# ADR-0014 — Janelas de avaliação relativas ao evento, não ao relógio

- **Status:** Aceito
- **Data:** 2026-08-06
- **Dono:** T4 — Transações e Ingresso
- **Área técnica:** Confiabilidade (POC 2)

## Contexto

Todas as regras do motor antifraude olham uma janela de tempo: "quantas contas
compartilham este dispositivo nos últimos 10 minutos", "quantas contas levaram assentos
deste setor em 30 segundos".

A primeira implementação media essas janelas a partir de `now()` — o instante em que o
*worker* processa a mensagem:

```sql
WHERE device_fingerprint = $1
  AND occurred_at > now() - make_interval(mins => $3)
```

Parece natural e tem duas falhas graves, ambas invisíveis em operação tranquila.

**A avaliação deixa de ser reproduzível.** O barramento entrega *at-least-once*. Uma
reentrega processada dez minutos depois vê uma vizinhança diferente da original e
produz uma evidência diferente. Duas execuções do mesmo evento, dois veredictos.

**Atraso de processamento vira erro de detecção.** É exatamente sob rajada — quando o
*worker* acumula fila e a detecção mais importa — que os eventos passam a ser julgados
pela vizinhança que sobrou quando chegou a vez deles, e não pela que tiveram de fato.
Uma quadrilha coordenada em 5 segundos, processada com 40 segundos de atraso, sai da
janela de 30 segundos e deixa de ser coordenada.

## Decisão

Toda janela é medida a partir do `occurred_at` do evento avaliado, com limite superior
no próprio evento:

```sql
WHERE device_fingerprint = $1
  AND occurred_at >  $4::timestamptz - make_interval(mins => $3)
  AND occurred_at <= $4::timestamptz
```

O limite superior é tão deliberado quanto o inferior: **um evento nunca é julgado por
algo que aconteceu depois dele.** Sem ele, reprocessar um evento antigo o julgaria com
informação do futuro — e o resultado dependeria de quando o reprocessamento aconteceu.

Com isso, `evaluate(evento, histórico, configuração)` é uma função pura. O mesmo evento
reprocessado amanhã produz a mesma evidência.

## Consequências

**Esperadas.** O consumidor idempotente já garante que uma reentrega não produz efeito
duplicado; esta decisão garante que, se produzisse, seria o mesmo efeito. As duas se
complementam: uma protege da duplicação, a outra da divergência.

O endereço `POST /recalculate` passa a ter significado exato — ele reprojeta o score a
partir das evidências, e as evidências não dependem de quando foram calculadas.

**Observadas.** O simulador de cenários só funciona por causa desta decisão. Ele envia
cada cenário em duas ondas, com uma barreira entre elas — a ordem de *envio* não é a
ordem dos *fatos*, e a espera pela barreira leva segundos de relógio. Com janelas
ancoradas em `now()`, a compra final de uma conta da fazenda seria avaliada dezenas de
segundos depois das compras das outras 19, e a regra de coordenação (janela de 30 s)
nunca acenderia. Os cenários C3 e C4 seriam impossíveis de escrever de forma
determinística.

Custo: as consultas ganharam um parâmetro e um predicado a mais. Os índices já eram
`(coluna, occurred_at DESC)`, então o predicado extra é atendido pelo mesmo índice e
não houve mudança mensurável de desempenho.
