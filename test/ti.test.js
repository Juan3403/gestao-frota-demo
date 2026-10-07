/**
 * Inventário de TI — cadastro, situação derivada, termo assinado, assentos,
 * chave de licença fora das listas, importação idempotente e backup.
 * Sobe o servidor real num DATA_DIR temporário e exercita o que falha em SILÊNCIO:
 * a máquina de estados das movimentações, o hash do termo e o vazamento da chave.
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const PORT = 3208; // faixa de test/ é 3196-3209; 3206 é do SEG-8 (modulos.test.js), 3207 do acoes-sst.test.js
const BASE = `http://localhost:${PORT}`;
// O servidor barra mutações sem Origin/Referer (anti-CSRF); o fetch cru do Node não manda.
const ORIG = { Origin: BASE, 'Content-Type': 'application/json' };
let srv, tmp;

const post = (rota, corpo) => fetch(BASE + rota, { method: 'POST', headers: ORIG, body: JSON.stringify(corpo || {}) });
const put = (rota, corpo) => fetch(BASE + rota, { method: 'PUT', headers: ORIG, body: JSON.stringify(corpo || {}) });
const del = (rota) => fetch(BASE + rota, { method: 'DELETE', headers: { Origin: BASE } });
const payload = async () => (await fetch(BASE + '/api/ti', { cache: 'no-store' })).json();

// Assinatura de teste: um PNG 1x1 de verdade (o servidor confere os magic bytes).
const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function planilha(linhas, aba = 'TI') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), aba);
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function enviarPrevia(buffer, especie = 'equipamento') {
  const fd = new FormData();
  fd.append('especie', especie);
  fd.append('arquivo', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'ti.xlsx');
  const r = await fetch(BASE + '/api/ti/importar/previa', { method: 'POST', headers: { Origin: BASE }, body: fd });
  return { status: r.status, corpo: await r.json() };
}
const aplicarDaPrevia = (previa, especie = 'equipamento') => post('/api/ti/importar/aplicar', {
  arquivo: previa.arquivo, especie,
  linhas: previa.linhas.filter(l => l.acao !== 'ignorar').map(l => ({ linha: l.linha, dados: l.dados, acao: l.acao, alvo: l.alvo })),
});

async function esperarServidor(ms = 10000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { const r = await fetch(BASE + '/api/versao'); if (r.ok) return; } catch (e) { /* ainda subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor de teste não respondeu a tempo');
}

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-ti-'));
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

let notebookId, linhaId, licencaId, entregaId;

test('situação é derivada das movimentações, nunca gravada', async () => {
  const r = await post('/api/ti/ativos', {
    especie: 'equipamento', tipo: 'Notebook', marca: 'Dell', modelo: 'Latitude 3420',
    numeroSerie: 'BR123XYZ', local: 'Escritório', valor: '3.500,00', garantiaAte: '2030-01-10',
  });
  assert.equal(r.status, 201);
  const nb = await r.json();
  notebookId = nb.id;
  assert.equal(nb.situacao, 'Em estoque', 'ativo novo nasce Em estoque');
  assert.equal(nb.valor, 3500, 'valor em formato brasileiro vira número');

  // Entrega → Em uso, com posse apontando o colaborador.
  const ent = await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Entrega', funcionarioNome: 'Carlos Teste', local: 'ORION', condicao: 'Novo' });
  assert.equal(ent.status, 201);
  entregaId = (await ent.json()).id;
  let d = await payload();
  let a = d.ativos.find(x => x.id === notebookId);
  assert.equal(a.situacao, 'Em uso');
  assert.equal(a.posse.funcionarioNome, 'Carlos Teste');
  assert.equal(a.posse.termoAssinado, false, 'entrega nasce sem termo assinado');
  assert.equal(a.local, 'ORION', 'o local da entrega atualiza o cadastro (write-through)');

  // Máquina de estados: entregar de novo sem devolver é recusado.
  const dupla = await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Entrega', funcionarioNome: 'Outro' });
  assert.equal(dupla.status, 400);
  assert.match((await dupla.json()).erro, /Carlos Teste/, 'o erro diz com quem o equipamento está');

  // Manutenção mantém a posse; retorno devolve para Em uso.
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Manutenção', motivo: 'tela' })).status, 201);
  d = await payload();
  a = d.ativos.find(x => x.id === notebookId);
  assert.equal(a.situacao, 'Em manutenção');
  assert.equal(a.posse.funcionarioNome, 'Carlos Teste', 'a manutenção não apaga de quem é o aparelho');
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Retorno de manutenção' })).status, 201);
  d = await payload();
  assert.equal(d.ativos.find(x => x.id === notebookId).situacao, 'Em uso', 'retorno com dono volta para Em uso');

  // Devolução exige estar com alguém; depois dela, devolver de novo é recusado.
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Devolução', funcionarioNome: 'Carlos Teste', condicao: 'Bom' })).status, 201);
  d = await payload();
  assert.equal(d.ativos.find(x => x.id === notebookId).situacao, 'Em estoque');
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Devolução', funcionarioNome: 'Carlos Teste' })).status, 400);
});

test('tipo de movimentação inválido (ou de outra espécie) devolve 400', async () => {
  const r1 = await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Substituicao' });
  assert.equal(r1.status, 400, 'tipo fora da lista não entra (aceitar inverteria a situação em silêncio)');
  const rLin = await post('/api/ti/ativos', { especie: 'linha', operadora: 'Vivo', numero: '(83) 99999-0001', mensalidade: '59,90' });
  assert.equal(rLin.status, 201);
  linhaId = (await rLin.json()).id;
  const r2 = await post('/api/ti/movimentacoes', { ativoId: linhaId, tipo: 'Manutenção' });
  assert.equal(r2.status, 400, 'linha não vai para a manutenção');
  assert.match((await r2.json()).erro, /não se aplica/);
});

test('snapshot do ativo fica congelado na movimentação quando o cadastro muda', async () => {
  const d = await payload();
  const mov = d.movimentacoes.find(m => m.id === entregaId);
  assert.equal(mov.snapshot.numeroSerie, 'BR123XYZ');
  const r = await put('/api/ti/ativos/' + notebookId, { numeroSerie: 'TROCADO999', marca: 'Dell', modelo: 'Latitude 3420', tipo: 'Notebook' });
  assert.equal(r.status, 200);
  const d2 = await payload();
  assert.equal(d2.ativos.find(a => a.id === notebookId).numeroSerie, 'TROCADO999');
  assert.equal(d2.movimentacoes.find(m => m.id === entregaId).snapshot.numeroSerie, 'BR123XYZ',
    'corrigir o cadastro não reescreve o que a movimentação registrou');
});

test('assinatura grava hash e código; editar depois acende "alterado após a assinatura"', async () => {
  // Nova entrega para assinar (a primeira já foi devolvida).
  const ent = await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Entrega', funcionarioNome: 'Maria Souza', local: 'ATLAS', condicao: 'Bom' });
  assert.equal(ent.status, 201);
  const mov = await ent.json();

  // Sem aceite não há assinatura.
  const semAceite = await post(`/api/ti/movimentacoes/${mov.id}/assinar`, { imagem: PNG_1PX, nome: 'Maria Souza' });
  assert.equal(semAceite.status, 400);

  const ass = await post(`/api/ti/movimentacoes/${mov.id}/assinar`, { imagem: PNG_1PX, nome: 'Maria Souza', aceite: true, modo: 'desenho' });
  assert.equal(ass.status, 200);
  const assinada = await ass.json();
  assert.equal(assinada.situacao, 'Assinado');
  assert.ok(assinada.assinaturaHash, 'o hash do conteúdo assinado fica gravado');
  assert.match(assinada.assinaturaCodigo, /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/, 'código de conferência no formato padrão');
  assert.equal(assinada.alteradaAposAssinatura, false);

  // A página pública confere o código sem login e devolve os rótulos prontos.
  const ver = await fetch(BASE + '/api/verificar/' + assinada.assinaturaCodigo);
  assert.equal(ver.status, 200);
  const vj = await ver.json();
  assert.equal(vj.modulo, 'ti');
  assert.equal(vj.autentico, true);
  assert.equal(vj.rotulos.autentico, 'Termo de responsabilidade autêntico');

  // Editar o registro assinado (mudar o local, que ENTRA no conteúdo assinado) diverge o hash.
  const ed = await put('/api/ti/movimentacoes/' + mov.id, { funcionarioNome: 'Maria Souza', data: assinada.data, hora: assinada.hora, local: 'OUTRO LUGAR', condicao: 'Bom' });
  assert.equal(ed.status, 200);
  assert.equal((await ed.json()).alteradaAposAssinatura, true, 'o hash guardado denuncia a edição');
  const ver2 = await (await fetch(BASE + '/api/verificar/' + assinada.assinaturaCodigo)).json();
  assert.equal(ver2.autentico, false, 'a conferência pública também acusa');

  // O PDF do termo responde (não valida o desenho, só que o documento sai).
  const pdf = await fetch(BASE + `/api/ti/movimentacoes/${mov.id}/termo.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
});

test('assento de licença: atribuir além do total (ou duas vezes ao mesmo) é recusado', async () => {
  const r = await post('/api/ti/ativos', { especie: 'licenca', fabricante: 'Microsoft', produto: 'Microsoft 365 Business', assentos: 2, custo: '45,00', periodicidade: 'mensal', chave: 'XXXX-YYYY-ZZZZ-0001' });
  assert.equal(r.status, 201);
  licencaId = (await r.json()).id;
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: licencaId, tipo: 'Atribuição de assento', funcionarioNome: 'Carlos Teste' })).status, 201);
  const dup = await post('/api/ti/movimentacoes', { ativoId: licencaId, tipo: 'Atribuição de assento', funcionarioNome: 'Carlos Teste' });
  assert.equal(dup.status, 400, 'a mesma pessoa não ocupa dois assentos');
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: licencaId, tipo: 'Atribuição de assento', funcionarioNome: 'Maria Souza' })).status, 201);
  const cheia = await post('/api/ti/movimentacoes', { ativoId: licencaId, tipo: 'Atribuição de assento', funcionarioNome: 'Terceiro' });
  assert.equal(cheia.status, 400, 'sem assento livre não atribui');
  assert.match((await cheia.json()).erro, /2\/2/);
  // Revogar libera o assento.
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: licencaId, tipo: 'Revogação de assento', funcionarioNome: 'Carlos Teste' })).status, 201);
  const d = await payload();
  const lic = d.ativos.find(a => a.id === licencaId);
  assert.equal(lic.assentosOcupados, 1);
  assert.equal(lic.assentosLivres, 1);
});

test('a chave da licença nunca sai em lista, exportação ou PDF — só na rota própria', async () => {
  const d = await payload();
  const lic = d.ativos.find(a => a.id === licencaId);
  assert.equal(lic.chave, undefined, 'a listagem não carrega a chave');
  assert.equal(lic.temChave, true, 'mas avisa que ela existe');
  assert.ok(!JSON.stringify(d).includes('XXXX-YYYY-ZZZZ-0001'), 'nem escondida em outro campo do payload');

  const excel = await fetch(BASE + '/api/ti/exportar');
  assert.equal(excel.status, 200);
  const buf = Buffer.from(await excel.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  const tudo = wb.SheetNames.map(n => XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
  assert.ok(!tudo.includes('XXXX-YYYY-ZZZZ-0001'), 'a exportação não leva a chave');
  assert.ok(tudo.includes('Microsoft 365 Business'), 'mas leva a licença');

  const rota = await fetch(BASE + `/api/ti/ativos/${licencaId}/chave`);
  assert.equal((await rota.json()).chave, 'XXXX-YYYY-ZZZZ-0001', 'a rota própria devolve (gated por editar)');

  // Editar a licença SEM mandar chave não a apaga; limparChave=true apaga.
  await put('/api/ti/ativos/' + licencaId, { fabricante: 'Microsoft', produto: 'Microsoft 365 Business', assentos: 2 });
  assert.equal((await (await fetch(BASE + `/api/ti/ativos/${licencaId}/chave`)).json()).chave, 'XXXX-YYYY-ZZZZ-0001');
  await put('/api/ti/ativos/' + licencaId, { limparChave: true });
  assert.equal((await (await fetch(BASE + `/api/ti/ativos/${licencaId}/chave`)).json()).chave, '');
});

test('importação: prévia não grava, aplicar é idempotente e "quem usa" vira entrega sem termo', async () => {
  const plan = planilha([
    ['EQUIPAMENTO', 'MARCA', 'MODELO', 'N SERIE', 'USUÁRIO', 'LOCAL'],
    ['Notebook', 'Lenovo', 'ThinkPad E14', 'LNV555', 'Carlos Teste', 'Escritório'],
    ['Monitor', 'LG', '24MK430', 'LG888', '', 'ATLAS'],
  ]);
  const antes = (await payload()).ativos.length;
  const previa = await enviarPrevia(plan);
  assert.equal(previa.status, 200);
  assert.equal(previa.corpo.total, 2);
  assert.equal(previa.corpo.mapa['N SERIE'], 'numeroSerie', 'o detector reconhece o cabeçalho');
  assert.equal(previa.corpo.mapa['USUÁRIO'], 'responsavel');
  assert.equal((await payload()).ativos.length, antes, 'a prévia não grava nada');

  const ap1 = await aplicarDaPrevia(previa.corpo);
  assert.equal(ap1.status, 200);
  const j1 = await ap1.json();
  assert.equal(j1.criados, 2);
  assert.equal(j1.entregas, 1, 'a coluna USUÁRIO vira uma entrega');
  let d = await payload();
  const lnv = d.ativos.find(a => a.numeroSerie === 'LNV555');
  assert.equal(lnv.situacao, 'Em uso');
  assert.equal(lnv.posse.funcionarioNome, 'Carlos Teste');
  assert.equal(lnv.posse.termoAssinado, false, 'a entrega importada aguarda o termo');
  assert.ok(d.indicadores.entregasSemTermo >= 1, 'o alerta cobra a assinatura');

  // Reimportar a MESMA planilha: nada duplica (nem ativo, nem entrega).
  const previa2 = await enviarPrevia(plan);
  const linha1 = previa2.corpo.linhas.find(l => (l.dados || {}).numeroSerie === 'LNV555');
  assert.equal(linha1.acao, 'atualizar', 'série já cadastrada vira atualização');
  const ap2 = await aplicarDaPrevia(previa2.corpo);
  const j2 = await ap2.json();
  assert.equal(j2.criados, 0);
  assert.equal(j2.entregas, 0, 'quem já está com a pessoa não ganha outra entrega');
  const d2 = await payload();
  assert.equal(d2.ativos.length, d.ativos.length);
  assert.equal(d2.movimentacoes.length, d.movimentacoes.length);
});

test('exclusão: ativo com movimentação é bloqueado (o caminho é a Baixa)', async () => {
  const r = await del('/api/ti/ativos/' + notebookId);
  assert.equal(r.status, 409);
  assert.match((await r.json()).erro, /Baixa/, 'o erro ensina o caminho certo');
  // A baixa encerra e trava movimentação futura.
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Devolução', funcionarioNome: 'Maria Souza' })).status, 201);
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Baixa', motivo: 'sucata' })).status, 201);
  const d = await payload();
  assert.equal(d.ativos.find(a => a.id === notebookId).situacao, 'Baixado');
  assert.equal((await post('/api/ti/movimentacoes', { ativoId: notebookId, tipo: 'Entrega', funcionarioNome: 'Alguém' })).status, 400, 'baixado não recebe mais movimentação');
});

test('backup: as duas coleções entram no dump com cobertura declarada', async () => {
  const r = await fetch(BASE + '/api/backup/modelo-manifest');
  assert.equal(r.status, 200);
  const man = await r.json();
  assert.equal(man.cobertura.ok, true, 'nenhum módulo do dump pode estar fora de COBERTURA_BACKUP: ' + (man.cobertura.faltando || []).join(', '));
  assert.ok(man.cobertura.modulos.includes('tiAtivos'), 'tiAtivos precisa estar em COBERTURA_BACKUP');
  assert.ok(man.cobertura.modulos.includes('tiMovimentacoes'), 'tiMovimentacoes precisa estar em COBERTURA_BACKUP');
});

test('linha sem aparelho entra nos indicadores; linha duplicada é recusada', async () => {
  const d = await payload();
  assert.ok(d.indicadores.linhasSemAparelho >= 1, 'a linha criada sem aparelhoId conta no alerta');
  const dup = await post('/api/ti/ativos', { especie: 'linha', operadora: 'Claro', numero: '83999990001' });
  assert.equal(dup.status, 409, 'o mesmo número (comparado só por dígitos) não entra duas vezes');
});
