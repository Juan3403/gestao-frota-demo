# Login

> A tela de entrada (usuário e senha).

**Tags:** #frontend #auth #publico

## O que faz
Mostra o formulário de acesso e envia usuário/senha para o sistema validar.

## Por que existe
É a porta de entrada quando o login está ativo (produção). Sem passar por aqui, não se acessa o conteúdo interno.

## Como funciona
Páginas `public/login.html` + `public/login.js`. Envia os dados para `/api/login`; se estiverem certos, o usuário recebe a sessão (o "cookie assinado") e entra. Inclui um gerador de QR code.

## Quando é usado
Toda vez que alguém precisa entrar e ainda não está logado.

## Dependências
- [[Autenticação]]

## Usado por
- (porta de entrada quando o login está ativo)
