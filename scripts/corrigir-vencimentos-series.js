'use strict';
// ============================================================================
// Recalcula os VENCIMENTOS de séries de contratos que nasceram deslocadas (parcelas
// geradas a partir de uma referência errada, antes da âncora única da 1.55.34).
//
// REGRA (a mesma do sistema — bloco ÂNCORA DA SÉRIE em backend/server.js):
//     vencimento(n) = vencimento(01) + (n − 1) meses
// A âncora é SEMPRE a parcela 01 da série. Sem 01, ou com a 01 sem vencimento, a série
// inteira vai para REVISÃO — o script não elege outra âncora por conta própria.
//
// QUATRO categorias (nada é apagado, nada é criado):
//   1. CORRIGIR              — parcela NÃO PAGA cujo vencimento cai em MÊS diferente do esperado:
//                              é a assinatura do bug (série inteira deslocada). Regrava no --apply.
//   2. SÓ O DIA              — parcela NÃO PAGA no mês certo e no dia errado: só relatório. Dia
//                              deslocado costuma ser ajuste legítimo de data bancária (fim de
//                              semana/feriado). Entra no --apply apenas com --incluir-dia.
//   3. PAGA DIVERGENTE       — parcela PAGA com vencimento ≠ esperado: só relatório. Parcela paga
//                              é fato consumado (o dinheiro saiu naquele dia); mexer nela é decisão
//                              humana, não de script.
//   4. REVISÃO               — série sem 01, 01 sem vencimento, ou a MESMA parcela em vencimentos
//                              diferentes (ambígua): série inteira intocada.
// NUNCA toca: valorPago, dataPagamento, parcela, parcelasPagas, parcelasFaltantes, id, ts, serieId,
// nem qualquer parcela paga. Série sem serieId fica FORA (o servidor atribui os ids no boot/uso;
// abra o sistema uma vez e rode de novo).
//
// ⚠ LIMITE: o script conserta série deslocada EM RELAÇÃO À 01. Se a própria 01 estiver errada
// (caso da planilha importada com o dia trocado), a série toda é coerente com ela e nada aparece
// aqui — corrija a 01 no formulário primeiro e rode de novo.
//
// Modos (sem subir o servidor), mesma regra do server.js:
//   • LOCAL (sem MONGODB_URI): lê/grava data/contratos.json (ou $env:DATA_DIR).
//   • MONGO (com MONGODB_URI): doc _id 'contratos' em db('frota').collection('app').
//
// Uso (PowerShell, da pasta do projeto):
//   node scripts/corrigir-vencimentos-series.js                  # dry-run (relatório, não grava)
//   node scripts/corrigir-vencimentos-series.js --apply          # grava o desvio de MÊS (backup antes)
//   node scripts/corrigir-vencimentos-series.js --apply --incluir-dia   # grava também o desvio só de dia
//   $env:MONGODB_URI="..."; node scripts/corrigir-vencimentos-series.js --apply  # produção
// Ex. de saída: "07/20  VCTO 21/07/2026 → 15/06/2026  [CAMINHONETE (série CS…, /20), âncora 01/20 = 15/12/2025]"
// Em Mongo, reinicie/redeploy o Render depois (alteração direta só reflete após restart).
// ============================================================================
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(RAIZ, 'data');
const USE_MONGO = !!process.env.MONGODB_URI;
const APLICAR = process.argv.includes('--apply');
const INCLUIR_DIA = process.argv.includes('--incluir-dia');
const ARQUIVO = path.join(DATA_DIR, 'contratos.json');

const pago = (c) => (Number(c && c.valorPago) > 0) || !!(c && c.dataPagamento && String(c.dataPagamento).trim());
const parcNM = (c) => { const m = String((c && c.parcela) || '').match(/(\d+)\s*\/\s*(\d+)/); return m ? { numero: +m[1], total: +m[2] } : null; };

// ESPELHO de somarMesesContratoBR (backend/server.js) / addMesesBR (frontend/app.js): clamp no
// último dia do mês e SEMPRE a partir da âncora — 31/01 +1 → 28/02, +2 → 31/03, sem cascata.
function somarMesesBR(dataBR, meses) {
  const m = String(dataBR || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  const dia = Number(m[1]);
  let ano = Number(m[3]); if (ano < 100) ano += 2000;
  const d = new Date(ano, Number(m[2]) - 1 + meses, 1);
  const ultimoDia = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(dia, ultimoDia));
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}

// "mm/aaaa" de uma data BR — o que separa desvio de MÊS (bug de série deslocada) de desvio só de
// DIA (ajuste de data bancária). Ex.: mesAnoBR('12/04/2023') === '04/2023'
const mesAnoBR = (s) => String(s || '').slice(3);

// Analisa a lista inteira e devolve { corrigir, diaDivergente, pagasDivergentes, revisao, semSerie }
// SEM mutar nada.
// Ex.: planejar([{id:'a',serieId:'S',parcela:'01/20',vencimento:'15/12/2025'},
//                {id:'b',serieId:'S',parcela:'02/20',vencimento:'21/01/2026'}]).diaDivergente[0].depois === '15/01/2026'
function planejar(contratos) {
  const corrigir = [], diaDivergente = [], pagasDivergentes = [], revisao = [];
  let semSerie = 0;
  const grupos = new Map();
  for (const c of contratos) {
    const nm = parcNM(c);
    if (!nm) continue;
    const serieId = String(c.serieId || '').trim();
    if (!serieId) { semSerie++; continue; }
    const chave = `${serieId}|${nm.total}`;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push({ c, ...nm });
  }
  for (const itens of grupos.values()) {
    const rotulo = `${itens[0].c.material || itens[0].c.banco || '?'} (série ${itens[0].c.serieId}, /${itens[0].total})`;
    // Ambígua: o mesmo número em vencimentos diferentes. Não dá para saber qual linha é a verdade.
    const datasPorNumero = new Map();
    for (const x of itens) {
      if (!String(x.c.vencimento || '').trim()) continue;
      if (!datasPorNumero.has(x.numero)) datasPorNumero.set(x.numero, new Set());
      datasPorNumero.get(x.numero).add(x.c.vencimento);
    }
    if ([...datasPorNumero.values()].some(datas => datas.size > 1)) {
      revisao.push({ serie: rotulo, motivo: 'a mesma parcela aparece com vencimentos diferentes' });
      continue;
    }
    const ancora = itens.find(x => x.numero === 1);
    if (!ancora) { revisao.push({ serie: rotulo, motivo: 'a série não tem a parcela 01' }); continue; }
    const base = String(ancora.c.vencimento || '').trim();
    if (!base) { revisao.push({ serie: rotulo, motivo: 'a parcela 01 está sem vencimento' }); continue; }
    for (const x of itens) {
      if (x.numero === 1) continue; // a âncora nunca é recalculada
      const esperado = somarMesesBR(base, x.numero - 1);
      const atual = String(x.c.vencimento || '').trim();
      if (!esperado || esperado === atual) continue;
      const registro = { serie: rotulo, ancora: `${ancora.c.parcela} = ${base}`, parcela: x.c.parcela, id: x.c.id, antes: atual, depois: esperado };
      if (pago(x.c)) pagasDivergentes.push(registro);
      else if (atual && mesAnoBR(atual) === mesAnoBR(esperado)) diaDivergente.push(registro);
      else corrigir.push(registro);
    }
  }
  return { corrigir, diaDivergente, pagasDivergentes, revisao, semSerie };
}

// Aplica a categoria 1 (desvio de MÊS) e, com `incluirDia`, também a 2 (só o dia). Reconfere o
// pagamento na hora de gravar: se a linha virou paga entre o planejamento e a aplicação, é pulada.
function aplicar(contratos, plano, incluirDia = false) {
  const porId = new Map(contratos.map(c => [c.id, c]));
  const alvo = incluirDia ? plano.corrigir.concat(plano.diaDivergente) : plano.corrigir;
  let alterados = 0;
  for (const x of alvo) {
    const c = porId.get(x.id);
    if (!c || pago(c)) continue;
    c.vencimento = x.depois;
    alterados++;
  }
  return alterados;
}

function stamp() {
  const d = new Date(); const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  let contratos, gravar;
  if (USE_MONGO) {
    const { MongoClient } = require('mongodb');
    const cli = new MongoClient(process.env.MONGODB_URI);
    await cli.connect();
    const col = cli.db('frota').collection('app');
    const doc = await col.findOne({ _id: 'contratos' });
    contratos = (doc && Array.isArray(doc.contratos)) ? doc.contratos : [];
    gravar = async () => { await col.updateOne({ _id: 'contratos' }, { $set: { contratos } }); await cli.close(); };
    if (!APLICAR) cli.close().catch(() => { });
  } else {
    const o = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    contratos = Array.isArray(o.contratos) ? o.contratos : [];
    gravar = async () => fs.writeFileSync(ARQUIVO, JSON.stringify({ contratos }, null, 2));
  }

  const plano = planejar(contratos);
  console.log(`\n=== CORRIGIR — parcela NÃO PAGA em MÊS diferente do esperado: ${plano.corrigir.length}`);
  for (const x of plano.corrigir) console.log(`  ${x.parcela}  VCTO ${x.antes || '(vazio)'} → ${x.depois}  [${x.serie}, âncora ${x.ancora}]`);
  console.log(`\n=== SÓ O DIA — mês certo, dia diferente${INCLUIR_DIA ? ' (INCLUÍDO no --apply)' : ' (só relatório; use --incluir-dia para aplicar)'}: ${plano.diaDivergente.length}`);
  for (const x of plano.diaDivergente) console.log(`  ${x.parcela}  VCTO ${x.antes} → ${x.depois}  [${x.serie}, âncora ${x.ancora}]`);
  console.log(`\n=== PAGA DIVERGENTE — só relatório, nada é alterado: ${plano.pagasDivergentes.length}`);
  for (const x of plano.pagasDivergentes) console.log(`  ${x.parcela}  VCTO ${x.antes} (a âncora daria ${x.depois})  [${x.serie}, âncora ${x.ancora}]`);
  console.log(`\n=== REVISÃO — série intocada: ${plano.revisao.length}`);
  for (const x of plano.revisao) console.log(`  ${x.serie} · ${x.motivo}`);
  if (plano.semSerie) console.log(`\n(${plano.semSerie} lançamento(s) sem serieId ficaram fora — abra o sistema para os ids serem atribuídos e rode de novo.)`);

  const aGravar = plano.corrigir.length + (INCLUIR_DIA ? plano.diaDivergente.length : 0);
  if (!APLICAR) { console.log(`\nDry-run: nada gravado (${aGravar} vencimento(s) seriam corrigidos). Rode com --apply para aplicar.`); return; }
  if (!aGravar) { console.log('\nNada a corrigir.'); return; }
  const bak = path.join(USE_MONGO ? RAIZ : DATA_DIR, `contratos.backup-vencimentos-${stamp()}.json`);
  fs.writeFileSync(bak, JSON.stringify({ contratos }, null, 2));
  console.log(`\nBackup salvo em ${bak}`);
  const alterados = aplicar(contratos, plano, INCLUIR_DIA);
  await gravar();
  console.log(`Gravado: ${alterados} vencimento(s) recalculado(s).${USE_MONGO ? ' Lembre do restart/redeploy no Render.' : ''}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { planejar, aplicar, somarMesesBR, mesAnoBR };
