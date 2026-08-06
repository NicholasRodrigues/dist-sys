# ADR-0013 — Pesos e limiar do score antifraude

- **Status:** Aceito
- **Data:** 2026-08-06
- **Dono:** T4 — Transações e Ingresso
- **Área técnica:** Confiabilidade (POC 2)

## Contexto

A Seção 4.2 da especificação exige quatro fatores de detecção: *device fingerprint*,
*velocidade de ação*, *padrão de escolhas* e *correlação entre contas*. Cada regra
produz uma severidade de 0 a 1; o score é a soma de `severidade × peso`, limitado a 100,
e um limiar decide a quarentena.

A pergunta que os pesos respondem não é "quanto vale cada regra". É **quantos sinais
simultâneos bastam para agir**.

A primeira versão usava pesos somando exatamente 100 — 30, 25, 25, 20 — com limiar 70.
Era elegante: um comprador que dispara tudo no máximo chega a exatamente 100. E estava
errado por um motivo que só apareceu ao construir os cenários de teste.

**Um bot solitário é estruturalmente incapaz de disparar dois dos quatro fatores.**
Uma conta, um dispositivo, um IP: não há com quem correlacionar. O máximo que ele
alcança são os dois fatores comportamentais. Com aqueles pesos, isso dava 50 — abaixo
do limiar. O modelo era cego, por construção, ao cambista que simplesmente não repete
dispositivo. E essa é a evasão mais barata que existe.

O caminho errado seria baixar o limiar até o bot passar. Isso levaria junto todo
comprador que dispara um único fator forte — e um único fator forte é justamente onde
moram as explicações inocentes: a família no mesmo notebook, o escritório atrás de um
NAT, o navegador com proteção contra rastreamento que randomiza o *fingerprint* a cada
aba.

## Decisão

Os pesos codificam uma regra de decisão explícita, e o limiar é 70:

| Fator | Peso | Natureza |
|---|---|---|
| `velocity` | 38 | direta — o que esta conta fez |
| `choice_pattern` | 37 | direta — o que esta conta fez |
| `device_fingerprint` | 35 | contextual — associação com terceiros |
| `account_correlation` | 35 | contextual — associação com terceiros |

Duas propriedades, verificadas por teste:

- **Nenhum fator sozinho quarentena.** O maior peso é 38, e 38 < 70.
- **Dois fatores quaisquer no máximo quarentenam.** O menor par é 35 + 35 = 70.

Comportamento pesa mais do que associação porque acusa a conta pelo que ela mesma fez,
e não por quem está perto dela. Associação erra mais, e o custo do erro aqui é negar a
venda a um cliente legítimo.

A soma dos pesos é **145**, e não 100. O score continua limitado a 100.

As explicações inocentes não moram nos pesos — moram nos **pisos** de cada regra:
3 contas por dispositivo, 4 por IP, 2 pelo mesmo cartão. Abaixo do piso a severidade é
zero. É por isso que a família do cenário C6 pontua 22,5: não porque o peso é pequeno,
mas porque a severidade dela é pequena.

## Alternativas consideradas

**Manter a soma em 100 e baixar o limiar para 45.** O bot solitário passaria a ser
pego, mas qualquer fator forte isolado também quarentenaria. O cenário C5 — uma conta
legítima em 15 *fingerprints*, com navegação humana — seria bloqueado. Rejeitada: troca
um falso negativo específico por uma classe inteira de falsos positivos.

**Score não linear (saturação probabilística).** `1 - Π(1 - sᵢwᵢ)` dá a propriedade
desejada de graça. Rejeitada por explicabilidade: o painel precisa mostrar "35 pontos
por isto, 37 por aquilo, total 72". Ninguém libera um comprador olhando para um
produtório.

**Normalizar pelo peso dos fatores aplicáveis.** Faria o bot solitário ser julgado só
pelos dois fatores mensuráveis. Rejeitada porque "não aplicável" e "aplicável e limpo"
viram a mesma coisa: um comprador com um único evento teria o score inflado pela
ausência de dados, e não pela presença de sinal.

## Consequências

**Esperadas.** Alterar um peso no painel muda a regra de decisão, não só a aritmética.
Por isso `make risk-config` imprime as duas propriedades e avisa quando alguma quebra —
subir um peso para 71 significa "um fator sozinho passa a quarentenar", e essa é uma
decisão de produto, não um ajuste fino.

**Observadas** (`make scenarios`, execução completa):

| Cenário | Score | Fatores acesos | Resultado |
|---|---|---|---|
| C1 comprador legítimo | 0,0 | nenhum | livre |
| C6 família (4 contas, 1 device, 1 cartão) | 22,5 | 2 parciais | livre |
| C5 rotação de *fingerprint*, ritmo humano | 43,6 | 1 no máximo + 2 fracos | livre |
| C2 bot solitário | 75,0 | 2 comportamentais no máximo | quarentena |
| C4 conluio distribuído | 91,9 | 2 comportamentais + coordenação | quarentena |
| C3 fazenda de 20 contas | 100,0 | os quatro | quarentena |

O limiar cai entre 43,6 e 75,0 — uma folga de mais de 30 pontos para os dois lados. O
caso mais apertado é o bot solitário, a 5 pontos do limiar, e é o certo para ser
apertado: é a decisão mais difícil do conjunto.

Uma consequência não prevista apareceu no cenário C5: a evidência de um fator **não
esfria sozinha**. A avaliação corrente de cada fator é a última evidência registrada,
e uma regra que deixa de disparar não escreve evidência nova — então a anterior
continua valendo. O C5 carrega 6,7 pontos de "compra em bloco" de um instante em que
tinha comprado 6 lugares no mesmo setor, mesmo tendo depois se espalhado por dois. É
coerente com a política de quarentena (entra sozinha, só sai por decisão humana):
comportamento passado não evapora porque a última ação foi inocente. Fica registrado
como propriedade conhecida, não como defeito.
