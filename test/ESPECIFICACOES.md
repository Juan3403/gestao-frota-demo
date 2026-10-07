# Especificações de comportamento (SDD) — módulos v1.18 → v1.22

Cada especificação abaixo descreve um comportamento **observável pela API** no formato
Dado / Quando / Então, com um identificador estável (ex.: `VST-3`). O arquivo
`test/modulos.test.js` implementa cada uma como teste executável — o nome do teste
começa pelo id da spec, então `npm test` diz exatamente qual comportamento quebrou.

Regra do fluxo (TDD): toda mudança nesses módulos começa ajustando a spec aqui,
depois o teste (vermelho), e só então o código (verde).

## VL — Vencimentos legais do veículo (v1.20.0)

- **VL-1** · Dado um veículo criado com `ipvaVenc`/`licencVenc`/`seguroVenc` em formato ISO
  (`aaaa-mm-dd`) e `seguroApolice` texto, quando eu listo os veículos, então os quatro
  campos voltam exatamente como enviados.
- **VL-2** · Dado um vencimento em formato inválido (ex.: `15/06/2026` ou texto solto),
  quando o veículo é salvo, então o campo é gravado **vazio** (o dado ruim não entra).
- **VL-3** · Dado um veículo existente, quando eu altero um vencimento via PUT, então o
  histórico da placa ganha uma entrada mencionando a alteração.

## FP — FIPE automática (v1.20.0)

- **FP-1** · Dado que nenhum veículo tem vínculo FIPE e os modelos não estão no mapa de
  marcas (ex.: "Teste"), quando eu chamo `POST /api/veiculos/fipe/atualizar`, então a
  resposta é `ok:true` com `vinculados:0`, `atualizados:0` e as placas na lista `revisar`
  — **sem** chamadas externas (o casamento desiste antes da rede quando o modelo é
  desconhecido).
- **FP-2** · Dado um veículo salvo com `codigoFipe`/`fipeTipo`/`fipeAno`, quando eu listo,
  então os campos persistem; um `fipeTipo` inválido cai para `carros`.

## VST — Vistorias de veículo (v1.20.0)

- **VST-1** · Quando eu crio uma vistoria **sem placa**, então recebo 400 com mensagem.
- **VST-2** · Quando eu crio uma vistoria **sem motorista**, então recebo 400.
- **VST-3** · Dado um checklist com valor inválido em um item (ex.: `pneus: "quase"`),
  quando a vistoria é criada, então o item é gravado vazio e os válidos preservados;
  `termoAceito: "on"` (checkbox) vira `true`.
- **VST-4** · Dado uma vistoria existente, quando eu edito via PUT, então `ts` e
  `criadoPor` originais são preservados e os campos enviados mudam.
- **VST-5** · Dado uma vistoria com foto no cofre de mídia, quando eu **excluo** a
  vistoria, então a foto some do cofre junto (404 em `/api/midia/:id`).
- **VST-6** · Dado uma vistoria com foto, quando eu **removo a foto** num PUT, então a
  mídia órfã é apagada do cofre.
- **VST-7** · Quando uma vistoria é criada, então o histórico da placa ganha a entrada
  "Vistoria de Saída/Retorno …".
- **VST-8** · Dado uma `data` em formato inválido, quando a vistoria é criada, então a
  data assume o dia de hoje (ISO), nunca fica inválida.

- **VST-9** · Quando eu edito uma vistoria com id inexistente, então recebo 404.
- **VST-10** · Dado uma placa digitada em minúsculas, quando a vistoria é criada, então a
  placa é gravada em MAIÚSCULAS (casa com o histórico e com a frota).

## RD — Rastreadores: desativados e importação (v1.18.0)

- **RD-1** · Dado um rastreador, quando eu marco `desativado:true` com `desativadoEm` via
  PUT, então os dois campos persistem e a restauração (`desativado:false`) os limpa.
- **RD-2** · Dado um rastreador com situação manual (ex.: `Devolvido`), quando a
  importação aplica um registro do mesmo código **sem** `situacaoInformada`, então a
  situação manual é **preservada**; **com** `situacaoInformada:true`, a da planilha vale.
- **RD-3** · Dado um rastreador desativado, quando a importação atualiza o mesmo código,
  então `desativado`/`desativadoEm` são preservados (planilha não mexe nisso).

## RL — Rastreadores: ações em lote pela barra de seleção (v1.30.0)

- **RL-1** · Dado dois rastreadores selecionados, quando eu chamo
  `POST /api/rastreadores/lote-excluir` com `{ids:[a,b]}`, então os dois somem da lista
  e a resposta traz `{ok:true, excluidos:2}`.
- **RL-2** · Dado dois rastreadores selecionados, quando eu chamo
  `POST /api/rastreadores/lote-desativar`, então ambos ficam `desativado:true` com
  `desativadoEm` de hoje (`dd/mm/aaaa`) e a resposta traz `desativados:2`. Rodar de novo
  não conta os que já estavam desativados.
- **RL-3** · Dado dois rastreadores selecionados, quando eu chamo
  `POST /api/rastreadores/lote-editar` com `{campos:{situacao:'Ativo', tipo:'Instalado'}}`,
  então os dois passam a ter essa situação e tipo (`alterados:2`); campos vazios não
  mexem no valor atual.
- **RL-4** · `lote-editar` sem `ids` responde 400; `lote-editar` com `ids` mas sem
  nenhum campo válido (situação/tipo) também responde 400 (nada para alterar).

## CX — Custos por categoria (ATLAS) (v1.31.0)

- **CX-1** · `POST /api/custos/importar` com uma planilha que tem a aba
  **"CONTA AZUL - CUSTOS"** grava os lançamentos e devolve a contagem; `GET /api/custos`
  devolve `{lancamentos, recebimentos, meta}`. A aba **RECEBIMENTO** vira `recebimentos`.
- **CX-2** · A linha de **TOTAL** embutida no razão (sem centro de custo/categoria) é
  **descartada** — não dobra a soma. Cabeçalhos com espaços sobrando (`" VALOR "`) são
  normalizados: o valor é lido corretamente (inclusive decimal).
- **CX-3** · Importar uma planilha **sem nenhum lançamento válido** (só a linha de total)
  responde **400**.
- **CX-4** · Importar uma planilha **sem a aba "CONTA AZUL - CUSTOS"** responde **400**
  citando a aba que falta.
- **CX-5** · A importação **mescla por contrato** (centro de custo): importar Atlas e depois
  Orion mantém os **dois**; reimportar Atlas **substitui só o Atlas** e preserva o Orion.
  A resposta traz `contratos` (os que foram atualizados).

## NT — Notificações externas (v1.20.0)

- **NT-1** · Dado que as envs do Resend não existem, quando eu consulto
  `GET /api/notificacoes/status`, então `configurado:false` e a contagem de pendências
  vem calculada mesmo assim.
- **NT-2** · Dado uma multa não paga vencendo em ~10 dias (data em `dd/mm/aaaa`), então
  ela conta em `pendencias.multas`; uma multa `PAGO` **não** conta.
- **NT-3** · Dado um funcionário ativo com documento vencendo em ~10 dias (ISO) e um
  veículo com `ipvaVenc` na mesma janela, então contam em `pendencias.docs` e
  `pendencias.veiculos`.
- **NT-4** · Sem configuração, `POST /api/notificacoes/testar` responde 400 com o motivo.
- **NT-5** · Dado um funcionário **Desligado** com documento vencido, então ele **não**
  conta nas pendências (desligado não gera aviso).
- **NT-6** · Dado uma multa **vencida** (data no passado), então ela conta (vencida é
  mais urgente que a vencer).

## VLX — Vencimentos: limpeza

- **VL-4** · Dado um veículo com vencimento preenchido, quando eu salvo com o campo
  vazio, então o vencimento é limpo (deixar de controlar é permitido).

## CB — Integração Cobli (v1.21.0)

- **CB-1** · Sem a env `COBLI_API_KEY`, `GET /api/cobli/status` responde
  `{configurado:false}` — sem tentar rede.
- **CB-2** · Sem a env, `POST /api/rastreadores/cobli/sincronizar` responde 400 com
  mensagem citando a env.

## DEV — Painel de serviços/deploy (v1.22.0)

- **DEV-1** · `GET /api/dev/servicos` responde com a lista de serviços contendo, no
  mínimo: Banco (ok), Cofre de mídia (ok), API FIPE (presente; pode falhar offline),
  API Cobli e E-mail como **não configurados** (`ok:null`) quando sem envs, e o total
  de conexões SSE.

## Fora do alcance destes testes (cobertura manual/visual)

- Offboarding (aviso de itens não devolvidos) e badge no card: comportamento de **UI**
  (validação no submit do modal) — coberto por teste visual com Playwright.
- Envio real de e-mail (Resend) e sincronização real da Cobli: dependem de credencial
  externa; o contrato coberto aqui é o comportamento sem credencial.
- Mídia compartilhada admissão↔funcionário (v1.18.1): coberta por teste manual na
  sessão da correção; candidata a spec futura.

## SEG — Telas admin de Segurança (v1.25.0)

Grupo "Segurança" (aba `seguranca`, só admin/dev) com 7 sub-telas. Todos os endpoints
são `exigeAdmin` (401 sem login / 403 para comum). As mutações gravam na trilha `seglogs`.

- **SEG-1 (Visão geral)** · `GET /api/seguranca/geral` responde com: `controles` (CSP,
  anti-CSRF, rate-limit, timeout de sessão — todos ligados), contagem de eventos por
  severidade, nº de sessões vivas, nº de IPs bloqueados e nº de tentativas de login
  em curso.
- **SEG-2 (Logs)** · `GET /api/seguranca/logs` filtra por evento/severidade/área/usuário/
  ip/período e devolve os eventos mais recentes primeiro (já existia; a tela consome).
- **SEG-3 (Endpoints)** · `GET /api/seguranca/endpoints` lista as rotas da API com o
  guard de cada uma (admin/editar:área/ver:área/mídia/pública). Rotas realmente públicas
  vêm marcadas `publica:true` para conferência.
- **SEG-4 (Segredos)** · `GET /api/seguranca/segredos` lista as variáveis de ambiente
  sensíveis com apenas `definida:true|false` (NUNCA o valor). `POST /.../segredos/scan`
  roda o scanner e devolve `{ ok, achados, resumo }` sem vazar o conteúdo.
- **SEG-5 (Bloqueios)** · `GET /api/seguranca/bloqueios` devolve `{ tentativas:[…],
  permanentes:[…] }`. `POST /api/seguranca/bloqueios` `{ip,motivo}` adiciona um IP à
  lista permanente (persistida); um IP na lista recebe 403 em qualquer requisição.
  `DELETE /api/seguranca/bloqueios/:ip` remove. `POST /.../bloqueios/limpar-tentativas`
  `{ip}` zera o contador de força-bruta daquele IP.
- **SEG-6 (Sessões)** · `GET /api/seguranca/sessoes` lista as sessões vivas (usuário,
  nível, ip, desde). `POST /api/seguranca/sessoes/revogar` `{usuario}` invalida as
  sessões daquele usuário (o cookie dele deixa de valer no próximo request).
  `POST /api/seguranca/sessoes/revogar-todas` derruba todo mundo.
- **SEG-7 (Config)** · `GET /api/seguranca/config` devolve os parâmetros vigentes
  (inatividade/absoluto da sessão, tentativas/janela do login, política de cadastro).
  `PUT /api/seguranca/config` grava overrides válidos (limites saneados) e eles passam
  a valer SEM redeploy; valores fora da faixa são rejeitados/limitados.
- **SEG-8 (guard)** · Todos os `/api/seguranca/*` respondem 401 sem login e 403 para
  usuário comum; nenhum vaza valor de segredo/senha.

## TRN — Envio de treinamento em lote (v1.27.0)

- **TRN-1** · `POST /api/treinamentos/convites/lote` com `{treinamentoId, funcionarioIds:[a,b]}`
  cria um convite (link único) para cada funcionário e responde
  `{ ok:true, criados:[{funcionarioId, nome, token, ...}], ignorados:[...] }`.
- **TRN-2** · Um funcionário que já tem um convite **aguardando** para o mesmo treinamento
  entra em `ignorados` (motivo "já tem link ativo"), não vira link duplicado.
- **TRN-3** · Sem `treinamentoId` → 400; `funcionarioIds` vazio → 400.
- **TRN-4** · IDs inexistentes entram em `ignorados` (motivo "não encontrado"); os válidos
  continuam sendo criados (o lote não falha inteiro por um id ruim).
- **TRN-5** · O `dias` do lote é saneado para 1..90 (fora da faixa → limitado).

## TRN — Reenviar/novo link (v1.55.35) e exclusão no Acompanhamento (v1.55.40)

- **TRN-6** · `DELETE /api/treinamentos/convites/:id` de convite aguardando ou expirado → 200; o link para
  de abrir (404) e o registro some do Acompanhamento.
- **TRN-7** · Convite concluído não é excluído (409 com `concluidos`), inclusive quando só existe a
  conclusão aprovada e o status não foi gravado.
- **TRN-8** · `POST /convites/excluir-lote` é tudo ou nada (um concluído no lote → 409 e nada é apagado);
  `ids` vazio → 400, mais de 500 → 413, nenhum existente → 404, mistura → 200 com `naoEncontrados`.
- **TRN-9** · Excluir remove só as tentativas REPROVADAS do convite; a aprovação de outro convite fica.
- **TRN-10** · Um único Desfazer restaura os convites e as tentativas de um lote excluído, e o token
  antigo volta a abrir.
- **TRN-11** · A trilha de segurança registra `treinamento_convite_excluido` e `treinamento_link_regerado`
  SEM o token do convite.
- **TRN-12** · Regenerar convite concluído → 409 com a orientação ("crie um novo convite"); inexistente → 404.
- **TRN-13** · Regenerar troca o token (o antigo dá 404), saneia `dias` (1..90, padrão 7) e grava
  `regeradoTs`/`regeradoPor`/`regeracoes`, que aparecem no Acompanhamento.
- **TRN-14** · Os campos do novo link sobrevivem a outras gravações dos convites (normalizador).
- **TRN-15** · O lote devolve, no ignorado "já tem link ativo", o convite aguardando mais recente
  (`convite:{id, token, validadeTs}`); convite expirado não conta como ativo.
- **TRN-16** · `POST /api/treinamentos/acompanhamento/exportar {ids}` devolve o Excel (aba ACOMPANHAMENTO)
  só com os ids pedidos, na ordem pedida; situação, nota, "aprovado em" e "certificado válido até";
  CPF mascarado e NUNCA o token/link do convite. No TRN-SEG: o recorte por empresa vale também aqui.
- **TRN-17** · O item do `GET /api/treinamentos/acompanhamento` traz `provas` (cada tentativa, da mais
  antiga para a mais nova, só `{ts, nota, aprovado}`, nunca as respostas), `validadeMeses` do
  treinamento e `origemVideo` (`'drive'` aqui; `'arquivo'` no TRV-10). Alimentam o painel do convite
  e as colunas Prazo/Nota do Acompanhamento redesenhado (1.55.45).
- **MUL-TERMO-1** · Gerar termo da multa (marcadores `{{…}}`, como nos modelos NTE/SUL): a multa grava código da
  infração, órgão autuador e data da notificação; `/termo/opcoes` lista os modelos .docx com a empresa tirada do título
  e põe primeiro o funcionário com o veículo vinculado (sem CPF na lista); `/termo/previa` exige o modelo e devolve só os
  marcadores que ele usa (sem repetir, sem os do bloco `[[INSTRUCOES…]]`), formatados (CPF, valor, data e hora, parcelas,
  mês por extenso, data da assinatura por extenso), o que falta e os desconhecidos; `POST /termo` devolve o .docx com os
  marcadores trocados (inclusive marcador partido pelo Word), o campo preenchido sem realce amarelo nem Consolas, o sem
  dado EM BRANCO (sem marcador e sem amarelo), o desconhecido `{{…}}` à vista em amarelo, TAB do texto virando `<w:tab/>` só
  na versão para PDF, marcador só no rodapé entrando na prévia (usados/faltando/desconhecidos) e preenchido lá, o bloco de instruções intacto e nenhuma etiqueta interna sobrando; a multa ganha
  `condutorFuncionarioId` (+ Responsável se estava vazio) e o vínculo sobrevive ao PUT; com `formato:'pdf'` o mesmo termo
  sai sem o bloco de instruções (oculto e com o marcador partido em dois runs), sem `w:altChunk` e sem `w:sym` de código
  inválido (o .docx baixado continua com eles), e o histórico da placa diz "Termo gerado para salvar em PDF"; modelo PDF → 400; marcador mal
  fechado → 400; funcionário inexistente → 404.
- **MUL-TERMO-SEG** (`test/security.test.js`) · só-leitura em Multas → 403 em opções e gerar; funcionário de outra
  empresa não aparece na lista e dá 403 na prévia e no gerar (sem vazar CPF); o seglog `termo_multa_gerado` não leva CPF.
- **TRN-SEG** (`test/security.test.js`) · Excluir, excluir-lote, regenerar e liberar-prova de convite de
  outra empresa → 403 sem apagar nada; o lote nunca devolve o token de quem está fora do recorte;
  usuário só-leitura → 403 nessas rotas.
- **INST-UNDO-1** · Dois Desfazer seguidos em Instalações restauram o vínculo exato do rastreador
  (200 nas duas): o Desfazer grava com `salvarInstalacoes(v, { exato: true })`.

## TRV — Vídeo de treinamento enviado ao sistema, com prova travada (v1.55.41)

Driver local (`DATA_DIR/videos`), servidor de `test/modulos.test.js` com `VIDEO_PARTE_BYTES_TESTE`
para partes pequenas. Em produção o mesmo fluxo vai para o bucket R2 (`docs/VIDEOS_TREINAMENTO.md`).

- **TRV-1** · Treinamento só com link do Drive continua sem trava: `/entrar` devolve `treino.video:null`
  e `progresso.provaLiberada:true`; `/responder` aceita direto.
- **TRV-2** · `iniciar` → 2 partes → `concluir` devolve o `video`, que salvo no treinamento aparece no GET;
  PUT sem `video` mantém, `video:null` remove; sem vídeo e sem Drive → 400.
- **TRV-3** · Formato (só MP4/WebM, `.mov` recusado), duração (1..14400 s), tamanho máximo (413) e
  bytes mágicos da parte 1 (415) são conferidos.
- **TRV-4** · Chave com `../` ou fora de `videos-treino/` é recusada em todas as rotas que a recebem.
- **TRV-5** · `/entrar` devolve `treino.video {url, duracaoSeg, mime, ref, expiraTs}` SEM a chave e com
  `fileId` vazio; a rota local do vídeo responde `Range` com 206 + `Content-Range`.
- **TRV-6** · Com vídeo travado, `/responder` → 409 `VIDEO_PENDENTE`; `inicio` seguido de `fim` imediato
  num vídeo de 60 s → 409 `VIDEO_CEDO` com `faltamSeg`.
- **TRV-7** · Vídeo curto terminado (`fim` aceito) libera a prova; trocar o vídeo do treinamento trava
  de novo quem ainda não foi aprovado.
- **TRV-8** · Link expirado ou cancelado não entra: `/entrar` e `/responder` → 409 `LINK_FECHADO` com o `status`.
- **TRV-9** · As rotas de envio (`/api/treinamentos/videos/*`) NÃO entram no Desfazer da Integração.
- **TRV-10** · O Acompanhamento traz `video {pendente, iniciadoTs, concluidoTs, liberadoTs, liberadoPor}`
  e `POST /convites/:id/liberar-prova` destrava o `/responder`.
- **TRV-11** · No máximo 2 partes sendo recebidas ao mesmo tempo; a 3ª recebe 503 + `Retry-After`.
- **TRV-12** · A faxina conta a carência a partir de quando o vídeo ficou SEM treinamento (marca persistida
  em `videos_orfaos`), não da data do envio: a 1ª rodada só marca e cancela o envio abandonado; a 2ª,
  depois da carência, apaga só o que tem marca E arquivo antigos; vídeo que voltou a ser usado sai da lista.

Módulo `backend/videos-treino.js` (`test/videos-treino.test.js`, sem porta fixa):
- **SIGV4-V1..V5, SIGV4-Q, SIGV4-U** · Assinatura AWS SigV4 bate com os vetores oficiais da AWS (GET com
  Range, PUT com `$` no nome, query canônica, URL pré-assinada, suíte genérica); `?uploads` assina
  `uploads=`, `partNumber` antes de `uploadId`; `uriEncode` segue a RFC 3986.
- **S3-1..S3-6** · Contra um S3 falso local: envio em partes completo com assinatura válida em toda
  requisição; Complete com 200 + `<Error>` falha; partes fora do plano recusadas; erro de assinatura
  com dica de região/chave; URL pré-assinada path-style; Complete cuja resposta se perdeu conta como
  concluído se o HEAD confirma o objeto inteiro (senão, 404 NoSuchUpload).
- **LOCAL-1..LOCAL-3** · Driver local junta as partes no arquivo final; `caminhoLocal`/`uploadId`
  recusam path traversal; `VIDEO_PARTE_BYTES_TESTE` só vale no driver local.

## ADZ — Download de admissões (atalho + lote) (v1.28.0)

- **ADZ-1** · `GET /api/admissao/documentos/zip-lote?ids=a,b` devolve um único .zip
  (Content-Type application/zip) com o pacote de cada candidato numa pasta própria.
- **ADZ-2** · `GET /api/admissao/documentos/zip-lote?status=preenchido` empacota todos os
  candidatos com aquele status.
- **ADZ-3** · Sem candidatos com resposta no filtro → 400 (nada para baixar).
- **ADZ-4** · A rota de lote NÃO é capturada por `/api/admissao/:id` (fica antes; "documentos"
  não vira um :id).

- **ADZ-5** · `GET /api/admissao/:id/documentos/zip?docs=<mediaId>` baixa um .zip só com o
  documento escolhido (SEM a ficha PDF) — é o "baixar selecionados" da revisão.

## M OCR — Print de multas com conferência opcional pela Frota (v1.55.52)

Interpretador puro em `test/multa-ocr.test.js`; interação em `e2e/multa-ocr.e2e.js`.
Uso: `npm run test:ocr`. Avaliação do Tesseract 5.1.1 com seis prints fictícios: `npm run avaliar:ocr`.

- **Placa** · Correspondência exata prevalece; uma placa compatível pode ser identificada pela Frota,
  com até duas trocas e dois caracteres extras. Remoções sem explicação, mais de um veículo,
  ausência de rótulo, placa ausente ou Frota indisponível geram avisos para conferência opcional. A ordem da Frota não muda a decisão.
- **Campos** · Valor original não usa desconto; data e hora da infração vêm exclusivamente de
  **Data/Hora do Cometimento da Infração**, inclusive com rótulo quebrado em linhas; rótulos genéricos,
  notificação e vencimento não fornecem esses campos;
  campos ausentes não usam o próximo rótulo. Colunas são associadas pela posição, datas reais são
  validadas e “sem equipamento” não vira “com equipamento”. Confiança abaixo de 85, inexistente,
  inferência ou correção deixa aviso opcional. Valores válidos e únicos preenchem os campos vazios
  automaticamente, sem exigir confirmação; múltiplas possibilidades e valores inválidos não são aplicados.
- **Descrição** · Rótulos e títulos CDT em várias linhas conservam o texto completo, inclusive
  prefixos visuais e palavras como faixa, placa, modelo e condutor dentro da infração. Cabeçalhos,
  campos seguintes e outras colunas ficam fora. Duplicatas que diferem apenas na apresentação não
  criam ambiguidade; diferenças de conteúdo, inclusive “com” versus “sem”, continuam distintas.
  A descrição preenche e salva sem confirmação, preservando o que já foi digitado.
- **Interação** · Arquivo e Ctrl+V seguem o mesmo fluxo; texto colado segue normal. Valores digitados
  são preservados; sugestões ficam recolhidas e não bloqueiam Salvar. É possível aceitar, corrigir,
  descartar ou reler opcionalmente. Releitura aplica valores válidos apenas em campo vazio ou ainda igual
  ao último valor aplicado pelo OCR. Fechar/reabrir, cancelar, erro ou timeout não deixam leitura anterior alterar outro cadastro.
- **Responsável** · Nova multa abre com IDENTIFICAR; edição preserva o valor salvo, inclusive vazio.
  O usuário pode alterar e salvar o responsável normalmente.
- **Imagem** · Fundo transparente fica branco; ampliação até 2× e limite efetivo de 12 megapixels.
  Avaliação real usa sete descrições/layouts fictícios, registra campos corretos, sugestões e tempo;
  descrição ausente/incompleta e qualquer preenchimento automático incorreto falham. O sétimo
  (`senatran-tabela`) imita o portal (fonte Raleway, ícones, tabela) e exige todos os campos certos.
- **Portal SENATRAN** (M OCR 66–69 + e2e "tabela SENATRAN") · Ícone lido como letra antes do título
  ("B TRANSITAR…") não impede a descrição; palavra curta de verdade ("A REALIZAR…") continua a frase.
  Na tabela, o órgão é só a sua linha (a linha "Órgão Competente/Responsável" fica fora) e o local
  quebrado na coluna do valor continua inteiro; "Data limite" não vira vencimento. Caractere partido
  em dois símbolos sobrepostos ou estreitos ("O"+"0", "S"+"5", "1"+"I") sai uma vez só; zeros lado a
  lado ficam. Cidade em formato de nome com UF maiúscula.
