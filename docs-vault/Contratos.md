# Contratos

> Os consórcios, financiamentos e empréstimos da empresa.

**Tags:** #api #db #frontend #financeiro

## O que faz
Controla os contratos financeiros: consórcios, financiamentos e empréstimos, com parcelas, valores e situação (pago/pendente).

## Por que existe
A empresa tem várias dívidas/compromissos rolando. Acompanhar parcelas e saldos num lugar só evita atraso, juros e perda de controle do fluxo de caixa.

## Como funciona
Fica no grupo **Financeiro** da barra lateral. Permite importar planilha, editar/excluir/marcar como pago **em lote**, e exportar. Cada contrato guarda fornecedor, banco, produto, parcelas e vencimentos. Endpoint `/api/contratos`.

## Quando é usado
Ao registrar um novo contrato, atualizar pagamentos de parcelas e revisar os compromissos do mês.

## Dependências
- [[Persistência]]
- [[Histórico]]

## Usado por
- [[Simulador]]
