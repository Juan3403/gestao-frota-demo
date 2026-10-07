/**
 * Cofre de arquivos no R2 (backend/cofre-midia.js) — regras puras e o driver contra um S3 FALSO
 * que confere a assinatura de cada requisição (test/helpers/s3-falso.js). Não sobe o servidor:
 * a integração com o server.js (upload, leitura de reserva no armazenamento antigo, Desfazer,
 * faxina e backup) fica em test/cofre-midia.test.js.
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../backend/cofre-midia');
const { criarS3Falso } = require('./helpers/s3-falso');

const VIDEO = { VIDEO_S3_ENDPOINT: 'https://conta.r2.cloudflarestorage.com', VIDEO_S3_REGION: 'auto', VIDEO_S3_KEY_ID: 'kv', VIDEO_S3_KEY_SECRET: 'sv' };

test('CR-CFG-1: sem MIDIA_S3_BUCKET o cofre fica desligado e sem erro; env solta sem o bucket é erro de configuração', () => {
  const nada = C.lerConfigCofre({ ...VIDEO });
  assert.equal(nada.ativo, false);
  assert.equal(nada.erro, false, 'não configurar é escolha, não erro');
  assert.equal(C.criarCofre(nada), null);
  const solta = C.lerConfigCofre({ MIDIA_S3_KEY_ID: 'k' });
  assert.equal(solta.ativo, false);
  assert.equal(solta.erro, true);
  assert.match(solta.motivo, /falta MIDIA_S3_BUCKET/);
});

test('CR-CFG-2: endpoint e região herdam dos vídeos; as CHAVES são sempre as do cofre; MIDIA_S3_* tem prioridade', () => {
  const herdado = C.lerConfigCofre({ ...VIDEO, MIDIA_S3_BUCKET: 'arquivos', MIDIA_S3_KEY_ID: 'km', MIDIA_S3_KEY_SECRET: 'sm' });
  assert.equal(herdado.ativo, true);
  assert.equal(herdado.credenciais, 'MIDIA_S3');
  assert.deepEqual(herdado.s3, { endpoint: 'https://conta.r2.cloudflarestorage.com', region: 'auto', bucket: 'arquivos', keyId: 'km', keySecret: 'sm' });
  const proprio = C.lerConfigCofre({ ...VIDEO, MIDIA_S3_BUCKET: 'arquivos', MIDIA_S3_KEY_ID: 'km', MIDIA_S3_KEY_SECRET: 'sm', MIDIA_S3_ENDPOINT: 'https://outra.r2.cloudflarestorage.com/' });
  assert.equal(proprio.s3.endpoint, 'https://outra.r2.cloudflarestorage.com', 'barra final sai');
  const semRegiao = C.lerConfigCofre({ MIDIA_S3_BUCKET: 'a', MIDIA_S3_ENDPOINT: 'https://c.r2.cloudflarestorage.com', MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 's' });
  assert.equal(semRegiao.s3.region, 'auto');
});

test('CR-CFG-3: só o bucket (com as chaves dos vídeos no ambiente) NÃO liga o R2 — o token dos vídeos não enxerga este bucket', () => {
  // Foi a armadilha da 1ª versão: herdar VIDEO_S3_KEY_* ligava o R2 com um token sem acesso,
  // e todo download de anexo (até os antigos) virava "cofre indisponível".
  const soBucket = C.lerConfigCofre({ ...VIDEO, MIDIA_S3_BUCKET: 'arquivos' });
  assert.equal(soBucket.ativo, false);
  assert.equal(soBucket.erro, true, 'tentou configurar: avisa alto');
  assert.match(soBucket.motivo, /MIDIA_S3_KEY_ID e MIDIA_S3_KEY_SECRET/);
  assert.equal(C.criarCofre(soBucket), null);
});

test('CR-CFG-4: chaves pela metade, endpoint inválido ou com bucket são recusados, sem citar credencial', () => {
  const metade = C.lerConfigCofre({ ...VIDEO, MIDIA_S3_BUCKET: 'a', MIDIA_S3_KEY_ID: 'km' });
  assert.equal(metade.ativo, false);
  assert.match(metade.motivo, /juntas/);
  const semCred = C.lerConfigCofre({ MIDIA_S3_BUCKET: 'a', MIDIA_S3_ENDPOINT: 'https://c.r2.cloudflarestorage.com' });
  assert.match(semCred.motivo, /Faltam as chaves/);
  assert.match(C.lerConfigCofre({ MIDIA_S3_BUCKET: 'a', MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 's' }).motivo, /Falta MIDIA_S3_ENDPOINT/);
  assert.match(C.lerConfigCofre({ MIDIA_S3_BUCKET: 'a', MIDIA_S3_ENDPOINT: 'c.r2', MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 's' }).motivo, /inválido/);
  assert.match(C.lerConfigCofre({ MIDIA_S3_BUCKET: 'a', MIDIA_S3_ENDPOINT: 'https://c.r2.cloudflarestorage.com/a', MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 's' }).motivo, /sem o bucket/);
  for (const c of [metade, semCred]) assert.doesNotMatch(c.motivo, /\bsv\b|\bkv\b/, 'a mensagem não cita credencial');
});

test('CR-CFG-5: modo local ignora as MIDIA_S3_* sem MIDIA_S3_LOCAL=1 (nunca o bucket de produção com a base de teste)', () => {
  const env = { MIDIA_S3_BUCKET: 'gestaorm-arquivos', MIDIA_S3_ENDPOINT: 'https://c.r2.cloudflarestorage.com', MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 's' };
  const local = C.lerConfigCofre(env, { usarMongo: false });
  assert.equal(local.ativo, false);
  assert.equal(local.erro, false, 'não é erro: é a trava');
  assert.match(local.motivo, /ignoradas no modo local/);
  assert.equal(C.lerConfigCofre({ ...env, MIDIA_S3_LOCAL: '1' }, { usarMongo: false }).ativo, true, 'com o opt-in liga (testes contra S3 falso)');
  assert.equal(C.lerConfigCofre(env, { usarMongo: true }).ativo, true, 'produção (Mongo) liga normalmente');
  assert.equal(C.lerConfigCofre(env).ativo, true, 'o padrão é o modo Mongo (os scripts de migração)');
});

test('CR-CFG-6: qualquer 4xx é configuração (menos 408/429); rede e 5xx são passageiros', () => {
  assert.equal(C.erroDeConfiguracao({ statusArmazenamento: 400, codigo: 'InvalidRegionName' }), true, 'região inválida');
  assert.equal(C.erroDeConfiguracao({ statusArmazenamento: 405 }), true, 'endpoint que não é a API S3 (r2.dev)');
  assert.equal(C.erroDeConfiguracao({ statusArmazenamento: 404, codigo: 'NoSuchBucket' }), true);
  assert.equal(C.erroDeConfiguracao({ codigo: 'AccessDenied' }), true);
  assert.equal(C.erroDeConfiguracao({ statusArmazenamento: 408 }), false);
  assert.equal(C.erroDeConfiguracao({ statusArmazenamento: 429 }), false);
  assert.equal(C.erroDeConfiguracao({ statusArmazenamento: 503 }), false);
  assert.equal(C.erroDeConfiguracao({ codigo: 'REDE' }), false);
  assert.equal(C.erroDeConfiguracao(null), false);
  // "Rede" que é configuração: host digitado errado (ENOTFOUND) ou certificado de outro host.
  assert.equal(C.erroDeConfiguracao({ codigo: 'REDE', causa: 'ENOTFOUND' }), true);
  assert.equal(C.erroDeConfiguracao({ codigo: 'REDE', causa: 'ERR_TLS_CERT_ALTNAME_INVALID' }), true);
  assert.equal(C.erroDeConfiguracao({ codigo: 'REDE', causa: 'EAI_AGAIN' }), false, 'DNS fora do ar é passageiro');
  assert.equal(C.erroDeConfiguracao({ codigo: 'REDE', causa: 'ECONNRESET' }), false);
});

test('CR-CFG-7: o driver guarda a causa do erro de rede; certificado errado não repete, ENOTFOUND repete (DNS tropeça)', async () => {
  const falhaCom = (code) => { const f = async () => { f.chamadas++; const e = new TypeError('fetch failed'); e.cause = Object.assign(new Error(code), { code }); throw e; }; f.chamadas = 0; return f; };
  const cfg = C.lerConfigCofre({ MIDIA_S3_BUCKET: 'a', MIDIA_S3_ENDPOINT: 'https://conta.r2.cloudflarestorage.co', MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 's' });
  const dns = falhaCom('ENOTFOUND');
  await assert.rejects(C.criarCofre(cfg, { fetch: dns, esperaMs: 1, retentativas: 2 }).testar(), (e) => e.codigo === 'REDE' && e.causa === 'ENOTFOUND' && /ENOTFOUND/.test(e.message) && C.erroDeConfiguracao(e));
  assert.equal(dns.chamadas, 3, 'ENOTFOUND pode ser de passagem: repete');
  const cert = falhaCom('ERR_TLS_CERT_ALTNAME_INVALID');
  await assert.rejects(C.criarCofre(cfg, { fetch: cert, esperaMs: 1, retentativas: 2 }).testar(), (e) => C.erroDeConfiguracao(e));
  assert.equal(cert.chamadas, 1, 'certificado de outro host não muda repetindo');
});

test('CR-DISP-1: só rede/prazo e 5xx indicam o R2 fora do ar; 4xx, configuração e lentidão não', () => {
  assert.equal(C.erroDeDisponibilidade({ codigo: 'REDE' }), true, 'prazo até os cabeçalhos / rede');
  assert.equal(C.erroDeDisponibilidade({ codigo: 'REDE', causa: 'ECONNRESET' }), true);
  assert.equal(C.erroDeDisponibilidade({ statusArmazenamento: 503 }), true);
  assert.equal(C.erroDeDisponibilidade({ codigo: 'REDE', causa: 'ENOTFOUND' }), false, 'endereço errado é configuração');
  assert.equal(C.erroDeDisponibilidade({ statusArmazenamento: 403, codigo: 'AccessDenied' }), false);
  assert.equal(C.erroDeDisponibilidade({ statusArmazenamento: 400 }), false, 'id esquisito de um usuário não pausa a leitura de todos');
  assert.equal(C.erroDeDisponibilidade({ codigo: 'LENTO' }), false, 'download lento: o R2 respondeu');
  assert.equal(C.erroDeDisponibilidade(null), false);
  // Id absurdo nem vira chave (não chega ao R2).
  assert.equal(C.chaveMidia('x'.repeat(201)), '');
  assert.equal(C.chaveMidia('x'.repeat(200)), 'midia/' + 'x'.repeat(200));
  assert.equal(C.validarChave('midia/' + 'x'.repeat(201)), false);
});

test('CR-DISP-2: prazo curto só até os cabeçalhos; o corpo tem prazo próprio e estourá-lo é LENTO, não REDE', async () => {
  const cfg = C.lerConfigCofre({ MIDIA_S3_BUCKET: 'a', MIDIA_S3_ENDPOINT: 'https://c.r2.cloudflarestorage.com', MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 's' });
  const esperaAbortar = (signal) => new Promise((_, nao) => signal.addEventListener('abort', () => nao(new Error('aborted'))));
  // Nunca responde: prazo dos cabeçalhos → REDE (disponibilidade).
  const mudo = async (url, o) => esperaAbortar(o.signal);
  await assert.rejects(C.criarCofre(cfg, { fetch: mudo, timeoutMs: 30, retentativas: 0 }).ler('midia/MD-1'), (e) => e.codigo === 'REDE' && C.erroDeDisponibilidade(e));
  // Responde os cabeçalhos rápido e manda o corpo devagar: o prazo curto NÃO derruba o download…
  const lentoMasChega = async () => ({ status: 200, headers: new Headers({ 'content-type': 'application/pdf' }), arrayBuffer: () => new Promise((ok) => setTimeout(() => ok(new ArrayBuffer(4)), 80)) });
  const m = await C.criarCofre(cfg, { fetch: lentoMasChega, timeoutMs: 30, timeoutCorpoMs: 1000, retentativas: 0 }).ler('midia/MD-1');
  assert.equal(m.buf.length, 4, 'o corpo que levou 80 ms passou com prazo de cabeçalho de 30 ms');
  // …e se nem o prazo do corpo basta, o erro é LENTO (não conta para o disjuntor).
  const corpoTravado = async (url, o) => ({ status: 200, headers: new Headers(), arrayBuffer: () => esperaAbortar(o.signal) });
  await assert.rejects(C.criarCofre(cfg, { fetch: corpoTravado, timeoutMs: 30, timeoutCorpoMs: 40, retentativas: 0 }).ler('midia/MD-1'), (e) => e.codigo === 'LENTO' && !C.erroDeDisponibilidade(e));
});

test('CR-MARC-1: o bucket com anexos exclusivos decide entre desligar e manter o R2 quebrado no boot', () => {
  assert.equal(C.bucketComArquivos(null), '');
  assert.equal(C.bucketComArquivos({ ativo: true, bucket: 'b' }), '', 'ativo sem bucketArquivos: o Mongo ainda tem tudo');
  assert.equal(C.bucketComArquivos({ bucketArquivos: 'b' }), 'b');
  assert.equal(C.bucketComArquivos({ acervoNoR2: true, acervoBucket: 'x' }), 'x');
  const cfgErrada = { statusArmazenamento: 403, codigo: 'AccessDenied' };
  assert.equal(C.decisaoTesteBoot({ codigo: 'REDE' }, 'b', { bucketArquivos: 'b' }), 'passageiro');
  assert.equal(C.decisaoTesteBoot(cfgErrada, 'b', null), 'desligar', '1ª subida com chave errada: volta ao Mongo');
  assert.equal(C.decisaoTesteBoot(cfgErrada, 'b', { bucketArquivos: 'b' }), 'manter', 'o bucket já tem anexos só dele: 503, nunca 404');
  assert.equal(C.decisaoTesteBoot(cfgErrada, 'novo', { bucketArquivos: 'b' }), 'desligar', 'bucket novo errado não prende o site');
  assert.equal(C.avisoArquivosForaDeAlcance({ bucketArquivos: 'b' }, 'b'), '');
  assert.match(C.avisoArquivosForaDeAlcance({ bucketArquivos: 'b' }, ''), /só existem no bucket "b".*sem o R2/);
  assert.match(C.avisoArquivosForaDeAlcance({ acervoNoR2: true, acervoBucket: 'b' }, 'outro'), /lê o bucket "outro"/);
  assert.equal(C.avisoArquivosForaDeAlcance({ ativo: true, bucket: 'b' }, ''), '', 'sem anexo exclusivo não há aviso');
});

test('CR-MARC-2: o apagar do Mongo só é liberado pelo site do Render, no mesmo bucket e endpoint, com sinal de vida recente', () => {
  const agora = Date.UTC(2026, 8, 24, 18, 0);
  const bom = { ativo: true, render: true, bucket: 'b', origem: 'https://c.r2', vistoTs: agora - 5 * 60 * 1000, bootTs: agora - 3600e3 };
  const ok = (m) => C.marcadorPermiteApagar(m, { bucket: 'b', origem: 'https://c.r2', agora });
  assert.deepEqual(ok(bom), { ok: true });
  assert.match(ok(null).motivo, /ainda não lê do R2/);
  assert.match(ok({ ...bom, ativo: false }).motivo, /ainda não lê do R2/);
  assert.match(ok({ ...bom, render: undefined }).motivo, /servidor local/, 'um npm run dev ligado no Mongo de produção não libera');
  assert.match(ok({ ...bom, bucket: 'outro' }).motivo, /lê o bucket "outro"/);
  assert.match(ok({ ...bom, origem: 'https://outra' }).motivo, /endpoint/);
  assert.match(ok({ ...bom, vistoTs: agora - 42 * 60 * 1000 }).motivo, /não dá sinal há 42 min/, 'rollback ou site dormindo não libera');
  assert.match(ok({ ...bom, vistoTs: undefined }).motivo, /não dá sinal/);
  // Deploy no ar (build do /api/versao) tem de ser o que gravou o marcador.
  const comBuild = (m, buildNoAr) => C.marcadorPermiteApagar(m, { bucket: 'b', origem: 'https://c.r2', agora, buildNoAr });
  assert.deepEqual(comBuild({ ...bom, commit: 'abc123' }, 'abc123'), { ok: true });
  assert.match(comBuild({ ...bom, commit: 'novo999' }, 'abc123').motivo, /deploy abc123.*deploy novo999/, 'deploy que gravou e falhou / rollback');
  // Relógio do PC atrás do Render: até 5 min é folga; além disso, mensagem própria.
  assert.deepEqual(ok({ ...bom, vistoTs: agora + 3 * 60 * 1000 }), { ok: true });
  assert.match(ok({ ...bom, vistoTs: agora + 10 * 60 * 1000 }).motivo, /relógio deste computador está 10 min atrás/);
});

test('CR-CHAVE-1: chaves saem limpas e só nos formatos conhecidos; o inverso recupera o id', () => {
  assert.equal(C.chaveMidia('MD-0a1b2c3d4e5f6071'), 'midia/MD-0a1b2c3d4e5f6071');
  assert.equal(C.chaveMidia('../../usuarios'), 'midia/usuarios', 'barra e ponto saem (mesma limpeza do data/uploads)');
  assert.equal(C.chaveMidia(''), '');
  assert.equal(C.chaveMidia('../'), '');
  assert.equal(C.chaveUndoMidia('UD1', 'MD-1'), 'undo-midia/UD1/MD-1');
  assert.equal(C.chaveUndoMidia('', 'MD-1'), '');
  assert.equal(C.idDaChaveMidia('midia/MD-1'), 'MD-1');
  assert.equal(C.idDaChaveMidia('undo-midia/UD1/MD-1'), '');
  assert.equal(C.validarChave('midia/MD-1'), true);
  assert.equal(C.validarChave('midia/../x'), false);
  assert.equal(C.validarChave('videos-treino/2026/x.mp4'), false, 'o cofre não mexe nas chaves dos vídeos');
  assert.equal(C.tamanhoBase64(3), 4);
  assert.equal(C.tamanhoBase64(4), 8);
  assert.equal(C.tamanhoBase64(0), 0);
});

// ----------------------------------------------------------------------------------------
// Driver contra o S3 falso
// ----------------------------------------------------------------------------------------
let falso, cofre;
before(async () => {
  falso = criarS3Falso({ segredo: 'segredo-de-teste', bucket: 'arquivos' });
  await new Promise((ok) => falso.srv.listen(0, '127.0.0.1', ok));
  const cfg = C.lerConfigCofre({ MIDIA_S3_BUCKET: 'arquivos', MIDIA_S3_ENDPOINT: `http://127.0.0.1:${falso.srv.address().port}`, MIDIA_S3_KEY_ID: 'chave-teste', MIDIA_S3_KEY_SECRET: 'segredo-de-teste' });
  cofre = C.criarCofre(cfg, { esperaMs: 1, timeoutMs: 5000 });
});
after(() => new Promise((ok) => falso.srv.close(ok)));

test('CR-S3-1: gravar → ler devolve os MESMOS bytes, tipo, nome com acento e ts; toda requisição com assinatura válida', async () => {
  const buf = crypto.randomBytes(3000); // binário de verdade (bytes > 0x7F), não texto
  const nome = 'ASO Admissão — João (cópia).pdf';
  const r = await cofre.gravar('midia/MD-aaa', { buf, tipo: 'application/pdf', nome, ts: 1790000000000 });
  assert.equal(r.bytes, 3000);
  assert.equal(r.sha256, crypto.createHash('sha256').update(buf).digest('hex'));
  const m = await cofre.ler('midia/MD-aaa');
  assert.ok(m.buf.equals(buf), 'bytes idênticos');
  assert.equal(m.tipo, 'application/pdf');
  assert.equal(m.nome, nome);
  assert.equal(m.ts, 1790000000000);
  assert.equal(m.sha256, r.sha256);
  const h = await cofre.cabeca('midia/MD-aaa');
  assert.equal(h.bytes, 3000);
  assert.equal(h.nome, nome);
  assert.equal(falso.estado.recusadas, 0, 'o S3 falso não recusou nenhuma assinatura');
});

test('CR-S3-1b: nome com emoji cortado ao meio (surrogate isolado) grava com U+FFFD, como o Mongo fazia — não lança URIError', async () => {
  const nome = 'Atestado ' + 'NR-35 '.repeat(25) + '\ud83d'; // o slice(0, 160) do atestado cortou o par do emoji
  await cofre.gravar('midia/MD-emoji', { buf: Buffer.from('x'), tipo: 'application/pdf', nome, ts: 1 });
  const m = await cofre.ler('midia/MD-emoji');
  assert.ok(m.nome.endsWith('�'));
  const longo = 'a'.repeat(299) + '😀'; // o NOME_MAX (300) corta o par
  await cofre.gravar('midia/MD-comprido', { buf: Buffer.from('y'), tipo: 'image/png', nome: longo, ts: 1 });
  assert.equal((await cofre.ler('midia/MD-comprido')).nome.length, 300);
});

test('CR-S3-2: ausente é null (não erro); apagar é idempotente; chave fora do formato nem sai do servidor', async () => {
  assert.equal(await cofre.ler('midia/MD-nao-existe'), null);
  assert.equal(await cofre.cabeca('midia/MD-nao-existe'), null);
  await cofre.apagar('midia/MD-nao-existe');
  await cofre.gravar('midia/MD-some', { buf: Buffer.from('x'), tipo: 'image/png', nome: 'x.png', ts: 1 });
  await cofre.apagar('midia/MD-some');
  assert.equal(await cofre.ler('midia/MD-some'), null);
  const antes = falso.estado.log.length;
  await assert.rejects(cofre.ler('midia/../usuarios'), (e) => e.status === 400);
  await assert.rejects(cofre.gravar('videos-treino/2026/x.mp4', { buf: Buffer.from('x') }), (e) => e.status === 400);
  await assert.rejects(cofre.listar('videos-treino/'), (e) => e.status === 400);
  assert.equal(falso.estado.log.length, antes, 'nenhuma requisição saiu para chave inválida');
});

test('CR-S3-3: mover leva bytes e metadados e apaga a origem; origem ausente devolve false', async () => {
  const buf = crypto.randomBytes(100);
  await cofre.gravar('midia/MD-mov', { buf, tipo: 'image/jpeg', nome: 'foto.jpg', ts: 42 });
  assert.equal(await cofre.mover('midia/MD-mov', 'undo-midia/UD9/MD-mov'), true);
  assert.equal(await cofre.ler('midia/MD-mov'), null);
  const q = await cofre.ler('undo-midia/UD9/MD-mov');
  assert.ok(q.buf.equals(buf));
  assert.equal(q.nome, 'foto.jpg');
  assert.equal(q.ts, 42);
  assert.equal(await cofre.mover('midia/MD-mov', 'undo-midia/UD9/MD-mov'), false);
  await cofre.apagar('undo-midia/UD9/MD-mov');
});

test('CR-S3-4: listar percorre todas as páginas e respeita o prefixo', async () => {
  for (const id of ['MD-l1', 'MD-l2', 'MD-l3', 'MD-l4', 'MD-l5']) await cofre.gravar('midia/' + id, { buf: Buffer.from(id), tipo: 'text/plain', nome: id, ts: 1 });
  await cofre.gravar('undo-midia/UD1/MD-l9', { buf: Buffer.from('q'), tipo: 'text/plain', nome: 'q', ts: 1 });
  const lista = await cofre.listar('midia/');
  const ids = lista.map((o) => C.idDaChaveMidia(o.chave)).filter((id) => id.startsWith('MD-l'));
  assert.deepEqual(ids, ['MD-l1', 'MD-l2', 'MD-l3', 'MD-l4', 'MD-l5'], '5 objetos em páginas de 2');
  assert.ok(lista.every((o) => o.bytes > 0 && o.modificadoTs > 0));
  assert.ok(!lista.some((o) => o.chave.startsWith('undo-midia/')), 'quarentena não entra na listagem de midia/');
});

test('CR-S3-5: 500 passageiro é repetido; indisponível de verdade vira erro 502 (nunca null, que significaria "apagado")', async () => {
  await cofre.gravar('midia/MD-ret', { buf: Buffer.from('ok'), tipo: 'text/plain', nome: 'r', ts: 1 });
  falso.estado.falhas['GET obj'] = 2;
  const m = await cofre.ler('midia/MD-ret');
  assert.equal(m.buf.toString(), 'ok', 'a 3ª tentativa passa');
  falso.estado.fora = true;
  try {
    await assert.rejects(cofre.ler('midia/MD-ret'), (e) => e.status === 502 && /503/.test(e.message));
    await assert.rejects(cofre.cabeca('midia/MD-ret'), (e) => e.status === 502);
  } finally {
    falso.estado.fora = false;
  }
});

test('CR-S3-6: segredo errado dá mensagem com dica, sem citar a credencial; testar() grava, confere e não deixa nada', async () => {
  const errado = C.criarCofre(C.lerConfigCofre({ MIDIA_S3_BUCKET: 'arquivos', MIDIA_S3_ENDPOINT: `http://127.0.0.1:${falso.srv.address().port}`, MIDIA_S3_KEY_ID: 'chave-teste', MIDIA_S3_KEY_SECRET: 'outro-segredo' }), { esperaMs: 1 });
  await assert.rejects(errado.ler('midia/MD-ret'), (e) => /SignatureDoesNotMatch/.test(e.message) && !/outro-segredo/.test(e.message));
  // erroDeConfiguracao separa o que não passa sozinho (desliga o R2 no boot) do passageiro.
  const pegar = (p) => p.then(() => null, (e) => e);
  assert.equal(C.erroDeConfiguracao(await pegar(errado.testar())), true, 'segredo errado é configuração');
  const outroBucket = C.criarCofre(C.lerConfigCofre({ MIDIA_S3_BUCKET: 'nao-existe', MIDIA_S3_ENDPOINT: `http://127.0.0.1:${falso.srv.address().port}`, MIDIA_S3_KEY_ID: 'chave-teste', MIDIA_S3_KEY_SECRET: 'segredo-de-teste' }), { esperaMs: 1 });
  assert.equal(C.erroDeConfiguracao(await pegar(outroBucket.testar())), true, 'bucket inexistente é configuração');
  falso.estado.fora = true;
  try { assert.equal(C.erroDeConfiguracao(await pegar(cofre.testar())), false, 'R2 fora do ar é passageiro'); }
  finally { falso.estado.fora = false; }
  assert.equal(C.erroDeConfiguracao(Object.assign(new Error('x'), { codigo: 'REDE' })), false, 'falha de rede é passageira');
  falso.estado.recusadas = 0;
  const r = await cofre.testar();
  assert.equal(r.ok, true);
  assert.match(r.mensagem, /arquivos/);
  assert.ok(![...falso.estado.objetos.keys()].some((k) => k.startsWith('teste-conexao/')), 'o objeto de teste foi apagado');
});
