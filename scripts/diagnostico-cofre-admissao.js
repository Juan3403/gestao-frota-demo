'use strict';
// ============================================================================
// Diagnóstico SOMENTE-LEITURA do cofre de mídia dos Formulários de Admissão.
//
// Percorre todos os convites (`admissoes[].docs` + `docsPendentes`) e confere,
// para cada documento, se a mídia `midia_<id>` ainda existe no cofre — SEM ler
// nem exibir o binário/base64 (em Mongo a consulta projeta só o _id). Agrupa o
// resultado por convite e fecha com os totais de encontrados × ausentes.
// Serve para responder: "os arquivos foram mesmo removidos (ex.: faxina de
// órfãs anterior à 1.55.3) ou o problema é indisponibilidade/outra coisa?".
//
// NÃO grava, NÃO deleta, NÃO corrige nada — leitura pura, seguro em produção.
//
// Modos (sem subir o servidor), mesma regra do server.js:
//   • LOCAL (sem MONGODB_URI): lê data/admissoes.json e data/uploads/<id>.json.
//   • MONGO (com MONGODB_URI): docs 'admissoes' e 'midia_<id>' em db('frota').collection('app').
//
// USO — Windows (PowerShell, da pasta do projeto):
//   node scripts/diagnostico-cofre-admissao.js                      # base local (data/)
//   $env:MONGODB_URI="..."; node scripts/diagnostico-cofre-admissao.js   # produção (só leitura)
// USO — Linux/Render (shell):
//   MONGODB_URI="..." node scripts/diagnostico-cofre-admissao.js
// Com o cofre no R2 (docs/ARQUIVOS_R2.md), defina TAMBÉM MIDIA_S3_BUCKET/KEY_ID/KEY_SECRET/ENDPOINT
// (as do Render); sem elas o script para em vez de acusar como ausente o que está no bucket.
//
// SAÍDA (exemplo). Além do ID do convite sai o NOME do candidato (campo `resposta.nome`, com
// fallback no `nome` do convite — o mesmo padrão do server.js); nenhum outro dado pessoal
// (CPF/RG/e-mail/telefone/endereço/nome de arquivo enviado) é impresso:
//   ── convite ADM1a2b3c (preenchido) ──
//   Funcionário: João da Silva
//   Documentos: 3 · Encontrados: 2 · Ausentes: 1
//     ✘ cpf-doc
//   (convite sem ausência sai compacto, numa linha só)
//   FUNCIONÁRIOS AFETADOS — 1. João da Silva · Convite: ADM1a2b3c · Ausentes: 1 de 3
//   TOTAL: 5 convite(s) com anexo · 12 mídia(s): 10 encontrada(s) · 2 AUSENTE(S)
// ============================================================================
const fs = require('fs');
const path = require('path');
const CofreMidia = require('../backend/cofre-midia');

const RAIZ = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(RAIZ, 'data');
const USE_MONGO = !!process.env.MONGODB_URI;

function lerAdmissoesLocal() {
  const arq = path.join(DATA_DIR, 'admissoes.json');
  if (!fs.existsSync(arq)) return [];
  const o = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  return Array.isArray(o.admissoes) ? o.admissoes : [];
}

async function main() {
  let admissoes, existeMidia, client = null;
  let marcador = null; // doc `cofre_r2` (só no modo Mongo)
  if (USE_MONGO) {
    const { MongoClient } = require('mongodb');
    client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const col = client.db('frota').collection('app');
    marcador = await col.findOne({ _id: 'cofre_r2' });
    const doc = await col.findOne({ _id: 'admissoes' });
    admissoes = (doc && Array.isArray(doc.admissoes)) ? doc.admissoes : [];
    // Projeção só do _id: confirma existência sem trafegar (nem exibir) o base64.
    existeMidia = async (id) => !!(await col.findOne({ _id: 'midia_' + id }, { projection: { _id: 1 }, maxTimeMS: 15000 }));
    console.log('Modo: MONGO (produção) — somente leitura');
  } else {
    admissoes = lerAdmissoesLocal();
    const caminho = (id) => path.join(DATA_DIR, 'uploads', String(id).replace(/[^a-zA-Z0-9_-]/g, '') + '.json');
    existeMidia = async (id) => fs.existsSync(caminho(id));
    console.log(`Modo: LOCAL (${DATA_DIR}) — somente leitura`);
  }
  // Com MIDIA_S3_* (as envs do servidor) o arquivo pode já estar no bucket R2: confere lá
  // primeiro (HEAD, sem baixar), depois no armazenamento antigo — igual ao existeMidia() do server.
  // Só no modo Mongo (no local, as MIDIA_S3_* apontariam a base de teste para o bucket de produção).
  const cofre = CofreMidia.criarCofre(CofreMidia.lerConfigCofre(process.env, { usarMongo: USE_MONGO }));
  // Anexos que só existem no bucket (marcador `cofre_r2`) e o bucket não configurado aqui: cada um
  // sairia como AUSENTE e o relatório mandaria pedir reenvio de documento que está íntegro.
  const bucketArq = CofreMidia.bucketComArquivos(marcador);
  if (bucketArq && (!cofre || cofre.bucket !== bucketArq)) {
    console.error(`Há anexos que só existem no bucket R2 "${bucketArq}". Defina MIDIA_S3_BUCKET, MIDIA_S3_KEY_ID, MIDIA_S3_KEY_SECRET e MIDIA_S3_ENDPOINT (as do Render) e rode de novo.`);
    if (client) await client.close().catch(() => {});
    process.exit(2);
  }
  if (cofre) {
    const noAntigo = existeMidia;
    existeMidia = async (id) => { const ch = CofreMidia.chaveMidia(id); return (ch && !!(await cofre.cabeca(ch))) || noAntigo(id); };
    console.log(`Cofre: bucket R2 "${cofre.bucket}" + armazenamento antigo`);
  }

  try {
    let totalMidias = 0, totalOk = 0, totalAusentes = 0, convitesComAnexo = 0, convitesComAusencia = 0;
    const afetados = []; // { nome, convite, status, ausentes, total } — só quem tem mídia ausente
    for (const a of admissoes) {
      const docs = [
        ...(Array.isArray(a.docs) ? a.docs.map(d => ({ ...d, origem: 'docs' })) : []),
        ...(Array.isArray(a.docsPendentes) ? a.docsPendentes.map(d => ({ ...d, origem: 'docsPendentes' })) : []),
      ].filter(d => d && d.id);
      if (!docs.length) continue;
      convitesComAnexo++;
      // Nome do candidato: `resposta.nome` (o que ele preencheu no formulário), com fallback no
      // `nome` do convite (dado pelo RH ao criar) — mesmo padrão do server.js. Fora o nome,
      // nenhum outro dado pessoal (CPF/RG/e-mail/telefone/endereço/nome de arquivo) é impresso.
      const nome = String((a.resposta && a.resposta.nome) || a.nome || '').trim() || 'Nome não identificado';
      const ausentes = []; // chaves (tipos) dos documentos sem binário no cofre
      for (const d of docs) {
        totalMidias++;
        if (await existeMidia(d.id)) totalOk++;
        else { totalAusentes++; ausentes.push(String(d.chave || 'doc') + (d.origem === 'docsPendentes' ? ' [rascunho]' : '')); }
      }
      if (ausentes.length) {
        convitesComAusencia++;
        afetados.push({ nome, convite: a.id || '?', status: a.status || 'pendente', ausentes: ausentes.length, total: docs.length });
        console.log(`\n── convite ${a.id || '?'} (${a.status || 'pendente'}) ──`);
        console.log(`Funcionário: ${nome}`);
        console.log(`Documentos: ${docs.length} · Encontrados: ${docs.length - ausentes.length} · Ausentes: ${ausentes.length}`);
        for (const chave of ausentes) console.log(`  ✘ ${chave}`);
      } else {
        console.log(`\n── convite ${a.id || '?'} (${a.status || 'pendente'}) ─ ${nome} — ${docs.length} doc(s), todos no cofre ✔`);
      }
    }

    if (afetados.length) {
      console.log('\nFUNCIONÁRIOS AFETADOS\n');
      afetados.forEach((f, i) => {
        console.log(`${i + 1}. ${f.nome}`);
        console.log(`   Convite: ${f.convite}`);
        console.log(`   Status: ${f.status}`);
        console.log(`   Ausentes: ${f.ausentes} de ${f.total}`);
      });
    }

    console.log(`\nTOTAL: ${convitesComAnexo} convite(s) com anexo · ${totalMidias} mídia(s): ${totalOk} encontrada(s) · ${totalAusentes} AUSENTE(S) em ${convitesComAusencia} convite(s)`);
    if (totalAusentes) {
      console.log('Mídia AUSENTE = o documento consta no convite, mas o binário não está no cofre.');
      console.log('Causa típica: faxina de órfãs anterior à correção 1.55.3. Recuperação: reenvio pelo');
      console.log('candidato (regenerar o link) ou restauração de um backup que contenha o arquivo.');
    } else if (totalMidias) {
      console.log('Todas as mídias referenciadas existem no cofre — falha de download nesses convites');
      console.log('indica indisponibilidade/erro em tempo de requisição (ver logs com correlationId).');
    } else {
      console.log('Nenhum convite com anexo encontrado.');
    }
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

// Redige credenciais de URI antes de imprimir (erros de conexão do driver podem citar a MONGODB_URI).
main().catch((e) => {
  console.error('Falha no diagnóstico:', String((e && e.message) || e).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1***@'));
  process.exit(1);
});
