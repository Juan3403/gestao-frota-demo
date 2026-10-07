/**
 * Testes de fumaça — sobem o servidor real num diretório de dados TEMPORÁRIO
 * (DATA_DIR) e exercitam as rotas principais. Não tocam nos dados reais.
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const PORT = 3199;
const BASE = `http://localhost:${PORT}`;
// O servidor barra mutações sem Origin/Referer (anti-CSRF). O navegador sempre envia
// Origin; o fetch cru do Node não. Replicamos o cabeçalho do navegador nas mutações.
const ORIG = { Origin: BASE };
let srv, tmp;
// Estado do processo filho: sem isto, um servidor que morre no boot (EADDRINUSE, variável de
// ambiente faltando...) some em silêncio — o spawn descartava o stderr e ninguém olhava o código
// de saída, então a suíte seguia contra o servidor alheio já de pé na porta.
let srvSaida = null; // código (ou sinal) com que o filho morreu, se morreu
let srvLog = '';     // stderr do filho, para a mensagem de erro dizer o motivo

const partesVersao = (v) => String(v || '').split('.').map((n) => Number(n) || 0);
const compararVersao = (a, b) => {
  const pa = partesVersao(a), pb = partesVersao(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
};

async function esperarServidor(ms = 10000) {
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
async function esperarUndoDisponivel(area, ms = 3000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    const r = await fetch(`${BASE}/api/desfazer/status?area=${encodeURIComponent(area)}`);
    const d = await r.json();
    if (d.disponivel) return d;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Undo de ${area} não ficou disponível`);
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-test-'));
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

test('changelog consolida todas as versões preparadas desde o último commit', async () => {
  let versaoAnterior = '';
  let autorGit = '';
  try {
    const bruto = execFileSync('git', ['show', 'HEAD:package.json'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    versaoAnterior = JSON.parse(bruto).version || '';
    autorGit = execFileSync('git', ['config', 'user.name'], {
      cwd: path.join(__dirname, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch (e) {
    return; // pacote sem metadados do Git (por exemplo, artefato de produção)
  }
  const d = await (await fetch(`${BASE}/api/versao`)).json();
  d.changelog = (await (await fetch(`${BASE}/api/changelog`)).json()).changelog; // histórico saiu do /api/versao (payload leve)
  assert.ok((d.changelog || []).every((c) => c.autor !== 'Codex'), 'o changelog não deve usar o nome da ferramenta como autor');
  if (compararVersao(d.versao, versaoAnterior) <= 0) return;
  const pendentes = (d.changelog || []).filter((c) =>
    compararVersao(c.versao, versaoAnterior) > 0 && compararVersao(c.versao, d.versao) <= 0
  );
  const topo = new Set(d.mudancas || []);
  for (const entrada of pendentes) {
    assert.equal(entrada.autor, autorGit, `a versão v${entrada.versao} deve usar o autor configurado no Git`);
  }
  for (const entrada of pendentes.slice(1)) {
    for (const mudanca of (entrada.mudancas || [])) {
      assert.ok(topo.has(mudanca), `a versão atual deve consolidar a alteração pendente de v${entrada.versao}: ${mudanca}`);
    }
  }
});

test('as listas começam vazias e respondem 200', async () => {
  for (const ep of ['veiculos', 'multas', 'rastreadores', 'instalacoes', 'envios']) {
    const r = await fetch(`${BASE}/api/${ep}`);
    assert.equal(r.status, 200, ep);
    assert.ok(Array.isArray(await r.json()), ep + ' deve ser lista');
  }
});

test('veículo em oficina persiste previsão e encerra o alerta sem apagar os dados ao sair', async () => {
  const amanha = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  let r = await fetch(`${BASE}/api/veiculos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ placa: 'TST1234', modelo: 'Teste', status: 'OFICINA', oficinaPrevisaoSaida: amanha, oficinaPrazoDias: 10 }),
  });
  assert.equal(r.status, 201);
  let veiculo = (await (await fetch(`${BASE}/api/veiculos`)).json()).find((v) => v.placa === 'TST1234');
  assert.equal(veiculo.oficinaPrevisaoSaida, amanha);
  assert.equal(veiculo.oficinaPrazoDias, 10);

  const notif = await (await fetch(`${BASE}/api/notificacoes/status`)).json();
  assert.equal(notif.pendencias.oficina, 1);

  r = await fetch(`${BASE}/api/veiculos/TST1234`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ ...veiculo, status: 'EM ATIVIDADE' }),
  });
  assert.equal(r.status, 200);
  veiculo = await r.json();
  assert.equal(veiculo.oficinaPrevisaoSaida, amanha);
  assert.equal(veiculo.oficinaPrazoDias, 10);
  assert.equal((await (await fetch(`${BASE}/api/notificacoes/status`)).json()).pendencias.oficina, 0);

  r = await fetch(`${BASE}/api/veiculos/TST1234`, { method: 'DELETE', headers: { ...ORIG } });
  assert.equal(r.status, 200);
});

test('Frota: oficina persiste, exporta só as placas pedidas e permite reimportar o Excel', async (t) => {
  const headers = { 'Content-Type': 'application/json', ...ORIG };
  const oficina = {
    placa: 'EXP1A23', status: 'OFICINA', oficinaDataEntrada: '2026-09-28',
    oficinaPrevisaoSaida: '2026-10-05', oficinaValorOrcamento: '1.250,50', oficinaMotivo: 'Troca de embreagem',
  };
  t.after(async () => {
    for (const placa of ['EXP1A23', 'EXP2B34']) await fetch(`${BASE}/api/veiculos/${placa}`, { method: 'DELETE', headers: ORIG });
  });
  for (const v of [oficina, { placa: 'EXP2B34', status: 'EM ATIVIDADE' }]) {
    const r = await fetch(`${BASE}/api/veiculos`, { method: 'POST', headers, body: JSON.stringify(v) });
    assert.equal(r.status, 201);
  }
  const r = await fetch(`${BASE}/api/exportar?placas=EXP1A23`);
  assert.equal(r.status, 200);
  const buffer = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(buffer, { type: 'buffer', cellNF: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const linhas = XLSX.utils.sheet_to_json(ws);
  assert.equal(linhas.length, 1);
  assert.equal(linhas[0].PLACA, oficina.placa);
  assert.equal(linhas[0]['DATA DE ENTRADA'], oficina.oficinaDataEntrada);
  assert.equal(linhas[0]['DATA DE PREVISÃO'], oficina.oficinaPrevisaoSaida);
  assert.equal(linhas[0]['VALOR DA MANUTENÇÃO'], 1250.5);
  assert.equal(linhas[0]['MOTIVO DA IDA'], oficina.oficinaMotivo);
  assert.ok(Object.values(ws).some(c => c && c.t === 'n' && c.v === 1250.5 && c.z.includes('0.00')));
  for (const query of ['placas=', 'placas=INEXISTENTE']) {
    const vazio = XLSX.read(Buffer.from(await (await fetch(`${BASE}/api/exportar?${query}`)).arrayBuffer()));
    const matriz = XLSX.utils.sheet_to_json(vazio.Sheets[vazio.SheetNames[0]], { header: 1 });
    assert.equal(matriz.length, 1, 'recorte vazio nunca exporta todos os veículos');
    assert.ok(matriz[0].includes('MOTIVO DA IDA'));
  }
  // Reimporta os dois registros para conferir também orçamento vazio versus zero.
  const completo = Buffer.from(await (await fetch(`${BASE}/api/exportar`)).arrayBuffer());
  const fd = new FormData(); fd.append('arquivo', new Blob([completo]), 'frota.xlsx');
  assert.equal((await fetch(`${BASE}/api/importar`, { method: 'POST', headers: ORIG, body: fd })).status, 200);
  let veiculos = await (await fetch(`${BASE}/api/veiculos`)).json();
  let salvo = veiculos.find(v => v.placa === oficina.placa);
  assert.equal(salvo.oficinaValorOrcamento, 1250.5);
  assert.equal(salvo.oficinaDataEntrada, oficina.oficinaDataEntrada);
  assert.equal(salvo.oficinaPrevisaoSaida, oficina.oficinaPrevisaoSaida);
  assert.equal(salvo.oficinaMotivo, oficina.oficinaMotivo);
  assert.equal(veiculos.find(v => v.placa === 'EXP2B34').oficinaValorOrcamento, null);
  const editado = await fetch(`${BASE}/api/veiculos/${oficina.placa}`, {
    method: 'PUT', headers, body: JSON.stringify({ ...salvo, status: 'EM ATIVIDADE', oficinaValorOrcamento: 0 }),
  });
  salvo = await editado.json();
  assert.equal(salvo.oficinaValorOrcamento, 0);
  assert.equal(salvo.oficinaDataEntrada, oficina.oficinaDataEntrada);
  assert.equal(salvo.oficinaPrevisaoSaida, oficina.oficinaPrevisaoSaida);
  assert.equal(salvo.oficinaMotivo, oficina.oficinaMotivo);
  // Cabeçalho anterior continua aceito para não apagar previsões nas planilhas antigas.
  const antigo = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(antigo, XLSX.utils.json_to_sheet([
    { PLACA: oficina.placa, STATUS: 'OFICINA', 'PREVISÃO SAÍDA OFICINA': '2026-10-06' },
  ]), 'FROTA');
  const fdAntigo = new FormData();
  fdAntigo.append('arquivo', new Blob([XLSX.write(antigo, { type: 'buffer', bookType: 'xlsx' })]), 'antigo.xlsx');
  assert.equal((await fetch(`${BASE}/api/importar`, { method: 'POST', headers: ORIG, body: fdAntigo })).status, 200);
  veiculos = await (await fetch(`${BASE}/api/veiculos`)).json();
  assert.equal(veiculos[0].oficinaPrevisaoSaida, '2026-10-06');
});

test('desfazer reverte criação, edição e exclusão sem sobrescrever alteração concorrente', async () => {
  const json = { 'Content-Type': 'application/json', ...ORIG };
  let r = await fetch(`${BASE}/api/veiculos`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ placa: 'UDO1A23', modelo: 'Criação', status: 'EM ATIVIDADE' }),
  });
  assert.equal(r.status, 201);
  await esperarUndoDisponivel('frota');
  r = await fetch(`${BASE}/api/desfazer/ultimo`, {
    method: 'POST', headers: json, body: JSON.stringify({ area: 'frota' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await (await fetch(`${BASE}/api/veiculos`)).json()).some(v => v.placa === 'UDO1A23'), false);

  r = await fetch(`${BASE}/api/veiculos`, {
    method: 'POST', headers: json,
    body: JSON.stringify({ placa: 'UDO2B34', modelo: 'Original', status: 'EM ATIVIDADE' }),
  });
  const original = await r.json();
  r = await fetch(`${BASE}/api/veiculos/UDO2B34`, {
    method: 'PUT', headers: json, body: JSON.stringify({ ...original, modelo: 'Editado' }),
  });
  assert.equal(r.status, 200);
  r = await fetch(`${BASE}/api/desfazer/ultimo`, {
    method: 'POST', headers: json, body: JSON.stringify({ area: 'frota' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await (await fetch(`${BASE}/api/veiculos`)).json()).find(v => v.placa === 'UDO2B34').modelo, 'Original');

  assert.equal((await fetch(`${BASE}/api/veiculos/UDO2B34`, { method: 'DELETE', headers: ORIG })).status, 200);
  r = await fetch(`${BASE}/api/desfazer/ultimo`, {
    method: 'POST', headers: json, body: JSON.stringify({ area: 'frota' }),
  });
  assert.equal(r.status, 200);
  assert.ok((await (await fetch(`${BASE}/api/veiculos`)).json()).some(v => v.placa === 'UDO2B34'));

  const dois = ['UCA1A11', 'UCB1B22'];
  const antes = (await (await fetch(`${BASE}/api/veiculos`)).json()).length;
  const criacoes = await Promise.all(dois.map(placa => fetch(`${BASE}/api/veiculos`, {
    method: 'POST', headers: json, body: JSON.stringify({ placa, modelo: 'Concorrente', status: 'EM ATIVIDADE' }),
  })));
  assert.deepEqual(criacoes.map(x => x.status), [201, 201]);
  r = await fetch(`${BASE}/api/desfazer/ultimo`, {
    method: 'POST', headers: json, body: JSON.stringify({ area: 'frota' }),
  });
  assert.equal(r.status, 200);
  const depois = await (await fetch(`${BASE}/api/veiculos`)).json();
  assert.equal(depois.length, antes + 1, 'undo da última requisição não pode englobar a requisição concorrente');

  const alvo = depois.find(v => dois.includes(v.placa));
  r = await fetch(`${BASE}/api/veiculos/${alvo.placa}`, {
    method: 'PUT', headers: json, body: JSON.stringify({ ...alvo, modelo: 'Minha edição' }),
  });
  assert.equal(r.status, 200);
  await esperarUndoDisponivel('frota');
  const arquivo = path.join(tmp, 'data.json');
  const disco = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  disco.veiculos.find(v => v.placa === alvo.placa).modelo = 'Edição concorrente';
  fs.writeFileSync(arquivo, JSON.stringify(disco, null, 2));
  r = await fetch(`${BASE}/api/desfazer/ultimo`, {
    method: 'POST', headers: json, body: JSON.stringify({ area: 'frota' }),
  });
  assert.equal(r.status, 409);
  assert.match((await r.json()).erro, /alteração mais recente/i);
  assert.equal((await (await fetch(`${BASE}/api/veiculos`)).json()).find(v => v.placa === alvo.placa).modelo, 'Edição concorrente');

  for (const placa of ['UDO2B34', ...dois]) {
    await fetch(`${BASE}/api/veiculos/${placa}`, { method: 'DELETE', headers: ORIG });
  }
});

test('desfazer em sequência: cada clique reverte uma alteração a mais, da mais recente para a mais antiga', async () => {
  const json = { 'Content-Type': 'application/json', ...ORIG };
  const placas = ['USQ1A11', 'USQ2B22', 'USQ3C33'];
  for (const placa of placas) { // três alterações seguidas, em ordem
    const r = await fetch(`${BASE}/api/veiculos`, { method: 'POST', headers: json, body: JSON.stringify({ placa, modelo: 'Sequência', status: 'EM ATIVIDADE' }) });
    assert.equal(r.status, 201);
    await esperarUndoDisponivel('frota');
  }
  let st = await esperarUndoDisponivel('frota');
  assert.ok(st.restantes >= 3, `status deve contar a pilha inteira (veio ${st.restantes})`);
  const veiculos = async () => (await (await fetch(`${BASE}/api/veiculos`)).json()).map(v => v.placa);
  // 1º clique: só a última (USQ3) volta; as duas anteriores continuam
  let r = await fetch(`${BASE}/api/desfazer/ultimo`, { method: 'POST', headers: json, body: JSON.stringify({ area: 'frota' }) });
  assert.equal(r.status, 200);
  let d = await r.json();
  assert.ok(d.restantes >= 2, 'a resposta informa quantas ainda podem ser desfeitas');
  assert.match(d.mensagem, /restante/i);
  let lista = await veiculos();
  assert.ok(!lista.includes('USQ3C33') && lista.includes('USQ2B22') && lista.includes('USQ1A11'));
  // 2º clique: USQ2
  r = await fetch(`${BASE}/api/desfazer/ultimo`, { method: 'POST', headers: json, body: JSON.stringify({ area: 'frota' }) });
  assert.equal(r.status, 200);
  lista = await veiculos();
  assert.ok(!lista.includes('USQ2B22') && lista.includes('USQ1A11'));
  // 3º clique: USQ1
  r = await fetch(`${BASE}/api/desfazer/ultimo`, { method: 'POST', headers: json, body: JSON.stringify({ area: 'frota' }) });
  assert.equal(r.status, 200);
  lista = await veiculos();
  assert.ok(!lista.includes('USQ1A11'), 'a terceira alteração também foi desfeita');
  // o status reflete a pilha esvaziando (pode sobrar undo de testes anteriores, por isso só checa a queda)
  const depois = await (await fetch(`${BASE}/api/desfazer/status?area=frota`)).json();
  assert.ok(!depois.disponivel || depois.restantes <= st.restantes - 3, 'a pilha encolheu em 3');
});

test('desfazer importação inicial restaura Investimentos e Custos ao estado vazio', async () => {
  const json = { 'Content-Type': 'application/json', ...ORIG };
  let r = await fetch(`${BASE}/api/investimentos/importar`, {
    method: 'POST',
    headers: json,
    body: JSON.stringify({
      meta: { data_base: '2026-07-24', gerado_em: '', fonte_posicao: 'teste', contagens: {} },
      resumo: {},
      posicoes_abertas: [],
      encerradas: [],
      historico: [],
    }),
  });
  assert.equal(r.status, 200);
  r = await fetch(`${BASE}/api/desfazer/ultimo`, {
    method: 'POST', headers: json, body: JSON.stringify({ area: 'investimentos' }),
  });
  assert.equal(r.status, 200);
  assert.equal(await (await fetch(`${BASE}/api/investimentos`)).json(), null);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['FORNECEDOR', 'DATA', 'DESCRIÇÃO', 'VALOR', 'CATEGORIA', 'CENTRO DE CUSTO', 'CONTA PAGAMENTO'],
    ['Fornecedor teste', '2026-07-24', 'Teste de undo', 10, 'Teste', 'ATLAS', 'Conta'],
  ]), 'CONTA AZUL - CUSTOS');
  const fd = new FormData();
  fd.append('arquivo', new Blob([XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })]), 'custos.xlsx');
  r = await fetch(`${BASE}/api/custos/importar`, { method: 'POST', headers: ORIG, body: fd });
  assert.equal(r.status, 200);
  r = await fetch(`${BASE}/api/desfazer/ultimo`, {
    method: 'POST', headers: json, body: JSON.stringify({ area: 'custos' }),
  });
  assert.equal(r.status, 200);
  assert.equal(await (await fetch(`${BASE}/api/custos`)).json(), null);
});


test('Contratos importa o mesmo formato atual gerado pela exportação', async () => {
  const cab = ['DATA EMISSÃO', 'BANCO', 'PRODUTO', 'GRUPO', 'COTA', 'DESCRIÇÃO', 'EMPRESA', 'LOCAL DO CARRO', 'PARC', 'TOTAL PARC', 'PAGAS', 'FALTANTES', 'VALOR PARCELA', 'SALDO QUITAÇÃO', 'DESC. QUITAÇÃO', 'DESC. R$', 'VCTO', 'DT PAGTO', 'ESCRITÓRIO', 'VALOR PAGO', 'C/C', 'NA JUSTIÇA'];
  const linhas = [
    cab,
    ['01/07/2026', 'Disal', 'Consórcio', '9780', '440', 'Carta Ranger', 'SUL', 'Ranger ABC1D23', '1/60', 60, 0, 60, 2100, 126000, '', 0, '10/08/2026', '', '', 0, '1234', 'Não'],
    ['01/07/2026', 'Caixa', 'Empréstimo', '', '', 'Capital de giro', 'NTE', 'SEM GARANTIA', '3/24', 24, 2, 22, 5200, 114400, '', 0, '10/09/2026', '', 'Caixa', 0, '', 'Sim'],
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), 'CONTRATOS');
  const arquivo = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fd = new FormData();
  fd.append('arquivo', new Blob([arquivo], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'CONTRATOS.xlsx');
  const r = await fetch(`${BASE}/api/contratos/importar`, { method: 'POST', headers: ORIG, body: fd });
  assert.equal(r.status, 200, await r.text());
  const lista = await (await fetch(`${BASE}/api/contratos`)).json();
  assert.equal(lista.length, 2);
  assert.deepEqual([lista[0].grupo, lista[0].cota, lista[0].banco], ['9780', '440', 'Disal']);
  assert.equal(lista[1].naJustica, true);
});

test('fornecedor persiste e atualiza somente emojis permitidos', async () => {
  let r = await fetch(`${BASE}/api/fornecedores`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Fornecedor Emoji', tipo: 'Oficina', emoji: '🏪' }),
  });
  assert.equal(r.status, 201);
  const criado = await r.json();
  assert.equal(criado.emoji, '🏪');

  r = await fetch(`${BASE}/api/fornecedores/${encodeURIComponent(criado.id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ ...criado, emoji: '🧰' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).emoji, '🧰');

  r = await fetch(`${BASE}/api/fornecedores`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Fornecedor Inválido', tipo: 'Outros', emoji: '<svg>' }),
  });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).emoji, '', 'texto arbitrário não pode virar ícone');

  r = await fetch(`${BASE}/api/fornecedores`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ nome: 'Fornecedor Pneu Legado', tipo: 'Pneus', emoji: '🛞' }),
  });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).emoji, '⚫', 'o emoji de pneu sem suporte deve ser convertido para o símbolo compatível');
});

test('instalação exige foto; mídia some em cascata e volta com o undo', async () => {
  // sem foto → 400
  let r = await fetch(`${BASE}/api/instalacoes`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ numeroSerie: 'X' }) });
  assert.equal(r.status, 400);
  // upload de um PNG 1x1
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'p.png');
  r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
  assert.equal(r.status, 201);
  const mid = await r.json();
  assert.ok(mid.id);
  assert.equal((await fetch(`${BASE}/api/midia/${mid.id}`)).status, 200);
  // cria instalação com a foto e exclui
  r = await fetch(`${BASE}/api/instalacoes`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ numeroSerie: 'X', fotos: [{ id: mid.id, nome: 'p.png', tipo: 'image/png' }] }) });
  assert.equal(r.status, 201);
  const inst = await r.json();
  assert.equal((await fetch(`${BASE}/api/instalacoes/${inst.id}`, { method: 'DELETE', headers: { ...ORIG } })).status, 200);
  // a mídia foi removida junto
  assert.equal((await fetch(`${BASE}/api/midia/${mid.id}`)).status, 404);
  // desfazer restaura tanto o registro quanto o binário que foi para a quarentena
  r = await fetch(`${BASE}/api/desfazer/ultimo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ area: 'instalacoes' }),
  });
  assert.equal(r.status, 200);
  assert.ok((await (await fetch(`${BASE}/api/instalacoes`)).json()).some(x => x.id === inst.id));
  assert.equal((await fetch(`${BASE}/api/midia/${mid.id}`)).status, 200);
  // limpeza do cenário
  assert.equal((await fetch(`${BASE}/api/instalacoes/${inst.id}`, { method: 'DELETE', headers: { ...ORIG } })).status, 200);
});

test('cofre criptografa a senha, omite o segredo da lista e permite revelação auditada', async () => {
  const senhaAberta = 'Teste-super-secreto-2026!';
  let r = await fetch(`${BASE}/api/senhas`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ servico: 'E-mail teste', categoria: 'E-mail', usuario: 'teste@empresa.com', senha: senhaAberta }) });
  assert.equal(r.status, 201);
  const criado = await r.json();
  assert.equal(criado.temSegredo, true);
  assert.equal(Object.hasOwn(criado, 'segredo'), false);
  const lista = await (await fetch(`${BASE}/api/senhas`)).json();
  assert.equal(Object.hasOwn(lista[0], 'segredo'), false);
  const disco = fs.readFileSync(path.join(tmp, 'senhas.json'), 'utf8');
  assert.equal(disco.includes(senhaAberta), false, 'a senha aberta nunca deve ser persistida');
  assert.match(disco, /"iv"|"dados"/);
  r = await fetch(`${BASE}/api/senhas/${encodeURIComponent(criado.id)}/segredo`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).senha, senhaAberta);
  assert.match(r.headers.get('cache-control') || '', /no-store/);

  r = await fetch(`${BASE}/api/senhas/${encodeURIComponent(criado.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ servico: 'E-mail teste', categoria: 'Infraestrutura', usuario: 'teste@empresa.com' }) });
  assert.equal(r.status, 200);
  r = await fetch(`${BASE}/api/senhas/${encodeURIComponent(criado.id)}/segredo`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).senha, senhaAberta, 'editar sem informar nova senha deve preservar o segredo existente');
  let categorias = await (await fetch(`${BASE}/api/senhas/categorias`)).json();
  assert.ok(categorias.personalizadas.includes('Infraestrutura'));
  assert.equal(categorias.usos.Infraestrutura, 1);
  r = await fetch(`${BASE}/api/senhas/categorias/${encodeURIComponent('Infraestrutura')}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ nome: 'Sistemas internos' }) });
  assert.equal(r.status, 200);
  assert.equal((await (await fetch(`${BASE}/api/senhas`)).json())[0].categoria, 'Sistemas internos');
  r = await fetch(`${BASE}/api/senhas/categorias/${encodeURIComponent('Sistemas internos')}`, { method: 'DELETE', headers: { ...ORIG } });
  assert.equal(r.status, 200); assert.equal((await r.json()).movidas, 1);
  assert.equal((await (await fetch(`${BASE}/api/senhas`)).json())[0].categoria, 'Sem categoria');
});

test('cofre aceita credencial sem nenhum campo preenchido', async () => {
  let r = await fetch(`${BASE}/api/senhas`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({})
  });
  assert.equal(r.status, 201);
  const criado = await r.json();
  assert.equal(criado.servico, '');
  assert.equal(criado.categoria, 'Sem categoria');
  assert.equal(criado.usuario, '');
  assert.equal(criado.temSegredo, false);

  r = await fetch(`${BASE}/api/senhas/${encodeURIComponent(criado.id)}/segredo`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).senha, '');

  r = await fetch(`${BASE}/api/senhas/${encodeURIComponent(criado.id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ servico: '', categoria: '', usuario: '', senha: '' })
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).categoria, 'Sem categoria');
});

test('documento empresarial sobe, lista e remove também o arquivo', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData(); fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'contrato.png');
  let r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
  assert.equal(r.status, 201); const arquivo = await r.json();
  // Documento agora vive dentro de uma PASTA (o antigo par empresa/empresaIcone saiu do modelo).
  r = await fetch(`${BASE}/api/documentos/pastas`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ nome: 'NTE' }) });
  assert.equal(r.status, 201); const pasta = await r.json();
  r = await fetch(`${BASE}/api/documentos`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ pastaId: pasta.id, titulo: 'Contrato social', categoria: 'Contrato', validade: '2030-12-31', arquivo }) });
  assert.equal(r.status, 201); const doc = await r.json();
  assert.equal(doc.pastaId, pasta.id);
  assert.equal(doc.categoria, 'Contrato');
  assert.equal((await fetch(`${BASE}/api/midia/${arquivo.id}`)).status, 200);
  const estrutura = await (await fetch(`${BASE}/api/documentos`)).json();
  assert.ok(estrutura.documentos.some(d => d.id === doc.id));
  assert.ok(estrutura.pastas.some(p => p.id === pasta.id));
  // Pasta inexistente é recusada — senão o documento fica órfão, invisível na árvore.
  r = await fetch(`${BASE}/api/documentos`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ pastaId: 'DP-nao-existe', titulo: 'Solto', arquivo }) });
  assert.equal(r.status, 400);
  const fd2 = new FormData(); fd2.append('arquivo', new Blob([png], { type: 'image/png' }), 'certidao.png');
  r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd2 });
  assert.equal(r.status, 201); const arquivo2 = await r.json();
  r = await fetch(`${BASE}/api/documentos`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ pastaId: pasta.id, titulo: 'Certidão', categoria: 'Certidão', arquivo: arquivo2 }) });
  assert.equal(r.status, 201); const doc2 = await r.json();
  // Renomear a pasta não mexe nos documentos: eles apontam para o id, não para o nome.
  r = await fetch(`${BASE}/api/documentos/pastas/${encodeURIComponent(pasta.id)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ nome: 'Norte Engenharia' }) });
  assert.equal(r.status, 200); assert.equal((await r.json()).nome, 'Norte Engenharia');
  const renomeada = await (await fetch(`${BASE}/api/documentos`)).json();
  assert.equal(renomeada.pastas.find(p => p.id === pasta.id).nome, 'Norte Engenharia');
  assert.ok(renomeada.documentos.filter(d => d.id === doc.id || d.id === doc2.id).every(d => d.pastaId === pasta.id));
  // Pasta com documento dentro não se apaga por acidente.
  assert.equal((await fetch(`${BASE}/api/documentos/pastas/${encodeURIComponent(pasta.id)}`, { method: 'DELETE', headers: { ...ORIG } })).status, 409);
  assert.equal((await fetch(`${BASE}/api/documentos/${encodeURIComponent(doc.id)}`, { method: 'DELETE', headers: { ...ORIG } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/documentos/${encodeURIComponent(doc2.id)}`, { method: 'DELETE', headers: { ...ORIG } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${arquivo.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/midia/${arquivo2.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/documentos/pastas/${encodeURIComponent(pasta.id)}`, { method: 'DELETE', headers: { ...ORIG } })).status, 200);
});

test('anexo do feedback dura enquanto o registro existe e é removido junto', async () => {
  const postFeedback = (body) => fetch(`${BASE}/api/feedbacks`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify(body),
  });
  let invalido = await postFeedback({ titulo: 'Curto', descricao: 'Descrição suficientemente detalhada.', imagens: [{ id: 'inexistente' }] });
  assert.equal(invalido.status, 400);
  assert.match((await invalido.json()).erro, /título.*10/i);
  invalido = await postFeedback({ titulo: 'Título suficiente', descricao: 'Muito curta', imagens: [{ id: 'inexistente' }] });
  assert.equal(invalido.status, 400);
  assert.match((await invalido.json()).erro, /descrição.*20/i);
  invalido = await postFeedback({ titulo: 'Título suficiente', descricao: 'Descrição suficientemente detalhada.' });
  assert.equal(invalido.status, 400);
  assert.match((await invalido.json()).erro, /ao menos uma imagem/i);
  invalido = await postFeedback({ titulo: 'Título suficiente', descricao: 'Descrição suficientemente detalhada.', imagens: [{ id: 'inexistente' }] });
  assert.equal(invalido.status, 400);
  assert.match((await invalido.json()).erro, /não foi encontrado|não é uma imagem válida/i);

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'feedback.png');
  let r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
  assert.equal(r.status, 201);
  const mid = await r.json();

  r = await postFeedback({
    titulo: 'Feedback com anexo', descricao: 'Descrição completa para testar o ciclo do anexo.',
    imagens: [{ id: mid.id, nome: mid.nome, tipo: mid.tipo }],
  });
  assert.equal(r.status, 201);
  const feedback = await r.json();
  assert.equal(feedback.imagens[0].id, mid.id);

  // Simula um anexo antigo: mesmo acima da carência de 1 hora, a limpeza não pode considerar
  // uma imagem ainda referenciada pelo feedback como órfã.
  const arquivoMidia = path.join(tmp, 'uploads', `${mid.id}.json`);
  const midiaSalva = JSON.parse(fs.readFileSync(arquivoMidia, 'utf8'));
  midiaSalva.ts = Date.now() - (2 * 60 * 60 * 1000);
  fs.writeFileSync(arquivoMidia, JSON.stringify(midiaSalva));
  r = await fetch(`${BASE}/api/midia/limpar-orfas`, { method: 'POST', headers: { ...ORIG } });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${mid.id}`)).status, 200);

  r = await fetch(`${BASE}/api/feedbacks/${encodeURIComponent(feedback.id)}`, { method: 'DELETE', headers: { ...ORIG } });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${mid.id}`)).status, 404);
});

test('documento do formulário de admissão sobrevive à limpeza de mídia órfã e entra no backup (regressão)', async () => {
  // Os anexos do convite (`docs` / `docsPendentes`) estavam FORA de midiasReferenciadas(): a
  // faxina diária os apagava ~1h depois do envio e o "Baixar tudo (.zip)" respondia "não estão
  // mais no cofre" (relato real de 24/08/2026, dois colaboradores). Como coletarMidias() usa a
  // mesma lista, eles também nunca entravam no backup — restaurar não trazia nada de volta.
  const convite = (await (await fetch(`${BASE}/api/admissao`, {
    method: 'POST', headers: { ...ORIG, 'Content-Type': 'application/json' },
    body: JSON.stringify({ nome: 'CANDIDATO ANEXO', empresa: 'NTE', dias: 7 }),
  })).json()).admissao;

  const fd = new FormData();
  fd.append('arquivo', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), 'rg.pdf');
  fd.append('chave', 'rg');
  let r = await fetch(`${BASE}/api/admissao/publico/${convite.token}/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
  assert.equal(r.status, 201);
  const doc = await r.json();

  // Ainda em rascunho (docsPendentes): já não pode ser tratado como órfão.
  const envelhecer = (id) => {
    const arq = path.join(tmp, 'uploads', `${id}.json`);
    const m = JSON.parse(fs.readFileSync(arq, 'utf8'));
    m.ts = Date.now() - (2 * 60 * 60 * 1000);
    fs.writeFileSync(arq, JSON.stringify(m));
  };
  envelhecer(doc.id);
  assert.equal((await fetch(`${BASE}/api/midia/limpar-orfas`, { method: 'POST', headers: { ...ORIG } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${doc.id}`)).status, 200, 'anexo em rascunho não pode ser apagado pela faxina');

  r = await fetch(`${BASE}/api/admissao/publico/${convite.token}`, {
    method: 'POST', headers: { ...ORIG, 'Content-Type': 'application/json' },
    body: JSON.stringify({ resposta: { nome: 'CANDIDATO ANEXO', cpf: '' }, docIds: [doc.id] }),
  });
  assert.equal(r.status, 200);

  envelhecer(doc.id);
  assert.equal((await fetch(`${BASE}/api/midia/limpar-orfas`, { method: 'POST', headers: { ...ORIG } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${doc.id}`)).status, 200, 'anexo já enviado não pode ser apagado pela faxina');

  // O .zip da revisão continua saindo com o arquivo (era ele que respondia 404).
  r = await fetch(`${BASE}/api/admissao/${encodeURIComponent(convite.id)}/documentos/zip`);
  assert.equal(r.status, 200, 'o "Baixar tudo" não pode mais responder que os arquivos sumiram');

  // E o backup leva o anexo na pasta própria (grupo funcionarios), não em files/outros.
  r = await fetch(`${BASE}/api/backup/gerar`, { headers: { ...ORIG } });
  assert.equal(r.status, 200);
  const texto = Buffer.from(await r.arrayBuffer()).toString('latin1');
  assert.ok(texto.includes('files/admissao/'), 'o anexo do formulário precisa ir para files/admissao no .zip');
});

test('versão anterior de documento de funcionário sobrevive à limpeza de mídia órfã (regressão)', async () => {
  const subirDoc = async (nome) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), nome);
    const r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
    assert.equal(r.status, 201);
    return r.json();
  };
  const v1 = await subirDoc('v1.pdf');
  const v2 = await subirDoc('v2.pdf');
  let r = await fetch(`${BASE}/api/funcionarios`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({
      nome: 'Teste Versao Doc',
      documentos: [{
        id: v2.id, nome: 'ASO', tipo: v2.tipo, categoria: 'Segurança', semValidade: true,
        versoes: [{ id: v1.id, nome: 'ASO', tipo: v1.tipo, nomeOriginal: 'v1.pdf', uploadTs: Date.now(), substituidoTs: Date.now(), substituidoPor: 'Teste' }],
      }],
    }),
  });
  assert.equal(r.status, 201);
  const func = await r.json();
  assert.equal(func.documentos[0].versoes.length, 1);

  // Simula uma versão arquivada há mais de 1h: a limpeza diária não pode tratá-la como órfã
  // só porque ela não é mais o arquivo ATIVO (bug real: v1.43.2 apagava essas versões).
  const arquivoMidia = path.join(tmp, 'uploads', `${v1.id}.json`);
  const midiaSalva = JSON.parse(fs.readFileSync(arquivoMidia, 'utf8'));
  midiaSalva.ts = Date.now() - (2 * 60 * 60 * 1000);
  fs.writeFileSync(arquivoMidia, JSON.stringify(midiaSalva));
  r = await fetch(`${BASE}/api/midia/limpar-orfas`, { method: 'POST', headers: { ...ORIG } });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${v1.id}`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${v2.id}`)).status, 200);

  // Excluir o funcionário apaga as duas versões (atual + arquivada) — nada deve sobrar órfão.
  r = await fetch(`${BASE}/api/funcionarios/${encodeURIComponent(func.id)}`, { method: 'DELETE', headers: { ...ORIG } });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${v1.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/midia/${v2.id}`)).status, 404);
});

test('excluir versão anterior de documento: some do cadastro e do cofre, recusa a atual, audita e volta com o undo', async () => {
  const subirDoc = async (nome) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob([Buffer.from('%PDF-1.4\n%%EOF')], { type: 'application/pdf' }), nome);
    const r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
    assert.equal(r.status, 201);
    return r.json();
  };
  const v1 = await subirDoc('aso-v1.pdf');
  const v2 = await subirDoc('aso-v2.pdf');
  let r = await fetch(`${BASE}/api/funcionarios`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({
      nome: 'Teste Excluir Versao',
      documentos: [{
        id: v2.id, nome: 'ASO', tipo: v2.tipo, categoria: 'Segurança', semValidade: true,
        versoes: [{ id: v1.id, nome: 'ASO', tipo: v1.tipo, nomeOriginal: 'aso-v1.pdf', uploadTs: Date.now(), substituidoTs: Date.now(), substituidoPor: 'Teste' }],
      }],
    }),
  });
  assert.equal(r.status, 201);
  const func = await r.json();
  const rota = (docId, midiaId) => `${BASE}/api/funcionarios/${encodeURIComponent(func.id)}/documentos/${encodeURIComponent(docId)}/versoes/${encodeURIComponent(midiaId)}`;

  // 2) o arquivo ATUAL nunca sai por aqui
  r = await fetch(rota(v2.id, v2.id), { method: 'DELETE', headers: { ...ORIG } });
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro, /versão atual não pode ser excluída/i);
  assert.equal((await fetch(`${BASE}/api/midia/${v2.id}`)).status, 200);
  // 3) versão/documento inexistentes
  assert.equal((await fetch(rota(v2.id, 'MD-nao-existe'), { method: 'DELETE', headers: { ...ORIG } })).status, 404);
  assert.equal((await fetch(rota('MD-doc-nao-existe', v1.id), { method: 'DELETE', headers: { ...ORIG } })).status, 404);

  // 1) exclui a versão antiga: cadastro sem ela, mídia v1 some, v2 (atual) continua
  r = await fetch(rota(v2.id, v1.id), { method: 'DELETE', headers: { ...ORIG } });
  assert.equal(r.status, 200);
  const resp = await r.json();
  assert.equal(resp.ok, true);
  assert.equal(resp.documento.id, v2.id);
  assert.deepEqual(resp.documento.versoes, []);
  const lerFunc = async () => (await (await fetch(`${BASE}/api/funcionarios`)).json()).find(x => x.id === func.id);
  assert.deepEqual((await lerFunc()).documentos[0].versoes, []);
  assert.equal((await fetch(`${BASE}/api/midia/${v1.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/midia/${v2.id}`)).status, 200);

  // 4) trilha: histórico do colaborador diz qual versão saiu
  r = await fetch(`${BASE}/api/historico?limite=50`);
  assert.equal(r.status, 200);
  const hist = await r.json();
  assert.ok(hist.some(h => h.funcId === func.id && /Excluiu a versão anterior "aso-v1\.pdf".*do documento "ASO"/.test(h.texto || '')), 'histórico deveria registrar a exclusão da versão');

  // 5) desfazer: a versão volta ao cadastro e o binário sai da quarentena
  await esperarUndoDisponivel('funcionarios');
  r = await fetch(`${BASE}/api/desfazer/ultimo`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ area: 'funcionarios' }),
  });
  assert.equal(r.status, 200);
  assert.equal((await lerFunc()).documentos[0].versoes.map(v => v.id).join(), v1.id);
  assert.equal((await fetch(`${BASE}/api/midia/${v1.id}`)).status, 200);

  // limpeza do cenário
  r = await fetch(`${BASE}/api/funcionarios/${encodeURIComponent(func.id)}`, { method: 'DELETE', headers: { ...ORIG } });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${v1.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/midia/${v2.id}`)).status, 404);
});

test('anexo de multa sobrevive à limpeza de mídia órfã, some com a multa e sai em .zip', async () => {
  const subir = async (nome, tipo, conteudo) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob([Buffer.from(conteudo)], { type: tipo }), nome);
    const r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
    assert.equal(r.status, 201);
    return r.json();
  };
  const v1 = await subir('notificacao-v1.pdf', 'application/pdf', '%PDF-1.4\n%%EOF');
  const v2 = await subir('notificacao-v2.pdf', 'application/pdf', '%PDF-1.4\n%%EOF v2');
  const boleto = await subir('boleto.pdf', 'application/pdf', '%PDF-1.4\n%%EOF boleto');
  let r = await fetch(`${BASE}/api/multas`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({
      placa: 'ANX1A23', autoInfracao: 'AI-ANEXO', valor: 130.16,
      documentos: [
        { id: v2.id, nome: 'Notificação', tipo: v2.tipo, categoria: 'Notificação', nomeOriginal: 'notificacao-v2.pdf',
          versoes: [{ id: v1.id, nome: 'Notificação', tipo: v1.tipo, nomeOriginal: 'notificacao-v1.pdf', substituidoTs: Date.now(), substituidoPor: 'Teste' }] },
        { id: boleto.id, nome: 'Boleto', tipo: boleto.tipo, categoria: 'Boleto', nomeOriginal: 'boleto.pdf' },
        { id: '', nome: 'Sem arquivo', categoria: 'Outro' }, // descartado: anexo de multa exige arquivo
      ],
    }),
  });
  assert.equal(r.status, 201);
  const multa = await r.json();
  assert.equal(multa.documentos.length, 2, 'anexo sem id não deve ser gravado');
  assert.equal(multa.documentos[0].versoes.length, 1);

  // A limpeza diária não pode tratar o anexo (nem a versão arquivada) como órfão — foi o bug da
  // v1.45.1 com os documentos de locação: sem entrada em midiasReferenciadas o arquivo sumia ~1h
  // depois do upload.
  for (const mid of [v1.id, v2.id, boleto.id]) {
    const arq = path.join(tmp, 'uploads', `${mid}.json`);
    const salva = JSON.parse(fs.readFileSync(arq, 'utf8'));
    salva.ts = Date.now() - (2 * 60 * 60 * 1000);
    fs.writeFileSync(arq, JSON.stringify(salva));
  }
  assert.equal((await fetch(`${BASE}/api/midia/limpar-orfas`, { method: 'POST', headers: { ...ORIG } })).status, 200);
  for (const mid of [v1.id, v2.id, boleto.id]) {
    assert.equal((await fetch(`${BASE}/api/midia/${mid}`)).status, 200, `mídia ${mid} não deveria ter sido apagada`);
  }

  // .zip dos anexos selecionados
  r = await fetch(`${BASE}/api/multas/${encodeURIComponent(multa.id)}/documentos/zip?ids=${encodeURIComponent(boleto.id)}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') || '', /ANEXOS_MULTA_ANX1A23/);
  const zip = Buffer.from(await r.arrayBuffer());
  assert.equal(zip.slice(0, 2).toString(), 'PK');
  assert.ok(zip.includes(Buffer.from('Boleto.pdf')), 'o zip deve nomear o arquivo pelo nome do anexo');

  // Editar removendo o boleto: só a mídia dele sai do cofre; o histórico da placa registra.
  r = await fetch(`${BASE}/api/multas/${encodeURIComponent(multa.id)}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({ ...multa, documentos: [multa.documentos[0]] }),
  });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${boleto.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/midia/${v2.id}`)).status, 200);
  const hist = await (await fetch(`${BASE}/api/historico?placa=ANX1A23`)).json();
  assert.ok(hist.some((h) => /removeu anexo: Boleto/.test(h.texto || '')), 'remover anexo deve entrar no histórico');

  // Excluir a multa apaga o anexo ativo E a versão arquivada.
  assert.equal((await fetch(`${BASE}/api/multas/${encodeURIComponent(multa.id)}`, { method: 'DELETE', headers: { ...ORIG } })).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${v2.id}`)).status, 404);
  assert.equal((await fetch(`${BASE}/api/midia/${v1.id}`)).status, 404);
});

test('auto-cadastro de entidade + exportações + backup respondem', async () => {
  let r = await fetch(`${BASE}/api/cadastros/responsaveis`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ nome: 'Fulano Teste' }) });
  assert.equal(r.status, 201);
  const cad = await (await fetch(`${BASE}/api/cadastros`)).json();
  assert.ok(cad.responsaveis.includes('Fulano Teste'));
  for (const ep of ['multas', 'rastreadores', 'instalacoes', 'envios']) {
    r = await fetch(`${BASE}/api/${ep}/exportar`);
    assert.equal(r.status, 200, ep + ' exportar');
    assert.match(r.headers.get('content-type') || '', /spreadsheetml/, ep + ' content-type');
  }
  assert.equal((await fetch(`${BASE}/api/backup`)).status, 200);
});

test('catálogo de contratos dos funcionários vem da API sem dados demo', async () => {
  const r = await fetch(`${BASE}/api/funcionarios/contratos`);
  assert.equal(r.status, 200);
  const lista = await r.json();
  assert.ok(Array.isArray(lista), 'contratos deve ser uma lista');
  const texto = JSON.stringify(lista);
  assert.match(texto, /REISOLAMENTO/, 'contrato real de reisolamento deve aparecer');
  assert.match(texto, /ORION/, 'contrato real ORION deve aparecer');
  assert.match(texto, /ATLAS/, 'contrato real ATLAS deve aparecer');
  assert.doesNotMatch(texto, /CONTRATO OBRA|LOGISTICA DEMO|SUL DEMO|NTE DEMO/i, 'dados demo não devem aparecer');
});

test('zip de documentos do funcionário inclui o relatório PDF do colaborador', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const upload = async (nome) => {
    const fd = new FormData();
    fd.append('arquivo', new Blob([png], { type: 'image/png' }), nome);
    const r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
    assert.equal(r.status, 201, 'upload ' + nome);
    return (await r.json()).id;
  };
  const fotoId = await upload('foto.png');
  const docId = await upload('aso.png');
  let r = await fetch(`${BASE}/api/funcionarios`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({
      nome: 'TESTE RELATORIO', cargo: 'Ajudante', empresa: 'NTE',
      foto: { id: fotoId, nome: 'foto.png', tipo: 'image/png' },
      documentos: [{ id: docId, nome: 'ASO', tipo: 'image/png', categoria: 'Segurança', validade: '2027-01-01' }],
    }),
  });
  assert.equal(r.status, 201);
  const func = await r.json();
  // baixa o .zip dos documentos
  r = await fetch(`${BASE}/api/funcionarios/${encodeURIComponent(func.id)}/documentos/zip`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /zip/);
  const zip = Buffer.from(await r.arrayBuffer());
  assert.equal(zip.slice(0, 2).toString('latin1'), 'PK', 'assinatura .zip');
  // zip em modo "store" (sem compressão): nomes e o PDF embutido ficam no buffer cru
  const txt = zip.toString('latin1');
  assert.match(txt, /relatorio_TESTE_RELATORIO\.pdf/, 'relatório PDF presente no zip');
  assert.match(txt, /%PDF-/, 'conteúdo PDF embutido (assinatura %PDF)');
  assert.match(txt, /ASO\.png/, 'documento baixado presente no zip');
  // limpa
  await fetch(`${BASE}/api/funcionarios/${encodeURIComponent(func.id)}`, { method: 'DELETE', headers: { ...ORIG } });
});

test('abastecimento: POST/PUT manual + importar a planilha real (parser)', async () => {
  // inclusão manual
  let r = await fetch(`${BASE}/api/abastecimento`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ placa: 'abc1d23', motorista: 'Fulano', litros: 50, valor: 300, kmRod: 400, kmL: 8, alerta: 'NÃO' }) });
  assert.equal(r.status, 200);
  let lista = await (await fetch(`${BASE}/api/abastecimento`)).json();
  assert.equal(lista.length, 1);
  assert.equal(lista[0].placa, 'ABC1D23'); // placa normalizada p/ maiúsculas
  assert.equal(lista[0].litros, 50);
  // edição inline (motorista)
  r = await fetch(`${BASE}/api/abastecimento/${lista[0].id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...ORIG }, body: JSON.stringify({ motorista: 'Beltrano' }) });
  assert.equal(r.status, 200);

  // importação de planilha real (se existir no projeto) — valida o parser + a mesclagem ponta a ponta.
  // Aceita o export financeiro atual ou a Auditoria antiga; ambos são .xlsx (gitignored → ausentes na CI).
  const candidatos = ['ABASTECIMENTO - SUL.xlsx', 'AUDITORIA_CONSOLIDADA_SUL_NTE.xlsx'];
  const planilha = candidatos.map(n => path.join(__dirname, '..', n)).find(p => fs.existsSync(p));
  if (planilha) {
    const buf = fs.readFileSync(planilha);
    const enviar = () => { const fd = new FormData(); fd.append('arquivos', new Blob([buf]), 'planilha.xlsx'); return fetch(`${BASE}/api/abastecimento/importar`, { method: 'POST', headers: { ...ORIG }, body: fd }); };
    r = await enviar();
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.ok(j.criados > 100, 'esperava centenas de transações importadas, veio ' + j.criados);
    assert.ok(j.veiculos > 10, 'esperava dezenas de veículos, veio ' + j.veiculos);
    lista = await (await fetch(`${BASE}/api/abastecimento`)).json();
    assert.equal(lista.length, j.total, 'total reportado bate com a lista');
    assert.equal(j.total, 1 + j.criados, 'importação MESCLA (mantém a transação manual criada acima)');
    assert.ok(lista.some(t => t.posto && Number(t.valor) > 0 && t.placa), 'linhas importadas têm placa, posto e valor');
    // idempotência: reimportar a MESMA planilha não cria duplicatas
    const j2 = await (await enviar()).json();
    assert.equal(j2.criados, 0, 'reimportar a mesma planilha não deve criar nada, veio ' + j2.criados);
    assert.ok(j2.ignorados >= j.criados, 'reimportar deve marcar as linhas como já existentes');
    const lista2 = await (await fetch(`${BASE}/api/abastecimento`)).json();
    assert.equal(lista2.length, lista.length, 'reimportar não muda o total');
  }
});
