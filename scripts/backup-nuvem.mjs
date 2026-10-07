/**
 * backup-nuvem.mjs — leva o backup do Gestão RM para um armazenamento de objetos S3-compatível
 * (Backblaze B2, Cloudflare R2, Wasabi, MinIO, AWS S3).
 *
 * Roda no GitHub Actions, não no Render: o plano grátis do Render DORME após ~15 min ociosos e os
 * timers do servidor são relativos ao boot, então backup agendado dentro da instância não tem
 * execução garantida. Aqui o cron é de verdade e não consome a memória de produção (que já teve OOM).
 *
 * O .zip vem da MESMA rota do botão "Backup" do site, autenticada por token de máquina — a rotina
 * herda a guarda de cobertura e o registro no histórico. Ler o Mongo direto pelo CLI foi descartado:
 * scripts/backup-lib.js cobre 25 dos 44 módulos e produziria backup incompleto em silêncio.
 *
 * NUNCA carrega o .zip inteiro na memória: baixa em fluxo para o disco do runner (~14 GB, contra
 * ~7 GB de RAM) calculando o SHA-256 no caminho, e envia lendo do disco.
 *
 * USO:
 *   node scripts/backup-nuvem.mjs                 # gera, confere e envia
 *   node scripts/backup-nuvem.mjs --dry-run       # baixa e confere; NÃO envia
 *   node scripts/backup-nuvem.mjs --sem-anexos    # backup leve (só os dados)
 *   node scripts/backup-nuvem.mjs --grupo funcionarios
 *
 * VARIÁVEIS (GitHub → Settings → Secrets and variables → Actions):
 *   GDJ_BASE_URL      https://gestao.example.com
 *   GDJ_BACKUP_TOKEN  gdj_itg_<id>.<segredo>  — emitido com escopo ['backup:gerar'] APENAS
 *   S3_ENDPOINT       https://s3.us-west-004.backblazeb2.com   (o do seu bucket)
 *   S3_REGION         us-west-004   (no Cloudflare R2 use "auto")
 *   S3_BUCKET         gestaorm-backups
 *   S3_KEY_ID         id da chave de aplicação
 *   S3_KEY_SECRET     segredo da chave    ⚠️ ao contrário do segredo do Azure, NÃO expira
 *   S3_PREFIXO        opcional, padrão "gestao-rm/"
 *
 * RETENÇÃO: configure uma REGRA DE CICLO DE VIDA no painel do bucket (ex.: apagar após 90 dias).
 * É melhor que apagar por script — o provedor aplica sozinho, mesmo que esta rotina pare de rodar.
 *
 * SAÍDA ESPERADA:
 *   [1/3] baixando o backup de https://gestao.example.com … gestao-rm-backup-2026-08-18-03-00.zip · 87.4 MB
 *   [2/3] conferindo o conteúdo … 44 módulos · 1203 anexos · COMPLETO
 *   [3/3] enviando para s3://gestaorm-backups/gestao-rm/2026/08/… … ok
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import https from 'node:https';
import http from 'node:http';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

const ARGS = process.argv.slice(2);
const temFlag = (f) => ARGS.includes(f);
const valorFlag = (f, padrao) => { const i = ARGS.indexOf(f); return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : padrao; };
const DRY_RUN = temFlag('--dry-run');
const GRUPO = valorFlag('--grupo', 'completo');
const SEM_ANEXOS = temFlag('--sem-anexos');

function env(nome, obrigatoria = true, padrao = '') {
  const v = String(process.env[nome] || '').trim();
  if (!v && obrigatoria) throw erroFatal(`falta a variável de ambiente ${nome}. Configure em Settings → Secrets and variables → Actions do repositório.`);
  return v || padrao;
}
const mb = (n) => (n / 1024 / 1024).toFixed(1) + ' MB';
function erroFatal(msg) { const e = new Error(msg); e.semRetentativa = true; return e; }

// fetch com timeout que não deixa handle pendente: AbortSignal.timeout() segura um timer vivo até
// o prazo acabar, e sair do processo com ele pendente faz o Node no Windows abortar com
// "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)".
async function buscar(url, opcoes = {}, ms = 60000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opcoes, signal: ctrl.signal }); }
  catch (e) { if (e.name === 'AbortError') throw new Error(`tempo esgotado após ${Math.round(ms / 1000)}s`); throw e; }
  finally { clearTimeout(t); }
}

// ---------- 1. baixa o .zip para o DISCO, com o hash pelo caminho ----------
async function baixarBackup(destino) {
  const base = env('GDJ_BASE_URL').replace(/\/+$/, '');
  const qs = new URLSearchParams({ grupo: GRUPO });
  if (SEM_ANEXOS) qs.set('anexos', '0');
  console.log(`[1/3] baixando o backup de ${base} …`);

  // Timeout largo: no plano grátis a instância pode estar dormindo e leva 30-50 s só para acordar,
  // antes sequer de começar a montar o .zip.
  const r = await buscar(`${base}/api/integracoes/backup/v1/gerar?${qs}`,
    { headers: { Authorization: `Bearer ${env('GDJ_BACKUP_TOKEN')}` } }, 15 * 60 * 1000);
  if (r.status === 401 || r.status === 403) {
    throw erroFatal(`o Gestão RM recusou a credencial (${r.status}). Confira GDJ_BACKUP_TOKEN, se ela tem o escopo backup:gerar e se não foi revogada.`);
  }
  if (!r.ok) throw new Error(`o Gestão RM respondeu ${r.status} ao gerar o backup`);

  const cd = r.headers.get('content-disposition') || '';
  const m = /filename="?([^"]+)"?/.exec(cd);
  const nome = m ? m[1] : `gestao-rm-backup-${new Date().toISOString().slice(0, 10)}.zip`;

  // Hash calculado DURANTE a gravação: sem segunda leitura do arquivo e sem byte extra em memória.
  const hash = crypto.createHash('sha256');
  await pipeline(
    Readable.fromWeb(r.body),
    async function* (fonte) { for await (const p of fonte) { hash.update(p); yield p; } },
    fs.createWriteStream(destino),
  );
  const bytes = fs.statSync(destino).size;
  if (!bytes) throw new Error('o backup veio vazio');
  console.log(`      ${nome} · ${mb(bytes)}`);
  return { nome, bytes, sha256: hash.digest('hex') };
}

// ---------- 2. confere o conteúdo ANTES de publicar ----------
// Olhar os 2 primeiros bytes ('PK') não serve de nada: é o cabeçalho da PRIMEIRA entrada, então
// qualquer .zip truncado passa no teste. Aqui lemos o manifest de verdade e exigimos que o backup
// se declare COMPLETO — é o que impede uma cópia pela metade de virar "o backup de ontem".
async function conferir(arquivo) {
  console.log('[2/3] conferindo o conteúdo …');
  let yauzl;
  try { const mod = await import('yauzl'); yauzl = mod.default || mod; }
  catch (e) { throw erroFatal('o pacote `yauzl` não está disponível. No workflow, acrescente o passo `npm i --no-save yauzl@^3.4.0` antes de rodar este script.'); }

  const manifest = await new Promise((ok, falhou) => {
    yauzl.open(arquivo, { lazyEntries: true }, (err, zip) => {
      if (err) return falhou(erroFatal('o arquivo baixado não é um .zip legível: ' + err.message));
      let achou = false;
      zip.on('entry', (e) => {
        if (e.fileName !== 'manifest.json') return zip.readEntry();
        achou = true;
        zip.openReadStream(e, (err2, fluxo) => {
          if (err2) return falhou(err2);
          const partes = [];
          fluxo.on('data', (d) => partes.push(d));
          fluxo.on('end', () => {
            try { ok(JSON.parse(Buffer.concat(partes).toString('utf-8'))); }
            catch (e3) { falhou(erroFatal('manifest.json ilegível')); }
          });
        });
      });
      zip.on('end', () => { if (!achou) falhou(erroFatal('o .zip não tem manifest.json — download truncado ou geração interrompida no meio.')); });
      zip.readEntry();
    });
  });

  const nMod = (manifest.modulos || []).length;
  const nAnx = (manifest.anexos || []).length;
  const completo = manifest.completo !== false;
  console.log(`      ${nMod} módulos · ${nAnx} anexos · ${completo ? 'COMPLETO' : '⚠ INCOMPLETO'}`);
  if (!nMod) throw erroFatal('o manifest não lista módulo nenhum — backup inválido.');
  if (!completo) {
    const f = (manifest.falhas || []).length;
    throw erroFatal(`o backup se declara INCOMPLETO (${f} anexo(s) não entraram). Publicar isto seria guardar uma cópia furada achando que está protegido. Veja o alerta no cartão de Backup do sistema.`);
  }
  return manifest;
}

// ---------- 3. envia (S3 / assinatura SigV4 feita à mão) ----------
// Sem SDK de propósito: o workflow não roda `npm ci` (traria sharp, tesseract e pdf-to-img à toa),
// e a assinatura de um PUT são ~30 linhas com o `crypto` embutido.
const sha256hex = (x) => crypto.createHash('sha256').update(x).digest('hex');
const hmac = (chave, dado) => crypto.createHmac('sha256', chave).update(dado).digest();

// Assinatura AWS Signature Version 4 de um PUT de objeto — os mesmos passos valem em B2, R2,
// Wasabi e MinIO. Devolve a URL e os cabeçalhos prontos.
//
// USO:
//   assinarPut({ endpoint:'https://s3.us-west-004.backblazeb2.com', region:'us-west-004',
//                bucket:'meus-backups', chaveObj:'gestao-rm/2026/08/b.zip', keyId:'…',
//                keySecret:'…', sha256corpo:'<sha256 do arquivo>', bytes: 123456,
//                agora:'20260818T030000Z' })
//   → { url: 'https://…/meus-backups/gestao-rm/2026/08/b.zip', cabecalhos: { Authorization: 'AWS4-HMAC-SHA256 …', … } }
function assinarPut({ endpoint, region, bucket, chaveObj, keyId, keySecret, sha256corpo, bytes, agora }) {
  const url = new URL(`${endpoint.replace(/\/+$/, '')}/${bucket}/${chaveObj}`);
  agora = agora || new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20260818T030000Z
  const dia = agora.slice(0, 8);
  const cabecalhos = {
    host: url.host,
    'content-length': String(bytes),
    'x-amz-content-sha256': sha256corpo,
    'x-amz-date': agora,
  };
  const assinados = Object.keys(cabecalhos).sort();
  const canonicos = assinados.map((h) => `${h}:${cabecalhos[h]}\n`).join('');
  const listaAssinados = assinados.join(';');
  // Cada segmento do caminho vai codificado separadamente: as barras da "pasta" continuam barras.
  const caminho = url.pathname.split('/').map((s) => encodeURIComponent(decodeURIComponent(s))).join('/');
  const requisicaoCanonica = ['PUT', caminho, '', canonicos, listaAssinados, sha256corpo].join('\n');
  const escopo = `${dia}/${region}/s3/aws4_request`;
  const paraAssinar = ['AWS4-HMAC-SHA256', agora, escopo, sha256hex(requisicaoCanonica)].join('\n');
  const chaveAssinatura = hmac(hmac(hmac(hmac('AWS4' + keySecret, dia), region), 's3'), 'aws4_request');
  const assinatura = crypto.createHmac('sha256', chaveAssinatura).update(paraAssinar).digest('hex');
  cabecalhos.Authorization = `AWS4-HMAC-SHA256 Credential=${keyId}/${escopo}, SignedHeaders=${listaAssinados}, Signature=${assinatura}`;
  return { url: url.toString(), cabecalhos };
}

// PUT por `https.request`, NÃO por fetch: com corpo em fluxo o fetch manda
// `Transfer-Encoding: chunked`, e praticamente todo S3 recusa PUT sem `Content-Length` exato.
// Aqui o tamanho é conhecido (veio do statSync) e o arquivo vai do disco direto para o socket.
function putEmFluxo(url, cabecalhos, arquivo, ms = 60 * 60 * 1000) {
  return new Promise((ok, falhou) => {
    const alvo = new URL(url);
    const mod = alvo.protocol === 'http:' ? http : https;
    const req = mod.request(alvo, { method: 'PUT', headers: cabecalhos, timeout: ms }, (res) => {
      const partes = [];
      res.on('data', (d) => partes.push(d));
      res.on('end', () => ok({ status: res.statusCode, corpo: Buffer.concat(partes).toString('utf-8') }));
    });
    req.on('timeout', () => { req.destroy(new Error(`tempo esgotado após ${Math.round(ms / 60000)} min de envio`)); });
    req.on('error', falhou);
    const leitura = fs.createReadStream(arquivo);
    leitura.on('error', (e) => { req.destroy(e); });
    leitura.pipe(req);
  });
}

async function enviar(arquivo, info) {
  const bucket = env('S3_BUCKET');
  const prefixo = env('S3_PREFIXO', false, 'gestao-rm/').replace(/^\/+/, '');
  // Pasta por ano/mês: com centenas de arquivos a listagem no painel continua navegável.
  const d = new Date();
  const chaveObj = `${prefixo}${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${info.nome}`;
  console.log(`[3/3] enviando para s3://${bucket}/${chaveObj} …`);

  const { url, cabecalhos } = assinarPut({
    endpoint: env('S3_ENDPOINT'), region: env('S3_REGION'), bucket, chaveObj,
    keyId: env('S3_KEY_ID'), keySecret: env('S3_KEY_SECRET'),
    sha256corpo: info.sha256, bytes: info.bytes,
  });

  const r = await putEmFluxo(url, cabecalhos, arquivo);
  if (r.status === 403) throw erroFatal(`o armazenamento recusou a credencial (403). Confira S3_KEY_ID/S3_KEY_SECRET, se a chave tem permissão de escrita no bucket e se S3_REGION bate com o endpoint.\n  ${r.corpo.slice(0, 300)}`);
  if (r.status < 200 || r.status >= 300) throw new Error(`o armazenamento respondeu ${r.status}: ${r.corpo.slice(0, 300)}`);
  console.log(`      ok · ${mb(info.bytes)} · sha256 ${info.sha256.slice(0, 16)}…`);
}

// ---------- fluxo ----------
async function principal() {
  const temporario = path.join(os.tmpdir(), `gdj-backup-${process.pid}.zip`);
  try {
    const info = await baixarBackup(temporario);
    await conferir(temporario);
    if (DRY_RUN) {
      console.log(`\n✔ (dry-run) backup íntegro e completo: ${info.nome} · ${mb(info.bytes)}. Nada foi enviado.`);
    } else {
      await enviar(temporario, info);
      console.log('\n✔ Backup guardado na nuvem.');
    }
  } catch (e) {
    console.error(`\n✖ Backup para a nuvem FALHOU: ${e.message}`);
    process.exitCode = 1; // diferente de zero: o GitHub marca a execução como falha e avisa
  } finally {
    try { fs.unlinkSync(temporario); } catch (_) { /* já foi, ou nunca chegou a existir */ }
  }
}

// Só roda quando chamado pelo terminal. Sem esta guarda, o `import` do teste da assinatura
// dispararia o backup inteiro (e falharia por falta das variáveis de ambiente).
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await principal();

export { assinarPut }; // usado pelo teste da assinatura (test/backup-nuvem.test.js)
