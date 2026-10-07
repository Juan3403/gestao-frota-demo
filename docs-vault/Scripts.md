# Scripts

> Ferramentas de terminal para tarefas técnicas (fora do site).

**Tags:** #infra

## O que faz
Conjunto de pequenos programas rodados por linha de comando para tarefas de bastidor: backup/restauração, varredura de segredos, migração de dados e a trava de versão.

## Por que existe
Algumas tarefas são de manutenção/operação e não fazem sentido como botão no site (são técnicas, ocasionais ou automatizáveis por agendamento).

## Como funciona
Ficam em `scripts/` e na raiz: `scripts/backup.js`/`restore.js` (backup por terminal), `scan-secrets.js` (procura senhas vazadas no código), migração de rastreadores e `check-version.sh` (impede subir código sem atualizar a versão). Trabalham sobre os mesmos dados do app (local ou Mongo), sempre fazendo backup antes de gravar.

## Quando é usado
Em rotinas de manutenção, auditoria de segurança, migrações pontuais e no controle de versão a cada commit.

## Dependências
- [[Persistência]]
- [[Backup]]

## Usado por
- (operação/manutenção, fora do app web)
