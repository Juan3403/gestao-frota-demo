#!/usr/bin/env node
/**
 * scripts/screenshots.mjs — prints de todas as abas da sidebar, nos dois temas, para
 * auditoria visual (comparação "antes/depois" de mudança de CSS/Design System).
 *
 * Sobe um servidor efêmero (porta livre, pasta temporária com dados fictícios do
 * scripts/seed-mock.js) e derruba tudo ao terminar — não toca a pasta data/ do seu
 * ambiente nem precisa dele rodando. Login fica desligado (modo local), então todas
 * as abas — inclusive as só-admin — ficam visíveis.
 *
 * USO (PowerShell/bash, da pasta do projeto):
 *   node scripts/screenshots.mjs                        # grava em screenshots/antes/
 *   node scripts/screenshots.mjs --out screenshots/depois
 *   node scripts/screenshots.mjs --tabs frota,multas     # só essas abas (valor de data-tab)
 *
 * Exemplo — comparar antes/depois de uma mudança de CSS:
 *   node scripts/screenshots.mjs --out screenshots/antes
 *   git stash                                  # ou faça a mudança de CSS
 *   node scripts/screenshots.mjs --out screenshots/depois
 *   # abra os dois PNGs de uma mesma aba lado a lado
 *
 * Saída: <out>/<aba>-claro.png e <out>/<aba>-escuro.png, 1440x900 @2x, página inteira.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Porta 3213. CONVENÇÃO DE FAIXAS: a pasta `test/` fica em 3196-3209 (uma por arquivo — o
// `node --test` roda os arquivos em processos PARALELOS) e as pastas `e2e/` e `scripts/` ficam em
// 3210+, para que as duas suítes possam rodar ao mesmo tempo. Era 3196, a mesma de test/security.test.js.
// `test/portas.test.js` cobra unicidade e faixa — não escolha porta "no olho".
const PORT = 3213;
const BASE = `http://localhost:${PORT}`;

function argv(flag, padrao) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}

const OUT_DIR = path.resolve(RAIZ, argv('--out', 'screenshots/antes'));
const FILTRO_ABAS = argv('--tabs', null)?.split(',').map((s) => s.trim()).filter(Boolean) || null;

function listarAbas() {
  const html = fs.readFileSync(path.join(RAIZ, 'frontend', 'index.html'), 'utf8');
  const nav = html.slice(html.indexOf('<nav class="side-nav">'), html.indexOf('</nav>'));
  const vistas = new Set();
  for (const m of nav.matchAll(/data-tab="([a-z0-9-]+)"/g)) vistas.add(m[1]);
  const lista = [...vistas];
  return FILTRO_ABAS ? lista.filter((a) => FILTRO_ABAS.includes(a)) : lista;
}

async function esperarServidor(ms = 20000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { const r = await fetch(`${BASE}/api/versao`); if (r.ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de screenshots não respondeu a tempo');
}

/** Espera a view ativa parar de mudar de tamanho (fontes carregadas, sem esqueleto). */
async function layoutEstavel(page, timeout = 12000) {
  await page.evaluate(() => document.fonts.ready);
  const assinatura = () => page.evaluate(() => {
    const v = document.querySelector('.view.active');
    if (!v) return '-';
    const r = v.getBoundingClientRect();
    const esqueleto = v.querySelector('.v2-skel, .skeleton, [aria-busy="true"]');
    return `${Math.round(r.width)},${Math.round(r.height)},${esqueleto ? 1 : 0}`;
  });
  const fim = Date.now() + timeout;
  let anterior = null, iguais = 0;
  while (Date.now() < fim) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const atual = await assinatura();
    if (atual === anterior && !atual.endsWith(',1')) { if (++iguais >= 2) return; } else { iguais = 0; anterior = atual; }
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-shots-'));
  const envBase = { ...process.env };
  delete envBase.MONGODB_URI;

  console.log('Semeando dados fictícios em', tmp, '...');
  execFileSync(process.execPath, ['scripts/seed-mock.js', '--apply', '--limpar'], {
    cwd: RAIZ, env: { ...envBase, DATA_DIR: tmp }, stdio: 'inherit',
  });

  console.log('Subindo servidor efêmero na porta', PORT, '...');
  // A porta tem de estar livre: com um servidor alheio de pé, o nosso morre com EADDRINUSE e o
  // esperarServidor() aceitaria o 200 do intruso — as capturas sairiam da tela de OUTRA base.
  let portaOcupada = false;
  try { await fetch(BASE + '/api/versao', { signal: AbortSignal.timeout(1500) }); portaOcupada = true; } catch (e) { /* recusou = livre */ }
  if (portaOcupada) {
    console.error(`A porta ${PORT} já está ocupada por outro processo. Encerre-o e rode de novo (convenção de portas em test/portas.test.js).`);
    process.exit(1);
  }
  const srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: RAIZ,
    env: { ...envBase, DATA_DIR: tmp, PORT: String(PORT), APP_PASSWORD: '', SENHA_ADMIN: '', E2E_TEST: '1', COFRE_CHAVE: 'chave-screenshots-nao-producao' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srvLog = '';
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.on('exit', (codigo) => {
    if (codigo) console.error(`O servidor saiu com código ${codigo}:`, srvLog.slice(-2000));
  });

  try {
    await esperarServidor();
    const abas = listarAbas();
    console.log(`${abas.length} aba(s):`, abas.join(', '));

    const browser = await chromium.launch();
    for (const tema of ['claro', 'escuro']) {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
      await ctx.addInitScript((t) => { try { localStorage.setItem('tema', t); } catch { /* ignora */ } }, tema);
      for (const aba of abas) {
        const page = await ctx.newPage();
        await page.goto(`${BASE}/painel/${aba}`, { waitUntil: 'load' });
        await page.locator('#sidebar').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await page.locator('.view.active').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        await layoutEstavel(page);
        const arquivo = path.join(OUT_DIR, `${aba}-${tema}.png`);
        await page.screenshot({ path: arquivo, fullPage: true });
        console.log('  ✓', path.relative(RAIZ, arquivo));
        await page.close();
      }
      await ctx.close();
    }
    await browser.close();
  } finally {
    srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
