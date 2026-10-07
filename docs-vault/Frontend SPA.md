# Frontend SPA

> Tudo o que você vê e clica no navegador.

**Tags:** #frontend

## O que faz
É a **interface** do sistema (`public/app.js`): as telas, tabelas, filtros, modais e botões de todas as abas.

## Por que existe
O usuário precisa de uma tela para usar o sistema. Este é o "rosto" do app — o [[Server]] manda os dados, e aqui eles viram telas e interações.

## Como funciona
É feito em **JavaScript puro** (sem framework, sem etapa de "build"), num arquivo único grande (~12 mil linhas). Cada aba tem um endereço próprio (roteamento por "hash", ex.: `#multas`). Conversa com o servidor pela API para buscar e salvar dados. "SPA" = Single Page Application: o site não recarrega a página inteira a cada clique.

## Quando é usado
Sempre que alguém está usando o sistema no navegador.

## Dependências
- [[Server]]

## Usado por
- (é a interface principal do usuário)
