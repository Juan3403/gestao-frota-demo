#!/usr/bin/env node
/**
 * Scanner de segredos SEM dependências (Node puro).
 *
 *  - `node scripts/scan-secrets.js`          → varre os arquivos versionados (git ls-files).
 *  - `node scripts/scan-secrets.js --staged` → varre só o que está no stage (uso em pre-commit).
 *  - `node scripts/scan-secrets.js --all`    → varre todos os arquivos da árvore (ignorando node_modules/.git).
 *
 * Se o binário `gitleaks` estiver instalado, ele é usado (motor mais completo). Caso
 * contrário, cai no scanner interno de regex abaixo.
 *
 * REGRA DE OURO: nunca imprime o segredo. Cada achado vira um FINGERPRINT redigido:
 *   tipo · arquivo · linha · sha256(12) · prévia mascarada (ab***yz).
 * Sai com código 1 se achar algo (falha o CI / o commit).
 */
'use strict';
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MODE = process.argv.includes('--staged') ? 'staged' : (process.argv.includes('--all') ? 'all' : 'tracked');

// Arquivos cujo conteúdo é "ruidoso" para padrões genéricos (hashes de integridade etc.).
const SKIP_GENERICOS = new Set(['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock']);
// Pula APENAS a regra genérica de "atribuição de segredo" (não as fortes) em arquivos que
// legitimamente têm credenciais fake: lockfiles e testes (fixtures com senha de teste).
function pulaGenerico(arq) {
  const base = path.basename(arq);
  if (SKIP_GENERICOS.has(base)) return true;
  if (/(^|\/)tests?\//.test(arq) || /\.test\.[cm]?js$/.test(arq) || /\.spec\.[cm]?js$/.test(arq)) return true;
  return false;
}
// Arquivos de exemplo/documentação que legitimamente contêm placeholders.
const ARQUIVOS_EXEMPLO = /(^|\/)(\.env\.example|SECURITY\.md|HOSPEDAGEM\.md|README\.md|COMO_USAR\.md|AGENTS\.md|CLAUDE\.md)$/;

// Regras: cada uma extrai o "segredo" no grupo `g` (ou no match inteiro).
const REGRAS = [
  { tipo: 'MongoDB URI com credenciais', re: /mongodb(?:\+srv)?:\/\/[^:@\s"'`]+:([^@\s"'`]{3,})@/gi, g: 1 },
  { tipo: 'Chave privada (PEM)', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g, g: 0 },
  { tipo: 'AWS Access Key ID', re: /\bAKIA[0-9A-Z]{16}\b/g, g: 0 },
  { tipo: 'Token GitHub', re: /\bgh[pousr]_[0-9A-Za-z]{30,}\b/g, g: 0 },
  { tipo: 'Token Slack', re: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, g: 0 },
  { tipo: 'Google API Key', re: /\bAIza[0-9A-Za-z_\-]{30,}\b/g, g: 0 },
  { tipo: 'JWT', re: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g, g: 0 },
  { tipo: 'Atribuição de segredo', generico: true,
    // Não trate o sufixo de palavras compostas como chave (ex.: current-password/new-password do autocomplete HTML).
    re: /(?<![\w-])\b(secret|senha|password|passwd|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key)\b["']?\s*[:=]\s*["']([^"'\s]{12,})["']/gi, g: 2 },
];

// Reconhece valores que são claramente placeholder/instrução, não segredo real.
function ehPlaceholder(v) {
  if (!v) return true;
  const s = String(v);
  if (/[`${}]/.test(s)) return true; // artefato de código: template literal / interpolação ${...}
  // O `…` (U+2026) conta junto com o `...` ASCII: a documentação trunca exemplo com reticências
  // tipográficas (`"token":"gdj_itg_ab12…"`), e sem ele o exemplo virava achado no CI.
  if (/x{3,}|\.{3}|…|\*{3,}|<[^>]+>/.test(s)) return true; // <password>, cluster0.xxx, ***, ..., …
  if (/^(change|trocar|seu|sua|your|example|placeholder|redacted|dummy|fake|test|teste|dev|local|me$)/i.test(s)) return true;
  // Token de teste/exemplo em qualquer posição (ex.: "senha-de-teste-123", "chave_exemplo") → fixture, não segredo.
  if (/\b(test|teste|exemplo|example|dummy|fake|placeholder|sample|fixture)\b/i.test(s)) return true;
  if (/process\.env|randomBytes|getenv|os\.environ/i.test(s)) return true; // ex.: em código/instrução
  // Entropia baixíssima (ex.: "aaaaaaaaaaaa") → provavelmente exemplo.
  const distintos = new Set(s).size;
  if (distintos <= 3) return true;
  return false;
}

function listarArquivos() {
  try {
    if (MODE === 'staged') {
      const out = execSync('git diff --cached --name-only --diff-filter=ACM', { encoding: 'utf8' });
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    if (MODE === 'all') {
      const out = execSync("git ls-files --cached --others --exclude-standard", { encoding: 'utf8' });
      return out.split('\n').map((s) => s.trim()).filter(Boolean);
    }
    const out = execSync('git ls-files', { encoding: 'utf8' });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    console.error('Não consegui listar arquivos do git:', e.message);
    return [];
  }
}

function ehBinario(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

function mascarar(v) {
  const s = String(v);
  if (s.length <= 6) return '*'.repeat(s.length);
  return s.slice(0, 2) + '*'.repeat(Math.min(s.length - 4, 8)) + s.slice(-2);
}

function scanInterno(arquivos) {
  const achados = [];
  for (const arq of arquivos) {
    if (ARQUIVOS_EXEMPLO.test(arq)) continue;
    if (arq.startsWith('node_modules/')) continue;
    let buf;
    try { buf = fs.readFileSync(arq); } catch (e) { continue; }
    if (ehBinario(buf)) continue;
    const texto = buf.toString('utf8');
    const linhas = texto.split('\n');
    const base = path.basename(arq);
    for (let i = 0; i < linhas.length; i++) {
      const linha = linhas[i];
      for (const regra of REGRAS) {
        if (regra.generico && pulaGenerico(arq)) continue;
        regra.re.lastIndex = 0;
        let m;
        while ((m = regra.re.exec(linha)) !== null) {
          const valor = regra.g === 0 ? m[0] : m[regra.g];
          if (regra.g !== 0 && ehPlaceholder(valor)) continue;
          achados.push({
            tipo: regra.tipo,
            arquivo: arq,
            linha: i + 1,
            sha256: crypto.createHash('sha256').update(valor).digest('hex').slice(0, 12),
            previa: mascarar(valor),
          });
          if (m.index === regra.re.lastIndex) regra.re.lastIndex++;
        }
      }
    }
  }
  return achados;
}

function temGitleaks() {
  try { const r = spawnSync('gitleaks', ['version'], { stdio: 'ignore' }); return r.status === 0; }
  catch (e) { return false; }
}

function main() {
  console.log(`[scan-secrets] modo=${MODE}`);
  if (temGitleaks()) {
    console.log('[scan-secrets] gitleaks detectado — usando o motor oficial (saída redigida pelo próprio gitleaks).');
    const args = MODE === 'staged'
      ? ['protect', '--staged', '--redact', '--no-banner']
      : ['detect', '--redact', '--no-banner'];
    const r = spawnSync('gitleaks', args, { stdio: 'inherit' });
    process.exit(r.status === null ? 1 : r.status);
  }

  console.log('[scan-secrets] gitleaks não encontrado — usando o scanner interno (regex, sem dependências).');
  const arquivos = listarArquivos();
  const achados = scanInterno(arquivos);
  if (!achados.length) {
    console.log(`[scan-secrets] OK — nenhum segredo detectado em ${arquivos.length} arquivo(s).`);
    process.exit(0);
  }
  console.error(`\n[scan-secrets] ⚠️  ${achados.length} possível(is) segredo(s) detectado(s) (FINGERPRINT redigido — o valor real NÃO é exibido):\n`);
  for (const a of achados) {
    console.error(`  • ${a.tipo}`);
    console.error(`      arquivo : ${a.arquivo}:${a.linha}`);
    console.error(`      sha256  : ${a.sha256}…`);
    console.error(`      prévia  : ${a.previa}\n`);
  }
  console.error('Se for falso positivo, ajuste o padrão/allowlist em scripts/scan-secrets.js.');
  console.error('Se for REAL: rotacione a credencial e siga o checklist em docs/SECURITY.md (NÃO apenas remova o arquivo — o segredo fica no histórico).');
  process.exit(1);
}

if (require.main === module) main();

module.exports = { scanInterno };
