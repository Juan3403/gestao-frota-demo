# Página Admissão

> A tela pública que o candidato preenche.

**Tags:** #frontend #publico #rh

## O que faz
É a página que o candidato abre pelo link de admissão para informar seus dados e enviar documentos.

## Por que existe
Precisa ser uma página separada e **pública** (sem login), porque quem preenche é alguém de fora que ainda não tem conta.

## Como funciona
`public/admissao.html` + `public/admissao.js`. Por segurança (regra de CSP do site), o código fica num arquivo externo, sem "atalhos" de script embutidos no HTML. O acesso é liberado pelo **token** do link, não por login. Os dados vão para o módulo [[Admissão]].

## Quando é usado
Quando um candidato recebe o link e preenche o formulário de admissão.

## Dependências
- [[Admissão]]

## Usado por
- (acessada por link/token externo)
