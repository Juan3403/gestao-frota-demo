// ============================================================================
// cofre-midia.js · cofre de ARQUIVOS (anexos: fotos, PDFs, assinaturas…) num bucket S3/R2
//
// Até a 1.55.45 todo anexo era um documento `midia_<id>` no Mongo, em base64 (+33% de
// tamanho), e em set/2026 o cofre já era 99,5% do banco (4,87 GB). Com MIDIA_S3_BUCKET
// definida, o server.js grava todo arquivo NOVO aqui e LÊ primeiro daqui, caindo no
// armazenamento antigo (Mongo ou data/uploads) quando o arquivo ainda não foi copiado.
// Isso deixa migrar sem tirar o site do ar: scripts/migrar-midia-r2.js copia o acervo
// antigo aos poucos. Passo a passo em docs/ARQUIVOS_R2.md.
//
// Chaves no bucket (nada fora destes formatos é aceito — anti path traversal):
//   midia/<id>                    o arquivo em uso (o id é o mesmo `MD-…` gravado nos registros)
//   undo-midia/<opId>/<id>        quarentena do "Desfazer" (anexo excluído que ainda pode voltar)
//   teste-conexao/<32 hex>        objeto efêmero do testar() (gravado e apagado na hora)
// Metadados do objeto: content-type = tipo; x-amz-meta-nome (URI-encoded), -ts e -sha256.
//
// A assinatura SigV4 vem de videos-treino.js (mesmo protocolo, já testado contra os vetores
// oficiais da AWS). O req() daqui é próprio porque precisa de corpo BINÁRIO na leitura e de
// cabeçalhos x-amz-meta-* assinados, que o driver de vídeos não usa.
// ============================================================================
'use strict';

const crypto = require('node:crypto');
const V = require('./videos-treino');

const PREFIXO_MIDIA = 'midia/';
const PREFIXO_UNDO = 'undo-midia/';
const PREFIXO_TESTE = 'teste-conexao/';
const ID_MAX = 200; // id de mídia maior que isso não é id (os reais têm 19: MD-<16 hex>); nem vai ao R2
const RE_CHAVE = /^(?:midia\/[A-Za-z0-9_-]{1,200}|undo-midia\/[A-Za-z0-9_-]{1,200}\/[A-Za-z0-9_-]{1,200}|teste-conexao\/[a-f0-9]{32})$/;
const NOME_MAX = 300; // caracteres do nome original guardados no metadado (o S3 limita os metadados a ~2 KB)

const sha256hex = (x) => crypto.createHash('sha256').update(x).digest('hex');
function erro(msg, status, codigo) {
  const e = new Error(msg);
  e.status = status;
  if (codigo) e.codigo = codigo;
  return e;
}

// ----------------------------------------------------------------------------
// Chaves
// ----------------------------------------------------------------------------

// Mesma limpeza do caminhoMidiaLocal() do server.js: o id vira nome de arquivo/chave sem risco.
// USO: limparId('MD-0a1b2c3d4e5f6071') // => 'MD-0a1b2c3d4e5f6071'  ·  limparId('../x') // => 'x'
function limparId(id) {
  return String(id == null ? '' : id).replace(/[^a-zA-Z0-9_-]/g, '');
}
// USO: chaveMidia('MD-0a1b2c3d4e5f6071') // => 'midia/MD-0a1b2c3d4e5f6071'  ·  chaveMidia('') // => ''
//      chaveMidia('x'.repeat(5000)) // => ''  (id absurdo: nem chega ao R2, que o recusaria com 4xx)
function chaveMidia(id) {
  const limpo = limparId(id);
  return limpo && limpo.length <= ID_MAX ? PREFIXO_MIDIA + limpo : '';
}
// USO: chaveUndoMidia('UDlx9k2a1b', 'MD-0a1b…') // => 'undo-midia/UDlx9k2a1b/MD-0a1b…'  ('' se faltar parte)
function chaveUndoMidia(opId, id) {
  const op = limparId(opId), limpo = limparId(id);
  return op && limpo && op.length <= ID_MAX && limpo.length <= ID_MAX ? `${PREFIXO_UNDO}${op}/${limpo}` : '';
}
// Inverso de chaveMidia (para a faxina e o backup, que partem da listagem do bucket).
// USO: idDaChaveMidia('midia/MD-0a1b…') // => 'MD-0a1b…'  ·  idDaChaveMidia('undo-midia/x/y') // => ''
function idDaChaveMidia(chave) {
  const m = /^midia\/([A-Za-z0-9_-]+)$/.exec(String(chave || ''));
  return m ? m[1] : '';
}
// USO: validarChave('midia/MD-1') // => true  ·  validarChave('midia/../usuarios') // => false
function validarChave(chave) {
  return typeof chave === 'string' && RE_CHAVE.test(chave);
}
// Tamanho do base64 de N bytes — o teto do backup é medido em base64 (o formato antigo).
// USO: tamanhoBase64(3) // => 4  ·  tamanhoBase64(4) // => 8
function tamanhoBase64(bytes) {
  return 4 * Math.ceil((Number(bytes) || 0) / 3);
}

// ----------------------------------------------------------------------------
// Configuração
// ----------------------------------------------------------------------------

// Lê as envs. Nunca lança. Sem MIDIA_S3_BUCKET o cofre fica DESLIGADO e nada muda (os arquivos
// continuam no Mongo/data/uploads). Endpoint e região podem vir dos vídeos (VIDEO_S3_*): é a
// mesma conta do Cloudflare e o endereço não é segredo. As CHAVES não: são sempre as do
// próprio cofre. Herdar as dos vídeos ligava o R2 com um token que só enxerga o bucket de
// vídeos — todo acesso dava 403 e TODO download de anexo (até os antigos, que a leitura de
// reserva ainda serviria) virava "cofre indisponível".
//   MIDIA_S3_BUCKET + MIDIA_S3_KEY_ID + MIDIA_S3_KEY_SECRET (obrigatórias, juntas)
//   MIDIA_S3_ENDPOINT (senão VIDEO_S3_ENDPOINT) · MIDIA_S3_REGION (senão VIDEO_S3_REGION, senão auto)
// USO: lerConfigCofre({ MIDIA_S3_BUCKET: 'gestaorm-arquivos', MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 's',
//        VIDEO_S3_ENDPOINT: 'https://c.r2.cloudflarestorage.com' })
//   // => { ativo:true, erro:false, motivo:'', credenciais:'MIDIA_S3', origem:'https://c.r2…',
//   //      s3:{ endpoint, region:'auto', bucket:'gestaorm-arquivos', keyId:'k', keySecret:'s' } }
//   lerConfigCofre({}) // => { ativo:false, erro:false, motivo:'MIDIA_S3_BUCKET não definida…', … }
//   lerConfigCofre({ MIDIA_S3_BUCKET: 'gestaorm-arquivos' }) // => { ativo:false, erro:true, motivo:'Faltam as chaves…' }
//   (erro:true = a pessoa TENTOU configurar e faltou algo: o server avisa alto no boot e no painel)
// MODO LOCAL (usarMongo:false — localhost, npm test, npm run dev): as MIDIA_S3_* são IGNORADAS,
// a não ser com MIDIA_S3_LOCAL=1. Quem define as chaves no PowerShell para rodar o
// scripts/migrar-midia-r2.js e, no mesmo terminal, roda `npm test` ligaria um servidor com a
// base de TESTE apontando para o bucket de PRODUÇÃO — e a faxina de órfãs apagaria de lá tudo o
// que a base de teste não cita (o R2 não tem lixeira). Os testes do cofre ligam com MIDIA_S3_LOCAL=1
// contra um S3 falso.
// USO: lerConfigCofre({ MIDIA_S3_BUCKET: 'b', MIDIA_S3_KEY_ID: 'k', MIDIA_S3_KEY_SECRET: 's' }, { usarMongo: false })
//   // => { ativo:false, erro:false, motivo:'MIDIA_S3_* ignoradas no modo local…' }
function lerConfigCofre(env, { usarMongo = true } = {}) {
  const e = env || {};
  const ler = (n) => String(e[n] == null ? '' : e[n]).trim();
  const cfg = {
    ativo: false, erro: false, motivo: '', credenciais: '', origem: '',
    s3: { endpoint: '', region: '', bucket: '', keyId: '', keySecret: '' },
  };
  const falhar = (motivo) => Object.assign(cfg, { erro: true, motivo });
  if (!usarMongo && ler('MIDIA_S3_LOCAL') !== '1') {
    cfg.motivo = ler('MIDIA_S3_BUCKET')
      ? 'MIDIA_S3_* ignoradas no modo local (sem MONGODB_URI): o bucket é o de produção. Para testar contra outro bucket, MIDIA_S3_LOCAL=1.'
      : 'MIDIA_S3_BUCKET não definida: os arquivos continuam em data/uploads.';
    return cfg;
  }
  const bucket = ler('MIDIA_S3_BUCKET');
  if (!bucket) {
    const soltas = ['MIDIA_S3_ENDPOINT', 'MIDIA_S3_REGION', 'MIDIA_S3_KEY_ID', 'MIDIA_S3_KEY_SECRET'].filter(ler);
    if (soltas.length) return falhar(`Cofre de arquivos com configuração incompleta: há ${soltas.join(', ')} mas falta MIDIA_S3_BUCKET (ver docs/ARQUIVOS_R2.md).`);
    cfg.motivo = 'MIDIA_S3_BUCKET não definida: os arquivos continuam no banco.';
    return cfg;
  }
  const endpointBruto = ler('MIDIA_S3_ENDPOINT') || ler('VIDEO_S3_ENDPOINT');
  if (!endpointBruto) return falhar('Falta MIDIA_S3_ENDPOINT (ou VIDEO_S3_ENDPOINT): a URL da conta, ex.: https://<conta>.r2.cloudflarestorage.com.');
  let u;
  try { u = new URL(endpointBruto.replace(/\/+$/, '')); } catch (_) { u = null; }
  if (!u || !/^https?:$/.test(u.protocol)) return falhar('MIDIA_S3_ENDPOINT inválido: use a URL da conta, ex.: https://<conta>.r2.cloudflarestorage.com.');
  if ((u.pathname && u.pathname !== '/') || u.search) return falhar('MIDIA_S3_ENDPOINT deve ter só o endereço da conta, sem o bucket no fim (o bucket vai em MIDIA_S3_BUCKET).');
  const keyId = ler('MIDIA_S3_KEY_ID'), keySecret = ler('MIDIA_S3_KEY_SECRET');
  if (!keyId && !keySecret) return falhar('Faltam as chaves do token do bucket de arquivos: MIDIA_S3_KEY_ID e MIDIA_S3_KEY_SECRET (as dos vídeos não servem: aquele token só enxerga o bucket de vídeos).');
  if (!keyId || !keySecret) return falhar('Defina MIDIA_S3_KEY_ID e MIDIA_S3_KEY_SECRET juntas.');
  cfg.s3 = { endpoint: u.origin, region: ler('MIDIA_S3_REGION') || ler('VIDEO_S3_REGION') || 'auto', bucket, keyId, keySecret };
  return Object.assign(cfg, { ativo: true, credenciais: 'MIDIA_S3', origem: u.origin });
}

// Erro que NÃO passa sozinho: qualquer 4xx do armazenamento (chave errada, token sem acesso,
// bucket inexistente, região inválida, endpoint que não é a API S3 — ex.: a URL pública r2.dev
// responde 404/405) menos 408/429, que são "tente de novo". Rede fora, prazo e 5xx: passageiros.
// USO: try { await cofre.testar(); } catch (e) { if (erroDeConfiguracao(e)) { /* não passa sozinho */ } }
//      erroDeConfiguracao({ statusArmazenamento: 400, codigo: 'InvalidRegionName' }) // => true
//      erroDeConfiguracao({ statusArmazenamento: 503 }) // => false · ({ codigo: 'REDE' }) // => false
const CODIGOS_CONFIG = ['SignatureDoesNotMatch', 'InvalidAccessKeyId', 'AccessDenied', 'NoSuchBucket', 'InvalidBucketName', 'InvalidRegionName', 'AuthorizationHeaderMalformed'];
// Falha "de rede" que é na verdade configuração: endereço que não existe (erro de digitação no
// MIDIA_S3_ENDPOINT → ENOTFOUND), URL inválida ou certificado de outro host. EAI_AGAIN (DNS fora),
// ECONNRESET, prazo estourado etc. continuam passageiros.
const CAUSAS_CONFIG = ['ENOTFOUND', 'ERR_INVALID_URL', 'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'];
// Destas, só as que não mudam de uma tentativa para outra encurtam as retentativas. ENOTFOUND
// fica de fora: DNS sobrecarregado ou contêiner recém-criado às vezes o devolvem de passagem
// (por isso o teste do boot também o repete antes de desligar o R2 — ver o server.js).
const CAUSAS_SEM_RETENTATIVA = CAUSAS_CONFIG.filter((c) => c !== 'ENOTFOUND');
function erroDeConfiguracao(e) {
  if (!e) return false;
  if (CODIGOS_CONFIG.includes(e.codigo)) return true;
  if (e.codigo === 'REDE' && CAUSAS_CONFIG.includes(e.causa)) return true;
  const s = e.statusArmazenamento;
  return typeof s === 'number' && s >= 400 && s < 500 && s !== 408 && s !== 429;
}

// Erro que indica o R2 FORA DO AR (e não configuração nem lentidão): rede/prazo até os cabeçalhos
// (fora as causas de configuração) ou 5xx. É o único tipo que conta para o disjuntor de leitura
// do server.js — um 4xx determinístico (id esquisito, chave errada) ou um download lento de um
// arquivo grande não pode pausar a leitura de todos os outros.
// USO: erroDeDisponibilidade({ codigo: 'REDE' }) // => true · ({ statusArmazenamento: 503 }) // => true
//      erroDeDisponibilidade({ statusArmazenamento: 403 }) // => false · ({ codigo: 'LENTO' }) // => false
function erroDeDisponibilidade(e) {
  if (!e) return false;
  if (e.codigo === 'REDE') return !CAUSAS_CONFIG.includes(e.causa);
  return typeof e.statusArmazenamento === 'number' && e.statusArmazenamento >= 500;
}

// ----------------------------------------------------------------------------
// Marcador `cofre_r2` (doc do Mongo) — regras puras, usadas pelo server.js e pelos scripts
// ----------------------------------------------------------------------------
// Campos: ativo/bucket/origem/bootTs/vistoTs/render/commit (gravados pela instância do Render a
// cada boot, vistoTs renovado a cada 5 min), bucketArquivos (gravado UMA vez, na 1ª subida com o
// R2 ligado: a partir dali há anexos que só existem naquele bucket) e acervoNoR2/acervoBucket
// (gravados pelo scripts/migrar-midia-r2.js antes de apagar o acervo antigo do Mongo).

// O bucket que guarda anexos que só existem nele ('' = nenhum; o Mongo ainda tem tudo).
// USO: bucketComArquivos({ bucketArquivos: 'gestaorm-arquivos' }) // => 'gestaorm-arquivos'
//      bucketComArquivos({ acervoNoR2: true, acervoBucket: 'x' })  // => 'x'  ·  bucketComArquivos(null) // => ''
function bucketComArquivos(marcador) {
  if (!marcador) return '';
  return String(marcador.bucketArquivos || (marcador.acervoNoR2 ? marcador.acervoBucket : '') || '');
}

// O que fazer quando o teste do bucket falha no boot:
//   'passageiro' → rede/5xx: mantém o R2 ligado (desligar mandaria arquivo novo ao Mongo às escondidas)
//   'desligar'   → configuração errada e o bucket ainda não tem anexo exclusivo: volta ao armazenamento antigo
//   'manter'     → configuração errada, mas o bucket JÁ tem anexos que só existem nele: desligar faria
//                  todos eles responderem "não está mais no cofre" (404). Fica ligado: leitura dá 503
//                  honesto ("indisponível"), envio dá erro, e o aviso aparece no log e no painel.
// USO: decisaoTesteBoot({ statusArmazenamento: 403 }, 'gestaorm-arquivos', { bucketArquivos: 'gestaorm-arquivos' }) // => 'manter'
function decisaoTesteBoot(erro, bucket, marcador) {
  if (!erroDeConfiguracao(erro)) return 'passageiro';
  return bucketComArquivos(marcador) === bucket ? 'manter' : 'desligar';
}

// Aviso quando há anexos só num bucket que ESTA instância não lê ('' = tudo certo).
// USO: avisoArquivosForaDeAlcance({ bucketArquivos: 'gestaorm-arquivos' }, '') // => 'Há anexos que só existem…'
function avisoArquivosForaDeAlcance(marcador, bucketLido) {
  const b = bucketComArquivos(marcador);
  if (!b || b === bucketLido) return '';
  return `Há anexos que só existem no bucket "${b}", mas esta instância ${bucketLido ? `lê o bucket "${bucketLido}"` : 'está sem o R2'}: eles respondem "cofre indisponível" até MIDIA_S3_* voltar a apontar para "${b}".`;
}

// O --apagar-do-mongo só pode rodar com o site DE PRODUÇÃO lendo do mesmo bucket, e agora: o
// marcador tem de ter sido gravado pela instância do Render (não por um `npm run dev` ligado no
// Mongo de produção), no mesmo bucket e endpoint, com sinal de vida recente — e pelo MESMO
// deploy que está no ar (`buildNoAr`, o `build` do /api/versao público = RENDER_GIT_COMMIT):
// um rollback, ou um deploy novo que gravou o marcador e falhou (o Render mantém o anterior no
// ar), deixa o marcador com um commit que não é o do site.
// `agora` é o relógio do PC e `vistoTs` o do Render: até 5 min "no futuro" é folga de relógio.
// USO: marcadorPermiteApagar(m, { bucket: 'gestaorm-arquivos', origem: 'https://c.r2…', agora: Date.now(), buildNoAr: '3f9a1c2…' })
//   // => { ok: true } | { ok: false, motivo: 'o site no ar está no deploy 1a2b3c4…' }
function marcadorPermiteApagar(m, { bucket, origem, agora, buildNoAr, maxIdadeMs = 15 * 60 * 1000 }) {
  const nao = (motivo) => ({ ok: false, motivo });
  if (!m || !m.ativo) return nao('o site ainda não lê do R2 (configure MIDIA_S3_* no Render e faça o deploy da versão com o R2).');
  if (m.render !== true) return nao('o marcador não foi gravado pelo site no Render (foi um servidor local ligado no Mongo de produção?). Faça um deploy e rode de novo.');
  if (m.bucket !== bucket) return nao(`o site lê o bucket "${m.bucket}", não "${bucket}".`);
  if (origem && m.origem && m.origem !== origem) return nao(`o site lê o endpoint ${m.origem}, não ${origem}.`);
  if (buildNoAr !== undefined && String(buildNoAr) !== String(m.commit || '')) {
    return nao(`o site no ar está no deploy ${String(buildNoAr || '?').slice(0, 7)}, mas quem gravou o marcador foi o deploy ${String(m.commit || '?').slice(0, 7)} (rollback, ou um deploy que falhou). Faça o deploy da versão com o R2 e rode de novo.`);
  }
  const idade = agora - (Number(m.vistoTs) || 0);
  if (!(idade >= -5 * 60 * 1000 && idade <= maxIdadeMs)) {
    return nao(idade < 0
      ? `o relógio deste computador está ${Math.round(-idade / 60000)} min atrás do servidor. Acerte a hora do Windows (Configurações › Hora › Sincronizar agora) e rode de novo.`
      : `o site não dá sinal há ${Math.round(idade / 60000)} min (pode estar dormindo ou ter voltado para uma versão sem o R2). Abra o site, espere 1 min e rode de novo.`);
  }
  return { ok: true };
}

// Mensagem clara para os erros comuns (sem citar credencial).
function mensagemS3(status, codigo, mensagem) {
  if (codigo === 'SignatureDoesNotMatch') return 'O R2 recusou a assinatura (SignatureDoesNotMatch). Confira o segredo da chave e se a região é "auto".';
  if (codigo === 'InvalidAccessKeyId') return 'O R2 não reconhece a chave de acesso (InvalidAccessKeyId). Confira MIDIA_S3_KEY_ID.';
  if (codigo === 'AccessDenied') return 'O R2 negou o acesso (AccessDenied). O token precisa de Object Read & Write no bucket de arquivos.';
  if (codigo === 'NoSuchBucket') return 'O bucket de arquivos não existe (NoSuchBucket). Confira MIDIA_S3_BUCKET.';
  if (status === 403) return `O R2 negou o acesso (${codigo || 403}). A chave precisa de leitura e escrita no bucket de arquivos.`;
  return `O R2 respondeu ${status}${codigo ? ` (${codigo})` : ''}${mensagem ? `: ${mensagem}` : ''}.`;
}

// ----------------------------------------------------------------------------
// Driver S3/R2
// ----------------------------------------------------------------------------

// opcoes (só testes): { fetch, timeoutMs, retentativas, esperaMs }. Padrão: fetch global, 60 s
// por requisição, 2 retentativas em 5xx/erro de rede (PUT/GET/HEAD/DELETE são idempotentes).
// Erros lançados: e.status 502 (falha do armazenamento) e, quando o R2 informa, e.codigo.
// USO: const cofre = criarCofre(lerConfigCofre(process.env)); // => driver | null (desligado)
//      await cofre.gravar(chaveMidia(id), { buf, tipo: 'image/png', nome: 'foto.png', ts: Date.now() })
//      await cofre.ler(chaveMidia(id))   // => { buf, tipo, nome, ts, sha256 } | null
function criarCofre(cfg, opcoes = {}) {
  if (!cfg || !cfg.ativo) return null;
  const s3 = cfg.s3;
  const base = new URL(s3.endpoint);
  const buscar = opcoes.fetch || globalThis.fetch;
  // timeoutMs vale até o R2 COMEÇAR a responder (cabeçalhos); timeoutCorpoMs, para terminar de
  // mandar o corpo. Separados porque um PDF de 9 MB numa hora de banda curta pode levar mais que
  // o prazo curto de "o R2 está vivo?" — e ele respondeu, não está fora do ar (codigo 'LENTO').
  const timeoutMs = opcoes.timeoutMs || 60000;
  const timeoutCorpoMs = opcoes.timeoutCorpoMs || timeoutMs;
  const retentativas = opcoes.retentativas == null ? 2 : opcoes.retentativas;
  const esperaMs = opcoes.esperaMs == null ? 500 : opcoes.esperaMs;
  const dormir = (ms) => new Promise((ok) => setTimeout(ok, ms));

  // Requisição assinada. `chave` '' = o bucket (listagem). Devolve o corpo como Buffer.
  async function req(metodo, chave, { query = {}, corpo, cabecalhos = {} } = {}) {
    const buf = corpo == null ? Buffer.alloc(0) : corpo;
    const caminho = `/${s3.bucket}${chave ? '/' + chave : ''}`;
    const qc = V.queryCanonica(query);
    const url = `${base.protocol}//${base.host}${V.caminhoCanonico(caminho)}${qc ? '?' + qc : ''}`;
    const semCorpo = metodo === 'GET' || metodo === 'HEAD' || metodo === 'DELETE';
    let ultimoErro;
    for (let tentativa = 0; tentativa <= retentativas; tentativa++) {
      if (tentativa) await dormir(esperaMs * tentativa);
      const cab = V.assinarRequisicao({
        metodo, host: base.host, caminho, query, cabecalhos,
        hashCorpo: sha256hex(buf), region: s3.region, keyId: s3.keyId, keySecret: s3.keySecret,
      });
      delete cab.host; // o fetch deriva o Host da URL (o mesmo valor assinado)
      const ctrl = new AbortController();
      let t = setTimeout(() => ctrl.abort(), timeoutMs);
      let r, resposta, noCorpo = false;
      try {
        r = await buscar(url, { method: metodo, headers: cab, signal: ctrl.signal, body: semCorpo ? undefined : buf });
        clearTimeout(t);
        noCorpo = true;
        t = setTimeout(() => ctrl.abort(), timeoutCorpoMs);
        resposta = metodo === 'HEAD' ? Buffer.alloc(0) : Buffer.from(await r.arrayBuffer());
      } catch (e) {
        if (noCorpo && ctrl.signal.aborted) {
          // Respondeu e não terminou de mandar no prazo do corpo: lentidão, não "fora do ar" —
          // não é 'REDE' (o disjuntor de leitura do server.js só conta erroDeDisponibilidade).
          // Conexão que CAI no meio do corpo segue abaixo como falha de rede.
          ultimoErro = erro(`O R2 começou a responder, mas não terminou de enviar o arquivo em ${Math.round(timeoutCorpoMs / 1000)} s.`, 502, 'LENTO');
          continue;
        }
        // O fetch do Node diz só "fetch failed"; o código útil (ENOTFOUND, certificado…) vem na causa.
        const causa = (e && e.cause && (e.cause.code || (e.cause.cause && e.cause.cause.code))) || '';
        ultimoErro = erro(ctrl.signal.aborted
          ? `O R2 não respondeu em ${Math.round(timeoutMs / 1000)} s.`
          : `Falha de rede ao falar com o R2: ${e && e.message || e}${causa ? ` (${causa})` : ''}`, 502, 'REDE');
        ultimoErro.causa = causa;
        if (CAUSAS_SEM_RETENTATIVA.includes(causa)) break; // certificado/URL inválida: repetir não muda nada
        continue;
      } finally {
        clearTimeout(t);
      }
      const ehXml = !(r.status >= 200 && r.status < 300) || metodo === 'GET' && !chave;
      const texto = ehXml ? resposta.toString('utf8') : '';
      const codigo = V.tagXml(texto, 'Code');
      if (r.status >= 500) {
        ultimoErro = erro(mensagemS3(r.status, codigo, V.tagXml(texto, 'Message')), 502, codigo || undefined);
        ultimoErro.statusArmazenamento = r.status;
        continue;
      }
      return { status: r.status, headers: r.headers, corpo: resposta, texto, codigo };
    }
    throw ultimoErro;
  }
  const ok2xx = (r) => r.status >= 200 && r.status < 300;
  function falhar(r) {
    const e = erro(mensagemS3(r.status, r.codigo, V.tagXml(r.texto, 'Message')), 502, r.codigo || undefined);
    e.statusArmazenamento = r.status; // o HTTP do R2 (403, 404…) — o e.status é o nosso (502)
    throw e;
  }
  function exigirChave(chave) {
    if (!validarChave(chave)) throw erro('Chave de arquivo inválida.', 400);
  }
  function metadados(h) {
    let nome = '';
    try { nome = decodeURIComponent(h.get('x-amz-meta-nome') || ''); } catch (_) { nome = h.get('x-amz-meta-nome') || ''; }
    return {
      tipo: (h.get('content-type') || '').split(';')[0].trim(),
      nome,
      ts: Number(h.get('x-amz-meta-ts')) || 0,
      sha256: h.get('x-amz-meta-sha256') || '',
    };
  }

  const cofre = {
    tipo: 's3',
    bucket: s3.bucket,
    origem: base.origin,

    // Grava (ou substitui) o objeto. O R2 confere o corpo contra o x-amz-content-sha256 assinado,
    // então um 2xx aqui garante que o que ficou no bucket é exatamente `buf`.
    // USO: await cofre.gravar('midia/MD-1', { buf, tipo: 'application/pdf', nome: 'ASO.pdf', ts }) // => { bytes, sha256 }
    async gravar(chave, { buf, tipo, nome, ts } = {}) {
      exigirChave(chave);
      if (!Buffer.isBuffer(buf)) throw erro('Arquivo vazio ou inválido.', 400);
      const sha256 = sha256hex(buf);
      const r = await req('PUT', chave, {
        corpo: buf,
        cabecalhos: {
          'content-type': String(tipo || 'application/octet-stream').trim() || 'application/octet-stream',
          // Ida e volta por UTF-8 troca surrogate isolado (emoji cortado ao meio pelo slice, ou
          // já vindo assim) por U+FFFD — como o BSON do Mongo sempre fez. Sem isso o
          // encodeURIComponent lança URIError e o arquivo não é gravado.
          'x-amz-meta-nome': encodeURIComponent(Buffer.from(String(nome == null ? '' : nome).slice(0, NOME_MAX), 'utf8').toString('utf8')),
          'x-amz-meta-ts': String(Math.floor(Number(ts) || 0)),
          'x-amz-meta-sha256': sha256,
        },
      });
      if (!ok2xx(r)) falhar(r);
      return { bytes: buf.length, sha256 };
    },

    // USO: await cofre.ler('midia/MD-1') // => { buf, tipo, nome, ts, sha256 } | null (não existe)
    async ler(chave) {
      exigirChave(chave);
      const r = await req('GET', chave);
      if (r.status === 404) return null;
      if (!ok2xx(r)) falhar(r);
      return { buf: r.corpo, ...metadados(r.headers) };
    },

    // Só os metadados, sem baixar o arquivo.
    // USO: await cofre.cabeca('midia/MD-1') // => { bytes, tipo, nome, ts, sha256 } | null
    async cabeca(chave) {
      exigirChave(chave);
      const r = await req('HEAD', chave);
      if (r.status === 404) return null;
      if (!ok2xx(r)) falhar(r);
      return { bytes: Number(r.headers.get('content-length') || 0), ...metadados(r.headers) };
    },

    // Idempotente: objeto inexistente conta como apagado.
    // USO: await cofre.apagar('midia/MD-1') // => undefined
    async apagar(chave) {
      exigirChave(chave);
      const r = await req('DELETE', chave);
      if (ok2xx(r) || r.status === 404) return;
      falhar(r);
    },

    // Move com os metadados (ler → gravar → apagar a origem). false = a origem não existe.
    // Usado pela quarentena do "Desfazer" (midia/<id> ⇄ undo-midia/<op>/<id>).
    // USO: await cofre.mover('midia/MD-1', 'undo-midia/UD1/MD-1') // => true | false
    async mover(de, para) {
      exigirChave(de); exigirChave(para);
      const m = await cofre.ler(de);
      if (!m) return false;
      await cofre.gravar(para, m);
      await cofre.apagar(de);
      return true;
    },

    // Lista todas as chaves de um prefixo (paginado de 1000 em 1000 pelo R2).
    // USO: await cofre.listar('midia/') // => [{ chave: 'midia/MD-1', bytes: 5120, modificadoTs: 1790000000000 }, …]
    async listar(prefixo) {
      const p = String(prefixo || '');
      if (![PREFIXO_MIDIA, PREFIXO_UNDO, PREFIXO_TESTE].includes(p)) throw erro('Prefixo de listagem inválido.', 400);
      const saida = [];
      let token = '';
      for (let pagina = 0; pagina < 100000; pagina++) {
        const query = { 'list-type': '2', prefix: p };
        if (token) query['continuation-token'] = token;
        const r = await req('GET', '', { query });
        if (!ok2xx(r)) falhar(r);
        for (const b of V.blocosXml(r.texto, 'Contents')) {
          saida.push({ chave: V.tagXml(b, 'Key'), bytes: Number(V.tagXml(b, 'Size')) || 0, modificadoTs: Date.parse(V.tagXml(b, 'LastModified')) || 0 });
        }
        token = V.tagXml(r.texto, 'NextContinuationToken');
        if (V.tagXml(r.texto, 'IsTruncated') !== 'true' || !token) break;
      }
      return saida;
    },

    // Grava, relê (conferindo o conteúdo) e apaga um objeto de teste. Não deixa nada no bucket.
    // USO: await cofre.testar() // => { ok: true, mensagem: 'bucket "gestaorm-arquivos": leitura e escrita ok' }
    async testar() {
      const chave = PREFIXO_TESTE + crypto.randomBytes(16).toString('hex');
      const buf = crypto.randomBytes(32);
      await cofre.gravar(chave, { buf, tipo: 'application/octet-stream', nome: 'teste', ts: Date.now() });
      try {
        const m = await cofre.ler(chave);
        if (!m || !m.buf.equals(buf)) throw erro('O arquivo de teste voltou diferente do que foi gravado.', 502);
      } finally {
        await cofre.apagar(chave).catch(() => {});
      }
      return { ok: true, mensagem: `bucket "${s3.bucket}": leitura e escrita ok` };
    },
  };
  return cofre;
}

module.exports = {
  PREFIXO_MIDIA, PREFIXO_UNDO, PREFIXO_TESTE,
  limparId, chaveMidia, chaveUndoMidia, idDaChaveMidia, validarChave, tamanhoBase64,
  lerConfigCofre, criarCofre, erroDeConfiguracao, erroDeDisponibilidade,
  bucketComArquivos, decisaoTesteBoot, avisoArquivosForaDeAlcance, marcadorPermiteApagar,
};
