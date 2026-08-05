# Trade-offs

Um trade-off documentado só vale se o custo estiver escrito. "Escolhemos X porque é melhor" não é
um trade-off — é uma preferência. Cada decisão abaixo declara o que foi perdido ao ganhar o que
foi ganho, e sob qual condição a decisão se inverteria.

---

## 1. Seis microsserviços, e não dez nem um

**Ganho.** Isolamento de falha no caminho que mais importa: o `realtime` saturado não derruba o
checkout. Fronteiras de consistência explícitas e fisicamente separadas. Cinco pessoas trabalhando
em paralelo sem conflito de merge constante.

**Custo.** Complexidade operacional desproporcional ao tamanho do domínio. Uma transação que seria
um `BEGIN...COMMIT` vira uma SAGA com três passos e três compensações. Depurar exige trace
distribuído. Latência de rede em caminhos que seriam chamadas de função.

**O custo específico de ter cortado para seis.** O `edge` acumula responsabilidades — autenticação,
fila virtual, rate limit, load shedding, mitigação de bots — e precisa de disciplina interna de
módulos para não virar um monólito de borda por acidente. É o ponto do sistema com maior risco de
apodrecer, e a mitigação é convenção de código, não arquitetura. Foi um custo aceito
conscientemente.

**O que o corte comprou.** Quatro processos a menos, quatro pipelines a menos, quatro conjuntos de
dashboards a menos e uma demonstração ao vivo que cabe com folga em uma máquina. Nenhum padrão
arquitetural foi perdido — o que é a prova de que os quatro serviços cortados nunca justificaram a
separação.

**Quando se inverteria.** Fora do contexto acadêmico, um monólito modular com o mesmo desenho de
fronteiras internas resolveria o mesmo problema com uma fração do custo, e o `realtime` seria o
único candidato legítimo a extração. A escolha aqui é orientada pelo objetivo de demonstrar
padrões distribuídos, e isso está declarado no [ADR-0001](adr/0001-microsservicos.md).

---

## 2. Consistência forte no assento, eventual em todo o resto

**Ganho.** A invariante que não pode ser violada é protegida por uma transação de banco, e não
por uma esperança. Overselling vira impossível por construção, não por convenção.

**Custo.** O núcleo ACID é o gargalo de vazão do sistema inteiro. Ele não escala
horizontalmente na mesma proporção que os serviços sem estado, e sob contenção máxima — todo
mundo no mesmo setor — a latência sobe.

**Mitigação.** Controle de admissão pela fila virtual, para que a chegada ao núcleo seja
constante; e particionamento por sessão de evento, já que assentos de eventos diferentes não
disputam entre si.

**Quando se inverteria.** Se o produto aceitasse *overbooking* com compensação posterior — como
companhias aéreas fazem —, uma reserva otimista com reconciliação seria muito mais barata. Para
ingresso numerado de show, não aceita.

---

## 3. SAGA orquestrada em vez de coreografada

**Ganho.** Existe um lugar único onde se lê o estado do processo de compra. Quando um cliente
liga perguntando por que o dinheiro saiu e o ingresso não chegou, a resposta está em uma linha de
uma tabela. As compensações são explícitas e testáveis em conjunto.

**Custo.** O orquestrador acopla-se ao conhecimento dos passos e é um ponto lógico de
concentração: mudar o fluxo exige mudá-lo. Coreografia distribuiria essa responsabilidade, ao
custo de tornar o fluxo emergente e difícil de auditar.

**Quando se inverteria.** Para fluxos sem dinheiro e com poucos participantes — atualizar o read
model do catálogo, por exemplo — coreografia é melhor, e é exatamente o que o projeto usa nesses
casos. A regra adotada: **dinheiro orquestra, o resto coreografa.**

---

## 4. Fila virtual em vez de autoscaling

**Ganho.** Custo constante e previsível. Reação imediata, sem o atraso de subir instância. E o
efeito contraintuitivo que o teste C3 demonstra: admitindo menos usuários por segundo, o sistema
conclui **mais** compras, porque para de gastar capacidade em requisições que iam falhar.

**Custo.** Piora a experiência percebida de quem espera, e concentra no `edge` uma
responsabilidade a mais que precisa ser altamente disponível — se a fila cai, ninguém compra. Como
a fila vive dentro do gateway, os dois falham juntos; isso é aceitável porque falhariam pela mesma
causa de qualquer forma, mas significa que o `edge` carrega o maior peso de disponibilidade do
sistema.

**Quando se inverteria.** Com demanda previsível e crescimento suave, autoscaling é mais simples
e transparente. Fila virtual é a resposta certa para pico em rajada com demanda muito acima da
capacidade — que é exatamente o caso da abertura de vendas.

---

## 5. Hold com expiração em vez de venda direta

**Ganho.** O usuário tem tempo de concluir o pagamento sabendo que o assento é dele. Sem isso, a
disputa se resolveria no momento da captura do PIX, e uma proporção grande de pagamentos
aprovados encontraria o assento já vendido — o pior desfecho possível, porque envolve estorno.

**Custo.** Estoque fica bloqueado sem ter sido vendido. Se o TTL for longo demais, o evento
parece esgotado quando não está; curto demais, o usuário perde a compra no meio do pagamento. É
um parâmetro que só se acerta medindo.

**Ponto de partida:** 10 minutos, com o valor exposto por feature flag para ajuste durante os
testes de carga.

---

## 6. Idempotência por chave explícita em vez de deduplicação por conteúdo

**Ganho.** Determinística e auditável. A chave vem do cliente, atravessa a SAGA inteira e é
gravada com a resposta produzida, então uma retentativa recebe exatamente a mesma resposta — não
uma resposta equivalente.

**Custo.** Exige disciplina em todos os serviços e uma tabela de idempotência com política de
retenção própria. Um cliente que gera a chave errada — nova a cada retentativa — anula a proteção,
o que transfere parte da responsabilidade para fora do sistema.

---

## 7. Redpanda em vez de RabbitMQ ou NATS

**Ganho.** Log particionado e ordenado por chave é exatamente o modelo que a Transactional
Outbox e o Event Sourcing precisam. Compatível com Kafka, então o conhecimento é transferível, e
sobe como binário único no Compose, sem ZooKeeper.

**Custo.** Modelo mental mais pesado que uma fila simples: partições, grupos de consumo,
offsets, rebalanceamento. Para o consumidor de notificação, que só precisa de uma fila de
trabalho, é mais máquina do que o necessário.

---

## 8. Ledger de dupla entrada em vez de coluna de saldo

**Ganho.** O saldo passa a ser uma consequência derivável do histórico, não um valor mutável que
pode divergir. Cada movimentação tem contrapartida, e a soma de todos os lançamentos é zero — um
teste de uma linha que detecta qualquer inconsistência financeira do sistema inteiro.

**Custo.** Mais escrita por operação e consultas de saldo mais caras, resolvidas com *snapshot*
periódico. Exige que a equipe entenda partidas dobradas, que não é conhecimento comum entre
desenvolvedores.

---

## 9. Monorepo em vez de repositório por serviço

**Ganho.** Uma alteração de contrato e todos os seus consumidores em um único commit. CI único.
Histórico que mostra a contribuição de todos em um só lugar — o que também importa para a
avaliação individual.

**Custo.** Pipeline mais lento sem filtro por caminho alterado, e menos realista quanto à
independência de deploy que microsserviços supostamente oferecem. A independência é preservada
por convenção, não pela ferramenta.

---

## 10. Assinatura Ed25519 no ingresso

**Ganho.** Verificação offline na portaria — o validador não precisa de rede para saber se o QR é
autêntico — e assinatura curta o suficiente para caber no código sem degradar a leitura.

**Custo.** Exige gestão de chave: a privada assina no `orders`, a pública vai para o validador, e
uma rotação invalidaria ingressos já emitidos se o identificador da chave não estivesse dentro do
payload assinado. Por isso ele está.

**Quando se inverteria.** Se a portaria tivesse rede garantida, um simples identificador opaco
consultado no servidor seria mais simples e permitiria revogação imediata — que a assinatura
offline não permite.

---

## 11. Escopo cortado ao necessário, com as ausências declaradas

**Ganho.** Catorze contêineres em vez de vinte, e uma demonstração ao vivo que cabe com folga na
máquina de qualquer integrante — o que protege diretamente os 20% da nota que dependem de ela
funcionar. Todo o esforço restante vai para o que a especificação cobra e para o que o domínio
exige para estar correto.

**Custo.** Saem os bônus da Seção 8 ligados a segurança expandida: Zero Trust com mTLS, supply
chain com assinatura verificada, política como código. A "valorização especial" prometida para
esses temas não será recebida por inteiro — resta a porta de entrada barata do SBOM no CI.

**Quando se inverteria.** Se o sistema estabilizar antes do congelamento, a ordem de reintrodução
está em [`escopo.md`](escopo.md). A regra é que nada entra depois do congelamento: um bônus pela
metade custa mais em credibilidade do que rende em pontos.
