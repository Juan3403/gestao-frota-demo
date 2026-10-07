'use strict';
// ============================================================================
// Converte as multas com situação CONCLUÍDO para PAGO. A opção CONCLUÍDO saiu
// da interface (v1.53.35+); este script alinha os registros antigos.
//
// Não inventa dataPagamento: multa convertida sem data de pagamento fica com o
// campo vazio (a regra do server só preenche em edição pela interface) — o
// dry-run lista quantas ficam assim.
//
// Modos (sem subir o servidor), mesma regra do server.js:
//   • LOCAL (sem MONGODB_URI): lê/grava data/multas.json.
//   • MONGO (com MONGODB_URI): doc _id 'multas' em db('frota').collection('app').
//
// Uso (PowerShell, da pasta do projeto):
//   node scripts/converter-multas-concluidas.js            # dry-run (só mostra)
//   node scripts/converter-multas-concluidas.js --apply    # grava (faz backup antes)
//   $env:MONGODB_URI="..."; node scripts/converter-multas-concluidas.js --apply  # produção
// Saída (exemplo): "3 multa(s) a converter: • MOK1A01 AA1000000 CONCLUÍDO → PAGO".
// Dry-run é o PADRÃO. Backup automático antes de gravar. Em Mongo, reinicie/redeploy
// o Render depois (alteração direta no banco só reflete após restart).
// ============================================================================
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(RAIZ, 'data');
const USE_MONGO = !!process.env.MONGODB_URI;
const APLICAR = process.argv.slice(2).includes('--apply');

const ehConcluida = (m) => String(m && m.situacao || '').toUpperCase().includes('CONCLU');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  console.log(`Modo: ${USE_MONGO ? 'MONGO' : 'LOCAL (' + DATA_DIR + ')'}`);
  console.log(`Ação: ${APLICAR ? 'APLICAR (grava)' : 'DRY-RUN (só mostra)'}\n`);

  let mongoClient = null;
  let multas, col, file;

  if (USE_MONGO) {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    col = mongoClient.db('frota').collection('app');
    const doc = await col.findOne({ _id: 'multas' });
    multas = (doc && Array.isArray(doc.multas)) ? doc.multas : [];
  } else {
    file = path.join(DATA_DIR, 'multas.json');
    const o = JSON.parse(fs.readFileSync(file, 'utf-8'));
    multas = Array.isArray(o.multas) ? o.multas : [];
  }

  const antes = JSON.stringify({ multas });
  const alvo = multas.filter(ehConcluida);

  if (!alvo.length) {
    console.log('Nada a fazer: nenhuma multa com situação CONCLUÍDO.');
    if (mongoClient) await mongoClient.close();
    return;
  }

  console.log(`${alvo.length} multa(s) a converter:`);
  let semData = 0;
  for (const m of alvo) {
    if (!m.dataPagamento) semData++;
    console.log(`  • ${m.placa || '?'} ${m.autoInfracao || ''} ${m.situacao} → PAGO${m.dataPagamento ? '' : ' (sem data de pagamento — fica vazia)'}`);
    m.situacao = 'PAGO';
  }
  if (semData) console.log(`\n${semData} ficarão como PAGO sem data de pagamento (preencha depois pela tela, se quiser).`);
  console.log('');

  if (!APLICAR) {
    console.log('DRY-RUN — nada foi gravado. Rode de novo com --apply para aplicar.');
    if (mongoClient) await mongoClient.close();
    return;
  }

  // Backup do estado ANTES de gravar.
  const dirBk = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dirBk, { recursive: true });
  const bk = path.join(dirBk, `multas-antes-converter-${stamp()}.json`);
  fs.writeFileSync(bk, antes);
  console.log(`Backup das multas salvo em: ${bk}`);

  if (USE_MONGO) {
    await col.updateOne({ _id: 'multas' }, { $set: { multas } }, { upsert: true });
    console.log('Gravado no MongoDB. ⚠️ Reinicie/redeploy o Render (Manual Deploy) para o site refletir.');
    await mongoClient.close();
  } else {
    fs.writeFileSync(file, JSON.stringify({ multas }, null, 2));
    console.log('Gravado no arquivo local. Um F5 no site já reflete.');
  }
  console.log('Pronto.');
}

main().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
