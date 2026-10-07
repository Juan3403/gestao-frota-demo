/**
 * OCR de multas: navegador real + Tesseract simulado; nenhum print/dado real é usado.
 * USO: node --test e2e/multa-ocr.e2e.js
 *      → valida arquivo/Ctrl+V, revisão, cancelamento e persistência do responsável.
 * A avaliação do motor real fica em scripts/avaliar-ocr-multas.js.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { chromium } = require('playwright');

// Exclusiva desta suíte; convenção e unicidade verificadas por test/portas.test.js.
const PORT = 3216;
const BASE = `http://localhost:${PORT}`;
const RAIZ = path.join(__dirname, '..');
let servidor, pasta, browser, saida = null, log = '';

// USO: dadosOCR(['Placa: KDROE17', 'Valor original: R$ 195,23'], 96)
// → resultado estruturado v5 com palavras, confiança e posições previsíveis.
function dadosOCR(linhas, confianca = 96) {
  const lines = linhas.map((text, i) => {
    let x = 25;
    const words = text.split(/\s+/).map((word) => {
      const bbox = { x0: x, y0: 25 + i * 45, x1: x + word.length * 15, y1: 56 + i * 45 };
      x = bbox.x1 + 12;
      return { text: word, confidence: confianca, bbox };
    });
    return { text, confidence: confianca, words,
      bbox: { x0: 25, y0: 25 + i * 45, x1: x, y1: 56 + i * 45 } };
  });
  return { text: linhas.join('\n'), confidence: confianca,
    blocks: [{ paragraphs: [{ lines }] }], lines };
}

// USO: dadosTabelaSenatran(['B TRANSITAR …'], [['Órgão Autuador', '000300 - …'], ['', 'continuação']])
// → títulos no topo e a tabela do portal SENATRAN: rótulos em x=30, valores em x=760 na mesma linha OCR.
function dadosTabelaSenatran(titulos, linhas, confianca = 96) {
  const palavras = (text, x, y) => text.split(/\s+/).map((word) => {
    const bbox = { x0: x, y0: y, x1: x + word.length * 15, y1: y + 31 };
    x = bbox.x1 + 12;
    return { text: word, confidence: confianca, bbox };
  });
  const lines = [...titulos.map((t) => ['', t, 25]), ...linhas.map(([r, v]) => [r, v, 760])].map(([rotulo, valor, xValor], i) => {
    const y = 25 + i * 45;
    const words = [...(rotulo ? palavras(rotulo, 30, y) : []), ...(valor ? palavras(valor, xValor, y) : [])];
    return { text: words.map((w) => w.text).join(' '), confidence: confianca, words,
      bbox: { x0: words[0].bbox.x0, y0: y, x1: words.at(-1).bbox.x1, y1: y + 31 } };
  });
  return { text: lines.map((l) => l.text).join('\n'), confidence: confianca, blocks: [{ paragraphs: [{ lines }] }], lines };
}

// USO: await portaLivre() antes do spawn → recusa conectar a outro DATA_DIR por engano.
async function portaLivre() {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', () => reject(new Error(`Porta ${PORT} ocupada; não inicia teste contra outro servidor.`)));
    probe.listen(PORT, '127.0.0.1', () => probe.close(resolve));
  });
}

before(async () => {
  await portaLivre();
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-multa-ocr-e2e-'));
  servidor = spawn(process.execPath, ['backend/server.js'], {
    cwd: RAIZ,
    env: { ...process.env, DATA_DIR: pasta, PORT: String(PORT), MONGODB_URI: '',
      APP_PASSWORD: '', SENHA_ADMIN: '', SESSION_SECRET: 'sessao-ficticia-ocr-e2e',
      E2E_TEST: '1', COFRE_CHAVE: 'chave-ficticia-exclusiva-multa-ocr-e2e',
      MIDIA_S3_LOCAL: '', MIDIA_S3_BUCKET: '', VIDEO_S3_BUCKET: '', RENDER: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  servidor.stderr.on('data', (d) => { log += d; });
  servidor.on('exit', (codigo, sinal) => { saida = codigo === null ? sinal : codigo; });
  const fim = Date.now() + 15000;
  let pronto = false;
  while (Date.now() < fim) {
    if (saida !== null) throw new Error(`Servidor OCR terminou (${saida}): ${log.slice(-2000)}`);
    try { pronto = (await fetch(BASE + '/api/versao')).ok; } catch { /* boot */ }
    if (pronto) break;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  assert.ok(pronto, 'servidor OCR respondeu antes do prazo');
  browser = await chromium.launch({ headless: !process.env.HEADED });
});

after(async () => {
  await browser?.close();
  if (servidor && saida === null) {
    await new Promise((resolve) => { servidor.once('exit', resolve); servidor.kill(); });
  }
  if (pasta) fs.rmSync(pasta, { recursive: true, force: true });
});

// USO: await paginaOCR(t, ['KDR0E17']) → modal aberto com Frota completa simulada e sem CDN.
async function paginaOCR(t, placas = ['KDR0E17'], opcoes = {}) {
  const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
  const erros = [];
  page.on('pageerror', (erro) => erros.push(String(erro)));
  page.on('console', (m) => { if (m.type() === 'error') erros.push(m.text()); });
  t.after(async () => {
    const reais = erros.filter((e) => !/Failed to load resource|net::ERR|CDN|cdn/i.test(e));
    await page.close();
    assert.deepEqual(reais, [], 'sem erro de JavaScript: ' + reais.join('\n'));
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === BASE) return route.fallback();
    // Teste funcional não precisa de CDN, fontes ou OCR real. Resposta vazia evita
    // erro de rede incidental; createWorker é instalado abaixo antes do app abrir.
    return route.fulfill({ status: 200, contentType: /\.js$/.test(url.pathname)
      ? 'application/javascript' : 'text/css', body: '' });
  });
  await page.route('**/api/veiculos', async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ json: placas.map((placa) => ({ placa, marca: 'Fictícia', modelo: 'Teste' })) });
  });
  await page.addInitScript((config) => {
    if (config.timeoutMs) {
      const original = window.setTimeout.bind(window);
      window.setTimeout = (fn, ms, ...args) => original(fn, ms === 90000 ? config.timeoutMs : ms, ...args);
    }
    window.__ocrTeste = { fila: [], chamadas: [], terminados: 0, criados: 0, liberar: null, liberarCriacao: null };
    window.Tesseract = {
      createWorker: async () => {
        window.__ocrTeste.criados++;
        if (config.workerPendente) await new Promise((resolve) => { window.__ocrTeste.liberarCriacao = resolve; });
        return {
          setParameters: async () => {},
          recognize: async (imagem, opcoes) => {
            const estado = window.__ocrTeste;
            estado.chamadas.push({ width: imagem.width, height: imagem.height, opcoes });
            const item = estado.fila.shift();
            if (!item) throw new Error('Fixture OCR não fornecida');
            if (item.pendente) await new Promise((resolve) => { estado.liberar = resolve; });
            if (item.erro) throw new Error(item.erro);
            const data = structuredClone(item.data);
            // Coordenadas fornecidas pelo motor referem-se ao canvas preparado,
            // não ao arquivo original 1200px. A imagem fictícia e seus recortes
            // precisam respeitar isso também, inclusive na inspeção visual.
            const escala = imagem.width >= 1200 ? imagem.width / 1200 : 1;
            const vistos = new WeakSet();
            const ajustar = (obj) => {
              if (!obj || typeof obj !== 'object' || vistos.has(obj)) return;
              vistos.add(obj);
              if (obj.bbox) for (const eixo of ['x0', 'y0', 'x1', 'y1']) obj.bbox[eixo] *= escala;
              for (const [chave, valor] of Object.entries(obj)) if (chave !== 'bbox') ajustar(valor);
            };
            ajustar(data);
            return { data };
          },
          terminate: async () => { window.__ocrTeste.terminados++; },
        };
      },
    };
  }, opcoes);
  await page.goto(`${BASE}/painel/multas`, { waitUntil: 'load' });
  await page.locator('#btnAddMulta').click();
  await page.locator('#multaModal').waitFor({ state: 'visible' });
  return page;
}

// USO: await filaOCR(page, {data: dadosOCR(['Placa: KDR0E17'])}) → próxima leitura prevista.
async function filaOCR(page, ...items) {
  await page.evaluate((valores) => window.__ocrTeste.fila.push(...valores), items);
}

// USO: await imagemFicticia(page) → PNG branco válido 1200×1500, sem usar clipboard real.
async function imagemFicticia(page, width = 1200, height = 1500) {
  const base64 = await page.evaluate(({ width, height }) => {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = '#111'; ctx.font = '25px Arial';
    const linhas = window.__ocrTeste.fila[0]?.data?.lines;
    if (linhas) linhas.forEach((linha) => linha.words.forEach((word) =>
      ctx.fillText(word.text, word.bbox.x0, word.bbox.y1 - 5)));
    else ctx.fillText('PRINT FICTÍCIO - TESTE', 25, 40);
    return canvas.toDataURL('image/png').split(',')[1];
  }, { width, height });
  return { name: 'senatran-ficticio.png', mimeType: 'image/png', buffer: Buffer.from(base64, 'base64') };
}

// USO: await lerArquivo(page) → dispara o onchange real do input de arquivo, aguarda fim.
async function lerArquivo(page) {
  await page.locator('#inputMultaOCR').setInputFiles(await imagemFicticia(page));
  await page.waitForFunction(() => !document.getElementById('btnMultaOCR').disabled);
}

// USO: await colarPrint(page) → evento paste com File via DataTransfer; sem acesso ao clipboard.
async function colarPrint(page) {
  const { buffer } = await imagemFicticia(page);
  await page.evaluate((base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer(); dt.items.add(new File([bytes], 'print-colado.png', { type: 'image/png' }));
    document.querySelector('#formMulta [name="placa"]').dispatchEvent(
      new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  }, buffer.toString('base64'));
  await page.waitForFunction(() => !document.getElementById('btnMultaOCR').disabled);
}

const campo = (page, name) => page.locator(`#formMulta [name="${name}"]`);
const salvar = (page) => page.locator('#formMulta button[type="submit"]');
const revisao = (page, name) => page.locator(`#mocrLista [data-ocr-campo="${name}"]`);

// USO: await abrirConferencia(page) → abre sugestões opcionais sem alterar nenhum campo.
async function abrirConferencia(page) {
  const details = page.locator('#mocrRevisao');
  if (!(await details.evaluate((el) => el.open))) await page.locator('#mocrRevisaoTitulo').click();
}

// USO: await capturarRevisao(page) → prints claros/escuros/mobile em tmp e réguas sem overflow.
async function capturarRevisao(page) {
  await abrirConferencia(page);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-ocr-revisao-visual-'));
  const medidas = [];
  for (const [nome, width, height, tema] of [
    ['desktop-claro', 1366, 768, 'claro'], ['desktop-escuro', 1366, 768, 'escuro'],
    ['mobile-claro', 390, 844, 'claro'],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate((valor) => aplicarTema(valor), tema);
    await page.locator('#mocrRevisao').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(dir, nome + '.png') });
    const medidasTela = await page.evaluate(() => {
      const selectors = ['#multaModal .modal', '#formMulta', '#mocrRevisao', '#mocrLista'];
      return Object.fromEntries(selectors.map((selector) => {
        const el = document.querySelector(selector);
        return [selector, { clientWidth: el.clientWidth, scrollWidth: el.scrollWidth }];
      }));
    });
    medidas.push({ nome, medidas: medidasTela });
    for (const [selector, medida] of Object.entries(medidasTela)) {
      assert.ok(medida.scrollWidth <= medida.clientWidth + 1,
        `${nome} ${selector} tem overflow horizontal: ${JSON.stringify(medida)}`);
    }
  }
  fs.writeFileSync(path.join(dir, 'medidas.json'), JSON.stringify(medidas, null, 2));
  console.log('QA visual OCR: ' + dir);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await page.evaluate(() => aplicarTema('claro'));
}

// USO: await capturarPreenchimentoAutomatico(page) → formulário preenchido e conferência recolhida nos dois tamanhos.
async function capturarPreenchimentoAutomatico(page) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-ocr-automatico-visual-'));
  const estados = [];
  for (const [nome, width, height] of [['desktop-claro', 1366, 768], ['mobile-claro', 390, 844]]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => {
      aplicarTema('claro');
      document.querySelector('#multaModal .modal').scrollTop = 0;
    });
    assert.equal(await page.locator('#mocrRevisao').evaluate((el) => el.open), false);
    const estado = await page.evaluate(() => {
      const form = document.getElementById('formMulta'), modal = document.querySelector('#multaModal .modal');
      return { conferenciaAberta: document.getElementById('mocrRevisao').open,
        valores: Object.fromEntries(['placa', 'responsavel', 'autoInfracao', 'descricao', 'dataInfracao', 'horaInfracao', 'valor']
          .map((nome) => [nome, form.elements[nome].value])),
        modal: { clientWidth: modal.clientWidth, scrollWidth: modal.scrollWidth },
        form: { clientWidth: form.clientWidth, scrollWidth: form.scrollWidth } };
    });
    assert.equal(estado.modal.scrollWidth, estado.modal.clientWidth);
    assert.equal(estado.form.scrollWidth, estado.form.clientWidth);
    estados.push({ nome, ...estado });
    await page.screenshot({ path: path.join(dir, nome + '.png') });
  }
  fs.writeFileSync(path.join(dir, 'estados.json'), JSON.stringify(estados, null, 2));
  console.log('QA preenchimento automático: ' + dir);
  await page.setViewportSize({ width: 1500, height: 1000 });
}

test('nova multa: IDENTIFICAR editável e persistido; edição preserva responsável vazio ou existente', async (t) => {
  const page = await paginaOCR(t);
  assert.equal(await campo(page, 'responsavel').inputValue(), 'IDENTIFICAR');
  await campo(page, 'placa').fill('KDR0E17');
  await campo(page, 'autoInfracao').fill('AUTO-DEFAULT-E2E');
  const salvo = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/multas' && r.request().method() === 'POST');
  await salvar(page).click();
  assert.equal((await (await salvo).json()).responsavel, 'IDENTIFICAR');
  await page.locator('#multaModal').waitFor({ state: 'hidden' });
  const response = await page.request.post(`${BASE}/api/multas`, {
    headers: { Origin: BASE }, data: { placa: 'KDR0E17', responsavel: '', autoInfracao: 'AUTO-VAZIO-E2E' },
  });
  const existente = await response.json();
  await page.evaluate(async (id) => { await carregarMultas(); abrirMultaModal(id); }, existente.id);
  assert.equal(await campo(page, 'responsavel').inputValue(), '', 'editar não reintroduz padrão');
  await campo(page, 'responsavel').fill('Condutor Fictício');
  const atualizado = page.waitForResponse((r) => r.url().endsWith('/api/multas/' + existente.id) && r.request().method() === 'PUT');
  await salvar(page).click();
  assert.equal((await (await atualizado).json()).responsavel, 'Condutor Fictício');
  await page.locator('#multaModal').waitFor({ state: 'hidden' });
  await page.evaluate((id) => abrirMultaModal(id), existente.id);
  assert.equal(await campo(page, 'responsavel').inputValue(), 'Condutor Fictício');
  await page.locator('#fecharMulta').click();
  await page.locator('#btnAddMulta').click();
  assert.equal(await campo(page, 'responsavel').inputValue(), 'IDENTIFICAR', 'padrão volta no próximo cadastro');
});

test('termo: trocar condutor e modelo durante envio mantém vínculo e representante da requisição original', async (t) => {
  // USO: gerar para Ana/NTE → POST em espera → escolher Bruno/SUL → resposta de Ana.
  // A resposta deve atualizar multa/formulário como Ana e lembrar representante da NTE.
  const page = await paginaOCR(t);
  const response = await page.request.post(`${BASE}/api/multas`, {
    headers: { Origin: BASE }, data: { placa: 'KDR0E17', responsavel: '', autoInfracao: 'AUTO-TERMO-CORRIDA' },
  });
  assert.equal(response.status(), 201);
  const multa = await response.json();
  const endpoint = `${BASE}/api/multas/${multa.id}/termo`;
  await page.route(endpoint + '/opcoes', (route) => route.fulfill({ json: {
    condutorFuncionarioId: '', marcadores: [],
    modelos: [{ id: 'MOD-NTE', empresa: 'NTE', titulo: 'Modelo fictício NTE' },
      { id: 'MOD-SUL', empresa: 'SUL', titulo: 'Modelo fictício SUL' }],
    candidatos: [{ id: 'FN-ANA', nome: 'Ana Fictícia', empresa: 'NTE', sugerido: 'veiculo' },
      { id: 'FN-BRUNO', nome: 'Bruno Fictício', empresa: 'SUL' }],
  } }));
  await page.route(endpoint + '/previa', (route) => route.fulfill({ json: {
    usados: [{ chave: 'NOME_REPRESENTANTE', rotulo: 'Representante', valor: 'Exemplo' }],
    faltando: [], desconhecidos: [],
  } }));
  let liberarResposta, avisarEnvio;
  const respostaPendente = new Promise((resolve) => { liberarResposta = resolve; });
  const enviada = new Promise((resolve) => { avisarEnvio = resolve; });
  let corpoEnviado;
  t.after(() => liberarResposta());
  await page.route(endpoint, async (route) => {
    corpoEnviado = route.request().postDataJSON();
    avisarEnvio();
    await respostaPendente;
    await route.fulfill({ status: 200,
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      headers: { 'Content-Disposition': "attachment; filename*=UTF-8''Termo-ficticio.docx" },
      body: Buffer.from('Conteúdo fictício; este teste valida a vinculação, sem abrir o Word.'),
    });
  });
  await page.evaluate(async (id) => { await carregarMultas(); abrirMultaModal(id); }, multa.id);
  await page.locator('#btnGerarTermoMulta').click();
  const termo = page.locator('.modal-overlay').filter({ has: page.locator('.termo-func') });
  await termo.waitFor({ state: 'visible' });
  await termo.locator('.termo-func').selectOption('FN-ANA');
  await termo.locator('.termo-modelo').selectOption('MOD-NTE');
  await termo.locator('[name="representante"]').fill('Representante fictício enviado da NTE');
  const baixado = page.waitForEvent('download');
  await termo.locator('.termo-baixar[data-formato="docx"]').click();
  await enviada;
  assert.equal(corpoEnviado.funcionarioId, 'FN-ANA');
  assert.equal(corpoEnviado.modeloId, 'MOD-NTE');
  assert.equal(corpoEnviado.representante, 'Representante fictício enviado da NTE');
  assert.equal(await termo.locator('.termo-func').isEnabled(), true, 'seleção continua editável durante envio');
  await termo.locator('.termo-func').selectOption('FN-BRUNO');
  await termo.locator('.termo-modelo').selectOption('MOD-SUL');
  assert.equal(await termo.locator('.termo-func').inputValue(), 'FN-BRUNO');
  assert.equal(await termo.locator('.termo-modelo').inputValue(), 'MOD-SUL');
  liberarResposta();
  assert.equal((await baixado).suggestedFilename(), 'Termo-ficticio.docx');
  await termo.waitFor({ state: 'detached' });
  assert.equal(await campo(page, 'responsavel').inputValue(), 'Ana Fictícia');
  assert.equal(await campo(page, 'condutorFuncionarioId').inputValue(), 'FN-ANA');
  const estado = await page.evaluate((id) => {
    const m = MULTAS.find((item) => item.id === id);
    return { responsavel: m.responsavel, condutorFuncionarioId: m.condutorFuncionarioId,
      repNTE: localStorage.getItem('termoMulta:rep:NTE'), repSUL: localStorage.getItem('termoMulta:rep:SUL') };
  }, multa.id);
  assert.deepEqual(estado, { responsavel: 'Ana Fictícia', condutorFuncionarioId: 'FN-ANA',
    repNTE: 'Representante fictício enviado da NTE', repSUL: null });
  const atualizado = page.waitForResponse((r) => r.url().endsWith('/api/multas/' + multa.id) && r.request().method() === 'PUT');
  await salvar(page).click();
  const salvo = await (await atualizado).json();
  assert.equal(salvo.responsavel, 'Ana Fictícia');
  assert.equal(salvo.condutorFuncionarioId, 'FN-ANA');
});

for (const entrada of ['arquivo', 'Ctrl+V']) {
  test(`${entrada}: Frota corrige placa única e preenche campos sem sobrescrever digitação`, async (t) => {
    const page = await paginaOCR(t, ['KDR0E17', 'ABC1D23']);
    let consultas = 0;
    page.on('request', (req) => { if (new URL(req.url()).pathname === '/api/veiculos') consultas++; });
    await campo(page, 'local').fill('Local já digitado');
    await filaOCR(page, { data: dadosOCR([
      'Placa: KDROE17', 'Número do auto de infração: A123456789',
      'Descrição da infração: CONDUZIR VEÍCULO SEM EQUIPAMENTO OBRIGATÓRIO',
      'Data da infração: 01/09/2026', 'Hora da infração: 07:35',
      'Data/Hora do Cometimento da Infração: 05/10/2026 10:25',
      'Valor com desconto: R$ 156,18', 'Valor original: R$ 195,23',
      'Local da infração: RUA FICTÍCIA 10', 'Data da notificação: 06/10/2026',
      'Data de vencimento: 05/11/2026',
    ]) });
    if (entrada === 'arquivo') await lerArquivo(page); else await colarPrint(page);
    assert.equal(await campo(page, 'placa').inputValue(), 'KDR0E17');
    assert.equal(await campo(page, 'autoInfracao').inputValue(), 'A123456789');
    assert.equal(await campo(page, 'valor').inputValue(), '195.23', 'desconto não ocupa o valor original');
    assert.equal(await campo(page, 'dataInfracao').inputValue(), '05/10/2026');
    assert.equal(await campo(page, 'dataNotificacao').inputValue(), '06/10/2026');
    assert.equal(await campo(page, 'dataVencimento').inputValue(), '05/11/2026');
    assert.equal(await campo(page, 'horaInfracao').inputValue(), '10:25');
    assert.equal(await campo(page, 'local').inputValue(), 'Local já digitado');
    assert.equal(await campo(page, 'responsavel').inputValue(), 'IDENTIFICAR');
    assert.match(await campo(page, 'descricao').inputValue(), /SEM EQUIPAMENTO/i);
    assert.match(await page.locator('#mocrStatus').textContent(), /Frota/i);
    assert.ok(consultas > 0, 'consulta fresca à lista completa, sem depender de estado visual');
    assert.equal(await salvar(page).isDisabled(), false, 'sugestões nunca impedem salvar');
    assert.equal(await page.locator('#mocrRevisao').evaluate((el) => el.open), false, 'conferência começa recolhida');
    await abrirConferencia(page);
    await revisao(page, 'local').locator('[data-ocr-acao="descartar"]').click();
    assert.equal(await campo(page, 'local').inputValue(), 'Local já digitado');
    assert.equal(await salvar(page).isDisabled(), false);
    assert.equal(await page.locator('#mocrDiagnostico').count(), 1);
  });
}

test('texto colado não inicia OCR nem impede a colagem normal', async (t) => {
  const page = await paginaOCR(t);
  const prevented = await campo(page, 'responsavel').evaluate((el) => {
    const dt = new DataTransfer(); dt.setData('text/plain', 'Condutor Digitado');
    const evento = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
    el.dispatchEvent(evento); return evento.defaultPrevented;
  });
  assert.equal(prevented, false);
  assert.equal(await page.evaluate(() => window.__ocrTeste.criados), 0);
  assert.equal(await salvar(page).isDisabled(), false);
});

for (const entrada of ['arquivo', 'Ctrl+V']) {
  test(`${entrada}: descrição multilinha preserva faixa, placa e condutor sem tratá-los como rótulos`, async (t) => {
    const page = await paginaOCR(t);
    await filaOCR(page, { data: dadosOCR([
      'Descrição da infração:',
      'TRANSITAR NA FAIXA OU PISTA EXCLUSIVA',
      'REGULAMENTADA COM PLACA PARA TRANSPORTE PUBLICO',
      'COLETIVO DE PASSAGEIROS, SEM AUTORIZACAO DO CONDUTOR',
      'Placa: KDR0E17', 'Número do auto de infração: A123456789',
      'Data/Hora do Cometimento da Infração: 05/10/2026 10:25',
    ]) });
    if (entrada === 'arquivo') await lerArquivo(page); else await colarPrint(page);
    const descricaoEsperada = 'Transitar na faixa ou pista exclusiva regulamentada com placa para transporte publico coletivo de passageiros, sem autorizacao do condutor';
    assert.equal(await campo(page, 'descricao').inputValue(), descricaoEsperada);
    assert.equal(await campo(page, 'placa').inputValue(), 'KDR0E17', 'placa no texto da infração não substitui a placa do veículo');
    assert.equal(await campo(page, 'autoInfracao').inputValue(), 'A123456789', 'o próximo rótulo delimita a descrição');
    assert.equal(await salvar(page).isDisabled(), false);
    assert.equal(await page.locator('#mocrRevisao').evaluate((el) => el.open), false, 'preenchimento dispensa confirmação');
    if (entrada === 'arquivo') {
      const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/multas' && r.request().method() === 'POST');
      await salvar(page).click();
      const salvo = await (await response).json();
      assert.equal(salvo.descricao, descricaoEsperada, 'o POST persiste a descrição completa sem abrir ou aceitar a conferência');
    }
  });
}

test('título CDT de recusa com marcador e várias linhas preenche a descrição completa', async (t) => {
  const page = await paginaOCR(t);
  await filaOCR(page, { data: dadosOCR([
    'NOTIFICAÇÃO DE AUTUAÇÃO',
    '• RECUSAR-SE A SER SUBMETIDO AO TESTE,',
    'EXAME CLINICO, PERICIA OU OUTRO PROCEDIMENTO',
    'QUE PERMITA CERTIFICAR INFLUENCIA DE ALCOOL',
    'Placa: KDR0E17', 'Número do auto de infração: A987654321',
  ], 60) });
  await colarPrint(page);
  assert.equal(await campo(page, 'descricao').inputValue(),
    'Recusar-se a ser submetido ao teste, exame clinico, pericia ou outro procedimento que permita certificar influencia de alcool');
  assert.doesNotMatch(await campo(page, 'descricao').inputValue(), /NOTIFICAÇÃO/i, 'cabeçalho fica fora da infração');
  assert.equal(await salvar(page).isDisabled(), false, 'baixa confiança não exige confirmação');
});

test('tabela SENATRAN: ícone antes do título, órgão só da primeira linha e cidade em formato de nome', async (t) => {
  const page = await paginaOCR(t, ['ABC0D12']);
  await filaOCR(page, { data: dadosTabelaSenatran([
    'B ESTACIONAR EM LOCAL/HORARIO PROIBIDO ESPECIFICAMENTE PELA SINALIZACAO',
    'Placa à época da infração: ABCOD12',
  ], [
    ['Órgão Autuador', '225310 - PREF. DE PE CIDADE FICTICIA'],
    ['Órgão Competente/Responsável', '225310 - PREF. DE PE CIDADE FICTICIA'],
    ['Local da Infração', 'RUA FICTICIA 100 - RECIFE'],
    ['Data/Hora do Cometimento da Infração', '18/09/2026 09:15'],
    ['Número do Auto de Infração', 'OD00512345'],
    ['Data Limite para Identificação do Condutor Infrator', '12/11/2026'],
  ]) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'orgaoAutuador').inputValue(), '225310 - PREF. DE PE CIDADE FICTICIA');
  assert.equal(await campo(page, 'descricao').inputValue(), 'Estacionar em local/horario proibido especificamente pela sinalizacao');
  assert.equal(await campo(page, 'cidadeEstado').inputValue(), 'Recife/PE');
  assert.equal(await campo(page, 'placa').inputValue(), 'ABC0D12');
  assert.equal(await campo(page, 'autoInfracao').inputValue(), 'OD00512345');
  assert.equal(await campo(page, 'dataVencimento').inputValue(), '', 'data limite não vira vencimento');
});

test('descrição digitada é preservada e salva sem aceitar a descrição sugerida pelo print', async (t) => {
  const page = await paginaOCR(t);
  const digitada = 'Descrição conferida manualmente: dirigir sem possuir CNH';
  await campo(page, 'descricao').fill(digitada);
  await filaOCR(page, { data: dadosOCR([
    'Descrição da infração: CONDUZIR VEÍCULO SEM EQUIPAMENTO OBRIGATÓRIO',
    'Placa: KDR0E17', 'Número do auto de infração: A555555555',
  ], 60) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'descricao').inputValue(), digitada);
  assert.equal(await revisao(page, 'descricao').count(), 1, 'a leitura alternativa fica disponível para conferência opcional');
  assert.equal(await page.locator('#mocrRevisao').evaluate((el) => el.open), false);
  assert.equal(await salvar(page).isDisabled(), false);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/multas' && r.request().method() === 'POST');
  await salvar(page).click();
  const salvo = await (await response).json();
  assert.equal(salvo.descricao, digitada, 'o POST persiste a descrição escolhida sem confirmação das sugestões');
});

test('descrição ausente e cabeçalhos não inventam texto; descrições diferentes continuam alternativas', async (t) => {
  const page = await paginaOCR(t);
  await filaOCR(page, { data: dadosOCR([
    'NOTIFICAÇÃO DE AUTUAÇÃO', 'DADOS DA INFRAÇÃO', 'Descrição da infração:',
    'NOTIFICAÇÃO DE PENALIDADE', 'Placa: KDR0E17',
  ]) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'descricao').inputValue(), '');
  assert.equal(await revisao(page, 'descricao').count(), 0, 'cabeçalhos não oferecem uma descrição falsa');
  assert.equal(await salvar(page).isDisabled(), false);
  await filaOCR(page, { data: dadosOCR([
    'Descrição da infração: TRANSITAR EM VELOCIDADE SUPERIOR A MAXIMA PERMITIDA',
    'Descrição da infração: ESTACIONAR EM LOCAL PROIBIDO',
    'Placa: KDR0E17',
  ]) });
  await colarPrint(page);
  assert.equal(await campo(page, 'descricao').inputValue(), '', 'não escolhe a primeira descrição diferente');
  await abrirConferencia(page);
  const opcoes = await revisao(page, 'descricao').locator('.mocr-alternativas option').allTextContents();
  assert.deepEqual(opcoes.slice(1).sort(), [
    'Estacionar em local proibido', 'Transitar em velocidade superior a maxima permitida',
  ]);
  assert.equal(await salvar(page).isDisabled(), false, 'conflito real mantém conferência opcional');
});

test('baixa confiança e inferências válidas preenchem e salvam imediatamente sem aceitar sugestões', async (t) => {
  const page = await paginaOCR(t);
  await filaOCR(page, { data: dadosOCR([
    'Placa: KDROE17', 'Número do auto de infração: A987654321',
    'CONDUZIR VEÍCULO SEM EQUIPAMENTO OBRIGATÓRIO',
    'Data/Hora do Cometimento da Infração: 05/10/2026 10:25',
    'Valor original: R$ 195,23', 'Local da infração: RUA FICTÍCIA 100',
  ], 60) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'placa').inputValue(), 'KDR0E17');
  assert.equal(await campo(page, 'autoInfracao').inputValue(), 'A987654321');
  assert.equal(await campo(page, 'valor').inputValue(), '195.23');
  assert.equal(await campo(page, 'dataInfracao').inputValue(), '05/10/2026');
  assert.equal(await campo(page, 'horaInfracao').inputValue(), '10:25');
  assert.match(await campo(page, 'descricao').inputValue(), /SEM EQUIPAMENTO/i);
  assert.equal(await page.locator('#mocrRevisao').evaluate((el) => el.open), false);
  assert.equal(await salvar(page).isDisabled(), false);
  await capturarPreenchimentoAutomatico(page);
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/multas' && r.request().method() === 'POST');
  await salvar(page).click();
  const salvo = await (await response).json();
  assert.equal(salvo.placa, 'KDR0E17');
  assert.equal(salvo.valor, 195.23);
  assert.equal(salvo.dataInfracao, '05/10/2026');
  assert.equal(salvo.horaInfracao, '10:25');
});

test('data e hora genéricas nunca substituem o rótulo completo do cometimento da infração', async (t) => {
  const page = await paginaOCR(t);
  await filaOCR(page, { data: dadosOCR([
    'Placa: KDR0E17', 'Data da infração: 01/09/2026', 'Hora da infração: 07:35',
    'Data/Hora: 02/09/2026 08:45', 'Cometimento: 03/09/2026 09:55',
    'Data da notificação: 06/10/2026', 'Data de vencimento: 05/11/2026',
  ]) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'dataInfracao').inputValue(), '');
  assert.equal(await campo(page, 'horaInfracao').inputValue(), '');
  assert.equal(await campo(page, 'dataNotificacao').inputValue(), '06/10/2026');
  assert.equal(await campo(page, 'dataVencimento').inputValue(), '05/11/2026');
  assert.equal(await salvar(page).isDisabled(), false);
});

for (const origem of ['Pagamento', 'Histórico']) {
  test(`celular: print colado em ${origem} abre Dados/Infração sem sobrescrever valores já salvos`, async (t) => {
    const page = await paginaOCR(t);
    await page.setViewportSize({ width: 390, height: 844 });
    const resposta = await page.request.post(`${BASE}/api/multas`, {
      headers: { Origin: BASE }, data: { placa: 'KDR0E17', autoInfracao: 'AUTO-MOBILE-' + origem },
    });
    const existente = await resposta.json();
    await page.evaluate(async (id) => { await carregarMultas(); abrirMultaModal(id); }, existente.id);
    if (origem === 'Pagamento') await page.locator('#multaMEtapas [data-n="2"]').click();
    else await page.locator('#multaMTabHist').click();
    await filaOCR(page, { data: dadosOCR(['Valor original: R$ 195,23'], 70) });
    await colarPrint(page);
    assert.equal(await page.locator('#formMulta').getAttribute('data-etapa-atual'), '1');
    assert.equal(await page.locator('#multaMTabDados').getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#mocrRevisao').isVisible(), true);
    assert.equal(await campo(page, 'valor').inputValue(), '0', 'valor zero salvo também deve ser preservado');
    assert.equal(await page.locator('#mocrRevisao').evaluate((el) => el.open), false);
    assert.equal(await salvar(page).isDisabled(), false);
    await abrirConferencia(page);
    assert.equal(await revisao(page, 'valor').isVisible(), true, 'conferência permanece acessível por escolha');
  });
}

test('placas ambíguas e valores inválidos não são escolhidos; conferência é opcional sem bloquear Salvar', async (t) => {
  const page = await paginaOCR(t, ['KDR0E17', 'KOR0E17']);
  await filaOCR(page, { data: dadosOCR([
    'Placa: K0ROE17', 'Número do auto de infração: A123456789',
    'Data/Hora do Cometimento da Infração: 31/02/2026 10:25', 'Valor original: R$ 195,23',
  ], 72) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'placa').inputValue(), '');
  assert.equal(await salvar(page).isDisabled(), false);
  assert.equal(await campo(page, 'autoInfracao').inputValue(), 'A123456789', 'baixa confiança não exige aceite');
  assert.equal(await campo(page, 'valor').inputValue(), '195.23');
  assert.equal(await campo(page, 'dataInfracao').inputValue(), '');
  assert.equal(await page.locator('#mocrRevisao').evaluate((el) => el.open), false);
  await capturarRevisao(page);
  const placa = revisao(page, 'placa');
  const alternativas = await placa.locator('.mocr-alternativas option').allTextContents();
  assert.ok(alternativas.join(' ').includes('KDR0E17') && alternativas.join(' ').includes('KOR0E17'));
  await placa.locator('.mocr-alternativas').selectOption('KDR0E17');
  await placa.locator('[data-ocr-acao="aceitar"]').click();
  assert.equal(await campo(page, 'placa').inputValue(), 'KDR0E17');
  const data = revisao(page, 'dataInfracao');
  await data.locator('[data-ocr-acao="aceitar"]').click();
  assert.equal(await campo(page, 'dataInfracao').inputValue(), '', 'data impossível não é aceita');
  await data.locator('[data-ocr-acao="corrigir"]').click();
  assert.equal(await data.locator('.mocr-valor').evaluate((el) => el === document.activeElement), true);
  await data.locator('.mocr-valor').fill('28/02/2026');
  await data.locator('[data-ocr-acao="aceitar"]').click();
  assert.equal(await campo(page, 'dataInfracao').inputValue(), '28/02/2026');
  assert.equal(await campo(page, 'autoInfracao').inputValue(), 'A123456789');
  await revisao(page, 'valor').locator('[data-ocr-acao="descartar"]').click();
  assert.equal(await campo(page, 'valor').inputValue(), '195.23', 'descartar sugestão preserva o que foi preenchido');
  assert.equal(await salvar(page).isDisabled(), false);
});

test('tentar aceitar data inválida não impede salvar cadastro sem aplicar a sugestão', async (t) => {
  const page = await paginaOCR(t);
  await filaOCR(page, { data: dadosOCR([
    'Placa: KDR0E17', 'Número do auto de infração: A-INVALIDA-E2E',
    'Data/Hora do Cometimento da Infração: 31/02/2026 10:25', 'Valor original: R$ 195,23',
  ]) });
  await lerArquivo(page);
  await abrirConferencia(page);
  const item = revisao(page, 'dataInfracao');
  await item.locator('[data-ocr-acao="aceitar"]').click();
  assert.equal(await campo(page, 'dataInfracao').inputValue(), '');
  assert.equal(await salvar(page).isDisabled(), false);
  assert.equal(await item.locator('.mocr-valor').evaluate((el) => el.validity.valid), true,
    'sugestão opcional inválida não cria bloqueio de validação nativa');
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/multas' && r.request().method() === 'POST');
  await salvar(page).click();
  const salvo = await (await response).json();
  assert.equal(salvo.placa, 'KDR0E17');
  assert.equal(salvo.dataInfracao, '');
});

for (const digitado of [false, true]) {
test(`releitura de trecho ${digitado ? 'preserva digitação posterior' : 'atualiza campo preenchido pelo OCR'} sem exigir aceite`, async (t) => {
  const page = await paginaOCR(t);
  await filaOCR(page, { data: dadosOCR(['Placa: KDR0E17', 'Valor original: R$ 195,23'], 70) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'valor').inputValue(), '195.23');
  if (digitado) await campo(page, 'valor').fill('99');
  await abrirConferencia(page);
  const item = revisao(page, 'valor');
  const antes = await item.locator('img').getAttribute('src');
  assert.ok(antes?.startsWith('data:image/'), 'recorte da imagem fica apenas em memória');
  await filaOCR(page, { data: dadosOCR(['Valor original: R$ 196,23']) });
  await item.locator('[data-ocr-acao="reler"]').click();
  await page.waitForFunction(() => !document.getElementById('btnMultaOCR').disabled);
  assert.equal(await campo(page, 'valor').inputValue(), digitado ? '99' : '196.23');
  await abrirConferencia(page);
  assert.equal(await item.locator('.mocr-valor').inputValue(), '196.23');
  assert.equal(await item.locator('img').getAttribute('src'), antes, 'não troca referência pelo bbox relativo ao recorte');
  const chamadas = await page.evaluate(() => window.__ocrTeste.chamadas);
  assert.equal(chamadas.length, 2);
  assert.ok(chamadas[1].width < chamadas[0].width || chamadas[1].opcoes?.rectangle,
    'segundo reconhecimento recebe somente a região do campo');
  assert.equal(await salvar(page).isDisabled(), false);
  await page.locator('#mocrDescartarTodas').click();
  assert.equal(await salvar(page).isDisabled(), false);
});
}

test('Frota indisponível: placa válida única é preenchida e cadastro manual continua disponível', async (t) => {
  const page = await paginaOCR(t);
  await page.route('**/api/veiculos', (route) => route.fulfill({ status: 403, json: { erro: 'Sem acesso' } }));
  await filaOCR(page, { data: dadosOCR(['Placa: KDR0E17']) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'placa').inputValue(), 'KDR0E17');
  assert.match(await page.locator('#mocrStatus').textContent(),
    /Frota|indispon[ií]vel/i);
  assert.equal(await salvar(page).isDisabled(), false);
});

test('duas placas fora da Frota permanecem opções e nunca preenchem a primeira automaticamente', async (t) => {
  const page = await paginaOCR(t, []);
  await filaOCR(page, { data: dadosOCR(['Placa: ABC1234', 'Placa: XYZ5678']) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'placa').inputValue(), '');
  assert.equal(await salvar(page).isDisabled(), false);
  await abrirConferencia(page);
  const alternativas = await revisao(page, 'placa').locator('.mocr-alternativas option').allTextContents();
  assert.ok(alternativas.join(' ').includes('ABC1234') && alternativas.join(' ').includes('XYZ5678'));
});

test('número do auto com formato de placa não é usado como placa da Frota', async (t) => {
  const page = await paginaOCR(t, ['ABC1234']);
  await filaOCR(page, { data: dadosOCR(['Número do auto de infração: ABC1234']) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'autoInfracao').inputValue(), 'ABC1234');
  assert.equal(await campo(page, 'placa').inputValue(), '', 'Frota não transforma número do auto em placa');
  assert.equal(await salvar(page).isDisabled(), false);
});

test('releitura com duas placas fora da Frota preserva placa anterior sem escolher a primeira alternativa', async (t) => {
  const page = await paginaOCR(t, []);
  await filaOCR(page, { data: dadosOCR(['Placa: ABC1234']) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'placa').inputValue(), 'ABC1234');
  await abrirConferencia(page);
  const item = revisao(page, 'placa');
  await filaOCR(page, { data: dadosOCR(['Placa: XYZ5678', 'Placa: LMN9012']) });
  await item.locator('[data-ocr-acao="reler"]').click();
  await page.waitForFunction(() => !document.getElementById('btnMultaOCR').disabled);
  assert.equal(await campo(page, 'placa').inputValue(), 'ABC1234');
  assert.equal(await salvar(page).isDisabled(), false);
  await abrirConferencia(page);
  const alternativas = await item.locator('.mocr-alternativas option').allTextContents();
  assert.ok(alternativas.join(' ').includes('XYZ5678') && alternativas.join(' ').includes('LMN9012'));
});

for (const acao of ['fechar e reabrir', 'cancelar']) {
  test(`leitura pendente: ${acao} invalida resultados, encerra worker e permite nova tentativa`, async (t) => {
    const page = await paginaOCR(t);
    await filaOCR(page, { pendente: true, data: dadosOCR(['Placa: KDR0E17', 'Valor original: R$ 195,23']) });
    await page.locator('#inputMultaOCR').setInputFiles(await imagemFicticia(page));
    await page.waitForFunction(() => window.__ocrTeste.liberar !== null);
    assert.equal(await salvar(page).isDisabled(), true);
    if (acao === 'fechar e reabrir') {
      await page.locator('#fecharMulta').click();
      await page.locator('#multaModal').waitFor({ state: 'hidden' });
      await page.locator('#btnAddMulta').click();
    } else {
      await page.locator('#mocrCancelar').click();
    }
    await page.evaluate(() => window.__ocrTeste.liberar());
    await page.waitForFunction(() => !document.getElementById('btnMultaOCR').disabled);
    await page.waitForTimeout(75); // resultado antigo passa pela microtask final, sem alterar novo modal
    assert.equal(await campo(page, 'placa').inputValue(), '');
    assert.equal(await campo(page, 'valor').inputValue(), '');
    assert.equal(await salvar(page).isDisabled(), false);
    assert.ok(await page.evaluate(() => window.__ocrTeste.terminados) > 0);
    await filaOCR(page, { data: dadosOCR(['Placa: KDR0E17']) });
    await lerArquivo(page);
    assert.equal(await campo(page, 'placa').inputValue(), 'KDR0E17');
  });
}

test('erro do motor não mantém Salvar bloqueado e permite tentar novamente', async (t) => {
  const page = await paginaOCR(t);
  await filaOCR(page, { erro: 'Falha fictícia do motor' });
  await lerArquivo(page);
  assert.match(await page.locator('#mocrStatus').textContent(), /falha|erro/i);
  assert.equal(await salvar(page).isDisabled(), false);
  assert.ok(await page.evaluate(() => window.__ocrTeste.terminados) > 0);
  await filaOCR(page, { data: dadosOCR(['Placa: KDR0E17']) });
  await lerArquivo(page);
  assert.equal(await campo(page, 'placa').inputValue(), 'KDR0E17');
});

test('revisão aceita moeda digitada no formato brasileiro e grava valor numérico correto', async (t) => {
  const page = await paginaOCR(t);
  await filaOCR(page, { data: dadosOCR(['Placa: KDR0E17', 'Valor original: R$ 195,23'], 70) });
  await lerArquivo(page);
  await abrirConferencia(page);
  const item = revisao(page, 'valor');
  await item.locator('[data-ocr-acao="corrigir"]').click();
  await item.locator('.mocr-valor').fill('R$ 1.234,56');
  await item.locator('[data-ocr-acao="aceitar"]').click();
  assert.equal(await campo(page, 'valor').inputValue(), '1234.56');
  const response = page.waitForResponse((r) => new URL(r.url()).pathname === '/api/multas' && r.request().method() === 'POST');
  await salvar(page).click();
  assert.equal((await (await response).json()).valor, 1234.56);
});

test('timeout de 90s simulado encerra leitura pendente sem aplicar resultado atrasado', async (t) => {
  const page = await paginaOCR(t, ['KDR0E17'], { timeoutMs: 30 });
  // O teste cobre o temporizador/worker; decode e limites têm um teste próprio.
  // Preparação imediata garante que o worker esteja pendente antes do prazo simulado.
  await page.evaluate(() => {
    prepararImagemOCR = async () => {
      const canvas = document.createElement('canvas'); canvas.width = 1200; canvas.height = 1500; return canvas;
    };
  });
  await filaOCR(page, { pendente: true, data: dadosOCR(['Placa: KDR0E17', 'Valor original: R$ 195,23']) });
  await page.locator('#inputMultaOCR').setInputFiles(await imagemFicticia(page));
  await page.waitForFunction(() => /demorou/.test(document.getElementById('mocrStatus').textContent)
    && !document.getElementById('btnMultaOCR').disabled);
  assert.equal(await page.evaluate(() => window.__ocrTeste.chamadas.length), 1);
  assert.ok(await page.evaluate(() => window.__ocrTeste.terminados) > 0);
  await page.evaluate(() => window.__ocrTeste.liberar());
  await page.waitForTimeout(75);
  assert.equal(await campo(page, 'placa').inputValue(), '');
  assert.equal(await campo(page, 'valor').inputValue(), '');
  assert.equal(await salvar(page).isDisabled(), false);
});

test('fechar antes da inicialização terminar encerra worker tardio e preserva novo modal', async (t) => {
  const page = await paginaOCR(t, ['KDR0E17'], { workerPendente: true });
  await filaOCR(page, { data: dadosOCR(['Placa: KDR0E17']) });
  await page.locator('#inputMultaOCR').setInputFiles(await imagemFicticia(page));
  await page.waitForFunction(() => window.__ocrTeste.liberarCriacao !== null);
  await page.locator('#fecharMulta').click();
  await page.locator('#multaModal').waitFor({ state: 'hidden' });
  await page.locator('#btnAddMulta').click();
  await page.evaluate(() => window.__ocrTeste.liberarCriacao());
  await page.waitForFunction(() => window.__ocrTeste.terminados > 0);
  assert.equal(await page.evaluate(() => window.__ocrTeste.chamadas.length), 0);
  assert.equal(await campo(page, 'placa').inputValue(), '');
  assert.equal(await campo(page, 'responsavel').inputValue(), 'IDENTIFICAR');
  assert.equal(await salvar(page).isDisabled(), false);
});

test('imagem muito grande respeita 12 megapixels e transparência vira fundo branco', async (t) => {
  const page = await paginaOCR(t);
  const resultado = await page.evaluate(async () => {
    const original = document.createElement('canvas'); original.width = 4500; original.height = 4000;
    const file = await new Promise((resolve) => original.toBlob((b) => resolve(new File([b], 'transparente.png', { type: 'image/png' }))));
    const preparada = await prepararImagemOCR(file);
    const canvas = preparada.canvas || preparada;
    return { width: canvas.width, height: canvas.height,
      pixel: [...canvas.getContext('2d').getImageData(0, 0, 1, 1).data] };
  });
  assert.ok(resultado.width * resultado.height <= 12e6, JSON.stringify(resultado));
  assert.deepEqual(resultado.pixel, [255, 255, 255, 255]);
});
