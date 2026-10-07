# Início

> A tela de boas-vindas, com um resumo e atalhos.

**Tags:** #frontend

## O que faz
É a primeira tela ao entrar: mostra contadores ao vivo (quantos veículos, multas, rastreadores, fornecedores) e atalhos para as abas.

## Por que existe
Dá um panorama rápido do sistema e facilita a navegação para quem está chegando, em vez de cair numa tela vazia.

## Como funciona
Estilo "welcome" (parecido com o do VS Code). Lê os totais de cada módulo e mostra cartões com atalhos. Para admins, exibe também um card com o status do [[Backup]]. É a aba padrão na primeira visita.

## Quando é usado
Ao abrir o sistema, especialmente na primeira vez.

## Dependências
- [[Veículos]]
- [[Multas]]
- [[Rastreadores]]
- [[Fornecedores]]
- [[Backup]]

## Usado por
- (porta de entrada do app)
