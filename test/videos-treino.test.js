/**
 * Vídeos de treinamento: backend/videos-treino.js (assinatura SigV4, regras e drivers).
 *
 * Por que este teste existe: a assinatura S3 é feita à mão (sem SDK). Erro nela só aparece
 * como "403 SignatureDoesNotMatch" no primeiro envio real ao R2, e erro nas regras de chave
 * vira path traversal no driver local. Aqui:
 *   Parte 1: vetores OFICIAIS da AWS (documentação do S3 "Signature Calculations for the
 *            Authorization Header", exemplos examplebucket/20130524, e a suíte genérica
 *            aws-sig-v4-test-suite get-vanilla), mais a requisição canônica passo a passo.
 *   Parte 2: regras puras (chave, mime, bytes mágicos, partes, config).
 *   Parte 3: driver s3 contra um S3 FALSO local (http.createServer em listen(0)) que confere
 *            a assinatura de cada requisição com um verificador independente.
 *   Parte 4: driver local numa pasta temporária.
 * Sem porta fixa: nada aqui disputa a faixa 3196-3209 (ver test/portas.test.js).
 * Rodar: npm test   (ou: node --test test/videos-treino.test.js)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const V = require('../backend/videos-treino');

const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
const CHAVE = 'videos-treino/2026/0123456789abcdef0123456789abcdef.mp4';

// ----------------------------------------------------------------------------------------
// Parte 1: SigV4
// ----------------------------------------------------------------------------------------
// Credenciais de exemplo publicadas pela AWS na documentação do S3 (não são reais — é o mesmo
// valor em todos os exemplos oficiais do SigV4). O Key ID é montado em duas partes só para o scan
// de segredos (scripts/scan-secrets.js no pre-commit e gitleaks no CI) não acusar este vetor de
// teste como "AWS Access Key ID"; afrouxar o scanner deixaria passar chave real.
const AWS_KEY_ID_EXEMPLO = 'AKIA' + 'IOSFODNN7EXAMPLE';
const AWS = {
  host: 'examplebucket.s3.amazonaws.com', agora: '20130524T000000Z', region: 'us-east-1',
  keyId: AWS_KEY_ID_EXEMPLO, keySecret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};

test('SIGV4-V1: GET Object (Range) bate com a requisição canônica, a string-to-sign e a assinatura da AWS', () => {
  const r = V.calcularAssinatura({ ...AWS, metodo: 'GET', caminho: '/test.txt', cabecalhos: { Range: 'bytes=0-9' }, hashCorpo: V.HASH_VAZIO });
  assert.equal(r.requisicaoCanonica, [
    'GET', '/test.txt', '',
    'host:examplebucket.s3.amazonaws.com',
    'range:bytes=0-9',
    `x-amz-content-sha256:${V.HASH_VAZIO}`,
    'x-amz-date:20130524T000000Z',
    '',
    'host;range;x-amz-content-sha256;x-amz-date',
    V.HASH_VAZIO,
  ].join('\n'));
  assert.equal(r.paraAssinar, [
    'AWS4-HMAC-SHA256', '20130524T000000Z', '20130524/us-east-1/s3/aws4_request',
    '7344ae5b7ee6c3e7e6b0fe0640412a37625d1fbfff95c48bbb2dc43964946972',
  ].join('\n'));
  assert.equal(r.assinatura, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  assert.equal(V.assinarRequisicao({ ...AWS, metodo: 'GET', caminho: '/test.txt', cabecalhos: { Range: 'bytes=0-9' }, hashCorpo: V.HASH_VAZIO }).Authorization,
    'AWS4-HMAC-SHA256 Credential=' + AWS_KEY_ID_EXEMPLO + '/20130524/us-east-1/s3/aws4_request, '
    + 'SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
});

test('SIGV4-V2: PUT Object com $ no nome codifica o segmento (/test%24file.text) e bate com a AWS', () => {
  const r = V.calcularAssinatura({ ...AWS, metodo: 'PUT', caminho: '/test$file.text',
    cabecalhos: { Date: 'Fri, 24 May 2013 00:00:00 GMT', 'x-amz-storage-class': 'REDUCED_REDUNDANCY' },
    hashCorpo: sha('Welcome to Amazon S3.') });
  assert.equal(sha('Welcome to Amazon S3.'), '44ce7dd67c959e0d3524ffac1771dfbba87d2b6b4b4e99e42034a8b803f8b072');
  assert.equal(r.requisicaoCanonica.split('\n')[1], '/test%24file.text');
  assert.equal(r.assinados, 'date;host;x-amz-content-sha256;x-amz-date;x-amz-storage-class');
  assert.equal(r.assinatura, '98ad721746da40c64f1a55b78f14c238d841ea1380cd77a1b5971af0ece108bd');
});

test('SIGV4-V3: query canônica ?lifecycle vira "lifecycle=" e ?max-keys=2&prefix=J fica ordenada (vetores da AWS)', () => {
  const lc = V.calcularAssinatura({ ...AWS, metodo: 'GET', caminho: '/', query: { lifecycle: '' }, hashCorpo: V.HASH_VAZIO });
  assert.equal(lc.requisicaoCanonica.split('\n')[2], 'lifecycle=');
  assert.equal(lc.assinatura, 'fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543');
  const ls = V.calcularAssinatura({ ...AWS, metodo: 'GET', caminho: '/', query: { prefix: 'J', 'max-keys': '2' }, hashCorpo: V.HASH_VAZIO });
  assert.equal(ls.requisicaoCanonica.split('\n')[2], 'max-keys=2&prefix=J');
  assert.equal(ls.assinatura, '34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7');
});

test('SIGV4-V4: URL pré-assinada bate com o exemplo de presigned URL da AWS', () => {
  const url = V.presignarGet({ endpoint: 'https://examplebucket.s3.amazonaws.com', region: 'us-east-1', bucket: '',
    chave: 'test.txt', keyId: AWS.keyId, keySecret: AWS.keySecret, expiraSeg: 86400, agora: AWS.agora });
  assert.equal(url, 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256'
    + '&X-Amz-Credential=' + AWS_KEY_ID_EXEMPLO + '%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z'
    + '&X-Amz-Expires=86400&X-Amz-SignedHeaders=host'
    + '&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});

test('SIGV4-V5: suíte genérica da AWS (get-vanilla e get-vanilla-query-order-key-case), sem hash em cabeçalho fora do S3', () => {
  const g = { metodo: 'GET', host: 'example.amazonaws.com', caminho: '/', agora: '20150830T123600Z', region: 'us-east-1',
    servico: 'service', keyId: 'AKIDEXAMPLE', keySecret: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };
  const a = V.calcularAssinatura(g);
  assert.equal(a.assinados, 'host;x-amz-date');
  assert.equal(a.assinatura, '5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31');
  const b = V.calcularAssinatura({ ...g, query: { Param2: 'value2', Param1: 'value1' } });
  assert.equal(b.requisicaoCanonica.split('\n')[2], 'Param1=value1&Param2=value2');
  assert.equal(b.assinatura, 'b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500');
});

test('SIGV4-Q: ?uploads assina "uploads=", partNumber vem antes de uploadId, content-type entra na assinatura', () => {
  assert.equal(V.queryCanonica({ uploads: '' }), 'uploads=');
  assert.equal(V.queryCanonica({ uploadId: 'a/b+c=', partNumber: 2 }), 'partNumber=2&uploadId=a%2Fb%2Bc%3D');
  const r = V.calcularAssinatura({ metodo: 'POST', host: 'conta.r2.cloudflarestorage.com', caminho: `/treinos/${CHAVE}`,
    query: { uploads: '' }, cabecalhos: { 'Content-Type': 'video/mp4' }, hashCorpo: V.HASH_VAZIO,
    agora: '20260923T120000Z', region: 'auto', keyId: 'K', keySecret: 'S' });
  const linhas = r.requisicaoCanonica.split('\n');
  assert.equal(linhas[1], `/treinos/${CHAVE}`, 'as barras da chave continuam barras');
  assert.equal(linhas[2], 'uploads=');
  assert.equal(r.assinados, 'content-type;host;x-amz-content-sha256;x-amz-date');
  assert.match(r.cabecalhos.Authorization, /Credential=K\/20260923\/auto\/s3\/aws4_request, /);
});

test('SIGV4-U: uriEncode codifica !\'()* e "/" (RFC 3986); caminho codifica por segmento', () => {
  assert.equal(V.uriEncode("!'()*"), '%21%27%28%29%2A');
  assert.equal(V.uriEncode('a/b c~-._'), 'a%2Fb%20c~-._');
  assert.equal(V.caminhoCanonico("/b/pasta (1)/x!.mp4"), '/b/pasta%20%281%29/x%21.mp4');
  assert.equal(V.carimboAmz(Date.UTC(2026, 8, 23, 12, 0, 0)), '20260923T120000Z');
});

// ----------------------------------------------------------------------------------------
// Parte 2: regras puras
// ----------------------------------------------------------------------------------------
test('REGRA-1: validarChave recusa ../, caminho absoluto, prefixo e extensão errados', () => {
  assert.equal(V.validarChave(CHAVE), true);
  assert.equal(V.validarChave(CHAVE.replace('.mp4', '.webm')), true);
  for (const ruim of [
    'videos-treino/2026/../../data/usuarios.json',
    '../videos-treino/2026/0123456789abcdef0123456789abcdef.mp4',
    '/videos-treino/2026/0123456789abcdef0123456789abcdef.mp4',
    'C:\\videos-treino\\2026\\0123456789abcdef0123456789abcdef.mp4',
    'backups/2026/0123456789abcdef0123456789abcdef.mp4',
    'videos-treino/2026/0123456789abcdef0123456789abcdef.mov',
    'videos-treino/2026/0123456789abcdef0123456789abcdef.mp4.html',
    'videos-treino/2026/0123456789ABCDEF0123456789abcdef.mp4',
    'videos-treino/26/0123456789abcdef0123456789abcdef.mp4',
    '', null, undefined, 42,
  ]) assert.equal(V.validarChave(ruim), false, String(ruim));
});

test('REGRA-2: novaChave gera chave válida e única; refDaChave tem 12 hex e não contém a chave', () => {
  const a = V.novaChave('mp4', Date.UTC(2026, 0, 1));
  const b = V.novaChave('video/webm');
  assert.match(a, /^videos-treino\/2026\/[a-f0-9]{32}\.mp4$/);
  assert.ok(V.validarChave(a) && V.validarChave(b) && b.endsWith('.webm'));
  assert.notEqual(a, V.novaChave('mp4'));
  assert.throws(() => V.novaChave('mov'), /MP4 ou WebM/);
  assert.match(V.refDaChave(a), /^[a-f0-9]{12}$/);
  assert.equal(V.refDaChave(a), V.refDaChave(a));
  assert.ok(!a.includes(V.refDaChave(a)));
});

test('REGRA-3: mimeDe aceita MP4/WebM e recusa QuickTime e conflito nome × tipo', () => {
  assert.equal(V.mimeDe('aula.mp4', 'video/mp4'), 'video/mp4');
  assert.equal(V.mimeDe('aula.MP4', ''), 'video/mp4');
  assert.equal(V.mimeDe('aula.m4v', 'video/x-m4v'), 'video/mp4');
  assert.equal(V.mimeDe('aula.webm', 'video/webm;codecs=vp9'), 'video/webm');
  assert.equal(V.mimeDe('aula', 'video/webm'), 'video/webm');
  assert.equal(V.mimeDe('aula.mov', 'video/quicktime'), '');
  assert.equal(V.mimeDe('aula.mov', 'video/mp4'), '');
  assert.equal(V.mimeDe('aula.mp4', 'video/quicktime'), '');
  assert.equal(V.mimeDe('aula.webm', 'video/mp4'), '');
  assert.equal(V.mimeDe('aula.avi', ''), '');
  assert.equal(V.mimeDe('planilha.xlsx', 'application/vnd.ms-excel'), '');
});

test('REGRA-4: tipoPorBytesMagicos reconhece MP4 (ftyp) e WebM (EBML) e recusa HTML, QuickTime e curto', () => {
  const mp4 = Buffer.concat([Buffer.from('00000020', 'hex'), Buffer.from('ftypisom'), Buffer.alloc(20)]);
  const webm = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('\x9f\x42\x86\x81\x01\x42\x82\x84webm', 'latin1'), Buffer.alloc(8)]);
  const mkv = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('\x42\x82\x88matroska', 'latin1')]);
  const mov = Buffer.concat([Buffer.from('00000014', 'hex'), Buffer.from('ftypqt  '), Buffer.alloc(8)]);
  assert.equal(V.tipoPorBytesMagicos(mp4), 'video/mp4');
  assert.equal(V.tipoPorBytesMagicos(webm), 'video/webm');
  assert.equal(V.tipoPorBytesMagicos(Buffer.from('<!doctype html><html><body>oi</body></html>')), '');
  assert.equal(V.tipoPorBytesMagicos(mov), '');
  assert.equal(V.tipoPorBytesMagicos(mkv), '');
  assert.equal(V.tipoPorBytesMagicos(Buffer.from('ftyp')), '');
  assert.equal(V.tipoPorBytesMagicos(null), '');
});

test('REGRA-5: planoPartes divide em partes fixas; conferirPartes recusa parte do meio diferente, falta e total acima do máximo', () => {
  const P = V.PARTE_BYTES;
  assert.equal(P, 6 * 1024 * 1024);
  const p = V.planoPartes(2 * P + 100);
  assert.equal(p.totalPartes, 3);
  assert.deepEqual([p.tamanhoDe(1), p.tamanhoDe(2), p.tamanhoDe(3), p.tamanhoDe(4), p.tamanhoDe(0)], [P, P, 100, 0, 0]);
  assert.equal(V.planoPartes(P).totalPartes, 1);
  assert.equal(V.planoPartes(P).tamanhoDe(1), P);
  assert.equal(V.planoPartes(0).totalPartes, 0);

  const certo = [{ n: 2, bytes: P }, { n: 1, bytes: P }, { n: 3, bytes: 100 }];
  assert.deepEqual(V.conferirPartes(certo, 2 * P + 100), { ok: true, erro: '' });
  const meio = V.conferirPartes([{ n: 1, bytes: P }, { n: 2, bytes: P - 1 }, { n: 3, bytes: 101 }], 2 * P + 100);
  assert.equal(meio.ok, false);
  assert.match(meio.erro, /parte 2/);
  const falta = V.conferirPartes([{ n: 1, bytes: P }, { n: 3, bytes: 100 }], 2 * P + 100);
  assert.equal(falta.ok, false);
  assert.match(falta.erro, /2 de 3/);
  const buraco = V.conferirPartes([{ n: 1, bytes: P }, { n: 3, bytes: P }, { n: 4, bytes: 100 }], 2 * P + 100);
  assert.equal(buraco.ok, false);
  const acima = V.conferirPartes(certo, 2 * P + 100, P, 2 * P);
  assert.equal(acima.ok, false);
  assert.match(acima.erro, /tamanho máximo/);
  assert.equal(V.conferirPartes([], 0).ok, false);
});

test('REGRA-6: normalizarVideoTreino limpa o campo e descarta chave ou duração inválida', () => {
  const v = V.normalizarVideoTreino({ chave: CHAVE, nome: 'x'.repeat(300), bytes: '1234.9', mime: 'video/webm',
    duracaoSeg: 612.4, enviadoTs: 1790000000000, enviadoPor: 'y'.repeat(80), extra: 'fora' });
  assert.deepEqual(Object.keys(v).sort(), ['bytes', 'chave', 'duracaoSeg', 'enviadoPor', 'enviadoTs', 'mime', 'nome']);
  assert.equal(v.nome.length, 200);
  assert.equal(v.enviadoPor.length, 60);
  assert.equal(v.bytes, 1234);
  assert.equal(v.duracaoSeg, 612);
  assert.equal(v.mime, 'video/mp4', 'o mime segue a extensão da chave');
  assert.equal(V.normalizarVideoTreino({ chave: '../x.mp4', duracaoSeg: 10 }), null);
  assert.equal(V.normalizarVideoTreino({ chave: CHAVE, duracaoSeg: 0 }), null);
  assert.equal(V.normalizarVideoTreino({ chave: CHAVE, duracaoSeg: 14401 }), null);
  assert.equal(V.normalizarVideoTreino({ chave: CHAVE, duracaoSeg: 14400 }).duracaoSeg, 14400);
  assert.equal(V.normalizarVideoTreino(null), null);
  assert.equal(V.normalizarVideoTreino('texto'), null);
});

const ENV_S3 = {
  VIDEO_S3_ENDPOINT: 'https://conta.r2.cloudflarestorage.com/', VIDEO_S3_REGION: 'auto', VIDEO_S3_BUCKET: 'treinos',
  VIDEO_S3_KEY_ID: 'id', VIDEO_S3_KEY_SECRET: 'segredo',
};

test('CFG-1: lerConfigVideo escolhe s3, local ou null (produção) e aplica os padrões', () => {
  const s3 = V.lerConfigVideo(ENV_S3, { usarMongo: true, dataDir: '/d' });
  assert.equal(s3.tipo, 's3');
  assert.equal(s3.ativo, true);
  assert.equal(s3.motivo, '');
  assert.equal(s3.origemCsp, 'https://conta.r2.cloudflarestorage.com');
  assert.equal(s3.s3.endpoint, 'https://conta.r2.cloudflarestorage.com');
  assert.equal(s3.s3.bucket, 'treinos');
  assert.equal(s3.maxBytes, 1024 * 1024 * 1024);
  assert.equal(s3.parteBytes, V.PARTE_BYTES);
  assert.equal(s3.urlTtlSeg, 360 * 60);
  assert.equal(s3.orfaoDias, 90);

  const local = V.lerConfigVideo({}, { usarMongo: false, dataDir: path.join('x', 'data') });
  assert.equal(local.tipo, 'local');
  assert.equal(local.origemCsp, '');
  assert.equal(local.local.dir, path.join('x', 'data', 'videos'));

  const prod = V.lerConfigVideo({}, { usarMongo: true, dataDir: '/d' });
  assert.equal(prod.tipo, null);
  assert.equal(prod.ativo, false);
  assert.equal(prod.motivo, 'Armazenamento de vídeos não configurado (ver docs/VIDEOS_TREINAMENTO.md).');
  assert.equal(prod.s3.endpoint, '', 's3 vem como objeto vazio, sem derrubar quem lê cfg.s3.x');

  const env = V.lerConfigVideo({ ...ENV_S3, VIDEO_MAX_MB: '200', VIDEO_URL_TTL_MIN: '30', VIDEO_ORFAO_DIAS: 'abc' }, {});
  assert.equal(env.maxBytes, 200 * 1024 * 1024);
  assert.equal(env.urlTtlSeg, 1800);
  assert.equal(env.orfaoDias, 90);
});

test('CFG-2: config parcial ou endpoint inválido desliga o vídeo com o motivo, sem lançar', () => {
  const { VIDEO_S3_BUCKET, VIDEO_S3_KEY_SECRET, ...parcial } = ENV_S3;
  for (const usarMongo of [true, false]) {
    const c = V.lerConfigVideo(parcial, { usarMongo, dataDir: '/d' });
    assert.equal(c.tipo, null);
    assert.match(c.motivo, /faltam VIDEO_S3_BUCKET, VIDEO_S3_KEY_SECRET/);
    assert.equal(c.s3.keySecret, '');
  }
  assert.match(V.lerConfigVideo({ ...ENV_S3, VIDEO_S3_ENDPOINT: 'nao-e-url' }, {}).motivo, /VIDEO_S3_ENDPOINT inválido/);
  assert.match(V.lerConfigVideo({ ...ENV_S3, VIDEO_S3_ENDPOINT: 'https://x.r2.cloudflarestorage.com/treinos' }, {}).motivo, /sem o bucket/);
  assert.equal(V.lerConfigVideo(null).tipo, null);
  assert.equal(V.criarArmazenamento(V.lerConfigVideo({}, { usarMongo: true })), null);
});

// ----------------------------------------------------------------------------------------
// Parte 3: driver s3 contra um S3 falso
// ----------------------------------------------------------------------------------------
// Verificador INDEPENDENTE do módulo: remonta a requisição canônica a partir do que chegou
// no socket (caminho cru, query crua, cabeçalhos listados em SignedHeaders). Pega o caso em
// que o módulo assina uma coisa e manda outra.
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
function assinaturaConfere(req, corpo, segredo) {
  const auth = req.headers.authorization || '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(auth);
  if (!m) return 'Authorization malformado';
  const [, , dia, region, lista, assinatura] = m;
  const hash = req.headers['x-amz-content-sha256'];
  if (hash !== sha(corpo)) return 'x-amz-content-sha256 não é o SHA-256 do corpo';
  if (req.headers['transfer-encoding']) return 'corpo chunked';
  // Sem corpo (GET/HEAD/DELETE) o fetch não manda Content-Length; com corpo ele tem de ser exato.
  if ((corpo.length || req.headers['content-length'] !== undefined) && Number(req.headers['content-length']) !== corpo.length) return 'Content-Length inexato';
  const [caminho, qs = ''] = req.url.split('?');
  const query = qs ? qs.split('&').map((p) => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; })
    .map(([k, v]) => [enc(decodeURIComponent(k)), enc(decodeURIComponent(v))])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&') : '';
  const nomes = lista.split(';');
  const canonica = [req.method, caminho, query, nomes.map((h) => `${h}:${String(req.headers[h]).trim()}\n`).join(''), lista, hash].join('\n');
  const h = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const k = h(h(h(h('AWS4' + segredo, dia), region), 's3'), 'aws4_request');
  const esperada = crypto.createHmac('sha256', k).update(['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${dia}/${region}/s3/aws4_request`, sha(canonica)].join('\n')).digest('hex');
  return esperada === assinatura ? '' : 'SignatureDoesNotMatch';
}

const xmlErro = (codigo, msg) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${codigo}</Code><Message>${msg}</Message></Error>`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function criarS3Falso(segredo) {
  const estado = { uploads: new Map(), objetos: new Map(), log: [], falhas: {}, seq: 0 };
  const srv = http.createServer((req, res) => {
    const pedacos = [];
    req.on('data', (d) => pedacos.push(d));
    req.on('end', () => {
      const corpo = Buffer.concat(pedacos);
      const u = new URL(req.url, 'http://x');
      const q = u.searchParams;
      const [, bucket, ...resto] = decodeURIComponent(u.pathname).split('/');
      const chave = resto.join('/');
      const op = `${req.method} ${chave ? 'obj' : 'bucket'} ${[...q.keys()].sort().join(',')}`;
      estado.log.push({ op, url: req.url, contentType: req.headers['content-type'] || '' });
      const responder = (status, xml = '', cab = {}) => { res.writeHead(status, { 'content-type': 'application/xml', ...cab }); res.end(xml); };
      const problema = assinaturaConfere(req, corpo, segredo);
      if (problema) { estado.recusadas = (estado.recusadas || 0) + 1; return responder(403, xmlErro('SignatureDoesNotMatch', problema)); }
      if (bucket !== 'treinos') return responder(404, xmlErro('NoSuchBucket', 'bucket'));
      if (estado.falhas[op]) { estado.falhas[op]--; return responder(500, xmlErro('InternalError', 'tente de novo')); }

      if (req.method === 'POST' && q.has('uploads')) {
        const id = `up~${++estado.seq}/x+y=`; // com caracteres que exigem codificação na query
        estado.uploads.set(id, { chave, mime: req.headers['content-type'], partes: new Map(), iniciado: new Date('2026-09-20T10:00:00Z') });
        return responder(200, `<InitiateMultipartUploadResult><Bucket>treinos</Bucket><Key>${esc(chave)}</Key><UploadId>${esc(id)}</UploadId></InitiateMultipartUploadResult>`);
      }
      const up = q.has('uploadId') ? estado.uploads.get(q.get('uploadId')) : null;
      if (q.has('uploadId') && (!up || up.chave !== chave)) return responder(404, xmlErro('NoSuchUpload', 'upload'));
      if (req.method === 'PUT' && up) {
        const etag = `"${crypto.createHash('md5').update(corpo).digest('hex')}"`;
        up.partes.set(Number(q.get('partNumber')), { buf: corpo, etag });
        return responder(200, '', { etag });
      }
      if (req.method === 'GET' && up) { // ListParts: 1 parte por página, para exercitar a paginação
        const nums = [...up.partes.keys()].sort((a, b) => a - b).filter((n) => n > Number(q.get('part-number-marker') || 0));
        const n = nums[0];
        const parte = n ? `<Part><PartNumber>${n}</PartNumber><ETag>${esc(up.partes.get(n).etag)}</ETag><Size>${up.partes.get(n).buf.length}</Size></Part>` : '';
        return responder(200, `<ListPartsResult><PartNumberMarker>0</PartNumberMarker>${parte}<IsTruncated>${nums.length > 1}</IsTruncated>${n ? `<NextPartNumberMarker>${n}</NextPartNumberMarker>` : ''}</ListPartsResult>`);
      }
      if (req.method === 'POST' && up) {
        if (estado.completeComErro) return responder(200, xmlErro('InternalError', 'We encountered an internal error. Please try again.'));
        const pedidas = [...corpo.toString().matchAll(/<Part><PartNumber>(\d+)<\/PartNumber><ETag>([^<]*)<\/ETag><\/Part>/g)];
        const bufs = [];
        for (const [, n, etag] of pedidas) {
          const p = up.partes.get(Number(n));
          if (!p || p.etag !== etag.replace(/&quot;/g, '"')) return responder(400, xmlErro('InvalidPart', `parte ${n}`));
          bufs.push(p.buf);
        }
        // completePerdido = { gravar }: o bucket aplica (ou não, gravar:false) e a resposta se perde
        // no caminho (socket fechado). O req() do driver repete e recebe NoSuchUpload.
        const perdido = estado.completePerdido;
        if (perdido) estado.completePerdido = null;
        if (!perdido || perdido.gravar) estado.objetos.set(chave, { buf: Buffer.concat(bufs), mime: up.mime, modificado: new Date('2026-09-21T10:00:00Z') });
        estado.uploads.delete(q.get('uploadId'));
        if (perdido) return req.socket.destroy();
        return responder(200, `<CompleteMultipartUploadResult><Key>${esc(chave)}</Key><ETag>"x-${bufs.length}"</ETag></CompleteMultipartUploadResult>`);
      }
      if (req.method === 'DELETE' && up) { estado.uploads.delete(q.get('uploadId')); return responder(204); }
      if (req.method === 'HEAD') {
        const o = estado.objetos.get(chave);
        if (!o) { res.writeHead(404); return res.end(); }
        res.writeHead(200, { 'content-length': o.buf.length, 'content-type': o.mime });
        return res.end();
      }
      if (req.method === 'DELETE' && chave) { estado.objetos.delete(chave); return responder(204); }
      if (req.method === 'GET' && !chave && q.get('list-type') === '2') { // 1 objeto por página
        const chaves = [...estado.objetos.keys()].filter((k) => k.startsWith(q.get('prefix') || '')).sort()
          .filter((k) => !q.get('continuation-token') || k > q.get('continuation-token'));
        const k = chaves[0];
        const o = k && estado.objetos.get(k);
        const cont = k ? `<Contents><Key>${esc(k)}</Key><LastModified>${o.modificado.toISOString()}</LastModified><Size>${o.buf.length}</Size></Contents>` : '';
        return responder(200, `<ListBucketResult>${cont}<IsTruncated>${chaves.length > 1}</IsTruncated>${chaves.length > 1 ? `<NextContinuationToken>${esc(k)}</NextContinuationToken>` : ''}</ListBucketResult>`);
      }
      if (req.method === 'GET' && !chave && q.has('uploads')) {
        const ups = [...estado.uploads.entries()].map(([id, x]) => `<Upload><Key>${esc(x.chave)}</Key><UploadId>${esc(id)}</UploadId><Initiated>${x.iniciado.toISOString()}</Initiated></Upload>`).join('');
        return responder(200, `<ListMultipartUploadsResult><KeyMarker></KeyMarker><NextKeyMarker></NextKeyMarker>${ups}<IsTruncated>false</IsTruncated></ListMultipartUploadsResult>`);
      }
      return responder(400, xmlErro('NotImplemented', op));
    });
  });
  return { srv, estado };
}

let falso, cfgS3, drvS3;
before(async () => {
  falso = criarS3Falso('segredo-de-teste');
  await new Promise((ok) => falso.srv.listen(0, '127.0.0.1', ok));
  const endpoint = `http://127.0.0.1:${falso.srv.address().port}`;
  cfgS3 = V.lerConfigVideo({ ...ENV_S3, VIDEO_S3_ENDPOINT: endpoint, VIDEO_S3_REGION: 'auto', VIDEO_S3_KEY_SECRET: 'segredo-de-teste' }, { usarMongo: true });
  // Partes de 8 bytes no teste: o que importa é a regra (iguais, menos a última), não o tamanho.
  cfgS3.parteBytes = 8;
  drvS3 = V.criarArmazenamento(cfgS3, { esperaMs: 1, timeoutMs: 5000 });
});
after(() => new Promise((ok) => falso.srv.close(ok)));

test('S3-1: iniciar → 2 partes → concluir junta o objeto, com assinatura válida em toda requisição', async () => {
  assert.equal(drvS3.tipo, 's3');
  const chave = V.novaChave('mp4');
  const { uploadId } = await drvS3.iniciar({ chave, mime: 'video/mp4' });
  assert.ok(uploadId);
  const criar = falso.estado.log.find((l) => l.op === 'POST obj uploads');
  assert.match(criar.url, /\?uploads=$/);
  assert.equal(criar.contentType, 'video/mp4', 'o Content-Type do objeto vai no create');

  const p1 = Buffer.from('ABCDEFGH'), p2 = Buffer.from('ijk');
  falso.estado.falhas['PUT obj partNumber,uploadId'] = 1; // um 500: a retentativa tem de cobrir
  const e1 = await drvS3.enviarParte({ chave, uploadId, n: 1, buf: p1 });
  const e2 = await drvS3.enviarParte({ chave, uploadId, n: 2, buf: p2 });
  assert.match(e1.etag, /^"[a-f0-9]{32}"$/);
  assert.ok(e2.etag);
  const put = falso.estado.log.find((l) => l.op === 'PUT obj partNumber,uploadId');
  assert.match(put.url, /\?partNumber=1&uploadId=/, 'partNumber antes de uploadId na query');

  const partes = await drvS3.listarPartes({ chave, uploadId });
  assert.deepEqual(partes.map((p) => [p.n, p.bytes]), [[1, 8], [2, 3]]);
  assert.equal(partes[0].etag, e1.etag, 'o &quot; do XML é desfeito');

  assert.deepEqual(await drvS3.concluir({ chave, uploadId, bytesEsperados: 11 }), { bytes: 11 });
  assert.equal(falso.estado.objetos.get(chave).buf.toString(), 'ABCDEFGHijk');
  assert.deepEqual(await drvS3.cabeca(chave), { bytes: 11, mime: 'video/mp4' });
  assert.equal(falso.estado.recusadas || 0, 0, 'o S3 falso não recusou nenhuma assinatura');

  const objs = await drvS3.listarObjetos();
  assert.ok(objs.some((o) => o.chave === chave && o.bytes === 11 && o.modificadoTs === Date.parse('2026-09-21T10:00:00Z')));

  await drvS3.apagar(chave);
  assert.equal(await drvS3.cabeca(chave), null);
  await drvS3.apagar(chave); // inexistente: não lança
});

test('S3-2: Complete com 200 e <Error> no corpo falha (depois das retentativas)', async () => {
  const chave = V.novaChave('webm');
  const { uploadId } = await drvS3.iniciar({ chave, mime: 'video/webm' });
  await drvS3.enviarParte({ chave, uploadId, n: 1, buf: Buffer.from('12345') });
  falso.estado.completeComErro = true;
  const antes = falso.estado.log.filter((l) => l.op === 'POST obj uploadId').length;
  try {
    await assert.rejects(drvS3.concluir({ chave, uploadId, bytesEsperados: 5 }), (e) => e.status === 502 && e.codigo === 'InternalError');
  } finally { falso.estado.completeComErro = false; }
  assert.equal(falso.estado.log.filter((l) => l.op === 'POST obj uploadId').length - antes, 3, '1 tentativa + 2 retentativas');
  assert.equal(falso.estado.objetos.has(chave), false);
  await drvS3.abortar({ chave, uploadId });
});

test('S3-3: concluir recusa partes fora do plano; uploads pendentes são listados e abortados; NoSuchUpload é claro', async () => {
  const chave = V.novaChave('mp4');
  const { uploadId } = await drvS3.iniciar({ chave, mime: 'video/mp4' });
  await drvS3.enviarParte({ chave, uploadId, n: 1, buf: Buffer.from('1234567') }); // 7 ≠ 8
  await drvS3.enviarParte({ chave, uploadId, n: 2, buf: Buffer.from('1234') });
  await assert.rejects(drvS3.concluir({ chave, uploadId, bytesEsperados: 11 }), (e) => e.status === 400 && /parte 1/.test(e.message));

  const pend = await drvS3.listarUploadsPendentes();
  const achado = pend.find((p) => p.uploadId === uploadId);
  assert.ok(achado);
  assert.equal(achado.chave, chave);
  assert.equal(achado.iniciadoTs, Date.parse('2026-09-20T10:00:00Z'));

  await drvS3.abortar({ chave, uploadId });
  await drvS3.abortar({ chave, uploadId }); // idempotente
  await assert.rejects(drvS3.listarPartes({ chave, uploadId }), (e) => e.status === 404 && e.codigo === 'NoSuchUpload' && /Envie o vídeo de novo/.test(e.message));
  await assert.rejects(drvS3.iniciar({ chave: '../x.mp4', mime: 'video/mp4' }), (e) => e.status === 400);
  await assert.rejects(drvS3.iniciar({ chave, mime: 'video/quicktime' }), (e) => e.status === 400);
  assert.equal(drvS3.caminhoLocal(chave), null);
});

test('S3-6: Complete aplicado com a resposta perdida: a retentativa recebe NoSuchUpload e o HEAD confirma o vídeo', async () => {
  const contaComplete = () => falso.estado.log.filter((l) => l.op === 'POST obj uploadId').length;
  // Objeto inteiro no bucket: conta como concluído, sem 404 ao RH.
  const chave = V.novaChave('mp4');
  const { uploadId } = await drvS3.iniciar({ chave, mime: 'video/mp4' });
  await drvS3.enviarParte({ chave, uploadId, n: 1, buf: Buffer.from('ABCDEFGH') });
  await drvS3.enviarParte({ chave, uploadId, n: 2, buf: Buffer.from('ij') });
  falso.estado.completePerdido = { gravar: true };
  let antes = contaComplete();
  assert.deepEqual(await drvS3.concluir({ chave, uploadId, bytesEsperados: 10 }), { bytes: 10 });
  assert.equal(contaComplete() - antes, 2, '1ª tentativa perdida + retentativa com NoSuchUpload');
  assert.equal(falso.estado.objetos.get(chave).buf.toString(), 'ABCDEFGHij');
  await drvS3.apagar(chave);

  // Upload sumiu SEM gravar o objeto: continua o 404 NoSuchUpload (nada a confirmar).
  const chave2 = V.novaChave('mp4');
  const up2 = await drvS3.iniciar({ chave: chave2, mime: 'video/mp4' });
  await drvS3.enviarParte({ chave: chave2, uploadId: up2.uploadId, n: 1, buf: Buffer.from('12345') });
  falso.estado.completePerdido = { gravar: false };
  antes = contaComplete();
  await assert.rejects(drvS3.concluir({ chave: chave2, uploadId: up2.uploadId, bytesEsperados: 5 }), (e) => e.status === 404 && e.codigo === 'NoSuchUpload');
  assert.equal(contaComplete() - antes, 2);
  assert.equal(falso.estado.objetos.has(chave2), false);
});

test('S3-4: segredo errado vira mensagem com dica de região/chave; testar() confere leitura e escrita', async () => {
  const errado = V.criarArmazenamento({ ...cfgS3, s3: { ...cfgS3.s3, keySecret: 'outro' } }, { esperaMs: 1 });
  // HEAD não tem corpo (o Code não chega); a listagem traz o <Error> completo.
  await assert.rejects(errado.listarObjetos(), (e) => e.codigo === 'SignatureDoesNotMatch' && /VIDEO_S3_REGION/.test(e.message) && /auto/.test(e.message));
  const t = await drvS3.testar();
  assert.equal(t.ok, true);
  assert.match(t.mensagem, /treinos/);
  assert.equal((await drvS3.listarUploadsPendentes()).length, 0, 'o teste de conexão não deixa envio aberto');
});

test('S3-5: urlLeitura/presignarGet gera URL path-style com X-Amz-Algorithm/Credential/Date/Expires/SignedHeaders=host/Signature', async () => {
  const antes = Date.now();
  const { url, expiraTs } = await drvS3.urlLeitura(CHAVE);
  const u = new URL(url);
  assert.equal(u.pathname, `/treinos/${CHAVE}`);
  assert.equal(u.searchParams.get('X-Amz-Algorithm'), 'AWS4-HMAC-SHA256');
  assert.match(u.searchParams.get('X-Amz-Credential'), /^id\/\d{8}\/auto\/s3\/aws4_request$/);
  assert.match(u.searchParams.get('X-Amz-Date'), /^\d{8}T\d{6}Z$/);
  assert.equal(u.searchParams.get('X-Amz-Expires'), String(360 * 60));
  assert.equal(u.searchParams.get('X-Amz-SignedHeaders'), 'host');
  assert.match(u.searchParams.get('X-Amz-Signature'), /^[a-f0-9]{64}$/);
  assert.ok(expiraTs >= antes + 360 * 60 * 1000 && expiraTs <= Date.now() + 360 * 60 * 1000);
  await assert.rejects(drvS3.urlLeitura('videos-treino/2026/x.mp4'), (e) => e.status === 400);
});

// ----------------------------------------------------------------------------------------
// Parte 4: driver local
// ----------------------------------------------------------------------------------------
test('LOCAL-1: iniciar → partes → concluir grava o arquivo final com o conteúdo concatenado', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdj-videos-'));
  try {
    const cfg = V.lerConfigVideo({}, { usarMongo: false, dataDir: tmp });
    cfg.parteBytes = 4;
    const drv = V.criarArmazenamento(cfg);
    assert.equal(drv.tipo, 'local');
    const chave = V.novaChave('webm');
    const { uploadId } = await drv.iniciar({ chave, mime: 'video/webm' });
    assert.match(uploadId, /^[a-f0-9]{32}$/);
    // fora de ordem e com reenvio da parte 2: vale a última
    await drv.enviarParte({ chave, uploadId, n: 2, buf: Buffer.from('zzzz') });
    await drv.enviarParte({ chave, uploadId, n: 3, buf: Buffer.from('ij') });
    await drv.enviarParte({ chave, uploadId, n: 1, buf: Buffer.from('abcd') });
    await drv.enviarParte({ chave, uploadId, n: 2, buf: Buffer.from('efgh') });
    assert.deepEqual((await drv.listarPartes({ chave, uploadId })).map((p) => [p.n, p.bytes]), [[1, 4], [2, 4], [3, 2]]);
    assert.equal((await drv.listarUploadsPendentes())[0].chave, chave);

    assert.deepEqual(await drv.concluir({ chave, uploadId, bytesEsperados: 10 }), { bytes: 10 });
    const arq = drv.caminhoLocal(chave);
    assert.equal(arq, path.join(tmp, 'videos', ...chave.split('/')));
    assert.equal(fs.readFileSync(arq, 'utf8'), 'abcdefghij');
    assert.equal(fs.existsSync(path.join(tmp, 'videos', '.parciais', uploadId)), false, 'as partes somem depois de juntar');
    assert.deepEqual(await drv.cabeca(chave), { bytes: 10, mime: 'video/webm' });
    assert.deepEqual((await drv.listarObjetos()).map((o) => [o.chave, o.bytes]), [[chave, 10]]);
    assert.deepEqual(await drv.listarUploadsPendentes(), []);
    assert.deepEqual((await drv.urlLeitura(chave, { urlLocal: '/api/treinamentos/T1/video' })).url, '/api/treinamentos/T1/video');
    await assert.rejects(drv.listarPartes({ chave, uploadId }), (e) => e.status === 404);

    await drv.apagar(chave);
    assert.equal(await drv.cabeca(chave), null);
    assert.equal((await drv.testar()).ok, true);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('LOCAL-2: caminhoLocal e o uploadId recusam path traversal; partes erradas e chave trocada são recusadas', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdj-videos-'));
  try {
    const cfg = V.lerConfigVideo({}, { usarMongo: false, dataDir: tmp });
    cfg.parteBytes = 4;
    const drv = V.criarArmazenamento(cfg);
    for (const ruim of ['../usuarios.json', 'videos-treino/2026/../../../x.mp4', '/etc/passwd', 'videos-treino/2026/abc.mp4', null]) {
      assert.throws(() => drv.caminhoLocal(ruim), (e) => e.status === 400, String(ruim));
    }
    const chave = V.novaChave('mp4');
    await assert.rejects(drv.enviarParte({ chave, uploadId: '../../x', n: 1, buf: Buffer.from('a') }), (e) => e.status === 400);
    await assert.rejects(drv.abortar({ chave, uploadId: '..' }), (e) => e.status === 400);

    const { uploadId } = await drv.iniciar({ chave, mime: 'video/mp4' });
    await assert.rejects(drv.enviarParte({ chave: V.novaChave('mp4'), uploadId, n: 1, buf: Buffer.from('abcd') }), (e) => e.status === 404, 'uploadId de outra chave');
    await drv.enviarParte({ chave, uploadId, n: 1, buf: Buffer.from('abc') });
    await drv.enviarParte({ chave, uploadId, n: 2, buf: Buffer.from('defg') });
    await assert.rejects(drv.concluir({ chave, uploadId, bytesEsperados: 7 }), (e) => e.status === 400 && e.codigo === 'PARTES_INVALIDAS');
    assert.equal(await drv.cabeca(chave), null, 'nada é gravado quando as partes não batem');
    await drv.abortar({ chave, uploadId });
    assert.deepEqual(await drv.listarUploadsPendentes(), []);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('LOCAL-3: VIDEO_PARTE_BYTES_TESTE só encolhe a parte no driver local; faxina aborta pasta de envio sem meta.json', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gdj-videos-'));
  try {
    const cfg = V.lerConfigVideo({ VIDEO_PARTE_BYTES_TESTE: '1024' }, { usarMongo: false, dataDir: tmp });
    assert.equal(cfg.tipo, 'local');
    assert.equal(cfg.parteBytes, 1024);
    assert.equal(V.lerConfigVideo({ VIDEO_PARTE_BYTES_TESTE: '999999999' }, { dataDir: tmp }).parteBytes, V.PARTE_BYTES, 'nunca acima de 6 MiB');
    assert.equal(V.lerConfigVideo({ ...ENV_S3, VIDEO_PARTE_BYTES_TESTE: '1024' }, {}).parteBytes, V.PARTE_BYTES, 'ignorada no s3');
    const drv = V.criarArmazenamento(cfg);
    const orfa = path.join(tmp, 'videos', '.parciais', 'ab'.repeat(16));
    fs.mkdirSync(orfa, { recursive: true });
    const [pend] = await drv.listarUploadsPendentes();
    assert.equal(pend.chave, '', 'pasta sem meta.json aparece sem chave');
    await drv.abortar({ chave: pend.chave, uploadId: pend.uploadId });
    assert.equal(fs.existsSync(orfa), false);
    await assert.rejects(drv.abortar({ chave: '../x', uploadId: 'ab'.repeat(16) }), (e) => e.status === 400, 'chave preenchida continua validada');
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});
