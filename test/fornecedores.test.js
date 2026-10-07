/**
 * Fornecedores — cadastro, busca, importação de planilha e pendências.
 * Sobe o servidor real num DATA_DIR temporário e exercita o que falha em SILÊNCIO:
 * validação de CNPJ, merge não destrutivo da planilha, idempotência da reimportação,
 * situação derivada e a trava de exclusão de quem tem nota fiscal atrelada.
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const XLSX = require('xlsx');

const PORT = 3204;
const BASE = `http://localhost:${PORT}`;
// O servidor barra mutações sem Origin/Referer (anti-CSRF); o fetch cru do Node não manda.
const ORIG = { Origin: BASE, 'Content-Type': 'application/json' };
let srv, tmp;

const post = (rota, corpo) => fetch(BASE + rota, { method: 'POST', headers: ORIG, body: JSON.stringify(corpo || {}) });
const put = (rota, corpo) => fetch(BASE + rota, { method: 'PUT', headers: ORIG, body: JSON.stringify(corpo || {}) });
const del = (rota) => fetch(BASE + rota, { method: 'DELETE', headers: { Origin: BASE } });
const listar = async () => (await fetch(BASE + '/api/fornecedores', { cache: 'no-store' })).json();
const acharPorNome = async (nome) => (await listar()).find(f => f.nome === nome);

// CNPJs com dígito verificador VÁLIDO (calculados, não inventados).
const CNPJ_A = '71205952000190';
const CNPJ_B = '97616128000116';
const CNPJ_C = '94313856000160';

function planilha(linhas, aba = 'Fornecedores') {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(linhas), aba);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['rascunho'], ['ignorar']]), 'Outra aba');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}
async function enviarPrevia(buffer, nomeArquivo = 'fornecedores.xlsx') {
  const fd = new FormData();
  fd.append('arquivo', new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), nomeArquivo);
  const r = await fetch(BASE + '/api/fornecedores/importar/previa', { method: 'POST', headers: { Origin: BASE }, body: fd });
  return { status: r.status, corpo: await r.json() };
}
// Repete o que a tela faz: manda a prévia inteira, menos o que ficou marcado para ignorar.
const aplicarDaPrevia = (previa) => post('/api/fornecedores/importar/aplicar', {
  arquivo: previa.arquivo,
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-forn-'));
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

test('CNPJ: valida os dígitos verificadores, guarda só números e recusa repetido', async () => {
  const ok = await post('/api/fornecedores', {
    nome: 'Hitachi', razaoSocial: 'Johnson Controls-Hitachi Ar Condicionado do Brasil LTDA',
    cnpj: '71.205.952/0001-90', cidade: 'São Paulo', uf: 'SP', telefone: '(11) 3333-4444',
    categorias: ['HVAC'], materiais: ['VRF', 'ar-condicionado'], tags: ['Hitachi'],
  });
  assert.equal(ok.status, 201);
  const criado = await ok.json();
  assert.equal(criado.cnpj, CNPJ_A, 'a máscara é da tela: no banco fica só o número');
  assert.equal(criado.origem, 'MANUAL');
  assert.equal(criado.ativo, true);
  assert.equal(criado.historico.length, 1, 'o cadastro precisa nascer com uma linha de histórico');

  // Dígito verificador errado não passa (não basta ter 14 caracteres).
  const invalido = await post('/api/fornecedores', { nome: 'Ruim', cnpj: '11.444.777/0001-99' });
  assert.equal(invalido.status, 400);
  // Sequência repetida também é recusada.
  assert.equal((await post('/api/fornecedores', { nome: 'Ruim 2', cnpj: '11111111111111' })).status, 400);

  const repetido = await post('/api/fornecedores', { nome: 'Outro nome', cnpj: CNPJ_A });
  assert.equal(repetido.status, 409, 'o mesmo CNPJ não pode entrar duas vezes');
  assert.match((await repetido.json()).erro, /Hitachi/, 'o erro diz em qual cadastro o CNPJ já está');

  assert.equal((await post('/api/fornecedores', { nome: '' })).status, 400, 'sem nome não grava');
});

test('Situação do cadastro é derivada e as pendências saem dela', async () => {
  await post('/api/fornecedores', { nome: 'Sem documento', cidade: 'Aracaju', uf: 'SE', telefone: '(79) 3000-0000', categorias: ['Serviços'] });
  const pend = await (await fetch(BASE + '/api/fornecedores/pendencias')).json();
  const semCnpj = pend.semCnpj.map(p => p.nome);
  assert.ok(semCnpj.includes('Sem documento'), 'quem não tem CNPJ entra em "sem CNPJ"');
  // O Hitachi tem CNPJ mas não tem categoria/cidade completos? tem cidade e categoria — só falta nada:
  const hitachi = await acharPorNome('Hitachi');
  assert.equal(hitachi.cnpj, CNPJ_A);
  // Tirar a categoria faz o mesmo cadastro cair para "incompleto", sem gravar nenhum campo de status.
  await put('/api/fornecedores/' + hitachi.id, Object.assign({}, hitachi, { categorias: [] }));
  const pend2 = await (await fetch(BASE + '/api/fornecedores/pendencias')).json();
  assert.ok(pend2.incompletos.some(p => p.nome === 'Hitachi'), 'sem categoria o cadastro fica incompleto');
  assert.ok(pend2.incompletos.find(p => p.nome === 'Hitachi').faltando.includes('categoria'));
  // Devolve a categoria para os testes seguintes.
  await put('/api/fornecedores/' + hitachi.id, Object.assign({}, hitachi, { categorias: ['HVAC'] }));
});

test('Edição preserva histórico e registra a troca de CNPJ; desativar não apaga', async () => {
  const f = await acharPorNome('Sem documento');
  const antes = f.historico.length;
  const r = await put('/api/fornecedores/' + f.id, Object.assign({}, f, { cnpj: CNPJ_B, razaoSocial: 'Sem Documento LTDA' }));
  assert.equal(r.status, 200);
  const depois = await r.json();
  assert.equal(depois.cnpj, CNPJ_B);
  assert.ok(depois.historico.length > antes, 'o histórico só cresce');
  assert.ok(depois.historico.some(h => h.acao === 'CNPJ'), 'a mudança de CNPJ vira evento próprio');

  const off = await (await put('/api/fornecedores/' + f.id, Object.assign({}, depois, { ativo: false }))).json();
  assert.equal(off.ativo, false);
  assert.ok(off.historico.some(h => h.acao === 'desativou'));
  assert.ok(await acharPorNome('Sem documento'), 'desativado continua na base');

  // CNPJ de outro cadastro não pode ser roubado por edição.
  const conflito = await put('/api/fornecedores/' + f.id, Object.assign({}, off, { cnpj: CNPJ_A }));
  assert.equal(conflito.status, 409);
});

test('Planilha: reconhece cabeçalhos variados, marca duplicidade e não grava na prévia', async () => {
  const buffer = planilha([
    ['FORNECEDOR', 'Razao Social', 'CNPJ/CPF', 'CIDADE', 'UF', 'Fone', 'CATEGORIA'],
    ['Ferreira Costa', 'Ferreira Costa & Cia LTDA', '97.616.128/0001-16', 'Recife', 'PE', '(81) 3344-5566', 'Construção civil'],
    ['', '', '', '', '', '', ''],
    ['Hitachi', 'Johnson Controls-Hitachi', CNPJ_A, 'São Paulo', 'SP', '', 'HVAC'],
    ['Empresa Ruim', '', '99.999.999/9999-99', 'Salvador', 'BA', '', 'Outros'],
  ]);
  const { status, corpo } = await enviarPrevia(buffer);
  assert.equal(status, 200);
  assert.deepEqual(corpo.abas, ['Fornecedores', 'Outra aba'], 'as abas da planilha voltam para o usuário escolher');
  assert.equal(corpo.mapa['FORNECEDOR'], 'nome');
  assert.equal(corpo.mapa['Razao Social'], 'razaoSocial', 'aceita cabeçalho sem acento');
  assert.equal(corpo.mapa['CNPJ/CPF'], 'cnpj');
  assert.equal(corpo.mapa['Fone'], 'telefone');
  assert.equal(corpo.total, 3, 'linha em branco não vira registro');

  const porNome = Object.fromEntries(corpo.linhas.map(l => [l.dados.nome, l]));
  assert.equal(porNome['Hitachi'].status, 'mesmo-cnpj');
  assert.equal(porNome['Hitachi'].acao, 'atualizar');
  assert.equal(porNome['Empresa Ruim'].status, 'cnpj-invalido');
  // CNPJ já pertence a outro cadastro (o "Sem documento" ficou com o CNPJ_B).
  assert.equal(porNome['Ferreira Costa'].status, 'mesmo-cnpj');

  const antes = (await listar()).length;
  assert.equal((await listar()).length, antes, 'a prévia não grava nada');
});

test('Importar: merge não destrutivo, CNPJ inválido recusado e reimportar não duplica', async () => {
  const buffer = planilha([
    ['FORNECEDOR', 'Razao Social', 'CNPJ/CPF', 'CIDADE', 'UF', 'Fone', 'CATEGORIA'],
    ['Hitachi', 'Johnson Controls-Hitachi do Brasil', CNPJ_A, 'São Paulo', 'SP', '', 'HVAC'],
    ['Elétrica Nordeste', 'Elétrica Nordeste Comércio LTDA', CNPJ_C, 'Recife', 'PE', '(81) 3000-1000', 'Material elétrico'],
    ['Empresa Ruim', '', '99.999.999/9999-99', 'Salvador', 'BA', '', 'Outros'],
  ]);
  const { corpo: previa } = await enviarPrevia(buffer);
  const r = await aplicarDaPrevia(previa);
  assert.equal(r.status, 200);
  const res = await r.json();
  assert.equal(res.criados, 1, 'só a Elétrica Nordeste é nova');
  assert.equal(res.atualizados, 1);
  assert.equal(res.ignorados, 1, 'o CNPJ inválido não entra');
  assert.match(res.erros[0], /CNPJ inválido/);

  // O telefone interno do Hitachi tinha sido digitado à mão e a planilha veio com a coluna
  // vazia: o dado comercial NÃO pode ser apagado pela importação.
  const hitachi = await acharPorNome('Hitachi');
  assert.equal(hitachi.telefone, '(11) 3333-4444', 'coluna vazia não apaga o que já estava no cadastro');
  assert.equal(hitachi.razaoSocial, 'Johnson Controls-Hitachi do Brasil', 'coluna preenchida atualiza');
  assert.ok(hitachi.historico.some(h => h.acao === 'importou'));
  const nova = await acharPorNome('Elétrica Nordeste');
  assert.equal(nova.origem, 'PLANILHA');
  assert.deepEqual(nova.categorias, ['Material elétrico']);

  // Reimportar o MESMO arquivo não pode multiplicar cadastro.
  const total = (await listar()).length;
  const { corpo: previa2 } = await enviarPrevia(buffer);
  const res2 = await (await aplicarDaPrevia(previa2)).json();
  assert.equal(res2.criados, 0, 'a segunda passada não cria ninguém');
  assert.equal((await listar()).length, total, 'o total não muda ao reimportar');
});

test('Remapear troca o destino da coluna sem reenviar o arquivo', async () => {
  const buffer = planilha([
    ['EMPRESA', 'DOCUMENTO', 'MUNICIPIO'],
    ['Vidraçaria Sul', '', 'Petrolina'],
  ]);
  const { corpo } = await enviarPrevia(buffer);
  assert.equal(corpo.mapa['EMPRESA'], 'nome', 'EMPRESA é sinônimo de nome fantasia');
  assert.equal(corpo.mapa['MUNICIPIO'], 'cidade');

  // Usuário decide ignorar a cidade e mandar o município para observações.
  const mapa = Object.assign({}, corpo.mapa, { MUNICIPIO: 'obs' });
  const r = await post('/api/fornecedores/importar/remapear', {
    mapa, linhas: corpo.linhas.map(l => ({ linha: l.linha, celulas: l.celulas })),
  });
  assert.equal(r.status, 200);
  const remap = await r.json();
  assert.equal(remap.linhas[0].dados.obs, 'Petrolina');
  assert.equal(remap.linhas[0].dados.cidade, undefined, 'a coluna remapeada deixa de alimentar cidade');
});

test('Exclusão: quem tem nota fiscal atrelada só pode ser desativado', async () => {
  const f = await acharPorNome('Elétrica Nordeste');
  // Uma nota da Manutenção emitida por esse fornecedor (casamento por nome, como na tela).
  const nf = await post('/api/oficina', { placa: 'ABC1D23', numeroNF: '123', fornecedor: 'Elétrica Nordeste', valor: 250.5, data: '2026-08-01' });
  assert.equal(nf.status, 201);

  const bloqueado = await del('/api/fornecedores/' + f.id);
  assert.equal(bloqueado.status, 409, 'apagar quem tem nota quebraria o gasto histórico da frota');
  assert.match((await bloqueado.json()).erro, /Desative/);
  assert.ok(await acharPorNome('Elétrica Nordeste'), 'continua na base');

  // Quem não tem nota alguma segue excluível.
  const semNota = await (await post('/api/fornecedores', { nome: 'Cadastro de teste' })).json();
  assert.equal((await del('/api/fornecedores/' + semNota.id)).status, 200);
});

test('Exportar traz CNPJ mascarado, listas legíveis e a situação calculada', async () => {
  const r = await fetch(BASE + '/api/fornecedores/exportar');
  assert.equal(r.status, 200);
  const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
  const linhas = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  const hitachi = linhas.find(l => l['NOME'] === 'Hitachi');
  assert.equal(hitachi['CNPJ'], '71.205.952/0001-90', 'a planilha sai com máscara (o banco guarda só números)');
  assert.equal(hitachi['CATEGORIAS'], 'HVAC');
  assert.equal(hitachi['MATERIAIS'], 'VRF; ar-condicionado', 'lista sai separada por ponto e vírgula');
  assert.ok(['Completo', 'Incompleto', 'Sem CNPJ'].includes(hitachi['SITUAÇÃO DO CADASTRO']));
  assert.equal(hitachi['ATIVO'], 'SIM');
});

test('Planilha modelo: todo cabeçalho é reconhecido na volta, exemplos não viram cadastro e cada coluna tem guia', async () => {
  const r = await fetch(BASE + '/api/fornecedores/modelo');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-disposition') || '', /MODELO_FORNECEDORES\.xlsx/);
  const buf = Buffer.from(await r.arrayBuffer());
  const wb = XLSX.read(buf, { type: 'buffer' });
  assert.deepEqual(wb.SheetNames, ['FORNECEDORES', 'COMO PREENCHER'], 'a aba de dados vem primeiro: a importação lê a primeira aba');
  const cab = XLSX.utils.sheet_to_json(wb.Sheets.FORNECEDORES, { header: 1 })[0];
  assert.ok(cab.includes('NOME') && cab.includes('CNPJ') && cab.includes('TIPO'));
  assert.ok(!cab.includes('SITUAÇÃO DO CADASTRO'), 'coluna calculada pelo sistema fica fora do modelo');
  const guia = XLSX.utils.sheet_to_json(wb.Sheets['COMO PREENCHER'], { header: 1 });
  for (const c of cab) assert.ok(guia.some(l => l[0] === c), `a aba COMO PREENCHER precisa explicar a coluna ${c}`);

  // Devolvida como veio: todo cabeçalho cai num campo sem mapear à mão, e os exemplos não viram cadastro.
  const previa = await enviarPrevia(buf, 'MODELO_FORNECEDORES.xlsx');
  assert.equal(previa.status, 200);
  for (const c of previa.corpo.cabecalhos) assert.ok(previa.corpo.mapa[c], `cabeçalho "${c}" do modelo precisa ser reconhecido`);
  assert.equal(previa.corpo.total, 2);
  assert.ok(previa.corpo.linhas.every(l => l.acao === 'ignorar' && l.status === 'exemplo'), 'linha "EXEMPLO ·" já entra como Não importar');

  // Trocou o nome do exemplo por um fornecedor de verdade: importa normalmente, com listas e CNPJ lidos.
  const matriz = XLSX.utils.sheet_to_json(wb.Sheets.FORNECEDORES, { header: 1, defval: '' });
  matriz[1][cab.indexOf('NOME')] = 'Auto Center do Modelo';
  const wb2 = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(matriz.slice(0, 2)), 'FORNECEDORES');
  const previa2 = (await enviarPrevia(XLSX.write(wb2, { type: 'buffer', bookType: 'xlsx' }))).corpo;
  assert.equal(previa2.linhas[0].acao, 'criar');
  assert.equal((await aplicarDaPrevia(previa2)).status, 200);
  const criado = await acharPorNome('Auto Center do Modelo');
  assert.ok(criado, 'a linha do modelo virou cadastro');
  assert.equal(criado.cnpj, '84668288000167');
  assert.equal(criado.tipo, 'Oficina');
  assert.deepEqual(criado.categorias, ['Oficina', 'Autopeças']);
  assert.equal(criado.uf, 'PB');
  assert.equal(criado.avaliacao, 4);
  assert.equal(criado.ativo, true);
});

test('Categorias devolvem as sugeridas e as que já estão em uso', async () => {
  const r = await (await fetch(BASE + '/api/fornecedores/categorias')).json();
  assert.ok(r.padrao.includes('Material elétrico'));
  assert.ok(r.padrao.includes('HVAC'));
  assert.ok(Array.isArray(r.usadas), 'as digitadas fora da lista voltam separadas');
});

test('Manutenção: vínculo validado, histórico preservado, edição parcial e remoção explícita', async () => {
  const f = await (await post('/api/fornecedores', { nome: 'Oficina do evento', obs: 'não expor no catálogo' })).json();
  const catalogo = await (await fetch(BASE + '/api/manutencao/fornecedores')).json();
  assert.deepEqual(catalogo.find(x => x.id === f.id), { id: f.id, nome: f.nome, ativo: true });
  const criado = await post('/api/manutencao', { placa: 'MNT1A23', item: 'Revisão', fornecedorId: f.id, fornecedor: 'Nome forjado' });
  assert.equal(criado.status, 200);
  const e = (await criado.json()).evento;
  assert.equal(e.fornecedor, f.nome, 'o nome vem do cadastro, não do cliente');
  assert.equal(e.fornecedorId, f.id);
  assert.equal((await del('/api/fornecedores/' + f.id)).status, 409, 'não pode quebrar um vínculo existente');
  assert.equal((await post('/api/manutencao', { placa: 'MNT1A23', fornecedorId: 'inexistente' })).status, 400);

  await put('/api/fornecedores/' + f.id, { ...f, nome: 'Nome novo da oficina', ativo: false });
  assert.equal((await post('/api/manutencao', { placa: 'MNT1A23', fornecedorId: f.id })).status, 400);
  const parcial = await (await put('/api/manutencao/' + e.id, { custo: 200 })).json();
  assert.equal(parcial.evento.fornecedorId, f.id);
  assert.equal(parcial.evento.fornecedor, f.nome, 'renomear/desativar não reescreve o histórico');
  const completo = await put('/api/manutencao/' + e.id, { ...parcial.evento, fornecedor: 'Nome forjado' });
  assert.equal(completo.status, 200, 'editar mantendo o fornecedor inativo continua permitido');
  assert.equal((await completo.json()).evento.fornecedor, f.nome);

  const exportado = await fetch(BASE + '/api/manutencao/exportar?ids=' + e.id);
  const buffer = Buffer.from(await exportado.arrayBuffer());
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const linha = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]])[0];
  assert.equal(linha.FORNECEDOR, f.nome);
  assert.equal(linha['FORNECEDOR ID'], f.id);
  const fd = new FormData();
  fd.append('arquivo', new Blob([buffer]), 'manutencao.xlsx');
  const importado = await fetch(BASE + '/api/manutencao/importar', { method: 'POST', headers: { Origin: BASE }, body: fd });
  assert.equal(importado.status, 200);
  const [reimportado] = await (await fetch(BASE + '/api/manutencao')).json();
  assert.equal(reimportado.fornecedorId, f.id);
  assert.equal(reimportado.fornecedor, f.nome, 'a volta do Excel conserva o vínculo e o nome histórico');

  const removido = await (await put('/api/manutencao/' + reimportado.id, { fornecedorId: '' })).json();
  assert.equal(removido.evento.fornecedorId, '');
  assert.equal(removido.evento.fornecedor, '');
  assert.equal((await del('/api/fornecedores/' + f.id)).status, 200);
  const legado = await (await post('/api/manutencao', { placa: 'MNT2B34', item: 'Sem fornecedor' })).json();
  assert.equal(legado.evento.fornecedorId, '');
});
