'use strict';
// ============================================================================
// Ajusta os DIAS de experiência de um contrato e RECALCULA o fim da experiência
// dos funcionários dele. Nasceu do caso ATLAS CONSTRUÇÃO PREDIAL (Nº 4600009606),
// que caía nos 45 dias padrão e deveria ser 30.
//
// Faz DUAS coisas:
//   1. Grava o override em sistema_config.experienciaDias.contratos['<numero>'] = <dias>.
//   2. Recalcula experienciaFim = admissao + (dias-1) para cada funcionário cujo
//      contrato PRINCIPAL (contratos[0].numero) é esse número e que tem admissão.
//      (O padrão de cálculo do server usa só o contrato principal.)
//
// Por que o passo 2 é preciso: o experienciaFim fica GRAVADO por funcionário e o
// save preserva o valor existente — mudar só o override não recalcula os já
// cadastrados. ponytail: recomputa direto (sobrescreve inclusive um eventual fim
// editado à mão, raro nesse contrato) — dry-run mostra o antes/depois p/ conferir.
//
// Modos (mesma regra do server.js):
//   • LOCAL (sem MONGODB_URI): lê/grava data/funcionarios.json + data/sistema_config.json.
//   • MONGO (com MONGODB_URI): docs _id 'funcionarios' e 'sistema_config' em db('frota').collection('app').
//
// Uso (PowerShell, da pasta do projeto):
//   node scripts/recalc-experiencia-contrato.js                         # dry-run: ATLAS 4600009606 = 30
//   node scripts/recalc-experiencia-contrato.js 4600009606 30           # dry-run, explícito
//   node scripts/recalc-experiencia-contrato.js --apply                 # grava (backup antes)
//   $env:MONGODB_URI="..."; node scripts/recalc-experiencia-contrato.js --apply   # em produção
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
const pos = args.filter(a => !a.startsWith('--'));
const NUMERO = String(pos[0] || '4600009606').trim(); // ATLAS CONSTRUÇÃO PREDIAL
const DIAS = Number(pos[1] || 30);

// Fim da experiência: a ADMISSÃO conta como 1º dia → fim = admissão + (dias-1). (espelha o server)
function calcFimExperiencia(admissaoISO, dias) {
  const m = String(admissaoISO || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m || !dias) return '';
  const dt = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  dt.setDate(dt.getDate() + (dias - 1));
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getFullYear()}-${p(dt.getMonth() + 1)}-${p(dt.getDate())}`;
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

// Recalcula experienciaFim dos funcionários cujo contrato principal é NUMERO. Muta em memória.
function planejarFuncs(funcionarios) {
  const mudancas = [];
  for (const f of funcionarios || []) {
    const c0 = (Array.isArray(f.contratos) && f.contratos[0]) || null;
    const num = c0 && String(c0.numero || '').trim();
    if (num !== NUMERO) continue;
    if (!f.admissao) continue; // sem admissão não dá p/ calcular
    const novo = calcFimExperiencia(f.admissao, DIAS);
    if (novo && novo !== (f.experienciaFim || '')) {
      mudancas.push({ nome: f.nome, admissao: String(f.admissao).slice(0, 10), de: f.experienciaFim || '(vazio)', para: novo });
      f.experienciaFim = novo;
    }
  }
  return mudancas;
}

function lerJSONLocal(file, padrao) {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch (e) { return padrao; }
}

async function main() {
  console.log(`Modo: ${USE_MONGO ? 'MONGO' : 'LOCAL (' + DATA_DIR + ')'}`);
  console.log(`Contrato: ${NUMERO}  →  ${DIAS} dias de experiência`);
  console.log(`Ação: ${APLICAR ? 'APLICAR (grava)' : 'DRY-RUN (só mostra)'}\n`);

  if (!(DIAS > 0)) { console.error('Dias inválido:', DIAS); process.exit(1); }

  let mongoClient = null, col = null;
  let funcionarios, config, fileFunc, fileCfg;

  if (USE_MONGO) {
    const { MongoClient } = require('mongodb');
    mongoClient = new MongoClient(process.env.MONGODB_URI);
    await mongoClient.connect();
    col = mongoClient.db('frota').collection('app');
    const docF = await col.findOne({ _id: 'funcionarios' });
    const docC = await col.findOne({ _id: 'sistema_config' });
    funcionarios = (docF && Array.isArray(docF.funcionarios)) ? docF.funcionarios : [];
    config = docC || {};
  } else {
    fileFunc = path.join(DATA_DIR, 'funcionarios.json');
    fileCfg = path.join(DATA_DIR, 'sistema_config.json');
    const o = lerJSONLocal(fileFunc, { funcionarios: [] });
    funcionarios = Array.isArray(o) ? o : (Array.isArray(o.funcionarios) ? o.funcionarios : []);
    config = lerJSONLocal(fileCfg, {});
  }

  // 1) Override de dias no sistema_config.
  const expDias = config.experienciaDias && typeof config.experienciaDias === 'object'
    ? config.experienciaDias : { padrao: 45, contratos: {} };
  expDias.contratos = expDias.contratos || {};
  const diasAntes = expDias.contratos[NUMERO];
  const configVaiMudar = Number(diasAntes) !== DIAS;
  expDias.contratos[NUMERO] = DIAS;
  config.experienciaDias = expDias;

  console.log(`Override de dias: ${diasAntes === undefined ? '(não existia)' : diasAntes} → ${DIAS}` + (configVaiMudar ? '' : '  (já estava correto)'));

  // 2) Recalcular funcionários do contrato.
  const antesFunc = JSON.stringify(funcionarios);
  const mudancas = planejarFuncs(funcionarios);

  console.log(`\nFuncionários com contrato principal ${NUMERO}: ${funcionarios.filter(f => { const c0 = (Array.isArray(f.contratos) && f.contratos[0]); return c0 && String(c0.numero || '').trim() === NUMERO; }).length}`);
  console.log(`Fim da experiência a recalcular: ${mudancas.length}`);
  for (const m of mudancas) console.log(`  • ${m.nome || '?'} (adm ${m.admissao}): ${m.de} → ${m.para}`);

  if (!configVaiMudar && !mudancas.length) {
    console.log('\nNada a fazer: override já estava certo e nenhum fim de experiência mudou.');
    if (mongoClient) await mongoClient.close();
    return;
  }

  if (!APLICAR) {
    console.log('\nDRY-RUN — nada foi gravado. Rode de novo com --apply para aplicar.');
    if (mongoClient) await mongoClient.close();
    return;
  }

  // Backup ANTES de gravar (config + funcionários).
  const dirBk = path.join(DATA_DIR, 'backups');
  fs.mkdirSync(dirBk, { recursive: true });
  const bk = path.join(dirBk, `recalc-exp-${NUMERO}-${stamp()}.json`);
  fs.writeFileSync(bk, JSON.stringify({ experienciaDias_antes: { contratos: { [NUMERO]: diasAntes } }, funcionarios_antes: JSON.parse(antesFunc) }, null, 2));
  console.log(`\nBackup do estado anterior salvo em: ${bk}`);

  if (USE_MONGO) {
    await col.updateOne({ _id: 'sistema_config' }, { $set: { experienciaDias: config.experienciaDias } }, { upsert: true });
    await col.updateOne({ _id: 'funcionarios' }, { $set: { funcionarios } }, { upsert: true });
    console.log('Gravado no MongoDB. ⚠️ Reinicie/redeploy o Render (Manual Deploy) para o site refletir.');
    await mongoClient.close();
  } else {
    const atualCfg = lerJSONLocal(fileCfg, {});
    atualCfg.experienciaDias = config.experienciaDias;
    fs.writeFileSync(fileCfg, JSON.stringify(atualCfg, null, 2));
    fs.writeFileSync(fileFunc, JSON.stringify(funcionarios, null, 2));
    console.log('Gravado nos arquivos locais. Um F5 no site já reflete.');
  }
  console.log('Pronto.');
}

main().catch((e) => { console.error('Falhou:', e.message); process.exit(1); });
