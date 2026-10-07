# Integração

> Os treinamentos da equipe (vídeo + prova) e o atestado de conclusão.

**Tags:** #api #db #frontend #publico #rh

## O que faz
Catálogo de treinamentos (NRs e cursos): cada um tem um vídeo e uma prova. Quando o colaborador é aprovado, gera um **atestado em PDF** e controla a **reciclagem** (validade).

## Por que existe
Certos treinamentos são obrigatórios por lei e têm validade. Ter um registro de quem fez, quando e até quando vale é exigência de segurança do trabalho — e prova em fiscalização.

## Como funciona
O RH cadastra o treinamento (vídeo do Google Drive + questões). O colaborador acessa uma **página pública por token** ([[Página Treinamento]]), assiste e faz a prova **sem login**; a correção é feita no servidor (o gabarito não é exposto). Aprovado, sai o atestado e a data de reciclagem (ex.: 90 dias). Endpoints `/api/treinamentos`.

## Quando é usado
Na integração de novos colaboradores e nas reciclagens periódicas dos treinamentos.

## Dependências
- [[Persistência]]
- [[Mídia]]
- [[Funcionários]]

## Usado por
- [[Página Treinamento]]
