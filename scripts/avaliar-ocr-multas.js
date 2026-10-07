#!/usr/bin/env node
/**
 * Avaliação reproduzível com sete prints SENATRAN/CDT inteiramente fictícios. O sétimo
 * ("senatran-tabela") imita o portal da SENATRAN: fonte Raleway, ícone antes do título e da placa,
 * tabela com a coluna de rótulos à esquerda, "Órgão Competente/Responsável" e as datas limite;
 * nele TODOS os campos exibidos têm de sair certos (foi onde os prints reais erraram em out/2026).
 * Usa o Tesseract do navegador EXATAMENTE 5.1.1, nunca a dependência backend v7;
 * usa prepararImagemOCR e MultaOCR reais da versão local do aplicativo.
 * Os assets oficiais são baixados pelo Node e servidos localmente ao worker.
 * Não grava dados na pasta data/ nem envia prints a serviço externo.
 *
 * USO: node scripts/avaliar-ocr-multas.js
 *      → PNGs e relatório JSON em pasta temporária; exit 1 se houver preenchimento automático errado
 *        ou alguma das sete descrições legíveis não for preenchida integralmente, ou se algum campo
 *        do cenário senatran-tabela sair errado ou vazio.
 *      node scripts/avaliar-ocr-multas.js --out screenshots/ocr-ficticio
 *      → mesma avaliação, conservando os artefatos no destino escolhido.
 * O download inicial requer internet; execuções seguintes reutilizam cache temporário.
 */
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { chromium } = require('playwright');

const RAIZ = path.join(__dirname, '..');
// Exclusiva do proxy desta avaliação; backend interno recebe porta dinâmica livre.
const PORT = 3217;
const BASE = `http://localhost:${PORT}`;
const VERSAO = '5.1.1';
const CACHE = path.join(os.tmpdir(), 'frota-ocr-assets-' + VERSAO);
const idxOut = process.argv.indexOf('--out');
if (idxOut >= 0 && !process.argv[idxOut + 1]) throw new Error('--out exige um diretório');
const OUT = idxOut >= 0 ? path.resolve(RAIZ, process.argv[idxOut + 1])
  : fs.mkdtempSync(path.join(os.tmpdir(), 'frota-ocr-avaliacao-'));

const CAMPOS = [
  ['placa', 'Placa à época da infração', 'KDR0E17'],
  ['autoInfracao', 'Número do auto de infração', 'A123456789'],
  ['descricao', 'Descrição da infração', 'CONDUZIR VEÍCULO SEM EQUIPAMENTO OBRIGATÓRIO'],
  [['dataInfracao', 'horaInfracao'], 'Data/Hora do Cometimento da Infração', '05/10/2026 10:25'],
  ['valor', 'Valor original', 'R$ 195,23'],
  ['local', 'Local da infração', 'RUA FICTÍCIA 100'],
  ['cidadeEstado', 'Cidade/Estado', 'SÃO PAULO/SP'],
  ['codigoInfracao', 'Código da infração', '5002-0'],
  ['orgaoAutuador', 'Órgão autuador', '000300 - DETRAN FICTÍCIO'],
  ['dataNotificacao', 'Data da notificação', '06/10/2026'],
  ['dataVencimento', 'Data de vencimento', '05/11/2026'],
];
const VERDADE = { ...Object.fromEntries(CAMPOS.filter(([campo]) => typeof campo === 'string')
  .map(([campo, , valor]) => [campo, campo === 'valor' ? '195.23' : valor])),
  dataInfracao: '05/10/2026', horaInfracao: '10:25' };
const CENARIOS = [
  { nome: 'limpo', escala: 1, descricao: {
    formato: 'titulo',
    linhas: ['RECUSAR-SE A SER SUBMETIDO A TESTE OU EXAME QUE',
      '• PERMITA CERTIFICAR INFLUÊNCIA DE ÁLCOOL'],
    esperado: 'RECUSAR-SE A SER SUBMETIDO A TESTE OU EXAME QUE PERMITA CERTIFICAR INFLUÊNCIA DE ÁLCOOL',
  } },
  { nome: 'pequeno', escala: 0.5, descricao: {
    formato: 'padrao', linhas: ['CONDUZIR VEÍCULO SEM EQUIPAMENTO OBRIGATÓRIO'],
    esperado: 'CONDUZIR VEÍCULO SEM EQUIPAMENTO OBRIGATÓRIO',
  } },
  { nome: 'borrado', escala: 1, blur: 2, descricao: {
    formato: 'padrao', linhas: ['CONDUZIR VEÍCULO COM EQUIPAMENTO OBRIGATÓRIO INEFICIENTE'],
    esperado: 'CONDUZIR VEÍCULO COM EQUIPAMENTO OBRIGATÓRIO INEFICIENTE',
  } },
  { nome: 'escuro', escala: 1, escuro: true, descricao: {
    formato: 'multilinha', linhas: ['TRANSITAR COM O VEÍCULO NA FAIXA OU VIA DE',
      'TRÂNSITO EXCLUSIVO PARA TRANSPORTE PÚBLICO COLETIVO'],
    esperado: 'TRANSITAR COM O VEÍCULO NA FAIXA OU VIA DE TRÂNSITO EXCLUSIVO PARA TRANSPORTE PÚBLICO COLETIVO',
  } },
  { nome: 'cortado', escala: 1, limite: 6, descricao: {
    formato: 'multilinha', linhas: ['CONDUZIR VEÍCULO COM PLACA DE IDENTIFICAÇÃO EM',
      'DESACORDO COM AS ESPECIFICAÇÕES'],
    esperado: 'CONDUZIR VEÍCULO COM PLACA DE IDENTIFICAÇÃO EM DESACORDO COM AS ESPECIFICAÇÕES',
  } },
  { nome: 'duas-colunas', escala: 1, colunas: true, descricao: {
    formato: 'rotulo-quebrado', linhas: ['PERMITIR QUE CONDUTOR NÃO HABILITADO',
      'CONDUZA VEÍCULO AUTOMOTOR'],
    esperado: 'PERMITIR QUE CONDUTOR NÃO HABILITADO CONDUZA VEÍCULO AUTOMOTOR',
  } },
  // Igual ao portal: Raleway (o zero dela parece "O" e partia em "O0"), ícone lido como "B",
  // linha "Órgão Competente/Responsável" logo abaixo do órgão autuador e Nº do auto com zeros.
  { nome: 'senatran-tabela', escala: 1, exigeTodos: true, descricao: {
    formato: 'senatran', linhas: ['ESTACIONAR EM LOCAL/HORARIO PROIBIDO ESPECIFICAMENTE PELA SINALIZACAO'],
    esperado: 'ESTACIONAR EM LOCAL/HORARIO PROIBIDO ESPECIFICAMENTE PELA SINALIZACAO',
  }, senatran: {
    placa: 'KDR0E17',
    tabela: [
      ['Órgão Autuador', '225310 - PREF. DE PE RECIFE'],
      ['Órgão Competente/Responsável', '225310 - PREF. DE PE RECIFE'],
      ['Local da Infração', 'RUA FICTICIA DAS FLORES, 100 - RECIFE'],
      ['Data/Hora do Cometimento da Infração', '18/09/2026 09:15'],
      ['Número do Auto de Infração', 'OD00512345'],
      ['Código da Infração', '5550 - 0'],
      ['Número RENAINF', '10253000297'],
      ['Valor Original', 'R$ 130,16'],
      null,
      ['Data da Notificação de Autuação', '25/09/2026'],
      ['Data Limite para Interposição de Defesa Prévia', '12/11/2026'],
      ['Data Limite para Identificação do Condutor Infrator', '12/11/2026'],
    ],
    verdade: { placa: 'KDR0E17', descricao: 'ESTACIONAR EM LOCAL/HORARIO PROIBIDO ESPECIFICAMENTE PELA SINALIZACAO',
      orgaoAutuador: '225310 - PREF. DE PE RECIFE', local: 'RUA FICTICIA DAS FLORES, 100 - RECIFE', cidadeEstado: 'Recife/PE',
      dataInfracao: '18/09/2026', horaInfracao: '09:15', autoInfracao: 'OD00512345', codigoInfracao: '5550-0',
      valor: '130.16', dataNotificacao: '25/09/2026' },
  } },
];

// USO: await baixar('worker.min.js', 'https://cdn.jsdelivr.net/npm/...') → asset local validado.
async function baixar(relativo, url) {
  const destino = path.join(CACHE, relativo);
  if (fs.existsSync(destino) && fs.statSync(destino).size > 0) return;
  const response = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Não foi possível baixar asset oficial: HTTP ${response.status}, ${url}`);
  const dados = Buffer.from(await response.arrayBuffer());
  assert.ok(dados.length > 0, 'asset não pode estar vazio');
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, dados);
}

// USO: await prepararAssets() → JS/core exatos 5.1.1 e idioma por do repositório oficial.
async function prepararAssets() {
  await Promise.all([
    baixar('tesseract.min.js', `https://cdn.jsdelivr.net/npm/tesseract.js@${VERSAO}/dist/tesseract.min.js`),
    baixar('worker.min.js', `https://cdn.jsdelivr.net/npm/tesseract.js@${VERSAO}/dist/worker.min.js`),
    // Fonte do portal da SENATRAN, para o cenário senatran-tabela (Fontsource, licença OFL).
    baixar('fonte/raleway-400.woff2', 'https://cdn.jsdelivr.net/npm/@fontsource/raleway@5.2.5/files/raleway-latin-400-normal.woff2'),
    // Mesmo modelo LSTM selecionado pelo default do worker 5.1.1/OEM 1.
    baixar('lang-best-int/por.traineddata.gz', 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/por@1.0.0/4.0.0_best_int/por.traineddata.gz'),
    ...['tesseract-core', 'tesseract-core-lstm', 'tesseract-core-simd', 'tesseract-core-simd-lstm']
      .flatMap((nome) => ['wasm.js', 'wasm'].map((ext) => baixar(`core/${nome}.${ext}`,
        `https://cdn.jsdelivr.net/npm/tesseract.js-core@${VERSAO}/${nome}.${ext}`))),
  ]);
}

// USO: await portaTemporaria() → escolhe porta livre interna sem disputar testes paralelos.
async function portaTemporaria() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer(); probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const porta = probe.address().port; probe.close(() => resolve(porta));
    });
  });
}

// USO: proxyAssets(45678) → mesma origem do painel para JS, WASM, idioma e app reais.
function proxyAssets(portaBackend) {
  return http.createServer((req, res) => {
    if (req.url.startsWith('/__ocr/')) {
      const relativo = req.url.slice('/__ocr/'.length).split('?')[0];
      if (!/^(?:tesseract\.min\.js|worker\.min\.js|core\/tesseract-core(?:-simd)?(?:-lstm)?\.wasm(?:\.js)?|lang\/por\.traineddata\.gz|fonte\/raleway-400\.woff2)$/.test(relativo)) {
        res.writeHead(404); return res.end();
      }
      const arq = path.join(CACHE, relativo === 'lang/por.traineddata.gz'
        ? 'lang-best-int/por.traineddata.gz' : relativo);
      const contentType = arq.endsWith('.woff2') ? 'font/woff2' : arq.endsWith('.wasm') ? 'application/wasm'
        : arq.endsWith('.js') ? 'application/javascript' : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      return fs.createReadStream(arq).pipe(res);
    }
    const pedido = http.request({ hostname: '127.0.0.1', port: portaBackend,
      path: req.url, method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode, response.headers); response.pipe(res);
    });
    pedido.on('error', () => {
      if (res.destroyed) return;
      if (res.headersSent) return res.destroy();
      res.writeHead(502); res.end('Backend de avaliação indisponível');
    });
    req.on('aborted', () => pedido.destroy());
    res.on('close', () => pedido.destroy());
    req.pipe(pedido);
  });
}

// USO: equivalente('SÃO PAULO/SP', 'São Paulo/SP') → true (apenas apresentação normalizada).
function equivalente(a, b) {
  const normal = (v) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase().replace(/\s+/g, ' ').trim();
  return normal(a) === normal(b);
}

// USO: await executar() → seis PNGs e relatório por campo; falha em automático errado ou descrição incompleta/ausente.
async function executar() {
  fs.mkdirSync(OUT, { recursive: true });
  console.log(`Baixando/conferindo Tesseract ${VERSAO} oficial (cache temporário)…`);
  await prepararAssets();
  const portaBackend = await portaTemporaria();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-ocr-benchmark-data-'));
  let browser, proxy, servidor, saida = null, stderr = '';
  try {
    proxy = proxyAssets(portaBackend);
    await new Promise((resolve, reject) => {
      proxy.once('error', reject); proxy.listen(PORT, '127.0.0.1', resolve);
    });
    servidor = spawn(process.execPath, ['backend/server.js'], {
      cwd: RAIZ,
      env: { ...process.env, DATA_DIR: tmp, PORT: String(portaBackend), MONGODB_URI: '',
        APP_PASSWORD: '', SENHA_ADMIN: '', SESSION_SECRET: 'sessao-ficticia-ocr-benchmark',
        E2E_TEST: '1', COFRE_CHAVE: 'chave-ficticia-exclusiva-ocr-benchmark',
        MIDIA_S3_LOCAL: '', MIDIA_S3_BUCKET: '', VIDEO_S3_BUCKET: '', RENDER: '' },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    servidor.stderr.on('data', (d) => { stderr += d; });
    servidor.on('exit', (codigo, sinal) => { saida = codigo === null ? sinal : codigo; });
    let pronto = false;
    const fim = Date.now() + 20000;
    while (Date.now() < fim) {
      if (saida !== null) throw new Error(`Backend da avaliação morreu (${saida}): ${stderr.slice(-2000)}`);
      try { pronto = (await fetch(BASE + '/api/versao')).ok; } catch { /* boot */ }
      if (pronto) break;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    assert.ok(pronto, 'backend da avaliação respondeu');
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
    await page.route('**/*', (route) => {
      if (new URL(route.request().url()).origin === BASE) return route.fallback();
      return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    });
    await page.goto(BASE + '/painel/multas', { waitUntil: 'load' });
    await page.waitForFunction(() => typeof prepararImagemOCR === 'function' && typeof MultaOCR !== 'undefined');
    await page.addScriptTag({ url: BASE + '/__ocr/tesseract.min.js' });
    await page.evaluate(async ({ base, versao }) => {
      window.__workerAvaliacao = await Tesseract.createWorker('por', 1, {
        workerPath: `${base}/__ocr/worker.min.js`, corePath: `${base}/__ocr/core`,
        langPath: `${base}/__ocr/lang`, cacheMethod: 'none',
      });
      window.__versaoAvaliacao = versao;
      const raleway = new FontFace('RalewayAvaliacao', `url(${base}/__ocr/fonte/raleway-400.woff2)`);
      document.fonts.add(await raleway.load());
    }, { base: BASE, versao: VERSAO });
    const resultados = [];
    for (const cenario of CENARIOS) {
      const leitura = await page.evaluate(async ({ cenario, campos }) => {
        const exibidos = campos.slice(0, cenario.limite || campos.length);
        // USO: linhasCampo(['descricao', 'Descrição da infração', '...']) → linhas completas do caso;
        // o esperado é definido separadamente no Node, sem ser derivado do texto reconhecido.
        const linhasCampo = ([campo, rotulo, valor]) => {
          if (campo !== 'descricao') return cenario.colunas ? [rotulo + ':', valor] : [rotulo + ': ' + valor];
          const descricao = cenario.descricao;
          if (descricao.formato === 'titulo') return descricao.linhas;
          if (descricao.formato === 'rotulo-quebrado') return ['Descrição da', 'infração:', ...descricao.linhas];
          if (descricao.formato === 'multilinha' || cenario.colunas) return [rotulo + ':', ...descricao.linhas];
          return [rotulo + ': ' + descricao.linhas[0]];
        };
        // USO: printSenatran(cenario.senatran) → canvas 1200 px como o print do portal (sem escala).
        const printSenatran = (sen) => {
          const cv = document.createElement('canvas'); cv.width = 1200; cv.height = 140 + sen.tabela.length * 45 + 30;
          const c = cv.getContext('2d');
          c.fillStyle = '#ffffff'; c.fillRect(0, 0, cv.width, cv.height);
          // Ícones azuis do portal (documento com "$" e cartão da placa): o OCR os lê como letra.
          c.fillStyle = '#1351b4'; c.fillRect(26, 24, 16, 22); c.fillStyle = '#ffffff'; c.font = 'bold 13px Arial'; c.fillText('$', 30, 42);
          c.fillStyle = '#1351b4'; c.fillRect(26, 92, 22, 13);
          c.fillStyle = '#333333'; c.font = '16px RalewayAvaliacao';
          c.fillText(cenario.descricao.linhas[0], 60, 42);
          c.fillText('Placa à época da infração: ' + sen.placa, 64, 104);
          let y = 140;
          const pontilhado = (yy) => { c.fillStyle = '#c8c8c8'; for (let x = 20; x < 1190; x += 7) c.fillRect(x, yy, 3, 3); };
          pontilhado(y - 8);
          for (const linha of sen.tabela) {
            if (!linha) { pontilhado(y + 6); y += 18; continue; }
            c.fillStyle = '#f6f6f6'; c.fillRect(20, y, 470, 45);
            c.fillStyle = '#dddddd'; c.fillRect(20, y + 44, 1170, 1);
            c.fillStyle = '#333333'; c.font = '15px RalewayAvaliacao';
            c.fillText(linha[0], 32, y + 28); c.fillText(linha[1], 495, y + 28);
            y += 45;
          }
          pontilhado(y + 4);
          return cv;
        };
        const blocos = exibidos.map((campo, i) => {
          const linhas = linhasCampo(campo);
          return { campo, linhas, coluna: cenario.colunas && i >= 6 ? 1 : 0,
            altura: Math.max(cenario.colunas ? 120 : 65, linhas.length * 36 + (cenario.colunas ? 45 : 29)) };
        });
        const alturas = [0, 0]; blocos.forEach((bloco) => { alturas[bloco.coluna] += bloco.altura; });
        const original = document.createElement('canvas');
        original.width = 1900;
        original.height = 145 + Math.max(...alturas) + 20;
        const ctx = original.getContext('2d');
        ctx.fillStyle = cenario.escuro ? '#171717' : '#ffffff'; ctx.fillRect(0, 0, original.width, original.height);
        ctx.fillStyle = cenario.escuro ? '#ffffff' : '#131313';
        ctx.font = 'bold 30px Arial';
        ctx.fillText('SENATRAN / CDT - NOTIFICAÇÃO FICTÍCIA PARA TESTE', 35, 48);
        ctx.font = '20px Arial'; ctx.fillText('Dados inventados - sem vínculo com pessoa ou veículo real', 35, 80);
        const posicoesY = [145, 145];
        blocos.forEach((bloco) => {
          const x = 35 + bloco.coluna * 950, y = posicoesY[bloco.coluna];
          ctx.font = cenario.colunas ? '25px Arial' : '28px Arial';
          bloco.linhas.forEach((linha, i) => { ctx.fillText(linha, x, y + i * 36); });
          posicoesY[bloco.coluna] += bloco.altura;
        });
        const print = cenario.senatran ? printSenatran(cenario.senatran) : document.createElement('canvas');
        if (!cenario.senatran) {
          print.width = Math.round(original.width * cenario.escala);
          print.height = Math.round(original.height * cenario.escala);
          const pctx = print.getContext('2d');
          if (cenario.blur) pctx.filter = `blur(${cenario.blur}px)`;
          pctx.drawImage(original, 0, 0, print.width, print.height);
        }
        const file = await new Promise((resolve) => print.toBlob((blob) => resolve(
          new File([blob], `${cenario.nome}.png`, { type: 'image/png' }))));
        const inicio = performance.now();
        const preparada = await prepararImagemOCR(file);
        const { data } = await window.__workerAvaliacao.recognize(preparada, {}, { text: true, blocks: true });
        const analise = MultaOCR.analisar(data, { placas: ['KDR0E17', 'ABC1D23'], frotaDisponivel: true });
        const automaticos = Object.keys(analise.campos).filter((nome) => {
          const campo = analise.campos[nome];
          return campo.estado !== 'naoEncontrado' && campo.valor && (campo.alternativas || []).length <= 1
            && MultaOCR.validar(nome, campo.valor);
        });
        // USO: resumirPalavra(data.words[0]) → {text, bbox, confidence}, sem referências circulares.
        const resumirPalavra = (word) => ({ text: word.text, bbox: word.bbox, confidence: word.confidence });
        // USO: resumirLinha(data.lines[0]) → linha com posições/confiança e todas as palavras reconhecidas.
        const resumirLinha = (line) => ({ text: line.text, bbox: line.bbox, confidence: line.confidence,
          words: (line.words || []).map(resumirPalavra) });
        // USO: dadosOCR → MultaOCR.analisar(relatorio.resultados[0].dadosOCR, contexto) reproduz a análise sem WASM.
        const dadosOCR = { text: data.text, confidence: data.confidence,
          lines: (data.lines || []).map(resumirLinha), words: (data.words || []).map(resumirPalavra),
          blocks: (data.blocks || []).map((block) => ({ text: block.text, bbox: block.bbox, confidence: block.confidence,
            paragraphs: (block.paragraphs || []).map((paragraph) => ({ text: paragraph.text,
              bbox: paragraph.bbox, confidence: paragraph.confidence, lines: (paragraph.lines || []).map(resumirLinha) })) })) };
        return { png: print.toDataURL('image/png').split(',')[1], analise,
          duracaoMs: Math.round(performance.now() - inicio), textoOCR: data.text, dadosOCR,
          width: preparada.width, height: preparada.height,
          automaticos, presentes: cenario.senatran ? Object.keys(cenario.senatran.verdade)
            : exibidos.flatMap(([campo]) => Array.isArray(campo) ? campo : [campo]) };
      }, { cenario, campos: CAMPOS });
      fs.writeFileSync(path.join(OUT, cenario.nome + '.png'), Buffer.from(leitura.png, 'base64'));
      const verdadeCenario = cenario.senatran ? cenario.senatran.verdade : { ...VERDADE, descricao: cenario.descricao.esperado };
      const campos = Object.fromEntries(Object.entries(leitura.analise.campos).map(([nome, extraido]) => {
        const esperado = leitura.presentes.includes(nome) ? verdadeCenario[nome] : '';
        return [nome, { esperado, ...extraido,
          correto: equivalente(extraido.valor, esperado),
          automatico: leitura.automaticos.includes(nome),
          automaticoIncorreto: leitura.automaticos.includes(nome) && !equivalente(extraido.valor, esperado) }];
      }));
      const vals = Object.values(campos);
      const resultado = { cenario: cenario.nome, duracaoMs: leitura.duracaoMs,
        imagemPreparada: { width: leitura.width, height: leitura.height }, campos,
        textoOCR: leitura.textoOCR, dadosOCR: leitura.dadosOCR,
        resumo: { claros: vals.filter((v) => v.estado === 'claro').length,
          revisar: vals.filter((v) => v.estado === 'revisar').length,
          automaticos: vals.filter((v) => v.automatico).length,
          naoEncontrados: vals.filter((v) => v.estado === 'naoEncontrado').length,
          valoresCorretos: vals.filter((v) => v.esperado && v.correto).length,
          esperadosPresentes: leitura.presentes.length,
          descricaoCompleta: campos.descricao.correto,
          descricaoAutomatica: campos.descricao.automatico,
          automaticosIncorretos: vals.filter((v) => v.automaticoIncorreto).length } };
      resultados.push(resultado);
      console.log(`${cenario.nome}: ${resultado.resumo.valoresCorretos}/${resultado.resumo.esperadosPresentes} valores corretos; `
        + `${resultado.resumo.automaticos} automáticos, ${resultado.resumo.revisar} sugestões opcionais, `
        + `${resultado.resumo.automaticosIncorretos} automáticos incorretos; `
        + `descrição ${resultado.resumo.descricaoCompleta && resultado.resumo.descricaoAutomatica ? 'completa e automática' : 'ausente, incompleta ou não automática'} (${leitura.duracaoMs} ms)`);
    }
    await page.evaluate(() => window.__workerAvaliacao.terminate());
    const automaticosIncorretos = resultados.reduce((s, r) => s + r.resumo.automaticosIncorretos, 0);
    // Cenário que imita o portal: todo campo exibido tem de sair certo, não só "sem erro automático".
    const camposFaltando = resultados.filter((r) => CENARIOS.find((c) => c.nome === r.cenario).exigeTodos)
      .flatMap((r) => Object.entries(r.campos).filter(([, v]) => v.esperado && !v.correto)
        .map(([nome, v]) => `${r.cenario}.${nome}: lido "${v.valor}", esperado "${v.esperado}"`));
    const descricoesFalhas = resultados.filter((r) => !r.resumo.descricaoCompleta || !r.resumo.descricaoAutomatica)
      .map((r) => r.cenario);
    const relatorio = { tesseract: VERSAO, idioma: 'por', pacoteIdioma: '1.0.0', modelo: '4.0.0_best_int', dataUTC: new Date().toISOString(),
      printsFicticios: true, automaticosIncorretos, descricoesFalhas, camposFaltando, resultados };
    fs.writeFileSync(path.join(OUT, 'relatorio.json'), JSON.stringify(relatorio, null, 2));
    console.log(`Relatório e ${CENARIOS.length} prints fictícios: ${OUT}`);
    assert.equal(automaticosIncorretos, 0, 'nenhum valor errado pode ser preenchido automaticamente; veja relatorio.json');
    assert.deepEqual(descricoesFalhas, [], 'as descrições legíveis devem ser preenchidas automaticamente e integralmente; veja relatorio.json');
    assert.deepEqual(camposFaltando, [], 'no print do portal SENATRAN todos os campos exibidos devem sair certos; veja relatorio.json');
  } finally {
    await browser?.close();
    if (servidor && saida === null) {
      await new Promise((resolve) => { servidor.once('exit', resolve); servidor.kill(); });
    }
    if (proxy) await new Promise((resolve) => {
      proxy.close(resolve);
      // Só o proxy desta avaliação: fecha keep-alive/SSE após encerrar seu navegador.
      proxy.closeAllConnections();
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

executar().catch((erro) => { console.error(erro.message); process.exitCode = 1; });
