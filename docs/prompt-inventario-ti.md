# Prompt: módulo Inventário de TI (Frota NTE / Gestão RM)

> Cole este arquivo inteiro como pedido. Ele já traz as decisões tomadas e os pontos exatos do código
> que precisam ser tocados, para você não redescobrir nem inventar caminho.

## O que fazer

Implementar, dentro do projeto existente `gestao-frota-demo`, uma aba nova chamada **Inventário de TI**,
completa e integrada ao resto do sistema. É trabalho no código de produção, não protótipo, não
mockup, não documento: no fim tem que estar funcionando no localhost com dados reais.

Entrega **inteira de uma vez**: cadastro, movimentações, termo assinado, dashboard, filtros,
importação de planilha, exportação, PDF, permissões e testes.

## Escopo: o que o inventário controla

Três espécies de registro, no mesmo módulo:

1. **Equipamento** (hardware): notebook, desktop, monitor, celular, tablet, impressora, roteador,
   switch, nobreak, projetor, outros.
2. **Linha e chip**: linha de voz/dados, com operadora, número, plano e mensalidade.
3. **Licença e conta**: Microsoft 365, antivírus, e-mail corporativo, sistema pago, com assentos,
   custo e data de renovação.

## Decisões já tomadas (não reabrir)

- **Não existe número de patrimônio.** Quem identifica o aparelho é o **número de série** (e o IMEI,
  no celular). Não crie campo de patrimônio, etiqueta ou tombamento.
- **`local` é campo próprio e obrigatório na prática**: Escritório, ORION, ATLAS e o que mais for
  cadastrado. Ele filtra a lista, agrupa o dashboard e sai impresso no termo. Ofereça os valores já
  usados como sugestão (`<datalist>`), sem travar numa lista fixa.
- **Entrega de equipamento gera termo de responsabilidade assinado na tela**, no mesmo padrão do EPI:
  canvas, aceite obrigatório, hash do conteúdo assinado, PDF com QR e conferência pública em
  `/verificar`.
- **Situação nunca é gravada, é derivada** das movimentações.
- Área de permissão própria (`ti`), no grupo **Administração** da sidebar, ao lado de Senhas e
  Documentos.

## Modelo de dados

Duas coleções, um módulo (uma área de permissão, um evento SSE, um prefixo de rota). O motivo é o
mesmo do EPI: `persistMongo` grava o documento inteiro, então salvar o cadastro reescreveria o array
de movimentações a cada request, e movimentação cresce para sempre contra o teto de 16 MB por
documento do Mongo.

### `tiAtivos` (arquivo local `data/ti_ativos.json`, doc Mongo `_id: 'tiAtivos'`, array `ativos`)

Campos comuns: `id`, `ts`, `especie` (`equipamento` | `linha` | `licenca`), `descricao`,
`local`, `empresa`, `contratoNumero`, `centroCusto`, `fornecedorId` (aponta para o cadastro de
Fornecedores), `valor`, `notaFiscal`, `dataCompra`, `anexos[]` (refs de mídia: nota fiscal, foto),
`obs`, `ativo`, `historico[]` (capado em 100, no padrão do fornecedor).

- **Equipamento**: `tipo`, `marca`, `modelo`, `numeroSerie`, `imei`, `processador`, `memoria`,
  `armazenamento`, `sistema`, `conservacao` (Novo/Bom/Regular/Ruim), `garantiaAte`.
- **Linha**: `operadora`, `numero`, `plano`, `franquia`, `mensalidade`, `tipoLinha`
  (voz/dados/ambos), `aparelhoId` (id de um equipamento), `ativacaoEm`.
- **Licença**: `fabricante`, `produto`, `modalidade` (assinatura/perpétua), `assentos`, `custo`,
  `periodicidade` (mensal/anual), `renovaEm`, `contaAdmin`.

**Chave ou serial de licença**: campo opcional. Se preenchido, é gravado, mas **aparece mascarado na
tela**, exige permissão de editar para revelar, e **nunca sai** em log, na exportação Excel nem no
PDF. Na ajuda do campo, indique a aba Senhas como lugar do segredo de verdade.

### `tiMovimentacoes` (`data/ti_movimentacoes.json`, doc `_id: 'tiMovimentacoes'`, array `movimentacoes`)

Tipos aceitos: `Entrada`, `Entrega`, `Devolução`, `Transferência`, `Manutenção`,
`Retorno de manutenção`, `Baixa`, `Extravio`, `Atribuição de assento`, `Revogação de assento`.

**Tipo fora dessa lista é recusado pela API com 400.** O normalizador pode cair num padrão para ler
registro antigo sem explodir, mas aceitar tipo inválido na entrada inverteria a situação do ativo em
silêncio (foi o que aconteceu no EPI quando um `Substituição` chegou com o acento corrompido).

Campos: `id`, `ts`, `tipo`, `ativoId`, `snapshot` (nome/tipo/marca/modelo/série do ativo no dia,
montado **no servidor**, ignorando o que vier no corpo do request), `funcionarioId`,
`funcionarioNome`, `entreguePor`, `recebidoPor`, `data`, `local`, `localAnterior`, `motivo`, `obs`,
`empresa`, `contratoNumero`, `anexos[]`, e os campos de assinatura quando houver termo.

## Regras de negócio

1. **Situação é derivada** (`situacaoAtivoTi`), calculada da última movimentação de cada ativo:
   Em estoque → Em uso → Em manutenção → Baixado / Extraviado. Nunca grave o campo.
2. **Quem está com o quê** (`posseTi`): equipamento em uso aponta o colaborador, a data da entrega e
   se o termo está assinado.
3. **Assentos de licença**: `Atribuição de assento` ocupa um, `Revogação` devolve. Saldo disponível =
   `assentos` menos atribuições em aberto. Recuse atribuição sem saldo.
4. **Linha e aparelho**: a linha aponta um equipamento por `aparelhoId`. Se o aparelho for baixado ou
   extraviado, a linha entra nos alertas como "linha sem aparelho".
5. **Alertas derivados, aviso com 30 dias de antecedência** (mesmo padrão de documentos e EPI):
   garantia vencendo, licença a renovar, linha sem aparelho, equipamento em manutenção há mais de 30
   dias, entrega sem termo assinado.
6. **Exclusão**: ativo com movimentação registrada não é apagado. Explique e ofereça baixa, como o
   fornecedor com nota fiscal faz hoje.
7. **Merge nunca destrutivo**: na importação, coluna vazia na planilha não apaga valor existente.

## Termo de responsabilidade

- `Entrega` e `Devolução` de equipamento podem ser assinadas na tela.
- Reuse `abrirAssinaModal(alvo, opcoes)` (`frontend/app.js:12146`), como o EPI faz em `:14007`. São
  ~230 linhas de canvas e Pointer Events que **não devem ser duplicadas**.
- No servidor: `assinaturaHash` = SHA-256 do conteúdo assinado (colaborador + data + ativo + local +
  declaração; devolução não entra), `assinaturaCodigo` =
  `gerarCodigoVerificacao(codigosVerificacaoEmUso())`, mais `assinaturaIp`, `assinaturaDispositivo`,
  `assinaturaModo`, `assinaturaAceite`, `assinaturaEm`. Editar depois faz o hash divergir e acende
  "⚠ alterado" na lista, no PDF e na página pública.
- Registre o módulo em `MODULOS_VERIFICACAO` (`backend/server.js:12372`) com `respostaVerificacaoTi`,
  devolvendo os rótulos prontos (`{data, itens, autentico}`), porque colar adjetivo no nome do
  documento erra a concordância.
- Texto da declaração: responsabilidade pela guarda e uso do equipamento, devolução ao desligamento,
  comunicação imediata de perda, dano ou roubo.

## Telas

Sub-abas: **Dashboard · Equipamentos · Linhas e chips · Licenças · Movimentações**, com barra de
filtros única para as cinco, no padrão do EPI.

- **Dashboard**: total de ativos por tipo, quantos em uso e quantos em estoque, valor imobilizado,
  custo mensal somado (linhas + licenças), garantias vencendo, licenças a renovar, ativos por local,
  quem tem mais equipamentos, entregas sem termo assinado.
- **Listas**: tabela com ordenação por coluna, filtros multi-seleção (tipo, local, situação, empresa,
  responsável), cartões-filtro clicáveis, busca que aceita série, IMEI, número da linha, modelo,
  responsável e local, sem exigir acento nem maiúscula.
- **Modal de cadastro**: abas internas (Identificação, Compra e garantia, Alocação, Anexos,
  Histórico), com os campos da espécie escolhida aparecendo e sumindo. Aviso de mudança não salva ao
  fechar.
- **Ficha do ativo**: linha do tempo das movimentações, quem está com ele e link do termo.

## Backend: onde encostar (`backend/server.js`, ~19.9 mil linhas)

| # | Linha | O quê |
|---|---|---|
| 1 | `:113` | `TI_ATIVOS_FILE` e `TI_MOV_FILE` em `DATA_DIR` |
| 2 | `:4094` | `mem.tiAtivos` e `mem.tiMovimentacoes` |
| 3 | `~:5613` | `normalizarAtivoTi` / `normalizarMovTi`, `lerTiAtivos` / `salvarTiAtivos` / `seedTiAtivos` (copie o trio de `lerEpiCatalogo`), sempre com `notificarDados('ti')` no fim do salvar |
| 4 | `:9046` e `:9082` | `MODULOS_UNDO` e `UNDO_ROTAS`, com `excluir:` das exportações POST (senão cada download cria um "Desfazer" fantasma) |
| 5 | `:3715` | `'ti'` em `AREAS_PERMISSAO`. A aba nasce trancada sozinha via `sincronizarAreasNovas()` (`:17642`) |
| 6 | `:3961`, `:18587`, `:18783` | `AREAS_MIDIA`, `midiasReferenciadas()` e `mapaPastaAnexos()` → `files/ti`. **Sem isso a limpeza de órfãs apaga a assinatura e os anexos ~1h depois** (foi o bug da v1.45.1) |
| 7 | `~:12622` | rotas `/api/ti`: estáticas antes das que têm `:id`, payload único no `GET /api/ti` (`{ativos, movimentacoes, posse, indicadores}`), `exigeVer('ti')` na leitura e `exigeEditar('ti')` na escrita |
| 8 | `:12372` | `MODULOS_VERIFICACAO` + `respostaVerificacaoTi` |
| 9 | `~:12749` | `gerarPdfTi(lista, modo, origem)` com `modo` = `termo` / `relatorio` / `inventario`, copiando a estrutura de `gerarPdfEpi`. Todo texto passa por `textoWinAnsi` (sem isso o `drawText` do pdf-lib lança), datas por `isoParaBR`, QR por `desenharQrNoPdf` |
| 10 | `~:12603` | `filtrarTi(lista, u)` sobre `empresasFuncPermitidas` / `contratosFuncPermitidos`. Registro sem empresa e sem contrato passa |
| 11 | `:18490`, `:18700`, `:19083` | `montarBackupCompleto()`, `COBERTURA_BACKUP`, `RESTORE_MODULOS`. Faltando a cobertura, a geração de backup **falha** de propósito |
| 12 | `:19807` | carga no boot com `findOne({_id:'tiAtivos'})` e fallback para `seedTiAtivos()` |
| 13 | `:228` + `package.json` | versão **1.54.0** e entrada nova no topo do `CHANGELOG`, os dois números idênticos |

Indicadores do dashboard vêm do servidor, sobre a base completa, porque o filtro por empresa esconde
a outra empresa mas o inventário do depósito é o mesmo para todos.

## Frontend: onde encostar

1. `frontend/index.html:165` — botão `<button class="tab" data-tab="ti">` no `.nav-group`
   **Administração**, mais `<section id="ti" class="view">` e `<div class="subtabs" id="tiSubtabs">`.
2. `frontend/app.js`: `AREA_ROTULOS` (`:20729`) → `GRUPOS_PERM` (`:20738`, área sem grupo **some** do
   painel de permissões) → `SUBTITULOS_ABA` (`:21625`) → `recarregarAba` (`:1739`) →
   `registrarSubrota('ti','tiSubtabs')` (`:2045`) → `REFRESCOS.ti` (`:9788`).
   A chave de `REFRESCOS` tem que ser idêntica à de `notificarDados('ti')`; se não bater, cada
   salvamento dispara ~25 fetches.
3. Render: `permissaoAtual('ti')` escondendo os botões de ação, `COLS_TI_*_UI` com cabeçalho
   clicável e `aria-sort`, `criarMultiSelect` / `getSel`, cartões-filtro, `estadoVazio`,
   `wirePaginacao`, e `'tabelaTiEquip'` / `'tabelaTiMov'` em `TABELAS_COMPACTAS` (`:25664`).
4. Modal: classes `.func-tabs` / `.func-tab` / `.func-tabpanel` (as mesmas do `#fornModal` e da ficha
   do colaborador), `snapshotFormTi` + `pedirParaFecharTi`, `fecharAoClicarNoFundo`, `confirmar`,
   `toast`.
5. Planilha: entrada nova em `padronizarAcoesPlanilha` (`:1652`) e importação em três passos copiando
   o fluxo dos Fornecedores (`fornImp`, `:11016`, com `/importar/previa`, `/remapear`, `/aplicar`).
   O detector de colunas precisa reconhecer os cabeçalhos comuns de planilha de TI: EQUIPAMENTO,
   ITEM, MARCA, MODELO, SÉRIE, N SERIE, SERIAL, IMEI, USUÁRIO, RESPONSÁVEL, SETOR, LOCAL, OBRA,
   OPERADORA, NÚMERO, LINHA, PLANO, LICENÇA, PRODUTO, VENCIMENTO, VALOR, NOTA.
6. `frontend/styles.css`: bloco novo no fim, com banner de seção, e tokens `--ti-*` declarados em
   **`body`, nunca em `:root`** (os temas redefinem `--brand` e `--green` em `body.<tema>`; um `var()`
   no `:root` resolveria contra o próprio `:root` e travaria a cor no azul padrão).

## Testes

Criar `test/ti.test.js`, `const PORT = 3205` (3196 a 3204 já estão ocupadas pelas outras suítes).
Sobe o servidor real com `DATA_DIR` temporário, como as suítes existentes. Cobrir, no mínimo:

1. Situação derivada: entrada deixa Em estoque, entrega deixa Em uso, manutenção e retorno voltam,
   baixa fecha.
2. Tipo de movimentação inválido devolve 400.
3. Snapshot do ativo na movimentação não muda quando o cadastro é corrigido depois.
4. Assinatura grava hash e código; editar o registro depois acende `alteradaAposAssinatura`.
5. Código de verificação não colide com os do almoxarifado e do EPI.
6. Assento de licença: atribuir além do total é recusado.
7. Chave de licença não aparece na exportação nem no PDF.
8. Importação: prévia não grava nada, aplicar é idempotente e não apaga campo com coluna vazia.
9. Backup: `tiAtivos` e `tiMovimentacoes` aparecem no dump e no manifest, e o restore devolve.
10. Recorte por empresa: usuário só de uma empresa não vê a movimentação da outra.

Rodar no fim: `npm test` (tem que ficar verde inteiro, não só a suíte nova),
`npm audit --audit-level=high` e `npm run security:secrets`.

## Não fazer

- Não recriar o projeto, não trocar de stack, não introduzir framework, build, ORM ou migration:
  aqui é Express com JSON e Mongo, e frontend vanilla sem build.
- Não gravar situação, saldo de assento nem "está com quem": tudo isso é derivado.
- Não duplicar o quadro de assinatura, o modal de câmera nem o componente de anexos.
- Não juntar cadastros automaticamente por nome parecido.
- Não colocar segredo (chave de licença, senha de conta) em log, resposta de API sem necessidade,
  commit, exportação ou PDF.
- Não usar travessão em texto de interface: separe com vírgula, dois-pontos, `·` ou parênteses.
- Não inventar endpoint que não existe nem simplificar requisito em silêncio: se algo não couber,
  diga qual e por quê.

## Como termina

1. `npm test` verde, `npm audit --audit-level=high` limpo.
2. Localhost de pé em `http://localhost:3100/painel/ti`, testado no navegador: cadastrar um
   equipamento, entregar para um colaborador, assinar o termo, gerar o PDF, conferir o código em
   `/verificar`, devolver, importar uma planilha e exportar.
3. Versão `1.54.0` no `package.json` e no topo do `CHANGELOG`, com as mudanças escritas em linguagem
   de usuário final.
4. Relatório curto do que entrou, do que ficou de fora e do que precisa de decisão.
