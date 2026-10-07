# Autenticação

> Quem entra no sistema, e como o site sabe que é você.

**Tags:** #auth #core

## O que faz
Cuida do **login**: confere usuário e senha e mantém você "logado" enquanto navega.

## Por que existe
Os dados da frota são internos da empresa. Sem login, qualquer um com o endereço veria tudo. A autenticação garante que só pessoas autorizadas entrem.

## Como funciona
A senha nunca é guardada "crua" — fica como um **hash + salt** (uma versão embaralhada e irreversível). Depois do login, o site cria um **cookie assinado** (uma espécie de pulseira de festa à prova de falsificação) que identifica você nas próximas telas. Em produção o login é obrigatório; no seu PC, o acesso é livre para facilitar o desenvolvimento. Páginas públicas (admissão, treinamento) entram por um **link com token**, sem precisar de conta.

## Quando é usado
Toda vez que alguém abre o site (em produção) e a cada pedido que precisa saber "quem é você".

## Dependências
- [[Persistência]]
- [[Usuários e Permissões]]

## Usado por
- [[Server]]
- [[Login]]
- [[Usuários e Permissões]]
- [[Modo Manutenção]]
