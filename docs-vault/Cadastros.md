# Cadastros

> As listas-base que abastecem os menus do sistema (centros de custo e responsáveis).

**Tags:** #db #api

## O que faz
Mantém duas listas que aparecem em vários lugares: os **Centros de Custo** (a qual obra/área um gasto pertence) e os **Responsáveis**.

## Por que existe
Esses valores são usados em muitos módulos. Tê-los numa lista única evita digitação solta e nomes diferentes para a mesma coisa (ex.: "Reisolamento C.G" vs "Reisolamento Campina Grande").

## Como funciona
Dá para adicionar, **renomear (com cascata)** — ou seja, ao renomear um centro de custo, todos os registros que usavam o nome antigo são atualizados de uma vez — e excluir. As pílulas de centro de custo nas tabelas leem desta lista.

## Quando é usado
Ao organizar/renomear centros de custo e responsáveis, e toda vez que um módulo mostra esses campos.

## Dependências
- [[Persistência]]
- [[Histórico]]

## Usado por
- [[Veículos]]
- [[Manutenção]]
- [[Abastecimento]]
