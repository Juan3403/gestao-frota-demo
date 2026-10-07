/**
 * Testes de segurança — sobem o servidor com LOGIN ATIVO (SENHA_ADMIN + SESSION_SECRET)
 * num DATA_DIR temporário, e exercitam: headers, CSRF, autenticação, autorização por aba,
 * authz de mídia (IDOR), trilha de auditoria, validação de upload e anti-fórmula no Excel.
 * Não tocam nos dados reais nem na produção. Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const PORT = 3196;
const BASE = `http://localhost:${PORT}`;
const ORIG = { Origin: BASE };
const ADMIN = { usuario: 'juan', senha: 'senha-de-teste-123' };
let srv, tmp;
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
  throw new Error('Servidor de teste (segurança) não respondeu a tempo');
}
// Captura o cookie de sessão de uma resposta de login.
function cookieDe(resp) {
  const sc = resp.headers.get('set-cookie') || '';
  const m = sc.match(/frota_auth=[^;]+/);
  return m ? m[0] : '';
}
async function login(usuario, senha) {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ usuario, senha }),
  });
  return { status: r.status, cookie: cookieDe(r), body: await r.json().catch(() => ({})) };
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-sec-'));
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
});
after(() => {
  try { srv.kill(); } catch (e) { /* já morreu */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

// USO: node --test --test-name-pattern='RV-SEG' test/security.test.js — sessão real e recorte de mídia.
test('RV-SEG: histórico exige ver Rastreadores e libera somente fotos vinculadas', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const headers = { ...ORIG, Cookie: admin.cookie, 'Content-Type': 'application/json' };
  const rast = await (await fetch(`${BASE}/api/rastreadores`, { method: 'POST', headers,
    body: JSON.stringify({ codigo: 'RV-SEG', placa: 'RVS1A23' }) })).json();
  const fotos = [];
  for (const nome of ['instalacao.png', 'privado.png']) {
    const fd = new FormData();
    fd.append('arquivo', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')], { type: 'image/png' }), nome);
    const up = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie }, body: fd });
    assert.equal(up.status, 201); fotos.push(await up.json());
  }
  assert.equal((await fetch(`${BASE}/api/instalacoes`, { method: 'POST', headers,
    body: JSON.stringify({ numeroSerie: rast.codigo, placa: rast.placa, data: '10/09/2026', fotos: [fotos[0]] }) })).status, 201);
  assert.equal((await fetch(`${BASE}/api/cadastro/solicitar`, { method: 'POST', headers: { ...ORIG, 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: 'rv-leitura', nome: 'Leitura RV', senha: 'senha1234' }) })).status, 201);
  assert.equal((await fetch(`${BASE}/api/usuarios/rv-leitura/aprovar`, { method: 'POST', headers })).status, 200);
  const comum = await login('rv-leitura', 'senha1234');
  const url = `${BASE}/api/rastreadores/${rast.id}/vinculos`;
  assert.equal((await fetch(url)).status, 401);
  assert.equal((await fetch(url, { headers: { Cookie: comum.cookie } })).status, 403);
  const usuarios = JSON.parse(fs.readFileSync(path.join(tmp, 'usuarios.json'), 'utf8')).usuarios;
  const permissoes = { ...usuarios.find(u => u.usuario === 'rv-leitura').permissoes, rastreadores: 'ver' };
  assert.equal((await fetch(`${BASE}/api/usuarios/rv-leitura/permissoes`, { method: 'POST', headers,
    body: JSON.stringify({ permissoes }) })).status, 200);
  assert.equal((await fetch(url, { headers: { Cookie: comum.cookie } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${fotos[0].id}`, { headers: { Cookie: comum.cookie } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${fotos[1].id}`, { headers: { Cookie: comum.cookie } })).status, 403);
  assert.equal((await fetch(`${BASE}/api/rastreadores/${rast.id}`, { method: 'PUT', headers: { ...headers, Cookie: comum.cookie },
    body: JSON.stringify({ ...rast, placa: 'RVS2B34' }) })).status, 403);
});

test('headers de segurança presentes', async () => {
  const r = await fetch(BASE + '/api/versao');
  assert.match(r.headers.get('content-security-policy') || '', /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.ok(r.headers.get('referrer-policy'));
});

test('API exige autenticação (401 sem cookie)', async () => {
  const r = await fetch(BASE + '/api/veiculos');
  assert.equal(r.status, 401);
});

test('mutação sem Origin/Referer é barrada (CSRF 403)', async () => {
  const r = await fetch(BASE + '/api/veiculos', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, // sem Origin
    body: JSON.stringify({ placa: 'CSRF123' }),
  });
  assert.equal(r.status, 403);
});

test('login falho retorna 401 com mensagem genérica', async () => {
  const r = await login('juan', 'senha-errada');
  assert.equal(r.status, 401);
  assert.doesNotMatch(JSON.stringify(r.body), /existe|senhaHash|stack/i);
});

test('avatar do usuário: exige sessão, sobe a foto e aparece no /api/eu', async () => {
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd1 = new FormData();
  fd1.append('foto', new Blob([png1x1], { type: 'image/png' }), 'foto.png');
  const semSessao = await fetch(BASE + '/api/eu/avatar', { method: 'POST', headers: ORIG, body: fd1 });
  assert.equal(semSessao.status, 401);

  const a = await login(ADMIN.usuario, ADMIN.senha);
  const fd2 = new FormData();
  fd2.append('foto', new Blob([png1x1], { type: 'image/png' }), 'foto.png');
  const r = await fetch(BASE + '/api/eu/avatar', { method: 'POST', headers: { cookie: a.cookie, ...ORIG }, body: fd2 });
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.match(j.avatar || '', /^data:image\/webp;base64,/, 'devolve o avatar novo como data-URL (webp: mais leve que png no mesmo tamanho)');
  const eu = await fetch(BASE + '/api/eu', { headers: { cookie: a.cookie } }).then((x) => x.json());
  assert.match(eu.avatar || '', /^data:image\/webp;base64,/, 'o /api/eu passa a devolver o avatar');
});

test('foto de perfil: fotos só para admin, fora da lista de usuários, e o DELETE apaga', async () => {
  const png1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const a = await login(ADMIN.usuario, ADMIN.senha);
  const fd = new FormData();
  fd.append('foto', new Blob([png1x1], { type: 'image/png' }), 'foto.png');
  let r = await fetch(BASE + '/api/eu/avatar', { method: 'POST', headers: { Cookie: a.cookie, ...ORIG }, body: fd });
  assert.equal(r.status, 200);

  // O painel lê as fotos por uma rota dedicada — a lista de usuários é rebuscada em todo aviso
  // em tempo real (com a aba fechada) e não pode carregar imagem junto.
  r = await fetch(BASE + '/api/usuarios/avatares', { headers: { Cookie: a.cookie } });
  assert.equal(r.status, 200);
  const { avatares } = await r.json();
  assert.match(avatares[ADMIN.usuario] || '', /^data:image\/webp;base64,/, 'a rota devolve a foto do admin');

  const lista = await fetch(BASE + '/api/usuarios', { headers: { Cookie: a.cookie } }).then((x) => x.json());
  const eu = lista.usuarios.find((u) => u.usuario === ADMIN.usuario);
  assert.equal(eu.temFoto, true, 'a lista manda o sinal de que existe foto');
  assert.equal(eu.avatar, undefined, 'a foto NÃO pode viajar na lista de usuários');

  // usuário comum não enxerga a foto de ninguém
  r = await fetch(BASE + '/api/cadastro/solicitar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ usuario: 'semfoto', nome: 'Sem Foto', senha: 'senha1234' }),
  });
  assert.equal(r.status, 201);
  r = await fetch(BASE + '/api/usuarios/semfoto/aprovar', { method: 'POST', headers: { ...ORIG, Cookie: a.cookie } });
  assert.equal(r.status, 200);
  const comum = await login('semfoto', 'senha1234');
  r = await fetch(BASE + '/api/usuarios/avatares', { headers: { Cookie: comum.cookie } });
  assert.equal(r.status, 403);

  // remover: exige sessão e apaga de verdade
  r = await fetch(BASE + '/api/eu/avatar', { method: 'DELETE', headers: ORIG });
  assert.equal(r.status, 401);
  r = await fetch(BASE + '/api/eu/avatar', { method: 'DELETE', headers: { Cookie: a.cookie, ...ORIG } });
  assert.equal(r.status, 200);
  const depois = await fetch(BASE + '/api/eu', { headers: { Cookie: a.cookie } }).then((x) => x.json());
  assert.ok(!depois.avatar, 'o /api/eu deixa de devolver a foto');
});

test('foto animada: GIF vira WebP animado, sai só pela rota binária e some com a foto', async () => {
  // GIF89a de 2 quadros (vermelho/azul, 1×1) montado à mão: é o menor arquivo que exercita o
  // caminho animado de verdade. sharp não escreve GIF animado a partir de imagem criada do zero.
  const gifAnim = Buffer.from('R0lGODlhAQABAIAAAP8AAAAA/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQAMgAAACwAAAAAAQABAAACAkQBACH5BAAyAAAALAAAAAABAAEAAAICTAEAOw==', 'base64');

  const a = await login(ADMIN.usuario, ADMIN.senha);
  const fd = new FormData();
  fd.append('foto', new Blob([gifAnim], { type: 'image/gif' }), 'perfil.gif');
  let r = await fetch(BASE + '/api/eu/avatar', { method: 'POST', headers: { Cookie: a.cookie, ...ORIG }, body: fd });
  assert.equal(r.status, 200, 'GIF é aceito no upload');
  const j = await r.json();
  assert.match(j.avatar, /^data:image\/webp;base64,/, 'o derivado parado é WebP');
  assert.ok(j.avatarV, 'devolve a versão usada para invalidar o cache');

  // Os bytes do animado NUNCA viajam em JSON: nem no /api/eu, nem na lista, nem no mapa admin.
  const eu = await fetch(BASE + '/api/eu', { headers: { Cookie: a.cookie } }).then((x) => x.json());
  assert.equal(typeof eu.avatarAnim, 'boolean', 'o /api/eu manda só o SINAL de que existe animação');
  const lista = await fetch(BASE + '/api/usuarios', { headers: { Cookie: a.cookie } }).then((x) => x.json());
  assert.equal(lista.usuarios.find((u) => u.usuario === ADMIN.usuario).avatarAnim !== undefined, true);
  assert.ok(!JSON.stringify(lista).includes('data:image/webp'), 'nenhum byte de imagem na lista de usuários');

  // A imagem sai pela rota binária, com cache imutável e privado (depende de sessão).
  const idAdmin = eu.id;
  r = await fetch(`${BASE}/api/usuarios/id/${idAdmin}/avatar.webp?v=${eu.avatarV}`, { headers: { Cookie: a.cookie } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/webp');
  assert.match(r.headers.get('cache-control') || '', /private/, 'cache não pode ser compartilhado entre pessoas');
  assert.match(r.headers.get('cache-control') || '', /immutable/);
  // Sem sessão, nada.
  assert.equal((await fetch(`${BASE}/api/usuarios/id/${idAdmin}/avatar.webp`)).status, 401);

  // Colega logado VÊ a foto (é o que permite a bolinha no Feedback e nas Últimas alterações),
  // mas continua sem poder listar todas de uma vez.
  const comum = await login('semfoto', 'senha1234');
  assert.equal((await fetch(`${BASE}/api/usuarios/id/${idAdmin}/avatar.webp`, { headers: { Cookie: comum.cookie } })).status, 200);
  assert.equal((await fetch(BASE + '/api/usuarios/avatares', { headers: { Cookie: comum.cookie } })).status, 403);
  const perfis = await fetch(BASE + '/api/usuarios/perfis', { headers: { Cookie: comum.cookie } }).then((x) => x.json());
  assert.ok(perfis.perfis.some((p) => p.id === idAdmin && p.temFoto), 'o perfil do admin aparece com o sinal de foto');
  assert.ok(!perfis.perfis.some((p) => 'usuario' in p || 'nivel' in p), 'perfis não expõem login nem nível');

  // Remover a foto leva junto a animação.
  await fetch(BASE + '/api/eu/avatar', { method: 'DELETE', headers: { Cookie: a.cookie, ...ORIG } });
  assert.equal((await fetch(`${BASE}/api/usuarios/id/${idAdmin}/avatar.webp`, { headers: { Cookie: a.cookie } })).status, 404);
});

test('aviso da foto: quem já existia não recebe, e o "já vi" fica no cadastro', async () => {
  const a = await login(ADMIN.usuario, ADMIN.senha);
  // O admin é semeado no boot, antes da marcação dos antigos: entra como quem "já usava".
  const eu = await fetch(BASE + '/api/eu', { headers: { Cookie: a.cookie } }).then((x) => x.json());
  assert.equal(eu.avisoFoto, false, 'usuário que já existia não é avisado da novidade');

  assert.equal((await fetch(BASE + '/api/eu/aviso-foto', { method: 'POST', headers: ORIG })).status, 401);
  const r = await fetch(BASE + '/api/eu/aviso-foto', { method: 'POST', headers: { Cookie: a.cookie, ...ORIG } });
  assert.equal(r.status, 200);
  const depois = await fetch(BASE + '/api/eu', { headers: { Cookie: a.cookie } }).then((x) => x.json());
  assert.equal(depois.avisoFoto, false, 'marcar como visto é idempotente');
});

test('moldura: só as do catálogo entram, e a escolha vale para quem vê o perfil', async () => {
  const a = await login(ADMIN.usuario, ADMIN.senha);
  const put = (moldura, cookie) => fetch(BASE + '/api/eu/moldura', {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...ORIG, ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ moldura }),
  });
  assert.equal((await put('coroa')).status, 401, 'sem sessão não muda moldura');
  assert.equal((await put('<script>', a.cookie)).status, 400, 'valor fora do catálogo é recusado');
  assert.equal((await put('https://exemplo.com/a.png', a.cookie)).status, 400, 'URL não é moldura');
  assert.equal((await put('coroa', a.cookie)).status, 200);

  const eu = await fetch(BASE + '/api/eu', { headers: { Cookie: a.cookie } }).then((x) => x.json());
  assert.equal(eu.moldura, 'coroa');
  const comum = await login('semfoto', 'senha1234');
  const perfis = await fetch(BASE + '/api/usuarios/perfis', { headers: { Cookie: comum.cookie } }).then((x) => x.json());
  assert.equal(perfis.perfis.find((p) => p.id === eu.id).moldura, 'coroa', 'o colega vê a moldura escolhida');

  assert.equal((await put('', a.cookie)).status, 200, 'dá para tirar a moldura');
  const semMold = await fetch(BASE + '/api/eu', { headers: { Cookie: a.cookie } }).then((x) => x.json());
  assert.equal(semMold.moldura, '');
});

test('admin loga e acessa rota protegida', async () => {
  const a = await login(ADMIN.usuario, ADMIN.senha);
  assert.equal(a.status, 200);
  assert.ok(a.cookie, 'deveria receber cookie de sessão');
  const r = await fetch(BASE + '/api/veiculos', { headers: { Cookie: a.cookie } });
  assert.equal(r.status, 200);
});

test('cookie de sessão tem formato v6 (5 campos), modo lembrar assinado e HttpOnly', async () => {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify(ADMIN),
  });
  const sc = r.headers.get('set-cookie') || '';
  assert.match(sc, /HttpOnly/i);
  const val = (sc.match(/frota_auth=([^;]+)/) || [])[1] || '';
  const partes = decodeURIComponent(val).split('~');
  assert.equal(partes.length, 5, 'cookie v6 deve ter 5 campos separados por ~');
  assert.equal(partes[3], '0', 'login sem lembrar deve assinar o modo normal');
  assert.match(partes[4], /^[a-f0-9]{64}$/, 'o último campo deve ser a assinatura HMAC');
});

test('scanner interno ignora autocomplete HTML e continua detectando segredo real', () => {
  const { scanInterno } = require('../scripts/scan-secrets');
  const dir = fs.mkdtempSync(path.join(tmp, 'scanner-'));
  const seguro = path.join(dir, 'autocomplete.js');
  const segredo = path.join(dir, 'credencial.js');
  fs.writeFileSync(seguro, "senha.autocomplete = item ? 'current-password' : 'new-password';\n");
  fs.writeFileSync(segredo, "const password = 'credencial-real-longa-123456';\n");

  assert.equal(scanInterno([seguro]).length, 0, 'autocomplete HTML não deve parecer um segredo');
  assert.equal(scanInterno([segredo]).length, 1, 'uma atribuição real de senha deve continuar bloqueada');
});

test('usuário comum NÃO acessa logs de segurança nem baixa mídia sem permissão (authz/IDOR)', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  // admin sobe uma mídia (tem permissão de mídia)
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'p.png');
  let r = await fetch(BASE + '/api/midia', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie }, body: fd });
  assert.equal(r.status, 201);
  const mid = await r.json();

  // cria e aprova um usuário comum (sem permissões — padrão 'nenhum' em tudo)
  r = await fetch(BASE + '/api/cadastro/solicitar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ usuario: 'comum1', nome: 'Usuario Comum', senha: 'senha1234' }),
  });
  assert.equal(r.status, 201);
  r = await fetch(BASE + '/api/usuarios/comum1/aprovar', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie } });
  assert.equal(r.status, 200);

  const comum = await login('comum1', 'senha1234');
  assert.equal(comum.status, 200);
  // comum não é admin → 403 nos logs de segurança
  r = await fetch(BASE + '/api/seguranca/logs', { headers: { Cookie: comum.cookie } });
  assert.equal(r.status, 403);
  // comum sem permissão de mídia → 403 ao baixar (IDOR corrigido)
  r = await fetch(BASE + `/api/midia/${mid.id}`, { headers: { Cookie: comum.cookie } });
  assert.equal(r.status, 403);

  // admin consegue ler os logs e a tentativa negada foi registrada
  r = await fetch(BASE + '/api/seguranca/logs', { headers: { Cookie: admin.cookie } });
  assert.equal(r.status, 200);
  const { logs } = await r.json();
  assert.ok(logs.some((l) => l.evento === 'acesso_negado'), 'deveria haver registro de acesso_negado');
  // nenhum log pode conter senha/cookie/secret
  assert.doesNotMatch(JSON.stringify(logs), /senha1234|frota_auth|SESSION_SECRET|senhaHash/);
});

test('excluir versão anterior de documento exige permissão de EDITAR Funcionários (403 para só-ver)', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const subir = async (nome) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), nome);
    const r = await fetch(BASE + '/api/midia', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie }, body: fd });
    assert.equal(r.status, 201);
    return r.json();
  };
  const v1 = await subir('v1.pdf');
  const v2 = await subir('v2.pdf');
  let r = await fetch(BASE + '/api/funcionarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG, Cookie: admin.cookie },
    body: JSON.stringify({
      nome: 'Versao Permissao', empresa: 'NTE',
      documentos: [{ id: v2.id, nome: 'ASO', tipo: v2.tipo, categoria: 'Segurança', semValidade: true, versoes: [{ id: v1.id, nome: 'ASO', tipo: v1.tipo, nomeOriginal: 'v1.pdf', substituidoTs: Date.now() }] }],
    }),
  });
  assert.equal(r.status, 201);
  const func = await r.json();
  const rota = BASE + `/api/funcionarios/${encodeURIComponent(func.id)}/documentos/${encodeURIComponent(v2.id)}/versoes/${encodeURIComponent(v1.id)}`;
  try {
    // usuário comum com Funcionários = 'ver' (a permissão exige uma empresa liberada)
    r = await fetch(BASE + '/api/cadastro/solicitar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
      body: JSON.stringify({ usuario: 'so-ver-func', nome: 'Só Vê Funcionários', senha: 'senha1234' }),
    });
    assert.equal(r.status, 201);
    r = await fetch(BASE + '/api/usuarios/so-ver-func/aprovar', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie } });
    assert.equal(r.status, 200);
    r = await fetch(BASE + '/api/usuarios/so-ver-func/permissoes', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG, Cookie: admin.cookie },
      body: JSON.stringify({ permissoes: { funcionarios: 'ver' }, empresasFunc: 'NTE', contratosFunc: [] }),
    });
    assert.equal(r.status, 200, JSON.stringify(await r.json().catch(() => ({}))));
    const comum = await login('so-ver-func', 'senha1234');
    assert.equal(comum.status, 200);
    // vê a ficha, mas não exclui a versão
    r = await fetch(BASE + '/api/funcionarios', { headers: { Cookie: comum.cookie } });
    assert.equal(r.status, 200);
    assert.ok((await r.json()).some(f => f.id === func.id));
    r = await fetch(rota, { method: 'DELETE', headers: { ...ORIG, Cookie: comum.cookie } });
    assert.equal(r.status, 403);
    assert.equal((await fetch(BASE + `/api/midia/${v1.id}`, { headers: { Cookie: admin.cookie } })).status, 200);
    // sem sessão → 401
    assert.equal((await fetch(rota, { method: 'DELETE', headers: { ...ORIG } })).status, 401);
    // admin consegue, e a exclusão fica nos logs de segurança
    r = await fetch(rota, { method: 'DELETE', headers: { ...ORIG, Cookie: admin.cookie } });
    assert.equal(r.status, 200);
    assert.equal((await fetch(BASE + `/api/midia/${v1.id}`, { headers: { Cookie: admin.cookie } })).status, 404);
    r = await fetch(BASE + '/api/seguranca/logs', { headers: { Cookie: admin.cookie } });
    assert.equal(r.status, 200);
    const { logs } = await r.json();
    assert.ok(logs.some((l) => l.evento === 'exclusao_versao_documento' && /v1\.pdf/.test(l.detalhes || '')), 'deveria haver registro de exclusao_versao_documento');
  } finally {
    // limpeza SEMPRE: os testes de escopo por empresa mais abaixo comparam a lista exata de nomes
    await fetch(BASE + `/api/funcionarios/${encodeURIComponent(func.id)}`, { method: 'DELETE', headers: { ...ORIG, Cookie: admin.cookie } });
  }
});

test('upload de tipo inválido é recusado (400)', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const fd = new FormData();
  fd.append('arquivo', new Blob(['<script>alert(1)</script>'], { type: 'text/html' }), 'x.html');
  const r = await fetch(BASE + '/api/midia', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie }, body: fd });
  assert.equal(r.status, 400);
});

test('upload de mídia com nome SEM extensão é aceito quando o MIME é válido (regressão dos documentos)', async () => {
  // O frontend envia documentos de funcionário com o "nome" (rótulo) sem extensão. O filtro
  // deve aceitar com base no MIME. Regressão: a validação de upload chegou a barrar isso.
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'RG sem extensao');
  const r = await fetch(BASE + '/api/midia', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie }, body: fd });
  assert.equal(r.status, 201);
});

test('upload com extensão perigosa é recusado mesmo com MIME permitido (.exe disfarçado)', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'malware.exe');
  const r = await fetch(BASE + '/api/midia', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie }, body: fd });
  assert.equal(r.status, 400);
});

test('exportação Excel neutraliza fórmulas (anti CSV-injection)', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  // cria veículo com modelo que começa com "=" (carga de fórmula)
  let r = await fetch(BASE + '/api/veiculos', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG, Cookie: admin.cookie },
    body: JSON.stringify({ placa: 'FORM123', modelo: '=HYPERLINK("http://x")' }),
  });
  assert.equal(r.status, 201);
  r = await fetch(BASE + '/api/exportar', { headers: { Cookie: admin.cookie } });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws);
  const alvo = linhas.find((l) => String(l.PLACA || l.Placa || '').toUpperCase() === 'FORM123');
  assert.ok(alvo, 'veículo exportado deveria existir');
  const modeloCol = Object.keys(alvo).find((k) => /modelo/i.test(k));
  assert.ok(String(alvo[modeloCol]).startsWith("'="), 'a fórmula deveria ter sido prefixada com aspóstrofo');
});

test('rota /api inexistente devolve JSON 404 (sem HTML/stack)', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const r = await fetch(BASE + '/api/nao-existe-xyz', { headers: { Cookie: admin.cookie } });
  assert.equal(r.status, 404);
  assert.match(r.headers.get('content-type') || '', /application\/json/);
});
test('permissão por contrato controla a visualização do Escritório Administrativo', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const criarFuncionario = async (dados) => fetch(BASE + '/api/funcionarios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG, Cookie: admin.cookie },
    body: JSON.stringify(dados),
  });
  let r = await criarFuncionario({ nome: 'Pessoa Administrativa', empresa: 'Norte Engenharia', setor: 'Escritório' });
  assert.equal(r.status, 201);
  r = await criarFuncionario({
    nome: 'Pessoa da Obra',
    empresa: 'Norte Engenharia',
    setor: 'Campo',
    contratos: [{ numero: '4600009505', nome: 'ORION', local: '' }],
  });
  assert.equal(r.status, 201);
  r = await fetch(BASE + '/api/cadastro/solicitar', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ usuario: 'escopo-func', nome: 'Escopo Funcionários', senha: 'senha1234' }),
  });
  assert.equal(r.status, 201);
  r = await fetch(BASE + '/api/usuarios/escopo-func/aprovar', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie } });
  assert.equal(r.status, 200);
  const salvarEscopo = (contratosFunc) => fetch(BASE + '/api/usuarios/escopo-func/permissoes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG, Cookie: admin.cookie },
    body: JSON.stringify({ permissoes: { funcionarios: 'ver' }, empresasFunc: 'NTE', contratosFunc }),
  });
  r = await salvarEscopo(['4600009505']);
  assert.equal(r.status, 200);
  const comum = await login('escopo-func', 'senha1234');
  assert.equal(comum.status, 200);
  const nomesVisiveis = async () => {
    const resp = await fetch(BASE + '/api/funcionarios', { headers: { Cookie: comum.cookie } });
    assert.equal(resp.status, 200);
    return (await resp.json()).map(f => f.nome);
  };
  const contratosVisiveis = async () => {
    const resp = await fetch(BASE + '/api/funcionarios/contratos', { headers: { Cookie: comum.cookie } });
    assert.equal(resp.status, 200);
    return (await resp.json()).flatMap(e => e.contratos.map(c => c.numero));
  };
  assert.deepEqual(await nomesVisiveis(), ['Pessoa da Obra']);
  assert.deepEqual(await contratosVisiveis(), ['4600009505']);
  r = await salvarEscopo(['ESCRITORIO-NTE']);
  assert.equal(r.status, 200);
  assert.deepEqual(await nomesVisiveis(), ['Pessoa Administrativa']);
  assert.deepEqual(await contratosVisiveis(), ['ESCRITORIO-NTE']);
});

test('acesso por empresa recorta a aba Admissão (lista, detalhe, ficha e criação)', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const comAdmin = (extra) => ({ 'Content-Type': 'application/json', ...ORIG, Cookie: admin.cookie, ...extra });
  const criarFunc = async (dados) => (await fetch(BASE + '/api/funcionarios', {
    method: 'POST', headers: comAdmin(), body: JSON.stringify(dados),
  })).json();
  const criarConvite = async (corpo) => (await fetch(BASE + '/api/admissao', {
    method: 'POST', headers: comAdmin(), body: JSON.stringify(corpo),
  })).json();

  const funcNte = await criarFunc({ nome: 'Candidato Efetivado NTE', empresa: 'Norte Engenharia' });
  const funcSul = await criarFunc({ nome: 'Candidato Efetivado SUL', empresa: 'SUL' });
  const cNte = (await criarConvite({ funcionarioId: funcNte.id, dias: 7 })).admissao;
  const cSul = (await criarConvite({ funcionarioId: funcSul.id, dias: 7 })).admissao;
  const cNovoSul = (await criarConvite({ nome: 'CANDIDATO NOVO SUL', empresa: 'SUL', dias: 7 })).admissao;

  // O candidato preenche o convite da SUL pelo link público (o gate é o token, não a sessão),
  // para existir uma ficha com dado sensível a ser protegida nas rotas de download.
  let r = await fetch(`${BASE}/api/admissao/publico/${cSul.token}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ resposta: { nome: 'Candidato Efetivado SUL', cpf: '529.982.247-25' } }),
  });
  assert.equal(r.status, 200);

  r = await fetch(BASE + '/api/cadastro/solicitar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ usuario: 'escopo-adm', nome: 'Escopo Admissão', senha: 'senha1234' }),
  });
  assert.equal(r.status, 201);
  r = await fetch(BASE + '/api/usuarios/escopo-adm/aprovar', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie } });
  assert.equal(r.status, 200);
  r = await fetch(BASE + '/api/usuarios/escopo-adm/permissoes', {
    method: 'POST', headers: comAdmin(),
    body: JSON.stringify({ permissoes: { admissao: 'editar', funcionarios: 'ver' }, empresasFunc: 'NTE', contratosFunc: [] }),
  });
  assert.equal(r.status, 200);
  const nteOnly = await login('escopo-adm', 'senha1234');
  assert.equal(nteOnly.status, 200);
  const comoNte = (m, ep, corpo) => fetch(BASE + ep, {
    method: m, headers: { 'Content-Type': 'application/json', ...ORIG, Cookie: nteOnly.cookie },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
  });

  // LISTA: só os convites da NTE. Os dois da SUL somem.
  const lista = (await (await comoNte('GET', '/api/admissao')).json()).admissoes;
  const ids = lista.map(a => a.id);
  assert.ok(ids.includes(cNte.id), 'o convite da própria empresa continua visível');
  assert.ok(!ids.includes(cSul.id), 'convite vinculado a colaborador de outra empresa some da lista');
  assert.ok(!ids.includes(cNovoSul.id), 'convite de candidato novo da outra empresa some da lista');

  // DETALHE e DOWNLOADS: o id direto não vale como atalho (a ficha traz CPF, endereço, bancário).
  assert.equal((await comoNte('GET', '/api/admissao/' + cSul.id)).status, 403);
  assert.equal((await comoNte('GET', `/api/admissao/${cSul.id}/ficha.pdf`)).status, 403);
  assert.equal((await comoNte('GET', `/api/admissao/${cSul.id}/documentos/zip`)).status, 403);
  assert.equal((await comoNte('GET', '/api/admissao/' + cNte.id)).status, 200, 'a própria empresa continua acessível');

  // O .zip em lote por ids também não pode servir de contorno para a lista filtrada.
  const lote = await comoNte('GET', `/api/admissao/documentos/zip-lote?ids=${cSul.id}`);
  assert.equal(lote.status, 400, 'lote de convite alheio não encontra nada para baixar');

  // ESCRITA: regerar, excluir e aplicar convite de outra empresa.
  assert.equal((await comoNte('POST', `/api/admissao/${cSul.id}/regenerar`, { dias: 7 })).status, 403);
  assert.equal((await comoNte('POST', `/api/admissao/${cSul.id}/aplicar`)).status, 403);
  assert.equal((await comoNte('DELETE', '/api/admissao/' + cSul.id)).status, 403);

  // CRIAÇÃO: nem por empresa escolhida, nem por id de colaborador fora do acesso (que devolveria
  // o nome dele na resposta).
  assert.equal((await comoNte('POST', '/api/admissao', { nome: 'ALVO SUL', empresa: 'SUL', dias: 7 })).status, 403);
  assert.equal((await comoNte('POST', '/api/admissao', { funcionarioId: funcSul.id, dias: 7 })).status, 403);
  assert.equal((await comoNte('POST', '/api/admissao', { nome: 'ALVO NTE', empresa: 'NTE', dias: 7 })).status, 201);

  // A ficha também é alcançável pela aba Funcionários — o recorte tem de valer nas duas portas.
  assert.equal((await comoNte('GET', `/api/funcionarios/${funcSul.id}/admissao`)).status, 403);
  assert.equal((await comoNte('GET', `/api/funcionarios/${funcSul.id}/admissao/ficha.pdf`)).status, 403);
  assert.equal((await comoNte('GET', `/api/funcionarios/${funcNte.id}/admissao`)).status, 200);
});

test('acesso por empresa recorta os convites de treinamento (lista, acompanhamento e reenvio)', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const comAdmin = () => ({ 'Content-Type': 'application/json', ...ORIG, Cookie: admin.cookie });
  const criarFunc = async (dados) => (await fetch(BASE + '/api/funcionarios', {
    method: 'POST', headers: comAdmin(), body: JSON.stringify(dados),
  })).json();

  const funcNte = await criarFunc({ nome: 'Treinando NTE', empresa: 'Norte Engenharia' });
  const funcSul = await criarFunc({ nome: 'Treinando SUL', empresa: 'SUL' });
  const treino = await (await fetch(BASE + '/api/treinamentos', {
    method: 'POST', headers: comAdmin(),
    body: JSON.stringify({
      titulo: 'NR-06 escopo', tipo: 'NR', fileId: '16WUfFcDSfuX1RsKvltxy7m7qGyFhUxWE',
      // `correta` é o ID da alternativa (não o índice) — id inexistente zera o gabarito e a rota recusa.
      questoes: [{ enunciado: 'O EPI é de uso individual?', alternativas: [{ id: 'a1', texto: 'Sim' }, { id: 'a2', texto: 'Não' }], correta: 'a1' }],
    }),
  })).json();
  const criarConvite = async (funcionarioId) => (await (await fetch(BASE + '/api/treinamentos/convites', {
    method: 'POST', headers: comAdmin(), body: JSON.stringify({ funcionarioId, treinamentoId: treino.id, dias: 7 }),
  })).json()).convite;
  assert.ok(treino && treino.id, 'o treinamento de teste precisa existir: ' + JSON.stringify(treino));
  const cNte = await criarConvite(funcNte.id);
  const cSul = await criarConvite(funcSul.id);
  assert.ok(cNte && cNte.id, 'convite NTE: ' + JSON.stringify(cNte));
  assert.ok(cSul && cSul.id, 'convite SUL: ' + JSON.stringify(cSul));

  let r = await fetch(BASE + '/api/cadastro/solicitar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ usuario: 'escopo-trn', nome: 'Escopo Treinamento', senha: 'senha1234' }),
  });
  assert.equal(r.status, 201);
  assert.equal((await fetch(BASE + '/api/usuarios/escopo-trn/aprovar', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie } })).status, 200);
  r = await fetch(BASE + '/api/usuarios/escopo-trn/permissoes', {
    method: 'POST', headers: comAdmin(),
    body: JSON.stringify({ permissoes: { integracao: 'editar', funcionarios: 'ver' }, empresasFunc: 'NTE', contratosFunc: [] }),
  });
  assert.equal(r.status, 200);
  const nteOnly = await login('escopo-trn', 'senha1234');
  assert.equal(nteOnly.status, 200);
  const comoNte = (metodo, rota, corpo) => fetch(BASE + rota, {
    method: metodo, headers: { 'Content-Type': 'application/json', ...ORIG, Cookie: nteOnly.cookie },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });

  // LISTAGEM: o token do convite abre a prova em nome do colaborador — não pode vazar entre empresas.
  const convites = (await (await comoNte('GET', '/api/treinamentos/convites')).json()).convites;
  assert.deepEqual(convites.map(c => c.nome), ['Treinando NTE'], 'a lista de convites tem de trazer só a empresa liberada');
  assert.equal(convites.some(c => c.token === cSul.token), false, 'o token do convite alheio não pode aparecer');

  // ACOMPANHAMENTO: mesma lista, com nome, token e o CPF usado no acesso.
  const itens = (await (await comoNte('GET', '/api/treinamentos/acompanhamento')).json()).itens;
  assert.deepEqual(itens.map(i => i.nome), ['Treinando NTE']);

  // O filtro por treinamento não pode servir de contorno para alcançar a outra empresa.
  const porTreino = (await (await comoNte('GET', '/api/treinamentos/convites?treinamentoId=' + treino.id)).json()).convites;
  assert.deepEqual(porTreino.map(c => c.nome), ['Treinando NTE']);

  // ESCRITA: reenviar (novo token e prazo) convite de colaborador fora do acesso.
  assert.equal((await comoNte('POST', `/api/treinamentos/convites/${cSul.id}/regenerar`, { dias: 7 })).status, 403);
  assert.equal((await comoNte('POST', `/api/treinamentos/convites/${cNte.id}/regenerar`, { dias: 7 })).status, 200);
});

// USO: node --test --test-name-pattern='TRN-SEG' test/security.test.js — excluir/novo link/liberar prova
// respeitam o recorte por empresa (tudo ou nada) e a permissão de EDITAR a Integração.
test('TRN-SEG: excluir, excluir-lote, lote, regenerar e liberar-prova respeitam empresa e permissão', async () => {
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const comAdmin = () => ({ 'Content-Type': 'application/json', ...ORIG, Cookie: admin.cookie });
  const criarFunc = async (dados) => (await fetch(BASE + '/api/funcionarios', {
    method: 'POST', headers: comAdmin(), body: JSON.stringify(dados),
  })).json();
  const treino = await (await fetch(BASE + '/api/treinamentos', {
    method: 'POST', headers: comAdmin(),
    body: JSON.stringify({
      titulo: 'NR-35 exclusão escopo', tipo: 'NR', fileId: '16WUfFcDSfuX1RsKvltxy7m7qGyFhUxWE',
      questoes: [{ enunciado: 'Cinto é obrigatório?', alternativas: [{ id: 'a1', texto: 'Sim' }, { id: 'a2', texto: 'Não' }], correta: 'a1' }],
    }),
  })).json();
  assert.ok(treino && treino.id, 'treinamento de teste: ' + JSON.stringify(treino));
  const criarConvite = async (funcionarioId) => (await (await fetch(BASE + '/api/treinamentos/convites', {
    method: 'POST', headers: comAdmin(), body: JSON.stringify({ funcionarioId, treinamentoId: treino.id, dias: 7 }),
  })).json()).convite;
  const funcNte = await criarFunc({ nome: 'Excluir NTE', empresa: 'Norte Engenharia' });
  const funcNte2 = await criarFunc({ nome: 'Excluir NTE Dois', empresa: 'Norte Engenharia' });
  const funcSul = await criarFunc({ nome: 'Excluir SUL', empresa: 'SUL' });
  const cNte = await criarConvite(funcNte.id), cNte2 = await criarConvite(funcNte2.id), cSul = await criarConvite(funcSul.id);
  assert.ok(cNte && cNte2 && cSul, 'convites de teste criados');

  const criarUsuario = async (usuario, permissoes, empresasFunc) => {
    let r = await fetch(BASE + '/api/cadastro/solicitar', {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
      body: JSON.stringify({ usuario, nome: 'Usuário ' + usuario, senha: 'senha1234' }),
    });
    assert.equal(r.status, 201);
    assert.equal((await fetch(`${BASE}/api/usuarios/${usuario}/aprovar`, { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie } })).status, 200);
    r = await fetch(`${BASE}/api/usuarios/${usuario}/permissoes`, {
      method: 'POST', headers: comAdmin(), body: JSON.stringify({ permissoes, empresasFunc, contratosFunc: [] }),
    });
    assert.equal(r.status, 200);
    const s = await login(usuario, 'senha1234');
    assert.equal(s.status, 200);
    return (metodo, rota, corpo) => fetch(BASE + rota, {
      method: metodo, headers: { 'Content-Type': 'application/json', ...ORIG, Cookie: s.cookie },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
  };
  const comoNte = await criarUsuario('excluir-trn-nte', { integracao: 'editar', funcionarios: 'ver' }, 'NTE');
  const comoLeitura = await criarUsuario('excluir-trn-ver', { integracao: 'ver', funcionarios: 'ver' }, 'NTE');
  const idsNoAcompanhamento = async () => new Set((await (await fetch(BASE + '/api/treinamentos/acompanhamento?treinamentoId=' + treino.id, { headers: comAdmin() })).json()).itens.map(i => i.id));

  // Outra empresa: 403 e nada apagado — nem o convite alheio, nem o próprio que veio no mesmo lote.
  assert.equal((await comoNte('DELETE', `/api/treinamentos/convites/${cSul.id}`)).status, 403);
  assert.equal((await comoNte('POST', '/api/treinamentos/convites/excluir-lote', { ids: [cNte2.id, cSul.id] })).status, 403);
  let ids = await idsNoAcompanhamento();
  assert.ok(ids.has(cSul.id) && ids.has(cNte2.id), 'o 403 do lote não apaga nenhum');
  assert.equal((await fetch(`${BASE}/api/treinamentos/publico/${cSul.token}`)).status, 200, 'link alheio continua abrindo');
  assert.equal((await comoNte('POST', `/api/treinamentos/convites/${cSul.id}/liberar-prova`, {})).status, 403);

  // Lote com funcionário de outra empresa (que JÁ tem link ativo): ignorado sem convite nem token.
  const lote = await (await comoNte('POST', '/api/treinamentos/convites/lote', { treinamentoId: treino.id, funcionarioIds: [funcSul.id, funcNte.id] })).json();
  const igSul = lote.ignorados.find(i => i.funcionarioId === funcSul.id);
  assert.equal(igSul.motivo, 'sem acesso à empresa');
  assert.equal(igSul.convite, undefined, 'fora do recorte nunca leva o convite');
  assert.equal(JSON.stringify(lote).includes(cSul.token), false, 'o token alheio não vaza no lote');
  const igNte = lote.ignorados.find(i => i.funcionarioId === funcNte.id);
  assert.equal(igNte.motivo, 'já tem link ativo');
  assert.equal(igNte.convite.token, cNte.token, 'o próprio link ativo volta para reenvio');

  // Só-leitura na Integração: nenhuma escrita passa.
  assert.equal((await comoLeitura('DELETE', `/api/treinamentos/convites/${cNte.id}`)).status, 403);
  assert.equal((await comoLeitura('POST', '/api/treinamentos/convites/excluir-lote', { ids: [cNte.id] })).status, 403);
  assert.equal((await comoLeitura('POST', `/api/treinamentos/convites/${cNte.id}/regenerar`, {})).status, 403);
  assert.equal((await comoLeitura('POST', `/api/treinamentos/convites/${cNte.id}/liberar-prova`, {})).status, 403);
  ids = await idsNoAcompanhamento();
  assert.ok(ids.has(cNte.id), 'só-leitura não apagou nada');

  // Exportar o Acompanhamento (só lê): quem só vê pode, mas a planilha respeita o recorte por
  // empresa: pedir o id de um convite da outra empresa não traz a linha dela.
  const rx = await comoLeitura('POST', '/api/treinamentos/acompanhamento/exportar', { ids: [cNte.id, cSul.id] });
  assert.equal(rx.status, 200);
  const XLSX_SEG = require('xlsx');
  const wbx = XLSX_SEG.read(Buffer.from(await rx.arrayBuffer()), { type: 'buffer' });
  const nomesExportados = XLSX_SEG.utils.sheet_to_json(wbx.Sheets[wbx.SheetNames[0]], { defval: '' }).map(l => l['FUNCIONÁRIO']);
  assert.deepEqual(nomesExportados, ['Excluir NTE'], 'a linha da outra empresa não sai na planilha');

  // Controle positivo: o usuário da NTE exclui o convite da própria empresa.
  const ok = await comoNte('DELETE', `/api/treinamentos/convites/${cNte.id}`);
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).excluidos, 1);
  ids = await idsNoAcompanhamento();
  assert.ok(!ids.has(cNte.id) && ids.has(cSul.id) && ids.has(cNte2.id));
});

// USO: node --test --test-name-pattern='MUL-TERMO-SEG' test/security.test.js — o termo da multa
// (dados pessoais do condutor) respeita o recorte por empresa e a permissão de EDITAR Multas.
test('MUL-TERMO-SEG: gerar termo exige editar Multas e respeita a empresa do condutor', async () => {
  const PizZip = require('pizzip');
  const admin = await login(ADMIN.usuario, ADMIN.senha);
  const comAdmin = () => ({ 'Content-Type': 'application/json', ...ORIG, Cookie: admin.cookie });
  const postAdmin = async (rota, corpo) => (await fetch(BASE + rota, { method: 'POST', headers: comAdmin(), body: JSON.stringify(corpo) })).json();
  const fNte = await postAdmin('/api/funcionarios', { nome: 'Termo NTE', empresa: 'Norte Engenharia', cpf: '52998224725' });
  const fSul = await postAdmin('/api/funcionarios', { nome: 'Termo SUL', empresa: 'SUL', cpf: '11144477735' });
  const multa = await postAdmin('/api/multas', { placa: 'SEG1T23', autoInfracao: 'A123' });
  const z = new PizZip();
  z.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');
  z.file('_rels/.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  z.file('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>{{NOME_COLABORADOR}} {{CPF}}</w:t></w:r></w:p></w:body></w:document>');
  const fd = new FormData();
  fd.append('tipo', 'modelo');
  fd.append('arquivo', new Blob([z.generate({ type: 'nodebuffer' })], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), 'm.docx');
  const arq = await (await fetch(BASE + '/api/termos-multas/midia', { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie }, body: fd })).json();
  const modelo = await postAdmin('/api/termos-multas', { tipo: 'modelo', titulo: 'Seg termo', arquivo: arq });
  assert.ok(multa.id && modelo.id && fNte.id && fSul.id, 'dados de teste criados');

  // Reaproveita os usuários do TRN-SEG quando já existem: o cadastro público tem limite por IP
  // (429) e a suíte inteira já o consome. Rodando este teste sozinho, cria do zero.
  const criarUsuario = async (usuario, permissoes, empresasFunc) => {
    let s0 = await login(usuario, 'senha1234');
    if (s0.status !== 200) {
      const rc = await fetch(BASE + '/api/cadastro/solicitar', { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ usuario, nome: 'Usuário ' + usuario, senha: 'senha1234' }) });
      assert.equal(rc.status, 201);
      assert.equal((await fetch(`${BASE}/api/usuarios/${usuario}/aprovar`, { method: 'POST', headers: { ...ORIG, Cookie: admin.cookie } })).status, 200);
    }
    let r = await fetch(`${BASE}/api/usuarios/${usuario}/permissoes`, { method: 'POST', headers: comAdmin(), body: JSON.stringify({ permissoes, empresasFunc, contratosFunc: [] }) });
    assert.equal(r.status, 200);
    const s = await login(usuario, 'senha1234');
    return (metodo, rota, corpo) => fetch(BASE + rota, { method: metodo, headers: { 'Content-Type': 'application/json', ...ORIG, Cookie: s.cookie }, body: corpo === undefined ? undefined : JSON.stringify(corpo) });
  };
  const comoNte = await criarUsuario('excluir-trn-nte', { multas: 'editar' }, 'NTE');
  const comoLeitura = await criarUsuario('excluir-trn-ver', { multas: 'ver' }, 'NTE');

  // Só-leitura em Multas: nada do termo passa (nem a lista de condutores).
  assert.equal((await comoLeitura('GET', `/api/multas/${multa.id}/termo/opcoes`)).status, 403);
  assert.equal((await comoLeitura('POST', `/api/multas/${multa.id}/termo`, { modeloId: modelo.id, funcionarioId: fNte.id })).status, 403);
  // Outra empresa: a lista não traz o funcionário, e prévia/gerar com o id dele dão 403 sem vazar o CPF.
  const op = await (await comoNte('GET', `/api/multas/${multa.id}/termo/opcoes`)).json();
  assert.ok(op.candidatos.some(c => c.id === fNte.id) && !op.candidatos.some(c => c.id === fSul.id));
  for (const rota of [`/api/multas/${multa.id}/termo/previa`, `/api/multas/${multa.id}/termo`]) {
    const r = await comoNte('POST', rota, { modeloId: modelo.id, funcionarioId: fSul.id });
    assert.equal(r.status, 403, rota);
    assert.ok(!(await r.text()).includes('111.444.777-35'));
  }
  // Controle positivo + trilha sem CPF.
  const r = await comoNte('POST', `/api/multas/${multa.id}/termo`, { modeloId: modelo.id, funcionarioId: fNte.id });
  assert.equal(r.status, 200);
  const { logs } = await (await fetch(BASE + '/api/seguranca/logs', { headers: { Cookie: admin.cookie } })).json();
  const ev = logs.find(l => l.evento === 'termo_multa_gerado');
  assert.ok(ev, 'evento termo_multa_gerado registrado');
  assert.ok(!JSON.stringify(ev).includes('52998224725') && !JSON.stringify(ev).includes('529.982.247-25'), 'o log não leva o CPF');
});
