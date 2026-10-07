'use strict';
// ============================================================================
// Tranca ('nenhum') abas para os usuários COMUNS que hoje as veem por padrão
// implícito ('editar' de área ausente no mapa). Serve para abas que subiram
// LIBERADAS por engano (ex.: Contabilidade, Investimentos): o admin libera
// manualmente depois quem precisar.
//
// Só toca em usuário COMUM e só quando a área NÃO tem valor explícito no mapa
// (não sobrescreve 'ver'/'nenhum'/'editar' já definidos). Admin/dev e o admin
// mestre (senhaEnv) têm acesso total — são ignorados.
//
// Modos (sem subir o servidor), mesma regra do server.js:
//   • LOCAL (sem MONGODB_URI): lê/grava data/usuarios.json.
//   • MONGO (com MONGODB_URI): doc _id 'usuarios' em db('frota').collection('app').
//
// Uso (PowerShell, da pasta do projeto):
//   node scripts/trancar-abas-novas.js                      # dry-run (não grava), abas padrão
//   node scripts/trancar-abas-novas.js contabilidade investimentos
//   node scripts/trancar-abas-novas.js --apply              # grava (faz backup antes)
//   $env:MONGODB_URI="..."; node scripts/trancar-abas-novas.js --apply   # em produção
// Dry-run é o PADRÃO. Backup automático antes de gravar. Em Mongo, reinicie/redeploy
// o Render depois (alteração direta no banco só reflete após restart).
// ============================================================================
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(RAIZ, 'data');
const USE_MONGO = !!process.env.MONGODB_URI;

const args = process.argv.slice(2);
const APLICAR = args.includes('--apply');
const AREAS = args.filter(a => !a.startsWith('--'));
const AREAS_ALVO = AREAS.length ? AREAS : ['contabilidade', 'investimentos'];

const ehAdmin = (u) => u && (u.senhaEnv || u.nivel === 'admin' || u.nivel === 'dev');

// Aplica o plano de trancamento a uma lista de usuários (muta em memória). Devolve o relatório.
function planejar(usuarios) {
  const mudancas = [];
  for (const u of usuarios || []) {
    if (ehAdmin(u)) continue;
    u.permissoes = u.permissoes || {};
    for (const area of AREAS_ALVO) {
      if (u.permissoes[area] === undefined) {
        mudancas.push({ usuario: u.usuario, nome: u.nome, area });
        u.permissoes[area] = 'nenhum';
      }
    }
  }
  return mudancas;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  console.log(`Modo: ${USE_MONGO ? 'MONGO' : 'LOCAL (' + DATA_DIR + ')'}`);
  console.log(`Abas a trancar p/ comuns (se estiverem implícitas): ${AREAS_ALVO.join(', ')}`);
  console.log(`Ação: ${APLICAR ? 'APLICAR (grava)' : 'DRY-RUN (só mostra)'}\n`);

  let mongoClient = null;
  let store; // { usuarios, cadastrosAbertos }

  if (USE_MONGO) {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    const col = mongoClient.db('frota').collection('app');
    const doc = await col.findOne({ _id: 'usuarios' });
    store = { usuarios: (doc && Array.isArray(doc.usuarios)) ? doc.usuarios : [], cadastrosAbertos: doc ? doc.cadastrosAbertos !== false : true };
    store._col = col;
  } else {
    const file = path.join(DATA_DIR, 'usuarios.json');
    const o = JSON.parse(fs.readFileSync(file, 'utf-8'));
    store = { usuarios: Array.isArray(o.usuarios) ? o.usuarios : [], cadastrosAbertos: o.cadastrosAbertos !== false, _file: file };
  }

  const antes = JSON.stringify({ usuarios: store.usuarios, cadastrosAbertos: store.cadastrosAbertos });
  const mudancas = planejar(store.usuarios);

  if (!mudancas.length) {
    console.log('Nada a fazer: nenhum usuário comum tem essas abas implícitas (já trancadas ou concedidas explicitamente).');
    if (mongoClient) await mongoClient.close();
    return;
  }

  console.log(`${mudancas.length} entrada(s) a trancar:`);
  for (const m of mudancas) console.log(`  • ${m.nome || '?'} (@${m.usuario}) → ${m.area} = nenhum`);
  console.log('');

  if (!APLICAR) {
    console.log('DRY-RUN — nada foi gravado. Rode de novo com --apply para aplicar.');
    if (mongoClient) await mongoClient.close();
    return;
  }

  // Backup do estado ANTES de gravar.
  const dirBk = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dirBk, { recursive: true });
  const bk = path.join(dirBk, `usuarios-antes-trancar-${stamp()}.json`);
  fs.writeFileSync(bk, antes);
  console.log(`Backup dos usuários salvo em: ${bk}`);

  const dados = { usuarios: store.usuarios, cadastrosAbertos: store.cadastrosAbertos };
  if (USE_MONGO) {
    await store._col.updateOne({ _id: 'usuarios' }, { $set: dados }, { upsert: true });
    console.log('Gravado no MongoDB. ⚠️ Reinicie/redeploy o Render (Manual Deploy) para o site refletir.');
    await mongoClient.close();
  } else {
    fs.writeFileSync(store._file, JSON.stringify(dados, null, 2));
    console.log('Gravado no arquivo local. Um F5 no site já reflete.');
  }
  console.log('Pronto.');
}

main().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
