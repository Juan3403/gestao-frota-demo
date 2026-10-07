# Backup automático para a nuvem

Cópia diária do Gestão RM para um armazenamento de objetos que **a NTE controla sozinha**, sem depender de terceiros.

- **Onde roda:** GitHub Actions ([`.github/workflows/backup-nuvem.yml`](../.github/workflows/backup-nuvem.yml)), 06:00 UTC = 03:00 de Brasília.
- **O que envia:** o mesmo `.zip` do botão "Backup" do site — mesmo manifest, mesmos hashes, mesma guarda de cobertura.
- **Script:** [`scripts/backup-nuvem.mjs`](../scripts/backup-nuvem.mjs).
- **Serve para:** Backblaze B2, Cloudflare R2, Wasabi, MinIO, AWS S3 — todos falam o mesmo protocolo.

## Por que não o SharePoint

O SharePoint da NTE é administrado por uma empresa terceirizada e não temos acesso ao Entra ID, que é onde se cria a credencial de aplicativo necessária para envio automático. Daria para pedir a eles (é um pedido pequeno e legítimo), mas há uma razão melhor para não depender disso: **backup é o que te salva quando tudo dá errado — inclusive a relação com um fornecedor.** Uma suspensão de conta, uma troca de prestador ou uma disputa contratual levaria junto as cópias de segurança.

Aqui a conta é da NTE, a chave é da NTE, e ninguém no meio.

## Por que não lê o Mongo direto

`scripts/backup-lib.js` declara **25 dos 44 módulos** e tem um bug de argumentos no caminho Mongo. Usá-lo produziria backup incompleto **em silêncio**. Passando pela rota do servidor, a rotina herda o `conferirCoberturaBackup`, que faz a geração **falhar** se algum módulo ficar sem cobertura.

---

## Configuração (uma vez, ~15 minutos)

### 1 · Criar o bucket

Exemplo com a **Backblaze B2** (o R2 da Cloudflare é equivalente):

1. Crie a conta em [backblaze.com/b2](https://www.backblaze.com/cloud-storage) e confirme o e-mail.
2. **Buckets → Create a Bucket**. Nome: `gestaorm-backups`. Deixe **Private**.
3. Anote o **Endpoint** que aparece nos detalhes do bucket (algo como `s3.us-west-004.backblazeb2.com`) — a parte `us-west-004` é a sua **região**.

### 2 · Ligar a retenção (importante — é o que apaga os antigos)

No bucket → **Lifecycle Settings** → escolha manter as versões por **90 dias** (ou o prazo que preferir).

Fazemos assim, e não por script, porque o provedor aplica a regra sozinho — mesmo que a rotina pare de rodar.

> **Vale ativar também o Object Lock**, se o provedor oferecer: o arquivo passa a não poder ser apagado nem alterado durante o prazo, **nem por quem tem a chave**. É o que diferencia uma cópia de uma cópia que sobrevive a um ataque de ransomware.

### 3 · Criar a chave de acesso

**Application Keys → Add a New Application Key**:

- Nome: `gestao-rm-backup`
- **Allow access to Bucket:** selecione **apenas** `gestaorm-backups` (não "All")
- **Type of Access:** *Read and Write*

Anote o **keyID** e o **applicationKey**. ⚠️ O segundo **só aparece uma vez**.

Diferente do Azure, **essa chave não expira** — não há data para acompanhar.

### 4 · Emitir a credencial do Gestão RM

Token de máquina com **um escopo só**. Não use a credencial do Estoque RM.

```bash
curl -X POST https://gestao.example.com/api/seguranca/integracoes \
  -H 'Content-Type: application/json' -H 'Origin: https://gestao.example.com' \
  -b 'frota_auth=<seu cookie de admin>' \
  -d '{"nome":"Backup nuvem","escopos":["backup:gerar"]}'
```

A resposta traz `ok`, o resumo da `credencial` e o campo do token, no formato `gdj_itg_<id>` + ponto + segredo. **Guarde-o agora** — ele não é exibido de novo. Revogar é imediato (`DELETE /api/seguranca/integracoes/<id>`), sem redeploy.

> **Escopo é obrigatório na emissão.** Sem o campo `escopos`, a credencial nasce só com `funcionarios:ler` — nunca com o catálogo inteiro. A credencial de backup não lê colaboradores, e a do Estoque RM não baixa backup.

### 5 · Cadastrar no GitHub

**Settings → Secrets and variables → Actions**, aba *Secrets*:

| Segredo | Exemplo |
|---|---|
| `GDJ_BASE_URL` | `https://gestao.example.com` |
| `GDJ_BACKUP_TOKEN` | o token do passo 4 |
| `S3_ENDPOINT` | `https://s3.us-west-004.backblazeb2.com` |
| `S3_REGION` | `us-west-004` (no R2, `auto`) |
| `S3_BUCKET` | `gestaorm-backups` |
| `S3_KEY_ID` | o *keyID* do passo 3 |
| `S3_KEY_SECRET` | o *applicationKey* do passo 3 |

Aba *Variables*, opcional: `S3_PREFIXO` (padrão `gestao-rm/`).

### 6 · Testar antes de confiar

**Actions → Backup para a nuvem → Run workflow**, marcando **dry-run**: baixa o backup, confere que o manifest existe e que ele se declara completo, e **não envia nada**. Se ficar verde, rode de novo sem o dry-run e confira o arquivo no painel do bucket.

Local, na sua máquina:
```bash
GDJ_BASE_URL=https://gestao.example.com GDJ_BACKUP_TOKEN=... \
S3_ENDPOINT=... S3_REGION=... S3_BUCKET=... S3_KEY_ID=... S3_KEY_SECRET=... \
node scripts/backup-nuvem.mjs --dry-run
```

---

## Como recuperar um backup

Pelo painel do bucket, no navegador: entra na conta, navega até `gestao-rm/<ano>/<mês>/` e baixa o `.zip`. Depois é o fluxo normal do sistema — **Backup → Restaurar**, que confere os hashes antes de aplicar e faz uma cópia de segurança do estado atual antes de gravar.

Para ver o bucket como se fosse uma pasta no computador, dá para usar o [Cyberduck](https://cyberduck.io) ou o [rclone](https://rclone.org) com os mesmos dados do passo 3.

## O que faz isto parar sem avisar

1. **Workflow agendado é desativado pelo GitHub após 60 dias sem atividade no repositório.**
2. **O cron do GitHub é UTC e atrasa sob carga** — não conte com o minuto exato.

Falha = execução vermelha no Actions, e o GitHub avisa por e-mail. O cartão de Backup na tela Início também passa a contar a partir destas execuções: a rotina entra no histórico como `integração: <nome da credencial>`.

## O script recusa backup incompleto

Antes de enviar, ele abre o `.zip`, lê o `manifest.json` e exige `completo: true`. Se algum anexo não tiver entrado na geração, **o envio é abortado com erro** em vez de publicar uma cópia furada como se fosse o backup do dia.

Conferir os 2 primeiros bytes (`PK`) não serviria: é o cabeçalho da *primeira* entrada, então todo `.zip` truncado passaria nesse teste.
