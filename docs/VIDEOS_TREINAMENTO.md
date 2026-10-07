# Vídeos de treinamento no Cloudflare R2

Guia para ligar o **player travado** dos treinamentos da Integração: o vídeo fica guardado num bucket do **Cloudflare R2** da própria NTE e o colaborador assiste pela página do link sem conseguir pular.

- **Onde fica o vídeo:** só no bucket R2. O servidor do Render nunca guarda o arquivo inteiro, nem em disco nem em memória.
- **Código:** [`backend/videos-treino.js`](../backend/videos-treino.js) (assinatura S3, drivers `s3` e `local`) e as rotas `/api/treinamentos/videos/*` em [`backend/server.js`](../backend/server.js).
- **Tempo de configuração:** uns 15 minutos, uma vez só.

## Para que serve

Com o vídeo enviado pelo sistema, a página do colaborador troca o player do Google Drive por um player próprio que:

- **não deixa adiantar** (arrastar para a frente volta para onde ele parou);
- **não deixa acelerar** (a velocidade sempre volta para 1×);
- **só libera a prova no fim do vídeo**. O servidor também confere o tempo: a prova é recusada se o vídeo "terminou" antes da duração real;
- **retoma de onde parou** se a pessoa fechar a página e abrir de novo;
- **não exige rever o vídeo** para refazer a prova depois de uma reprovação.

**Treinamentos com link do Google Drive continuam exatamente como estão**, sem trava. Não é preciso migrar tudo de uma vez: dá para ir um por um, no seu ritmo.

### Como migrar um treinamento

1. **Integração → Treinamentos**, abra o treinamento.
2. No bloco **Vídeo**, escolha **Enviar arquivo (trava o avanço)** e selecione o MP4.
3. Espere a barra de progresso chegar ao fim (o **Salvar** fica bloqueado durante o envio).
4. **Salvar.**

No Catálogo, cada treinamento mostra uma etiqueta: **Vídeo · 12 min** (já migrado, com trava) ou **Drive (sem trava)** (ainda falta migrar).

> Trocar o vídeo de um treinamento (enviar outro arquivo) faz **quem ainda não foi aprovado assistir de novo**. Quem já foi aprovado não é afetado.

---

## Configuração (uma vez)

### 1 · Criar o bucket de vídeos

No painel da Cloudflare ([dash.cloudflare.com](https://dash.cloudflare.com)):

1. **R2 Object Storage** no menu lateral. Se for o primeiro uso, ative o R2 (pede um cartão, mas o uso dentro da faixa grátis não é cobrado; ver [Custos](#custos)).
2. **Create bucket**.
   - Nome: `gestaorm-videos` (ou outro, só letras minúsculas, números e hífen).
   - Location: **Automatic**.
   - Storage class: **Standard**.
3. Confirme. O bucket nasce **privado**, e é assim que deve ficar:
   - **não** ligue o *Public access* / *r2.dev subdomain*;
   - **não** configure *Custom domain*;
   - **não** precisa de CORS (explicação em [Por que não precisa de CORS](#por-que-não-precisa-de-cors)).

**Use um bucket SEPARADO do bucket de backup.** O bucket de backup ([BACKUP_NUVEM.md](BACKUP_NUVEM.md)) tem regra de retenção que **apaga os arquivos antigos sozinha**. Vídeo colocado lá sumiria depois de alguns meses e os treinamentos parariam de tocar. Nunca aponte os vídeos para o bucket de backup.

**No bucket de vídeos, NÃO crie regra de expiração** (*Settings → Object lifecycle rules*). Os vídeos precisam ficar lá enquanto o treinamento existir; a limpeza do que deixa de ser usado é feita pelo próprio sistema, com carência (ver [Backup](#backup-o-que-entra-e-o-que-não-entra)). Se o R2 já tiver criado sozinho uma regra que **só cancela envios em partes incompletos** (*abort incomplete multipart uploads*), pode deixar: ela não apaga vídeo pronto.

### 2 · Criar o token de acesso

Ainda em **R2 Object Storage**, na página inicial do R2:

1. **Manage API tokens** (às vezes aparece como **{} API → Manage API tokens**) → **Create API token** (o de conta, *Account API token*, é o mais indicado: não depende do seu usuário).
2. Preencha:
   - Token name: `gestao-rm-videos`
   - **Permissions:** **Object Read & Write**
   - **Specify bucket(s):** escolha **Apply to specific buckets only** e marque **apenas** `gestaorm-videos` (não "All buckets"; o token não deve enxergar o bucket de backup)
   - TTL: **Forever** (ou um prazo, se preferir trocar a chave de tempos em tempos; aí anote a data)
3. **Create API Token.** A tela seguinte mostra:
   - **Access Key ID** → vai em `VIDEO_S3_KEY_ID`
   - **Secret Access Key** → vai em `VIDEO_S3_KEY_SECRET`. **Só aparece uma vez**: copie agora.
   - o **endpoint para clientes S3**, no formato `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` → vai em `VIDEO_S3_ENDPOINT`

Não cole essas chaves em chat, e-mail, planilha nem no `.env.example`. O lugar delas é o painel do Render (passo 3).

### Account ID e endpoint

O **Account ID** aparece no lado direito da página inicial do R2 (*Account Details*). O endpoint é sempre:

```
https://<ACCOUNT_ID>.r2.cloudflarestorage.com
```

- **Só o endereço**, sem o nome do bucket no fim. `https://<ACCOUNT_ID>.r2.cloudflarestorage.com/gestaorm-videos` está **errado**: o sistema recusa e avisa. O bucket vai em `VIDEO_S3_BUCKET`.
- Se o bucket foi criado numa *jurisdiction* específica (ex.: EU), o endpoint muda (`https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com`). Use o que a tela do token mostrou.

### 3 · Cadastrar no Render

No [Render](https://dashboard.render.com), serviço do Gestão RM → **Environment** → **Add Environment Variable**:

| Variável | Valor | Obrigatória |
|---|---|---|
| `VIDEO_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` | sim |
| `VIDEO_S3_REGION` | `auto` | sim |
| `VIDEO_S3_BUCKET` | `gestaorm-videos` | sim |
| `VIDEO_S3_KEY_ID` | o *Access Key ID* do passo 2 | sim |
| `VIDEO_S3_KEY_SECRET` | o *Secret Access Key* do passo 2 | sim |
| `VIDEO_MAX_MB` | tamanho máximo de um vídeo, em MB. Padrão `1024` (1 GB) | não |
| `VIDEO_URL_TTL_MIN` | por quantos minutos vale o link temporário do vídeo. Padrão `360` (6 h); a página renova sozinha quando vence | não |
| `VIDEO_ORFAO_DIAS` | dias de carência antes de apagar um vídeo que deixou de ser usado. Padrão `90` | não |

Regras:

- **As cinco primeiras vão juntas.** Com só algumas preenchidas, o envio de vídeo fica desligado e o sistema diz quais faltam.
- Sem espaço antes ou depois dos valores (o sistema ignora, mas o copiar/colar às vezes traz quebra de linha junto).
- Se aumentar o `VIDEO_ORFAO_DIAS`, tudo bem. **Não diminua** para menos que a retenção do backup (90 dias), pelo motivo explicado em [Backup](#backup-o-que-entra-e-o-que-não-entra).

Depois de salvar, faça o **redeploy** (*Save Changes* e confirme o deploy, ou **Manual Deploy → Deploy latest commit**). Variável nova só vale depois que o serviço reinicia. No log do boot aparece qual armazenamento de vídeos ficou ativo.

### 4 · Testar a conexão

No site, logado como **admin**:

1. **Integração → Treinamentos**, abra um treinamento (ou **Novo treinamento**).
2. No bloco **Vídeo**, clique em **Testar conexão**.

O teste lista o bucket e abre e cancela um envio de mentira, sem deixar arquivo nenhum. Resposta esperada:

```
Conexão com o bucket "gestaorm-videos" ok: leitura e escrita.
```

Se der erro, a mensagem diz o motivo (ver [Problemas comuns](#problemas-comuns)).

Depois, para ter certeza de ponta a ponta: envie um vídeo curto num treinamento de teste, gere um link para você mesmo e abra **num iPhone e num Android de verdade**.

---

## Por que não precisa de CORS

- **Envio:** o arquivo vai do navegador para o **nosso servidor** em pedaços de 6 MB, e o servidor repassa cada pedaço ao R2. O navegador nunca fala direto com o bucket para gravar. De quebra, a chave secreta do R2 nunca sai do servidor e o servidor confere se o arquivo é mesmo um vídeo.
- **Assistir:** o celular do colaborador baixa o vídeo **direto do R2** por um link assinado e temporário (6 h por padrão). Um `<video>` comum tocando um link não precisa de CORS. O site já libera o endereço do R2 na política de segurança (CSP) sozinho, a partir do `VIDEO_S3_ENDPOINT`.

Como o vídeo não passa pelo Render na hora de assistir, não pesa no plano grátis. Enquanto o vídeo toca, a página faz um "batimento" leve a cada 5 minutos para o servidor não dormir e a prova liberar sem espera no fim.

---

## Preparar o vídeo

O formato que toca em todo celular (iPhone e Android) e no computador:

| Item | Valor |
|---|---|
| Arquivo | **MP4** |
| Vídeo | **H.264** |
| Áudio | **AAC**, 128 kbps, estéreo |
| Resolução | **720p** (1280×720) |
| Taxa | **1,5 a 2,5 Mbps** |
| Otimizado para web | **sim** |

Isso dá uns **15 MB por minuto**: um treinamento de 20 minutos fica perto de 300 MB. O limite padrão é 1 GB por vídeo e 4 horas de duração.

### Com o HandBrake (grátis)

1. Baixe em [handbrake.fr](https://handbrake.fr) e abra o vídeo original.
2. **Preset:** *General → Fast 720p30*.
3. Aba **Summary**: Format **MP4** e marque **Web Optimized** (em português, *Otimizado para Web*). Isso põe o índice do vídeo no começo do arquivo, e o vídeo começa a tocar sem baixar tudo antes.
4. Aba **Video**: Video Encoder **H.264 (x264)**; em Quality, *Avg Bitrate* **2000** kbps (ou *Constant Quality* RF 22 a 23).
5. Aba **Audio**: **AAC**, 128 kbps.
6. **Start Encode** e envie o arquivo gerado.

### Cuidados

- **`.mov` do iPhone em HEVC (H.265) não toca em vários Androids** e o sistema recusa `.mov`. Converta pelo HandBrake antes de enviar. Para gravar já compatível no iPhone: *Ajustes → Câmera → Formatos → Mais Compatível*.
- **WebM** também é aceito, mas o suporte no iPhone é irregular. Prefira MP4.
- Se o navegador não conseguir ler a duração do arquivo na hora de enviar, ele avisa: quase sempre é codec HEVC ou arquivo não otimizado para web. Converta e tente de novo.

---

## Backup: o que entra e o que não entra

- **Os vídeos NÃO entram no `.zip` do backup** (nem no botão "Backup" do site, nem no [backup automático para a nuvem](BACKUP_NUVEM.md)). Seriam gigabytes a cada cópia. O backup guarda só o cadastro do treinamento, que aponta para o vídeo no bucket.
- **Os vídeos ficam no bucket R2.** O R2 é durável, mas é uma cópia só.
- **Guarde os arquivos originais** (a versão convertida e, se der, a gravação bruta) numa pasta da empresa. Se o bucket se perder, é só reenviar pelo cadastro do treinamento.
- **Vídeo que deixa de ser usado** (treinamento excluído ou vídeo trocado) **só é apagado do bucket depois de 90 dias** (`VIDEO_ORFAO_DIAS`). Os 90 dias contam a partir do dia em que a faxina viu o vídeo sem treinamento pela primeira vez, não da data do envio: um vídeo enviado há um ano e trocado hoje ainda fica mais 90 dias. Assim, se você restaurar um backup de até 90 dias atrás (ou usar o Desfazer), o treinamento restaurado ainda encontra o vídeo dele. Se o vídeo voltar a ser usado nesse meio tempo, a contagem é zerada. Essa marca fica guardada à parte (doc `videos_orfaos` no MongoDB, `data/videos_orfaos.json` no modo local) e não entra no backup. A faxina roda 10 minutos depois de cada início do servidor e uma vez por dia, apaga no máximo 20 vídeos por vez e registra cada exclusão no log de segurança. Envios que ficaram pela metade também são cancelados por ela.
- Se um dia trocar de bucket (`VIDEO_S3_BUCKET`), os vídeos antigos **não são copiados** sozinhos: copie o conteúdo da pasta `videos-treino/` para o bucket novo antes de trocar a variável.

## Custos

- **R2:** **10 GB grátis** por mês de armazenamento e **sem cobrança de saída** (o colaborador assistir não custa nada). A 15 MB por minuto, 10 GB comportam umas **11 horas** de vídeo.
- Acima disso, o armazenamento custa na faixa de US$ 0,015 por GB por mês (confira a [página de preços do R2](https://developers.cloudflare.com/r2/pricing/)). As operações de envio e leitura também têm faixa grátis mensal bem acima do uso de treinamentos.

## Limites conhecidos

- **A trava impede o colaborador comum de pular.** Quem sabe usar ferramentas técnicas do navegador consegue mexer no player da própria tela, mas **ainda precisa esperar o tempo do vídeo**: o servidor só aceita o "terminei" depois de passado o tempo real de duração.
- **A trava garante tempo, não atenção.** Ninguém impede alguém de deixar o vídeo tocando e sair de perto. A prova no fim é o que confere o aprendizado.
- **Saída de emergência do RH:** no **Acompanhamento**, a ação **Liberar prova** libera a prova sem o vídeo, para casos como aparelho que não toca o vídeo ou treinamento feito presencialmente. Fica registrado quem liberou e quando.
- Link **expirado ou cancelado** não abre o vídeo nem a prova. Gere um novo link pelo Acompanhamento.
- O player de tela cheia **nativo** do iPhone é fechado com um aviso (ele permitiria pular). A página usa uma tela cheia própria.

---

## Problemas comuns

| Sintoma | Causa provável | O que fazer |
|---|---|---|
| **403 SignatureDoesNotMatch** no "Testar conexão" ou no envio | Chave secreta errada, região diferente de `auto` ou endpoint errado | Confira `VIDEO_S3_KEY_SECRET` (recopie; ela só aparece uma vez, se perdeu crie outro token), `VIDEO_S3_REGION=auto` e `VIDEO_S3_ENDPOINT` com o seu Account ID. Redeploy. |
| **InvalidAccessKeyId** | `VIDEO_S3_KEY_ID` errado ou token apagado | Recopie o Access Key ID ou crie outro token. |
| **NoSuchBucket** | Nome do bucket diferente | Confira `VIDEO_S3_BUCKET` (maiúsculas e minúsculas contam). |
| **403 AccessDenied** / "negou o acesso" | Token só de leitura, ou restrito a outro bucket | Recrie o token com **Object Read & Write** marcando o bucket de vídeos. |
| **"Armazenamento de vídeos não configurado"** | Nenhuma variável `VIDEO_S3_*` no Render | Faça o passo 3 e o redeploy. Os treinamentos com Drive continuam funcionando enquanto isso. |
| **"configuração incompleta: faltam …"** | Alguma das cinco variáveis está vazia | Preencha a que a mensagem citar e faça o redeploy. |
| **"VIDEO_S3_ENDPOINT deve ter só o endereço…"** | Endpoint com `/nome-do-bucket` no fim | Deixe só `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. |
| Envio recusado: **arquivo não é MP4/WebM** | `.mov`, `.avi`, `.mkv` ou outro formato | Converta para MP4 H.264 no HandBrake. |
| Envio recusado: **vídeo grande demais** | Acima de `VIDEO_MAX_MB` (1 GB) | Reduza a taxa (2 Mbps a 720p) ou divida o treinamento. |
| Envio para no meio | Internet caiu ou o servidor estava acordando | O envio tenta de novo sozinho cada pedaço. Se falhar de vez, envie outra vez; o pedaço que ficou pela metade é limpo pela faxina. |
| **Vídeo não toca no iPhone** (ou em algum Android) | Codec HEVC/H.265, `.mov` convertido só no nome, WebM ou arquivo não otimizado para web | Reconverta no HandBrake com H.264 + AAC e **Web Optimized** marcado, e envie de novo. Enquanto isso, use **Liberar prova** para quem já está esperando. |
| Colaborador diz que "a prova não libera" | Vídeo não foi até o fim, ou a página ficou aberta de um dia para o outro | Pedir para recarregar a página: ela retoma de onde parou. Em último caso, **Liberar prova** no Acompanhamento. |

### No localhost (desenvolvimento)

Sem as variáveis `VIDEO_S3_*` e sem `MONGODB_URI`, o sistema usa o driver **local**: os vídeos ficam em **`data/videos/`** (dentro da pasta de dados, que não vai para o Git). Serve para testar o fluxo inteiro sem R2. Em produção (com Mongo) esse modo nunca é usado: sem as variáveis, o envio é recusado com a mensagem "Armazenamento de vídeos não configurado".

Para testar o R2 de verdade no localhost, ponha as cinco variáveis no seu `.env` (nunca no `.env.example`) e reinicie o servidor.
