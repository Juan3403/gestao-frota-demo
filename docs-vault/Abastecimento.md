# Abastecimento

> Os abastecimentos de combustível da frota, com dashboards e alertas.

**Tags:** #api #db #frontend

## O que faz
Registra as transações de combustível (litros, valor, posto, veículo) e mostra dashboards e alertas (ex.: consumo fora do padrão).

## Por que existe
Combustível é um dos maiores custos da frota e um ponto comum de desvio/fraude. Acompanhar de perto ajuda a economizar e a flagrar anomalias.

## Como funciona
Os dados entram por **planilha** (uma ou várias de uma vez), com edição inline e snapshots de segurança antes de cada importação. A importação **mescla** (soma sem duplicar — dedup por data+placa+valor+posto+centro); `?modo=substituir` zera antes. O leitor `parseAbastecimentoPlanilha` aceita o export financeiro "Conta Azul" (uma aba por mês; placa/motorista embutidos na Descrição "Abastecimento - ABC1D23(Nome)"), valores negativos/com vírgula, datas serial ou texto, e usa o **nome da aba** como competência do mês (corrige seriais errados). Quando a base não tem litros/km, a UI oculta cards/colunas/gráficos de combustível e foca no gasto (`abtTemFuel`). Os indicadores são calculados a partir da lista bruta. Endpoints `/api/abastecimento` e `/api/abastecimento/importar`.

## Quando é usado
Nas atualizações periódicas da planilha e na análise de consumo/custos por veículo ou motorista.

## Dependências
- [[Persistência]]
- [[Histórico]]
- [[Cadastros]]

## Usado por
- [[Início]]
