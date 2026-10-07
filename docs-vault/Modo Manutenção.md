# Modo Manutenção

> Um aviso entre administradores de que "alguém está mexendo agora".

**Tags:** #auth #api

## O que faz
Mostra um aviso (banner) em tempo real para admins/devs sinalizando que alguém está alterando o sistema naquele momento.

## Por que existe
Evita que duas pessoas mexam ao mesmo tempo sem saber e atrapalhem o trabalho uma da outra (útil em manutenção a quatro mãos).

## Como funciona
Um botão liga/desliga o aviso. O estado fica num registro de configuração e é transmitido na hora para os outros admins (via SSE — uma conexão que "empurra" avisos do servidor para a tela). **Importante: não bloqueia nada**, só sinaliza. Não confundir com a aba [[Manutenção]] (que é de veículos).

## Quando é usado
Quando um admin/dev vai mexer no sistema e quer avisar os colegas.

## Dependências
- [[Persistência]]
- [[Autenticação]]

## Usado por
- [[Frontend SPA]]
