/**
 * Backup — ida e volta dos módulos que moram no doc `sistema_config`.
 *
 * Arquivo próprio (e porta própria) porque o restore é DESTRUTIVO: reescreve módulos inteiros e
 * chama salvarBackupAuto(). Rodar isso dentro de modulos.test.js contaminaria as demais asserções.
 *
 * O que se protege aqui:
 *  1. `vigenciasContratos` e `experienciaDias` são dado de NEGÓCIO e não estavam em backup nenhum
 *     — nem completo, nem seletivo. Perda irrecuperável num cenário de desastre.
 *  2. Eles moram no MESMO doc do estado de segurança vivo (sessEpoca*, ipBloqueados,
 *     areasLiberadas, modo manutenção). O restore só pode tocar as duas chaves de negócio: a
 *     sentinela do passo 5 é o que prova isso, e é o assert mais importante do arquivo.
 *
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3205;
const BASE = `http://localhost:${PORT}`;
// Contrato REAL do catálogo versionado (config/funcionarios-contratos.json) — número inventado dá 400.
const CONTRATO = '4600009505'; // ORION (NTE)
const ORIG = { Origin: BASE, 'Content-Type': 'application/json' };
let srv, tmp;
// Estado do processo filho: sem isto, um servidor que morre no boot (EADDRINUSE, variável de
// ambiente faltando...) some em silêncio — o spawn descartava o stderr e ninguém olhava o código
// de saída, então a suíte seguia contra o servidor alheio já de pé na porta.
let srvSaida = null; // código (ou sinal) com que o filho morreu, se morreu
let srvLog = '';     // stderr do filho, para a mensagem de erro dizer o motivo

const post = (rota, corpo) => fetch(BASE + rota, { method: 'POST', headers: ORIG, body: JSON.stringify(corpo || {}) });
// Sobe uma imagem real ao cofre (o endpoint decide o tipo pelos magic bytes, não pelo MIME).
// ⚠️ sem o Content-Type do ORIG: FormData define o seu próprio, com o boundary.
async function subirFoto(nome = 'foto.png') {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), nome);
  const r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { Origin: BASE }, body: fd });
  assert.equal(r.status, 201, 'upload de mídia deve responder 201');
  return r.json();
}
const put = (rota, corpo) => fetch(BASE + rota, { method: 'PUT', headers: ORIG, body: JSON.stringify(corpo || {}) });
const getj = async (rota) => (await fetch(BASE + rota, { cache: 'no-store' })).json();

// 30 s como modulos/almoxarifado/acoes-sst: com a suíte inteira em paralelo, 10 s estourava no boot
// (falha intermitente "Servidor de teste não respondeu a tempo" nos BKP-*, que passavam sozinhos).
async function esperarServidor(ms = 30000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    // O filho morreu antes de responder. Sem esta checagem o laço iria até o timeout — ou,
    // pior, aceitaria o 200 de um servidor ALHEIO na mesma porta.
    if (srvSaida !== null) {
      throw new Error(`O servidor de teste (porta ${PORT}) morreu com código ${srvSaida} antes de responder.`
        + (srvLog ? `
--- stderr do servidor ---
${srvLog.slice(-2000)}` : ''));
    }
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de teste não respondeu a tempo');
}

before(async () => {
  // A porta precisa estar LIVRE ANTES do spawn. Se alguém já responde nela, o nosso servidor
  // morre com EADDRINUSE e o laço de espera aceitaria o 200 do intruso já no primeiro ciclo — a
  // suíte inteira rodaria contra o DATA_DIR, a COFRE_CHAVE e o teto de requisições de outro
  // servidor. test/portas.test.js impede a colisão entre arquivos do repo; isto aqui pega o
  // servidor esquecido aberto na máquina.
  let portaOcupada = false;
  try {
    await fetch(BASE + '/api/versao', { signal: AbortSignal.timeout(1500) });
    portaOcupada = true;
  } catch (e) { /* conexão recusada = porta livre, que é o que queremos */ }
  if (portaOcupada) {
    throw new Error(`A porta ${PORT} já está ocupada por outro processo. Encerre-o e rode de novo `
      + '(a convenção de portas do repositório está em test/portas.test.js).');
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-backup-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: tmp, PORT: String(PORT), APP_PASSWORD: '', SENHA_ADMIN: '', MONGODB_URI: '', COFRE_CHAVE: 'chave-segura-exclusiva-dos-testes' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Só o stderr é canalizado: o stdout do servidor é o banner e a telemetria de memória, ruído
  // puro aqui. E um cano que ninguém drena enche e trava o filho — por isso os dois listeners.
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.on('exit', (codigo, sinal) => { srvSaida = codigo === null ? `sinal ${sinal}` : codigo; });
  await esperarServidor();
});
after(() => {
  try { srv.kill(); } catch (e) { /* já morreu */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

test('BKP-2: vigências e dias de experiência sobrevivem ao ciclo backup → restore', async () => {
  // ---- 1. dado de negócio que TEM de voltar ----
  assert.equal((await put('/api/funcionarios/experiencia-dias', { padrao: 60, contratos: { [CONTRATO]: 90 } })).status, 200);
  assert.equal((await put(`/api/funcionarios/vigencias/${CONTRATO}`, { inicio: '2026-01-01', fimOriginal: '2026-12-31' })).status, 200);
  assert.equal((await post(`/api/funcionarios/vigencias/${CONTRATO}/aditivos`, { numero: '1', inicio: '2027-01-01', novoFim: '2027-06-30' })).status, 200);

  // ---- 2. sentinela: chave do MESMO doc que NÃO pode entrar no backup ----
  // O modo manutenção vive em sistema_config, ao lado de sessEpoca*/ipBloqueados/areasLiberadas.
  // Se o restore trocasse o doc em vez de fazer read-modify-write, isto sumiria — e junto com
  // ele iriam as sessões revogadas (re-validadas) e os banimentos de IP (desfeitos).
  assert.equal((await post('/api/sistema/manutencao', { ativo: true, mensagem: 'sentinela-do-teste' })).status, 200);

  // ---- 3. gera o .zip (sem anexos: aqui só interessam os JSON) ----
  const r = await fetch(`${BASE}/api/backup/gerar?grupo=funcionarios&anexos=0`, { headers: { Origin: BASE } });
  assert.equal(r.status, 200, 'a geração precisa responder 200');
  const zip = Buffer.from(await r.arrayBuffer());
  const texto = zip.toString('latin1'); // os nomes de entrada do ZIP não são comprimidos
  assert.ok(texto.includes('experiencia_dias.json'), 'o .zip precisa levar os dias de experiência');
  assert.ok(texto.includes('vigencias_contratos.json'), 'o .zip precisa levar as vigências de contrato');

  // ---- 4. estraga os dois ----
  assert.equal((await put('/api/funcionarios/experiencia-dias', { padrao: 30, contratos: {} })).status, 200);
  assert.equal((await post(`/api/funcionarios/vigencias/${CONTRATO}/encerrar`, { data: '2026-06-30', motivo: 'Fim da obra' })).status, 200);
  assert.equal((await getj('/api/funcionarios/experiencia-dias')).padrao, 30, 'sanidade: o estrago foi aplicado');

  // ---- 5. restaura em modo substituir ----
  const fd = new FormData();
  fd.append('arquivo', new Blob([zip], { type: 'application/zip' }), 'backup.zip');
  fd.append('aplicar', '1');
  fd.append('frase', 'RESTAURAR BACKUP');
  fd.append('modo', 'substituir');
  fd.append('grupos', 'funcionarios');
  const rr = await fetch(`${BASE}/api/backup/restaurar`, { method: 'POST', headers: { Origin: BASE }, body: fd });
  assert.equal(rr.status, 200, 'a restauração precisa responder 200');

  // ---- 6. o dado de negócio voltou ----
  const exp = await getj('/api/funcionarios/experiencia-dias');
  assert.equal(exp.padrao, 60, 'o padrão de dias tem de voltar ao valor do backup');
  assert.equal(exp.contratos[CONTRATO], 90, 'os dias por contrato têm de voltar');

  const vig = (await getj('/api/funcionarios/vigencias')).contratos[CONTRATO];
  assert.ok(vig, 'a vigência do contrato tem de voltar');
  assert.equal(vig.fimOriginal, '2026-12-31');
  assert.equal(vig.aditivos.length, 1, 'o aditivo de prorrogação tem de voltar');
  assert.equal(vig.aditivos[0].novoFim, '2027-06-30');
  assert.equal(vig.encerramento, null, 'o encerramento posterior ao backup tem de ser desfeito no modo substituir');

  // ---- 7. O ASSERT QUE IMPORTA: o resto do sistema_config sobreviveu ----
  const manut = await getj('/api/sistema/manutencao');
  assert.equal(manut.ativo, true, 'o restore NÃO pode apagar as outras chaves do sistema_config');
  assert.equal(manut.mensagem, 'sentinela-do-teste',
    'se isto quebrar, alguém trocou o salvar por um salvarDocBackup direto — e um restore em produção passa a revogar sessões e desfazer banimentos de IP');
});

test('BKP-4: anexo que não entra no .zip é DENUNCIADO no manifest, no resumo e no status', async () => {
  // Antes, backup incompleto era silencioso: o .zip saía com manifest válido, hashes corretos e
  // menos arquivos. Quem gerava via "✓ integridade conferida" e só descobria o buraco no dia da
  // restauração. Aqui o anexo é referenciado por uma vistoria e some do cofre à força.
  const foto = await subirFoto('sumida.png');
  const vist = await (await post('/api/vistorias', { placa: 'BKP1A11', tipo: 'Saída', motorista: 'FULANO', fotos: [foto] })).json();
  assert.ok(vist.id);

  // Apaga o arquivo do cofre SEM tirar a referência: é o estado de quem perdeu mídia.
  fs.unlinkSync(path.join(tmp, 'uploads', `${foto.id}.json`));

  const r = await fetch(`${BASE}/api/backup/gerar?grupo=frota`, { headers: { Origin: BASE } });
  assert.equal(r.status, 200, 'um anexo perdido não pode derrubar o backup dos 44 módulos');
  const zip = Buffer.from(await r.arrayBuffer());

  // O manifest tem de nomear o anexo que faltou e o motivo. (O conteúdo do resumo.txt não dá para
  // conferir por substring: só os NOMES das entradas ficam sem compressão dentro do .zip.)
  const fdv = new FormData();
  fdv.append('arquivo', new Blob([zip], { type: 'application/zip' }), 'incompleto.zip');
  const v = await (await fetch(`${BASE}/api/backup/validar`, { method: 'POST', headers: { Origin: BASE }, body: fdv })).json();
  assert.equal(v.manifest.completo, false, 'o manifest precisa marcar o backup como incompleto');
  assert.equal(v.manifest.falhas, 1, 'a falha precisa estar declarada, com o id do anexo perdido');

  // O histórico e o card do Início têm de acusar sozinhos.
  const st = await getj('/api/backup/status');
  assert.equal(st.ultimo.completo, false, 'o histórico precisa marcar o backup como incompleto');
  const alerta = (st.alertas || []).find((a) => /INCOMPLETO/.test(a.msg));
  assert.ok(alerta, 'o status precisa alertar sobre o backup incompleto');
  assert.equal(alerta.nivel, 'erro', 'incompletude é erro, não aviso');
  assert.equal(st.alertas[0].nivel, 'erro', 'o alerta grave tem de vir primeiro (o card mostra só o 1º)');
});

test('BKP-5: backup incompleto NÃO passa como íntegro na validação', async () => {
  // O SHA-256 só prova que o que está ali não foi adulterado — não diz nada sobre o que falta.
  const r = await fetch(`${BASE}/api/backup/gerar?grupo=frota`, { headers: { Origin: BASE } });
  const zip = Buffer.from(await r.arrayBuffer());

  const fd = new FormData();
  fd.append('arquivo', new Blob([zip], { type: 'application/zip' }), 'incompleto.zip');
  const v = await (await fetch(`${BASE}/api/backup/validar`, { method: 'POST', headers: { Origin: BASE }, body: fd })).json();
  assert.equal(v.integridade.ok, false, 'backup incompleto não pode ser dado como íntegro');
  assert.ok(v.integridade.problemas.some((p) => /INCOMPLETO/.test(p.erro)), 'o problema precisa nomear a incompletude');
  assert.equal(v.manifest.completo, false);
});

test('BKP-6: backup sem anexos (anexos=0) é COMPLETO — não é a mesma coisa que incompleto', async () => {
  // Pedir "sem anexos" é uma escolha, não uma falha: se isto marcasse incompleto, o alarme
  // tocaria todo dia no backup diário leve e ninguém mais olharia para ele.
  const r = await fetch(`${BASE}/api/backup/gerar?grupo=frota&anexos=0`, { headers: { Origin: BASE } });
  const zip = Buffer.from(await r.arrayBuffer());
  const fd = new FormData();
  fd.append('arquivo', new Blob([zip], { type: 'application/zip' }), 'sem-anexos.zip');
  const v = await (await fetch(`${BASE}/api/backup/validar`, { method: 'POST', headers: { Origin: BASE }, body: fd })).json();
  assert.equal(v.manifest.completo, true, 'sem anexos pedidos = nada faltando');
  assert.equal(v.integridade.ok, true);
});

test('BKP-7: PDF da fatura de locação sobrevive à faxina, entra no .zip (files/locacoes/faturas) e volta na restauração', async () => {
  // Mesma armadilha da admissão (1.55.3): anexo fora de midiasReferenciadas()/mapaPastaAnexos()
  // nunca entra no backup e a faxina diária o apaga ~1h depois de criado. Aqui o ciclo inteiro é
  // exercitado: gerar → faxina (arquivo envelhecido) → backup → perda total → restauração.
  // O BKP-4 deixa de propósito uma vistoria cuja foto sumiu do cofre: qualquer backup do grupo
  // Frota sai INCOMPLETO por causa dela e a restauração o recusa (é a regra do BKP-5). Limpa antes.
  const vistorias = await getj('/api/vistorias');
  for (const v of (Array.isArray(vistorias) ? vistorias : (vistorias.vistorias || []))) {
    if (v.placa === 'BKP1A11') assert.equal((await fetch(`${BASE}/api/vistorias/${encodeURIComponent(v.id)}`, { method: 'DELETE', headers: { Origin: BASE } })).status, 200);
  }
  assert.equal((await post('/api/locacoes', { placa: 'BKP2A22', modelo: 'GOL', dataChegada: '01/01/2026', valorInicial: 1000 })).status, 201);
  const pdf = await fetch(`${BASE}/api/locacoes/fatura/pdf?mes=07&ano=2026`);
  assert.equal(pdf.status, 200);
  const original = Buffer.from(await pdf.arrayBuffer());
  const idRegistro = pdf.headers.get('x-fatura-id');
  const reg = (await getj('/api/locacoes/faturas')).find((f) => f.id === idRegistro);
  assert.ok(reg && reg.arquivo && reg.arquivo.id, 'registro criado com o PDF no cofre');
  const arquivoMidia = path.join(tmp, 'uploads', `${reg.arquivo.id}.json`);
  assert.ok(fs.existsSync(arquivoMidia), 'sanidade: o PDF está no cofre local');

  // 1. A faxina de órfãs poupa arquivo com menos de 1 h — envelhece para a checagem valer.
  const envelhecer = () => { const m = JSON.parse(fs.readFileSync(arquivoMidia, 'utf8')); m.ts = Date.now() - 2 * 60 * 60 * 1000; fs.writeFileSync(arquivoMidia, JSON.stringify(m)); };
  envelhecer();
  assert.equal((await post('/api/midia/limpar-orfas', {})).status, 200);
  assert.ok(fs.existsSync(arquivoMidia), 'a faxina de órfãs NÃO pode apagar o PDF de uma fatura do histórico');

  // 2. O .zip do grupo Frota leva o registro E o arquivo, na pasta certa.
  const r = await fetch(`${BASE}/api/backup/gerar?grupo=frota&anexos=1`, { headers: { Origin: BASE } });
  assert.equal(r.status, 200, 'a geração precisa responder 200');
  const zip = Buffer.from(await r.arrayBuffer());
  const texto = zip.toString('latin1'); // nomes de entrada do ZIP não são comprimidos
  assert.ok(texto.includes('locacoes_faturas.json'), 'o .zip precisa levar o histórico de faturas');
  assert.ok(texto.includes(`files/locacoes/faturas/${reg.arquivo.id}`), 'o .zip precisa levar o PDF em files/locacoes/faturas');

  // 3. Perda total: registro excluído e PDF apagado do cofre (agora órfão de verdade).
  assert.equal((await fetch(`${BASE}/api/locacoes/faturas/${reg.id}`, { method: 'DELETE', headers: { Origin: BASE } })).status, 200);
  assert.equal((await post('/api/midia/limpar-orfas', {})).status, 200);
  assert.ok(!fs.existsSync(arquivoMidia), 'sanidade: sem registro o PDF é órfão e a faxina o remove');
  assert.equal((await fetch(`${BASE}/api/locacoes/faturas/${reg.id}/pdf`)).status, 404);

  // 4. Restaura (mesclar, grupo Frota): registro e PDF voltam byte a byte.
  const fd = new FormData();
  fd.append('arquivo', new Blob([zip], { type: 'application/zip' }), 'backup.zip');
  fd.append('aplicar', '1');
  fd.append('frase', 'RESTAURAR BACKUP');
  fd.append('modo', 'mesclar');
  fd.append('grupos', 'frota');
  const rr = await fetch(`${BASE}/api/backup/restaurar`, { method: 'POST', headers: { Origin: BASE }, body: fd });
  const corpoRestore = await rr.text();
  assert.equal(rr.status, 200, 'a restauração precisa responder 200; veio ' + rr.status + ': ' + corpoRestore.slice(0, 300));
  const voltou = (await getj('/api/locacoes/faturas')).find((f) => f.id === reg.id);
  assert.ok(voltou, 'o registro da fatura tem de voltar do backup');
  assert.equal(voltou.arquivo.id, reg.arquivo.id);
  const pdfVoltou = await fetch(`${BASE}/api/locacoes/faturas/${reg.id}/pdf`);
  assert.equal(pdfVoltou.status, 200, 'o PDF restaurado tem de ser servido de novo');
  assert.ok(Buffer.from(await pdfVoltou.arrayBuffer()).equals(original), 'o PDF restaurado tem de ser byte a byte o original');
});
