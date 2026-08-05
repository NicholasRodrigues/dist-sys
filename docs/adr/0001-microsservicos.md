# ADR-0001 — Seis serviços, cortados por fronteira de consistência e perfil de escala

- **Status:** Aceito
- **Data:** 2026-08-04
- **Dono:** T1 — Plataforma e Deployment
- **Área técnica:** Escalabilidade

## Contexto

O sistema precisa demonstrar, de forma verificável, padrões de sistemas distribuídos exigidos pela
Seção 6 do documento da disciplina. Vários deles — Circuit Breaker, Bulkhead, SAGA, Service
Discovery, Database per Service — só existem de verdade quando há processos separados por rede;
dentro de um único processo, viram simulação.

Isso cria uma tentação óbvia e perigosa: **maximizar o número de serviços para maximizar o número
de padrões demonstráveis.** O primeiro desenho deste projeto tinha dez serviços por esse motivo.

Ao revisar, ficou claro que quatro deles não sobreviviam a uma pergunta simples: *que garantia ou
que perfil de carga esse processo separado oferece, que um módulo dentro de outro serviço não
ofereceria?* Para quatro deles, a resposta honesta era "nenhum" — eles existiam para parecer
distribuídos, não para ser.

Um serviço a mais não é gratuito: é um repositório de deploy, um banco, um pipeline, um conjunto
de dashboards, um modo de falha novo e um salto de rede em algum caminho. Com cinco pessoas, esse
custo é pago em atenção, que é o recurso mais escasso do projeto.

## Decisão

Adotamos **seis serviços**, e adotamos uma regra explícita para decidir o que é serviço:

> Um serviço só existe se tiver uma **fronteira de consistência própria** ou um **perfil de escala
> próprio**. Todo o resto é módulo dentro de um serviço existente.

| Serviço | O que justifica a existência |
|---|---|
| `edge` | Perfil de escala: absorve a enxurrada inteira. Stateless, replicável, descartável |
| `catalog` | Perfil de escala: leitura é ordens de magnitude maior que a escrita e tolera defasagem |
| `inventory` | Fronteira de consistência: dono da invariante do assento, sob ACID |
| `orders` | Fronteira de consistência: dono do processo, não do dado. Estado da SAGA |
| `payments` | Fronteira de consistência: dono do dinheiro, sob ACID, com requisito de auditoria imutável |
| `realtime` | Perfil de escala: conexões longas, consumo de memória linear no número de espectadores |

Os quatro serviços cortados não perderam funcionalidade — perderam apenas o processo próprio.
**Nenhum padrão arquitetural foi perdido no corte**, o que é a evidência de que eles nunca
justificaram a separação.

## Alternativas consideradas

| Alternativa | Por que foi rejeitada |
|---|---|
| Monólito modular | Tecnicamente a escolha mais defensável para um domínio deste tamanho, e provavelmente o que faríamos em produção com esta equipe. Rejeitado porque impede demonstrar os padrões que a disciplina avalia: um circuit breaker entre dois módulos do mesmo processo não protege de nada real |
| Dez serviços (desenho original) | Quatro deles não passavam na regra acima. O custo operacional era pago em atenção da equipe e o ganho pedagógico era zero — os mesmos padrões são demonstrados com seis |
| Três serviços (borda, núcleo, leitura) | Colapsaria `inventory`, `orders` e `payments` em um só, e a SAGA viraria uma transação local. Perderia o padrão mais importante do projeto |
| Repositórios separados por serviço | Mudança de contrato exigiria commits coordenados em vários repositórios, sem atomicidade. Para cinco pessoas em uma janela curta, o custo de coordenação superaria o ganho de independência |
| Funções serverless | Incompatível com conexões WebSocket longas e com pool de conexões ao Postgres. Também tornaria a demonstração local dependente de um provedor |

## As extrações que rejeitamos

Esta seção existe porque a decisão de **não** extrair é tão arquitetural quanto a de extrair, e é
raramente documentada.

| Extração rejeitada | Onde a funcionalidade vive agora | Motivo |
|---|---|---|
| `waiting-room` | Módulo do `edge` | Mesmo perfil de escala do gateway: ambos existem para absorver a enxurrada. Separar acrescentaria um salto de rede no caminho mais quente do sistema sem nenhum ganho de isolamento — a fila e o gateway caem juntos de qualquer forma, porque falham pela mesma causa |
| `ticketing` | Módulo do `orders` | O ingresso é o resultado do pedido: mesmo ciclo de vida, mesma transação de confirmação. A crypto-agility do QR é uma decisão de biblioteca, não de topologia |
| `antifraud` | Dividido entre `edge` e `payments` | Ao tentar justificar a extração, percebemos que eram **duas coisas diferentes** com requisitos temporais opostos. Barrar bot é controle de admissão e precisa acontecer *antes* de o estoque ser consumido — como consumidor assíncrono, chegava tarde demais para servir de alguma coisa. Fraude de pagamento é quarentena financeira e pertence junto do ledger, onde o dinheiro está retido. O serviço separado era o pior lugar possível para ambos |
| `notifier` | Consumidor de eventos dentro do `orders` | Não demonstra nenhum padrão que outro consumidor já não demonstre. Um webhook resolve |

O caso do `antifraud` é o mais instrutivo: a tentativa de justificar uma extração revelou um erro
de modelagem. O componente não estava mal posicionado — ele não existia como conceito único.

## Consequências

**Esperadas**

- Seis serviços cabem confortavelmente em uma máquina de desenvolvimento e em uma demonstração ao
  vivo, o que reduz o risco do bloco de demo da apresentação
- A regra de extração é defensável em voz alta na banca, e o corte de dez para seis é ele próprio
  um argumento de maturidade arquitetural
- Uma transação que seria local vira SAGA distribuída, com três passos e três compensações
- Depuração exige trace distribuído; sem OpenTelemetry desde a Fase 0, o projeto fica cego
  exatamente quando mais precisa enxergar
- Contratos entre serviços precisam ser definidos antes da implementação, ou as cinco trilhas
  travam umas nas outras
- O `edge` acumula responsabilidades — autenticação, fila, rate limit, mitigação de bots — e
  precisa de disciplina interna de módulos para não virar um monólito de borda por acidente. Este
  é o custo real da decisão

**Observadas**

_A preencher após a Fase 2._

## Condição de reversão

Se a Fase 3 mostrar que a fila virtual e o gateway competem por CPU sob carga — o único cenário em
que o perfil de escala deles diverge de fato — a fila volta a ser serviço próprio. É a extração
com maior probabilidade de se justificar depois, e o código é organizado em módulos para que
extrair custe pouco.

Na direção oposta: se o custo operacional passar a consumir mais esforço do que o domínio, o
colapso natural é juntar `orders` e `inventory`, que compartilham o mesmo ciclo de vida — ao custo
de reduzir a SAGA a dois participantes.

## Evidência

O cenário R8 do [plano de testes](../plano-de-testes.md) demonstra o isolamento na prática: uma
partição de rede entre `orders` e `inventory` é contida pelo bulkhead sem esgotar pools de conexão
nem afetar o caminho de leitura.
