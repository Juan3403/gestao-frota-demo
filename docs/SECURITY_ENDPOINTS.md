# Matriz de Segurança dos Endpoints — Frota NTE / Gestão RM

Inventário dos endpoints Express (`backend/server.js`) com os controles de segurança aplicados a
cada um. Gerado na auditoria de jun/2026. Total: **~145 rotas**.

## Controles GLOBAIS (valem para todas as rotas, salvo indicação)

- **Autenticação:** com login ativo (produção), tudo exige sessão válida, exceto a tela de login e assets do PWA (`/login.js`, `/manifest.webmanifest`, `/sw.js`, ícones). Rotas `/api/*` sem sessão → `401`.
- **CSRF/Origin:** toda mutação (POST/PUT/DELETE) valida `Origin`/`Referer` same-origin → senão `403` (logado como `csrf_recusado`).
- **Rate limit:** 600 req/min por IP (global) → `429` com `Retry-After`. Login: 8 erros/15 min por IP.
- **Cabeçalhos:** CSP, `X-Content-Type-Options=nosniff`, `X-Frame-Options=SAMEORIGIN`, `Referrer-Policy`, HSTS (quando HTTPS).
- **Sessão:** cookie HMAC `HttpOnly`+`SameSite=lax`+`Secure`(prod); timeout de inatividade (60 min) e absoluto (12 h).
- **Erros:** handler global devolve JSON saneado + `correlationId`; nunca expõe stack/segredo/URI.
- **Upload:** allowlist MIME+extensão, teto 10 MB, 1 arquivo, bloqueio de nomes perigosos.

**Legenda authz:** `público` · `login` (qualquer logado) · `ver:<área>` · `editar:<área>` · `admin` · `admin/local` (admin em prod, livre no localhost).
**Risco:** 🟢 baixo · 🟡 médio · 🟠 alto · 🔴 crítico. (após as correções desta auditoria)

---

## Públicas / autenticação

| Método | Rota | Operação | Authz | Auditoria | Risco |
|---|---|---|---|---|---|
| GET | `/api/versao` | leitura (build) | público | — | 🟢 |
| GET | `/login` | página | público | — | 🟢 |
| POST | `/api/login` | autenticação | público (rate-limit + brute-force) | `entrou`/`falhou`/`bloqueado` | 🟢 |
| POST | `/api/logout` | encerra sessão | login | — | 🟢 |
| GET | `/api/cadastro/aberto` | leitura | público | — | 🟢 |
| POST | `/api/cadastro/solicitar` | cria pendente | público (10/h por IP) | — | 🟢 |
| GET | `/api/cadastro/status` | leitura | público (não enumera usuários) | — | 🟢 |
| GET | `/api/eu` | dados do logado | login | — | 🟢 |
| GET | `/api/eventos` | SSE tempo real | login | — | 🟢 |

## Frota / veículos

| Método | Rota | Authz | Observações | Risco |
|---|---|---|---|---|
| GET | `/api/veiculos` | `ver:frota` | dado fundacional | 🟢 |
| POST/PUT/DELETE | `/api/veiculos[/:placa]` | `editar:frota` | | 🟢 |
| POST | `/api/veiculos/lote-editar` | `editar:frota` | | 🟢 |
| GET | `/api/exportar` | `ver:frota` | Excel; fórmulas neutralizadas | 🟢 |
| POST | `/api/importar` | admin/local · upload xlsx | SUBSTITUI a frota; backup antes | 🟡 |

## Histórico

| Método | Rota | Authz | Observações | Risco |
|---|---|---|---|---|
| GET | `/api/historico` | login | leitura (quem fez o quê) | 🟢 |
| POST | `/api/historico` | login | append da trilha | 🟢 |
| DELETE | `/api/historico/:id` | admin/local | limpeza exige admin | 🟢 |

## Multas

| Método | Rota | Authz | Observações | Risco |
|---|---|---|---|---|
| GET | `/api/multas` | `ver:multas` | | 🟢 |
| POST/PUT/DELETE | `/api/multas[/:id]` | `editar:multas` | | 🟢 |
| POST (limpar) | `/api/multas` (bulk) | admin/local | | 🟡 |
| GET | `/api/multas/exportar` | `ver:multas` | Excel protegido | 🟢 |
| GET | `/api/multas/:id/termo/opcoes` | `editar:multas` | condutores só id/nome/cargo/veículo/empresa, no recorte `podeVerFunc` (sem CPF) | 🟢 |
| POST | `/api/multas/:id/termo/previa` | `editar:multas` | só lê; funcionário fora do recorte → 403; fora do Desfazer | 🟢 |
| POST | `/api/multas/:id/termo` | `editar:multas` | .docx com dados pessoais do condutor; recorte `podeVerFunc` (403); seglog `termo_multa_gerado` sem CPF | 🟢 |

## Rastreadores

| Método | Rota | Authz | Observações | Risco |
|---|---|---|---|---|
| GET | `/api/rastreadores` | `ver:rastreadores` | | 🟢 |
| POST/PUT/DELETE | `/api/rastreadores[/:id]` | `editar:rastreadores` | | 🟢 |
| POST (bulk) | `/api/rastreadores` | admin/local | | 🟡 |
| POST | `/api/rastreadores/importar/preview` | admin/local · upload xlsx | | 🟡 |
| POST | `/api/rastreadores/importar/aplicar` | admin/local | | 🟡 |
| GET | `/api/rastreadores/exportar` | `ver:rastreadores` | | 🟢 |
| GET/POST | `/api/rastreadores/backups[...]` | admin/local | baixar/restaurar backup | 🟡 |

## Mídia (fotos/documentos/PPP)

| Método | Rota | Authz | Observações | Risco |
|---|---|---|---|---|
| POST | `/api/midia` | `editarMidia` (editar instalacoes/funcionarios/programas) · upload imagem/pdf | `upload_recusado` se negado | 🟢 |
| GET | `/api/midia/:id` | **`verMidia`** (corrigido: antes era qualquer logado) | servida com `nosniff`+`Content-Disposition`; `acesso_negado` se sem permissão | 🟢 (era 🟠 IDOR) |
| POST | `/api/midia/limpar-orfas` | admin/local | | 🟢 |

## Instalações / Envios

| Método | Rota | Authz | Risco |
|---|---|---|---|
| GET | `/api/instalacoes`, `/api/envios` | `ver:instalacoes` | 🟢 |
| POST/PUT/DELETE | `/api/instalacoes[/:id]`, `/api/envios[/:id]` | `editar:instalacoes` | 🟢 |
| GET | `/api/instalacoes/exportar`, `/api/envios/exportar` | `ver:instalacoes` | 🟢 |

## Contratos

| Método | Rota | Authz | Risco |
|---|---|---|---|
| GET | `/api/contratos` | `ver:contratos` | 🟢 |
| POST/PUT/DELETE | `/api/contratos[/:id]` | `editar:contratos` | 🟢 |
| POST | `/api/contratos/lote-status`, `/lote-editar`, `/lote-criar` | `editar:contratos` | 🟢 |
| POST | `/api/contratos/lote-excluir` | admin/local | exclusão em massa | 🟡 |
| POST | `/api/contratos/importar` | admin/local · upload xlsx | 🟡 |
| GET | `/api/contratos/exportar` | `ver:contratos` | 🟢 |

## Manutenção / Abastecimento (mesmo padrão)

| Método | Rota | Authz | Risco |
|---|---|---|---|
| GET | `/api/{manutencao,abastecimento}` | `ver:<área>` | 🟢 |
| POST/PUT/DELETE | `/api/{manutencao,abastecimento}[/:id]` | `editar:<área>` | 🟢 |
| POST (bulk) | `/api/{manutencao,abastecimento}` | admin/local | 🟡 |
| POST | `/api/{manutencao,abastecimento}/importar` | admin/local · upload xlsx | substitui tudo; backup antes | 🟡 |
| GET | `/api/{manutencao,abastecimento}/exportar` | `ver:<área>` | 🟢 |
| GET/POST | `/api/{manutencao,abastecimento}/backups[...]` | admin/local | 🟡 |
| GET | `/api/manutencao/relatorios` | `ver:manutencao` | agregados por veículo (cartões da sub-aba Relatórios) | 🟢 |
| GET | `/api/manutencao/relatorio/:placa` | `ver:manutencao` · auditado (`ver_/download_relatorio_veiculo`) | PDF do histórico do veículo; expõe só identificação da Frota (placa/chassi/renavam/…), nunca dados financeiros. `?assinantes=<ids>`: o nome impresso é resolvido no servidor pelo cadastro de usuários ativos — o cliente nunca envia texto livre para o documento | 🟢 |

## Fornecedores

| Método | Rota | Authz | Risco |
|---|---|---|---|
| GET | `/api/fornecedores` | `ver:fornecedores` | 🟢 |
| POST/PUT/DELETE | `/api/fornecedores[/:id]` | `editar:fornecedores` | 🟢 |
| GET | `/api/fornecedores/exportar` | `ver:fornecedores` | 🟢 |
| POST | `/api/fornecedores/importar` | admin/local · upload xlsx | 🟡 |

## Controles financeiros (aportes/empréstimos/percentuais/retiradas)

| Método | Rota | Authz | Observações | Risco |
|---|---|---|---|---|
| GET | `/api/{aportes,emprestimos,percentuais,retiradas}` | `ver:controles` | dados financeiros dos sócios | 🟡 |
| POST/PUT/DELETE | `/api/{...}[/:id]` | `editar:controles` | | 🟡 |
| GET | `/api/{...}/exportar` | `ver:controles` | Excel protegido | 🟡 |

## Funcionários / Programas SST (PII sensível)

| Método | Rota | Authz | Observações | Risco |
|---|---|---|---|---|
| GET | `/api/funcionarios`, `/api/programas` | `ver:<área>` | CPF/RG/PPP | 🟡 |
| POST/PUT/DELETE | `/api/funcionarios[/:id]`, `/api/programas[/:id]` | `editar:<área>` | | 🟡 |
| POST | `/api/funcionarios/importar` | `editar:funcionarios` · upload xlsx | | 🟡 |
| GET | `/api/funcionarios/exportar` | `ver:funcionarios` | `exportacao_sensivel` auditada; Excel protegido | 🟡 |
| GET | `/api/funcionarios/pendencias` | `ver:funcionarios` | | 🟢 |
| GET/POST | `/api/funcionarios/obrigatorios` | `ver`/`editar:funcionarios` | | 🟢 |
| POST | `/api/funcionarios/excluir-lote` | `editar:funcionarios` | exclusão em massa | 🟡 |

## Simulador / Feedback / Cadastros

| Método | Rota | Authz | Risco |
|---|---|---|---|
| GET/POST/PUT | `/api/simulacoes[/:id]` | `ver`/`editar:simulador` | 🟢 |
| GET | `/api/feedbacks` | admin/local | 🟢 |
| POST/PUT/DELETE | `/api/feedbacks[/:id][/apoiar]` | `editar:feedback` / admin | 🟢 |
| GET | `/api/cadastros` | login (fundacional) | 🟢 |
| POST/PUT/DELETE | `/api/cadastros/:tipo` | `editar:cadastros` | 🟢 |

## Administração de usuários (somente admin) — **ações sensíveis auditadas**

| Método | Rota | Authz | Evento de auditoria | Risco |
|---|---|---|---|---|
| GET | `/api/usuarios` | admin | — | 🟡 |
| GET | `/api/usuarios/ativos` | login (qualquer logado) | — · devolve só `id`+`nome` dos aprovados (escolher quem assina um documento); sem login/nível/permissões/status | 🟢 |
| POST | `/api/cadastros-abertos` | admin | — | 🟢 |
| POST | `/api/usuarios/:u/aprovar` | admin | `usuario_aprovado` | 🟡 |
| POST | `/api/usuarios/:u/recusar` | admin | `usuario_recusado` | 🟡 |
| DELETE | `/api/usuarios/:u` | admin | `usuario_excluido` | 🟠 |
| POST | `/api/usuarios/:u/senha` | admin | `senha_redefinida` | 🟠 |
| POST | `/api/usuarios/:u/nivel` | admin | `nivel_alterado` | 🟠 |
| POST | `/api/usuarios/:u/permissoes` | admin | `permissoes_alteradas` | 🟠 |
| GET | `/api/usuarios/logs` | admin | logs de acesso | 🟡 |
| GET | `/api/seguranca/logs` | admin | trilha de auditoria | 🟡 |

## Integração / Treinamentos (convites, prova e vídeo) — v1.55.35 a v1.55.41

Recorte por empresa em toda rota que toca convite/funcionário (`podeVerFunc`/`podeVerConvite`/`filtrarConvites`).
As rotas `/api/treinamentos/publico/*` e a página `/treinamento/:token` passam pelo gate de login SEM sessão:
a proteção é o token de 128 bits do convite (e o CPF no `/entrar`). O Desfazer (`UNDO_ROTAS`) cobre
`/api/treinamentos/*` exceto `/publico/` e `/videos/` (o envio do vídeo não trava o Desfazer de Funcionários).

| Método | Rota | Authz | Observações | Risco |
|---|---|---|---|---|
| GET | `/api/treinamentos`, `/api/treinamentos/:id` | `ver:integracao` | gabarito só com `?editar=1` + `editar:integracao` | 🟢 |
| POST/PUT/DELETE | `/api/treinamentos[/:id]` | `editar:integracao` | exige vídeo enviado OU link do Drive | 🟢 |
| GET | `/api/treinamentos/convites`, `/acompanhamento` | `ver:integracao` | recortado por empresa; leva o token (reenviar o link) | 🟡 |
| POST | `/api/treinamentos/acompanhamento/exportar` | `ver:integracao` | Excel dos ids da tela, recortado por empresa; sem token/link, CPF mascarado; só lê (fora do Desfazer) | 🟢 |
| POST | `/api/treinamentos/convites`, `/convites/lote` | `editar:integracao` | lote devolve o link ativo de quem já tinha, nunca de fora do recorte | 🟡 |
| POST | `/api/treinamentos/convites/:id/regenerar` | `editar:integracao` | 409 em convite concluído; `seglogs` sem o token | 🟢 |
| DELETE | `/api/treinamentos/convites/:id` | `editar:integracao` | só não concluído (409); tudo-ou-nada no recorte (403); `seglogs` alerta | 🟢 |
| POST | `/api/treinamentos/convites/excluir-lote` | `editar:integracao` | idem, até 500 ids, uma operação de Desfazer | 🟢 |
| POST | `/api/treinamentos/convites/:id/liberar-prova` | `editar:integracao` | libera a prova sem o vídeo; `seglogs` + histórico | 🟢 |
| GET | `/api/treinamentos/acompanhamento/:conviteId/certificado` | `ver:integracao` | PDF do atestado | 🟢 |
| GET | `/api/treinamentos/videos/config` | `ver:integracao` | sem segredo | 🟢 |
| POST/PUT/DELETE | `/api/treinamentos/videos/{iniciar,partes/:n,concluir,upload}` | `editar:integracao` | envio em partes de 6 MiB, sem estado no servidor; bytes mágicos MP4/WebM; máx. 2 partes simultâneas (503) | 🟡 |
| POST | `/api/treinamentos/videos/{testar,faxina}` | admin/local | testa o bucket / roda a faxina de órfãos | 🟢 |
| GET | `/api/treinamentos/:id/video-url`, `/:id/video` | `ver:integracao` | prévia do RH (URL assinada ~6 h / arquivo local com Range) | 🟢 |
| GET | `/api/treinamentos/publico/:token` | público (token) | só status | 🟢 |
| POST | `/api/treinamentos/publico/:token/entrar` | público (token + CPF) | 409 se expirado/cancelado; devolve URL assinada do vídeo, nunca a chave | 🟡 |
| POST | `/api/treinamentos/publico/:token/video`, `/video/url` | público (token, depois do `/entrar`) | `fim` só depois do tempo do vídeo (409 `VIDEO_CEDO`) | 🟡 |
| GET | `/api/treinamentos/publico/:token/video` | público (token, depois do `/entrar`) | só driver local, Range | 🟢 |
| POST | `/api/treinamentos/publico/:token/responder` | público (token) | 409 `VIDEO_PENDENTE` enquanto o vídeo travado não terminou | 🟡 |

Credenciais do bucket (`VIDEO_S3_KEY_ID`/`VIDEO_S3_KEY_SECRET`) só existem no servidor (envs do Render);
o navegador nunca fala com o bucket para enviar, só para ASSISTIR, por URL pré-assinada de leitura.

## Backup

| Método | Rota | Authz | Observações | Risco |
|---|---|---|---|---|
| GET | `/api/backup` | admin/local | `backup_baixado` auditado; usuários sem hash de senha | 🟠 |

---

## Correções aplicadas nesta auditoria

1. **🟠→🟢 `GET /api/midia/:id`**: passou a exigir permissão de mídia (`exigeVerMidia`) — corrige IDOR de documentos de RH.
2. **Exportações Excel/CSV**: `protegerCelula` neutraliza injeção de fórmula nas duas únicas funções geradoras de planilha.
3. **Uploads**: validação de MIME+extensão (mídia vs. planilha) e bloqueio de nomes perigosos.
4. **Sessão**: timeout de inatividade + absoluto (cookie assinado; formato atual v6 com 5 campos e modo "lembrar por 30 dias").
5. **Auditoria**: nova trilha `seglogs` cobrindo ações sensíveis, CSRF recusado, acesso negado e upload recusado.
6. **Observabilidade**: `correlationId` nas respostas 500.

## Telas admin de Segurança (v1.25.0 — IMPLEMENTADAS)

Grupo "Segurança" na sidebar (aba `seguranca`, guard `exigeAdminOuLocal`), 7 sub-telas:
Visão geral, Logs, Sessões, Bloqueios, Endpoints, Segredos, Configuração.
Endpoints: `GET /api/seguranca/{geral,endpoints,segredos,bloqueios,sessoes,config}`,
`POST /api/seguranca/{segredos/scan,bloqueios,bloqueios/limpar-tentativas,sessoes/revogar,sessoes/revogar-todas}`,
`PUT /api/seguranca/config`, `DELETE /api/seguranca/bloqueios/:ip`. Toda mutação grava em `seglogs`.
Novidades de segurança que vieram junto: revogação de sessão por ÉPOCA (introduzida no cookie v5 e
preservada no v6; a assinatura inclui época global + por usuário), banimento permanente de IP persistido em `sistema_config.ipBloqueados`
(403 em qualquer request), e configuração de timeout/força-bruta editável sem redeploy (SEG_CFG).

## Pendências / recomendações futuras

- Auditar exportações dos demais módulos sensíveis (controles financeiros) com `exportacao_sensivel`.
- Revisar os ~210 usos de `innerHTML` no frontend para garantir uso consistente do helper `esc()`.
- Persistir bloqueios de IP/sessão no Mongo (hoje em memória — zeram no restart).
