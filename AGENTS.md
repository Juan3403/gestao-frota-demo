# Frota NTE — Sistema de Gestão de Frota (Norte Engenharia)

App web de gestão de veículos, multas, rastreadores e pessoal. **Backend** Node + Express; **frontend** vanilla JS (sem framework, sem build). Deploy no **Render** em `https://gestao.example.com`.

**Para as regras completas do projeto, consultar `CLAUDE.md` (raiz)** — este arquivo é só a camada curta de roteamento; em caso de divergência, vale o `CLAUDE.md`.

## 🚨 Design System (fonte normativa de UI)
**Todo trabalho de UI deve seguir:**
- `docs/DESIGN.md` — fonte de verdade obrigatória do padrão visual;
- `frontend/design-system/` — o Design System oficial (tokens `--ds-*`; primitivos em `01-tokens.css`, semânticos em `02-themes.css`).

`frontend/styles.css` contém apenas legado/compatibilidade e **não é fonte de novos designs**. O apêndice histórico do `docs/DESIGN.md` não é normativo — nada de Bricolage Grotesque, gradientes antigos, sombras decorativas, raios 10/14/18px ou `translateY` no hover.

## 🚨 Regras obrigatórias (detalhe no CLAUDE.md)
- **Versão + CHANGELOG andam juntos:** mudança visível ao usuário exige subir o patch em `package.json` **e** entrada no topo do `CHANGELOG` em `backend/server.js` (hook e GitHub Action barram commit/push se faltar; `[sem-versao]` só para mudança interna sem novidade visível).
- **Funcionalidade nova nasce com exemplo de uso** no mesmo commit, num comentário junto da implementação (formato: seção "Regra de desenvolvimento" do `README.md`).

## Essencial para não errar
- **Persistência em DOIS modos:** local (dev) = JSONs na pasta **`data/`** (gitignored inteira), lidos frescos a cada request; produção (Render) = **MongoDB** com tudo em memória (`mem.*`) no boot — mudança direta no banco só aparece após restart/redeploy.
- **Anexos (cofre de arquivos):** com `MIDIA_S3_BUCKET` vão para o bucket R2 e são lidos do R2 com o Mongo/`data/uploads` como reserva (migração em andamento) — `backend/cofre-midia.js`, `docs/ARQUIVOS_R2.md`. Nunca acesse `midia_<id>` direto: use `salvarMidia`/`lerMidia`/`existeMidia`/`excluirMidia`.
- Dados locais são **fictícios** (`scripts/seed-mock.js`; usuários `*.demo`, senha `demo1234`).
- **Roteamento por path com base `/painel`** (History API): `/painel/<aba>[/<sub>]`. O `/` é o hub público (`hub/`). Não é mais por hash.
- Preview local: `.claude/launch.json` (preview "frota", autoPort).
- Workflow do usuário (Juan): ele mesmo commita (GitHub Desktop) e deploya (Render). Não commitar por ele; testa primeiro no localhost.
- `MONGODB_URI`/`APP_PASSWORD`/`SESSION_SECRET` são envs do Render — nunca colar segredos no chat.

Detalhes de abas/features, modelo de dados, permissões, backup, scripts e gotchas: **`CLAUDE.md`** e `docs/` (`README.md` indexa).
