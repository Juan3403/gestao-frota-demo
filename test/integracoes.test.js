/**
 * Testes da API de integração (sistema a sistema) — sobem o servidor com LOGIN ATIVO num
 * DATA_DIR temporário e exercitam o caminho inteiro: emitir credencial (admin), consumir o
 * snapshot de colaboradores com o token, ETag/304, recorte por empresa e revogação.
 * O teste que mais importa é o NEGATIVO: nenhum campo fora da allowlist pode sair.
 * Não tocam nos dados reais nem na produção. Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3203;
const BASE = `http://localhost:${PORT}`;
const ORIG = { Origin: BASE };
const ADMIN = { usuario: 'juan', senha: 'senha-de-teste-123' };
const API = BASE + '/api/integracoes/v1/funcionarios';
let srv, tmp, cookie;
// Estado do processo filho: sem isto, um servidor que morre no boot (EADDRINUSE, variável de
// ambiente faltando...) some em silêncio — o spawn descartava o stderr e ninguém olhava o código
// de saída, então a suíte seguia contra o servidor alheio já de pé na porta.
let srvSaida = null; // código (ou sinal) com que o filho morreu, se morreu
let srvLog = '';     // stderr do filho, para a mensagem de erro dizer o motivo

async function esperar(ms = 30000) {
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
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de teste (integrações) não respondeu a tempo');
}
function cookieDe(resp) {
  const m = (resp.headers.get('set-cookie') || '').match(/frota_auth=[^;]+/);
  return m ? m[0] : '';
}
const comSessao = (extra = {}) => ({ 'Content-Type': 'application/json', Cookie: cookie, ...ORIG, ...extra });
const comToken = (token, extra = {}) => ({ Authorization: `Bearer ${token}`, ...extra });

async function emitirCredencial(corpo) {
  const r = await fetch(BASE + '/api/seguranca/integracoes', {
    method: 'POST', headers: comSessao(), body: JSON.stringify(corpo || {}),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-itg-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, DATA_DIR: tmp, PORT: String(PORT), MONGODB_URI: '',
      SENHA_ADMIN: ADMIN.senha, SESSION_SECRET: 'segredo-de-teste-bem-longo-1234567890', // gitleaks:allow (segredo fictício do servidor de teste)
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  // Só o stderr é canalizado: o stdout do servidor é o banner e a telemetria de memória, ruído
  // puro aqui. E um cano que ninguém drena enche e trava o filho — por isso os dois listeners.
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.on('exit', (codigo, sinal) => { srvSaida = codigo === null ? `sinal ${sinal}` : codigo; });
  await esperar();
  const login = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify(ADMIN),
  });
  cookie = cookieDe(login);
  assert.ok(cookie, 'login do admin de teste falhou');
  // Dois colaboradores com dado sensível preenchido — é o que o DTO tem que deixar de fora.
  const base = {
    rg: '1234567', nascimento: '1990-05-10', telefone: '(83) 99999-0000',
    email: 'pessoa@exemplo.com', endereco: 'Rua A, 100', cidade: 'Campina Grande', uf: 'PB',
    salarios: [{ desde: '2026-01', valor: 3500 }], cnhNumero: '01234567890', obs: 'observação interna',
  };
  for (const f of [
    { ...base, cpf: '529.982.247-25', nome: 'Ana Teste', cargo: 'Pedreiro', empresa: 'Norte Engenharia', matricula: '0451', status: 'Ativo', contratoNumero: '12345' },
    { ...base, cpf: '111.444.777-35', nome: 'Bruno Teste', cargo: 'Eletricista', empresa: 'Sul Empreendimentos', status: 'Desligado', dataDemissao: '2026-07-31', motivoDemissao: 'pedido' },
  ]) {
    const r = await fetch(BASE + '/api/funcionarios', { method: 'POST', headers: comSessao(), body: JSON.stringify(f) });
    assert.equal(r.status, 201, 'não consegui semear o colaborador de teste');
  }
});
after(() => {
  try { srv.kill(); } catch (e) { /* já morreu */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

test('sem credencial: 401 (o gate de login não vale aqui, quem manda é o token)', async () => {
  const r = await fetch(API);
  assert.equal(r.status, 401);
  const b = await r.json();
  assert.match(b.erro, /credencial/i);
});

test('credencial malformada ou desconhecida: 401 sem pista do motivo', async () => {
  for (const t of ['abacaxi', 'gdj_itg_naoehhex.segredo', 'gdj_itg_aaaaaaaaaaaa.segredo-errado']) {
    const r = await fetch(API, { headers: comToken(t) });
    assert.equal(r.status, 401, `token "${t}" deveria ser recusado`);
    const b = await r.json();
    assert.doesNotMatch(JSON.stringify(b), /hash|tokens|stack/i);
  }
});

test('emitir credencial exige admin (sem sessão: 401)', async () => {
  const r = await fetch(BASE + '/api/seguranca/integracoes', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: '{}',
  });
  assert.equal(r.status, 401);
});

test('escopo desconhecido é recusado na emissão', async () => {
  const r = await emitirCredencial({ nome: 'Escopo inválido', escopos: ['funcionarios:apagar'] });
  assert.equal(r.status, 400);
});

test('snapshot: só os campos da allowlist, com desligado incluído', async () => {
  const e = await emitirCredencial({ nome: 'Estoque RM (teste)' });
  assert.equal(e.status, 201);
  assert.match(e.body.token, /^gdj_itg_[a-f0-9]{12}\./);
  assert.ok(!JSON.stringify(e.body.credencial).includes('hash'), 'a resposta não pode devolver o hash');

  const r = await fetch(API, { headers: comToken(e.body.token) });
  assert.equal(r.status, 200);
  const b = await r.json();
  assert.equal(b.schemaVersion, 1);
  assert.equal(b.total, b.funcionarios.length);
  assert.equal(b.total, 2, 'o snapshot traz TODOS os status, inclusive o desligado');

  const campos = ['id', 'nome', 'matricula', 'cargo', 'empresa', 'status', 'ativo'];
  for (const p of b.funcionarios) {
    assert.deepEqual(Object.keys(p).sort(), [...campos].sort(), 'apareceu campo fora da allowlist');
  }
  // Rede de segurança: nenhum dado sensível pode aparecer no corpo, em campo nenhum.
  const cru = JSON.stringify(b);
  for (const proibido of ['529.982.247-25', '111.444.777-35', '1234567', '1990-05-10', '99999-0000', 'pessoa@exemplo.com', 'Rua A, 100', '3500', '01234567890', 'observação interna']) {
    assert.ok(!cru.includes(proibido), `vazou dado sensível: ${proibido}`);
  }
  const ana = b.funcionarios.find(p => p.nome === 'Ana Teste');
  assert.equal(ana.empresa, 'NTE', 'a empresa tem que sair canonizada em sigla');
  assert.equal(ana.ativo, true);
  const bruno = b.funcionarios.find(p => p.nome === 'Bruno Teste');
  assert.equal(bruno.status, 'Desligado');
  assert.equal(bruno.ativo, false);
});

test('ETag: a segunda chamada com If-None-Match responde 304 sem corpo', async () => {
  const e = await emitirCredencial({ nome: 'ETag (teste)' });
  const r1 = await fetch(API, { headers: comToken(e.body.token) });
  const etag = r1.headers.get('etag');
  assert.ok(etag, 'faltou o ETag');
  const r2 = await fetch(API, { headers: comToken(e.body.token, { 'If-None-Match': etag }) });
  assert.equal(r2.status, 304);
  assert.equal((await r2.text()).length, 0);
});

test('recorte por empresa: credencial da SUL não vê a NTE, e sem empresa não some ninguém', async () => {
  const e = await emitirCredencial({ nome: 'Só SUL (teste)', empresas: ['SUL'] });
  const r = await fetch(API, { headers: comToken(e.body.token) });
  const b = await r.json();
  assert.equal(b.total, 1);
  assert.equal(b.funcionarios[0].empresa, 'SUL');
});

test('revogar corta o acesso na hora, sem reiniciar o servidor', async () => {
  const e = await emitirCredencial({ nome: 'Para revogar (teste)' });
  const antes = await fetch(API, { headers: comToken(e.body.token) });
  assert.equal(antes.status, 200);

  const del = await fetch(BASE + '/api/seguranca/integracoes/' + e.body.credencial.id, { method: 'DELETE', headers: comSessao() });
  assert.equal(del.status, 200);

  const depois = await fetch(API, { headers: comToken(e.body.token) });
  assert.equal(depois.status, 401);
  assert.match((await depois.json()).erro, /revogada/i);
});

test('a rota aparece no inventário de Segurança com o guard de token', async () => {
  const r = await fetch(BASE + '/api/seguranca/endpoints', { headers: { Cookie: cookie } });
  const b = await r.json();
  const rota = b.rotas.find(x => x.path === '/api/integracoes/v1/funcionarios');
  assert.ok(rota, 'a rota da integração sumiu do inventário');
  assert.equal(rota.guard, 'token:funcionarios:ler');
  assert.equal(rota.anonima, false);
  const verificar = b.rotas.find(x => x.path === '/api/verificar/:codigo');
  assert.ok(verificar && verificar.anonima, 'a conferência pública deve constar como pública');
});

// ---------- Backup por máquina (rotina agendada que leva o .zip para fora) ----------
const API_BACKUP = BASE + '/api/integracoes/backup/v1/gerar';

test('token emitido SEM escopo explícito não ganha o backup (privilégio mínimo)', async () => {
  // O padrão de emissão já foi "todos os escopos do catálogo": acrescentar um escopo novo
  // ampliava, retroativamente, toda credencial emitida sem especificar — a do Estoque RM
  // passaria a poder baixar o sistema inteiro só porque a rota de backup passou a existir.
  const { status, body } = await emitirCredencial({ nome: 'Sem escopo declarado' });
  assert.equal(status, 201);
  assert.deepEqual(body.credencial.escopos, ['funcionarios:ler'], 'o padrão tem de ser o mínimo, nunca o catálogo inteiro');

  const r = await fetch(API_BACKUP, { headers: comToken(body.token) });
  assert.equal(r.status, 403, 'sem o escopo backup:gerar a credencial não pode baixar o backup');
});

test('backup por máquina: fail-closed sem credencial e escopo insuficiente', async () => {
  assert.equal((await fetch(API_BACKUP)).status, 401, 'sem Authorization tem de recusar');
  assert.equal((await fetch(API_BACKUP, { headers: comToken('gdj_itg_aaaaaaaaaaaa.qualquer') })).status, 401, 'id desconhecido tem de recusar');

  // Credencial de backup NÃO pode ler colaboradores: os escopos são independentes nos dois sentidos.
  const { body } = await emitirCredencial({ nome: 'Backup nuvem', escopos: ['backup:gerar'] });
  const rf = await fetch(API, { headers: comToken(body.token) });
  assert.equal(rf.status, 403, 'a credencial de backup não pode acessar a lista de colaboradores');
});

test('backup por máquina: com o escopo certo devolve o .zip e registra no histórico', async () => {
  const { body } = await emitirCredencial({ nome: 'Backup agendado', escopos: ['backup:gerar'] });
  const r = await fetch(API_BACKUP + '?anexos=0', { headers: comToken(body.token) });
  assert.equal(r.status, 200, 'com o escopo certo tem de gerar');
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 2).toString('latin1'), 'PK', 'a resposta tem de ser um .zip de verdade');
  const texto = buf.toString('latin1');
  assert.ok(texto.includes('manifest.json'), 'o .zip precisa do manifest');
  assert.ok(texto.includes('funcionarios.json'), 'o .zip precisa dos módulos de dados');

  // O backup automático precisa contar como backup: senão o card do Início segue dizendo
  // "nenhum backup foi gerado ainda" enquanto a rotina roda todo dia.
  const hist = await (await fetch(BASE + '/api/backup/historico', { headers: { Cookie: cookie } })).json();
  const ultimo = (hist.itens || hist)[0];
  assert.equal(ultimo.tipo, 'geração');
  assert.equal(ultimo.usuario, 'integração: Backup agendado', 'o histórico tem de identificar a credencial que gerou');
});
