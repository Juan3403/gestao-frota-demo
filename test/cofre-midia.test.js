/**
 * Cofre de mídia — distinção entre "arquivo removido" (404), "cofre indisponível" (503)
 * e "erro interno" (500) no download, cobrindo o caminho da Admissão (regressão do
 * sintoma de produção: indisponibilidade de infraestrutura respondia "os arquivos não
 * estão mais no cofre", como se os documentos tivessem sido apagados).
 *
 * A indisponibilidade é simulada pelo gancho determinístico TESTE_COFRE_INDISPONIVEL=1
 * (ver lerMidia no backend/server.js) — permissão de arquivo (chmod) e queda de Mongo
 * variam entre Windows/Linux/CI e não dão um teste estável.
 *
 * Os testes R2-* sobem o servidor com MIDIA_S3_* apontando para o S3 falso de
 * test/helpers/s3-falso.js e cobrem o cofre no bucket: gravação, leitura de reserva no
 * armazenamento antigo (data/uploads), Desfazer, faxina de órfãs, backup e R2 fora do ar.
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarS3Falso } = require('./helpers/s3-falso');

const PORT = 3209; // faixa de test/ é 3196-3209 (ver test/portas.test.js)
const BASE = `http://localhost:${PORT}`;
const ORIG = { Origin: BASE };
const MSG_COFRE = /cofre de arquivos está indisponível.*NÃO foram removidos/i;
let srv, tmp;
let srvSaida = null;
let srvLog = '';

function subirServidor(envExtra = {}) {
  srvSaida = null; srvLog = '';
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    // MIDIA_S3_* vazias: fora dos testes R2-* o cofre é o de data/uploads, e nenhum teste soma o
    // MIDIA_S3_LOCAL=1 com endpoint/chaves de PRODUÇÃO herdados do terminal de quem roda a suíte.
    env: { ...process.env, DATA_DIR: tmp, PORT: String(PORT), APP_PASSWORD: '', SENHA_ADMIN: '', MONGODB_URI: '', MIDIA_S3_BUCKET: '', MIDIA_S3_ENDPOINT: '', MIDIA_S3_REGION: '', MIDIA_S3_KEY_ID: '', MIDIA_S3_KEY_SECRET: '', MIDIA_S3_LOCAL: '', ...envExtra },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.on('exit', (codigo, sinal) => { srvSaida = codigo === null ? `sinal ${sinal}` : codigo; });
}
async function esperarServidor(ms = 10000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (srvSaida !== null) {
      throw new Error(`O servidor de teste (porta ${PORT}) morreu com código ${srvSaida} antes de responder.`
        + (srvLog ? `\n--- stderr do servidor ---\n${srvLog.slice(-2000)}` : ''));
    }
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de teste não respondeu a tempo');
}
async function derrubarServidor() {
  if (!srv) return;
  srv.kill();
  const fim = Date.now() + 5000;
  while (srvSaida === null && Date.now() < fim) await new Promise((r) => setTimeout(r, 50));
}

before(async () => {
  let portaOcupada = false;
  try { await fetch(BASE + '/api/versao', { signal: AbortSignal.timeout(1500) }); portaOcupada = true; }
  catch (e) { /* porta livre */ }
  if (portaOcupada) throw new Error(`A porta ${PORT} já está ocupada por outro processo (ver test/portas.test.js).`);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-cofre-test-'));
  subirServidor();
  await esperarServidor();
});

after(async () => {
  await derrubarServidor();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

const arquivoMidia = (id) => path.join(tmp, 'uploads', `${id}.json`);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
async function subirMidia(nome = 'foto.png') {
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), nome);
  const r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
  assert.equal(r.status, 201);
  return r.json();
}

let convite, docAdm; // preparados no 1º teste, reutilizados no cenário de indisponibilidade

test('download normal responde 200 e ausência REAL responde 404 (comportamento preservado)', async () => {
  const mid = await subirMidia();
  let r = await fetch(`${BASE}/api/midia/${mid.id}`);
  assert.equal(r.status, 200);
  assert.equal((await r.arrayBuffer()).byteLength, png.length);

  // Admissão completa (convite → upload público → submit) para o cenário do .zip.
  convite = (await (await fetch(`${BASE}/api/admissao`, {
    method: 'POST', headers: { ...ORIG, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'CANDIDATO COFRE', empresa: 'NTE', dias: 7 }),
  })).json()).admissao;
  const fd = new FormData();
  fd.append('arquivo', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), 'rg.pdf');
  fd.append('chave', 'rg');
  r = await fetch(`${BASE}/api/admissao/publico/${convite.token}/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
  assert.equal(r.status, 201);
  docAdm = await r.json();
  r = await fetch(`${BASE}/api/admissao/publico/${convite.token}`, {
    method: 'POST', headers: { ...ORIG, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resposta: { nome: 'CANDIDATO COFRE', cpf: '' }, docIds: [docAdm.id] }),
  });
  assert.equal(r.status, 200);
  r = await fetch(`${BASE}/api/admissao/${encodeURIComponent(convite.id)}/documentos/zip`);
  assert.equal(r.status, 200, 'com o cofre saudável o zip sai normalmente');
  // O zip agora sai em STREAMING (sem Content-Length, chunked): confere que o fluxo terminou
  // ÍNTEGRO — começa com a assinatura de entrada local (PK\x03\x04) e fecha com o End Of
  // Central Directory (PK\x05\x06). Fluxo interrompido no meio não teria o EOCD.
  const zipBuf = Buffer.from(await r.arrayBuffer());
  assert.equal(zipBuf.readUInt32LE(0), 0x04034b50, 'zip começa com a assinatura PK de entrada local');
  assert.equal(zipBuf.readUInt32LE(zipBuf.length - 22), 0x06054b50, 'zip termina com o EOCD (fluxo completo)');

  // Ausência REAL: apagado do cofre → 404 (individual) e 404 "não estão mais no cofre" (zip).
  fs.rmSync(arquivoMidia(mid.id));
  r = await fetch(`${BASE}/api/midia/${mid.id}`);
  assert.equal(r.status, 404);
});

test('JSON corrompido no cofre é erro interno (500), não vira 503 nem "removido"', async () => {
  const mid = await subirMidia('corrompida.png');
  fs.writeFileSync(arquivoMidia(mid.id), 'isto não é um JSON válido');
  const r = await fetch(`${BASE}/api/midia/${mid.id}`);
  assert.equal(r.status, 500, 'erro de estrutura não pode ser mascarado como indisponibilidade');
  const j = await r.json();
  assert.match(j.erro, /processar a requisição/i, 'GET usa a mensagem neutra, não "Falha ao salvar"');
  assert.doesNotMatch(j.erro, MSG_COFRE);
  assert.ok(j.correlationId, 'o 500 leva correlationId para rastrear no log');
  fs.rmSync(arquivoMidia(mid.id)); // não deixa o arquivo corrompido para os demais testes
});

test('cofre indisponível responde 503 e aborta o zip da Admissão (nunca "foram removidos")', async () => {
  // Mesmo DATA_DIR, servidor reaberto com o gancho de indisponibilidade ligado.
  // O gancho SÓ funciona com NODE_ENV=test (em produção a variável sozinha não tem efeito).
  await derrubarServidor();
  subirServidor({ NODE_ENV: 'test', TESTE_COFRE_INDISPONIVEL: '1' });
  await esperarServidor();

  // Download individual: 503 com a mensagem que NÃO acusa remoção.
  let r = await fetch(`${BASE}/api/midia/${docAdm.id}`);
  assert.equal(r.status, 503);
  let j = await r.json();
  assert.match(j.erro, MSG_COFRE);
  assert.ok(j.correlationId);

  // Zip da Admissão: aborta com 503 — nada de zip parcial nem DOCUMENTOS_FALTANDO.txt.
  r = await fetch(`${BASE}/api/admissao/${encodeURIComponent(convite.id)}/documentos/zip`);
  assert.equal(r.status, 503, 'indisponibilidade precisa abortar o zip, não fingir documento faltando');
  j = await r.json();
  assert.match(j.erro, MSG_COFRE);

  // Zip em LOTE idem.
  r = await fetch(`${BASE}/api/admissao/documentos/zip-lote?ids=${encodeURIComponent(convite.id)}`);
  assert.equal(r.status, 503);
  assert.match((await r.json()).erro, MSG_COFRE);

  // Volta o servidor saudável: o mesmo documento baixa 200 (nada foi removido de verdade).
  await derrubarServidor();
  subirServidor();
  await esperarServidor();
  r = await fetch(`${BASE}/api/midia/${docAdm.id}`);
  assert.equal(r.status, 200, 'passada a indisponibilidade o arquivo continua no cofre');
});

test('o gancho de teste é INERTE sem NODE_ENV=test (nenhum backdoor operacional em produção)', async () => {
  // Simula o ambiente de produção: a variável do gancho definida, mas NODE_ENV ≠ test.
  await derrubarServidor();
  subirServidor({ NODE_ENV: '', TESTE_COFRE_INDISPONIVEL: '1' });
  await esperarServidor();
  const r = await fetch(`${BASE}/api/midia/${docAdm.id}`);
  assert.equal(r.status, 200, 'fora do ambiente de teste a variável sozinha não pode forçar indisponibilidade');
});

// ----------------------------------------------------------------------------------------
// Cofre no R2 (MIDIA_S3_*): o servidor contra o S3 falso
// ----------------------------------------------------------------------------------------
let falso = null, envR2 = null, antigo = null, novo = null;
const JSON_H = { 'Content-Type': 'application/json', ...ORIG };
after(() => (falso ? new Promise((ok) => falso.srv.close(ok)) : undefined));
async function esperarUndoDisponivel(area, ms = 3000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const d = await (await fetch(`${BASE}/api/desfazer/status?area=${encodeURIComponent(area)}`)).json();
    if (d.disponivel) return d;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error(`Undo de ${area} não ficou disponível`);
}
const baixar = async (id) => { const r = await fetch(`${BASE}/api/midia/${id}`); return { r, buf: r.ok ? Buffer.from(await r.arrayBuffer()) : null }; };
const servicoCofre = async () => {
  const s = await (await fetch(`${BASE}/api/dev/servicos`, { headers: { ...ORIG } })).json();
  return (Array.isArray(s) ? s : s.servicos || []).find((x) => x.nome === 'Cofre de mídia');
};

test('R2-0: no modo local as MIDIA_S3_* do terminal são IGNORADAS sem MIDIA_S3_LOCAL=1 — o servidor nem encosta no bucket', async () => {
  // Quem define as chaves de produção no PowerShell para o script de migração e roda `npm test`
  // no mesmo terminal: sem esta trava, a faxina de órfãs da base de TESTE apagaria do bucket de
  // PRODUÇÃO tudo o que ela não cita.
  falso = criarS3Falso({ segredo: 'segredo-r2', bucket: 'arquivos' });
  await new Promise((ok) => falso.srv.listen(0, '127.0.0.1', ok));
  const endpoint = `http://127.0.0.1:${falso.srv.address().port}`;
  falso.estado.objetos.set('midia/MD-producao', { buf: png, tipo: 'image/png', meta: { nome: 'p', ts: '1', sha256: '' }, modificado: new Date(Date.now() - 3 * 60 * 60 * 1000) });
  await derrubarServidor();
  subirServidor({ MIDIA_S3_BUCKET: 'arquivos', MIDIA_S3_ENDPOINT: endpoint, MIDIA_S3_KEY_ID: 'chave-r2', MIDIA_S3_KEY_SECRET: 'segredo-r2' });
  await esperarServidor();
  antigo = await subirMidia('antigo.png');
  assert.ok(fs.existsSync(arquivoMidia(antigo.id)), 'o envio fica em data/uploads');
  assert.equal((await fetch(`${BASE}/api/midia/limpar-orfas`, { method: 'POST', headers: { ...ORIG } })).status, 200);
  assert.ok(falso.estado.objetos.has('midia/MD-producao'), 'a faxina local não apagou nada do bucket');
  assert.equal(falso.estado.log.length, 0, 'nenhuma requisição chegou ao bucket');
  falso.estado.objetos.clear();
});

test('R2-1: com MIDIA_S3_BUCKET o arquivo novo vai para o bucket e baixa igual; o antigo em data/uploads continua baixando', async () => {
  // Acervo antigo: `antigo`, enviado no R2-0 com o R2 desligado (está em data/uploads).
  assert.ok(fs.existsSync(arquivoMidia(antigo.id)));
  envR2 = { MIDIA_S3_LOCAL: '1', MIDIA_S3_PAUSA_MS: '400', MIDIA_S3_BUCKET: 'arquivos', MIDIA_S3_ENDPOINT: `http://127.0.0.1:${falso.srv.address().port}`, MIDIA_S3_KEY_ID: 'chave-r2', MIDIA_S3_KEY_SECRET: 'segredo-r2' };
  await derrubarServidor(); subirServidor(envR2); await esperarServidor();

  novo = await subirMidia('Foto Ação.png');
  assert.equal(fs.existsSync(arquivoMidia(novo.id)), false, 'com o R2 ligado nada novo cai em data/uploads');
  const obj = falso.estado.objetos.get('midia/' + novo.id);
  assert.ok(obj, 'o arquivo está no bucket');
  assert.ok(obj.buf.equals(png), 'em binário, sem base64');
  assert.equal(obj.tipo, 'image/png');

  const { r, buf } = await baixar(novo.id);
  assert.equal(r.status, 200);
  assert.ok(buf.equals(png), 'o download devolve os mesmos bytes');
  assert.equal(r.headers.get('content-type'), 'image/png');
  // O nome volta IDÊNTICO ao que o servidor gravou (acentos no metadado do objeto vão
  // URI-encoded). Compara com o `nome` da resposta do upload, não com 'Foto Ação.png': o multer
  // lê o nome do multipart como latin1 desde sempre (defeito à parte, igual sem o R2).
  const m = /filename\*=UTF-8''([^;]+)/.exec(r.headers.get('content-disposition') || '');
  assert.ok(m, 'o download traz o nome em UTF-8');
  assert.equal(decodeURIComponent(m[1]), novo.nome, 'o nome sobrevive à ida e volta pelo bucket');

  const velho = await baixar(antigo.id);
  assert.equal(velho.r.status, 200, 'arquivo ainda não copiado é lido do armazenamento antigo');
  assert.ok(velho.buf.equals(png));
  assert.equal(falso.estado.recusadas, 0, 'toda requisição ao bucket saiu com assinatura válida');
});

test('R2-2: excluir e Desfazer devolvem o anexo do bucket E o do armazenamento antigo; a quarentena não fica para trás', async () => {
  let r = await fetch(`${BASE}/api/multas`, {
    method: 'POST', headers: JSON_H,
    body: JSON.stringify({
      placa: 'RDO1A23', autoInfracao: 'AI-R2', valor: 10,
      documentos: [
        { id: novo.id, nome: 'Notificação', tipo: novo.tipo, categoria: 'Notificação', nomeOriginal: 'n.png' },
        { id: antigo.id, nome: 'Boleto', tipo: antigo.tipo, categoria: 'Boleto', nomeOriginal: 'b.png' },
      ],
    }),
  });
  assert.equal(r.status, 201);
  const multa = await r.json();
  assert.equal(multa.documentos.length, 2);

  assert.equal((await fetch(`${BASE}/api/multas/${encodeURIComponent(multa.id)}`, { method: 'DELETE', headers: { ...ORIG } })).status, 200);
  assert.equal((await baixar(novo.id)).r.status, 404, 'o anexo do bucket saiu de circulação');
  assert.equal((await baixar(antigo.id)).r.status, 404, 'o anexo antigo também (a leitura de reserva não o ressuscita)');
  assert.ok([...falso.estado.objetos.keys()].some((k) => k.startsWith('undo-midia/') && k.endsWith('/' + novo.id)), 'quarentena no bucket');

  await esperarUndoDisponivel('multas');
  r = await fetch(`${BASE}/api/desfazer/ultimo`, { method: 'POST', headers: JSON_H, body: JSON.stringify({ area: 'multas' }) });
  assert.equal(r.status, 200, 'o Desfazer encontrou as duas quarentenas');
  const a = await baixar(novo.id), b = await baixar(antigo.id);
  assert.equal(a.r.status, 200);
  assert.ok(a.buf.equals(png));
  assert.equal(b.r.status, 200);
  assert.ok(falso.estado.objetos.has('midia/' + novo.id), 'voltou para midia/ no bucket');
  assert.ok(![...falso.estado.objetos.keys()].some((k) => k.startsWith('undo-midia/')), 'a quarentena foi consumida');
});

test('R2-3: a faxina apaga do bucket só o órfão com mais de 1 h; referenciado velho e órfão recente ficam', async () => {
  const orfao = await subirMidia('orfao.png');
  const recente = await subirMidia('recente.png');
  const duasHoras = new Date(Date.now() - 2 * 60 * 60 * 1000);
  falso.estado.objetos.get('midia/' + orfao.id).modificado = duasHoras;
  falso.estado.objetos.get('midia/' + novo.id).modificado = duasHoras; // referenciado pela multa restaurada
  const r = await fetch(`${BASE}/api/midia/limpar-orfas`, { method: 'POST', headers: { ...ORIG } });
  assert.equal(r.status, 200);
  assert.ok((await r.json()).removidas >= 1);
  assert.equal(falso.estado.objetos.has('midia/' + orfao.id), false, 'órfão velho apagado');
  assert.ok(falso.estado.objetos.has('midia/' + novo.id), 'referenciado fica, por mais velho que seja');
  assert.ok(falso.estado.objetos.has('midia/' + recente.id), 'órfão recente espera (pode ser upload de cadastro ainda não salvo)');
});

test('R2-4: o backup com anexos leva o arquivo do bucket e o do armazenamento antigo, e sai completo', async () => {
  const r = await fetch(`${BASE}/api/backup/gerar?grupo=multas`, { headers: { ...ORIG } });
  assert.equal(r.status, 200);
  const zip = Buffer.from(await r.arrayBuffer());
  assert.ok(zip.includes(Buffer.from(novo.id)), 'anexo do bucket no .zip');
  assert.ok(zip.includes(Buffer.from(antigo.id)), 'anexo antigo no .zip');
  const fd = new FormData();
  fd.append('arquivo', new Blob([zip], { type: 'application/zip' }), 'r2.zip');
  const v = await (await fetch(`${BASE}/api/backup/validar`, { method: 'POST', headers: { ...ORIG }, body: fd })).json();
  assert.equal(v.manifest.completo, true, 'nenhum anexo referenciado ficou de fora');
});

test('R2-5: R2 fora do ar dá 503 (nunca "removido") e o envio falha sem cair escondido no armazenamento antigo', async () => {
  const antes = fs.readdirSync(path.join(tmp, 'uploads')).length;
  falso.estado.fora = true;
  try {
    let r = await fetch(`${BASE}/api/midia/${novo.id}`);
    assert.equal(r.status, 503);
    assert.match((await r.json()).erro, MSG_COFRE);
    // Disjuntor: só abre com 3 falhas SEGUIDAS de disponibilidade (5xx/rede) — um soluço isolado
    // não pausa a leitura de todos. Mais duas leituras com o R2 fora completam as 3…
    for (let i = 0; i < 2; i++) assert.equal((await fetch(`${BASE}/api/midia/${novo.id}`)).status, 503);
    // …e a partir daí a leitura nem chama o R2 (responde na hora).
    const reqAntes = falso.estado.log.length;
    r = await fetch(`${BASE}/api/midia/${novo.id}`);
    assert.equal(r.status, 503);
    assert.equal(falso.estado.log.length, reqAntes, 'em pausa, nenhuma requisição ao R2');
    // O que ainda está no armazenamento antigo continua baixando com o R2 fora (antes: 503 em tudo).
    assert.equal((await fetch(`${BASE}/api/midia/${antigo.id}`)).status, 200, 'o acervo antigo não depende do R2');
    const fd = new FormData();
    fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'durante-queda.png');
    r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
    assert.equal(r.status, 500, 'a gravação falha às claras');
    assert.equal(fs.readdirSync(path.join(tmp, 'uploads')).length, antes, 'nada foi gravado no armazenamento antigo');
  } finally {
    falso.estado.fora = false;
  }
  await new Promise((ok) => setTimeout(ok, 500)); // passa a pausa do disjuntor (MIDIA_S3_PAUSA_MS=400)
  assert.equal((await baixar(novo.id)).r.status, 200, 'passada a queda, o arquivo continua lá');
});

test('R2-6: painel de Serviços testa o bucket; config incompleta avisa no boot, acende vermelho e os arquivos seguem no antigo', async () => {
  let cofre = await servicoCofre();
  assert.ok(cofre, 'o painel lista o cofre');
  assert.equal(cofre.ok, true);
  assert.match(cofre.info, /bucket "arquivos"/);
  assert.ok(![...falso.estado.objetos.keys()].some((k) => k.startsWith('teste-conexao/')), 'o teste do painel não deixa lixo no bucket');

  await derrubarServidor();
  subirServidor({ MIDIA_S3_LOCAL: '1', MIDIA_S3_BUCKET: 'arquivos', VIDEO_S3_ENDPOINT: '', VIDEO_S3_KEY_ID: '', VIDEO_S3_KEY_SECRET: '' });
  await esperarServidor();
  assert.match(srvLog, /AVISO: Falta MIDIA_S3_ENDPOINT/, 'o boot avisa em voz alta');
  cofre = await servicoCofre();
  assert.equal(cofre.ok, false);
  assert.match(cofre.info, /R2 não ligado/);
  const mid = await subirMidia('sem-r2.png');
  assert.ok(fs.existsSync(arquivoMidia(mid.id)), 'sem R2 válido o site segue gravando no armazenamento antigo');
});

test('R2-7: chave errada é pega NO BOOT — o R2 fica desligado e os anexos antigos continuam baixando (nada de 503 em tudo)', async () => {
  // Sem o teste do boot, o R2 subia ligado e respondia 403 a tudo: todo download virava
  // "cofre indisponível" (até os antigos, que a leitura de reserva serviria) e todo envio falhava.
  await derrubarServidor();
  subirServidor({ ...envR2, MIDIA_S3_KEY_SECRET: 'segredo-errado' });
  await esperarServidor();
  assert.match(srvLog, /O R2 recusou o acesso no boot e ficou desligado/, 'o boot diz por que desligou');
  assert.doesNotMatch(srvLog, /segredo-errado/, 'sem vazar a credencial no log');
  const velho = await baixar(antigo.id);
  assert.equal(velho.r.status, 200, 'o anexo antigo continua baixando');
  const cofre = await servicoCofre();
  assert.equal(cofre.ok, false);
  assert.match(cofre.info, /recusou o acesso no boot/);
  const mid = await subirMidia('chave-errada.png');
  assert.ok(fs.existsSync(arquivoMidia(mid.id)), 'o envio funciona, no armazenamento antigo');
  assert.ok(![...falso.estado.objetos.keys()].some((k) => k.startsWith('teste-conexao/')), 'o teste do boot não deixou lixo');
});
