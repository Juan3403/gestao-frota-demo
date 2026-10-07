# Histórico

> O "diário" do sistema: quem mudou o quê e quando.

**Tags:** #db #api

## O que faz
Registra as alterações importantes — por exemplo, "Fulano trocou o centro de custo do veículo X".

## Por que existe
Quando algo muda (um valor, um responsável), é preciso saber **quem fez e quando**, para auditoria e para resolver dúvidas ("por que esse carro mudou de dono?").

## Como funciona
Cada ação relevante grava uma linha com data/hora, autor, a placa ou rastreador envolvido e um texto explicando. Dá para filtrar por placa (clicando na placa) ou por rastreador.

## Quando é usado
Sempre que alguém edita, cria ou exclui algo nos módulos que têm rastro (veículos, multas, manutenção, etc.).

## Dependências
- [[Persistência]]

## Usado por
- [[Veículos]]
- [[Multas]]
- [[Rastreadores]]
- [[Manutenção]]
- [[Abastecimento]]
- [[Contratos]]
- [[Cadastros]]
