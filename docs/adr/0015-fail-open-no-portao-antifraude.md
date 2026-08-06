# ADR-0015 — `fail_open` como padrão do portão antifraude

- **Status:** Aceito
- **Data:** 2026-08-06
- **Dono:** T2 — Borda e Admissão
- **Área técnica:** Confiabilidade (POC 2)

## Contexto

O checkout da Bilheteria consulta o Risk-Shield antes de liberar a compra. É uma chamada
síncrona no caminho mais crítico do sistema, e ela introduz uma dependência nova numa
operação que antes não tinha nenhuma além do núcleo transacional.

A pergunta é inevitável:

> Se o antifraude cair, a venda para?

**Não existe resposta técnica para essa pergunta.** As duas opções são implementáveis
com o mesmo esforço, e as duas estão certas em contextos diferentes:

- `fail_open` — uma indisponibilidade do antifraude deixa as vendas passarem. Perde-se
  detecção, preserva-se receita.
- `fail_closed` — o checkout é bloqueado até o antifraude voltar. Perde-se receita,
  preserva-se a garantia de que ninguém marcado comprou.

Numa noite comum, `fail_closed` significa derrubar a bilheteria inteira porque um
serviço acessório caiu — o sistema de segurança causando mais prejuízo do que a fraude
que ele evita. Nos dez minutos de abertura de um show muito disputado, `fail_open`
significa entregar o lote inteiro ao cambista justamente quando ele está atacando.

## Decisão

O modo de falha é uma **feature flag lida em tempo de execução**, `risk_check_mode`,
com três valores:

| Valor | Comportamento quando o antifraude está fora do ar |
|---|---|
| `fail_open` *(padrão)* | libera a compra |
| `fail_closed` | bloqueia com HTTP 403 |
| `disabled` | não consulta o antifraude |

O padrão é `fail_open`, porque a indisponibilidade é o caso comum e a janela de ataque é
o caso raro — e porque um operador consegue virar a chave para `fail_closed` quando o
show abre, mas ninguém consegue reverter uma bilheteria que ficou fora do ar a noite
toda.

`disabled` é o terceiro estado por um motivo prático: desligar a **consulta** sem apagar
a marcação. É o que permite a bateria de fumaça rodar (ela gera, por construção, tráfego
indistinguível de fraude) sem que o antifraude perca o histórico.

A decisão é de produto, não de código. Por isso mora numa flag e pode mudar durante a
venda, sem *deploy* e sem reiniciar nada.

O circuit breaker é o que torna `fail_open` viável na prática. Sem ele, "seguir em
frente" custaria o *timeout* inteiro da consulta em **cada** checkout — `fail_open` na
teoria seria "cada compra espera mais de um segundo" na prática, que é uma forma lenta
de `fail_closed`.

## Consequências

**Esperadas.** Um mesmo binário atende às duas políticas. A escolha vira operação, e a
demonstração é virar a chave na tela e ver o comportamento inverter.

**Observadas** (`make risk-gate`, fase 2, com o `risk-api` realmente parado):

| Verificação | Resultado |
|---|---|
| `fail_open` com o antifraude no chão | HTTP 201 — vendeu para um comprador em quarentena |
| `fail_closed` com o antifraude no chão | HTTP 403 — `verificacao antifraude indisponivel` |
| Alternância entre os dois modos | mesma instância, comportamento oposto, sem reinício |
| Custo do checkout com a dependência morta | **268 ms** |

O último número é o que sustenta a decisão. Sem breaker seriam 1200 ms de *timeout*
mais uma retentativa, por compra. O teste falha se passar de 1200 ms, justamente para
que uma futura remoção do breaker apareça como falha de teste e não como lentidão
inexplicada em produção.

A fase 3 confirma que a quarentena sobrevive à indisponibilidade: o estado vive no banco
do Risk-Shield, não na memória de quem consulta.
