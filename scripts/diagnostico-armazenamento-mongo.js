'use strict';
// ============================================================================
// Diagnóstico SOMENTE-LEITURA do armazenamento do MongoDB de produção.
//
// Responde "quanto da cota do Atlas está ocupado, e com o quê?" — em especial quanto é o
// cofre de arquivos (docs `midia_<id>`, guardados em base64), o candidato a ir para o R2.
// O tamanho de cada documento é medido NO SERVIDOR ($bsonSize): só _id e números trafegam,
// nunca o base64 nem o nome do arquivo (que pode trazer nome de pessoa). Nenhum dado pessoal
// sai na tela.
//
// NÃO grava, NÃO deleta, NÃO corrige nada — leitura pura, seguro em produção.
// Exige MONGODB_URI: não há modo local (a base local é JSON fictício, ver scripts/seed-mock.js).
//
// USO — Windows (PowerShell, da pasta do projeto). Aspas SIMPLES: nas duplas o PowerShell
// troca `$algo` da senha por vazio e a conexão falha com "Authentication failed".
//   $env:MONGODB_URI='mongodb+srv://...'; node scripts/diagnostico-armazenamento-mongo.js
//   $env:MONGODB_URI='mongodb+srv://...'; node scripts/diagnostico-armazenamento-mongo.js --cota-mb=5120 --top=25
//   Remove-Item Env:MONGODB_URI      # ao terminar, tira a URI da sessão do terminal
// A URI é a MESMA do Render (serviço › Environment › MONGODB_URI). Valor colado errado
// (texto de exemplo, "MONGODB_URI=" na frente, comando do mongosh) é explicado sem ecoar o segredo.
// Opções: --cota-mb=N  tamanho do plano em MB (padrão 512 = Atlas M0 grátis)
//         --top=N      quantos itens nas listas de "maiores" (padrão 15)
//
// SAÍDA (exemplo; números ilustrativos):
//   1. OCUPAÇÃO DO BANCO "frota"
//      Dados (sem compressão) ......... 412,3 MB
//      Conta usada para a cota ........ 413,5 MB de 512 MB (81%)
//   2. O QUE OCUPA A COLEÇÃO "app"
//      Cofre de arquivos (midia_)         1.180     380,2 MB   92,0%
//   3. COFRE DE ARQUIVOS
//      1.180 arquivos · 380,2 MB no Mongo (base64) · ~285,0 MB de arquivo original
//      Média dos últimos 6 meses: 25,3 MB/mês → no ritmo atual a cota enche em ~4 meses
//   4. MAIORES DOCUMENTOS DE DADOS (limite do Mongo: 16 MB por documento)
//      funcionarios                        2,1 MB   13% do limite
//   5. SE O COFRE FOR PARA O R2
//      Sai do Mongo ................... ~380,6 MB
// ============================================================================

const BANCO = 'frota';
const COLECAO = 'app';
const LIMITE_DOC_BYTES = 16 * 1024 * 1024; // teto do Mongo por documento
const MS_DIA = 24 * 60 * 60 * 1000;
const FUSO_BR_MS = 3 * 60 * 60 * 1000;     // Brasília (UTC-3, sem horário de verão)

// Ordem importa: a 1ª que casar vence ('undo_midia_' antes do resto; 'Dados' pega o que sobrar).
// Os prefixos vêm do backend/server.js: salvarMidia ('midia_'), idMidiaUndo/idEstadoUndo/
// idParteUndo ('undo_*'), as cópias *_bak_ de manutenção/abastecimento/rastreadores e backup_auto.
const CATEGORIAS = [
  { chave: 'cofre', rotulo: 'Cofre de arquivos (midia_)', casa: (id) => id.startsWith('midia_') },
  { chave: 'undoMidia', rotulo: 'Desfazer: anexos em quarentena', casa: (id) => id.startsWith('undo_midia_') },
  { chave: 'undo', rotulo: 'Desfazer: estados e partes', casa: (id) => /^undo_(estado|parte)_/.test(id) },
  { chave: 'copias', rotulo: 'Cópias internas (_bak_, backup_auto)', casa: (id) => /_bak_/.test(id) || id === 'backup_auto' || id === 'frota_backup' },
  { chave: 'dados', rotulo: 'Dados do sistema (módulos)', casa: () => true },
];
function categoriaDe(id) { return CATEGORIAS.find((c) => c.casa(String(id))).chave; }

// ----- formatação -----
const num = (n, casas = 0) => Number(n || 0).toLocaleString('pt-BR', { minimumFractionDigits: casas, maximumFractionDigits: casas });
function tam(bytes) {
  const b = Number(bytes) || 0;
  if (b >= 1024 ** 3) return num(b / 1024 ** 3, 2) + ' GB';
  if (b >= 1024 ** 2) return num(b / 1024 ** 2, 1) + ' MB';
  return num(b / 1024, 0) + ' KB';
}
const pct = (parte, todo) => (todo > 0 ? num((parte / todo) * 100, 1) + '%' : '—');
const linhaPontos = (rotulo, valor) => `   ${(rotulo + ' ').padEnd(32, '.')} ${valor}`;
const mesBR = (ts) => new Date(ts - FUSO_BR_MS).toISOString().slice(0, 7);          // 'aaaa-mm'
const dataBR = (ts) => new Date(ts - FUSO_BR_MS).toISOString().slice(0, 10).split('-').reverse().join('/');

// ----- coleta (única parte que fala com o banco) -----
async function coletar(client) {
  const db = client.db(BANCO);
  const out = { bancos: null, erroBancos: '', dbStats: null, erroDbStats: '', colecoes: [], docsApp: [] };

  // A cota do Atlas é do CLUSTER, não do banco: se houver outro banco nele, ele também conta.
  try {
    const r = await client.db('admin').admin().listDatabases();
    out.bancos = { lista: (r.databases || []).map((d) => ({ nome: d.name, bytes: d.sizeOnDisk || 0 })), total: r.totalSize || 0 };
  } catch (e) { out.erroBancos = e.message; }

  try { out.dbStats = await db.command({ dbStats: 1 }); } catch (e) { out.erroDbStats = e.message; }

  const nomes = (await db.listCollections({}, { nameOnly: true }).toArray())
    .map((c) => c.name).filter((n) => !n.startsWith('system.'));
  for (const nome of nomes) {
    if (nome === COLECAO) continue; // a principal é medida documento a documento logo abaixo
    const [g] = await db.collection(nome).aggregate([
      { $group: { _id: null, n: { $sum: 1 }, bytes: { $sum: { $bsonSize: '$$ROOT' } } } },
    ], { maxTimeMS: 300000 }).toArray();
    out.colecoes.push({ nome, n: g ? g.n : 0, bytes: g ? g.bytes : 0 });
  }

  // Um item por documento, só com números: o base64 é medido no servidor e não trafega.
  const cursor = db.collection(COLECAO).aggregate([
    { $project: {
      _id: 1,
      bytes: { $bsonSize: '$$ROOT' },
      b64: { $cond: [{ $eq: [{ $type: '$b64' }, 'string'] }, { $strLenBytes: '$b64' }, 0] },
      tipo: { $cond: [{ $eq: [{ $type: '$tipo' }, 'string'] }, '$tipo', ''] },
      ts: { $cond: [{ $isNumber: '$ts' }, '$ts', 0] },
    } },
  ], { maxTimeMS: 300000, batchSize: 1000 });
  for await (const d of cursor) out.docsApp.push({ id: String(d._id), bytes: d.bytes, b64: d.b64, tipo: d.tipo, ts: d.ts });
  if (nomes.includes(COLECAO)) out.colecoes.unshift({ nome: COLECAO, n: out.docsApp.length, bytes: out.docsApp.reduce((s, d) => s + d.bytes, 0) });
  return out;
}

// ----- relatório (puro: recebe a coleta, devolve as linhas) -----
// USO: montarRelatorio(await coletar(client), { cotaMb: 512, top: 15, agora: Date.now() }).join('\n')
function montarRelatorio(c, { cotaMb = 512, top = 15, agora = Date.now() } = {}) {
  const L = [];
  const cota = cotaMb * 1024 * 1024;
  const docs = c.docsApp.map((d) => ({ ...d, cat: categoriaDe(d.id) }));
  const totalApp = docs.reduce((s, d) => s + d.bytes, 0);
  const totalColecoes = c.colecoes.reduce((s, x) => s + x.bytes, 0);

  L.push(`Gestão RM · armazenamento do MongoDB · somente leitura · ${new Date(agora).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`, '');

  // 1. Ocupação
  const s = c.dbStats;
  const dados = s ? s.dataSize : totalColecoes;
  const disco = s ? s.storageSize : 0;
  const indices = s ? s.indexSize : 0;
  const conta = Math.max(dados, disco) + indices;
  L.push(`1. OCUPAÇÃO DO BANCO "${BANCO}"`);
  L.push(linhaPontos('Dados (sem compressão)', tam(dados)));
  if (s) {
    L.push(linhaPontos('Em disco (comprimido)', tam(disco)));
    L.push(linhaPontos('Índices', tam(indices)));
  } else {
    L.push(`   (dbStats indisponível: ${c.erroDbStats} — usando a soma dos documentos)`);
  }
  L.push(linhaPontos('Conta usada para a cota', `${tam(conta)} de ${tam(cota)} (${pct(conta, cota)})`));
  L.push('   Conta conservadora: o maior entre dados e disco, mais os índices.');
  L.push('   O número oficial do Atlas fica em Clusters › Metrics.');
  if (c.bancos) {
    const outros = c.bancos.lista.filter((b) => ![BANCO, 'admin', 'local', 'config'].includes(b.nome));
    if (outros.length) {
      L.push('   ⚠ Há outros bancos no mesmo cluster, e a cota é do cluster inteiro:');
      for (const b of outros) L.push(`     ${b.nome.padEnd(28)} ${tam(b.bytes).padStart(11)} em disco`);
    }
  } else if (c.erroBancos) {
    L.push('   (sem permissão para listar os outros bancos do cluster; normal se o usuário só enxerga "frota")');
  }
  L.push('');

  // 2. Categorias
  L.push(`2. O QUE OCUPA A COLEÇÃO "${COLECAO}" (tamanho sem compressão)`);
  L.push(`   ${'Categoria'.padEnd(38)} ${'Docs'.padStart(7)} ${'Tamanho'.padStart(11)} ${'%'.padStart(7)}`);
  const porCat = CATEGORIAS.map((cat) => {
    const itens = docs.filter((d) => d.cat === cat.chave);
    return { ...cat, n: itens.length, bytes: itens.reduce((t, d) => t + d.bytes, 0) };
  }).sort((a, b) => b.bytes - a.bytes);
  for (const cat of porCat) {
    if (!cat.n) continue;
    L.push(`   ${cat.rotulo.padEnd(38)} ${num(cat.n).padStart(7)} ${tam(cat.bytes).padStart(11)} ${pct(cat.bytes, totalApp).padStart(7)}`);
  }
  L.push(`   ${'TOTAL'.padEnd(38)} ${num(docs.length).padStart(7)} ${tam(totalApp).padStart(11)}`);
  const outrasCol = c.colecoes.filter((x) => x.nome !== COLECAO);
  if (outrasCol.length) {
    L.push('   Outras coleções do banco:');
    for (const x of outrasCol) L.push(`     ${x.nome.padEnd(36)} ${num(x.n).padStart(7)} ${tam(x.bytes).padStart(11)}`);
  }
  L.push('');

  // 3. Cofre
  const cofre = docs.filter((d) => d.cat === 'cofre');
  const quarentena = docs.filter((d) => d.cat === 'undoMidia');
  const bytesCofre = cofre.reduce((t, d) => t + d.bytes, 0);
  const originalCofre = Math.round(cofre.reduce((t, d) => t + d.b64, 0) * 3 / 4); // base64 → bytes reais
  L.push('3. COFRE DE ARQUIVOS');
  if (!cofre.length) {
    L.push('   Nenhum documento midia_ no banco.');
  } else {
    L.push(`   ${num(cofre.length)} arquivos · ${tam(bytesCofre)} no Mongo (base64) · ~${tam(originalCofre)} de arquivo original`);
    L.push('   Por tipo:');
    const tipos = new Map();
    for (const d of cofre) {
      const t = tipos.get(d.tipo || '(sem tipo)') || { n: 0, bytes: 0 };
      t.n++; t.bytes += d.bytes; tipos.set(d.tipo || '(sem tipo)', t);
    }
    for (const [t, v] of [...tipos].sort((a, b) => b[1].bytes - a[1].bytes)) {
      L.push(`     ${t.padEnd(22)} ${num(v.n).padStart(7)} ${tam(v.bytes).padStart(11)}`);
    }

    // Crescimento: só conta o que AINDA está no cofre (órfão apagado pela faxina não aparece).
    const meses = [];
    const [ano, mes] = mesBR(agora).split('-').map(Number);
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(ano, mes - 1 - i, 1));
      meses.push(d.toISOString().slice(0, 7));
    }
    const porMes = new Map(meses.map((m) => [m, { n: 0, bytes: 0 }]));
    let semData = 0;
    for (const d of cofre) {
      if (!d.ts) { semData++; continue; }
      const m = porMes.get(mesBR(d.ts));
      if (m) { m.n++; m.bytes += d.bytes; }
    }
    L.push('   Enviados por mês (arquivos que ainda estão no cofre; o mês atual está incompleto):');
    for (const m of meses) {
      const v = porMes.get(m);
      L.push(`     ${m}   ${num(v.n).padStart(6)} ${tam(v.bytes).padStart(11)}`);
    }
    if (semData) L.push(`     (${num(semData)} arquivo(s) sem data de envio)`);
    // Média só dos meses FECHADOS a partir do 1º com envio: os meses vazios de antes de o cofre
    // começar a ser usado puxavam a média para baixo (3 meses reais divididos por 6).
    const fechados = meses.slice(-7, -1).map((m) => porMes.get(m).bytes); // até 6 meses fechados
    const inicio = fechados.findIndex((b) => b > 0);
    const considerados = inicio < 0 ? [] : fechados.slice(inicio);
    const media = considerados.length ? considerados.reduce((t, b) => t + b, 0) / considerados.length : 0;
    const livre = cota - conta;
    let previsao = '';
    if (livre <= 0) previsao = ' → a cota informada já foi ultrapassada (confira --cota-mb)';
    else if (media > 0) {
      const dias = Math.round(livre / (media / 30));
      previsao = dias < 60 ? ` → no ritmo atual a cota enche em ~${num(Math.max(1, dias))} dia(s)` : ` → no ritmo atual a cota enche em ~${num(Math.round(dias / 30))} mês(es)`;
    }
    L.push(`   Média de ${considerados.length} mês(es) fechado(s) com envio: ${tam(media)}/mês${previsao}`);

    L.push(`   Maiores arquivos (top ${top}):`);
    for (const d of [...cofre].sort((a, b) => b.bytes - a.bytes).slice(0, top)) {
      L.push(`     ${d.id.padEnd(30)} ${(d.tipo || '').padEnd(16)} ${tam(d.bytes).padStart(9)}${d.ts ? '  enviado em ' + dataBR(d.ts) : ''}`);
    }
  }
  if (quarentena.length) {
    const antigos = quarentena.filter((d) => d.ts && agora - d.ts > MS_DIA).length;
    L.push(`   Desfazer: ${num(quarentena.length)} anexo(s) em quarentena, ${tam(quarentena.reduce((t, d) => t + d.bytes, 0))}${antigos ? ` (${num(antigos)} com mais de 1 dia)` : ''}`);
  }
  L.push('');

  // 4. Documentos de dados perto do teto de 16 MB
  L.push('4. MAIORES DOCUMENTOS DE DADOS (o Mongo recusa documento acima de 16 MB)');
  const dadosDocs = docs.filter((d) => d.cat !== 'cofre' && d.cat !== 'undoMidia').sort((a, b) => b.bytes - a.bytes).slice(0, top);
  for (const d of dadosDocs) {
    const fr = d.bytes / LIMITE_DOC_BYTES;
    const alerta = fr >= 0.75 ? '  ⚠ PERTO DO LIMITE' : fr >= 0.5 ? '  ⚠ passou da metade' : '';
    L.push(`   ${d.id.slice(0, 40).padEnd(40)} ${tam(d.bytes).padStart(11)}   ${num(fr * 100, 0).padStart(3)}% do limite${alerta}`);
  }
  L.push('');

  // 5. Simulação do R2
  const saiDoMongo = bytesCofre + quarentena.reduce((t, d) => t + d.bytes, 0);
  const ficaNoMongo = Math.max(0, conta - saiDoMongo);
  const noR2 = originalCofre + Math.round(quarentena.reduce((t, d) => t + d.b64, 0) * 3 / 4);
  L.push('5. SE O COFRE FOR PARA O R2 (aproximado)');
  L.push(linhaPontos('Sai do Mongo', `~${tam(saiDoMongo)} (cofre + quarentena do Desfazer)`));
  L.push(linhaPontos('O Mongo ficaria com', `~${tam(ficaNoMongo)} de ${tam(cota)} (${pct(ficaNoMongo, cota)})`));
  L.push(linhaPontos('O R2 guardaria', `~${tam(noR2)} (arquivo original, sem base64); plano grátis: 10 GB`));
  return L;
}

// Confere a URI ANTES de conectar e explica o erro sem imprimir o valor (é credencial).
// Tira só o que nunca faz parte da URI: espaços, aspas em volta e caracteres invisíveis de cópia.
// USO: const { uri, erro } = conferirUri(process.env.MONGODB_URI);
//      conferirUri(' "mongodb+srv://u:s@c.net/" ')  => { uri: 'mongodb+srv://u:s@c.net/' }
//      conferirUri('<sua URI>')                     => { erro: 'Ficou o texto de exemplo …' }
function conferirUri(bruta) {
  const uri = String(bruta || '').replace(/^[\s﻿​]+|[\s﻿​]+$/g, '').replace(/^(['"])(.*)\1$/s, '$2').trim();
  if (/^mongodb(\+srv)?:\/\//.test(uri)) {
    if (/<(db_)?password>|<senha>/i.test(uri)) return { erro: 'A URI ainda tem o marcador <db_password> do Atlas: troque pela senha real (ou copie a URI pronta do Render › Environment › MONGODB_URI).' };
    return { uri };
  }
  const n = uri.length;
  if (!n) return { erro: 'MONGODB_URI está vazia.' };
  if (/^MONGODB_URI\s*=/i.test(uri)) return { erro: 'O valor começa com "MONGODB_URI=": copie só o que vem depois do sinal de igual.' };
  if (/^mongosh\b/i.test(uri)) return { erro: 'Foi colado o comando do mongosh (tela Connect › Shell do Atlas). Use a URI do Render › Environment › MONGODB_URI.' };
  const pos = uri.search(/mongodb(\+srv)?:\/\//);
  // O que vem ANTES do "mongodb" não é a URI (é sobra de cópia), então dá para mostrar.
  if (pos > 0) return { erro: `Há ${pos} caractere(s) antes de "mongodb": ${JSON.stringify(uri.slice(0, Math.min(pos, 20)))}${pos > 20 ? '…' : ''}. Apague essa parte.` };
  if (uri.startsWith('<')) return { erro: 'Ficou o texto de exemplo (entre < >) no lugar da URI. Troque pelo valor do Render › Environment › MONGODB_URI.' };
  return { erro: `O valor (${n} caracteres) não tem "mongodb://" nem "mongodb+srv://", então não é a string de conexão. Copie a do Render › Environment › MONGODB_URI.` };
}

function lerOpcoes(argv) {
  const op = { cotaMb: 512, top: 15 };
  for (const a of argv) {
    const m = /^--(cota-mb|top)=(\d+)$/.exec(a);
    if (m && m[1] === 'cota-mb') op.cotaMb = Math.max(1, Number(m[2]));
    else if (m && m[1] === 'top') op.top = Math.min(200, Math.max(1, Number(m[2])));
    else if (a === '--ajuda' || a === '-h') op.ajuda = true;
    else throw new Error(`Opção desconhecida: ${a} (use --cota-mb=N e/ou --top=N)`);
  }
  return op;
}

async function main() {
  const op = lerOpcoes(process.argv.slice(2));
  const exemplo = "$env:MONGODB_URI='mongodb+srv://...'; node scripts/diagnostico-armazenamento-mongo.js";
  if (op.ajuda) { console.log(`Uso: ${exemplo} [--cota-mb=512] [--top=15]`); return; }
  if (!process.env.MONGODB_URI) {
    console.error(`Defina MONGODB_URI antes (PowerShell, com aspas simples): ${exemplo}`);
    process.exit(2);
  }
  const { uri, erro } = conferirUri(process.env.MONGODB_URI);
  if (erro) {
    console.error(`MONGODB_URI inválida: ${erro}\nExemplo (PowerShell, com aspas simples): ${exemplo}`);
    process.exit(2);
  }
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    console.log('Medindo… (percorre o banco inteiro no servidor; pode levar até alguns minutos)\n');
    console.log(montarRelatorio(await coletar(client), op).join('\n'));
  } finally {
    await client.close().catch(() => {});
  }
}

if (require.main === module) {
  // Redige credenciais de URI antes de imprimir (erros de conexão do driver podem citar a MONGODB_URI).
  main().catch((e) => {
    console.error('Falha no diagnóstico:', String((e && e.message) || e).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1***@'));
    process.exit(1);
  });
}

module.exports = { categoriaDe, montarRelatorio, lerOpcoes, conferirUri };
