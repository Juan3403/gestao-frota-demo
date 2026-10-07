# Manutenção

> O histórico de consertos e revisões dos veículos, com alertas.

**Tags:** #api #db #frontend

## O que faz
Registra os eventos de manutenção (o que foi feito, quanto custou, em qual carro) e gera dashboards e alertas de risco.

## Por que existe
Manutenção é um custo grande da frota. Acompanhar gastos por veículo e detectar carros que dão problema demais (muitas corretivas) ajuda a decidir o que consertar, vender ou trocar.

## Como funciona
Os dados entram por uma **planilha** (geralmente subida toda terça e quinta). A tabela tem edição inline, **exclusão em lote** e o botão **"Excel"** que deixa escolher entre baixar a **planilha original** que você subiu ou **exportar** os dados atuais (já editados). Antes de cada importação/exclusão grande, o sistema tira um "snapshot" (foto de segurança) para poder voltar atrás.

## Quando é usado
Nas atualizações periódicas (ter/qui), ao corrigir um lançamento, e ao analisar custos/alertas por veículo.

## Dependências
- [[Persistência]]
- [[Histórico]]
- [[Cadastros]]
- [[Backup]]

## Usado por
- [[Início]]
