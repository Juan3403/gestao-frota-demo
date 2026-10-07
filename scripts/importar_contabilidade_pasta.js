#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { PDFParse } = require('pdf-parse');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const CONTAB_FILE = path.join(DATA_DIR, 'contabilidade.json');
const PREVIEW_FILE = path.join(DATA_DIR, 'contabilidade-import-preview.json');

const MESES = { jan: '01', fev: '02', mar: '03', abr: '04', mai: '05', jun: '06', jul: '07', ago: '08', set: '09', out: '10', nov: '11', dez: '12' };

function argValor(nome, fallback = '') {
  const i = process.argv.indexOf(nome);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const PASTA = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : argValor('--pasta');
const APPLY = process.argv.includes('--apply');
const REPLACE_DEMO = process.argv.includes('--replace-demo');
const EMPRESA_INFORMADA = argValor('--empresa');
const CNPJ_INFORMADO = argValor('--cnpj');

if (!PASTA) {
  console.error('Uso: node scripts/importar_contabilidade_pasta.js "C:\\\\pasta\\\\pdfs" --empresa "NORTE CONSTRUTORA LTDA" --cnpj "00.000.000/0001-00" [--apply]');
  process.exit(1);
}

function moedaBR(v) {
  if (v == null || v === '' || v === '-') return 0;
  let s = String(v).trim().replace(/\s+/g, '').replace(/[^\d,.\-()]/g, '');
  if (!s || s === '-') return 0;
  const neg = /\(|-/.test(s);
  s = s.replace(/[()]/g, '').replace(/-/g, '');
  const temVirg = s.includes(','), temPonto = s.includes('.');
  if (temVirg && temPonto) s = s.lastIndexOf(',') > s.lastIndexOf('.') ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (temVirg) s = s.replace(',', '.');
  else if (temPonto) {
    const partes = s.split('.');
    if (partes.length > 1 && partes[0].length <= 3 && partes.slice(1).every(p => p.length === 3)) s = s.replace(/\./g, '');
  }
  const n = Number(s);
  return Number.isFinite(n) ? (neg ? -Math.abs(n) : n) : 0;
}
function norm(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}
function limparTexto(t) {
  return String(t || '').replace(/\r/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}
function listarPDFs(dir) {
  const out = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...listarPDFs(full));
    else if (/\.pdf$/i.test(item.name)) out.push(full);
  }
  return out.sort((a, b) => a.localeCompare(b, 'pt-BR'));
}
async function extrairTextoPDF(file) {
  const parser = new PDFParse({ data: fs.readFileSync(file) });
  try {
    const r = await parser.getText();
    return limparTexto(r && r.text);
  } finally {
    try { await parser.destroy(); } catch (_) {}
  }
}
function renderizarPDFParaPNG(file) {
  const base = crypto.createHash('sha1').update(file).digest('hex').slice(0, 16);
  const script = `
import fitz, os, json, tempfile
f = json.loads(os.environ['PDF_FILE_JSON'])
base = os.environ['PDF_RENDER_BASE']
tmp = os.path.join(tempfile.gettempdir(), 'codex_pdf_ocr_batch')
os.makedirs(tmp, exist_ok=True)
doc = fitz.open(f)
out = []
for i in range(min(doc.page_count, 3)):
    pix = doc[i].get_pixmap(matrix=fitz.Matrix(3, 3), alpha=False)
    img = os.path.join(tmp, f'{base}.p{i+1}.png')
    pix.save(img)
    out.append(img)
print(json.dumps(out, ensure_ascii=False))
`;
  const r = spawnSync('python', ['-c', script], {
    env: { ...process.env, PDF_FILE_JSON: JSON.stringify(file), PDF_RENDER_BASE: base },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || '').trim() || 'Falha ao renderizar PDF para OCR.');
  return JSON.parse((r.stdout || '').replace(/^\uFEFF/, ''));
}
async function ocrImagens(images) {
  const modPath = path.join(os.homedir(), '.codex', 'pdf-tools', 'node_modules', 'tesseract.js');
  if (!fs.existsSync(modPath)) throw new Error(`Tesseract.js local nao encontrado em ${modPath}`);
  const { createWorker } = require(modPath);
  const worker = await createWorker('por');
  try {
    const textos = [];
    for (const image of images) {
      const { data } = await worker.recognize(image);
      textos.push(data.text || '');
    }
    return limparTexto(textos.join('\n'));
  } finally {
    await worker.terminate();
  }
}
async function textoComOCR(file) {
  const direto = await extrairTextoPDF(file).catch(() => '');
  if (direto.replace(/\s+/g, '').length > 80) return { texto: direto, origem: 'texto' };
  const imgs = renderizarPDFParaPNG(file);
  const ocr = await ocrImagens(imgs);
  return { texto: ocr, origem: 'ocr' };
}
function detectarTipo(file, texto) {
  const s = norm(path.basename(file) + ' ' + texto.slice(0, 1600));
  if (s.includes('DRE') || s.includes('DEMONSTRACAO DE RESULTADO')) return 'dre';
  if (s.includes('BALANCO') || s.includes('BALANCO PATRIMONIAL')) return 'balanco';
  if (s.includes('FATURAMENTO') || /^ANO\s+20\d{2}/i.test(path.basename(file))) return 'faturamento';
  return 'balancete';
}
function competencia(file, texto) {
  const periodo = String(texto || '').match(/(\d{2})\/(\d{2})\/(20\d{2})\s+a\s+(\d{2})\/(\d{2})\/(20\d{2})/);
  if (periodo) return `${periodo[6]}-${periodo[5]}`;
  const ano = (path.basename(file).match(/20\d{2}/) || String(texto || '').match(/\b20\d{2}\b/) || [''])[0];
  return ano ? `${ano}-12` : '';
}
function empresaTexto(texto) {
  const ent = String(texto || '').match(/Entidade:\s*([^\n]+)/i);
  const cnpj = String(texto || '').match(/\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/);
  return {
    empresa: EMPRESA_INFORMADA || (ent && ent[1] || '').trim(),
    cnpj: CNPJ_INFORMADO || (cnpj ? cnpj[0] : ''),
  };
}
function valoresLinha(linha) {
  const vals = [];
  const re = /R\$\s*\(?-?\s*[\d .]*\d,\d{2}\)?|R\$\s*-\s*/g;
  let m;
  while ((m = re.exec(linha))) vals.push(moedaBR(m[0]));
  return vals;
}
function linhasContabeis(texto) {
  const raw = limparTexto(texto).split(/\n+/).map(s => s.trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    let l = raw[i];
    if (!/R\$/i.test(l) && i + 1 < raw.length && /^R\$/i.test(raw[i + 1])) l += ' ' + raw[++i];
    if (/R\$/i.test(l)) out.push(l);
  }
  return out;
}
function linhaPorRotulo(linhas, rotulo) {
  const alvo = norm(rotulo);
  return linhas.find(l => norm(l).startsWith(alvo + ' R') || norm(l).startsWith(alvo + ' '));
}
function valorAtual(linhas, rotulo) {
  const l = linhaPorRotulo(linhas, rotulo);
  if (!l) return 0;
  const vals = valoresLinha(l);
  return vals.length ? vals[0] : 0;
}
function valorAposRotulo(texto, rotulo) {
  const alvo = norm(rotulo);
  const flat = String(texto || '').replace(/\s+/g, ' ');
  const idx = norm(flat).indexOf(alvo);
  if (idx < 0) return 0;
  const trecho = flat.slice(Math.max(0, idx - 30), idx + rotulo.length + 180);
  const vals = valoresLinha(trecho);
  return vals.length ? vals.at(-1) : 0;
}
function extrairDRE(texto) {
  const linhas = linhasContabeis(texto);
  const get = (r) => valorAtual(linhas, r) || valorAposRotulo(texto, r);
  const resultadoOperacional = get('RESULTADO OPERACIONAL');
  const resultadoAntesIR = get('RESULTADO ANTES DO IR E CSL');
  const lucroLiquido = get('LUCRO LIQUIDO DO EXERCICIO') || get('LUCRO LIQUIDO') || get('PREJUIZO DO EXERCICIO') || resultadoAntesIR || resultadoOperacional;
  return {
    dados: {
      faturamento: get('RECEITA BRUTA'),
      receitaBruta: get('RECEITA BRUTA'),
      deducoes: get('(-) DEDUCOES') || get('DEDUCOES'),
      receitaLiquida: get('RECEITA LIQUIDA'),
      custos: get('(-) CMV') || get('CMV') || get('CUSTOS DOS SERVICOS PRESTADOS'),
      lucroBruto: get('LUCRO BRUTO'),
      despesasOperacionais: get('(-) DESPESAS OPERACIONAIS') || get('DESPESAS OPERACIONAIS'),
      despesasAdministrativas: get('(-) DESPESAS ADMINISTRATIVAS') || get('DESPESAS ADMINISTRATIVAS'),
      resultadoOperacional,
      resultadoAntesIR,
      lucroLiquido,
    },
    linhas: linhas.map(l => ({ rotulo: l.replace(/\s*R\$.*$/, '').trim(), valores: valoresLinha(l) })).filter(x => x.valores.length),
  };
}
function extrairBalanco(texto) {
  const linhas = linhasContabeis(texto);
  const get = (r) => valorAtual(linhas, r) || valorAposRotulo(texto, r);
  const ativo = get('ATIVO');
  const passivo = get('PASSIVO');
  const passivoCirculante = get('PASSIVO CIRCULANTE');
  const passivoNaoCirculante = get('PASSIVO NAO CIRCULANTE') || get('PASSIVO NAO-CIRCULANTE');
  return {
    dados: {
      ativo,
      ativoCirculante: get('ATIVO CIRCULANTE'),
      ativoNaoCirculante: get('ATIVO NAO CIRCULANTE') || get('ATIVO NAO-CIRCULANTE'),
      realizavelLongoPrazo: get('ATIVO REALIZAVEL A LONGO PRAZO') || get('REALIZAVEL A LONGO PRAZO'),
      estoques: get('ESTOQUES'),
      passivo,
      passivoCirculante,
      passivoNaoCirculante,
      passivoLongoPrazo: passivoNaoCirculante,
      patrimonioLiquido: get('PATRIMONIO LIQUIDO') || (ativo && (passivoCirculante || passivoNaoCirculante) ? ativo - passivoCirculante - passivoNaoCirculante : 0),
    },
    linhas: linhas.map(l => ({ rotulo: l.replace(/\s*R\$.*$/, '').trim(), valores: valoresLinha(l) })).filter(x => x.valores.length),
  };
}
function extrairFaturamento(texto) {
  const meses = [];
  const re = /\b(jan|fev|mar|abr|mai|jun|jul|ago|set|out|nov|dez)\/(\d{2,4})\b\s*(?:-|R\$)?\s*([-\d .]+,\d{2}|-)/gi;
  let m;
  while ((m = re.exec(String(texto || '')))) {
    const ano = m[2].length === 2 ? '20' + m[2] : m[2];
    const mes = MESES[m[1].toLowerCase()];
    meses.push({ competencia: `${ano}-${mes}`, rotulo: `${m[1].toLowerCase()}/${String(ano).slice(2)}`, valor: m[3] === '-' ? 0 : moedaBR(m[3]) });
  }
  const total = meses.reduce((s, x) => s + x.valor, 0);
  return { dados: { faturamento: total, receitaBruta: total, lucroLiquido: 0 }, meses };
}
function extrair(tipo, texto) {
  if (tipo === 'dre') return extrairDRE(texto);
  if (tipo === 'balanco') return extrairBalanco(texto);
  if (tipo === 'faturamento') return extrairFaturamento(texto);
  return { dados: {}, linhas: [] };
}
// Ganchos para corrigir à mão totais que o OCR deformar em um PDF específico.
// USO: aplicarAjustesConhecidos('BALANCO 2023.pdf', 'balanco', ext) → ext (sem ajuste na versão demo)
function aplicarAjustesConhecidos(file, tipo, ext) {
  return ext;
}
function id(prefixo) {
  return prefixo + Date.now().toString(36) + crypto.randomBytes(5).toString('hex');
}
function normalizarEmpresaId(nome, cnpj) {
  return 'CTBE_' + crypto.createHash('sha1').update(`${nome}|${cnpj}`).digest('hex').slice(0, 14);
}
function lerStore() {
  try {
    const o = JSON.parse(fs.readFileSync(CONTAB_FILE, 'utf8'));
    return { contabilidade: Array.isArray(o.contabilidade) ? o.contabilidade : [], empresas: Array.isArray(o.empresas) ? o.empresas : [] };
  } catch (_) {
    return { contabilidade: [], empresas: [] };
  }
}
function salvarStore(store) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(CONTAB_FILE, JSON.stringify(store, null, 2));
}
function salvarMidia(file) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const midiaId = id('contab_imp_');
  const nome = path.basename(file);
  fs.writeFileSync(path.join(UPLOADS_DIR, midiaId + '.json'), JSON.stringify({
    tipo: 'application/pdf',
    nome,
    b64: fs.readFileSync(file).toString('base64'),
    ts: Date.now(),
  }, null, 2));
  return { id: midiaId, nome, tipo: 'application/pdf' };
}
function qualidade(tipo, dados) {
  const campos = tipo === 'dre'
    ? ['receitaBruta', 'receitaLiquida', 'custos', 'despesasOperacionais']
    : tipo === 'balanco'
      ? ['ativo', 'ativoCirculante', 'passivoCirculante', 'patrimonioLiquido']
      : ['faturamento'];
  return campos.filter(c => Math.abs(Number(dados[c]) || 0) > 0).length;
}

(async () => {
  const pdfs = listarPDFs(path.resolve(PASTA));
  const registros = [];
  for (const file of pdfs) {
    console.log('Lendo:', path.basename(file));
    const { texto, origem } = await textoComOCR(file);
    const tipo = detectarTipo(file, texto);
    const ext = aplicarAjustesConhecidos(file, tipo, extrair(tipo, texto));
    const base = empresaTexto(texto);
    const empresa = base.empresa || EMPRESA_INFORMADA || 'EMPRESA CONTABIL';
    const cnpj = base.cnpj || CNPJ_INFORMADO || '';
    const empresaId = normalizarEmpresaId(empresa, cnpj);
    const comp = competencia(file, texto);
    const avisos = [];
    if (origem === 'ocr') avisos.push('Texto extraido por OCR; revisar valores antes de usar.');
    if (ext.ajusteManual) avisos.push(ext.ajusteManual);
    if (!ext.ajusteManual && qualidade(tipo, ext.dados || {}) < (tipo === 'faturamento' ? 1 : 2)) avisos.push('Poucos campos foram reconhecidos automaticamente.');
    registros.push({
      id: `CTB_IMP_${tipo.toUpperCase()}_${empresaId}_${comp || id('SEMCOMP_')}`,
      ts: Date.now(),
      tipo,
      competencia: comp,
      empresaId,
      empresa,
      cnpj,
      arquivoFonte: file,
      arquivo: null,
      dados: ext.dados || {},
      meses: ext.meses || [],
      linhas: ext.linhas || [],
      revisadoPor: 'Importador local',
      revisadoEm: Date.now(),
      textoPreview: texto.slice(0, 2500),
      avisos,
      origemTexto: origem,
    });
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(PREVIEW_FILE, JSON.stringify({ geradoEm: new Date().toISOString(), pasta: path.resolve(PASTA), apply: APPLY, registros }, null, 2));
  console.log('\nPrevia salva em:', PREVIEW_FILE);
  for (const r of registros) {
    console.log(`${r.competencia || '----'} | ${r.tipo.padEnd(11)} | ${r.origemTexto.padEnd(5)} | score ${qualidade(r.tipo, r.dados)} | ${path.basename(r.arquivoFonte)}`);
    if (r.avisos.length) console.log('  avisos:', r.avisos.join(' '));
  }

  if (!APPLY) {
    console.log('\nDry-run: nada foi gravado no app. Rode novamente com --apply para importar.');
    return;
  }

  const store = lerStore();
  if (fs.existsSync(CONTAB_FILE)) {
    const bak = CONTAB_FILE + '.bak-' + Date.now();
    fs.copyFileSync(CONTAB_FILE, bak);
    console.log('Backup criado:', bak);
  }
  if (REPLACE_DEMO) {
    store.contabilidade = store.contabilidade.filter(r => !String(r.id || '').startsWith('CTB_DEMO_') && !String(r.empresaId || '').startsWith('CTBE_DEMO_'));
    store.empresas = store.empresas.filter(e => !String(e.id || '').startsWith('CTBE_DEMO_'));
  }
  const empresas = new Map(store.empresas.map(e => [e.id, e]));
  for (const r of registros) {
    if (!empresas.has(r.empresaId)) empresas.set(r.empresaId, { id: r.empresaId, nome: r.empresa, cnpj: r.cnpj, observacoes: 'Importada de pasta local', criadoEm: Date.now(), atualizadoEm: Date.now() });
    r.arquivo = salvarMidia(r.arquivoFonte);
    delete r.arquivoFonte;
    delete r.origemTexto;
  }
  const chave = (r) => [r.empresaId || r.empresa, r.tipo, r.competencia, r.arquivo && r.arquivo.nome].join('|').toLowerCase();
  const existentes = new Set(store.contabilidade.map(chave));
  for (const r of registros) {
    if (existentes.has(chave(r))) continue;
    store.contabilidade.push(r);
  }
  store.empresas = Array.from(empresas.values()).sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));
  store.contabilidade.sort((a, b) => String(b.competencia || '').localeCompare(String(a.competencia || '')) || String(a.tipo).localeCompare(String(b.tipo)));
  salvarStore(store);
  console.log('\nImportado em:', CONTAB_FILE);
})();
