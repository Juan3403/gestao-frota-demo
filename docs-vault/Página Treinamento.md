# Página Treinamento

> A tela pública onde o colaborador assiste ao vídeo e faz a prova.

**Tags:** #frontend #publico #rh

## O que faz
Mostra o vídeo do treinamento (player 16:9 do Google Drive) e a prova para o colaborador responder.

## Por que existe
Permite que o colaborador faça o treinamento por um link, **sem precisar de conta** no sistema — simples para quem é de campo.

## Como funciona
`public/treinamento.html` + `public/treinamento.js`. O acesso é por **token**. A prova é corrigida no servidor e o **gabarito não é enviado** para a tela (para não dar para "colar" olhando o código). Conecta com o módulo [[Integração]].

## Quando é usado
Quando o colaborador recebe o link de um treinamento para concluir.

## Dependências
- [[Integração]]

## Usado por
- (acessada por link/token pelo colaborador)
