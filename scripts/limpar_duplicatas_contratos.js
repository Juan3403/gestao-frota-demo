// Remove lançamentos DUPLICADOS de Contratos: mesma série (serieId) + mesmo número de
// parcela (N/M). Achado numa vistoria em 24/07/2026 — a importação de planilha
// (/api/contratos/importar) substitui a base inteira mas não verifica duplicata de parcela
// dentro da mesma série; se o Excel trouxer 2 linhas da mesma parcela, as duas entram.
//
// Política de remoção (só mexe em casos SEM AMBIGUIDADE):
//   - Grupos "ambos pagos"     → mantém 1 cópia (a mais antiga por `ts`), remove as demais.
//     (as duas contam o mesmo pagamento — hoje inflam "Total pago" em dobro)
//   - Grupos "ambos pendentes" → mantém 1 cópia (a mais antiga por `ts`), remove as demais.
//     (inflam "Lançamentos" e "Saldo devedor" à toa)
//   - Grupos "MISTOS" (1 pago + 1 pendente) → NÃO mexe. Só relata. Description (`material`)
//     pode divergir entre as cópias (ex.: carta trocada/recontemplada) — decidir automaticamente
//     qual cópia é a "fantasma" arriscaria apagar um pagamento real. Resolver manualmente.
//
// Uso (dry-run por padrão — não grava nada):
//   node limpar_duplicatas_contratos.js
//   node limpar_duplicatas_contratos.js --apply     (grava, faz backup antes)

const fs = require('fs');
const path = require('path');

const ARQ = path.join(__dirname, '..', 'data', 'contratos.json');
const APLICAR = process.argv.includes('--apply');

const contrPago = (c) => (Number(c.valorPago) > 0) || !!(c.dataPagamento && String(c.dataPagamento).trim());

function chaveSerieParcela(c) {
  const m = String(c.parcela || '').match(/(\d+)\s*\/\s*(\d+)/);
  if (!m) return null;
  return `${c.serieId || ''}|${+m[1]}/${+m[2]}`;
}

function main() {
  const raw = JSON.parse(fs.readFileSync(ARQ, 'utf-8'));
  const lista = raw.contratos;

  const grupos = new Map();
  for (const c of lista) {
    const chave = chaveSerieParcela(c);
    if (!chave) continue;
    if (!grupos.has(chave)) grupos.set(chave, []);
    grupos.get(chave).push(c);
  }

  const idsRemover = new Set();
  const mistosParaRevisar = [];
  let grupoAmbosPago = 0, grupoAmbosPendente = 0;
  let valorPagoDuplicadoRemovido = 0;

  for (const [chave, itens] of grupos) {
    if (itens.length <= 1) continue;
    const pagos = itens.filter(contrPago);
    const pendentes = itens.filter(c => !contrPago(c));

    if (pagos.length > 0 && pendentes.length > 0) {
      // MISTO — não decide sozinho, só relata para revisão manual.
      mistosParaRevisar.push({ chave, itens });
      continue;
    }

    // Ambos no mesmo status: mantém o mais antigo (ts menor), remove o resto.
    const ordenado = itens.slice().sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
    const manter = ordenado[0];
    const remover = ordenado.slice(1);
    for (const r of remover) {
      idsRemover.add(r.id);
      if (contrPago(r)) valorPagoDuplicadoRemovido += Number(r.valorParcela) || 0;
    }
    if (pagos.length === itens.length) grupoAmbosPago++;
    else grupoAmbosPendente++;
  }

  console.log(`Grupos "ambos pagos" a corrigir: ${grupoAmbosPago}`);
  console.log(`Grupos "ambos pendentes" a corrigir: ${grupoAmbosPendente}`);
  console.log(`Linhas duplicadas a remover: ${idsRemover.size}`);
  console.log(`Valor duplicado de "Total pago" que será corrigido: R$ ${valorPagoDuplicadoRemovido.toFixed(2)}`);
  console.log('');
  console.log(`Grupos MISTOS (1 pago + 1 pendente) — NÃO tocados, revisar manualmente: ${mistosParaRevisar.length}`);
  for (const { chave, itens } of mistosParaRevisar) {
    console.log(`  --- ${chave} ---`);
    for (const c of itens) {
      console.log(`    id=${c.id} | ${c.material} | parcela=${c.parcela} | vcto=${c.vencimento} | dataPagamento="${c.dataPagamento}" | valorPago=${c.valorPago}`);
    }
  }

  if (!APLICAR) {
    console.log('');
    console.log('DRY-RUN — nada foi gravado. Rode com --apply para remover as', idsRemover.size, 'linhas listadas acima (grupos não-mistos).');
    return;
  }

  // Backup antes de gravar
  const backupPath = ARQ.replace(/\.json$/, `.backup-${Date.now()}.json`);
  fs.writeFileSync(backupPath, JSON.stringify(raw, null, 2), 'utf-8');
  console.log('Backup salvo em', backupPath);

  const novaLista = lista.filter(c => !idsRemover.has(c.id));
  fs.writeFileSync(ARQ, JSON.stringify({ contratos: novaLista }, null, 2), 'utf-8');
  console.log(`Aplicado: ${idsRemover.size} linha(s) duplicada(s) removida(s). Total de lançamentos: ${lista.length} → ${novaLista.length}.`);
}

main();
