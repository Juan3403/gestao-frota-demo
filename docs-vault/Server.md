# Server

> O "motor" que liga tudo: recebe os acessos do navegador e responde.

**Tags:** #core #backend #api

## O que faz
É o programa principal (`server.js`) que fica rodando no servidor. Ele entrega as telas do site (a pasta `public/`) e responde aos pedidos do navegador (a "API": buscar veículos, salvar uma multa, etc.).

## Por que existe
Todo site precisa de um programa que fique "ouvindo" os acessos e devolva as informações. Sem ele, não há site no ar. Aqui ele também concentra as regras de segurança e desempenho num lugar só.

## Como funciona
Usa o **Express** (uma ferramenta de Node.js). No "boot" (quando liga), carrega os dados na memória e passa a atender cada pedido. Comprime as respostas (gzip/brotli) para o site abrir rápido e exige login quando está em produção.

## Quando é usado
O tempo todo — ele só para quando o servidor reinicia (por exemplo, num novo deploy no Render).

## Dependências
- [[Persistência]]
- [[Autenticação]]
- [[Usuários e Permissões]]

## Usado por
- [[Frontend SPA]]
- [[Scripts]]
