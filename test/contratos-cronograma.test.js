/**
 * Contratos › Cronograma — regra de parcela atrasada e exportação Excel.
 *
 * A regra oficial (contratoAtrasadoDados no server, espelhada como contrAtrasado no app.js):
 * atrasada = NÃO paga E vencimento ANTES do início do dia de hoje (vencer HOJE não é atraso;
 * datas em calendário local, nunca ISO/UTC). Não existe pagamento parcial no domínio de
 * Contratos: valorPago > 0 OU dataPagamento preenchida marca a parcela INTEIRA como paga.
 *
 * O botão Excel do Cronograma ({ cronograma: true }) devolve um arquivo de DUAS abas:
 * "Cronograma" (visual da tela: 1 linha por contrato, meses nas colunas, cores) e
 * "Parcelas" (1 linha por parcela + colunas de atraso). Sem a flag, o export é o
 * CONTRATOS.xlsx de sempre (round-trip com a importação) — CR-5 trava isso.
 *
 * Mesmo harness do smoke/modulos: servidor REAL em DATA_DIR temporário, porta própria.
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const ExcelJS = require('exceljs');

const PORT = 3200;
const BASE = `http://localhost:${PORT}`;
const ORIG = { Origin: BASE }; // anti-CSRF do servidor exige Origin nas mutações
const JSONH = { 'Content-Type': 'application/json', ...ORIG };
let srv, tmp;
let srvSaida = null;
let srvLog = '';

const hoje = new Date();
const emDias = (n) => { const d = new Date(hoje); d.setDate(d.getDate() + n); return d; };
const br = (d) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
const chaveMes = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const MESES_CURTOS = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'];
const rotuloMes = (d) => `${MESES_CURTOS[d.getMonth()]}/${String(d.getFullYear()).slice(-2)}`;

async function esperarServidor(ms = 30000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    if (srvSaida !== null) {
      throw new Error(`O servidor de teste (porta ${PORT}) morreu com código ${srvSaida} antes de responder.`
        + (srvLog ? `\n--- stderr do servidor ---\n${srvLog.slice(-2000)}` : ''));
    }
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de teste não respondeu a tempo');
}

before(async () => {
  let portaOcupada = false;
  try {
    await fetch(BASE + '/api/versao', { signal: AbortSignal.timeout(1500) });
    portaOcupada = true;
  } catch (e) { /* conexão recusada = porta livre, que é o que queremos */ }
  if (portaOcupada) {
    throw new Error(`A porta ${PORT} já está ocupada por outro processo. Encerre-o e rode de novo `
      + '(a convenção de portas do repositório está em test/portas.test.js).');
  }
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-crono-test-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: tmp, PORT: String(PORT), APP_PASSWORD: '', SENHA_ADMIN: '', MONGODB_URI: '', COBLI_API_KEY: '', RESEND_API_KEY: '', NOTIF_EMAIL_PARA: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  srv.stderr.on('data', (d) => { srvLog += d; });
  srv.on('exit', (codigo, sinal) => { srvSaida = codigo === null ? `sinal ${sinal}` : codigo; });
  await esperarServidor();
});

after(() => {
  try { srv.kill(); } catch (e) { /* já morreu */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

const post = (ep, body) => fetch(`${BASE}${ep}`, { method: 'POST', headers: JSONH, body: JSON.stringify(body) });

// Baixa o Excel do endpoint. `aba` escolhe qual planilha ler como objetos { RÓTULO: valor }.
async function exportarLinhas(body, aba) {
  const r = await post('/api/contratos/exportar', body);
  assert.equal(r.status, 200, 'a exportação deve responder 200');
  const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
  assert.ok(wb.Sheets[aba], `o arquivo deve ter a aba ${aba} (tem: ${wb.SheetNames.join(', ')})`);
  return { wb, linhas: XLSX.utils.sheet_to_json(wb.Sheets[aba], { defval: '' }) };
}
// Versão exceljs (preserva estilo/richText) para as asserções visuais da aba Cronograma.
async function exportarCronogramaExcelJS(body = { cronograma: true }) {
  const r = await post('/api/contratos/exportar', body);
  assert.equal(r.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await r.arrayBuffer()));
  return wb;
}

// Série A: 2 parcelas atrasadas + paga com vencimento antigo + vencendo HOJE + futura.
// Série B: só futuras (contrato SEM atraso — o visual da célula "Atrasadas" fica neutro).
const SERIE_A = { banco: 'Banco Crono', produto: 'Consórcio', empresa: 'SUL', grupo: 'CR-1', cota: '10', material: 'Carta de teste do cronograma' };
const SERIE_B = { banco: 'Banco Crono B', produto: 'Financiamento', empresa: 'NTE', material: 'Zérie sem atraso' };
const IDS = {}; // apelido → id gravado (preenchido no seed)

test('CR-1: seed — série com 2 atrasadas + série sem atraso', async () => {
  const casos = [
    ['pagaAntiga', { ...SERIE_A, parcela: '1/5', vencimento: br(emDias(-40)), valorParcela: 700, dataPagamento: br(emDias(-40)), valorPago: 700 }],
    ['atrasada10', { ...SERIE_A, parcela: '2/5', vencimento: br(emDias(-10)), valorParcela: 300 }],
    ['atrasada1', { ...SERIE_A, parcela: '3/5', vencimento: br(emDias(-1)), valorParcela: 500 }],
    ['venceHoje', { ...SERIE_A, parcela: '4/5', vencimento: br(emDias(0)), valorParcela: 200 }],
    ['futura', { ...SERIE_A, parcela: '5/5', vencimento: br(emDias(30)), valorParcela: 100 }],
    ['bFutura1', { ...SERIE_B, parcela: '1/2', vencimento: br(emDias(60)), valorParcela: 250 }],
    ['bFutura2', { ...SERIE_B, parcela: '2/2', vencimento: br(emDias(90)), valorParcela: 250 }],
  ];
  for (const [apelido, corpo] of casos) {
    const r = await post('/api/contratos', corpo);
    assert.equal(r.status, 201, `criação de ${apelido} deve responder 201`);
    IDS[apelido] = (await r.json()).id;
  }
});

test('CR-2: aba Parcelas do arquivo do Cronograma traz as colunas de atraso com a regra por dia', async () => {
  const { linhas } = await exportarLinhas({ cronograma: true }, 'Parcelas');
  assert.equal(linhas.length, 7);
  for (const col of ['STATUS', 'COMPETÊNCIA', 'ATRASADA', 'DIAS EM ATRASO', 'VALOR EM ATRASO']) {
    assert.ok(col in linhas[0], `a aba Parcelas deve ter a coluna ${col}`);
  }
  // Localiza pelo VALOR PARCELA (único por caso da série A no seed) — o campo PARC sai
  // normalizado pelo servidor com zeros à esquerda ("01/05"), o que tornaria o casamento frágil.
  const VALOR = { pagaAntiga: 700, atrasada10: 300, atrasada1: 500, venceHoje: 200, futura: 100 };
  const por = (apelido) => {
    const l = linhas.find((x) => x['VALOR PARCELA'] === VALOR[apelido]);
    assert.ok(l, `a planilha deve ter a linha de ${apelido}`);
    return l;
  };

  const pagaAntiga = por('pagaAntiga');
  assert.equal(pagaAntiga.STATUS, 'Pago', 'paga com vencimento antigo é Pago, não atrasada');
  assert.equal(pagaAntiga.ATRASADA, 'Não');
  assert.equal(pagaAntiga['DIAS EM ATRASO'], 0);
  assert.equal(pagaAntiga['VALOR EM ATRASO'], 0);

  const atrasada10 = por('atrasada10');
  assert.equal(atrasada10.STATUS, 'Atrasada');
  assert.equal(atrasada10.ATRASADA, 'Sim');
  assert.equal(atrasada10['DIAS EM ATRASO'], 10);
  assert.equal(atrasada10['VALOR EM ATRASO'], 300);
  const venc10 = emDias(-10);
  assert.equal(atrasada10['COMPETÊNCIA'], `${String(venc10.getMonth() + 1).padStart(2, '0')}/${venc10.getFullYear()}`);

  const atrasada1 = por('atrasada1');
  assert.equal(atrasada1.ATRASADA, 'Sim');
  assert.equal(atrasada1['DIAS EM ATRASO'], 1);

  const venceHoje = por('venceHoje');
  assert.equal(venceHoje.STATUS, 'Pendente', 'vencer HOJE ainda não é atraso');
  assert.equal(venceHoje.ATRASADA, 'Não');
  assert.equal(venceHoje['VALOR EM ATRASO'], 0);

  const futura = por('futura');
  assert.equal(futura.STATUS, 'Pendente');
  assert.equal(futura.ATRASADA, 'Não');
});

test('CR-3: linha × rodapé — a soma por parcela fecha com o total em atraso', async () => {
  // Mesma regra da tela (contrAtrasado no app.js), aplicada linha a linha, fecha o total:
  // 2 atrasadas (300 + 500), e pendentes = atrasadas + futuras (sem dupla contagem).
  const { linhas } = await exportarLinhas({ cronograma: true }, 'Parcelas');
  const atrasadas = linhas.filter((l) => l.ATRASADA === 'Sim');
  assert.equal(atrasadas.length, 2, 'a base tem exatamente 2 parcelas atrasadas');
  assert.equal(atrasadas.reduce((s, l) => s + l['VALOR EM ATRASO'], 0), 800);
  const pendentes = linhas.filter((l) => l.STATUS !== 'Pago');
  const futuras = linhas.filter((l) => l.STATUS === 'Pendente');
  assert.equal(pendentes.length, atrasadas.length + futuras.length, 'pendentes = atrasadas + futuras');
});

test('CR-4: export com {ids} respeita o recorte nas DUAS abas', async () => {
  const { wb, linhas } = await exportarLinhas({ ids: [IDS.atrasada1, IDS.futura], cronograma: true }, 'Parcelas');
  assert.equal(linhas.length, 2);
  assert.deepEqual(linhas.map((l) => l['VALOR PARCELA']).sort((a, b) => a - b), [100, 500]);
  // Aba Cronograma: só a série A entrou no recorte → 1 linha visual (fora o cabeçalho)
  const crono = XLSX.utils.sheet_to_json(wb.Sheets.Cronograma, { header: 1, defval: '' });
  assert.equal(crono.length - 1, 1, 'uma linha visual por contrato do recorte');
});

test('CR-5: export SEM a flag mantém o formato da aba Parcelas do site (sem abas/colunas novas)', async () => {
  // A importação (/api/contratos/importar) reconhece a planilha pelo formato atual — o export
  // padrão não pode ganhar coluna nem aba em silêncio.
  const { wb, linhas } = await exportarLinhas({}, 'CONTRATOS');
  assert.deepEqual(wb.SheetNames, ['CONTRATOS'], 'o export padrão continua com uma única aba CONTRATOS');
  assert.equal(linhas.length, 7);
  for (const col of ['STATUS', 'ATRASADA', 'DIAS EM ATRASO', 'VALOR EM ATRASO', 'COMPETÊNCIA']) {
    assert.ok(!(col in linhas[0]), `o export padrão não deve ter a coluna ${col}`);
  }
});

test('CR-6: aba Cronograma — 1 linha por contrato, meses ordenados, progresso e atraso como na tela', async () => {
  const wb = await exportarCronogramaExcelJS();
  const ws = wb.getWorksheet('Cronograma');
  assert.ok(ws, 'a aba Cronograma deve existir');
  assert.ok(wb.getWorksheet('Parcelas'), 'a aba Parcelas deve existir');
  assert.equal(ws.rowCount, 3, '2 séries → 2 linhas visuais + cabeçalho');

  // Cabeçalho: CONTRATO / PROGRESSO / ATRASADAS + meses do menor ao maior vencimento de TODAS
  // as parcelas (a paga de -40d inclusive — a planilha é o cronograma completo, como a tela)
  const cab = ws.getRow(1);
  assert.equal(cab.getCell(1).text, 'CONTRATO');
  assert.equal(cab.getCell(2).text, 'PROGRESSO');
  assert.match(cab.getCell(3).text, /ATRASADAS/);
  const mesIni = new Date(emDias(-40).getFullYear(), emDias(-40).getMonth(), 1); // parcela mais antiga (paga)
  const mesFim = new Date(emDias(90).getFullYear(), emDias(90).getMonth(), 1);   // maior pendente
  const esperados = [];
  for (let m = mesIni; m <= mesFim; m = new Date(m.getFullYear(), m.getMonth() + 1, 1)) esperados.push(m);
  for (let i = 0; i < esperados.length; i++) {
    assert.ok(cab.getCell(4 + i).text.startsWith(rotuloMes(esperados[i])),
      `coluna ${4 + i} deve ser ${rotuloMes(esperados[i])} (meses em ordem cronológica), veio "${cab.getCell(4 + i).text}"`);
  }
  assert.equal(ws.columnCount, 3 + esperados.length, 'sem coluna de mês além do intervalo do cronograma');
  const mesAtualIdx = esperados.findIndex((m) => chaveMes(m) === chaveMes(hoje));
  if (mesAtualIdx >= 0) assert.match(cab.getCell(4 + mesAtualIdx).text, /MÊS ATUAL/);

  // Linha da série A (ordem alfabética: "Carta..." antes de "Zérie...")
  const rowA = ws.getRow(2);
  assert.match(rowA.getCell(1).text, /Carta de teste do cronograma/);
  assert.match(rowA.getCell(1).text, /Banco Crono/);
  assert.match(rowA.getCell(1).text, /SUL/);
  assert.match(rowA.getCell(2).text, /01\/05/, 'progresso vem da parcela paga de maior número');
  assert.match(rowA.getCell(2).text, /4 restantes/);
  assert.match(rowA.getCell(3).text, /2 ATRASADAS/);
  assert.match(rowA.getCell(3).text, /R\$\s*800,00/);
  assert.equal(rowA.getCell(3).fill && rowA.getCell(3).fill.fgColor && rowA.getCell(3).fill.fgColor.argb, 'FFFBE9E9',
    'célula de atrasadas com fundo vermelho claro');

  // Célula do mês da parcela vencida há 10 dias → vermelha; mês só com futura → verde
  const idxVencida = esperados.findIndex((m) => chaveMes(m) === chaveMes(emDias(-10)));
  const celVencida = rowA.getCell(4 + idxVencida);
  assert.match(celVencida.text, /R\$/);
  assert.equal(celVencida.fill.fgColor.argb, 'FFFBE9E9', 'mês com parcela vencida fica vermelho');
  const idxFutura = esperados.findIndex((m) => chaveMes(m) === chaveMes(emDias(30)));
  const celFutura = rowA.getCell(4 + idxFutura);
  assert.match(celFutura.text, /R\$/);
  assert.equal(celFutura.fill.fgColor.argb, 'FFFBE9E9', 'mês pendente (não pago) fica vermelho, igual ao atrasado');

  // Linha da série B (sem atraso): célula de atrasadas neutra, meses futuros verdes
  const rowB = ws.getRow(3);
  assert.match(rowB.getCell(1).text, /Zérie sem atraso/);
  assert.match(rowB.getCell(2).text, /01\/02/);
  assert.equal(rowB.getCell(3).text, '—', 'contrato sem atraso fica neutro');
  assert.notEqual(rowB.getCell(3).fill && rowB.getCell(3).fill.fgColor && rowB.getCell(3).fill.fgColor.argb, 'FFFBE9E9');
  const idxB = esperados.findIndex((m) => chaveMes(m) === chaveMes(emDias(60)));
  assert.equal(rowB.getCell(4 + idxB).fill.fgColor.argb, 'FFFBE9E9'); // pendente = vermelho (só paga é verde)

  // Congela CONTRATO/PROGRESSO + cabeçalho
  assert.deepEqual({ x: ws.views[0].xSplit, y: ws.views[0].ySplit, s: ws.views[0].state }, { x: 2, y: 1, s: 'frozen' });
});

test('CR-7: aba Cronograma — parcela paga aparece no mês dela (cinza) sem virar célula aberta nem somar nos totais', async () => {
  const wb = await exportarCronogramaExcelJS();
  const ws = wb.getWorksheet('Cronograma');
  const cab = ws.getRow(1);
  const rowA = ws.getRow(2);
  const idxPaga = [...Array(ws.columnCount)].findIndex((_, i) => i >= 3 && cab.getCell(i + 1).text.startsWith(rotuloMes(emDias(-40)))) + 1;
  assert.ok(idxPaga >= 4, 'o mês da parcela paga (-40d) tem coluna própria');
  const celPaga = rowA.getCell(idxPaga);
  const mesMisto = chaveMes(emDias(-40)) === chaveMes(emDias(-10)); // na virada de mês a paga divide o mês com a vencida
  if (mesMisto) {
    // Mês com paga + aberta: valor EM ABERTO (300) e a marca "1 PAGA" — o 700 não entra na soma.
    assert.match(celPaga.text, /2 parcelas/);
    assert.match(celPaga.text, /1 PAGA/);
    assert.ok(!celPaga.text.includes('700'), 'o valor pago não soma na célula aberta');
    assert.equal(celPaga.fill.fgColor.argb, 'FFFBE9E9', 'célula com parcela vencida continua vermelha');
  } else {
    // Mês só com a paga: nº da parcela + valor no MESMO verde da "a pagar" — sem texto "PAGA".
    assert.match(celPaga.text, /01\/05/); // o servidor normaliza "1/5" → "01/05"
    assert.match(celPaga.text, /700/);
    assert.doesNotMatch(celPaga.text, /PAGA/, 'a cor verde já diz que está em dia; sem rótulo extra');
    assert.equal(celPaga.fill && celPaga.fill.fgColor && celPaga.fill.fgColor.argb, 'FFEAF6EF', 'célula paga é a única verde');
  }
  // Indicadores não mudam: coluna "Atrasadas" e demais células abertas seguem sem o 700.
  assert.match(rowA.getCell(3).text, /R\$\s*800,00/);
  for (let i = 4; i <= ws.columnCount; i++) {
    if (i === idxPaga) continue;
    // Procura o RÓTULO da paga (01/05), não o valor: em datas em que duas abertas do mesmo mês
    // somam 700 (500 + 200), o texto 'R$ 700,00' aparece legitimamente numa célula aberta.
    assert.ok(!String(rowA.getCell(i).text).includes('01/05'), `célula ${cab.getCell(i).text} não deve conter a parcela paga`);
  }
});

// Regressão do bug real (ago/2026): série com 01/80 e 02/80 PAGAS, 03/80 e 04/80 atrasadas e
// 05/80 futura — o Progresso dizia 02/80 e as duas pagas sumiam da linha do tempo ("—"),
// porque a célula do mês só existia quando havia parcela ABERTA. Regra final: a timeline
// mostra todas as parcelas do cronograma; o status só muda aparência e indicadores.
test('CR-8: pagas 01/80 e 02/80 aparecem no mês delas (cinza), atrasada e futura no mesmo vermelho (não pagas) — indicadores intactos', async () => {
  const SERIE_C = { banco: 'Banco Regressão', produto: 'Consórcio', empresa: 'SUL', grupo: 'CR-8', cota: '80', material: 'Toro da regressão' };
  // Meses distintos por calendário: em 05/10/2026, -65 e -35 dias caíam ambos em agosto,
  // e a célula agregada (corretamente) deixava este teste de parcelas individuais impossível.
  // USO: outubro/2026 → vencimentos em junho, julho, agosto, setembro e novembro.
  const vencimentos = [-4, -3, -2, -1, 1].map(n => new Date(hoje.getFullYear(), hoje.getMonth() + n, 1));
  const casos = [
    ['p01', { ...SERIE_C, parcela: '01/80', vencimento: br(vencimentos[0]), valorParcela: 2190, dataPagamento: br(vencimentos[0]), valorPago: 2190 }],
    ['p02', { ...SERIE_C, parcela: '02/80', vencimento: br(vencimentos[1]), valorParcela: 2190, dataPagamento: br(vencimentos[1]), valorPago: 2190 }],
    ['p03', { ...SERIE_C, parcela: '03/80', vencimento: br(vencimentos[2]), valorParcela: 2190 }],
    ['p04', { ...SERIE_C, parcela: '04/80', vencimento: br(vencimentos[3]), valorParcela: 2190 }],
    ['p05', { ...SERIE_C, parcela: '05/80', vencimento: br(vencimentos[4]), valorParcela: 2190 }],
  ];
  const ids = {};
  for (const [apelido, corpo] of casos) {
    const r = await post('/api/contratos', corpo);
    assert.equal(r.status, 201, `criação de ${apelido} deve responder 201`);
    ids[apelido] = (await r.json()).id;
  }
  const wb = await exportarCronogramaExcelJS({ ids: Object.values(ids), cronograma: true });
  const ws = wb.getWorksheet('Cronograma');
  const cab = ws.getRow(1);
  const row = ws.getRow(2);
  assert.equal(ws.rowCount, 2, 'uma linha visual para a série');
  const colDoMes = (d) => { for (let i = 4; i <= ws.columnCount; i++) if (cab.getCell(i).text.startsWith(rotuloMes(d))) return i; return -1; };
  assert.ok(cab.getCell(4).text.startsWith(rotuloMes(vencimentos[0])), 'a linha do tempo começa no mês da 01/80 (paga), sem navegação');

  // Progresso e resumo de atraso não mudam com as pagas na timeline
  assert.match(row.getCell(2).text, /02\/80/);
  assert.match(row.getCell(2).text, /78 restantes/);
  assert.match(row.getCell(3).text, /2 ATRASADAS/);
  assert.match(row.getCell(3).text, /R\$\s*4\.380,00/, 'só 03/80 + 04/80 no total em atraso');

  const fundo = (cel) => (cel.fill && cel.fill.fgColor && cel.fill.fgColor.argb) || null;
  const esperado = [
    ['01/80', vencimentos[0], 'paga'], ['02/80', vencimentos[1], 'paga'],
    ['03/80', vencimentos[2], 'atrasada'], ['04/80', vencimentos[3], 'atrasada'], ['05/80', vencimentos[4], 'futura'],
  ];
  for (const [parc, data, status] of esperado) {
    const cel = row.getCell(colDoMes(data));
    assert.match(cel.text, new RegExp(parc.replace('/', '\/')), `${parc} aparece no mês ${rotuloMes(data)}`);
    assert.match(cel.text, /2\.190,00/, `${parc} mostra o valor`);
    if (status === 'paga') { assert.doesNotMatch(cel.text, /PAGA/, `${parc} paga não leva rótulo "PAGA"`); assert.equal(fundo(cel), 'FFEAF6EF', `${parc} paga é verde`); }
    if (status === 'atrasada') assert.equal(fundo(cel), 'FFFBE9E9', `${parc} atrasada é vermelha`);
    if (status === 'futura') assert.equal(fundo(cel), 'FFFBE9E9', `${parc} futura (não paga) é vermelha, igual à atrasada`);
  }
  // Sem duplicata: cada nº de parcela aparece em exatamente UMA célula da linha
  const textoLinha = [];
  for (let i = 4; i <= ws.columnCount; i++) textoLinha.push(String(row.getCell(i).text));
  for (const [parc] of esperado) {
    assert.equal(textoLinha.filter((t) => t.includes(parc)).length, 1, `${parc} aparece uma única vez`);
  }
  // Aba Parcelas (indicadores): só 2 atrasadas, R$ 4.380,00 em atraso; pagas continuam "Pago"
  const { linhas: parcelas } = await exportarLinhas({ ids: Object.values(ids), cronograma: true }, 'Parcelas');
  assert.equal(parcelas.filter((l) => l.ATRASADA === 'Sim').length, 2);
  assert.equal(parcelas.reduce((s, l) => s + (Number(l['VALOR EM ATRASO']) || 0), 0), 4380);
  assert.equal(parcelas.filter((l) => l.STATUS === 'Pago').length, 2);
});

test('CR-9: aba Resumo é a 1ª do arquivo, descreve os filtros e fecha os totais com as outras abas', async () => {
  const wb = await exportarCronogramaExcelJS({ ids: Object.values(IDS), cronograma: true, filtros: { banco: ['Banco Crono'], soAtraso: true, busca: '=x' } });
  assert.equal(wb.worksheets[0].name, 'Resumo', 'Resumo tem que ser a primeira aba');
  assert.ok(wb.getWorksheet('Cronograma') && wb.getWorksheet('Parcelas'), 'as outras abas continuam');
  const ws = wb.getWorksheet('Resumo');
  const texto = [];
  ws.eachRow((row) => row.eachCell((cel) => texto.push(String(cel.text ?? cel.value ?? ''))));
  const tudo = texto.join('\n');
  assert.match(tudo, /Filtros aplicados/);
  assert.match(tudo, /Banco: Banco Crono · Só com atraso/, 'os filtros da tela aparecem no cabeçalho');
  assert.match(tudo, /Busca: "=x"/, 'busca com = não vira fórmula (protegida)');
  // Totais: série A (paga 700; abertas 300+500 atrasadas, 200 hoje, 100 futura) + série B (250+250)
  const valor = (rotulo) => { let v = null; ws.eachRow((row) => { row.eachCell((cel, col) => { if (v === null && String(cel.value) === rotulo) v = ws.getCell(row.number + 1, col).value; }); }); return v; }; // 1ª ocorrência = cartão de Totais
  assert.equal(valor('Já pago'), 700);
  assert.equal(valor('Em aberto'), 300 + 500 + 200 + 100 + 250 + 250);
  assert.equal(valor('Em atraso'), 800);
  assert.equal(valor('Parcelas atrasadas'), 2);
  assert.match(tudo, /Em atraso\nCarta de teste do cronograma/, 'contrato atrasado listado em Alertas');
  assert.match(tudo, /Quita em até 3 meses\nZérie sem atraso/, 'série B quita em 90 dias → alerta de quitação');
  let formula = null;
  ws.eachRow((row) => { if (String(row.getCell(1).value) === 'TOTAL') { const v = row.getCell(6).value; if (v && v.formula) formula = v; } });
  assert.ok(formula && /^SUM\(/.test(formula.formula), 'totais em fórmula SUM');
});
