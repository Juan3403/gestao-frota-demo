# Arquivos (anexos) no Cloudflare R2

Guia para tirar do MongoDB o **cofre de arquivos** (fotos, PDFs, assinaturas, documentos de admissão, faturas, evidências etc.) e guardá-lo num bucket do **Cloudflare R2**.

- **Por quê:** em set/2026 o cofre ocupava **4,87 GB dos 4,89 GB do banco** (99,5%), guardado em base64 (+33% de tamanho) e crescendo cerca de 1,3 GB por mês. No R2 o mesmo acervo ocupa uns 3,65 GB, e os 10 GB grátis cobrem uns 6 meses; depois custa US$ 0,015 por GB/mês. Sem os arquivos, o Mongo fica com uns 24 MB.
- **Código:** [`backend/cofre-midia.js`](../backend/cofre-midia.js) (driver do bucket) e as funções `salvarMidia`/`lerMidia`/`existeMidia`/`excluirMidia` em [`backend/server.js`](../backend/server.js). Migração: [`scripts/migrar-midia-r2.js`](../scripts/migrar-midia-r2.js). Medição do banco: [`scripts/diagnostico-armazenamento-mongo.js`](../scripts/diagnostico-armazenamento-mongo.js).
- **Tempo:** uns 15 minutos de configuração, mais o tempo da cópia (depende da sua internet: 3,65 GB descem do Atlas e sobem para o R2).

## Como funciona

Com a variável `MIDIA_S3_BUCKET` definida no Render:

| Situação | O que o sistema faz |
|---|---|
| Arquivo **novo** (qualquer upload, assinatura, PDF gerado) | Vai **só** para o R2, em binário. O Mongo não recebe mais nada. |
| **Abrir/baixar** um arquivo | Procura no R2; se não achar, procura no Mongo. É isso que deixa copiar o acervo antigo **aos poucos, com o site no ar**. |
| **Excluir** um anexo | Apaga dos dois lugares (senão a procura no Mongo "ressuscitaria" o excluído). |
| **Desfazer** uma exclusão | Funciona para o arquivo que estava no R2 e para o que ainda estava no Mongo. |
| **Faxina diária** de arquivos sem uso | Varre o R2 também, com a mesma regra de sempre: só apaga o que nenhum registro cita e tem mais de 1 hora. |
| **Backup** (.zip) | Lê os anexos do R2 e do Mongo. O teto de anexos por backup continua o mesmo (ver [Antes de apagar do Mongo](#antes-de-apagar-do-mongo-a-cópia-do-bucket)). |
| R2 **fora do ar** ou travado | O que ainda está no Mongo continua abrindo normalmente. A leitura espera o R2 começar a responder por no máximo 8 s (com uma 2ª tentativa curta) e, depois de 3 falhas seguidas, pula o R2 por 30 s e vai direto ao Mongo. Recibo, ficha de EPI e termo de TI **não** saem sem a assinatura nesse meio-tempo: respondem "indisponível, tente de novo". O que só existe no R2 responde "cofre indisponível, tente de novo" (nunca "arquivo removido"). O envio falha às claras: **não** cai escondido no Mongo. |
| **Localhost** e `npm test` (sem `MONGODB_URI`) | As `MIDIA_S3_*` são **ignoradas**, mesmo definidas no terminal ou no `.env`. Assim a base de teste nunca encosta no bucket de produção (a faxina de órfãs apagaria de lá o que a base de teste não cita). Para testar contra um bucket **de teste**: `MIDIA_S3_LOCAL=1`. |

Sem `MIDIA_S3_BUCKET`, nada muda: os arquivos continuam no Mongo (produção) ou em `data/uploads` (localhost).

---

## Configuração (uma vez)

### 1 · Criar o bucket de arquivos

No painel da Cloudflare ([dash.cloudflare.com](https://dash.cloudflare.com)) → **R2 Object Storage** → **Create bucket**:

- Nome: `gestaorm-arquivos`
- Location: **Automatic** · Storage class: **Standard**

O bucket nasce **privado** e assim deve ficar: **sem** *Public access*, **sem** *r2.dev subdomain*, **sem** *Custom domain*, **sem** CORS. O navegador nunca fala com o bucket: todo arquivo passa pelo servidor, que confere a permissão de quem pede.

- **Bucket separado** do de backup e do de vídeos. O de backup tem regra que apaga arquivos antigos sozinha.
- **Nunca crie regra de expiração** (*Settings → Object lifecycle rules*) neste bucket. A limpeza do que deixa de ser usado é feita pelo próprio sistema.

### 2 · Criar o token de acesso

**R2 Object Storage → Manage API tokens → Create API token** (*Account API token*):

- Token name: `gestao-rm-arquivos`
- **Permissions:** **Object Read & Write**
- **Specify bucket(s):** **Apply to specific buckets only** → marque **só** `gestaorm-arquivos`
- TTL: **Forever**

A tela seguinte mostra o **Access Key ID** e o **Secret Access Key** (este só aparece uma vez). Não cole em chat, e-mail nem planilha.

> O token dos vídeos foi criado só para o bucket `gestaorm-videos` ([VIDEOS_TREINAMENTO.md](VIDEOS_TREINAMENTO.md)), por isso os arquivos precisam de token próprio.

### 3 · Cadastrar no Render

Serviço do Gestão RM → **Environment**:

| Variável | Valor | Obrigatória |
|---|---|---|
| `MIDIA_S3_BUCKET` | `gestaorm-arquivos` (o nome, não é segredo) | **sim** |
| `MIDIA_S3_KEY_ID` | o *Access Key ID* do passo 2 | **sim** |
| `MIDIA_S3_KEY_SECRET` | o *Secret Access Key* do passo 2 | **sim** |
| `MIDIA_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | não: sem ela, usa o `VIDEO_S3_ENDPOINT` que já está lá (mesma conta) |
| `MIDIA_S3_REGION` | `auto` | não: usa a dos vídeos ou `auto` |

As três primeiras vão **juntas**. As chaves dos vídeos (`VIDEO_S3_KEY_*`) **não** são usadas: aquele token só enxerga o bucket de vídeos.

Salve e faça o **deploy**. Configuração errada **não derruba o site**. No boot, o sistema grava, relê e apaga um arquivo de teste no bucket. Se faltar variável, ou se o R2 recusar o acesso (chave errada, token sem permissão, bucket com outro nome), o R2 fica **desligado** naquela instância: os anexos continuam indo para o Mongo e abrindo normalmente, e o aviso aparece no log e no painel (passo 4). Corrija e faça o deploy de novo.

**Depois que o R2 funcionou uma vez**, a regra muda: a partir dali há anexos que só existem no bucket. Se mais tarde a chave for trocada, revogada ou vencer, desligar o R2 faria esses anexos parecerem **apagados**. Então ele fica ligado e com erro: esses anexos respondem "cofre indisponível" (o que ainda está no Mongo segue abrindo), os envios falham, e o log e o painel ficam vermelhos. É para ser corrigido **na hora**. O mesmo aviso aparece se as `MIDIA_S3_*` forem apagadas do Render. **Não troque de bucket** depois de ligado sem copiar os arquivos antes: o sistema guarda qual bucket recebeu anexos e continua avisando.

### 4 · Conferir

- **Log do boot** (Render → Logs): `Cofre de arquivos: bucket "gestaorm-arquivos" em https://… (reserva dos arquivos antigos: banco (Mongo))`. Se aparecer `⚠ R2 NÃO LIGADO: …`, o motivo vem escrito logo depois.
- **Painel do desenvolvedor → Serviços → Cofre de mídia**: verde com `bucket "gestaorm-arquivos": leitura e escrita ok`. O teste grava, relê e apaga um arquivo de teste.
- **Na prática:** anexe um arquivo em qualquer tela (uma foto numa vistoria, por exemplo), abra e baixe. No painel do R2 aparece um objeto novo em `midia/`.

A partir deste ponto o Mongo **para de crescer**.

---

## Migração do acervo antigo

Tudo pelo [`scripts/migrar-midia-r2.js`](../scripts/migrar-midia-r2.js), no PowerShell, da pasta do projeto. Cada etapa é um comando e **todas são retomáveis**: rodar de novo continua de onde parou. Nenhum nome de arquivo nem dado pessoal aparece na tela, só ids `MD-…`, contagens e tamanhos.

Prepare o terminal (aspas **simples**: nas duplas o PowerShell come o `$` de uma senha). A URI e as chaves são as mesmas do Render:

```powershell
$env:MONGODB_URI='mongodb+srv://...'
$env:MIDIA_S3_ENDPOINT='https://<ACCOUNT_ID>.r2.cloudflarestorage.com'
$env:MIDIA_S3_BUCKET='gestaorm-arquivos'
$env:MIDIA_S3_KEY_ID='...'
$env:MIDIA_S3_KEY_SECRET='...'
```

| # | Comando | O que faz |
|---|---|---|
| 1 | `node scripts/migrar-midia-r2.js` | **Simulação.** Conta o que está no Mongo, o que já está no R2 e o que falta. Não grava nada. |
| 2 | `node scripts/migrar-midia-r2.js --copiar --limite=20` | Ensaio com 20 arquivos. Confira no painel do R2 e abra alguns anexos antigos no site. |
| 3 | `node scripts/migrar-midia-r2.js --copiar` | Copia o resto. **Não apaga nada do Mongo.** Pode rodar com o site no ar. |
| 4 | `node scripts/migrar-midia-r2.js --conferir` | Baixa cada arquivo do R2 e compara byte a byte (SHA-256) com o do Mongo. |
| 5 | *(cópia do bucket, abaixo)* | Antes de o Mongo deixar de ter a 2ª cópia. |
| 6 | `node scripts/migrar-midia-r2.js --apagar-do-mongo` | Confere de novo, arquivo por arquivo, e só apaga do Mongo o que está idêntico no R2. Pede para digitar `APAGAR DO MONGO`. |

Ao terminar: `Remove-Item Env:MONGODB_URI, Env:MIDIA_S3_KEY_SECRET`. Use esse terminal **só** para o script. Com a `MONGODB_URI` definida, um `npm run dev` ali sobe o sistema local ligado no banco **de produção**.

Se alguém excluir um anexo no site bem na hora em que ele está sendo copiado, a cópia fica no bucket de propósito. O Desfazer pode ter devolvido o anexo para lá, e apagar perderia a única cópia. Se ninguém mais usar o arquivo, a faxina diária do site apaga depois.

Travas do passo 6:

- **Recusa** se não houver prova de que o **site de produção** lê do mesmo bucket **agora**. Apagar com o site no código antigo tiraria do ar todo anexo antigo. A prova combina duas coisas:
  - o marcador `cofre_r2`, gravado no Mongo pelo site no Render a cada boot e renovado a cada 5 minutos. Ele precisa ter sido gravado pelo Render (e não por um servidor local), apontar para o mesmo bucket e o mesmo endereço, e ter dado sinal de vida nos últimos 15 minutos;
  - o próprio site, consultado em `https://gestao.example.com/api/versao` (troque com `$env:GDJ_SITE_URL`). O deploy que está no ar tem de ser o mesmo que gravou o marcador. Isso pega o *rollback* no Render e o deploy novo que falhou (o Render mantém o anterior no ar).

  Essa consulta também **acorda o site** se ele estiver dormindo, então em geral basta rodar de novo. Se o relógio do seu computador estiver atrasado, o script avisa para acertar a hora do Windows.
- A cada 50 arquivos o script **para tudo e refaz a prova inteira**. Se o site não responder, espera e tenta de novo por até 5 minutos. Se continuar sem prova (por exemplo, depois de um rollback ou de um deploy que desligou o R2), **interrompe** sem apagar mais nada. É retomável.
- Sai com código de erro (1) se recusou, se foi interrompido ou se algum arquivo deu problema.
- Arquivo que não está no R2, ou que está **diferente**, não é apagado: aparece na lista de problemas.
- Antes do 1º apagamento, o script marca no Mongo que o acervo passou a morar no R2. Se algum dia o site subir **sem** o R2 (variável apagada, bucket trocado), o log e o painel de Serviços avisam em vermelho, e esses anexos respondem "indisponível", nunca "apagado".

Depois do passo 6, o tamanho "de dados" no Atlas cai na hora. O "em disco" pode levar um tempo, porque o Mongo reaproveita o espaço antes de devolvê-lo. Para conferir, use `node scripts/diagnostico-armazenamento-mongo.js`.

Com o banco pequeno, dá para reduzir o plano do Atlas. Para voltar ao grátis (M0, 512 MB), normalmente é preciso criar um cluster novo e copiar os dados, que ficam em ~24 MB. O M0 não tem backup automático nem o desempenho do Flex; teste antes de trocar.

## Antes de apagar do Mongo: a cópia do bucket

Enquanto o Mongo guarda os arquivos, existem **duas cópias**. Depois do passo 6, **só uma**, e:

- o **backup .zip** do site (botão Backup e o [backup diário na nuvem](BACKUP_NUVEM.md)) leva **no máximo 50 MB de anexos** por vez. Isso já era assim antes do R2: hoje ele não cobre o acervo;
- o R2 **não tem lixeira**: arquivo apagado lá não volta.

Então, antes do passo 6, tenha uma cópia do bucket fora dele. Qualquer uma destas serve:

- **Snapshot do Atlas** logo antes do passo 6, se o seu plano tiver backup: guarda o Mongo como estava, com os arquivos dentro.
- **Cópia no seu computador ou num HD**, com o [rclone](https://rclone.org/downloads/). Configure um remoto do tipo *S3 → Cloudflare R2* com as mesmas chaves e rode:

  ```powershell
  rclone copy r2:gestaorm-arquivos D:\backup-gestaorm-arquivos --progress
  ```

  Rodar de novo só baixa o que é novo. A chave precisa de leitura no bucket (a do passo 2 serve).

O ideal, depois da migração, é uma cópia periódica automática do bucket, por exemplo um GitHub Action semanal para o Backblaze B2 que o backup diário já usa.

## O que muda para quem usa o site

Nada visível. Os anexos abrem, baixam, entram no .zip e no Desfazer como antes. Os anexos antigos continuam abrindo durante toda a migração.

Para scripts de linha de comando: os diagnósticos da Admissão leem do R2 quando as variáveis `MIDIA_S3_*` estão definidas no terminal. Sem elas, e com anexos que só existem no bucket, eles param e avisam, em vez de dar os arquivos como ausentes. O [`scripts/backup.js`/`restore.js`](../scripts/backup-lib.js) tem a mesma trava, mas **no modo Mongo ele já não funcionava antes desta mudança** (defeito antigo em `lerMongoMod`, com os argumentos trocados). Para backup, use o botão Backup do site ou o [backup na nuvem](BACKUP_NUVEM.md).

## Problemas comuns

| Mensagem | Causa e solução |
|---|---|
| `⚠ R2 NÃO LIGADO: Faltam as chaves do token…` | Só o bucket foi cadastrado. Cadastre `MIDIA_S3_KEY_ID` e `MIDIA_S3_KEY_SECRET` (passo 2). |
| `⚠ R2 NÃO LIGADO: Falta MIDIA_S3_ENDPOINT…` | Não há `MIDIA_S3_ENDPOINT` nem `VIDEO_S3_ENDPOINT`. Cadastre o endereço da conta. |
| `…deve ter só o endereço da conta, sem o bucket no fim` | O endpoint foi colado com `/gestaorm-arquivos` no fim. Tire; o bucket vai em `MIDIA_S3_BUCKET`. |
| `Defina MIDIA_S3_KEY_ID e MIDIA_S3_KEY_SECRET juntas` | Só uma das duas foi cadastrada. |
| `O R2 recusou o acesso no boot e ficou desligado. …SignatureDoesNotMatch` | Segredo errado (ou com espaço/quebra de linha colada junto) ou região diferente de `auto`. |
| `O R2 recusou o acesso no boot e ficou desligado. …AccessDenied` | O token não tem **Object Read & Write** neste bucket. |
| `O R2 recusou o acesso no boot e ficou desligado. …NoSuchBucket` | Nome do bucket cadastrado diferente do criado. |
| `O teste do R2 no boot não respondeu (…). O R2 segue ligado.` | Falha passageira de rede na subida. O R2 continua ligado; confira o painel de Serviços depois de alguns minutos. |
| `O R2 recusou o acesso no boot. … Ele segue ligado porque há anexos que só existem nele` | A chave foi trocada, revogada ou venceu depois que o R2 já estava em uso. Cadastre as chaves certas no Render e faça o deploy **já**: até lá esses anexos não abrem e os envios falham. |
| `Há anexos que só existem no bucket "…", mas esta instância está sem o R2` | As `MIDIA_S3_*` sumiram do Render (ou apontam para outro bucket). Restaure-as e faça o deploy. |
| Script: `RECUSADO: o site não dá sinal há N min` | O site está dormindo ou voltou para uma versão sem o R2. Abra o site, espere 1 minuto e rode de novo. Se persistir, confira no Render qual deploy está no ar. |
| Script: `RECUSADO: o marcador não foi gravado pelo site no Render` | Quem gravou foi um servidor local ligado no Mongo de produção. Faça um deploy (ou reinicie o serviço no Render) e rode de novo. |
| Script: `INTERROMPIDO: …` (seguido do motivo, ex.: `o site lê o bucket …`, `o site no ar está no deploy …`, `não consegui ler o marcador …`) | No meio do apagar, o site deixou de provar que lê deste bucket (um deploy desligou o R2, trocou o bucket, voltou para versão antiga) ou o Mongo não respondeu por 5 min. Nada mais foi apagado; confira o Render e rode de novo. |
| Backup/restore por terminal ou diagnóstico: `Há anexos que só existem no bucket R2…` | Defina as `MIDIA_S3_*` no terminal (as mesmas do Render) e rode de novo. Sem elas, o backup sairia sem esses anexos, e o diagnóstico os daria como ausentes. |
