/**
 * Ações de Segurança (SST) — status derivado (regra única), validações de data,
 * auditoria (criadoPor/atualizadoPor/realizadoPor + histórico), evidências no cofre
 * (sobrevivem à faxina de órfãs, morrem quando saem do registro), backup/restauração
 * ponta a ponta e permissões (ver ≠ editar; aba nova nasce trancada).
 * Sobe o servidor real num DATA_DIR temporário, com LOGIN ATIVO (SENHA_ADMIN) para
 * exercitar os gates de permissão de verdade.
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PORT = 3207; // faixa de test/ é 3196-3209 (ver test/portas.test.js)
const BASE = `http://localhost:${PORT}`;
const ORIG = { Origin: BASE };
const ADMIN = { usuario: 'juan', senha: 'senha-de-teste-123' };
let srv, tmp;
let srvSaida = null, srvLog = '';
let adminCookie = '';

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
const hdr = (cookie) => ({ ...ORIG, 'Content-Type': 'application/json', Cookie: cookie || adminCookie });
const post = (rota, corpo, cookie) => fetch(BASE + rota, { method: 'POST', headers: hdr(cookie), body: JSON.stringify(corpo || {}) });
const put = (rota, corpo, cookie) => fetch(BASE + rota, { method: 'PUT', headers: hdr(cookie), body: JSON.stringify(corpo || {}) });
const del = (rota, cookie) => fetch(BASE + rota, { method: 'DELETE', headers: { ...ORIG, Cookie: cookie || adminCookie } });
const getj = async (rota, cookie) => (await fetch(BASE + rota, { headers: { Cookie: cookie || adminCookie }, cache: 'no-store' })).json();

// PNG 1x1 de verdade — o cofre confere os magic bytes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
async function subirEvidencia(nome = 'evid.png', cookie) {
  const fd = new FormData();
  fd.append('arquivo', new Blob([PNG], { type: 'image/png' }), nome);
  const r = await fetch(BASE + '/api/midia', { method: 'POST', headers: { ...ORIG, Cookie: cookie || adminCookie }, body: fd });
  assert.equal(r.status, 201, 'upload de mídia deve responder 201');
  return r.json();
}
// Referência de evidência no formato do registro (mesmo dos anexos de multa).
const refEvid = (m, extra) => ({ id: m.id, nome: m.nome || 'Evidência', tipo: m.tipo || 'image/png', categoria: 'Foto', uploadTs: Date.now(), uploadPor: 'teste', versoes: [], ...(extra || {}) });
// Envelhece a mídia no disco: a faxina tem carência de 1h e nunca apaga upload recente —
// sem isto o teste de sobrevivência seria vácuo (mesma nota do VST-6b em modulos.test.js).
function envelhecerMidia(id) {
  const arq = path.join(tmp, 'uploads', `${id}.json`);
  const bruto = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  fs.writeFileSync(arq, JSON.stringify({ ...bruto, ts: Date.now() - 2 * 60 * 60 * 1000 }));
}
// Datas relativas a HOJE (fuso local do servidor de teste) — os cenários não apodrecem.
const p2 = (n) => String(n).padStart(2, '0');
function isoDia(deltaDias) {
  const d = new Date(); d.setDate(d.getDate() + deltaDias);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
}
const mesDe = (iso) => iso.slice(0, 7);
function mesDelta(deltaMeses) {
  const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() + deltaMeses);
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}
const baseAcao = (extra) => ({ titulo: 'Ação de teste', tipo: 'DDS', responsavel: 'João Silva', mesRef: mesDe(isoDia(0)), ...(extra || {}) });

async function esperarServidor(ms = 30000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (srvSaida !== null) {
      throw new Error(`O servidor de teste (porta ${PORT}) morreu com código ${srvSaida} antes de responder.`
        + (srvLog ? `\n--- stderr ---\n${srvLog.slice(-2000)}` : ''));
    }
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de teste (ações SST) não respondeu a tempo');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-acoes-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env, DATA_DIR: tmp, PORT: String(PORT), MONGODB_URI: '',
      SENHA_ADMIN: ADMIN.senha, SESSION_SECRET: 'segredo-de-teste-bem-longo-1234567890', // gitleaks:allow (segredo fictício do servidor de teste)
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.on('exit', (codigo, sinal) => { srvSaida = codigo === null ? `sinal ${sinal}` : codigo; });
  await esperarServidor();
  const a = await login(ADMIN.usuario, ADMIN.senha);
  assert.equal(a.status, 200, 'login do admin de teste precisa funcionar');
  adminCookie = a.cookie;
});
after(() => {
  try { srv.kill(); } catch (e) { /* já morreu */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

test('AS-1: status é derivado (nunca gravado) e segue a tabela de decisão', async () => {
  // Cada caso da tabela do plano: [payload, status esperado]
  const casos = [
    [baseAcao({ mesRef: mesDelta(2), prazo: '' }), 'Programada', 'mês futuro'],
    [baseAcao({ prazo: isoDia(20) }), 'Programada', 'mês atual, prazo distante'],
    [baseAcao({ prazo: isoDia(3) }), 'Em andamento', 'perto do vencimento (≤7 dias)'],
    [baseAcao({ prazo: isoDia(0) }), 'Em andamento', 'no dia do prazo'],
    [baseAcao({ mesRef: mesDe(isoDia(-40)), prazo: isoDia(-5) }), 'Atrasada', 'prazo vencido'],
    [baseAcao({ mesRef: mesDelta(-2), prazo: '' }), 'Atrasada', 'sem prazo, mês passado (vale o fim do mês)'],
    [baseAcao({ mesRef: mesDe(isoDia(-10)), prazo: isoDia(-10), dataRealizacao: isoDia(-9) }), 'Realizada', 'realizada mesmo com prazo vencido'],
    [baseAcao({ prazo: isoDia(-2), dataRealizacao: isoDia(-1), cancelada: true }), 'Cancelada', 'cancelada ganha de tudo'],
  ];
  for (const [payload, esperado, rotulo] of casos) {
    const r = await post('/api/acoes-sst', payload);
    assert.equal(r.status, 201, `criação deve aceitar o caso "${rotulo}"`);
    const a = await r.json();
    assert.equal(a.status, esperado, `caso "${rotulo}"`);
    await del('/api/acoes-sst/' + a.id);
  }
  // `status` forjado no body é ignorado — o derivado é quem responde.
  const r = await post('/api/acoes-sst', baseAcao({ prazo: isoDia(20), status: 'Cancelada' }));
  const a = await r.json();
  assert.equal(a.status, 'Programada', 'status vindo do cliente não pode ser gravado');
  const bruto = JSON.parse(fs.readFileSync(path.join(tmp, 'acoes_sst.json'), 'utf-8'));
  assert.equal(bruto.acoes.find((x) => x.id === a.id).status, undefined, 'o arquivo não guarda status');
  await del('/api/acoes-sst/' + a.id);
});

test('AS-2: validações — obrigatórios e datas inválidas respondem 400', async () => {
  assert.equal((await post('/api/acoes-sst', { ...baseAcao(), mesRef: '' })).status, 400, 'sem mesRef');
  assert.equal((await post('/api/acoes-sst', { ...baseAcao(), titulo: '' })).status, 400, 'sem título');
  assert.equal((await post('/api/acoes-sst', { ...baseAcao(), responsavel: '' })).status, 400, 'sem responsável');
  for (const mesRuim of ['2026-00', '2026-13', 'abcd-01']) {
    assert.equal((await post('/api/acoes-sst', baseAcao({ mesRef: mesRuim }))).status, 400, `mesRef inválido: ${mesRuim}`);
  }
  assert.equal((await post('/api/acoes-sst', baseAcao({ prazo: '2026-02-30' }))).status, 400, 'prazo que não existe');
  assert.equal((await post('/api/acoes-sst', baseAcao({ prazo: '30/08/2026' }))).status, 400, 'prazo fora do formato ISO');
  const rFut = await post('/api/acoes-sst', baseAcao({ dataRealizacao: isoDia(2) }));
  assert.equal(rFut.status, 400, 'realização futura é recusada');
  assert.match((await rFut.json()).erro, /futura/i);
});

test('AS-3: auditoria — criadoPor/atualizadoPor/realizadoPor + histórico com antes→depois', async () => {
  const r = await post('/api/acoes-sst', baseAcao({ titulo: 'DDS NR-35', responsavel: 'João Silva', prazo: isoDia(10), criadoPor: 'forjado' }));
  const a = await r.json();
  // quemFez() devolve o NOME de exibição do usuário logado (ex.: 'Juan'), nunca o body forjado.
  assert.match(a.criadoPor, new RegExp(ADMIN.usuario, 'i'), 'criadoPor vem da sessão, nunca do body');
  assert.equal(a.atualizadoPor, '');
  // Troca de responsável → histórico com antes→depois.
  let atual = await put('/api/acoes-sst/' + a.id, { ...a, responsavel: 'Maria Souza' }).then((x) => x.json());
  assert.equal(atual.criadoPor, a.criadoPor, 'PUT preserva o criadoPor');
  assert.match(atual.atualizadoPor, new RegExp(ADMIN.usuario, 'i'));
  const hist1 = await getj('/api/historico');
  assert.ok(hist1.some((h) => /Ação SST "DDS NR-35".*Responsável: João Silva → Maria Souza/.test(h.texto || '')),
    'histórico precisa registrar responsável antes→depois');
  // Realizar → realizadoPor; desfazer → limpa e registra.
  atual = await put('/api/acoes-sst/' + a.id, { ...atual, dataRealizacao: isoDia(-1) }).then((x) => x.json());
  assert.match(atual.realizadoPor, new RegExp(ADMIN.usuario, 'i'));
  assert.equal(atual.status, 'Realizada');
  atual = await put('/api/acoes-sst/' + a.id, { ...atual, dataRealizacao: '' }).then((x) => x.json());
  assert.equal(atual.realizadoPor, '', 'desfazer a realização limpa o realizadoPor');
  assert.notEqual(atual.status, 'Realizada', 'o status volta à regra normal');
  const hist2 = await getj('/api/historico');
  assert.ok(hist2.some((h) => /Ação SST "DDS NR-35".*realização removida/.test(h.texto || '')),
    'histórico precisa registrar a realização desfeita');
  await del('/api/acoes-sst/' + a.id);
});

test('AS-4: evidência (e a versão anterior) sobrevive à faxina de órfãs e entra no backup', async () => {
  const antiga = await subirEvidencia('relatorio-v1.png');
  const nova = await subirEvidencia('relatorio-v2.png');
  const evid = refEvid(nova, { versoes: [{ id: antiga.id, nome: 'v1', tipo: 'image/png', nomeOriginal: 'relatorio-v1.png', uploadTs: Date.now() - 1000, uploadPor: 'teste', substituidoTs: Date.now(), substituidoPor: 'teste' }] });
  const a = await post('/api/acoes-sst', baseAcao({ titulo: 'Inspeção com evidência', dataRealizacao: isoDia(-1), evidencias: [evid] })).then((x) => x.json());
  envelhecerMidia(antiga.id);
  envelhecerMidia(nova.id);
  assert.equal((await post('/api/midia/limpar-orfas', {})).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${nova.id}`, { headers: { Cookie: adminCookie } })).status, 200, 'evidência ativa não pode ser tratada como órfã');
  assert.equal((await fetch(`${BASE}/api/midia/${antiga.id}`, { headers: { Cookie: adminCookie } })).status, 200, 'a versão anterior também é referenciada');
  const rz = await fetch(`${BASE}/api/backup/gerar?grupo=funcionarios`, { headers: { ...ORIG, Cookie: adminCookie } });
  assert.equal(rz.status, 200, 'a geração falha avisando se faltar cobertura do módulo novo');
  const texto = Buffer.from(await rz.arrayBuffer()).toString('latin1');
  assert.ok(texto.includes('data/acoes_sst.json'), 'o .zip precisa levar o JSON do módulo');
  assert.ok(texto.includes('files/acoes-sst/'), 'as evidências precisam ir para a pasta do módulo');
  const s = await getj('/api/backup/status');
  assert.equal(s.cobertura.ok, true, 'nenhum módulo do dump pode ficar sem cobertura');
  assert.equal(s.anexos.ok, true, 'toda pasta de anexo declarada aponta para grupo válido');
  await del('/api/acoes-sst/' + a.id);
});

test('AS-5: PUT que remove a evidência apaga a mídia do cofre; DELETE apaga em cascata', async () => {
  const m1 = await subirEvidencia('some-no-put.png');
  const a = await post('/api/acoes-sst', baseAcao({ evidencias: [refEvid(m1)] })).then((x) => x.json());
  assert.equal((await put('/api/acoes-sst/' + a.id, { ...a, evidencias: [] })).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${m1.id}`, { headers: { Cookie: adminCookie } })).status, 404, 'evidência removida do registro não pode ficar órfã no cofre');
  const m2 = await subirEvidencia('some-no-delete.png');
  const b = await post('/api/acoes-sst', baseAcao({ evidencias: [refEvid(m2)] })).then((x) => x.json());
  assert.equal((await del('/api/acoes-sst/' + b.id)).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${m2.id}`, { headers: { Cookie: adminCookie } })).status, 404, 'excluir a ação apaga as evidências em cascata');
  await del('/api/acoes-sst/' + a.id);
});

test('AS-6: backup → estrago → restauração devolve o registro, a evidência e a versão anterior', async () => {
  const antiga = await subirEvidencia('rest-v1.png');
  const nova = await subirEvidencia('rest-v2.png');
  const evid = refEvid(nova, { versoes: [{ id: antiga.id, nome: 'v1', tipo: 'image/png', nomeOriginal: 'rest-v1.png', uploadTs: 1, uploadPor: 'teste', substituidoTs: 2, substituidoPor: 'teste' }] });
  const a = await post('/api/acoes-sst', baseAcao({ titulo: 'Ação restaurável', dataRealizacao: isoDia(-1), observacaoRealizacao: '12 participantes', evidencias: [evid] })).then((x) => x.json());

  const rz = await fetch(`${BASE}/api/backup/gerar?grupo=funcionarios`, { headers: { ...ORIG, Cookie: adminCookie } });
  assert.equal(rz.status, 200);
  const zip = Buffer.from(await rz.arrayBuffer());

  // Estrago: excluir apaga o registro E as mídias do cofre.
  assert.equal((await del('/api/acoes-sst/' + a.id)).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${nova.id}`, { headers: { Cookie: adminCookie } })).status, 404, 'sanidade: o estrago apagou a mídia');

  const fd = new FormData();
  fd.append('arquivo', new Blob([zip], { type: 'application/zip' }), 'backup.zip');
  fd.append('aplicar', '1');
  fd.append('frase', 'RESTAURAR BACKUP');
  fd.append('modo', 'mesclar');
  fd.append('grupos', 'funcionarios');
  const rr = await fetch(`${BASE}/api/backup/restaurar`, { method: 'POST', headers: { ...ORIG, Cookie: adminCookie }, body: fd });
  assert.equal(rr.status, 200, 'a restauração precisa responder 200');

  const lista = await getj('/api/acoes-sst');
  const volta = lista.find((x) => x.id === a.id);
  assert.ok(volta, 'o registro precisa voltar do backup');
  assert.equal(volta.titulo, 'Ação restaurável');
  assert.equal(volta.observacaoRealizacao, '12 participantes', 'os campos voltam intactos');
  assert.equal(volta.evidencias[0].id, nova.id, 'o vínculo ação↔mídia é preservado');
  assert.equal(volta.evidencias[0].versoes[0].id, antiga.id, 'a versão anterior volta junto');
  assert.equal((await fetch(`${BASE}/api/midia/${nova.id}`, { headers: { Cookie: adminCookie } })).status, 200, 'o binário da evidência volta do .zip');
  assert.equal((await fetch(`${BASE}/api/midia/${antiga.id}`, { headers: { Cookie: adminCookie } })).status, 200, 'o binário da versão anterior volta do .zip');
  await del('/api/acoes-sst/' + a.id);
});

test('AS-8: agendamento — explícito é respeitado, legado é inferido e "fixa" exige a data', async () => {
  // 'fixa' sem data programada → 400 (a ação de dia marcado precisa do dia).
  const rSem = await post('/api/acoes-sst', baseAcao({ agendamento: 'fixa', prazo: '' }));
  assert.equal(rSem.status, 400, 'fixa sem data programada é recusada');
  assert.match((await rSem.json()).erro, /data programada/i);
  // 'atePrazo' explícito COM prazo é respeitado — o tipo não é adivinhado pela existência do prazo.
  const flex = await post('/api/acoes-sst', baseAcao({ agendamento: 'atePrazo', prazo: isoDia(10) })).then((x) => x.json());
  assert.equal(flex.agendamento, 'atePrazo');
  // Sem o campo no body (cliente antigo): com prazo → 'fixa' (mantém o comportamento ancorado);
  // sem prazo → 'atePrazo' ("faça até o fim do mês", a flexível).
  const leg1 = await post('/api/acoes-sst', baseAcao({ prazo: isoDia(5) })).then((x) => x.json());
  assert.equal(leg1.agendamento, 'fixa');
  const leg2 = await post('/api/acoes-sst', baseAcao({ prazo: '' })).then((x) => x.json());
  assert.equal(leg2.agendamento, 'atePrazo');
  // O prazo original NUNCA muda para a ação "andar" no calendário — o dia exibido é derivado
  // no cliente a cada render; aqui só se garante que o gravado permanece o original.
  const lido = (await getj('/api/acoes-sst')).find((x) => x.id === flex.id);
  assert.equal(lido.prazo, flex.prazo, 'o prazo gravado permanece o original');
  assert.equal(lido.agendamento, 'atePrazo', 'GET devolve o agendamento decorado');
  // Registro gravado ANTES do campo existir (escrito direto no arquivo — em modo local o
  // servidor relê a cada request): o GET decora por inferência, sem migração.
  const arq = path.join(tmp, 'acoes_sst.json');
  const bruto = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  bruto.acoes.push({
    id: 'AS-legado', ts: Date.now(), mesRef: mesDe(isoDia(0)), titulo: 'Ação legada', tipo: 'DDS',
    responsavel: 'João Silva', prazo: '', dataRealizacao: '', observacaoRealizacao: '',
    cancelada: false, motivoCancelamento: '', criadoPor: 'x', atualizadoPor: '', atualizadoEm: 0,
    realizadoPor: '', evidencias: [],
  });
  fs.writeFileSync(arq, JSON.stringify(bruto));
  const legado = (await getj('/api/acoes-sst')).find((x) => x.id === 'AS-legado');
  assert.equal(legado.agendamento, 'atePrazo', 'registro antigo sem prazo vira flexível no GET');
  for (const a of [flex, leg1, leg2, legado]) await del('/api/acoes-sst/' + a.id);
});

// Catálogo de contratos usado pelos testes de empresa/contrato (mesma estrutura de
// cadastros.contratosFuncionarios; em modo local o servidor relê o arquivo a cada request).
const CT_SUL = '4600000101', CT_NTE = '4600000303';
function gravarCatalogoContratos() {
  const arq = path.join(tmp, 'cadastros.json');
  let cad = {};
  try { cad = JSON.parse(fs.readFileSync(arq, 'utf-8')); } catch (e) { /* começa vazio */ }
  cad.contratosFuncionarios = [
    { sigla: 'SUL', nome: 'SUL EMPREENDIMENTOS', contratos: [{ numero: CT_SUL, nome: 'Obra Paulo Afonso' }] },
    { sigla: 'NTE', nome: 'NORTE ENGENHARIA', contratos: [{ numero: CT_NTE, nome: 'ORION' }] },
  ];
  fs.writeFileSync(arq, JSON.stringify(cad));
}

test('AS-9: empresa/contrato — valida existência e pertencimento no servidor; legado sem vínculo segue vivo', async () => {
  gravarCatalogoContratos();
  // Válidos: empresa + contrato dela; e só empresa (contrato é opcional — ação geral).
  const ok = await post('/api/acoes-sst', baseAcao({ empresa: 'SUL', contratoNumero: CT_SUL }));
  assert.equal(ok.status, 201);
  const a = await ok.json();
  assert.equal(a.empresa, 'SUL');
  assert.equal(a.contratoNumero, CT_SUL);
  const soEmp = await post('/api/acoes-sst', baseAcao({ empresa: 'NTE' })).then((x) => x.json());
  assert.equal(soEmp.empresa, 'NTE');
  assert.equal(soEmp.contratoNumero, '');
  // Inválidos — a validação é do SERVIDOR, não se confia no formulário.
  assert.equal((await post('/api/acoes-sst', baseAcao({ empresa: 'ACME' }))).status, 400, 'empresa que não existe');
  assert.equal((await post('/api/acoes-sst', baseAcao({ empresa: 'SUL', contratoNumero: '999' }))).status, 400, 'contrato que não existe');
  const cruzado = await post('/api/acoes-sst', baseAcao({ empresa: 'NTE', contratoNumero: CT_SUL }));
  assert.equal(cruzado.status, 400, 'contrato de OUTRA empresa é recusado');
  assert.match((await cruzado.json()).erro, /não pertence/i);
  assert.equal((await post('/api/acoes-sst', baseAcao({ contratoNumero: CT_SUL }))).status, 400, 'contrato sem empresa é recusado');
  // Nome livre é normalizado para a sigla canônica (mesma régua da aba Funcionários).
  const porNome = await post('/api/acoes-sst', baseAcao({ empresa: 'Sul Empreendimentos' })).then((x) => x.json());
  assert.equal(porNome.empresa, 'SUL');
  // Edição: trocar a empresa E o contrato juntos vale; trocar só a empresa deixando o
  // contrato da antiga é recusado (combinação inválida não passa nem vinda da edição).
  const trocada = await put('/api/acoes-sst/' + a.id, { ...a, empresa: 'NTE', contratoNumero: CT_NTE }).then((x) => x.json());
  assert.equal(trocada.empresa, 'NTE');
  assert.equal(trocada.contratoNumero, CT_NTE);
  assert.equal((await put('/api/acoes-sst/' + a.id, { ...trocada, empresa: 'SUL' })).status, 400, 'empresa nova com contrato da antiga');
  // Legado: registro sem os campos continua abrindo e o PUT sem vínculo continua aceito.
  const legado = await post('/api/acoes-sst', baseAcao({})).then((x) => x.json());
  assert.equal((await put('/api/acoes-sst/' + legado.id, { ...legado, titulo: 'Legado editado' })).status, 200);
  for (const x of [a, soEmp, porNome, legado]) await del('/api/acoes-sst/' + x.id);
});

test('AS-10: recorte por empresa/contrato do usuário — mesma régua da aba Funcionários', async () => {
  gravarCatalogoContratos();
  const daSUL = await post('/api/acoes-sst', baseAcao({ titulo: 'Ação da SUL', empresa: 'SUL', contratoNumero: CT_SUL })).then((x) => x.json());
  const daNTE = await post('/api/acoes-sst', baseAcao({ titulo: 'Ação da NTE', empresa: 'NTE' })).then((x) => x.json());
  const geral = await post('/api/acoes-sst', baseAcao({ titulo: 'Ação geral' })).then((x) => x.json());
  // Usuário com editar em acoesSst mas acesso SÓ à NTE.
  let r = await fetch(BASE + '/api/cadastro/solicitar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ usuario: 'sst.nte', nome: 'Só NTE', senha: 'senha1234' }),
  });
  assert.equal(r.status, 201);
  assert.equal((await post('/api/usuarios/sst.nte/aprovar', {})).status, 200);
  const AREAS = ['frota', 'multas', 'rastreadores', 'instalacoes', 'manutencao', 'abastecimento',
    'fornecedores', 'locacoes', 'funcionarios', 'almoxarifado', 'epi', 'admissao', 'integracao',
    'programas', 'acoesSst', 'simulador', 'contratos', 'cartoes', 'controles', 'contabilidade',
    'investimentos', 'custos', 'senhas', 'documentos', 'ti', 'feedback', 'cadastros'];
  const permissoes = Object.fromEntries(AREAS.map((ar) => [ar, ar === 'acoesSst' ? 'editar' : 'nenhum']));
  assert.equal((await post('/api/usuarios/sst.nte/permissoes', { permissoes, empresasFunc: 'NTE' })).status, 200);
  const nte = await login('sst.nte', 'senha1234');
  assert.equal(nte.status, 200);
  // GET: a ação da SUL some; a da NTE e a geral (sem empresa) aparecem.
  const lista = await getj('/api/acoes-sst', nte.cookie);
  const ids = new Set(lista.map((x) => x.id));
  assert.ok(!ids.has(daSUL.id), 'ação da outra empresa não pode vazar na listagem');
  assert.ok(ids.has(daNTE.id), 'ação da empresa liberada aparece');
  assert.ok(ids.has(geral.id), 'ação sem empresa aparece para quem tem acesso a alguma empresa');
  // Mutações fora do acesso: editar/excluir a ação da SUL e criar/mover PARA a SUL → 403.
  assert.equal((await put('/api/acoes-sst/' + daSUL.id, { ...daSUL, titulo: 'x' }, nte.cookie)).status, 403);
  assert.equal((await del('/api/acoes-sst/' + daSUL.id, nte.cookie)).status, 403);
  assert.equal((await post('/api/acoes-sst', baseAcao({ empresa: 'SUL' }), nte.cookie)).status, 403, 'não cria ação de empresa fora do acesso');
  assert.equal((await put('/api/acoes-sst/' + daNTE.id, { ...daNTE, empresa: 'SUL' }, nte.cookie)).status, 403, 'não move a ação para empresa fora do acesso');
  // Dentro do acesso, tudo normal.
  assert.equal((await put('/api/acoes-sst/' + daNTE.id, { ...daNTE, contratoNumero: CT_NTE }, nte.cookie)).status, 200);
  for (const x of [daSUL, daNTE, geral]) await del('/api/acoes-sst/' + x.id);
});

test('AS-11: cor no calendário — paleta validada no servidor, fallback Padrão e persistência', async () => {
  // Sem cor no body → Padrão ('' — a pílula segue a situação no cliente).
  const semCor = await post('/api/acoes-sst', baseAcao({})).then((x) => x.json());
  assert.equal(semCor.cor, '', 'default é o Padrão (string vazia)');
  // Cor da paleta persiste e volta no GET (sobrevive a reload).
  const r = await post('/api/acoes-sst', baseAcao({ cor: 'roxo' }));
  assert.equal(r.status, 201);
  const roxa = await r.json();
  assert.equal(roxa.cor, 'roxo');
  let lida = (await getj('/api/acoes-sst')).find((x) => x.id === roxa.id);
  assert.equal(lida.cor, 'roxo', 'GET devolve a cor persistida');
  // Valor fora da paleta não vira 400 nem passa cru: normaliza para '' (Padrão).
  const invalida = await post('/api/acoes-sst', baseAcao({ cor: 'rosa' })).then((x) => x.json());
  assert.equal(invalida.cor, '', 'cor inventada é coagida ao Padrão');
  // Edição: PUT troca a cor e o GET confirma.
  assert.equal((await put('/api/acoes-sst/' + roxa.id, { ...roxa, cor: 'verde' })).status, 200);
  lida = (await getj('/api/acoes-sst')).find((x) => x.id === roxa.id);
  assert.equal(lida.cor, 'verde', 'a troca de cor persiste');
  // Registro legado gravado ANTES do campo existir continua sendo devolvido normalmente
  // (sem cor → o cliente cai no Padrão; nada de migração).
  const arq = path.join(tmp, 'acoes_sst.json');
  const bruto = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  bruto.acoes.push({
    id: 'AS-sem-cor', ts: Date.now(), mesRef: mesDe(isoDia(0)), titulo: 'Ação sem cor', tipo: 'DDS',
    responsavel: 'João Silva', prazo: '', dataRealizacao: '', cancelada: false, evidencias: [],
  });
  fs.writeFileSync(arq, JSON.stringify(bruto));
  const legado = (await getj('/api/acoes-sst')).find((x) => x.id === 'AS-sem-cor');
  assert.ok(legado, 'legado sem o campo continua na listagem');
  assert.ok(!legado.cor, 'sem cor gravada → sem cor na resposta');
  for (const x of [semCor, roxa, invalida, legado]) await del('/api/acoes-sst/' + x.id);
});

test('AS-7: permissões — "ver" lê ações e evidências mas não cria/edita/exclui/anexa; sem a área, nada', async () => {
  // Usuário 'ver': solicita cadastro → admin aprova → admin libera só acoesSst:'ver'.
  let r = await fetch(BASE + '/api/cadastro/solicitar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ usuario: 'sst.ver', nome: 'Só Leitura', senha: 'senha1234' }),
  });
  assert.equal(r.status, 201);
  assert.equal((await post('/api/usuarios/sst.ver/aprovar', {})).status, 200);
  // O painel real manda o mapa COMPLETO ('nenhum' explícito em tudo): área AUSENTE do mapa cai
  // no 'editar' implícito (retrocompat), o que liberaria upload de mídia por outra área.
  const AREAS = ['frota', 'multas', 'rastreadores', 'instalacoes', 'manutencao', 'abastecimento',
    'fornecedores', 'locacoes', 'funcionarios', 'almoxarifado', 'epi', 'admissao', 'integracao',
    'programas', 'acoesSst', 'simulador', 'contratos', 'cartoes', 'controles', 'contabilidade',
    'investimentos', 'custos', 'senhas', 'documentos', 'ti', 'feedback', 'cadastros'];
  const soVer = Object.fromEntries(AREAS.map((ar) => [ar, ar === 'acoesSst' ? 'ver' : 'nenhum']));
  r = await post('/api/usuarios/sst.ver/permissoes', { permissoes: soVer });
  assert.equal(r.status, 200);
  const ver = await login('sst.ver', 'senha1234');
  assert.equal(ver.status, 200);

  const evid = await subirEvidencia('perm.png');
  const a = await post('/api/acoes-sst', baseAcao({ evidencias: [refEvid(evid)] })).then((x) => x.json());

  // Pode: listar e baixar a evidência.
  assert.equal((await fetch(BASE + '/api/acoes-sst', { headers: { Cookie: ver.cookie } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${evid.id}`, { headers: { Cookie: ver.cookie } })).status, 200, '"ver" na área libera a leitura da evidência');
  // Não pode: mutar nem subir mídia.
  assert.equal((await post('/api/acoes-sst', baseAcao(), ver.cookie)).status, 403, 'ver não cria');
  assert.equal((await put('/api/acoes-sst/' + a.id, { ...a, titulo: 'x' }, ver.cookie)).status, 403, 'ver não edita');
  assert.equal((await del('/api/acoes-sst/' + a.id, ver.cookie)).status, 403, 'ver não exclui');
  const fd = new FormData();
  fd.append('arquivo', new Blob([PNG], { type: 'image/png' }), 'x.png');
  const up = await fetch(BASE + '/api/midia', { method: 'POST', headers: { ...ORIG, Cookie: ver.cookie }, body: fd });
  assert.equal(up.status, 403, 'ver não envia mídia');

  // Usuário novo sem permissão explícita: a aba nova nasce trancada ('nenhum' em tudo).
  r = await fetch(BASE + '/api/cadastro/solicitar', {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ usuario: 'sst.nada', nome: 'Sem Acesso', senha: 'senha1234' }),
  });
  assert.equal(r.status, 201);
  assert.equal((await post('/api/usuarios/sst.nada/aprovar', {})).status, 200);
  const nada = await login('sst.nada', 'senha1234');
  assert.equal((await fetch(BASE + '/api/acoes-sst', { headers: { Cookie: nada.cookie } })).status, 403, 'sem a área liberada, nem leitura');
  await del('/api/acoes-sst/' + a.id);
});
