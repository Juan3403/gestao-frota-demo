// ============================================================================
// videos-treino.js · armazenamento dos VÍDEOS de treinamento (Integração › Treinamentos)
//
// O vídeo enviado pelo RH vai para um bucket S3-compatível (Cloudflare R2 em produção) e
// NUNCA para o disco do Render (efêmero, 512 MB). Em dev/testes, sem as envs do bucket,
// um driver "local" grava em DATA_DIR/videos com a MESMA interface.
//
// O upload é em partes fixas de 6 MiB e passa pelo servidor SEM estado: o cliente devolve
// {chave, uploadId} a cada parte e o concluir pergunta ao armazenamento (ListParts) o que
// chegou. O Render dormir no meio do envio não perde nada.
//
// Sem SDK da AWS: a assinatura SigV4 é feita aqui com o `crypto` embutido (a do
// scripts/backup-nuvem.mjs é ESM com top-level await e não trata query string).
//
// Interface dos drivers (todas async), igual em 's3' e 'local':
//   iniciar, enviarParte, listarPartes, concluir, abortar, cabeca, urlLeitura,
//   caminhoLocal (só local), listarObjetos, apagar, listarUploadsPendentes, testar.
// Erros lançados levam `e.status` (400 entrada inválida, 404 upload inexistente,
// 502 falha do armazenamento) e, quando o armazenamento informa, `e.codigo` (Code do S3).
// ============================================================================
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');

// Chave do objeto: pasta fixa + ano + 32 hex + extensão. Tudo que vem do cliente passa por
// aqui antes de virar caminho de disco ou URL (anti path traversal).
const RE_CHAVE = /^videos-treino\/\d{4}\/[a-f0-9]{32}\.(mp4|webm)$/;
const PREFIXO = 'videos-treino/';
const MIMES = ['video/mp4', 'video/webm'];
const EXT_DO_MIME = { 'video/mp4': 'mp4', 'video/webm': 'webm' };
// 6 MiB: acima do mínimo de 5 MiB do S3 por parte e pequeno o bastante para uma parte subir
// bem antes do timeout de 300 s do Node mesmo numa conexão ruim. O R2 exige partes iguais
// (exceto a última), por isso o tamanho é fixo e conferido.
const PARTE_BYTES = 6 * 1024 * 1024;
const MAX_PARTES = 10000; // limite do protocolo S3
const DURACAO_MAX_SEG = 4 * 60 * 60;
const HASH_VAZIO = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const ENVS_S3 = ['VIDEO_S3_ENDPOINT', 'VIDEO_S3_REGION', 'VIDEO_S3_BUCKET', 'VIDEO_S3_KEY_ID', 'VIDEO_S3_KEY_SECRET'];
const MOTIVO_SEM_CONFIG = 'Armazenamento de vídeos não configurado (ver docs/VIDEOS_TREINAMENTO.md).';

function erro(msg, status, codigo) {
  const e = new Error(msg);
  e.status = status;
  if (codigo) e.codigo = codigo;
  return e;
}

const sha256hex = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (chave, dado) => crypto.createHmac('sha256', chave).update(dado).digest();

// ----------------------------------------------------------------------------
// Assinatura AWS Signature Version 4
// ----------------------------------------------------------------------------

// Codificação da RFC 3986 exigida pelo SigV4: além do encodeURIComponent, codifica !'()*.
// USO: uriEncode("a b!'()*/") // => 'a%20b%21%27%28%29%2A%2F'
function uriEncode(s) {
  return encodeURIComponent(String(s == null ? '' : s))
    .replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

// Carimbo SigV4 (UTC, sem separadores). Aceita Date, milissegundos ou o próprio carimbo.
// USO: carimboAmz(Date.UTC(2026, 8, 23, 12, 0, 0)) // => '20260923T120000Z'
function carimboAmz(agora) {
  if (typeof agora === 'string' && /^\d{8}T\d{6}Z$/.test(agora)) return agora;
  const d = agora instanceof Date ? agora : new Date(agora == null ? Date.now() : agora);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

// Caminho canônico: cada segmento codificado à parte, as barras continuam barras. Recebe o
// caminho CRU (não codificado).
// USO: caminhoCanonico('/meu-bucket/test$file.text') // => '/meu-bucket/test%24file.text'
function caminhoCanonico(caminho) {
  const c = String(caminho || '/');
  return (c.startsWith('/') ? c : '/' + c).split('/').map(uriEncode).join('/');
}

// Query canônica: nomes e valores codificados, ordenados pelo nome codificado (e pelo valor,
// em empate). Parâmetro "flag" (ex.: ?uploads) entra como 'uploads='. Aceita objeto ou lista
// de pares.
// USO: queryCanonica({ uploadId: 'X', partNumber: 2 }) // => 'partNumber=2&uploadId=X'
//      queryCanonica({ uploads: '' })                  // => 'uploads='
function queryCanonica(query) {
  const pares = Array.isArray(query) ? query : Object.entries(query || {});
  return pares
    .map(([k, v]) => [uriEncode(k), uriEncode(v == null ? '' : v)])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
}

// Todos os passos do SigV4, expostos para o teste conferir a requisição canônica e a
// string-to-sign separadamente. assinarRequisicao() é o que o resto do código usa.
// USO: calcularAssinatura({ metodo:'GET', host:'h', caminho:'/b/k', query:{}, cabecalhos:{},
//        hashCorpo:HASH_VAZIO, agora:'20260923T120000Z', region:'auto', keyId:'K', keySecret:'S' })
//   // => { requisicaoCanonica, paraAssinar, assinatura, escopo, assinados, cabecalhos, data }
function calcularAssinatura({ metodo, host, caminho, query, cabecalhos, hashCorpo, agora, region, keyId, keySecret, servico = 's3' }) {
  const data = carimboAmz(agora);
  const dia = data.slice(0, 8);
  const hash = hashCorpo || HASH_VAZIO;
  const cab = {};
  for (const [k, v] of Object.entries(cabecalhos || {})) {
    const nome = String(k).toLowerCase().trim();
    if (!nome || nome === 'authorization' || v == null || v === '') continue;
    cab[nome] = String(v).trim().replace(/\s+/g, ' ');
  }
  cab.host = String(host);
  cab['x-amz-date'] = data;
  // Só o S3 exige o hash do corpo em cabeçalho; os outros serviços (e os vetores genéricos
  // da AWS) assinam sem ele.
  if (servico === 's3') cab['x-amz-content-sha256'] = hash;
  const nomes = Object.keys(cab).sort();
  const assinados = nomes.join(';');
  const requisicaoCanonica = [
    String(metodo).toUpperCase(),
    caminhoCanonico(caminho),
    queryCanonica(query),
    nomes.map((h) => `${h}:${cab[h]}\n`).join(''),
    assinados,
    hash,
  ].join('\n');
  const escopo = `${dia}/${region}/${servico}/aws4_request`;
  const paraAssinar = ['AWS4-HMAC-SHA256', data, escopo, sha256hex(requisicaoCanonica)].join('\n');
  const chave = hmac(hmac(hmac(hmac('AWS4' + keySecret, dia), region), servico), 'aws4_request');
  const assinatura = crypto.createHmac('sha256', chave).update(paraAssinar).digest('hex');
  cab.Authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${escopo}, SignedHeaders=${assinados}, Signature=${assinatura}`;
  return { requisicaoCanonica, paraAssinar, assinatura, escopo, assinados, cabecalhos: cab, data };
}

// Cabeçalhos assinados de uma requisição. Assina host, x-amz-date, x-amz-content-sha256 (S3)
// e todo cabeçalho recebido em `cabecalhos` (ex.: content-type). `caminho` vai CRU; o
// codificado é caminhoCanonico(caminho), e a URL enviada tem de usar esse mesmo caminho e a
// queryCanonica(query).
// USO: assinarRequisicao({ metodo:'POST', host:'conta.r2.cloudflarestorage.com',
//        caminho:'/treinos/videos-treino/2026/<32hex>.mp4', query:{ uploads:'' },
//        cabecalhos:{ 'content-type':'video/mp4' }, hashCorpo:HASH_VAZIO, region:'auto',
//        keyId:'…', keySecret:'…' })
//   // => { host, 'content-type', 'x-amz-date', 'x-amz-content-sha256', Authorization:'AWS4-HMAC-SHA256 Credential=…' }
function assinarRequisicao(p) {
  return calcularAssinatura(p).cabecalhos;
}

// URL pré-assinada de leitura (GET), path-style: <endpoint>/<bucket>/<chave>. Só o host é
// assinado e o corpo é UNSIGNED-PAYLOAD; a URL funciona direto no <video src>. Com
// bucket '' o endpoint já aponta para o bucket (estilo virtual-host).
// USO: presignarGet({ endpoint:'https://conta.r2.cloudflarestorage.com', region:'auto',
//        bucket:'treinos', chave:'videos-treino/2026/<32hex>.mp4', keyId:'…', keySecret:'…',
//        expiraSeg:21600 })
//   // => 'https://conta.r2.cloudflarestorage.com/treinos/videos-treino/2026/<32hex>.mp4?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=…&X-Amz-Date=…&X-Amz-Expires=21600&X-Amz-SignedHeaders=host&X-Amz-Signature=…'
function presignarGet({ endpoint, region, bucket, chave, keyId, keySecret, expiraSeg = 3600, agora }) {
  const base = new URL(String(endpoint));
  const data = carimboAmz(agora);
  const dia = data.slice(0, 8);
  const escopo = `${dia}/${region}/s3/aws4_request`;
  const caminho = caminhoCanonico((bucket ? `/${bucket}/` : '/') + chave);
  const expira = Math.min(604800, Math.max(1, Math.floor(Number(expiraSeg) || 3600)));
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${keyId}/${escopo}`,
    'X-Amz-Date': data,
    'X-Amz-Expires': String(expira),
    'X-Amz-SignedHeaders': 'host',
  };
  const qc = queryCanonica(query);
  const requisicaoCanonica = ['GET', caminho, qc, `host:${base.host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const paraAssinar = ['AWS4-HMAC-SHA256', data, escopo, sha256hex(requisicaoCanonica)].join('\n');
  const k = hmac(hmac(hmac(hmac('AWS4' + keySecret, dia), region), 's3'), 'aws4_request');
  const assinatura = crypto.createHmac('sha256', k).update(paraAssinar).digest('hex');
  return `${base.protocol}//${base.host}${caminho}?${qc}&X-Amz-Signature=${assinatura}`;
}

// ----------------------------------------------------------------------------
// Regras (puras)
// ----------------------------------------------------------------------------

// USO: validarChave('videos-treino/2026/0123456789abcdef0123456789abcdef.mp4') // => true
//      validarChave('videos-treino/2026/../../data/usuarios.json')           // => false
function validarChave(chave) {
  return typeof chave === 'string' && RE_CHAVE.test(chave);
}

// Chave nova e imprevisível para um envio. Aceita a extensão ou o mime.
// USO: novaChave('mp4')        // => 'videos-treino/2026/9f1c…(32 hex).mp4'
//      novaChave('video/webm') // => 'videos-treino/2026/….webm'
function novaChave(ext, agora = Date.now()) {
  const e = EXT_DO_MIME[String(ext || '').toLowerCase()] || String(ext || '').toLowerCase().replace(/^\./, '');
  if (e !== 'mp4' && e !== 'webm') throw erro('Formato de vídeo não aceito (use MP4 ou WebM).', 400);
  const ano = new Date(agora).getUTCFullYear();
  return `${PREFIXO}${ano}/${crypto.randomBytes(16).toString('hex')}.${e}`;
}

// Extensões de vídeo conhecidas que o navegador não toca de forma confiável.
const EXT_RECUSADAS = /^(mov|qt|avi|mkv|wmv|flv|3gp|mpg|mpeg|ts|m2ts|mts|hevc|ogv|vob)$/;
const MIME_DA_EXT = { mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm' };

// Mime aceito a partir do nome do arquivo e do tipo informado pelo navegador. QuickTime
// (.mov) e outros formatos são recusados (''); nome e tipo em conflito também.
// USO: mimeDe('aula.mp4', 'video/mp4')        // => 'video/mp4'
//      mimeDe('aula.webm', '')                // => 'video/webm'
//      mimeDe('aula.mov', 'video/quicktime')  // => ''
function mimeDe(nome, mimeInformado) {
  const ext = ((/\.([a-z0-9]+)$/i.exec(String(nome || '').trim()) || [])[1] || '').toLowerCase();
  if (EXT_RECUSADAS.test(ext)) return '';
  const pelaExt = MIME_DA_EXT[ext] || '';
  let inf = String(mimeInformado || '').toLowerCase().split(';')[0].trim();
  if (inf === 'video/x-m4v') inf = 'video/mp4';
  if (inf === 'video/quicktime') return '';
  const informado = MIMES.includes(inf) ? inf : '';
  if (informado && pelaExt && informado !== pelaExt) return '';
  return informado || pelaExt;
}

// Tipo real pelo começo do arquivo (a parte 1 do envio). MP4 tem 'ftyp' no offset 4 (a marca
// 'qt  ' é QuickTime e é recusada); WebM começa com o cabeçalho EBML 1A 45 DF A3 (Matroska
// declarado é recusado).
// USO: tipoPorBytesMagicos(Buffer.from('000000186674797069736f6d', 'hex')) // => 'video/mp4'
//      tipoPorBytesMagicos(Buffer.from('<!doctype html>'))                 // => ''
function tipoPorBytesMagicos(buf) {
  if (!buf || buf.length < 8) return '';
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (b.toString('latin1', 4, 8) === 'ftyp') {
    return b.length >= 12 && b.toString('latin1', 8, 12) === 'qt  ' ? '' : 'video/mp4';
  }
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) {
    return b.subarray(0, 64).toString('latin1').includes('matroska') ? '' : 'video/webm';
  }
  return '';
}

// Plano de partes de um arquivo: todas com parteBytes, menos a última.
// USO: const p = planoPartes(13 * 1024 * 1024)  // parteBytes padrão 6 MiB
//      p.totalPartes // => 3   ·  p.tamanhoDe(1) // => 6291456  ·  p.tamanhoDe(3) // => 1048576
//      p.tamanhoDe(4) // => 0 (fora do plano)
function planoPartes(bytes, parteBytes = PARTE_BYTES) {
  const total = Math.max(0, Math.floor(Number(bytes) || 0));
  const tam = Math.max(1, Math.floor(Number(parteBytes) || PARTE_BYTES));
  const totalPartes = total ? Math.ceil(total / tam) : 0;
  const tamanhoDe = (n) => {
    if (!Number.isInteger(n) || n < 1 || n > totalPartes) return 0;
    return n < totalPartes ? tam : total - (totalPartes - 1) * tam;
  };
  return { bytes: total, parteBytes: tam, totalPartes, tamanhoDe };
}

// Confere o que chegou ao armazenamento contra o plano, antes de concluir o envio.
// USO: conferirPartes([{n:1,bytes:6291456},{n:2,bytes:100}], 6291556)  // => { ok:true, erro:'' }
//      conferirPartes([{n:1,bytes:6291456}], 6291556)                  // => { ok:false, erro:'Faltam partes do vídeo: chegaram 1 de 2.' }
//      conferirPartes(lista, bytes, PARTE_BYTES, 1024 * 1024 * 1024)   // 4º parâmetro opcional: tamanho máximo
function conferirPartes(listaPartes, bytesDeclarados, parteBytes = PARTE_BYTES, maxBytes = Infinity) {
  const falha = (m) => ({ ok: false, erro: m });
  const bytes = Number(bytesDeclarados);
  if (!Number.isInteger(bytes) || bytes <= 0) return falha('Tamanho do vídeo inválido.');
  if (bytes > maxBytes) return falha(`O vídeo passa do tamanho máximo (${Math.round(maxBytes / 1048576)} MB).`);
  const plano = planoPartes(bytes, parteBytes);
  if (plano.totalPartes > MAX_PARTES) return falha('O vídeo tem partes demais para o armazenamento.');
  const partes = (Array.isArray(listaPartes) ? listaPartes : []).slice().sort((a, b) => a.n - b.n);
  if (partes.length !== plano.totalPartes) return falha(`Faltam partes do vídeo: chegaram ${partes.length} de ${plano.totalPartes}.`);
  let soma = 0;
  for (let i = 0; i < partes.length; i++) {
    const p = partes[i];
    if (p.n !== i + 1) return falha(`A parte ${i + 1} do vídeo não chegou.`);
    if (p.bytes !== plano.tamanhoDe(p.n)) return falha(`A parte ${p.n} do vídeo chegou com ${p.bytes} bytes; eram esperados ${plano.tamanhoDe(p.n)}.`);
    soma += p.bytes;
  }
  if (soma !== bytes) return falha(`O vídeo chegou com ${soma} bytes; eram esperados ${bytes}.`);
  return { ok: true, erro: '' };
}

// Duração em segundos inteiros, de 1 s a 4 h. Fora disso ou não numérica => 0 (inválida).
// USO: lerDuracaoSeg('612.4') // => 612  ·  lerDuracaoSeg(0) // => 0  ·  lerDuracaoSeg(20000) // => 0
function lerDuracaoSeg(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const s = Math.max(1, Math.round(n));
  return s > DURACAO_MAX_SEG ? 0 : s;
}

// Campo `video` do treinamento. Chave inválida ou duração inválida => null (sem vídeo). O
// mime segue a extensão da chave, não o que veio no objeto.
// USO: normalizarVideoTreino({ chave:'videos-treino/2026/<32hex>.mp4', nome:'NR-35.mp4',
//        bytes:52428800, duracaoSeg:612, enviadoTs:1790000000000, enviadoPor:'Ana' })
//   // => { chave, nome:'NR-35.mp4', bytes:52428800, mime:'video/mp4', duracaoSeg:612, enviadoTs:1790000000000, enviadoPor:'Ana' }
//      normalizarVideoTreino({ chave:'../x.mp4' }) // => null
function normalizarVideoTreino(v) {
  if (!v || typeof v !== 'object' || !validarChave(v.chave)) return null;
  const duracaoSeg = lerDuracaoSeg(v.duracaoSeg);
  if (!duracaoSeg) return null;
  const inteiro = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.floor(Number(x)) : 0);
  return {
    chave: v.chave,
    nome: String(v.nome == null ? '' : v.nome).trim().slice(0, 200),
    bytes: inteiro(v.bytes),
    mime: v.chave.endsWith('.webm') ? 'video/webm' : 'video/mp4',
    duracaoSeg,
    enviadoTs: inteiro(v.enviadoTs),
    enviadoPor: String(v.enviadoPor == null ? '' : v.enviadoPor).trim().slice(0, 60),
  };
}

// Referência curta e estável da chave para a página pública (a chave nunca sai do servidor).
// USO: refDaChave('videos-treino/2026/<32hex>.mp4') // => '3fa1b2c4d5e6' (12 hex do SHA-256)
function refDaChave(chave) {
  return sha256hex(String(chave || '')).slice(0, 12);
}

// ----------------------------------------------------------------------------
// Configuração
// ----------------------------------------------------------------------------

function inteiroEnv(v, padrao, min, max) {
  const n = Math.floor(Number(String(v == null ? '' : v).trim()));
  if (!String(v == null ? '' : v).trim() || !Number.isFinite(n) || n <= 0) return padrao;
  return Math.min(max, Math.max(min, n));
}

// Lê as envs e decide o driver. Nunca lança: config incompleta desliga o vídeo com o motivo.
//   VIDEO_S3_ENDPOINT (ex.: https://<conta>.r2.cloudflarestorage.com), VIDEO_S3_REGION (R2: auto),
//   VIDEO_S3_BUCKET, VIDEO_S3_KEY_ID, VIDEO_S3_KEY_SECRET  → todas: 's3'
//   nenhuma e sem Mongo (dev)                            → 'local' em <dataDir>/videos
//   nenhuma em produção (Mongo)                          → null (envio recusado com o motivo)
//   VIDEO_MAX_MB (1024), VIDEO_URL_TTL_MIN (360), VIDEO_ORFAO_DIAS (90)
// USO: lerConfigVideo(process.env, { usarMongo: !!process.env.MONGODB_URI, dataDir: DATA_DIR })
//   // => { tipo:'s3'|'local'|null, ativo, motivo, origemCsp, maxBytes, parteBytes, urlTtlSeg,
//   //      orfaoDias, s3:{endpoint, region, bucket, keyId, keySecret}, local:{dir} }
//   (s3 e local vêm sempre como objeto; os campos ficam '' quando não se aplicam)
function lerConfigVideo(env, { usarMongo = false, dataDir = '' } = {}) {
  const e = env || {};
  const ler = (n) => String(e[n] == null ? '' : e[n]).trim();
  const cfg = {
    tipo: null, ativo: false, motivo: MOTIVO_SEM_CONFIG, origemCsp: '',
    maxBytes: 0, parteBytes: PARTE_BYTES, urlTtlSeg: 0, orfaoDias: 90,
    s3: { endpoint: '', region: '', bucket: '', keyId: '', keySecret: '' },
    local: { dir: '' },
  };
  try {
    const maxPossivelMb = Math.floor((MAX_PARTES * PARTE_BYTES) / 1048576);
    cfg.maxBytes = inteiroEnv(e.VIDEO_MAX_MB, 1024, 1, maxPossivelMb) * 1048576;
    cfg.urlTtlSeg = inteiroEnv(e.VIDEO_URL_TTL_MIN, 360, 1, 7 * 24 * 60) * 60;
    cfg.orfaoDias = inteiroEnv(e.VIDEO_ORFAO_DIAS, 90, 1, 3650);

    const presentes = ENVS_S3.filter((n) => ler(n));
    if (presentes.length === ENVS_S3.length) {
      const endpoint = ler('VIDEO_S3_ENDPOINT').replace(/\/+$/, '');
      let u;
      try { u = new URL(endpoint); } catch (_) { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) {
        cfg.motivo = 'VIDEO_S3_ENDPOINT inválido: use a URL do armazenamento, ex.: https://<conta>.r2.cloudflarestorage.com (ver docs/VIDEOS_TREINAMENTO.md).';
        return cfg;
      }
      if ((u.pathname && u.pathname !== '/') || u.search) {
        cfg.motivo = 'VIDEO_S3_ENDPOINT deve ter só o endereço, sem o bucket nem caminho no fim (o bucket vai em VIDEO_S3_BUCKET).';
        return cfg;
      }
      cfg.s3 = { endpoint: u.origin, region: ler('VIDEO_S3_REGION'), bucket: ler('VIDEO_S3_BUCKET'),
        keyId: ler('VIDEO_S3_KEY_ID'), keySecret: ler('VIDEO_S3_KEY_SECRET') };
      Object.assign(cfg, { tipo: 's3', ativo: true, motivo: '', origemCsp: u.origin });
      return cfg;
    }
    if (presentes.length) {
      const faltam = ENVS_S3.filter((n) => !ler(n));
      cfg.motivo = `Armazenamento de vídeos com configuração incompleta: faltam ${faltam.join(', ')} (ver docs/VIDEOS_TREINAMENTO.md).`;
      return cfg;
    }
    if (usarMongo) return cfg;
    if (!dataDir) { cfg.motivo = 'Armazenamento local de vídeos sem pasta de dados.'; return cfg; }
    cfg.local = { dir: path.join(dataDir, 'videos') };
    Object.assign(cfg, { tipo: 'local', ativo: true, motivo: '' });
    // SÓ PARA TESTE: VIDEO_PARTE_BYTES_TESTE encolhe a parte no driver local, para a suíte
    // exercitar um envio de várias partes sem mandar 6 MiB por parte. Nunca vale no s3 (o
    // S3/R2 recusa parte menor que 5 MiB) nem em produção (com Mongo o driver local não existe).
    // USO: lerConfigVideo({ VIDEO_PARTE_BYTES_TESTE: '1024' }, { dataDir }) // => { tipo:'local', parteBytes:1024, … }
    if (ler('VIDEO_PARTE_BYTES_TESTE')) cfg.parteBytes = inteiroEnv(e.VIDEO_PARTE_BYTES_TESTE, PARTE_BYTES, 16, PARTE_BYTES);
    return cfg;
  } catch (err) {
    cfg.tipo = null; cfg.ativo = false;
    cfg.motivo = 'Falha ao ler a configuração de vídeos: ' + (err && err.message || err);
    return cfg;
  }
}

// ----------------------------------------------------------------------------
// XML (respostas do S3, lidas por regex: o formato é fixo e raso)
// ----------------------------------------------------------------------------

function desfazerEntidades(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}
const escaparXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// USO: tagXml('<a><Key>x&amp;y</Key></a>', 'Key') // => 'x&y'  ·  ausente => ''
function tagXml(xml, nome) {
  const m = new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`).exec(String(xml || ''));
  return m ? desfazerEntidades(m[1]).trim() : '';
}
// USO: blocosXml('<r><Part>1</Part><Part>2</Part></r>', 'Part') // => ['1', '2'] (sem desfazer entidades)
function blocosXml(xml, nome) {
  const re = new RegExp(`<${nome}(?:\\s[^>]*)?>([\\s\\S]*?)</${nome}>`, 'g');
  const saida = [];
  let m;
  while ((m = re.exec(String(xml || '')))) saida.push(m[1]);
  return saida;
}

// ----------------------------------------------------------------------------
// Drivers
// ----------------------------------------------------------------------------

function exigirChave(chave) {
  if (!validarChave(chave)) throw erro('Chave de vídeo inválida.', 400);
}
function exigirParte(n) {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PARTES) throw erro('Número da parte inválido.', 400);
}
function exigirUploadId(uploadId) {
  if (typeof uploadId !== 'string' || !uploadId || uploadId.length > 1024) throw erro('Identificador do envio inválido.', 400);
}

// Mensagem clara para os erros comuns do S3/R2.
function mensagemS3(status, codigo, mensagem) {
  if (codigo === 'SignatureDoesNotMatch') {
    return 'O armazenamento recusou a assinatura (SignatureDoesNotMatch). Confira VIDEO_S3_KEY_SECRET e se VIDEO_S3_REGION bate com o endpoint (no Cloudflare R2 use "auto").';
  }
  if (codigo === 'InvalidAccessKeyId') return 'O armazenamento não reconhece a chave de acesso (InvalidAccessKeyId). Confira VIDEO_S3_KEY_ID.';
  if (codigo === 'NoSuchBucket') return 'O bucket de vídeos não existe (NoSuchBucket). Confira VIDEO_S3_BUCKET.';
  if (codigo === 'NoSuchUpload') return 'O envio expirou ou foi cancelado no armazenamento (NoSuchUpload). Envie o vídeo de novo.';
  if (status === 403) return `O armazenamento negou o acesso (${codigo || 403}). Confira se a chave tem permissão de leitura e escrita no bucket de vídeos.`;
  return `O armazenamento respondeu ${status}${codigo ? ` (${codigo})` : ''}${mensagem ? `: ${mensagem}` : ''}.`;
}

// Driver S3-compatível (R2, B2, MinIO, AWS). opcoes: { fetch, timeoutMs, retentativas, esperaMs }
// só para testes; o padrão é o fetch global, 60 s por requisição e 2 retentativas.
function criarDriverS3(cfg, opcoes = {}) {
  const s3 = cfg.s3;
  const base = new URL(s3.endpoint);
  const buscar = opcoes.fetch || globalThis.fetch;
  const timeoutMs = opcoes.timeoutMs || 60000;
  const retentativas = opcoes.retentativas == null ? 2 : opcoes.retentativas;
  const esperaMs = opcoes.esperaMs == null ? 500 : opcoes.esperaMs;
  const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

  // Uma requisição assinada, com prazo e retentativas em 5xx/erro de rede. `chave` '' = bucket.
  // Corpo sempre Buffer: o fetch manda Content-Length exato (nunca chunked, que o S3 recusa).
  async function req(metodo, chave, { query = {}, corpo, contentType, erroNoCorpo = false } = {}) {
    const buf = corpo == null ? Buffer.alloc(0) : Buffer.isBuffer(corpo) ? corpo : Buffer.from(corpo);
    const caminho = `/${s3.bucket}${chave ? '/' + chave : ''}`;
    const qc = queryCanonica(query);
    const url = `${base.protocol}//${base.host}${caminhoCanonico(caminho)}${qc ? '?' + qc : ''}`;
    let ultimoErro;
    for (let tentativa = 0; tentativa <= retentativas; tentativa++) {
      if (tentativa) await dormir(esperaMs * tentativa);
      const cab = assinarRequisicao({
        metodo, host: base.host, caminho, query,
        cabecalhos: contentType ? { 'content-type': contentType } : {},
        hashCorpo: sha256hex(buf), region: s3.region, keyId: s3.keyId, keySecret: s3.keySecret,
      });
      delete cab.host; // o fetch deriva o Host da URL (o mesmo valor assinado)
      // Prazo com AbortController + clearTimeout, não AbortSignal.timeout(): o timer deste
      // segundo não fica pendente depois da resposta (ver o comentário de buscar() em
      // scripts/backup-nuvem.mjs sobre o Node no Windows).
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      let r, texto;
      try {
        r = await buscar(url, {
          method: metodo, headers: cab, signal: ctrl.signal,
          // DELETE/GET/HEAD vão sem corpo (o hash assinado é o do corpo vazio).
          body: metodo === 'GET' || metodo === 'HEAD' || metodo === 'DELETE' ? undefined : buf,
        });
        texto = metodo === 'HEAD' ? '' : await r.text();
      } catch (e) {
        ultimoErro = erro(ctrl.signal.aborted
          ? `O armazenamento não respondeu em ${Math.round(timeoutMs / 1000)} s.`
          : `Falha de rede ao falar com o armazenamento: ${e && e.message || e}`, 502, 'REDE');
        continue;
      } finally {
        clearTimeout(t);
      }
      const codigo = tagXml(texto, 'Code');
      // CompleteMultipartUpload pode responder 200 e trazer <Error> no corpo.
      const falhouNoCorpo = erroNoCorpo && r.status === 200 && /<Error[\s>]/.test(texto);
      if (r.status >= 500 || falhouNoCorpo) {
        ultimoErro = erro(mensagemS3(falhouNoCorpo ? 500 : r.status, codigo, tagXml(texto, 'Message')), 502, codigo || undefined);
        ultimoErro.statusArmazenamento = r.status;
        continue;
      }
      return { status: r.status, headers: r.headers, texto, codigo };
    }
    throw ultimoErro;
  }

  function falhar(r) {
    const e = erro(mensagemS3(r.status, r.codigo, tagXml(r.texto, 'Message')),
      r.codigo === 'NoSuchUpload' ? 404 : r.status === 404 ? 404 : 502, r.codigo || undefined);
    e.statusArmazenamento = r.status;
    throw e;
  }
  const ok2xx = (r) => r.status >= 200 && r.status < 300;
  // Um Complete anterior pode ter dado certo e a resposta se perdeu (rede, prazo de 60 s): o
  // upload some (NoSuchUpload) e o objeto final fica no bucket. Conta como concluído só se o
  // HEAD achar o objeto com o tamanho esperado. Serve ao ListParts e à retentativa do Complete.
  // USO: await concluidoAntes(chave, 13631488) // => { bytes: 13631488 } | null (não dá para afirmar)
  async function concluidoAntes(chave, bytesEsperados) {
    if (bytesEsperados == null) return null;
    const h = await driver.cabeca(chave);
    return h && h.bytes === Number(bytesEsperados) ? { bytes: h.bytes } : null;
  }

  const driver = {
    tipo: 's3',

    // USO: await drv.iniciar({ chave: novaChave('mp4'), mime: 'video/mp4' }) // => { uploadId: '…' }
    async iniciar({ chave, mime }) {
      exigirChave(chave);
      if (!MIMES.includes(mime)) throw erro('Formato de vídeo não aceito (use MP4 ou WebM).', 400);
      const r = await req('POST', chave, { query: { uploads: '' }, contentType: mime });
      if (!ok2xx(r)) falhar(r);
      const uploadId = tagXml(r.texto, 'UploadId');
      if (!uploadId) throw erro('O armazenamento não devolveu o identificador do envio.', 502);
      return { uploadId };
    },

    // USO: await drv.enviarParte({ chave, uploadId, n: 1, buf }) // => { etag: '"9b2c…"' }
    async enviarParte({ chave, uploadId, n, buf }) {
      exigirChave(chave); exigirUploadId(uploadId); exigirParte(n);
      if (!buf || !buf.length) throw erro('Parte do vídeo vazia.', 400);
      const r = await req('PUT', chave, { query: { partNumber: String(n), uploadId }, corpo: buf });
      if (!ok2xx(r)) falhar(r);
      return { etag: r.headers.get('etag') || '' };
    },

    // USO: await drv.listarPartes({ chave, uploadId }) // => [{ n: 1, etag: '"…"', bytes: 6291456 }, …]
    async listarPartes({ chave, uploadId }) {
      exigirChave(chave); exigirUploadId(uploadId);
      const partes = [];
      let marcador = '';
      for (let pagina = 0; pagina < 100; pagina++) {
        const query = { uploadId };
        if (marcador) query['part-number-marker'] = marcador;
        const r = await req('GET', chave, { query });
        if (!ok2xx(r)) falhar(r);
        for (const b of blocosXml(r.texto, 'Part')) {
          partes.push({ n: Number(tagXml(b, 'PartNumber')), etag: tagXml(b, 'ETag'), bytes: Number(tagXml(b, 'Size')) });
        }
        const proximo = tagXml(r.texto, 'NextPartNumberMarker');
        if (tagXml(r.texto, 'IsTruncated') !== 'true' || !proximo || proximo === marcador) break;
        marcador = proximo;
      }
      return partes.sort((a, b) => a.n - b.n);
    },

    // Junta as partes que o armazenamento TEM (ListParts), não as que o cliente diz ter mandado,
    // e confirma com HEAD que o objeto final tem o tamanho esperado.
    // USO: await drv.concluir({ chave, uploadId, bytesEsperados: 13631488 }) // => { bytes: 13631488 }
    async concluir({ chave, uploadId, bytesEsperados }) {
      exigirChave(chave); exigirUploadId(uploadId);
      let partes;
      try {
        partes = await driver.listarPartes({ chave, uploadId });
      } catch (e) {
        // Um Complete anterior pode ter dado certo e a resposta se perdeu: o upload some, o objeto fica.
        if (e.codigo === 'NoSuchUpload') {
          const feito = await concluidoAntes(chave, bytesEsperados);
          if (feito) return feito;
        }
        throw e;
      }
      if (!partes.length) throw erro('Nenhuma parte do vídeo chegou ao armazenamento.', 400, 'PARTES_INVALIDAS');
      if (bytesEsperados != null) {
        const c = conferirPartes(partes, Number(bytesEsperados), cfg.parteBytes || PARTE_BYTES, cfg.maxBytes || Infinity);
        if (!c.ok) throw erro(c.erro, 400, 'PARTES_INVALIDAS');
      }
      const xml = '<CompleteMultipartUpload xmlns="http://s3.amazonaws.com/doc/2006-03-01/">'
        + partes.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${escaparXml(p.etag)}</ETag></Part>`).join('')
        + '</CompleteMultipartUpload>';
      const r = await req('POST', chave, { query: { uploadId }, corpo: Buffer.from(xml, 'utf8'), contentType: 'application/xml', erroNoCorpo: true });
      if (!ok2xx(r)) {
        // O req() repete o Complete depois de erro de rede ou prazo. Se a 1ª tentativa foi aplicada
        // no bucket, a retentativa recebe NoSuchUpload: confere o objeto antes de dar 404 ao RH.
        if (r.codigo === 'NoSuchUpload') {
          const feito = await concluidoAntes(chave, bytesEsperados);
          if (feito) return feito;
        }
        falhar(r);
      }
      const h = await driver.cabeca(chave);
      if (!h) throw erro('O armazenamento concluiu o envio, mas o vídeo não aparece no bucket.', 502);
      if (bytesEsperados != null && h.bytes !== Number(bytesEsperados)) {
        throw erro(`O vídeo ficou com ${h.bytes} bytes no armazenamento; eram esperados ${bytesEsperados}.`, 502, 'TAMANHO_DIVERGENTE');
      }
      return { bytes: h.bytes };
    },

    // Cancela um envio pela metade (idempotente: envio que já não existe conta como cancelado).
    // USO: await drv.abortar({ chave, uploadId }) // => undefined
    async abortar({ chave, uploadId }) {
      exigirChave(chave); exigirUploadId(uploadId);
      const r = await req('DELETE', chave, { query: { uploadId } });
      if (ok2xx(r) || r.status === 404) return;
      falhar(r);
    },

    // USO: await drv.cabeca(chave) // => { bytes: 13631488, mime: 'video/mp4' } | null (não existe)
    async cabeca(chave) {
      exigirChave(chave);
      const r = await req('HEAD', chave);
      if (r.status === 404) return null;
      if (!ok2xx(r)) falhar(r);
      return { bytes: Number(r.headers.get('content-length') || 0), mime: (r.headers.get('content-type') || '').split(';')[0].trim() };
    },

    // URL pré-assinada para o <video>; expira em cfg.urlTtlSeg (padrão 6 h).
    // USO: drv.urlLeitura(chave) // => { url: 'https://…?X-Amz-…&X-Amz-Signature=…', expiraTs: 1790021600000 }
    async urlLeitura(chave, _opcoes = {}) {
      exigirChave(chave);
      const agora = Date.now();
      const expiraSeg = cfg.urlTtlSeg || 21600;
      const url = presignarGet({ endpoint: s3.endpoint, region: s3.region, bucket: s3.bucket, chave,
        keyId: s3.keyId, keySecret: s3.keySecret, expiraSeg, agora });
      return { url, expiraTs: agora + expiraSeg * 1000 };
    },

    // Só existe no driver local.
    // USO: drv.caminhoLocal(chave) // => null
    caminhoLocal() { return null; },

    // USO: await drv.listarObjetos() // => [{ chave:'videos-treino/2026/….mp4', bytes, modificadoTs }]
    async listarObjetos(prefixo = PREFIXO) {
      const saida = [];
      let token = '';
      for (let pagina = 0; pagina < 1000; pagina++) {
        const query = { 'list-type': '2', prefix: String(prefixo || '') };
        if (token) query['continuation-token'] = token;
        const r = await req('GET', '', { query });
        if (!ok2xx(r)) falhar(r);
        for (const b of blocosXml(r.texto, 'Contents')) {
          saida.push({ chave: tagXml(b, 'Key'), bytes: Number(tagXml(b, 'Size')) || 0, modificadoTs: Date.parse(tagXml(b, 'LastModified')) || 0 });
        }
        token = tagXml(r.texto, 'NextContinuationToken');
        if (tagXml(r.texto, 'IsTruncated') !== 'true' || !token) break;
      }
      return saida;
    },

    // Só apaga chaves de vídeo (RE_CHAVE): nada fora de videos-treino/ some por engano.
    // USO: await drv.apagar(chave) // => undefined (inexistente também conta como apagado)
    async apagar(chave) {
      exigirChave(chave);
      const r = await req('DELETE', chave);
      if (ok2xx(r) || r.status === 404) return;
      falhar(r);
    },

    // Envios começados e nunca concluídos nem cancelados (ocupam espaço no bucket).
    // USO: await drv.listarUploadsPendentes() // => [{ chave, uploadId, iniciadoTs }]
    async listarUploadsPendentes() {
      const saida = [];
      let chaveMarcador = '', idMarcador = '';
      for (let pagina = 0; pagina < 1000; pagina++) {
        const query = { uploads: '', prefix: PREFIXO };
        if (chaveMarcador) query['key-marker'] = chaveMarcador;
        if (idMarcador) query['upload-id-marker'] = idMarcador;
        const r = await req('GET', '', { query });
        if (!ok2xx(r)) falhar(r);
        for (const b of blocosXml(r.texto, 'Upload')) {
          saida.push({ chave: tagXml(b, 'Key'), uploadId: tagXml(b, 'UploadId'), iniciadoTs: Date.parse(tagXml(b, 'Initiated')) || 0 });
        }
        chaveMarcador = tagXml(r.texto, 'NextKeyMarker');
        idMarcador = tagXml(r.texto, 'NextUploadIdMarker');
        if (tagXml(r.texto, 'IsTruncated') !== 'true' || (!chaveMarcador && !idMarcador)) break;
      }
      return saida;
    },

    // Testa leitura (lista o bucket) e escrita (abre e cancela um envio) sem deixar nada.
    // USO: await drv.testar() // => { ok: true, mensagem: 'Conexão com o bucket "treinos" ok: leitura e escrita.' }
    async testar() {
      const r = await req('GET', '', { query: { 'list-type': '2', prefix: PREFIXO, 'max-keys': '1' } });
      if (!ok2xx(r)) falhar(r);
      const chave = novaChave('mp4');
      const { uploadId } = await driver.iniciar({ chave, mime: 'video/mp4' });
      await driver.abortar({ chave, uploadId });
      return { ok: true, mensagem: `Conexão com o bucket "${s3.bucket}" ok: leitura e escrita.` };
    },
  };
  return driver;
}

// Driver local (dev/testes): <dataDir>/videos/<chave>, partes em .parciais/<uploadId>/<n>.part.
function criarDriverLocal(cfg) {
  const raiz = path.resolve(cfg.local.dir);
  const parciais = path.join(raiz, '.parciais');
  const RE_UPLOAD = /^[a-f0-9]{32}$/;

  const pastaUpload = (uploadId) => {
    if (typeof uploadId !== 'string' || !RE_UPLOAD.test(uploadId)) throw erro('Identificador do envio inválido.', 400);
    return path.join(parciais, uploadId);
  };
  const semUpload = () => erro(mensagemS3(404, 'NoSuchUpload'), 404, 'NoSuchUpload');
  async function lerMeta(uploadId, chave) {
    let meta;
    try { meta = JSON.parse(await fsp.readFile(path.join(pastaUpload(uploadId), 'meta.json'), 'utf8')); }
    catch (e) { if (e.status) throw e; throw semUpload(); }
    if (chave != null && meta.chave !== chave) throw semUpload();
    return meta;
  }
  const etagDe = (st) => `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;

  const driver = {
    tipo: 'local',

    // USO: await drv.iniciar({ chave: novaChave('webm'), mime: 'video/webm' }) // => { uploadId: '<32 hex>' }
    async iniciar({ chave, mime }) {
      exigirChave(chave);
      if (!MIMES.includes(mime)) throw erro('Formato de vídeo não aceito (use MP4 ou WebM).', 400);
      const uploadId = crypto.randomBytes(16).toString('hex');
      const dir = pastaUpload(uploadId);
      await fsp.mkdir(dir, { recursive: true });
      await fsp.writeFile(path.join(dir, 'meta.json'), JSON.stringify({ chave, mime, iniciadoTs: Date.now() }));
      return { uploadId };
    },

    // Grava em arquivo temporário e renomeia: parte reenviada substitui a anterior inteira.
    // USO: await drv.enviarParte({ chave, uploadId, n: 1, buf }) // => { etag: '"600000-18f…"' }
    async enviarParte({ chave, uploadId, n, buf }) {
      exigirChave(chave); exigirParte(n);
      if (!buf || !buf.length) throw erro('Parte do vídeo vazia.', 400);
      await lerMeta(uploadId, chave);
      const destino = path.join(pastaUpload(uploadId), `${n}.part`);
      const tmp = `${destino}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fsp.writeFile(tmp, buf);
      await fsp.rename(tmp, destino);
      return { etag: etagDe(await fsp.stat(destino)) };
    },

    // USO: await drv.listarPartes({ chave, uploadId }) // => [{ n: 1, etag, bytes: 6291456 }, …]
    async listarPartes({ chave, uploadId }) {
      exigirChave(chave);
      await lerMeta(uploadId, chave);
      const dir = pastaUpload(uploadId);
      const partes = [];
      for (const nome of await fsp.readdir(dir)) {
        const m = /^(\d+)\.part$/.exec(nome);
        if (!m) continue;
        const st = await fsp.stat(path.join(dir, nome));
        partes.push({ n: Number(m[1]), etag: etagDe(st), bytes: st.size });
      }
      return partes.sort((a, b) => a.n - b.n);
    },

    // Junta as partes em fluxo (sem carregar o vídeo na memória) num temporário e renomeia.
    // USO: await drv.concluir({ chave, uploadId, bytesEsperados: 13631488 }) // => { bytes: 13631488 }
    async concluir({ chave, uploadId, bytesEsperados }) {
      exigirChave(chave);
      const partes = await driver.listarPartes({ chave, uploadId });
      if (!partes.length) throw erro('Nenhuma parte do vídeo chegou ao armazenamento.', 400, 'PARTES_INVALIDAS');
      if (bytesEsperados != null) {
        const c = conferirPartes(partes, Number(bytesEsperados), cfg.parteBytes || PARTE_BYTES, cfg.maxBytes || Infinity);
        if (!c.ok) throw erro(c.erro, 400, 'PARTES_INVALIDAS');
      }
      const dir = pastaUpload(uploadId);
      const final = driver.caminhoLocal(chave);
      await fsp.mkdir(path.dirname(final), { recursive: true });
      const tmp = `${final}.${uploadId}.tmp`;
      const saida = fs.createWriteStream(tmp);
      try {
        for (const p of partes) await pipeline(fs.createReadStream(path.join(dir, `${p.n}.part`)), saida, { end: false });
        await new Promise((ok, falhou) => { saida.on('error', falhou); saida.end(ok); });
        const st = await fsp.stat(tmp);
        if (bytesEsperados != null && st.size !== Number(bytesEsperados)) {
          throw erro(`O vídeo ficou com ${st.size} bytes; eram esperados ${bytesEsperados}.`, 502, 'TAMANHO_DIVERGENTE');
        }
        await fsp.rename(tmp, final);
        await fsp.rm(dir, { recursive: true, force: true });
        return { bytes: st.size };
      } catch (e) {
        saida.destroy();
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw e;
      }
    },

    // Chave '' é aceita só aqui: listarUploadsPendentes() devolve '' para a pasta de envio que
    // ficou sem meta.json, e a faxina precisa conseguir apagá-la (o uploadId continua validado).
    // USO: await drv.abortar({ chave, uploadId }) // => undefined (idempotente)
    //      await drv.abortar({ chave: '', uploadId: '<32 hex>' }) // pasta órfã sem meta.json
    async abortar({ chave, uploadId }) {
      if (chave !== '') exigirChave(chave);
      await fsp.rm(pastaUpload(uploadId), { recursive: true, force: true });
    },

    // USO: await drv.cabeca(chave) // => { bytes, mime: 'video/mp4' } | null
    async cabeca(chave) {
      const arq = driver.caminhoLocal(chave);
      try {
        const st = await fsp.stat(arq);
        if (!st.isFile()) return null;
        return { bytes: st.size, mime: chave.endsWith('.webm') ? 'video/webm' : 'video/mp4' };
      } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
      }
    },

    // No local a URL é a rota do próprio servidor, que o chamador monta e passa em urlLocal.
    // USO: await drv.urlLeitura(chave, { urlLocal: '/api/treinamentos/T1/video' })
    //   // => { url: '/api/treinamentos/T1/video', expiraTs: agora + urlTtlSeg*1000 }
    async urlLeitura(chave, { urlLocal = '' } = {}) {
      exigirChave(chave);
      return { url: String(urlLocal || ''), expiraTs: Date.now() + (cfg.urlTtlSeg || 21600) * 1000 };
    },

    // Caminho no disco para servir com Range. Revalida a chave e confere que o caminho
    // resolvido continua dentro da pasta de vídeos (anti path traversal); chave inválida lança 400.
    // USO: drv.caminhoLocal('videos-treino/2026/<32hex>.mp4') // => 'C:\\…\\data\\videos\\videos-treino\\2026\\<32hex>.mp4'
    //      drv.caminhoLocal('../usuarios.json')              // => lança Error (status 400)
    caminhoLocal(chave) {
      exigirChave(chave);
      const arq = path.resolve(raiz, ...chave.split('/'));
      if (!arq.startsWith(raiz + path.sep)) throw erro('Chave de vídeo inválida.', 400);
      return arq;
    },

    // USO: await drv.listarObjetos() // => [{ chave:'videos-treino/2026/….mp4', bytes, modificadoTs }]
    async listarObjetos(prefixo = PREFIXO) {
      const saida = [];
      async function varrer(dir, rel) {
        let itens;
        try { itens = await fsp.readdir(dir, { withFileTypes: true }); }
        catch (e) { if (e.code === 'ENOENT') return; throw e; }
        for (const it of itens) {
          if (it.name === '.parciais' || it.name.endsWith('.tmp')) continue;
          const r = rel ? `${rel}/${it.name}` : it.name;
          if (it.isDirectory()) await varrer(path.join(dir, it.name), r);
          else if (it.isFile() && r.startsWith(String(prefixo || ''))) {
            const st = await fsp.stat(path.join(dir, it.name));
            saida.push({ chave: r, bytes: st.size, modificadoTs: st.mtimeMs });
          }
        }
      }
      await varrer(raiz, '');
      return saida;
    },

    // USO: await drv.apagar(chave) // => undefined (inexistente também conta como apagado)
    async apagar(chave) {
      await fsp.rm(driver.caminhoLocal(chave), { force: true });
    },

    // USO: await drv.listarUploadsPendentes() // => [{ chave, uploadId, iniciadoTs }]
    async listarUploadsPendentes() {
      let itens;
      try { itens = await fsp.readdir(parciais, { withFileTypes: true }); }
      catch (e) { if (e.code === 'ENOENT') return []; throw e; }
      const saida = [];
      for (const it of itens) {
        if (!it.isDirectory() || !RE_UPLOAD.test(it.name)) continue;
        let meta = null;
        try { meta = JSON.parse(await fsp.readFile(path.join(parciais, it.name, 'meta.json'), 'utf8')); } catch (_) { /* sem meta */ }
        const iniciadoTs = meta && meta.iniciadoTs || (await fsp.stat(path.join(parciais, it.name))).mtimeMs;
        saida.push({ chave: meta && validarChave(meta.chave) ? meta.chave : '', uploadId: it.name, iniciadoTs });
      }
      return saida;
    },

    // USO: await drv.testar() // => { ok: true, mensagem: 'Pasta local de vídeos ok: …' }
    async testar() {
      await fsp.mkdir(raiz, { recursive: true });
      const teste = path.join(raiz, `.teste-${crypto.randomBytes(4).toString('hex')}`);
      await fsp.writeFile(teste, 'ok');
      await fsp.rm(teste, { force: true });
      return { ok: true, mensagem: `Pasta local de vídeos ok: ${raiz}` };
    },
  };
  return driver;
}

// Fábrica: devolve o driver do tipo da config (mesma interface nos dois) ou null se o vídeo
// estiver desligado (cfg.tipo null; o motivo está em cfg.motivo).
// USO: const cfgVideo = lerConfigVideo(process.env, { usarMongo, dataDir: DATA_DIR });
//      const videos = criarArmazenamento(cfgVideo);   // => driver | null
//      if (videos) { const { uploadId } = await videos.iniciar({ chave, mime: 'video/mp4' }); … }
// `opcoes` ({ fetch, timeoutMs, retentativas, esperaMs }) serve aos testes do driver S3.
function criarArmazenamento(cfg, opcoes = {}) {
  if (!cfg || !cfg.tipo) return null;
  if (cfg.tipo === 's3') return criarDriverS3(cfg, opcoes);
  if (cfg.tipo === 'local') return criarDriverLocal(cfg);
  return null;
}

module.exports = {
  RE_CHAVE, PREFIXO, MIMES, PARTE_BYTES, MAX_PARTES, DURACAO_MAX_SEG, HASH_VAZIO, ENVS_S3,
  uriEncode, carimboAmz, caminhoCanonico, queryCanonica, calcularAssinatura, assinarRequisicao, presignarGet,
  validarChave, novaChave, mimeDe, tipoPorBytesMagicos, planoPartes, conferirPartes, lerDuracaoSeg,
  normalizarVideoTreino, refDaChave, lerConfigVideo, criarArmazenamento, tagXml, blocosXml,
};
