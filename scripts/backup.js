#!/usr/bin/env node
'use strict';
// Gera um backup .zip pela linha de comando (modo LOCAL ou MONGO, conforme MONGODB_URI).
//
//   node scripts/backup.js --out ./backups
//   node scripts/backup.js --out ./backups --grupos funcionarios,multas --sem-anexos
//   MONGODB_URI="..." node scripts/backup.js --out ./backups
//
const fs = require('fs');
const path = require('path');
const lib = require('./backup-lib');

function arg(nome, padrao) {
  const i = process.argv.indexOf(nome);
  return (i >= 0 && process.argv[i + 1]) ? process.argv[i + 1] : padrao;
}
(async () => {
  const out = path.resolve(arg('--out', './backups'));
  const grupos = String(arg('--grupos', 'completo')).split(',').map((s) => s.trim()).filter(Boolean);
  const incluirAnexos = !process.argv.includes('--sem-anexos');
  if (!fs.existsSync(out)) fs.mkdirSync(out, { recursive: true });
  console.log(`Gerando backup (${lib.USE_MONGO ? 'MongoDB' : 'arquivos locais'}) — grupos: ${grupos.join(', ')} — anexos: ${incluirAnexos ? 'sim' : 'não'}`);
  const { entradas, manifest } = await lib.gerarBackup({ grupos, incluirAnexos });
  const destino = path.join(out, `gestao-rm-backup-${lib.carimbo()}.zip`);
  const bytes = await lib.escreverZip(entradas, destino);
  console.log(`\n✔ Backup gerado: ${destino}`);
  console.log(`  ${manifest.modulos.length} área(s) · ${manifest.totalRegistros} registro(s) · ${manifest.anexos.length} anexo(s) · ${(bytes / 1024).toFixed(1)} KB`);
  console.log('  Integridade: SHA-256 por arquivo no manifest.json.');
})().catch((e) => { console.error('\n✘ Erro ao gerar backup:', e.message); process.exit(1); });
