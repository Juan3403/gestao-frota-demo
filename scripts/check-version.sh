#!/usr/bin/env bash
# ============================================================================
#  check-version.sh — rede de segurança no servidor (CI).
#  Roda na GitHub Action a cada push/PR. Garante:
#    1) package.json e o topo do CHANGELOG (backend/server.js) na MESMA versão (sempre);
#    2) se o código servido mudou desde a base, a versão TEM que ter subido.
#  Espelha a lógica do hook local .githooks/commit-msg. O escape [sem-versao]
#  numa mensagem de commit do intervalo pula a regra (2).
#  Variáveis de ambiente (setadas pelo workflow): BEFORE, BASE_REF.
# ============================================================================
set -uo pipefail

pkg_ver()   { grep -m1 '"version"' "$1" | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'; }
chlog_top() { grep -m1 -E "versao:[[:space:]]*'" "$1" | sed -E "s/.*versao:[[:space:]]*'([^']+)'.*/\1/"; }

NEW=$(pkg_ver package.json)
TOP=$(chlog_top backend/server.js)
fail=0

# (1) Consistência — sempre.
if [ "$NEW" != "$TOP" ]; then
  echo "::error::package.json ($NEW) e topo do CHANGELOG ($TOP) divergem. Adicione a entrada nova no topo do CHANGELOG (backend/server.js)."
  fail=1
fi

# (2) Bump quando o código servido mudou — compara com a base do push/PR.
BASE=""
[ -n "${BEFORE:-}" ] && BASE="$BEFORE"
[ -n "${BASE_REF:-}" ] && BASE="origin/${BASE_REF}"

if [ -n "$BASE" ] \
   && [ "$BASE" != "0000000000000000000000000000000000000000" ] \
   && git rev-parse --verify -q "$BASE" >/dev/null 2>&1; then

  CHANGED=$(git diff --name-only "$BASE"...HEAD 2>/dev/null | grep -E '^(backend/server\.js|frontend/.*\.(js|html|css))$' || true)
  OLD=$(git show "$BASE:package.json" 2>/dev/null | grep -m1 '"version"' | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/' || true)
  SKIP=$(git log --format='%B' "$BASE..HEAD" 2>/dev/null | grep -E '\[sem-versao\]|\[skip-version\]' || true)

  if [ -n "$CHANGED" ] && [ -z "$SKIP" ] && [ "$NEW" = "$OLD" ]; then
    echo "::error::Código mudou desde $BASE mas a versão (package.json) não subiu. Suba o patch e atualize o CHANGELOG, ou use [sem-versao] no commit se for refator sem novidade."
    fail=1
  fi
fi

if [ "$fail" = 1 ]; then exit 1; fi
echo "OK — versão $NEW; package.json e CHANGELOG em sincronia."
