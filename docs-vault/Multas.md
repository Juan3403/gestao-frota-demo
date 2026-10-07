# Multas

> Controle das multas de trânsito e do andamento de cada processo.

**Tags:** #api #db #frontend

## O que faz
Cadastra as multas e acompanha em que pé está cada uma (pendente, em andamento, paga…), inclusive o trâmite no Detran.

## Por que existe
Multas têm prazos (indicar condutor, recorrer, pagar com desconto). Perder prazo custa dinheiro. Esse módulo organiza tudo para não deixar passar.

## Como funciona
Mostra **cards por situação** (clicáveis para filtrar), valores com 2 casas decimais e uma seção **"Status do Processo no Detran"** com etapas (checkbox + data + observação). Tem o **"Preencher por print"**: você manda a foto da multa e um leitor de texto (OCR) no próprio navegador extrai placa, valor, data e local automaticamente.

## Quando é usado
Quando chega uma nova multa, ao atualizar o andamento (indicou condutor, recorreu, pagou) e na conferência de pendências.

## Dependências
- [[Persistência]]
- [[Histórico]]
- [[Veículos]]

## Usado por
- [[Início]]
