# Feedback

> O mural de sugestões dos usuários.

**Tags:** #api #db #frontend

## O que faz
Um **mural público** onde qualquer usuário envia sugestões, vê as dos outros e apoia (👍) as que achar boas.

## Por que existe
Quem usa o sistema todo dia sabe o que falta ou incomoda. Dar um canal aberto para sugestões ajuda a priorizar melhorias de verdade.

## Como funciona
Diferente de uma caixa de entrada só do admin, aqui todos veem e votam. Dá para anexar imagens (via [[Mídia]]). Os admins **moderam**: respondem, mudam status, ocultam ou excluem. O nome de quem enviou aparece, mas dados internos (quem votou) ficam ocultos. Endpoint `/api/feedbacks`.

## Quando é usado
A qualquer momento em que alguém tem uma ideia ou reclamação sobre o sistema.

## Dependências
- [[Persistência]]
- [[Mídia]]
- [[Usuários e Permissões]]

## Usado por
- (recebe sugestões de todos os módulos)
