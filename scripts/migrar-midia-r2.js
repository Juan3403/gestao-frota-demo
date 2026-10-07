'use strict';
// ============================================================================
// Migra o cofre de arquivos do MongoDB (docs `midia_<id>`, base64) para o bucket R2.
// Passo a passo completo e o porquê de cada etapa: docs/ARQUIVOS_R2.md.
//
// Etapas, cada uma um comando (todas retomáveis: rodar de novo continua de onde parou):
//   (sem opção)         SIMULAÇÃO: conta o que está no Mongo, o que já está no R2 e o que falta.
//                       Não grava nada em lugar nenhum.
//   --copiar            copia para o R2 o que ainda não está lá. NÃO apaga nada do Mongo, e
//                       nunca apaga do bucket (nem a cópia de um anexo excluído no meio: o
//                       Desfazer pode tê-lo devolvido para lá; a faxina diária do site resolve).
//                       Pode rodar com o site no ar: o site já grava arquivo novo no R2 e lê o
//                       antigo do Mongo até ele ser copiado.
//   --conferir          baixa cada arquivo do R2 e compara byte a byte (SHA-256) com o do Mongo.
//   --apagar-do-mongo   confere de novo, arquivo por arquivo, e só apaga do Mongo o que bateu.
//                       Pede para digitar APAGAR DO MONGO e se RECUSA se o marcador `cofre_r2`
//                       não provar que o SITE lê do mesmo bucket agora: gravado pela instância
//                       do Render (não por um servidor local), mesmo bucket e endpoint, sinal de
//                       vida nos últimos 15 min, e pelo MESMO deploy que o site diz estar no ar
//                       (/api/versao; pega rollback e deploy que falhou) — C.marcadorPermiteApagar.
//                       Apagar com o site no código antigo tiraria do ar todo anexo antigo.
//                       Refaz tudo a cada 50 arquivos (espera o site acordar; se não voltar,
//                       para). Sai com código 1 se recusou ou parou no meio.
// Site consultado: https://gestao.example.com (troque com $env:GDJ_SITE_URL).
// Opções: --limite=N (só os N primeiros; bom para um ensaio) · --paralelo=N (padrão 4, máx. 16)
//
// USO — Windows (PowerShell, da pasta do projeto). Aspas SIMPLES (nas duplas o PowerShell
// come o `$` de uma senha). Bucket e credenciais são os MESMOS do Render › Environment:
//   $env:MONGODB_URI='mongodb+srv://...'
//   $env:MIDIA_S3_ENDPOINT='https://<conta>.r2.cloudflarestorage.com'
//   $env:MIDIA_S3_BUCKET='gestaorm-arquivos'
//   $env:MIDIA_S3_KEY_ID='...'; $env:MIDIA_S3_KEY_SECRET='...'
//   node scripts/migrar-midia-r2.js                        # simulação
//   node scripts/migrar-midia-r2.js --copiar --limite=20   # ensaio com 20 arquivos
//   node scripts/migrar-midia-r2.js --copiar               # o resto
//   node scripts/migrar-midia-r2.js --conferir
//   node scripts/migrar-midia-r2.js --apagar-do-mongo      # só depois do backup do bucket
//   Remove-Item Env:MONGODB_URI, Env:MIDIA_S3_KEY_SECRET   # ao terminar
//
// SAÍDA (exemplo da simulação; números ilustrativos):
//   Site: lê do R2 · bucket "gestaorm-arquivos" · deploy 3f9a1c2 de 24/09/2026 14:02 · último sinal 24/09/2026 15:47
//   Mongo: 4.518 arquivos · 3,65 GB (4,87 GB em base64)
//   Já no R2: 0 · Falta copiar: 4.518 (3,65 GB)
//   Próximo passo: node scripts/migrar-midia-r2.js --copiar
//
// Nenhum nome de arquivo nem dado pessoal é impresso: só ids `MD-…`, contagens e tamanhos.
// ============================================================================
const crypto = require('crypto');
const readline = require('readline');
const C = require('../backend/cofre-midia');

const FRASE_APAGAR = 'APAGAR DO MONGO';
const ID_MARCADOR = 'cofre_r2'; // mesmo _id do registrarEstadoCofreR2() do server.js

const num = (n, casas = 0) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
function tam(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 ** 3) return num(b / 1024 ** 3, 2) + ' GB';
  if (b >= 1024 ** 2) return num(b / 1024 ** 2, 1) + ' MB';
  return num(b / 1024, 0) + ' KB';
}
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const dataBR = (ts) => new Date(ts).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });

// USO: lerOpcoes(['--copiar', '--limite=20']) // => { modo: 'copiar', limite: 20, paralelo: 4 }
function lerOpcoes(argv) {
  const op = { modo: 'simular', limite: Infinity, paralelo: 4 };
  const modos = { '--copiar': 'copiar', '--conferir': 'conferir', '--apagar-do-mongo': 'apagar' };
  for (const a of argv) {
    const m = /^--(limite|paralelo)=(\d+)$/.exec(a);
    if (modos[a]) {
      if (op.modo !== 'simular') throw new Error('Use uma etapa por vez: --copiar, --conferir ou --apagar-do-mongo.');
      op.modo = modos[a];
    } else if (m && m[1] === 'limite') op.limite = Math.max(1, Number(m[2]));
    else if (m && m[1] === 'paralelo') op.paralelo = Math.min(16, Math.max(1, Number(m[2])));
    else if (a === '--ajuda' || a === '-h') op.ajuda = true;
    else throw new Error(`Opção desconhecida: ${a}`);
  }
  return op;
}

// Roda fn em até n itens ao mesmo tempo (cada item é tratado pelo próprio fn, erro incluso).
// USO: await emParalelo([1, 2, 3], 2, async (x) => { … })
async function emParalelo(itens, n, fn) {
  let i = 0;
  const trabalhadores = Array.from({ length: Math.min(n, itens.length) }, async () => {
    while (i < itens.length) { const item = itens[i++]; await fn(item); }
  });
  await Promise.all(trabalhadores);
}

// Inventário do Mongo sem trazer o base64: o tamanho é medido no servidor (mesma expressão
// que o backup do server.js já usa em produção).
// USO: await inventarioMongo(col) // => [{ _id: 'midia_MD-0a1b…', id: 'MD-0a1b…', len: 16384, bytes: 12288 }, …]
async function inventarioMongo(col) {
  const linhas = await col.aggregate([
    { $match: { _id: { $regex: '^midia_' } } },
    { $project: { len: { $strLenBytes: { $ifNull: ['$b64', ''] } }, ts: 1 } },
  ]).toArray();
  return linhas.map((d) => ({ _id: String(d._id), id: String(d._id).slice(6), len: d.len || 0, bytes: Math.floor((d.len || 0) * 3 / 4) }));
}

// O coração do script, sem conexão nem console: recebe a coleção (Mongo) e o cofre (R2) prontos.
// `confirmar(frase)` responde se a pessoa digitou a frase; `log(texto)` imprime; `progresso(texto)`
// reescreve a linha de andamento. Devolve o resumo da etapa (usado pelo teste).
// `origem` é o endpoint do cofre (cfg.origem) e `agora` o relógio (injetável no teste).
// `buildNoAr()` devolve o `build` do /api/versao público do SITE (o commit do deploy no ar) — a
// chamada também acorda o site se o Render o pôs para dormir. null = não consultar (só testes).
// USO: await executar({ col, cofre, bucket: 'gestaorm-arquivos', origem: 'https://c.r2.cloudflarestorage.com',
//        buildNoAr: async () => '3f9a1c2…', opcoes: { modo: 'copiar', limite: 20, paralelo: 4 },
//        confirmar: async () => false, log: console.log })
//   // => { modo: 'copiar', total: 20, copiados: 20, jaEstavam: 0, vazios: 0, erros: [], bytes: 20971520 }
async function executar({ col, cofre, bucket, origem = '', buildNoAr = null, opcoes, confirmar, log = () => {}, progresso = () => {}, agora = () => Date.now() }) {
  const op = { limite: Infinity, paralelo: 4, reconferirACada: 50, tentativasReconferir: 10, esperaReconferirMs: 30000, ...opcoes };
  const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));
  // Permissão do apagar: marcador (gravado pelo site) + deploy no ar (perguntado ao site agora).
  const permissaoAgora = async () => {
    let build;
    if (buildNoAr) {
      try { build = await buildNoAr(); } catch (e) { return { ok: false, motivo: `não consegui consultar o site (${e.message}).` }; }
    }
    return C.marcadorPermiteApagar(await col.findOne({ _id: ID_MARCADOR }), { bucket, origem, agora: agora(), buildNoAr: build });
  };
  const permissao = await permissaoAgora();
  const marcador = await col.findOne({ _id: ID_MARCADOR });
  log(permissao.ok
    ? `Site: lê do R2 · bucket "${bucket}" · deploy ${String(marcador.commit || '?').slice(0, 7)} de ${dataBR(marcador.bootTs)} · último sinal ${dataBR(marcador.vistoTs)}`
    : `Site: ${permissao.motivo} Copiar e conferir podem rodar; apagar do Mongo, não.`);

  const inventario = await inventarioMongo(col);
  const noR2 = new Map((await cofre.listar(C.PREFIXO_MIDIA)).map((o) => [o.chave, o.bytes]));
  // Dois ids diferentes que a limpeza transformasse na MESMA chave se sobrescreveriam no bucket:
  // ficam de fora (e aparecem no relatório) em vez de arriscar.
  const porChave = new Map();
  for (const d of inventario) {
    d.chave = C.chaveMidia(d.id);
    if (d.chave) porChave.set(d.chave, (porChave.get(d.chave) || 0) + 1);
  }
  const colisoes = inventario.filter((d) => !d.chave || porChave.get(d.chave) > 1);
  const validos = inventario.filter((d) => d.chave && porChave.get(d.chave) === 1);
  const bytesTotal = validos.reduce((t, d) => t + d.bytes, 0);
  const presentes = validos.filter((d) => noR2.has(d.chave));
  const faltam = validos.filter((d) => !noR2.has(d.chave));
  log(`Mongo: ${num(inventario.length)} arquivos · ${tam(bytesTotal)} (${tam(inventario.reduce((t, d) => t + d.len, 0))} em base64)`);
  log(`Já no R2: ${num(presentes.length)} · Falta copiar: ${num(faltam.length)} (${tam(faltam.reduce((t, d) => t + d.bytes, 0))})`);
  if (colisoes.length) log(`⚠ ${num(colisoes.length)} id(s) ficam de fora por id vazio ou repetido depois da limpeza: ${colisoes.slice(0, 10).map((d) => d._id).join(', ')}`);

  const r = { modo: op.modo, total: 0, copiados: 0, jaEstavam: 0, conferidos: 0, apagados: 0, vazios: 0, sumiramDurante: 0, bytes: 0, erros: [], colisoes: colisoes.length };
  if (op.modo === 'simular') {
    log(faltam.length ? 'Próximo passo: node scripts/migrar-midia-r2.js --copiar' : 'Tudo copiado. Próximo passo: node scripts/migrar-midia-r2.js --conferir');
    return r;
  }

  const anotarErro = (d, motivo) => r.erros.push({ id: d.id, motivo });
  let feitos = 0;
  const andar = (rotulo, lista) => progresso(`[${rotulo}] ${num(++feitos)}/${num(lista.length)} · ${tam(r.bytes)} · ${num(r.erros.length)} erro(s)`);

  // Lê o doc e devolve o buffer original, ou null (sumiu / sem conteúdo — anotado).
  async function lerDoMongo(d) {
    const doc = await col.findOne({ _id: d._id });
    if (!doc) { anotarErro(d, 'sumiu do Mongo durante a etapa (excluído no site)'); return null; }
    if (typeof doc.b64 !== 'string' || !doc.b64) { r.vazios++; anotarErro(d, 'doc sem conteúdo (b64 vazio): não copiado nem apagado'); return null; }
    return { doc, buf: Buffer.from(doc.b64, 'base64') };
  }
  // Confere o R2 contra o Mongo: mesmos bytes (SHA-256) e mesmo tipo.
  async function conferir(d) {
    const m = await lerDoMongo(d);
    if (!m) return null;
    const noBucket = await cofre.ler(d.chave);
    if (!noBucket) { anotarErro(d, 'não está no R2'); return null; }
    if (sha(noBucket.buf) !== sha(m.buf)) { anotarErro(d, 'conteúdo no R2 DIFERENTE do Mongo'); return null; }
    const tipoMongo = String(m.doc.tipo || '').trim().toLowerCase();
    if (tipoMongo && String(noBucket.tipo || '').toLowerCase() !== tipoMongo) { anotarErro(d, `tipo diferente (${noBucket.tipo} × ${m.doc.tipo})`); return null; }
    return m;
  }

  if (op.modo === 'copiar') {
    // Chave presente = copiado: o PUT é atômico (o objeto existe inteiro ou não existe), e o
    // conteúdo é conferido byte a byte no --conferir. Assim rodar de novo só trafega o que falta.
    const lista = faltam.slice(0, op.limite);
    r.total = lista.length;
    r.jaEstavam = presentes.length;
    await emParalelo(lista, op.paralelo, async (d) => {
      try {
        const m = await lerDoMongo(d);
        if (m) {
          await cofre.gravar(d.chave, { buf: m.buf, tipo: m.doc.tipo, nome: m.doc.nome, ts: m.doc.ts || 0 });
          const h = await cofre.cabeca(d.chave);
          if (!h || h.bytes !== m.buf.length) anotarErro(d, 'o R2 não confirmou o tamanho depois de gravar');
          // O doc sumiu do Mongo enquanto copiava: excluído no site OU excluído e já devolvido
          // pelo Desfazer — que, com o R2 ligado, devolve o arquivo para o BUCKET, na mesma chave.
          // Apagar a cópia aqui podia apagar a única que restou. Fica; se ninguém mais a citar, a
          // faxina diária do servidor (que confere as referências) apaga depois de 1 h.
          else if (!(await col.findOne({ _id: d._id }, { projection: { _id: 1 } }))) { r.copiados++; r.bytes += m.buf.length; r.sumiramDurante++; }
          else { r.copiados++; r.bytes += m.buf.length; }
        }
      } catch (e) { anotarErro(d, e.message); }
      andar('copiar', lista);
    });
  } else if (op.modo === 'conferir') {
    const lista = validos.slice(0, op.limite);
    r.total = lista.length;
    await emParalelo(lista, op.paralelo, async (d) => {
      try { const m = await conferir(d); if (m) { r.conferidos++; r.bytes += m.buf.length; } } catch (e) { anotarErro(d, e.message); }
      andar('conferir', lista);
    });
  } else if (op.modo === 'apagar') {
    if (!permissao.ok) {
      log(`RECUSADO: ${permissao.motivo}`);
      r.recusado = true;
      return r;
    }
    // Só o que já está no bucket; o que falta copiar nem é tocado (e é avisado).
    const lista = presentes.slice(0, op.limite);
    if (faltam.length) log(`${num(faltam.length)} arquivo(s) ainda não copiado(s) ficam no Mongo (rode --copiar antes para incluí-los).`);
    log(`Vai conferir e apagar do Mongo até ${num(lista.length)} arquivo(s) (${tam(lista.reduce((t, d) => t + d.bytes, 0))}).`);
    log('Depois disso eles existem SÓ no R2. O backup .zip do site leva no máximo 50 MB de anexos: tenha a cópia do bucket (docs/ARQUIVOS_R2.md) antes.');
    if (!(await confirmar(FRASE_APAGAR))) { log('Cancelado: nada foi apagado.'); r.cancelado = true; return r; }
    // A pessoa pode ter levado tempo para digitar: confere de novo antes do 1º delete.
    const depoisDaFrase = await permissaoAgora();
    if (!depoisDaFrase.ok) { log(`RECUSADO: ${depoisDaFrase.motivo}`); r.recusado = true; return r; }
    // A marca vem ANTES do 1º delete: se o script morrer no meio, o servidor já sabe que parte
    // do acervo só existe no bucket (e avisa se algum dia subir sem ele).
    await col.updateOne({ _id: ID_MARCADOR }, { $set: { acervoNoR2: true, acervoBucket: bucket, acervoTs: Date.now() } }, { upsert: true });
    r.total = lista.length;
    // O apagar pode levar horas: de `reconferirACada` em `reconferirACada` arquivos TODOS os
    // processos param e a permissão inteira é refeita (marcador + deploy no ar + sinal de vida).
    // Rollback, deploy que desligou o R2 ou trocou o bucket → não passa. Site dormindo → a
    // consulta ao /api/versao o acorda; enquanto não responde, espera (tentativasReconferir ×
    // esperaReconferirMs, padrão 10 × 30 s) e só então interrompe — é retomável.
    let desdeConferencia = 0, conferindo = null;
    // Erro ao reconferir (ex.: leitura do marcador falhou no Atlas) é "sem permissão", nunca
    // "segue apagando": entra na mesma espera e, se não passar, interrompe (falha FECHADA).
    const aindaPode = async () => {
      let motivo = '';
      for (let t = 0; t <= op.tentativasReconferir; t++) {
        if (t) { log(`\nAguardando o site (${motivo}) — tentativa ${t}/${op.tentativasReconferir}…`); await dormir(op.esperaReconferirMs); }
        let p;
        try { p = await permissaoAgora(); } catch (e) { p = { ok: false, motivo: `não consegui ler o marcador (${e.message}).` }; }
        if (p.ok) return '';
        motivo = p.motivo;
      }
      return motivo;
    };
    const reconferirSeFaltar = () => {
      if (conferindo) return conferindo;
      if (++desdeConferencia < op.reconferirACada) return null;
      desdeConferencia = 0;
      conferindo = aindaPode()
        .then((motivo) => { if (motivo) r.interrompido = motivo; })
        .catch((e) => { r.interrompido = `falha ao reconferir: ${e.message}`; })
        .finally(() => { conferindo = null; });
      return conferindo;
    };
    await emParalelo(lista, op.paralelo, async (d) => {
      if (r.interrompido) return;
      try {
        await reconferirSeFaltar();
        if (r.interrompido) return;
        const m = await conferir(d);
        if (conferindo) await conferindo; // uma reconferência começou enquanto este conferia
        if (m && !r.interrompido) { await col.deleteOne({ _id: d._id }); r.apagados++; r.bytes += m.buf.length; }
      } catch (e) { anotarErro(d, e.message); }
      andar('apagar', lista);
    });
    if (r.interrompido) log(`\nINTERROMPIDO: ${r.interrompido} Nada mais foi apagado; confira o Render e rode de novo.`);
  }
  return r;
}

function imprimirResumo(r, log) {
  const linhas = {
    copiar: `Copiados: ${num(r.copiados)} (${tam(r.bytes)}) · já estavam: ${num(r.jaEstavam)}`
      + (r.sumiramDurante ? ` · ${num(r.sumiramDurante)} excluído(s) no site durante a cópia (a cópia fica; a faxina diária apaga se ninguém mais usar)` : ''),
    conferir: `Idênticos no R2: ${num(r.conferidos)} de ${num(r.total)} (${tam(r.bytes)})`,
    apagar: `Apagados do Mongo: ${num(r.apagados)} de ${num(r.total)} (${tam(r.bytes)} liberados; o "em disco" do Atlas pode levar um tempo para baixar)`,
  };
  if (linhas[r.modo] && !r.recusado && !r.cancelado) log(linhas[r.modo]);
  if (r.erros.length) {
    log(`${num(r.erros.length)} problema(s):`);
    for (const e of r.erros.slice(0, 30)) log(`  ${e.id}: ${e.motivo}`);
    if (r.erros.length > 30) log(`  … e mais ${num(r.erros.length - 30)}`);
    log('Rodar a mesma etapa de novo tenta só o que faltou.');
  }
}

async function confirmarNoTerminal(frase) {
  if (!process.stdin.isTTY) { console.error('A confirmação precisa de um terminal interativo.'); return false; }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const resposta = await new Promise((ok) => rl.question(`Digite ${frase} para continuar: `, ok));
  rl.close();
  return resposta.trim() === frase;
}

async function main() {
  const op = lerOpcoes(process.argv.slice(2));
  const exemplo = "$env:MONGODB_URI='mongodb+srv://...'; $env:MIDIA_S3_BUCKET='...'; (endpoint e chaves: ver o topo deste arquivo)";
  if (op.ajuda) { console.log(`Uso: node scripts/migrar-midia-r2.js [--copiar | --conferir | --apagar-do-mongo] [--limite=N] [--paralelo=N]\n${exemplo}`); return; }
  const { conferirUri } = require('./diagnostico-armazenamento-mongo');
  const { uri, erro } = conferirUri(process.env.MONGODB_URI);
  if (erro) { console.error(`MONGODB_URI: ${erro}`); process.exit(2); }
  const cfg = C.lerConfigCofre(process.env);
  if (!cfg.ativo) { console.error(`R2 não configurado: ${cfg.motivo}\n${exemplo}`); process.exit(2); }
  const cofre = C.criarCofre(cfg);

  // O deploy no ar, perguntado ao próprio site (/api/versao é público). 90 s de prazo: se o
  // Render tiver posto o site para dormir, esta chamada o acorda. GDJ_SITE_URL troca o endereço.
  const site = String(process.env.GDJ_SITE_URL || 'https://gestao.example.com').trim().replace(/\/+$/, '');
  const buildNoAr = async () => {
    const r = await fetch(site + '/api/versao', { signal: AbortSignal.timeout(90000), headers: { 'cache-control': 'no-cache' } });
    if (!r.ok) throw new Error(`${site}/api/versao respondeu ${r.status}`);
    return String((await r.json()).build || '');
  };

  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  let ultimaLinha = 0;
  const progresso = (t) => { const agora = Date.now(); if (agora - ultimaLinha > 1000) { ultimaLinha = agora; process.stdout.write('\r' + t + '   '); } };
  try {
    const col = client.db('frota').collection('app');
    const r = await executar({ col, cofre, bucket: cfg.s3.bucket, origem: cfg.origem, buildNoAr, opcoes: op, confirmar: confirmarNoTerminal, log: console.log, progresso });
    if (r.total) process.stdout.write('\n');
    imprimirResumo(r, console.log);
    if (r.modo === 'copiar' && !r.erros.length) console.log('Próximo passo: node scripts/migrar-midia-r2.js --conferir');
    if (r.modo === 'conferir' && !r.erros.length) console.log('Tudo idêntico. Antes de apagar do Mongo, faça a cópia do bucket (docs/ARQUIVOS_R2.md).');
    // Recusa e interrupção não são sucesso: `… --apagar-do-mongo && <próximo passo>` não pode seguir.
    if (r.erros.length || r.recusado || r.interrompido) process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('\nFalha na migração:', String((e && e.message) || e).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1***@'));
    process.exit(1);
  });
}

module.exports = { lerOpcoes, emParalelo, executar, FRASE_APAGAR };
