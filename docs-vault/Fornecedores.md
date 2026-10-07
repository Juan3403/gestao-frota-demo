# Fornecedores

> A agenda de oficinas, distribuidoras e concessionárias.

**Tags:** #api #db #frontend

## O que faz
Lista os fornecedores (oficina, autopeças, funilaria, pneus, guincho…) em **cards**, com os serviços que fazem e os tipos de veículo que atendem.

## Por que existe
Quando um carro precisa de serviço, é útil achar rápido "quem conserta isso e atende esse tipo de veículo". Centraliza os contatos que antes ficavam espalhados.

## Como funciona
Cada fornecedor é um card com nome, tipo, serviços, veículos atendidos, contato, cidade/UF e observações. Tem busca por texto e filtro por tipo (chips). O cadastro é feito num modal. Endpoint `/api/fornecedores`.

## Quando é usado
Ao procurar um prestador para um serviço, ou ao cadastrar/atualizar um fornecedor novo.

## Dependências
- [[Persistência]]

## Usado por
- [[Início]]
