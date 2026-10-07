'use strict';
// ============================================================================
// Biblioteca de backup/restauração para a LINHA DE COMANDO (CLI).
// Gera/lê o MESMO formato .zip do módulo de backup do servidor (manifest.json +
// data/<área>.json + files/** + reports/resumo.txt + SHA-256 por arquivo), então
// um backup feito pela interface pode ser restaurado pelo CLI e vice-versa.
//
// Funciona nos dois modos, sem subir o servidor:
//   • LOCAL  (sem MONGODB_URI): lê/grava os arquivos JSON em DATA_DIR.
//   • MONGO  (com MONGODB_URI): lê/grava os docs em db('frota').collection('app').
// ============================================================================
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const archiver = require('archiver');
const yauzl = require('yauzl');
const CofreMidia = require('../backend/cofre-midia');

const RAIZ = path.resolve(__dirname, '..');
// Mesma regra do server.js: dados locais vivem em `data/` (mantém a raiz limpa);
// trocável pela env DATA_DIR. Tem de bater com o server senão a CLI lê/grava no lugar errado.
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(RAIZ, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
const USE_MONGO = !!process.env.MONGODB_URI;

// Mapa ÚNICO de cobertura (espelha COBERTURA_BACKUP/RESTORE_MODULOS do server.js).
// objeto: módulo guardado como objeto (não array). localArray: arquivo local é um array cru.
// naoRestauravel: trilha de auditoria — entra no backup, mas o restore não a grava.
const MODULOS = [
  { mod: 'veiculos', file: 'frota.json', mongoId: 'frota', wrap: 'veiculos', localFile: 'data.json', grupo: 'frota', chave: 'placa', label: 'Frota (veículos)' },
  { mod: 'multas', file: 'multas.json', mongoId: 'multas', wrap: 'multas', localFile: 'multas.json', grupo: 'multas', chave: 'id', label: 'Multas' },
  { mod: 'rastreadores', file: 'rastreadores.json', mongoId: 'rastreadores', wrap: 'rastreadores', localFile: 'rastreadores.json', grupo: 'rastreadores', chave: 'codigo', label: 'Rastreadores' },
  { mod: 'rastreadoresVinculos', file: 'rastreadores_vinculos.json', mongoId: 'rastreadoresVinculos', wrap: 'eventos', localFile: 'rastreadores_vinculos.json', grupo: 'rastreadores', chave: 'id', label: 'Histórico de vínculos dos rastreadores' },
  { mod: 'instalacoes', file: 'instalacoes.json', mongoId: 'instalacoes', wrap: 'instalacoes', localFile: 'instalacoes.json', grupo: 'rastreadores', chave: 'id', label: 'Instalações' },
  { mod: 'envios', file: 'envios.json', mongoId: 'envios', wrap: 'envios', localFile: 'envios.json', grupo: 'rastreadores', chave: 'id', label: 'Envios' },
  { mod: 'cadastros', file: 'cadastros.json', mongoId: 'cadastros', objeto: true, localFile: 'cadastros.json', grupo: 'frota', label: 'Cadastros' },
  { mod: 'contratos', file: 'contratos.json', mongoId: 'contratos', wrap: 'contratos', localFile: 'contratos.json', grupo: 'frota', chave: 'id', label: 'Contratos' },
  { mod: 'manutencao', file: 'manutencao.json', mongoId: 'manutencao', wrap: 'manutencao', localFile: 'manutencao.json', grupo: 'frota', chave: 'id', label: 'Manutenção' },
  { mod: 'abastecimento', file: 'abastecimento.json', mongoId: 'abastecimento', wrap: 'abastecimento', localFile: 'abastecimento.json', grupo: 'frota', chave: 'id', label: 'Abastecimento' },
  { mod: 'simulacoes', file: 'simulacoes.json', mongoId: 'simulacoes', wrap: 'simulacoes', localFile: 'simulacoes.json', grupo: 'frota', chave: 'id', label: 'Simulações' },
  { mod: 'fornecedores', file: 'fornecedores.json', mongoId: 'fornecedores', wrap: 'fornecedores', localFile: 'fornecedores.json', grupo: 'frota', chave: 'id', label: 'Fornecedores' },
  { mod: 'oficina', file: 'oficina.json', mongoId: 'oficina', wrap: 'oficina', localFile: 'oficina.json', grupo: 'frota', chave: 'id', label: 'Notas fiscais (manutenção)' },
  { mod: 'odometros', file: 'odometros.json', mongoId: 'odometros', wrap: 'leituras', localFile: 'odometros.json', grupo: 'frota', chave: 'id', label: 'Odômetro; leituras por veículo (manutenção)' },
  { mod: 'vistorias', file: 'vistorias.json', mongoId: 'vistorias', wrap: 'vistorias', localFile: 'vistorias.json', grupo: 'frota', chave: 'id', label: 'Vistorias de veículos' },
  { mod: 'aportes', file: 'aportes.json', mongoId: 'aportes', wrap: 'aportes', localFile: 'aportes.json', grupo: 'frota', chave: 'id', label: 'Aportes' },
  { mod: 'emprestimos', file: 'emprestimos.json', mongoId: 'emprestimos', wrap: 'emprestimos', localFile: 'emprestimos.json', grupo: 'frota', chave: 'id', label: 'Empréstimos' },
  { mod: 'percentuais', file: 'percentuais.json', mongoId: 'percentuais', wrap: 'percentuais', localFile: 'percentuais.json', grupo: 'frota', chave: 'id', label: 'Percentuais' },
  { mod: 'retiradas', file: 'retiradas.json', mongoId: 'retiradas', wrap: 'retiradas', localFile: 'retiradas.json', grupo: 'frota', chave: 'id', label: 'Retiradas' },
  { mod: 'funcionarios', file: 'funcionarios.json', mongoId: 'funcionarios', wrap: 'funcionarios', localFile: 'funcionarios.json', grupo: 'funcionarios', chave: 'id', label: 'Funcionários' },
  { mod: 'funcobrigatorios', file: 'funcobrigatorios.json', mongoId: 'funcobrigatorios', objeto: true, localFile: 'func_obrigatorios.json', grupo: 'funcionarios', label: 'Matriz de obrigatórios' },
  { mod: 'programas', file: 'programas.json', mongoId: 'programas', wrap: 'programas', localFile: 'programas.json', grupo: 'funcionarios', chave: 'id', label: 'Programas SST' },
  { mod: 'acoesSst', file: 'acoes_sst.json', mongoId: 'acoesSst', wrap: 'acoes', localFile: 'acoes_sst.json', grupo: 'funcionarios', chave: 'id', label: 'Ações de Segurança (SST)' },
  { mod: 'locacoesFaturas', file: 'locacoes_faturas.json', mongoId: 'locacoesFaturas', wrap: 'faturas', localFile: 'locacoes_faturas.json', grupo: 'frota', chave: 'id', label: 'Locações; histórico de faturas emitidas' },
  { mod: 'feedbacks', file: 'feedbacks.json', mongoId: 'feedbacks', wrap: 'feedbacks', localFile: 'feedbacks.json', grupo: 'logs', chave: 'id', label: 'Feedbacks' },
  { mod: 'usuarios', file: 'usuarios.json', mongoId: 'usuarios', objeto: true, localFile: 'usuarios.json', grupo: 'usuarios', label: 'Usuários (sem credenciais)', semCredenciais: true },
  { mod: 'loginlogs', file: 'loginlogs.json', mongoId: 'loginlogs', wrap: 'logs', localArray: true, localFile: 'login_logs.json', grupo: 'logs', label: 'Logs de acesso', naoRestauravel: true },
  { mod: 'seglogs', file: 'seglogs.json', mongoId: 'seglogs', wrap: 'logs', localArray: true, localFile: 'seguranca_logs.json', grupo: 'logs', label: 'Auditoria de segurança', naoRestauravel: true },
  { mod: 'historico', file: 'historico.json', mongoId: 'historico', wrap: 'historico', localFile: 'historico.json', grupo: 'logs', chave: 'id', label: 'Histórico' },
];
const PASTA_ANEXO = {
  funcionarios_foto: 'files/funcionarios/fotos',
  funcionarios_doc: 'files/funcionarios/documentos',
  instalacoes: 'files/instalacoes', envios: 'files/envios', programas: 'files/programas', oficina: 'files/oficina',
  vistorias: 'files/vistorias', locacoes: 'files/locacoes', locacoesFaturas: 'files/locacoes/faturas', acoesSst: 'files/acoes-sst',
};

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const extDoTipo = (t) => ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif', 'application/pdf': '.pdf' }[t] || '');
const sanitize = (s) => String(s || 'arquivo').replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
function carimbo() {
  const p = new Date().toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' });
  return p.replace(' ', '-').replace(/:/g, '-');
}

// ---------- Acesso aos dados (abstrai LOCAL vs MONGO) ----------
async function abrirMongo() {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  return { client, col: client.db('frota').collection('app') };
}
function lerLocal(m) {
  let obj;
  try { obj = JSON.parse(fs.readFileSync(path.join(DATA_DIR, m.localFile), 'utf8')); }
  catch (e) { return m.objeto ? {} : []; }
  if (m.objeto) return obj || {};
  if (m.localArray) return Array.isArray(obj) ? obj : [];
  return (obj && obj[m.wrap]) || [];
}
async function lerMongoMod(col, m) {
  const doc = await col.findOne({ _id: m.mongoId });
  if (!doc) return m.objeto ? {} : [];
  if (m.objeto) { const { _id, ...rest } = doc; return rest; }
  return doc[m.wrap] || [];
}
function semCredenciais(store) {
  return { cadastrosAbertos: store.cadastrosAbertos !== false, usuarios: (store.usuarios || []).map(({ senhaHash, salt, ...r }) => r) };
}
async function lerModulo(m, ctx) {
  let val = ctx.col ? await lerMongoMod(m, ctx.col) : lerLocal(m);
  if (m.semCredenciais) val = semCredenciais(val || {});
  return val;
}
function contar(val) {
  if (Array.isArray(val)) return val.length;
  if (val && typeof val === 'object') { let n = 0; for (const v of Object.values(val)) n += Array.isArray(v) ? v.length : 1; return n; }
  return val == null ? 0 : 1;
}
// Anexos referenciados pelos módulos já lidos → mapa id→pasta no ZIP.
function mapaAnexos(dados) {
  const map = {};
  const add = (id, pasta) => { if (id) map[id] = pasta; };
  for (const f of (dados.funcionarios || [])) {
    if (f.foto && f.foto.id) add(f.foto.id, PASTA_ANEXO.funcionarios_foto);
    if (f.ppp && f.ppp.id) add(f.ppp.id, PASTA_ANEXO.funcionarios_doc);
    if (f.fichaEpi && f.fichaEpi.id) add(f.fichaEpi.id, PASTA_ANEXO.funcionarios_doc);
    for (const d of (f.documentos || [])) { if (d && d.id) add(d.id, PASTA_ANEXO.funcionarios_doc); for (const v of ((d && d.versoes) || [])) if (v && v.id) add(v.id, PASTA_ANEXO.funcionarios_doc); }
  }
  for (const i of [...(dados.instalacoes || []), ...(dados.rastreadoresVinculos || [])]) for (const ft of (i.fotos || [])) if (ft && ft.id) add(ft.id, PASTA_ANEXO.instalacoes);
  for (const e of (dados.envios || [])) for (const c of (e.comprovantes || [])) if (c && c.id) add(c.id, PASTA_ANEXO.envios);
  for (const p of (dados.programas || [])) if (p && p.documento && p.documento.id) add(p.documento.id, PASTA_ANEXO.programas);
  // Ações de Segurança: evidências (e versões anteriores) de cada ação.
  for (const a of (dados.acoesSst || [])) for (const d of (a.evidencias || [])) { if (d && d.id) add(d.id, PASTA_ANEXO.acoesSst); for (const v of ((d && d.versoes) || [])) if (v && v.id) add(v.id, PASTA_ANEXO.acoesSst); }
  for (const o of (dados.oficina || [])) if (o && o.anexo && o.anexo.id) add(o.anexo.id, PASTA_ANEXO.oficina);
  for (const v of (dados.vistorias || [])) for (const ft of (v.fotos || [])) if (ft && ft.id) add(ft.id, PASTA_ANEXO.vistorias);
  // Locações: documentos dos contratos — ficam em locacoesConfig.contratos[].documentos (não na
  // lista de locações). Sem isto o .zip levava o cadastro do contrato mas não os arquivos dele.
  for (const c of ((dados.locacoesConfig && dados.locacoesConfig.contratos) || [])) {
    for (const d of ((c && c.documentos) || [])) if (d && d.id) add(d.id, PASTA_ANEXO.locacoes);
  }
  // Locações: o PDF de cada fatura emitida (histórico da sub-aba Faturas).
  for (const f of (dados.locacoesFaturas || [])) if (f && f.arquivo && f.arquivo.id) add(f.arquivo.id, PASTA_ANEXO.locacoesFaturas);
  return map;
}
// Com o R2 configurado (MIDIA_S3_*, as MESMAS envs do servidor — docs/ARQUIVOS_R2.md) os
// anexos vêm do bucket, e o armazenamento antigo é a reserva do que ainda não foi copiado,
// igual ao lerMidia() do server.js. A restauração grava no bucket.
// USO: $env:MIDIA_S3_BUCKET='gestaorm-arquivos'; …; node scripts/backup.js --out ./backups
// Só no modo Mongo: no local (sem MONGODB_URI) as MIDIA_S3_* do terminal apontariam os anexos da
// base de teste para o bucket de PRODUÇÃO (a mesma regra do server, ver lerConfigCofre).
const COFRE = CofreMidia.criarCofre(CofreMidia.lerConfigCofre(process.env, { usarMongo: USE_MONGO })); // driver | null
// Depois que o bucket passou a ter anexos que só existem nele (marcador `cofre_r2`, gravado pelo
// site), rodar SEM as MIDIA_S3_* daria um backup sem esses anexos e sem erro nenhum, e um restore
// que enche o Mongo de novo. Para antes, dizendo o que falta.
async function exigirCofreSeHaArquivosNoR2(ctx) {
  if (!ctx.col) return;
  const b = CofreMidia.bucketComArquivos(await ctx.col.findOne({ _id: 'cofre_r2' }));
  if (b && (!COFRE || COFRE.bucket !== b)) {
    throw new Error(`Há anexos que só existem no bucket R2 "${b}". Defina no terminal MIDIA_S3_BUCKET, MIDIA_S3_KEY_ID, MIDIA_S3_KEY_SECRET e MIDIA_S3_ENDPOINT (as mesmas do Render) e rode de novo (docs/ARQUIVOS_R2.md).`);
  }
}
async function coletarAnexos(ctx, ids) {
  const out = [];
  const pendentes = new Set(ids);
  if (COFRE) {
    for (const id of ids) {
      const chave = CofreMidia.chaveMidia(id);
      const m = chave ? await COFRE.ler(chave) : null;
      if (m) { out.push({ id, tipo: m.tipo, nome: m.nome, b64: m.buf.toString('base64') }); pendentes.delete(id); }
    }
  }
  if (ctx.col) {
    // Um doc por vez: o find().toArray() de todos os `midia_` trazia o acervo inteiro (GBs) para a memória.
    for (const id of pendentes) {
      const d = await ctx.col.findOne({ _id: 'midia_' + id });
      if (d && d.b64) out.push({ id, tipo: d.tipo, nome: d.nome, b64: d.b64 });
    }
  } else if (fs.existsSync(UPLOADS_DIR)) {
    for (const f of fs.readdirSync(UPLOADS_DIR)) {
      const id = f.replace(/\.json$/, ''); if (!pendentes.has(id)) continue;
      try { const m = JSON.parse(fs.readFileSync(path.join(UPLOADS_DIR, f), 'utf8')); if (m && m.b64) out.push({ id, tipo: m.tipo, nome: m.nome, b64: m.b64 }); } catch (e) { /* pula */ }
    }
  }
  return out;
}

// ---------- GERAR ----------
async function gerarBackup(opts) {
  opts = opts || {};
  const grupos = (opts.grupos && opts.grupos.length) ? opts.grupos : ['completo'];
  const incluirAnexos = opts.incluirAnexos !== false;
  const selec = grupos.includes('completo') ? MODULOS : MODULOS.filter((m) => grupos.includes(m.grupo));
  const ctx = USE_MONGO ? await abrirMongo() : {};
  try {
    if (incluirAnexos) await exigirCofreSeHaArquivosNoR2(ctx);
    const dados = {};
    for (const m of MODULOS) dados[m.mod] = await lerModulo(m, ctx); // lê tudo (anexos precisam das referências)
    const entradas = [];
    const modulosMan = [];
    for (const m of selec) {
      const buf = Buffer.from(JSON.stringify(dados[m.mod] ?? null, null, 2), 'utf8');
      const p = 'data/' + m.file;
      entradas.push({ path: p, buffer: buf });
      modulosMan.push({ modulo: m.mod, grupo: m.grupo, label: m.label, arquivo: p, registros: contar(dados[m.mod]), bytes: buf.length, sha256: sha256(buf) });
    }
    const anexosMan = [];
    if (incluirAnexos) {
      const mapa = mapaAnexos(dados);
      const gruposAtivos = new Set(selec.map((m) => m.grupo));
      const idsAlvo = new Set(Object.keys(mapa).filter((id) => {
        const pasta = mapa[id];
        const g = pasta.startsWith('files/funcionarios') || pasta === 'files/programas' || pasta === 'files/acoes-sst' ? 'funcionarios' : 'rastreadores';
        return gruposAtivos.has(g);
      }));
      const anexos = await coletarAnexos(ctx, idsAlvo);
      for (const a of anexos) {
        const pasta = mapa[a.id] || 'files/outros';
        const ext = extDoTipo(a.tipo); let nome = sanitize(a.id + '-' + (a.nome || 'arquivo'));
        if (ext && !nome.toLowerCase().endsWith(ext)) nome += ext;
        const buf = Buffer.from(a.b64, 'base64'); const p = pasta + '/' + nome;
        entradas.push({ path: p, buffer: buf });
        anexosMan.push({ id: a.id, arquivo: p, tipo: a.tipo, nomeOriginal: a.nome || '', bytes: buf.length, sha256: sha256(buf) });
      }
    }
    const totalRegistros = modulosMan.reduce((s, m) => s + m.registros, 0);
    let versao = '0.0.0'; try { versao = require(path.join(RAIZ, 'package.json')).version; } catch (e) {}
    const manifest = {
      sistema: 'Frota NTE / Gestão RM', versao, build: 'cli', geradoEm: new Date().toISOString(),
      geradoPor: opts.usuario || (process.env.USER || 'cli'), origem: 'cli', ambiente: USE_MONGO ? 'mongo' : 'local-json',
      grupos, contemAnexos: anexosMan.length > 0, modulos: modulosMan, anexos: anexosMan,
      totalRegistros, totalArquivos: entradas.length + 2, observacoes: opts.observacoes || '',
    };
    entradas.push({ path: 'reports/resumo.txt', buffer: Buffer.from(resumoTxt(manifest), 'utf8') });
    entradas.unshift({ path: 'manifest.json', buffer: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') });
    return { entradas, manifest };
  } finally { if (ctx.client) await ctx.client.close(); }
}
function resumoTxt(m) {
  const L = ['RESUMO DO BACKUP — Frota NTE / Gestão RM', '='.repeat(50)];
  L.push('Gerado em : ' + m.geradoEm, 'Por       : ' + m.geradoPor, 'Origem    : ' + m.origem, 'Ambiente  : ' + m.ambiente, 'Versão    : ' + m.versao, 'Grupos    : ' + m.grupos.join(', '), 'Anexos    : ' + (m.contemAnexos ? m.anexos.length + ' arquivo(s)' : 'não'), '', 'MÓDULOS:');
  for (const x of m.modulos) L.push('  - ' + String(x.label).padEnd(34) + String(x.registros).padStart(6) + ' registro(s)');
  L.push('', 'Total de registros: ' + m.totalRegistros, 'Cada arquivo tem hash SHA-256 no manifest.json.');
  return L.join('\n');
}
function escreverZip(entradas, destino) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destino);
    const archive = archiver('zip', { zlib: { level: 9 } });
    out.on('close', () => resolve(archive.pointer()));
    archive.on('error', reject);
    archive.pipe(out);
    for (const e of entradas) archive.append(e.buffer, { name: e.path });
    archive.finalize();
  });
}

// ---------- LER/VALIDAR ZIP ----------
function nomePermitido(n) {
  if (n.includes('..') || n.startsWith('/') || n.includes('\\') || /[\x00-\x1f]/.test(n)) return false;
  return /^manifest\.json$/.test(n) || /^reports\/[\w.-]+$/.test(n) || /^data\/[\w.-]+\.json$/.test(n) || /^files\/[\w./-]+$/.test(n);
}
function lerZip(arquivoZip) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(fs.readFileSync(arquivoZip), { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(new Error('Arquivo .zip inválido ou corrompido.'));
      const arquivos = new Map(); let total = 0, count = 0, fim = false;
      const falhar = (msg) => { if (!fim) { fim = true; reject(new Error(msg)); } };
      zip.on('entry', (entry) => {
        const nome = entry.fileName;
        if (/\/$/.test(nome)) return zip.readEntry();
        if (++count > 5000) return falhar('ZIP com arquivos demais.');
        if (!nomePermitido(nome)) return falhar('Caminho não permitido no ZIP: ' + nome);
        total += entry.uncompressedSize; if (total > 300 * 1024 * 1024) return falhar('ZIP excede o limite total.');
        zip.openReadStream(entry, (e, st) => {
          if (e) return falhar('Falha ao extrair ' + nome);
          const ch = []; st.on('data', (c) => ch.push(c)); st.on('error', () => falhar('Falha ao ler ' + nome));
          st.on('end', () => { arquivos.set(nome, Buffer.concat(ch)); zip.readEntry(); });
        });
      });
      zip.on('end', () => { if (fim) return; fim = true;
        const mb = arquivos.get('manifest.json'); if (!mb) return reject(new Error('Backup sem manifest.json.'));
        let manifest; try { manifest = JSON.parse(mb.toString('utf8')); } catch (e) { return reject(new Error('manifest.json inválido.')); }
        resolve({ arquivos, manifest });
      });
      zip.readEntry();
    });
  });
}
function conferirHashes(arquivos, manifest) {
  const probs = [];
  for (const it of [...(manifest.modulos || []), ...(manifest.anexos || [])]) {
    const b = arquivos.get(it.arquivo);
    if (!b) { probs.push(it.arquivo + ' (ausente)'); continue; }
    if (it.sha256 && sha256(b) !== it.sha256) probs.push(it.arquivo + ' (hash divergente)');
  }
  // Espelha o servidor: o hash só prova que o que está ali não foi adulterado, não que está
  // tudo ali. Backup marcado como incompleto na origem tem de ser acusado aqui também.
  if (manifest && manifest.completo === false) {
    const n = (manifest.falhas || []).length || Math.max(0, (manifest.esperados || []).length - (manifest.anexos || []).length);
    probs.push(`manifest.json (backup INCOMPLETO na origem: ${n} anexo(s) não entraram)`);
  }
  return probs;
}

// ---------- RESTAURAR ----------
function chaveDe(item, m) { if (!item || typeof item !== 'object') return undefined; const k = item[m.chave]; return (k != null && k !== '') ? String(k) : undefined; }
function mesclarArray(atual, novo, m, modo) {
  if (modo === 'substituir') return novo.slice();
  const res = atual.slice(); const idx = new Map();
  res.forEach((it, i) => { const k = chaveDe(it, m); if (k != null) idx.set(k, i); });
  for (const it of novo) { const k = chaveDe(it, m); if (k != null && idx.has(k)) res[idx.get(k)] = it; else res.push(it); }
  return res;
}
async function gravarModulo(m, valor, ctx) {
  if (ctx.col) {
    const doc = m.objeto ? Object.assign({ _id: m.mongoId }, valor) : { _id: m.mongoId, [m.wrap]: valor };
    await ctx.col.replaceOne({ _id: m.mongoId }, doc, { upsert: true });
  } else {
    const dest = path.join(DATA_DIR, m.localFile);
    let conteudo;
    if (m.objeto) conteudo = valor;
    else if (m.localArray) conteudo = valor;
    else if (m.mod === 'veiculos') { let base = {}; try { base = JSON.parse(fs.readFileSync(dest, 'utf8')); } catch (e) {} conteudo = Object.assign(base, { veiculos: valor }); }
    else conteudo = { [m.wrap]: valor };
    fs.writeFileSync(dest, JSON.stringify(conteudo, null, 2));
  }
}
async function restaurarAnexos(arquivos, manifest, ctx) {
  let ok = 0, pend = 0;
  for (const a of (manifest.anexos || [])) {
    const b = arquivos.get(a.arquivo); if (!b) { pend++; continue; }
    const obj = { tipo: a.tipo || 'application/octet-stream', nome: a.nomeOriginal || a.id, b64: b.toString('base64'), ts: Date.now() };
    const chave = COFRE ? CofreMidia.chaveMidia(a.id) : '';
    if (chave) await COFRE.gravar(chave, { buf: b, tipo: obj.tipo, nome: obj.nome, ts: obj.ts });
    else if (ctx.col) await ctx.col.replaceOne({ _id: 'midia_' + a.id }, Object.assign({ _id: 'midia_' + a.id }, obj), { upsert: true });
    else { if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true }); fs.writeFileSync(path.join(UPLOADS_DIR, a.id + '.json'), JSON.stringify(obj)); }
    ok++;
  }
  return { restaurados: ok, pendentes: pend };
}
async function restaurarBackup(opts) {
  const { arquivos, manifest } = await lerZip(opts.arquivoZip);
  const probs = conferirHashes(arquivos, manifest);
  if (probs.length) { const e = new Error('Integridade falhou: ' + probs.join('; ')); e.codigo = 'INTEGRIDADE'; throw e; }
  const modo = opts.modo === 'substituir' ? 'substituir' : 'mesclar';
  const aplicar = !!opts.aplicar;
  const gruposSet = (!opts.grupos || !opts.grupos.length || opts.grupos.includes('completo')) ? null : new Set(opts.grupos);
  const porMod = {}; MODULOS.forEach((m) => { porMod[m.mod] = m; });
  const ctx = (USE_MONGO && aplicar) ? await abrirMongo() : (USE_MONGO ? await abrirMongo() : {});
  const rel = { modo, aplicar, ambiente: USE_MONGO ? 'mongo' : 'local-json', modulos: [], ignorados: [], anexos: null };
  try {
    if (aplicar && (manifest.anexos || []).length) await exigirCofreSeHaArquivosNoR2(ctx);
    for (const item of (manifest.modulos || [])) {
      const m = porMod[item.modulo];
      if (!m || m.naoRestauravel) { rel.ignorados.push(item.modulo + (m ? ' (auditoria)' : ' (desconhecido)')); continue; }
      if (gruposSet && !gruposSet.has(m.grupo) && !gruposSet.has(m.mod)) { rel.ignorados.push(item.modulo + ' (fora da seleção)'); continue; }
      const buf = arquivos.get(item.arquivo); if (!buf) { rel.ignorados.push(item.modulo + ' (ausente no zip)'); continue; }
      const novo = JSON.parse(buf.toString('utf8'));
      const atual = await lerModulo(m, ctx);
      if (m.objeto) {
        rel.modulos.push({ modulo: m.mod, tipo: 'objeto', itensBackup: contar(novo) });
        if (aplicar) {
          if (m.mod === 'usuarios') { // preserva credenciais existentes por id
            const cred = new Map((atual.usuarios || []).map((u) => [String(u.id), { senhaHash: u.senhaHash, salt: u.salt }]));
            const usuarios = (novo.usuarios || []).map((u) => { const c = cred.get(String(u.id)); return (c && (c.senhaHash || c.salt)) ? Object.assign({}, u, c) : u; });
            await gravarModulo(m, { usuarios, cadastrosAbertos: novo.cadastrosAbertos !== false }, ctx);
          } else await gravarModulo(m, novo, ctx);
        }
      } else {
        const a = Array.isArray(atual) ? atual : []; const n = Array.isArray(novo) ? novo : [];
        const mapaA = new Map(a.map((x) => [chaveDe(x, m), x]));
        let criados = 0, atualizados = 0, iguais = 0;
        for (const it of n) { const k = chaveDe(it, m); if (!mapaA.has(k)) criados++; else if (JSON.stringify(mapaA.get(k)) !== JSON.stringify(it)) atualizados++; else iguais++; }
        rel.modulos.push({ modulo: m.mod, tipo: 'array', criados, atualizados, iguais, totalBackup: n.length });
        if (aplicar) await gravarModulo(m, mesclarArray(a, n, m, modo), ctx);
      }
    }
    if (manifest.contemAnexos) {
      if (aplicar) rel.anexos = await restaurarAnexos(arquivos, manifest, ctx);
      else rel.anexos = { aRestaurar: (manifest.anexos || []).filter((a) => arquivos.has(a.arquivo)).length };
    }
    return rel;
  } finally { if (ctx.client) await ctx.client.close(); }
}

module.exports = { MODULOS, DATA_DIR, USE_MONGO, carimbo, gerarBackup, escreverZip, lerZip, conferirHashes, restaurarBackup };
