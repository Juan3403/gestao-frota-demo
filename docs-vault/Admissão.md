# Admissão

> O formulário que o candidato preenche sozinho, por um link.

**Tags:** #api #db #frontend #publico #rh

## O que faz
Gera um **link único** para o candidato preencher seus dados e enviar documentos **sem precisar de login**. Depois o RH revisa e aplica no cadastro.

## Por que existe
Digitar os dados de cada novo contratado dá trabalho e gera erro. Deixar o próprio candidato preencher economiza tempo do RH e melhora a qualidade da informação.

## Como funciona
O RH gera um link com **token** (`/admissao/<token>`, válido por alguns dias e de uso único). A página pública ([[Página Admissão]]) recebe os dados e anexos. Quando o RH "aplica", o sistema faz um **merge não-destrutivo**: completa o cadastro sem apagar o que já existe. É uma área de permissão própria (`admissao`).

## Quando é usado
Toda vez que a empresa vai contratar alguém novo.

## Dependências
- [[Persistência]]
- [[Mídia]]
- [[Funcionários]]

## Usado por
- (alimenta [[Funcionários]])
