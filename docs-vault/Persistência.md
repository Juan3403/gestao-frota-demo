# Persistência

> Onde os dados ficam guardados — e por que mudam de lugar entre o seu PC e a produção.

**Tags:** #db #core

## O que faz
Guarda e lê todas as informações do sistema (veículos, multas, funcionários…). É a "memória de longo prazo" do app.

## Por que existe
Os dados precisam sobreviver a um fechar de aba ou a um reinício do servidor. Esse módulo garante isso e ainda abstrai uma particularidade do projeto: o lugar de armazenamento muda conforme o ambiente.

## Como funciona
Trabalha em **dois modos**:
- **No seu computador (desenvolvimento):** salva em arquivos `.json` dentro da pasta `data/`. Cada F5 já mostra a mudança.
- **Em produção (Render):** salva no **MongoDB** (um banco de dados na nuvem). Aqui há um detalhe importante: o servidor carrega tudo na memória ao ligar, então mudanças feitas direto no banco só aparecem **após reiniciar**; mudanças feitas pela tela aparecem na hora.

## Quando é usado
Em toda ação que lê ou grava algo — praticamente todos os outros módulos passam por aqui.

## Dependências
- (nenhuma — é a base de tudo)

## Usado por
- [[Veículos]]
- [[Multas]]
- [[Rastreadores]]
- [[Manutenção]]
- [[Abastecimento]]
- [[Fornecedores]]
- [[Contratos]]
- [[Investimentos]]
- [[Funcionários]]
- [[Admissão]]
- [[Integração]]
- [[Feedback]]
- [[Cadastros]]
- [[Histórico]]
- [[Mídia]]
- [[Usuários e Permissões]]
- [[Backup]]
