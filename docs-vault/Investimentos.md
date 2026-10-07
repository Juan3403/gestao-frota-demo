# Investimentos

> A carteira de renda fixa da empresa (Banco Inter).

**Tags:** #api #db #frontend #financeiro

## O que faz
Mostra os investimentos em renda fixa: quanto está aplicado, o rendimento, posições abertas/encerradas, histórico diário, movimentações e impostos.

## Por que existe
O dinheiro parado rende. Acompanhar a carteira ajuda a saber quanto se ganha, quando resgatar e quanto pagar de imposto — sem depender de abrir o app do banco toda hora.

## Como funciona
Os dados vêm dos extratos em PDF do Inter. O site recebe os PDFs, processa em uma pasta temporária usando o mesmo pipeline de consolidação e salva só o snapshot consolidado; os PDFs não ficam guardados. O JSON consolidado ainda pode ser importado como fallback. Tem uma coluna de rendimento diário projetado pelo CDI (percentual configurável), recalculado automaticamente todo dia. Acesso por permissão própria. Endpoint `/api/investimentos`.

## Quando é usado
Ao atualizar a carteira (importação do extrato) e ao acompanhar rendimento/impostos.

## Dependências
- [[Persistência]]

## Usado por
- [[Início]]
