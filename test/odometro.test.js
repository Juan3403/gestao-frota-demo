/**
 * Odômetro (Manutenção › Odômetro) — leitura da planilha, linha do tempo e API.
 * Parte 1 testa as regras puras (backend/odometro.js e frontend/odometro-calc.js).
 * Parte 2 sobe o servidor real num DATA_DIR temporário e exercita o que falha em SILÊNCIO:
 * reimportar não duplica, linha de exemplo do modelo não vira leitura, o Excel exportado
 * volta como importação sem duplicar, e a coleção entra no backup.
 * Rodar: npm test   (ou: node --test test/odometro.test.js)
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');
const odo = require('../backend/odometro');
const Calc = require('../frontend/odometro-calc.js');

const PORT = 3201; // faixa de test/ é 3196-3209 (ver test/portas.test.js)
const BASE = `http://localhost:${PORT}`;
// O servidor barra mutações sem Origin/Referer (anti-CSRF); o fetch cru do Node não manda.
const ORIG = { Origin: BASE, 'Content-Type': 'application/json' };
let srv, tmp;

// ----------------------------------------------------------------------------------------
// Parte 1: regras puras
// ----------------------------------------------------------------------------------------
test('entrada: placa, km e data aceitam o que a planilha costuma trazer', () => {
  assert.equal(odo.lerPlaca('abc-1d23'), 'ABC1D23');
  assert.equal(odo.lerPlaca('ABC 1234'), 'ABC1234');
  assert.equal(odo.lerPlaca('AB12'), '');
  assert.equal(odo.lerKm('45.320 km'), 45320, 'ponto de milhar pt-BR');
  assert.equal(odo.lerKm('45320,5'), 45320.5);
  assert.equal(odo.lerKm(45320.46), 45320.5, 'arredonda a 1 casa');
  assert.equal(odo.lerKm('abc'), null);
  assert.equal(odo.lerKm(-5), null);
  assert.equal(odo.lerData(46235), '2026-08-01', 'serial do Excel (46235 = 01/08/2026)');
  assert.equal(odo.lerData('01/08/2026 07:30'), '2026-08-01');
  assert.equal(odo.lerData('1/8/26'), '2026-08-01');
  assert.equal(odo.lerData('2026-08-01'), '2026-08-01');
  assert.equal(odo.lerData('31/02/2026'), '', 'data que não existe é recusada');
  assert.equal(odo.normalizarLeitura({ placa: 'ABC1D23', data: '01/08/2030', km: 10 }, { hoje: '2026-09-22' }).erro, 'data no futuro (01/08/2030)');
  assert.equal(odo.normalizarLeitura({ placa: 'ABC1D23', data: '01/08/2026', km: '' }, { hoje: '2026-09-22' }).erro, 'odômetro vazio');
});

test('cabeçalho: comparação exata, colunas do Excel exportado não se confundem com data/km', () => {
  assert.deepEqual(odo.mapearCabecalho(['Placa', 'Data', 'Odômetro (km)', 'Obs']), { placa: 0, data: 1, km: 2, obs: 3 });
  const exportado = ['PLACA', 'MODELO', 'DATA', 'ODÔMETRO (KM)', 'DESDE A ANTERIOR (KM)', 'DIAS DESDE A ANTERIOR', 'KM/DIA NO TRECHO', 'DESDE A 1ª LEITURA (KM)', 'CONFERIR', 'OBSERVAÇÃO', 'ORIGEM'];
  assert.deepEqual(odo.mapearCabecalho(exportado), { placa: 0, data: 2, km: 3, obs: 9 });
  assert.equal(odo.mapearCabecalho(['Nome', 'Valor']), null);
});

test('análise da planilha: acha o cabeçalho abaixo de um título, ignora exemplo/repetida/branco e aponta a linha do erro', () => {
  const linhas = [
    ['Controle de odômetro', '', ''],
    ['PLACA', 'DATA', 'KM'],
    ['ABC1D23', '01/07/2026', 45000],
    ['ABC1D23', '01/08/2026', '46.850'],
    ['ABC1D23', '01/08/2026', '46.850'],          // repetida dentro da mesma planilha
    ['', '', ''],                                  // linha em branco
    ['XYZ9999', 'amanhã', 1000],                   // data inválida → linha 7
  ];
  const existentes = [{ placa: 'ABC1D23', data: '2026-07-01', km: 45000 }];
  const r = odo.analisarPlanilha([{ nome: 'Plan1', linhas }], existentes, { hoje: '2026-09-22', gerarId: () => 'ODO1' });
  assert.equal(r.novas.length, 1);
  assert.equal(r.novas[0].km, 46850);
  assert.equal(r.novas[0].origem, 'planilha');
  assert.equal(r.repetidas, 2, 'a já gravada e a repetida na própria planilha');
  assert.deepEqual(r.erros, [{ linha: 7, motivo: 'data inválida (amanhã)' }]);
  const ex = odo.analisarPlanilha([{ nome: 'L', linhas: [['PLACA', 'DATA', 'ODÔMETRO (KM)', 'OBSERVAÇÃO'], ['ABC1D23', '01/07/2026', 1, 'EXEMPLO · apague']] }], [], { hoje: '2026-09-22' });
  assert.equal(ex.exemplos, 1);
  assert.equal(ex.novas.length, 0);
  assert.match(odo.analisarPlanilha([{ nome: 'X', linhas: [['A', 'B']] }], []).erroGeral, /PLACA, DATA e ODÔMETRO/);
});

test('linha do tempo: trecho, acumulado, voltou e salto; total = última menos primeira', () => {
  const l = (data, km) => ({ placa: 'ABC1D23', data, km });
  const tl = Calc.linhaDoTempo([l('2026-07-11', 45800), l('2026-07-01', 45000), l('2026-07-21', 458000), l('2026-07-31', 47000)]);
  assert.deepEqual(tl.map(x => x.delta), [null, 800, 412200, -411000]);
  assert.deepEqual(tl.map(x => x.desdeInicio), [0, 800, 413000, 2000]);
  assert.equal(tl[1].kmDia, 80);
  assert.deepEqual(tl.map(x => x.alerta), ['', '', 'salto', 'voltou']);
  assert.equal(Calc.textoAlerta(tl[3]), 'Voltou 411.000 km');
  const r = Calc.resumoVeiculo('ABC1D23', tl, { hoje: '2026-09-22' });
  assert.equal(r.km, 2000, 'o erro no meio não contamina o total');
  assert.equal(r.dias, 30);
  assert.equal(r.alertas, 2);
  assert.equal(r.diasSemLeitura, 53);
  assert.equal(r.semLeituraRecente, true);
  // Período: só as leituras dentro dele contam, e "sem leitura" continua olhando a última de todas.
  const p = Calc.resumoVeiculo('ABC1D23', tl, { de: '2026-07-01', ate: '2026-07-11', hoje: '2026-08-01' });
  assert.equal(p.km, 800);
  assert.equal(p.diasSemLeitura, 1);
  assert.equal(Calc.resumoVeiculo('ABC1D23', tl, { de: '2026-09-01' }), null);
  const frota = Calc.resumoFrota([l('2026-07-01', 100), l('2026-07-11', 600), { placa: 'XYZ4E56', data: '2026-07-01', km: 5 }], { placas: ['ABC1D23'] });
  assert.equal(frota.veiculos.length, 1);
  assert.equal(frota.km, 500);
});

// ----------------------------------------------------------------------------------------
// Parte 2: API
// ----------------------------------------------------------------------------------------
async function esperarServidor(ms = 10000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de teste não respondeu a tempo');
}
before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-odo-'));
  srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, DATA_DIR: tmp, PORT: String(PORT), APP_PASSWORD: '', SENHA_ADMIN: '', MONGODB_URI: '', COFRE_CHAVE: 'chave-segura-exclusiva-dos-testes' },
    stdio: 'ignore',
  });
  await esperarServidor();
});
after(() => {
  try { srv.kill(); } catch (e) { /* já morreu */ }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignora */ }
});

const post = (rota, corpo) => fetch(BASE + rota, { method: 'POST', headers: ORIG, body: JSON.stringify(corpo || {}) });
const listar = async () => (await fetch(BASE + '/api/odometros', { cache: 'no-store' })).json();
const baixarXlsx = async (rota) => {
  const r = await fetch(BASE + rota);
  assert.equal(r.status, 200, rota);
  return XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
};
function xlsx(linhas, aba = 'Leituras') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), aba);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function importar(buffer, nome = 'odometro.xlsx') {
  const fd = new FormData();
  fd.append('arquivo', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), nome);
  const r = await fetch(BASE + '/api/odometros/importar', { method: 'POST', headers: { Origin: BASE }, body: fd });
  return { status: r.status, corpo: await r.json() };
}

test('API: a planilha modelo traz as duas abas, e importá-la sem mexer não cria leitura', async () => {
  const wb = await baixarXlsx('/api/odometros/modelo');
  assert.deepEqual(wb.SheetNames, ['LEITURAS', 'COMO PREENCHER']);
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets.LEITURAS, { header: 1 });
  assert.deepEqual(linhas[0], ['PLACA', 'DATA', 'ODÔMETRO (KM)', 'OBSERVAÇÃO']);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const { status, corpo } = await importar(buf, 'MODELO_ODOMETRO.xlsx');
  assert.equal(status, 200);
  assert.equal(corpo.novas, 0);
  assert.equal(corpo.exemplos, 3, 'as 3 linhas EXEMPLO são ignoradas sozinhas');
  assert.equal((await listar()).length, 0);
});

test('API: importar soma, reimportar não duplica e o erro volta com o número da linha', async () => {
  const planilha = xlsx([
    ['Placa', 'Data', 'Odômetro (km)', 'Observação'],
    ['ABC-1D23', '01/07/2026', 45000, ''],
    ['ABC1D23', '01/08/2026', '46.850', 'revisão'],
    ['ABC1D23', '01/09/2026', 48320, ''],
    ['XYZ4E56', '10/08/2026', 12000, ''],
    ['XYZ4E56', '10/09/2026', 13500, ''],
    ['XYZ4E56', '15/09/2026', 'doze mil', ''],
  ]);
  const a = await importar(planilha);
  assert.equal(a.status, 200, JSON.stringify(a.corpo));
  assert.equal(a.corpo.novas, 5);
  assert.equal(a.corpo.veiculos, 2);
  assert.deepEqual(a.corpo.erros, [{ linha: 7, motivo: 'odômetro inválido (doze mil)' }]);
  assert.deepEqual(a.corpo.placasForaDaFrota, ['ABC1D23', 'XYZ4E56'], 'base de teste vazia: nenhuma placa está na Frota');
  const b = await importar(planilha);
  assert.equal(b.status, 200, 'tudo repetido + a mesma linha ruim é reimportação normal, não erro');
  assert.equal(b.corpo.novas, 0);
  assert.equal(b.corpo.repetidas, 5);
  assert.equal(b.corpo.totalErros, 1);
  const lista = await listar();
  assert.equal(lista.length, 5);
  assert.ok(lista.every(l => /^ODO/.test(l.id) && l.origem === 'planilha' && l.arquivo === 'odometro.xlsx'));
  // Só erro e nada novo = 400 com a lista, para a tela mostrar o que corrigir.
  const c = await importar(xlsx([['PLACA', 'DATA', 'KM'], ['ABC1D23', '01/01/2099', 1]]));
  assert.equal(c.status, 400);
  assert.equal(c.corpo.totalErros, 1);
  assert.match(c.corpo.erros[0].motivo, /futuro/);
});

test('API: leitura avulsa, duplicata recusada e exclusão', async () => {
  const ok = await post('/api/odometros', { placa: 'abc1d23', data: '2026-09-10', km: '49.000', obs: 'pneus' });
  assert.equal(ok.status, 201);
  const nova = await ok.json();
  assert.equal(nova.placa, 'ABC1D23');
  assert.equal(nova.km, 49000);
  assert.equal(nova.origem, 'manual');
  assert.equal((await post('/api/odometros', { placa: 'ABC1D23', data: '2026-09-10', km: 49000 })).status, 409);
  const ruim = await post('/api/odometros', { placa: 'ABC1D23', data: '2099-01-01', km: 1 });
  assert.equal(ruim.status, 400);
  assert.match((await ruim.json()).erro, /futuro/);
  const del = await fetch(BASE + '/api/odometros/' + nova.id, { method: 'DELETE', headers: { Origin: BASE } });
  assert.equal(del.status, 200);
  assert.equal((await fetch(BASE + '/api/odometros/' + nova.id, { method: 'DELETE', headers: { Origin: BASE } })).status, 404);
});

test('API: o Excel exportado traz trecho e resumo, e volta como importação sem duplicar', async () => {
  const wb = await baixarXlsx('/api/odometros/exportar?placas=ABC1D23');
  assert.deepEqual(wb.SheetNames, ['LEITURAS', 'RESUMO POR VEÍCULO']);
  const leituras = XLSX.utils.sheet_to_json(wb.Sheets.LEITURAS);
  assert.equal(leituras.length, 3, 'só a placa pedida');
  assert.deepEqual(leituras.map(l => l['DESDE A 1ª LEITURA (KM)']), [0, 1850, 3320]);
  const resumo = XLSX.utils.sheet_to_json(wb.Sheets['RESUMO POR VEÍCULO']);
  assert.equal(resumo[0]['KM RODADOS'], 3320);
  assert.equal(resumo[0].DIAS, 62);
  const porPeriodo = XLSX.utils.sheet_to_json((await baixarXlsx('/api/odometros/exportar?de=2026-08-01&ate=2026-08-31')).Sheets['RESUMO POR VEÍCULO']);
  assert.deepEqual(porPeriodo.map(r => r.PLACA), ['ABC1D23', 'XYZ4E56']);
  const volta = await importar(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }), 'ODOMETRO.xlsx');
  assert.equal(volta.status, 200);
  assert.equal(volta.corpo.novas, 0);
  assert.equal(volta.corpo.repetidas, 3);
});

test('backup: a coleção odometros está no dump com cobertura declarada', async () => {
  const r = await fetch(BASE + '/api/backup/modelo-manifest');
  assert.equal(r.status, 200);
  const man = await r.json();
  assert.equal(man.cobertura.ok, true, 'nenhum módulo do dump pode estar fora de COBERTURA_BACKUP: ' + (man.cobertura.faltando || []).join(', '));
  assert.ok(man.cobertura.modulos.includes('odometros'), 'odometros precisa estar em COBERTURA_BACKUP');
});
