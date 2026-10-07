# Backup

> A "cópia de segurança" de tudo — e o jeito de voltar atrás se algo der errado.

**Tags:** #backup #api #db

## O que faz
Gera um arquivo `.zip` com todos os dados do sistema (um arquivo por módulo) + os anexos, e permite **restaurar** a partir dele.

## Por que existe
Erro humano e acidente acontecem (importar a planilha errada, apagar em lote sem querer). Ter backup é a rede de segurança que permite recuperar os dados.

## Como funciona
O `.zip` traz um `manifest.json` que lista cada arquivo com uma "impressão digital" (SHA-256) para garantir que nada foi corrompido. Na restauração dá para **mesclar** (juntar) ou **substituir**, e o sistema faz um backup automático **antes** de gravar. Há também versão por terminal (`scripts/`) e um card de status na tela de Início.

## Quando é usado
Periodicamente (rotina de segurança), antes de mudanças grandes, e na hora de recuperar algo que se perdeu.

## Dependências
- [[Persistência]]
- [[Mídia]]

## Usado por
- [[Início]]
- (cobre as coleções de todos os módulos)
