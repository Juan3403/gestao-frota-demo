# Usuários e Permissões

> Quem pode ver/editar o quê, e quem é chefe.

**Tags:** #auth #api #db

## O que faz
Gerencia as contas das pessoas e o que cada uma pode acessar. Define **níveis** (`comum`, `admin`, `dev`) e libera **aba por aba**.

## Por que existe
Nem todo mundo deve ver tudo (ex.: salário fica só com o RH). E novas contas não podem nascer com acesso total. Esse controle evita vazamento e bagunça.

## Como funciona
Cada pessoa tem um nível e uma lista de permissões por área. `admin` e `dev` são super-usuários. **Todo usuário novo começa sem acesso a nada** além da tela de Início; o admin libera depois. Há um painel de **Logs de acesso** que registra cada login (entrou / falhou / bloqueado) com IP e navegador.

## Quando é usado
Na aprovação de um novo usuário, ao liberar/retirar acesso, e a cada vez que alguém tenta abrir uma aba (o sistema confere a permissão).

## Dependências
- [[Persistência]]
- [[Autenticação]]

## Usado por
- [[Server]]
- (todos os módulos com permissão por aba)
