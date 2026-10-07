#!/usr/bin/env node
'use strict';
// Valida e restaura um backup .zip pela linha de comando. DRY-RUN por padrão:
// só grava com --apply (modo LOCAL ou MONGO, conforme MONGODB_URI).
//
//   node scripts/restore.js ./backups/gestao-rm-backup-….zip            (dry-run)
//   node scripts/restore.js ./backups/….zip --apply                     (mesclar)
//   node scripts/restore.js ./backups/….zip --apply --modo substituir
//   node scripts/restore.js ./backups/….zip --grupos funcionarios --apply
//   MONGODB_URI="..." node scripts/restore.js ./backups/….zip --apply
//
const path = require('path');
const lib = require('./backup-lib');

function arg(nome, padrao) { const i = process.argv.indexOf(nome); return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : padrao; }
(async () => {
  const zip = process.argv[2];
  if (!zip || zip.startsWith('--')) { console.error('Uso: node scripts/restore.js <arquivo.zip> [--apply] [--modo mesclar|substituir] [--grupos a,b]'); process.exit(1); }
  const aplicar = process.argv.includes('--apply');
  const modo = arg('--modo', 'mesclar');
  const grupos = String(arg('--grupos', 'completo')).split(',').map((s) => s.trim()).filter(Boolean);
  console.log(`${aplicar ? 'APLICANDO' : 'DRY-RUN (nada será gravado)'} — ${lib.USE_MONGO ? 'MongoDB' : 'arquivos locais'} — modo: ${modo} — grupos: ${grupos.join(', ')}`);
  const rel = await lib.restaurarBackup({ arquivoZip: path.resolve(zip), aplicar, modo, grupos });
  console.log('\nÁrea                         novos  atualiz.  iguais');
  for (const m of rel.modulos) {
    if (m.tipo === 'objeto') console.log('  ' + m.modulo.padEnd(26) + ' (objeto — ' + m.itensBackup + ' item(ns) no backup)');
    else console.log('  ' + m.modulo.padEnd(26) + String(m.criados).padStart(5) + String(m.atualizados).padStart(9) + String(m.iguais).padStart(8));
  }
  if (rel.anexos) console.log('\nAnexos:', JSON.stringify(rel.anexos));
  if (rel.ignorados.length) console.log('Ignorados:', rel.ignorados.join(', '));
  console.log(aplicar ? '\n✔ Restauração aplicada.' + (lib.USE_MONGO ? ' Em produção, reinicie o servidor (Render → Manual Deploy) para recarregar a memória.' : '') : '\nℹ Dry-run concluído. Rode de novo com --apply para gravar.');
})().catch((e) => { console.error('\n✘ Erro na restauração:', e.message); process.exit(1); });
