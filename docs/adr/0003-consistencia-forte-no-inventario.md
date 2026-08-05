# ADR-0003 — Consistência forte no assento, eventual em todo o resto

- **Status:** Aceito
- **Data:** 2026-08-04
- **Dono:** T3 — Núcleo de Vendas
- **Área técnica:** Confiabilidade

## Contexto

Este é o ADR central do projeto. Todo o resto do desenho decorre dele.

Existe no domínio uma invariante que não admite violação: **um assento numerado tem no máximo um
dono.** Vender o mesmo lugar duas vezes não é um erro que se corrige depois com um estorno — é uma
falha que aparece na porta do evento, com duas pessoas segurando o mesmo ingresso. Não há
compensação satisfatória.

Ao mesmo tempo, a abertura de vendas concentra tráfego de 100 a 1000 vezes a média, com a demanda
recaindo sobre poucos recursos: todos querem os mesmos setores. Contenção alta e consistência
forte no mesmo lugar é a receita clássica de colapso de vazão.

A tentação é resolver a contenção afrouxando a consistência. Neste domínio, essa saída não existe.

## Decisão

O `inventory` é a **única** fonte da verdade sobre o estado de um assento, e opera sob garantias
ACID em PostgreSQL. A reserva usa uma transação com bloqueio de linha (`SELECT ... FOR UPDATE`) e
uma *constraint* de unicidade parcial que torna a venda dupla impossível no nível do schema, e não
apenas no nível do código:

```sql
CREATE UNIQUE INDEX one_active_hold_per_seat
    ON seat_holds (seat_id)
    WHERE released_at IS NULL;
```

Todo o resto do sistema — catálogo, mapa de assentos exibido na tela, contadores, avaliação de
risco, notificações — é eventualmente consistente e alimentado por eventos.

A escalabilidade do núcleo ACID **não** é buscada afrouxando a consistência, e sim reduzindo a
taxa de chegada até o ponto que ele comporta, através do controle de admissão da fila virtual
(ADR-0007).

O mapa exibido na tela é, por construção, levemente defasado. Isso é aceitável e é comunicado ao
usuário: a confirmação de que o assento é dele acontece na reserva, não na visualização.

## Alternativas consideradas

| Alternativa | Por que foi rejeitada |
|---|---|
| Reserva em Redis com `SETNX` | Muito mais rápido e a contenção deixaria de ser problema. Rejeitado por durabilidade: uma falha do Redis entre a reserva e a persistência perde o registro de quem tem o assento, e a invariante mais importante do sistema passa a depender do componente menos durável |
| Bloqueio otimista com reconciliação posterior | Bom para estoque fungível — camisetas, ingressos sem lugar marcado. Para assento numerado, a reconciliação significa dizer a alguém que já pagou que o lugar não é mais dele. É overbooking com outro nome |
| Sharding do inventário por setor | Aumentaria a vazão de fato, e continua sendo o caminho de evolução natural. Não adotado agora porque a contenção real se concentra em poucos setores populares: fragmentar por setor não divide o ponto quente, apenas o realoca |
| CRDT para o mapa de assentos | Convergência garantida, mas convergência não é exclusão mútua. Dois nós podem aceitar o mesmo assento e o CRDT converge para um estado em que ambos aceitaram — exatamente a falha que se quer evitar |

## Consequências

**Esperadas**

- Overselling se torna impossível por construção, não por convenção. O teste é uma consulta SQL
  que precisa retornar vazio
- O `inventory` passa a ser o gargalo de vazão declarado do sistema. Isso não é um defeito
  escondido: é uma propriedade conhecida, medida e protegida
- Sob contenção máxima — todos no mesmo setor — a latência sobe, e a degradação precisa ser
  graciosa em vez de abrupta
- A defasagem do mapa de assentos exige tratamento de produto: o usuário pode clicar em um lugar
  que acabou de ser reservado por outra pessoa, e a mensagem de erro precisa ser boa
- O reaper de holds vencidos passa a ser um componente crítico. Sem ele, uma SAGA que morre no
  meio bloqueia o assento para sempre

**Observadas**

_A preencher após os cenários C1 e C2._

## Condição de reversão

Se o teste C2 mostrar que a contenção em um único setor torna a latência inaceitável mesmo com a
fila virtual regulando a chegada, o próximo passo é particionar o inventário por sessão de evento
e adotar filas de trabalho por setor — serializando o acesso ao ponto quente em vez de disputá-lo.
A consistência forte permanece; muda apenas o mecanismo de acesso.

## Evidência

- Cenário C2 do [plano de testes](../plano-de-testes.md): 1.000 usuários virtuais disputando 500
  lugares
- Invariante 1: `SELECT seat_id, count(*) FROM tickets WHERE status='VALID' GROUP BY seat_id
  HAVING count(*) > 1` — precisa retornar vazio em toda rodada
