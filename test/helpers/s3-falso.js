/**
 * S3 FALSO para os testes do cofre de arquivos (backend/cofre-midia.js): um http.createServer
 * que guarda objetos em memória e RECUSA qualquer requisição cuja assinatura SigV4 não bata.
 * O verificador remonta a requisição canônica a partir do que chegou no socket (caminho cru,
 * query crua, cabeçalhos listados em SignedHeaders), independente do módulo testado — pega o
 * caso em que o módulo assina uma coisa e manda outra. Mesma técnica do S3 falso de
 * test/videos-treino.test.js, com o que o cofre usa: PUT/GET/HEAD/DELETE de objeto com
 * metadados x-amz-meta-* e ListObjectsV2 (2 objetos por página, para exercitar a paginação).
 *
 * Não é um teste: o `node --test` também executa este arquivo (ele está dentro de test/), e ele
 * só exporta a fábrica.
 *
 * USO:
 *   const { criarS3Falso } = require('./helpers/s3-falso');
 *   const falso = criarS3Falso({ segredo: 'segredo-de-teste', bucket: 'arquivos' });
 *   await new Promise((ok) => falso.srv.listen(0, '127.0.0.1', ok));
 *   const endpoint = `http://127.0.0.1:${falso.srv.address().port}`;
 *   falso.estado.objetos          // Map chave → { buf, tipo, meta: {nome, ts, sha256}, modificado: Date }
 *   falso.estado.falhas['GET obj'] = 2;   // as 2 próximas leituras de objeto respondem 500
 *   falso.estado.fora = true;             // tudo responde 503 até voltar a false
 */
'use strict';
const crypto = require('node:crypto');
const http = require('node:http');

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function assinaturaConfere(req, corpo, segredo) {
  const auth = req.headers.authorization || '';
  const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([a-f0-9]{64})$/.exec(auth);
  if (!m) return 'Authorization malformado';
  const [, , dia, region, lista, assinatura] = m;
  const hash = req.headers['x-amz-content-sha256'];
  if (hash !== sha(corpo)) return 'x-amz-content-sha256 não é o SHA-256 do corpo';
  if (req.headers['transfer-encoding']) return 'corpo chunked';
  if ((corpo.length || req.headers['content-length'] !== undefined) && Number(req.headers['content-length']) !== corpo.length) return 'Content-Length inexato';
  const nomes = lista.split(';');
  // Todo x-amz-* enviado tem de estar assinado (o S3 de verdade recusa o que não estiver).
  for (const h of Object.keys(req.headers)) if (h.startsWith('x-amz-') && !nomes.includes(h)) return `cabeçalho ${h} fora da assinatura`;
  const [caminho, qs = ''] = req.url.split('?');
  const query = qs ? qs.split('&').map((p) => { const i = p.indexOf('='); return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]; })
    .map(([k, v]) => [enc(decodeURIComponent(k)), enc(decodeURIComponent(v))])
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&') : '';
  const canonica = [req.method, caminho, query, nomes.map((h) => `${h}:${String(req.headers[h]).trim()}\n`).join(''), lista, hash].join('\n');
  const h = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const k = h(h(h(h('AWS4' + segredo, dia), region), 's3'), 'aws4_request');
  const esperada = crypto.createHmac('sha256', k).update(['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${dia}/${region}/s3/aws4_request`, sha(canonica)].join('\n')).digest('hex');
  return esperada === assinatura ? '' : 'SignatureDoesNotMatch';
}

const xmlErro = (codigo, msg) => `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${codigo}</Code><Message>${msg}</Message></Error>`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function criarS3Falso({ segredo = 'segredo-de-teste', bucket: nomeBucket = 'arquivos', porPagina = 2 } = {}) {
  const estado = { objetos: new Map(), log: [], falhas: {}, recusadas: 0, fora: false };
  const srv = http.createServer((req, res) => {
    const pedacos = [];
    req.on('data', (d) => pedacos.push(d));
    req.on('end', () => {
      const corpo = Buffer.concat(pedacos);
      const u = new URL(req.url, 'http://x');
      const q = u.searchParams;
      const [, bucket, ...resto] = decodeURIComponent(u.pathname).split('/');
      const chave = resto.join('/');
      const op = `${req.method} ${chave ? 'obj' : 'bucket'}`;
      estado.log.push({ op, chave, url: req.url });
      const responder = (status, xml = '', cab = {}) => { res.writeHead(status, { 'content-type': 'application/xml', ...cab }); res.end(xml); };
      if (estado.fora) return responder(503, xmlErro('ServiceUnavailable', 'fora do ar'));
      const problema = assinaturaConfere(req, corpo, segredo);
      if (problema) { estado.recusadas++; return responder(403, xmlErro('SignatureDoesNotMatch', problema)); }
      if (bucket !== nomeBucket) return responder(404, xmlErro('NoSuchBucket', 'bucket'));
      if (estado.falhas[op]) { estado.falhas[op]--; return responder(500, xmlErro('InternalError', 'tente de novo')); }

      if (req.method === 'PUT' && chave) {
        estado.objetos.set(chave, {
          buf: corpo, tipo: req.headers['content-type'] || 'application/octet-stream',
          meta: { nome: req.headers['x-amz-meta-nome'] || '', ts: req.headers['x-amz-meta-ts'] || '', sha256: req.headers['x-amz-meta-sha256'] || '' },
          modificado: new Date(),
        });
        return responder(200, '', { etag: `"${crypto.createHash('md5').update(corpo).digest('hex')}"` });
      }
      if ((req.method === 'GET' || req.method === 'HEAD') && chave) {
        const o = estado.objetos.get(chave);
        if (!o) {
          if (req.method === 'HEAD') { res.writeHead(404); return res.end(); }
          return responder(404, xmlErro('NoSuchKey', 'objeto'));
        }
        res.writeHead(200, {
          'content-type': o.tipo, 'content-length': o.buf.length,
          'x-amz-meta-nome': o.meta.nome, 'x-amz-meta-ts': o.meta.ts, 'x-amz-meta-sha256': o.meta.sha256,
        });
        return res.end(req.method === 'HEAD' ? undefined : o.buf);
      }
      if (req.method === 'DELETE' && chave) { estado.objetos.delete(chave); return responder(204); }
      if (req.method === 'GET' && !chave && q.get('list-type') === '2') {
        const todas = [...estado.objetos.keys()].filter((k) => k.startsWith(q.get('prefix') || '')).sort()
          .filter((k) => !q.get('continuation-token') || k > q.get('continuation-token'));
        const pagina = todas.slice(0, porPagina);
        const mais = todas.length > pagina.length;
        const cont = pagina.map((k) => { const o = estado.objetos.get(k); return `<Contents><Key>${esc(k)}</Key><LastModified>${o.modificado.toISOString()}</LastModified><Size>${o.buf.length}</Size></Contents>`; }).join('');
        return responder(200, `<ListBucketResult>${cont}<IsTruncated>${mais}</IsTruncated>${mais ? `<NextContinuationToken>${esc(pagina[pagina.length - 1])}</NextContinuationToken>` : ''}</ListBucketResult>`);
      }
      return responder(400, xmlErro('NotImplemented', op));
    });
  });
  return { srv, estado };
}

module.exports = { criarS3Falso, assinaturaConfere };
