#!/usr/bin/env node
// sincronizar_local_do_backup.js
// Pega um backup completo do site (baixado de /api/backup) e grava nos arquivos
// JSON locais, deixando o localhost com os MESMOS dados de produção.
//
// Uso:
//   node sincronizar_local_do_backup.js "C:\\caminho\\backup-frota-2026-06-19.json"
//
// - Faz backup (.bak-<ts>) de cada arquivo local antes de sobrescrever.
// - Só toca num arquivo se o backup tiver a chave correspondente (chave ausente
//   = não mexe no local).
// - NÃO sobrescreve usuarios.json (o backup vem sem as senhas; manter o local
//   preserva o login). Use --usuarios para forçar.
// - Grava na pasta de dados (data/, conforme DATA_DIR do server.js) — NÃO na raiz.

const fs = require('fs');
const path = require('path');

const arg = process.argv.find((a) => a.toLowerCase().endsWith('.json') && !a.includes('sincronizar_local'));
const FORCAR_USUARIOS = process.argv.includes('--usuarios');
if (!arg) {
  console.error('Informe o caminho do backup .json. Ex.:\n  node sincronizar_local_do_backup.js "C:\\Users\\PC\\Downloads\\backup-frota-2026-06-19.json"');
  process.exit(1);
}

// Mesma regra do server.js: dados ficam em data/ (trocável por DATA_DIR).
const DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data');
try { fs.mkdirSync(DIR, { recursive: true }); } catch (e) { /* já existe */ }
const backupPath = path.resolve(arg);
let dump;
try {
  dump = JSON.parse(fs.readFileSync(backupPath, 'utf-8'));
} catch (e) {
  console.error('Não consegui ler/parsear o backup:', e.message);
  process.exit(1);
}
console.log(`Backup: ${backupPath}`);
console.log(`  geradoEm=${dump.geradoEm || '?'}  versao=${dump.versao || '?'}`);

// ts simples sem depender de Date (evita warnings em ambientes restritos)
const TS = String(Date.now());

// Mapa: arquivo local  ->  função que monta o conteúdo a partir do dump.
// Retornar undefined = pular (chave ausente no backup).
const MAPA = {
  'data.json':         () => has('veiculos')      && { veiculos: dump.veiculos },
  'multas.json':       () => has('multas')        && { multas: dump.multas },
  'rastreadores.json': () => has('rastreadores')  && { rastreadores: dump.rastreadores },
  'cadastros.json':    () => has('cadastros')     && {
    centrosCusto: dump.cadastros.centrosCusto || [],
    responsaveis: dump.cadastros.responsaveis || [],
  },
  'instalacoes.json':  () => has('instalacoes')   && { instalacoes: dump.instalacoes },
  'envios.json':       () => has('envios')        && { envios: dump.envios },
  'contratos.json':    () => has('contratos')     && { contratos: dump.contratos },
  'manutencao.json':   () => has('manutencao')    && { manutencao: dump.manutencao },
  'abastecimento.json':() => has('abastecimento') && { abastecimento: dump.abastecimento },
  'simulacoes.json':   () => has('simulacoes')    && { simulacoes: dump.simulacoes },
  'fornecedores.json': () => has('fornecedores')  && { fornecedores: dump.fornecedores },
  'aportes.json':      () => has('aportes')       && { aportes: dump.aportes },
  'emprestimos.json':  () => has('emprestimos')   && { emprestimos: dump.emprestimos },
  'percentuais.json':  () => has('percentuais')   && { percentuais: dump.percentuais },
  'retiradas.json':    () => has('retiradas')     && { retiradas: dump.retiradas },
  'funcionarios.json': () => has('funcionarios')  && { funcionarios: dump.funcionarios },
  'programas.json':    () => has('programas')     && { programas: dump.programas },
  'acoes_sst.json':    () => has('acoesSst')      && { acoes: dump.acoesSst },
  'feedbacks.json':    () => has('feedbacks')     && { feedbacks: dump.feedbacks },
  'func_obrigatorios.json': () => has('funcobrigatorios') && {
    cargos: (dump.funcobrigatorios && dump.funcobrigatorios.cargos) || {},
    contratos: (dump.funcobrigatorios && dump.funcobrigatorios.contratos) || {},
  },
  'historico.json':    () => has('historico')     && dump.historico, // array cru
};

function has(k) { return dump[k] !== undefined && dump[k] !== null; }

let escritos = 0, pulados = 0;
for (const [arquivo, montar] of Object.entries(MAPA)) {
  const conteudo = montar();
  if (conteudo === false || conteudo === undefined) {
    console.log(`  pulado  ${arquivo} (sem dados no backup)`);
    pulados++;
    continue;
  }
  const destino = path.join(DIR, arquivo);
  if (fs.existsSync(destino)) {
    fs.copyFileSync(destino, `${destino}.bak-${TS}`);
  }
  fs.writeFileSync(destino, JSON.stringify(conteudo, null, 2), 'utf-8');
  const n = Array.isArray(conteudo) ? conteudo.length
    : Array.isArray(Object.values(conteudo)[0]) ? Object.values(conteudo)[0].length : '-';
  console.log(`  escrito ${arquivo}  (${n} itens)`);
  escritos++;
}

// Mídias (fotos/documentos): recria os arquivos no cofre local (uploads/<id>.json) a partir
// do backup completo (gerado com ?midia=1, que é o padrão de /api/backup). Sem isto, as
// referências de documento existem mas o arquivo não — e o download dá 404 / sem botão.
if (Array.isArray(dump.midias) && dump.midias.length) {
  const UP = path.join(DIR, 'uploads');
  if (!fs.existsSync(UP)) fs.mkdirSync(UP, { recursive: true });
  let nm = 0;
  for (const m of dump.midias) {
    if (!m || !m.id || !m.b64) continue;
    const idSeguro = String(m.id).replace(/[^a-zA-Z0-9_-]/g, '');
    if (!idSeguro) continue;
    fs.writeFileSync(path.join(UP, idSeguro + '.json'), JSON.stringify({ tipo: m.tipo, nome: m.nome, b64: m.b64, ts: m.ts || 0 }), 'utf-8');
    nm++;
  }
  console.log(`  escrito uploads/ (${nm} arquivo(s) de mídia recriado(s) no cofre)`);
} else {
  console.log('  sem mídias no backup (gere com /api/backup?midia=1 p/ trazer os arquivos)');
}

// usuarios.json: por padrão preserva o local (mantém senha do login local).
if (FORCAR_USUARIOS && dump.usuarios) {
  const destino = path.join(DIR, 'usuarios.json');
  if (fs.existsSync(destino)) fs.copyFileSync(destino, `${destino}.bak-${TS}`);
  fs.writeFileSync(destino, JSON.stringify(dump.usuarios, null, 2), 'utf-8');
  console.log('  escrito usuarios.json (--usuarios; ATENÇÃO: sem senhas, login local pode quebrar)');
  escritos++;
} else {
  console.log('  preservado usuarios.json (login local intacto; use --usuarios p/ sobrescrever)');
}

console.log(`\nPronto: ${escritos} arquivo(s) escrito(s), ${pulados} pulado(s).`);
console.log('Backups dos arquivos antigos: *.bak-' + TS);
console.log('Reinicie o npm run dev (ou só dê F5 — JSON é relido a cada request).');
