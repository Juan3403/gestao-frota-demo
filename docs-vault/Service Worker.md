# Service Worker

> Um ajudante invisível que faz o site abrir mais rápido.

**Tags:** #frontend

## O que faz
Guarda em cache (memória do navegador) os arquivos do site para carregar mais rápido nas próximas visitas.

## Por que existe
Acelera o carregamento e melhora a experiência mesmo com internet ruim, sem que o usuário precise fazer nada.

## Como funciona
`public/sw.js` roda em segundo plano no navegador e serve os arquivos do cache. A "versão" do cache sobe a cada atualização importante, para o usuário sempre pegar a versão nova.

## Quando é usado
Sempre, de forma transparente, enquanto a pessoa usa o site.

## Dependências
- [[Frontend SPA]]

## Usado por
- (transparente para o usuário)
