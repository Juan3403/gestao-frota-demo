# Funcionários

> O módulo de RH: cadastro completo da equipe e seus documentos.

**Tags:** #api #db #frontend #rh

## O que faz
Guarda o cadastro dos colaboradores (dados pessoais e profissionais), seus documentos, CNH, EPIs/ferramentas, e avisa o que está **vencido ou faltando**.

## Por que existe
O RH precisa garantir que cada função tenha os documentos obrigatórios em dia (ASO, NRs, CNH válida…). Esquecer um documento vencido é risco trabalhista e de segurança.

## Como funciona
O cadastro é organizado em **abas** dentro de um formulário. Existe uma **matriz de obrigatórios** por cargo/contrato: o sistema cruza o que a função exige com o que a pessoa tem e acende "Falta obrigatório" ou "Vencido". Tem aba de **Pendências** e **Dashboard**. Fotos e documentos ficam no cofre de [[Mídia]]. Endpoints `/api/funcionarios`.

## Quando é usado
Ao admitir alguém, anexar/renovar documentos, e na rotina de conferir pendências (vencidos / a vencer / faltando).

## Dependências
- [[Persistência]]
- [[Mídia]]
- [[Histórico]]
- [[Cadastros]]

## Usado por
- [[Admissão]]
- [[Integração]]
- [[Início]]
