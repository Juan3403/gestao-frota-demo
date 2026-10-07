/**
 * Teste de BROWSER REAL do hub de acesso (gestao.example.com/, pasta hub/), redesenhado no Design
 * System na 1.55.45.
 *
 * Rodar:  node --test e2e/hub.e2e.js   (também entra no `npm run test:e2e`)
 * Porta 3214 (faixa de e2e/ e scripts/ = 3210+, convenção cobrada por test/portas.test.js).
 *
 * O que estes testes protegem (comportamento, não pixel):
 *   - último acesso: o cartão dele nasce marcado e com o selo; sem último acesso, o 1º, sem selo;
 *   - teclado: ← → alternam o marcado; 1 e 2 abrem SÓ com o foco num cartão (WCAG 2.1.4) e o
 *     foco já nasce no marcado, então funcionam de cara; clicar em qualquer ponto do cartão entra;
 *   - tema: mesma chave `tema` do app e do login, migração da chave antiga `hub-nte:tema`;
 *   - a volta ao hub pelo painel (`transicaoParaSistema('hub')`) termina em '/'.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = 3214;
const BASE = `http://localhost:${PORT}`;
const FLUXO = 'https://fluxo.example.com';
let srv, tmp, browser;
let srvSaida = null; // código com que o filho morreu, se morreu (porta ocupada, env faltando...)
let srvLog = '';

async function esperarServidor(ms = 20000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (srvSaida !== null) {
      throw new Error(`O servidor de teste (porta ${PORT}) morreu com código ${srvSaida} antes de responder.`
        + (srvLog ? `\n--- stderr do servidor ---\n${srvLog.slice(-2000)}` : ''));
    }
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de teste não respondeu a tempo');
}

/**
 * Abre o hub num contexto limpo com o localStorage pedido já gravado antes do primeiro script.
 * O Fluxo RM (outro domínio) é interceptado com uma página mínima, para o teste não sair da
 * máquina.
 * Ex.: const page = await abrirHub({ 'hub-nte:ultimo-sistema': 'fluxo' }, { width: 390, height: 844 })
 */
async function abrirHub(armazenado = {}, viewport = { width: 1440, height: 900 }) {
  const ctx = await browser.newContext({ viewport });
  await ctx.addInitScript((itens) => {
    // Só na PRIMEIRA carga do contexto: senão cada navegação regravaria o estado inicial.
    if (sessionStorage.getItem('__semeado')) return;
    sessionStorage.setItem('__semeado', '1');
    for (const [k, v] of Object.entries(itens)) localStorage.setItem(k, v);
  }, armazenado);
  await ctx.route(`${FLUXO}/**`, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Fluxo</title>' }));
  const page = await ctx.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));
  page.erros = erros;
  await page.goto(BASE + '/', { waitUntil: 'load' });
  return page;
}

/** Estado visível do hub: quem está marcado, quem mostra o selo, onde está o foco, o tema. */
async function estado(page) {
  return page.evaluate(() => ({
    marcado: [...document.querySelectorAll('.sistema.marcado')].map((c) => c.dataset.sistema),
    selo: [...document.querySelectorAll('.sistema')].filter((c) => !c.querySelector('.sistema-selo').hidden).map((c) => c.dataset.sistema),
    foco: document.activeElement && document.activeElement.closest('.sistema') ? document.activeElement.closest('.sistema').dataset.sistema : null,
    dark: document.documentElement.classList.contains('dark'),
    tema: localStorage.getItem('tema'),
    temaAntigo: localStorage.getItem('hub-nte:tema'),
    ultimo: localStorage.getItem('hub-nte:ultimo-sistema'),
  }));
}

before(async () => {
  let portaOcupada = false;
  try {
    await fetch(BASE + '/api/versao', { signal: AbortSignal.timeout(1500) });
    portaOcupada = true;
  } catch (e) { /* conexão recusada = porta livre */ }
  if (portaOcupada) {
    throw new Error(`A porta ${PORT} já está ocupada por outro processo. Encerre-o e rode de novo `
      + '(a convenção de portas do repositório está em test/portas.test.js).');
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-hub-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: tmp, PORT: String(PORT),
      APP_PASSWORD: '', SENHA_ADMIN: '', MONGODB_URI: '',
      E2E_TEST: '1', COFRE_CHAVE: 'chave-segura-exclusiva-dos-testes-do-hub',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.on('exit', (codigo, sinal) => { srvSaida = codigo === null ? `sinal ${sinal}` : codigo; });
  await esperarServidor();
  browser = await chromium.launch({ headless: !process.env.HEADED });
});

after(async () => {
  try { await browser?.close(); } catch (e) { /* já fechou */ }
  try { srv.kill(); } catch (e) { /* já morreu */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

test('HUB-1: último acesso marca o cartão, acende o selo e recebe o foco', async () => {
  let page = await abrirHub();
  let e = await estado(page);
  assert.deepEqual(e.marcado, ['gestao'], 'sem último acesso, o 1º cartão fica marcado (o Enter sempre tem destino)');
  assert.deepEqual(e.selo, [], 'sem último acesso, nenhum selo');
  assert.equal(e.foco, 'gestao', 'o foco nasce no cartão marcado (1, 2 e Enter funcionam de cara)');
  assert.deepEqual(page.erros, [], 'o hub não pode ter erro de console');
  await page.context().close();

  page = await abrirHub({ 'hub-nte:ultimo-sistema': 'fluxo' });
  e = await estado(page);
  assert.deepEqual(e.marcado, ['fluxo']);
  assert.deepEqual(e.selo, ['fluxo'], 'o selo "Último acesso" fica só no cartão do último sistema');
  assert.equal(e.foco, 'fluxo');
  await page.context().close();
});

test('HUB-2: setas alternam o marcado; 1 e 2 só abrem com o foco num cartão (WCAG 2.1.4)', async () => {
  const page = await abrirHub();
  await page.keyboard.press('ArrowRight');
  assert.deepEqual((await estado(page)).marcado, ['fluxo'], '→ marca o próximo sistema');
  await page.keyboard.press('ArrowLeft');
  assert.deepEqual((await estado(page)).marcado, ['gestao'], '← volta');

  // Foco fora dos cartões: a tecla de caractere não pode disparar nada.
  await page.evaluate(() => document.activeElement.blur());
  await page.keyboard.press('2');
  await page.waitForTimeout(300);
  assert.equal(new URL(page.url()).pathname, '/', 'com o foco fora dos cartões, a tecla 2 não pode navegar');

  // Com o foco num cartão, a tecla 2 abre o Fluxo RM e grava o último acesso.
  await page.keyboard.press('ArrowRight');
  await Promise.all([page.waitForURL(`${FLUXO}/**`), page.keyboard.press('2')]);
  await page.goto(BASE + '/', { waitUntil: 'load' });
  const e = await estado(page);
  assert.equal(e.ultimo, 'fluxo');
  assert.deepEqual(e.selo, ['fluxo']);
  await page.context().close();
});

test('HUB-3: clicar em qualquer ponto do cartão entra no sistema dele', async () => {
  const page = await abrirHub();
  // Clique de MOUSE nas coordenadas da descrição (não `locator.click()`): quem recebe o clique
  // de verdade é o ::after do "Entrar", que cobre o cartão de propósito, e o Playwright recusaria
  // clicar num elemento "coberto". É exatamente isso que o teste quer provar.
  const caixa = await page.locator('.sistema[data-sistema="fluxo"] .sistema-desc').boundingBox();
  await Promise.all([
    page.waitForURL(`${FLUXO}/**`),
    page.mouse.click(caixa.x + caixa.width / 2, caixa.y + caixa.height / 2),
  ]);
  await page.context().close();
});

test('HUB-4: tema na chave compartilhada `tema`, lido pelo login; chave antiga migrada', async () => {
  // Migração: o "preto" do alternador antigo vira `tema = escuro` e a chave antiga some.
  let page = await abrirHub({ 'hub-nte:tema': 'preto' });
  let e = await estado(page);
  assert.equal(e.dark, true, 'preto do hub antigo abre no escuro');
  assert.equal(e.tema, 'escuro');
  assert.equal(e.temaAntigo, null, 'a chave antiga é apagada depois da migração');
  await page.context().close();

  // Com tema já escolhido no app, a escolha do app vence a do hub antigo.
  page = await abrirHub({ 'hub-nte:tema': 'preto', tema: 'claro' });
  e = await estado(page);
  assert.equal(e.dark, false);
  assert.equal(e.tema, 'claro');
  assert.equal(e.temaAntigo, null);

  // Alternar aqui grava na mesma chave do login: o login abre no tema escolhido.
  await page.locator('#temaToggle').click();
  e = await estado(page);
  assert.equal(e.dark, true);
  assert.equal(e.tema, 'escuro');
  assert.equal(await page.locator('#temaToggle').getAttribute('aria-label'), 'Usar tema claro');
  await page.goto(BASE + '/login', { waitUntil: 'load' });
  assert.equal(await page.evaluate(() => document.body.classList.contains('dark')), true, 'o login lê o tema escolhido no hub');
  await page.context().close();
});

test('HUB-5: no celular, sem prévia e com o botão de largura inteira nomeando o sistema', async () => {
  const page = await abrirHub({}, { width: 390, height: 844 });
  const r = await page.evaluate(() => {
    const a = document.querySelector('.sistema[data-sistema="gestao"] .sistema-entrar');
    return {
      previa: getComputedStyle(document.querySelector('.sistema-previa')).display,
      texto: a.innerText.replace(/\s+/g, ' ').trim(),
      alturaBotao: a.getBoundingClientRect().height,
      rolagemLateral: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  });
  assert.equal(r.previa, 'none');
  assert.equal(r.texto, 'Entrar no Gestão RM');
  assert.ok(r.alturaBotao >= 44, `alvo de toque de 44px (medido ${r.alturaBotao})`);
  assert.equal(r.rolagemLateral, 0, 'sem rolagem horizontal no celular');
  await page.context().close();
});

test('HUB-6: a volta ao hub pelo painel termina em /', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(BASE + '/painel', { waitUntil: 'domcontentloaded' }); // SSE aberto: nada de 'networkidle'
  await page.waitForFunction(() => typeof transicaoParaSistema === 'function');
  await Promise.all([
    page.waitForURL(BASE + '/'),
    page.evaluate(() => transicaoParaSistema('hub')),
  ]);
  assert.ok(await page.locator('.sistema[data-sistema="gestao"]').count(), 'chegou ao hub');
  await ctx.close();
});
