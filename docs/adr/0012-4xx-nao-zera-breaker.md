# ADR-0012 — Um 4xx é neutro para o circuit breaker

- **Status:** Aceito
- **Data:** 2026-08-05
- **Dono:** T4 — Transações e Ingresso
- **Área técnica:** Confiabilidade

## Contexto

Este ADR nasceu de um bug encontrado pelo cenário R1 do plano de testes, e não de
uma discussão de projeto. Ele está registrado porque a decisão que o corrigiu não
é óbvia e vai reaparecer sempre que alguém mexer no cliente HTTP.

A primeira implementação do circuit breaker tratava qualquer resposta HTTP como
sinal de saúde da dependência:

```ts
if (res.status < 500) {
  onSuccess(opts.target);   // zera o contador de falhas
  throw new RemoteError('http', ...);
}
```

O raciocínio parecia sólido: um `4xx` é uma resposta deliberada do servidor. Ele
está vivo, processou a requisição e decidiu recusá-la. Isso não é falha de
dependência, então não deveria contar para o breaker.

O cenário R1 mostrou o furo. Com o PSP fora do ar, cada tentativa de cobrança
fazia duas chamadas:

1. `GET /pix/charges/by-key/:key` — consulta de reconciliação, respondia **404**
   (a cobrança de fato não existia);
2. `POST /pix/charges` — a cobrança em si, respondia **503**.

O `404` zerava o contador a cada rodada, e o `503` seguinte só conseguia levá-lo
de volta a 1. O contador nunca chegava ao limiar de 8. **O breaker nunca abria**, e
o sistema martelava indefinidamente uma dependência morta — exatamente o
comportamento que o padrão existe para evitar.

## Decisão

Um `4xx` é **neutro** para o circuit breaker: não conta como falha e **não zera o
contador de falhas**.

```ts
if (res.status < 500) {
  // sem onSuccess() e sem onFailure(): apenas propaga o erro
  throw new RemoteError('http', ...);
}
```

O princípio: um `4xx` prova que o **servidor** está vivo, mas não prova que a
**operação que falha** está saudável. São afirmações diferentes, e o breaker se
importa com a segunda.

Só uma resposta de sucesso fecha o breaker, porque só ela é evidência de que o
caminho que estava quebrado voltou a funcionar.

## Alternativas consideradas

| Alternativa | Por que foi rejeitada |
|---|---|
| Contar 4xx como falha | Abriria o breaker por causa de erros legítimos de cliente. Um `409` de assento indisponível é o sistema funcionando: sob contenção normal ele acontece às centenas e derrubaria a dependência sozinho |
| Um breaker por rota, em vez de por alvo | Resolveria este caso, e é a solução mais correta em teoria. Rejeitada pela cardinalidade: cada rota vira uma métrica e um estado a acompanhar, e o ganho sobre a regra de neutralidade é pequeno |
| Contar apenas timeouts e erros de rede | Ignoraria um `500` persistente, que é sinal claro de dependência doente |

## Consequências

**Esperadas**

- O breaker passa a abrir em cenários de indisponibilidade parcial, em que a
  dependência responde bem em uma rota e mal em outra
- Um alvo que só recebe `4xx` mantém o breaker fechado para sempre, o que é
  correto: não há falha de dependência acontecendo
- Um breaker aberto só fecha com um sucesso de verdade

**Observadas**

O cenário R1 passou a abrir o breaker do `payments` para o `psp` de forma
consistente. Com a dependência de volta, o pedido chega a `CONFIRMED` sozinho
pelo varredor de sagas, sem assento preso.

## Condição de reversão

Se aparecer um alvo em que erros de cliente e falhas de dependência precisem de
tratamento genuinamente diferente por rota, o caminho é o breaker por rota — com
a cardinalidade das métricas controlada por agrupamento explícito, e não por
caminho cru.

## Evidência

- Cenário R1 em `make chaos`
- Teste de regressão em `tests/unit/breaker.test.ts`, com o nome
  `REGRESSAO: um 4xx nao zera o contador de falhas`
