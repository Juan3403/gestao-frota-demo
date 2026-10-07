/**
 * scripts/migrar-midia-r2.js — as quatro etapas (simular, copiar, conferir, apagar do Mongo)
 * contra um Mongo FALSO em memória e o S3 falso de test/helpers/s3-falso.js. O foco é o que
 * não pode dar errado com 4,8 GB de anexos reais: nada é apagado sem estar idêntico no R2,
 * nada é apagado se o site ainda não lê do bucket, e rodar de novo retoma de onde parou.
 * Não sobe o servidor. Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const C = require('../backend/cofre-midia');
const M = require('../scripts/migrar-midia-r2');
const { criarS3Falso } = require('./helpers/s3-falso');

// Mongo falso: só o que o script usa (aggregate do inventário, findOne, deleteOne, updateOne).
function criarColFalsa() {
  const docs = new Map();
  const col = {
    docs,
    depoisDeLer: null, // gancho: roda depois de cada leitura COMPLETA de um doc
    aggregate: () => ({
      toArray: async () => [...docs.values()].filter((d) => d._id.startsWith('midia_'))
        .map((d) => ({ _id: d._id, len: typeof d.b64 === 'string' ? d.b64.length : 0, ts: d.ts })),
    }),
    async findOne(q, o) {
      const d = docs.get(q._id);
      if (!d) return null;
      if (o && o.projection) return { _id: d._id };
      const copia = { ...d };
      if (col.depoisDeLer) col.depoisDeLer(q._id);
      return copia;
    },
    async deleteOne(q) { docs.delete(q._id); return { deletedCount: 1 }; },
    async updateOne(q, u) { docs.set(q._id, { ...(docs.get(q._id) || { _id: q._id }), ...u.$set }); },
  };
  return col;
}
const arquivo = (n) => crypto.randomBytes(n);
function semear(col, id, buf, tipo = 'application/pdf') {
  col.docs.set('midia_' + id, { _id: 'midia_' + id, tipo, nome: `doc ${id}.pdf`, b64: buf.toString('base64'), ts: 1780000000000 });
}

let falso, cofre;
before(async () => {
  falso = criarS3Falso({ segredo: 'segredo-mig', bucket: 'arquivos' });
  await new Promise((ok) => falso.srv.listen(0, '127.0.0.1', ok));
  cofre = C.criarCofre(C.lerConfigCofre({ MIDIA_S3_BUCKET: 'arquivos', MIDIA_S3_ENDPOINT: `http://127.0.0.1:${falso.srv.address().port}`, MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 'segredo-mig' }), { esperaMs: 1 });
});
after(() => new Promise((ok) => falso.srv.close(ok)));

const ORIGEM = 'https://conta.r2.cloudflarestorage.com';
const AGORA = Date.UTC(2026, 8, 24, 18, 0);
let BUILD_NO_AR = 'abc1234'; // o que o /api/versao do site responderia
const rodar = (col, modo, extra = {}) => M.executar({
  col, cofre, bucket: 'arquivos', origem: ORIGEM, agora: () => AGORA, buildNoAr: async () => BUILD_NO_AR,
  opcoes: { modo, paralelo: 3, tentativasReconferir: 1, esperaReconferirMs: 1, ...extra.opcoes },
  confirmar: extra.confirmar || (async () => false), log: extra.log || (() => {}),
});
// Marcador como o site do Render grava (registrarEstadoCofreR2), com sinal de vida de 5 min atrás.
const marcadorDoSite = (extra = {}) => ({ _id: 'cofre_r2', ativo: true, render: true, bucket: 'arquivos', origem: ORIGEM, commit: 'abc1234', bootTs: AGORA - 3600e3, vistoTs: AGORA - 5 * 60e3, ...extra });

test('MIG-OPC: opções — uma etapa por vez, limite e paralelo', () => {
  assert.deepEqual(M.lerOpcoes([]), { modo: 'simular', limite: Infinity, paralelo: 4 });
  assert.deepEqual(M.lerOpcoes(['--copiar', '--limite=20', '--paralelo=99']), { modo: 'copiar', limite: 20, paralelo: 16 });
  assert.throws(() => M.lerOpcoes(['--copiar', '--apagar-do-mongo']), /uma etapa por vez/);
  assert.throws(() => M.lerOpcoes(['--apagar']), /desconhecida/);
});

test('MIG-1: simulação conta o que falta e NÃO grava em lugar nenhum', async () => {
  falso.estado.objetos.clear();
  const col = criarColFalsa();
  semear(col, 'MD-a', arquivo(100));
  semear(col, 'MD-b', arquivo(200));
  const linhas = [];
  const r = await rodar(col, 'simular', { log: (t) => linhas.push(t) });
  assert.equal(r.modo, 'simular');
  assert.equal(falso.estado.objetos.size, 0, 'nada foi para o bucket');
  assert.equal(col.docs.size, 2, 'nada saiu do Mongo');
  assert.ok(linhas.some((l) => /Falta copiar: 2/.test(l)));
  assert.ok(linhas.some((l) => /ainda não lê do R2/.test(l)), 'avisa que o site ainda não lê do R2');
});

test('MIG-2: copiar é retomável, leva bytes/tipo/nome e pula doc vazio; excluído no meio da cópia NUNCA é apagado do bucket', async () => {
  falso.estado.objetos.clear();
  const col = criarColFalsa();
  const bufs = { 'MD-1': arquivo(1000), 'MD-2': arquivo(2000), 'MD-3': arquivo(3000), 'MD-4': arquivo(10) };
  for (const [id, b] of Object.entries(bufs)) semear(col, id, b);
  col.docs.set('midia_MD-vazio', { _id: 'midia_MD-vazio', tipo: 'image/png', nome: 'x', b64: '', ts: 1 });

  let r = await rodar(col, 'copiar', { opcoes: { limite: 2 } });
  assert.equal(r.copiados, 2, 'o ensaio com --limite=2 copia 2');
  r = await rodar(col, 'copiar');
  assert.equal(r.jaEstavam, 2, 'a 2ª rodada não copia de novo o que já estava');
  assert.equal(r.copiados, 2);
  assert.equal(r.vazios, 1);
  assert.ok(r.erros.some((e) => e.id === 'MD-vazio'));
  for (const [id, b] of Object.entries(bufs)) {
    const o = falso.estado.objetos.get('midia/' + id);
    assert.ok(o && o.buf.equals(b), `${id} idêntico no bucket`);
    assert.equal(o.tipo, 'application/pdf');
    assert.equal(decodeURIComponent(o.meta.nome), `doc ${id}.pdf`);
  }
  assert.equal(falso.estado.objetos.has('midia/MD-vazio'), false);
  assert.equal(col.docs.size, 5, 'copiar nunca apaga do Mongo');

  // Corrida da revisão: o site exclui o anexo (quarentena do Desfazer) entre a leitura do Mongo e
  // o fim da cópia, e o Desfazer o DEVOLVE — com o R2 ligado, para o bucket, na mesma chave. A
  // 1ª versão via "sumiu do Mongo" e apagava midia/X: a única cópia que restava. Agora fica.
  const corrida = arquivo(50);
  semear(col, 'MD-corrida', corrida);
  col.depoisDeLer = (id) => { if (id === 'midia_MD-corrida') col.docs.delete(id); };
  r = await rodar(col, 'copiar');
  col.depoisDeLer = null;
  assert.equal(r.sumiramDurante, 1);
  assert.equal(r.erros.length, 1, 'só o doc vazio é problema');
  assert.ok(falso.estado.objetos.get('midia/MD-corrida').buf.equals(corrida), 'a cópia continua no bucket (a faxina do site decide)');
});

test('MIG-3: conferir compara byte a byte e aponta o que diverge e o que não foi copiado', async () => {
  falso.estado.objetos.clear();
  const col = criarColFalsa();
  semear(col, 'MD-ok', arquivo(500));
  semear(col, 'MD-mexido', arquivo(500));
  await rodar(col, 'copiar');
  semear(col, 'MD-novo', arquivo(500)); // entrou depois da cópia
  falso.estado.objetos.get('midia/MD-mexido').buf = arquivo(500); // mesmo tamanho, outro conteúdo
  const r = await rodar(col, 'conferir');
  assert.equal(r.conferidos, 1);
  assert.ok(r.erros.some((e) => e.id === 'MD-mexido' && /DIFERENTE/.test(e.motivo)));
  assert.ok(r.erros.some((e) => e.id === 'MD-novo' && /não está no R2/.test(e.motivo)));
});

test('MIG-4: apagar do Mongo recusa sem o site no mesmo bucket, exige a frase e só apaga o que está idêntico', async () => {
  falso.estado.objetos.clear();
  const col = criarColFalsa();
  const bom = arquivo(700);
  semear(col, 'MD-bom', bom);
  semear(col, 'MD-mexido', arquivo(700));
  await rodar(col, 'copiar');
  semear(col, 'MD-nao-copiado', arquivo(700));
  falso.estado.objetos.get('midia/MD-mexido').buf = arquivo(700);
  const frase = async (f) => f === M.FRASE_APAGAR;

  // Cada marcador que NÃO prova que o site de produção lê deste bucket agora é recusado.
  const recusas = [
    null, // sem marcador: o site ainda está no código antigo
    marcadorDoSite({ bucket: 'outro' }),
    marcadorDoSite({ render: undefined }), // gravado por um `npm run dev` ligado no Mongo de produção
    marcadorDoSite({ vistoTs: AGORA - 40 * 60e3 }), // rollback para versão sem R2 (parou de renovar) ou site dormindo
    marcadorDoSite({ origem: 'https://outra.r2.cloudflarestorage.com' }),
    marcadorDoSite({ ativo: false }), // o R2 do site subiu quebrado (ver conferirCofreNoBoot)
    marcadorDoSite({ commit: 'novo9999' }), // deploy novo gravou o marcador e falhou: no ar segue o abc1234
  ];
  for (const m of recusas) {
    if (m) col.docs.set('cofre_r2', m); else col.docs.delete('cofre_r2');
    const r = await rodar(col, 'apagar', { confirmar: frase });
    assert.equal(r.recusado, true, `recusa com ${JSON.stringify(m && { ...m, _id: undefined })}`);
    assert.equal(col.docs.size, m ? 4 : 3, 'nada apagado');
  }
  // Marcador bom, frase errada.
  col.docs.set('cofre_r2', marcadorDoSite());
  let r = await rodar(col, 'apagar', { confirmar: async () => false });
  assert.equal(r.cancelado, true);
  assert.equal(col.docs.get('cofre_r2').acervoNoR2, undefined, 'cancelado não marca nada');
  assert.equal(col.docs.size, 4);

  r = await rodar(col, 'apagar', { confirmar: frase });
  assert.equal(r.apagados, 1);
  assert.equal(col.docs.has('midia_MD-bom'), false, 'o idêntico saiu do Mongo');
  assert.ok(falso.estado.objetos.get('midia/MD-bom').buf.equals(bom), 'e continua no bucket');
  assert.ok(col.docs.has('midia_MD-mexido'), 'o divergente NÃO foi apagado');
  assert.ok(col.docs.has('midia_MD-nao-copiado'), 'o não copiado nem foi tocado');
  const marca = col.docs.get('cofre_r2');
  assert.equal(marca.acervoNoR2, true, 'o servidor passa a saber que parte do acervo só existe no bucket');
  assert.equal(marca.acervoBucket, 'arquivos');
});

test('MIG-5: se o site deixa de ler do bucket no meio do apagar (deploy que desligou o R2), o script para', async () => {
  falso.estado.objetos.clear();
  const col = criarColFalsa();
  for (let i = 1; i <= 6; i++) semear(col, 'MD-p' + i, arquivo(100));
  await rodar(col, 'copiar');
  col.docs.set('cofre_r2', marcadorDoSite());
  let apagados = 0;
  const deleteOriginal = col.deleteOne;
  col.deleteOne = async (q) => {
    await deleteOriginal(q);
    // Depois do 2º apagado, um deploy novo sobe sem o R2 e grava ativo:false.
    if (++apagados === 2) col.docs.set('cofre_r2', marcadorDoSite({ ativo: false }));
  };
  const r = await rodar(col, 'apagar', { confirmar: async (f) => f === M.FRASE_APAGAR, opcoes: { reconferirACada: 1, paralelo: 1 } });
  assert.match(r.interrompido || '', /não lê do R2/);
  assert.equal(r.apagados, 2, 'parou na reconferência seguinte');
  assert.equal([...col.docs.keys()].filter((k) => k.startsWith('midia_')).length, 4, 'o resto ficou no Mongo');
});

test('MIG-6: erro ao reler o marcador na reconferência PARA o apagar (falha fechada, não segue apagando)', async () => {
  falso.estado.objetos.clear();
  const col = criarColFalsa();
  for (let i = 1; i <= 5; i++) semear(col, 'MD-q' + i, arquivo(100));
  await rodar(col, 'copiar');
  col.docs.set('cofre_r2', marcadorDoSite());
  let apagados = 0, quebrado = false;
  const findOriginal = col.findOne.bind(col), deleteOriginal = col.deleteOne;
  col.findOne = async (q, o) => { if (quebrado && q._id === 'cofre_r2') throw new Error('Atlas: primário em eleição'); return findOriginal(q, o); };
  col.deleteOne = async (q) => { await deleteOriginal(q); if (++apagados === 1) quebrado = true; };
  const r = await rodar(col, 'apagar', { confirmar: async (f) => f === M.FRASE_APAGAR, opcoes: { reconferirACada: 1, paralelo: 1 } });
  assert.match(r.interrompido || '', /não consegui ler o marcador/);
  assert.equal(r.apagados, 1, 'nada mais foi apagado depois que a reconferência falhou');
});
