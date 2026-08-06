# Guia de Apresentação — passo a passo

Este documento é para ser seguido **com o terminal aberto**, na ordem em que está
escrito. Cada passo diz o comando, quanto tempo leva, o que deve aparecer na tela
e o que dizer em voz alta.

Regra que vale para tudo: **o que impressiona não é o ataque sendo pego — é o
comprador legítimo passando.** Qualquer regra paranoica pega ataque.

---

## Parte 0 — Antes de gravar (30 minutos antes)

Nada disso acontece durante a gravação. É preparação.

### 0.1 Subir o sistema do zero

```bash
git clone https://github.com/NicholasRodrigues/dist-sys.git
cd dist-sys
make up
```

Leva de 1 a 3 minutos na primeira vez (constrói a imagem). Deve terminar
imprimindo a lista de endereços. Se falhar, o motivo quase sempre é Docker sem
memória — feche o resto.

### 0.2 Provar que tudo passa

```bash
make test
```

Leva de 8 a 12 minutos. Roda, em sequência: 59 unitários, 30 verificações ponta a
ponta, 6 cenários de caos, 6 cenários de antifraude, 15 verificações do portão e
6 invariantes. **Se algo falhar aqui, não grave — conserte primeiro.**

Deixe a saída num terminal separado: ela é a evidência da dimensão *Testes e
Validação* e pode ser mostrada no bloco 8.

### 0.3 Aquecer

```bash
make scenarios          # popula o painel com compradores e evidências
make risk-config        # confere pesos e limiar
```

Abra e deixe prontas, em abas separadas:

| Aba | Endereço |
|---|---|
| Painel do antifraude | http://localhost:3022/ |
| Bilheteria | http://localhost:8080/ |
| Jaeger | http://localhost:16686 |
| Grafana | http://localhost:3030/d/bilheteria |

### 0.4 Gravar um reserva

Grave uma vez os blocos 5, 6 e 7 sozinho, antes. Se a demo ao vivo falhar na
gravação real, você corta para a reserva. **A dimensão Videocast vale 20% e
metade dela é "demonstração funcional".**

---

## Parte 1 — O roteiro, bloco a bloco

Quem apresenta cada bloco está em [`roadmap.md`](roadmap.md). Os tempos abaixo
somam ~25 min; a versão de 15 min corta os blocos 7, 8 e 9.

---

### Bloco 1 — O problema real (2 min) · sem terminal

Comece pela frase, não pela arquitetura:

> "Detectar fraude é fácil se você puder errar. O difícil é pegar o cambista
> **sem bloquear a família que comprou seis lugares do mesmo notebook**."

Diga por que isso é um problema **distribuído** e não de machine learning:

- o sinal é **coletivo** — conluio é invisível para qualquer regra que olhe uma
  conta por vez;
- a decisão está no **caminho crítico** — uma consulta síncrona dentro do
  checkout, que não pode derrubá-lo;
- o **detector também falha** — e aí a venda para ou continua?
- a compra **dura segundos** — a decisão pode mudar no meio dela.

---

### Bloco 2 — O domínio hospedeiro (2 min) · aba da Bilheteria

Mostre a tela de compra e o mapa de assentos. Compre um ingresso ao vivo.

Diga o essencial e **não se alongue**:

> "40.000 assentos, overselling zero, PIX externo. A bilheteria existe porque o
> antifraude precisa de vendas reais para observar — e porque é a SAGA dela que
> torna possível o cenário que vou mostrar no bloco 6."

Se perguntarem por que não usar um simulador: porque um simulador não tem
transação para compensar.

---

### Bloco 3 — Arquitetura do Risk-Shield (4 min) · diagrama

Abra o diagrama do [`README`](../README.md) ou o
[`arquitetura.md`](arquitetura.md).

Três pontos, nesta ordem:

1. **Três serviços, e a regra que os produziu.** Só vira serviço o que tem
   fronteira de consistência própria ou perfil de escala próprio.
   `risk-event-api` (escala: rajadas), `risk-worker` (consistência: único
   escritor), `risk-api` (escala oposta: leitura no caminho crítico).

2. **A Event API não chama o motor de forma síncrona.** Aponte para as setas do
   diagrama: só duas são grossas. "A venda nunca espera pela detecção, só pela
   decisão. O evento já aconteceu — perdê-lo é pior do que processá-lo tarde."

3. **CQRS e Event Sourcing juntos.** A evidência é append-only; o score é
   *derivado* dela. É isso que permite mudar um peso no painel e re-projetar sem
   reprocessar um evento sequer.

---

### Bloco 4 — O modelo de score (3 min) · painel + código

Abra o painel e mostre os quatro fatores com os pesos: 38, 37, 35, 35.

**Este é o momento mais forte da dimensão Arquitetura.** Diga:

> "Os pesos não são chute. Eles codificam uma regra de decisão: **nenhum fator
> sozinho quarentena — o maior peso é 38, e o limiar é 70. Mas dois fatores
> quaisquer no máximo, sim — o menor par é 35 + 35 = 70.**"

E então conte o erro, porque contar o erro é o que prova que houve engenharia:

> "A primeira versão somava exatamente 100. Era elegante e estava errada: um bot
> solitário — uma conta, um dispositivo, um IP — **não consegue disparar** os
> dois fatores contextuais. Chegava a 50 no máximo. O modelo era cego a ele por
> construção, e bastava ao cambista não repetir dispositivo."

Mostre o teste que trava a propriedade:

```bash
npx vitest run tests/unit/risk-scoring.test.ts
```

> "Este teste não verifica se a soma está certa. Verifica se a **propriedade**
> continua valendo. Quando alguém subir um peso para 71 'para pegar mais
> fraude', é ele que vai explicar por que aquilo vira um gerador de falso
> positivo."

---

### Bloco 5 — Ele discrimina (4 min) · terminal + painel

```bash
make scenarios
```

Leva ~2 min. **Passe rápido pelos quatro ataques** — eles são o esperado.

**Pare nos dois falsos positivos.** Abra o painel, clique na família, mostre a
evidência em texto:

> *"4 contas usaram o mesmo instrumento de pagamento" — 17,5 pontos.*

E diga:

> "Score 22,5. O sistema **notou**, pontuou, registrou a evidência com a
> explicação — e **não agiu**. E a proteção não vem do peso: vem do piso da
> regra. Quatro contas num cartão passa do piso de duas, então pontua. Quatro
> contas num dispositivo está abaixo do piso de três, então quase não pontua.
> **As explicações inocentes moram nos pisos, não nos pesos.**"

Mostre também o de 43,6 (uma conta em 15 dispositivos, ritmo humano):

> "Um fator no máximo vale 35 — metade do limiar. Navegador com proteção contra
> rastreamento randomiza fingerprint a cada aba. Acusar por associação sozinha é
> como o antifraude vira prejuízo."

Feche com o limiar:

> "70 cai entre 43,6 e 75. Mais de 30 pontos de folga para os dois lados."

---

### Bloco 6 — Ele muda a venda (4 min) · terminal + Jaeger

```bash
make risk-gate
```

Leva ~3 min e para o `risk-api` no meio. Narre as três fases enquanto rodam.

**O momento alto é a linha da quarentena em pleno voo.** Quando aparecer:

```
OK  quarentena em pleno voo: a SAGA compensa com estorno
    pagamento capturado, quarentena aplicada, estorno emitido e assento devolvido
```

Explique:

> "O teste injeta 2 segundos de latência no PSP e aplica a quarentena **durante**
> a captura do pagamento. Quando a SAGA sai da cobrança, o dinheiro já foi
> capturado — então a única compensação possível é o estorno. É por isso que a
> verificação de risco é um **passo da SAGA**, e não um porteiro na entrada: a
> borda olha uma vez, no começo, e a compra dura segundos."

Abra o Jaeger e mostre o trace: **43 spans, 10 serviços, uma tela.** O
`traceparent` viaja no cabeçalho da mensagem Kafka — sem isso o rastro morreria
na publicação.

---

### Bloco 7 — Quando o antifraude cai (3 min) · terminal

Isto já aconteceu dentro do `make risk-gate`, mas vale repetir isolado:

```bash
docker compose stop risk-api
make flags ARGS="risk_check_mode=fail_open"    # tente comprar: vende
make flags ARGS="risk_check_mode=fail_closed"  # tente comprar: 403
docker compose start risk-api
```

> "Se o antifraude cai, a venda para? **Não existe resposta técnica.** As duas
> são implementáveis com o mesmo esforço e as duas estão certas em contextos
> diferentes. Numa noite comum, `fail_closed` derruba a bilheteria inteira porque
> um serviço acessório caiu. Nos dez minutos de abertura de um show disputado,
> `fail_open` entrega o lote ao cambista. **É decisão de produto, e por isso mora
> numa flag** que pode virar durante a venda."

E o detalhe que sustenta a decisão:

> "O checkout continua respondendo em **268 ms** com a dependência morta. Sem o
> circuit breaker, `fail_open` na teoria seria 'cada compra espera o timeout' na
> prática — uma forma lenta de `fail_closed`."

---

### Bloco 8 — Resultados (3 min) · terminal

```bash
cat docs/resultados/comparacao.txt
```

Dois números, e só dois:

**Custo do antifraude no caminho crítico:**

> "Abaixo da variação entre repetições. Não é que ele acelere — é que a consulta
> é um SELECT por chave primária numa projeção de leitura. O custo real é
> **+1,7 ponto percentual de checkouts recusados**, que são os compradores
> quarentenados. É o preço de a verificação valer alguma coisa."

**A fila virtual em dois pontos de operação:**

| | 200 VUs | 600 VUs |
|---|---|---|
| compras sem fila | 2.488 | 1.669 |
| compras com fila | 2.198 | **2.724** |
| p99 sem fila | 5,02 s | 10,96 s |
| p99 com fila | 6,36 s | **2,10 s** |

> "A 200 VUs a fila **atrapalha** — o núcleo não está saturado e a admissão vira
> espera pura. A 600 ela vende 63% mais com p99 5 vezes menor. **A fila não
> aumenta a capacidade: ela escolhe o ponto de operação, e só compensa depois do
> joelho da curva.** Um ponto único de medição teria nos feito concluir a coisa
> errada — e chegou a fazer."

---

### Bloco 9 *(opcional)* — Deployment (2 min)

```bash
make deploy-status
make canary PCT=10
make blue-green TO=green
make rollback
```

A versão que atendeu vem no header `x-app-version`, então a distribuição é
verificável e não precisa ser acreditada.

---

### Bloco 10 — Lições aprendidas (3 min) · sem terminal

**Este bloco vale a dimensão de Originalidade e Profundidade (10%).** Conte os
bugs, não os acertos.

1. **O estorno nunca havia funcionado.** O cliente HTTP anunciava
   `content-type: application/json` em POST sem corpo, e o Fastify respondia 400.
   Só apareceu quando o antifraude obrigou a percorrer a compensação com estorno
   pela primeira vez.

2. **A compensação girava para sempre.** Retentava qualquer erro, inclusive um
   400 que jamais teria sucesso. A SAGA ficou 40 segundos repetindo e teria
   ficado indefinidamente.

3. **O Traefik sobrescrevia o `X-Forwarded-For`.** Todo o tráfego local chegava
   com um endereço só, e a regra de correlação via 127 contas nele — marcando
   todo mundo por associação. Teria arruinado a demonstração.

4. **O melhor de todos: a própria bateria de fumaça foi quarentenada.** Ela usa
   40 contas disputando um assento e 50 requisições idênticas, tudo do mesmo
   endereço. O antifraude a bloqueou com *"53 tentativas de compra nos últimos 10
   minutos"*. **O detector estava certo** — o gerador de carga não é um cliente.
   A lição é operacional: sondas sintéticas precisam de um caminho declarado fora
   do antifraude, senão a própria monitoração acorda o plantão.

5. **O gerador de carga descrevia um ataque.** Criava uma conta nova por
   iteração mas mantinha device e IP fixos por usuário virtual — 200 fazendas de
   contas. O antifraude quarentenou 2.519 compradores e 96% dos checkouts
   falharam. De novo: o detector estava certo.

Feche com o que ficou de fora e por quê — [`escopo.md`](escopo.md) tem a lista.

---

## Parte 2 — Perguntas prováveis, e as respostas

| Pergunta | Resposta curta |
|---|---|
| "Por que não usar ML?" | Sem dados rotulados e sem explicabilidade. O painel precisa dizer *por que* o comprador foi marcado; ninguém libera alguém olhando para um número. |
| "Os pesos não são arbitrários?" | Não: são a codificação de uma regra de decisão, com duas propriedades verificadas por teste unitário. E documentamos por que a versão anterior estava errada. |
| "Por que 70 e não 60?" | Porque 70 é o ponto em que dois fatores no máximo passam e um só não. Mudar o limiar muda a regra, e o `make risk-config` avisa quando ela quebra. |
| "Isso escala?" | Os três serviços separam por perfil de escala. Se o worker cair, a Event API continua aceitando e a Risk API responde com o último score — degrada em frescor, não em disponibilidade. |
| "E se o antifraude errar?" | A quarentena entra sozinha por score, mas **nunca sai sozinha**: liberar exige decisão humana no painel, porque um score que cai não prova inocência. |
| "Por que TypeScript e não Python, como no documento inicial?" | Porque o que prova o Anti-Corruption Layer é a heterogeneidade de **contrato**, não de linguagem — e ela existe: camelCase sem timestamp de um lado, snake_case com timestamp sem fuso do outro. Python custaria reescrever tracer, breaker, consumidor e métricas já testados. |
| "Vocês testaram só o caminho feliz?" | Dois dos seis cenários são falsos positivos que **devem passar**, e os testes encontraram três bugs reais no sistema que já existia. |

---

## Parte 3 — Checklist final antes de entregar

Da Seção 7 da especificação. Marque um por um:

- [x] Repositório Git acessível
- [x] README com descrição e instruções de execução
- [ ] **Link do videocast no README** — obrigatório, ainda falta
- [x] Diagrama C4 (níveis 1, 2 e 3)
- [x] ADRs completos (16)
- [x] Código funcional com testes
- [x] Docker Compose
- [ ] **Videocast gravado (15–30 min) com participação de todos**
- [ ] **Histórico de commits mostrando contribuição de todos os membros** — hoje
      há um único autor. A Seção 5 diz que cada integrante é avaliado
      individualmente pelos commits; este é o item de maior risco.
- [x] Plano e resultados de testes (carga, resiliência, integração)
- [x] Trade-offs documentados
- [x] Seção "Ferramentas de IA utilizadas" — **obrigatória; a omissão
      desclassifica a entrega**

E três pendências de contexto:

1. **Equipe de 4**, e a Seção 2.1 prevê 5. Alinhar com o professor.
2. **Duração do videocast**: a Seção 1.2 diz 12–15 min e o checklist da Seção 7
   diz 15–30. A Seção 8 exige dúvidas com 48 h de antecedência.
3. **CI definido mas nunca verde**: a execução não recebe *runner* na conta.
   Está declarado como ressalva no [`padroes.md`](padroes.md), em vez de
   afirmado como prova.

---

## Parte 4 — Se algo der errado ao vivo

| Sintoma | O que fazer |
|---|---|
| `make up` falha | Docker sem memória. `make clean && make up`. |
| Um serviço não sobe | `make ps` para ver qual, `make logs` para o motivo. |
| Cenários falham logo após uma carga | O worker está drenando a fila. Espere, ou `make risk-reset` e rode de novo. |
| Painel vazio | `make scenarios` popula em 2 minutos. |
| Comprador bloqueado sem querer | `make flags ARGS="risk_check_mode=disabled"` desliga a consulta sem apagar nada. |
| A demo ao vivo travou | Corte para a gravação reserva do passo 0.4. |

**Comando único que reconstrói tudo do zero**, se precisar recomeçar:

```bash
make clean && make up && make test
```
