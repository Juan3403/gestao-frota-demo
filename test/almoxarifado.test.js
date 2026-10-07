/**
 * Testes do módulo ALMOXARIFADO (v1.48) — cada teste começa pelo id da spec (AX-n).
 * Mesmo harness do smoke/modulos: servidor REAL em DATA_DIR temporário, porta própria.
 * Rodar: npm test  (ou: node --test test/almoxarifado.test.js)
 *
 * O que estes testes protegem, em ordem de importância:
 *  1. Devolução PARCIAL por quantidade (pegou 6, devolveu 3) — o motivo desta versão.
 *  2. O hash da assinatura: devolver NÃO pode invalidar o recibo; editar item TEM que invalidar.
 *  3. Contrato travado em ORION e a saída de centro de custo / CA da interface.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const PORT = 3197;
const BASE = `http://localhost:${PORT}`;
const ORIG = { Origin: BASE };                                  // anti-CSRF exige Origin nas mutações
const JSONH = { 'Content-Type': 'application/json', ...ORIG };
let srv, tmp;
// Estado do processo filho: sem isto, um servidor que morre no boot (EADDRINUSE, variável de
// ambiente faltando...) some em silêncio — o spawn descartava o stderr e ninguém olhava o código
// de saída, então a suíte seguia contra o servidor alheio já de pé na porta.
let srvSaida = null; // código (ou sinal) com que o filho morreu, se morreu
let srvLog = '';     // stderr do filho, para a mensagem de erro dizer o motivo

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const ASSINATURA_PNG = 'data:image/png;base64,' + PNG_1x1;

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
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* subindo */ }
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-almox-test-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: tmp, PORT: String(PORT), APP_PASSWORD: '', SENHA_ADMIN: '', MONGODB_URI: '', COBLI_API_KEY: '', RESEND_API_KEY: '', NOTIF_EMAIL_PARA: '' },
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

const post = (ep, body) => fetch(`${BASE}${ep}`, { method: 'POST', headers: JSONH, body: JSON.stringify(body) });
const put = (ep, body) => fetch(`${BASE}${ep}`, { method: 'PUT', headers: JSONH, body: JSON.stringify(body) });
const del = (ep) => fetch(`${BASE}${ep}`, { method: 'DELETE', headers: { ...ORIG } });
const getj = async (ep) => (await fetch(`${BASE}${ep}`)).json();
const hoje = new Date().toISOString().slice(0, 10);

// Cria uma retirada e devolve o registro já normalizado pelo servidor.
async function criarRetirada(extra = {}) {
  const r = await post('/api/almoxarifado', {
    funcionarioNome: 'Colaborador Teste',
    data: hoje, hora: '08:00',
    responsavel: 'Richard',
    finalidade: 'teste automatizado',
    itens: [{ nome: 'Martelete', tipo: 'Ferramenta', quantidade: 5, unidade: 'un', retornavel: true }],
    ...extra,
  });
  assert.equal(r.status, 201, 'criar retirada deve responder 201');
  return r.json();
}
const devolver = (id, body) => post(`/api/almoxarifado/${encodeURIComponent(id)}/devolver`, body);
const assinar = (id, body = {}) => post(`/api/almoxarifado/${encodeURIComponent(id)}/assinar`,
  { imagem: ASSINATURA_PNG, nome: 'Colaborador Teste', aceite: true, modo: 'desenho', ...body });
const buscar = async (id) => (await getj('/api/almoxarifado')).find((x) => x.id === id);

// ===================== AX-1 — CRUD =====================

test('AX-1a: cria retirada com os itens e a situação derivada', async () => {
  const novo = await criarRetirada();
  assert.ok(novo.id, 'deve gerar id');
  assert.equal(novo.itens.length, 1);
  assert.equal(novo.itens[0].quantidade, 5);
  assert.equal(novo.situacao, 'Pendente de assinatura', 'recibo novo nasce sem assinatura');
});

test('AX-1b: recusa retirada sem colaborador e sem itens', async () => {
  const semNome = await post('/api/almoxarifado', { itens: [{ nome: 'Martelo', quantidade: 1 }] });
  assert.equal(semNome.status, 400);
  const semItens = await post('/api/almoxarifado', { funcionarioNome: 'Fulano', itens: [] });
  assert.equal(semItens.status, 400);
});

test('AX-1c: edita e exclui a retirada', async () => {
  const novo = await criarRetirada();
  const r = await put(`/api/almoxarifado/${novo.id}`, { ...novo, finalidade: 'finalidade nova' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).finalidade, 'finalidade nova');
  assert.equal((await del(`/api/almoxarifado/${novo.id}`)).status, 200);
  assert.equal(await buscar(novo.id), undefined, 'excluída some da listagem');
});

// ===================== AX-2 — Contrato travado em ORION =====================

test('AX-2a: contrato sai sempre como ORION, mesmo se mandarem outro', async () => {
  const novo = await criarRetirada({ contrato: 'Obra do Bloco B' });
  assert.equal(novo.contrato, 'ORION', 'o almoxarifado é exclusivo da ORION — o campo é fixo');
});

test('AX-2b: contrato vazio também vira ORION', async () => {
  const novo = await criarRetirada({ contrato: '' });
  assert.equal(novo.contrato, 'ORION');
});

// ===================== AX-3 — Centro de custo removido =====================

test('AX-3: centro de custo não é mais gravado nem devolvido', async () => {
  const novo = await criarRetirada({ centroCusto: 'CC-99' });
  assert.equal(novo.centroCusto, undefined, 'campo saiu do modelo');
});

// ===================== AX-4 — CA fora da interface, preservado no dado =====================

test('AX-4: CA continua no registro (o hash da assinatura depende dele) mesmo fora da tela', async () => {
  const novo = await criarRetirada({
    itens: [{ nome: 'Furadeira', tipo: 'Ferramenta', quantidade: 1, unidade: 'un', ca: 'PAT-123', retornavel: true }],
  });
  assert.equal(novo.itens[0].ca, 'PAT-123', 'apagar o CA do modelo invalidaria todo recibo já assinado');
});

// ===================== AX-5 — Devolução PARCIAL (o coração desta versão) =====================

test('AX-5a: pegou 5, devolveu 3 — fica em posse com saldo 2', async () => {
  const novo = await criarRetirada();
  await assinar(novo.id);   // sem assinatura a situação seria "Pendente de assinatura", que é outra coisa
  const r = await devolver(novo.id, { itens: [{ i: 0, qtd: 3 }], data: hoje, devolvidoPor: 'Colaborador Teste', recebidoPor: 'Tiago' });
  assert.equal(r.status, 200);
  const it = (await r.json()).itens[0];
  assert.equal(it.qtdDevolvida, 3, 'soma das devoluções');
  assert.equal(it.qtdPendente, 2, 'saldo ainda com o colaborador');
  assert.equal(it.devolvido, false, 'devolução parcial NÃO marca o item como devolvido');
  assert.equal((await buscar(novo.id)).situacao, 'Em posse');
});

test('AX-5b: devolvendo o restante o item fecha e o recibo conclui', async () => {
  const novo = await criarRetirada();
  await assinar(novo.id);
  await devolver(novo.id, { itens: [{ i: 0, qtd: 3 }], data: hoje, recebidoPor: 'Tiago' });
  const r = await devolver(novo.id, { itens: [{ i: 0, qtd: 2 }], data: hoje, recebidoPor: 'Richard' });
  const it = (await r.json()).itens[0];
  assert.equal(it.qtdDevolvida, 5);
  assert.equal(it.qtdPendente, 0);
  assert.equal(it.devolvido, true);
  assert.equal((await buscar(novo.id)).situacao, 'Concluído');
});

test('AX-5c: cada parcela guarda quem trouxe e quem recebeu', async () => {
  const novo = await criarRetirada();
  await devolver(novo.id, { itens: [{ i: 0, qtd: 3 }], data: hoje, devolvidoPor: 'João', recebidoPor: 'Tiago' });
  const r = await devolver(novo.id, { itens: [{ i: 0, qtd: 1 }], data: hoje, devolvidoPor: 'Pedro', recebidoPor: 'Richard' });
  const devs = (await r.json()).itens[0].devolucoes;
  assert.equal(devs.length, 2, 'duas parcelas = dois registros');
  assert.deepEqual([devs[0].qtd, devs[0].devolvidoPor, devs[0].devolvidoPara], [3, 'João', 'Tiago']);
  assert.deepEqual([devs[1].qtd, devs[1].devolvidoPor, devs[1].devolvidoPara], [1, 'Pedro', 'Richard']);
});

test('AX-5d: recusa devolver mais do que está em posse', async () => {
  const novo = await criarRetirada();
  await devolver(novo.id, { itens: [{ i: 0, qtd: 4 }], data: hoje });
  const r = await devolver(novo.id, { itens: [{ i: 0, qtd: 2 }], data: hoje });
  assert.equal(r.status, 400, 'saldo é 1 — devolver 2 é erro de digitação, não um fato');
  assert.match((await r.json()).erro, /1/, 'a mensagem diz quanto ainda está em posse');
});

test('AX-5e: recusa quantidade zero, negativa ou não numérica', async () => {
  const novo = await criarRetirada();
  for (const qtd of [0, -2, 'abc', null]) {
    const r = await devolver(novo.id, { itens: [{ i: 0, qtd }], data: hoje });
    assert.equal(r.status, 400, `qtd ${JSON.stringify(qtd)} deve ser recusada`);
  }
});

test('AX-5f: material de consumo não aceita devolução', async () => {
  const novo = await criarRetirada({
    itens: [{ nome: 'Disco de corte', tipo: 'Material de consumo', quantidade: 10, unidade: 'un', retornavel: false }],
  });
  const r = await devolver(novo.id, { itens: [{ i: 0, qtd: 1 }], data: hoje });
  assert.equal(r.status, 400, 'consumo já sai baixado — não volta');
});

test('AX-5g: índice de item inexistente é recusado', async () => {
  const novo = await criarRetirada();
  const r = await devolver(novo.id, { itens: [{ i: 7, qtd: 1 }], data: hoje });
  assert.equal(r.status, 400);
});

test('AX-5h: lista de índices (formato antigo) devolve o saldo inteiro do item', async () => {
  const novo = await criarRetirada();
  const r = await devolver(novo.id, { itens: [0], data: hoje, recebidoPor: 'Tiago' });
  assert.equal(r.status, 200);
  const it = (await r.json()).itens[0];
  assert.equal(it.qtdDevolvida, 5);
  assert.equal(it.devolvido, true);
});

test('AX-5i: estorno desfaz a última parcela e devolve o saldo', async () => {
  const novo = await criarRetirada();
  await devolver(novo.id, { itens: [{ i: 0, qtd: 3 }], data: hoje, recebidoPor: 'Tiago' });
  await devolver(novo.id, { itens: [{ i: 0, qtd: 2 }], data: hoje, recebidoPor: 'Richard' });
  const r = await devolver(novo.id, { estornar: [0] });
  assert.equal(r.status, 200);
  const it = (await r.json()).itens[0];
  assert.equal(it.qtdDevolvida, 3, 'volta ao estado anterior');
  assert.equal(it.devolvido, false);
  assert.equal(it.devolucoes.length, 1, 'a parcela mais antiga fica intacta');
  assert.equal(it.devolucoes[0].devolvidoPara, 'Tiago');
});

test('AX-5j: item já totalmente devolvido não aceita nova devolução', async () => {
  const novo = await criarRetirada();
  await devolver(novo.id, { itens: [{ i: 0, qtd: 5 }], data: hoje });
  const r = await devolver(novo.id, { itens: [{ i: 0, qtd: 1 }], data: hoje });
  assert.equal(r.status, 400);
});

test('AX-5k: devolução parcial de item fracionado (kg, metro) mantém a conta', async () => {
  const novo = await criarRetirada({
    itens: [{ nome: 'Cabo de aço', tipo: 'Equipamento', quantidade: 2.5, unidade: 'm', retornavel: true }],
  });
  const r = await devolver(novo.id, { itens: [{ i: 0, qtd: 1.5 }], data: hoje });
  const it = (await r.json()).itens[0];
  assert.equal(it.qtdDevolvida, 1.5);
  assert.equal(it.qtdPendente, 1);
});

// ===================== AX-6 — Retrocompatibilidade =====================

test('AX-6: registro antigo com devolvido:true conta como devolução integral', async () => {
  const novo = await criarRetirada({
    itens: [{ nome: 'Marreta', tipo: 'Ferramenta', quantidade: 4, unidade: 'un', retornavel: true,
      devolvido: true, dataDevolucao: '2026-07-01', devolvidoPara: 'Tiago', devolvidoPor: 'João' }],
  });
  const it = novo.itens[0];
  assert.equal(it.devolvido, true);
  assert.equal(it.qtdDevolvida, 4, 'o formato velho vira uma parcela cheia');
  assert.equal(it.qtdPendente, 0);
  assert.equal(it.devolucoes[0].devolvidoPara, 'Tiago', 'os nomes do registro antigo são preservados');
});

// ===================== AX-7 — Assinatura e integridade do recibo =====================

test('AX-7a: assinar exige o aceite e a imagem PNG', async () => {
  const novo = await criarRetirada();
  assert.equal((await assinar(novo.id, { aceite: false })).status, 400, 'sem aceite não há assinatura');
  assert.equal((await assinar(novo.id, { imagem: 'data:image/png;base64,AAAA' })).status, 400, 'PNG falso é recusado');
  const ok = await assinar(novo.id);
  assert.equal(ok.status, 200);
  const r = await ok.json();
  assert.ok(r.assinatura && r.assinatura.id, 'guarda a referência da imagem');
  assert.ok(r.assinaturaCodigo, 'gera o código público de conferência');
  assert.equal(r.alteradaAposAssinatura, false);
});

test('AX-7b: DEVOLVER (inclusive parcial) não invalida a assinatura', async () => {
  const novo = await criarRetirada();
  await assinar(novo.id);
  await devolver(novo.id, { itens: [{ i: 0, qtd: 2 }], data: hoje, recebidoPor: 'Tiago' });
  const r = await buscar(novo.id);
  assert.equal(r.alteradaAposAssinatura, false, 'devolver é o curso normal do processo');
});

test('AX-7c: editar os ITENS depois de assinado acende o alerta de alteração', async () => {
  const novo = await criarRetirada();
  await assinar(novo.id);
  await put(`/api/almoxarifado/${novo.id}`, {
    ...novo, itens: [{ nome: 'Martelete', tipo: 'Ferramenta', quantidade: 9, unidade: 'un', retornavel: true }],
  });
  assert.equal((await buscar(novo.id)).alteradaAposAssinatura, true, 'a assinatura só vale para o que foi assinado');
});

test('AX-7d: estorno de devolução também não invalida a assinatura', async () => {
  const novo = await criarRetirada();
  await assinar(novo.id);
  await devolver(novo.id, { itens: [{ i: 0, qtd: 2 }], data: hoje });
  await devolver(novo.id, { estornar: [0] });
  assert.equal((await buscar(novo.id)).alteradaAposAssinatura, false);
});

// ===================== AX-8 — Conferência pública =====================

test('AX-8: /api/verificar devolve o recibo sem expor CPF nem id interno', async () => {
  const novo = await criarRetirada({ funcionarioCpf: '111.222.333-44' });
  const assinado = await (await assinar(novo.id)).json();
  const v = await getj(`/api/verificar/${assinado.assinaturaCodigo}`);
  assert.equal(v.ok, true);
  assert.equal(v.autentico, true);
  assert.equal(v.colaborador, 'Colaborador Teste');
  assert.equal(v.cpf, undefined, 'CPF não sai na página pública');
  assert.equal(v.id, undefined, 'id interno não sai na página pública');
  assert.equal((await fetch(`${BASE}/api/verificar/CODIGO-QUE-NAO-EXISTE`)).status, 404);
});

// ===================== AX-9 — Exportações =====================

test('AX-9a: Excel traz o saldo da devolução e não traz CA nem centro de custo', async () => {
  const novo = await criarRetirada();
  await devolver(novo.id, { itens: [{ i: 0, qtd: 3 }], data: hoje, recebidoPor: 'Tiago', devolvidoPor: 'João' });
  const r = await post('/api/almoxarifado/exportar', { ids: [novo.id] });
  assert.equal(r.status, 200);
  const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
  const cabecalhos = Object.keys(linhas[0] || {});
  assert.ok(!cabecalhos.some((c) => /CA \/ PATRIM/i.test(c)), 'coluna de CA saiu');
  assert.ok(!cabecalhos.some((c) => /CENTRO DE CUSTO/i.test(c)), 'coluna de centro de custo saiu');
  const linha = linhas.find((l) => l.ITEM === 'Martelete');
  assert.equal(linha['QTD DEVOLVIDA'], 3);
  assert.equal(linha['QTD EM POSSE'], 2);
  assert.equal(linha['CONTRATO / OBRA'], 'ORION');
});

test('AX-9b: recibo em PDF sai para retirada com devolução parcial', async () => {
  const novo = await criarRetirada();
  await assinar(novo.id);
  await devolver(novo.id, { itens: [{ i: 0, qtd: 3 }], data: hoje, recebidoPor: 'Tiago' });
  const r = await fetch(`${BASE}/api/almoxarifado/${novo.id}/recibo.pdf`);
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.subarray(0, 4).toString(), '%PDF', 'resposta é um PDF de verdade');
  assert.ok(buf.length > 1000, 'PDF não pode sair vazio');
});

test('AX-9c: relatório em PDF do período responde', async () => {
  const novo = await criarRetirada();
  const r = await post('/api/almoxarifado/relatorio.pdf', { ids: [novo.id] });
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
});

// ===================== AX-10 — Backup =====================

test('AX-10: almoxarifado entra no backup com a devolução parcial preservada', async () => {
  const novo = await criarRetirada();
  await devolver(novo.id, { itens: [{ i: 0, qtd: 3 }], data: hoje, recebidoPor: 'Tiago' });
  const r = await fetch(`${BASE}/api/backup/gerar`, { headers: { ...ORIG } });
  assert.equal(r.status, 200, 'a geração falha se faltar entrada em COBERTURA_BACKUP');
  assert.ok(Buffer.from(await r.arrayBuffer()).length > 100);
});
