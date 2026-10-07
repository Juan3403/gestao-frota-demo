/**
 * Teste de BROWSER REAL do Design System ("design-v2", nome histórico) na aba Frota.
 *
 * Arquivo próprio (e não dentro de browser.e2e.js) porque concentra o contrato visual do
 * Design System — componentes, densidade, filtros, estados e isolamento entre módulos.
 *
 * Rodar:  npm run test:e2e:design-v2   (ou `node --test e2e/frota-design-v2.e2e.js`)
 * Porta 3211. Convenção de faixas: a pasta `test/` = 3196-3209 (uma por arquivo, porque o
 * `node --test` roda os arquivos em paralelo) e as pastas `e2e/` e `scripts/` = 3210+, para as duas
 * suítes poderem rodar ao mesmo tempo. Este arquivo já usou a 3197 e colidia em silêncio com
 * test/almoxarifado.test.js — o comentário antigo enumerava só os outros arquivos de e2e e
 * nunca varria `test/`, que foi exatamente como o bug entrou. `test/portas.test.js` cobra.
 *
 * ⚠️ `npm run test:e2e` usa `--test-concurrency=1`: `node --test` roda ARQUIVOS em processos
 * PARALELOS por padrão, e dois Chromium + dois servidores Express ao mesmo tempo dobram a
 * carga da máquina. Foi nessa condição que apareceu a única falha intermitente da suíte de
 * Funcionários (não reproduzida depois). Sequencial é mais lento e previsível — e nenhuma
 * asserção precisou ser enfraquecida por causa disso.
 *
 * Consolidação visual (ago/2026): o Design System deixou de ser opt-in — é a identidade
 * única do app. O antigo kill-switch `?design=off` foi aposentado: a query é simplesmente
 * ignorada (styles.css não guarda mais uma aparência alternativa mantida).
 *
 * O que estes testes protegem (contrato, não pixel):
 *   - o Design System liga sozinho e `?design=off` é ignorado;
 *   - o Design System não vaza para fora de um módulo migrado, mesmo com todos migrados;
 *   - alto contraste é independente do Design System (nenhum dos dois desliga o outro);
 *   - o painel de filtros é acessível de teclado e anuncia o que é;
 *   - filtros/chips/densidade/estados continuam funcionando dentro dele;
 *   - módulos migrados (`.ds-modulo`, detectados pelo DOM, sem lista fixa aqui) têm estilos
 *     computados IGUAIS entre si nos componentes genéricos.
 * Valores exatos de CSS só são exigidos onde ELES SÃO o contrato (32px/40px de densidade);
 * no resto a verificação é semântica.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');

const PORT = 3211;
const BASE = `http://localhost:${PORT}`;
const PAINEL = `${BASE}/painel`;
const ORIG = { Origin: BASE };
let srv, tmp, browser;
// Estado do processo filho: sem isto, um servidor que morre no boot (EADDRINUSE, variável de
// ambiente faltando...) some em silêncio — o spawn descartava o stderr e ninguém olhava o código
// de saída, então a suíte seguia contra o servidor alheio já de pé na porta.
let srvSaida = null; // código (ou sinal) com que o filho morreu, se morreu
let srvLog = '';     // stderr do filho, para a mensagem de erro dizer o motivo

// Base semeada determinística. Nomes longos de propósito: é o que faz os chips quebrarem
// linha e a coluna de modelo usar reticências.
const CENTROS = ['CONTRATO 4600009505 - ORION MANUTENÇÃO INDUSTRIAL', 'ADMINISTRATIVO MATRIZ NATAL'];
const DONOS = ['RICARDO MENDES DE ALMEIDA', 'MARCELO PORTELA DE SOUZA'];
const MODELOS = ['HILUX SW4 SRX 2.8 DIESEL 4X4 AUTOMÁTICO', 'STRADA FREEDOM CD 1.3 FIREFLY FLEX'];
const STATUS = ['EM ATIVIDADE', 'EM ATIVIDADE', 'GALPÃO', 'VEÍCULO VENDIDO'];
const SEMENTE = Array.from({ length: 12 }, (_, i) => ({
  placa: `DV2${String(i + 1).padStart(2, '0')}${String.fromCharCode(65 + i)}${i % 10}`,
  modelo: MODELOS[i % MODELOS.length],
  anoFab: 2018 + (i % 5), anoMod: 2019 + (i % 5), cor: 'BRANCA',
  centroCusto: CENTROS[i % CENTROS.length], dono: DONOS[i % DONOS.length],
  valorFipe: 80000 + i * 5000, doc: i % 5 === 2 ? 2024 : 2026,
  status: STATUS[i % STATUS.length],
  gravame: i % 2 ? 'ALIENADO' : 'NADA CONSTA',
  pctRicardo: 0.5, pctMarcelo: 0.5,
})).concat([
  { placa: 'DV2OFI1', modelo: MODELOS[0], status: 'OFICINA', oficinaPrevisaoSaida: '2026-08-20', oficinaPrazoDias: 10, centroCusto: CENTROS[0], dono: DONOS[0], doc: 2026, gravame: 'NADA CONSTA', valorFipe: 90000, pctRicardo: 0.5, pctMarcelo: 0.5 },
  { placa: 'DV2OFI2', modelo: MODELOS[1], status: 'OFICINA', centroCusto: CENTROS[1], dono: DONOS[1], doc: 2026, gravame: 'ALIENADO', valorFipe: 70000, pctRicardo: 0.5, pctMarcelo: 0.5 },
]);

async function esperarServidor(ms = 20000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    // O filho morreu antes de responder. Sem esta checagem o laço iria até o timeout — ou,
    // pior, aceitaria o 200 de um servidor ALHEIO na mesma porta.
    if (srvSaida !== null) {
      throw new Error(`O servidor de teste (porta ${PORT}) morreu com código ${srvSaida} antes de responder.`
        + (srvLog ? `
--- stderr do servidor ---
${srvLog.slice(-2000)}` : ''));
    }
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de teste não respondeu a tempo');
}

/** Abre a Frota com o piloto no estado pedido e espera a lista chegar. */
async function abrir(opts = {}) {
  const { design = 'v2', viewport = { width: 1440, height: 900 }, aba = 'frota' } = opts;
  const page = await browser.newPage({ viewport });
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));
  page.erros = erros;
  await page.goto(`${PAINEL}/${aba}${design ? `?design=${design}` : ''}`, { waitUntil: 'load' });
  await page.locator('#sidebar').waitFor({ state: 'visible', timeout: 10000 });
  if (aba === 'frota') await page.locator('#corpoTabela tr:not(.v2-skel)').first().waitFor({ state: 'visible', timeout: 10000 });
  return page;
}

/* Abre a Frota com a PRIMEIRA carga adulterada — é a única forma honesta de testar o estado
   inicial: depois que um conjunto válido chega, `FROTA_TEVE_DADOS` liga e a tela deixa de
   entrar em "carregando"/"erro inicial" de propósito (ver 2.6). `como`: 'lenta' | 'falha'. */
async function abrirCarga(como, opts = {}) {
  const { design = 'v2', viewport = { width: 1440, height: 900 }, atraso = 2000 } = opts;
  const page = await browser.newPage({ viewport });
  const erros = [];
  // A falha de rede é PROVOCADA por este teste: o "Failed to load resource / net::ERR_FAILED"
  // que o Chromium registra é consequência esperada, não erro de JS do app.
  const provocado = (t) => /net::ERR_FAILED|Failed to load resource/i.test(t);
  page.on('console', (m) => { if (m.type() === 'error' && !provocado(m.text())) erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));
  page.erros = erros;
  await page.route('**/api/veiculos', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (como === 'falha') return route.abort('failed');
    await new Promise((r) => setTimeout(r, atraso));
    await route.continue();
  });
  await page.goto(`${PAINEL}/frota?design=${design}`, { waitUntil: 'load' });
  await page.locator('#sidebar').waitFor({ state: 'visible', timeout: 10000 });
  return page;
}

/* Troca de aba pela sidebar (`.tab[data-tab]`, "estilo Cobli" desde ago/2026): em telas
   ≥901px cada `.tab` só fica visível/clicável DENTRO do flyout do seu grupo (`.nav-group`),
   aberto por hover ou clicando no título do grupo (`iniciarSidebarCobli`, frontend/app.js).
   O viewport dos testes (1440px) sempre cai nesse modo — clicar direto no `.tab` sem abrir o
   grupo antes trava em "element is not visible" até estourar o timeout. Clicar no título é
   mais estável no Playwright do que simular hover (não depende do debounce de 40ms).
   Ex.: await irPara(page, 'multas') → abre o grupo "Financeiro" e clica na aba Multas.
   Sem grupo (ex. estado antigo/legado sem sidebar Cobli), cai direto no clique — retrocompat. */
async function irPara(page, dataTab) {
  // Início é a exceção: no trilho ≥901px o grupo "Painel" inteiro fica display:none —
  // quem leva ao Início é o LOGO (`#logoHome`, frontend/app.js), como na Cobli. Clicar
  // no título daquele grupo trava em "element is not visible" até estourar o timeout.
  if (dataTab === 'inicio' && await page.locator('#grupoPainel').evaluate((g) => getComputedStyle(g).display === 'none')) {
    await page.locator('#logoHome').click();
    return;
  }
  const link = page.locator(`.tab[data-tab="${dataTab}"]`);
  const grupo = link.locator('xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " nav-group ")][1]');
  if (await grupo.count()) {
    const titulo = grupo.locator('.nav-group-title');
    if (await titulo.count()) await titulo.click();
  }
  await link.click();
  // "Escolher uma aba não fecha o painel" é o comportamento desejado com mouse de verdade —
  // o painel só soma quando o cursor sai da sidebar (200ms). No teste ele fica aberto por cima
  // da tela seguinte e passa a interceptar cliques por COORDENADA (ex.: uma sub-aba do módulo
  // que abriu, se cair sob a área do flyout). Fechar aqui equivale a "o mouse saiu da sidebar" —
  // não mexe em `.flyout-fixado` (o pino é escolha explícita do usuário, continua aberto).
  await page.evaluate(() => document.querySelectorAll('.nav-group.flyout-aberto')
    .forEach((g) => g.classList.remove('flyout-aberto', 'sem-anim')));
}

/* Espera o layout PARAR de mudar, por condição observável — nada de sleep fixo. As 5 famílias
   de fonte entram com `display=swap` e o ResizeObserver de `ajustarAcoesQuebradas` tem 80ms de
   debounce: medir antes disso devolve caixa de fonte-de-sistema. Duas leituras idênticas em
   quadros consecutivos = assentou. */
async function layoutEstavel(page, timeout = 15000) {
  await page.evaluate(() => document.fonts.ready);
  const assinatura = () => page.evaluate(() => ['#frota-lista .toolbar', '#frota .tabela-wrap', '#frotaKpis', '#frotaChips', '#frotaFiltrosPainel']
    .map((s) => { const el = document.querySelector(s); if (!el) return s + ':-'; const r = el.getBoundingClientRect(); return `${s}:${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}`; }).join('|'));
  const fim = Date.now() + timeout;
  let anterior = null, iguais = 0;
  while (Date.now() < fim) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const atual = await assinatura();
    if (atual === anterior) { if (++iguais >= 2) return; } else { iguais = 0; anterior = atual; }
  }
  throw new Error('o layout não estabilizou a tempo');
}

/** Marca valores num multiselect da Frota sem depender da posição do menu na tela. */
async function marcar(page, pares) {
  await page.evaluate((ps) => {
    for (const [id, vals] of ps) if (typeof MSEL !== 'undefined' && MSEL[id]) MSEL[id].setSelecionados(vals);
    renderTabela();
  }, pares);
}

const linhas = (page) => page.locator('#corpoTabela tr:not(.v2-skel)').count();

/* O #toast é um elemento ÚNICO e permanente (região aria-live): o que aparece e some é a
   classe `show`, não o nó. Removê-lo do DOM faria o próximo toast() achar null e explodir —
   para zerar o estado antes de medir, tira-se só a classe (e o timer que a removeria depois). */
const limparToast = (page) => page.evaluate(() => {
  const t = document.getElementById('toast');
  if (t) { clearTimeout(t._timer); t.classList.remove('show'); }
});

before(async () => {
  // A porta precisa estar LIVRE ANTES do spawn. Se alguém já responde nela, o nosso servidor
  // morre com EADDRINUSE e o laço de espera aceitaria o 200 do intruso já no primeiro ciclo — a
  // suíte inteira rodaria contra o DATA_DIR, a COFRE_CHAVE e o teto de requisições de outro
  // servidor. test/portas.test.js impede a colisão entre arquivos do repo; isto aqui pega o
  // servidor esquecido aberto na máquina.
  let portaOcupada = false;
  try {
    await fetch(BASE + '/api/versao', { signal: AbortSignal.timeout(1500) });
    portaOcupada = true;
  } catch (e) { /* conexão recusada = porta livre, que é o que queremos */ }
  if (portaOcupada) {
    throw new Error(`A porta ${PORT} já está ocupada por outro processo. Encerre-o e rode de novo `
      + '(a convenção de portas do repositório está em test/portas.test.js).');
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-dv2-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: tmp, PORT: String(PORT),
      APP_PASSWORD: '', SENHA_ADMIN: '', MONGODB_URI: '',
      E2E_TEST: '1', COFRE_CHAVE: 'chave-segura-exclusiva-dos-testes-design-v2',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Só o stderr é canalizado: o stdout do servidor é o banner e a telemetria de memória, ruído
  // puro aqui. E um cano que ninguém drena enche e trava o filho — por isso os dois listeners.
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.on('exit', (codigo, sinal) => { srvSaida = codigo === null ? `sinal ${sinal}` : codigo; });
  await esperarServidor();
  for (const v of SEMENTE) {
    const r = await fetch(`${BASE}/api/veiculos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(v),
    });
    assert.equal(r.status, 201, `semeadura de ${v.placa} falhou (${r.status})`);
  }
  browser = await chromium.launch({ headless: !process.env.HEADED });
});

after(async () => {
  try { await browser?.close(); } catch (e) { /* já fechou */ }
  try { srv.kill(); } catch (e) { /* já morreu */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

/* ============================================================
   3.1 / 3.2 — ativação, persistência e desligamento
   ============================================================ */
test('design-v2: é a aparência padrão — liga sozinho, sem precisar de ?design=v2', async () => {
  // Abre SEM nenhuma query nem preferência salva: o Design System já tem de estar ligado,
  // porque ele é o padrão agora (não mais opt-in).
  const page = await abrir({ design: null });
  assert.equal(await page.evaluate(() => document.body.classList.contains('design-v2')), true,
    'a classe design-v2 deve entrar no <body> mesmo sem query nem preferência salva');

  // Recarregar de novo: continua ligado, porque é o padrão — não porque algo persistiu.
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  await page.locator('#corpoTabela tr').first().waitFor({ state: 'visible', timeout: 10000 });
  assert.equal(await page.evaluate(() => document.body.classList.contains('design-v2')), true,
    'recarregar sem a query deve manter o piloto ligado');

  // DOM do Design System realmente na tela (não só presente no HTML). O toggle de
  // densidade não tem id fixo por aba: é injetado por JS em TODA `.toolbar` de módulo
  // com tabela (`injetarTogglesDensidade`, frontend/app.js) — aqui pega-se o da Frota
  // mesmo, `#frota-lista [data-densidade-toggle]`.
  const visiveis = await page.evaluate(() => {
    const o = ['frotaKpis', 'frotaChips', 'frotaRodape', 'frotaFiltrosBtn']
      .reduce((acc, id) => (acc[id] = getComputedStyle(document.getElementById(id)).display, acc), {});
    o.frotaDensidade = getComputedStyle(document.querySelector('#frota-lista [data-densidade-toggle]')).display;
    return o;
  });
  assert.equal(visiveis.frotaKpis !== 'none', true, 'a faixa de KPIs deve aparecer com o piloto ligado');
  assert.equal(visiveis.frotaRodape !== 'none', true, 'o rodapé deve aparecer com o piloto ligado');
  assert.equal(visiveis.frotaDensidade !== 'none', true, 'o controle de densidade deve aparecer');
  assert.equal(visiveis.frotaFiltrosBtn !== 'none', true, 'o botão Filtros deve aparecer');
  assert.equal(await page.evaluate(() => getComputedStyle(document.getElementById('resumoLinha')).display), 'none',
    'a linha "Exibindo X de Y" cede o lugar para os KPIs e o rodapé');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: o antigo ?design=off é ignorado — o Design System nunca desliga', async () => {
  // O kill-switch foi aposentado (styles.css não guarda mais uma aparência alternativa):
  // links antigos com a query não podem deixar ninguém numa tela sem estilo mantido.
  const page = await abrir({ design: null });
  await page.goto(`${PAINEL}/frota?design=off`, { waitUntil: 'load' });
  await page.locator('#corpoTabela tr').first().waitFor({ state: 'visible', timeout: 10000 });

  assert.equal(await page.evaluate(() => document.body.classList.contains('design-v2')), true,
    'a classe design-v2 continua no <body> mesmo com ?design=off na URL');
  const ligado = await page.evaluate(() => ({
    kpis: getComputedStyle(document.getElementById('frotaKpis')).display,
    role: document.getElementById('frotaFiltrosPainel').getAttribute('role'),
    sobrouChave: sessionStorage.getItem('design-v2') || localStorage.getItem('design-v2'),
  }));
  assert.notEqual(ligado.kpis, 'none', 'a faixa de KPIs continua na tela');
  assert.equal(ligado.role, 'dialog', 'o painel de filtros continua anunciado como diálogo');
  assert.equal(ligado.sobrouChave, null, 'nenhuma chave de storage do antigo kill-switch pode ser gravada');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

/* ============================================================
   3.3 — isolamento entre abas
   ============================================================ */
test('design-v2: o shell acompanha módulos migrados e nada exclusivo da Frota vaza', async () => {
  // O contrato não é "só a Frota tem grafite", é "todo módulo com .ds-modulo tem" — então os
  // módulos cobertos aqui vêm do próprio DOM (`.tab[data-tab]` cujo `.view` correspondente tem
  // `.ds-modulo`), não de uma lista fixa neste arquivo. Cada migração nova entra sozinha no
  // teste; ele só precisa de edição se o contrato em si mudar.
  const page = await abrir({ design: 'v2' });
  const sidebar = () => page.evaluate(() => getComputedStyle(document.querySelector('.sidebar')).backgroundColor);
  const GRAFITE = 'rgb(18, 20, 23)'; // --ds-graphite-900 #121417 (neutro desde 1.53.53)

  const { migrados } = await page.evaluate(() => {
    // Sidebar "Cobli": o item só tem offsetParent quando o flyout do grupo está aberto — geometria
    // não serve mais para "esta aba existe para este usuário". Escondida-por-permissão continua
    // marcando `hidden` no próprio <button> (frontend/app.js), então é isso que se checa aqui.
    const visivel = (tab) => !tab.hidden;
    const ids = [...document.querySelectorAll('#sidebar .tab[data-tab]')].filter(visivel).map((t) => t.dataset.tab);
    const eDsModulo = (id) => !!document.getElementById(id)?.classList.contains('ds-modulo');
    return { migrados: ids.filter(eDsModulo) };
  });
  assert.ok(migrados.includes('frota'), 'a Frota precisa estar entre os módulos migrados (é onde a página abre)');

  assert.equal(await sidebar(), GRAFITE, 'na Frota a sidebar usa o grafite do shell');

  for (const id of migrados) {
    if (id === 'frota') continue; // já estamos nela — checada acima
    await irPara(page, id);
    await page.locator(`#${id}.active`).waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await sidebar(), GRAFITE, `${id} é módulo migrado — o shell continua ligado`);
    assert.equal(await page.evaluate(() => document.body.classList.contains('ds-shell')), true,
      `a classe que o app.js liga por trás do grafite acompanha ${id}, não fica presa na Frota`);
    // Nada EXCLUSIVO da Frota pode ter ficado preso no módulo seguinte. `getComputedStyle().display`
    // NÃO serve aqui: o #frotaKpis continua computando `grid`, o que o esconde é o `display:none`
    // do ancestral #frota. Quem responde "está na tela?" é a caixa renderizada.
    // ⚠️ O que se procura são os elementos de ID `#frota*`, NÃO o prefixo `v2-`: ele nasceu na
    // Frota mas hoje nomeia os componentes GENÉRICOS do Design System (`v2-kpis`, `v2-filtros-btn`,
    // `v2-kebab-*`, `v2-densidade`), que todo módulo migrado usa — e vários são injetados por
    // `injetarTogglesDensidade()`/`sincronizarKebabs()` em qualquer `.toolbar`.
    const vazouDaFrota = await page.evaluate((moduloId) => {
      const naTela = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); return el.offsetParent !== null && r.width > 0 && r.height > 0; };
      return {
        exclusivos: [...document.querySelectorAll(`#${moduloId} [id^="frota"]`)].map((el) => el.id),
        kpisNaTela: naTela(document.getElementById('frotaKpis')),
        chipsNaTela: naTela(document.getElementById('frotaChips')),
        frotaAtiva: document.getElementById('frota').classList.contains('active'),
      };
    }, id);
    assert.deepEqual(vazouDaFrota.exclusivos, [], `nenhum elemento EXCLUSIVO da Frota pode aparecer dentro de ${id}`);
    assert.equal(vazouDaFrota.frotaAtiva, false, 'a Frota deixou de ser a aba ativa');
    assert.equal(vazouDaFrota.kpisNaTela, false, 'a faixa de KPIs da Frota não pode ficar visível fora dela');
    assert.equal(vazouDaFrota.chipsNaTela, false, 'nem os chips de filtro da Frota');
  }

  await irPara(page, 'frota');
  await page.locator('#frota.active').waitFor({ state: 'visible', timeout: 8000 });
  assert.equal(await sidebar(), GRAFITE, 'voltando para a Frota o shell é reaplicado');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

/* ============================================================
   3.3.1 — Comparação de estilos computados
   (módulo migrado × módulo migrado, módulo migrado × módulo fora do Design System)
   ============================================================ */
async function estiloDe(page, seletor, props) {
  return page.evaluate(({ seletor, props }) => {
    const el = document.querySelector(seletor);
    if (!el) return null;
    const cs = getComputedStyle(el);
    return Object.fromEntries(props.map((p) => [p, cs[p]]));
  }, { seletor, props });
}
const PROPS_CAMPO = ['height', 'borderRadius', 'borderColor', 'fontSize'];
const PROPS_CABECALHO = ['fontFamily', 'fontSize', 'fontWeight', 'textTransform', 'letterSpacing', 'paddingTop', 'paddingLeft'];

test('design-v2: Instalações usa os mesmos componentes genéricos que Rastreadores (estilos computados)', async () => {
  // Instalações não ganhou CSS próprio no Design System — só a classe `.ds-modulo`. O contrato
  // é herdar EXATAMENTE o desenho que Rastreadores já usa: mesma busca, mesmo campo de
  // intervalo de data, mesmo cabeçalho de tabela. Comparação de estilos computados, não pixel.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'rastreadores');
  await page.locator('#rastreadores.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#tabelaRast thead th').first().waitFor({ state: 'visible', timeout: 8000 });
  const rast = {
    busca: await estiloDe(page, '#buscaRast', PROPS_CAMPO),
    filtroData: await estiloDe(page, '#frDevDe', PROPS_CAMPO),
    th: await estiloDe(page, '#tabelaRast thead th', PROPS_CABECALHO),
  };

  await irPara(page, 'instalacoes');
  await page.locator('#instalacoes.active').waitFor({ state: 'visible', timeout: 8000 });
  const inst = {
    busca: await estiloDe(page, '#buscaInst', PROPS_CAMPO),
    filtroData: await estiloDe(page, '#fiDe', PROPS_CAMPO),
  };
  assert.ok(rast.busca && inst.busca, 'os dois módulos precisam ter o campo de busca na tela');
  assert.deepEqual(inst.busca, rast.busca, 'a busca de Instalações usa o mesmo desenho da de Rastreadores');
  assert.ok(rast.filtroData && inst.filtroData, 'os dois módulos precisam ter o campo de data na tela');
  assert.deepEqual(inst.filtroData, rast.filtroData, 'o campo de data de Instalações usa o mesmo desenho do de Rastreadores');

  // A tabela só existe na sub-aba Envios — a sub-aba Instalações usa uma galeria de cards
  // (`.inst-galeria`), que fica de fora do Design System de propósito (ver index.html).
  await page.locator('#instSubtabs .subtab[data-sub="inst-envios"]').click();
  await page.locator('#inst-envios.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#tabelaEnvios thead th').first().waitFor({ state: 'visible', timeout: 8000 });
  const th = await estiloDe(page, '#tabelaEnvios thead th', PROPS_CABECALHO);
  assert.ok(th, 'a tabela de Envios precisa ter cabeçalho, mesmo sem nenhum envio cadastrado');
  assert.deepEqual(th, rast.th, 'o cabeçalho da tabela de Envios usa o mesmo desenho do de Rastreadores');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Manutenção usa os mesmos componentes genéricos que Rastreadores (estilos computados)', async () => {
  // Manutenção não ganhou CSS próprio no Design System — só a classe `.ds-modulo`. A sub-aba
  // Eventos (ativa por padrão) já tem busca e tabela; o resto (Dashboards/Alertas/Relatórios)
  // fica de fora de propósito (ver comentário no index.html), então não entra nesta comparação.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'rastreadores');
  await page.locator('#rastreadores.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#tabelaRast thead th').first().waitFor({ state: 'visible', timeout: 8000 });
  const rast = {
    busca: await estiloDe(page, '#buscaRast', PROPS_CAMPO),
    th: await estiloDe(page, '#tabelaRast thead th', PROPS_CABECALHO),
  };

  await irPara(page, 'manutencao');
  await page.locator('#manutencao.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#tabelaMnt thead th').first().waitFor({ state: 'visible', timeout: 8000 });
  const mnt = {
    busca: await estiloDe(page, '#buscaMnt', PROPS_CAMPO),
    th: await estiloDe(page, '#tabelaMnt thead th', PROPS_CABECALHO),
  };

  assert.ok(rast.busca && mnt.busca, 'os dois módulos precisam ter o campo de busca na tela');
  assert.deepEqual(mnt.busca, rast.busca, 'a busca de Manutenção usa o mesmo desenho da de Rastreadores');
  assert.ok(rast.th && mnt.th, 'os dois módulos precisam ter cabeçalho de tabela na tela');
  assert.deepEqual(mnt.th, rast.th, 'o cabeçalho da tabela de Manutenção (Eventos) usa o mesmo desenho do de Rastreadores');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Fornecedores usa os mesmos componentes genéricos que Rastreadores, incluindo o novo filtro por chip (estilos computados)', async () => {
  // Fornecedores ganhou UM componente novo no Design System: o chip de filtro (`.forn-chip`) —
  // não existe equivalente em `.toolbar` (lá o filtro é multisseleção em dropdown). Já a busca e
  // os botões de `.forn-topo` são a MESMA regra de `.toolbar`/`.busca` (ver 05-components.css,
  // seção 3) — por isso saem comparados contra Rastreadores como qualquer outro módulo migrado.
  const r1 = await fetch(`${BASE}/api/fornecedores`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Oficina Teste DV2', tipo: 'Oficina' }),
  });
  const r2 = await fetch(`${BASE}/api/fornecedores`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Distribuidora Teste DV2', tipo: 'Distribuidora' }),
  });
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);

  const page = await abrir({ design: 'v2' });

  await irPara(page, 'rastreadores');
  await page.locator('#rastreadores.active').waitFor({ state: 'visible', timeout: 8000 });
  const rastBusca = await estiloDe(page, '#buscaRast', PROPS_CAMPO);

  await irPara(page, 'fornecedores');
  await page.locator('#fornecedores.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#fornFiltros .forn-chip').first().waitFor({ state: 'visible', timeout: 8000 });
  const fornBusca = await estiloDe(page, '#fornBusca', PROPS_CAMPO);

  assert.ok(rastBusca && fornBusca, 'os dois módulos precisam ter o campo de busca na tela');
  assert.deepEqual(fornBusca, rastBusca, 'a busca de Fornecedores usa o mesmo desenho da de Rastreadores (mesma regra de .toolbar/.busca)');

  // O chip "Todos" começa ligado (fornEstado.tipo === 'all' por padrão) — dá para comparar
  // ligado × desligado sem precisar clicar em nada.
  const chips = await page.evaluate(() => {
    const cs = (el) => { const c = getComputedStyle(el); return { background: c.backgroundColor, color: c.color, borderColor: c.borderColor }; };
    const on = document.querySelector('#fornFiltros .forn-chip.on');
    const off = document.querySelector('#fornFiltros .forn-chip:not(.on)');
    return { on: on && cs(on), off: off && cs(off) };
  });
  assert.ok(chips.on, 'o chip "Todos" deveria começar ligado (.on)');
  assert.ok(chips.off, 'precisa haver pelo menos um tipo de fornecedor para comparar o chip desligado (semeados 2 tipos diferentes)');
  assert.notDeepEqual(chips.on, chips.off, 'o chip ligado (.on) precisa ter aparência diferente do desligado');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Programas valida o chip de filtro FORA do módulo onde nasceu — mesmo desenho que Fornecedores (estilos computados)', async () => {
  // Programas usa um nome de classe DIFERENTE (`.func-topo`/`.func-busca`/`.func-filtros`/
  // `.func-chip`/`.func-contagem`) para o MESMO componente que Fornecedores usa com o prefixo
  // `forn-`. Se o Design System tratasse os dois como coisas diferentes (CSS duplicado em vez de
  // estendido), esta comparação pegaria: os estilos computados têm de sair IGUAIS.
  const r1 = await fetch(`${BASE}/api/programas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ tipo: 'PCMSO' }),
  });
  const r2 = await fetch(`${BASE}/api/programas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ tipo: 'PGR' }),
  });
  assert.equal(r1.status, 201); assert.equal(r2.status, 201);

  const page = await abrir({ design: 'v2' });

  await irPara(page, 'fornecedores');
  await page.locator('#fornecedores.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#fornFiltros .forn-chip').first().waitFor({ state: 'visible', timeout: 8000 });
  const forn = {
    busca: await estiloDe(page, '#fornBusca', PROPS_CAMPO),
    chipOn: await estiloDe(page, '#fornFiltros .forn-chip.on', PROPS_CAMPO),
    contagem: await estiloDe(page, '#fornContagem', ['fontSize', 'color']),
  };

  await irPara(page, 'programas');
  await page.locator('#programas.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#progFiltros .func-chip').first().waitFor({ state: 'visible', timeout: 8000 });
  const prog = {
    busca: await estiloDe(page, '#progBusca', PROPS_CAMPO),
    chipOn: await estiloDe(page, '#progFiltros .func-chip.on', PROPS_CAMPO),
    contagem: await estiloDe(page, '#progContagem', ['fontSize', 'color']),
  };

  assert.ok(forn.busca && prog.busca, 'os dois módulos precisam ter o campo de busca na tela');
  assert.deepEqual(prog.busca, forn.busca, 'a busca de Programas (.func-busca) usa o mesmo desenho da de Fornecedores (.forn-busca)');
  assert.ok(forn.chipOn && prog.chipOn, 'os dois módulos precisam ter um chip ligado (.on) na tela');
  assert.deepEqual(prog.chipOn, forn.chipOn, 'o chip ligado de Programas (.func-chip) usa o mesmo desenho do de Fornecedores (.forn-chip)');
  assert.ok(forn.contagem && prog.contagem, 'os dois módulos precisam ter a linha de contagem na tela');
  assert.deepEqual(prog.contagem, forn.contagem, 'a contagem de Programas (.func-contagem) usa o mesmo desenho da de Fornecedores (.forn-contagem)');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Integração usa o filtro por chip sem nenhum CSS novo — mesmo desenho que Programas (terceiro consumidor)', async () => {
  // Integração é o TERCEIRO consumidor do filtro por chip (depois de Fornecedores e Programas) —
  // os chips do Catálogo (`.forn-chip`) são fixos ("Todos"/"NR"/"Cursos"), nem precisam de dado
  // semeado. Zero CSS novo esperado: a comparação tem de dar igual à de um consumidor anterior.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'programas');
  await page.locator('#programas.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#progFiltros .func-chip').first().waitFor({ state: 'visible', timeout: 8000 });
  const prog = {
    busca: await estiloDe(page, '#progBusca', PROPS_CAMPO),
    chipOn: await estiloDe(page, '#progFiltros .func-chip.on', PROPS_CAMPO),
  };

  await irPara(page, 'integracao');
  await page.locator('#integracao.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#intgFiltros .forn-chip').first().waitFor({ state: 'visible', timeout: 8000 });
  const intg = {
    busca: await estiloDe(page, '#intgBusca', PROPS_CAMPO),
    chipOn: await estiloDe(page, '#intgFiltros .forn-chip.on', PROPS_CAMPO),
  };

  assert.ok(prog.busca && intg.busca, 'os dois módulos precisam ter o campo de busca na tela');
  assert.deepEqual(intg.busca, prog.busca, 'a busca de Integração usa o mesmo desenho da de Programas');
  assert.ok(prog.chipOn && intg.chipOn, 'os dois módulos precisam ter um chip ligado (.on) na tela');
  assert.deepEqual(intg.chipOn, prog.chipOn, 'o chip ligado de Integração usa o mesmo desenho do de Programas');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Integração valida o alternador de visão (.func-vis) — componente novo, ligado × desligado', async () => {
  // `.func-vis`/`.func-vis-btn` é componente novo desta rodada (seção 12 de 05-components.css):
  // segmentado, ativo preenchido com a cor da marca. Os dois botões existem sempre no DOM (só o
  // PAINEL abaixo deles é que troca), então dá para comparar ligado × desligado sem clicar.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'integracao');
  await page.locator('#integracao.active').waitFor({ state: 'visible', timeout: 8000 });

  const vis = await page.evaluate(() => {
    const cs = (el) => { const c = getComputedStyle(el); return { background: c.backgroundColor, color: c.color, fontWeight: c.fontWeight }; };
    const grupo = getComputedStyle(document.querySelector('#intgVis'));
    const on = document.querySelector('#intgVis .func-vis-btn.on');
    const off = document.querySelector('#intgVis .func-vis-btn:not(.on)');
    return {
      grupoBorda: grupo.borderStyle + ' ' + grupo.borderWidth,
      grupoRaio: grupo.borderRadius,
      on: on && cs(on),
      off: off && cs(off),
    };
  });
  assert.ok(vis.on, 'o botão "Catálogo" deveria começar ligado (.on)');
  assert.ok(vis.off, 'o botão "Acompanhamento" deveria existir desligado');
  assert.notDeepEqual(vis.on, vis.off, 'o botão ligado (.on) precisa ter aparência diferente do desligado');
  assert.notEqual(vis.grupoRaio, '0px', 'o grupo segmentado precisa ter cantos arredondados (não é o CSS legado cru)');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Cartões usa a busca genérica sem CSS novo e mantém o cartão de crédito intocado (sem filtro, quarto consumidor)', async () => {
  // Cartões é o módulo mais simples migrado até agora: só busca + botão, sem `.forn-filtros`/
  // chip nenhum. Zero CSS novo esperado — a busca tem de sair igual à de Fornecedores. E o
  // cartão em si (`.cartao-cc`, paleta escura fixa nos 14 temas, referência "credit-card") tem
  // de continuar com as MESMAS cores independente do tema: é conteúdo de domínio, não deve virar
  // `.forn-card` por engano.
  const r = await fetch(`${BASE}/api/cartoes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Fulano de Tal', marca: 'Visa', ultimos4: '1234' }),
  });
  assert.equal(r.status, 201);

  const page = await abrir({ design: 'v2' });

  await irPara(page, 'fornecedores');
  await page.locator('#fornecedores.active').waitFor({ state: 'visible', timeout: 8000 });
  const fornBusca = await estiloDe(page, '#fornBusca', PROPS_CAMPO);

  await irPara(page, 'cartoes');
  await page.locator('#cartoes.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#cartoesGrid .cartao-cc').first().waitFor({ state: 'visible', timeout: 8000 });
  const cartBusca = await estiloDe(page, '#cartBusca', PROPS_CAMPO);
  const cartao = await page.evaluate(() => {
    const cs = getComputedStyle(document.querySelector('#cartoesGrid .cartao-cc'));
    return { background: cs.backgroundColor, color: cs.color };
  });

  assert.ok(fornBusca && cartBusca, 'os dois módulos precisam ter o campo de busca na tela');
  assert.deepEqual(cartBusca, fornBusca, 'a busca de Cartões usa o mesmo desenho da de Fornecedores');
  // A cor de fundo do .cartao-cc é fixa por design (mesma referência visual em qualquer tema) —
  // não é branca/clara como a superfície padrão do Design System (--ds-surface no tema claro).
  assert.notEqual(cartao.background, 'rgb(255, 255, 255)', 'o cartão de crédito não pode ter herdado a superfície branca do Design System');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Abastecimento usa os mesmos componentes que Manutenção — gêmeo estrutural sem CSS novo (estilos computados)', async () => {
  // Abastecimento é o par estrutural de Manutenção (mesmas 4 sub-abas: dado tabular, dashboards,
  // alertas). Zero CSS novo esperado. A sub-aba "Por veículo" (ativa por padrão) só tem busca —
  // compara direto; "Transações" tem a tabela completa, precisa trocar de sub-aba.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'manutencao');
  await page.locator('#manutencao.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#tabelaMnt thead th').first().waitFor({ state: 'visible', timeout: 8000 });
  const mnt = {
    busca: await estiloDe(page, '#buscaMnt', PROPS_CAMPO),
    th: await estiloDe(page, '#tabelaMnt thead th', PROPS_CABECALHO),
  };

  await irPara(page, 'abastecimento');
  await page.locator('#abastecimento.active').waitFor({ state: 'visible', timeout: 8000 });
  const abtVeic = await estiloDe(page, '#buscaAbtVeic', PROPS_CAMPO);

  await page.locator('#abastecimentoSubtabs .subtab[data-sub="abt-transacoes"]').click();
  await page.locator('#abt-transacoes.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#tabelaAbt thead th').first().waitFor({ state: 'visible', timeout: 8000 });
  const abt = {
    busca: await estiloDe(page, '#buscaAbt', PROPS_CAMPO),
    th: await estiloDe(page, '#tabelaAbt thead th', PROPS_CABECALHO),
  };

  assert.ok(mnt.busca && abtVeic, 'os dois módulos precisam ter busca na sub-aba padrão');
  assert.deepEqual(abtVeic, mnt.busca, 'a busca de "Por veículo" (Abastecimento) usa o mesmo desenho da de Manutenção');
  assert.ok(mnt.busca && abt.busca, 'os dois módulos precisam ter busca na sub-aba de dado tabular');
  assert.deepEqual(abt.busca, mnt.busca, 'a busca de "Transações" (Abastecimento) usa o mesmo desenho da de Manutenção');
  assert.ok(mnt.th && abt.th, 'os dois módulos precisam ter cabeçalho de tabela na sub-aba de dado tabular');
  assert.deepEqual(abt.th, mnt.th, 'o cabeçalho da tabela de Transações usa o mesmo desenho do de Manutenção (sem a armadilha de especificidade que Manutenção teve)');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Senhas usa a busca e a contagem de .empresa-toolbar sem CSS novo — mesmo desenho que Rastreadores', async () => {
  // Senhas é o primeiro consumidor migrado da família `.empresa-*`. A busca e a contagem usam a
  // MESMA regra que `.toolbar`/`.forn-topo`/`.func-topo` já usam (estendida, não duplicada) —
  // por isso a comparação é contra um módulo de tabela comum, não só contra outro `.empresa-*`.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'rastreadores');
  await page.locator('#rastreadores.active').waitFor({ state: 'visible', timeout: 8000 });
  const rast = { busca: await estiloDe(page, '#buscaRast', PROPS_CAMPO) };

  await irPara(page, 'senhas');
  await page.locator('#senhas.active').waitFor({ state: 'visible', timeout: 8000 });
  const senhas = {
    busca: await estiloDe(page, '#senhaBusca', PROPS_CAMPO),
    contagem: await estiloDe(page, '#senhaContagem', ['fontSize', 'color']),
  };

  assert.ok(rast.busca && senhas.busca, 'os dois módulos precisam ter busca na tela');
  assert.deepEqual(senhas.busca, rast.busca, 'a busca de Senhas (.empresa-toolbar) usa o mesmo desenho da de Rastreadores');
  assert.ok(senhas.contagem, 'Senhas precisa ter a linha de contagem na tela');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: .empresa-vazio continua igual entre Senhas e Documentos, agora os dois migrados (ponte de tokens, sem CSS novo em nenhum)', async () => {
  // `.empresa-vazio` foi AVALIADO e REJEITADO como componente novo em Senhas: o CSS legado já usa
  // só variáveis (--line/--muted/--radius/--ink) que a ponte com o legado remapeia dentro de
  // .ds-modulo. Documentos migrou depois e é o SEGUNDO consumidor real — nenhuma linha de CSS
  // nova foi precisa aqui também. Por isso a comparação agora é IGUAL × IGUAL (não mais
  // migrado × não migrado, como quando só Senhas tinha migrado): os dois têm de sair idênticos.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'senhas');
  await page.locator('#senhas.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#senhaVazio:not([hidden])').waitFor({ state: 'visible', timeout: 8000 });
  const senhaVazio = await estiloDe(page, '#senhaVazio', ['borderColor', 'borderRadius', 'color']);

  await irPara(page, 'documentos');
  await page.locator('#documentos.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#documentoVazio:not([hidden])').waitFor({ state: 'visible', timeout: 8000 });
  const documentoVazio = await estiloDe(page, '#documentoVazio', ['borderColor', 'borderRadius', 'color']);

  assert.ok(senhaVazio && documentoVazio, 'os dois módulos precisam mostrar o vazio confirmado (base de teste sem dados)');
  assert.deepEqual(documentoVazio, senhaVazio,
    'o .empresa-vazio de Documentos precisa sair igual ao de Senhas — os dois herdam a mesma ponte de tokens, sem CSS próprio');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Documentos usa a busca/contagem genéricas e alinha o .ord-select à busca — mesmo desenho que Senhas', async () => {
  // Documentos é o segundo consumidor migrado de `.empresa-toolbar`/`.empresa-contagem`. O
  // `.ord-select` (filtro de categoria) ganhou 4 linhas de CSS (seção 3.1.1) só para acompanhar
  // a altura/raio da busca ao lado — antes da migração ficava mais baixo e mais arredondado.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'senhas');
  await page.locator('#senhas.active').waitFor({ state: 'visible', timeout: 8000 });
  const senhas = {
    busca: await estiloDe(page, '#senhaBusca', PROPS_CAMPO),
    contagem: await estiloDe(page, '#senhaContagem', ['fontSize', 'color']),
  };

  await irPara(page, 'documentos');
  await page.locator('#documentos.active').waitFor({ state: 'visible', timeout: 8000 });
  const doc = {
    busca: await estiloDe(page, '#documentoBusca', PROPS_CAMPO),
    contagem: await estiloDe(page, '#documentoContagem', ['fontSize', 'color']),
    ordSelect: await estiloDe(page, '#documentoCategoria', ['height', 'borderRadius']),
  };

  assert.ok(senhas.busca && doc.busca, 'os dois módulos precisam ter busca na tela');
  assert.deepEqual(doc.busca, senhas.busca, 'a busca de Documentos usa o mesmo desenho da de Senhas');
  assert.ok(senhas.contagem && doc.contagem, 'os dois módulos precisam ter a linha de contagem na tela');
  assert.deepEqual(doc.contagem, senhas.contagem, 'a contagem de Documentos usa o mesmo desenho da de Senhas');
  assert.ok(doc.ordSelect, 'o select de categoria precisa estar na tela');
  assert.deepEqual(doc.ordSelect, { height: doc.busca.height, borderRadius: doc.busca.borderRadius },
    'o .ord-select precisa ter a mesma altura e o mesmo raio da busca ao lado, na mesma fileira');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: a caixa de navegação por pastas (.documento-pasta-head) já sai correta pela ponte de tokens — igual entre Documentos e Multas/Termos', async () => {
  // `.documento-pasta-head` (a caixa do breadcrumb, o ícone e os textos) usa só variáveis que a
  // ponte com o legado já remapeia (--line/--radius/--panel/--shadow/--r-control/--brand/
  // --muted) — nenhuma linha de CSS nova foi escrita. Mesma estrutura, já migrada, na sub-aba
  // Termos de Multas: os dois têm de sair idênticos.
  const pastaDoc = await fetch(`${BASE}/api/documentos/pastas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Pasta Teste DV2', pastaPaiId: '' }),
  });
  assert.equal(pastaDoc.status, 201);
  const pastaTermo = await fetch(`${BASE}/api/termos-multas/pastas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Pasta Teste DV2', pastaPaiId: '' }),
  });
  assert.equal(pastaTermo.status, 201);

  const page = await abrir({ design: 'v2' });

  await irPara(page, 'multas');
  await page.locator('#multas.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#multasSubtabs .subtab[data-sub="multas-termos"]').click();
  await page.locator('#multas-termos.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#termosMultaPastas [data-abrir-pasta]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#termosMultaPastas [data-abrir-pasta]').first().click();
  await page.locator('#termosMultaPastaHead:not([hidden])').waitFor({ state: 'visible', timeout: 8000 });
  const termos = {
    caixa: await estiloDe(page, '#termosMultaPastaHead', ['borderColor', 'borderRadius', 'backgroundColor', 'boxShadow']),
    icone: await estiloDe(page, '#termosMultaPastaHead .documento-pasta-icone', ['color', 'backgroundColor', 'borderRadius']),
  };

  await irPara(page, 'documentos');
  await page.locator('#documentos.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#documentoPastas [data-abrir-pasta]').first().waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#documentoPastas [data-abrir-pasta]').first().click();
  await page.locator('#documentoPastaHead:not([hidden])').waitFor({ state: 'visible', timeout: 8000 });
  const doc = {
    caixa: await estiloDe(page, '#documentoPastaHead', ['borderColor', 'borderRadius', 'backgroundColor', 'boxShadow']),
    icone: await estiloDe(page, '#documentoPastaHead .documento-pasta-icone', ['color', 'backgroundColor', 'borderRadius']),
  };

  assert.ok(termos.caixa && doc.caixa, 'os dois módulos precisam mostrar o breadcrumb da pasta aberta');
  assert.deepEqual(doc.caixa, termos.caixa, 'a caixa do breadcrumb de Documentos sai igual à de Multas/Termos, sem CSS próprio');
  assert.ok(termos.icone && doc.icone, 'os dois módulos precisam ter o ícone da pasta na tela');
  assert.deepEqual(doc.icone, termos.icone, 'o ícone do breadcrumb de Documentos sai igual ao de Multas/Termos, sem CSS próprio');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: o cartão de pasta de Documentos é superfície chapada, sem gradiente', async () => {
  // ⚠️ Este teste era o NEGATIVO oposto: até a auditoria visual de ago/2026 ele exigia que
  // `.documento-empresa-card` CONTINUASSE com o fundo em gradiente ("identidade visual
  // própria", mesmo critério aplicado então a `.empresa-hero`). A auditoria reverteu a
  // decisão: identidade visual própria por tela é justamente o que faz o sistema parecer
  // vários produtos, e o degradê não vinha de token nenhum. A regra nova mora em
  // design-system/09-superficies.css, seção 6. `.cartao-cc` (cartão FÍSICO, com proporção de
  // plástico) continua sendo a exceção legítima e tem teste próprio.
  // Semeia a própria pasta (não depende de outro teste já ter rodado).
  const r = await fetch(`${BASE}/api/documentos/pastas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Pasta Negativo DV2', pastaPaiId: '' }),
  });
  assert.equal(r.status, 201);

  const page = await abrir({ design: 'v2' });
  await irPara(page, 'documentos');
  await page.locator('#documentos.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#documentoPastas .documento-empresa-card').first().waitFor({ state: 'visible', timeout: 8000 });

  const cartao = await page.evaluate(() => {
    const s = getComputedStyle(document.querySelector('#documentoPastas .documento-empresa-card'));
    return { backgroundImage: s.backgroundImage, borderRadius: s.borderRadius, boxShadow: s.boxShadow };
  });
  assert.ok(!cartao.backgroundImage.includes('gradient'), '.documento-empresa-card precisa ser superfície chapada (o degradê saiu na consolidação visual)');
  assert.equal(cartao.borderRadius, '8px', '.documento-empresa-card usa o raio de painel do Design System');
  assert.equal(cartao.boxShadow, 'none', 'superfície estática não tem sombra no Design System');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Feedback usa a toolbar de tabela genérica sem CSS novo — mesmo desenho que Rastreadores', async () => {
  // Feedback segue o padrão de tabela comum (toolbar + busca + filtros em .msel), o mesmo de
  // Multas/Rastreadores/Manutenção/Abastecimento — zero CSS novo esperado.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'rastreadores');
  await page.locator('#rastreadores.active').waitFor({ state: 'visible', timeout: 8000 });
  const rastBusca = await estiloDe(page, '#buscaRast', PROPS_CAMPO);

  await irPara(page, 'feedback');
  await page.locator('#feedback.active').waitFor({ state: 'visible', timeout: 8000 });
  const fbBusca = await estiloDe(page, '#buscaFeedback', PROPS_CAMPO);

  assert.ok(rastBusca && fbBusca, 'os dois módulos precisam ter o campo de busca na tela');
  assert.deepEqual(fbBusca, rastBusca, 'a busca de Feedback usa o mesmo desenho da de Rastreadores');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: .ord-select sai igual em Feedback (dentro de .toolbar) e Documentos (dentro de .empresa-toolbar) — segundo consumidor real', async () => {
  // A regra de `.ord-select` foi ESTENDIDA (seção 3.1.1), não duplicada, para cobrir os dois
  // contêineres. Esta comparação prova que a extensão funciona: o mesmo controle, em duas barras
  // de propósito diferente (tabela × cards), tem de sair com a MESMA altura e o MESMO raio.
  const page = await abrir({ design: 'v2' });

  await irPara(page, 'documentos');
  await page.locator('#documentos.active').waitFor({ state: 'visible', timeout: 8000 });
  const doc = await estiloDe(page, '#documentoCategoria', ['height', 'borderRadius', 'fontSize']);

  await irPara(page, 'feedback');
  await page.locator('#feedback.active').waitFor({ state: 'visible', timeout: 8000 });
  const fb = await estiloDe(page, '#ordFeedback', ['height', 'borderRadius', 'fontSize']);

  assert.ok(doc && fb, 'os dois módulos precisam ter o .ord-select na tela');
  assert.deepEqual(fb, doc, 'o .ord-select de Feedback (.toolbar) usa o mesmo desenho do de Documentos (.empresa-toolbar)');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: Senhas entrega .empresa-hero e o selo da credencial chapados, sem gradiente nem sombra colorida', async () => {
  // ⚠️ Assim como o teste de Documentos acima, este era o NEGATIVO oposto: exigia que
  // `.empresa-hero` e `.empresa-icone` mantivessem degradê e sombra colorida por "identidade
  // visual própria". A auditoria visual de ago/2026 reverteu — e aqui havia um efeito
  // colateral concreto além do estético: era por causa do degradê do hero que a busca logo
  // abaixo precisou ficar SEM caixa (duas molduras empilhadas pesavam a tela; ver a nota de
  // `.empresa-toolbar .busca` em design-system/05-components.css, 3.1). Regra nova em
  // design-system/09-superficies.css, seção 6.
  const r = await fetch(`${BASE}/api/senhas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ servico: 'Sistema Teste DV2', senha: 'x', usuario: 'teste' }),
  });
  assert.equal(r.status, 201);

  const page = await abrir({ design: 'v2' });
  await irPara(page, 'senhas');
  await page.locator('#senhas.active').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#senhaCards .empresa-card').first().waitFor({ state: 'visible', timeout: 8000 });

  const estado = await page.evaluate(() => {
    const hero = getComputedStyle(document.querySelector('.empresa-hero'));
    const icone = getComputedStyle(document.querySelector('#senhaCards .empresa-icone'));
    return {
      heroBackgroundImage: hero.backgroundImage,
      heroSombra: hero.boxShadow,
      iconeBackgroundImage: icone.backgroundImage,
      iconeSombra: icone.boxShadow,
      iconeRaio: icone.borderRadius,
    };
  });
  assert.ok(!estado.heroBackgroundImage.includes('gradient'), '.empresa-hero precisa ser superfície chapada (o degradê saiu na consolidação visual)');
  assert.equal(estado.heroSombra, 'none', 'superfície estática não tem sombra no Design System');
  assert.ok(!estado.iconeBackgroundImage.includes('gradient'), '.empresa-icone precisa ser bloco sólido da primária, sem degradê');
  assert.equal(estado.iconeSombra, 'none', '.empresa-icone não pode manter a sombra colorida (halo da marca)');
  assert.equal(estado.iconeRaio, '4px', '.empresa-icone usa o raio de controle do Design System');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

/* ============================================================
   3.4 — alto contraste é independente do Design System (consolidação visual, ago/2026)
   Antes o alto contraste desligava o piloto (a paleta dele apagaria o reforço de
   contraste). Correção de arquitetura: acessibilidade não é tema — agora liga por
   cima de claro OU escuro, sem desligar nada, através de `alternarAltoContraste()`
   (não é mais uma opção dentro de `aplicarTema()`).
   ============================================================ */
test('design-v2: alto contraste liga por cima do Design System, sem desligar nenhum dos dois', async () => {
  const page = await abrir({ design: null });
  assert.equal(await page.evaluate(() => document.body.classList.contains('design-v2')), true,
    'Design System já começa ligado (é o padrão)');

  // Liga o alto contraste em cima do claro (padrão do boot).
  const claroContraste = await page.evaluate(() => {
    alternarAltoContraste(true);
    return {
      piloto: document.body.classList.contains('design-v2'),
      contraste: document.body.classList.contains('alto-contraste'),
      contrasteEscuro: document.body.classList.contains('alto-contraste-escuro'),
      salvo: localStorage.getItem('alto-contraste'),
    };
  });
  assert.equal(claroContraste.contraste, true, 'alto-contraste (variante clara) deve estar aplicado');
  assert.equal(claroContraste.contrasteEscuro, false, 'a variante escura não deve estar aplicada junto');
  assert.equal(claroContraste.piloto, true, 'o Design System continua ligado — os dois convivem agora');
  assert.equal(claroContraste.salvo, '1', 'a preferência de alto contraste persiste separada da do Design System');

  // Troca para escuro com o contraste ainda ligado: reavalia sozinho para a variante escura.
  const trocouEscuro = await page.evaluate(() => {
    aplicarTema('escuro');
    return {
      piloto: document.body.classList.contains('design-v2'),
      contraste: document.body.classList.contains('alto-contraste'),
      contrasteEscuro: document.body.classList.contains('alto-contraste-escuro'),
    };
  });
  assert.equal(trocouEscuro.contrasteEscuro, true, 'ao trocar para escuro com o contraste ligado, a variante escura assume sozinha');
  assert.equal(trocouEscuro.contraste, false, 'a variante clara sai junto — só uma das duas por vez');
  assert.equal(trocouEscuro.piloto, true, 'o Design System não é afetado pela troca claro/escuro nem pelo contraste');

  // Desliga o alto contraste: o Design System nunca saiu do ar.
  const desligou = await page.evaluate(() => {
    alternarAltoContraste(false);
    return {
      piloto: document.body.classList.contains('design-v2'),
      contraste: document.body.classList.contains('alto-contraste'),
      contrasteEscuro: document.body.classList.contains('alto-contraste-escuro'),
      kpis: getComputedStyle(document.getElementById('frotaKpis')).display,
    };
  });
  assert.equal(desligou.contraste, false, 'nenhuma variante de contraste deve sobrar');
  assert.equal(desligou.contrasteEscuro, false, 'nenhuma variante de contraste deve sobrar');
  assert.equal(desligou.piloto, true, 'o Design System permaneceu ligado o tempo todo');
  assert.notEqual(desligou.kpis, 'none', 'a faixa de KPIs nunca saiu da tela');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

/* ============================================================
   3.5 — painel de filtros: acessibilidade
   ============================================================ */
test('design-v2: o painel de filtros é um diálogo acessível, sem armadilha de foco', async () => {
  const page = await abrir({ design: 'v2' });
  await layoutEstavel(page);
  const btn = page.locator('#frotaFiltrosBtn');
  const attrs = () => page.evaluate(() => {
    const b = document.getElementById('frotaFiltrosBtn'), p = document.getElementById('frotaFiltrosPainel');
    return {
      expanded: b.getAttribute('aria-expanded'), controls: b.getAttribute('aria-controls'),
      haspopup: b.getAttribute('aria-haspopup'), rotulo: b.getAttribute('aria-label'),
      role: p.getAttribute('role'), labelledby: p.getAttribute('aria-labelledby'),
      aberto: p.classList.contains('aberto'), exibicao: getComputedStyle(p).display,
      foco: document.activeElement ? document.activeElement.id : null,
    };
  });

  let a = await attrs();
  assert.equal(a.controls, 'frotaFiltrosPainel', 'aria-controls deve apontar para o painel');
  assert.equal(a.haspopup, 'dialog', 'o botão deve anunciar que abre um diálogo');
  assert.equal(a.role, 'dialog', 'o painel deve ter role="dialog" com o piloto ligado');
  assert.equal(a.labelledby, 'frotaFiltrosTit', 'o diálogo precisa de um título ligado por aria-labelledby');
  const titulo = await page.locator('#frotaFiltrosTit').innerText();
  assert.ok(titulo.trim().length > 3, `o alvo do aria-labelledby precisa ter texto real (tem "${titulo}")`);
  assert.equal(a.expanded, 'false', 'fechado começa em aria-expanded=false');
  assert.equal(a.rotulo, 'Filtros, nenhum ativo', 'o nome acessível diz a contagem, mesmo sendo zero');

  // Abrir por TECLADO e chegar ao primeiro filtro com um Tab.
  await btn.focus();
  await page.keyboard.press('Enter');
  a = await attrs();
  assert.equal(a.aberto, true, 'Enter no botão deve abrir o painel');
  assert.equal(a.expanded, 'true', 'aria-expanded deve virar true ao abrir');
  await page.keyboard.press('Tab');
  const primeiro = await page.evaluate(() => {
    const el = document.activeElement;
    return { noPainel: !!el.closest('#frotaFiltrosPainel'), filtro: el.closest('.msel')?.id || null };
  });
  assert.equal(primeiro.noPainel, true, 'um Tab a partir do botão precisa entrar no painel');
  assert.equal(primeiro.filtro, 'fStatus', 'e cair no PRIMEIRO filtro, sem atravessar nada pelo caminho');

  // Escolher uma opção NÃO fecha o painel (o filtro vale na hora, sem "aplicar").
  await page.locator('#fStatus .msel-btn').click();
  await page.locator('#fStatus .msel-item input[value="EM ATIVIDADE"]').check();
  a = await attrs();
  assert.equal(a.aberto, true, 'marcar uma opção não pode fechar o painel');
  assert.equal(a.rotulo, 'Filtros, 1 ativo', 'o nome acessível acompanha a contagem (singular)');

  // Escape fecha e DEVOLVE o foco ao botão.
  await page.locator('#fStatus .msel-btn').focus();
  await page.keyboard.press('Escape');
  a = await attrs();
  assert.equal(a.aberto, false, 'Escape deve fechar o painel');
  assert.equal(a.expanded, 'false', 'aria-expanded volta a false ao fechar');
  assert.equal(a.foco, 'frotaFiltrosBtn', 'fechando pelo teclado o foco volta para o botão que abriu');

  // Sem focus trap: o Tab atravessa o painel e SAI. Contar teclas fixas seria frágil (o
  // "Limpar filtros" entra e sai da ordem conforme está habilitado): a condição observável é
  // "o foco deixou o painel", com um teto que denuncia a armadilha se ela existir.
  await btn.focus();
  await page.keyboard.press('Enter');
  const MAX_TAB = 12;
  let passos = 0;
  while (passos < MAX_TAB) {
    await page.keyboard.press('Tab');
    passos += 1;
    if (!(await page.evaluate(() => !!document.activeElement.closest('#frotaFiltrosPainel')))) break;
  }
  assert.ok(passos < MAX_TAB,
    `o foco tem de sair do painel pelo Tab; depois de ${MAX_TAB} teclas ainda estava preso dentro (focus trap)`);
  const saiu = await attrs();
  assert.equal(saiu.aberto, false, 'ao sair pelo Tab o painel fecha sozinho, em vez de ficar aberto órfão');
  assert.equal(saiu.expanded, 'false', 'e o aria-expanded acompanha o fechamento');

  // Clicar fora fecha sem roubar o foco para outro controle.
  await btn.click();
  assert.equal((await attrs()).aberto, true);
  await page.locator('#frotaRodape').click({ position: { x: 5, y: 5 } });
  const fora = await attrs();
  assert.equal(fora.aberto, false, 'clicar fora deve fechar o painel');
  assert.equal(await page.evaluate(() => document.activeElement === document.body), true,
    'clicar fora não pode mover o foco para outro controle');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

/* ============================================================
   3.6 — filtros, chips e limpeza
   ============================================================ */
test('design-v2: filtros viram chips removíveis com nome acessível completo', async () => {
  const page = await abrir({ design: 'v2' });
  await layoutEstavel(page);
  const total = await linhas(page);
  assert.ok(total > 0, 'a base semeada precisa render linhas');

  // Um filtro só.
  await marcar(page, [['fStatus', ['EM ATIVIDADE']]]);
  const umFiltro = await linhas(page);
  assert.ok(umFiltro > 0 && umFiltro < total, `um filtro deve recortar a lista (${umFiltro}/${total})`);
  assert.equal(await page.evaluate(() => document.getElementById('frotaFiltrosBtn').getAttribute('aria-label')),
    'Filtros, 1 ativo');

  // Três filtros combinados, aplicados na hora (sem botão de "aplicar").
  await marcar(page, [['fStatus', ['EM ATIVIDADE']], ['fGravame', ['NADA CONSTA']], ['fCentro', [CENTROS[0]]]]);
  const combinado = await linhas(page);
  assert.ok(combinado <= umFiltro, 'combinar filtros só pode estreitar o recorte');
  assert.equal(await page.evaluate(() => document.getElementById('frotaFiltrosBtn').getAttribute('aria-label')),
    'Filtros, 3 ativos', 'o nome acessível pluraliza e conta os três');
  assert.equal(await page.evaluate(() => document.getElementById('frotaFiltrosCont').textContent), '3',
    'o contador visual mostra o mesmo número');

  const chips = await page.locator('#frotaChips .v2-chip').evaluateAll((els) => els.map((c) => ({
    aria: c.getAttribute('aria-label'), texto: c.innerText.replace(/\s+/g, ' ').trim(),
    tag: c.tagName, focavel: c.tabIndex >= 0,
    xDecorativo: c.querySelector('.v2-chip-x')?.getAttribute('aria-hidden'),
  })));
  assert.equal(chips.length, 3, 'cada valor selecionado vira um chip');
  for (const c of chips) {
    assert.equal(c.tag, 'BUTTON', 'o chip precisa ser um botão de verdade');
    assert.ok(c.focavel, 'o chip precisa ser alcançável pelo teclado');
    assert.match(c.aria, /^Remover o filtro .+: .+$/,
      `o nome do chip diz a ação, o campo e o valor — não só "Remover" (veio "${c.aria}")`);
    assert.match(c.texto, /: /, 'o texto visível carrega rótulo e valor: o estado não depende de cor');
    assert.equal(c.xDecorativo, 'true', 'o × é decorativo e não pode ser lido pelo leitor de tela');
  }

  // Remover UM chip tira só aquele valor.
  await page.locator('#frotaChips .v2-chip').first().click();
  assert.equal(await page.locator('#frotaChips .v2-chip').count(), 2, 'clicar no chip remove só aquele filtro');

  // "Limpar tudo" zera e a linha inteira some.
  await page.locator('#frotaChips .v2-chip-limpar').click();
  const zerado = await page.evaluate(() => {
    const c = document.getElementById('frotaChips');
    return {
      vazio: c.innerHTML === '', exibicao: getComputedStyle(c).display,
      rotulo: document.getElementById('frotaFiltrosBtn').getAttribute('aria-label'),
      contadorEscondido: document.getElementById('frotaFiltrosCont').hidden,
      limparDesabilitado: document.getElementById('btnLimpar').disabled,
    };
  });
  assert.equal(zerado.vazio, true, '"Limpar tudo" tem de esvaziar a linha de chips');
  assert.equal(zerado.exibicao, 'none', 'sem chip nenhum a linha não pode ocupar espaço');
  assert.equal(zerado.rotulo, 'Filtros, nenhum ativo');
  assert.equal(zerado.contadorEscondido, true, 'o contador do botão some junto');
  assert.equal(zerado.limparDesabilitado, true,
    '"Limpar filtros" não pode ficar aceso sem nada para limpar');
  assert.equal(await linhas(page), total, 'a lista volta ao tamanho original');

  // A BUSCA conta como recorte: vira chip e reabilita a limpeza.
  await page.locator('#busca').fill('HILUX');
  await page.waitForFunction(() => document.getElementById('btnLimpar').disabled === false, null, { timeout: 5000 });
  const comBusca = await page.evaluate(() => ({
    chips: [...document.querySelectorAll('#frotaChips .v2-chip')].map((c) => c.getAttribute('aria-label')),
    limparDesabilitado: document.getElementById('btnLimpar').disabled,
  }));
  assert.ok(comBusca.chips.some((a) => /^Remover o filtro Busca: HILUX$/.test(a)),
    `a busca também vira chip removível (chips: ${comBusca.chips.join(' | ')})`);
  assert.equal(comBusca.limparDesabilitado, false, 'só a busca preenchida já dá o que limpar');

  // "Limpar filtros" DENTRO do painel limpa busca + filtros.
  await page.locator('#frotaFiltrosBtn').click();
  await page.locator('#btnLimpar').click();
  await page.waitForFunction((n) => document.querySelectorAll('#corpoTabela tr:not(.v2-skel)').length === n, total, { timeout: 5000 });
  assert.equal(await page.evaluate(() => document.getElementById('busca').value), '',
    '"Limpar filtros" limpa também a busca');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

/* ============================================================
   3.7 — densidade
   ============================================================ */
test('design-v2: densidade alterna 32/40px, persiste e não atrapalha a edição inline', async () => {
  const page = await abrir({ design: 'v2' });
  await layoutEstavel(page);
  const alturaLinha = () => page.evaluate(() => document.querySelector('#corpoTabela tr:not(.v2-skel) td').getBoundingClientRect().height);
  const pressionados = () => page.evaluate(() => [...document.querySelectorAll('#frota-lista [data-densidade-toggle] .v2-dens-btn')].map((b) => b.getAttribute('aria-pressed')));

  // 32/40px são o contrato do piloto (é o ganho de linhas por tela), medidos com folga
  // de 1px para o arredondamento de subpixel do navegador.
  assert.ok(Math.abs(await alturaLinha() - 32) <= 1, `compacta deve fechar em 32px (veio ${await alturaLinha()})`);
  assert.deepEqual(await pressionados(), ['true', 'false'], 'o botão ativo é anunciado por aria-pressed');

  await page.locator('#frota-lista [data-densidade-toggle] [data-densidade="confortavel"]').click();
  await layoutEstavel(page);
  assert.ok(Math.abs(await alturaLinha() - 40) <= 1, `confortável deve fechar em 40px (veio ${await alturaLinha()})`);
  assert.deepEqual(await pressionados(), ['false', 'true'], 'aria-pressed acompanha a troca');
  // O atributo/chave migraram de #frota-lista/'frota-densidade' (piloto original, só a Frota)
  // para a SECTION e um namespace por módulo — "toda aba com tabela ganha o toggle" (comentário
  // de `injetarTogglesDensidade`, frontend/app.js). A migração da chave antiga é automática só
  // quando ela EXISTE; num navegador zerado (como aqui) a chave nasce direto no formato novo.
  assert.equal(await page.evaluate(() => document.getElementById('frota').dataset.densidade), 'confortavel');
  assert.equal(await page.evaluate(() => localStorage.getItem('dens-frota')), 'confortavel',
    'a escolha de densidade fica salva no navegador');

  // Persiste ao recarregar.
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  await page.locator('#corpoTabela tr:not(.v2-skel)').first().waitFor({ state: 'visible', timeout: 10000 });
  await layoutEstavel(page);
  assert.ok(Math.abs(await alturaLinha() - 40) <= 1, 'a densidade escolhida volta depois do recarregar');

  // Edição inline continua funcionando na densidade confortável.
  const placa = await page.evaluate(() => document.querySelector('#corpoTabela tr').dataset.placa);
  await page.locator(`#corpoTabela tr[data-placa="${placa}"] .pill-select[data-campo="status"] .pill-trigger`).click();
  await page.locator('.pill-menu-portaled .pill-item.parado').first().click();
  await page.waitForFunction((p) => /PARADO/.test(document.querySelector(`#corpoTabela tr[data-placa="${p}"]`)?.innerText || ''), placa, { timeout: 8000 });

  await page.locator('#frota-lista [data-densidade-toggle] [data-densidade="compacta"]').click();
  await layoutEstavel(page);
  assert.ok(Math.abs(await alturaLinha() - 32) <= 1, 'voltar para compacta devolve os 32px');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

/* ============================================================
   3.8 — estados da tabela (carregando / vazio / erro)
   ============================================================ */
test('design-v2: carregando, vazio e erro nunca aparecem ao mesmo tempo', async () => {
  const page = await abrir({ design: 'v2' });
  await layoutEstavel(page);

  // --- CARREGANDO: com a tabela já preenchida, recarregar não pode piscar o esqueleto.
  await page.route('**/api/veiculos', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  await page.evaluate(() => { carregar(); });
  assert.equal(await page.locator('#corpoTabela .v2-skel').count(), 0,
    'recarregar com a lista na tela não pode trocá-la por linhas fantasma');
  await page.locator('#corpoTabela tr:not(.v2-skel)').first().waitFor({ state: 'visible', timeout: 10000 });

  await page.unroute('**/api/veiculos');

  // --- VAZIO: só depois de carregar, e com saída.
  await page.locator('#busca').fill('PLACAQUENAOEXISTE');
  await page.locator('#vazio:not([hidden])').waitFor({ state: 'visible', timeout: 5000 });
  const vazio = await page.evaluate(() => ({
    texto: document.getElementById('vazio').innerText.replace(/\s+/g, ' ').trim(),
    temSaida: !!document.querySelector('#vazio .empty-acao'),
    esqueleto: document.querySelectorAll('#corpoTabela .v2-skel').length,
    kpi: document.querySelector('#frotaKpis .v2-kpi-val').textContent,
  }));
  assert.match(vazio.texto, /Nenhum resultado para os filtros atuais/, 'o vazio POR FILTRO diz que é filtro');
  assert.equal(vazio.temSaida, true, 'o estado vazio precisa oferecer o caminho de volta');
  assert.equal(vazio.esqueleto, 0, 'o vazio só aparece com o carregamento concluído');
  assert.equal(vazio.kpi, '0', 'o KPI acompanha o recorte vazio');
  await page.locator('#busca').fill('');
  await page.locator('#corpoTabela tr:not(.v2-skel)').first().waitFor({ state: 'visible', timeout: 5000 });

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: a PRIMEIRA carga mostra só o esqueleto — sem vazio, sem erro e sem zeros', async () => {
  const page = await abrirCarga('lenta');
  await page.locator('#corpoTabela .v2-skel').first().waitFor({ state: 'visible', timeout: 8000 });
  const carregando = await page.evaluate(() => ({
    esqueleto: document.querySelectorAll('#corpoTabela .v2-skel').length,
    foraDoLeitor: [...document.querySelectorAll('#corpoTabela .v2-skel')].every((t) => t.getAttribute('aria-hidden') === 'true'),
    vazioVisivel: !document.getElementById('vazio').hidden,
    erroVisivel: document.getElementById('frotaErro').classList.contains('v2-on'),
    toasts: document.querySelectorAll('#toast.show').length,
    kpis: [...document.querySelectorAll('#frotaKpis .v2-kpi-val')].map((v) => v.textContent.trim()),
    rodape: document.getElementById('frotaRodape').innerText.replace(/\s+/g, ' ').trim(),
    resumo: document.getElementById('resumoLinha').innerText.replace(/\s+/g, ' ').trim(),
  }));
  assert.ok(carregando.esqueleto > 0, 'a primeira carga mostra linhas fantasma no lugar da tela em branco');
  assert.equal(carregando.foraDoLeitor, true, 'as linhas fantasma são decorativas (aria-hidden)');
  assert.equal(carregando.vazioVisivel, false, '"Nenhum veículo" não pode aparecer antes de os dados chegarem');
  assert.equal(carregando.erroVisivel, false, 'nem o erro pode conviver com o carregando');
  assert.equal(carregando.toasts, 0, 'carregar não é evento de toast');
  assert.ok(!carregando.kpis.includes('0'),
    `enquanto carrega, nenhum KPI pode exibir 0 como se fosse dado (veio ${JSON.stringify(carregando.kpis)})`);
  assert.equal(carregando.rodape, '', 'o rodapé não pode dizer "Mostrando 0 de 0" antes de haver dados');
  assert.equal(carregando.resumo, '', 'nem o resumo da tela sem o piloto');

  // e ao terminar, tudo isso volta coerente
  await page.locator('#corpoTabela tr:not(.v2-skel)').first().waitFor({ state: 'visible', timeout: 15000 });
  const pronto = await page.evaluate(() => ({
    esqueleto: document.querySelectorAll('#corpoTabela .v2-skel').length,
    vazioVisivel: !document.getElementById('vazio').hidden,
    rodape: document.getElementById('frotaRodape').innerText.replace(/\s+/g, ' ').trim(),
    kpi: document.querySelector('#frotaKpis .v2-kpi-val').textContent.trim(),
  }));
  assert.equal(pronto.esqueleto, 0, 'o esqueleto some no primeiro render');
  assert.equal(pronto.vazioVisivel, false, 'com dados não há estado vazio');
  assert.match(pronto.rodape, /Mostrando \d+ de \d+ veículos/, 'o rodapé volta com a contagem real');
  assert.match(pronto.kpi, /^\d+$/, 'e o KPI volta a mostrar número');
  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: erro inicial explica UMA vez e nunca afirma zero', async () => {
  const page = await abrirCarga('falha');
  await page.locator('#frotaErro.v2-on').waitFor({ state: 'visible', timeout: 10000 });
  const erro = await page.evaluate(() => {
    const faixa = document.getElementById('frotaErro');
    const corpo = document.getElementById('corpoTabela');
    return {
      // faixa: explicação única, com título, descrição e saída
      faixaTexto: faixa.innerText.replace(/\s+/g, ' ').trim(),
      faixaPapel: faixa.getAttribute('role'),
      temTentar: !!document.getElementById('frotaErroTentar'),
      toasts: document.querySelectorAll('#toast.show').length,
      // KPIs: nem um zero, e o leitor de tela entende que está indisponível
      kpiValores: [...document.querySelectorAll('#frotaKpis .v2-kpi-val')].map((v) => v.textContent.trim()),
      kpiRotulos: [...document.querySelectorAll('#frotaKpis .v2-kpi-rot')].map((v) => v.textContent.trim()),
      kpiLeitor: [...document.querySelectorAll('#frotaKpis .sr-only')].map((v) => v.textContent.trim()),
      kpiGrupo: document.getElementById('frotaKpis').getAttribute('aria-label'),
      kpiVermelhos: document.querySelectorAll('#frotaKpis .v2-kpi.risco, #frotaKpis .v2-kpi.aviso').length,
      // estado vazio: proibido
      vazioVisivel: !document.getElementById('vazio').hidden,
      vazioTexto: document.getElementById('vazio').innerText.replace(/\s+/g, ' ').trim(),
      // tabela: cabeçalho preservado + uma linha neutra
      colunas: document.querySelectorAll('#cabecalho th').length,
      linhasDados: corpo.querySelectorAll('tr:not(.v2-indisp)').length,
      neutra: corpo.querySelectorAll('.v2-indisp').length,
      neutraTexto: (corpo.querySelector('.v2-indisp')?.innerText || '').trim(),
      neutraPapel: corpo.querySelector('.v2-indisp')?.getAttribute('role'),
      neutraTemBotao: !!corpo.querySelector('.v2-indisp button'),
      // resumo/rodapé: nada de "0 de 0"
      rodape: document.getElementById('frotaRodape').innerText.replace(/\s+/g, ' ').trim(),
      rodapeVisivel: getComputedStyle(document.getElementById('frotaRodape')).display !== 'none',
      resumo: document.getElementById('resumoLinha').innerText.replace(/\s+/g, ' ').trim(),
      esqueleto: corpo.querySelectorAll('.v2-skel').length,
    };
  });

  assert.match(erro.faixaTexto, /Não foi possível carregar os veículos/, 'a faixa dá o título do problema');
  assert.match(erro.faixaTexto, /tente novamente/i, 'e uma descrição curta do que fazer');
  assert.equal(erro.faixaPapel, 'alert', 'a faixa é quem anuncia — uma vez');
  assert.equal(erro.temTentar, true, 'e oferece "Tentar de novo"');
  assert.equal(erro.toasts, 0, 'sem toast: seriam dois anúncios do mesmo erro');

  assert.deepEqual(erro.kpiValores, ['—', '—', '—', '—'],
    `KPI não pode dizer 0 quando não conseguiu consultar (veio ${JSON.stringify(erro.kpiValores)})`);
  assert.deepEqual(erro.kpiRotulos, ['Veículos ativos', 'FIPE somado', 'Na oficina', 'Documento vencido'],
    'os rótulos ficam: são eles que dão sentido ao traço');
  assert.ok(erro.kpiLeitor.length >= 4 && erro.kpiLeitor.every((t) => /indispon/i.test(t)),
    `o leitor de tela precisa ouvir "indisponível", não "traço" (veio ${JSON.stringify(erro.kpiLeitor)})`);
  assert.match(erro.kpiGrupo, /indispon/i, 'e o grupo de indicadores diz o mesmo uma vez');
  assert.equal(erro.kpiVermelhos, 0, 'nenhum KPI pintado de alerta: quatro alarmes para um erro só');

  assert.equal(erro.vazioVisivel, false,
    `erro de rede não é lista vazia (o estado vazio dizia "${erro.vazioTexto}")`);
  assert.ok(erro.colunas > 5, 'o cabeçalho da tabela é preservado (a área não salta)');
  assert.equal(erro.linhasDados, 0, 'não há linhas de dados para mostrar');
  assert.equal(erro.neutra, 1, 'uma única linha neutra ocupa o corpo da tabela');
  assert.match(erro.neutraTexto, /Dados indisponíveis/, 'com texto neutro');
  assert.equal(erro.neutraPapel, null, 'a linha neutra NÃO é um alerta');
  assert.equal(erro.neutraTemBotao, false, 'nem repete o "Tentar de novo" da faixa');
  assert.equal(erro.esqueleto, 0, 'o erro encerra o carregando');

  assert.equal(erro.rodape, '', 'o rodapé não pode dizer "Mostrando 0 de 0 veículos"');
  assert.equal(erro.rodapeVisivel, false, 'e some por completo, sem deixar faixa vazia');
  assert.equal(erro.resumo, '', 'o resumo da tela sem o piloto também cala');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: "Tentar de novo" volta ao carregando, não duplica requisição e recupera a tela', async () => {
  const page = await abrirCarga('falha');
  await page.locator('#frotaErro.v2-on').waitFor({ state: 'visible', timeout: 10000 });

  // conta as idas ao servidor a partir daqui
  let chamadas = 0;
  page.on('request', (req) => { if (req.url().includes('/api/veiculos') && req.method() === 'GET') chamadas += 1; });

  // a rede volta, mas devagar: dá tempo de ver o estado "tentando"
  await page.unroute('**/api/veiculos');
  await page.route('**/api/veiculos', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });

  await page.locator('#frotaErroTentar').focus();
  await page.locator('#frotaErroTentar').click();
  // dois cliques seguidos no mesmo botão não podem virar duas requisições
  await page.locator('#frotaErroTentar').click({ force: true }).catch(() => {});

  const tentando = await page.evaluate(() => ({
    esqueleto: document.querySelectorAll('#corpoTabela .v2-skel').length,
    neutra: document.querySelectorAll('#corpoTabela .v2-indisp').length,
    // `aria-disabled` em vez de `disabled`: desabilitar de verdade tiraria o foco do botão
    botaoDesabilitado: document.getElementById('frotaErroTentar')?.getAttribute('aria-disabled'),
    focoNoBotao: document.activeElement?.id === 'frotaErroTentar',
    semCaraDeErro: document.getElementById('frotaErro').classList.contains('v2-tentando'),
    vazioVisivel: !document.getElementById('vazio').hidden,
    kpis: [...document.querySelectorAll('#frotaKpis .v2-kpi-val')].map((v) => v.textContent.trim()),
    toasts: document.querySelectorAll('#toast.show').length,
  }));
  assert.ok(tentando.esqueleto > 0, 'a nova tentativa volta ao estado de carregando');
  assert.equal(tentando.neutra, 0, 'a linha "Dados indisponíveis" cede lugar ao esqueleto');
  assert.equal(tentando.botaoDesabilitado, 'true', 'o botão trava enquanto a tentativa corre');
  assert.equal(tentando.focoNoBotao, true, 'o foco do teclado não pode se perder no meio da tentativa');
  assert.equal(tentando.semCaraDeErro, true, 'a faixa deixa de acusar erro enquanto tenta');
  assert.equal(tentando.vazioVisivel, false, 'e nada de estado vazio no caminho');
  assert.ok(!tentando.kpis.includes('0'), 'nem zeros');
  assert.equal(tentando.toasts, 0, 'nem toast');

  await page.locator('#corpoTabela tr:not(.v2-skel)').first().waitFor({ state: 'visible', timeout: 15000 });
  assert.equal(chamadas, 1, `o mesmo botão não pode disparar duas requisições (disparou ${chamadas})`);

  const recuperado = await page.evaluate(() => ({
    faixaVisivel: getComputedStyle(document.getElementById('frotaErro')).display !== 'none',
    kpi: document.querySelector('#frotaKpis .v2-kpi-val').textContent.trim(),
    rodape: document.getElementById('frotaRodape').innerText.replace(/\s+/g, ' ').trim(),
    neutra: document.querySelectorAll('#corpoTabela .v2-indisp').length,
  }));
  assert.equal(recuperado.faixaVisivel, false, 'com sucesso, todo o estado de erro sai da tela');
  assert.match(recuperado.kpi, /^\d+$/, 'os KPIs voltam a ser números');
  assert.match(recuperado.rodape, /Mostrando \d+ de \d+ veículos/, 'e o rodapé volta a contar');
  assert.equal(recuperado.neutra, 0, 'sem sobra da linha neutra');
  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: resposta vazia bem-sucedida é VAZIO confirmado, não erro', async () => {
  // Lista vazia com HTTP 200 é resposta VÁLIDA: aqui o zero é dado, e o estado vazio é verdade.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.route('**/api/veiculos', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    : route.continue());
  await page.goto(`${PAINEL}/frota?design=v2`, { waitUntil: 'load' });
  await page.locator('#vazio:not([hidden])').waitFor({ state: 'visible', timeout: 10000 });

  const vazio = await page.evaluate(() => ({
    texto: document.getElementById('vazio').innerText.replace(/\s+/g, ' ').trim(),
    kpis: [...document.querySelectorAll('#frotaKpis .v2-kpi-val')].map((v) => v.textContent.trim()),
    faixaErro: document.getElementById('frotaErro').classList.contains('v2-on'),
    neutra: document.querySelectorAll('#corpoTabela .v2-indisp').length,
    esqueleto: document.querySelectorAll('#corpoTabela .v2-skel').length,
    toasts: document.querySelectorAll('#toast.show').length,
    rodape: document.getElementById('frotaRodape').innerText.replace(/\s+/g, ' ').trim(),
    faixaOficina: document.getElementById('frotaOficinaAlertas').hidden,
  }));
  assert.match(vazio.texto, /Nenhum veículo cadastrado ainda/, 'sem filtro, o vazio é "nada cadastrado"');
  assert.equal(vazio.kpis[0], '0', 'aqui o zero é LEGÍTIMO: os dados confirmaram que não há veículos');
  assert.equal(vazio.kpis[2], '0', 'idem para "Na oficina"');
  assert.equal(vazio.faixaErro, false, 'lista vazia não é erro');
  assert.equal(vazio.neutra, 0, 'nem "Dados indisponíveis"');
  assert.equal(vazio.esqueleto, 0, 'nem esqueleto');
  assert.equal(vazio.toasts, 0, 'nem toast');
  assert.match(vazio.rodape, /Mostrando 0 de 0 veículos/,
    'com zero CONFIRMADO o rodapé pode e deve contar — o que era proibido é afirmar isso sem dados');
  assert.equal(vazio.faixaOficina, true, 'sem veículos não há faixa de oficina');
  assert.equal(erros.length, 0, 'erros de JS:\n' + erros.join('\n'));
  await page.close();
});

test('design-v2: vazio confirmado + falha depois NÃO regride para erro inicial', async () => {
  // O caso de borda: a 1ª resposta foi 200 com lista vazia (válida). Uma falha posterior não
  // pode fingir que a tela nunca conseguiu consultar nada.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/net::ERR_FAILED|Failed to load resource/i.test(m.text())) erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.route('**/api/veiculos', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
    : route.continue());
  await page.goto(`${PAINEL}/frota?design=v2`, { waitUntil: 'load' });
  await page.locator('#vazio:not([hidden])').waitFor({ state: 'visible', timeout: 10000 });

  await page.unroute('**/api/veiculos');
  await page.route('**/api/veiculos', (route) => route.request().method() === 'GET' ? route.abort('failed') : route.continue());
  await limparToast(page);
  await page.evaluate(() => { carregar(); });
  await page.locator('#toast.show').waitFor({ state: 'visible', timeout: 8000 });

  const depois = await page.evaluate(() => ({
    vazioVisivel: !document.getElementById('vazio').hidden,
    faixaErro: document.getElementById('frotaErro').classList.contains('v2-on'),
    neutra: document.querySelectorAll('#corpoTabela .v2-indisp').length,
    kpis: [...document.querySelectorAll('#frotaKpis .v2-kpi-val')].map((v) => v.textContent.trim()),
    toastTexto: (document.querySelector('#toast.show')?.innerText || '').replace(/\s+/g, ' ').trim(),
  }));
  assert.equal(depois.vazioVisivel, true, 'o vazio confirmado continua valendo: era um estado VÁLIDO');
  assert.equal(depois.faixaErro, false, 'a falha posterior não pode virar "erro inicial"');
  assert.equal(depois.neutra, 0, 'nem trocar o vazio por "Dados indisponíveis"');
  assert.ok(!depois.kpis.includes('—'), `os KPIs seguem em 0, que é o último valor válido (veio ${JSON.stringify(depois.kpis)})`);
  assert.match(depois.toastTexto, /não foi possível atualizar/i, 'e o aviso é de ATUALIZAÇÃO');
  assert.equal(erros.length, 0, 'erros de JS:\n' + erros.join('\n'));
  await page.unroute('**/api/veiculos');
  await page.close();
});

test('design-v2: falha de SERVIDOR não é lista vazia', async () => {
  // 500 não é "não há veículos". Só o 403 (sem acesso ao módulo) é resposta válida vazia.
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/api/veiculos', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 500, contentType: 'application/json', body: '{"erro":"boom"}' })
    : route.continue());
  await page.goto(`${PAINEL}/frota?design=v2`, { waitUntil: 'load' });
  await page.locator('#frotaErro.v2-on').waitFor({ state: 'visible', timeout: 10000 });
  const r = await page.evaluate(() => ({
    vazioVisivel: !document.getElementById('vazio').hidden,
    kpis: [...document.querySelectorAll('#frotaKpis .v2-kpi-val')].map((v) => v.textContent.trim()),
    neutra: document.querySelectorAll('#corpoTabela .v2-indisp').length,
  }));
  assert.equal(r.vazioVisivel, false, 'HTTP 500 não pode virar "Nenhum veículo cadastrado ainda"');
  assert.deepEqual(r.kpis, ['—', '—', '—', '—'], 'nem zerar os indicadores');
  assert.equal(r.neutra, 1, 'é estado de indisponibilidade');
  await page.close();
});

test('design-v2: 403 (sem acesso ao módulo) continua sendo lista vazia, não erro', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route('**/api/veiculos', (route) => route.request().method() === 'GET'
    ? route.fulfill({ status: 403, contentType: 'application/json', body: '{"erro":"sem acesso"}' })
    : route.continue());
  await page.goto(`${PAINEL}/frota?design=v2`, { waitUntil: 'load' });
  await page.locator('#vazio:not([hidden])').waitFor({ state: 'visible', timeout: 10000 });
  const r = await page.evaluate(() => ({
    faixaErro: document.getElementById('frotaErro').classList.contains('v2-on'),
    kpis: [...document.querySelectorAll('#frotaKpis .v2-kpi-val')].map((v) => v.textContent.trim()),
  }));
  assert.equal(r.faixaErro, false, '403 é resposta: "não há nada para você ver aqui"');
  assert.equal(r.kpis[0], '0', 'e o zero é confirmado');
  await page.close();
});

test('design-v2: falha DEPOIS de carregado preserva os dados e não vira erro inicial', async () => {
  const page = await abrir({ design: 'v2' });
  await layoutEstavel(page);
  const antes = await linhas(page);
  assert.ok(antes > 0);

  await page.route('**/api/veiculos', (route) => route.request().method() === 'GET' ? route.abort('failed') : route.continue());
  await limparToast(page);
  await page.evaluate(() => { carregar(); });
  await page.locator('#toast.show').waitFor({ state: 'visible', timeout: 8000 });

  const depois = await page.evaluate(() => ({
    linhas: document.querySelectorAll('#corpoTabela tr:not(.v2-skel):not(.v2-indisp)').length,
    faixaVisivel: document.getElementById('frotaErro').classList.contains('v2-on'),
    neutra: document.querySelectorAll('#corpoTabela .v2-indisp').length,
    kpi: document.querySelector('#frotaKpis .v2-kpi-val').textContent.trim(),
    vazioVisivel: !document.getElementById('vazio').hidden,
    rodape: document.getElementById('frotaRodape').innerText.replace(/\s+/g, ' ').trim(),
    toastTexto: (document.querySelector('#toast.show')?.innerText || '').replace(/\s+/g, ' ').trim(),
  }));
  assert.equal(depois.linhas, antes, 'os últimos dados válidos continuam na tela');
  assert.equal(depois.faixaVisivel, false, 'uma atualização que falha não converte a tela em erro inicial');
  assert.equal(depois.neutra, 0, 'nem troca os dados por "Dados indisponíveis"');
  assert.match(depois.kpi, /^\d+$/, 'e os KPIs não são substituídos por traço nem por zero');
  assert.equal(depois.vazioVisivel, false, 'nada de estado vazio');
  assert.match(depois.rodape, /Mostrando \d+ de \d+ veículos/, 'o rodapé segue coerente com o que está exibido');
  assert.match(depois.toastTexto, /não foi possível atualizar/i, 'o aviso é de ATUALIZAÇÃO, não de abertura');
  await page.unroute('**/api/veiculos');
  await page.close();
});

test('design-v2: erro de AÇÃO do usuário fala só pelo toast, sem acrescentar a faixa', async () => {
  // Erro de CARGA (faixa, sem toast) é coberto por "erro inicial explica UMA vez". Aqui é o
  // outro canal: o usuário mandou fazer algo e espera resposta imediata.
  const page = await abrir({ design: 'v2' });
  await layoutEstavel(page);
  await page.route('**/api/veiculos', (route) => route.request().method() === 'GET' ? route.abort('failed') : route.continue());
  await limparToast(page);
  await page.evaluate(() => { carregar('acao'); });
  await page.locator('#toast.show').waitFor({ state: 'visible', timeout: 8000 });
  const acao = await page.evaluate(() => ({
    toasts: document.querySelectorAll('#toast.show').length,
    textoToast: (document.querySelector('#toast.show')?.innerText || '').replace(/\s+/g, ' ').trim(),
    faixa: document.getElementById('frotaErro').classList.contains('v2-on'),
    neutra: document.querySelectorAll('#corpoTabela .v2-indisp').length,
  }));
  assert.equal(acao.toasts, 1, 'ação do usuário que falha continua recebendo resposta imediata');
  assert.match(acao.textoToast, /não foi possível|erro/i, 'e a resposta diz o que houve');
  assert.equal(acao.faixa, false,
    'o erro de ação não pode ACRESCENTAR a faixa: de novo seriam dois anúncios do mesmo erro');
  assert.equal(acao.neutra, 0, 'e não troca os dados exibidos por "Dados indisponíveis"');
  await page.unroute('**/api/veiculos');
  await page.close();
});

/* ============================================================
   KPIs — escopo inequívoco
   ============================================================ */
test('design-v2: os KPIs dizem o escopo, e a faixa de oficina se diferencia deles', async () => {
  const page = await abrir({ design: 'v2' });
  await layoutEstavel(page);
  const kpi = () => page.evaluate(() => [...document.querySelectorAll('#frotaKpis .v2-kpi')].map((c) => ({
    rotulo: c.querySelector('.v2-kpi-rot').textContent,
    valor: c.querySelector('.v2-kpi-val').textContent,
    nota: c.querySelector('.v2-kpi-nota').textContent,
  })));

  // --- SEM recorte: "ativos" x "cadastrados no total", cada número com seu nome.
  const semFiltro = await kpi();
  const cadastrados = await page.evaluate(() => VEICULOS.length);
  const ativos = await linhas(page);
  assert.equal(semFiltro[0].rotulo, 'Veículos ativos', 'sem recorte o primeiro KPI conta a frota ativa');
  assert.equal(semFiltro[0].valor, String(ativos), 'e o valor é o número de linhas na tela');
  assert.equal(semFiltro[0].nota, `${cadastrados} cadastrados no total`,
    'o segundo número aparece nomeado, não como "de N" solto');
  assert.ok(cadastrados > ativos, 'a base precisa ter vendidos para o par ativos/cadastrados fazer sentido');
  assert.equal(semFiltro[2].rotulo, 'Na oficina');

  // --- COM recorte: os rótulos passam a dizer "no recorte".
  await marcar(page, [['fStatus', ['EM ATIVIDADE']]]);
  const comFiltro = await kpi();
  assert.equal(comFiltro[0].rotulo, 'Veículos no recorte', 'com filtro o KPI deixa claro que conta o recorte');
  assert.equal(comFiltro[0].nota, `${cadastrados} cadastrados no total`, 'o total continua nomeado');
  assert.equal(comFiltro[2].rotulo, 'Na oficina no recorte',
    'o KPI de oficina precisa dizer que é do recorte — a faixa logo abaixo conta a frota inteira');
  assert.equal(comFiltro[3].rotulo, 'Documento vencido no recorte');

  // --- A faixa (cadastro inteiro) e o KPI (recorte) não podem discordar em silêncio.
  //     `veiculosNaOficina()` lê VEICULOS direto, sem passar por fleetAtiva() — então o texto
  //     tem de dizer "todos os cadastrados", não "frota ativa" nem "frota total".
  const faixa = await page.locator('#frotaOficinaAlertas').innerText();
  assert.match(faixa, /Entre todos os veículos cadastrados/,
    `a faixa precisa declarar o escopo exato da coleção que ela conta (veio "${faixa.split('\n')[0]}")`);
  assert.doesNotMatch(faixa, /frota total/i,
    '"frota total" é ambíguo: pode ser lido como "só os ativos"');
  const naOficinaNoRecorte = Number(comFiltro[2].valor);
  const naOficinaNaFrota = await page.evaluate(() => VEICULOS.filter((v) => /OFICINA/i.test(v.status || '')).length);
  assert.equal(naOficinaNaFrota, 2, 'a base semeada tem 2 veículos na oficina');
  assert.notEqual(naOficinaNoRecorte, naOficinaNaFrota,
    'este recorte foi escolhido justamente para os dois números divergirem — é o caso que o texto precisa explicar');
  await page.evaluate(() => limparFiltros());

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

/* ============================================================
   3.9 — toolbar em 1440 e em 1024
   ============================================================ */
test('design-v2: a toolbar cabe em uma linha em 1440 e em duas em 1024, sem rolagem lateral', async () => {
  // Conta LINHAS VISUAIS agrupando pelo CENTRO vertical: rótulo e botão da mesma linha têm
  // topos diferentes (alturas diferentes) e seriam contados como duas linhas.
  const medir = (page) => page.evaluate(() => {
    const visivel = (el) => { const e = getComputedStyle(el); if (e.display === 'none' || e.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const barra = document.querySelector('#frota-lista .toolbar');
    // `.toolbar-mais` é `display: contents`: não gera caixa própria, mas o botão "⋯" lá dentro
    // É um item da linha. Sem achatar, ele nunca entrava na conta — a barra era medida sem um
    // dos seus controles.
    const itensDe = (pai) => [...pai.children].flatMap((f) => (getComputedStyle(f).display === 'contents' ? itensDe(f) : [f]));
    const itens = itensDe(barra).filter((f) => visivel(f) && getComputedStyle(f).position !== 'absolute')
      .map((f) => { const r = f.getBoundingClientRect(); return { centro: r.top + r.height / 2, meia: r.height / 2 }; })
      .sort((a, b) => a.centro - b.centro);
    const linhasVisuais = [];
    for (const it of itens) {
      const ult = linhasVisuais[linhasVisuais.length - 1];
      if (!ult || it.centro - ult.centro > Math.max(it.meia, ult.meia)) linhasVisuais.push(it);
    }
    const caixa = (s) => { const el = document.querySelector(s); return el && visivel(el) ? el.getBoundingClientRect() : null; };
    // O grupo de planilha deixou de ter caixa própria: `padronizarAcoesPlanilha` o monta DENTRO
    // do menu "⋯" e o CSS o deixa `display: contents` — `getBoundingClientRect()` devolve 0x0
    // mesmo com o menu aberto. Medir a distância dele até o cadastro é asserção IMPOSSÍVEL. Quem
    // ocupa a linha agora é o botão "⋯", e é ele que precisa continuar colado no botão primário.
    const kebab = caixa('#frota-lista .toolbar .v2-kebab-btn'), add = caixa('#btnAdicionar');
    const blocos = ['#frotaKpis', '#frotaOficinaAlertas', '#frota-lista .toolbar', '#frotaChips', '#frota .tabela-wrap']
      .map((s) => ({ s, r: caixa(s) })).filter((o) => o.r);
    const sobrepostos = [];
    for (let i = 0; i < blocos.length; i++) for (let j = i + 1; j < blocos.length; j++) {
      const a = blocos[i].r, b = blocos[j].r;
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) sobrepostos.push(`${blocos[i].s} x ${blocos[j].s}`);
    }
    return {
      linhas: linhasVisuais.length,
      semRolagemX: document.documentElement.scrollWidth <= window.innerWidth,
      buscaVisivel: !!caixa('#busca'), filtrosVisivel: !!caixa('#frotaFiltrosBtn'), adicionarVisivel: !!add,
      mesmaLinhaKebabAdd: !!(kebab && add) && Math.abs(kebab.y - add.y) < 2,
      gap: kebab && add ? +(add.x - (kebab.x + kebab.width)).toFixed(1) : null,
      // as ações de planilha continuam existindo — agora dentro do menu
      grupoNoKebab: document.querySelectorAll('#frota-lista .toolbar .toolbar-mais .v2-kebab-menu [data-planilha-grupo="Frota"]').length,
      sobrepostos,
    };
  });

  const page = await abrir({ design: 'v2', viewport: { width: 1440, height: 900 } });
  await layoutEstavel(page);
  const g = await medir(page);
  assert.equal(g.linhas, 1, `em 1440×900 a toolbar do piloto cabe em uma linha (veio ${g.linhas})`);
  assert.equal(g.semRolagemX, true, 'a página não pode ganhar rolagem horizontal em 1440');
  assert.equal(g.mesmaLinhaKebabAdd, true, 'o menu "⋯" e "Adicionar veículo" continuam na mesma linha');
  assert.ok(g.gap >= 0 && g.gap <= 12, `entre o "⋯" e o cadastro fica só o gap da barra (veio ${g.gap}px)`);
  assert.equal(g.grupoNoKebab, 1, 'as ações de planilha continuam existindo — agora dentro do menu "⋯"');
  assert.deepEqual(g.sobrepostos, [], 'nenhum bloco pode se sobrepor a outro');

  // 1024×768 no pior caso: aviso de oficina + 5 filtros com rótulos longos.
  await page.setViewportSize({ width: 1024, height: 768 });
  await marcar(page, [['fStatus', ['EM ATIVIDADE']], ['fGravame', ['NADA CONSTA']],
    ['fCentro', [CENTROS[0]]], ['fDono', [DONOS[0]]], ['fModelo', [MODELOS[0]]]]);
  await layoutEstavel(page);
  const p = await medir(page);
  assert.ok(p.linhas <= 2, `em 1024×768 a toolbar usa no máximo duas linhas (veio ${p.linhas})`);
  assert.equal(p.buscaVisivel, true, 'a busca continua visível em 1024');
  assert.equal(p.filtrosVisivel, true, 'o botão Filtros continua visível em 1024');
  assert.equal(p.adicionarVisivel, true, '"Adicionar veículo" continua visível em 1024');
  assert.equal(p.semRolagemX, true, 'nem no pior caso a página pode rolar para o lado');
  assert.deepEqual(p.sobrepostos, [], 'nem no pior caso os blocos podem se sobrepor');

  // O painel de filtros aberto no pior caso não pode sair da tela.
  await page.locator('#frotaFiltrosBtn').click();
  await layoutEstavel(page);
  const painel = await page.evaluate(() => {
    const r = document.getElementById('frotaFiltrosPainel').getBoundingClientRect();
    return { dentro: r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1, caixa: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
  });
  assert.equal(painel.dentro, true, `o painel precisa caber na viewport de 1024×768 (${JSON.stringify(painel.caixa)})`);

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

/* ============================================================
   Faixa de oficina: resumo recolhido + lista expansível (nada escondido por overflow)
   ============================================================ */
for (const vp of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }, { width: 1680, height: 900 }]) {
  test(`design-v2: a faixa de oficina é um resumo com lista expansível, sem corte nem rolagem (${vp.width}px)`, async () => {
    const page = await abrir({ design: 'v2', viewport: vp });
    await page.locator('#frotaOficinaAlertas:not([hidden])').waitFor({ state: 'visible', timeout: 8000 });
    await layoutEstavel(page);

    // --- RECOLHIDO: contagem + escopo + ação. Nenhum cartão de veículo na tela.
    const recolhido = await page.evaluate(() => {
      const host = document.getElementById('frotaOficinaAlertas');
      const ver = document.getElementById('frotaOficinaVer');
      const lista = document.getElementById('frotaOficinaLista');
      const semOverflowLateral = (el) => {
        for (let n = el; n && n !== document.body; n = n.parentElement) {
          const e = getComputedStyle(n);
          if ((e.overflowX === 'auto' || e.overflowX === 'scroll') && n.scrollWidth > n.clientWidth + 1) return false;
        }
        return true;
      };
      return {
        papel: host.getAttribute('role'), live: host.getAttribute('aria-live'),
        resumo: host.querySelector('.v2-ofi-resumo')?.innerText.replace(/\s+/g, ' ').trim(),
        verTexto: ver?.textContent.trim(),
        verNome: ver?.getAttribute('aria-label'),
        expandido: ver?.getAttribute('aria-expanded'),
        controla: ver?.getAttribute('aria-controls'),
        listaOculta: lista?.hasAttribute('hidden'),
        linhasNaTela: [...host.querySelectorAll('.v2-ofi-linha')].filter((l) => l.offsetParent !== null).length,
        semRolagemInterna: semOverflowLateral(host),
        docSemRolagemX: document.documentElement.scrollWidth <= window.innerWidth,
      };
    });
    assert.equal(recolhido.papel, 'status', 'a faixa continua sendo uma região de status');
    assert.equal(recolhido.live, 'polite', 'anunciada sem interromper');
    assert.match(recolhido.resumo, /2 veículos na oficina/, 'o resumo diz quantos são');
    assert.match(recolhido.resumo, /Entre todos os veículos cadastrados/,
      `o resumo declara o escopo exato da coleção (veio "${recolhido.resumo}")`);
    assert.equal(recolhido.verTexto, 'Ver 2 veículos', 'a ação diz o que vai abrir, com o plural certo');
    assert.match(recolhido.verNome, /Entre todos os veículos cadastrados/i,
      'o nome acessível da ação também carrega o escopo');
    assert.equal(recolhido.expandido, 'false', 'começa recolhida');
    assert.equal(recolhido.controla, 'frotaOficinaLista', 'aria-controls aponta para a região que ela abre');
    assert.equal(recolhido.listaOculta, true, 'a lista nasce escondida');
    assert.equal(recolhido.linhasNaTela, 0, 'recolhida, nenhum veículo aparece — nem pela metade');
    assert.equal(recolhido.semRolagemInterna, true,
      'a faixa NÃO pode esconder conteúdo atrás de rolagem lateral própria');
    assert.equal(recolhido.docSemRolagemX, true, 'e não pode empurrar a página para o lado');

    // --- EXPANDIDO: lista inline, largura inteira, empurrando a tabela para baixo.
    const tabelaAntes = await page.evaluate(() => document.querySelector('#frota .tabela-wrap').getBoundingClientRect().top);
    await page.locator('#frotaOficinaVer').click();
    await layoutEstavel(page);
    const aberto = await page.evaluate(() => {
      const host = document.getElementById('frotaOficinaAlertas');
      const lista = document.getElementById('frotaOficinaLista');
      const linhas = [...host.querySelectorAll('.v2-ofi-linha')];
      const rh = host.getBoundingClientRect(), rl = lista.getBoundingClientRect();
      const tabela = document.querySelector('#frota .tabela-wrap').getBoundingClientRect();
      return {
        expandido: document.getElementById('frotaOficinaVer').getAttribute('aria-expanded'),
        focoNoBotao: document.activeElement?.id === 'frotaOficinaVer',
        qtd: linhas.length,
        todasBotoes: linhas.every((l) => l.tagName === 'BUTTON' && l.tabIndex >= 0),
        todasComNome: linhas.every((l) => (l.getAttribute('aria-label') || '').length > 10),
        // nenhuma linha cortada: todas cabem inteiras dentro da região
        cortadas: linhas.filter((l) => {
          const r = l.getBoundingClientRect();
          return r.left < rl.left - 1 || r.right > rl.right + 1;
        }).length,
        larguraCheia: linhas.every((l) => l.getBoundingClientRect().width >= rl.width - 24),
        cobreTabela: rh.bottom > tabela.top + 1,
        tabelaTop: tabela.top,
        docSemRolagemX: document.documentElement.scrollWidth <= window.innerWidth,
        textos: linhas.map((l) => l.innerText.replace(/\s+/g, ' ').trim()),
      };
    });
    assert.equal(aberto.expandido, 'true', 'aria-expanded acompanha a abertura');
    assert.equal(aberto.focoNoBotao, true, 'o foco fica no botão que abriu, mesmo com o re-render');
    assert.equal(aberto.qtd, 2, 'os dois veículos aparecem, um por linha');
    assert.equal(aberto.todasBotoes, true, 'cada linha continua sendo um botão que abre o veículo');
    assert.equal(aberto.todasComNome, true, 'com nome acessível próprio');
    assert.equal(aberto.cortadas, 0, 'nenhuma linha pode ficar cortada');
    assert.equal(aberto.larguraCheia, true, 'as linhas ocupam a largura disponível');
    assert.equal(aberto.cobreTabela, false, 'a lista EMPURRA a tabela, não flutua por cima dela');
    assert.ok(aberto.tabelaTop > tabelaAntes, 'abrir a lista desloca a tabela para baixo');
    assert.equal(aberto.docSemRolagemX, true, 'abrir a lista não cria rolagem horizontal na página');
    assert.ok(aberto.textos.some((t) => /DV2OFI1/.test(t)) && aberto.textos.some((t) => /DV2OFI2/.test(t)),
      `as duas placas estão visíveis (veio ${JSON.stringify(aberto.textos)})`);
    assert.ok(aberto.textos.every((t) => /previs|prevista/i.test(t)),
      'cada linha traz a previsão de saída — o mesmo dado dos cartões antigos');

    // --- medidas específicas por viewport (não é screenshot: é caixa medida)
    const medidas = await page.evaluate(() => {
      const resumo = document.querySelector('.v2-ofi-resumo');
      const linhas = [...document.querySelectorAll('.v2-ofi-linha')];
      const barra = document.querySelector('#frota-lista .toolbar');
      const visivel = (el) => { const e = getComputedStyle(el); if (e.display === 'none') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      // linhas visuais pelo CENTRO (rótulo e botão da mesma linha têm topos diferentes)
      const linhasVisuais = (pai) => {
        const its = [...pai.children].filter((f) => visivel(f) && getComputedStyle(f).position !== 'absolute')
          .map((f) => { const r = f.getBoundingClientRect(); return { c: r.top + r.height / 2, m: r.height / 2 }; })
          .sort((a, b) => a.c - b.c);
        const out = [];
        for (const it of its) { const u = out[out.length - 1]; if (!u || it.c - u.c > Math.max(it.m, u.m)) out.push(it); }
        return out.length;
      };
      const tops = new Set(linhas.map((l) => Math.round(l.getBoundingClientRect().top)));
      return {
        resumoLinhas: linhasVisuais(resumo),
        verVisivel: visivel(document.getElementById('frotaOficinaVer')),
        colunasDaLista: linhas.length ? (tops.size === linhas.length ? 1 : linhas.length / tops.size) : 0,
        toolbarLinhas: linhasVisuais(barra),
        // "espaço artificial": sobra à direita da linha dentro da região
        sobraDireita: (() => {
          const lista = document.getElementById('frotaOficinaLista').getBoundingClientRect();
          return Math.round(Math.min(...linhas.map((l) => lista.right - l.getBoundingClientRect().right)));
        })(),
        alturaLinha: Math.round(linhas[0].getBoundingClientRect().height),
      };
    });
    assert.equal(medidas.verVisivel, true, 'a ação "Ver N veículos" continua visível');
    assert.equal(medidas.colunasDaLista, 1, 'a lista é sempre de UMA coluna: uma linha por veículo');
    assert.ok(medidas.sobraDireita <= 4,
      `a lista ocupa a largura disponível, sem espaço artificial à direita (sobra ${medidas.sobraDireita}px)`);
    assert.ok(medidas.alturaLinha <= 64, `linha compacta, não cartão (veio ${medidas.alturaLinha}px)`);
    if (vp.width >= 1440) {
      assert.equal(medidas.resumoLinhas, 1, `em ${vp.width}px o resumo cabe em uma linha (veio ${medidas.resumoLinhas})`);
      assert.equal(medidas.toolbarLinhas, 1, `e a toolbar continua em uma linha (veio ${medidas.toolbarLinhas})`);
    } else {
      assert.ok(medidas.resumoLinhas <= 2, `em ${vp.width}px o resumo pode quebrar em até duas linhas (veio ${medidas.resumoLinhas})`);
      assert.ok(medidas.toolbarLinhas <= 2, `e a toolbar em no máximo duas (veio ${medidas.toolbarLinhas})`);
    }

    // --- RECOLHE de volta e não deixa resto.
    await page.locator('#frotaOficinaVer').click();
    await layoutEstavel(page);
    const fechado = await page.evaluate(() => ({
      expandido: document.getElementById('frotaOficinaVer').getAttribute('aria-expanded'),
      visiveis: [...document.querySelectorAll('.v2-ofi-linha')].filter((l) => l.offsetParent !== null).length,
      tabelaTop: document.querySelector('#frota .tabela-wrap').getBoundingClientRect().top,
    }));
    assert.equal(fechado.expandido, 'false');
    assert.equal(fechado.visiveis, 0, 'recolhida de novo, nenhuma linha fica para trás');
    assert.equal(Math.round(fechado.tabelaTop), Math.round(tabelaAntes), 'e a tabela volta ao lugar');

    assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
    await page.close();
  });
}

test('design-v2: o disclosure da oficina é operável por Enter, Espaço e Escape', async () => {
  const page = await abrir({ design: 'v2' });
  await page.locator('#frotaOficinaAlertas:not([hidden])').waitFor({ state: 'visible', timeout: 8000 });
  const estado = () => page.evaluate(() => ({
    expandido: document.getElementById('frotaOficinaVer').getAttribute('aria-expanded'),
    foco: document.activeElement?.id || document.activeElement?.className || null,
    linhasVisiveis: [...document.querySelectorAll('.v2-ofi-linha')].filter((l) => l.offsetParent !== null).length,
  }));

  // ENTER abre; o foco NÃO é movido para dentro da lista
  await page.locator('#frotaOficinaVer').focus();
  await page.keyboard.press('Enter');
  let e1 = await estado();
  assert.equal(e1.expandido, 'true', 'Enter abre a lista');
  assert.equal(e1.foco, 'frotaOficinaVer', 'abrir não move o foco automaticamente para dentro');
  assert.equal(e1.linhasVisiveis, 2);

  // o próximo Tab segue a ordem natural: primeiro item da lista
  await page.keyboard.press('Tab');
  const aposTab = await page.evaluate(() => ({
    naLista: !!document.activeElement.closest('#frotaOficinaLista'),
    placa: document.activeElement.dataset?.placa || null,
  }));
  assert.equal(aposTab.naLista, true, 'o Tab seguinte entra na lista, que vem logo depois no DOM');

  // ESCAPE com o foco DENTRO da lista recolhe e devolve o foco ao botão
  await page.keyboard.press('Escape');
  const aposEsc = await estado();
  assert.equal(aposEsc.expandido, 'false', 'Escape recolhe a lista');
  assert.equal(aposEsc.foco, 'frotaOficinaVer', 'e devolve o foco ao botão que abriu');
  assert.equal(aposEsc.linhasVisiveis, 0);

  // ESPAÇO abre de novo (botão nativo)
  await page.keyboard.press('Space');
  assert.equal((await estado()).expandido, 'true', 'Espaço também aciona o botão');

  // ESCAPE com o foco no BOTÃO (ainda dentro da faixa) também recolhe
  await page.keyboard.press('Escape');
  assert.equal((await estado()).expandido, 'false', 'Escape a partir do próprio botão recolhe');

  // sem focus trap: com a lista aberta, Shift+Tab sai da faixa para trás
  await page.locator('#frotaOficinaVer').focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('Shift+Tab');
  const paraTras = await page.evaluate(() => ({
    naFaixa: !!document.activeElement.closest('#frotaOficinaAlertas'),
    aberta: document.getElementById('frotaOficinaVer').getAttribute('aria-expanded'),
  }));
  assert.equal(paraTras.naFaixa, false, 'o foco sai da faixa para trás: não há armadilha');
  assert.equal(paraTras.aberta, 'true', 'e sair pelo Tab não fecha a lista (ela não é um diálogo)');

  // Escape FORA da faixa não pode mexer nela (não sequestra o Escape de outros componentes)
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.getElementById('frotaOficinaVer').getAttribute('aria-expanded')), 'true',
    'Escape com o foco fora da faixa não recolhe a lista');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: a lista de oficina é uma lista semântica e não vaza para Multas', async () => {
  const page = await abrir({ design: 'v2' });
  await page.locator('#frotaOficinaAlertas:not([hidden])').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#frotaOficinaVer').click();

  const semantica = await page.evaluate(() => {
    const lista = document.getElementById('frotaOficinaLista');
    const itens = [...lista.children];
    return {
      tag: lista.tagName,
      nome: lista.getAttribute('aria-label'),
      papel: lista.getAttribute('role'),
      filhosLi: itens.every((i) => i.tagName === 'LI'),
      qtd: itens.length,
      itensSemTabindex: itens.every((i) => !i.hasAttribute('tabindex')),
      botaoPorItem: itens.every((i) => i.querySelectorAll('button').length === 1),
      controlado: document.getElementById('frotaOficinaVer').getAttribute('aria-controls') === lista.id,
    };
  });
  assert.equal(semantica.tag, 'UL', 'a lista precisa ser uma lista de verdade (<ul>)');
  assert.equal(semantica.filhosLi, true, 'com <li> como filhos diretos');
  assert.equal(semantica.qtd, 2, 'um <li> por veículo');
  assert.equal(semantica.papel, null, 'sem role sobrescrevendo o de lista — e nada de dialog');
  assert.match(semantica.nome, /Veículos na oficina/, 'a região tem nome acessível');
  assert.equal(semantica.itensSemTabindex, true, 'o <li> não é interativo: não pode ganhar tabindex');
  assert.equal(semantica.botaoPorItem, true, 'quem é interativo é o botão dentro do item');
  assert.equal(semantica.controlado, true, 'aria-controls aponta para o id estável da lista');

  // Multas não recebe o componente nem os estilos
  await irPara(page, 'multas');
  await page.locator('#multas.active').waitFor({ state: 'visible', timeout: 8000 });
  const emMultas = await page.evaluate(() => {
    const naTela = (el) => !!el && el.offsetParent !== null;
    return {
      disclosureEmMultas: document.querySelectorAll('#multas .v2-ofi-lista, #multas .v2-ofi-resumo, #multas .v2-ofi-linha').length,
      faixaDaFrotaNaTela: naTela(document.getElementById('frotaOficinaAlertas')),
      listaDaFrotaNaTela: naTela(document.getElementById('frotaOficinaLista')),
    };
  });
  assert.equal(emMultas.disclosureEmMultas, 0, 'Multas não recebe o disclosure nem seus estilos');
  assert.equal(emMultas.faixaDaFrotaNaTela, false, 'a faixa da Frota sai da tela junto com a aba');
  assert.equal(emMultas.listaDaFrotaNaTela, false, 'e a lista aberta não fica presa em outro módulo');

  // voltando, o comportamento é restaurado
  await irPara(page, 'frota');
  await page.locator('#frota.active').waitFor({ state: 'visible', timeout: 8000 });
  const voltou = await page.evaluate(() => ({
    faixa: !document.getElementById('frotaOficinaAlertas').hidden,
    botao: !!document.getElementById('frotaOficinaVer'),
    expandido: document.getElementById('frotaOficinaVer')?.getAttribute('aria-expanded'),
  }));
  assert.equal(voltou.faixa, true, 'voltando para a Frota a faixa reaparece');
  assert.equal(voltou.botao, true, 'com o botão do disclosure');
  assert.ok(['true', 'false'].includes(voltou.expandido), 'num estado válido e coerente');

  assert.equal(page.erros.length, 0, 'erros de JS:\n' + page.erros.join('\n'));
  await page.close();
});

test('design-v2: a lista de oficina sobrevive a um filtro e some quando não há veículo na oficina', async () => {
  const page = await abrir({ design: 'v2' });
  await page.locator('#frotaOficinaAlertas:not([hidden])').waitFor({ state: 'visible', timeout: 8000 });
  await page.locator('#frotaOficinaVer').click();
  assert.equal(await page.evaluate(() => document.getElementById('frotaOficinaVer').getAttribute('aria-expanded')), 'true');

  // renderTabela roda a cada filtro e remonta a faixa: a lista aberta não pode fechar sozinha
  await marcar(page, [['fStatus', ['EM ATIVIDADE']]]);
  await layoutEstavel(page);
  assert.equal(await page.evaluate(() => document.getElementById('frotaOficinaVer').getAttribute('aria-expanded')), 'true',
    'mexer num filtro não pode fechar a lista na cara do usuário');
  assert.equal(await page.locator('.v2-ofi-linha').count(), 2,
    'e a lista continua contando a mesma coleção (o filtro é da tabela, não da faixa)');

  // sem nenhum veículo na oficina a faixa some inteira — nada de faixa com zero
  await page.evaluate(() => {
    VEICULOS = VEICULOS.map((v) => (/OFICINA/i.test(v.status || '') ? { ...v, status: 'EM ATIVIDADE' } : v));
    renderTabela();
  });
  const semOficina = await page.evaluate(() => ({
    escondida: document.getElementById('frotaOficinaAlertas').hidden,
    conteudo: document.getElementById('frotaOficinaAlertas').innerHTML,
  }));
  assert.equal(semOficina.escondida, true, 'sem veículo na oficina a faixa não aparece');
  assert.equal(semOficina.conteudo, '', 'e não deixa marcação órfã na tela');
  await page.close();
});
