# Rastreadores

> Os aparelhos de rastreamento (Cobli) instalados nos veículos.

**Tags:** #api #db #frontend

## O que faz
Controla os rastreadores: qual aparelho está em qual carro, o tipo, a situação e o histórico de instalação/remoção.

## Por que existe
A frota usa rastreadores para localização e segurança. É preciso saber onde cada aparelho está, quais sobraram e o que já foi devolvido — senão perde-se equipamento.

## Como funciona
O identificador único é o **N° Cobli**. Há tipos (Instalado/Removível/Outros), importação por planilha, cards de status clicáveis e histórico por rastreador. Fotos de instalação ficam no cofre de [[Mídia]].

## Quando é usado
Ao instalar/remover um rastreador, importar a lista da Cobli, ou conferir o estoque de aparelhos.

## Dependências
- [[Persistência]]
- [[Histórico]]
- [[Mídia]]
- [[Veículos]]

## Usado por
- [[Início]]
