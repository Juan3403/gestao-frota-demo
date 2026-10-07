'use strict';
// ============================================================================
// Diagnóstico SOMENTE-LEITURA: cruza os documentos AUSENTES dos convites de
// Admissão com os documentos que existem HOJE no cadastro do funcionário.
//
// Contexto: a mídia do CONVITE pode ter sido apagada (faxina de órfãs pré-1.55.3),
// mas o "aplicar" da admissão DUPLICAVA cada arquivo com um id NOVO no cofre para
// o funcionário (duplicarMidiaAdm, backend/server.js) — então o binário pode
// continuar vivo no cadastro (Funcionários → Editar → Documentos) mesmo com o
// convite quebrado. Este script mostra, por funcionário, o que é recuperável.
//
// NÃO grava, NÃO copia mídia, NÃO reconecta referência, NÃO corrige — só lê.
//
// Estruturas reais usadas (backend/server.js):
//   admissoes[]:    { id, status, funcionarioId, preenchidoTs, resposta.nome, nome,
//                     docs: [{ chave, nome: rótulo, id, tipo, nomeOriginal }] }
//   funcionarios[]: { id, nome, foto: {id,nome,tipo},
//                     documentos: [{ id, nome, tipo, categoria, uploadTs, uploadPor,
//                                    nomeOriginal, versoes: [{id,...}] }] }
//   cofre:          Mongo doc _id 'midia_<id>' · local data/uploads/<id>.json
//
// Correspondência (sem inventar por nome — em ordem de confiança):
//   1. TÉCNICA: doc do funcionário gravado pelo próprio aplicar —
//      uploadPor === 'Formulário de admissão' E nome === rótulo da chave
//      E uploadTs === preenchidoTs do convite; chave 'foto' casa com f.foto.
//   2. POR NOME (fallback): nome do doc atual igual ao rótulo da chave
//      (normalizado, sem acento/caixa), sem as marcas técnicas.
//   3. Nada casou → "Correspondência não confirmada".
// Em qualquer nível, só conta como recuperável se a mídia do doc atual EXISTE
// no cofre (conferida por projeção {_id:1} — o base64 nunca trafega).
//
// USO — Windows (PowerShell, da pasta do projeto):
//   node scripts/diagnostico-recuperacao-admissao.js                    # base local (data/)
//   $env:MONGODB_URI='...'; node .\scripts\diagnostico-recuperacao-admissao.js   # produção (só leitura)
// USO — Linux/Render (shell):
//   MONGODB_URI='...' node scripts/diagnostico-recuperacao-admissao.js
// Com o cofre no R2 (docs/ARQUIVOS_R2.md), defina TAMBÉM MIDIA_S3_BUCKET/KEY_ID/KEY_SECRET/ENDPOINT
// (as do Render); sem elas o script para em vez de acusar como ausente o que está no bucket.
//
// Privacidade: imprime só nome do funcionário, id do convite, tipo/rótulo dos
// documentos e existência da mídia. Nada de base64, CPF/RG/e-mail/telefone/
// endereço, nome original de arquivo enviado, URI do Mongo, senha ou token.
// ============================================================================
const fs = require('fs');
const path = require('path');
const CofreMidia = require('../backend/cofre-midia');

const RAIZ = path.resolve(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(RAIZ, 'data');
const USE_MONGO = !!process.env.MONGODB_URI;

// Espelho de rotuloDocAdmissao/DOC_LABELS_ADMISSAO do backend/server.js: converte a chave do
// formulário ('ctps', 'rg-doc'...) no rótulo que o aplicar grava como `nome` do documento.
const DOC_LABELS_ADMISSAO = {
  foto: 'Foto 3x4', ctps: 'CTPS', 'rg-doc': 'RG', 'cpf-doc': 'CPF',
  vacina: 'Cartão de Vacina', residencia: 'Comprovante de Residência',
  certidao: 'Certidão de Nascimento/Casamento', escolar: 'Histórico/Declaração Escolar',
  sus: 'Cartão do SUS', 'pis-doc': 'PIS/PASEP/NIT', 'reservista-doc': 'Reservista',
  cnh: 'CNH', 'reg-prof': 'Registro Profissional', 'titulo-doc': 'Título de Eleitor',
  'conjuge-doc': 'Documentos do cônjuge', 'vacina-dep': 'Vacina (dependentes)',
  'sus-dep': 'Cartão SUS (dependentes)',
};
function rotuloDocAdmissao(chave) {
  if (DOC_LABELS_ADMISSAO[chave]) return DOC_LABELS_ADMISSAO[chave];
  const m = String(chave || '').match(/^filho-(\d+)-doc$/);
  if (m) return `Documentos do filho ${m[1]}`;
  return chave || 'Documento';
}
// Normaliza para comparação por nome (fallback): sem acento, sem caixa, espaços colapsados.
const normalizar = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();

function lerJsonLocal(arquivo, campo) {
  const arq = path.join(DATA_DIR, arquivo);
  if (!fs.existsSync(arq)) return [];
  const o = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  return Array.isArray(o[campo]) ? o[campo] : [];
}

async function main() {
  let admissoes, funcionarios, existeMidia, client = null;
  let marcador = null; // doc `cofre_r2` (só no modo Mongo)
  if (USE_MONGO) {
    const { MongoClient } = require('mongodb');
    client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const col = client.db('frota').collection('app');
    marcador = await col.findOne({ _id: 'cofre_r2' });
    const docAdm = await col.findOne({ _id: 'admissoes' });
    const docFunc = await col.findOne({ _id: 'funcionarios' });
    admissoes = (docAdm && Array.isArray(docAdm.admissoes)) ? docAdm.admissoes : [];
    funcionarios = (docFunc && Array.isArray(docFunc.funcionarios)) ? docFunc.funcionarios : [];
    // Projeção só do _id: confirma existência sem trafegar (nem exibir) o base64.
    existeMidia = async (id) => !!(await col.findOne({ _id: 'midia_' + id }, { projection: { _id: 1 }, maxTimeMS: 15000 }));
    console.log('Modo: MONGO (produção) — somente leitura');
  } else {
    admissoes = lerJsonLocal('admissoes.json', 'admissoes');
    funcionarios = lerJsonLocal('funcionarios.json', 'funcionarios');
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
    const funcPorId = new Map(funcionarios.map(f => [String(f.id), f]));
    const resumos = []; // { nome, ausentes, recuperaveis, semCorresp }
    let totAusentes = 0, totRecuperaveis = 0, totSemCorresp = 0;

    for (const a of admissoes) {
      const docs = (Array.isArray(a.docs) ? a.docs : []).filter(d => d && d.id);
      if (!docs.length) continue;
      // 1) documentos do CONVITE cuja mídia sumiu do cofre
      const ausentes = [];
      for (const d of docs) if (!(await existeMidia(d.id))) ausentes.push(d);
      if (!ausentes.length) continue;

      const nome = String((a.resposta && a.resposta.nome) || a.nome || '').trim() || 'Nome não identificado';
      console.log(`\n── ${nome} ──`);
      console.log(`Convite: ${a.id || '?'} (${a.status || 'pendente'})`);

      console.log('\nDOCUMENTOS AUSENTES NO CONVITE:');
      for (const d of ausentes) console.log(`✘ ${d.chave || 'doc'}`);

      // 2) funcionário vinculado (só existe após "aplicar")
      const f = a.funcionarioId ? funcPorId.get(String(a.funcionarioId)) : null;
      if (!f) {
        console.log('\nFuncionário vinculado: NENHUM (convite não aplicado) — nada a cruzar.');
        totAusentes += ausentes.length; totSemCorresp += ausentes.length;
        resumos.push({ nome, ausentes: ausentes.length, recuperaveis: 0, semCorresp: ausentes.length });
        continue;
      }

      // 3) documentos ATUAIS do funcionário (o que a aba Funcionários → Documentos lista) + foto,
      //    cada um conferido no cofre (o arquivo ATIVO; versões antigas ficam fora do cruzamento).
      const docsAtuais = (Array.isArray(f.documentos) ? f.documentos : []).filter(d => d && d.id);
      const atuais = [];
      for (const d of docsAtuais) atuais.push({ ...d, noCofre: await existeMidia(d.id) });
      const fotoAtual = (f.foto && f.foto.id) ? { ...f.foto, noCofre: await existeMidia(f.foto.id) } : null;

      console.log('\nDOCUMENTOS ATUAIS DO FUNCIONÁRIO:');
      if (!atuais.length && !fotoAtual) console.log('(nenhum documento no cadastro)');
      if (fotoAtual) console.log(`${fotoAtual.noCofre ? '✔' : '✘'} Foto de perfil${fotoAtual.noCofre ? '' : ' (mídia ausente no cofre)'}`);
      for (const d of atuais) console.log(`${d.noCofre ? '✔' : '✘'} ${d.nome || 'Documento'}${d.noCofre ? '' : ' (mídia ausente no cofre)'}`);

      // 4) cruzamento por doc ausente do convite
      console.log('\nPOSSÍVEIS CORRESPONDÊNCIAS:');
      const larg = Math.max(...ausentes.map(d => String(d.chave || 'doc').length), 10);
      let recuperaveis = 0, semCorresp = 0;
      for (const d of ausentes) {
        const chave = String(d.chave || 'doc');
        const rotulo = rotuloDocAdmissao(d.chave);
        let achado = null, nivel = '';
        if (d.chave === 'foto') {
          // A foto 3x4 vira f.foto no aplicar (não entra em documentos[]).
          if (fotoAtual && fotoAtual.noCofre) { achado = fotoAtual; nivel = 'foto do cadastro'; }
        } else {
          // Nível 1 — marcas TÉCNICAS gravadas pelo próprio aplicar: uploadPor + nome (rótulo
          // da chave) + uploadTs igual ao preenchidoTs do convite. Não é palpite por nome.
          achado = atuais.find(x => x.noCofre && x.uploadPor === 'Formulário de admissão'
            && x.nome === rotulo && Number(x.uploadTs) === Number(a.preenchidoTs));
          if (achado) nivel = 'confirmada (marcas do aplicar)';
          // Nível 1b — mesmas marcas sem exigir o uploadTs (cadastro pode ter sido re-aplicado).
          if (!achado) {
            achado = atuais.find(x => x.noCofre && x.uploadPor === 'Formulário de admissão' && x.nome === rotulo);
            if (achado) nivel = 'confirmada (veio do formulário de admissão)';
          }
          // Nível 2 — fallback por NOME normalizado (documento re-anexado à mão com o mesmo rótulo).
          if (!achado) {
            achado = atuais.find(x => x.noCofre && normalizar(x.nome) === normalizar(rotulo));
            if (achado) nivel = 'possível (mesmo nome, anexado manualmente)';
          }
        }
        if (achado) { recuperaveis++; console.log(`${chave.padEnd(larg)} → SIM — ${nivel}`); }
        else { semCorresp++; console.log(`${chave.padEnd(larg)} → NÃO — Correspondência não confirmada`); }
      }

      console.log(`\nFUNCIONÁRIO: ${nome}`);
      console.log(`\nDocumentos ausentes no convite: ${ausentes.length}`);
      console.log(`Possivelmente recuperáveis pelo cadastro atual: ${recuperaveis}`);
      console.log(`Sem correspondência: ${semCorresp}`);
      totAusentes += ausentes.length; totRecuperaveis += recuperaveis; totSemCorresp += semCorresp;
      resumos.push({ nome, ausentes: ausentes.length, recuperaveis, semCorresp });
    }

    console.log('\nRESUMO GERAL\n');
    console.log(`Funcionários afetados: ${resumos.length}`);
    console.log(`Documentos ausentes nos convites: ${totAusentes}`);
    console.log(`Documentos encontrados novamente no cadastro atual: ${totRecuperaveis}`);
    console.log(`Documentos sem correspondência: ${totSemCorresp}`);
    if (!resumos.length) console.log('\nNenhum convite com mídia ausente — nada a cruzar.');
  } finally {
    if (client) await client.close().catch(() => {});
  }
}

// Redige credenciais de URI antes de imprimir (erros de conexão do driver podem citar a MONGODB_URI).
main().catch((e) => {
  console.error('Falha no diagnóstico:', String((e && e.message) || e).replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^@\s/]+@/gi, '$1***@'));
  process.exit(1);
});
