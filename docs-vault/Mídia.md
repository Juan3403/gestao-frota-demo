# Mídia

> O "cofre" de arquivos: fotos, comprovantes e documentos.

**Tags:** #db #api

## O que faz
Guarda os arquivos anexados no sistema (foto do funcionário, comprovante, documento da multa, imagem de feedback) e os entrega quando alguém autorizado pede para baixar/ver.

## Por que existe
Vários módulos precisam anexar arquivos. Centralizar isso num único cofre evita duplicar lógica e mantém o controle de acesso e segurança num lugar só.

## Como funciona
O upload entra pela memória (limite de 10 MB por arquivo) e é salvo por `salvarMidia`/`lerMidia` — em arquivo local (`data/uploads/`) ou no banco, conforme o ambiente. O download passa por `/api/midia/:id`, que confere a permissão e envia o arquivo de forma segura (impede o navegador de "executar" o que não deve).

## Quando é usado
Ao anexar foto/documento de um funcionário, enviar imagem num feedback, anexar comprovante, etc. — e quando alguém baixa esses arquivos.

## Dependências
- [[Persistência]]
- [[Autenticação]]

## Usado por
- [[Funcionários]]
- [[Admissão]]
- [[Integração]]
- [[Feedback]]
- [[Rastreadores]]
- [[Backup]]
