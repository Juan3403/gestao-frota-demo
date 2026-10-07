/**
 * Testes de comportamento dos módulos v1.18 → v1.22 — cada teste implementa uma
 * especificação de test/ESPECIFICACOES.md (o nome começa pelo id da spec).
 * Mesmo harness do smoke: servidor REAL em DATA_DIR temporário, porta própria.
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http'); // TRV-9: parte de vídeo com o corpo chegando aos poucos
const os = require('node:os');
const path = require('node:path');
const archiver = require('archiver');

const PORT = 3198;
const BASE = `http://localhost:${PORT}`;
const ORIG = { Origin: BASE }; // anti-CSRF do servidor exige Origin nas mutações
const JSONH = { 'Content-Type': 'application/json', ...ORIG };
let srv, tmp;
// Estado do processo filho: sem isto, um servidor que morre no boot (EADDRINUSE, variável de
// ambiente faltando...) some em silêncio — o spawn descartava o stderr e ninguém olhava o código
// de saída, então a suíte seguia contra o servidor alheio já de pé na porta.
let srvSaida = null; // código (ou sinal) com que o filho morreu, se morreu
let srvLog = '';     // stderr do filho, para a mensagem de erro dizer o motivo
async function criarDocxTeste() {
  const zip = archiver('zip', { zlib: { level: 1 } });
  const partes = [];
  const pronto = new Promise((resolve, reject) => {
    zip.on('data', (p) => partes.push(p));
    zip.on('end', () => resolve(Buffer.concat(partes)));
    zip.on('error', reject);
  });
  zip.append('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>', { name: '[Content_Types].xml' });
  zip.append('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>', { name: 'word/document.xml' });
  await zip.finalize();
  return pronto;
}

const hoje = new Date();
const emDias = (n) => { const d = new Date(hoje); d.setDate(d.getDate() + n); return d; };
const iso = (d) => d.toISOString().slice(0, 10);
const br = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-mod-test-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    // Sem MONGODB_URI/COBLI_API_KEY/RESEND_API_KEY: specs CB/NT cobrem o modo "não configurado".
    // Vídeos (TRV): sem VIDEO_S3_* o driver é o LOCAL em DATA_DIR/videos; VIDEO_PARTE_BYTES_TESTE
    // encolhe a parte para 1 KiB, para testar envio de várias partes sem mandar 6 MiB cada.
    // E2E_TEST=1 só sobe o teto do rate-limit (600 → 5000 req/min, ver REQ_MAX no server.js):
    // com os TRV a suíte passou de 600 requisições no mesmo minuto e o último teste (CT-16)
    // levava 429 — falha sem relação nenhuma com o que ele testa.
    env: { ...process.env, DATA_DIR: tmp, PORT: String(PORT), APP_PASSWORD: '', SENHA_ADMIN: '', MONGODB_URI: '', COBLI_API_KEY: '', RESEND_API_KEY: '', NOTIF_EMAIL_PARA: '', E2E_TEST: '1',
      VIDEO_S3_ENDPOINT: '', VIDEO_S3_REGION: '', VIDEO_S3_BUCKET: '', VIDEO_S3_KEY_ID: '', VIDEO_S3_KEY_SECRET: '', VIDEO_PARTE_BYTES_TESTE: '1024' },
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

async function subirFoto(nome = 'foto.png') {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), nome);
  const r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { ...ORIG }, body: fd });
  assert.equal(r.status, 201, 'upload de mídia deve responder 201');
  return r.json();
}

// ===================== VL — Vencimentos legais do veículo =====================

test('VL-1: vencimentos ISO e apólice persistem como enviados', async () => {
  const r = await post('/api/veiculos', {
    placa: 'VLA1A11', modelo: 'Teste',
    ipvaVenc: iso(emDias(40)), licencVenc: iso(emDias(80)), seguroVenc: iso(emDias(120)),
    seguroApolice: 'Porto Seguro · nº 998877',
  });
  assert.equal(r.status, 201);
  const v = (await getj('/api/veiculos')).find((x) => x.placa === 'VLA1A11');
  assert.equal(v.ipvaVenc, iso(emDias(40)));
  assert.equal(v.licencVenc, iso(emDias(80)));
  assert.equal(v.seguroVenc, iso(emDias(120)));
  assert.equal(v.seguroApolice, 'Porto Seguro · nº 998877');
});

test('VL-2: vencimento em formato inválido é gravado vazio', async () => {
  const r = await post('/api/veiculos', { placa: 'VLB2B22', modelo: 'Teste', ipvaVenc: '15/06/2026', licencVenc: 'mês que vem' });
  assert.equal(r.status, 201);
  const v = (await getj('/api/veiculos')).find((x) => x.placa === 'VLB2B22');
  assert.equal(v.ipvaVenc, '');
  assert.equal(v.licencVenc, '');
});

test('VL-3: alterar um vencimento entra no histórico da placa', async () => {
  const v = (await getj('/api/veiculos')).find((x) => x.placa === 'VLA1A11');
  const r = await put('/api/veiculos/VLA1A11', { ...v, ipvaVenc: iso(emDias(45)) });
  assert.equal(r.status, 200);
  const hist = await getj('/api/historico?placa=VLA1A11');
  assert.ok(hist.some((h) => /IPVA/i.test(h.texto || '')), 'histórico deve citar o IPVA alterado');
});

// ===================== FP — FIPE automática =====================

test('FP-1: sincronizar FIPE com modelos desconhecidos responde ok sem tocar a rede', async () => {
  const r = await post('/api/veiculos/fipe/atualizar', {});
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.atualizados, 0);
  assert.equal(d.vinculados, 0, 'modelo fora do mapa de marcas não deve ser vinculado');
  assert.ok(Array.isArray(d.revisar) && d.revisar.length >= 2, 'os veículos sem vínculo entram na lista de revisão');
});

test('FP-2: vínculo FIPE persiste e fipeTipo inválido cai para carros', async () => {
  const r = await post('/api/veiculos', { placa: 'FPC3C33', modelo: 'Teste', codigoFipe: '002038-9', fipeTipo: 'bicicletas', fipeAno: '1995-1' });
  assert.equal(r.status, 201);
  const v = (await getj('/api/veiculos')).find((x) => x.placa === 'FPC3C33');
  assert.equal(v.codigoFipe, '002038-9');
  assert.equal(v.fipeAno, '1995-1');
  assert.equal(v.fipeTipo, 'carros', 'tipo inválido deve cair para carros');
});

// ===================== CT — Contratos em lote =====================

test('CT-1: lote-editar altera a descrição dos lançamentos selecionados', async () => {
  const a = await (await post('/api/contratos', { banco: 'Banco CT', material: 'Descrição antiga A' })).json();
  const b = await (await post('/api/contratos', { banco: 'Banco CT', material: 'Descrição antiga B' })).json();
  const r = await post('/api/contratos/lote-editar', {
    ids: [a.id, b.id],
    campos: { material: 'Descrição atualizada em lote' },
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).alterados, 2);
  const lista = await getj('/api/contratos');
  for (const id of [a.id, b.id]) {
    const item = lista.find((c) => c.id === id);
    assert.equal(item.material, 'Descrição atualizada em lote');
    assert.equal(item.banco, 'Banco CT', 'campos não enviados devem permanecer intactos');
  }
});

test('CT-1b: lote-editar com totalParcelas renumera N/M → N/novo, preserva pagamento e devolve as excedentes sem apagar', async () => {
  const base = { banco: 'Banco CT Total', produto: 'Consórcio', empresa: 'NTE', grupo: 'CT77', cota: '9', valorParcela: 100 };
  const criadas = [];
  for (let n = 1; n <= 6; n++) {
    const extra = n <= 2 ? { dataPagamento: `1${n}/01/2026`, valorPago: 100 } : {};
    criadas.push(await (await post('/api/contratos', { ...base, parcela: `${n}/6`, vencimento: `1${n}/0${n}/2026`, ...extra })).json());
  }
  const invalido = await post('/api/contratos/lote-editar', { ids: criadas.map(c => c.id), campos: { totalParcelas: 0 } });
  assert.equal(invalido.status, 400, 'total 0 é recusado');
  const r = await post('/api/contratos/lote-editar', { ids: criadas.map(c => c.id), campos: { totalParcelas: 4 } });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.alterados, 4, 'só as parcelas 1..4 são renumeradas');
  assert.deepEqual(j.excedentes.map(x => x.parcela).sort(), ['05/06', '06/06'], 'as acima do novo total voltam em excedentes');
  const lista = await getj('/api/contratos');
  const por = (id) => lista.find(c => c.id === id);
  assert.equal(por(criadas[0].id).parcela, '01/04');
  assert.equal(por(criadas[3].id).parcela, '04/04');
  assert.equal(por(criadas[0].id).totalParcelas, 4);
  assert.equal(por(criadas[0].id).dataPagamento, '11/01/2026', 'pagamento preservado');
  assert.equal(por(criadas[2].id).vencimento, '13/03/2026', 'vencimento intacto');
  assert.ok(por(criadas[4].id) && por(criadas[4].id).parcela === '05/06', 'excedente NÃO é apagada nem alterada pelo lote-editar');
  assert.ok(por(criadas[5].id) && por(criadas[5].id).parcela === '06/06');
});

test('CT-2: lote-criar ignora parcela já existente na mesma série', async () => {
  const base = {
    banco: 'Banco CT Série',
    produto: 'Consórcio',
    empresa: 'NTE',
    grupo: 'CT54',
    cota: '99',
    parcela: '53/54',
    material: 'Descrição antiga',
  };
  const existente = await post('/api/contratos', base);
  assert.equal(existente.status, 201);

  const r = await post('/api/contratos/lote-criar', {
    itens: [
      { ...base, material: 'Descrição atualizada' },
      { ...base, parcela: '54/54', material: 'Descrição atualizada' },
    ],
  });
  assert.equal(r.status, 201);
  assert.deepEqual(await r.json(), { criados: 1, ignorados: 1 });
  const serie = (await getj('/api/contratos')).filter((c) => c.grupo === base.grupo && c.cota === base.cota);
  assert.deepEqual(serie.map((c) => c.parcela).sort(), ['53/54', '54/54']);
});

test('CT-3: completar-series preenche todos os contratos, padroniza N/M e não duplica', async () => {
  const serieA = {
    banco: 'Banco CT Global A', produto: 'Consórcio', empresa: 'NTE',
    grupo: 'CT-A', cota: '1', material: 'Carta A', parcela: '2/4',
    vencimento: '15/08/2026', valorParcela: 100,
  };
  const serieB = {
    banco: 'Banco CT Global B', produto: 'Financiamento', empresa: 'SUL',
    grupo: 'CT-B', cota: '2', material: 'Veículo B', parcela: '2/3',
    vencimento: '31/01/2026', valorParcela: 200,
  };
  const criadoA = await (await post('/api/contratos', serieA)).json();
  const criadoB = await (await post('/api/contratos', serieB)).json();
  assert.equal(criadoA.parcela, '02/04');
  assert.equal(criadoB.parcela, '02/03');

  const r = await post('/api/contratos/completar-series', {});
  assert.equal(r.status, 201);
  const resultado = await r.json();
  assert.ok(resultado.criadas >= 5);
  assert.ok(resultado.series >= 2);

  const lista = await getj('/api/contratos');
  const a = lista.filter(c => c.grupo === serieA.grupo).sort((x, y) => x.parcela.localeCompare(y.parcela));
  const b = lista.filter(c => c.grupo === serieB.grupo).sort((x, y) => x.parcela.localeCompare(y.parcela));
  assert.deepEqual(a.map(c => [c.parcela, c.vencimento]), [
    ['01/04', '15/07/2026'], ['02/04', '15/08/2026'],
    ['03/04', '15/09/2026'], ['04/04', '15/10/2026'],
  ]);
  assert.deepEqual(b.map(c => [c.parcela, c.vencimento]), [
    ['01/03', '31/12/2025'], ['02/03', '31/01/2026'], ['03/03', '28/02/2026'],
  ]);
  assert.equal(a.find(c => c.parcela === '01/04').valorPago, 100, 'parcela anterior deve ser criada como paga');
  assert.equal(a.find(c => c.parcela === '03/04').valorPago, 0, 'parcela futura deve continuar pendente');
  assert.equal(a.find(c => c.parcela === '03/04').parcelasPagas, 1);
  assert.equal(a.find(c => c.parcela === '03/04').parcelasFaltantes, 3);

  const repetido = await post('/api/contratos/completar-series', {});
  assert.deepEqual(await repetido.json(), {
    criadas: 0, padronizadas: 0, series: 0, removidas: 0, ignoradas: 0,
    sobrepostas: 0, sobreposicoes: [], avisos: [],
  });
});

test('CT-4: completar-series usa a linha mais atual como modelo e RELATA a sobreposta sem apagar', async () => {
  const comum = {
    banco: 'Banco CT Mesmo Grupo', produto: 'Consórcio', empresa: 'SUL',
    grupo: 'CT-REUSO', cota: '7', parcela: '2/3', vencimento: '10/08/2026', valorParcela: 300,
  };
  const antiga = await (await post('/api/contratos', { ...comum, material: 'Carta antiga' })).json();
  await post('/api/contratos', {
    ...comum, material: 'Carta atual', dataPagamento: '20/07/2026', valorPago: 300,
  });

  const r = await post('/api/contratos/completar-series', {});
  const resultado = await r.json();
  assert.equal(resultado.criadas, 2);
  assert.equal(resultado.series, 1);
  // 1.55.39: sobreposição (mesmo vencimento + mesmo valor) virou RELATÓRIO — nada é excluído.
  assert.equal(resultado.removidas, 0, 'o completar-series não exclui mais nenhuma linha');
  const sobre = resultado.sobreposicoes.filter(s => s.parcelas.length === 2 && s.vencimento === '10/08/2026' && s.valor === 300);
  assert.equal(sobre.length, 1, 'as duas 02/03 no mesmo vencimento e valor entram no relatório');
  const lista = (await getj('/api/contratos')).filter(c => c.grupo === comum.grupo && c.cota === comum.cota);
  assert.deepEqual(lista.map(c => c.parcela).sort(), ['01/03', '02/03', '02/03', '03/03'], 'a 02/03 antiga continua na base');
  assert.ok(lista.some(c => c.id === antiga.id), 'nenhuma linha existente é apagada');
  // O MODELO das parcelas criadas é a linha mais atual (paga de maior número), não a antiga.
  for (const p of ['01/03', '03/03']) assert.equal(lista.find(c => c.parcela === p).material, 'Carta atual');
  assert.equal(lista.find(c => c.parcela === '01/03').valorPago, 300, 'preenchimento retroativo (CT-3) segue nascendo pago');
  assert.equal(lista.find(c => c.parcela === '03/03').valorPago, 0, 'parcela à frente nasce sempre em aberto');
});

test('CT-5: completar-series sinaliza série legada ambígua sem inventar parcelas', async () => {
  const arquivo = path.join(tmp, 'contratos.json');
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  dados.contratos.push(
    { id: 'ct-amb-1', banco: 'Banco CT Ambíguo', produto: 'Empréstimo', empresa: 'KV', material: 'Contrato repetido', parcela: '2/4', vencimento: '10/08/2026' },
    { id: 'ct-amb-2', banco: 'Banco CT Ambíguo', produto: 'Empréstimo', empresa: 'KV', material: 'Contrato repetido', parcela: '2/4', vencimento: '10/09/2026' },
  );
  fs.writeFileSync(arquivo, JSON.stringify(dados));

  const r = await post('/api/contratos/completar-series', {});
  const resultado = await r.json();
  assert.equal(resultado.ignoradas, 1);
  const ambiguos = (await getj('/api/contratos')).filter(c => c.banco === 'Banco CT Ambíguo');
  assert.equal(ambiguos.length, 2);
  assert.deepEqual(ambiguos.map(c => c.parcela), ['02/04', '02/04']);
});

test('CT-6: parcela antiga repetida no mesmo vencimento é RELATADA, nunca excluída', async () => {
  const arquivo = path.join(tmp, 'contratos.json');
  const dados = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  const comum = { banco: 'Banco CT Sobreposição', produto: 'Empréstimo', empresa: 'NTE', material: 'Série mensal', valorParcela: 500 };
  dados.contratos.push(
    { ...comum, id: 'ct-sobre-1', parcela: '1/4', vencimento: '10/01/2026' },
    { ...comum, id: 'ct-sobre-antiga', parcela: '1/4', vencimento: '10/02/2026' },
    { ...comum, id: 'ct-sobre-2', parcela: '2/4', vencimento: '10/02/2026' },
    { ...comum, id: 'ct-sobre-3', parcela: '3/4', vencimento: '10/03/2026' },
  );
  fs.writeFileSync(arquivo, JSON.stringify(dados));

  const r = await post('/api/contratos/completar-series', {});
  const resultado = await r.json();
  // Até a 1.55.38 o dedup apagava a `ct-sobre-antiga` e "resolvia" a série sozinho. Agora nada é
  // excluído: a sobreposição vira relatório e a série, que tem a MESMA 01/04 em dois vencimentos,
  // cai em `ignoradas` — o sistema avisa em vez de escolher qual linha do usuário está errada.
  assert.equal(resultado.removidas, 0, 'nenhuma exclusão');
  const sobre = resultado.sobreposicoes.filter(s => s.ids.includes('ct-sobre-antiga'));
  assert.equal(sobre.length, 1, 'a 01/04 antiga e a 02/04 dividem vencimento e valor: entram no relatório');
  assert.deepEqual(sobre[0].parcelas.sort(), ['01/04', '02/04']);
  assert.ok(resultado.ignoradas >= 1, 'série com o mesmo número em vencimentos diferentes fica para revisão');
  const serie = (await getj('/api/contratos')).filter(c => c.banco === comum.banco);
  assert.deepEqual(serie.map(c => [c.parcela, c.vencimento]).sort(), [
    ['01/04', '10/01/2026'], ['01/04', '10/02/2026'],
    ['02/04', '10/02/2026'], ['03/04', '10/03/2026'],
  ], 'as 4 linhas originais continuam intactas e nenhuma 04/04 é inventada');
  assert.equal(serie.some(c => c.id === 'ct-sobre-antiga'), true, 'a linha "perdedora" do dedup antigo continua na base');
});

// ===================== TM — Termos de multas =====================

test('TM-1: cria pastas aninhadas, armazena arquivos e move termos entre pastas', async () => {
  async function enviarArquivo(tipo, nome, mime, conteudo) {
    const fd = new FormData();
    fd.append('tipo', tipo);
    fd.append('arquivo', new Blob([conteudo], { type: mime }), nome);
    return fetch(`${BASE}/api/termos-multas/midia`, { method: 'POST', headers: ORIG, body: fd });
  }
  async function criarPasta(nome, pastaPaiId = '') {
    const r = await post('/api/termos-multas/pastas', { nome, pastaPaiId });
    assert.equal(r.status, 201);
    return r.json();
  }

  let estrutura = await getj('/api/termos-multas');
  const modelos = estrutura.pastas.find(p => p.nome === 'Modelos prontos');
  const carros = estrutura.pastas.find(p => p.nome === 'Carros');
  assert.ok(modelos && carros, 'a migração deve criar as pastas iniciais');

  const frotaPropria = await criarPasta('Frota própria', carros.id);
  const veiculo = await criarPasta('TMT1A23', frotaPropria.id);
  const motorista = await criarPasta('Motorista Teste', veiculo.id);
  const arquivoGeral = await criarPasta('Arquivo geral');

  let r = await enviarArquivo('assinado', 'termo-assinado.pdf', 'application/pdf', Buffer.from('%PDF-1.4\n% teste\n'));
  assert.equal(r.status, 201);
  const pdf = await r.json();
  r = await post('/api/termos-multas', {
    tipo: 'assinado', pastaId: motorista.id, placa: 'TMT1A23', motorista: 'MOTORISTA TESTE',
    titulo: 'Termo de indicação assinado', descricao: 'Auto 123', arquivo: pdf,
  });
  assert.equal(r.status, 201);
  const assinado = await r.json();

  const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  r = await enviarArquivo('modelo', 'modelo-indicacao.docx', docxMime, await criarDocxTeste());
  assert.equal(r.status, 201);
  const docx = await r.json();
  r = await post('/api/termos-multas', {
    tipo: 'modelo', pastaId: modelos.id, titulo: 'Modelo de indicação do condutor', arquivo: docx,
  });
  assert.equal(r.status, 201);

  r = await fetch(`${BASE}/api/termos-multas/${encodeURIComponent(assinado.id)}/mover`, {
    method: 'PATCH', headers: JSONH, body: JSON.stringify({ pastaId: arquivoGeral.id }),
  });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).pastaId, arquivoGeral.id);

  estrutura = await getj('/api/termos-multas');
  assert.ok(estrutura.termos.some(t => t.id === assinado.id && t.pastaId === arquivoGeral.id));
  assert.ok(estrutura.termos.some(t => t.tipo === 'modelo' && t.pastaId === modelos.id && t.arquivo.tipo === docxMime));
  assert.ok(estrutura.pastas.some(p => p.id === motorista.id && p.pastaPaiId === veiculo.id));

  r = await del(`/api/termos-multas/pastas/${encodeURIComponent(arquivoGeral.id)}`);
  assert.equal(r.status, 409, 'pasta com arquivo não pode ser excluída');

  const backup = await getj('/api/backup');
  assert.equal(backup.termosMultas.length, 2, 'backup deve incluir os arquivos');
  assert.ok(backup.pastasTermosMultas.some(p => p.id === motorista.id), 'backup deve incluir a árvore de pastas');

  r = await enviarArquivo('assinado', 'nao-e-pdf.docx', docxMime, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]));
  assert.equal(r.status, 400, 'termo assinado deve aceitar somente PDF');
  r = await enviarArquivo('modelo', 'docx-falso.docx', docxMime, Buffer.from('PK arquivo que não é um DOCX'));
  assert.equal(r.status, 400, 'extensão DOCX sem pacote OOXML válido deve ser recusada');

  r = await del(`/api/termos-multas/${encodeURIComponent(assinado.id)}`);
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${encodeURIComponent(pdf.id)}`)).status, 404,
    'excluir o termo também deve remover seu PDF');
});

// ===================== VST — Vistorias =====================

test('VST-1: vistoria sem placa é recusada com 400', async () => {
  const r = await post('/api/vistorias', { tipo: 'Saída', motorista: 'FULANO' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro || '', /placa/i);
});

test('VST-2: vistoria sem motorista é recusada com 400', async () => {
  const r = await post('/api/vistorias', { placa: 'VLA1A11', tipo: 'Saída' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro || '', /motorista/i);
});

test('VST-3: checklist normaliza item inválido e coage o termo do checkbox', async () => {
  const r = await post('/api/vistorias', {
    placa: 'VLA1A11', tipo: 'Saída', motorista: 'FULANO DE TAL', km: '84500',
    itens: { pneus: 'quase', lataria: 'avaria', oleo: 'ok' },
    termoAceito: 'on',
  });
  assert.equal(r.status, 201);
  const v = await r.json();
  assert.equal(v.itens.pneus, '', 'valor inválido deve virar vazio');
  assert.equal(v.itens.lataria, 'avaria');
  assert.equal(v.itens.oleo, 'ok');
  assert.equal(v.termoAceito, true, '"on" do checkbox deve virar true');
});

test('VST-4: PUT preserva ts e criadoPor e aplica as mudanças', async () => {
  const criada = await (await post('/api/vistorias', { placa: 'VLA1A11', tipo: 'Saída', motorista: 'BELTRANO' })).json();
  const r = await put(`/api/vistorias/${criada.id}`, { ...criada, tipo: 'Retorno', km: '85000', criadoPor: 'invasor', ts: 1 });
  assert.equal(r.status, 200);
  const v = await r.json();
  assert.equal(v.tipo, 'Retorno');
  assert.equal(v.km, '85000');
  assert.equal(v.ts, criada.ts, 'ts original preservado');
  assert.equal(v.criadoPor, criada.criadoPor, 'criadoPor original preservado');
});

test('VST-5: excluir vistoria apaga as fotos do cofre', async () => {
  const foto = await subirFoto('avaria.png');
  const criada = await (await post('/api/vistorias', { placa: 'VLA1A11', tipo: 'Retorno', motorista: 'CICLANO', fotos: [foto] })).json();
  assert.equal((await fetch(`${BASE}/api/midia/${foto.id}`)).status, 200);
  assert.equal((await del(`/api/vistorias/${criada.id}`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${foto.id}`)).status, 404, 'foto deve sumir em cascata');
});

test('VST-6: remover a foto num PUT apaga a mídia órfã', async () => {
  const foto = await subirFoto('orfa.png');
  const criada = await (await post('/api/vistorias', { placa: 'VLA1A11', tipo: 'Saída', motorista: 'CICLANO', fotos: [foto] })).json();
  const r = await put(`/api/vistorias/${criada.id}`, { ...criada, fotos: [] });
  assert.equal(r.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${foto.id}`)).status, 404, 'mídia removida da vistoria não pode ficar órfã');
  await del(`/api/vistorias/${criada.id}`);
});

test('VST-6b: foto de vistoria sobrevive à limpeza de órfãs e entra no backup', async () => {
  // As fotos de vistoria estavam FORA de midiasReferenciadas() embora mapaPastaAnexos() já
  // apontasse para 'files/vistorias': a limpeza diária apagava toda foto ~1h após o upload e o
  // .zip nunca as levava (coletarMidias percorre só o que está referenciado). O CHANGELOG da
  // v1.44 afirmava o contrário. É a mesma armadilha da v1.45.1, com perda de dados real.
  const foto = await subirFoto('vistoria-backup.png');
  const criada = await (await post('/api/vistorias', { placa: 'VLA1A11', tipo: 'Saída', motorista: 'CICLANO', fotos: [foto] })).json();

  // ENVELHECE a mídia no disco antes de varrer. Sem isto o teste seria vacuoso: limparMidiaOrfa
  // tem carência de 1h e NUNCA apaga upload recente — ou seja, a foto sobreviveria mesmo estando
  // fora de midiasReferenciadas(), e o assert passaria com o bug presente.
  const arqMidia = path.join(tmp, 'uploads', `${foto.id}.json`);
  const bruto = JSON.parse(fs.readFileSync(arqMidia, 'utf-8'));
  fs.writeFileSync(arqMidia, JSON.stringify({ ...bruto, ts: Date.now() - 2 * 60 * 60 * 1000 }));

  const limpou = await post('/api/midia/limpar-orfas', {});
  assert.equal(limpou.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${foto.id}`)).status, 200, 'a foto da vistoria não pode ser tratada como órfã');

  const r = await fetch(`${BASE}/api/backup/gerar?grupo=frota`, { headers: { Origin: BASE } });
  assert.equal(r.status, 200);
  const texto = Buffer.from(await r.arrayBuffer()).toString('latin1');
  assert.ok(texto.includes('files/vistorias/'), 'a foto da vistoria precisa entrar no .zip do grupo frota');
  await del(`/api/vistorias/${criada.id}`);
});

test('VST-7: criar vistoria registra no histórico da placa', async () => {
  const hist = await getj('/api/historico?placa=VLA1A11');
  assert.ok(hist.some((h) => /vistoria de (saída|retorno)/i.test(h.texto || '')), 'histórico deve ter a vistoria');
});

test('VST-8: data inválida assume o dia de hoje (ISO)', async () => {
  const r = await post('/api/vistorias', { placa: 'VLA1A11', tipo: 'Saída', motorista: 'DATA RUIM', data: '32/13/2026' });
  assert.equal(r.status, 201);
  const v = await r.json();
  assert.match(v.data, /^\d{4}-\d{2}-\d{2}$/);
  await del(`/api/vistorias/${v.id}`);
});

test('VST-9: editar vistoria inexistente responde 404', async () => {
  const r = await put('/api/vistorias/NAO-EXISTE', { placa: 'VLA1A11', motorista: 'X' });
  assert.equal(r.status, 404);
});

test('VST-10: placa em minúsculas é gravada em maiúsculas', async () => {
  const r = await post('/api/vistorias', { placa: 'vla1a11', tipo: 'Saída', motorista: 'CAIXA BAIXA' });
  assert.equal(r.status, 201);
  const v = await r.json();
  assert.equal(v.placa, 'VLA1A11');
  await del(`/api/vistorias/${v.id}`);
});

test('VL-4: salvar com o campo vazio limpa um vencimento existente', async () => {
  const v = (await getj('/api/veiculos')).find((x) => x.placa === 'VLA1A11');
  assert.ok(v.ipvaVenc, 'pré-condição: IPVA preenchido');
  const r = await put('/api/veiculos/VLA1A11', { ...v, ipvaVenc: '' });
  assert.equal(r.status, 200);
  const depois = (await getj('/api/veiculos')).find((x) => x.placa === 'VLA1A11');
  assert.equal(depois.ipvaVenc, '', 'vencimento deve poder ser limpo');
});

// ===================== RD — Rastreadores: desativados e importação =====================

// USO: node --test --test-name-pattern='RV-' test/modulos.test.js — API real, com JSON temporário.
test('RV-1: vínculo manual, transferência por planilha e remoção preservam o mesmo aparelho', async () => {
  const criado = await post('/api/rastreadores', { codigo: 'RV-1', esn: 'RV-ESN-1', placa: 'RVL1A23' });
  assert.equal(criado.status, 201);
  let rast = await criado.json();
  const url = `/api/rastreadores/${rast.id}/vinculos`;
  let h = await getj(url);
  assert.equal(h.eventos[0].tipo, 'vinculacao');
  assert.equal(h.eventos[0].dataInstalacao, '');
  assert.equal(h.eventos[0].origem, 'manual');
  const dados = { registros: [{ ...rast, placa: 'RVL2B34', situacaoInformada: false }] };
  assert.equal((await post('/api/rastreadores/importar/aplicar', dados)).status, 200);
  h = await getj(url);
  assert.equal(h.eventos[0].tipo, 'transferencia');
  assert.equal(h.eventos[0].placaAnterior, 'RVL1A23');
  assert.equal(h.eventos[0].origem, 'planilha');
  const total = h.total;
  await post('/api/rastreadores/importar/aplicar', dados);
  assert.equal((await getj(url)).total, total, 'a mesma planilha não duplica o histórico');
  rast = (await getj('/api/rastreadores')).find(r => r.id === rast.id);
  await put(`/api/rastreadores/${rast.id}`, { ...rast, codigo: 'RV-1-CORRIGIDO' });
  assert.equal((await getj(url)).eventos[0].tipo, 'identificacao');
  await put(`/api/rastreadores/${rast.id}`, { ...rast, codigo: 'RV-1-CORRIGIDO', situacao: 'Removido' });
  h = await getj(url);
  assert.equal(h.eventos[0].tipo, 'remocao');
  assert.equal(h.rastreador.placa, '');
  assert.equal(h.total, total + 2);
  assert.equal((await fetch(`${BASE}/api/rastreadores/inexistente/vinculos`)).status, 404);
});

test('RV-2: instalação pelo ESN, correção e exclusão preservam datas e fotos no histórico e no backup', async () => {
  const rast = await (await post('/api/rastreadores', { codigo: 'RV-2', esn: 'RV-ESN-2', placa: 'RVL3C45' })).json();
  const foto = await subirFoto('instalacao-rv.png');
  let resp = await post('/api/instalacoes', { numeroSerie: rast.esn, placa: rast.placa, data: '01/09/2026', colaborador: 'Instalador Demo', fotos: [foto] });
  assert.equal(resp.status, 201);
  let inst = await resp.json();
  assert.equal(inst.rastreadorId, rast.id);
  let h = await getj(`/api/rastreadores/${rast.id}/vinculos`);
  const registro = h.eventos.find(e => e.tipo === 'instalacao');
  assert.equal(registro.dataInstalacao, '01/09/2026');
  assert.equal(registro.colaborador, 'Instalador Demo');
  assert.equal(registro.fotos[0].id, foto.id);
  await put(`/api/rastreadores/${rast.id}`, { ...rast, codigo: 'RV-2-NOVO', esn: 'RV-ESN-2-NOVO' });
  const fotoNova = await subirFoto('instalacao-rv-nova.png');
  resp = await put(`/api/instalacoes/${inst.id}`, { ...inst, data: '02/09/2026', fotos: [fotoNova] });
  assert.equal(resp.status, 200);
  inst = await resp.json();
  assert.equal(inst.rastreadorId, rast.id, 'corrigir identificação do rastreador não solta a instalação');
  assert.equal((await fetch(`${BASE}/api/midia/${foto.id}`)).status, 200, 'foto antiga preservada');
  assert.equal((await del(`/api/instalacoes/${inst.id}`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${fotoNova.id}`)).status, 200, 'foto da instalação excluída preservada');
  h = await getj(`/api/rastreadores/${rast.id}/vinculos`);
  assert.equal(h.eventos[0].tipo, 'instalacaoExcluida');
  assert.ok(h.eventos.some(e => e.tipo === 'instalacaoCorrigida'));
  const backup = await fetch(`${BASE}/api/backup/gerar?grupo=rastreadores`);
  assert.equal(backup.status, 200);
  const zip = Buffer.from(await backup.arrayBuffer());
  assert.ok(zip.toString('latin1').includes('data/rastreadores_vinculos.json'));
  assert.ok(zip.toString('latin1').includes('files/instalacoes/'));
  const eventosSalvos = JSON.parse(fs.readFileSync(path.join(tmp, 'rastreadores_vinculos.json'), 'utf8')).eventos;
  assert.deepEqual(eventosSalvos.filter(e => e.rastreadorId === rast.id).reverse(), h.eventos);
  // Simula a recuperação do arquivo perdido em DATA_DIR temporário. O restore não gera eventos falsos.
  fs.writeFileSync(path.join(tmp, 'rastreadores_vinculos.json'), JSON.stringify({ eventos: [] }));
  const fd = new FormData();
  fd.append('arquivo', new Blob([zip], { type: 'application/zip' }), 'backup.zip');
  fd.append('aplicar', '1'); fd.append('frase', 'RESTAURAR BACKUP');
  fd.append('modo', 'substituir'); fd.append('grupos', 'rastreadores');
  const restaurou = await fetch(`${BASE}/api/backup/restaurar`, { method: 'POST', headers: ORIG, body: fd });
  assert.equal(restaurou.status, 200);
  assert.deepEqual((await getj(`/api/rastreadores/${rast.id}/vinculos`)).eventos, h.eventos);
});

test('RV-3: histórico próprio conserva mais de 1.000 registros e pagina sem gravar na leitura', async () => {
  const rast = await (await post('/api/rastreadores', { codigo: 'RV-3', placa: 'RVL4D56' })).json();
  const arq = path.join(tmp, 'rastreadores_vinculos.json');
  const original = JSON.parse(fs.readFileSync(arq, 'utf8'));
  const eventos = Array.from({ length: 1001 }, (_, n) => ({ id: `RV-TEST-${n}`, rastreadorId: rast.id, tipo: 'vinculacao', ts: n + 1, placa: rast.placa, origem: 'planilha' }));
  fs.writeFileSync(arq, JSON.stringify({ eventos: original.eventos.concat(eventos) }));
  const antes = fs.readFileSync(arq, 'utf8');
  const h = await getj(`/api/rastreadores/${rast.id}/vinculos`);
  assert.equal(h.total, 1002);
  assert.equal(h.eventos.length, 50);
  assert.equal(h.paginas, 21);
  const ultima = await getj(`/api/rastreadores/${rast.id}/vinculos?pagina=21`);
  assert.equal(ultima.eventos.length, 2);
  assert.equal(fs.readFileSync(arq, 'utf8'), antes, 'GET não regrava o arquivo');
});

// Desfazer em Instalações restaura o snapshot EXATO. Cenário do bug: Z sem rastreador → cadastra um
// rastreador cujo ESN casa com o Nº de série de Z → editar Y re-resolve Z (Z ganha o rastreadorId)
// → o 1º Desfazer volta Z com rastreadorId '' mas, sem a opção `exato`, o salvar religava Z pelo
// Nº de série; o 2º Desfazer via o estado "diferente do que deixou" e dava 409 (preso 15 min).
test('INST-UNDO-1: dois Desfazer seguidos em Instalações restauram o vínculo exato (200 nas duas)', async () => {
  const foto = await subirFoto('inst-undo.png');
  let r = await post('/api/instalacoes', { numeroSerie: 'UNDOZ-ESN', placa: 'UND1Z11', data: '01/09/2026', colaborador: 'Undo Z', fotos: [foto] });
  assert.equal(r.status, 201);
  const z = await r.json();
  assert.equal(z.rastreadorId, '', 'Z nasce sem rastreador');
  r = await post('/api/instalacoes', { numeroSerie: 'UNDOY-SEM-PAR', placa: 'UND2Y22', data: '01/09/2026', colaborador: 'Undo Y', fotos: [foto] });
  assert.equal(r.status, 201);
  const y = await r.json();
  assert.equal((await put(`/api/instalacoes/${z.id}`, { ...z, data: '05/09/2026' })).status, 200);
  const rast = await post('/api/rastreadores', { codigo: 'UNDOZ-C', esn: 'UNDOZ-ESN' });
  assert.equal(rast.status, 201);
  const rastId = (await rast.json()).id;
  assert.equal((await put(`/api/instalacoes/${y.id}`, { ...y, data: '06/09/2026' })).status, 200);
  const zDepois = (await getj('/api/instalacoes')).find(i => i.id === z.id);
  assert.equal(zDepois.rastreadorId, rastId, 'editar Y re-resolve Z pelo Nº de série');
  const d1 = await post('/api/desfazer/ultimo', { area: 'instalacoes' });
  assert.equal(d1.status, 200, '1º Desfazer: ' + await d1.clone().text());
  const d2 = await post('/api/desfazer/ultimo', { area: 'instalacoes' });
  assert.equal(d2.status, 200, '2º Desfazer: ' + await d2.clone().text());
  const lista = await getj('/api/instalacoes');
  const zFinal = lista.find(i => i.id === z.id), yFinal = lista.find(i => i.id === y.id);
  assert.equal(zFinal.data, '01/09/2026', 'Z volta à data original');
  assert.equal(zFinal.rastreadorId, '', 'Z volta sem rastreador, como estava no snapshot');
  assert.equal(yFinal.data, '01/09/2026', 'Y volta à data original');
});

test('RD-1: desativar e restaurar um rastreador persiste os campos', async () => {
  const r0 = await post('/api/rastreadores', { codigo: 'TST1', esn: '111222333', situacao: 'Devolvido' });
  assert.equal(r0.status, 201);
  const criado = await r0.json();
  let r = await put(`/api/rastreadores/${criado.id}`, { ...criado, desativado: true, desativadoEm: br(hoje) });
  assert.equal(r.status, 200);
  let v = await r.json();
  assert.equal(v.desativado, true);
  assert.equal(v.desativadoEm, br(hoje));
  r = await put(`/api/rastreadores/${criado.id}`, { ...v, desativado: false, desativadoEm: '' });
  v = await r.json();
  assert.equal(v.desativado, false);
  assert.equal(v.desativadoEm, '');
});

test('RD-2: importação só troca a situação quando a planilha a informa', async () => {
  // sem situacaoInformada → preserva a situação manual (Devolvido)
  let r = await post('/api/rastreadores/importar/aplicar', { registros: [{ codigo: 'TST1', esn: '111222333', situacao: 'Ativo', situacaoInformada: false }] });
  assert.equal(r.status, 200);
  let rast = (await getj('/api/rastreadores')).find((x) => x.codigo === 'TST1');
  assert.equal(rast.situacao, 'Devolvido', 'situação manual deve ser preservada');
  // com situacaoInformada → a da planilha vale
  r = await post('/api/rastreadores/importar/aplicar', { registros: [{ codigo: 'TST1', esn: '111222333', situacao: 'Ativo', situacaoInformada: true }] });
  assert.equal(r.status, 200);
  rast = (await getj('/api/rastreadores')).find((x) => x.codigo === 'TST1');
  assert.equal(rast.situacao, 'Ativo', 'situação informada na planilha deve valer');
});

test('RD-3: importação preserva desativado/desativadoEm', async () => {
  const rast = (await getj('/api/rastreadores')).find((x) => x.codigo === 'TST1');
  await put(`/api/rastreadores/${rast.id}`, { ...rast, desativado: true, desativadoEm: br(hoje) });
  const r = await post('/api/rastreadores/importar/aplicar', { registros: [{ codigo: 'TST1', esn: '999888777', situacao: 'Ativo', situacaoInformada: true }] });
  assert.equal(r.status, 200);
  const depois = (await getj('/api/rastreadores')).find((x) => x.codigo === 'TST1');
  assert.equal(depois.esn, '999888777', 'ESN da planilha deve atualizar');
  assert.equal(depois.desativado, true, 'desativado não pode ser tocado pela planilha');
  assert.equal(depois.desativadoEm, br(hoje));
});

// ===================== RL — Rastreadores: ações em lote =====================

test('RL-1: lote-excluir remove os selecionados e responde a contagem', async () => {
  const a = await (await post('/api/rastreadores', { codigo: 'LOTE-A', esn: '100100100' })).json();
  const b = await (await post('/api/rastreadores', { codigo: 'LOTE-B', esn: '200200200' })).json();
  const r = await post('/api/rastreadores/lote-excluir', { ids: [a.id, b.id] });
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.ok, true);
  assert.equal(j.excluidos, 2);
  const lista = await getj('/api/rastreadores');
  assert.ok(!lista.some((x) => x.id === a.id || x.id === b.id), 'os dois devem sumir');
});

test('RL-2: lote-desativar marca desativado com a data de hoje e é idempotente', async () => {
  const a = await (await post('/api/rastreadores', { codigo: 'LOTE-C', esn: '300300300' })).json();
  const b = await (await post('/api/rastreadores', { codigo: 'LOTE-D', esn: '400400400' })).json();
  let r = await post('/api/rastreadores/lote-desativar', { ids: [a.id, b.id] });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).desativados, 2);
  const lista = await getj('/api/rastreadores');
  for (const id of [a.id, b.id]) {
    const v = lista.find((x) => x.id === id);
    assert.equal(v.desativado, true);
    assert.equal(v.desativadoEm, br(hoje));
  }
  // rodar de novo não reconta quem já estava desativado
  r = await post('/api/rastreadores/lote-desativar', { ids: [a.id, b.id] });
  assert.equal((await r.json()).desativados, 0);
});

test('RL-3: lote-editar troca situação/tipo só nos campos preenchidos', async () => {
  const a = await (await post('/api/rastreadores', { codigo: 'LOTE-E', esn: '500500500', situacao: 'Novo', tipo: 'Outros' })).json();
  const b = await (await post('/api/rastreadores', { codigo: 'LOTE-F', esn: '600600600', situacao: 'Novo', tipo: 'Outros' })).json();
  const r = await post('/api/rastreadores/lote-editar', { ids: [a.id, b.id], campos: { situacao: 'Ativo', tipo: 'Instalado' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).alterados, 2);
  const lista = await getj('/api/rastreadores');
  for (const id of [a.id, b.id]) {
    const v = lista.find((x) => x.id === id);
    assert.equal(v.situacao, 'Ativo');
    assert.equal(v.tipo, 'Instalado');
  }
  // só situação: o tipo fica como está
  await post('/api/rastreadores/lote-editar', { ids: [a.id], campos: { situacao: 'Removido', tipo: '' } });
  const va = (await getj('/api/rastreadores')).find((x) => x.id === a.id);
  assert.equal(va.situacao, 'Removido');
  assert.equal(va.tipo, 'Instalado', 'tipo vazio não pode mexer no valor atual');
});

test('RL-4: lote-editar valida ids e campos (400)', async () => {
  const semIds = await post('/api/rastreadores/lote-editar', { ids: [], campos: { situacao: 'Ativo' } });
  assert.equal(semIds.status, 400);
  const c = await (await post('/api/rastreadores', { codigo: 'LOTE-G', esn: '700700700' })).json();
  const semCampo = await post('/api/rastreadores/lote-editar', { ids: [c.id], campos: {} });
  assert.equal(semCampo.status, 400, 'sem situação/tipo válidos → nada para alterar');
});

// ===================== CX — Custos por categoria (ATLAS) =====================

function xlsxCustos(ledgerRows, recRows) {
  const XLSX_CX = require('xlsx'); // require preguiçoso: não carrega o xlsx (~7MB) no boot do arquivo de teste
  const wb = XLSX_CX.utils.book_new();
  // cabeçalhos com espaços de propósito (" VALOR ") — o parser tem de normalizar
  const led = XLSX_CX.utils.aoa_to_sheet([['FORNECEDOR', 'DATA', 'DESCRIÇÃO', ' VALOR ', 'CATEGORIA', 'CENTRO DE CUSTO', 'CONTA PAGAMENTO'], ...ledgerRows]);
  XLSX_CX.utils.book_append_sheet(wb, led, 'CONTA AZUL - CUSTOS');
  if (recRows) {
    const r = XLSX_CX.utils.aoa_to_sheet([['Nº DE PROTOCOLO', 'Nº DA FATURA', 'NF', 'Nº CONTRATO', 'CONTRATO', 'REFERÊNCIA', 'DATA DE  FATURAMENTO', 'DATA DE PAGAMENTO ', 'VALOR FATURADO ', 'VALOR À RECEBER ', 'STATUS DA FATURA'], ...recRows]);
    XLSX_CX.utils.book_append_sheet(wb, r, 'RECEBIMENTO');
  }
  return XLSX_CX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function importarCustos(buf) {
  const fd = new FormData();
  fd.append('arquivo', new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'custos.xlsx');
  return fetch(`${BASE}/api/custos/importar`, { method: 'POST', headers: { ...ORIG }, body: fd });
}

test('CX-1: importar grava lançamentos + recebimentos; GET devolve os dados', async () => {
  const buf = xlsxCustos([
    ['Fornecedor A', '2026-01-05', 'Compra 1', 1000, 'Combustível', 'Atlas', 'Conta Azul'],
    ['Fornecedor B', '2026-02-10', 'Compra 2', 2500.5, 'Folha', 'Atlas', 'Cartão XP'],
    ['', '', 'TOTAL', 3500.5, '', '', ''], // linha de total → deve ser ignorada
  ], [
    [1, 'FAT1', 1, 4600, 'ATLAS', 'MED JAN', '2026-02-25', '2026-03-18', 400000, 350000, 'RECEBIDO'],
    ['', '', '', '', '', '', '', '', 400000, 350000, ''], // total → ignorado
  ]);
  const r = await importarCustos(buf);
  assert.equal(r.status, 200);
  const j = await r.json();
  assert.equal(j.lancamentosImportados, 2, 'a linha de total não conta');
  assert.equal(j.recebimentosImportados, 1, 'a linha de total do recebimento não conta');
  const d = await getj('/api/custos');
  assert.equal(d.lancamentos.length, 2);
  assert.equal(d.recebimentos.length, 1);
});

test('CX-2: descarta total e lê o valor de cabeçalho com espaços (" VALOR ")', async () => {
  const d = await getj('/api/custos');
  const soma = d.lancamentos.reduce((s, l) => s + l.valor, 0);
  assert.equal(Math.round(soma * 100) / 100, 3500.5, 'soma = só os 2 lançamentos reais');
  const b = d.lancamentos.find(l => l.fornecedor === 'Fornecedor B');
  assert.equal(b.valor, 2500.5, 'valor decimal lido do cabeçalho " VALOR "');
  assert.equal(b.data, '2026-02-10');
  assert.equal(b.centroCusto, 'Atlas');
});

test('CX-3: planilha sem lançamento válido (só total) responde 400', async () => {
  const buf = xlsxCustos([['', '', 'TOTAL', 999, '', '', '']]);
  const r = await importarCustos(buf);
  assert.equal(r.status, 400);
});

test('CX-4: planilha sem a aba "CONTA AZUL - CUSTOS" responde 400 citando a aba', async () => {
  const XLSX_CX = require('xlsx');
  const wb = XLSX_CX.utils.book_new();
  XLSX_CX.utils.book_append_sheet(wb, XLSX_CX.utils.aoa_to_sheet([['x'], ['y']]), 'OUTRA');
  const r = await importarCustos(XLSX_CX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  assert.equal(r.status, 400);
  const j = await r.json();
  assert.match(j.erro || '', /CONTA AZUL/i);
});

test('CX-5: importação mescla por contrato (centro de custo)', async () => {
  await del('/api/custos'); // zera para começar limpo
  await importarCustos(xlsxCustos([['F1', '2026-01-05', 'compra', 1000, 'Cat', 'Atlas', 'Conta Azul']]));
  const r2 = await importarCustos(xlsxCustos([['F2', '2026-01-06', 'compra', 2000, 'Cat', 'Orion', 'Conta Azul']]));
  assert.deepEqual((await r2.json()).contratos, ['Orion']);
  let d = await getj('/api/custos');
  assert.equal(d.lancamentos.length, 2, 'Atlas + Orion coexistem');
  const centros = new Set(d.lancamentos.map(l => l.centroCusto));
  assert.ok(centros.has('Atlas') && centros.has('Orion'));
  // reimporta Atlas com valor novo → só Atlas muda, Orion fica
  const r3 = await importarCustos(xlsxCustos([['F1b', '2026-02-05', 'compra', 5000, 'Cat', 'Atlas', 'Conta Azul']]));
  assert.deepEqual((await r3.json()).contratos, ['Atlas']);
  d = await getj('/api/custos');
  assert.equal(d.lancamentos.length, 2, 'Atlas substituído (1) + Orion intacto (1)');
  const atlas = d.lancamentos.filter(l => l.centroCusto === 'Atlas');
  assert.equal(atlas.length, 1);
  assert.equal(atlas[0].valor, 5000, 'Atlas com o valor novo');
  const orion = d.lancamentos.filter(l => l.centroCusto === 'Orion');
  assert.equal(orion.length, 1);
  assert.equal(orion[0].valor, 2000, 'Orion preservado');
});

// ===================== NT — Notificações externas =====================

test('NT-1: status sem envs responde configurado:false com pendências calculadas', async () => {
  const d = await getj('/api/notificacoes/status');
  assert.equal(d.configurado, false);
  assert.ok(d.pendencias && typeof d.pendencias.total === 'number');
});

test('NT-2: multa a vencer conta; multa paga não conta', async () => {
  const antes = (await getj('/api/notificacoes/status')).pendencias.multas;
  await post('/api/multas', { placa: 'VLA1A11', descricao: 'Teste NT', valor: 100, situacao: 'PENDENTE', dataVencimento: br(emDias(10)) });
  await post('/api/multas', { placa: 'VLA1A11', descricao: 'Paga NT', valor: 100, situacao: 'PAGO', dataVencimento: br(emDias(10)) });
  const depois = (await getj('/api/notificacoes/status')).pendencias.multas;
  assert.equal(depois, antes + 1, 'só a multa não paga entra na contagem');
});

test('NT-3: documento de funcionário e IPVA vencendo contam nas pendências', async () => {
  const antes = (await getj('/api/notificacoes/status')).pendencias;
  await post('/api/funcionarios', { nome: 'TESTE NOTIF', status: 'Ativo', documentos: [{ nome: 'ASO', categoria: 'Ocupacional', validade: iso(emDias(10)) }] });
  await post('/api/veiculos', { placa: 'NTV4D44', modelo: 'Teste', ipvaVenc: iso(emDias(10)) });
  const depois = (await getj('/api/notificacoes/status')).pendencias;
  assert.equal(depois.docs, antes.docs + 1, 'documento vencendo deve contar');
  assert.equal(depois.veiculos, antes.veiculos + 1, 'IPVA vencendo deve contar');
});

test('NT-4: testar sem configuração responde 400 com o motivo', async () => {
  const r = await post('/api/notificacoes/testar', {});
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro || '', /RESEND_API_KEY/);
});

test('NT-5: funcionário Desligado com documento vencido não conta', async () => {
  const antes = (await getj('/api/notificacoes/status')).pendencias.docs;
  const r = await post('/api/funcionarios', {
    nome: 'DESLIGADO NOTIF', status: 'Desligado', dataDemissao: iso(emDias(-30)), motivoDemissao: 'Teste',
    documentos: [{ nome: 'ASO', categoria: 'Ocupacional', validade: iso(emDias(-5)), semValidade: false }],
  });
  assert.equal(r.status, 201, 'o cadastro do desligado precisa ter sido criado (senão o teste passa de graça)');
  const criado = await r.json();
  assert.equal(criado.status, 'Desligado');
  assert.ok((criado.documentos || []).some((d) => d.validade === iso(emDias(-5))), 'documento vencido gravado');
  const depois = (await getj('/api/notificacoes/status')).pendencias.docs;
  assert.equal(depois, antes, 'desligado não deve gerar pendência de documento');
});

test('NT-6: multa vencida (no passado) conta nas pendências', async () => {
  const antes = (await getj('/api/notificacoes/status')).pendencias.multas;
  await post('/api/multas', { placa: 'VLA1A11', descricao: 'Vencida NT', valor: 50, situacao: 'PENDENTE', dataVencimento: br(emDias(-7)) });
  const depois = (await getj('/api/notificacoes/status')).pendencias.multas;
  assert.equal(depois, antes + 1, 'multa vencida deve contar');
});

// ===================== MU — Multas: data de pagamento automática =====================
// Marcar PAGO sem digitar a data (o jeito rápido: clicar na pílula de status) não pode deixar
// dataPagamento vazia pra sempre — é o que qualquer resumo "pago por mês" usa pra achar a multa.

test('MU-1: cadastrar já como PAGO sem data preenche a data de hoje sozinho', async () => {
  const r = await post('/api/multas', { placa: 'MUA1A11', descricao: 'Paga na hora', valor: 100, situacao: 'PAGO' });
  assert.equal(r.status, 201);
  const m = await r.json();
  assert.equal(m.dataPagamento, br(hoje), 'sem data informada, deve assumir hoje');
});

test('MU-2: mudar a situação pra PAGO (sem mandar data) preenche sozinho; editar de novo não reescreve', async () => {
  const criada = await (await post('/api/multas', { placa: 'MUA2A22', descricao: 'Pendente', valor: 200, situacao: 'PENDENTE' })).json();
  assert.equal(criada.dataPagamento, '', 'ainda pendente não deve ter data de pagamento');

  // pílula de status manda a multa inteira de volta, só trocando "situacao" (dataPagamento continua '').
  const marcada = await (await put(`/api/multas/${encodeURIComponent(criada.id)}`, { ...criada, situacao: 'PAGO' })).json();
  assert.equal(marcada.situacao, 'PAGO');
  assert.equal(marcada.dataPagamento, br(hoje), 'virou PAGO sem data → assume hoje');

  // edita outro campo, situação PAGO se mantém: a data de pagamento já preenchida não pode mudar.
  const editada = await (await put(`/api/multas/${encodeURIComponent(marcada.id)}`, { ...marcada, observacao: 'nova nota' })).json();
  assert.equal(editada.dataPagamento, marcada.dataPagamento, 'editar uma multa já paga não pode reescrever a data de pagamento');
});

test('MU-3: data de pagamento digitada manualmente nunca é sobrescrita', async () => {
  const dataEscolhida = br(emDias(-3));
  const criada = await (await post('/api/multas', { placa: 'MUA3A33', descricao: 'Paga com data própria', valor: 300, situacao: 'PAGO', dataPagamento: dataEscolhida })).json();
  assert.equal(criada.dataPagamento, dataEscolhida, 'data informada não deve ser trocada pela de hoje');
});

// ===================== CB — Integração Cobli =====================

test('CB-1: status da Cobli sem a env responde configurado:false', async () => {
  const d = await getj('/api/cobli/status');
  assert.equal(d.configurado, false);
});

test('CB-2: sincronizar sem a env responde 400 citando a configuração', async () => {
  const r = await post('/api/rastreadores/cobli/sincronizar', {});
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro || '', /COBLI_API_KEY/);
});

// ===================== DEV — Painel de serviços (deploy) =====================

test('DEV-1: /api/dev/servicos lista banco e cofre ok e marca não-configurados', async () => {
  const d = await getj('/api/dev/servicos');
  const por = (nome) => (d.servicos || []).find((s) => s.nome.includes(nome));
  assert.ok(por('Banco'), 'deve listar o banco');
  assert.equal(por('Banco').ok, true);
  assert.equal(por('Cofre').ok, true);
  assert.ok(por('FIPE'), 'deve listar a FIPE (pode falhar offline, mas aparece)');
  assert.equal(por('Cobli').ok, null, 'sem env → não configurado');
  assert.equal(por('Resend').ok, null, 'sem env → não configurado');
  assert.ok(typeof d.sse === 'number');
});

// ===================== SEG — Telas admin de Segurança =====================
// O harness roda com login DESLIGADO → exigeAdminOuLocal libera (modo local, como o admin).

test('SEG-1: visão geral traz controles ativos e contadores', async () => {
  const d = await getj('/api/seguranca/geral');
  assert.ok(Array.isArray(d.controles) && d.controles.length >= 5, 'lista de controles');
  assert.ok(d.controles.every(c => c.ok === true || c.nome.includes('produção')), 'controles ligados');
  assert.equal(typeof d.eventos24h, 'number');
  assert.ok(d.porSeveridade && typeof d.porSeveridade.alerta === 'number');
});

test('SEG-3: endpoints lista as rotas com guard e marca as anônimas', async () => {
  const d = await getj('/api/seguranca/endpoints');
  assert.ok(d.total > 100, 'muitas rotas mapeadas');
  const bloq = d.rotas.find(r => r.path === '/api/seguranca/bloqueios' && r.metodo === 'POST');
  assert.ok(bloq && /admin/.test(bloq.guard), 'rota de bloqueio é admin');
  const login = d.rotas.find(r => r.path === '/api/login');
  assert.ok(login && login.anonima, '/api/login é anônima');
  const veic = d.rotas.find(r => r.path === '/api/veiculos' && r.metodo === 'POST');
  assert.equal(veic.guard, 'editar:frota', 'POST veículos exige editar:frota');
});

test('SEG-4: segredos mostram só presença, nunca o valor', async () => {
  const d = await getj('/api/seguranca/segredos');
  assert.ok(Array.isArray(d.envs) && d.envs.some(e => e.nome === 'SESSION_SECRET'));
  for (const e of d.envs) {
    assert.equal(typeof e.definida, 'boolean');
    assert.ok(!('valor' in e) && !('value' in e), 'nunca expõe o valor');
  }
});

test('SEG-4b: scan de segredos devolve resumo sem eco cru', async () => {
  const d = await (await post('/api/seguranca/segredos/scan', {})).json();
  assert.equal(typeof d.ok, 'boolean');
  assert.ok(typeof d.resumo === 'string');
  assert.ok(Array.isArray(d.achados));
});

test('SEG-5: bloquear IP persiste, aparece na lista e desbloqueia', async () => {
  const ip = '198.51.100.7';
  let r = await post('/api/seguranca/bloqueios', { ip, motivo: 'teste automatizado' });
  assert.equal(r.status, 200);
  let d = await getj('/api/seguranca/bloqueios');
  assert.ok(d.permanentes.some(b => b.ip === ip), 'IP na lista permanente');
  r = await del('/api/seguranca/bloqueios/' + encodeURIComponent(ip));
  assert.equal(r.status, 200);
  d = await getj('/api/seguranca/bloqueios');
  assert.ok(!d.permanentes.some(b => b.ip === ip), 'IP saiu da lista');
});

test('SEG-5b: bloquear sem IP responde 400', async () => {
  const r = await post('/api/seguranca/bloqueios', { motivo: 'x' });
  assert.equal(r.status, 400);
});

test('SEG-6: sessões respondem e revogar-todas é aceito', async () => {
  const d = await getj('/api/seguranca/sessoes');
  assert.ok(Array.isArray(d.sessoes) && typeof d.total === 'number');
  const r = await post('/api/seguranca/sessoes/revogar-todas', {});
  assert.equal(r.status, 200);
});

test('SEG-6b: revogar sessão sem usuário responde 400', async () => {
  const r = await post('/api/seguranca/sessoes/revogar', {});
  assert.equal(r.status, 400);
});

test('SEG-7: config grava overrides e SANEIA valores fora da faixa', async () => {
  let r = await put('/api/seguranca/config', { inatividadeMin: 45, absolutoH: 8, loginMaxTentativas: 5, loginJanelaMin: 10 });
  assert.equal(r.status, 200);
  let d = await r.json();
  assert.equal(d.config.inatividadeMin, 45);
  // fora da faixa → limitado (não rejeitado com erro)
  r = await put('/api/seguranca/config', { inatividadeMin: 999999, absolutoH: -3, loginMaxTentativas: 5, loginJanelaMin: 10 });
  d = await r.json();
  assert.equal(d.config.inatividadeMin, 1440, 'inatividade limitada ao teto');
  assert.equal(d.config.absolutoH, 1, 'absoluto limitado ao piso');
  // restaura o padrão para não afetar outros testes
  await put('/api/seguranca/config', { inatividadeMin: 60, absolutoH: 12, loginMaxTentativas: 8, loginJanelaMin: 15 });
});

// SEG-8: guard em produção (login ON) — servidor próprio, sem cookie → 401.
test('SEG-8: com login ativo, /api/seguranca/* exige autenticação (401)', async () => {
  const { spawn } = require('node:child_process');
  // Porta EXCLUSIVA: era 3197, a mesma de test/almoxarifado.test.js. Como o `node --test` roda os
  // arquivos em paralelo, os dois servidores disputavam a porta e este teste falhava de vez em
  // quando — sem relação nenhuma com o que ele testa.
  const porta = 3206;
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-seg-'));
  const base2 = `http://localhost:${porta}`;
  // Mesma trava do before() deste arquivo: se a porta já responde, o nosso servidor morre com
  // EADDRINUSE e o laço abaixo aceitaria o 200 do intruso — este teste passaria medindo o
  // servidor errado (que tem OUTRO login configurado, então os 401 esperados viriam por acaso
  // ou não viriam nunca).
  let porta2Ocupada = false;
  try { await fetch(base2 + '/api/versao', { signal: AbortSignal.timeout(1500) }); porta2Ocupada = true; } catch (e) { /* recusou = livre */ }
  assert.equal(porta2Ocupada, false, `a porta ${porta} já está ocupada por outro processo — encerre-o e rode de novo`);
  const srv2 = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: tmp2, PORT: String(porta), APP_PASSWORD: 'segredo-teste', SESSION_SECRET: 'x'.repeat(32), MONGODB_URI: '', COBLI_API_KEY: '', RESEND_API_KEY: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let srv2Saida = null; let srv2Log = '';
  srv2.stderr.on('data', (d) => { srv2Log += d; });
  srv2.on('exit', (codigo, sinal) => { srv2Saida = codigo === null ? `sinal ${sinal}` : codigo; });
  try {
    const fim = Date.now() + 30000;
    let subiu = false;
    while (Date.now() < fim) {
      assert.equal(srv2Saida, null, `o 2º servidor (porta ${porta}) morreu com código ${srv2Saida}: ${srv2Log.slice(-500)}`);
      try { const r = await fetch(base2 + '/api/versao'); if (r.ok) { subiu = true; break; } } catch (e) {}
      await new Promise(r => setTimeout(r, 150));
    }
    assert.equal(subiu, true, `o 2º servidor (porta ${porta}) não respondeu a tempo`);
    for (const ep of ['geral', 'endpoints', 'segredos', 'bloqueios', 'sessoes', 'config']) {
      const r = await fetch(`${base2}/api/seguranca/${ep}`);
      assert.equal(r.status, 401, `${ep} sem login deve dar 401`);
    }
  } finally {
    try { srv2.kill(); } catch (e) {}
    try { fs.rmSync(tmp2, { recursive: true, force: true }); } catch (e) {}
  }
});

// ===================== TRN — Envio de treinamento em lote =====================
async function criarTreino(titulo) {
  const r = await post('/api/treinamentos', {
    titulo, tipo: 'NR', fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', validadeMeses: 12,
    questoes: [{ enunciado: 'ok?', alternativas: [{ id: 'a', texto: 'Não' }, { id: 'b', texto: 'Sim' }], correta: 'b' }],
  });
  assert.equal(r.status, 201, 'treino criado');
  return (await r.json()).treinamento?.id || (await getj('/api/treinamentos')).treinamentos?.[0]?.id;
}
async function criarFunc(nome) {
  const r = await post('/api/funcionarios', { nome, status: 'Ativo' });
  assert.equal(r.status, 201);
  return (await r.json()).id;
}

// ===================== MUL-TERMO — termo da multa preenchido (1.55.49) =====================
// .docx mínimo com o corpo dado (pizzip, como o Word gravaria). Os modelos da empresa marcam cada
// campo com {{MARCADOR}} em Consolas com realce amarelo; o Word às vezes parte o marcador em dois
// pedaços de texto, que é o caso que um "procura e troca" simples não pega.
// `rodape` (opcional): parágrafos de um rodapé (word/footer1.xml), como nos modelos da empresa.
function docxComCorpo(paragrafos, rodape) {
  const PizZip = require('pizzip');
  const z = new PizZip();
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  z.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + (rodape ? '<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>' : '') + '</Types>');
  z.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');
  if (rodape) {
    z.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/></Relationships>');
    z.file('word/footer1.xml', `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${W}>${rodape}</w:ftr>`);
  }
  const sect = rodape ? '<w:sectPr><w:footerReference w:type="default" r:id="rIdF"/></w:sectPr>' : '';
  z.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${paragrafos}${sect}</w:body></w:document>`);
  return z.generate({ type: 'nodebuffer' });
}
const xmlDocx = (buf) => new (require('pizzip'))(buf).file('word/document.xml').asText();
const textoDocx = (buf) => xmlDocx(buf).replace(/<[^>]+>/g, '');
// Run de campo como nos modelos: Consolas + realce amarelo.
const runCampo = (t) => `<w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:highlight w:val="yellow"/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
const runTexto = (t) => `<w:r><w:t xml:space="preserve">${t}</w:t></w:r>`;
// Texto oculto (w:vanish), como o bloco de instruções dos modelos.
const runOculto = (t) => `<w:r><w:rPr><w:vanish/></w:rPr><w:t xml:space="preserve">${t}</w:t></w:r>`;
test('MUL-TERMO-1: gera o termo .docx com dados da multa, do condutor e do veículo e liga a multa ao funcionário', async () => {
  const docxMime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const subirModelo = async (titulo, buf, nome = 'modelo.docx', mime = docxMime) => {
    const fd = new FormData();
    fd.append('tipo', 'modelo');
    fd.append('arquivo', new Blob([buf], { type: mime }), nome);
    let r = await fetch(`${BASE}/api/termos-multas/midia`, { method: 'POST', headers: ORIG, body: fd });
    assert.equal(r.status, 201, await r.clone().text());
    r = await post('/api/termos-multas', { tipo: 'modelo', titulo, arquivo: await r.json() });
    assert.equal(r.status, 201, await r.clone().text());
    return (await r.json()).id;
  };
  let r = await post('/api/veiculos', { placa: 'TRM1A23', modelo: 'Strada', versao: 'Freedom', renavam: '01234567890', chassi: '9bd1234567890abcd', dono: 'NORTE CONSTRUTORA LTDA', anoFab: 2022, anoMod: 2023, cor: 'Branca' });
  assert.ok(r.status === 201 || r.status === 200, await r.clone().text());
  r = await post('/api/funcionarios', { nome: 'TERMO CONDUTOR', status: 'Ativo', cpf: '52998224725', rg: '1234567', orgaoEmissor: 'SSP/BA', cnhNumero: '01234567890', cnhCategoria: 'B', cnhValidade: '2030-05-10', empresa: 'Norte Engenharia', cargo: 'Encarregado', endereco: 'Rua A, 10', cidade: 'Salvador', uf: 'BA', veiculoVinculado: 'TRM1A23' });
  assert.equal(r.status, 201, await r.clone().text());
  const func = await r.json();
  await criarFunc('TERMO OUTRO FUNCIONARIO');
  r = await post('/api/multas', { placa: 'TRM1A23', autoInfracao: 'N002135790', descricao: 'Multa por nao identificacao.', dataInfracao: '17/09/2025', horaInfracao: '09:15', local: 'BR 101 KM 10', cidadeEstado: 'Salvador/BA', valor: 260.32,
    codigoInfracao: '5002-0', orgaoAutuador: 'PRF', dataNotificacao: '2025-10-02' });
  assert.equal(r.status, 201);
  const multa = await r.json();
  assert.equal(multa.codigoInfracao, '5002-0');
  assert.equal(multa.orgaoAutuador, 'PRF');
  const corpo = `<w:p>${runTexto('Condutor: ')}${runCampo('{{NOME_')}${runCampo('COLABORADOR}}')}${runTexto(', CPF ')}${runCampo('{{CPF}}')}</w:p>`
    + `<w:p>${runTexto('CNH ')}${runCampo('{{CNH}}')}${runTexto(' (')}${runCampo('{{CNH_CATEGORIA}}')}${runTexto(') até ')}${runCampo('{{CNH_VALIDADE}}')}</w:p>`
    + `<w:p>${runTexto('Auto ')}${runCampo('{{NUMERO_AUTO}}')}${runTexto(' código ')}${runCampo('{{CODIGO_INFRACAO}}')}${runTexto(' do ')}${runCampo('{{ORGAO_AUTUADOR}}')}${runTexto(' em ')}${runCampo('{{DATA_HORA_INFRACAO}}')}${runTexto(', notificada em ')}${runCampo('{{DATA_NOTIFICACAO}}')}</w:p>`
    + `<w:p>${runCampo('{{DESCRICAO_INFRACAO}}')}${runTexto('. Local ')}${runCampo('{{LOCAL_INFRACAO}}')}${runTexto(' valor ')}${runCampo('{{VALOR_MULTA}}')}</w:p>`
    + `<w:p>${runTexto('Veículo ')}${runCampo('{{MODELO_MARCA}}')}${runTexto(' renavam ')}${runCampo('{{RENAVAM}}')}${runTexto(' chassi ')}${runCampo('{{CHASSI}}')}${runTexto(' ano ')}${runCampo('{{ANO}}')}</w:p>`
    + `<w:p>${runCampo('{{EMPRESA_RAZAO}}')}${runTexto(' CNPJ ')}${runCampo('{{EMPRESA_CNPJ}}')}${runTexto(', valor ')}${runCampo('{{CONDICAO_PARCELAS}}')}${runTexto(' a partir de ')}${runCampo('{{MES_INICIO_DESCONTO}}')}</w:p>`
    + `<w:p>${runCampo('{{CIDADE}}')}${runTexto(', ')}${runCampo('{{DATA_ASSINATURA}}')}${runTexto('. Responsável desde ')}${runCampo('{{RESPONSAVEL_DESDE}}')}${runTexto(' ')}${runCampo('{{CAMPO_INVENTADO}}')}</w:p>`
    // Rodapé com TAB digitado no texto (como nos modelos): a versão para PDF o troca por <w:tab/>.
    + `<w:p>${runTexto('NORTE ENGENHARIA\tTERMO')}</w:p>`
    // Bloco de instruções oculto, com o marcador partido pelo Word ('[[' + 'INSTRUCOES'), um símbolo
    // com código inválido e um pedaço de HTML embutido (altChunk): a versão para PDF tira os três.
    + `<w:p>${runOculto('[[')}${runOculto('INSTRUCOES DE USO]] troque {{NOME_COLABORADOR}}')}</w:p><w:p>${runOculto('pelo nome [[FIM INSTRUCOES]]')}</w:p>`
    + `<w:p><w:r><w:sym w:font="Wingdings" w:char="41;&lt;b&gt;"/></w:r><w:r><w:sym w:font="Wingdings" w:char="F0FC"/></w:r></w:p><w:altChunk r:id="rIdHtml"/>`;
  const modeloId = await subirModelo('Termo teste MUL NTE', docxComCorpo(corpo));

  // Opções: o modelo aparece (com a empresa tirada do título) e o funcionário com o veículo vinculado
  // vem primeiro, sem dado pessoal.
  const op = await getj(`/api/multas/${multa.id}/termo/opcoes`);
  const mod = op.modelos.find(m => m.id === modeloId);
  assert.equal(mod && mod.empresa, 'NTE');
  assert.equal(op.candidatos[0].id, func.id);
  assert.equal(op.candidatos[0].sugerido, 'veiculo');
  assert.equal(op.candidatos[0].empresa, 'NTE');
  assert.ok(!JSON.stringify(op.candidatos).includes('52998224725'), 'a lista de condutores não leva CPF');
  assert.ok(op.marcadores.some(([g]) => g === 'Colaborador'));

  // Prévia: só os marcadores que o modelo usa (os do bloco de instruções não contam), formatados.
  const extras = { parcelas: 2, mesInicio: '2026-04', cidade: 'Recife', dataAssinatura: '2026-10-01' };
  r = await post(`/api/multas/${multa.id}/termo/previa`, { modeloId, funcionarioId: func.id, ...extras });
  assert.equal(r.status, 200, await r.clone().text());
  const pv = await r.json();
  const val = Object.fromEntries(pv.usados.map(u => [u.chave, u.valor]));
  assert.equal(pv.usados[0].chave, 'NOME_COLABORADOR');
  assert.equal(pv.usados.filter(u => u.chave === 'NOME_COLABORADOR').length, 1);
  assert.equal(val.CPF, '529.982.247-25');
  assert.equal(val.VALOR_MULTA, 'R$ 260,32');
  assert.equal(val.CNH_VALIDADE, '10/05/2030');
  assert.equal(val.DATA_HORA_INFRACAO, '17/09/2025 às 09:15');
  assert.equal(val.DATA_NOTIFICACAO, '02/10/2025');
  assert.equal(val.CONDICAO_PARCELAS, 'dividida em 2 parcelas mensais');
  assert.equal(val.MES_INICIO_DESCONTO, 'abril de 2026');
  assert.equal(val.DATA_ASSINATURA, '1 de outubro de 2026');
  assert.equal(val.EMPRESA_CNPJ, '96.105.728/0001-57');
  assert.deepEqual(pv.faltando, ['RESPONSAVEL_DESDE']);
  assert.deepEqual(pv.desconhecidos, ['CAMPO_INVENTADO']);
  // Prévia sem modelo: 404 (ela depende de saber quais marcadores o modelo usa).
  assert.equal((await post(`/api/multas/${multa.id}/termo/previa`, { funcionarioId: func.id })).status, 404);

  // Gerar: .docx preenchido (marcador partido incluído); o que recebeu valor perde o amarelo e a
  // Consolas; o que faltou continua {{…}} em amarelo; o bloco de instruções fica intacto.
  r = await post(`/api/multas/${multa.id}/termo`, { modeloId, funcionarioId: func.id, ...extras, parcelas: 1 });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(r.headers.get('content-type') || '', /wordprocessingml/);
  assert.match(r.headers.get('content-disposition') || '', /Termo N002135790 TRM1A23\.docx/);
  const buf = Buffer.from(await r.arrayBuffer());
  const txt = textoDocx(buf);
  for (const esperado of ['Condutor: TERMO CONDUTOR, CPF 529.982.247-25', 'CNH 01234567890 (B) até 10/05/2030',
    'Auto N002135790 código 5002-0 do PRF em 17/09/2025 às 09:15, notificada em 02/10/2025',
    'Multa por nao identificacao. Local BR 101 KM 10 - Salvador valor R$ 260,32',
    'Veículo Strada Freedom renavam 01234567890 chassi 9BD1234567890ABCD ano 2022/2023',
    'NORTE CONSTRUTORA LTDA CNPJ 96.105.728/0001-57, valor paga em parcela única a partir de abril de 2026',
    // Sem dado sai EM BRANCO; marcador que o sistema não conhece fica à vista.
    'Recife, 1 de outubro de 2026. Responsável desde  {{CAMPO_INVENTADO}}',
    '[[INSTRUCOES DE USO]] troque {{NOME_COLABORADOR}}pelo nome [[FIM INSTRUCOES]]']) {
    assert.ok(txt.includes(esperado), `faltou "${esperado}" em: ${txt}`);
  }
  const runs = xmlDocx(buf).match(/<w:r>[\s\S]*?<\/w:r>/g);
  const runDe = (trecho) => runs.find(x => x.replace(/<[^>]+>/g, '').includes(trecho));
  assert.ok(!/highlight|Consolas/.test(runDe('529.982.247-25')), 'campo preenchido sai sem realce e sem Consolas');
  assert.ok(!txt.includes('RESPONSAVEL_DESDE'), 'campo sem dado sai em branco');
  const pResp = xmlDocx(buf).match(/<w:p>(?:(?!<\/w:p>)[\s\S])*Responsável desde[\s\S]*?<\/w:p>/)[0];
  assert.deepEqual((pResp.match(/<w:r>[\s\S]*?<\/w:r>/g) || []).filter(x => /highlight/.test(x)).map(x => x.replace(/<[^>]+>/g, '')),
    ['{{CAMPO_INVENTADO}}'], 'o campo sem dado também perde o amarelo; só o desconhecido continua');
  assert.ok(/highlight/.test(runDe('{{CAMPO_INVENTADO}}')), 'marcador desconhecido fica à vista, em amarelo');
  assert.ok(!/[-]/.test(xmlDocx(buf)), 'nenhuma etiqueta interna sobrando');

  // Versão para PDF (formato:'pdf'): mesmo termo, sem os parágrafos do bloco oculto de instruções
  // (o navegador deixaria o espaço deles e o termo vazaria para uma 2ª página).
  r = await post(`/api/multas/${multa.id}/termo`, { modeloId, funcionarioId: func.id, ...extras, formato: 'pdf' });
  assert.equal(r.status, 200, await r.clone().text());
  const bufPdf = Buffer.from(await r.arrayBuffer());
  const txtPdf = textoDocx(bufPdf);
  assert.ok(!txtPdf.includes('INSTRUCOES'), 'o bloco de instruções sai da versão para PDF');
  assert.ok(!xmlDocx(bufPdf).includes('altChunk') && !xmlDocx(bufPdf).includes('41;') && xmlDocx(bufPdf).includes('w:char="F0FC"'),
    'a versão para PDF tira o HTML embutido e o símbolo inválido, e mantém o símbolo válido');
  assert.ok(xmlDocx(bufPdf).includes('NORTE ENGENHARIA</w:t><w:tab/><w:t xml:space="preserve">TERMO'), 'TAB digitado vira <w:tab/> na versão para PDF');
  assert.ok(xmlDocx(buf).includes('NORTE ENGENHARIA\tTERMO'), 'o .docx baixado mantém o TAB como no modelo');
  assert.ok(xmlDocx(buf).includes('altChunk'), 'o .docx baixado continua como o modelo');
  assert.ok(txtPdf.includes('Condutor: TERMO CONDUTOR, CPF 529.982.247-25') && txtPdf.includes('Recife, 1 de outubro de 2026.'), txtPdf);
  const hist = await getj('/api/historico?placa=TRM1A23');
  assert.ok(hist.some(h => /Termo gerado para salvar em PDF/.test(h.texto)), 'histórico registra o PDF');

  const depois = (await getj('/api/multas')).find(m => m.id === multa.id);
  assert.equal(depois.condutorFuncionarioId, func.id);
  assert.equal(depois.responsavel, 'TERMO CONDUTOR', 'Responsável vazio recebe o nome do condutor');
  // O modal da multa manda o vínculo num campo oculto: um PUT com ele mantém.
  r = await fetch(`${BASE}/api/multas/${multa.id}`, { method: 'PUT', headers: JSONH, body: JSON.stringify({ ...depois, observacao: 'x' }) });
  assert.equal((await r.json()).condutorFuncionarioId, func.id);

  // Modelo em PDF: 400 com orientação. Marcador mal fechado: 400. Funcionário inexistente: 404.
  const pdfId = await subirModelo('Termo PDF MUL', Buffer.from('%PDF-1.4\n% teste\n'), 'termo.pdf', 'application/pdf');
  r = await post(`/api/multas/${multa.id}/termo`, { modeloId: pdfId, funcionarioId: func.id });
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro, /Word/);
  // Marcador só no rodapé: entra na prévia (usados/faltando/desconhecidos) e é preenchido lá.
  const rodapeId = await subirModelo('Termo rodapé MUL', docxComCorpo(`<w:p>${runCampo('{{NUMERO_AUTO}}')}</w:p>`,
    `<w:p>${runTexto('CNPJ ')}${runCampo('{{EMPRESA_CNPJ}}')}${runTexto(' desde ')}${runCampo('{{RESPONSAVEL_DESDE}}')}${runTexto(' ')}${runCampo('{{RODAPE_ERRADO}}')}</w:p>`));
  const pvR = await (await post(`/api/multas/${multa.id}/termo/previa`, { modeloId: rodapeId, funcionarioId: func.id })).json();
  assert.deepEqual(pvR.usados.map(u => u.chave), ['NUMERO_AUTO', 'EMPRESA_CNPJ', 'RESPONSAVEL_DESDE', 'RODAPE_ERRADO']);
  assert.deepEqual(pvR.faltando, ['RESPONSAVEL_DESDE']);
  assert.deepEqual(pvR.desconhecidos, ['RODAPE_ERRADO']);
  r = await post(`/api/multas/${multa.id}/termo`, { modeloId: rodapeId, funcionarioId: func.id });
  const rodapeTxt = new (require('pizzip'))(Buffer.from(await r.arrayBuffer())).file('word/footer1.xml').asText().replace(/<[^>]+>/g, '');
  assert.equal(rodapeTxt, 'CNPJ 96.105.728/0001-57 desde  {{RODAPE_ERRADO}}');

  const ruimId = await subirModelo('Termo quebrado MUL', docxComCorpo('<w:p><w:r><w:t>Placa {{PLACA e {{NUMERO_AUTO}}</w:t></w:r></w:p>'));
  r = await post(`/api/multas/${multa.id}/termo`, { modeloId: ruimId, funcionarioId: func.id });
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro, /marcador/);
  assert.equal((await post(`/api/multas/${multa.id}/termo`, { modeloId, funcionarioId: 'F-nao-existe' })).status, 404);
});

// ===================== FUNC — Funcionários =====================
test('FUNC-1: duas admissões calculam experiência 30+30 no ATLAS e 45+45 nos demais', async () => {
  let r = await post('/api/funcionarios', {
    nome: 'EXP ATLAS',
    status: 'Ativo',
    admissao: '2026-01-01',
    admissao2: '2026-03-01',
    contratos: [{ numero: '4600009606', nome: 'ATLAS CONSTRUÇÃO PREDIAL', local: '' }],
  });
  assert.equal(r.status, 201);
  let f = await r.json();
  assert.equal(f.experienciaFim, '2026-01-30');
  assert.equal(f.experienciaFim2, '2026-03-30');

  r = await post('/api/funcionarios', {
    nome: 'EXP OUTRO CONTRATO',
    status: 'Ativo',
    admissao: '2026-01-01',
    admissao2: '2026-03-01',
    contratos: [{ numero: '4600009505', nome: 'ORION SERVIÇOS DE EXECUÇÃO DE OBRAS DE CONSTRUÇÃO CIVIL', local: '' }],
  });
  assert.equal(r.status, 201);
  f = await r.json();
  assert.equal(f.experienciaFim, '2026-02-14');
  assert.equal(f.experienciaFim2, '2026-04-14');
});

test('TRN-1: lote cria um convite por funcionário e devolve os tokens', async () => {
  const tid = await criarTreino('NR-Lote-1');
  const f1 = await criarFunc('LOTE FULANO'), f2 = await criarFunc('LOTE BELTRANO');
  const r = await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [f1, f2] });
  assert.equal(r.status, 201);
  const d = await r.json();
  assert.equal(d.ok, true);
  assert.equal(d.criados.length, 2, 'dois links criados');
  assert.ok(d.criados.every(c => c.token && c.token.length >= 20), 'cada um com token');
  assert.deepEqual(d.criados.map(c => c.funcionarioId).sort(), [f1, f2].sort());
});

test('TRN-2: quem já tem link ativo do mesmo treino é ignorado (sem duplicar)', async () => {
  const tid = await criarTreino('NR-Lote-2');
  const f1 = await criarFunc('LOTE CICLANO');
  await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [f1] }); // 1º link
  const r = await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [f1] }); // repete
  const d = await r.json();
  assert.equal(d.criados.length, 0, 'não cria segundo link');
  assert.equal(d.ignorados.length, 1);
  assert.match(d.ignorados[0].motivo, /já tem link ativo/i);
});

test('TRN-3: sem treino ou sem funcionários → 400', async () => {
  assert.equal((await post('/api/treinamentos/convites/lote', { funcionarioIds: ['x'] })).status, 400);
  const tid = await criarTreino('NR-Lote-3');
  assert.equal((await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [] })).status, 400);
});

test('TRN-4: id inexistente é ignorado, os válidos continuam', async () => {
  const tid = await criarTreino('NR-Lote-4');
  const f1 = await criarFunc('LOTE VALIDO');
  const r = await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [f1, 'nao-existe-999'] });
  const d = await r.json();
  assert.equal(d.criados.length, 1);
  assert.equal(d.criados[0].funcionarioId, f1);
  assert.ok(d.ignorados.some(i => i.motivo === 'não encontrado'));
});

test('TRN-5: dias fora da faixa é saneado (1..90)', async () => {
  const tid = await criarTreino('NR-Lote-5');
  const f1 = await criarFunc('LOTE PRAZO');
  const r = await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [f1], dias: 9999 });
  const d = await r.json();
  const validadeDias = Math.round((d.criados[0].validadeTs - Date.now()) / 86400000);
  assert.ok(validadeDias <= 90, 'prazo limitado a 90 dias, veio ' + validadeDias);
});

// ===================== TRN-6..15 — Novo link e exclusão de convites (Acompanhamento) =====================
// Treinamento do Drive (sem trava de vídeo) com 1 questão, gabarito 'b'. Funcionários criados sem
// CPF: qualquer CPF de 11 dígitos entra no /entrar.
const CPF_TRN = '98765432100';
async function criarTreinoTrn(titulo) {
  const r = await post('/api/treinamentos', {
    titulo, tipo: 'NR', fileId: '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', validadeMeses: 12,
    questoes: [{ enunciado: 'ok?', alternativas: [{ id: 'a', texto: 'Não' }, { id: 'b', texto: 'Sim' }], correta: 'b' }],
  });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json()).id;
}
async function conviteTrn(tid, nome) {
  const fid = await criarFunc(nome);
  const d = await (await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [fid] })).json();
  assert.equal(d.criados.length, 1);
  return d.criados[0];
}
// Responde a prova pelo link público: 'b' aprova, 'a' reprova.
async function responderTrn(token, alternativa) {
  const e = await post(`/api/treinamentos/publico/${token}/entrar`, { cpf: CPF_TRN });
  assert.equal(e.status, 200, await e.clone().text());
  const q = (await e.json()).treino.questoes[0];
  const r = await post(`/api/treinamentos/publico/${token}/responder`, { respostas: { [q.id]: alternativa } });
  assert.equal(r.status, 200, await r.clone().text());
  return r.json();
}
const aprovarTrn = (token) => responderTrn(token, 'b');
const reprovarTrn = (token) => responderTrn(token, 'a');
// Vence o convite direto no JSON (modo local relê o arquivo a cada requisição).
function expirarTrn(conviteId) {
  const arq = path.join(tmp, 'treinamento_convites.json');
  const dados = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  dados.treinamentoConvites.find(c => c.id === conviteId).validadeTs = Date.now() - 60000;
  fs.writeFileSync(arq, JSON.stringify(dados));
}
const itemAcmp = async (tid, id) => (await getj(`/api/treinamentos/acompanhamento?treinamentoId=${tid}`)).itens.find(x => x.id === id);
const abreLink = async (token) => (await fetch(`${BASE}/api/treinamentos/publico/${token}`)).status;
const excluirLote = (ids) => post('/api/treinamentos/convites/excluir-lote', { ids });

test('TRN-6: excluir convite aguardando e expirado → 200; o link para de abrir e some do acompanhamento', async () => {
  const tid = await criarTreinoTrn('NR-Excluir-6');
  const a = await conviteTrn(tid, 'TRN6 AGUARDANDO'), x = await conviteTrn(tid, 'TRN6 EXPIRADO');
  expirarTrn(x.id);
  assert.equal((await itemAcmp(tid, x.id)).status, 'expirado');
  for (const c of [a, x]) {
    const r = await del(`/api/treinamentos/convites/${c.id}`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, excluidos: 1, tentativasRemovidas: 0, naoEncontrados: [] });
    assert.equal(await abreLink(c.token), 404, 'o link excluído não abre mais');
    assert.equal(await itemAcmp(tid, c.id), undefined);
  }
  assert.equal((await del(`/api/treinamentos/convites/${a.id}`)).status, 404, 'já excluído → 404');
});

test('TRN-7: convite concluído não é excluído (409 com a lista), nem pela aprovação sem o status gravado', async () => {
  const tid = await criarTreinoTrn('NR-Excluir-7');
  const c = await conviteTrn(tid, 'TRN7 APROVADO');
  assert.equal((await aprovarTrn(c.token)).aprovado, true);
  let r = await del(`/api/treinamentos/convites/${c.id}`);
  assert.equal(r.status, 409);
  const d = await r.json();
  assert.deepEqual(d.concluidos, [c.id]);
  assert.match(d.erro, /concluído/i);
  assert.ok(await itemAcmp(tid, c.id), 'continua no acompanhamento');
  // A 2ª escrita do /responder (status 'concluido') pode falhar: a conclusão aprovada basta.
  const arq = path.join(tmp, 'treinamento_convites.json');
  const dados = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  dados.treinamentoConvites.find(x => x.id === c.id).status = 'aguardando';
  fs.writeFileSync(arq, JSON.stringify(dados));
  const it = await itemAcmp(tid, c.id);
  assert.equal(it.concluido, true, 'acompanhamento marca concluido pela aprovação');
  r = await del(`/api/treinamentos/convites/${c.id}`);
  assert.equal(r.status, 409);
  assert.equal((await post(`/api/treinamentos/convites/${c.id}/regenerar`, {})).status, 409);
});

test('TRN-8: excluir-lote é tudo ou nada e valida a entrada (400/413/404/naoEncontrados)', async () => {
  const tid = await criarTreinoTrn('NR-Excluir-8');
  const a = await conviteTrn(tid, 'TRN8 A'), b = await conviteTrn(tid, 'TRN8 B'), c = await conviteTrn(tid, 'TRN8 CONCLUIDO');
  await aprovarTrn(c.token);
  let r = await excluirLote([a.id, c.id]);
  assert.equal(r.status, 409);
  assert.deepEqual((await r.json()).concluidos, [c.id]);
  assert.ok(await itemAcmp(tid, a.id), 'lote com concluído não apaga nenhum');
  assert.equal(await abreLink(a.token), 200);
  assert.equal((await excluirLote([])).status, 400);
  assert.equal((await excluirLote('TCVx')).status, 400);
  assert.equal((await post('/api/treinamentos/convites/excluir-lote', {})).status, 400);
  assert.equal((await excluirLote(Array.from({ length: 501 }, (_, n) => 'X' + n))).status, 413);
  assert.equal((await excluirLote(['nao-existe-1', 'nao-existe-2'])).status, 404);
  r = await excluirLote([a.id, b.id, 'nao-existe-3']);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.excluidos, 2);
  assert.deepEqual(d.naoEncontrados, ['nao-existe-3']);
  assert.equal(await itemAcmp(tid, a.id), undefined);
  assert.equal(await itemAcmp(tid, b.id), undefined);
  assert.ok(await itemAcmp(tid, c.id), 'o concluído continua');
});

test('TRN-9: excluir remove só as tentativas reprovadas do convite; a aprovação de outro convite fica', async () => {
  const tid = await criarTreinoTrn('NR-Excluir-9');
  const fid = await criarFunc('TRN9 MESMA PESSOA');
  const lote = async () => (await (await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [fid] })).json());
  const antigo = (await lote()).criados[0];
  await aprovarTrn(antigo.token); // convite antigo concluído (aprovado)
  const novo = (await lote()).criados[0]; // repetir o treinamento: convite novo
  assert.ok(novo && novo.id !== antigo.id);
  await reprovarTrn(novo.token);
  await reprovarTrn(novo.token);
  assert.equal((await itemAcmp(tid, novo.id)).tentativas, 2);
  const r = await del(`/api/treinamentos/convites/${novo.id}`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).tentativasRemovidas, 2);
  const conc = JSON.parse(fs.readFileSync(path.join(tmp, 'treinamento_conclusoes.json'), 'utf-8')).treinamentoConclusoes;
  assert.equal(conc.filter(k => k.conviteId === novo.id).length, 0, 'reprovadas do convite excluído saem');
  const doAntigo = conc.filter(k => k.conviteId === antigo.id);
  assert.equal(doAntigo.length, 1);
  assert.equal(doAntigo[0].aprovado, true, 'aprovação do outro convite preservada');
  assert.equal((await itemAcmp(tid, antigo.id)).concluido, true);
});

test('TRN-10: um Desfazer restaura convites e tentativas do lote excluído; o token antigo volta a abrir', async () => {
  const tid = await criarTreinoTrn('NR-Excluir-10');
  const a = await conviteTrn(tid, 'TRN10 A'), b = await conviteTrn(tid, 'TRN10 B');
  await reprovarTrn(a.token);
  const r = await excluirLote([a.id, b.id]);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).tentativasRemovidas, 1);
  assert.equal(await abreLink(a.token), 404);
  const u = await post('/api/desfazer/ultimo', { area: 'integracao' });
  assert.equal(u.status, 200, await u.clone().text());
  assert.equal(await abreLink(a.token), 200, 'token antigo volta a abrir');
  assert.equal(await abreLink(b.token), 200);
  assert.equal((await itemAcmp(tid, a.id)).tentativas, 1, 'a tentativa reprovada voltou');
  assert.ok(await itemAcmp(tid, b.id));
});

test('TRN-11: a trilha de segurança registra exclusão e novo link SEM o token', async () => {
  const tid = await criarTreinoTrn('NR-Seglog-11');
  const a = await conviteTrn(tid, 'TRN11 EXCLUIR'), b = await conviteTrn(tid, 'TRN11 REGERAR');
  const rg = await post(`/api/treinamentos/convites/${b.id}/regenerar`, {});
  assert.equal(rg.status, 200);
  const novoToken = (await rg.json()).convite.token;
  assert.equal((await del(`/api/treinamentos/convites/${a.id}`)).status, 200);
  const logs = JSON.parse(fs.readFileSync(path.join(tmp, 'seguranca_logs.json'), 'utf-8'));
  const exc = logs.filter(l => l.evento === 'treinamento_convite_excluido' && l.detalhes.includes('TRN11 EXCLUIR'));
  const reg = logs.filter(l => l.evento === 'treinamento_link_regerado' && l.detalhes.includes('TRN11 REGERAR'));
  assert.equal(exc.length, 1);
  assert.equal(exc[0].severidade, 'alerta');
  assert.equal(exc[0].area, 'integracao');
  assert.equal(exc[0].acao, 'excluir');
  assert.equal(reg.length, 1);
  assert.equal(reg[0].acao, 'regerar_link');
  const texto = JSON.stringify(logs);
  for (const tk of [a.token, b.token, novoToken]) assert.ok(!texto.includes(tk), 'nenhum token na trilha');
});

test('TRN-12: regenerar convite concluído → 409 com a orientação; inexistente → 404', async () => {
  const tid = await criarTreinoTrn('NR-Regerar-12');
  const c = await conviteTrn(tid, 'TRN12 CONCLUIDO');
  await aprovarTrn(c.token);
  const r = await post(`/api/treinamentos/convites/${c.id}/regenerar`, { dias: 10 });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).erro, 'Este treinamento já foi concluído. Para aplicar de novo, crie um novo convite.');
  assert.equal(await abreLink(c.token), 200, 'o link do concluído continua como estava');
  assert.equal((await post('/api/treinamentos/convites/nao-existe/regenerar', {})).status, 404);
});

test('TRN-13: regenerar troca o token, sanea dias e grava regeradoTs/regeradoPor/regeracoes', async () => {
  const tid = await criarTreinoTrn('NR-Regerar-13');
  const c = await conviteTrn(tid, 'TRN13 EXPIRADO');
  expirarTrn(c.id);
  let r = await post(`/api/treinamentos/convites/${c.id}/regenerar`, { dias: 15 });
  assert.equal(r.status, 200);
  let cv = (await r.json()).convite;
  assert.notEqual(cv.token, c.token);
  assert.equal(cv.status, 'aguardando');
  assert.equal(Math.round((cv.validadeTs - Date.now()) / 86400000), 15);
  assert.ok(cv.regeradoTs > 0);
  assert.equal(typeof cv.regeradoPor, 'string');
  assert.equal(cv.regeracoes, 1);
  assert.equal(await abreLink(c.token), 404, 'token antigo não abre');
  assert.equal(await abreLink(cv.token), 200);
  r = await post(`/api/treinamentos/convites/${c.id}/regenerar`, { dias: 9999 });
  cv = (await r.json()).convite;
  assert.equal(Math.round((cv.validadeTs - Date.now()) / 86400000), 90, 'dias limitado a 90');
  assert.equal(cv.regeracoes, 2);
  r = await post(`/api/treinamentos/convites/${c.id}/regenerar`, {});
  cv = (await r.json()).convite;
  assert.equal(Math.round((cv.validadeTs - Date.now()) / 86400000), 7, 'padrão de 7 dias');
  const it = await itemAcmp(tid, c.id);
  assert.equal(it.regeracoes, 3);
  assert.ok(it.regeradoTs > 0);
  assert.equal(typeof it.regeradoPor, 'string');
  assert.equal(typeof it.criadoPor, 'string');
  assert.equal(it.ultimoAcessoTs, 0);
  assert.equal(it.concluido, false);
  assert.equal(it.token, cv.token);
});

test('TRN-14: os campos do novo link sobrevivem a outras gravações dos convites', async () => {
  const tid = await criarTreinoTrn('NR-Regerar-14');
  const c = await conviteTrn(tid, 'TRN14 SOBREVIVE');
  const cv = (await (await post(`/api/treinamentos/convites/${c.id}/regenerar`, {})).json()).convite;
  // /entrar grava o acesso (regrava a coleção normalizada) e um lote novo grava de novo.
  const e = await post(`/api/treinamentos/publico/${cv.token}/entrar`, { cpf: CPF_TRN });
  assert.equal(e.status, 200);
  await conviteTrn(tid, 'TRN14 OUTRO');
  const salvo = JSON.parse(fs.readFileSync(path.join(tmp, 'treinamento_convites.json'), 'utf-8')).treinamentoConvites.find(x => x.id === c.id);
  assert.equal(salvo.regeracoes, 1);
  assert.equal(salvo.regeradoTs, cv.regeradoTs);
  assert.equal(salvo.regeradoPor, cv.regeradoPor);
  const it = await itemAcmp(tid, c.id);
  assert.equal(it.regeracoes, 1);
  assert.ok(it.ultimoAcessoTs > 0, 'último acesso aparece no acompanhamento');
});

test('TRN-15: lote devolve o link ativo (o aguardando mais recente) de quem já tem', async () => {
  const tid = await criarTreinoTrn('NR-Lote-15');
  const fid = await criarFunc('TRN15 ATIVO');
  const primeiro = (await (await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [fid] })).json()).criados[0];
  // Um 2º aguardando da mesma pessoa (via rota individual) é o mais recente.
  await new Promise((r) => setTimeout(r, 5));
  const r2 = await post('/api/treinamentos/convites', { funcionarioId: fid, treinamentoId: tid });
  assert.equal(r2.status, 201);
  const segundo = (await r2.json()).convite;
  const d = await (await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [fid] })).json();
  assert.equal(d.criados.length, 0);
  const ig = d.ignorados[0];
  assert.equal(ig.motivo, 'já tem link ativo');
  assert.deepEqual(ig.convite, { id: segundo.id, token: segundo.token, validadeTs: segundo.validadeTs, status: 'aguardando' });
  assert.notEqual(ig.convite.id, primeiro.id);
  // Expirado não conta como ativo: vence os dois e o lote cria um novo.
  expirarTrn(primeiro.id); expirarTrn(segundo.id);
  const d2 = await (await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [fid] })).json();
  assert.equal(d2.criados.length, 1);
});

test('TRN-16: Excel do Acompanhamento traz só os ids da tela, na ordem, sem o link e com o CPF mascarado', async () => {
  const XLSX_TE = require('xlsx'); // require preguiçoso, como nos demais testes do arquivo
  const tid = await criarTreinoTrn('NR-Exportar-16');
  const a = await conviteTrn(tid, 'TRN16 APROVADO'), b = await conviteTrn(tid, 'TRN16 AGUARDANDO'), c = await conviteTrn(tid, 'TRN16 FORA DO FILTRO');
  await aprovarTrn(a.token);
  const r = await post('/api/treinamentos/acompanhamento/exportar', { ids: [b.id, a.id] });
  assert.equal(r.status, 200, await r.clone().text());
  assert.match(r.headers.get('content-type') || '', /spreadsheetml/);
  const wb = XLSX_TE.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
  assert.equal(wb.SheetNames[0], 'ACOMPANHAMENTO');
  const linhas = XLSX_TE.utils.sheet_to_json(wb.Sheets.ACOMPANHAMENTO, { defval: '' });
  // Ordem da tela (ids enviados) e nada além do que foi pedido.
  assert.deepEqual(linhas.map(l => l['FUNCIONÁRIO']), ['TRN16 AGUARDANDO', 'TRN16 APROVADO']);
  const [ag, ap] = linhas;
  assert.equal(ag['SITUAÇÃO'], 'Em andamento'); // mesmo nome do indicador da tela (1.55.45)
  assert.match(ag['LINK VÁLIDO ATÉ'], /^\d{2}\/\d{2}\/\d{4}$/);
  assert.equal(ap['SITUAÇÃO'], 'Concluído');
  assert.equal(ap['ÚLTIMA NOTA (%)'], 100);
  assert.match(ap['APROVADO EM'], /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  assert.match(ap['CERTIFICADO VÁLIDO ATÉ'], /^\d{2}\/\d{2}\/\d{4}$/); // treinamento com validade de 12 meses
  assert.equal(ap['CPF INFORMADO'], '***.***.321-00');
  assert.equal(ap['VÍDEO'], 'Sem trava (Drive)');
  // O link (token) abre a prova em nome da pessoa: nunca vai para a planilha.
  const tudo = JSON.stringify(linhas);
  for (const cv of [a, b, c]) assert.ok(!tudo.includes(cv.token), 'o token do convite não pode sair na planilha');
});

test('TRN-17: acompanhamento traz as tentativas, a validade do certificado e a origem do vídeo (sem as respostas)', async () => {
  const tid = await criarTreinoTrn('NR-Painel-17');
  const a = await conviteTrn(tid, 'TRN17 REPROVOU E PASSOU'), b = await conviteTrn(tid, 'TRN17 SO REPROVOU'), c = await conviteTrn(tid, 'TRN17 NAO ABRIU');
  await reprovarTrn(a.token);
  await aprovarTrn(a.token);
  await reprovarTrn(b.token);
  const ia = await itemAcmp(tid, a.id), ib = await itemAcmp(tid, b.id), ic = await itemAcmp(tid, c.id);
  // Cada tentativa, da mais antiga para a mais nova, só com data, nota e resultado.
  assert.deepEqual(ia.provas.map(p => [p.nota, p.aprovado]), [[0, false], [100, true]]);
  assert.ok(ia.provas[0].ts <= ia.provas[1].ts);
  for (const p of ia.provas) assert.deepEqual(Object.keys(p).sort(), ['aprovado', 'nota', 'ts']);
  assert.equal(ia.concluido, true);
  assert.deepEqual(ib.provas.map(p => p.aprovado), [false]);
  assert.equal(ib.concluido, false);
  assert.deepEqual(ic.provas, []);
  // Validade do certificado em meses (o treinamento de teste tem 12) e a origem do vídeo (Drive).
  for (const it of [ia, ib, ic]) {
    assert.equal(it.validadeMeses, 12);
    assert.equal(it.origemVideo, 'drive');
  }
  // Validade pronta (AAAA-MM-DD, fuso de Brasília): a MESMA conta do PDF do atestado e da planilha.
  const fmt = (ts) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ts));
  const [aa, mm, dd] = fmt(ia.concluidoTs).split('-').map(Number);
  assert.equal(ia.certificadoAte, new Date(Date.UTC(aa + 1, mm - 1, dd, 12)).toISOString().slice(0, 10));
  assert.equal(ib.certificadoAte, null, 'sem aprovação → null');
  assert.equal(ic.certificadoAte, null);
  // As respostas marcadas na prova nunca saem no acompanhamento.
  assert.ok(!JSON.stringify([ia, ib, ic]).includes('respostas'));
});

// ===================== TRV — Vídeo do treinamento enviado (player travado) =====================
// Driver LOCAL (sem VIDEO_S3_*), partes de 1 KiB (VIDEO_PARTE_BYTES_TESTE). O "vídeo" é um Buffer
// que começa com a assinatura EBML do WebM (1A 45 DF A3): o servidor só confere os bytes mágicos,
// não decodifica.
const CPF_TRV = '12345678901'; // funcionário criado sem CPF: qualquer CPF de 11 dígitos entra
const QUESTOES_TRV = [{ enunciado: 'ok?', alternativas: [{ id: 'a', texto: 'Não' }, { id: 'b', texto: 'Sim' }], correta: 'b' }];
function videoFalso(bytes) {
  const b = Buffer.alloc(bytes, 0x41);
  Buffer.from('1a45dfa3', 'hex').copy(b, 0);
  return b;
}
const urlParte = (n, chave, uploadId) => `${BASE}/api/treinamentos/videos/partes/${n}?chave=${encodeURIComponent(chave)}&uploadId=${encodeURIComponent(uploadId)}`;
const putParte = (n, chave, uploadId, buf) => fetch(urlParte(n, chave, uploadId), { method: 'PUT', headers: { ...ORIG, 'Content-Type': 'application/octet-stream' }, body: buf });
async function iniciarVideo({ bytes = 1500, duracaoSeg = 60, nome = 'aula.webm', mime = 'video/webm' } = {}) {
  const r = await post('/api/treinamentos/videos/iniciar', { nome, bytes, mime, duracaoSeg });
  assert.equal(r.status, 201, await r.clone().text());
  return r.json();
}
// Envio completo (iniciar → partes → concluir). Devolve o `video` do /concluir.
async function enviarVideo(op = {}) {
  const { bytes = 1500, duracaoSeg = 60, nome = 'aula.webm', mime = 'video/webm' } = op;
  const { chave, uploadId, parteBytes, totalPartes } = await iniciarVideo({ bytes, duracaoSeg, nome, mime });
  const buf = videoFalso(bytes);
  for (let n = 1; n <= totalPartes; n++) {
    const r = await putParte(n, chave, uploadId, buf.subarray((n - 1) * parteBytes, Math.min(n * parteBytes, bytes)));
    assert.equal(r.status, 200, `parte ${n}: ` + await r.text());
  }
  const c = await post('/api/treinamentos/videos/concluir', { chave, uploadId, nome, bytes, mime, duracaoSeg });
  assert.equal(c.status, 200, await c.clone().text());
  return (await c.json()).video;
}
async function criarTreinoComVideo(titulo, duracaoSeg = 60) {
  const video = await enviarVideo({ duracaoSeg });
  const r = await post('/api/treinamentos', { titulo, tipo: 'NR', validadeMeses: 12, questoes: QUESTOES_TRV, video: { chave: video.chave, nome: video.nome, duracaoSeg } });
  assert.equal(r.status, 201, await r.clone().text());
  return { treino: await r.json(), video };
}
async function conviteTrv(treinamentoId, nome) {
  const fid = await criarFunc(nome);
  const d = await (await post('/api/treinamentos/convites/lote', { treinamentoId, funcionarioIds: [fid] })).json();
  assert.equal(d.criados.length, 1);
  return d.criados[0];
}
const entrarTrv = (token) => post(`/api/treinamentos/publico/${token}/entrar`, { cpf: CPF_TRV });
const eventoTrv = (token, evento) => post(`/api/treinamentos/publico/${token}/video`, { evento });
const responderTrv = (token) => post(`/api/treinamentos/publico/${token}/responder`, { respostas: {} });

test('TRV-1: treinamento com link do Drive continua sem trava (sem vídeo, prova liberada)', async () => {
  const tid = await criarTreino('NR-Drive-TRV');
  const conv = await conviteTrv(tid, 'TRV DRIVE');
  const r = await entrarTrv(conv.token);
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.treino.fileId, '1AbCdEfGhIjKlMnOpQrStUvWxYz012345', 'Drive continua indo para a página');
  assert.equal(d.treino.video, null);
  assert.equal(d.progresso.provaLiberada, true);
  const ev = await eventoTrv(conv.token, 'inicio');
  assert.equal(ev.status, 409);
  assert.equal((await ev.json()).codigo, 'SEM_VIDEO');
  assert.equal((await responderTrv(conv.token)).status, 200, 'prova sem trava');
  const it = (await getj(`/api/treinamentos/acompanhamento?treinamentoId=${tid}`)).itens[0];
  assert.equal(it.video, null, 'acompanhamento sem vídeo enviado → video null');
});

test('TRV-2: envio em 2 partes vira o vídeo do treinamento; sem vídeo e sem Drive → 400', async () => {
  const cfg = await getj('/api/treinamentos/videos/config');
  assert.equal(cfg.ativo, true);
  assert.equal(cfg.tipo, 'local');
  assert.equal(cfg.parteBytes, 1024);
  assert.deepEqual(cfg.mimes, ['video/mp4', 'video/webm']);
  const ini = await iniciarVideo({ bytes: 1500 });
  assert.equal(ini.totalPartes, 2, '1500 bytes em partes de 1024 = 2 partes');
  assert.match(ini.chave, /^videos-treino\/\d{4}\/[a-f0-9]{32}\.webm$/);
  await del(`/api/treinamentos/videos/upload?chave=${encodeURIComponent(ini.chave)}&uploadId=${ini.uploadId}`);

  const { treino, video } = await criarTreinoComVideo('NR-Video-TRV2', 90);
  assert.equal(video.bytes, 1500);
  assert.equal(video.mime, 'video/webm');
  assert.equal(treino.fileId, '');
  assert.equal(treino.video.chave, video.chave);
  assert.equal(treino.video.duracaoSeg, 90);
  const lista = (await getj('/api/treinamentos')).treinamentos;
  assert.equal(lista.find(t => t.id === treino.id).video.bytes, 1500, 'GET /api/treinamentos traz o vídeo');
  // PUT sem `video` mantém; `video:null` sem Drive é recusado.
  const semVideo = { titulo: 'NR-Video-TRV2', tipo: 'NR', validadeMeses: 12, questoes: QUESTOES_TRV };
  let r = await put(`/api/treinamentos/${treino.id}`, semVideo);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).video.chave, video.chave, 'PUT sem video mantém o atual');
  r = await put(`/api/treinamentos/${treino.id}`, { ...semVideo, video: null });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).erro, 'Envie o vídeo do treinamento ou informe o link do Google Drive.');
  r = await post('/api/treinamentos', { ...semVideo, titulo: 'NR-Sem-Nada' });
  assert.equal(r.status, 400);
});

test('TRV-3: formato, duração, tamanho e bytes mágicos são conferidos', async () => {
  let r = await post('/api/treinamentos/videos/iniciar', { nome: 'aula.mov', bytes: 1500, mime: 'video/quicktime', duracaoSeg: 60 });
  assert.equal(r.status, 400, '.mov recusado');
  r = await post('/api/treinamentos/videos/iniciar', { nome: 'aula.mp4', bytes: 1500, mime: 'video/mp4', duracaoSeg: 0 });
  assert.equal(r.status, 400, 'duração inválida');
  r = await post('/api/treinamentos/videos/iniciar', { nome: 'aula.mp4', bytes: 5 * 1024 * 1024 * 1024, mime: 'video/mp4', duracaoSeg: 60 });
  assert.equal(r.status, 413, 'acima do máximo');
  // Parte 1 que não é vídeo (HTML renomeado) → 415.
  const a = await iniciarVideo({ bytes: 1500 });
  r = await putParte(1, a.chave, a.uploadId, Buffer.concat([Buffer.from('<!doctype html><html>'), Buffer.alloc(1003, 0x20)]));
  assert.equal(r.status, 415);
  // Parte maior que parteBytes → 400; tamanho conferido quando o total vem em ?bytes=.
  r = await putParte(2, a.chave, a.uploadId, Buffer.alloc(1500, 0x41));
  assert.equal(r.status, 400);
  r = await fetch(urlParte(2, a.chave, a.uploadId) + '&bytes=1500', { method: 'PUT', headers: { ...ORIG, 'Content-Type': 'application/octet-stream' }, body: Buffer.alloc(400, 0x41) });
  assert.equal(r.status, 400, 'a última parte de 1500 bytes tem 476, não 400');
  // Concluir com parte faltando → 400 PARTES_INVALIDAS; cancelar → 200 e o upload some.
  assert.equal((await putParte(1, a.chave, a.uploadId, videoFalso(1024))).status, 200);
  r = await post('/api/treinamentos/videos/concluir', { chave: a.chave, uploadId: a.uploadId, nome: 'aula.webm', bytes: 1500, mime: 'video/webm', duracaoSeg: 60 });
  assert.equal(r.status, 400);
  assert.equal((await r.json()).codigo, 'PARTES_INVALIDAS');
  assert.equal((await del(`/api/treinamentos/videos/upload?chave=${encodeURIComponent(a.chave)}&uploadId=${a.uploadId}`)).status, 200);
  assert.equal((await putParte(2, a.chave, a.uploadId, Buffer.alloc(476, 0x41))).status, 404, 'envio cancelado não aceita parte');
  // MP4 declarado com conteúdo WebM → 415 (o conteúdo tem de bater com a extensão da chave).
  const m = await iniciarVideo({ bytes: 1500, nome: 'aula.mp4', mime: 'video/mp4' });
  assert.equal((await putParte(1, m.chave, m.uploadId, videoFalso(1024))).status, 415);
  await del(`/api/treinamentos/videos/upload?chave=${encodeURIComponent(m.chave)}&uploadId=${m.uploadId}`);
});

test('TRV-4: chave com ../ ou fora de videos-treino/ é recusada em todas as portas', async () => {
  const ruim = 'videos-treino/2026/../../usuarios.json';
  let r = await putParte(1, ruim, '0123456789abcdef0123456789abcdef', videoFalso(1024));
  assert.equal(r.status, 400);
  r = await post('/api/treinamentos/videos/concluir', { chave: ruim, uploadId: 'x', nome: 'a.webm', bytes: 1500, mime: 'video/webm', duracaoSeg: 60 });
  assert.equal(r.status, 400);
  r = await post('/api/treinamentos', { titulo: 'NR-Chave-Ruim', tipo: 'NR', questoes: QUESTOES_TRV, video: { chave: '../usuarios.json', nome: 'x', duracaoSeg: 60 } });
  assert.equal(r.status, 400);
  // Chave bem formada que não existe no armazenamento também não entra.
  r = await post('/api/treinamentos', { titulo: 'NR-Chave-Fantasma', tipo: 'NR', questoes: QUESTOES_TRV, video: { chave: 'videos-treino/2026/0123456789abcdef0123456789abcdef.mp4', nome: 'x', duracaoSeg: 60 } });
  assert.equal(r.status, 400);
});

test('TRV-5: /entrar devolve o vídeo sem a chave e a rota local responde Range 206', async () => {
  const { treino } = await criarTreinoComVideo('NR-Video-TRV5');
  const conv = await conviteTrv(treino.id, 'TRV RANGE');
  const outro = await conviteTrv(treino.id, 'TRV SEM ENTRAR');
  const r = await entrarTrv(conv.token);
  assert.equal(r.status, 200);
  const texto = await r.text();
  assert.doesNotMatch(texto, /videos-treino\//, 'a chave nunca sai para a página pública');
  const d = JSON.parse(texto);
  assert.equal(d.treino.fileId, '');
  assert.match(d.treino.video.ref, /^[a-f0-9]{12}$/);
  assert.equal(d.treino.video.url, `/api/treinamentos/publico/${conv.token}/video?r=${d.treino.video.ref}`);
  assert.equal(d.treino.video.duracaoSeg, 60);
  assert.equal(d.treino.video.mime, 'video/webm');
  assert.ok(d.treino.video.expiraTs > Date.now());
  assert.deepEqual(d.progresso, { iniciadoTs: 0, concluidoTs: 0, liberadoRh: false, provaLiberada: false });
  const v = await fetch(BASE + d.treino.video.url, { headers: { Range: 'bytes=0-99' } });
  assert.equal(v.status, 206);
  assert.equal(v.headers.get('content-range'), 'bytes 0-99/1500');
  const corpo = Buffer.from(await v.arrayBuffer());
  assert.equal(corpo.length, 100);
  assert.equal(corpo.subarray(0, 4).toString('hex'), '1a45dfa3');
  // Quem não passou pelo /entrar não baixa nem registra evento.
  const sem = await fetch(`${BASE}/api/treinamentos/publico/${outro.token}/video`);
  assert.equal(sem.status, 403);
  assert.equal((await eventoTrv(outro.token, 'inicio')).status, 403);
  // Renovar a URL e a prévia do RH.
  const u = await (await post(`/api/treinamentos/publico/${conv.token}/video/url`, {})).json();
  assert.equal(u.ok, true);
  assert.equal(u.url, d.treino.video.url);
  const rh = await getj(`/api/treinamentos/${treino.id}/video-url`);
  assert.equal(rh.url, `/api/treinamentos/${treino.id}/video`);
  assert.equal((await fetch(BASE + rh.url, { headers: { Range: 'bytes=0-' } })).status, 206);
});

test('TRV-6: prova travada até o fim do vídeo; fim imediato de vídeo de 60 s → VIDEO_CEDO', async () => {
  const { treino } = await criarTreinoComVideo('NR-Video-TRV6', 60);
  const conv = await conviteTrv(treino.id, 'TRV CEDO');
  await entrarTrv(conv.token);
  let r = await responderTrv(conv.token);
  assert.equal(r.status, 409);
  let d = await r.json();
  assert.equal(d.codigo, 'VIDEO_PENDENTE');
  assert.equal(d.erro, 'Assista ao vídeo até o fim para liberar a prova.');
  r = await eventoTrv(conv.token, 'inicio');
  assert.equal(r.status, 200);
  const ini = (await r.json()).progresso.iniciadoTs;
  assert.ok(ini > 0);
  r = await eventoTrv(conv.token, 'inicio');
  assert.equal((await r.json()).progresso.iniciadoTs, ini, 'inicio repetido não reinicia o relógio');
  r = await eventoTrv(conv.token, 'fim');
  assert.equal(r.status, 409);
  d = await r.json();
  assert.equal(d.codigo, 'VIDEO_CEDO');
  assert.ok(d.faltamSeg >= 50 && d.faltamSeg <= 54, 'faltam ~54 s (60 × 0,95 − 3), veio ' + d.faltamSeg);
  assert.equal((await responderTrv(conv.token)).status, 409, 'continua travada');
  assert.equal((await eventoTrv(conv.token, 'pular')).status, 400, 'evento inválido');
});

test('TRV-7: vídeo curto terminado libera a prova; trocar o vídeo trava de novo quem não foi aprovado', async () => {
  const { treino } = await criarTreinoComVideo('NR-Video-TRV7', 1);
  const conv = await conviteTrv(treino.id, 'TRV FIM');
  await entrarTrv(conv.token);
  let r = await eventoTrv(conv.token, 'fim');
  assert.equal(r.status, 409, "'fim' sem 'inicio' grava o início e devolve VIDEO_CEDO");
  assert.equal((await r.json()).codigo, 'VIDEO_CEDO');
  r = await eventoTrv(conv.token, 'fim');
  assert.equal(r.status, 200);
  const p = (await r.json()).progresso;
  assert.ok(p.concluidoTs > 0);
  assert.equal(p.provaLiberada, true);
  assert.equal((await eventoTrv(conv.token, 'fim')).status, 200, 'idempotente');
  // Reprovou (respostas vazias = nota 0): refazer NÃO exige rever o vídeo.
  r = await responderTrv(conv.token);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).aprovado, false);
  assert.equal((await responderTrv(conv.token)).status, 200, 'segunda tentativa sem rever o vídeo');
  // Vídeo novo (chave nova) → o progresso da chave antiga não vale mais.
  const novo = await enviarVideo({ duracaoSeg: 30 });
  r = await put(`/api/treinamentos/${treino.id}`, { titulo: 'NR-Video-TRV7', tipo: 'NR', validadeMeses: 12, questoes: QUESTOES_TRV, video: { chave: novo.chave, nome: 'v2.webm', duracaoSeg: 30 } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).video.chave, novo.chave);
  r = await responderTrv(conv.token);
  assert.equal(r.status, 409);
  assert.equal((await r.json()).codigo, 'VIDEO_PENDENTE', 'vídeo trocado: assiste de novo');
  const ent = await (await entrarTrv(conv.token)).json();
  assert.equal(ent.progresso.concluidoTs, 0);
  assert.equal(ent.treino.video.duracaoSeg, 30);
});

test('TRV-8: link expirado ou cancelado não entra (409 LINK_FECHADO)', async () => {
  const { treino } = await criarTreinoComVideo('NR-Video-TRV8');
  const conv = await conviteTrv(treino.id, 'TRV EXPIRADO');
  assert.equal((await entrarTrv(conv.token)).status, 200);
  // Vence o convite direto no JSON (modo local relê o arquivo a cada requisição).
  const arq = path.join(tmp, 'treinamento_convites.json');
  const dados = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  dados.treinamentoConvites.find(c => c.id === conv.id).validadeTs = Date.now() - 60000;
  fs.writeFileSync(arq, JSON.stringify(dados));
  let r = await entrarTrv(conv.token);
  assert.equal(r.status, 409);
  const d = await r.json();
  assert.equal(d.codigo, 'LINK_FECHADO');
  assert.equal(d.status, 'expirado');
  r = await eventoTrv(conv.token, 'inicio');
  assert.equal(r.status, 409);
  assert.equal((await r.json()).codigo, 'LINK_FECHADO');
  assert.equal((await fetch(`${BASE}/api/treinamentos/publico/${conv.token}/video`)).status, 409);
  // Enviar a prova com o link vencido também devolve LINK_FECHADO (a página mostra a tela de link vencido).
  r = await responderTrv(conv.token);
  assert.equal(r.status, 409);
  const dr = await r.json();
  assert.equal(dr.codigo, 'LINK_FECHADO');
  assert.equal(dr.status, 'expirado');
  // Cancelado pelo RH: mesmo código, com o status certo.
  const conv2 = await conviteTrv(treino.id, 'TRV CANCELADO');
  const dados2 = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  dados2.treinamentoConvites.find(c => c.id === conv2.id).status = 'cancelado';
  fs.writeFileSync(arq, JSON.stringify(dados2));
  r = await responderTrv(conv2.token);
  assert.equal(r.status, 409);
  const dc = await r.json();
  assert.equal(dc.codigo, 'LINK_FECHADO');
  assert.equal(dc.status, 'cancelado');
});

test('TRV-9: o envio do vídeo não entra no Desfazer da Integração', async () => {
  const status = async () => {
    const s = await getj('/api/desfazer/status?area=integracao');
    return { disponivel: s.disponivel, descricao: s.descricao, expiraEm: s.expiraEm, restantes: s.restantes };
  };
  const antes = await status();
  const a = await iniciarVideo({ bytes: 1500 });
  assert.equal((await putParte(1, a.chave, a.uploadId, videoFalso(1024))).status, 200);
  assert.equal((await putParte(2, a.chave, a.uploadId, Buffer.alloc(476, 0x41))).status, 200);
  const c = await post('/api/treinamentos/videos/concluir', { chave: a.chave, uploadId: a.uploadId, nome: 'aula.webm', bytes: 1500, mime: 'video/webm', duracaoSeg: 60 });
  assert.equal(c.status, 200);
  const b = await iniciarVideo({ bytes: 1500 });
  assert.equal((await del(`/api/treinamentos/videos/upload?chave=${encodeURIComponent(b.chave)}&uploadId=${b.uploadId}`)).status, 200);
  assert.deepEqual(await status(), antes, 'iniciar/partes/concluir/cancelar não criam operação desfazível');

  // O que a exclusão evita de fato: dentro do journal, a parte seguraria as travas dos módulos
  // da Integração (inclusive Funcionários) enquanto o corpo sobe. Com uma parte "lenta" no meio
  // do caminho, um cadastro em Funcionários tem de responder normalmente.
  const lenta = await iniciarVideo({ bytes: 1500 });
  const buf = videoFalso(1024);
  const req = http.request(urlParte(1, lenta.chave, lenta.uploadId), { method: 'PUT', headers: { ...ORIG, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) } });
  const fimLenta = new Promise((ok, falha) => {
    req.on('response', (r) => { r.resume(); r.on('end', () => ok(r.statusCode)); });
    req.on('error', falha);
  });
  req.write(buf.subarray(0, 100));
  await new Promise((r) => setTimeout(r, 300));
  const f = await fetch(`${BASE}/api/funcionarios`, { method: 'POST', headers: JSONH, body: JSON.stringify({ nome: 'TRV TRAVA', status: 'Ativo' }), signal: AbortSignal.timeout(5000) });
  assert.equal(f.status, 201, 'Funcionários não fica preso atrás do envio do vídeo');
  req.end(buf.subarray(100));
  assert.equal(await fimLenta, 200);
  await del(`/api/treinamentos/videos/upload?chave=${encodeURIComponent(lenta.chave)}&uploadId=${lenta.uploadId}`);
});

test('TRV-10: acompanhamento mostra o vídeo e "liberar prova" destrava o /responder', async () => {
  const { treino } = await criarTreinoComVideo('NR-Video-TRV10', 600);
  const conv = await conviteTrv(treino.id, 'TRV LIBERAR');
  await entrarTrv(conv.token);
  await eventoTrv(conv.token, 'inicio');
  let it = (await getj(`/api/treinamentos/acompanhamento?treinamentoId=${treino.id}`)).itens.find(x => x.id === conv.id);
  assert.equal(it.video.duracaoSeg, 600);
  assert.ok(it.video.iniciadoTs > 0);
  assert.equal(it.video.concluidoTs, 0);
  assert.equal(it.video.pendente, true);
  assert.equal(it.origemVideo, 'arquivo', 'vídeo enviado → origem "arquivo" (player travado)');
  assert.equal((await responderTrv(conv.token)).status, 409);
  let r = await post(`/api/treinamentos/convites/${conv.id}/liberar-prova`, {});
  assert.equal(r.status, 200);
  const lib = (await r.json()).convite.video;
  assert.ok(lib.liberadoTs > 0);
  assert.ok(lib.inicioTs > 0, 'liberar mantém o início já gravado');
  it = (await getj(`/api/treinamentos/acompanhamento?treinamentoId=${treino.id}`)).itens.find(x => x.id === conv.id);
  assert.equal(it.video.pendente, false);
  assert.ok(it.video.liberadoTs > 0);
  const ent = await (await entrarTrv(conv.token)).json();
  assert.equal(ent.progresso.liberadoRh, true);
  assert.equal(ent.progresso.provaLiberada, true);
  // Aprova (gabarito 'b' na única questão) → convite concluído → liberar de novo é 409.
  const q = ent.treino.questoes[0];
  r = await post(`/api/treinamentos/publico/${conv.token}/responder`, { respostas: { [q.id]: 'b' } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).aprovado, true);
  assert.equal((await post(`/api/treinamentos/convites/${conv.id}/liberar-prova`, {})).status, 409, 'concluído');
  // Treinamento do Drive: não há vídeo para liberar.
  const tid = await criarTreino('NR-Drive-TRV10');
  const cd = await conviteTrv(tid, 'TRV LIBERAR DRIVE');
  assert.equal((await post(`/api/treinamentos/convites/${cd.id}/liberar-prova`, {})).status, 409);
  assert.equal((await post('/api/treinamentos/convites/nao-existe/liberar-prova', {})).status, 404);
});

test('TRV-11: no máximo 2 partes ao mesmo tempo; a 3ª recebe 503 + Retry-After', async () => {
  const a = await iniciarVideo({ bytes: 1500 });
  const lentas = [1, 2].map((n) => {
    const buf = n === 1 ? videoFalso(1024) : Buffer.alloc(476, 0x41);
    const req = http.request(urlParte(n, a.chave, a.uploadId), { method: 'PUT', headers: { ...ORIG, 'Content-Type': 'application/octet-stream', 'Content-Length': String(buf.length) } });
    const fim = new Promise((ok, falha) => {
      req.on('response', (r) => { r.resume(); r.on('end', () => ok(r.statusCode)); });
      req.on('error', falha);
    });
    req.write(buf.subarray(0, 10));
    return { req, buf, fim };
  });
  await new Promise((r) => setTimeout(r, 300));
  const r = await putParte(1, a.chave, a.uploadId, videoFalso(1024));
  assert.equal(r.status, 503);
  assert.equal(r.headers.get('retry-after'), '2');
  for (const l of lentas) l.req.end(l.buf.subarray(10));
  assert.deepEqual(await Promise.all(lentas.map((l) => l.fim)), [200, 200]);
  assert.equal((await putParte(1, a.chave, a.uploadId, videoFalso(1024))).status, 200, 'vaga devolvida no fim');
  await del(`/api/treinamentos/videos/upload?chave=${encodeURIComponent(a.chave)}&uploadId=${a.uploadId}`);
});

test('TRV-12: faxina marca o órfão na 1ª rodada, apaga só depois da carência e cancela envio abandonado', async () => {
  const { video } = await criarTreinoComVideo('NR-Video-TRV11');
  const raiz = path.join(tmp, 'videos');
  const arqOrfaos = path.join(tmp, 'videos_orfaos.json');
  const velho = new Date(Date.now() - 200 * 86400000);
  const chaveOrfao = 'videos-treino/2020/' + 'ab'.repeat(16) + '.mp4';
  const chaveOrfaoNovo = 'videos-treino/2026/' + 'cd'.repeat(16) + '.mp4';
  const noDisco = (chave) => path.join(raiz, ...chave.split('/'));
  const orfao = noDisco(chaveOrfao), orfaoNovo = noDisco(chaveOrfaoNovo);
  fs.mkdirSync(path.dirname(orfao), { recursive: true });
  fs.mkdirSync(path.dirname(orfaoNovo), { recursive: true });
  fs.writeFileSync(orfao, 'x'); fs.utimesSync(orfao, velho, velho);
  fs.writeFileSync(orfaoNovo, 'x');
  const citado = noDisco(video.chave);
  fs.utimesSync(citado, velho, velho); // antigo, mas citado por um treinamento: fica
  // Enviado há muito tempo e ainda sem treinamento na 1ª rodada; depois passa a ser citado.
  const volta = await enviarVideo();
  fs.utimesSync(noDisco(volta.chave), velho, velho);
  const abandonado = path.join(raiz, '.parciais', 'ef'.repeat(16));
  fs.mkdirSync(abandonado, { recursive: true });
  fs.writeFileSync(path.join(abandonado, 'meta.json'), JSON.stringify({ chave: 'videos-treino/2026/' + 'ef'.repeat(16) + '.webm', mime: 'video/webm', iniciadoTs: velho.getTime() }));
  const lerOrfaos = () => new Map(JSON.parse(fs.readFileSync(arqOrfaos, 'utf-8')).itens.map(i => [i.chave, i.vistoTs]));

  // 1ª rodada: o envio abandonado cai, mas NENHUM vídeo é apagado. Mesmo o órfão enviado há
  // 200 dias só é marcado: a carência conta de quando ele ficou sem treinamento, não do envio.
  let r = await post('/api/treinamentos/videos/faxina', {});
  assert.equal(r.status, 200);
  let d = await r.json();
  assert.equal(d.removidos, 0, '1ª rodada só marca');
  assert.equal(d.uploadsAbortados, 1);
  assert.ok(d.marcados >= 3);
  assert.equal(fs.existsSync(orfao), true, 'órfão antigo fica na 1ª rodada');
  assert.equal(fs.existsSync(abandonado), false, 'envio abandonado cancelado');
  let vistos = lerOrfaos();
  for (const k of [chaveOrfao, chaveOrfaoNovo, volta.chave]) assert.ok(vistos.get(k) > Date.now() - 60000, `marcado agora: ${k}`);
  assert.equal(vistos.has(video.chave), false, 'vídeo citado não entra na lista');

  // O vídeo "volta" passa a ser citado; a lista ganha uma chave que já saiu do bucket; e o tempo
  // anda: a carência (VIDEO_ORFAO_DIAS, 90 por padrão) venceu para todas as marcas.
  const r2 = await post('/api/treinamentos', { titulo: 'NR-Video-TRV12-volta', tipo: 'NR', validadeMeses: 12, questoes: QUESTOES_TRV, video: { chave: volta.chave, nome: volta.nome, duracaoSeg: 60 } });
  assert.equal(r2.status, 201, await r2.clone().text());
  const sumiu = 'videos-treino/2019/' + '12'.repeat(16) + '.mp4';
  const doc = JSON.parse(fs.readFileSync(arqOrfaos, 'utf-8'));
  for (const i of doc.itens) if ([chaveOrfao, chaveOrfaoNovo, volta.chave].includes(i.chave)) i.vistoTs = velho.getTime();
  doc.itens.push({ chave: sumiu, vistoTs: velho.getTime() });
  fs.writeFileSync(arqOrfaos, JSON.stringify(doc));

  // 2ª rodada: apaga só o órfão com marca vencida E arquivo antigo.
  r = await post('/api/treinamentos/videos/faxina', {});
  d = await r.json();
  assert.equal(d.removidos, 1);
  assert.equal(fs.existsSync(orfao), false, 'órfão com a carência vencida removido');
  assert.equal(fs.existsSync(orfaoNovo), true, 'arquivo recente fica mesmo com a marca antiga');
  assert.equal(fs.existsSync(noDisco(volta.chave)), true, 'vídeo que voltou a ser citado fica');
  assert.equal(fs.existsSync(citado), true, 'vídeo citado fica');
  vistos = lerOrfaos();
  assert.equal(vistos.has(chaveOrfao), false, 'apagado sai da lista');
  assert.equal(vistos.has(volta.chave), false, 'citado de novo sai da lista');
  assert.equal(vistos.has(sumiu), false, 'chave que não existe mais no bucket sai da lista');
  assert.equal(vistos.get(chaveOrfaoNovo), velho.getTime(), 'a marca do órfão que ficou é preservada');
  const seg = fs.readFileSync(path.join(tmp, 'seguranca_logs.json'), 'utf-8');
  assert.match(seg, /video_treino_orfao_removido/);
});

test('TRN-COM-1: comentário ao lado do vídeo exige CPF confirmado, valida e chega ao Acompanhamento', async () => {
  const tid = await criarTreino('NR-Coment-6');
  const f1 = await criarFunc('COMENT FULANO');
  const conv = (await (await post('/api/treinamentos/convites/lote', { treinamentoId: tid, funcionarioIds: [f1] })).json()).criados[0];
  const url = '/api/treinamentos/publico/' + conv.token;
  // Antes do gate de CPF: recusa (só o token não basta para escrever em nome da pessoa).
  assert.equal((await post(url + '/comentarios', { avaliacao: 'ok', texto: 'x' })).status, 403);
  const entrou = await (await post(url + '/entrar', { cpf: '52998224725' })).json();
  assert.deepEqual(entrou.comentarios, [], 'começa sem comentários');
  assert.equal((await post(url + '/comentarios', { avaliacao: 'talvez' })).status, 400, 'avaliação fora da lista');
  assert.equal((await post(url + '/comentarios', { avaliacao: 'problema', texto: '  ' })).status, 400, 'problema exige texto');
  assert.equal((await post(url + '/comentarios', { avaliacao: 'ok', texto: 'x'.repeat(1001) })).status, 400, 'passa do limite');
  let r = await post(url + '/comentarios', { avaliacao: 'ok' });
  assert.equal(r.status, 201, 'OK sem texto é aceito');
  r = await post(url + '/comentarios', { avaliacao: 'problema', texto: 'O áudio sumiu no celular' });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).comentarios.length, 2);
  // Reabrir o link devolve o que a pessoa já mandou.
  assert.equal((await (await post(url + '/entrar', { cpf: '52998224725' })).json()).comentarios.length, 2);
  // O RH lê no Acompanhamento.
  const item = (await getj('/api/treinamentos/acompanhamento')).itens.find(i => i.id === conv.id);
  assert.deepEqual(item.comentarios.map(c => c.avaliacao), ['ok', 'problema']);
  assert.equal(item.comentarios[1].texto, 'O áudio sumiu no celular');
  // Link inexistente: 404.
  assert.equal((await post('/api/treinamentos/publico/nao-existe/comentarios', { avaliacao: 'ok' })).status, 404);
});

// ===================== ADZ — Download de admissões (atalho + lote) =====================
test('ADM-MARCA-1: formulário público informa a empresa correta e mantém fallback NTE', async () => {
  const sul = await (await post('/api/admissao', { nome: 'CANDIDATO SUL', empresa: 'SUL', dias: 7 })).json();
  assert.equal(sul.admissao.empresa, 'SUL');
  const publicoSul = await getj('/api/admissao/publico/' + sul.admissao.token);
  assert.equal(publicoSul.empresa, 'SUL');

  const legado = await (await post('/api/admissao', { nome: 'CANDIDATO NTE', dias: 7 })).json();
  const publicoNte = await getj('/api/admissao/publico/' + legado.admissao.token);
  assert.equal(publicoNte.empresa, 'NTE');
});

async function criarAdmissaoPreenchida(nome) {
  // cria convite → sobe 1 doc pelo link público → submete
  const c = await (await post('/api/admissao', { nome, dias: 7 })).json();
  const adm = c.admissao; const token = adm.token;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'rg.png');
  fd.append('chave', 'rg-doc');
  const up = await (await fetch(`${BASE}/api/admissao/publico/${token}/midia`, { method: 'POST', headers: { ...ORIG }, body: fd })).json();
  await fetch(`${BASE}/api/admissao/publico/${token}`, { method: 'POST', headers: JSONH, body: JSON.stringify({ resposta: { nome }, docIds: [up.id] }) });
  return adm.id;
}

test('ADZ-1: zip-lote por ids devolve um único application/zip', async () => {
  const a1 = await criarAdmissaoPreenchida('ZIP CANDIDATO UM');
  const a2 = await criarAdmissaoPreenchida('ZIP CANDIDATO DOIS');
  const r = await fetch(`${BASE}/api/admissao/documentos/zip-lote?ids=${a1},${a2}`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /application\/zip/);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.ok(buf.length > 100 && buf.slice(0, 2).toString() === 'PK', 'é um zip válido');
});

test('ADZ-2: zip-lote por status empacota os preenchidos', async () => {
  const r = await fetch(`${BASE}/api/admissao/documentos/zip-lote?status=preenchido`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type') || '', /application\/zip/);
});

test('ADZ-3: zip-lote sem candidatos preenchidos no filtro → 400', async () => {
  const r = await fetch(`${BASE}/api/admissao/documentos/zip-lote?ids=nao-existe-1,nao-existe-2`);
  assert.equal(r.status, 400);
});

test('ADZ-4: /:id não captura a rota de lote (documentos != :id)', async () => {
  // GET /api/admissao/documentos → seria "documentos" como :id; a rota de lote é /documentos/zip-lote.
  // Garantimos que zip-lote responde zip (não o JSON de "convite não encontrado" de /:id).
  const r = await fetch(`${BASE}/api/admissao/documentos/zip-lote?status=preenchido`);
  assert.notEqual(r.status, 404);
});

test('ADZ-5: baixar documentos SELECIONADOS (?docs=) sai só com os escolhidos, sem a ficha', async () => {
  // cria admissão preenchida com 1 doc e captura o id da mídia
  const c = await (await post('/api/admissao', { nome: 'ZIP SELECIONADO', dias: 7 })).json();
  const token = c.admissao.token;
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
  const fd = new FormData(); fd.append('arquivo', new Blob([png], { type: 'image/png' }), 'cpf.png'); fd.append('chave', 'cpf-doc');
  const up = await (await fetch(`${BASE}/api/admissao/publico/${token}/midia`, { method: 'POST', headers: { ...ORIG }, body: fd })).json();
  await fetch(`${BASE}/api/admissao/publico/${token}`, { method: 'POST', headers: JSONH, body: JSON.stringify({ resposta: { nome: 'ZIP SELECIONADO' }, docIds: [up.id] }) });
  const r = await fetch(`${BASE}/api/admissao/${c.admissao.id}/documentos/zip?docs=${up.id}`);
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  assert.equal(buf.slice(0, 2).toString(), 'PK', 'zip válido');
  // o zip NÃO deve conter a ficha (FICHA_ADMISSAO) — busca o marcador de nome no bytes do zip
  assert.ok(!buf.includes(Buffer.from('FICHA_ADMISSAO')), 'baixar selecionados não inclui a ficha');
  assert.ok(buf.includes(Buffer.from('documentos/')), 'inclui a pasta de documentos');
});

// ===================== ADT — Trilha de autoria do convite de admissão =====================
// O harness sobe SEM login (APP_PASSWORD/SENHA_ADMIN/MONGODB_URI vazios), então `quemFez(req)`
// devolve '' e o nome do autor não é testável aqui. O que estas specs travam é a FORMA: que a
// trilha exista, esteja ordenada, seja APPEND-ONLY, sobreviva à re-normalização, derive dos
// convites antigos sem migração e não vaze token nem para a lista nem para a página pública.

test('ADT-1: convite novo nasce com o evento "criado" na trilha', async () => {
  const c = await (await post('/api/admissao', { nome: 'ADT CRIADO', dias: 7 })).json();
  const d = await getj('/api/admissao/' + c.admissao.id);
  assert.deepEqual(d.trilha.map((e) => e.acao), ['criado']);
  assert.equal(typeof d.trilha[0].quem, 'string', 'autor é string mesmo sem sessão');
  assert.match(d.trilha[0].detalhe, /validade 7 dia/);
  assert.equal(d.eventos, undefined, 'o array cru não sai na API — a tela lê só a trilha derivada');
});

test('ADT-2: gerar link novo ACRESCENTA à trilha e preserva quem criou', async () => {
  const c = await (await post('/api/admissao', { nome: 'ADT REGERADO', dias: 7 })).json();
  const id = c.admissao.id;
  await post(`/api/admissao/${id}/regenerar`, { dias: 10 });
  await post(`/api/admissao/${id}/regenerar`, { dias: 3 });
  const d = await getj('/api/admissao/' + id);
  assert.deepEqual(d.trilha.map((e) => e.acao), ['criado', 'regerado', 'regerado']);
  assert.equal(d.criadoPor, c.admissao.criadoPor, 'regerar não reescreve quem criou');
  assert.ok(d.trilha.every((e, i, v) => i === 0 || e.ts >= v[i - 1].ts), 'trilha ordenada por data');
  assert.match(d.trilha[1].detalhe, /10 dia/);
  assert.match(d.trilha[2].detalhe, /3 dia/);
});

test('ADT-3: gerar link novo zera a resposta, mas a trilha lembra que houve preenchimento', async () => {
  const id = await criarAdmissaoPreenchida('ADT DESCARTE');
  await post(`/api/admissao/${id}/regenerar`, { dias: 7 });
  const d = await getj('/api/admissao/' + id);
  assert.equal(d.preenchidoTs, 0, 'estado do convite volta a zero');
  assert.equal(d.ip, '');
  assert.equal(d.resposta, null);
  const acoes = d.trilha.map((e) => e.acao);
  assert.ok(acoes.includes('preenchido'), 'a história do preenchimento sobrevive ao regerar');
  const reg = d.trilha.find((e) => e.acao === 'regerado');
  assert.match(reg.detalhe, /descartou resposta preenchida/);
  assert.match(reg.detalhe, /1 anexo/);
});

test('ADT-4: convite antigo (sem eventos) rende trilha DERIVADA, sem migração', async () => {
  const arq = path.join(tmp, 'admissoes.json');
  const atual = JSON.parse(fs.readFileSync(arq, 'utf-8'));
  atual.admissoes.push({
    id: 'ADM-LEGADO-1', token: 'a'.repeat(32), ts: 1700000000000,
    nome: 'ADT LEGADO', status: 'aplicado', criadoPor: 'RH ANTIGO',
    preenchidoTs: 1700000100000, ip: '203.0.113.9',
    aplicadoTs: 1700000200000, aplicadoPor: 'MARIA RH', docs: [],
  });
  fs.writeFileSync(arq, JSON.stringify(atual));
  const d = await getj('/api/admissao/ADM-LEGADO-1');
  assert.deepEqual(d.trilha.map((e) => e.acao), ['criado', 'preenchido', 'aplicado']);
  assert.equal(d.trilha[0].quem, 'RH ANTIGO');
  assert.equal(d.trilha[2].quem, 'MARIA RH');
  assert.match(d.trilha[1].detalhe, /IP 203\.0\.113\.9/);
});

test('ADT-5: a trilha sobrevive à re-normalização de salvarAdmissoes', async () => {
  const c = await (await post('/api/admissao', { nome: 'ADT SOBREVIVE', dias: 7 })).json();
  const id = c.admissao.id;
  await post(`/api/admissao/${id}/regenerar`, { dias: 5 });
  // qualquer mutação do módulo reescreve a lista INTEIRA, re-normalizando todos os convites:
  // é aqui que um campo não declarado em `normalizarAdmissao` sumiria em silêncio.
  await post('/api/admissao', { nome: 'ADT OUTRO CONVITE', dias: 7 });
  const d = await getj('/api/admissao/' + id);
  assert.deepEqual(d.trilha.map((e) => e.acao), ['criado', 'regerado']);
});

test('ADT-6: a lista devolve o RESUMO da autoria, nunca a trilha inteira', async () => {
  const c = await (await post('/api/admissao', { nome: 'ADT RESUMO', dias: 7 })).json();
  await post(`/api/admissao/${c.admissao.id}/regenerar`, { dias: 7 });
  const item = (await getj('/api/admissao')).admissoes.find((x) => x.id === c.admissao.id);
  assert.equal(typeof item.criadoPor, 'string');
  assert.equal(typeof item.aplicadoPor, 'string');
  assert.equal(item.regeracoes, 1);
  assert.equal(item.trilha, undefined, 'a lista é relida em polling — trilha só sob demanda');
  assert.equal(item.eventos, undefined);
});

test('ADT-7: excluir apaga o convite mas deixa o rastro na auditoria', async () => {
  const c = await (await post('/api/admissao', { nome: 'ADT AUDIT DELETE', dias: 7 })).json();
  const id = c.admissao.id;
  assert.equal((await del('/api/admissao/' + id)).status, 200);
  assert.equal((await fetch(`${BASE}/api/admissao/${id}`)).status, 404, 'exclusão é física');
  const { logs } = await getj('/api/seguranca/logs?evento=admissao_convite_excluido');
  const log = logs.find((l) => String(l.detalhes || '').includes('ADT AUDIT DELETE'));
  assert.ok(log, 'o seglog é o único artefato que sobrevive à exclusão do convite');
  assert.equal(log.area, 'admissao');
  assert.equal(log.acao, 'excluir');
  assert.equal(log.severidade, 'alerta');
});

test('ADT-8: nenhum log de admissão carrega o token do link', async () => {
  const c = await (await post('/api/admissao', { nome: 'ADT TOKEN LOG', dias: 7 })).json();
  const token = c.admissao.token;
  await post(`/api/admissao/${c.admissao.id}/regenerar`, { dias: 7 });
  const { logs } = await getj('/api/seguranca/logs?area=admissao');
  // O token É a credencial do link: o seglog é lido por qualquer admin e sai no backup.
  for (const l of logs) assert.ok(!JSON.stringify(l).includes(token), `token vazou em ${l.evento}`);
});

test('ADT-9: a página pública do candidato não enxerga a trilha nem quem gerou', async () => {
  const c = await (await post('/api/admissao', { nome: 'ADT PUBLICO', dias: 7 })).json();
  const p = await getj('/api/admissao/publico/' + c.admissao.token);
  assert.equal(p.trilha, undefined);
  assert.equal(p.eventos, undefined);
  assert.equal(p.criadoPor, undefined);
});

// ===================== LOC — Locações =====================

test('LOC-1: salvar locação preserva configuração e vínculo contratual no JSON local', async () => {
  const config = {
    ipca: { 2025: 4.5 },
    contratos: [{ numero: '01', descricao: '12 meses — Veículos' }],
  };
  let r = await put('/api/locacoes/config', config);
  assert.equal(r.status, 200);

  r = await post('/api/locacoes', {
    placa: 'LOC1A23',
    modelo: 'SAVEIRO',
    dataChegada: '23/07/2026',
    valorInicial: 3600,
    contrato: '01',
    polo: 'ARACAJU',
  });
  assert.equal(r.status, 201);

  // A lista de documentos é sempre devolvida (vazia quando não há anexo) — quem a gerencia são
  // as rotas .../contratos/:numero/documentos, não este endpoint. Locatário e data de
  // assinatura são normalizados para '' quando não informados.
  const cfgSalva = await getj('/api/locacoes/config');
  assert.deepEqual(cfgSalva.ipca, config.ipca);
  assert.deepEqual(cfgSalva.contratos, config.contratos.map((c) => ({ ...c, documentos: [], locatario: '', assinadoEm: '' })));
  // Os modelos de empresa da fatura nascem prontos, sem ninguém cadastrar nada.
  assert.ok(cfgSalva.fatura.partes.length >= 2, 'configuração já traz modelos de locadora e locatária');
  assert.equal(cfgSalva.fatura.diaEmissao, 10);
  assert.equal(cfgSalva.fatura.diaVencimento, 15);
  const locacao = (await getj('/api/locacoes')).find((item) => item.placa === 'LOC1A23');
  assert.ok(locacao, 'locação criada deve continuar disponível');
  assert.equal(locacao.contrato, '01');
  assert.equal(locacao.polo, 'ARACAJU');
});

test('LOC-1b: contrato de locação recebe documentos em lote, mantém no salvar config e exclui', async () => {
  const fd = new FormData();
  fd.append('arquivos', new Blob([Buffer.from('%PDF-1.4\n% contrato de locação\n')], { type: 'application/pdf' }), 'contrato-locacao.pdf');
  fd.append('arquivos', new Blob([Buffer.from('%PDF-1.4\n% aditivo\n')], { type: 'application/pdf' }), 'aditivo-01.pdf');
  const r = await fetch(`${BASE}/api/locacoes/contratos/${encodeURIComponent('01')}/documentos`, { method: 'POST', headers: { ...ORIG }, body: fd });
  assert.equal(r.status, 201);
  const up = await r.json();
  assert.equal(up.enviados.length, 2, 'os dois arquivos do lote devem subir');
  const [contratoPdf, aditivoPdf] = up.enviados;
  assert.ok(contratoPdf.id && contratoPdf.tamanho > 0 && contratoPdf.ts > 0, 'metadados do arquivo vêm preenchidos');

  let cfg = await getj('/api/locacoes/config');
  let contrato = cfg.contratos.find((item) => item.numero === '01');
  assert.deepEqual(contrato.documentos.map((d) => d.nome), ['contrato-locacao.pdf', 'aditivo-01.pdf']);
  assert.equal((await fetch(`${BASE}/api/midia/${contratoPdf.id}`)).status, 200);

  // Salvar IPCA/descrição pela tela de configuração não pode apagar os anexos.
  assert.equal((await put('/api/locacoes/config', { ipca: { 2025: 4.5 }, contratos: [{ numero: '01', descricao: '12 meses — revisado' }] })).status, 200);
  cfg = await getj('/api/locacoes/config');
  contrato = cfg.contratos.find((item) => item.numero === '01');
  assert.equal(contrato.descricao, '12 meses — revisado');
  assert.equal(contrato.documentos.length, 2, 'salvar a configuração preserva os documentos');

  // Excluir tira da lista e apaga o arquivo do cofre.
  const del = await fetch(`${BASE}/api/locacoes/contratos/01/documentos/${encodeURIComponent(aditivoPdf.id)}`, { method: 'DELETE', headers: { ...ORIG } });
  assert.equal(del.status, 200);
  cfg = await getj('/api/locacoes/config');
  assert.deepEqual(cfg.contratos.find((item) => item.numero === '01').documentos.map((d) => d.nome), ['contrato-locacao.pdf']);
  assert.equal((await fetch(`${BASE}/api/midia/${aditivoPdf.id}`)).status, 404);

  // Contrato que não existe não vira pasta fantasma.
  const fdOrfao = new FormData();
  fdOrfao.append('arquivos', new Blob([Buffer.from('%PDF-1.4\n')], { type: 'application/pdf' }), 'orfao.pdf');
  const semContrato = await fetch(`${BASE}/api/locacoes/contratos/99/documentos`, { method: 'POST', headers: { ...ORIG }, body: fdOrfao });
  assert.equal(semContrato.status, 404);
});

test('LOC-2: fatura calcula pró-rata e entrega PDF binário', async () => {
  const fatura = await getj('/api/locacoes/fatura?mes=07&ano=2026');
  assert.equal(fatura.schemaVersao, 3);
  const item = fatura.itens.find((linha) => linha.placa === 'LOC1A23');
  assert.ok(item, 'veículo da locação entra na cobrança');
  assert.equal(item.periodo, '23/07-14/08/26');
  assert.equal(item.dias, 23);
  assert.equal(item.valorMensal, 3600);
  assert.equal(item.valor, 2760);
  assert.equal(fatura.subtotal, 2760);
  assert.equal(fatura.totalLiquido, 2760);
  assert.equal(fatura.emitente.cnpj, '98.447.360/0001-30');
  assert.equal(fatura.destinatario.cnpj, '85.292.800/0001-86');
  // A fatura de julho é enviada em 10/08 e vence em 15/08 — mês de referência ≠ mês do envio.
  assert.equal(fatura.selo, 'JULHO 2026');
  assert.equal(fatura.periodoInicio, '15/07/2026');
  assert.equal(fatura.periodoFim, '14/08/2026');
  assert.equal(fatura.emissao, '10/08/2026');
  assert.equal(fatura.vencimento, '15/08/2026');

  const resposta = await fetch(`${BASE}/api/locacoes/fatura/pdf?mes=07&ano=2026`);
  assert.equal(resposta.status, 200);
  assert.match(resposta.headers.get('content-type') || '', /^application\/pdf/);
  assert.match(resposta.headers.get('content-disposition') || '', /cobranca-locacoes-2026-07\.pdf/);
  const pdf = Buffer.from(await resposta.arrayBuffer());
  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
});

test('LOC-2b: veículo chegado antes do ciclo é cobrado o mês cheio, e as empresas são escolhidas na emissão', async () => {
  // Chegou em 09/07 (ciclo de junho: 15/06 a 14/07). O trecho quebrado foi cobrado na fatura de
  // junho; em julho ele paga a mensalidade inteira. Cobrar o trecho antigo aqui subfaturaria.
  assert.equal((await post('/api/locacoes', {
    placa: 'ANT9J09', modelo: 'GOL', dataChegada: '09/07/2026', valorInicial: 2500,
  })).status, 201);

  const julho = await getj('/api/locacoes/fatura?mes=07&ano=2026');
  const emJulho = julho.itens.find((linha) => linha.placa === 'ANT9J09');
  assert.equal(emJulho.dias, 30);
  assert.equal(emJulho.periodo, '15/07-14/08/26');
  assert.equal(emJulho.valor, 2500);

  const junho = await getj('/api/locacoes/fatura?mes=06&ano=2026');
  const emJunho = junho.itens.find((linha) => linha.placa === 'ANT9J09');
  assert.equal(emJunho.dias, 6, 'em junho entra só o trecho de 09/07 a 14/07');
  assert.equal(emJunho.periodo, '09/07-14/07/26');

  // Modelo de empresa escolhido por id (GET) e campos ajustados só nesta emissão (POST).
  const cfg = await getj('/api/locacoes/config');
  const locataria = cfg.fatura.partes.find((p) => p.papel === 'locataria');
  const porId = await getj(`/api/locacoes/fatura?mes=07&ano=2026&destinatario=${encodeURIComponent(locataria.id)}`);
  assert.equal(porId.destinatario.razaoSocial, locataria.razaoSocial);

  const avulsa = await fetch(`${BASE}/api/locacoes/fatura`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...ORIG },
    body: JSON.stringify({
      mes: '07', ano: '2026',
      destinatario: locataria.id,
      destinatarioDados: { razaoSocial: 'OUTRA EMPRESA LTDA', cnpj: '00.000.000/0001-00' },
    }),
  });
  assert.equal(avulsa.status, 200);
  const faturaAvulsa = await avulsa.json();
  assert.equal(faturaAvulsa.destinatario.razaoSocial, 'OUTRA EMPRESA LTDA');
  assert.equal(faturaAvulsa.destinatario.cnpj, '00.000.000/0001-00');
  // Emissão avulsa não altera o modelo salvo.
  const cfgDepois = await getj('/api/locacoes/config');
  assert.equal(cfgDepois.fatura.partes.find((p) => p.id === locataria.id).razaoSocial, locataria.razaoSocial);

  // Excluir a locação de apoio para não interferir nos totais dos testes seguintes.
  const criada = (await getj('/api/locacoes')).find((item) => item.placa === 'ANT9J09');
  assert.equal((await fetch(`${BASE}/api/locacoes/${criada.id}`, { method: 'DELETE', headers: { ...ORIG } })).status, 200);
});

test('LOC-3: fatura aceita valor monetário persistido no formato brasileiro', async () => {
  const respostaCriacao = await post('/api/locacoes', {
    placa: 'BRZ1L00',
    modelo: 'F4000',
    dataChegada: '11/05/2025',
    valorInicial: 'R$ 11.000,00',
  });
  assert.equal(respostaCriacao.status, 201);
  const criada = await respostaCriacao.json();
  assert.equal(criada.valorInicial, 11000);

  const persistida = (await getj('/api/locacoes')).find((item) => item.placa === 'BRZ1L00');
  assert.equal(persistida.valorInicial, 11000);
  const fatura = await getj('/api/locacoes/fatura?mes=07&ano=2026');
  const item = fatura.itens.find((linha) => linha.placa === 'BRZ1L00');
  assert.equal(item.valorMensal, 11495);
  assert.equal(item.valor, 11495);
  assert.equal(fatura.totalLiquido, 14255);
});

test('LOC-4: equipamento/ferramental entra em Locações sem placa e sai na fatura pela identificação', async () => {
  // Tipo desconhecido é recusado — coagir para veículo em silêncio exigiria placa de quem não tem.
  assert.equal((await post('/api/locacoes', { tipo: 'drone', modelo: 'X', dataChegada: '01/07/2026', valorInicial: 100 })).status, 400);
  // Veículo (tipo ausente = veículo, como todo registro anterior à 1.55.31) continua exigindo placa.
  const semPlaca = await post('/api/locacoes', { modelo: 'GOL', dataChegada: '01/07/2026', valorInicial: 100 });
  assert.equal(semPlaca.status, 400);
  assert.match((await semPlaca.json()).erro, /placa/i);
  // Item sem placa exige a descrição.
  const semDescricao = await post('/api/locacoes', { tipo: 'ferramental', identificacao: 'PAT-0451', dataChegada: '01/07/2026', valorInicial: 100 });
  assert.equal(semDescricao.status, 400);
  assert.match((await semDescricao.json()).erro, /descrição/i);

  const r = await post('/api/locacoes', {
    tipo: 'ferramental', identificacao: ' PAT-0451 ', modelo: 'Ferramental de troca de peças (reisolamento)',
    placa: 'NAO1D23', anoFabricacao: '2020', dataChegada: '01/07/2026', valorInicial: 'R$ 1.800,00', contrato: '01', polo: 'ARACAJU',
  });
  assert.equal(r.status, 201);
  const criada = await r.json();
  assert.equal(criada.tipo, 'ferramental');
  assert.equal(criada.placa, '', 'placa enviada por engano num item sem placa é descartada');
  assert.equal(criada.anoFabricacao, '', 'ano só faz sentido em veículo');
  assert.equal(criada.identificacao, 'PAT-0451');
  assert.equal(criada.valorInicial, 1800);

  // Registro antigo (gravado sem `tipo`) é lido como veículo.
  const lista = await getj('/api/locacoes');
  assert.equal(lista.find((l) => l.placa === 'LOC1A23').tipo, 'veiculo');

  // Na fatura o item entra pela identificação; com equipamento no meio a fatura deixa de ser "só veículos".
  const fatura = await getj('/api/locacoes/fatura?mes=07&ano=2026');
  const item = fatura.itens.find((l) => l.identificador === 'PAT-0451');
  assert.ok(item, 'ferramental entra na cobrança');
  assert.equal(item.tipoRotulo, 'Ferramental');
  assert.equal(item.dias, 30, 'chegou antes do ciclo → mês cheio');
  assert.equal(item.valor, 1800);
  assert.equal(fatura.apenasVeiculos, false);
  assert.match(fatura.observacoes[0], /veículos e equipamentos/);
  const pdf = await fetch(`${BASE}/api/locacoes/fatura/pdf?mes=07&ano=2026`);
  assert.equal(pdf.status, 200);
  assert.equal(Buffer.from(await pdf.arrayBuffer()).subarray(0, 4).toString(), '%PDF');
  // Competência em que o ferramental ainda não existia (maio: 15/05 a 14/06; ele chegou em 01/07)
  // volta a ser só de veículos, com o texto de sempre.
  assert.equal((await getj('/api/locacoes/fatura?mes=05&ano=2026')).apenasVeiculos, true);

  // Trocar para veículo sem placa é recusado; trocar para equipamento mantém sem placa e aceita nova identificação.
  assert.equal((await put(`/api/locacoes/${criada.id}`, { tipo: 'veiculo' })).status, 400);
  const virouEquip = await put(`/api/locacoes/${criada.id}`, { tipo: 'equipamento', identificacao: 'SN-99' });
  assert.equal(virouEquip.status, 200);
  const equip = await virouEquip.json();
  assert.equal(equip.tipo, 'equipamento');
  assert.equal(equip.identificacao, 'SN-99');
  assert.equal(equip.placa, '');
  assert.equal((await del(`/api/locacoes/${criada.id}`)).status, 200);
});

test('LOC-5: cada PDF emitido entra no histórico com o arquivo guardado, e o check de enviada grava quem e quando', async () => {
  const antes = (await getj('/api/locacoes/faturas')).length;
  const pdf = await fetch(`${BASE}/api/locacoes/fatura/pdf?mes=08&ano=2026`);
  assert.equal(pdf.status, 200);
  const idRegistro = pdf.headers.get('x-fatura-id');
  assert.ok(idRegistro, 'a resposta do PDF traz o id do registro criado');
  const original = Buffer.from(await pdf.arrayBuffer());

  const lista = await getj('/api/locacoes/faturas');
  assert.equal(lista.length, antes + 1);
  const reg = lista[0]; // mais recente primeiro
  assert.equal(reg.id, idRegistro);
  assert.equal(reg.competencia, '2026-08');
  assert.equal(reg.referencia, 'Agosto/2026');
  assert.equal(reg.enviada, false);
  assert.ok(reg.arquivo && reg.arquivo.id, 'PDF guardado no cofre');
  assert.equal(reg.arquivo.nome, 'cobranca-locacoes-2026-08.pdf');
  assert.equal(reg.qtdItens, reg.itens.length);
  assert.ok(reg.totalLiquido > 0);
  assert.equal(reg.emitente.cnpj, '98.447.360/0001-30');

  // O PDF guardado é byte a byte o que foi entregue — e sobrevive à faxina de órfãs. A faxina
  // poupa arquivo com menos de 1 h, então o teste ENVELHECE o arquivo antes (2 h atrás): sem isso
  // o assert passaria mesmo com o PDF fora de midiasReferenciadas() — e ele sumiria em produção
  // ~1h depois de gerado, como aconteceu com os documentos de locação (1.45.1) e da admissão (1.55.3).
  const arquivoMidia = path.join(tmp, 'uploads', `${reg.arquivo.id}.json`);
  const midiaSalva = JSON.parse(fs.readFileSync(arquivoMidia, 'utf8'));
  midiaSalva.ts = Date.now() - (2 * 60 * 60 * 1000);
  fs.writeFileSync(arquivoMidia, JSON.stringify(midiaSalva));
  assert.equal((await post('/api/midia/limpar-orfas', {})).status, 200);
  assert.ok(fs.existsSync(arquivoMidia), 'a faxina de órfãs NÃO pode apagar o PDF de uma fatura do histórico');
  const guardado = await fetch(`${BASE}/api/locacoes/faturas/${reg.id}/pdf`);
  assert.equal(guardado.status, 200);
  assert.match(guardado.headers.get('content-type') || '', /^application\/pdf/);
  assert.ok(Buffer.from(await guardado.arrayBuffer()).equals(original));

  // Marcar como enviada grava data (e usuário, quando há sessão); desmarcar limpa.
  const marcada = await put(`/api/locacoes/faturas/${reg.id}`, { enviada: true, obs: 'enviada por e-mail' });
  assert.equal(marcada.status, 200);
  const m = await marcada.json();
  assert.equal(m.enviada, true);
  assert.ok(m.enviadaEm > 0);
  assert.equal(m.obs, 'enviada por e-mail');
  assert.equal((await getj('/api/locacoes/faturas')).find((f) => f.id === reg.id).enviada, true);
  const desmarcada = await (await put(`/api/locacoes/faturas/${reg.id}`, { enviada: false })).json();
  assert.equal(desmarcada.enviada, false);
  assert.equal(desmarcada.enviadaEm, 0);
  assert.equal(desmarcada.obs, 'enviada por e-mail', 'desmarcar não apaga a anotação');

  // Excluir tira o registro; o PDF deixa de ser servido por esta rota e o 404 é honesto.
  assert.equal((await del(`/api/locacoes/faturas/${reg.id}`)).status, 200);
  assert.equal((await fetch(`${BASE}/api/locacoes/faturas/${reg.id}/pdf`)).status, 404);
  // Sem o registro o PDF é órfão de verdade: a faxina tem de removê-lo (prova de que a idade
  // forçada acima estava valendo e o assert anterior não passou à toa).
  assert.equal((await post('/api/midia/limpar-orfas', {})).status, 200);
  assert.ok(!fs.existsSync(arquivoMidia), 'PDF de registro excluído vira órfão e a faxina o apaga');
  assert.equal((await del(`/api/locacoes/faturas/${reg.id}`)).status, 404);
  assert.equal((await put(`/api/locacoes/faturas/${reg.id}`, { enviada: true })).status, 404);
});

test('LOC-6: item com "reajuste anual" desmarcado não sofre IPCA na fatura; registro antigo segue reajustando', async () => {
  // Mesma chegada do BRZ1L00 (11/05/2025; IPCA 2025 = 4,5% cai no aniversário de 11/05/2026), mas de valor fixo.
  const r = await post('/api/locacoes', { placa: 'FIX1A00', modelo: 'STRADA', dataChegada: '11/05/2025', valorInicial: 1000, reajusteIpca: false });
  assert.equal(r.status, 201);
  const criada = await r.json();
  assert.equal(criada.reajusteIpca, false);
  assert.equal((await getj('/api/locacoes')).find((l) => l.placa === 'BRZ1L00').reajusteIpca, true, 'registro gravado sem o campo reajusta como sempre');

  let fatura = await getj('/api/locacoes/fatura?mes=07&ano=2026');
  let item = fatura.itens.find((l) => l.placa === 'FIX1A00');
  assert.equal(item.valorMensal, 1000, 'sem reajuste: cobra o valor inicial');
  assert.equal(item.valor, 1000);
  assert.equal(fatura.itens.find((l) => l.placa === 'BRZ1L00').valorMensal, 11495, 'o vizinho com reajuste segue corrigido');

  // Ligar o reajuste volta a aplicar o IPCA já vencido; o campo aceita "false" em texto também.
  assert.equal((await put(`/api/locacoes/${criada.id}`, { reajusteIpca: true })).status, 200);
  fatura = await getj('/api/locacoes/fatura?mes=07&ano=2026');
  assert.equal(fatura.itens.find((l) => l.placa === 'FIX1A00').valorMensal, 1045);
  assert.equal((await (await put(`/api/locacoes/${criada.id}`, { reajusteIpca: 'false' })).json()).reajusteIpca, false);
  assert.equal((await del(`/api/locacoes/${criada.id}`)).status, 200);
});

test('BKP-1: /api/backup/status não reporta pasta de anexo sem grupo válido', async () => {
  // Guarda ESTÁTICA (derivada de PASTAS_ANEXO, não dos dados): antes eram duas listas de strings
  // escritas à mão e uma pasta nova numa delas caía no fallback `|| 'frota'` do filtro, em
  // silêncio — foi assim que o anexo da NF de EPI sumiu do backup seletivo de "Funcionários".
  // Derivar das pastas EMITIDAS não serviria: numa base sem aquele anexo passaria verde.
  const s = await getj('/api/backup/status');
  assert.ok(s.anexos, 'o status precisa expor o bloco de anexos');
  assert.deepEqual(s.anexos.pastasSemGrupo, [], 'toda pasta declarada tem de apontar para um grupo existente');
  assert.equal(s.anexos.ok, true);
  assert.equal(s.cobertura.ok, true, 'nenhum módulo do dump pode ficar sem cobertura');
  // Alertas de nível `erro` vêm primeiro: o card do Início mostra só alertas[0], e sem ordenação
  // um "Nenhum backup foi gerado ainda" (alerta) escondia justamente os que exigem ação.
  const niveis = (s.alertas || []).map((a) => a.nivel);
  const peso = { erro: 0, alerta: 1, info: 2 };
  assert.deepEqual(niveis, [...niveis].sort((a, b) => peso[a] - peso[b]), 'alertas devem vir ordenados por gravidade');
});

// Regressão do bug real (ago/2026, série do "Fiat Toro" do seed): a 04/80 aberta "declarava"
// parcelasPagas=3 (heurística do normalizador) e o completar-series usava isso como marco,
// gravando 3/77 + o saldoQuitacao da parcela-modelo em TODAS as 76 parcelas criadas — mesmo
// com a 03/80 aberta provando que só havia 2 pagas. Regra nova: pagasAteCoerente (parcela
// aberta existente limita a declaração) + quitação nunca herdada.
test('CT-8: completar-series não propaga pagas/quitação inventadas — parcela aberta limita o marco', async () => {
  const SERIE = { banco: 'Banco CT Marco', produto: 'Consórcio', empresa: 'SUL', grupo: 'CT-MARCO', cota: '9', material: 'Carta do marco' };
  const casos = [
    { parcela: '1/10', vencimento: '26/04/2026', valorParcela: 100, dataPagamento: '24/04/2026', valorPago: 100 },
    { parcela: '2/10', vencimento: '26/05/2026', valorParcela: 100, dataPagamento: '24/05/2026', valorPago: 100 },
    { parcela: '3/10', vencimento: '26/06/2026', valorParcela: 100 },
    // aberta com declaração explícita inconsistente + quitação preenchida (a parcela-modelo)
    { parcela: '4/10', vencimento: '26/07/2026', valorParcela: 100, parcelasPagas: 3, parcelasFaltantes: 7, saldoQuitacao: 136481 },
    { parcela: '7/10', vencimento: '26/10/2026', valorParcela: 100 }, // heurística declararia 6
  ];
  for (const corpo of casos) assert.equal((await post('/api/contratos', { ...SERIE, ...corpo })).status, 201);
  const antes = (await getj('/api/contratos')).filter(c => c.grupo === SERIE.grupo);
  assert.equal((await post('/api/contratos/completar-series', {})).status, 201);
  const depois = (await getj('/api/contratos')).filter(c => c.grupo === SERIE.grupo);
  assert.equal(depois.length, 10, 'série completa com 10 parcelas');

  const criadas = depois.filter(c => !antes.some(a => a.id === c.id));
  assert.deepEqual(criadas.map(c => c.parcela).sort(), ['05/10', '06/10', '08/10', '09/10', '10/10']);
  for (const c of criadas) {
    assert.equal(c.valorPago, 0, `${c.parcela} não pode nascer paga`);
    assert.equal(c.dataPagamento, '', `${c.parcela} não pode nascer com data de pagamento`);
    assert.equal(c.parcelasPagas, 2, `${c.parcela}: marco coerente = 2 (03/10 aberta refuta o "3" da 04/10)`);
    assert.equal(c.parcelasFaltantes, 8, `${c.parcela}: faltantes = total − marco`);
    assert.equal(c.saldoQuitacao, '', `${c.parcela} não herda saldo de quitação da parcela-modelo`);
  }
  // Parcelas existentes: intocadas nos campos de pagamento/quitação (a 04 continua 3/7 — corrigir
  // registro histórico é papel do scripts/corrigir-series-contratos.js, não do botão).
  for (const a of antes) {
    const d = depois.find(c => c.id === a.id);
    assert.ok(d, 'nenhuma parcela original some');
    for (const campo of ['valorPago', 'dataPagamento', 'saldoQuitacao', 'parcelasPagas', 'vencimento']) {
      assert.deepEqual(d[campo], a[campo], `${a.parcela}: campo ${campo} não muda no completar-series`);
    }
  }
  assert.equal(depois.filter(c => Number(c.valorPago) > 0).length, 2, 'progresso financeiro segue 2 pagas');
  // Idempotente: rodar de novo não cria nem muda nada nesta série
  await post('/api/contratos/completar-series', {});
  const denovo = (await getj('/api/contratos')).filter(c => c.grupo === SERIE.grupo);
  assert.deepEqual(denovo, depois, 'segunda execução não altera a série');
});

test('CT-9: corrigir-series-contratos saneia 3/77 e só limpa quitação com evidência de lote', async () => {
  const { planejar, aplicar, pagasAteCoerente } = require('../scripts/corrigir-series-contratos.js');
  // Regra FINAL do marco (casos A–J aprovados; mesma função espelhada no server e no app.js):
  // evidência por linha = declarado explícito (0 vale!) OU inferência (paga ⇒ nº, aberta ⇒ nº−1),
  // capada pela menor parcela aberta existente e pelo total.
  const semDecl = (n, pago) => ({ numero: n, pago, parcelasPagas: '' });
  assert.equal(pagasAteCoerente([semDecl(5, false)], 10), 4, 'A: só 05/10 aberta sem declaração ⇒ infere 4');
  assert.equal(pagasAteCoerente([{ numero: 5, pago: false, parcelasPagas: 1 }], 10), 1, 'B: declaração explícita 1 vence a inferência');
  assert.equal(pagasAteCoerente([semDecl(1, true), semDecl(2, true), semDecl(3, false), semDecl(4, false), semDecl(7, false)], 10), 2, 'C: 03 aberta limita a 2');
  assert.equal(pagasAteCoerente([semDecl(3, false), semDecl(7, false), semDecl(10, false)], 12), 2, 'D: buracos no início — 03 aberta limita a 2');
  assert.equal(pagasAteCoerente([semDecl(1, true), semDecl(2, true), semDecl(3, false), { numero: 4, pago: false, parcelasPagas: 99 }], 10), 2, 'E: 99 corrompido refutado pela 03 aberta');
  assert.equal(pagasAteCoerente([semDecl(80, false)], 80), 79, 'F: só a 80/80 aberta ⇒ backfill até 79, nunca 80');
  assert.equal(pagasAteCoerente([semDecl(1, false)], 10), 0, 'G: 01 aberta ⇒ 0');
  assert.equal(pagasAteCoerente(Array.from({ length: 10 }, (_, i) => semDecl(i + 1, true)), 10), 10, 'H: todas pagas ⇒ 10');
  assert.equal(pagasAteCoerente([{ numero: 5, pago: true, parcelasPagas: 99 }], 10), 10, 'I: declarado > total sem aberta ⇒ teto = total');
  assert.equal(pagasAteCoerente([{ numero: 5, pago: false, parcelasPagas: 0 }], 10), 0, 'J: 0 EXPLÍCITO é declaração, não vazio — não inferir 4');
  const serieId = 'CS-ct9-sanear';
  const base = { serieId, banco: 'Banco CT Sanear', produto: 'Consórcio', empresa: 'NTE', material: 'Carta saneada' };
  const contratos = [
    { ...base, id: 'ct9-1', ts: 1000, parcela: '01/08', vencimento: '26/01/2026', valorParcela: 50, valorPago: 50, dataPagamento: '24/01/2026', parcelasPagas: 1, parcelasFaltantes: 7 },
    { ...base, id: 'ct9-2', ts: 2000, parcela: '02/08', vencimento: '26/02/2026', valorParcela: 50, valorPago: 50, dataPagamento: '24/02/2026', parcelasPagas: 2, parcelasFaltantes: 6 },
    // 03 e 04 abertas com o MESMO saldo legítimo (digitado) — iguais, mas SEM lote → intocáveis
    { ...base, id: 'ct9-3', ts: 3000, parcela: '03/08', vencimento: '26/03/2026', valorParcela: 50, valorPago: 0, dataPagamento: '', parcelasPagas: 2, parcelasFaltantes: 6, saldoQuitacao: 5000 },
    { ...base, id: 'ct9-4', ts: 4000, parcela: '04/08', vencimento: '26/04/2026', valorParcela: 50, valorPago: 0, dataPagamento: '', parcelasPagas: 3, parcelasFaltantes: 5, saldoQuitacao: 5000 },
    // 05–07 nascidas em LOTE (mesmo ts, ≥3 parcelas) copiando pagas e saldo da 04 → saneáveis
    { ...base, id: 'ct9-5', ts: 9999, parcela: '05/08', vencimento: '26/05/2026', valorParcela: 50, valorPago: 0, dataPagamento: '', parcelasPagas: 3, parcelasFaltantes: 5, saldoQuitacao: 5000 },
    { ...base, id: 'ct9-6', ts: 9999, parcela: '06/08', vencimento: '26/06/2026', valorParcela: 50, valorPago: 0, dataPagamento: '', parcelasPagas: 3, parcelasFaltantes: 5, saldoQuitacao: 5000 },
    { ...base, id: 'ct9-7', ts: 9999, parcela: '07/08', vencimento: '26/07/2026', valorParcela: 50, valorPago: 0, dataPagamento: '', parcelasPagas: 3, parcelasFaltantes: 5, saldoQuitacao: 5000 },
  ];
  const plano = planejar(contratos);
  // marco coerente = 2 (03 aberta refuta o 3 declarado) → 04..07 excedem
  assert.deepEqual(plano.seguras.map(s => [s.parcela, s.depois.pagas, s.depois.faltantes]).sort(),
    [['04/08', 2, 6], ['05/08', 2, 6], ['06/08', 2, 6], ['07/08', 2, 6]]);
  assert.match(plano.seguras.find(s => s.parcela === '04/08').motivo, /menor parcela aberta = 03\/8/);
  // Quitação: só as 3 do lote têm evidência forte; 03 e 04 (iguais, sem lote) viram SUSPEITAS
  assert.deepEqual(plano.fortes.map(f => f.parcela).sort(), ['05/08', '06/08', '07/08']);
  assert.deepEqual(plano.suspeitas.map(s => s.parcela).sort(), ['03/08', '04/08']);
  aplicar(contratos, plano);
  assert.equal(contratos.find(c => c.id === 'ct9-3').saldoQuitacao, 5000, 'saldo legítimo igual NÃO é apagado');
  assert.equal(contratos.find(c => c.id === 'ct9-4').saldoQuitacao, 5000, 'suspeito fica para revisão manual');
  assert.equal(contratos.find(c => c.id === 'ct9-4').parcelasPagas, 2);
  for (const id of ['ct9-5', 'ct9-6', 'ct9-7']) {
    const c = contratos.find(x => x.id === id);
    assert.equal(c.saldoQuitacao, '', `${id}: quitação copiada em lote é limpa`);
    assert.equal(c.parcelasPagas, 2); assert.equal(c.parcelasFaltantes, 6);
  }
  const paga = contratos.find(c => c.id === 'ct9-1');
  assert.equal(paga.valorPago, 50, 'parcela paga é intocável');
  assert.equal(paga.parcelasPagas, 1, 'pagas/faltantes de parcela paga não mudam');
  // Idempotente: replanejar sobre o corrigido → nenhuma correção segura/forte
  const plano2 = planejar(contratos);
  assert.equal(plano2.seguras.length, 0, 'segunda execução: 0 correções seguras');
  assert.equal(plano2.fortes.length, 0, 'segunda execução: 0 limpezas de quitação');
});

// A heurística que MATERIALIZAVA "aberta N/M ⇒ N−1 pagas" no normalizador foi removida (era a
// fábrica do bug 3/77): o registro guarda só declaração EXPLÍCITA (0 vale) ou vazio, e a
// coerência é derivada por série (pagasAteCoerente) na tela, no export e no Completar série.
test('CT-10: normalizador não fabrica mais pagas; export sai coerente por série; 0 explícito ≠ vazio', async () => {
  const SERIE = { banco: 'Banco CT Derivado', produto: 'Consórcio', empresa: 'SUL', grupo: 'CT-DERIV', cota: '3', material: 'Carta derivada' };
  // Regressão do bug de origem: POST simples de parcela ABERTA sem declaração NÃO pode gravar N−1.
  const r04 = await (await post('/api/contratos', { ...SERIE, parcela: '4/80', vencimento: '10/04/2026', valorParcela: 10 })).json();
  // strictEqual de propósito: 0 == '' é true no equal frouxo, e a diferença '' × 0 é o ponto.
  assert.strictEqual(r04.parcelasPagas, '', 'aberta sem declaração fica vazia (antes virava 3)');
  assert.strictEqual(r04.parcelasFaltantes, '', 'faltantes não é fabricado junto');
  // 0 explícito é declaração válida e sobrevive à normalização.
  const r05 = await (await post('/api/contratos', { ...SERIE, parcela: '5/80', vencimento: '10/05/2026', valorParcela: 10, parcelasPagas: 0 })).json();
  assert.strictEqual(r05.parcelasPagas, 0, '0 explícito continua 0 (não é tratado como vazio)');
  // Declaração explícita importada/enviada é preservada (não sobrescrita pela inferência).
  const r06 = await (await post('/api/contratos', { ...SERIE, parcela: '6/80', vencimento: '10/06/2026', valorParcela: 10, parcelasPagas: 1 })).json();
  assert.strictEqual(r06.parcelasPagas, 1, 'declaração explícita 1 preservada');
  for (const id of [r04.id, r05.id, r06.id]) {
    await fetch(`${BASE}/api/contratos/${encodeURIComponent(id)}`, { method: 'DELETE', headers: ORIG });
  }

  // Export coerente por série: usa a série do CT-8 (01,02 pagas + 03 aberta + 04 declarando 3 +
  // completadas com marco 2) — TODAS as linhas devem exportar PAGAS=2 / FALTANTES=8, mesmo a 04.
  const XLSX_CT = require('xlsx'); // require preguiçoso, como nos demais testes do arquivo
  const rex = await post('/api/contratos/exportar', {});
  assert.equal(rex.status, 200);
  const wbx = XLSX_CT.read(Buffer.from(await rex.arrayBuffer()), { type: 'buffer' });
  const linhas = XLSX_CT.utils.sheet_to_json(wbx.Sheets.CONTRATOS, { defval: '' });
  const daSerie = linhas.filter((l) => l.GRUPO === 'CT-MARCO');
  assert.equal(daSerie.length, 10, 'série do CT-8 completa no export');
  for (const l of daSerie) {
    assert.equal(l.PAGAS, 2, `linha ${l.PARC}: PAGAS coerente da série`);
    // FALTANTES é POSICIONAL (total − nº da parcela), não o restante financeiro: 01/10→9 … 10/10→0
    assert.equal(l.FALTANTES, 10 - Number(l.PARC.split('/')[0]), `linha ${l.PARC}: FALTANTES = total − nº`);
  }
  assert.equal(daSerie.find((l) => l.PARC === '01/10').FALTANTES, 9);
  assert.equal(daSerie.find((l) => l.PARC === '10/10').FALTANTES, 0);
  // Série /20 completa: os exemplos canônicos da regra posicional.
  const S20 = { banco: 'Banco CT Vinte', produto: 'Consórcio', empresa: 'NTE', grupo: 'CT-20', cota: '20', material: 'Carta vinte' };
  for (let n = 1; n <= 20; n++) assert.equal((await post('/api/contratos', { ...S20, parcela: `${n}/20`, vencimento: `10/${String(((n - 1) % 12) + 1).padStart(2, '0')}/${2026 + Math.floor((n - 1) / 12)}`, valorParcela: 5 })).status, 201);
  const rex20 = await post('/api/contratos/exportar', {});
  const l20 = XLSX_CT.utils.sheet_to_json(XLSX_CT.read(Buffer.from(await rex20.arrayBuffer()), { type: 'buffer' }).Sheets.CONTRATOS, { defval: '' }).filter((l) => l.GRUPO === 'CT-20');
  const f20 = (p) => l20.find((l) => l.PARC === p).FALTANTES;
  assert.deepEqual([f20('01/20'), f20('10/20'), f20('11/20'), f20('12/20'), f20('19/20'), f20('20/20')], [19, 10, 9, 8, 1, 0], 'FALTANTES posicional na série /20');
});

// Caso real da série de 54 parcelas (ago/2026): produção tinha 01..15 + 18..53 e um registro
// SEM PARC (parcelasPagas=54/faltantes=0, vencimento vazio) na mesma série. A completude é
// decidida SÓ pelos números válidos do "N/M": o registro sem PARC é pulado (não conta como
// parcela nem "completa" a série via pagas declaradas), e o completar preenche todo buraco
// de 1..total — inclusive no fim da sequência.
test('CT-11: série 54 com buracos no meio e no fim + registro sem PARC — completa 16,17,53,54', async () => {
  const SERIE = { banco: 'Banco CT54', produto: 'Financiamento', empresa: 'NTE', material: 'Serie regressao 54' };
  const pad = (n) => String(n).padStart(2, '0');
  const venc = (n) => { const d = new Date(2024, 8 + (n - 1), 10); return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`; }; // 01/54 = 10/09/2024
  for (let n = 1; n <= 52; n++) {
    if (n === 16 || n === 17) continue; // buracos no meio; 53 e 54 nem existem (buraco no fim)
    const corpo = { ...SERIE, parcela: `${n}/54`, vencimento: venc(n), valorParcela: 1385.40 };
    if (n <= 24) { corpo.dataPagamento = venc(n); corpo.valorPago = 1385.40; }
    assert.equal((await post('/api/contratos', corpo)).status, 201, `criação de ${n}/54`);
  }
  // Registro inválido da produção: sem PARC, "declarando" a série completa. Não pode contar.
  const semParc = await (await post('/api/contratos', { ...SERIE, parcela: '', totalParcelas: 54, parcelasPagas: 54, parcelasFaltantes: 0, valorParcela: 1385.40 })).json();
  assert.strictEqual(semParc.parcela, '');

  const antes = (await getj('/api/contratos')).filter(c => c.banco === SERIE.banco);
  const r1 = await (await post('/api/contratos/completar-series', {})).json();
  const depois = (await getj('/api/contratos')).filter(c => c.banco === SERIE.banco);

  const nums = depois.map(c => (String(c.parcela).match(/^(\d+)\/54$/) || [])[1]).filter(Boolean).map(Number).sort((a, b) => a - b);
  assert.equal(nums.length, 54, 'todas as 54 posições numeradas existem');
  assert.equal(new Set(nums).size, 54, 'nenhum número duplicado');
  for (let n = 1; n <= 54; n++) assert.ok(nums.includes(n), `posição ${n}/54 presente`);

  const criadas = depois.filter(c => !antes.some(a => a.id === c.id));
  assert.deepEqual(criadas.map(c => c.parcela).sort(), ['16/54', '17/54', '53/54', '54/54'], 'cria exatamente os 4 buracos');
  const vencDe = (p) => criadas.find(c => c.parcela === p).vencimento;
  assert.equal(vencDe('16/54'), '10/12/2025'); // sequência mensal real: 15/54=10/11/2025, 18/54=10/02/2026
  assert.equal(vencDe('17/54'), '10/01/2026');
  assert.equal(vencDe('53/54'), '10/01/2029'); // 52/54=10/12/2028
  assert.equal(vencDe('54/54'), '10/02/2029');

  // O sem-PARC fica intacto e não vira "parcela 54"; nenhuma existente é alterada.
  const semParcDepois = depois.find(c => c.id === semParc.id);
  assert.strictEqual(semParcDepois.parcela, '', 'registro sem PARC permanece sem número');
  assert.strictEqual(semParcDepois.parcelasPagas, 54, 'declaração do registro inválido não é tocada');
  for (const a of antes) {
    const d = depois.find(c => c.id === a.id);
    for (const campo of ['parcela', 'vencimento', 'valorPago', 'dataPagamento']) {
      assert.deepEqual(d[campo], a[campo], `${a.parcela || '(sem PARC)'}: ${campo} intacto`);
    }
  }
  assert.ok(r1.criadas >= 4, 'resposta reporta as criações');

  // Excel: FALTANTES posicional (total − nº) em série longa; sem-PARC cai no valor salvo (0), sem virar "54/54".
  const XLSX_54 = require('xlsx');
  const rex = await post('/api/contratos/exportar', {});
  const wbx = XLSX_54.read(Buffer.from(await rex.arrayBuffer()), { type: 'buffer' });
  const linhas54 = XLSX_54.utils.sheet_to_json(wbx.Sheets.CONTRATOS, { defval: '' }).filter((l) => l.BANCO === SERIE.banco);
  const faltDe = (parc) => linhas54.find((l) => l.PARC === parc).FALTANTES;
  assert.equal(faltDe('01/54'), 53); assert.equal(faltDe('24/54'), 30);
  assert.deepEqual([faltDe('51/54'), faltDe('52/54'), faltDe('53/54'), faltDe('54/54')], [3, 2, 1, 0]);
  assert.equal(linhas54.filter((l) => l.PARC === '').length, 1, 'o registro sem PARC segue no export sem número');
  // Sem N/M válido a célula fica VAZIA (não o 0 salvo, não "54/54"): só a 54/54 real tem FALTANTES 0.
  assert.strictEqual(linhas54.find((l) => l.PARC === '').FALTANTES, '', 'sem PARC: FALTANTES vazio');
  assert.equal(linhas54.filter((l) => l.FALTANTES === 0).length, 1, 'um único FALTANTES=0 na série: a 54/54');
  assert.ok(linhas54.every((l) => l.FALTANTES === '' || l.FALTANTES >= 0), 'nunca negativo');
  // Parcela inválida ("abc") e nula: também vazias, e nada é alterado/criado/removido por isso.
  const antesInv = (await getj('/api/contratos')).length;
  const rAbc = await (await post('/api/contratos', { ...SERIE, banco: 'Banco CT54 inv', parcela: 'abc', valorParcela: 1 })).json();
  const rNul = await (await post('/api/contratos', { ...SERIE, banco: 'Banco CT54 inv', parcela: null, valorParcela: 1 })).json();
  const rexI = await post('/api/contratos/exportar', { ids: [rAbc.id, rNul.id] });
  const lInv = XLSX_54.utils.sheet_to_json(XLSX_54.read(Buffer.from(await rexI.arrayBuffer()), { type: 'buffer' }).Sheets.CONTRATOS, { defval: '' });
  assert.equal(lInv.length, 2);
  assert.ok(lInv.every((l) => l.FALTANTES === ''), 'parcela "abc"/null: FALTANTES vazio, sem inventar número');
  assert.equal((await getj('/api/contratos')).length, antesInv + 2, 'export não altera, cria nem remove registros');

  // Idempotente: segunda execução não cria nada nesta série
  await post('/api/contratos/completar-series', {});
  const denovo = (await getj('/api/contratos')).filter(c => c.banco === SERIE.banco);
  assert.equal(denovo.length, depois.length, 'segunda execução: 0 criadas na série');
});

// ===================== CT-12..CT-16 — Âncora única da série (1.55.39) =====================
// Regra ÚNICA, documentada em backend/server.js (bloco ÂNCORA DA SÉRIE) e espelhada no
// frontend/app.js:  vencimento(k) = vencimentoAncora + (k − numeroAncora) meses.
// Os testes cobrem os DOIS caminhos que criam parcela: o botão global
// (/api/contratos/completar-series) e o "Completar série" do modal (/api/contratos/lote-criar,
// com o payload montado do jeito que gerarSerieContr monta).

// Espelho de addMesesBR (app.js) / somarMesesContratoBR (server.js): clamp no último dia do mês
// e SEMPRE a partir da âncora — 31/01 +1 → 28/02, +2 → 31/03 (sem cascata).
const addMesesBRTeste = (dataBR, n) => {
  const m = String(dataBR || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return '';
  let ano = +m[3]; if (ano < 100) ano += 2000;
  const d = new Date(ano, +m[2] - 1 + n, 1);
  d.setDate(Math.min(+m[1], new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
};
// Monta o corpo do lote-criar exatamente como o modal monta (âncora = a parcela do form):
// vencimento = base + (i − numeroAncora); pago só no preenchimento RETROATIVO (abaixo de tudo
// o que já existe). Espelho de gerarSerieContr em frontend/app.js.
const itensDoModal = (dados, inicio, total, existentes = new Set()) => {
  const baseVcto = (dados.vencimento || '').trim() || (dados.inicioParcelas || '').trim();
  const numeroAncora = (dados.vencimento || '').trim() ? inicio : 1;
  const menorExistente = Math.min(inicio, ...existentes);
  const itens = [];
  for (let i = 1; i <= total; i++) {
    if (i === inicio || existentes.has(i)) continue;
    const vencimento = addMesesBRTeste(baseVcto, i - numeroAncora);
    const pago = i < menorExistente && i <= (inicio - 1);
    itens.push({
      ...dados, parcela: `${i}/${total}`, totalParcelas: total, vencimento,
      dataPagamento: pago ? vencimento : '', valorPago: pago ? dados.valorParcela : '',
    });
  }
  return itens;
};
const serieOrdenada = (lista, banco) => lista.filter(c => c.banco === banco)
  .sort((a, b) => Number(String(a.parcela).split('/')[0]) - Number(String(b.parcela).split('/')[0]));

test('CT-12: completar-series ancorado na 01/20 (15/12/2025) gera 20 parcelas até 15/07/2027 e não toca na paga', async () => {
  const SERIE = { banco: 'Banco CT Ancora A', produto: 'Consórcio', empresa: 'SUL', grupo: 'CT-ANC-A', cota: '495', material: 'Caminhonete âncora' };
  const ancora = await (await post('/api/contratos', {
    ...SERIE, parcela: '01/20', vencimento: '15/12/2025', valorParcela: 4137.37,
    dataEmissao: '12/12/2025', dataPagamento: '15/12/2025', valorPago: 4137.37,
  })).json();

  assert.equal((await post('/api/contratos/completar-series', {})).status, 201);
  const serie = serieOrdenada(await getj('/api/contratos'), SERIE.banco);
  assert.equal(serie.length, 20, 'a série fica com exatamente 20 linhas');
  assert.equal(serie[0].vencimento, '15/12/2025', 'a primeira parcela é a âncora');
  assert.equal(serie[19].vencimento, '15/07/2027', 'a última é âncora + 19 meses');
  assert.equal(serie.filter(c => /\/08\/2027$/.test(c.vencimento)).length, 0, 'nenhuma linha em agosto/2027');
  assert.deepEqual(serie.map(c => c.vencimento), Array.from({ length: 20 }, (_, i) => addMesesBRTeste('15/12/2025', i)));

  // A linha âncora não é mutada pela geração — nem no vencimento, nem no pagamento.
  const depoisAncora = serie.find(c => c.id === ancora.id);
  for (const campo of ['parcela', 'vencimento', 'dataEmissao', 'dataPagamento', 'valorPago', 'valorParcela']) {
    assert.deepEqual(depoisAncora[campo], ancora[campo], `âncora: ${campo} intacto`);
  }
  // Parcela PAGA continua sendo a única paga: nenhuma linha nova nasce quitada.
  assert.equal(serie.filter(c => Number(c.valorPago) > 0).length, 1, 'só a âncora está paga');
  assert.ok(serie.filter(c => c.id !== ancora.id).every(c => c.dataPagamento === ''), 'parcela nova nasce em aberto');
});

test('CT-13: âncora no MEIO (10/20) gera só 11..20 e deixa as anteriores intactas', async () => {
  const SERIE = { banco: 'Banco CT Ancora B', produto: 'Financiamento', empresa: 'NTE', grupo: 'CT-ANC-B', cota: '77', material: 'Série ancorada no meio' };
  const antes = [];
  for (let n = 1; n <= 10; n++) {
    const corpo = { ...SERIE, parcela: `${n}/20`, vencimento: addMesesBRTeste('15/12/2025', n - 1), valorParcela: 4137.37 };
    if (n <= 8) { corpo.dataPagamento = corpo.vencimento; corpo.valorPago = 4137.37; }
    antes.push(await (await post('/api/contratos', corpo)).json());
  }
  assert.equal((await post('/api/contratos/completar-series', {})).status, 201);
  const serie = serieOrdenada(await getj('/api/contratos'), SERIE.banco);
  const criadas = serie.filter(c => !antes.some(a => a.id === c.id));
  assert.deepEqual(criadas.map(c => c.parcela), ['11/20', '12/20', '13/20', '14/20', '15/20', '16/20', '17/20', '18/20', '19/20', '20/20']);
  assert.equal(criadas.length, 10);
  // Cada nova parcela sai da âncora existente mais próxima ABAIXO (a 10/20, 15/09/2026).
  assert.deepEqual(criadas.map(c => c.vencimento), Array.from({ length: 10 }, (_, i) => addMesesBRTeste('15/09/2026', i + 1)));
  assert.equal(criadas[9].vencimento, '15/07/2027');
  // Nenhuma das 10 anteriores é tocada (as 8 pagas seguem pagas, com os mesmos valores).
  for (const a of antes) {
    assert.deepEqual(serie.find(c => c.id === a.id), a, `${a.parcela}: linha existente não pode ser alterada pela geração`);
  }
  assert.ok(criadas.every(c => c.dataPagamento === '' && Number(c.valorPago) === 0), 'parcela à frente nasce em aberto');
});

test('CT-14: modal (lote-criar) usa a MESMA âncora do botão global — 01/20 → 20 linhas até 15/07/2027', async () => {
  const SERIE = { banco: 'Banco CT Ancora C', produto: 'Consórcio', empresa: 'KV', grupo: 'CT-ANC-C', cota: '495', material: 'Série pelo modal' };
  const dados = { ...SERIE, parcela: '01/20', vencimento: '15/12/2025', valorParcela: 4137.37, dataEmissao: '12/12/2025', dataPagamento: '15/12/2025', valorPago: 4137.37 };
  const ancora = await (await post('/api/contratos', dados)).json();

  const r = await post('/api/contratos/lote-criar', { itens: itensDoModal(dados, 1, 20, new Set([1])) });
  assert.equal(r.status, 201);
  assert.equal((await r.json()).criados, 19);
  const serie = serieOrdenada(await getj('/api/contratos'), SERIE.banco);
  assert.equal(serie.length, 20);
  assert.deepEqual(serie.map(c => c.vencimento), Array.from({ length: 20 }, (_, i) => addMesesBRTeste('15/12/2025', i)));
  assert.equal(serie[19].vencimento, '15/07/2027');
  assert.equal(serie.filter(c => /\/08\/2027$/.test(c.vencimento)).length, 0, 'nenhuma linha em agosto/2027');
  assert.deepEqual(serie.find(c => c.id === ancora.id), ancora, 'a âncora não é mutada pelo lote-criar');
  assert.equal(serie.filter(c => Number(c.valorPago) > 0).length, 1, 'só a âncora está paga');

  // Fallback: sem Vencimento, "Início das parcelas" é o vencimento da parcela 01 (numeroAncora = 1)
  // — mesmo ancorando numa parcela do meio. Antes, o fallback deslocava a série em (nº−1) meses.
  const SERIE_INI = { ...SERIE, banco: 'Banco CT Ancora D', grupo: 'CT-ANC-D' };
  const dadosIni = { ...SERIE_INI, parcela: '05/06', vencimento: '', inicioParcelas: '10/03/2026', valorParcela: 100, dataPagamento: '', valorPago: '' };
  await post('/api/contratos', dadosIni);
  assert.equal((await post('/api/contratos/lote-criar', { itens: itensDoModal(dadosIni, 5, 6, new Set([5])) })).status, 201);
  const serieIni = serieOrdenada(await getj('/api/contratos'), SERIE_INI.banco);
  assert.deepEqual(serieIni.map(c => [c.parcela, c.vencimento]), [
    ['01/06', '10/03/2026'], ['02/06', '10/04/2026'], ['03/06', '10/05/2026'],
    ['04/06', '10/06/2026'], ['05/06', ''], ['06/06', '10/08/2026'],
  ], '"Início das parcelas" ancora a parcela 01, não a parcela editada');
});

test('CT-15: fim de mês faz clamp a partir da âncora (31/01 → 28/02 → 31/03), sem cascata', async () => {
  const SERIE = { banco: 'Banco CT Ancora E', produto: 'Empréstimo', empresa: 'SUL', grupo: 'CT-ANC-E', cota: '31', material: 'Série de fim de mês' };
  await post('/api/contratos', { ...SERIE, parcela: '01/04', vencimento: '31/01/2026', valorParcela: 50 });
  assert.equal((await post('/api/contratos/completar-series', {})).status, 201);
  const serie = serieOrdenada(await getj('/api/contratos'), SERIE.banco);
  assert.deepEqual(serie.map(c => c.vencimento), ['31/01/2026', '28/02/2026', '31/03/2026', '30/04/2026'],
    'março volta ao dia 31 porque sai da âncora, não do mês anterior');
});

test('CT-17: série já cadastrada com cadência irregular vira AVISO, e as parcelas novas seguem a âncora vizinha', async () => {
  const SERIE = { banco: 'Banco CT Cadencia', produto: 'Consórcio', empresa: 'SUL', grupo: 'CT-CAD', cota: '495', material: 'Série com linha velha no dia 21' };
  // Cenário do repro: a 01 foi corrigida para o dia 15 e sobrou uma 05 antiga no dia 21.
  const p01 = await (await post('/api/contratos', { ...SERIE, parcela: '01/20', vencimento: '15/12/2025', valorParcela: 4137.37, dataPagamento: '15/12/2025', valorPago: 4137.37 })).json();
  const p05 = await (await post('/api/contratos', { ...SERIE, parcela: '05/20', vencimento: '21/05/2026', valorParcela: 4137.37 })).json();

  const r = await (await post('/api/contratos/completar-series', {})).json();
  const meus = r.avisos.filter(a => /cad(ê|e)ncia irregular/.test(a) && a.includes(p01.serieId));
  assert.equal(meus.length, 1, 'a série sai com UM aviso de cadência (não um por parcela)');
  assert.match(meus[0], /01\/20 = 15\/12\/2025/);
  assert.match(meus[0], /deveria vencer em 15\/04\/2026 e está em 21\/05\/2026/);

  const serie = serieOrdenada(await getj('/api/contratos'), SERIE.banco);
  assert.equal(serie.length, 20);
  // Nada existente é alterado: a 01 e a 05 continuam exatamente como estavam.
  assert.deepEqual(serie.find(c => c.id === p01.id), p01);
  assert.deepEqual(serie.find(c => c.id === p05.id), p05);
  // 02..04 saem da 01 (dia 15) e 06..20 saem da 05 (dia 21) — cada uma da âncora mais próxima abaixo.
  assert.deepEqual(serie.slice(1, 4).map(c => c.vencimento), ['15/01/2026', '15/02/2026', '15/03/2026']);
  assert.deepEqual(serie.slice(5, 8).map(c => c.vencimento), ['21/06/2026', '21/07/2026', '21/08/2026']);
  assert.equal(serie[19].vencimento, '21/08/2027');

  // Dia diferente no MESMO mês não vira aviso (ajuste de data bancária é rotina, não defeito).
  const SD = { banco: 'Banco CT Cadencia Dia', produto: 'Consórcio', empresa: 'SUL', grupo: 'CT-CAD-DIA', cota: '9', material: 'Dia deslocado' };
  const d01 = await (await post('/api/contratos', { ...SD, parcela: '01/03', vencimento: '15/12/2025', valorParcela: 10 })).json();
  await post('/api/contratos', { ...SD, parcela: '02/03', vencimento: '16/01/2026', valorParcela: 10 });
  const r2 = await (await post('/api/contratos/completar-series', {})).json();
  assert.equal(r2.avisos.filter(a => a.includes(d01.serieId)).length, 0, 'só o dia mudou: nenhum aviso');
});

test('CT-18: corrigir-vencimentos-series separa desvio de mês, desvio de dia, parcela paga e série sem âncora', async () => {
  const { planejar, aplicar } = require('../scripts/corrigir-vencimentos-series.js');
  const base = { serieId: 'S-MIG', material: 'Série migrada', valorParcela: 100 };
  const contratos = [
    { ...base, id: 'm1', parcela: '01/06', vencimento: '15/12/2025', dataPagamento: '15/12/2025', valorPago: 100 }, // âncora, paga
    { ...base, id: 'm2', parcela: '02/06', vencimento: '15/01/2026' },                                              // certa
    { ...base, id: 'm3', parcela: '03/06', vencimento: '21/03/2026' },                                              // MÊS errado (esperado 15/02/2026)
    { ...base, id: 'm4', parcela: '04/06', vencimento: '17/03/2026' },                                              // só o DIA (esperado 15/03/2026)
    { ...base, id: 'm5', parcela: '05/06', vencimento: '20/09/2026', dataPagamento: '20/09/2026', valorPago: 100 }, // PAGA e divergente
    { ...base, id: 'm6', parcela: '06/06', vencimento: '' },                                                        // sem data
    { serieId: 'S-SEM-01', id: 'x1', parcela: '03/04', vencimento: '10/01/2026', material: 'Sem a 01' },
    { serieId: 'S-AMB', id: 'y1', parcela: '02/04', vencimento: '10/01/2026', material: 'Ambígua' },
    { serieId: 'S-AMB', id: 'y2', parcela: '02/04', vencimento: '10/02/2026', material: 'Ambígua' },
    { serieId: '', id: 'z1', parcela: '01/02', vencimento: '10/01/2026', material: 'Sem serieId' },
  ];
  const plano = planejar(contratos);
  assert.deepEqual(plano.corrigir.map(x => [x.parcela, x.antes, x.depois]), [
    ['03/06', '21/03/2026', '15/02/2026'], ['06/06', '', '15/05/2026'],
  ], 'mês diferente (e vencimento vazio) entram na correção');
  assert.deepEqual(plano.diaDivergente.map(x => [x.parcela, x.antes, x.depois]), [['04/06', '17/03/2026', '15/03/2026']]);
  assert.deepEqual(plano.pagasDivergentes.map(x => x.parcela), ['05/06'], 'parcela paga só é relatada');
  assert.deepEqual(plano.revisao.map(x => x.motivo).sort(), [
    'a mesma parcela aparece com vencimentos diferentes', 'a série não tem a parcela 01',
  ]);
  assert.equal(plano.semSerie, 1);

  // --apply padrão: só o desvio de MÊS. Paga, dia-só, âncora e séries em revisão ficam intactas.
  const copia = JSON.parse(JSON.stringify(contratos));
  assert.equal(aplicar(copia, planejar(copia)), 2);
  const por = (id) => copia.find(c => c.id === id);
  assert.equal(por('m3').vencimento, '15/02/2026');
  assert.equal(por('m6').vencimento, '15/05/2026');
  assert.equal(por('m4').vencimento, '17/03/2026', 'desvio só de dia não entra no --apply padrão');
  assert.equal(por('m5').vencimento, '20/09/2026', 'parcela paga nunca é reescrita');
  assert.equal(por('m1').vencimento, '15/12/2025', 'a âncora nunca é recalculada');
  assert.equal(por('y2').vencimento, '10/02/2026', 'série ambígua fica intocada');
  for (const c of copia) {
    const orig = contratos.find(o => o.id === c.id);
    for (const campo of ['parcela', 'dataPagamento', 'valorPago', 'serieId', 'id']) {
      assert.deepEqual(c[campo], orig[campo], `${c.id}: ${campo} não pode mudar`);
    }
  }
  // --incluir-dia acrescenta a categoria 2.
  const copia2 = JSON.parse(JSON.stringify(contratos));
  assert.equal(aplicar(copia2, planejar(copia2), true), 3);
  assert.equal(copia2.find(c => c.id === 'm4').vencimento, '15/03/2026');
});

// ATENÇÃO: este é o ÚLTIMO teste do arquivo de propósito — /api/contratos/importar SUBSTITUI a
// base inteira, então qualquer teste de contratos depois dele rodaria sobre uma base zerada.
test('CT-16: round-trip Exportar → Importar preserva "Início das parcelas" e "Carência"', async () => {
  const XLSX_RT = require('xlsx');
  const SERIE = { banco: 'Banco CT RoundTrip', produto: 'Consórcio', empresa: 'SUL', grupo: 'CT-RT', cota: '1', material: 'Série round-trip' };
  const criado = await (await post('/api/contratos', {
    ...SERIE, parcela: '01/03', vencimento: '15/12/2025', valorParcela: 1000,
    dataEmissao: '12/12/2025', inicioParcelas: '15/12/2025', carencia: 6,
  })).json();
  assert.equal(criado.inicioParcelas, '15/12/2025');
  assert.equal(criado.carencia, 6);

  const rex = await post('/api/contratos/exportar', {});
  assert.equal(rex.status, 200);
  const buffer = Buffer.from(await rex.arrayBuffer());
  const linhas = XLSX_RT.utils.sheet_to_json(XLSX_RT.read(buffer, { type: 'buffer' }).Sheets.CONTRATOS, { defval: '' });
  const linha = linhas.find(l => l.BANCO === SERIE.banco);
  assert.equal(linha['INÍCIO PARCELAS'], '15/12/2025', 'a coluna nova sai no Excel');
  assert.equal(linha['CARÊNCIA'], 6);

  const fd = new FormData();
  fd.append('arquivo', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'CONTRATOS.xlsx');
  const rimp = await fetch(`${BASE}/api/contratos/importar`, { method: 'POST', headers: ORIG, body: fd });
  assert.equal(rimp.status, 200, await rimp.text());
  const voltou = (await getj('/api/contratos')).find(c => c.banco === SERIE.banco);
  assert.equal(voltou.inicioParcelas, '15/12/2025', 'Início das parcelas sobrevive ao round-trip');
  assert.equal(voltou.carencia, 6, 'Carência sobrevive ao round-trip');
  assert.equal(voltou.vencimento, '15/12/2025');
  assert.equal(voltou.dataEmissao, '12/12/2025');
  assert.equal(voltou.serieId, criado.serieId, 'o id da série continua vindo da coluna ID SÉRIE');

  // Planilha ANTIGA (sem as duas colunas do fim) continua válida: importa sem erro e sem inventar valor.
  const cabAntigo = ['DATA EMISSÃO', 'BANCO', 'PRODUTO', 'GRUPO', 'COTA', 'DESCRIÇÃO', 'EMPRESA', 'LOCAL DO CARRO', 'PARC', 'TOTAL PARC', 'PAGAS', 'FALTANTES', 'VALOR PARCELA', 'SALDO QUITAÇÃO', 'DESC. QUITAÇÃO', 'DESC. R$', 'VCTO', 'DT PAGTO', 'ESCRITÓRIO', 'VALOR PAGO', 'C/C', 'NA JUSTIÇA'];
  const wbAntigo = XLSX_RT.utils.book_new();
  XLSX_RT.utils.book_append_sheet(wbAntigo, XLSX_RT.utils.aoa_to_sheet([
    cabAntigo,
    ['01/07/2026', 'Banco CT Antigo', 'Consórcio', '9780', '440', 'Carta antiga', 'SUL', '', '1/60', 60, 0, 60, 2100, 0, '', 0, '10/08/2026', '', '', 0, '', 'Não'],
  ]), 'CONTRATOS');
  const fd2 = new FormData();
  fd2.append('arquivo', new Blob([XLSX_RT.write(wbAntigo, { type: 'buffer', bookType: 'xlsx' })]), 'ANTIGA.xlsx');
  const rimp2 = await fetch(`${BASE}/api/contratos/importar`, { method: 'POST', headers: ORIG, body: fd2 });
  assert.equal(rimp2.status, 200, await rimp2.text());
  const antigo = (await getj('/api/contratos')).find(c => c.banco === 'Banco CT Antigo');
  assert.equal(antigo.inicioParcelas, '', 'coluna ausente vira vazio, não erro');
  assert.strictEqual(antigo.carencia, '');
});
