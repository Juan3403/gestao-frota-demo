# Veículos

> O coração do sistema: a lista de todos os carros da frota.

**Tags:** #api #db #frontend

## O que faz
É a aba **Frota**: a tabela com todos os veículos, editável direto na tela, com valor FIPE, status, centro de custo e a divisão entre os sócios.

## Por que existe
A empresa precisa de um lugar único e confiável com todos os veículos, seus valores e a quem pertencem — base para relatórios financeiros e decisões.

## Como funciona
A tabela é **editável inline** (clica e muda na hora, com "pílulas" para status/gravame/centro de custo). Tem filtros, seleção por checkbox que soma os valores (FIPE/Ricardo/Marcelo) no rodapé, exportar/importar Excel e histórico por placa (clicando na placa). Cada veículo guarda `placa`, `valorFipe`, e o percentual de cada sócio.

## Quando é usado
No dia a dia da gestão: ao comprar/vender um carro, atualizar valor, mudar responsável ou conferir a frota.

## Dependências
- [[Persistência]]
- [[Histórico]]
- [[Cadastros]]

## Usado por
- [[Multas]]
- [[Rastreadores]]
- [[Manutenção]]
- [[Início]]
