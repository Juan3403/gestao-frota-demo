/**
 * Teste de BROWSER REAL (Playwright + Chromium) — sobe o servidor num DATA_DIR
 * temporário com login DESLIGADO (env vazio → LOGIN_ATIVO=false) e abre a página
 * de verdade. Pega o que o smoke de API não pega: erro de JS no console, app.js
 * que não inicializa, página que não renderiza.
 *
 * Rodar: npm run test:e2e   (NÃO entra no `npm test` de propósito — exige Chromium)
 * Fica fora de test/ e sem sufixo .test → o auto-discovery do node:test o ignora.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const XLSX = require('xlsx');
const archiver = require('archiver');

// Porta 3210. CONVENÇÃO DE FAIXAS: a pasta `test/` fica em 3196-3209 (uma por arquivo — o
// `node --test` roda os arquivos em processos PARALELOS) e as pastas `e2e/` e `scripts/` ficam em
// 3210+, para que as duas suítes possam rodar ao mesmo tempo. Este arquivo já usou a 3198 e colidia em silêncio com test/modulos.test.js:
// `test/portas.test.js` cobra unicidade e faixa — não escolha porta "no olho".
// o servidor perdedor morria com EADDRINUSE, ninguém olhava, e a suíte rodava inteira contra
// o servidor da outra — outro DATA_DIR, outra COFRE_CHAVE e teto de 600 req/min em vez de 5000.
const PORT = 3210;
const BASE = `http://localhost:${PORT}`;
// O painel (SPA) vive sob /painel desde a 1.50.13 — a raiz passou a ser o hub de acesso, e a
// rota da aba é o PATHNAME (/painel/frota), não mais o hash (#frota). Navegar para BASE ou
// para `${BASE}/#aba` abre o hub, onde não existe #sidebar: use sempre PAINEL nos testes do
// app. Os endereços antigos continuam valendo por redirect 301 — coberto por teste próprio.
const PAINEL = `${BASE}/painel`;
const ORIG = { Origin: BASE };
// Contrato REAL do catálogo versionado (config/funcionarios-contratos.json) = ORION (NTE). O
// estoque de EPI é separado por obra: cadastro com saldo inicial exige exatamente 1 contrato
// vinculado e toda movimentação exige contratoNumero válido — sem isso a API devolve 400.
const CONTRATO_EPI = '4600009505';
let srv, tmp, browser;
// Estado do processo filho: sem isto, um servidor que morre no boot (EADDRINUSE, variável de
// ambiente faltando...) some em silêncio — o spawn descartava o stderr e ninguém olhava o código
// de saída, então a suíte seguia contra o servidor alheio já de pé na porta.
let srvSaida = null; // código (ou sinal) com que o filho morreu, se morreu
let srvLog = '';     // stderr do filho, para a mensagem de erro dizer o motivo
async function criarDocxTeste() {
  const zip = archiver('zip', { zlib: { level: 1 } });
  const partes = [];
  const pronto = new Promise((resolve, reject) => {
    zip.on('data', (p) => partes.push(p));
    zip.on('end', () => resolve(Buffer.concat(partes)));
    zip.on('error', reject);
  });
  zip.append('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', { name: '[Content_Types].xml' });
  zip.append('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>', { name: 'word/document.xml' });
  await zip.finalize();
  return pronto;
}

async function esperarServidor(ms = 10000) {
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

// Escolhe uma opção num <select> que virou seletor customizado (customSelect no app.js).
// O menu é PORTADO para o <body> — assim escapa de ancestral com overflow ou que crie
// containing block p/ position:fixed (backdrop-filter/transform do modal) —, logo ele NÃO é
// filho nem irmão do campo: `#campo ~ .cs-menu` ou `.cs-item` dentro do <form> não acham nada.
// Sempre passar por aqui: escopar no ÚNICO menu aberto (o app fecha os outros ao abrir um)
// também evita casar `.cs-item` de mesmo data-val em outro select da página.
// `gatilho` = locator do .cs-btn; `opcao` = value da option ou filtro ({ hasText: '…' }).
async function escolherNoSelect(page, gatilho, opcao) {
  await gatilho.click();
  const menu = page.locator('.cs-menu:not([hidden])');
  await menu.waitFor({ state: 'visible' });
  await (typeof opcao === 'string' ? menu.locator(`.cs-item[data-val="${opcao}"]`) : menu.locator('.cs-item', opcao)).click();
}

/* ---------- Navegação e widgets da casca padronizada (ago/2026) ----------
   Cinco helpers para as mudanças estruturais que arrancaram elementos do lugar onde a suíte os
   procurava. Cada um diz O QUE mudou — é isso que evita o próximo teste nascer errado.
   Gêmeos do `irPara()` de e2e/frota-design-v2.e2e.js (aquele só precisa do ramo desktop; se
   mexer num, olhe o outro). */

/* Troca de aba pela sidebar. Um `.tab` NUNCA está visível sozinho:
     · >= 901px: as abas vivem no flyout `.nav-group-painel` (`position:absolute; display:none`
       em styles.css) e só aparecem com `.flyout-aberto`/`.flyout-fixado` — hover, foco ou
       clique no `.nav-group-title`. Clicar no título é mais estável que simular hover: não
       depende do intervalo de intenção de 40ms.
     · < 901px: o grupo é acordeão (`.nav-group:not(.aberto) .tab { display:none }`).
       (A gaveta/hambúrguer foi removida em ago/2026 junto com o visual mobile.)
       Só o grupo da aba ATIVA nasce aberto — por isso o clique no título aqui é
       CONDICIONAL: no acordeão ele alterna, e clicar num grupo já aberto o fecharia.
   Ex.: await abrirAba(page, 'senhas'); */
async function abrirAba(page, dataTab) {
  const link = page.locator(`.side-nav .tab[data-tab="${dataTab}"]`);
  const grupo = page.locator('.nav-group').filter({ has: page.locator(`.tab[data-tab="${dataTab}"]`) });
  if (await grupo.count()) {
    const precisaAbrir = await grupo.first().evaluate((g) => (matchMedia('(min-width: 901px)').matches
      ? !g.classList.contains('flyout-aberto') && !g.classList.contains('flyout-fixado')
      : !g.classList.contains('aberto')));
    if (precisaAbrir) await grupo.first().locator('.nav-group-title').click();
  }
  await link.click();
  // Com mouse de verdade o flyout some sozinho no mouseleave. No teste ele fica por cima da
  // tela seguinte e passa a interceptar cliques por COORDENADA (uma sub-aba logo abaixo, por
  // exemplo). Fechar aqui equivale a "o mouse saiu da sidebar"; o `.flyout-fixado` (o pino, que
  // é escolha explícita do usuário) não é tocado.
  await page.evaluate(() => document.querySelectorAll('.nav-group.flyout-aberto')
    .forEach((g) => g.classList.remove('flyout-aberto', 'sem-anim')));
}

/* Painel de filtros (`.v2-filtros-btn` + `.filtros`). No Design System (>= 768px) o `.filtros`
   deixou de ser fileira inline e virou painel ancorado: `position:absolute; display:none`, só
   `.aberto` mostra. Abrir é PRÉ-REQUISITO para qualquer `.msel` de dentro existir na tela —
   sem esperar o painel, o clique no `.msel-btn` corre contra a abertura.
   `prefixo`: 'frota' | 'func' | 'rast' | 'mnt' | 'abt' | 'almox' | 'multas'. */
async function abrirFiltros(page, prefixo) {
  await page.locator(`#${prefixo}FiltrosBtn`).click();
  await page.locator(`#${prefixo}FiltrosPainel`).waitFor({ state: 'visible' });
}
/* Fechar NÃO é higiene: o painel é `absolute` dentro da barra (`.toolbar`/`.func-topo` são
   `position:relative`) e COBRE o que vem logo abaixo — em Funcionários, os KPIs. Sem fechar, o
   clique num KPI é interceptado pelo painel. O mesmo clique fecha também o multiselect que
   estiver aberto lá dentro. */
async function fecharFiltros(page, prefixo) {
  if (await page.locator(`#${prefixo}FiltrosPainel.aberto`).count()) {
    await page.locator(`#${prefixo}FiltrosBtn`).click();
  }
  await page.locator(`#${prefixo}FiltrosPainel`).waitFor({ state: 'hidden' });
}

/* Menu "⋯" (`.toolbar-mais` + `.v2-kebab-btn`). No Design System as ações secundárias — e o
   grupo `.planilha-acoes`, que `padronizarAcoesPlanilha` monta — moram DENTRO dele, que nasce
   `display:none`. Ao abrir, o menu é PORTADO para o <body>: depois do clique ele não está mais
   dentro da barra, e só um fica aberto por vez. Devolve o locator do menu já aberto.
   ⚠️ `.planilha-acoes` é `display:contents` lá dentro: caixa 0x0 mesmo com o menu aberto —
   medir o GRUPO é asserção impossível; meça os botões, ou o próprio "⋯". */
async function abrirKebab(page, escopo) {
  await page.locator(`${escopo} .v2-kebab-btn`).click();
  const menu = page.locator('.v2-kebab-menu.aberto');
  await menu.waitFor({ state: 'visible' });
  return menu;
}

/* "Clicar fora": tirar o foco de um campo sem acionar nada (o atalho Alt+D é ignorado quando o
   alvo é input/textarea/select). O alvo histórico era `#pageTitle`, na topbar, que no desktop é
   `display:none` desde ago/2026 — clicar nela trava até o timeout. `#pageLinhaTitulo` é o
   equivalente visível: ESPELHA o #pageTitle por MutationObserver, ou seja, é o mesmo texto no
   lugar novo. No celular a topbar volta e o alvo é o de sempre. */
async function clicarFora(page) {
  const linha = page.locator('#pageLinhaTitulo');
  await ((await linha.isVisible()) ? linha : page.locator('#pageTitle')).click();
}

/* Faixa de alerta expansível — `.v2-ofi-*` na Frota e `.ds-alert` nas demais. Ela nasce
   RECOLHIDA: a lista de itens vem com `hidden`. `innerText` de nó não renderizado devolve o
   `textContent`, então asserção sobre o texto da faixa passava a medir o que ninguém vê — e
   clique em item de dentro nunca acontece. Expandir aqui é o que o usuário faz.
   `botaoId`: 'frotaOficinaVer' (Frota) ou '<hostId>-ver' (montarFaixaAlerta).
   Na Frota o estado sobrevive aos re-renders; no `.ds-alert` NÃO — depois de qualquer
   re-render da aba é preciso expandir de novo. */
async function expandirFaixa(page, botaoId) {
  const btn = page.locator(`#${botaoId}`);
  await btn.waitFor({ state: 'visible' });
  if (await btn.getAttribute('aria-expanded') === 'true') return;
  await btn.click();
  await page.waitForFunction((id) => document.getElementById(id)?.getAttribute('aria-expanded') === 'true', botaoId);
}

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-e2e-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      DATA_DIR: tmp,
      PORT: String(PORT),
      APP_PASSWORD: '',
      SENHA_ADMIN: '',
      MONGODB_URI: '',
      E2E_TEST: '1',
      COFRE_CHAVE: 'chave-segura-exclusiva-dos-testes-e2e',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Só o stderr é canalizado: o stdout do servidor é o banner e a telemetria de memória, ruído
  // puro aqui. E um cano que ninguém drena enche e trava o filho — por isso os dois listeners.
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.on('exit', (codigo, sinal) => { srvSaida = codigo === null ? `sinal ${sinal}` : codigo; });
  await esperarServidor();
  browser = await chromium.launch({ headless: !process.env.HEADED }); // HEADED=1 abre janela visível
});

after(async () => {
  try { await browser?.close(); } catch (e) { /* já fechou */ }
  try { srv.kill(); } catch (e) { /* já morreu */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

test('a página abre, o app inicializa e a sidebar renderiza sem erro de JS', async () => {
  const page = await browser.newPage();
  const erros = [];
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  page.on('pageerror', (e) => erros.push(String(e)));

  // 'load', não 'networkidle': o app abre SSE (modo manutenção) que nunca "esfria"
  await page.goto(PAINEL, { waitUntil: 'load' });
  await page.locator('#sidebar').waitFor({ state: 'visible', timeout: 5000 });
  const abas = await page.locator('#sidebar .tab[data-tab]').count();
  assert.ok(abas > 0, 'a sidebar deveria ter botões de aba');
  // app.js inicializou de fato? a aba Frota é a ativa por padrão e o app monta a tabela nela
  await page.locator('#frota.active, #frota').first().waitFor({ state: 'attached', timeout: 5000 });

  // ignora ruído de rede de CDN offline (Chart.js/Tesseract) — só falha em erro de código nosso
  const reais = erros.filter((e) => !/Failed to load resource|net::ERR|CDN|cdn/i.test(e));
  assert.equal(reais.length, 0, 'erros de JS na página:\n' + reais.join('\n'));
});

// USO: node --test --test-name-pattern='Manutenção: fornecedor' e2e/browser.e2e.js
test('Manutenção: fornecedor no cadastro, busca, edição e falha de carregamento', async (t) => {
  const page = await browser.newPage();
  const headers = { ...ORIG, 'Content-Type': 'application/json' };
  const f = await (await fetch(`${BASE}/api/fornecedores`, {
    method: 'POST', headers, body: JSON.stringify({ nome: 'Oficina E2E do evento' }),
  })).json();
  let evento;
  t.after(async () => {
    await page.close();
    if (evento) await fetch(`${BASE}/api/manutencao/${evento.id}`, { method: 'DELETE', headers });
    await fetch(`${BASE}/api/fornecedores/${f.id}`, { method: 'DELETE', headers });
  });
  await page.goto(`${PAINEL}/manutencao`, { waitUntil: 'load' });
  await page.locator('#btnAddMnt').click();
  await page.waitForFunction(() => !document.getElementById('mntFornecedor').disabled);
  await page.locator('#formMnt [name="placa"]').fill('MNT9Z99');
  await page.locator('#formMnt [name="item"]').fill('Revisão do fornecedor');
  await escolherNoSelect(page, page.locator('#mntFornecedor').locator('..').locator('.cs-btn'), f.id);
  const criado = page.waitForResponse(r => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/manutencao');
  await page.locator('#formMnt button[type="submit"]').click();
  const resposta = await criado;
  assert.ok(resposta.ok());
  evento = (await resposta.json()).evento;
  assert.equal(evento.fornecedorId, f.id);
  const linha = page.locator(`#corpoMnt tr[data-id="${evento.id}"]`);
  await linha.waitFor();
  assert.ok((await linha.innerText()).includes(f.nome));
  await page.locator('#buscaMnt').fill(f.nome);
  assert.equal(await page.locator('#corpoMnt tr').count(), 1);
  await page.reload({ waitUntil: 'load' });
  await linha.locator('.edit-mnt').click();
  await page.waitForFunction(() => !document.getElementById('mntFornecedor').disabled);
  assert.equal(await page.locator('#mntFornecedor').inputValue(), f.id);
  await page.locator('#cancelarMnt').click();

  // Uma falha no catálogo não pode apagar o fornecedor quando o usuário só corrige o custo.
  await page.route('**/api/manutencao/fornecedores', route => route.fulfill({ status: 503, body: '{}' }));
  await linha.locator('.edit-mnt').click();
  await page.waitForFunction(() => document.getElementById('mntFornecedorAjuda').textContent.includes('Não foi possível'));
  assert.equal(await page.locator('#mntFornecedor').inputValue(), f.id);
  await page.locator('#formMnt [name="custo"]').fill('250');
  const editado = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/api/manutencao/${evento.id}`));
  await page.locator('#formMnt button[type="submit"]').click();
  assert.equal((await (await editado).json()).evento.fornecedorId, f.id);
  await page.locator('#mntModal').waitFor({ state: 'hidden' });
  await page.unroute('**/api/manutencao/fornecedores');
  await linha.locator('.edit-mnt').click();
  await page.waitForFunction(() => !document.getElementById('mntFornecedor').disabled);
  await escolherNoSelect(page, page.locator('#mntFornecedor').locator('..').locator('.cs-btn'), '');
  const removido = page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/api/manutencao/${evento.id}`));
  await page.locator('#formMnt button[type="submit"]').click();
  assert.equal((await (await removido).json()).evento.fornecedorId, '');
});

// USO: node --test --test-name-pattern='Manutenção: motorista' e2e/browser.e2e.js
// Confere seleção, cadastro pelo teclado/botão e Desfazer com eventos da mesma placa.
for (const modo of ['selecionar', 'Enter', 'botão']) {
  test(`Manutenção: motorista por lançamento ao ${modo}, inclusive ao desfazer`, async (t) => {
    const originais = [];
    const page = await browser.newPage();
    t.after(async () => {
      await page.close();
      for (const e of originais) {
        await fetch(`${BASE}/api/manutencao/${e.id}`, { method: 'DELETE', headers: ORIG });
      }
    });
    const anterior = modo === 'selecionar' ? 'Ana Demo' : '';
    for (const dados of [
      { placa: 'MNT1A23', motorista: anterior, item: 'Troca de óleo' },
      { placa: 'MNT1A23', motorista: 'Carlos Demo', item: 'Troca de pneus' },
      { placa: 'MNT1A23', motorista: 'Daniel Demo', item: 'Revisão de freios' },
      { placa: 'MNT2B34', motorista: 'Bruno Demo', item: 'Revisão de outra placa' },
    ]) {
      const r = await fetch(`${BASE}/api/manutencao`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
        body: JSON.stringify({ ...dados, data: '15/09/2026', tipo: 'Preventiva', custo: 100 }),
      });
      assert.equal(r.status, 200);
      originais.push((await r.json()).evento);
    }
    const alvo = originais[0];
    const novo = modo === 'selecionar' ? 'Bruno Demo' : `Motorista novo ${modo}`;
    await page.goto(`${PAINEL}/manutencao`, { waitUntil: 'load' });
    const campo = page.locator(`#corpoMnt .pill-select[data-id="${alvo.id}"][data-campo="motorista"] .pill-trigger`);
    await campo.click();
    // O menu da pílula abre no body, fora da linha da tabela.
    const menu = page.locator('.pill-menu:not([hidden])');
    if (modo !== 'selecionar') await menu.locator('.pill-edit').fill(novo);
    const salvo = page.waitForResponse(r => r.request().method() === 'PUT'
      && new URL(r.url()).pathname.startsWith('/api/manutencao/'));
    if (modo === 'selecionar') await menu.getByRole('button', { name: novo, exact: true }).click();
    else if (modo === 'Enter') await menu.locator('.pill-edit').press('Enter');
    else await menu.getByRole('button', { name: 'Adicionar motorista' }).click();
    assert.ok((await salvo).ok());
    await page.locator('#toast.show .toast-acao').waitFor();
    const lista = await (await fetch(`${BASE}/api/manutencao`)).json();
    for (const original of originais) {
      const esperado = original.id === alvo.id ? { ...original, motorista: novo } : original;
      assert.deepEqual(lista.find(e => e.id === original.id), esperado,
        'só o motorista do lançamento editado pode mudar, mesmo quando há outros eventos da placa');
      const texto = await page.locator(`#corpoMnt .pill-select[data-id="${original.id}"][data-campo="motorista"] .pill-trigger`).innerText();
      assert.equal(texto.trim(), esperado.motorista || '—');
    }
    if (modo !== 'selecionar') {
      const cadastros = await (await fetch(`${BASE}/api/cadastros`)).json();
      assert.ok(cadastros.motoristas.includes(novo), 'o nome novo deve continuar disponível no cadastro');
    }
    // O toast atual usa pointer-events:none; aciona pelo teclado para testar a reversão
    // pelo mesmo botão, sem depender do clique por coordenadas sobre o aviso.
    const [desfeito] = await Promise.all([
      page.waitForResponse(r => r.request().method() === 'PUT'
        && new URL(r.url()).pathname.startsWith('/api/manutencao/')),
      page.locator('#toast').getByRole('button', { name: 'Desfazer' }).press('Enter'),
    ]);
    assert.ok(desfeito.ok());
    const depois = await (await fetch(`${BASE}/api/manutencao`)).json();
    for (const original of originais) {
      assert.deepEqual(depois.find(e => e.id === original.id), original,
        'Desfazer deve restaurar só o lançamento editado e preservar os demais');
    }
    await page.reload({ waitUntil: 'load' });
    await campo.waitFor();
    assert.equal((await campo.innerText()).trim(), anterior || '—', 'o valor restaurado deve persistir após recarregar');
  });
}

// USO: node --test --test-name-pattern='Rastreadores: histórico' e2e/browser.e2e.js
// Abre Ações (Código/ID no celular), confere transferência, data/foto da instalação e leitura.
for (const width of [1280, 390]) {
  test(`Rastreadores: histórico de vínculos em Ações (${width}px)`, async (t) => {
    const headers = { ...ORIG, 'Content-Type': 'application/json' };
    const rast = await (await fetch(`${BASE}/api/rastreadores`, {
      method: 'POST', headers, body: JSON.stringify({ codigo: `HIST-E2E-${width}`, esn: `ESN-E2E-${width}`, placa: 'RVT1A23' }),
    })).json();
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAAH/e5Ea1QAAAABJRU5ErkJggg==', 'base64');
    const fd = new FormData();
    fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'instalacao-e2e.png');
    const fotoResp = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: ORIG, body: fd });
    assert.equal(fotoResp.status, 201);
    const foto = await fotoResp.json();
    const instResp = await fetch(`${BASE}/api/instalacoes`, { method: 'POST', headers,
      body: JSON.stringify({ numeroSerie: rast.esn, placa: rast.placa, data: '01/09/2026', fotos: [foto] }) });
    assert.equal(instResp.status, 201);
    const inst = await instResp.json();
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    const erros = [];
    page.on('pageerror', e => erros.push(e.message));
    t.after(async () => {
      await page.close();
      await fetch(`${BASE}/api/instalacoes/${inst.id}`, { method: 'DELETE', headers: ORIG });
      await fetch(`${BASE}/api/rastreadores/${rast.id}`, { method: 'DELETE', headers: ORIG });
    });
    await page.goto(`${PAINEL}/rastreadores`, { waitUntil: 'load' });
    const linha = page.locator(`#corpoRast tr[data-id="${rast.id}"]`);
    if (width >= 768) {
      await linha.locator('.edit-rast').click();
      await page.locator('#formRast [name="placa"]').fill('RVT2B34');
      const [salvo] = await Promise.all([
        page.waitForResponse(r => r.request().method() === 'PUT' && r.url().endsWith(`/api/rastreadores/${rast.id}`)),
        page.locator('#formRast button[type="submit"]').click(),
      ]);
      assert.equal(salvo.status(), 200);
      await page.locator('#rastModal').waitFor({ state: 'hidden' });
    } else {
      assert.equal((await fetch(`${BASE}/api/rastreadores/${rast.id}`, { method: 'PUT', headers,
        body: JSON.stringify({ ...rast, placa: 'RVT2B34' }) })).status, 200);
    }
    const botaoHistorico = width >= 768 ? linha.getByRole('button', { name: 'Histórico de vínculos' }) : linha.locator('.cod-rast');
    await botaoHistorico.click();
    const modal = page.locator('#rastVinculosModal');
    await modal.locator('[data-tipo="transferencia"]').waitFor();
    assert.match(await modal.innerText(), /RVT1A23 → RVT2B34/);
    assert.match(await modal.innerText(), /Detectado em:/);
    assert.match(await modal.innerText(), /Vínculo atual: RVT2B34/);
    assert.match(await modal.innerText(), /Data informada da instalação: 01\/09\/2026/);
    await modal.getByRole('button', { name: 'Ver fotos (1)' }).click();
    await page.locator('#midiaModal').waitFor({ state: 'visible' });
    await page.waitForFunction(() => {
      const img = document.querySelector('#midiaVisor img');
      return img && img.complete && img.naturalWidth > 0;
    });
    await page.locator('#fecharMidia').click();
    assert.equal(await modal.isVisible(), true, 'fechar a foto mantém o histórico aberto');
    const dimensoes = await modal.locator('.modal').boundingBox();
    assert.ok(dimensoes.x >= 0 && dimensoes.x + dimensoes.width <= width + 1, 'modal deve caber na tela');
    if (process.env.CAPTURA_VINCULOS && width === 1280) await page.screenshot({ path: process.env.CAPTURA_VINCULOS, animations: 'disabled' });
    await page.locator('#fecharRastVinculos').click();
    // A ação de leitura permanece disponível; editar/excluir ficam ocultos.
    await page.evaluate(() => document.getElementById('rastreadores').classList.add('somente-leitura'));
    assert.equal(await linha.locator('.edit-rast').isVisible(), false);
    await botaoHistorico.click();
    await modal.locator('[data-tipo="transferencia"]').waitFor();
    assert.equal(erros.length, 0, erros.join('\n'));
  });
}

// A raiz virou o hub de acesso e o painel foi para /painel (1.50.13). Links salvos, QR de
// crachá e atalhos instalados apontam para os endereços ANTIGOS: se o 301 cair, eles morrem
// no hub sem erro nenhum — foi assim que a suíte inteira passou a abrir a página errada.
test('endereço antigo continua abrindo o painel (301) e o hash legado vira caminho', async () => {
  const resp = await fetch(`${BASE}/frota`, { redirect: 'manual' });
  assert.equal(resp.status, 301, '/frota deve redirecionar permanentemente para o painel');
  assert.equal(resp.headers.get('location'), '/painel/frota');

  const page = await browser.newPage();
  await page.goto(`${BASE}/frota`, { waitUntil: 'load' });
  await page.locator('#sidebar').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(new URL(page.url()).pathname, '/painel/frota', 'o endereço antigo deve terminar no painel');

  // Hash antigo (#multas): o app migra para /painel/multas no boot, sem perder a aba.
  await page.goto(`${PAINEL}/#multas`, { waitUntil: 'load' });
  await page.waitForFunction(() => location.pathname === '/painel/multas', null, { timeout: 5000 });
  await page.locator('#multas.active').waitFor({ state: 'visible', timeout: 5000 });

  // A raiz NÃO é o painel: quem abre gestao.example.com cai no hub, com o cartão de cada sistema.
  await page.goto(BASE, { waitUntil: 'load' });
  assert.equal(await page.locator('#sidebar').count(), 0, 'a raiz é o hub de acesso, não o painel');
  await page.close();
});

test('Frota salva dados da oficina e exporta o resultado dos filtros e da busca', async (t) => {
  const registros = [
    { placa: 'EXF1A23', modelo: 'Alvo exportação', status: 'OFICINA', centroCusto: 'Centro exportação A' },
    { placa: 'EXF2B34', modelo: 'Outro exportação', status: 'OFICINA', centroCusto: 'Centro exportação A' },
    { placa: 'EXF3C45', modelo: 'Alvo exportação', status: 'OFICINA', centroCusto: 'Centro exportação B' },
    { placa: 'EXF4D56', modelo: 'Alvo exportação', status: 'EM ATIVIDADE', centroCusto: 'Centro exportação A' },
  ];
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(async () => {
    await page.close();
    for (const v of registros) await fetch(`${BASE}/api/veiculos/${v.placa}`, { method: 'DELETE', headers: ORIG });
  });
  for (const v of registros) {
    const r = await fetch(`${BASE}/api/veiculos`, {
      method: 'POST', headers: { ...ORIG, 'Content-Type': 'application/json' }, body: JSON.stringify(v),
    });
    assert.equal(r.status, 201);
  }
  const erros = [];
  page.on('pageerror', e => erros.push(String(e)));
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  const editar = page.locator('#corpoTabela tr[data-placa="EXF1A23"] .edit');
  await editar.click();
  await page.locator('[name="oficinaDataEntrada"] + .dp-input').fill('28/09/2026');
  await page.locator('[name="oficinaPrevisaoSaida"] + .dp-input').fill('05/10/2026');
  await page.locator('[name="oficinaValorOrcamento"]').fill('1250,50');
  await page.locator('[name="oficinaMotivo"]').fill('Troca de embreagem');
  const salvou = page.waitForResponse(r => r.url().endsWith('/api/veiculos/EXF1A23') && r.request().method() === 'PUT');
  await page.locator('#formVeiculo button[type="submit"]').click();
  assert.equal((await salvou).status(), 200);
  await page.locator('#modal').waitFor({ state: 'hidden' });
  await page.reload({ waitUntil: 'load' });
  await editar.click();
  assert.equal(await page.locator('[name="oficinaDataEntrada"]').inputValue(), '2026-09-28');
  assert.equal(await page.locator('[name="oficinaPrevisaoSaida"]').inputValue(), '2026-10-05');
  assert.equal(await page.locator('[name="oficinaValorOrcamento"]').inputValue(), '1.250,50');
  assert.equal(await page.locator('[name="oficinaMotivo"]').inputValue(), 'Troca de embreagem');
  await page.locator('#cancelar').click();
  // Seleção feita antes do filtro: a placa do centro B não pode vazar para o arquivo.
  await page.evaluate(() => { SELECAO_FROTA.add('EXF1A23'); SELECAO_FROTA.add('EXF3C45'); renderTabela(); });
  await abrirFiltros(page, 'frota');
  await page.locator('#fStatus .msel-btn').click();
  await page.locator('#fStatus .msel-item', { hasText: 'OFICINA' }).locator('input').check();
  await page.locator('#fStatus .msel-btn').click();
  await page.locator('#fCentro .msel-btn').click();
  await page.locator('#fCentro .msel-item', { hasText: 'Centro exportação A' }).locator('input').check();
  await fecharFiltros(page, 'frota');
  await page.locator('#busca').fill('Alvo exportação');
  await page.waitForFunction(() => document.querySelectorAll('#corpoTabela tr[data-placa]').length === 1);
  for (const selecionados of [false, true]) {
    if (!selecionados) await abrirKebab(page, '#frota-lista .toolbar');
    const baixou = page.waitForEvent('download');
    await page.locator(selecionados ? '#selBarExportar' : '#btnExportar').click();
    const download = await baixou;
    const wb = XLSX.read(fs.readFileSync(await download.path()));
    const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
    assert.deepEqual(linhas.map(v => v.PLACA), ['EXF1A23']);
    assert.equal(linhas[0]['DATA DE ENTRADA'], '2026-09-28');
    assert.equal(linhas[0]['DATA DE PREVISÃO'], '2026-10-05');
    assert.equal(linhas[0]['VALOR DA MANUTENÇÃO'], 1250.5);
    assert.equal(linhas[0]['MOTIVO DA IDA'], 'Troca de embreagem');
  }
  let exportacoesVazias = 0;
  page.on('request', r => { if (r.url().includes('/api/exportar')) exportacoesVazias++; });
  await page.locator('#busca').fill('resultado-inexistente-e2e');
  await page.waitForFunction(() => document.querySelectorAll('#corpoTabela tr[data-placa]').length === 0);
  await abrirKebab(page, '#frota-lista .toolbar');
  await page.locator('#btnExportar').click();
  await page.waitForFunction(() => document.body.innerText.includes('Nenhum veículo para exportar com os filtros atuais.'));
  assert.equal(exportacoesVazias, 0);
  assert.deepEqual(erros, []);
});

test('Frota atualiza o card da oficina ao salvar prazo sem recarregar a página', async (t) => {
  t.after(async () => {
    for (const placa of ['OFI1C23', 'OFI2C34']) {
      await fetch(`${BASE}/api/veiculos/${placa}`, { method: 'DELETE', headers: ORIG });
    }
  });
  for (const placa of ['OFI1C23', 'OFI2C34']) {
    const r = await fetch(`${BASE}/api/veiculos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ORIG },
      body: JSON.stringify({ placa, modelo: placa === 'OFI1C23' ? 'Veículo oficina' : 'Veículo sem previsão', status: 'OFICINA' }),
    });
    assert.equal(r.status, 201);
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  const alerta = page.locator('#frotaOficinaAlertas');
  await alerta.waitFor({ state: 'visible' });

  // A faixa virou RESUMO recolhido + lista expansível. O resumo é um `display:flex` de <span>,
  // então os filhos são blocos e o innerText mete "\n" onde antes havia " · " — e entre os dois
  // números entrou o ESCOPO ("Entre todos os veículos cadastrados"), que existe porque a
  // contagem da faixa é sobre a base inteira e o KPI é sobre a filtrada. Normalizar o espaço em
  // branco preserva o contrato original (os dois números na MESMA frase) sem afrouxar para
  // "contém".
  const resumoOficina = (alvo = page) =>
    alvo.locator('#frotaOficinaAlertas .v2-ofi-resumo').innerText().then((t) => t.replace(/\s+/g, ' ').trim());
  const RESUMO = (n, sem) => new RegExp(
    `${n} ve[íi]culos? na oficina Entre todos os ve[íi]culos cadastrados · ${sem} sem previsão de saída`);
  const esperarResumo = (alvo, re) => alvo.waitForFunction((fonte) => {
    const el = document.querySelector('#frotaOficinaAlertas .v2-ofi-resumo');
    return !!el && new RegExp(fonte).test(el.innerText.replace(/\s+/g, ' ').trim());
  }, re.source, { timeout: 10000 });
  const esperarPrevisao = (alvo, txt) => alvo.waitForFunction((t) =>
    document.querySelector('#frotaOficinaLista .v2-ofi-linha[data-placa="OFI1C23"]')?.innerText.includes(t),
    txt, { timeout: 10000 });

  assert.match(await resumoOficina(), RESUMO(2, 2));
  // A lista nasce recolhida (<ul hidden>): sem abrir, nenhum [data-placa] é clicável. O estado é
  // de módulo, então basta abrir UMA vez — o que o passo 4 confere explicitamente.
  await expandirFaixa(page, 'frotaOficinaVer');

  await alerta.locator('[data-placa="OFI1C23"]').click();
  await page.locator('#formVeiculo input[name="oficinaPrevisaoSaida"] + .dp-input').fill('29/07/2026');
  assert.equal(await page.locator('#formVeiculo [name="oficinaPrevisaoSaida"]').inputValue(), '2026-07-29');
  assert.equal(await page.locator('#veicOficinaPrazoDias').inputValue(), '', 'a data exata deve ser aceita sem prazo relativo');
  await page.locator('#cancelar').click();

  await alerta.locator('[data-placa="OFI1C23"]').click();
  await page.locator('#veicOficinaPrazoDias').fill('10');
  const dataCalculada = await page.locator('#formVeiculo [name="oficinaPrevisaoSaida"]').inputValue();
  const esperada = await page.evaluate(() => {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + 10);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  assert.equal(dataCalculada, esperada, '10 dias deve virar uma data fixa');

  let atrasarProximaRecarga = true;
  await page.route('**/api/veiculos', async (route) => {
    if (route.request().method() === 'GET' && atrasarProximaRecarga) {
      atrasarProximaRecarga = false;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    await route.continue();
  });
  const tentouRecarga = page.waitForRequest((r) => r.url().endsWith('/api/veiculos') && r.method() === 'GET');
  const concluiuRecarga = page.waitForResponse((r) => r.url().endsWith('/api/veiculos') && r.request().method() === 'GET');
  const salvou = page.waitForResponse((r) => r.url().endsWith('/api/veiculos/OFI1C23') && r.request().method() === 'PUT');
  await page.locator('#formVeiculo button[type="submit"]').click();
  assert.equal((await salvou).status(), 200);
  await tentouRecarga;
  await esperarResumo(page, RESUMO(2, 1));
  // A lista continua aberta depois do re-render (o estado de expansão é de módulo). Se um dia
  // deixar de continuar, isto falha AQUI, com nome, em vez de virar timeout mais abaixo.
  assert.equal(await page.locator('#frotaOficinaVer').getAttribute('aria-expanded'), 'true',
    'a lista precisa continuar aberta depois do re-render');
  const linhaOficina = (placa) => alerta.locator(`.v2-ofi-linha[data-placa="${placa}"]`).innerText();
  assert.match(await linhaOficina('OFI1C23'), /Saída prevista em 10 d/);
  assert.match(await linhaOficina('OFI2C34'), /Sem previsão; clique para definir/);
  assert.equal(await page.locator('#badgeFrotaOficina').innerText(), '2');
  await concluiuRecarga;

  const observer = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await observer.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  await observer.locator('#frotaOficinaAlertas').waitFor({ state: 'visible' });
  await expandirFaixa(observer, 'frotaOficinaVer'); // aba nova: a lista nasce recolhida aqui também
  await esperarPrevisao(observer, 'Saída prevista em 10 d');

  await alerta.locator('[data-placa="OFI1C23"]').click();
  assert.equal(await page.locator('#formVeiculo [name="oficinaPrevisaoSaida"]').inputValue(), esperada);
  assert.equal(await page.locator('#veicOficinaPrazoDias').inputValue(), '10', 'o prazo informado deve continuar salvo ao reabrir');
  assert.equal(await page.locator('#veicOficinaPrazoInfo').innerText(), `Prazo original: 10 d · Data fixa: ${esperada.split('-').reverse().join('/')}.`);

  await page.locator('#veicOficinaPrazoDias').fill('3');
  const esperada3 = await page.locator('#formVeiculo [name="oficinaPrevisaoSaida"]').inputValue();
  const alterouPrazo = page.waitForResponse((r) => r.url().endsWith('/api/veiculos/OFI1C23') && r.request().method() === 'PUT');
  await page.locator('#formVeiculo button[type="submit"]').click();
  assert.equal((await alterouPrazo).status(), 200);
  await esperarPrevisao(page, 'Saída prevista em 3 d');
  await esperarPrevisao(observer, 'Saída prevista em 3 d');

  await alerta.locator('[data-placa="OFI1C23"]').click();
  assert.equal(await page.locator('#formVeiculo [name="oficinaPrevisaoSaida"]').inputValue(), esperada3);
  assert.equal(await page.locator('#veicOficinaPrazoDias').inputValue(), '3');
  await escolherNoSelect(page, page.locator('#formVeiculo select[name="status"] + .cs-btn'), 'EM ATIVIDADE');
  assert.equal(await page.locator('#veicOficinaPrevisao').isVisible(), false);
  const atualizou = page.waitForResponse((r) => r.url().endsWith('/api/veiculos/OFI1C23') && r.request().method() === 'PUT');
  await page.locator('#formVeiculo button[type="submit"]').click();
  assert.equal((await atualizou).status(), 200);
  await esperarResumo(page, RESUMO(1, 1));
  await esperarResumo(observer, RESUMO(1, 1));
  assert.equal(await page.locator('#badgeFrotaOficina').innerText(), '1');
  await observer.close();

  assert.equal(erros.length, 0, 'erros de JS:\n' + erros.join('\n'));
  await page.close();
});

// A topbar sumiu do desktop na padronização de ago/2026 (`.topbar { display:none }` a partir de
// 901px) e as ferramentas administrativas viraram itens do menu do usuário, no rodapé da
// sidebar: `htmlUserMenuRaiz` monta Backup / Modo manutenção / Painel do desenvolvedor, e o
// handler DELEGA o clique aos mesmos botões que continuam ocultos no DOM (#btnBackup,
// #manutToggle, #btnDevPainel) — por isso eles ainda existem e por isso o teste os procura
// escondidos. O contrato medido aqui é o mesmo de antes: ferramentas recolhidas por padrão,
// mas ESTADO IMPORTANTE nunca escondido dentro do menu.
test('menu do usuário recolhe ferramentas administrativas sem esconder estados importantes', async (t) => {
  // Modo manutenção é estado do SERVIDOR e a suíte compartilha um só: sem esta rede, um teste
  // que falhe no meio deixa o banner ligado para os ~30 seguintes.
  t.after(() => fetch(`${BASE}/api/sistema/manutencao`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ ativo: false }),
  }).catch(() => {}));

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(PAINEL, { waitUntil: 'load' });

  const gatilho = page.locator('#sidebarPerfil');
  const menu = page.locator('#userMenu');
  const item = (acao) => menu.locator(`[data-acao="${acao}"]`);
  await gatilho.waitFor({ state: 'visible', timeout: 5000 }); // o cartão só monta depois do /api/eu

  assert.equal(await menu.isVisible(), false, 'as ferramentas ocasionais começam recolhidas');
  for (const oculto of ['#btnFerramentas', '#btnBackup', '#manutToggleWrap', '#btnDevPainel']) {
    assert.equal(await page.locator(oculto).isVisible(), false,
      `${oculto} não pode ocupar a barra: ele existe só para o menu delegar o clique`);
  }

  await gatilho.click();
  assert.equal(await menu.isVisible(), true);
  assert.equal(await gatilho.getAttribute('aria-expanded'), 'true');
  for (const acao of ['backup', 'manutencao', 'dev']) {
    assert.equal(await item(acao).isVisible(), true, `o menu deve oferecer "${acao}"`);
  }
  // O foco não salta para o primeiro item ao abrir (o menu de ferramentas antigo fazia isso;
  // este não). A operabilidade por teclado vem de duas coisas que EXISTEM: o vínculo ARIA
  // gatilho→menu, e o menu estar logo adiante na ordem de tabulação (entre eles só há o botão
  // de versão do rodapé) — poucos Tabs alcançam os itens.
  assert.equal(await gatilho.getAttribute('aria-haspopup'), 'menu');
  assert.equal(await gatilho.getAttribute('aria-controls'), 'userMenu');
  await gatilho.focus();
  let tabsAteMenu = 0;
  for (; tabsAteMenu < 4; tabsAteMenu++) {
    if (await page.evaluate(() => !!document.getElementById('userMenu')?.contains(document.activeElement))) break;
    await page.keyboard.press('Tab');
  }
  assert.ok(tabsAteMenu < 4, 'o teclado deve alcançar os itens do menu em poucos Tabs a partir do cartão');

  await item('backup').click();
  await page.locator('#backupModal').waitFor({ state: 'visible' });
  assert.equal(await menu.isVisible(), false, 'abrir o Backup fecha o menu');
  await page.locator('#fecharBackup').click();

  await gatilho.click();
  await item('dev').click();
  await page.locator('#devPainelModal').waitFor({ state: 'visible' });
  assert.equal(await menu.isVisible(), false, 'abrir o painel de desenvolvimento fecha o menu');
  await page.locator('#fecharDevPainel').click();

  await gatilho.focus();
  await page.keyboard.press('Enter');
  await menu.waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  assert.equal(await menu.isVisible(), false);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'sidebarPerfil', 'Escape fecha e devolve o foco');

  // ESTADO IMPORTANTE NÃO SE ESCONDE NUM MENU. É o coração deste teste: ligar a manutenção pelo
  // menu tem de acender um aviso PERMANENTE na tela, e o próprio item precisa dizer o estado por
  // texto — não só por cor.
  await gatilho.click();
  await item('manutencao').click();
  const banner = page.locator('#manutencaoBanner');
  await banner.waitFor({ state: 'visible', timeout: 5000 });
  assert.match(await banner.innerText(), /sinalizando manutenção|mexendo no sistema/i,
    'o aviso precisa dizer o que está acontecendo, sem depender de cor');
  await gatilho.click();
  assert.equal(await item('manutencao').locator('.um-estado').innerText(), 'ligado',
    'o item também anuncia o estado por texto');
  await item('manutencao').click();
  await banner.waitFor({ state: 'hidden' });
  await gatilho.click();
  assert.equal(await item('manutencao').locator('.um-estado').innerText(), 'desligado');
  await page.keyboard.press('Escape');

  // Abrir a página de Tema troca o conteúdo do menu (é submenu, não um segundo popup) e
  // "clicar fora" fecha.
  await gatilho.click();
  await item('tema').click();
  await page.locator('#userMenu .um-tema').first().waitFor({ state: 'visible' });
  assert.equal(await page.locator('#userMenu .um-voltar').count(), 1, 'a página de tema tem o botão de voltar');
  await clicarFora(page);
  assert.equal(await menu.isVisible(), false, 'clicar fora fecha o menu');

  // Contraste em cada aparência que EXISTE. As decorativas saíram na consolidação de ago/2026 —
  // `aplicarTema` cai em 'claro' para qualquer outro nome, então o laço antigo, com 'preto' e
  // 'comando', media três vezes o tema claro sem perceber.
  for (const tema of ['claro', 'escuro']) {
    await page.evaluate((valor) => aplicarTema(valor), tema);
    await gatilho.click();
    const cores = await menu.evaluate((el) => ({ fundo: getComputedStyle(el).backgroundColor, texto: getComputedStyle(el).color }));
    assert.notEqual(cores.fundo, 'rgba(0, 0, 0, 0)', `o menu precisa de fundo no tema ${tema}`);
    assert.notEqual(cores.fundo, cores.texto, `o menu precisa manter contraste no tema ${tema}`);
    await page.keyboard.press('Escape');
  }
  await page.evaluate(() => aplicarTema('claro'));

  // Alvo de toque no DESKTOP: o `.ferramentas-item` que estes itens substituíram tinha 42px, e a
  // interface pede 40px de alvo clicável. ⚠️ No celular os itens seguem menores — mexer no
  // layout de celular é decisão à parte, e está registrado como pendência, não esquecimento.
  await gatilho.click();
  const alturas = await menu.locator('button:not([hidden])').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  assert.ok(alturas.length, 'o menu precisa ter itens');
  assert.ok(alturas.every((h) => h >= 40), `itens precisam de alvo de toque confortável (medido: ${alturas.join('/')}px)`);
  await page.keyboard.press('Escape');

  // (ago/2026: a checagem de viewport de celular saiu junto com o visual mobile,
  //  que será reconstruído do zero — voltará com o novo layout.)
  assert.equal(erros.length, 0, 'erros de JS:\n' + erros.join('\n'));
  await page.close();
});

test('ações de planilha ficam padronizadas em todas as abas', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  // No Design System as ações de planilha nascem DENTRO do menu "⋯" (padronizarAcoesPlanilha
  // detecta a `.toolbar-mais` e monta o grupo lá), e esse menu é `display:none` fechado: o grupo
  // existe no DOM mas não tem caixa. Esperar por "visible" ficava até o timeout — o sinal certo
  // de que a barra terminou de montar é o próprio botão "⋯".
  await page.locator('#frota-lista .toolbar .v2-kebab-btn').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('[data-planilha-grupo="Frota"]').waitFor({ state: 'attached', timeout: 5000 });

  const grupos = {
    Frota: ['importar', 'exportar'], Multas: ['exportar'], Rastreadores: ['importar', 'exportar'],
    'Instalações': ['exportar'], Envios: ['exportar'], 'Manutenção': ['importar', 'exportar'],
    'Notas fiscais': ['exportar'], Abastecimento: ['importar', 'exportar'], Contratos: ['importar', 'exportar'],
    Aportes: ['importar', 'exportar'], 'Empréstimos': ['importar', 'exportar'], Percentuais: ['importar', 'exportar'],
    Retiradas: ['exportar'], Fornecedores: ['importar', 'exportar'], 'Funcionários': ['importar', 'exportar'],
    Custos: ['importar'], 'Custos · impostos': ['exportar'], 'Custos · equipe': ['exportar'],
    'Custos · lançamentos': ['exportar'], 'Integração': ['exportar'],
  };
  for (const [nome, ordem] of Object.entries(grupos)) {
    const grupo = page.locator(`[data-planilha-grupo="${nome}"]`);
    assert.equal(await grupo.count(), 1, `deve existir um grupo único em ${nome}`);
    assert.equal(await grupo.getAttribute('role'), 'group');
    assert.match(await grupo.getAttribute('aria-label'), /Ações de planilha/);
    assert.deepEqual(await grupo.locator('[data-planilha-acao]').evaluateAll((els) => els.map((el) => el.dataset.planilhaAcao)), ordem, `ordem em ${nome}`);
  }
  assert.equal(await page.locator('.topbar-actions #btnImportar, .topbar-actions #btnExportar').count(), 0, 'Frota não deve manter planilhas no cabeçalho global');
  assert.equal(await page.evaluate(() => {
    const grupo = document.querySelector('[data-planilha-grupo="Frota"]');
    const adicionar = document.querySelector('#btnAdicionar');
    return !!(grupo.compareDocumentPosition(adicionar) & Node.DOCUMENT_POSITION_FOLLOWING);
  }), true, 'o grupo deve vir imediatamente antes da ação de cadastro');

  // O que a padronização passou a prometer no desktop: as ações continuam ACESSÍVEIS, agora
  // atrás do "⋯" da própria barra — não voltaram para o cabeçalho global (asserção acima) nem
  // sumiram. Medir a CAIXA do grupo é impossível de propósito: dentro do menu ele é
  // `display:contents`, ou seja, 0x0 mesmo com o menu aberto. O que dá para provar, e é o que
  // importa, é que abrir o menu revela os MESMOS botões, na ordem padronizada.
  const menuFrota = await abrirKebab(page, '#frota-lista .toolbar');
  assert.equal(await menuFrota.locator('[data-planilha-grupo="Frota"]').count(), 1,
    'o grupo de planilha da Frota vive dentro do menu "⋯"');
  const acoesNoMenu = await menuFrota.locator('[data-planilha-acao]').evaluateAll(
    (els) => els.filter((el) => el.getBoundingClientRect().height > 0).map((el) => el.dataset.planilhaAcao));
  assert.deepEqual(acoesNoMenu, ['importar', 'exportar'], 'abrir o "⋯" revela importar e exportar, nessa ordem');
  await page.keyboard.press('Escape');
  await menuFrota.waitFor({ state: 'hidden' });

  // (ago/2026: a seção de celular deste teste saiu junto com o visual mobile.)
  const casos = [
    { aba: 'frota', grupo: 'Frota', barra: '#frota-lista .toolbar', principal: '#btnAdicionar' },
    { aba: 'fornecedores', grupo: 'Fornecedores', barra: '#fornecedores .forn-topo', principal: '#btnAddForn' },
    { aba: 'funcionarios', grupo: 'Funcionários', barra: '#funcionarios .func-topo', principal: '#btnAddFunc' },
  ];

  await page.setViewportSize({ width: 1663, height: 900 });
  for (const caso of casos) {
    await page.evaluate((aba) => {
      document.querySelectorAll('main > .view').forEach((view) => { view.style.display = 'none'; });
      document.getElementById(aba).style.display = 'block';
    }, caso.aba);
    // Duas formas legítimas da MESMA barra, e o teste aceita as duas explicitamente em vez de
    // medir a que existir por acaso: barra COM menu "⋯" (Frota, Funcionários) guarda as ações de
    // planilha lá dentro, e quem passa a fazer par com o cadastro é o próprio "⋯"; barra SEM
    // menu (Fornecedores — a `.forn-topo` não tem `.toolbar-mais`) mantém o grupo inline, colado
    // no cadastro, exatamente como o contrato original.
    const temKebab = (await page.locator(`${caso.barra} .toolbar-mais .v2-kebab-menu`).count()) > 0;
    const vizinho = page.locator(temKebab
      ? `${caso.barra} .v2-kebab-btn`
      : `[data-planilha-grupo="${caso.grupo}"]`);
    const principal = page.locator(caso.principal);
    await vizinho.waitFor({ state: 'visible' });
    const [caixaVizinho, caixaPrincipal] = await Promise.all([vizinho.boundingBox(), principal.boundingBox()]);
    assert.ok(caixaVizinho && caixaPrincipal, `controles de ${caso.aba} devem estar visíveis`);
    assert.equal(Math.abs(caixaVizinho.y - caixaPrincipal.y) < 2, true,
      `ações secundárias e cadastro devem compartilhar a linha em ${caso.aba}`);
    const espaco = caixaPrincipal.x - (caixaVizinho.x + caixaVizinho.width);
    assert.ok(espaco >= 0 && espaco <= 12,
      `entre elas deve ficar só o gap da barra em ${caso.aba} (gap atual: ${espaco}px)`);
    assert.equal(await page.locator(temKebab
      ? `${caso.barra} .toolbar-mais [data-planilha-grupo="${caso.grupo}"]`
      : `${caso.barra} [data-planilha-grupo="${caso.grupo}"]`).count(), 1,
      `o grupo de ${caso.aba} deve morar ${temKebab ? 'dentro do menu "⋯"' : 'inline na barra'}`);
  }

  await page.evaluate(() => {
    document.querySelectorAll('main > .view').forEach((view) => { view.style.display = 'none'; });
    document.getElementById('fornecedores').style.display = 'block';
    FORNECEDORES = [{
      id: 'forn-icones-e2e', nome: 'Oficina Vetor', tipo: 'Oficina', ativo: true, cidade: 'Natal', uf: 'RN',
      contato: 'Ana', telefone: '(84) 99999-0000', endereco: 'Rua dos Testes, 10',
    }, {
      id: 'forn-pneu-legado-e2e', nome: 'Pneus Legado', tipo: 'Pneus', ativo: true, emoji: '🛞',
    }];
    OFICINA = [{ fornecedor: 'Oficina Vetor', valor: 250, data: '2026-07-20' }];
    renderFornecedores();
  });
  const linhaOficina = page.locator('#corpoForn tr[data-id="forn-icones-e2e"]');
  assert.equal((await linhaOficina.locator('.forn-ic-mini').innerText()).trim(), '🔧', 'fornecedor antigo deve manter o emoji automático do tipo');
  assert.equal(await linhaOficina.locator('.forn-edit').getAttribute('aria-label'), 'Abrir cadastro de Oficina Vetor');
  assert.equal(await linhaOficina.locator('.forn-del').getAttribute('aria-label'), 'Excluir Oficina Vetor');
  assert.equal(await page.locator('#corpoForn tr[data-id="forn-pneu-legado-e2e"] .forn-pneu-svg').count(), 1, 'cadastro antigo de pneus deve mostrar um pneu reconhecível');
  for (const tema of ['claro', 'escuro']) {
    const medidas = await page.locator('#corpoForn tr[data-id="forn-pneu-legado-e2e"] .forn-pneu-svg').evaluate((svg, modo) => {
      aplicarTema(modo);
      const caixa = svg.getBoundingClientRect(), estilo = getComputedStyle(svg);
      return { largura: caixa.width, altura: caixa.height, cor: estilo.color, visibilidade: estilo.visibility };
    }, tema);
    // A entrada da view pode produzir frações como 17.999999px por translação; a régua é 18px.
    assert.ok(Math.round(medidas.largura) >= 18 && Math.round(medidas.altura) >= 18, `pneu deve permanecer legível na linha compacta no tema ${tema}: ${JSON.stringify(medidas)}`);
    assert.notEqual(medidas.cor, 'rgba(0, 0, 0, 0)');
    assert.equal(medidas.visibilidade, 'visible');
  }
  await page.evaluate(() => aplicarTema('claro'));

  let fornecedorEmojiMock = null;
  await page.route('**/api/fornecedores**', async (route) => {
    const req = route.request(), metodo = req.method();
    if (metodo === 'POST') {
      fornecedorEmojiMock = { ...req.postDataJSON(), id: 'forn-emoji-api-e2e', ts: Date.now() };
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify(fornecedorEmojiMock) });
      return;
    }
    if (metodo === 'PUT') {
      fornecedorEmojiMock = { ...fornecedorEmojiMock, ...req.postDataJSON() };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fornecedorEmojiMock) });
      return;
    }
    if (metodo === 'GET') {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fornecedorEmojiMock ? [fornecedorEmojiMock] : []) });
      return;
    }
    await route.continue();
  });
  await page.route('**/api/oficina', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.locator('#btnAddForn').click();
  await page.locator('#fornModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#formForn input[name="nome"]').fill('Fornecedor Emoji E2E');
  await page.locator('#fornTabFrota').click();
  await page.locator('#fornPanelFrota').waitFor({ state: 'visible' });
  const opcoesEmoji = page.locator('#fornEmojiOpcoes input[name="emoji"]');
  assert.ok(await opcoesEmoji.count() >= 12, 'o seletor deve oferecer uma variedade de emojis');
  assert.equal(await page.locator('#fornEmojiOpcoes input[value="⚫"]').count(), 1, 'o seletor deve oferecer o símbolo de pneu compatível');
  assert.equal(await page.locator('#fornEmojiOpcoes input[value="🛞"]').count(), 0, 'o emoji sem suporte não deve continuar no seletor');
  assert.equal(await page.locator('#fornEmojiOpcoes label:has(input[value="⚫"]) .forn-pneu-svg').count(), 1, 'a opção deve desenhar aro e banda do pneu');
  const alvosEmoji = await page.locator('.forn-emoji-opcao').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
  assert.ok(alvosEmoji.every((h) => h >= 40), 'cada emoji deve ser um alvo confortável para mouse e toque');
  await page.locator('.forn-emoji-opcao:has(input[value="🏪"])').click();
  const criou = page.waitForResponse((resp) => resp.url().endsWith('/api/fornecedores') && resp.request().method() === 'POST');
  await page.locator('#formForn button[type="submit"]').click();
  const respostaCriou = await criou;
  assert.equal(respostaCriou.status(), 201);
  const fornecedorCriado = await respostaCriou.json();
  assert.equal(fornecedorCriado.emoji, '🏪', 'a API deve persistir o emoji escolhido');
  const linhaCriada = page.locator(`#corpoForn tr[data-id="${fornecedorCriado.id}"]`);
  await linhaCriada.waitFor({ state: 'visible' });
  assert.equal((await linhaCriada.locator('.forn-ic-mini').innerText()).trim(), '🏪');

  await linhaCriada.locator('.forn-edit').click();
  await page.locator('#fornTabFrota').click();
  await page.locator('#fornPanelFrota').waitFor({ state: 'visible' });
  await page.locator('#fornEmojiOpcoes input[value="🏪"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#fornEmojiOpcoes input[value="🏪"]').isChecked(), true, 'a edição deve restaurar o emoji salvo');
  await page.locator('.forn-emoji-opcao:has(input[value="🧰"])').click();
  const editou = page.waitForResponse((resp) => resp.url().includes(`/api/fornecedores/${fornecedorCriado.id}`) && resp.request().method() === 'PUT');
  await page.locator('#formForn button[type="submit"]').click();
  const respostaEditou = await editou;
  assert.equal(respostaEditou.status(), 200);
  assert.equal((await respostaEditou.json()).emoji, '🧰', 'a API deve atualizar o emoji escolhido');
  await page.waitForFunction((id) => document.querySelector(`#corpoForn tr[data-id="${id}"] .forn-ic-mini`)?.textContent.trim() === '🧰', fornecedorCriado.id);

  assert.equal(erros.length, 0, 'erros de JS:\n' + erros.join('\n'));
  await page.close();
});

test('permissões de Funcionários permitem liberar o Escritório Administrativo', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(PAINEL, { waitUntil: 'load' });
  await page.locator('#permEmpresaSel').waitFor({ state: 'attached', timeout: 5000 });
  await page.evaluate(() => {
    setCatalogoContratosFunc([{
      sigla: 'NTE',
      nome: 'NORTE ENGENHARIA',
      contratos: [
        { numero: '4600009505', nome: 'OBRA', frentes: [''] },
        { numero: 'ESCRITORIO-NTE', nome: 'ESCRITÓRIO', frentes: [''] },
      ],
    }]);
    document.getElementById('permEmpresaSel').value = 'NTE';
    renderPermContratos(new Set());
  });
  await page.locator('#permissoesModal').evaluate(el => { el.hidden = false; });
  const escritorio = page.locator('.perm-ctr-chk[value="ESCRITORIO-NTE"]');
  await escritorio.check();
  assert.match(await escritorio.locator('xpath=..').innerText(), /Escritório \(Administrativo\)/);
  assert.deepEqual(await page.evaluate(() => [...coletarContratosMarcados()]), ['ESCRITORIO-NTE']);
  await page.close();
});
test('cronograma de contratos agrupa parcelas e projeta os meses futuros', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/contratos`, { waitUntil: 'load' });
  await page.locator('#contratosSubtabs').waitFor({ state: 'visible', timeout: 5000 });

  await page.evaluate(() => {
    const hoje = new Date();
    const br = (d) => String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    const noMes = (n) => new Date(hoje.getFullYear(), hoje.getMonth() + n, 10);
    CONTRATOS = [
      { id: 'con-pago', serieId: 'serie-carta', ts: 2, banco: 'Itaú', produto: 'Consórcio', empresa: 'NTE', material: 'Carta atual 1042', grupo: '88', cota: '1042', parcela: '2/48', valorParcela: 1250, vencimento: br(noMes(0)), dataPagamento: br(noMes(0)), valorPago: 1250, localCarro: 'Hilux ABC1D23' },
      { id: 'con-1', serieId: 'serie-carta', ts: 1, banco: 'Itaú', produto: 'Consórcio', empresa: 'NTE', material: 'Carta antiga 1042', grupo: '88', cota: '1042', parcela: '3/48', valorParcela: 1250, vencimento: br(noMes(1)), localCarro: 'Hilux ABC1D23' },
      { id: 'con-2', serieId: 'serie-carta', ts: 1, banco: 'Itaú', produto: 'Consórcio', empresa: 'NTE', material: 'Carta antiga 1042', grupo: '88', cota: '1042', parcela: '4/48', valorParcela: 1250, vencimento: br(noMes(2)), localCarro: 'Hilux ABC1D23' },
      { id: 'emp-1', serieId: 'serie-emprestimo', banco: 'BB', produto: 'Empréstimo', empresa: 'SUL', material: 'Empréstimo 77', parcela: '2/12', valorParcela: 900, vencimento: br(noMes(1)), localCarro: 'Não deve aparecer' },
      { id: 'emp-pago', serieId: 'serie-emprestimo', banco: 'BB', produto: 'Empréstimo', empresa: 'SUL', material: 'Empréstimo 77', parcela: '1/12', valorParcela: 900, vencimento: br(noMes(0)), dataPagamento: br(noMes(0)), valorPago: 900, localCarro: 'Não deve aparecer' },
    ];
    renderCronogramaContr();
  });
  await page.locator('#contratosSubtabs [data-sub="contr-cronograma"]').click();
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('cronograma-tela-cheia')), true, 'o cronograma deve ativar o modo de planilha em tela cheia');

  const linhas = page.locator('#contrCronoCorpo tr');
  assert.equal(await linhas.count(), 2, 'parcelas do mesmo contrato devem virar uma linha');
  assert.match(await linhas.nth(0).innerText(), /Carta atual 1042/, 'descrições alteradas devem permanecer na mesma série e usar a parcela paga mais recente');
  assert.match(await linhas.nth(0).innerText(), /Hilux ABC1D23/, 'consórcio deve mostrar o veículo');
  assert.match(await linhas.nth(1).innerText(), /BB/, 'empréstimo deve mostrar o banco');
  assert.doesNotMatch(await linhas.nth(1).innerText(), /Não deve aparecer/, 'empréstimo não deve usar o campo de carro');
  assert.equal(await page.locator('#contrCronoCorpo .contr-crono-cel.pendente').count(), 3);
  // Parcelas PAGAS ficam na timeline (cinza, classe `paga`), no mês delas — a timeline é o
  // cronograma completo; só não entram nos indicadores (regressão 1.55.26).
  assert.equal(await page.locator('#contrCronoCorpo .contr-crono-cel.paga').count(), 2, 'con-pago e emp-pago aparecem como células pagas');
  assert.equal(await page.locator('#contrCronoCorpo .contr-crono-cel.paga').last().locator('.contr-crono-status').innerText(), '1/12');
  assert.doesNotMatch(await page.locator('#contrCronoCorpo .contr-crono-cel.paga').last().innerText(), /Paga/i, 'paga não leva rótulo — a cor verde já diz que está em dia');
  // Paga e não paga têm estados visuais diferentes: verde para paga, vermelho para pendente.
  const fundoDe = (sel) => page.locator(sel).first().evaluate(el => getComputedStyle(el).backgroundColor);
  const fundoPago = await fundoDe('#contrCronoCorpo .contr-crono-cel.paga');
  const fundoPendente = await fundoDe('#contrCronoCorpo .contr-crono-cel.pendente');
  assert.notEqual(fundoPago, fundoPendente, 'paga e não paga precisam ter fundos diferentes');
  for (const fundo of [fundoPago, fundoPendente]) {
    assert.notEqual(fundo, 'rgba(0, 0, 0, 0)', 'os dois estados devem pintar um fundo visível');
    assert.notEqual(fundo, 'transparent', 'os estados não podem desaparecer por transparência');
  }
  assert.match(await page.locator('#contrCronoCorpo .contr-crono-cel.paga').last().locator('button').getAttribute('title'), /paga/i);
  const semPendencia = page.locator('#contrCronoCorpo .contr-crono-cel.sem-pendencia[title="Sem parcela neste mês"]').first();
  assert.equal(await semPendencia.locator('[aria-hidden="true"]').innerText(), '—', 'mês sem parcela deve ter um estado neutro explícito');
  assert.match(await semPendencia.locator('.sr-only').innerText(), /Sem parcela/i);
  assert.equal(await page.locator('#contrCronoCorpo .contr-crono-cel.pendente').first().locator('.contr-crono-status').innerText(), '3/48');
  assert.match(await page.locator('#contrCronoResumo').innerText(), /Parcelas futuras/i);
  assert.match(await page.locator('#contrCronoResumo').innerText(), /Verde: paga/i);
  assert.match(await page.locator('#contrCronoResumo').innerText(), /Vermelho: não paga/i);
  assert.doesNotMatch(await page.locator('#contrCronoResumo').innerText(), /Cinza/i, 'paga não tem legenda própria');
  assert.match(await page.locator('#contrCronoResumo').innerText(), /Sem parcela/i);
  assert.match(await page.locator('#contrCronoResumo').innerText(), /3/);
  assert.match(await page.locator('#contrCronoCab').innerText(), /Contrato/i);
  const progressoCarta = linhas.nth(0).locator('.contr-crono-progresso');
  const larguraMes = await page.locator('#contrCronoCab .contr-crono-mes').first().evaluate(el => el.getBoundingClientRect().width);
  assert.ok(larguraMes <= 82, `coluna mensal deve ser compacta; largura atual: ${larguraMes}px`);
  assert.match(await progressoCarta.innerText(), /02\/48/);
  assert.match(await progressoCarta.innerText(), /46 restantes/i);
  assert.equal(await progressoCarta.locator('[role="progressbar"]').getAttribute('aria-valuenow'), '2');

  // A busca do Cronograma é debounced (180 ms, `debounce(renderCronogramaContr)`): esperar o
  // re-render antes de contar as linhas, senão a asserção lê a grade anterior.
  await page.locator('#buscaCronoContr').fill('Carta atual');
  await page.waitForTimeout(400);
  assert.equal(await linhas.count(), 1, 'buscar pela descrição atual deve manter a série consolidada');
  assert.equal(await linhas.first().locator('.contr-crono-cel.pendente').count(), 2, 'parcelas com a descrição antiga devem continuar visíveis na série atual');
  // "Limpar filtros" e o multiselect de banco vivem DENTRO do painel de filtros do Cronograma
  // (botão "Filtros", prefixo `cronoContr`) — abrir o painel antes, como nas demais abas.
  const limparCrono = async () => {
    if (!(await page.locator('#cronoContrFiltrosPainel.aberto').count())) await abrirFiltros(page, 'cronoContr');
    await page.locator('#btnLimparCronoContr').click();
  };
  await limparCrono();
  await page.locator('#buscaCronoContr').fill('1042');
  await page.waitForTimeout(400);
  assert.equal(await linhas.count(), 1, 'a busca deve filtrar por carta/cota');
  assert.match(await linhas.first().innerText(), /Carta atual 1042/);
  await limparCrono();
  assert.equal(await linhas.count(), 2, 'limpar deve restaurar todos os contratos');
  if (!(await page.locator('#cronoContrFiltrosPainel.aberto').count())) await abrirFiltros(page, 'cronoContr');
  await page.locator('#fcrBanco .msel-btn').click();
  await page.locator('#fcrBanco .msel-item', { hasText: 'BB' }).locator('input').check();
  assert.equal(await linhas.count(), 1, 'o filtro de banco deve limitar o cronograma');
  assert.match(await linhas.first().innerText(), /Empréstimo 77/);
  await limparCrono();
  await fecharFiltros(page, 'cronoContr');

  await page.evaluate(() => {
    const originais = CONTRATOS.slice();
    CONTRATOS = Array.from({ length: 18 }, (_, i) => originais.map(c => ({ ...c, id: `${c.id}-${i}`, serieId: `${c.serieId}-${i}`, grupo: c.grupo ? `${c.grupo}-${i}` : c.grupo, cota: c.cota ? `${c.cota}-${i}` : c.cota, material: `${c.material} ${i + 1}` }))).flat();
    renderCronogramaContr();
  });
  const grade = page.locator('#contrCronoWrap');
  const areaGrade = await grade.boundingBox();
  assert.ok(areaGrade && areaGrade.height > 350, 'a planilha deve ocupar a maior parte da altura disponível');
  assert.ok(areaGrade && areaGrade.y + areaGrade.height <= 900, 'a planilha deve permanecer inteira dentro da página');
  assert.equal(await grade.evaluate(el => el.scrollHeight > el.clientHeight), true, 'a planilha deve ter rolagem vertical própria');
  assert.equal(await grade.evaluate(el => el.scrollWidth > el.clientWidth), true, 'a planilha deve ter rolagem horizontal própria');
  await grade.hover();
  const paginaAntes = await page.evaluate(() => scrollY);
  await page.mouse.wheel(0, 500);
  await page.waitForTimeout(100);
  assert.ok(await grade.evaluate(el => el.scrollTop) > 0, 'a roda deve mover as linhas dentro da planilha');
  assert.equal(await page.evaluate(() => scrollY), paginaAntes, 'a roda sobre a planilha não deve mover a página');
  await grade.evaluate(el => { el.scrollLeft = el.scrollWidth; });
  assert.ok(await grade.evaluate(el => el.scrollLeft) > 0, 'a barra horizontal deve mover a planilha');
  assert.equal(await page.evaluate(() => scrollX), 0, 'a planilha não deve criar rolagem horizontal na página');

  const foco = page.locator('#contrCronoWrap');
  await foco.focus();
  assert.equal(await foco.getAttribute('role'), 'region');
  assert.match(await foco.getAttribute('aria-label'), /Cronograma mensal/);
  assert.equal(await foco.getAttribute('aria-describedby'), 'contrCronoInstrucao');
  await page.locator('#contratosSubtabs [data-sub="contr-parcelas"]').click();
  assert.equal(await page.locator('body').evaluate(el => el.classList.contains('cronograma-tela-cheia')), false, 'sair do cronograma deve restaurar o layout normal');
  assert.equal(erros.length, 0, 'erros de JS:\n' + erros.join('\n'));
  await page.close();
});

// Regressão do VAZAMENTO VISUAL do Cronograma (1.55.28): as células mensais apareciam
// pintadas POR CIMA das colunas fixas Contrato/Progresso na 1ª renderização/scroll
// horizontal (pintura de compositor obsoleta no Chromium; hover na linha "consertava").
// O teste valida o COMPORTAMENTO, não a implementação (nada de sticky/left/z-index):
// depois de rolar nos dois eixos, as colunas fixas seguem no mesmo lugar, o que responde
// ao hit-test na faixa fixa é sempre Contrato/Progresso (nunca um mês), cada linha fica
// alinhada entre as colunas fixas e as mensais, e a pintura é estável (screenshot antes e
// depois de uma repintura forçada tem de ser idêntico). Assim continua valendo se um dia
// o quadro virar dois painéis (plano B) — só o contrato visual é travado.
// ⚠️ NÃO é um detector determinístico do bug de compositor: em execução controlada com o
// z-index antigo (3/7, 02/09/2026, 3 rodadas) o teste PASSOU — elementFromPoint segue a
// ordem de empilhamento do spec (correta nos dois casos) e o screenshot captura um único
// frame de um defeito intermitente. Ele trava o contrato visual/comportamental; a prova de
// que a mitigação vale continua sendo a reprodução manual no navegador afetado.
// Exemplo de uso: npm run test:e2e  (ou: node --test e2e/browser.e2e.js)
test('colunas fixas do Cronograma cobrem as células mensais (regressão do vazamento visual)', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/contratos`, { waitUntil: 'load' });
  await page.locator('#contratosSubtabs').waitFor({ state: 'visible', timeout: 5000 });
  await page.evaluate(() => {
    // 24 séries longas (24 meses pagos + futuros) → rolagem horizontal E vertical, as duas
    // pré-condições do bug (as células mensais rolam por baixo das colunas fixas).
    const hoje = new Date();
    const br = (d) => String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0') + '/' + d.getFullYear();
    const noMes = (n) => new Date(hoje.getFullYear(), hoje.getMonth() + n, 10);
    CONTRATOS = Array.from({ length: 24 }, (_, s) => Array.from({ length: 30 }, (_, i) => ({
      id: `leak-${s}-${i}`, serieId: `serie-leak-${s}`, banco: 'Itaú', produto: 'Consórcio', empresa: 'NTE',
      material: `Carta vazamento ${900 + s}`, grupo: '90', cota: String(900 + s), parcela: `${String(i + 1).padStart(2, '0')}/54`,
      valorParcela: 1385.40, vencimento: br(noMes(i - 24)),
      ...(i < 24 ? { dataPagamento: br(noMes(i - 24)), valorPago: 1385.40 } : {}),
    }))).flat();
    renderCronogramaContr();
  });
  // Sem hover na grade em momento algum: o hover repinta a linha e mascararia o defeito.
  await page.mouse.move(1439, 899);
  await page.locator('#contratosSubtabs [data-sub="contr-cronograma"]').click();
  await page.locator('#contrCronoCorpo .contr-crono-progresso').first().waitFor({ state: 'visible' });

  const grade = page.locator('#contrCronoWrap');
  assert.equal(await grade.evaluate((el) => el.scrollWidth > el.clientWidth && el.scrollHeight > el.clientHeight), true, 'pré-condição: a grade precisa rolar nos dois eixos');

  // Geometria da faixa fixa (Contrato + Progresso) medida ANTES de qualquer rolagem: é a
  // referência que a rolagem não pode mover.
  const faixaFixa = async () => {
    const g = await grade.boundingBox();
    const id = await page.locator('#contrCronoCorpo .contr-crono-id').first().boundingBox();
    const prog = await page.locator('#contrCronoCorpo .contr-crono-progresso').first().boundingBox();
    return { g, id, prog, fim: prog.x + prog.width };
  };
  const ref = await faixaFixa();
  assert.ok(Math.abs(ref.id.x - ref.g.x) <= 2, `Contrato deve encostar na borda esquerda da grade; desvio: ${ref.id.x - ref.g.x}px`);
  assert.ok(Math.abs(ref.prog.x - (ref.id.x + ref.id.width)) <= 1.5, 'Progresso deve ficar colado ao Contrato');

  // O que está por cima em cada ponto da faixa fixa tem de ser uma célula fixa (corpo ou
  // cabeçalho) — nunca uma célula mensal. Amostra várias linhas visíveis e várias colunas x.
  const conferirFaixa = async (rotulo) => {
    const f = await faixaFixa();
    assert.ok(Math.abs(f.id.x - ref.id.x) <= 1 && Math.abs(f.prog.x - ref.prog.x) <= 1, `${rotulo}: as colunas fixas não podem se deslocar com a rolagem`);
    const xs = [f.id.x + 8, f.id.x + f.id.width / 2, f.prog.x + 4, f.prog.x + f.prog.width / 2, f.fim - 3];
    const vazamentos = await page.evaluate(([xs, gy, gh]) => {
      const ruins = [];
      for (let y = gy + 6; y < gy + gh - 20; y += 22) {
        for (const x of xs) {
          const el = document.elementFromPoint(x, y);
          if (!el) continue;
          const fixo = el.closest('.contr-crono-id, .contr-crono-progresso, .contr-crono-progresso-cab');
          const mensal = el.closest('.contr-crono-cel, .contr-crono-mes');
          if (!fixo || mensal) ruins.push(`${Math.round(x)},${Math.round(y)} → ${el.className || el.tagName}`);
        }
      }
      return ruins;
    }, [xs, f.g.y, Math.min(f.g.height, 600)]);
    assert.deepEqual(vazamentos, [], `${rotulo}: célula mensal respondendo por cima da faixa fixa:\n` + vazamentos.join('\n'));
  };
  // Cada linha tem de ficar alinhada entre Contrato, Progresso e a 1ª célula mensal.
  const conferirAlinhamento = async (rotulo) => {
    const desalinhadas = await page.evaluate(() => {
      const ruins = [];
      document.querySelectorAll('#contrCronoCorpo tr').forEach((tr, i) => {
        const a = tr.querySelector('.contr-crono-id')?.getBoundingClientRect();
        const b = tr.querySelector('.contr-crono-progresso')?.getBoundingClientRect();
        const c = tr.querySelector('.contr-crono-cel')?.getBoundingClientRect();
        if (!a || !b || !c) { ruins.push(`linha ${i}: célula ausente`); return; }
        if (Math.abs(a.top - b.top) > 1 || Math.abs(a.top - c.top) > 1 || Math.abs(a.height - b.height) > 1 || Math.abs(a.height - c.height) > 1) ruins.push(`linha ${i}: tops ${a.top}/${b.top}/${c.top} alturas ${a.height}/${b.height}/${c.height}`);
      });
      return ruins;
    });
    assert.deepEqual(desalinhadas, [], `${rotulo}: linhas desalinhadas entre colunas fixas e mensais:\n` + desalinhadas.join('\n'));
  };

  await conferirFaixa('sem rolar');
  await conferirAlinhamento('sem rolar');
  // Rolagem programática (sem mouse) na horizontal, ao meio e ao fim.
  await grade.evaluate((el) => { el.scrollLeft = Math.floor(el.scrollWidth / 2); });
  await page.waitForTimeout(150);
  await conferirFaixa('rolado à metade');
  await conferirAlinhamento('rolado à metade');
  await grade.evaluate((el) => { el.scrollLeft = el.scrollWidth; });
  await page.waitForTimeout(150);
  await conferirFaixa('rolado ao fim');
  // E na vertical, com a horizontal ainda deslocada.
  await grade.evaluate((el) => { el.scrollTop = Math.floor(el.scrollHeight / 3); });
  await page.waitForTimeout(150);
  await conferirFaixa('rolado nos dois eixos');
  await conferirAlinhamento('rolado nos dois eixos');

  // Pintura estável: screenshot da faixa fixa ANTES e DEPOIS de forçar repintura das
  // células fixas tem que ser idêntico — se divergir, o que estava na tela era pintura
  // obsoleta (exatamente o sintoma que o usuário via e o hover "consertava").
  const f = await faixaFixa();
  const faixa = { x: f.g.x, y: f.g.y, width: Math.round(f.fim - f.g.x) + 4, height: Math.min(f.g.height, 400) };
  const antes = await page.screenshot({ clip: faixa });
  await page.evaluate(() => {
    const tds = document.querySelectorAll('#contrCronoCorpo .contr-crono-progresso, #contrCronoCorpo .contr-crono-id');
    tds.forEach((td) => { td.style.backgroundColor = 'rgb(254,254,254)'; });
    return new Promise((r) => requestAnimationFrame(() => { tds.forEach((td) => { td.style.backgroundColor = ''; }); requestAnimationFrame(() => setTimeout(r, 80)); }));
  });
  const depois = await page.screenshot({ clip: faixa });
  const dif = await page.evaluate(async ([da, db]) => {
    const load = (src) => new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.src = src; });
    const [ia, ib] = await Promise.all([load(da), load(db)]);
    const c = document.createElement('canvas'); c.width = ia.width; c.height = ia.height; const x = c.getContext('2d');
    x.drawImage(ia, 0, 0); const pa = x.getImageData(0, 0, c.width, c.height).data;
    x.clearRect(0, 0, c.width, c.height); x.drawImage(ib, 0, 0); const pb = x.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < pa.length; i += 4) if (Math.abs(pa[i] - pb[i]) + Math.abs(pa[i + 1] - pb[i + 1]) + Math.abs(pa[i + 2] - pb[i + 2]) > 24) n++;
    return n;
  }, ['data:image/png;base64,' + antes.toString('base64'), 'data:image/png;base64,' + depois.toString('base64')]);
  assert.equal(dif, 0, `a faixa das colunas fixas mudou após repintura forçada (${dif}px) — havia pintura obsoleta na tela`);

  assert.equal(erros.length, 0, 'erros de JS:\n' + erros.join('\n'));
  await page.close();
});

test('aviso de nova versão mostra todas as alterações sem truncar a lista', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(PAINEL, { waitUntil: 'load' });
  await page.locator('#sidebar').waitFor({ state: 'visible', timeout: 5000 });
  const mudancas = Array.from({ length: 7 }, (_, i) => `Alteração visível ${i + 1}`);
  await page.evaluate((itens) => {
    mostrarAvisoVersao({ versao: '9.9.9', data: '15/07/2026', mudancas: itens, obrigatoria: false });
  }, mudancas);
  await page.locator('#updateBanner:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#updateInfo .update-lista li').count(), mudancas.length);
  assert.deepEqual(await page.locator('#updateInfo .update-lista li').allInnerTexts(), mudancas);
  // Changelog curto (o caso comum) continua um cartão compacto: nada de rolagem interna
  // nem degradê de "tem mais para ler" onde a lista já cabe inteira.
  const compacto = await page.evaluate(() => {
    const lista = document.querySelector('#updateInfo .update-lista');
    return {
      rolavel: lista.scrollHeight > lista.clientHeight + 1,
      dica: document.getElementById('updateInfo').classList.contains('tem-mais'),
      altura: document.getElementById('updateBanner').offsetHeight,
    };
  });
  assert.equal(compacto.rolavel, false, 'uma lista curta não deve criar rolagem interna');
  assert.equal(compacto.dica, false, 'sem conteúdo escondido não deve aparecer o degradê');
  assert.ok(compacto.altura < 400, `com poucas linhas o aviso deve seguir compacto (${compacto.altura}px)`);

  // Um deploy pode consolidar várias versões: a lista fica longa e as linhas, compridas.
  // O banner tem de continuar DENTRO da tela (antes ele crescia para cima e o título/os
  // botões saíam pela borda de cima) — quem rola é a lista, não o card.
  const longas = Array.from({ length: 14 }, (_, i) =>
    `Alteração longa ${i + 1}: ${'texto de changelog bem comprido para forçar várias linhas '.repeat(4)}`);
  const caber = async (rotulo) => {
    const fora = await page.evaluate(() => {
      const b = document.getElementById('updateBanner').getBoundingClientRect();
      const btn = document.getElementById('btnAtualizarAgora').getBoundingClientRect();
      const lista = document.querySelector('#updateInfo .update-lista');
      return {
        topo: Math.round(b.top), base: Math.round(b.bottom),
        dirBtn: Math.round(btn.right), baseBtn: Math.round(btn.bottom),
        alturaJanela: window.innerHeight, larguraJanela: window.innerWidth,
        rolavel: lista.scrollHeight > lista.clientHeight + 1,
        rolagemPagina: document.documentElement.scrollWidth > window.innerWidth,
      };
    });
    assert.ok(fora.topo >= 0, `${rotulo}: o topo do aviso não deve sair da tela (top=${fora.topo})`);
    assert.ok(fora.base <= fora.alturaJanela + 1, `${rotulo}: o aviso não deve passar do rodapé (bottom=${fora.base}/${fora.alturaJanela})`);
    assert.ok(fora.baseBtn <= fora.alturaJanela + 1 && fora.dirBtn <= fora.larguraJanela + 1,
      `${rotulo}: o botão "Atualizar agora" tem de ficar visível na tela`);
    assert.equal(fora.rolagemPagina, false, `${rotulo}: o aviso não deve criar rolagem horizontal na página`);
    assert.equal(fora.rolavel, true, `${rotulo}: a lista de mudanças deve rolar por dentro`);
  };
  // (ago/2026: o laço rodava também em 390×844; a variante de celular saiu com o visual mobile.)
  for (const [rotulo, viewport] of [['desktop', { width: 1280, height: 800 }]]) {
    await page.setViewportSize(viewport);
    await page.evaluate((itens) => {
      mostrarAvisoVersao({ versao: '9.9.9', data: '15/07/2026', mudancas: itens, obrigatoria: false });
    }, longas);
    await page.locator('#updateBanner:not([hidden])').waitFor({ state: 'visible' });
    await caber(rotulo);
    assert.equal(await page.locator('#updateInfo').evaluate((el) => el.classList.contains('tem-mais')), true,
      `${rotulo}: com a lista cortada o degradê deve avisar que há mais para ler`);
    // rolar a lista até o fim não pode levar embora a versão/data nem os botões
    await page.locator('#updateInfo .update-lista').evaluate((el) => { el.scrollTop = el.scrollHeight; });
    // o degradê apaga no evento de scroll (um quadro depois), daí o waitForFunction
    await page.waitForFunction(() => !document.getElementById('updateInfo').classList.contains('tem-mais'),
      null, { timeout: 2000 }).catch(() => { throw new Error(`${rotulo}: no fim da lista o degradê deve apagar`); });
    assert.equal(await page.locator('#updateInfo .update-versao').isVisible(), true, `${rotulo}: a versão deve continuar visível ao rolar a lista`);
    assert.equal(await page.locator('#btnLembrarDepois').isVisible(), true, `${rotulo}: "Lembrar depois" deve continuar visível ao rolar a lista`);
    await caber(rotulo + ' (após rolar)');
  }
  await page.locator('#btnLembrarDepois').click();
  await page.setViewportSize({ width: 1280, height: 800 });

  const atuais = await page.evaluate(async () => (await (await fetch('/api/versao')).json()).mudancas);
  await page.locator('#btnChangelog').click();
  await page.locator('#changelogModal:not([hidden])').waitFor({ state: 'visible' });
  // O quadro ABRE antes de a lista chegar: desde a 1.50.18 o histórico saiu do /api/versao e é
  // buscado só ao abrir (/api/changelog). Medir na abertura pega a lista ainda vazia.
  await page.locator('#changelogLista .changelog-item.atual li').first().waitFor({ state: 'attached', timeout: 5000 });
  assert.deepEqual(await page.locator('#changelogLista .changelog-item.atual li').allInnerTexts(), atuais);
  assert.equal(await page.locator('#changelogLista .changelog-item.atual .changelog-autor').innerText(), 'por Juan Balbino');
  const autores = await page.locator('#changelogLista .changelog-autor').allInnerTexts();
  assert.ok(autores.every((autor) => autor !== 'por Codex'), 'o nome da ferramenta não deve aparecer como autor');
  await page.close();
});

test('formulário de admissão usa a logo da empresa e cabe no celular', async () => {
  const criarConvite = async (nome, empresa) => {
    const r = await fetch(`${BASE}/api/admissao`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ORIG },
      body: JSON.stringify({ nome, empresa, dias: 7 }),
    });
    assert.equal(r.status, 201);
    return (await r.json()).admissao;
  };

  const nte = await criarConvite('Candidato NTE E2E', 'NTE');
  const sul = await criarConvite('Candidato SUL E2E', 'SUL');
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));

  await page.goto(`${BASE}/admissao/${nte.token}`, { waitUntil: 'load' });
  await page.locator('#form-main').waitFor({ state: 'visible' });
  assert.match(await page.locator('#empresa-logo').getAttribute('src'), /logo-nte\.png$/);
  assert.equal(await page.locator('#empresa-logo').getAttribute('alt'), 'Logo da Norte Engenharia');

  await page.goto(`${BASE}/admissao/${sul.token}`, { waitUntil: 'load' });
  await page.locator('#form-main').waitFor({ state: 'visible' });
  assert.match(await page.locator('#empresa-logo').getAttribute('src'), /logo-sul\.png$/);
  assert.equal(await page.locator('#empresa-logo').getAttribute('alt'), 'Logo da Sul Empreendimentos');
  const semOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  assert.equal(semOverflow, true, 'o formulário não deve criar rolagem horizontal no celular');
  assert.equal(erros.length, 0, 'erros de JS no formulário:\n' + erros.join('\n'));
  await page.close();
});

test('Alt + D abre o novo cadastro da aba atual sem interromper a digitação', async () => {
  // A sidebar virou trilho + flyout e a topbar sumiu do desktop: `abrirAba` abre o grupo antes
  // de clicar na aba, e `clicarFora` usa a linha de título do conteúdo (#pageLinhaTitulo) no
  // lugar do #pageTitle escondido. O que este teste mede não mudou: com o foco num campo o
  // Alt+D é ignorado; fora dele, abre o cadastro DA ABA ATUAL.
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(PAINEL, { waitUntil: 'load' });
  await page.waitForFunction(() => !document.querySelector('#tabContratos').hidden);

  await abrirAba(page, 'frota');
  await page.locator('#frota.active').waitFor({ state: 'visible' });
  const busca = page.locator('#busca');
  await busca.fill('texto em edição');
  await busca.press('Alt+KeyD');
  assert.equal(await page.locator('#modal').isHidden(), true, 'o atalho não deve interromper um campo em edição');

  await clicarFora(page);
  await page.keyboard.press('Alt+KeyD');
  await page.locator('#modal:not([hidden])').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#modalTitulo').innerText(), 'Adicionar veículo');
  await page.locator('#fecharModal').click();

  await abrirAba(page, 'multas');
  await clicarFora(page);
  await page.keyboard.press('Alt+KeyD');
  await page.locator('#multaModal:not([hidden])').waitFor({ state: 'visible' });
  assert.match(await page.locator('#multaTitulo').innerText(), /Adicionar multa/i);
  await page.locator('#fecharMulta').click();

  await abrirAba(page, 'contratos');
  await clicarFora(page);
  await page.keyboard.press('Alt+KeyD');
  await page.locator('#contratoModal:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#contratoTitulo').innerText(), 'Novo lançamento');
  await page.waitForFunction(() => document.activeElement === document.querySelector('#formContrato [name="banco"]'));
  assert.equal(await page.locator('#btnAddContr').getAttribute('aria-keyshortcuts'), 'Alt+D');
  await page.locator('#fecharContrato').click();

  await abrirAba(page, 'instalacoes');
  await page.locator('#instSubtabs .subtab[data-sub="inst-envios"]').click();
  await clicarFora(page);
  await page.keyboard.press('Alt+KeyD');
  await page.locator('#envioModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#fecharEnvio').click();

  await abrirAba(page, 'controles');
  await page.locator('#controlesSubtabs .subtab[data-sub="ctrl-percentuais"]').click();
  await clicarFora(page);
  await page.keyboard.press('Alt+KeyD');
  await page.locator('#pctModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#fecharPct').click();

  await abrirAba(page, 'simulador');
  await clicarFora(page);
  await page.keyboard.press('Alt+KeyD');
  await page.waitForFunction(() => document.activeElement === document.querySelector('#simulador .subview.active .sim-form input'));

  await page.close();
});

test('Contratos altera a descrição de vários lançamentos pela barra de seleção', async () => {
  for (const material of ['Descrição lote E2E A', 'Descrição lote E2E B']) {
    const r = await fetch(`${BASE}/api/contratos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
      body: JSON.stringify({ banco: 'Banco Lote E2E', produto: 'Financiamento', material }),
    });
    assert.equal(r.status, 201);
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = []; page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/contratos`, { waitUntil: 'load' });
  await page.locator('#contratos.active').waitFor({ state: 'visible' });
  const linhas = page.locator('#corpoContr tr', { hasText: 'Descrição lote E2E' });
  await linhas.first().waitFor({ state: 'visible' });
  assert.equal(await linhas.count(), 2);
  // Desde a 1.53.32 não existe caixinha por linha: marcar é clicar na área livre da linha.
  // A 2ª célula é o Banco — texto puro, sem botão nem pílula.
  for (const linha of await linhas.all()) await linha.locator('td:nth-child(2)').click();
  assert.equal(await page.locator('#corpoContr tr.sel-on').count(), 2, 'as duas linhas ficam marcadas');

  const editar = page.locator('#selBarContrEditar');
  await editar.waitFor({ state: 'visible' });
  await editar.click();
  await page.locator('#loteContrModal:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#formLoteContr [name="material"]').count(), 1);
  const descricaoCompleta = 'L200 RMH6B12 - Carta 50 Mil - Contrato de consórcio com identificação completa do bem e observação extensa';
  await page.locator('#formLoteContr [name="material"]').fill(descricaoCompleta);
  const resposta = page.waitForResponse((resp) => resp.url().endsWith('/api/contratos/lote-editar') && resp.request().method() === 'POST');
  await page.locator('#formLoteContr button[type="submit"]').click();
  assert.equal((await resposta).status(), 200);
  await page.locator('#loteContrModal').waitFor({ state: 'hidden' });
  const linhasAtualizadas = page.locator('#corpoContr tr', { hasText: 'Banco Lote E2E' });
  await linhasAtualizadas.first().waitFor({ state: 'visible' });
  // nth-child(5) e não (6): com a coluna de seleção removida na 1.53.32, a Descrição andou uma
  // casa para a esquerda (Ações · Banco · Produto · Empresa · DESCRIÇÃO · Grupo/Cota).
  assert.deepEqual(await linhasAtualizadas.locator('td:nth-child(5)').allInnerTexts(), [descricaoCompleta, descricaoCompleta], 'a descrição inteira deve chegar à célula, sem o servidor resumir');
  const layoutDesktop = await page.evaluate(() => {
    const tabela = document.querySelector('#tabelaContr'), wrap = tabela.closest('.tabela-wrap');
    const celulas = [...tabela.querySelectorAll('th, tbody td')];
    return {
      todosCentralizados: celulas.every((celula) => getComputedStyle(celula).textAlign === 'center'),
      tabelaExpande: tabela.scrollWidth > wrap.clientWidth,
      // Corte ACIDENTAL. `.cel-trunc` corta de propósito (styles.css limita a 150px para a
      // tabela densa caber em 1366px) e devolve o texto inteiro no title — esse é o contrato,
      // e é conferido logo abaixo. Qualquer OUTRA célula que esconda conteúdo é defeito.
      // Lista em vez de booleano: quando falha, a mensagem já diz QUAL célula.
      cortadas: celulas.filter((c) => c.scrollWidth > c.clientWidth && !c.classList.contains('cel-trunc'))
        .map((c) => `${c.tagName}.${c.className || '-'} ${c.scrollWidth}>${c.clientWidth} "${(c.innerText || '').slice(0, 30)}"`),
      // o contrato do truncamento deliberado: nada se perde, o texto inteiro fica no title
      truncadasComTitle: celulas.filter((c) => c.classList.contains('cel-trunc'))
        .every((c) => (c.getAttribute('title') || '') === (c.innerText || '').trim()),
      paginaCabe: document.documentElement.scrollWidth <= window.innerWidth,
    };
  });
  assert.equal(layoutDesktop.todosCentralizados, true, 'todos os cabeçalhos e dados devem ficar centralizados no desktop');
  assert.equal(layoutDesktop.tabelaExpande, true, 'a tabela deve crescer conforme o maior conteúdo e usar rolagem interna');
  assert.deepEqual(layoutDesktop.cortadas, [], 'nenhuma célula deve esconder informação por acidente');
  assert.equal(layoutDesktop.truncadasComTitle, true, 'a célula truncada de propósito deve manter o texto inteiro no title');
  assert.equal(layoutDesktop.paginaCabe, true, 'a tabela larga não deve criar rolagem na página');
  // (ago/2026: a seção de celular saiu junto com o visual mobile — voltará com o novo layout.)
  assert.equal(erros.length, 0, 'erros de JS: ' + erros.join('\n'));
  await page.close();
});

test('abas Senhas e Documentos funcionam no navegador', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: BASE });
  const erros = []; page.on('pageerror', e => erros.push(String(e)));
  await page.goto(PAINEL, { waitUntil: 'load' });
  await abrirAba(page, 'senhas');
  await page.locator('#senhas.active').waitFor({ state: 'visible' });
  await page.locator('#btnAddSenha').click();
  assert.equal(await page.locator('#formSenha [required]').count(), 0, 'nenhum campo da credencial deve ser obrigatório');
  await page.locator('#formSenha [name="servico"]').fill('Microsoft 365 E2E');
  assert.equal(await page.locator('#senhaCategoriaCampo').inputValue(), '', 'uma nova credencial não deve vir com categoria preenchida');
  await escolherNoSelect(page, page.locator('#senhaCategoriaCampo').locator('..').locator('.cs-btn'), '__outra__');
  await page.locator('#senhaCategoriaPersonalizada').waitFor({ state: 'visible' });
  assert.match(await page.locator('#senhaCategoriaPersonalizada').getAttribute('placeholder'), /digite ou busque/i);
  await page.locator('#senhaCategoriaPersonalizada').fill('Soft');
  await page.locator('.ac-menu:visible .ac-item', { hasText: 'Software' }).waitFor({ state: 'visible' });
  await page.locator('#senhaCategoriaPersonalizada').fill('Produtividade corporativa');
  await page.locator('#formSenha [name="usuario"]').fill('teste@empresa.com');
  await page.locator('#formSenha [name="senha"]').fill('Senha-E2E-123!');
  await page.locator('#formSenha [name="observacoes"]').fill('Acesso administrado pelo setor financeiro.');
  await page.locator('#formSenha button[type="submit"]').click();
  const card = page.locator('#senhaCards .empresa-card', { hasText: 'Microsoft 365 E2E' });
  await card.waitFor({ state: 'visible' });
  assert.equal(await card.locator('.empresa-tag').innerText(), 'PRODUTIVIDADE CORPORATIVA');
  assert.equal(await page.locator('#listaCategoriasSenhaFiltro option[value="Produtividade corporativa"]').count(), 1, 'a categoria personalizada deve entrar nas sugestões do filtro');
  assert.equal(await card.locator('.senha-observacao-badge').innerText(), 'Com observação');
  assert.match(await card.locator('.cofre-card-abrir').getAttribute('aria-label'), /com observação/i);
  await page.locator('#senhaCategoria').fill('Produtiv');
  await page.waitForFunction(() => document.querySelectorAll('#senhaCards .cofre-card').length === 1);
  await page.locator('#senhaCategoria').fill('');
  await card.locator('.cofre-card-abrir').click();
  await page.locator('#senhaModal:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#formSenha [name="servico"]').inputValue(), 'Microsoft 365 E2E');
  const senhaEdicao = page.locator('#formSenha [name="senha"]');
  await page.waitForFunction(() => document.querySelector('#formSenha [name="senha"]')?.value === 'Senha-E2E-123!');
  // O campo é type="text" com máscara por CSS, nunca type="password" (de propósito: assim o
  // navegador não oferece "Salvar senha?" — ver ocultarSenhaModal no app.js). Então o que se mede
  // aqui é o EFEITO: ninguém consegue ler a senha carregada até clicar no olho.
  assert.equal(await senhaEdicao.evaluate((el) => getComputedStyle(el).webkitTextSecurity), 'disc',
    'a senha atual deve permanecer mascarada no formulário');
  const olhoSenha = page.locator('#btnRevelarSenhaModal');
  assert.equal(await olhoSenha.getAttribute('aria-label'), 'Mostrar senha');
  await olhoSenha.click();
  assert.equal(await senhaEdicao.evaluate((el) => getComputedStyle(el).webkitTextSecurity), 'none',
    'o olho deve revelar a senha digitada');
  assert.equal(await olhoSenha.getAttribute('aria-label'), 'Ocultar senha');
  await olhoSenha.click();
  assert.equal(await senhaEdicao.evaluate((el) => getComputedStyle(el).webkitTextSecurity), 'disc',
    'o olho deve voltar a esconder a senha');
  assert.match(await page.locator('#senhaAjudaEdicao').innerText(), /senha atual carregada/i);
  await page.locator('#cancelarSenhaModal').click();
  assert.match(await card.locator('.senha-valor').innerText(), /•/);
  const editarSenha = card.locator('.empresa-acao-icone.editar'), excluirSenha = card.locator('[data-acao="excluir"]');
  assert.equal(await editarSenha.getAttribute('aria-label'), 'Editar credencial Microsoft 365 E2E');
  assert.equal(await excluirSenha.getAttribute('aria-label'), 'Excluir credencial Microsoft 365 E2E');
  assert.equal(await editarSenha.locator('svg').count(), 1, 'editar deve usar ícone vetorial');
  assert.equal(await excluirSenha.locator('.lixeira-tampa').count(), 1, 'excluir deve usar a lixeira padronizada');
  await page.waitForTimeout(800); // deixa o evento de tempo real do próprio cadastro terminar antes das ações do cofre
  await card.locator('[data-acao="revelar"]').click();
  await page.waitForFunction(() => document.querySelector('#senhaCards .senha-valor')?.textContent === 'Senha-E2E-123!');
  assert.equal(await card.locator('.senha-valor').innerText(), 'Senha-E2E-123!');
  await card.locator('[data-acao="ocultar"]').evaluate(el => el.click());
  assert.match(await card.locator('.senha-valor').innerText(), /•/, 'ocultar deve mascarar a senha novamente');
  await card.locator('[data-acao="copiar"]').click();
  await page.waitForFunction(async () => (await navigator.clipboard.readText()) === 'Senha-E2E-123!');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'Senha-E2E-123!', 'copiar deve enviar somente a senha para a área de transferência');

  // Categorias personalizadas podem ser renomeadas em cascata e excluídas sem apagar a credencial.
  await editarSenha.click();
  await page.locator('#btnGerenciarCategorias').click();
  let categoria = page.locator('#categoriasSenhaLista [data-categoria="Produtividade corporativa"]');
  await categoria.locator('input').fill('Ferramentas internas');
  await categoria.locator('[data-cat-acao="salvar"]').click();
  categoria = page.locator('#categoriasSenhaLista [data-categoria="Ferramentas internas"]');
  await categoria.waitFor({ state: 'visible' });
  assert.equal(await categoria.locator('span').innerText(), '1 credencial(is)');
  await categoria.locator('[data-cat-acao="excluir"]').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  assert.match(await page.locator('#confirmTexto').innerText(), /movidas para “Sem categoria”/i);
  await page.locator('#confirmOk').click();
  await page.locator('#categoriasSenhaVazio').waitFor({ state: 'visible' });
  await page.locator('#concluirCategoriasSenha').click();
  await page.locator('#cancelarSenhaModal').click();
  assert.equal(await card.locator('.empresa-tag').innerText(), 'SEM CATEGORIA');

  const pngDoc = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fdDoc = new FormData(); fdDoc.append('arquivo', new Blob([pngDoc], { type: 'image/png' }), 'documento-visual.png');
  let rDoc = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: ORIG, body: fdDoc });
  assert.equal(rDoc.status, 201); const arquivoDoc = await rDoc.json();
  // Documentos deixaram de ser organizados por EMPRESA fixa: são pastas livres (commit 79e6f70) e
  // cada documento aponta para a pasta em que foi enviado (pastaId), podendo aninhar subpastas.
  const criarPastaDoc = async (nome) => {
    const r = await fetch(`${BASE}/api/documentos/pastas`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ nome }),
    });
    assert.equal(r.status, 201, `pasta de documentos "${nome}" deveria ser criada`);
    return r.json();
  };
  const pastaInst = await criarPastaDoc('Institucional E2E');
  const pastaLic = await criarPastaDoc('Licenças E2E');
  rDoc = await fetch(`${BASE}/api/documentos`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ pastaId: pastaInst.id, titulo: 'Documento Visual E2E', categoria: 'Institucional', arquivo: arquivoDoc }) });
  assert.equal(rDoc.status, 201);
  const fdDocSul = new FormData(); fdDocSul.append('arquivo', new Blob([pngDoc], { type: 'image/png' }), 'licenca-sul.png');
  rDoc = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: ORIG, body: fdDocSul });
  assert.equal(rDoc.status, 201); const arquivoDocSul = await rDoc.json();
  rDoc = await fetch(`${BASE}/api/documentos`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ pastaId: pastaLic.id, titulo: 'Licença SUL E2E', categoria: 'Licença', validade: '2020-01-01', arquivo: arquivoDocSul }) });
  assert.equal(rDoc.status, 201);

  await abrirAba(page, 'documentos');
  await page.locator('#documentos.active').waitFor({ state: 'visible' });
  const cartaoInst = page.locator(`#documentoPastas [data-pasta-id="${pastaInst.id}"]`);
  const cartaoLic = page.locator(`#documentoPastas [data-pasta-id="${pastaLic.id}"]`);
  await cartaoInst.waitFor({ state: 'visible' });
  await cartaoLic.waitFor({ state: 'visible' });
  const caixaPasta = await cartaoInst.boundingBox();
  assert.ok(caixaPasta && Math.abs(caixaPasta.width - caixaPasta.height) <= 2 && caixaPasta.width <= 242, 'o cartão da pasta deve ser quadrado e não esticar no desktop');
  assert.match(await cartaoInst.innerText(), /1 item/i, 'o cartão deve resumir o que existe na pasta');
  assert.match(await cartaoLic.locator('.doc-emp-alerta.vencido').innerText(), /vencido/i, 'o cartão deve sinalizar documentos vencidos');
  // A régua de toque é conferida no celular; o desktop usa controles compactos do DS.
  await page.setViewportSize({ width: 390, height: 844 });
  // Trocar o viewport não deixa o layout pronto no mesmo tick (o app re-renderiza no resize), e
  // medir na hora dá falso negativo: mede-se por polling, como o cofre faz mais acima.
  const esperarAlvoDeToque = (seletor, rotulo) => page.waitForFunction((s) => {
    const el = document.querySelector(s);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 40 && r.height >= 40;
  }, seletor).catch(() => { throw new Error(`${rotulo} deve ter alvo de toque de 40px`); });

  const renomearPasta = cartaoInst.locator('[data-pasta-acao="renomear"]');
  assert.equal(await renomearPasta.getAttribute('aria-label'), 'Renomear pasta Institucional E2E');
  await esperarAlvoDeToque(`#documentoPastas [data-pasta-id="${pastaInst.id}"] [data-pasta-acao="renomear"]`, 'renomear pasta');
  await renomearPasta.click();
  await page.locator('#pastaDocumentoModal:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#formPastaDocumento [name="nome"]').inputValue(), 'Institucional E2E');
  await page.locator('#formPastaDocumento [name="nome"]').fill('Institucional NTE E2E');
  await page.locator('#formPastaDocumento button[type="submit"]').click();
  await page.locator('#pastaDocumentoModal').waitFor({ state: 'hidden' });
  assert.match(await cartaoInst.innerText(), /Institucional NTE E2E/, 'o cartão deve passar a exibir o novo nome');
  assert.equal(await page.locator('#documentoPastas .doc-emp-corpo strong', { hasText: 'Institucional E2E' }).count(), 0, 'o nome antigo não deve continuar na lista');
  await cartaoInst.locator('[data-abrir-pasta]').click();
  await page.locator('#documentoPastaHead:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#documentoTitulo').innerText(), 'Institucional NTE E2E');
  const docCard = page.locator('#documentoCards .documento-card', { hasText: 'Documento Visual E2E' });
  await docCard.waitFor({ state: 'visible' });
  assert.equal(await page.locator('#documentoCards .documento-card', { hasText: 'Licença SUL E2E' }).count(), 0, 'a pasta deve mostrar somente os documentos dela');
  // O envio herda a pasta ABERTA (era "herdar a empresa aberta"): o destino aparece no modal.
  await page.locator('#btnAddDocumento').click();
  await page.locator('#documentoModal:not([hidden])').waitFor({ state: 'visible' });
  assert.match(await page.locator('#documentoDestino').innerText(), /Institucional NTE E2E/, 'o envio deve herdar a pasta aberta');
  await page.locator('#cancelarDocumentoModal').click();
  // As ações do documento agora são botões COM TEXTO (não mais ícones com aria-label).
  const acoesDoc = docCard.locator('.empresa-acoes');
  assert.deepEqual(await acoesDoc.locator('a, button').allInnerTexts(), ['Baixar', 'Mover', 'Editar', 'Excluir'],
    'o cartão deve oferecer baixar, mover, editar e excluir, cada um com rótulo visível');
  for (const acao of ['mover', 'editar', 'excluir']) {
    await esperarAlvoDeToque(`#documentoCards .documento-card [data-acao="${acao}"]`, acao);
  }
  await page.locator('#documentoVoltar').click();
  await cartaoLic.locator('[data-abrir-pasta]').click();
  await page.locator('#documentoCards .documento-card', { hasText: 'Licença SUL E2E' }).waitFor({ state: 'visible' });
  assert.equal(await page.locator('#documentoCards .documento-card', { hasText: 'Documento Visual E2E' }).count(), 0, 'trocar de pasta não deve misturar documentos');
  await page.setViewportSize({ width: 1280, height: 800 });
  const caixa = await page.locator('#documentos').boundingBox();
  assert.ok(caixa && caixa.width <= 1280, 'a aba Documentos não deve estourar a largura da janela');
  assert.equal(erros.length, 0, 'erros de JS: ' + erros.join('\n'));
});

test('Frota clona um veículo preservando dados reutilizáveis e limpando identificadores', async () => {
  const original = {
    placa: 'CLN0001', modelo: 'SUV TESTE', versao: '2.0 Turbo', anoFab: 2026, anoMod: 2027,
    cor: 'Prata', motor: '2.0', tanque: 55, centroCusto: 'OBRA TESTE', dono: 'NTE',
    renavam: '12345678901', chassi: '9BRTESTE123456789', valorFipe: 150000,
    status: 'EM ATIVIDADE', gravame: 'NADA CONSTA', pctRicardo: 0.75, pctMarcelo: 0.25,
    oficinaDataEntrada: '2026-09-28', oficinaPrevisaoSaida: '2026-10-05',
    oficinaValorOrcamento: 1250.5, oficinaMotivo: 'Troca de embreagem',
    crlvDoc: { id: 'MD-nao-copiar', nome: 'crlv.pdf', tipo: 'application/pdf' },
  };
  let r = await fetch(`${BASE}/api/veiculos`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(original),
  });
  assert.equal(r.status, 201);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  // Clonar saiu da coluna AÇÕES (que ficou só com editar/excluir) e agora vive SÓ no menu de
  // botão direito da linha — é por lá que o fluxo inteiro tem de estar disponível.
  await page.locator('#corpoTabela tr[data-placa="CLN0001"] .clone').waitFor({ state: 'detached' });
  assert.equal(await page.locator('#corpoTabela tr[data-placa="CLN0001"] td.acoes button').count(), 2,
    'a coluna Ações da Frota deve ter apenas editar e excluir');
  await page.locator('#corpoTabela tr[data-placa="CLN0001"]').click({ button: 'right' });
  const clonarContexto = page.locator('#ctxMenu .ctx-clonar:not([hidden])');
  await clonarContexto.waitFor({ state: 'visible', timeout: 3000 });
  assert.match(await clonarContexto.innerText(), /Clonar veículo/);
  assert.equal(await clonarContexto.locator('svg').getAttribute('data-icon'), 'veiculos-clonados');
  // Dispara o botão já validado como visível; evita que o auto-scroll do Playwright feche o
  // menu fixed pelo listener global de scroll antes do clique sintético chegar ao elemento.
  await clonarContexto.evaluate(el => el.click());

  await page.locator('#modal:not([hidden])').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#modalTitulo').innerText(), 'Clonar veículo CLN0001');
  assert.equal(await page.locator('#formVeiculo [name="modelo"]').inputValue(), original.modelo);
  assert.equal(await page.locator('#formVeiculo [name="versao"]').inputValue(), original.versao);
  assert.equal(await page.locator('#formVeiculo [name="centroCusto"]').inputValue(), original.centroCusto);
  for (const campo of ['placa', 'renavam', 'chassi', 'oficinaDataEntrada', 'oficinaPrevisaoSaida', 'oficinaValorOrcamento', 'oficinaMotivo']) {
    assert.equal(await page.locator(`#formVeiculo [name="${campo}"]`).inputValue(), '', `${campo} não deve ser copiado`);
  }
  assert.equal(await page.locator('#veicCrlvNome').innerText(), 'Nenhum documento anexado.');

  await page.locator('#formVeiculo [name="placa"]').fill('CLN0002');
  await page.locator('#formVeiculo button[type="submit"]').click();
  await page.locator('#modal').waitFor({ state: 'hidden', timeout: 5000 });

  const veiculos = await (await fetch(`${BASE}/api/veiculos`)).json();
  const clone = veiculos.find(v => v.placa === 'CLN0002');
  assert.ok(clone, 'o novo veículo deve ser criado');
  assert.equal(clone.modelo, original.modelo);
  assert.equal(clone.versao, original.versao);
  assert.equal(clone.centroCusto, original.centroCusto);
  assert.equal(clone.renavam, '');
  assert.equal(clone.chassi, '');
  assert.equal(clone.crlvDoc, null);
  assert.equal(erros.length, 0, 'erros de JS ao clonar:\n' + erros.join('\n'));

  // Responsividade é conferida depois do fluxo contextual para que o evento de resize não feche
  // artificialmente o menu fixed durante o teste.
  await page.close();
});

test('Feedback aceita captura colada com Ctrl+V sem bloquear a colagem de texto', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/feedback`, { waitUntil: 'load' });
  await page.locator('#feedback.active').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#btnAddFeedback').click();
  await page.locator('#feedbackModal:not([hidden])').waitFor({ state: 'visible', timeout: 3000 });
  assert.match(await page.locator('#feedbackModal .midia-dica').innerText(), /Ctrl\s*\+\s*V/i);
  const titulo = page.locator('#formFeedback [name="titulo"]');
  const descricao = page.locator('#formFeedback [name="descricao"]');
  assert.equal(await titulo.getAttribute('minlength'), '10');
  assert.equal(await descricao.getAttribute('minlength'), '20');
  assert.equal(await descricao.getAttribute('required'), '');

  // Um paste contendo somente texto não pode ser interceptado pelo recurso de captura.
  const textoFoiBloqueado = await page.locator('#formFeedback [name="descricao"]').evaluate((alvo) => {
    const dados = new DataTransfer();
    dados.items.add('texto comum', 'text/plain');
    const evento = new ClipboardEvent('paste', { clipboardData: dados, bubbles: true, cancelable: true });
    alvo.dispatchEvent(evento);
    return evento.defaultPrevented;
  });
  assert.equal(textoFoiBloqueado, false, 'a colagem normal de texto deve continuar disponível');

  await titulo.fill('Feedback sem anexo');
  await descricao.fill('Descrição completa, mas ainda sem nenhuma imagem anexada.');
  await page.locator('#formFeedback button[type="submit"]').click();
  await page.locator('#feedbackModal:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#feedbackImgsGrade .midia-thumb').count(), 0, 'sem imagem o envio deve permanecer bloqueado');
  assert.match(await page.locator('#feedbackAnexoEstado').innerText(), /Obrigatório/i);

  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  const imagemFoiCapturada = await page.locator('#formFeedback [name="descricao"]').evaluate((alvo, b64) => {
    const binario = atob(b64);
    const bytes = Uint8Array.from(binario, c => c.charCodeAt(0));
    const dados = new DataTransfer();
    dados.items.add(new File([bytes], 'print.png', { type: 'image/png' }));
    const evento = new ClipboardEvent('paste', { clipboardData: dados, bubbles: true, cancelable: true });
    alvo.dispatchEvent(evento);
    return evento.defaultPrevented;
  }, pngBase64);
  assert.equal(imagemFoiCapturada, true, 'a captura deve ser reconhecida e assumir a colagem');
  await page.locator('#feedbackImgsGrade .midia-thumb').waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#feedbackImgsGrade .midia-thumb').count(), 1);
  assert.match(await page.locator('#feedbackImgsGrade .thumb-nome').getAttribute('title'), /captura-colada-\d+\.png/);

  await titulo.fill('Feedback com captura colada');
  await descricao.fill('Esta descrição detalha o problema mostrado na captura de tela.');
  await page.locator('#formFeedback button[type="submit"]').click();
  await page.locator('#feedbackModal').waitFor({ state: 'hidden', timeout: 8000 });
  const feedbacks = await (await fetch(`${BASE}/api/feedbacks`)).json();
  const salvo = feedbacks.find(f => f.titulo === 'Feedback com captura colada');
  assert.ok(salvo, 'o feedback deve ser salvo');
  assert.equal(salvo.imagens.length, 1, 'a captura colada deve ser enviada como anexo');
  assert.match(salvo.imagens[0].nome, /captura-colada-\d+\.png/);

  const excluir = page.locator(`.fb-card[data-id="${salvo.id}"] .fb-del`);
  await excluir.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await excluir.getAttribute('aria-label'), 'Excluir feedback Feedback com captura colada');
  await excluir.hover();
  await page.waitForFunction((id) => {
    const tampa = document.querySelector(`.fb-card[data-id="${id}"] .fb-del .lixeira-tampa`);
    return tampa && getComputedStyle(tampa).transform !== 'none';
  }, salvo.id);
  assert.notEqual(await excluir.locator('.lixeira-tampa').evaluate(el => getComputedStyle(el).transform), 'none', 'a tampa deve se mover no hover');

  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await excluir.locator('.lixeira-tampa').evaluate(el => getComputedStyle(el).transform), 'none', 'movimento deve ser removido quando o usuário prefere menos animação');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  assert.equal(erros.length, 0, 'erros de JS ao colar captura:\n' + erros.join('\n'));
  await fetch(`${BASE}/api/feedbacks/${encodeURIComponent(salvo.id)}`, { method: 'DELETE', headers: { ...ORIG } });
  await page.close();
});

test('Login exibe a marca Gestão RM e a opção de 30 dias com clareza e acessibilidade', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${BASE}/login.html`, { waitUntil: 'load' });

  assert.equal((await page.locator('.marca .marca-nome').innerText()).replace(/\s+/g, ' ').trim(), 'Gestão RM');
  assert.match(await page.locator('.rodape').innerText(), /GESTÃO RM · ACESSO SEGURO/i);
  assert.doesNotMatch(await page.locator('body').innerText(), /Núcleo RM/i, 'o login não deve exibir a identidade antiga');
  await assert.doesNotReject(async () => {
    await page.getByRole('heading', { name: /Sua operação inteira, sob controle/i }).waitFor({ state: 'visible' });
  }, 'o login deve apresentar o sistema como uma central de gestão completa');
  assert.match(await page.locator('.shell-meio p').innerText(), /Operação, pessoas, finanças e administração/i);
  assert.deepEqual(await page.locator('.shell-lista li').allInnerTexts(), [
    'Frota, multas e rastreadores', 'Pessoas, documentos e segurança', 'Contratos, custos e decisões',
  ]);
  assert.match(await page.locator('.access-note').innerText(), /somente as áreas liberadas para o seu perfil/i);

  // Desde o redesign (docs/DESIGN §10.1), o tile grafite de 42px usa a arte transparente
  // logo-rm.png como máscara. O favicon preenchido não serve como máscara do glifo.
  const marca = page.locator('.marca .marca-mark');
  await marca.waitFor({ state: 'visible', timeout: 5000 });
  const estiloMarca = await marca.evaluate(async (el) => {
    const estilo = getComputedStyle(el);
    const mascara = estilo.maskImage || estilo.webkitMaskImage || 'none';
    const url = mascara.match(/url\(["']?([^"')]+)["']?\)/)?.[1];
    const img = new Image();
    img.src = url || '';
    const desenhou = await img.decode().then(() => img.naturalWidth > 0 && img.naturalHeight > 0).catch(() => false);
    return {
      desenhou,
      mascara,
      escondidaDoLeitor: el.getAttribute('aria-hidden'),
      caixa: getComputedStyle(el.parentElement).width,
    };
  });
  assert.match(estiloMarca.mascara, /\/img\/logo-rm\.png/, 'a marca deve usar a engrenagem transparente do painel');
  assert.equal(estiloMarca.desenhou, true, 'o ícone da marca deve carregar de fato (nada de quadrado vazio)');
  assert.equal(estiloMarca.escondidaDoLeitor, 'true', 'a marca é decorativa e não deve ser lida duas vezes');
  assert.equal(estiloMarca.caixa, '42px', 'o símbolo deve ocupar o ladrilho definido no padrão de telas públicas');
  const icone = await fetch(`${BASE}/img/logo-rm.png`);
  assert.equal(icone.status, 200, 'o ícone precisa carregar antes da autenticação');

  const lembrar = page.getByRole('checkbox', { name: /Manter conectado por 30 dias/i });
  await lembrar.focus();
  await lembrar.press('Space');
  assert.equal(await lembrar.isChecked(), true);
  assert.match(await page.locator('.lembrar-copy small').innerText(), /dispositivo pessoal/i);
  assert.match(await lembrar.evaluate((el) => getComputedStyle(el).backgroundImage), /data:image\/svg\+xml/, 'o estado marcado deve desenhar o check');
  await lembrar.press('Space');
  assert.equal(await lembrar.isChecked(), false, 'a mesma tecla deve permitir desmarcar a opção');
  assert.equal(await lembrar.evaluate((el) => getComputedStyle(el).backgroundImage), 'none');

  await page.setViewportSize({ width: 360, height: 740 });
  const caixa = await page.locator('.card').boundingBox();
  const opcao = await page.locator('.lembrar').boundingBox();
  const faixa = await page.locator('.shell').boundingBox();
  assert.ok(caixa && caixa.x >= 0 && caixa.x + caixa.width <= 360, 'o cartão de login não deve estourar a tela');
  assert.ok(opcao && opcao.width <= caixa.width, 'a opção de 30 dias deve caber dentro do cartão');
  assert.ok(faixa && faixa.x >= 0 && faixa.x + faixa.width <= 360, 'a faixa institucional deve caber na tela do celular');
  assert.equal(await page.locator('.shell-meio').isVisible(), false, 'o painel institucional deve ficar compacto no celular');

  assert.equal(erros.length, 0, 'erros de JS na tela de login:\n' + erros.join('\n'));
  await page.close();
});

test('Funcionários mantém a faixa de alerta estável com poucas ou muitas pendências', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/funcionarios`, { waitUntil: 'load' });
  await page.locator('#funcionarios.active').waitFor({ state: 'visible', timeout: 5000 });

  // A aba se redesenha sozinha e apagaria a semeadura no meio da medição. Neutraliza-se o
  // re-render, nunca o componente que está sendo medido.
  await page.evaluate(() => { window.renderAlertasFunc = () => {}; });

  // Deixa o PRÓPRIO gerador montar o HTML (montarFaixaAlerta, app.js) em vez de injetar marcação
  // na mão: era isso que fazia este teste medir `.func-alerta-*`, um componente que o app deixou
  // de emitir na 1.53.32 — ele passava/falhava sobre CSS morto. O nome comprido do 2º item é de
  // propósito: é o caso que esticava a linha antes do `text-overflow`.
  const semear = (qtd) => page.evaluate((n) => {
    montarFaixaAlerta({
      host: document.getElementById('funcAlertas'),
      itens: Array.from({ length: n }, (_, i) => ({
        rotuloId: i === 1
          ? 'CARLOS DEMONSTRAÇÃO COM NOME MUITO COMPRIDO PARA CABER NA COLUNA'
          : `COLABORADOR DEMO ${i + 1}`,
        desc: 'ASO admissional · Segurança',
        info: i % 2 ? `Vence em ${i} d` : `Vencido há ${i * 5} d`,
        severidade: i % 2 ? 'warning' : 'error',
        onClick: () => {},
      })),
      singular: 'documento vencido ou a vencer',
      plural: 'documentos vencidos ou a vencer',
      sufixo: ' em até 30 dias',
      acaoSingular: 'documento',
      acaoPlural: 'documentos',
    });
  }, qtd);

  const caixaFaixa = () => page.locator('#funcAlertas .ds-alert').boundingBox();

  // 1) RECOLHIDA a faixa não muda de tamanho com a quantidade — é o herdeiro direto do contrato
  //    antigo ("o cartão mede o mesmo com poucos e com muitos"): o resumo não cresce.
  await semear(2);
  const comPoucas = await caixaFaixa();
  await semear(12);
  const comMuitas = await caixaFaixa();
  assert.ok(comPoucas && comMuitas, 'a faixa precisa estar visível nos dois casos');
  assert.ok(Math.abs(comPoucas.height - comMuitas.height) < 1,
    `a faixa recolhida deve manter a altura (2 itens: ${comPoucas.height}px, 12 itens: ${comMuitas.height}px)`);
  assert.ok(Math.abs(comPoucas.width - comMuitas.width) < 1, 'e a largura');

  // 2) EXPANDIDA, as linhas se mantêm alinhadas e do mesmo tamanho — inclusive a do nome
  //    comprido, que é cortado com reticências em vez de esticar a linha.
  await expandirFaixa(page, 'funcAlertas-ver');
  const linhas = await page.locator('#funcAlertas .ds-alert-linha').evaluateAll((els) => els.map((el) => {
    const linha = el.getBoundingClientRect();
    const desc = el.querySelector('.ds-alert-linha-desc').getBoundingClientRect();
    const id = el.querySelector('.ds-alert-linha-id');
    return { largura: linha.width, altura: linha.height, descX: desc.left, cortaNome: id.scrollWidth > id.clientWidth };
  }));
  assert.equal(linhas.length, 12);
  const espalha = (campo) => Math.max(...linhas.map((l) => l[campo])) - Math.min(...linhas.map((l) => l[campo]));
  assert.ok(espalha('altura') < 1, 'todas as linhas devem ter a mesma altura');
  assert.ok(espalha('largura') < 1, 'todas as linhas devem ter a mesma largura');
  assert.ok(espalha('descX') < 1, 'a descrição deve começar na mesma coluna em todas as linhas');
  assert.equal(linhas[1].cortaNome, true, 'o nome comprido deve ser cortado, não esticar a linha');

  // 3) A lista tem teto próprio: 12 pendências rolam dentro da faixa em vez de empurrar a tela.
  const lista = await page.locator('#funcAlertas .ds-alert-lista').evaluate((el) => ({
    altura: el.getBoundingClientRect().height, conteudo: el.scrollHeight,
  }));
  assert.ok(lista.conteudo > lista.altura, 'com 12 itens a lista deve rolar dentro da faixa');
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    'a faixa aberta não pode criar rolagem lateral na página');

  // 4) O tamanho não depende do tema. Só existem claro e escuro (as aparências decorativas
  //    saíram na consolidação de ago/2026 — `aplicarTema` cai em 'claro' para qualquer outro
  //    nome, e era isso que este laço vinha fazendo três vezes sem perceber).
  for (const tema of ['claro', 'escuro']) {
    await page.evaluate((t) => aplicarTema(t), tema);
    const noTema = await caixaFaixa();
    assert.ok(Math.abs(noTema.width - comMuitas.width) < 1, `a largura deve ser preservada no tema ${tema}`);
  }
  await page.evaluate(() => aplicarTema('claro'));

  // 5) Celular: a faixa cabe na tela. ⚠️ Abaixo de 768px o `.ds-alert` não recebe o CSS do
  //    Design System, então o que dá para exigir aqui é só isto — e é o que importa.
  //    A medida é da FAIXA, não da página: em 360px a aba Funcionários já estoura por conta de
  //    outros elementos (#funcFiltrosPainel, .func-adm-filtro, #ffAdmAte, #btnVisDesmob e
  //    #btnVisEncerrados chegam a 510px), o que é anterior a este componente e não é o que este
  //    teste cobre. Medir a página aqui transformaria este teste no detector daquele problema.
  await page.close();
});

test('Checkboxes simples seguem o mesmo padrão e a opção de dirigir fica bem alinhada', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/funcionarios`, { waitUntil: 'load' });
  await page.locator('#btnAddFunc').click();
  await page.locator('#funcModal:not([hidden])').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#funcTabs .func-tab[data-panel="cnh"]').click();
  await page.locator('#funcModal .func-tabpanel[data-panel="cnh"]:not([hidden])').waitFor({ state: 'visible' });

  const opcao = page.locator('#funcModal .func-check');
  const checkbox = opcao.locator('input[name="podeDirigir"]');
  const estilo = await checkbox.evaluate(el => {
    const s = getComputedStyle(el);
    return { width: s.width, height: s.height, appearance: s.appearance || s.webkitAppearance, radius: s.borderRadius };
  });
  // radius 4px = --ds-radius-sm (régua de controle do DS) — o 5px era resquício do
  // design antigo, alinhado na auditoria de aderência de ago/2026.
  assert.deepEqual(estilo, { width: '18px', height: '18px', appearance: 'none', radius: '4px' });
  const layout = await opcao.evaluate(el => {
    const s = getComputedStyle(el); const box = el.getBoundingClientRect();
    const cb = el.querySelector('input').getBoundingClientRect(); const txt = el.querySelector('span').getBoundingClientRect();
    return { direcao: s.flexDirection, altura: box.height, largura: box.width, desalinho: Math.abs((cb.top + cb.height / 2) - (txt.top + txt.height / 2)) };
  });
  assert.equal(layout.direcao, 'row');
  assert.ok(layout.altura >= 44, 'a linha inteira deve oferecer uma área de clique confortável');
  assert.ok(layout.desalinho < 2, 'checkbox e texto devem ficar centralizados na mesma linha');

  await opcao.click();
  assert.equal(await checkbox.isChecked(), true, 'clicar no texto também deve marcar a opção');
  await checkbox.focus();
  await checkbox.press('Space');
  assert.equal(await checkbox.isChecked(), false, 'a caixa deve continuar utilizável pelo teclado');

  const amostras = await page.evaluate(() => [
    document.getElementById('selTodosFrota'), // era #selTodos (cabeçalho da tabela), removido na 1.53.32

    document.getElementById('segEpSoAnon'),
    document.querySelector('.detran-check input[type="checkbox"]'),
  ].map(el => {
    const s = getComputedStyle(el);
    return { width: s.width, height: s.height, radius: s.borderRadius, appearance: s.appearance || s.webkitAppearance };
  }));
  // radius 4px = --ds-radius-sm (mesma nota da asserção acima — auditoria de ago/2026)
  assert.ok(amostras.every(s => s.width === '18px' && s.height === '18px' && s.radius === '4px' && s.appearance === 'none'), 'tabelas, filtros e etapas devem compartilhar o mesmo padrão');

  const switchCadastro = await page.locator('#toggleCadastros').evaluate(el => {
    const s = getComputedStyle(el); return { width: s.width, opacity: s.opacity };
  });
  assert.equal(switchCadastro.width, '0px', 'interruptores existentes não devem virar checkbox comum');
  assert.equal(switchCadastro.opacity, '0');

  for (const tema of ['', 'dark', 'preto']) {
    await page.evaluate((classe) => { document.body.classList.remove('dark', 'preto'); if (classe) document.body.classList.add(classe); }, tema);
    await checkbox.check();
    const fundo = await checkbox.evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(fundo, 'rgba(0, 0, 0, 0)', `a marcação precisa ser visível no tema ${tema || 'claro'}`);
  }
  await page.evaluate(() => document.body.classList.remove('dark', 'preto'));

  assert.equal(erros.length, 0, 'erros de JS ao testar checkboxes:\n' + erros.join('\n'));
  await page.close();
});

test('Funcionários calcula e salva o término de estágio em 6 meses', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/funcionarios`, { waitUntil: 'load' });
  await page.locator('#btnAddFunc').click();
  await page.locator('#funcModal:not([hidden])').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#funcTabs .func-tab[data-panel="profissional"]').click();
  await page.locator('#funcModal .func-tabpanel[data-panel="profissional"]:not([hidden])').waitFor({ state: 'visible', timeout: 5000 });

  const periodo = page.getByLabel('Período para cálculo');
  const periodoBtn = page.getByRole('button', { name: 'Período para cálculo' });
  const escolherPeriodo = (valor) => escolherNoSelect(page, periodoBtn, valor);
  assert.deepEqual(await periodo.locator('option').allTextContents(), ['Regra do contrato', '6 meses (estágio)']);
  await page.locator('#funcAdmissao + .dp-input').fill('31/01/2026');
  await escolherPeriodo('6m');
  assert.equal(await page.locator('#funcExpFim').inputValue(), '2026-07-31');
  assert.match(await page.locator('#funcExpHint').innerText(), /6 meses de calendário/i);

  await page.locator('#funcAdmissao + .dp-input').fill('31/08/2025');
  await page.locator('#btnRecalcExp').click();
  assert.equal(await page.locator('#funcExpFim').inputValue(), '2026-02-28', 'o cálculo deve limitar o dia ao último existente no mês de destino');

  await page.locator('#funcAdmissao + .dp-input').fill('01/01/2026');
  await escolherPeriodo('dias');
  assert.equal(await page.locator('#funcExpFim').inputValue(), '2026-02-14', 'a regra atual de 45 dias deve continuar funcionando');

  await page.close();

  const criado = await fetch(`${BASE}/api/funcionarios`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Estagiário E2E', admissao: '2025-08-31', experienciaCalculo: '6m' }),
  });
  assert.equal(criado.status, 201);
  const funcionario = await criado.json();
  assert.equal(funcionario.experienciaCalculo, '6m');
  assert.equal(funcionario.experienciaFim, '2026-02-28');
});

test('Experiência fica fora das pendências e mantém relatório próprio', async () => {
  const isoEm = (dias) => { const d = new Date(); d.setDate(d.getDate() + dias); return d.toISOString().slice(0, 10); };
  const criado = await fetch(`${BASE}/api/funcionarios`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({
      nome: 'Colaborador Experiência E2E', empresa: 'NTE', cargo: 'Teste', status: 'Ativo',
      admissao: isoEm(-34), experienciaFim: isoEm(10),
      documentos: [{ nome: 'ASO', categoria: 'Segurança', validade: isoEm(10) }],
    }),
  });
  assert.equal(criado.status, 201);
  const funcionario = await criado.json();

  const cenariosPendencia = [
    {
      nome: 'Colaborador Experiência Encerrada E2E', empresa: 'NTE', cargo: 'Teste', status: 'Ativo',
      admissao: isoEm(-60), experienciaFim: isoEm(-5), documentos: [],
    },
    {
      nome: 'Colaborador Documento Vencido E2E', empresa: 'NTE', cargo: 'Teste', status: 'Ativo',
      admissao: isoEm(-60), experienciaFim: isoEm(-5),
      documentos: [{ nome: 'NR-35', categoria: 'Segurança', validade: isoEm(-3) }],
    },
  ];
  for (const dados of cenariosPendencia) {
    const resposta = await fetch(`${BASE}/api/funcionarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(dados),
    });
    assert.equal(resposta.status, 201);
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/funcionarios`, { waitUntil: 'load' });
  // O cartão único "Com pendências" virou um indicador POR TIPO (docs vencidos / a vencer /
  // falta obrigatório / ASO) — a intenção original continua valendo em cada um: experiência
  // encerrada não é pendência, então ela não pode entrar em nenhum deles.
  assert.equal(await page.locator('#funcDash [data-act="com-pend"]').count(), 0,
    'o cartão "Com pendências" foi substituído pelos indicadores por tipo');
  // Os cartões viraram `.v2-kpi` do Design System (`.func-dash-*` não existe mais); o
  // `data-act` é o mesmo, então o recorte que este teste mede continua sendo o mesmo.
  const numeroKpi = (act) => page.locator(`#funcDash .v2-kpi[data-act="${act}"] .v2-kpi-val`).innerText();
  assert.equal(await numeroKpi('vencidos'), '1', 'o total de documentos vencidos deve permanecer correto');
  assert.equal(await numeroKpi('a-vencer'), '1', 'o documento a vencer deve continuar no indicador próprio');
  assert.equal(await numeroKpi('em-experiencia'), '1', 'a experiência deve permanecer apenas no indicador próprio enquanto estiver vigente');
  // A faixa nasce RECOLHIDA: ler o innerText dela sem expandir devolvia o textContent de um nó
  // não renderizado, e a asserção passaria mesmo com o app errado. Expandir é o que o usuário faz.
  await expandirFaixa(page, 'funcAlertas-ver');
  const nomesNaFaixa = await page.locator('#funcAlertas .ds-alert-linha-id').allInnerTexts();
  assert.ok(!nomesNaFaixa.includes('Colaborador Experiência Encerrada E2E'), 'experiência encerrada não deve aparecer na faixa de documentos');
  await page.locator('#funcAlertas-ver').click(); // recolhe: a faixa aberta empurra os KPIs para baixo
  const pendencias = await (await fetch(`${BASE}/api/funcionarios/pendencias?tipo=todos`)).json();
  assert.ok(pendencias.pendencias.every((p) => p.categoria !== 'Experiência'), 'experiência não deve entrar na lista nem no Excel de pendências');
  assert.deepEqual(pendencias.pendencias.map((p) => p.documento), ['NR-35', 'ASO']);

  // Filtro pelo cartão que herdou o significado de "tem pendência de documento". Ele agora abre a
  // visão Pendências (irParaPendencias), não a de cartões: experiência encerrada não entra na
  // lista, só quem está com documentação vencida.
  await page.locator('#funcDash [data-act="vencidos"]').click();
  await page.locator('#funcPend .func-pend-lista').waitFor({ state: 'visible' });
  assert.deepEqual(await page.locator('#funcPend .func-pend-row .func-pend-quem-txt strong').allInnerTexts(), ['Colaborador Documento Vencido E2E'], 'o cartão deve filtrar somente quem possui documentação vencida');
  const atalho = page.locator('#funcDash .v2-kpi[data-act="em-experiencia"]');
  await atalho.waitFor({ state: 'visible', timeout: 5000 });
  await atalho.click();

  const contexto = page.locator('#funcDrill');
  const relatorio = page.locator('#btnRelatorioExp');
  await relatorio.waitFor({ state: 'visible' });
  assert.match(await contexto.innerText(), /Término de experiência/i);
  assert.match(await contexto.innerText(), /Gerar relatório/i);
  assert.match(await relatorio.getAttribute('class') || '', /btn-primary/, 'a ação principal deve estar visualmente destacada');
  assert.match(await relatorio.getAttribute('aria-label') || '', /Excel/i, 'o botão deve informar o formato para tecnologias assistivas');
  assert.equal(await relatorio.locator('.func-exp-relatorio-formato').innerText(), 'XLSX');

  const respostaP = page.waitForResponse((resp) => resp.url().endsWith('/api/funcionarios/exportar') && resp.request().method() === 'POST');
  const downloadP = page.waitForEvent('download');
  await relatorio.click();
  const [resposta, download] = await Promise.all([respostaP, downloadP]);
  assert.equal(resposta.status(), 200);
  assert.match(resposta.headers()['content-type'] || '', /spreadsheetml/);
  assert.ok(JSON.parse(resposta.request().postData() || '{}').ids.includes(funcionario.id), 'o relatório deve incluir o colaborador exibido');
  assert.equal(download.suggestedFilename(), 'TERMINO_EXPERIENCIA.xlsx');
  const planilha = XLSX.read(fs.readFileSync(await download.path()), { type: 'buffer' });
  const linhas = XLSX.utils.sheet_to_json(planilha.Sheets[planilha.SheetNames[0]]);
  // A coluna virou "FIM EXPERIÊNCIA (1ª)" e ganhou irmã "(2ª)" quando o cadastro passou a
  // registrar recontratação — o que este teste garante continua sendo o mesmo: a data de
  // término precisa CHEGAR na planilha, em alguma das colunas de experiência.
  const semAcento = (t) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const chavesFim = Object.keys(linhas[0] || {}).filter((chave) => semAcento(chave).startsWith('FIM EXPERIENCIA'));
  assert.ok(chavesFim.length > 0, `o Excel deve ter coluna de fim de experiência (colunas: ${Object.keys(linhas[0] || {}).join(', ')})`);
  assert.ok(linhas.some((item) => chavesFim.some((c) => item[c])), 'o Excel deve trazer a data de término da experiência');

  await page.close();
});

test('Funcionários mostra e filtra admissões e demissões do mês atual', async () => {
  const hoje = new Date();
  const mesISO = (data) => `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, '0')}`;
  const atual = mesISO(hoje);
  const anterior = mesISO(new Date(hoje.getFullYear(), hoje.getMonth() - 1, 1));
  const casos = [
    { nome: 'Admissão Atual E2E', status: 'Ativo', admissao: `${atual}-02` },
    { nome: 'Admissão Antiga E2E', status: 'Ativo', admissao: `${anterior}-02` },
    { nome: 'Demissão Atual E2E', status: 'Desligado', admissao: `${anterior}-03`, dataDemissao: `${atual}-05` },
    { nome: 'Demissão Antiga E2E', status: 'Desligado', admissao: `${anterior}-03`, dataDemissao: `${anterior}-05` },
  ];
  for (const dados of casos) {
    const resposta = await fetch(`${BASE}/api/funcionarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(dados),
    });
    assert.equal(resposta.status, 201);
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/funcionarios`, { waitUntil: 'load' });
  const cardAdmissoes = page.locator('#funcDash .v2-kpi[data-act="admissoes"]');
  const cardDemissoes = page.locator('#funcDash .v2-kpi[data-act="demissoes"]');
  await cardAdmissoes.waitFor({ state: 'visible', timeout: 5000 });
  // Os cartões viraram `.v2-kpi` (`.func-dash-*` saiu). E a contagem é conferida por DELTA: a
  // suíte inteira compartilha um DATA_DIR, então "1" só valia enquanto nenhum teste ANTERIOR
  // criasse alguém admitido no mês corrente — dependência de ordem invisível, que o teste do
  // filtro de contrato (logo abaixo, com admissão de 20 dias atrás) quebra em boa parte do ano.
  const total = (card) => card.locator('.v2-kpi-val').innerText().then(Number);
  const admDepois = await total(cardAdmissoes);
  const demDepois = await total(cardDemissoes);
  assert.ok(admDepois >= 1, 'a admissão deste mês precisa entrar no indicador');
  assert.ok(demDepois >= 1, 'a demissão deste mês precisa entrar no indicador');
  assert.equal(await cardAdmissoes.locator('.v2-kpi-rot').innerText(), 'Admissões no mês');
  assert.equal(await cardDemissoes.locator('.v2-kpi-rot').innerText(), 'Demissões no mês');

  // O recorte é pelo MÊS, e é isso que o par inclui/não-inclui prova — sem depender de quem
  // mais está na base por causa dos testes anteriores.
  await cardAdmissoes.click();
  assert.match(await page.locator('#funcDrill').innerText(), /Admissões no mês/);
  const admitidos = await page.locator('#funcGrupos .func-card-nome').allInnerTexts();
  assert.ok(admitidos.includes('Admissão Atual E2E'), 'quem entrou neste mês precisa aparecer');
  assert.ok(!admitidos.includes('Admissão Antiga E2E'), 'quem entrou no mês anterior não pode aparecer');

  await cardDemissoes.click();
  assert.match(await page.locator('#funcDrill').innerText(), /Demissões no mês/);
  const desligados = await page.locator('#funcDesmob .func-card-nome').allInnerTexts();
  assert.ok(desligados.includes('Demissão Atual E2E'), 'quem saiu neste mês precisa aparecer');
  assert.ok(!desligados.includes('Demissão Antiga E2E'), 'quem saiu no mês anterior não pode aparecer');

  await page.locator('#funcDrill .func-drill-voltar').click();
  await page.locator('#funcContratos:not([hidden])').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#funcDrill').isHidden(), true, 'voltar deve limpar o filtro mensal');
  await page.close();
});

test('Funcionários aplica o filtro de contrato em todas as informações da tela', async () => {
  const isoEm = (dias) => { const d = new Date(); d.setDate(d.getDate() + dias); return d.toISOString().slice(0, 10); };
  const contratos = [
    { numero: '4600009505', nome: 'ORION SERVIÇOS DE EXECUÇÃO DE OBRAS DE CONSTRUÇÃO CIVIL', pessoa: 'Pessoa Orion E2E' },
    { numero: '4600009606', nome: 'ATLAS CONSTRUÇÃO PREDIAL', pessoa: 'Pessoa Atlas E2E' },
  ];
  for (const contrato of contratos) {
    const criado = await fetch(`${BASE}/api/funcionarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
      body: JSON.stringify({
        nome: contrato.pessoa, empresa: 'NTE', cargo: 'Teste', status: 'Ativo',
        admissao: isoEm(-20), experienciaFim: isoEm(10),
        contratos: [{ numero: contrato.numero, nome: contrato.nome, local: '' }],
        contratoNumero: contrato.numero, contratoNome: contrato.nome, local: '',
        documentos: [{ nome: 'ASO', categoria: 'Segurança', validade: isoEm(-1) }],
      }),
    });
    assert.equal(criado.status, 201);
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/funcionarios`, { waitUntil: 'load' });
  await page.locator('#funcContratos .func-contrato-card').first().waitFor({ state: 'visible', timeout: 5000 });
  await abrirFiltros(page, 'func');
  await page.locator('#ffContrato .msel-btn').click(); // o painel é a moldura; a lista do filtro abre à parte
  const opcaoOrion = page.locator('#ffContrato .msel-item').filter({ hasText: '4600009505' }).first();
  await opcaoOrion.locator('input').check();
  // Fechar o painel é obrigatório, não higiene: ele é `position:absolute` dentro da `.func-topo`
  // e COBRE os KPIs — o clique no cartão logo abaixo seria interceptado por ele.
  await fecharFiltros(page, 'func');

  const contratosVisiveis = await page.locator('#funcContratos .func-contrato-card:visible').evaluateAll((cards) => cards.map((c) => c.dataset.contrato));
  assert.deepEqual([...new Set(contratosVisiveis)], ['4600009505'], 'o diretório deve esconder os outros contratos');
  assert.match(await page.locator('#funcDash .v2-kpi[data-act="ativos"] .v2-kpi-val').innerText(), /^1$/, 'o indicador deve refletir só o contrato selecionado');
  // A faixa é regerada a cada mudança de filtro e, ao contrário da Frota, o `.ds-alert` NÃO
  // guarda o estado expandido: expandir só depois de aplicar o filtro.
  await expandirFaixa(page, 'funcAlertas-ver');
  const nomesAlertas = await page.locator('#funcAlertas .ds-alert-linha-id').allInnerTexts();
  assert.ok(nomesAlertas.length > 0 && nomesAlertas.every((nome) => nome === 'Pessoa Orion E2E'), 'os alertas devem respeitar o contrato');
  await page.locator('#funcAlertas-ver').click(); // recolhe para não empurrar os KPIs

  await page.locator('#funcDash .v2-kpi[data-act="em-experiencia"]').click();
  assert.match(await page.locator('#funcDrill').innerText(), /1 colaborador/i, 'o relatório deve usar o mesmo recorte');
  assert.deepEqual(await page.locator('#funcGrupos .func-card-nome').allInnerTexts(), ['Pessoa Orion E2E'], 'a lista deve mostrar somente o contrato escolhido');
  await page.close();
});

test('Comprados aceita data completa e valor de compra com centavos em formato BR', async () => {
  const placa = 'CPR1234';
  let r = await fetch(`${BASE}/api/veiculos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({
      placa,
      modelo: 'Teste Compra',
      anoFab: 2026,
      valorFipe: 100000,
      compra: { ativo: true },
    }),
  });
  assert.equal(r.status, 201);

  const page = await browser.newPage();
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  await page.locator('#frotaSubtabs .subtab[data-sub="frota-comprados"]').click();

  const campo = page.locator(`#corpoComprados tr[data-placa="${placa}"] input.dp-input`).first();
  await campo.waitFor({ state: 'visible', timeout: 5000 });
  const salvou = page.waitForResponse((resp) =>
    resp.url().includes(`/api/veiculos/${placa}`) && resp.request().method() === 'PUT' && resp.ok()
  );
  await campo.click();
  await campo.pressSequentially('01072026', { delay: 5 });
  await salvou;

  await campo.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await campo.inputValue(), '01/07/2026');

  const valorCampo = page.locator(`#corpoComprados tr[data-placa="${placa}"] input[data-campo="valor"]`).first();
  await valorCampo.waitFor({ state: 'visible', timeout: 5000 });
  const salvouValor = page.waitForResponse((resp) =>
    resp.url().includes(`/api/veiculos/${placa}`) && resp.request().method() === 'PUT' && resp.ok()
  );
  await valorCampo.fill('R$ 115.041,68');
  await valorCampo.blur();
  await salvouValor;

  const valorReformatado = page.locator(`#corpoComprados tr[data-placa="${placa}"] input[data-campo="valor"]`).first();
  await valorReformatado.waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await valorReformatado.inputValue(), '115.041,68');

  const lista = await (await fetch(`${BASE}/api/veiculos`)).json();
  const veiculo = lista.find((v) => v.placa === placa);
  assert.equal(veiculo?.compra?.data, '2026-07-01');
  assert.equal(veiculo?.compra?.valor, 115041.68);
  await page.close();
});

test('Multas marca a lista filtrada inteira pelo controle da barra e mostra a seleção nos dois temas', async () => {
  const veiculo = await fetch(`${BASE}/api/veiculos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ placa: 'LIN1234', modelo: 'Referência de altura', status: 'EM ATIVIDADE' }),
  });
  assert.equal(veiculo.status, 201);

  const criadas = [];
  for (let i = 1; i <= 26; i++) {
    const r = await fetch(`${BASE}/api/multas`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...ORIG },
      body: JSON.stringify({
        placa: `MLT${String(i).padStart(4, '0')}`,
        autoInfracao: `AUTO-${i}`,
        descricao: `Multa de teste ${i}`,
        valor: i,
        situacao: 'PENDENTE',
      }),
    });
    assert.equal(r.status, 201);
    criadas.push(await r.json());
  }

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  await page.locator('#corpoTabela tr').first().waitFor({ state: 'visible', timeout: 5000 });
  const linhaFrota = await page.locator('#corpoTabela tr').first().boundingBox();

  await page.goto(`${PAINEL}/multas`, { waitUntil: 'load' });
  await page.locator('#multaPorPagina').selectOption('25');
  await page.locator('#corpoMultas tr').first().waitFor({ state: 'visible', timeout: 5000 });
  assert.equal(await page.locator('#corpoMultas tr').count(), 25);
  const linhaMulta = await page.locator('#corpoMultas tr').first().boundingBox();
  assert.ok(linhaFrota && linhaMulta && Math.abs(linhaFrota.height - linhaMulta.height) <= 1,
    `linhas de Frota e Multas devem ter a mesma altura no desktop (${linhaFrota?.height} x ${linhaMulta?.height})`);

  // 1) Clique na linha marca uma só — não existe mais caixinha por linha (saiu na 1.53.32) —
  //    e a linha não pode mudar de altura ao ficar selecionada (o véu é box-shadow, não borda).
  //    A 4ª célula é o Nº do Auto: texto puro, sem botão nem pílula.
  const alturaAntes = linhaMulta.height;
  await page.locator('#corpoMultas tr').first().locator('td:nth-child(4)').click();
  const alturaSelecionada = (await page.locator('#corpoMultas tr').first().boundingBox()).height;
  assert.ok(Math.abs(alturaAntes - alturaSelecionada) <= 1, 'selecionar uma multa não deve alterar a altura da linha');
  await page.locator('#selBarMultas').waitFor({ state: 'visible' });
  assert.match(await page.locator('#selBarMultasInfo').innerText(), /1\s+selecionada/);
  assert.equal(await page.locator('#selTodosMultas').evaluate((el) => el.indeterminate), true,
    '1 de 26 marcadas: o controle da barra de filtros mostra o estado intermediário');

  // 2) "Selecionar todos" pega a LISTA FILTRADA INTEIRA (26) e não só as 25 da página.
  assert.match(await page.locator('#selTodosMultasRot').innerText(), /\(26\)/,
    'o rótulo anuncia o tamanho da lista filtrada antes do clique');
  await page.locator('#selTodosMultas').check();
  assert.match(await page.locator('#selBarMultasInfo').innerText(), /26\s+selecionada/);
  assert.equal(await page.locator('#selTodosMultas').evaluate((el) => el.indeterminate), false);

  // 3) Trocar de página não mexe em nada. O controle ANTIGO era por página e zerava aqui.
  await page.locator('#multaPagNext').click();
  assert.equal(await page.locator('#corpoMultas tr').count(), 1);
  assert.equal(await page.locator('#selTodosMultas').isChecked(), true);
  assert.equal(await page.locator('#corpoMultas tr.sel-on').count(), 1, 'a linha da 2ª página já vem marcada');
  assert.match(await page.locator('#selBarMultasInfo').innerText(), /26\s+selecionada/);

  // 4) Filtrar reduz a contagem do controle sem descartar a seleção que ficou fora do filtro.
  // MLT0007 e não MLT0026: estamos na 2ª página, que já mostra exatamente 1 linha (a 26ª) —
  // esperar por "1 linha" voltaria na hora, antes de a busca ter redesenhado.
  await page.locator('#buscaMulta').fill('MLT0007');
  await page.waitForFunction(() => {
    const trs = document.querySelectorAll('#corpoMultas tr');
    return trs.length === 1 && trs[0].innerText.includes('MLT0007');
  });
  assert.match(await page.locator('#selTodosMultasRot').innerText(), /\(1\)/);
  assert.equal(await page.locator('#selTodosMultas').isChecked(), true);
  assert.match(await page.locator('#selBarMultasInfo').innerText(), /26\s+selecionada/,
    'a seleção fora do filtro continua valendo');

  // 5) Desmarcar pelo controle tira só o que está filtrado; quem zera tudo é o "Limpar seleção".
  await page.locator('#selTodosMultas').uncheck();
  assert.match(await page.locator('#selBarMultasInfo').innerText(), /25\s+selecionada/);
  assert.equal(await page.locator('#corpoMultas tr.sel-on').count(), 0);

  // 6) A linha selecionada precisa ser VISÍVEL nos dois temas — era exatamente isso que
  //    falhava no escuro: a zebra (0,5,4) vencia a regra de seleção e apagava as linhas PARES.
  await page.locator('#buscaMulta').fill('');
  await page.waitForFunction(() => document.querySelectorAll('#corpoMultas tr').length > 1);
  for (const tema of ['claro', 'escuro']) {
    await page.evaluate((t) => { localStorage.setItem('tema', t); }, tema);
    await page.reload({ waitUntil: 'load' });
    await page.locator('#corpoMultas tr').first().waitFor({ state: 'visible' });
    for (const i of [0, 1]) await page.locator('#corpoMultas tr').nth(i).locator('td:nth-child(4)').click();
    const veu = await page.evaluate(() => [0, 1].map((i) => {
      const td = document.querySelectorAll('#corpoMultas tr')[i].querySelector('td');
      return getComputedStyle(td).boxShadow;
    }));
    for (const [i, sombra] of veu.entries()) {
      assert.ok(sombra && sombra !== 'none',
        `tema ${tema}: a linha ${i % 2 ? 'PAR' : 'ÍMPAR'} selecionada precisa do véu (box-shadow), não de background`);
      assert.match(sombra, /inset/, `tema ${tema}: o véu é uma sombra inset`);
    }
    await page.locator('#selBarMultasLimpar').click();
  }

  const exportada = await fetch(`${BASE}/api/multas/exportar?ids=${encodeURIComponent(criadas[0].id)}`);
  assert.equal(exportada.status, 200);
  const wb = XLSX.read(Buffer.from(await exportada.arrayBuffer()), { type: 'buffer' });
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  assert.equal(linhas.length, 1, 'exporta somente as multas selecionadas');

  await page.locator('#selTodosMultas').check();
  await page.locator('#selBarMultasLimpar').click();
  await page.locator('#selBarMultas').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#corpoMultas tr.sel-on').count(), 0);
  assert.equal(await page.locator('#selTodosMultas').isChecked(), false, '"Limpar seleção" também zera o controle');
  await page.close();
});

// O "Selecionar todos" do dropdown é do PRÓPRIO componente criarMultiSelect: uma mudança lá
// vale para as ~30 instâncias de filtro do app. Este teste exerce o contrato do componente
// (aditivo, rótulo que inverte, disabled, dispara onChange) numa instância qualquer.
test('filtro multi-seleção marca de uma vez tudo que a busca deixou à vista', async (t) => {
  const placas = ['SEL1A11', 'SEL2B22', 'SEL3C33'];
  const centros = ['E2E SELECAO ALFA', 'E2E SELECAO BETA', 'E2E SELECAO GAMA'];
  for (const [i, placa] of placas.entries()) {
    const r = await fetch(`${BASE}/api/veiculos`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
      body: JSON.stringify({ placa, modelo: 'Multi-seleção E2E', centroCusto: centros[i], status: 'EM ATIVIDADE' }),
    });
    assert.equal(r.status, 201);
  }
  t.after(async () => { for (const placa of placas) await fetch(`${BASE}/api/veiculos/${placa}`, { method: 'DELETE', headers: ORIG }); });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = []; page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  await page.locator('#corpoTabela tr').first().waitFor({ state: 'visible', timeout: 5000 });
  await abrirFiltros(page, 'frota');
  await page.locator('#fCentro .msel-btn').click();
  const menu = page.locator('#fCentro .msel-menu');
  await menu.waitFor({ state: 'visible' });
  const todos = menu.locator('.msel-todos');

  // sem busca: marca a lista inteira e o MESMO botão passa a oferecer o inverso
  const total = await menu.locator('.msel-item').count();
  assert.match(await todos.innerText(), new RegExp('^Selecionar todos \\(' + total + '\\)'), 'o rótulo anuncia quantos vai marcar');
  await todos.click();
  assert.equal(await page.locator('#fCentro .msel-count').innerText(), String(total));
  assert.match(await todos.innerText(), /^Desmarcar todos/, 'com tudo marcado o botão vira o inverso, em vez de desabilitar');
  await todos.click();
  assert.equal(await page.locator('#fCentro .msel-count').isVisible(), false);
  assert.match(await todos.innerText(), /^Selecionar todos/);

  // com busca: age só sobre o que está à vista, e é ADITIVO (marcar por busca SOMA)
  await menu.locator('.msel-busca').fill('E2E SELECAO ALFA');
  await page.waitForFunction(() => document.querySelectorAll('#fCentro .msel-item').length === 1);
  await todos.click();
  await menu.locator('.msel-busca').fill('E2E SELECAO BETA');
  await page.waitForFunction(() => document.querySelectorAll('#fCentro .msel-item').length === 1);
  await todos.click();
  assert.equal(await page.locator('#fCentro .msel-count').innerText(), '2',
    'marcar por busca soma com o que já estava marcado — a busca é uma lente, não um recorte da seleção');

  // busca sem resultado: desabilitado (marcar zero itens é promessa falsa)
  await menu.locator('.msel-busca').fill('ZZZZ-NAO-EXISTE');
  await page.waitForFunction(() => !!document.querySelector('#fCentro .msel-vazio'));
  assert.equal(await todos.isDisabled(), true);

  // O botão dispara onChange (a armadilha: a API limpar() NÃO dispara) → a tabela reage na hora.
  // A prova é feita sobre UM centro exclusivo deste teste, e não sobre "marcar tudo": a suíte
  // inteira compartilha o mesmo DATA_DIR, então o total de veículos depende de quem rodou antes.
  await menu.locator('.msel-limpar').click();
  await menu.locator('.msel-busca').fill('E2E SELECAO GAMA');
  await page.waitForFunction(() => document.querySelectorAll('#fCentro .msel-item').length === 1);
  await todos.click();
  await page.waitForFunction(() => {
    const trs = document.querySelectorAll('#corpoTabela tr');
    return trs.length === 1 && trs[0].innerText.includes('SEL3C33');
  }, null, { timeout: 10000 });
  assert.equal(await page.locator('#corpoTabela tr').count(), 1, 'marcar pelo botão filtra a tabela na hora');

  assert.equal(erros.length, 0, 'erros de JS no multi-seleção:\n' + erros.join('\n'));
  await page.close();
});

// Regressão da 1.53.32: ao trocar a caixinha por linha pelo clique-na-linha, o bloco de seleção
// das Fichas de EPI ficou DEPOIS do guard `if (!btn) return;` e virou código inalcançável — a
// aba inteira perdeu a seleção sem ninguém notar, porque a barra nunca chegava a aparecer.
test('EPI - Fichas: clicar na linha marca e desmarca, e o controle da barra pega a lista inteira', async (t) => {
  const epi = await (await fetch(`${BASE}/api/epi/catalogo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Capacete seleção', codigo: 'E2E-SEL', ca: '55555', unidade: 'un', estoqueInicial: 20, contratos: [CONTRATO_EPI] }),
  })).json();
  const criarFicha = async (nome) => (await (await fetch(`${BASE}/api/epi/movimentacoes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ tipo: 'Entrega', funcionarioNome: nome, data: '2026-07-21', contratoNumero: CONTRATO_EPI, itens: [{ epiId: epi.id, quantidade: 1 }], responsavel: 'Almoxarife E2E' }),
  })).json()).id;
  const fichas = [];
  for (const nome of ['Ana Seleção', 'Bruno Seleção', 'Carla Seleção']) fichas.push(await criarFicha(nome));
  t.after(async () => {
    for (const id of fichas) await fetch(`${BASE}/api/epi/movimentacoes/${id}`, { method: 'DELETE', headers: ORIG });
    const d = await (await fetch(`${BASE}/api/epi`)).json();
    for (const m of d.movimentacoes.filter((x) => (x.itens || []).some((i) => i.epiId === epi.id))) {
      await fetch(`${BASE}/api/epi/movimentacoes/${m.id}`, { method: 'DELETE', headers: ORIG });
    }
    await fetch(`${BASE}/api/epi/catalogo/${epi.id}`, { method: 'DELETE', headers: ORIG });
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = []; page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/epi/fichas`, { waitUntil: 'load' });
  await page.locator('#corpoEpiFichas tr').first().waitFor({ state: 'visible', timeout: 5000 });

  // a 2ª célula é o colaborador — texto puro, sem botão
  const alvo = () => page.locator('#corpoEpiFichas tr').first().locator('td:nth-child(2)');
  await alvo().click();
  assert.equal(await page.locator('#corpoEpiFichas tr.sel-on').count(), 1, 'clicar na linha marca a ficha');
  await page.locator('#selBarEpiFicha').waitFor({ state: 'visible' });
  await alvo().click();
  assert.equal(await page.locator('#corpoEpiFichas tr.sel-on').count(), 0,
    'clicar de novo DESMARCA — sem isso "selecionar todos" seria mão única');

  // o controle da barra de filtros pega a lista filtrada inteira
  const total = await page.locator('#corpoEpiFichas tr').count();
  await page.locator('#selTodosEpiFicha').check();
  assert.equal(await page.locator('#corpoEpiFichas tr.sel-on').count(), total);
  assert.match(await page.locator('#selBarEpiFichaInfo').innerText(), new RegExp(total + ' ficha\\(s\\) selecionada'));

  // ele pertence à sub-aba Fichas e some junto com ela
  await page.locator('#epiSubtabs .subtab[data-sub="epi-movimentacoes"]').click();
  await page.locator('#epi-movimentacoes.active').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#selTodosEpiFicha').isVisible(), false, 'o controle é da sub-aba Fichas');

  assert.equal(erros.length, 0, 'erros de JS nas Fichas de EPI:\n' + erros.join('\n'));
  await page.close();
});

test('Frota mostra no filtro somente centros de custo usados por veículos', async () => {
  const centroFrota = 'CENTRO EXCLUSIVO FROTA E2E';
  const centroOutraAba = 'CENTRO SOMENTE OUTRA ABA E2E';
  let r = await fetch(`${BASE}/api/veiculos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ placa: 'CCF1234', modelo: 'Teste de centro', centroCusto: centroFrota, status: 'EM ATIVIDADE' }),
  });
  assert.equal(r.status, 201);
  r = await fetch(`${BASE}/api/cadastros/centrosCusto`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: centroOutraAba }),
  });
  assert.equal(r.status, 201);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/frota`, { waitUntil: 'load' });
  await page.locator('#corpoTabela tr[data-placa="CCF1234"]').waitFor({ state: 'visible', timeout: 5000 });
  // No Design System os filtros vivem num painel ancorado no botão "Filtros" — abri-lo é
  // pré-requisito para o multiselect existir na tela.
  await abrirFiltros(page, 'frota');
  await page.locator('#fCentro .msel-btn').click();
  const opcoesFiltro = await page.locator('#fCentro .msel-item span').allInnerTexts();
  assert.ok(opcoesFiltro.includes(centroFrota), 'o centro usado por um veículo deve aparecer no filtro');
  assert.ok(!opcoesFiltro.includes(centroOutraAba), 'centro sem veículo não deve aparecer no filtro da Frota');
  await page.locator('#fCentro .msel-item', { hasText: centroFrota }).locator('input').check();
  await fecharFiltros(page, 'frota'); // o painel flutua sobre a tabela; sai da frente antes de medir
  assert.equal(await page.locator('#corpoTabela tr').count(), 1, 'o filtro deve deixar somente o veículo do centro escolhido');
  assert.equal(await page.locator('#corpoTabela tr').getAttribute('data-placa'), 'CCF1234');
  assert.equal(await page.locator(`#listaCentros option[value="${centroOutraAba}"]`).count(), 1,
    'o centro cadastrado deve continuar disponível para edição de veículos');
  await page.close();
});

test('Contratos completa a parcela 1 quando a série existente começa em 2/24', async () => {
  const base = {
    banco: 'Banco série E2E',
    produto: 'Financiamento',
    empresa: 'NTE',
    material: 'Série incompleta E2E',
    parcela: '2/24',
    vencimento: '15/08/2026',
    valorParcela: 1000,
  };
  const criada = await fetch(`${BASE}/api/contratos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify(base),
  });
  assert.equal(criada.status, 201);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/contratos`, { waitUntil: 'load' });
  const linha = page.locator('#corpoContr tr', { hasText: 'Série incompleta E2E' });
  await linha.waitFor({ state: 'visible' });
  await linha.locator('.edit-contr').click();
  await page.locator('#gerarSerieContr').click();
  await page.locator('#confirmOk').click();
  await page.waitForFunction(() => document.getElementById('corpoContr')?.innerText.includes('1/24'));

  const serie = (await (await fetch(`${BASE}/api/contratos`)).json())
    .filter((c) => c.material === base.material)
    .sort((a, b) => Number(a.parcela.split('/')[0]) - Number(b.parcela.split('/')[0]));
  assert.equal(serie.length, 24, 'a série deve ter uma linha por parcela, sem duplicatas');
  assert.deepEqual(serie.map((c) => c.parcela), Array.from({ length: 24 }, (_, i) => `${String(i + 1).padStart(2, '0')}/24`));
  assert.equal(serie[0].vencimento, '15/07/2026', 'o vencimento anterior deve ser calculado a partir da parcela 2');
  assert.equal(serie[2].vencimento, '15/09/2026');
  await page.close();
});

test('Contratos reconhece as parcelas da segunda página mesmo com descrição alterada', async () => {
  const grupo = 'E2E54';
  const cota = '77';
  const itens = Array.from({ length: 54 }, (_, i) => ({
    banco: 'Banco paginação E2E',
    produto: 'Consórcio',
    empresa: 'NTE',
    grupo,
    cota,
    material: i < 50 ? 'Descrição inicial E2E' : 'Descrição atualizada E2E',
    parcela: `${i + 1}/54`,
    vencimento: '15/08/2026',
  }));
  const criada = await fetch(`${BASE}/api/contratos/lote-criar`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ itens }),
  });
  assert.equal(criada.status, 201);

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/contratos`, { waitUntil: 'load' });
  await page.locator('#buscaContr').fill(grupo);
  await page.waitForFunction(() => document.getElementById('resumoContr')?.innerText.replace(/\s+/g, ' ').includes('1–50 de 54 filtrados'));
  assert.equal(await page.locator('#corpoContr tr').count(), 50);
  await page.locator('#corpoContr .edit-contr').first().click();
  await page.locator('#gerarSerieContr').click();

  assert.equal(await page.locator('#confirmModal').isVisible(), false,
    'uma série completa não deve pedir para gerar as quatro parcelas da segunda página');
  assert.match(await page.locator('#toast').innerText(), /já está completa/);
  await page.close();
});

// Caso real (Banco Exemplo 20416/315, 1.55.47): a 53/54 e a 54/54 tinham sido cadastradas com o nome
// antigo; a busca pelo nome novo as escondia e o "Completar série" — que agrupa por grupo/cota, não
// pela descrição — com razão não as criava de novo. Parecia que "faltou gerar". Agora os dois
// botões dizem quais parcelas estão fora da lista, por quê, e oferecem mostrar a série inteira.
test('Completar série avisa das parcelas que existem mas a busca esconde (descrição diferente)', async () => {
  const post = (ep, body) => fetch(`${BASE}${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(body) });
  // Espelho do caso real: série de 54 em que só a 53/54 e a 54/54 têm o nome antigo. Com 50 por
  // página e a lista por vencimento, elas caem na PÁGINA 2 — o "Mostrar a série" tem de abrir lá.
  const SER = { banco: 'Banco ocultas E2E', produto: 'Consórcio', empresa: 'SUL', grupo: 'E2EOC', cota: '53', valorParcela: 100 };
  const venc = (n) => { const d = new Date(2027, n - 1, 10); return `10/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`; };
  const itens = Array.from({ length: 54 }, (_, i) => ({
    ...SER, parcela: `${i + 1}/54`, vencimento: venc(i + 1),
    material: i + 1 <= 52 ? 'Nome novo ocultas E2E' : 'Nome antigo ocultas E2E',
  }));
  assert.equal((await post('/api/contratos/lote-criar', { itens })).status, 201);

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/contratos`, { waitUntil: 'load' });
  await page.locator('#contratosSubtabs').waitFor({ state: 'visible', timeout: 5000 });
  const linhas = page.locator('#corpoContr tr');
  const resumo = (re) => page.waitForFunction((fonte) => new RegExp(fonte).test(document.getElementById('resumoContr')?.innerText.replace(/\s+/g, ' ') || ''), re.source);
  await page.locator('#buscaContr').fill('Nome novo ocultas E2E');
  await resumo(/1–50 de 52 filtrados/);

  // (1a) Edição NÃO salva no form: o diálogo avisa que ela será descartada; Cancelar mantém o modal.
  await linhas.filter({ hasText: '03/54' }).locator('.edit-contr').click();
  await page.locator('#formContrato [name="escritorio"]').fill('Escritório digitado e não salvo');
  await page.locator('#gerarSerieContr').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  assert.match(await page.locator('#confirmTexto').innerText(), /não foi salvo será descartado/);
  await page.locator('#confirmCancel').click();
  assert.equal(await page.locator('#contratoModal').isVisible(), true, 'Cancelar não fecha o modal nem perde a edição');
  assert.equal(await page.locator('#formContrato [name="escritorio"]').inputValue(), 'Escritório digitado e não salvo');
  await page.locator('#cancelarContrato').click();

  // (1b) Modal sem edição, série COMPLETA com 53/54 e 54/54 fora da lista → diálogo explica e mostra
  // a série NA PÁGINA delas.
  await linhas.filter({ hasText: '03/54' }).locator('.edit-contr').click();
  await page.locator('#gerarSerieContr').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  const texto1 = await page.locator('#confirmTexto').innerText();
  assert.match(texto1, /já está completa, então nada foi criado/);
  assert.match(texto1, /53\/54 e 54\/54 já existem nesta série, mas não aparecem na lista porque estão cadastradas com descrição diferente/);
  assert.doesNotMatch(texto1, /descartado/, 'form sem mudança: nada a descartar');
  assert.equal(await page.locator('#confirmOk').innerText(), 'Mostrar a série');
  await page.locator('#confirmOk').click();
  await resumo(/51–54 de 54 filtrados/);
  assert.equal(await page.locator('#buscaContr').inputValue(), 'E2EOC / 53', 'a busca passa a ser pelo grupo/cota, que casa a série inteira');
  assert.match(await page.locator('#corpoContr').innerText(), /53\/54[\s\S]*54\/54/, 'abre direto na página 2, onde estão as citadas');
  assert.equal(await page.locator('#contratoModal').isVisible(), false, 'o modal fecha para mostrar a lista');

  // (2) Botão global com a busca pelo nome novo: o mesmo aviso, e o resumo só DEPOIS de fechar o aviso.
  await page.locator('#buscaContr').fill('Nome novo ocultas E2E');
  await resumo(/1–50 de 52 filtrados/);
  await page.evaluate(() => { const t = document.getElementById('toast'); t.textContent = ''; t.className = 'toast'; });
  await page.locator('#btnCompletarSeriesContr').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#confirmOk').click(); // "Completar todas"
  await page.waitForFunction(() => /Parte de uma série/.test(document.getElementById('confirmTexto')?.textContent || '')
    && !document.getElementById('confirmModal').hidden, null, { timeout: 8000 });
  assert.match(await page.locator('#confirmTexto').innerText(), /Banco ocultas E2E E2EOC\/53: 53\/54 e 54\/54 já existem nesta série/);
  assert.equal(await page.locator('#toast').innerText(), '', 'o resumo espera o aviso fechar (senão some embaixo dele)');
  await page.locator('#confirmOk').click(); // "Mostrar a série"
  await resumo(/51–54 de 54 filtrados/);
  await page.waitForFunction(() => /completas|criada|padronizada|sobreposi|revisão|aviso/.test(document.getElementById('toast').textContent));

  // (3) Série inteira visível: o global NÃO abre aviso (sem ruído).
  await page.evaluate(() => { const t = document.getElementById('toast'); t.textContent = ''; t.className = 'toast'; });
  await page.locator('#btnCompletarSeriesContr').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#confirmOk').click();
  await page.waitForFunction(() => /completas|criada|padronizada|sobreposi|revisão|aviso/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#confirmModal').isVisible(), false, 'série inteira visível: nenhum aviso de parcela escondida');
  assert.deepEqual(erros, []);
  await page.close();
});

test('Filtro de Status não gera aviso falso de parcela escondida, mesmo com a descrição trocada', async () => {
  const post = (ep, body) => fetch(`${BASE}${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(body) });
  // Descrição trocada na contemplação: 01–03 PAGAS com o nome antigo, 04–06 pendentes com o novo.
  const SER = { banco: 'Banco ocultas3 E2E', produto: 'Consórcio', empresa: 'SUL', grupo: 'E2EOC3', cota: '7', valorParcela: 50 };
  const itens = [1, 2, 3, 4, 5, 6].map((n) => ({
    ...SER, parcela: `${n}/6`, vencimento: `10/0${n}/2026`,
    material: n <= 3 ? 'Nome antigo ocultas3 E2E' : 'Nome novo ocultas3 E2E',
    ...(n <= 3 ? { dataPagamento: `10/0${n}/2026`, valorPago: 50 } : {}),
  }));
  assert.equal((await post('/api/contratos/lote-criar', { itens })).status, 201);

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/contratos`, { waitUntil: 'load' });
  await page.locator('#contratosSubtabs').waitFor({ state: 'visible', timeout: 5000 });
  // Busca que casa OS DOIS nomes + Status = Pendente: as pagas somem pelo filtro, não pelo nome.
  await page.locator('#buscaContr').fill('ocultas3');
  await page.evaluate(() => { MSEL.fcStatus.setSelecionados(['Pendente']); filtrarContr(); });
  await page.waitForFunction(() => document.querySelectorAll('#corpoContr tr').length === 3);

  // Modal: série completa, as escondidas o são pelo Status → só o aviso de sempre, sem diálogo.
  await page.locator('#corpoContr tr', { hasText: '04/06' }).locator('.edit-contr').click();
  await page.locator('#gerarSerieContr').click();
  await page.waitForFunction(() => /já está completa/.test(document.getElementById('toast').textContent));
  assert.equal(await page.locator('#confirmModal').isVisible(), false, 'recorte de Status é intencional: nenhum aviso de "descrição diferente"');
  await page.locator('#cancelarContrato').click();

  // Global: idem — e o filtro escolhido continua lá.
  await page.evaluate(() => { const t = document.getElementById('toast'); t.textContent = ''; t.className = 'toast'; });
  await page.locator('#btnCompletarSeriesContr').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#confirmOk').click();
  await page.waitForFunction(() => /completas|criada|padronizada|sobreposi|revisão|aviso/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#confirmModal').isVisible(), false, 'nenhum aviso falso com o filtro de Status');
  assert.deepEqual(await page.evaluate(() => getSel('fcStatus')), ['Pendente'], 'o filtro do usuário não é apagado');
  assert.deepEqual(erros, []);
  await page.close();
});

test('Lançamento novo encaixa na série existente: gera só o que falta e avisa da parcela escondida', async () => {
  const post = (ep, body) => fetch(`${BASE}${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(body) });
  const SER = { banco: 'Banco ocultas2 E2E', produto: 'Consórcio', empresa: 'SUL', grupo: 'E2EOC2', cota: '9', valorParcela: 200 };
  // Existem 01/06 e 02/06 (nome novo) e 06/06 (nome antigo). Faltam 03, 04 e 05.
  const itens = [
    { ...SER, parcela: '1/6', vencimento: '10/01/2027', material: 'Nome novo ocultas2 E2E' },
    { ...SER, parcela: '2/6', vencimento: '10/02/2027', material: 'Nome novo ocultas2 E2E' },
    { ...SER, parcela: '6/6', vencimento: '10/06/2027', material: 'Nome antigo ocultas2 E2E' },
  ];
  assert.equal((await post('/api/contratos/lote-criar', { itens })).status, 201);
  const serieId = (await (await fetch(`${BASE}/api/contratos`)).json()).find((c) => c.grupo === 'E2EOC2').serieId;

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/contratos`, { waitUntil: 'load' });
  await page.locator('#contratosSubtabs').waitFor({ state: 'visible', timeout: 5000 });
  await page.locator('#buscaContr').fill('Nome novo ocultas2 E2E');
  await page.waitForFunction(() => document.querySelectorAll('#corpoContr tr').length === 2);

  // Lançamento NOVO (não salvo) 03/06 com o nome novo → "Gerar série completa".
  await page.locator('#btnAddContr').click();
  const campo = (n) => page.locator(`#formContrato [name="${n}"]`);
  for (const [n, v] of Object.entries({ banco: SER.banco, produto: SER.produto, empresa: SER.empresa, material: 'Nome novo ocultas2 E2E', grupo: SER.grupo, cota: SER.cota, parcela: '3/6', valorParcela: '200', vencimento: '10/03/2027' })) {
    await campo(n).fill(v);
  }
  await page.locator('#gerarSerieContr').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  const texto = await page.locator('#confirmTexto').innerText();
  // Antes: a tela não enxergava a série (lançamento sem ID de série) e pedia para gerar as 6.
  assert.match(texto, /^Gerar 3 parcela\(s\) que faltam/, 'só 03, 04 e 05 faltam: a tela encaixa o lançamento novo na série existente');
  assert.match(texto, /Atenção: 06\/06 já existe nesta série, mas não aparece na lista porque está cadastrada com descrição diferente/);
  await page.locator('#confirmOk').click();
  await page.waitForFunction(() => /já existia\(m\) fora da lista/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
  assert.equal(await page.locator('#toast .toast-acao').innerText(), 'Mostrar a série');
  await page.locator('#toast .toast-acao').click(); // antes das conferências: o aviso some em 6 s
  await page.waitForFunction(() => document.querySelectorAll('#corpoContr tr').length === 6);
  assert.equal(await page.locator('#buscaContr').inputValue(), 'E2EOC2 / 9');

  const serie = (await (await fetch(`${BASE}/api/contratos`)).json()).filter((c) => c.grupo === 'E2EOC2')
    .sort((a, b) => Number(a.parcela.split('/')[0]) - Number(b.parcela.split('/')[0]));
  assert.deepEqual(serie.map((c) => c.parcela), ['01/06', '02/06', '03/06', '04/06', '05/06', '06/06'], 'nenhuma duplicada, nenhuma faltando');
  assert.deepEqual(serie.slice(2, 5).map((c) => c.vencimento), ['10/03/2027', '10/04/2027', '10/05/2027']);
  assert.ok(serie.every((c) => c.serieId === serieId), 'as novas entram na MESMA série');
  assert.deepEqual(erros, []);
  await page.close();
});

test('Multas cria pastas aninhadas e move arquivos entre elas', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.goto(`${PAINEL}/multas/termos`, { waitUntil: 'load' });
  await page.locator('#multasSubtabs .subtab[data-sub="multas-termos"]').waitFor({ state: 'visible' });
  assert.ok(await page.locator('#multas-termos').isVisible());
  const criarPasta = async (nome) => {
    await page.locator('#btnAddPastaTermos').click();
    await page.locator('#formPastaTermoMulta [name="nome"]').fill(nome);
    await page.locator('#formPastaTermoMulta button[type="submit"]').click();
    const pasta = page.locator('[data-pasta-id]', { hasText: nome });
    await pasta.waitFor({ state: 'visible' });
    return pasta;
  };

  await page.locator('[data-termos-modelos]').click();
  await page.locator('#btnAddTermoModelo').click();
  await page.locator('#formTermoMulta [name="titulo"]').fill('Modelo de indicação E2E');
  await page.locator('#formTermoMulta [name="arquivo"]').setInputFiles({
    name: 'modelo-indicacao.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: await criarDocxTeste(),
  });
  await page.locator('#formTermoMulta button[type="submit"]').click();
  await page.locator('#termosMultaCards [data-termo-id]', { hasText: 'Modelo de indicação E2E' }).waitFor({ state: 'visible' });
  await page.locator('#termosMultaVoltar').click();

  const arquivo = await criarPasta('Arquivados E2E');
  const carros = await criarPasta('Carros E2E');
  await carros.locator('[data-abrir-pasta]').click();
  const veiculo = await criarPasta('TME1E23');
  await veiculo.locator('[data-abrir-pasta]').click();
  const motorista = await criarPasta('Motorista E2E');
  await motorista.locator('[data-abrir-pasta]').click();

  await page.locator('#btnAddTermoAssinado').click();
  await page.locator('#formTermoMulta [name="placa"]').fill('TME1E23');
  await page.locator('#formTermoMulta [name="motorista"]').fill('Motorista E2E');
  await page.locator('#formTermoMulta [name="titulo"]').fill('Termo assinado E2E');
  await page.locator('#formTermoMulta [name="arquivo"]').setInputFiles({
    name: 'termo-assinado.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% termo e2e\n'),
  });
  await page.locator('#formTermoMulta button[type="submit"]').click();
  const termo = page.locator('#termosMultaCards [data-termo-id]', { hasText: 'Termo assinado E2E' });
  await termo.waitFor({ state: 'visible' });

  await termo.locator('[data-acao="mover"]').click();
  await escolherNoSelect(page, page.locator('#formMoverTermoMulta .cs-btn'), { hasText: 'Início / Arquivados E2E' });
  await page.locator('#formMoverTermoMulta button[type="submit"]').click();
  await termo.waitFor({ state: 'detached' });

  await page.locator('#termosMultaVoltar').click();
  await page.locator('#termosMultaVoltar').click();
  await page.locator('#termosMultaVoltar').click();
  await arquivo.locator('[data-abrir-pasta]').click();
  await page.locator('#termosMultaCards [data-termo-id]', { hasText: 'Termo assinado E2E' }).waitFor({ state: 'visible' });

  await page.locator('#termosMultaVoltar').click();
  await page.locator('[data-termos-modelos]').click();
  const modelo = page.locator('#termosMultaCards [data-termo-id]', { hasText: 'Modelo de indicação E2E' });
  await modelo.waitFor({ state: 'visible' });
  assert.equal(await modelo.locator('a[download]').count(), 1, 'modelo deve ter download para edição local');

  await page.close();
});

test('EPI - Controle troca de sub-aba de verdade (só uma visível por vez)', async (t) => {
  // Regressão de CSS, não de JS: `.epi-dash { display: grid }` tinha a MESMA especificidade de
  // `.subview { display: none }` e, vindo depois no styles.css, vencia — o Dashboard ficava
  // visível em TODAS as sub-abas e a tela parecia não mudar. Conferir a classe `.active` não
  // pega isso; só o `display` computado pega. Por isso este teste mede o display.
  const criarEpi = async (corpo) => (await (await fetch(`${BASE}/api/epi/catalogo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ contratos: [CONTRATO_EPI], ...corpo }),
  })).json());
  const epi = await criarEpi({ nome: 'Capacete E2E', codigo: 'E2E-CAP', ca: '99999', estoqueInicial: 3 });
  // Os outros dois estados da coluna Estoque (abaixo do mínimo, com a seta ▼; e zerado, com a
  // etiqueta contornada) — é entre eles que o número saía do eixo.
  const epiBaixo = await criarEpi({ nome: 'Luva E2E baixa', codigo: 'E2E-LUV', ca: '99998', estoqueInicial: 2, estoqueMinimo: 10 });
  const epiZero = await criarEpi({ nome: 'Bota E2E zerada', codigo: 'E2E-BOT', ca: '99997', estoqueMinimo: 4 });
  const criados = [epi, epiBaixo, epiZero];
  t.after(async () => {
    const d = await (await fetch(`${BASE}/api/epi`)).json();
    const ids = criados.map((e) => e.id);
    for (const m of d.movimentacoes.filter((x) => (x.itens || []).some((i) => ids.includes(i.epiId)))) {
      await fetch(`${BASE}/api/epi/movimentacoes/${m.id}`, { method: 'DELETE', headers: ORIG });
    }
    for (const id of ids) await fetch(`${BASE}/api/epi/catalogo/${id}`, { method: 'DELETE', headers: ORIG });
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/epi`, { waitUntil: 'load' });
  await page.locator('#epiSubtabs').waitFor({ state: 'visible' });

  const visiveis = () => page.evaluate(() => [...document.querySelectorAll('#epi .subview')]
    .filter((v) => getComputedStyle(v).display !== 'none').map((v) => v.id));

  assert.deepEqual(await visiveis(), ['epi-dashboard'], 'a aba deve abrir só no Dashboard');
  for (const alvo of ['epi-catalogo', 'epi-fichas', 'epi-movimentacoes', 'epi-dashboard']) {
    await page.locator(`#epiSubtabs .subtab[data-sub="${alvo}"]`).click();
    await page.locator(`#${alvo}.subview.active`).waitFor({ state: 'visible' });
    assert.deepEqual(await visiveis(), [alvo], `ao abrir ${alvo}, só ele deveria estar visível`);
  }

  // O EPI criado tem de aparecer no catálogo, com a pílula de status do CA.
  await page.locator('#epiSubtabs .subtab[data-sub="epi-catalogo"]').click();
  const linha = page.locator('#corpoEpiCat tr', { hasText: 'Capacete E2E' });
  await linha.waitFor({ state: 'visible' });
  assert.equal(await linha.locator('.epi-ca').count(), 1, 'a linha deve trazer a pílula de status do CA');
  assert.match(await linha.locator('.epi-est').innerText(), /3/, 'o estoque derivado do saldo inicial deve aparecer');

  // Alinhamento da coluna ESTOQUE — regressão de GEOMETRIA, que conferir classe não pega:
  // `.epi-est { justify-content: flex-end }` grudava o número na direita enquanto o <th> seguia
  // centralizado (`table th, table td { text-align: center !important }`), e a seta ▼ / a moldura
  // do zerado empurravam o dígito só nas linhas em que aparecem. Mede o eixo, não o CSS.
  const eixos = await page.evaluate(() => {
    const meio = (el) => { const r = el.getBoundingClientRect(); return r.left + r.width / 2; };
    const th = document.querySelector('#tabelaEpiCat thead th.cel-estoque');
    const cels = [...document.querySelectorAll('#corpoEpiCat td.cel-estoque .epi-est-n')];
    return {
      th: meio(th),
      nums: cels.map((el) => ({
        valor: el.innerText, eixo: meio(el),
        largura: el.getBoundingClientRect().width,
        raio: getComputedStyle(el).borderTopLeftRadius,
      })),
    };
  });
  assert.ok(eixos.nums.length >= 3, `esperava 3 linhas na coluna Estoque, veio ${eixos.nums.length}`);
  for (const n of eixos.nums) {
    assert.ok(Math.abs(n.eixo - eixos.th) <= 1,
      `"${n.valor}" deve ficar no eixo do título ESTOQUE (th ${eixos.th}, valor ${n.eixo})`);
    // Pílula (raio 999px), como as demais da tela — e não texto solto nem moldura retangular.
    assert.equal(n.raio, '999px', `o saldo "${n.valor}" deve ser uma pílula`);
  }
  // Todas as pílulas com a MESMA largura, em qualquer estado: pílulas de tamanhos diferentes na
  // mesma coluna (o "0" e o "-1" tinham) é o que fazia a coluna parecer desigual.
  const larguras = eixos.nums.map((n) => n.largura);
  assert.ok(Math.max(...larguras) - Math.min(...larguras) <= 0.5,
    `as pílulas de estoque devem ter a mesma largura (${larguras.join(', ')})`);

  // Deep link direto e Voltar do navegador.
  await page.goto(`${PAINEL}/epi/movimentacoes`, { waitUntil: 'load' });
  await page.locator('#epi-movimentacoes.subview.active').waitFor({ state: 'visible' });
  assert.deepEqual(await visiveis(), ['epi-movimentacoes'], 'deep link deve abrir direto na sub-aba');

  const reais = erros.filter((e) => !/Failed to load resource|net::ERR|CDN|cdn/i.test(e));
  assert.equal(reais.length, 0, 'erros de JS na aba de EPI:\n' + reais.join('\n'));
  await page.close();
});

test('coluna AÇÕES: botões no meio da linha e em coluna, mesmo com alturas e botões diferentes', async (t) => {
  // Bug visual relatado: `.acoes` era um flex alinhado à esquerda, então a linha que não tinha
  // uma das ações puxava as seguintes uma casa para o lado (na ficha assinada o download
  // aparecia embaixo da assinatura das outras) e o <td> não acompanhava a altura da linha.
  // Conferir a contagem de botões não pega isso; só medir a POSIÇÃO pega. Daí a régua abaixo.
  // A vaga reservada (`.acoes-vaga`) vive no Almoxarifado — está no teste seguinte.
  const epi = await (await fetch(`${BASE}/api/epi/catalogo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Luva alinhamento', codigo: 'E2E-ALI', ca: '77777', unidade: 'par', estoqueInicial: 10, contratos: [CONTRATO_EPI] }),
  })).json();
  const criarFicha = async (nome) => (await (await fetch(`${BASE}/api/epi/movimentacoes`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ tipo: 'Entrega', funcionarioNome: nome, data: '2026-07-20', contratoNumero: CONTRATO_EPI, itens: [{ epiId: epi.id, quantidade: 1 }], responsavel: 'Almoxarife E2E' }),
  })).json()).id;
  const fichas = [await criarFicha('Ana Alinhamento'), await criarFicha('Bruno Alinhamento'), await criarFicha('Carla Alinhamento')];
  t.after(async () => {
    for (const id of fichas) await fetch(`${BASE}/api/epi/movimentacoes/${id}`, { method: 'DELETE', headers: ORIG });
    const d = await (await fetch(`${BASE}/api/epi`)).json();
    for (const m of d.movimentacoes.filter((x) => (x.itens || []).some((i) => i.epiId === epi.id))) {
      await fetch(`${BASE}/api/epi/movimentacoes/${m.id}`, { method: 'DELETE', headers: ORIG });
    }
    await fetch(`${BASE}/api/epi/catalogo/${epi.id}`, { method: 'DELETE', headers: ORIG });
  });
  // Assina só a do MEIO: a lista fica com linhas de 4 e de 3 botões ao mesmo tempo.
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAAH/e5Ea1QAAAABJRU5ErkJggg==';
  const rAss = await fetch(`${BASE}/api/epi/movimentacoes/${fichas[1]}/assinar`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ imagem: png, aceite: true, modo: 'desenho' }),
  });
  assert.equal(rAss.status, 200, 'a ficha do meio precisa ficar assinada para o teste valer');

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/epi/fichas`, { waitUntil: 'load' });
  await page.locator('#corpoEpiFichas tr').first().waitFor({ state: 'visible' });

  // Uma ficha pendente serve de régua; na assinada, "assinar" e "link" viram ícones
  // DESABILITADOS na mesma casa (apagados, sem clique) em vez de desaparecer — é isso que
  // mantém PDF/editar/excluir batendo em coluna de uma linha para a outra.
  const medir = () => page.evaluate(() => {
    const linhas = [...document.querySelectorAll('#corpoEpiFichas tr')]
      .filter((tr) => /Alinhamento/.test(tr.innerText))
      .map((tr) => {
        const cel = tr.querySelector('td.acoes');
        const vizinha = tr.querySelector('td'); // 1ª célula: a altura que a LINHA realmente tem
        const rc = tr.getBoundingClientRect(), cc = cel.getBoundingClientRect();
        const b1 = cel.querySelector('button:not(.acoes-vaga)').getBoundingClientRect();
        return {
          nome: tr.innerText.split('\n')[0],
          assinada: !!cel.querySelector('.epi-assinar[disabled]'),
          xs: [...cel.children].map((c) => Math.round(c.getBoundingClientRect().left)),
          classes: [...cel.children].map((c) => c.className),
          travados: [...cel.querySelectorAll('button[disabled]')]
            .map((b) => ({ classe: b.className, clicavel: getComputedStyle(b).pointerEvents !== 'none' })),
          alturaLinha: Math.round(rc.height),
          celulaAcompanhaALinha: Math.round(cc.height) === Math.round(vizinha.getBoundingClientRect().height),
          desvioDoCentro: Math.round((b1.top + b1.height / 2) - (rc.top + rc.height / 2)),
        };
      });
    return linhas;
  });
  const linhas = await medir();
  assert.equal(linhas.length, 3, 'as três fichas do teste deveriam estar na lista');
  const pendente = linhas.find((l) => !l.assinada);
  const assinada = linhas.find((l) => l.assinada);
  assert.ok(pendente && assinada, 'precisa de uma ficha assinada e uma pendente na mesma lista');
  assert.deepEqual(assinada.classes, pendente.classes,
    'a ficha assinada deve ter as MESMAS casas da pendente — assinar e link só ficam desabilitados');
  for (let i = 0; i < pendente.xs.length; i++) {
    assert.equal(assinada.xs[i], pendente.xs[i],
      `casa ${i + 1} da linha assinada (${assinada.xs[i]}px) deveria estar na mesma vertical da linha pendente (${pendente.xs[i]}px)`);
  }
  // Ocupar o lugar não pode virar ação fantasma: o ícone indisponível fica apagado e sem clique.
  assert.deepEqual(assinada.travados.map((t) => t.classe).sort(), ['epi-assinar', 'epi-link'],
    'na ficha assinada, assinar e link devem ficar no lugar mas desabilitados');
  assert.ok(assinada.travados.every((t) => !t.clicavel), 'ação indisponível não pode aceitar clique');
  assert.equal(pendente.travados.length, 0, 'a ficha pendente não deve ter nenhuma ação desabilitada');
  // VERTICAL — o defeito que dava o "espaçamento irregular" na lista: com `display: flex` o <td>
  // não acompanhava a altura da linha (ficava nos 41px do conteúdo enquanto as vizinhas iam a 48
  // ou 57px, porque o nome ocupava duas linhas), e os botões paravam acima do centro. Estas duas
  // medidas são o que garante o ritmo da lista — a linha assinada é a mais alta (tem o "cód.").
  for (const l of linhas) {
    assert.ok(l.celulaAcompanhaALinha,
      `a célula de ações de "${l.nome}" (linha de ${l.alturaLinha}px) deve ter a mesma altura das outras células da linha`);
    assert.equal(l.desvioDoCentro, 0,
      `os botões de "${l.nome}" deveriam estar no meio da linha, e estão ${l.desvioDoCentro}px fora`);
  }
  assert.ok(new Set(linhas.map((l) => l.alturaLinha)).size > 1,
    'o teste só vale com linhas de ALTURAS diferentes na mesma lista (é isso que expõe o bug)');

  const reais = erros.filter((e) => !/Failed to load resource|net::ERR|CDN|cdn/i.test(e));
  assert.equal(reais.length, 0, 'erros de JS na aba de EPI:\n' + reais.join('\n'));
  await page.close();
});

test('Almoxarifado reserva o lugar do botão que a linha não tem (vaga invisível do tamanho do botão)', async (t) => {
  // `ACAO_VAGA` só é renderizado aqui: a retirada SEM item retornável não tem "devolver".
  // Sem a vaga, recibo/editar/excluir subiam uma casa e deixavam de bater em coluna com as
  // linhas que têm o botão. A medida da vaga tem de sair do próprio botão (o tamanho muda por
  // tabela e por largura de tela — foi por chutar 32px que a linha saiu 2px fora de lugar).
  const criar = (nome, retornavel) => fetch(`${BASE}/api/almoxarifado`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({
      funcionarioNome: nome, data: '2026-07-21', responsavel: 'Almoxarife E2E',
      itens: [{ nome: 'Chave inglesa', quantidade: 1, unidade: 'un', retornavel }],
    }),
  }).then((r) => r.json());
  const comDevolver = await criar('Dario Vaga', true);
  const semDevolver = await criar('Elza Vaga', false);
  t.after(async () => {
    for (const r of [comDevolver, semDevolver]) {
      await fetch(`${BASE}/api/almoxarifado/${r.id}`, { method: 'DELETE', headers: ORIG });
    }
  });

  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/almoxarifado/retiradas`, { waitUntil: 'load' });
  await page.locator('#corpoAlmox tr').first().waitFor({ state: 'visible' });

  const dados = await page.evaluate(() => {
    const linha = (nome) => {
      const tr = [...document.querySelectorAll('#corpoAlmox tr')].find((x) => x.innerText.includes(nome));
      if (!tr) return null;
      const cel = tr.querySelector('td.acoes');
      return {
        classes: [...cel.children].map((c) => c.className),
        xs: [...cel.children].map((c) => Math.round(c.getBoundingClientRect().left)),
      };
    };
    const el = document.querySelector('#corpoAlmox .acoes-vaga');
    const botao = document.querySelector('#corpoAlmox td.acoes button:not(.acoes-vaga)');
    const cx = (n) => ({ w: Math.round(n.getBoundingClientRect().width), h: Math.round(n.getBoundingClientRect().height) });
    return {
      comDevolver: linha('Dario Vaga'), semDevolver: linha('Elza Vaga'),
      vaga: el ? {
        caixa: cx(el), botao: cx(botao), visibilidade: getComputedStyle(el).visibility,
        desabilitado: el.disabled, foraDoLeitor: el.getAttribute('aria-hidden'),
      } : null,
    };
  });
  assert.ok(dados.comDevolver && dados.semDevolver, 'as duas retiradas do teste deveriam estar na lista');
  assert.ok(dados.vaga, 'a retirada sem item retornável deveria reservar o lugar do botão "devolver"');
  assert.ok(dados.semDevolver.classes.includes('acoes-vaga'), 'o lugar do "devolver" deve ficar reservado');
  assert.equal(dados.semDevolver.xs.length, dados.comDevolver.xs.length,
    'as duas linhas devem ter o mesmo número de casas');
  for (let i = 0; i < dados.comDevolver.xs.length; i++) {
    assert.equal(dados.semDevolver.xs[i], dados.comDevolver.xs[i],
      `casa ${i + 1} da retirada sem devolução (${dados.semDevolver.xs[i]}px) deveria estar na mesma vertical da que tem devolução (${dados.comDevolver.xs[i]}px)`);
  }
  assert.deepEqual(dados.vaga.caixa, dados.vaga.botao, 'a vaga deve ocupar exatamente a caixa de um botão daquela tabela');
  assert.equal(dados.vaga.visibilidade, 'hidden', 'a vaga não pode ser vista');
  assert.equal(dados.vaga.desabilitado, true, 'a vaga não pode ser clicada nem focada');
  assert.equal(dados.vaga.foraDoLeitor, 'true', 'a vaga deve ficar fora do leitor de tela');

  const reais = erros.filter((e) => !/Failed to load resource|net::ERR|CDN|cdn/i.test(e));
  assert.equal(reais.length, 0, 'erros de JS na aba do Almoxarifado:\n' + reais.join('\n'));
  await page.close();
});

test('lista de contratos do "Novo EPI" aparece inteira, sem morrer na borda do modal', async () => {
  // Bug relatado (print): no modal "Novo EPI" os últimos contratos da lista saíam cortados. O
  // `.msel-menu` era `position:absolute` dentro do `.msel`, que vive no `.modal` — e o
  // `overflow:auto; max-height:92vh` do modal recortava o pedaço do menu que passava da borda.
  // Conferir a contagem de opções NÃO pega isso (todas estão no DOM, só invisíveis); só medir
  // o recorte pega. Daí a régua abaixo, que intersecta o menu com todos os ancestrais que
  // recortam. Janela baixa (a do print, ~670px de altura): é onde o corte aparecia.
  // A janela do print tinha ~670px, mas a casca do Design System encolheu o modal (cabeçalho
  // mais denso, controles menores) e, em 660px, ele PAROU de rolar — a pré-condição "o modal
  // rola" virou tautologia: o trecho de "rolar o modal com o menu aberto" media um menu que
  // nunca se movia. A altura agora é DERIVADA do conteúdo real: o .modal é max-height:92vh,
  // então basta uma janela em que 92vh fique bem abaixo da altura do formulário. Assim o teste
  // sobrevive ao próximo ajuste de densidade — para qualquer lado.
  let ALTURA = 660;
  const page = await browser.newPage({ viewport: { width: 1100, height: ALTURA } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/epi/catalogo`, { waitUntil: 'load' });
  await page.locator('#btnAddEpi').click();
  await page.locator('#epiModal .modal').waitFor({ state: 'visible' });
  await page.evaluate(() => document.fonts.ready);
  const conteudoModal = await page.locator('#epiModal .modal').evaluate((el) => el.scrollHeight);
  // 92vh da janela precisa ficar ~120px abaixo do conteúdo para haver rolagem de sobra.
  ALTURA = Math.max(420, Math.min(660, Math.floor((conteudoModal - 120) / 0.92)));
  await page.setViewportSize({ width: 1100, height: ALTURA });
  // Espera as fontes da web assentarem ANTES de abrir o menu. Com `display=swap` (5 famílias no
  // index.html) o texto entra na fonte de sistema e é remedido quando a real chega: o modal muda
  // de altura, ganha ou perde a barra de rolagem e o campo muda ~9px de largura. O menu é portado
  // para o <body> e ancorado com a largura do campo NAQUELE instante (ancorarMenuFixo), então
  // medir no meio do swap acusava ora "menu mais estreito que o campo", ora "o modal nem rola".
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => {
    const larg = Math.round(document.querySelector('#epiContratosMsel .msel-btn').getBoundingClientRect().width);
    const parado = larg === window.__campoLarg;
    window.__campoLarg = larg;
    return parado;
  });
  await page.locator('#epiContratosMsel .msel-btn').click();
  // A animação de entrada (menuIn) abre em scale(.97): medir no meio dela devolveria um menu 3%
  // menor do que o real — e um menu menor "não parece cortado". Espera assentar: mede a caixa
  // (o que FORÇA o recálculo de estilo que cria a animação — só conferir getAnimations() logo
  // após o clique dá "nenhuma animação rodando" porque ela ainda nem começou) e exige duas
  // medidas iguais seguidas com a animação já terminada.
  await page.waitForFunction(() => {
    const m = document.querySelector('.msel-menu:not([hidden])');
    if (!m) return false;
    const larg = Math.round(m.getBoundingClientRect().width);
    const parado = larg === window.__mselLarg;
    window.__mselLarg = larg;
    return parado && m.getAnimations().every((a) => a.playState !== 'running');
  });

  // Retângulo REALMENTE visível de um elemento = ele intersectado com a janela e com a caixa de
  // todo ancestral que recorta (overflow != visible). É o que enxerga o corte do modal.
  const medir = () => page.evaluate(() => {
    const menu = document.querySelector('#epiContratosMsel .msel-menu:not([hidden])')
      || document.querySelector('.msel-menu.msel-menu-flutuante:not([hidden])');
    if (!menu) return null;
    const rec = (el) => {
      const box = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const st = getComputedStyle(p);
        if (!/visible/.test(st.overflow + st.overflowX + st.overflowY)) {
          const r = p.getBoundingClientRect();
          box.top = Math.max(box.top, r.top); box.left = Math.max(box.left, r.left);
          box.right = Math.min(box.right, r.right); box.bottom = Math.min(box.bottom, r.bottom);
        }
      }
      return box;
    };
    const itens = [...menu.querySelectorAll('.msel-item')];
    const r = menu.getBoundingClientRect();
    return {
      menu: { top: r.top, bottom: r.bottom, left: r.left, right: r.right, largura: r.width },
      recorte: rec(menu),
      gatilho: document.querySelector('#epiContratosMsel .msel-btn').getBoundingClientRect().width,
      qtd: itens.length,
      ultimo: itens.length ? itens[itens.length - 1].innerText.trim() : '',
      // O menu tem de ter UMA rolagem só: dois "max-height" (o do menu e o da lista) davam
      // barra dentro de barra.
      rolaveis: [menu, menu.querySelector('.msel-itens')]
        .filter((el) => el.scrollHeight > el.clientHeight + 1).length,
      buscaOculta: getComputedStyle(menu.querySelector('.msel-busca')).display === 'none',
      rodapeOculto: getComputedStyle(menu.querySelector('.msel-foot')).display === 'none',
    };
  });

  const m = await medir();
  assert.ok(m, 'o dropdown de contratos deveria abrir');
  assert.ok(m.qtd >= 5, `esperava a lista de contratos do catálogo, veio ${m.qtd} item(ns)`);
  const folga = 1;
  assert.ok(m.menu.bottom <= m.recorte.bottom + folga,
    `o fim da lista está cortado: menu vai até ${Math.round(m.menu.bottom)}px e só se enxerga até ${Math.round(m.recorte.bottom)}px`);
  assert.ok(m.menu.top >= m.recorte.top - folga,
    `o começo da lista está cortado: menu começa em ${Math.round(m.menu.top)}px e só se enxerga a partir de ${Math.round(m.recorte.top)}px`);
  assert.ok(m.menu.bottom <= ALTURA + folga && m.menu.top >= -folga, 'o menu não pode passar da janela');
  // Largura do gatilho: portado para o <body>, o `width:100%` resolveria contra o <body> e o
  // `max-width:300px` do .msel-menu encolheria a lista — ambos deixariam o menu fora do campo.
  assert.ok(Math.abs(m.menu.largura - m.gatilho) <= 1,
    `o menu deveria ter a largura do campo (campo ${Math.round(m.gatilho)}px, menu ${Math.round(m.menu.largura)}px)`);
  assert.equal(m.rolaveis <= 1, true, 'a lista deve ter uma rolagem só (menu OU itens, nunca as duas)');
  // A cara de "lista" (sem busca nem rodapé) tem de sobreviver à mudança de lugar no DOM.
  assert.equal(m.buscaOculta, true, 'o dropdown de contratos não tem campo de busca');
  assert.equal(m.rodapeOculto, true, 'o dropdown de contratos não tem rodapé "Limpar seleção"');

  // Rolar o modal com o menu aberto: ele tem de acompanhar o campo, continuar dentro da tela e
  // NÃO piscar — ancorarMenuFixo zera e devolve o `animation` para medir, e devolver reiniciava
  // a animação de entrada (menuIn, que começa em opacity 0): o menu sumia a cada rolagem.
  const rolou = await page.evaluate(() => {
    const el = document.querySelector('#epiModal .modal');
    // Com a janela mais baixa o navegador pode já ter rolado o modal até o fim para manter o
    // campo focado à vista — e "fim + 60" não sai do lugar. Normaliza para o topo primeiro:
    // o que se mede é "o modal TEM rolagem", não "está numa posição específica".
    el.scrollTop = 0;
    const antes = el.scrollTop;
    el.scrollTop = antes + 60;
    return { moveu: el.scrollTop > antes, conteudo: el.scrollHeight, visivel: el.clientHeight, janela: window.innerHeight };
  });
  assert.equal(rolou.moveu, true,
    `o modal precisa rolar de verdade, senão este trecho não testa nada (conteúdo ${rolou.conteudo}px, visível ${rolou.visivel}px, janela ${rolou.janela}px)`);
  // O evento de rolagem só é disparado na próxima renderização — sem esperar o quadro, mediríamos
  // o menu ainda na posição antiga (e o teste passaria sem testar nada).
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  const rolado = await page.evaluate(() => {
    const b = document.querySelector('#epiContratosMsel .msel-btn').getBoundingClientRect();
    const m = document.querySelector('.msel-menu:not([hidden])');
    const r = m.getBoundingClientRect();
    return {
      grudado: Math.abs(r.top - b.bottom) <= 6 || Math.abs(b.top - r.bottom) <= 6, // abre p/ baixo ou p/ cima
      opacidade: getComputedStyle(m).opacity, dentro: r.top >= -1 && r.bottom <= innerHeight + 1,
    };
  });
  assert.equal(rolado.grudado, true, 'ao rolar o modal o menu deve continuar colado no campo');
  assert.equal(rolado.dentro, true, 'ao rolar o modal o menu não pode sair da tela');
  assert.equal(rolado.opacidade, '1', 'reposicionar o menu não pode reiniciar a animação (ele piscava)');

  // O ÚLTIMO contrato precisa ser clicável de verdade (é o que o print mostrava cortado).
  const ultimo = page.locator('#epiContratosMsel .msel-item, .msel-menu-flutuante .msel-item').last();
  const nome = (await ultimo.innerText()).trim();
  await ultimo.scrollIntoViewIfNeeded();
  await ultimo.click();
  assert.equal(await page.locator('#epiContratosMsel .msel-count').innerText(), '1',
    `clicar no último contrato ("${nome}") deveria marcá-lo`);

  // Esc fecha primeiro o menu e depois o modal — sem deixar o menu flutuante órfão na tela.
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.msel-menu:not([hidden])').count(), 0, 'Esc deve fechar o dropdown');
  await page.keyboard.press('Escape');
  await page.locator('#epiModal').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('body > .msel-menu').count(), 0,
    'o menu não pode ficar solto no <body> depois que o modal fecha');

  const reais = erros.filter((e) => !/Failed to load resource|net::ERR|CDN|cdn/i.test(e));
  assert.equal(reais.length, 0, 'erros de JS no modal de EPI:\n' + reais.join('\n'));
  await page.close();
});

test('EPI › Notas Fiscais: lança, edita e exclui a compra pelo modal (sem prompt do navegador)', async (t) => {
  // A primeira versão da tela pedia os 8 campos em `prompt()` encadeados: no navegador real isso
  // é um diálogo nativo que TRAVA a página (e nem aparece em alguns contextos). Este teste passa
  // pelo modal de verdade — se alguém voltar ao prompt, o page.on('dialog') abaixo acusa.
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const erros = [];
  const dialogos = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  page.on('dialog', async (d) => { dialogos.push(d.type()); await d.dismiss(); });
  t.after(async () => {
    const notas = await (await fetch(`${BASE}/api/epi/notas-fiscais`)).json();
    for (const n of notas.filter((x) => /E2E/.test(x.numero))) {
      await fetch(`${BASE}/api/epi/notas-fiscais/${n.id}`, { method: 'DELETE', headers: ORIG });
    }
  });

  await page.goto(`${PAINEL}/epi/notas-fiscais`, { waitUntil: 'load' });
  await page.locator('#epi-notas-fiscais.subview.active').waitFor({ state: 'visible' });
  // Só a sub-aba de NF visível, e a barra de filtros compartilhada fora de cena (empresa,
  // colaborador e situação do CA não dizem nada sobre uma compra).
  const visiveis = await page.evaluate(() => [...document.querySelectorAll('#epi .subview')]
    .filter((v) => getComputedStyle(v).display !== 'none').map((v) => v.id));
  assert.deepEqual(visiveis, ['epi-notas-fiscais'], 'deep link deve abrir só a sub-aba de notas fiscais');
  assert.equal(await page.locator('#epi .epi-filtros-barra').isHidden(), true,
    'a barra de filtros do EPI não se aplica a compras e deve sumir aqui');

  // ---- Lançar ----
  await page.locator('#btnAddEpiNf').click();
  await page.locator('#epiNfModal .modal').waitFor({ state: 'visible' });
  const f = page.locator('#formEpiNf');
  // Campo de data com `name` recebe o proxy dd/mm/aaaa do datepicker do app (o <input type=date>
  // nativo fica display:none) — é nele que se digita, como nas outras abas.
  await f.locator('[name="dataCompra"] + .dp-input').fill('29/07/2026');
  await f.locator('[name="numero"]').fill('E2E-1001');
  await f.locator('[name="fornecedor"]').fill('Frigelar E2E');
  await f.locator('[name="descricao"]').fill('10 pares de luva de vaqueta e 5 botinas');
  await f.locator('[name="valorTotal"]').fill('1200');
  await f.locator('[name="parcelas"]').fill('3');
  await f.locator('[name="centroCusto"]').fill('ORION');
  // O aviso de parcela é calculado na hora (1200 / 3).
  await page.locator('#epiNfParcelaInfo').waitFor({ state: 'visible' });
  assert.match(await page.locator('#epiNfParcelaInfo').innerText(), /3x de R\$\s?400,00/,
    'o modal deve mostrar o valor da parcela enquanto se digita');
  await f.locator('button[type="submit"]').click();
  await page.locator('#epiNfModal').waitFor({ state: 'hidden' });

  const linha = page.locator('#corpoEpiNf tr', { hasText: 'E2E-1001' });
  await linha.waitFor({ state: 'visible' });
  assert.match(await linha.innerText(), /29\/07\/2026/, 'a data aparece no formato brasileiro');
  assert.match(await linha.innerText(), /1\.200,00/, 'o valor total aparece com centavos');
  assert.match(await linha.innerText(), /3x/, 'as parcelas aparecem na linha');
  assert.match(await page.locator('#epiNfResumo').innerText(), /1 nota\(s\) fiscal\(is\)/);

  // ---- Duplicidade: pergunta em vez de criar a compra repetida em silêncio ----
  await page.locator('#btnAddEpiNf').click();
  await page.locator('#epiNfModal .modal').waitFor({ state: 'visible' });
  await f.locator('[name="dataCompra"] + .dp-input').fill('30/07/2026');
  await f.locator('[name="numero"]').fill('E2E-1001');
  await f.locator('[name="fornecedor"]').fill('Frigelar E2E');
  await f.locator('[name="descricao"]').fill('lançamento repetido por engano');
  await f.locator('[name="valorTotal"]').fill('900');
  await f.locator('[name="centroCusto"]').fill('ORION');
  await f.locator('button[type="submit"]').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  assert.match(await page.locator('#confirmTexto').innerText(), /já está lançada/i);
  await page.locator('#confirmCancel').click();
  assert.equal(await page.locator('#corpoEpiNf tr').count(), 1, 'cancelar a duplicidade não lança a NF');
  await page.locator('#cancelarEpiNf').click();
  await page.locator('#epiNfModal').waitFor({ state: 'hidden' });

  // ---- Editar (a versão anterior só permitia excluir e digitar tudo de novo) ----
  await linha.locator('button[data-acao="editar"]').click();
  await page.locator('#epiNfModal .modal').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#epiNfTitulo').innerText(), 'Editar nota fiscal');
  assert.equal(await f.locator('[name="fornecedor"]').inputValue(), 'Frigelar E2E',
    'o modal deve abrir com os dados da nota');
  await f.locator('[name="valorTotal"]').fill('1500');
  // Anexo pelo componente padrão do app (input escondido + botão): o arquivo aparece na prévia
  // com ver/baixar/remover e só sobe ao cofre no submit.
  assert.match(await page.locator('#epiNfDocPrev').innerText(), /Nenhum arquivo anexado/i);
  await page.locator('#inputDocEpiNf').setInputFiles({
    name: 'nota-fiscal.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  });
  await page.locator('#epiNfDocPrev .prog-doc-item').waitFor({ state: 'visible' });
  await f.locator('button[type="submit"]').click();
  await page.locator('#epiNfModal').waitFor({ state: 'hidden' });
  await page.locator('#corpoEpiNf tr', { hasText: '1.500,00' }).waitFor({ state: 'visible' });
  const anexo = linha.locator('a[href^="/api/midia/"]');
  assert.equal(await anexo.count(), 1, 'a linha deve oferecer o anexo para abrir');
  const midiaResp = await page.request.get(BASE + (await anexo.getAttribute('href')));
  assert.equal(midiaResp.status(), 200, 'o anexo salvo tem de abrir de verdade');

  // ---- Busca e período ----
  await page.locator('#epiNfBusca').fill('nao-existe-esse-fornecedor');
  await page.locator('#epiNfVazio').waitFor({ state: 'visible' });
  await page.locator('#btnLimparEpiNf').click();
  await linha.waitFor({ state: 'visible' });

  // ---- Excluir ----
  await linha.locator('button[data-acao="excluir"]').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#confirmOk').click();
  await page.locator('#corpoEpiNf tr', { hasText: 'E2E-1001' }).waitFor({ state: 'detached' });

  assert.deepEqual(dialogos, [], 'a tela não deve usar prompt/alert do navegador: ' + dialogos.join(', '));
  const reais = erros.filter((e) => !/Failed to load resource|net::ERR|CDN|cdn/i.test(e));
  assert.equal(reais.length, 0, 'erros de JS na sub-aba de notas fiscais:\n' + reais.join('\n'));
  await page.close();
});

test('Funcionários › Detalhes: ações centradas na linha alta e anexo sem nome de arquivo virando coluna', async (t) => {
  // Dois defeitos relatados no print da aba (localhost), os dois só detectáveis MEDINDO:
  // 1) `.func-td-acoes` era `display: flex`, então o <td> saía do alinhamento da tabela: numa
  //    linha alta (colaborador com DOIS contratos → célula CONTRATO com duas linhas) a célula
  //    ficava mais baixa que a linha, os ícones subiam e a `border-bottom` dela virava um traço
  //    solto no meio da linha. Contar botões ou conferir classe não pega — só o eixo pega.
  // 2) Documento anexado e nunca renomeado mantém o nome do ARQUIVO ("2026(1) (31)_MERGED"), e a
  //    tabela criava uma coluna por nome — o arquivo de um colaborador virava coluna de todos.
  const ARQ = '2026(1) (31)_MERGED';
  const criados = [];
  const criar = async (corpo) => {
    const r = await fetch(`${BASE}/api/funcionarios`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(corpo),
    });
    assert.equal(r.status, 201);
    const f = await r.json();
    criados.push(f.id);
    return f;
  };
  t.after(async () => {
    for (const id of criados) await fetch(`${BASE}/api/funcionarios/${id}`, { method: 'DELETE', headers: ORIG });
  });

  await criar({
    nome: 'Alinha Dois Contratos E2E', empresa: 'NTE', cargo: 'Técnica de Segurança do Trabalho', status: 'Ativo',
    contratos: [
      { numero: '4600009505', nome: 'ORION SERVIÇOS DE EXECUÇÃO DE OBRAS DE CONSTRUÇÃO CIVIL', local: '' },
      { numero: '4600009606', nome: 'ATLAS CONSTRUÇÃO PREDIAL', local: '' },
    ],
    documentos: [{ nome: 'ASO', categoria: 'Segurança', validade: '2027-01-22' }],
  });
  await criar({
    nome: 'Anexo Sem Nome E2E', empresa: 'NTE', cargo: 'Engenheira Civil', status: 'Ativo',
    contratos: [{ numero: '4600009505', nome: 'ORION SERVIÇOS DE EXECUÇÃO DE OBRAS DE CONSTRUÇÃO CIVIL', local: '' }],
    // `nome` igual ao arquivo (sem extensão) = o usuário nunca renomeou — é o que a tela detecta.
    documentos: [{ nome: ARQ, nomeOriginal: `${ARQ}.pdf`, categoria: 'Pessoal', semValidade: true }],
  });

  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  await page.goto(`${PAINEL}/funcionarios/detalhes`, { waitUntil: 'load' });
  await page.locator('.func-tabela tbody tr').first().waitFor({ state: 'visible' });

  // ---- (1) Régua da coluna AÇÕES ----
  const linhas = await page.evaluate(() => {
    const meio = (el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2; };
    return [...document.querySelectorAll('.func-tabela tbody tr')].map((tr) => {
      const td = tr.querySelector('td.func-td-acoes');
      const bts = [...td.querySelectorAll('button')];
      return {
        nome: (tr.querySelector('.func-td-nome') || {}).textContent || '',
        alturaLinha: tr.getBoundingClientRect().height,
        alturaCelula: td.getBoundingClientRect().height,
        meioLinha: meio(tr),
        meioBotoes: bts.reduce((s, b) => s + meio(b), 0) / bts.length,
        eixoBotoes: bts.map((b) => Math.round(meio(b))),
      };
    });
  });
  const alta = linhas.find((l) => l.nome.includes('Alinha Dois Contratos'));
  assert.ok(alta, 'o colaborador de dois contratos precisa estar na tabela');
  assert.ok(alta.alturaLinha > 40, `a linha de dois contratos deveria ser alta (veio ${alta.alturaLinha}px)`);
  for (const l of linhas) {
    // A célula tem de acompanhar a altura da LINHA: se ficar menor, a borda dela desenha o traço solto.
    assert.ok(Math.abs(l.alturaCelula - l.alturaLinha) <= 1,
      `a célula de ações de "${l.nome}" deve ter a altura da linha (linha ${l.alturaLinha}, célula ${l.alturaCelula})`);
    assert.ok(Math.abs(l.meioBotoes - l.meioLinha) <= 1,
      `os botões de "${l.nome}" devem ficar no meio da linha (linha ${Math.round(l.meioLinha)}, botões ${Math.round(l.meioBotoes)})`);
    // Todos no MESMO eixo entre si (nenhum ícone deslocado do vizinho).
    assert.equal(new Set(l.eixoBotoes).size, 1, `os ícones de "${l.nome}" devem estar no mesmo eixo: ${l.eixoBotoes.join(', ')}`);
  }

  // ---- (2) Cabeçalhos ----
  // innerText vem com o `text-transform: uppercase` do cabeçalho aplicado — compara sem caixa.
  const cabecalhos = await page.locator('.func-tabela thead th').allInnerTexts();
  const limpos = cabecalhos.map((c) => c.replace(/[▲▼]/g, '').trim().toLocaleUpperCase('pt-BR'));
  assert.ok(!limpos.some((c) => c.includes('_MERGED')),
    `nome de arquivo não pode virar coluna: ${limpos.join(' | ')}`);
  assert.ok(limpos.includes('ASO'), 'documento com nome de verdade continua sendo coluna');
  assert.ok(limpos.includes('OUTROS ANEXOS'), `os anexos ainda com nome de arquivo entram numa coluna só: ${limpos.join(' | ')}`);
  // A coluna explica o que fazer para o documento virar coluna própria.
  const thOutros = page.locator('.func-tabela thead th', { hasText: 'Outros anexos' });
  assert.match(await thOutros.getAttribute('title'), /renomeie/i);
  // O anexo não desaparece: a linha de quem o tem mostra "anexo" e o title lista o nome do arquivo.
  const linhaAnexo = page.locator('.func-tabela tbody tr', { hasText: 'Anexo Sem Nome E2E' });
  const celOutros = linhaAnexo.locator('td.func-td-doc').last();
  assert.match(await celOutros.innerText(), /anexo/i, 'o anexo tem de continuar visível na coluna "Outros anexos"');
  // includes() e não RegExp: o nome do arquivo tem parênteses, que em regex viram grupos.
  const tituloCel = await celOutros.getAttribute('title');
  assert.ok(tituloCel.includes(ARQ), `o title da célula tem de dizer QUAL anexo é (veio: ${tituloCel})`);
  assert.match(tituloCel, /renomeie/i, 'e dizer como fazer o documento virar coluna própria');

  const reais = erros.filter((e) => !/Failed to load resource|net::ERR|CDN|cdn/i.test(e));
  assert.equal(reais.length, 0, 'erros de JS na aba de Funcionários:\n' + reais.join('\n'));
  await page.close();
});

// ---- Camada MOBILE (ago/2026, design-mobile.css + iniciarNavMobile) ----
// Asserts mínimos do visual novo de celular: barra inferior no lugar da sidebar,
// navegação pela barra atualizando o título, e sheet "Mais" com as demais áreas.
test('celular: barra inferior navega e a sidebar some', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  // domcontentloaded (não networkidle): o SSE de tempo real mantém a rede "ocupada" para sempre
  await page.goto(PAINEL, { waitUntil: 'domcontentloaded' });

  await page.locator('#mnav').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#sidebar').isVisible(), false, 'a sidebar não deve aparecer no celular');

  // navegar pela barra inferior usa o handler de aba de sempre (título + rota)
  await page.locator('#mnav .mnav-btn[data-mtab="multas"]').click();
  await page.waitForTimeout(400);
  assert.equal((await page.locator('#pageTitle').innerText()).trim(), 'Multas');
  assert.ok(page.url().includes('/painel/multas'), 'a rota deve acompanhar a aba');
  assert.ok(await page.locator('#mnav .mnav-btn[data-mtab="multas"]').evaluate((b) => b.classList.contains('ativo')),
    'o item da barra tem de acender junto com a aba');

  // sheet "Todas as áreas": mora na topbar (o meio da barra virou a ação de cadastro)
  await page.locator('#btnAreasTop').click();
  await page.locator('#msheet .msheet-item[data-mtab="fornecedores"]').click();
  await page.waitForTimeout(400);
  assert.equal((await page.locator('#pageTitle').innerText()).trim(), 'Fornecedores');
  assert.equal(await page.locator('#msheet').isVisible(), false, 'o sheet fecha ao escolher uma área');

  // botão do meio = ação principal da tela, e NÃO acende como se fosse aba
  await page.locator('#mnav .mnav-btn[data-mtab="frota"]').click();
  await page.waitForTimeout(400);
  assert.match(await page.locator('#mnavAdd').getAttribute('title'), /veículo/i,
    'na Frota o botão central oferece adicionar veículo');
  assert.equal(await page.locator('#mnavAdd').evaluate((b) => b.classList.contains('ativo')), false,
    'o botão de ação nunca marca aba ativa');
  assert.equal(await page.locator('#mfab').count(), 0, 'o botão flutuante saiu de cena');

  const reais = erros.filter((e) => !/Failed to load resource|net::ERR|CDN|cdn/i.test(e));
  assert.equal(reais.length, 0, 'erros de JS no celular:\n' + reais.join('\n'));
  await page.close();
});

test('Completar série atualiza a tela sem F5: parcela nova visível, filtros mantidos e export imediato completo', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const erros = [];
  page.on('pageerror', (e) => erros.push(String(e)));
  const post = (ep, body) => fetch(`${BASE}${ep}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(body) });
  const SER = { banco: 'Banco SemF5', produto: 'Consórcio', empresa: 'NTE', material: 'Carta sem F5', grupo: 'SEMF5', cota: '9' };
  assert.equal((await post('/api/contratos', { ...SER, parcela: '1/3', vencimento: '10/01/2026', valorParcela: 70, dataPagamento: '08/01/2026', valorPago: 70 })).status, 201);
  assert.equal((await post('/api/contratos', { ...SER, parcela: '3/3', vencimento: '10/03/2026', valorParcela: 70 })).status, 201);

  await page.goto(`${PAINEL}/contratos`, { waitUntil: 'load' });
  await page.locator('#contratosSubtabs').waitFor({ state: 'visible', timeout: 5000 });
  // Busca ativa ANTES do clique — tem de continuar valendo depois da sincronização.
  await page.locator('#buscaContr').fill('sem F5');
  await page.waitForTimeout(400); // busca é debounced (180 ms)
  const linhas = page.locator('#corpoContr tr');
  assert.equal(await linhas.count(), 2, 'antes: só 01/03 e 03/03 no filtro');

  await page.locator('#btnCompletarSeriesContr').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#confirmOk').click();
  await page.waitForFunction(() => /criada/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });

  // Sem F5: a 02/03 criada aparece na hora, com a busca preservada.
  assert.equal(await page.locator('#buscaContr').inputValue(), 'sem F5', 'busca preservada após a sincronização');
  assert.equal(await linhas.count(), 3, 'a parcela criada entra no filtro atual sem recarregar a página');
  assert.match(await page.locator('#corpoContr').innerText(), /02\/03/);
  // Coluna "Faltam" é POSICIONAL (total − nº): 01/03→2, 02/03→1, 03/03→0 — e o sort usa o mesmo valor.
  const lerFaltam = async () => page.evaluate(() => {
    const ths = [...document.querySelectorAll('#contratos thead th')].map((t) => t.textContent.trim());
    const iParc = ths.findIndex((t) => t.startsWith('Parcela')), iFal = ths.findIndex((t) => t.startsWith('Faltam'));
    return [...document.querySelectorAll('#corpoContr tr')].map((tr) => [tr.children[iParc].textContent.trim(), tr.children[iFal].textContent.trim()]);
  });
  assert.deepEqual(Object.fromEntries(await lerFaltam()), { '01/03': '2', '02/03': '1', '03/03': '0' }, 'Faltam = total − nº da própria linha');
  await page.locator('#contratos thead th[data-campo="parcelasFaltantes"]').click();
  await page.waitForTimeout(300);
  assert.deepEqual((await lerFaltam()).map((x) => x[1]), ['0', '1', '2'], 'ordenação usa o valor posicional exibido');
  // Registro SEM parcela válida na mesma série: "Faltam" mostra "—" (não o 0 salvo) e, na
  // ordenação crescente, fica por último — não empata com a última parcela real.
  assert.equal((await post('/api/contratos', { ...SER, parcela: '', totalParcelas: 3, parcelasPagas: 3, parcelasFaltantes: 0, valorParcela: 70 })).status, 201);
  await page.evaluate(() => carregarContratos()); // atualiza os dados sem F5
  await page.waitForTimeout(400);
  const comSemParc = await lerFaltam(); // ainda ordenado crescente por "Faltam"
  assert.deepEqual(comSemParc.map((x) => x[1]), ['0', '1', '2', '—'], 'sem N/M vai para o fim da crescente, não vira 0');
  assert.equal(comSemParc.filter((x) => x[1] === '0').length, 1, 'só a 03/03 real mostra Faltam 0');
  await page.locator('#contratos thead th[data-campo="parcelasFaltantes"]').click(); // volta a desc para não afetar o resto
  await page.waitForTimeout(300);
  const desc = (await lerFaltam()).map((x) => x[1]);
  assert.deepEqual(desc, ['2', '1', '0', '—'], 'na decrescente o ausente também fica por último (mesma convenção das colunas de data) — nunca é tratado como 0');

  // Export imediato: os {ids} da tela já incluem a recém-criada.
  const ids = await page.evaluate(() => aplicarFiltrosContr().map((c) => c.id));
  assert.equal(ids.length, 4, 'o export montaria 4 ids (3 parcelas + o registro sem PARC)');
  const rex = await page.request.post(`${BASE}/api/contratos/exportar`, { data: { ids }, headers: { Origin: BASE } });
  const wb = XLSX.read(Buffer.from(await rex.body()), { type: 'buffer' });
  const rows = XLSX.utils.sheet_to_json(wb.Sheets.CONTRATOS, { defval: '' });
  assert.deepEqual(rows.map((r) => r.PARC).sort(), ['', '01/03', '02/03', '03/03'], 'Excel exportado sem F5 contém a série completa');
  assert.deepEqual(rows.filter((r) => r.PARC).map((r) => [r.PARC, r.FALTANTES]).sort(), [['01/03', 2], ['02/03', 1], ['03/03', 0]], 'Excel: FALTANTES posicional igual à tela');
  assert.strictEqual(rows.find((r) => r.PARC === '').FALTANTES, '', 'Excel: sem PARC → FALTANTES vazio, não 0');

  // Rodar de novo (0 criadas nesta série): tela segue coerente, nada duplica.
  await page.locator('#btnCompletarSeriesContr').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#confirmOk').click();
  await page.waitForFunction(() => /já estavam completas|criada|padronizada|sobreposta|revisão/.test(document.getElementById('toast').textContent), null, { timeout: 8000 });
  assert.equal(await linhas.count(), 4, 'segunda execução não muda o filtro atual (3 parcelas + o registro sem PARC, que o botão ignora)');

  // Servidor gravou mas a recarga falhou → mensagem diferencia (não parece "falhou tudo").
  assert.equal((await post('/api/contratos', { ...SER, material: 'Carta sem F5 B', grupo: 'SEMF5B', cota: '8', parcela: '2/2', vencimento: '10/05/2026', valorParcela: 70 })).status, 201);
  await page.route('**/api/contratos', (route) => (route.request().method() === 'GET' ? route.abort() : route.fallback()));
  await page.locator('#btnCompletarSeriesContr').click();
  await page.locator('#confirmModal:not([hidden])').waitFor({ state: 'visible' });
  await page.locator('#confirmOk').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('não foi possível atualizar a tela'), null, { timeout: 8000 });
  assert.match(await page.locator('#toast').innerText(), /completadas no servidor/, 'aviso deixa claro que o backend executou');
  await page.unroute('**/api/contratos');

  assert.equal(erros.length, 0, 'erros de JS:\n' + erros.join('\n'));
  await page.close();
});
