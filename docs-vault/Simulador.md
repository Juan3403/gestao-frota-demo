# Simulador

> Uma calculadora para comparar propostas de financiamento/empréstimo.

**Tags:** #api #db #frontend #financeiro

## O que faz
Simula o custo real de um financiamento, consórcio ou empréstimo usando o **CET** (Custo Efetivo Total — o juro "de verdade", já com taxas).

## Por que existe
Propostas de banco costumam esconder o custo real atrás de taxas. Simular pelo CET ajuda a comparar maçã com maçã e escolher a opção mais barata antes de assinar.

## Como funciona
Você informa os parâmetros (valor, parcelas, taxas) e o simulador calcula o custo. Dá para salvar as simulações para comparar depois. Endpoint `/api/simulacoes`.

## Quando é usado
Antes de fechar um novo financiamento/empréstimo, na hora de comparar propostas.

## Dependências
- [[Persistência]]

## Usado por
- (ferramenta de apoio à decisão)
