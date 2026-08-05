# ADR-0004 — Conduzir a compra por SAGA orquestrada

- **Status:** Aceito
- **Data:** 2026-08-04
- **Dono:** T4 — Transações
- **Área técnica:** Confiabilidade

## Contexto

Uma compra atravessa três serviços com bancos de dados distintos: reservar o assento
(`inventory`), cobrar via PIX (`payments`) e confirmar a venda emitindo o ingresso (`orders` e
`inventory`). Não existe transação distribuída disponível — e mesmo que existisse, o segundo passo
depende de um sistema externo cujo tempo de resposta não é controlado por nós.

O passo do pagamento tem uma propriedade que domina o desenho inteiro: **um timeout do PSP não
diz se a cobrança falhou.** A requisição pode ter sido processada e a resposta ter se perdido no
retorno. Tratar timeout como falha, e compensar automaticamente, produz o pior erro possível:
estornar uma cobrança e devolver o assento de alguém que pagou.

Cada passo pode falhar de forma diferente e precisa de uma compensação específica.

## Decisão

Usamos uma **SAGA orquestrada**, com o `orders` como orquestrador. Ele mantém uma máquina de
estados persistida por pedido e decide, a cada transição, qual é o próximo passo ou qual
compensação executar.

```
  passo                     sucesso                     compensação
  ─────────────────────────────────────────────────────────────────────────
  1. reservar assento    →  RESERVED (hold, TTL 10min)  →  liberar assento
  2. cobrar via PIX      →  PAID                        →  estornar
  3. emitir e confirmar  →  CONFIRMED (terminal)        →  invalidar e liberar
```

O passo 3 é **local e transacional**: emitir o QR e confirmar a venda acontecem na mesma transação
do `orders`, porque a emissão do ingresso é um módulo interno e não um serviço remoto. Isso
elimina a janela "pago, ingresso ainda não emitido" que existia no desenho anterior, em que a
emissão era um quarto salto de rede. Uma fronteira de rede a menos é uma falha parcial a menos —
ver [ADR-0001](0001-microsservicos.md).

Três propriedades são obrigatórias em todos os passos:

1. **Idempotência.** Cada passo carrega a `sagaId` como chave; repetir um passo não produz um
   segundo efeito.
2. **Reconciliação antes de compensar.** Diante de um timeout, o orquestrador **consulta o estado
   real** no serviço de destino antes de decidir. Timeout nunca é tratado como falha por
   presunção. É por isso que o `payments` precisa oferecer consulta idempotente por chave, e não
   apenas escrita idempotente.
3. **Progresso garantido.** O reaper de holds vencidos e o retomador de SAGAs travadas garantem
   que toda SAGA chega a um estado terminal, mesmo que o orquestrador morra no meio.

A regra geral adotada no projeto: **dinheiro orquestra, o resto coreografa.** Atualização de read
model, notificação e avaliação de risco reagem a eventos sem orquestrador.

## Alternativas consideradas

| Alternativa | Por que foi rejeitada |
|---|---|
| Coreografia por eventos | Menor acoplamento e nenhum ponto de concentração. Rejeitada para o fluxo de compra porque o estado do processo passa a ser emergente: descobrir por que um pedido específico parou exige reconstituir a sequência a partir dos logs de quatro serviços. Para um fluxo com dinheiro, isso é caro no pior momento possível — quando alguém está reclamando |
| Two-phase commit | Bloqueia recursos durante a fase de preparação, o que sob a contenção do pico é exatamente o que não se pode fazer. E o PSP externo não participa de 2PC |
| Transação única em banco compartilhado | Resolveria o problema e eliminaria a SAGA, ao custo de um banco compartilhado entre serviços — acoplamento por schema, que anula boa parte do sentido da separação |

## Consequências

**Esperadas**

- Existe um único lugar onde se lê o estado de qualquer compra
- As compensações são explícitas, versionadas e testáveis em conjunto
- O `orders` acopla-se ao conhecimento de todos os passos: mudar o fluxo significa mudá-lo
- Toda a lógica de compensação precisa ser testada com falha injetada em **cada** passo, o que
  multiplica a matriz de testes
- Existe uma janela de inconsistência visível ao usuário entre o passo 2 e o 3: pago, ingresso
  ainda não emitido. A interface precisa comunicar isso honestamente
- A reconciliação exige que todos os serviços de destino ofereçam consulta por chave de SAGA

**Observadas**

_A preencher após os cenários R1, R2 e R5._

## Condição de reversão

Se o número de passos crescer a ponto de o orquestrador virar o ponto de mudança de toda
funcionalidade nova, o caminho é extrair a definição do fluxo para uma máquina de estados
declarativa — mantendo a orquestração, mas tirando o fluxo do código imperativo.

## Evidência

- R1: queda total do `payments` durante a carga — nenhum assento preso após o TTL
- R2: PSP com 5 segundos de latência — a reconciliação impede estorno indevido
- R5: crash do `orders` no meio da SAGA — retomada até estado terminal sem intervenção
- O trace distribuído de uma SAGA compensada é a evidência visual usada na apresentação
