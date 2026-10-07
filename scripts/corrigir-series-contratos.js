'use strict';
// ============================================================================
// Saneia séries de CONTRATOS cujos campos derivados nasceram inconsistentes:
//   • parcelasPagas/parcelasFaltantes acima do marco COERENTE da série (a heurística
//     "cadastrei a parcela atual N ⇒ N−1 pagas" ignorava parcelas ABERTAS anteriores,
//     e o Completar série propagava o valor para todas as parcelas criadas);
//   • saldoQuitacao/descontoQuitacao/descontoQuitacaoRS copiados da parcela-modelo
//     pelo Completar série (cotação de um momento, não atributo da série).
//
// TRÊS categorias (igualdade de valores NUNCA é critério destrutivo sozinha):
//   1. CORREÇÃO SEGURA        — parcela ABERTA com parcelasPagas gravado > marco coerente:
//                               regrava pagas = marco e faltantes = total − marco.
//   2. QUITAÇÃO COPIADA (forte) — parcela ABERTA com o trio de quitação idêntico ao de uma
//                               parcela mais ANTIGA da série E nascida em LOTE (mesmo `ts`,
//                               no milissegundo, compartilhado por ≥ 3 parcelas da série,
//                               posterior ao ts da fonte — assinatura do Completar série,
//                               que grava o lote inteiro com um único Date.now()):
//                               limpa o trio no --apply.
//   3. SUSPEITO (revisão manual) — trio idêntico SEM evidência de lote: só relatório,
//                               nunca alterado (duas parcelas podem ter o mesmo saldo
//                               legitimamente).
// NUNCA toca: parcela paga, valorPago, dataPagamento, parcela, vencimento, id, ts.
// Série sem serieId fica FORA (o servidor atribui ids no boot/uso; rode de novo depois).
//
// Modos (sem subir o servidor), mesma regra do server.js:
//   • LOCAL (sem MONGODB_URI): lê/grava data/contratos.json (ou $env:DATA_DIR).
//   • MONGO (com MONGODB_URI): doc _id 'contratos' em db('frota').collection('app').
//
// Uso (PowerShell, da pasta do projeto):
//   node scripts/corrigir-series-contratos.js            # dry-run (relatório, não grava)
//   node scripts/corrigir-series-contratos.js --apply    # grava (backup antes)
//   $env:MONGODB_URI="..."; node scripts/corrigir-series-contratos.js --apply  # produção
// Ex. de saída (série do Fiat Toro): "04/80 PAGAS 3 → 2 · FALTANTES 77 → 78 · motivo:
// menor parcela aberta = 03/80" e "05/80 … quitação copiada (lote ts=…): saldo 136481 → ''".
// Em Mongo, reinicie/redeploy o Render depois (alteração direta só reflete após restart).
// ============================================================================
const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(RAIZ, 'data');
const USE_MONGO = !!process.env.MONGODB_URI;
const APLICAR = process.argv.includes('--apply');
const ARQUIVO = path.join(DATA_DIR, 'contratos.json');

const pago = (c) => (Number(c && c.valorPago) > 0) || !!(c && c.dataPagamento && String(c.dataPagamento).trim());
const parcNM = (c) => { const m = String((c && c.parcela) || '').match(/(\d+)\s*\/\s*(\d+)/); return m ? { numero: +m[1], total: +m[2] } : null; };
const trioQuit = (c) => `${String(c.saldoQuitacao ?? '')}|${String(c.descontoQuitacao ?? '')}|${String(c.descontoQuitacaoRS ?? '')}`;
const temQuit = (c) => (c.saldoQuitacao !== '' && c.saldoQuitacao !== undefined && c.saldoQuitacao !== null)
  || String(c.descontoQuitacao || '').trim() !== ''
  || (c.descontoQuitacaoRS !== '' && c.descontoQuitacaoRS !== undefined && c.descontoQuitacaoRS !== null);

// ESPELHO de pagasAteCoerente (backend/server.js / app.js) — regra única do watermark.
function pagasAteCoerente(itens, total) {
  let maiorEvidencia = 0;     // maior evidência por linha (declarada ou inferida)
  let menorAberta = Infinity; // menor nº de parcela EXISTENTE e em aberto
  for (const it of itens || []) {
    if (!Number.isInteger(it.numero) || it.numero < 1) continue;
    if (!it.pago) menorAberta = Math.min(menorAberta, it.numero);
    // parcelasPagas EXPLÍCITO tem precedência (0 é declaração válida — "0 pagas" ≠ vazio);
    // sem declaração, inferência estrutural: paga ⇒ nº, aberta ⇒ nº−1.
    const declarado = Number(it.parcelasPagas);
    const declarou = it.parcelasPagas !== '' && it.parcelasPagas !== null && it.parcelasPagas !== undefined
      && Number.isFinite(declarado) && declarado >= 0;
    maiorEvidencia = Math.max(maiorEvidencia, declarou ? declarado : (it.pago ? it.numero : it.numero - 1));
  }
  const teto = Number(total); // clamp: declaração corrompida (> total) não pode inflar o marco
  if (Number.isFinite(teto) && teto >= 1) maiorEvidencia = Math.min(maiorEvidencia, teto);
  if (!Number.isFinite(menorAberta)) return maiorEvidencia;
  return Math.max(0, Math.min(maiorEvidencia, menorAberta - 1));
}

// Analisa a lista inteira e devolve { seguras, fortes, suspeitas, semSerie } SEM mutar nada.
// Ex.: planejar([{serieId:'S',parcela:'04/80',parcelasPagas:3,...}]).seguras[0].depois.pagas === 2
function planejar(contratos) {
  const seguras = [], fortes = [], suspeitas = [];
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
    const marco = pagasAteCoerente(itens.map(x => ({ numero: x.numero, pago: pago(x.c), parcelasPagas: x.c.parcelasPagas })), itens[0].total);
    const abertas = itens.filter(x => !pago(x.c));
    const menorAberta = abertas.length ? Math.min(...abertas.map(x => x.numero)) : null;
    const rotuloSerie = `${itens[0].c.material || itens[0].c.banco || '?'} (série ${itens[0].c.serieId}, /${itens[0].total})`;
    // Lotes: ts (ms exato) compartilhado por ≥ 3 parcelas da série = gravação em lote do Completar série.
    const porTs = new Map();
    for (const x of itens) { const t = Number(x.c.ts) || 0; if (!porTs.has(t)) porTs.set(t, 0); porTs.set(t, porTs.get(t) + 1); }
    for (const x of itens) {
      if (pago(x.c)) continue; // parcela paga é intocável
      // 1) pagas/faltantes acima do marco coerente
      const declarado = Number(x.c.parcelasPagas);
      if (Number.isFinite(declarado) && declarado > marco) {
        seguras.push({
          serie: rotuloSerie, parcela: x.c.parcela, id: x.c.id,
          antes: { pagas: x.c.parcelasPagas, faltantes: x.c.parcelasFaltantes },
          depois: { pagas: marco, faltantes: Math.max(0, x.total - marco) },
          motivo: menorAberta !== null && menorAberta - 1 < declarado
            ? `menor parcela aberta = ${String(menorAberta).padStart(2, '0')}/${x.total}`
            : 'excede watermark coerente da série',
        });
      }
      // 2/3) quitação idêntica à de outra parcela da série
      if (!temQuit(x.c)) continue;
      const trio = trioQuit(x.c);
      const fontes = itens.filter(y => y !== x && temQuit(y.c) && trioQuit(y.c) === trio);
      if (!fontes.length) continue;
      const ts = Number(x.c.ts) || 0;
      const emLote = (porTs.get(ts) || 0) >= 3;
      const fonteAntiga = fontes.find(y => (Number(y.c.ts) || 0) < ts);
      const registro = {
        serie: rotuloSerie, parcela: x.c.parcela, id: x.c.id,
        saldo: x.c.saldoQuitacao, descQ: x.c.descontoQuitacao, descRS: x.c.descontoQuitacaoRS,
      };
      if (emLote && fonteAntiga) {
        fortes.push({ ...registro, motivo: `quitação copiada (lote ts=${ts}, fonte ${fonteAntiga.c.parcela})` });
      } else {
        suspeitas.push({ ...registro, motivo: 'SUSPEITO — revisão manual (trio igual sem evidência de lote)' });
      }
    }
  }
  return { seguras, fortes, suspeitas, semSerie };
}

function aplicar(contratos, plano) {
  const porId = new Map(contratos.map(c => [c.id, c]));
  for (const s of plano.seguras) {
    const c = porId.get(s.id); if (!c || pago(c)) continue;
    c.parcelasPagas = s.depois.pagas;
    c.parcelasFaltantes = s.depois.faltantes;
  }
  for (const f of plano.fortes) {
    const c = porId.get(f.id); if (!c || pago(c)) continue;
    c.saldoQuitacao = '';
    c.descontoQuitacao = '';
    c.descontoQuitacaoRS = '';
  }
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
    if (!APLICAR) cli.close().catch(() => {});
  } else {
    const o = JSON.parse(fs.readFileSync(ARQUIVO, 'utf8'));
    contratos = Array.isArray(o.contratos) ? o.contratos : [];
    gravar = async () => fs.writeFileSync(ARQUIVO, JSON.stringify({ contratos }, null, 2));
  }

  const plano = planejar(contratos);
  const linha = (x, extra) => console.log(`  ${x.parcela}  ${extra}  [${x.serie}]`);
  console.log(`\n=== CORREÇÃO SEGURA (pagas/faltantes acima do marco coerente): ${plano.seguras.length}`);
  for (const s of plano.seguras) linha(s, `PAGAS ${s.antes.pagas} → ${s.depois.pagas} · FALTANTES ${s.antes.faltantes} → ${s.depois.faltantes} · motivo: ${s.motivo}`);
  console.log(`\n=== QUITAÇÃO COPIADA COM EVIDÊNCIA FORTE (limpa no --apply): ${plano.fortes.length}`);
  for (const f of plano.fortes) linha(f, `saldo ${f.saldo} / desc "${f.descQ}" / R$ ${f.descRS} → '' · ${f.motivo}`);
  console.log(`\n=== SUSPEITA DE QUITAÇÃO COPIADA (só relatório, nada é alterado): ${plano.suspeitas.length}`);
  for (const s of plano.suspeitas) linha(s, `saldo ${s.saldo} · ${s.motivo}`);
  if (plano.semSerie) console.log(`\n(${plano.semSerie} lançamento(s) sem serieId ficaram fora — abra o sistema para os ids serem atribuídos e rode de novo.)`);

  const total = plano.seguras.length + plano.fortes.length;
  if (!APLICAR) { console.log(`\nDry-run: nada gravado (${total} correção(ões) pendente(s)). Rode com --apply para aplicar.`); return; }
  if (!total) { console.log('\nNada a corrigir.'); return; }
  const bak = path.join(USE_MONGO ? RAIZ : DATA_DIR, `contratos.backup-${stamp()}.json`);
  fs.writeFileSync(bak, JSON.stringify({ contratos }, null, 2));
  console.log(`\nBackup salvo em ${bak}`);
  aplicar(contratos, plano);
  await gravar();
  console.log(`Gravado: ${plano.seguras.length} correção(ões) de pagas/faltantes e ${plano.fortes.length} limpeza(s) de quitação.${USE_MONGO ? ' Lembre do restart/redeploy no Render.' : ''}`);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });
module.exports = { planejar, aplicar, pagasAteCoerente };
