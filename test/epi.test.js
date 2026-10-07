/**
 * EPI — Controle. Sobe o servidor real num DATA_DIR temporário e exercita o ciclo completo:
 * catálogo -> entrada -> ficha -> assinatura -> devolução, mais o que falha em SILÊNCIO
 * (estoque derivado, hash da assinatura, /verificar público, cobertura de backup, mídia órfã).
 * Rodar: npm test
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PDFParse } = require('pdf-parse'); // lê o texto do PDF da ficha (mesmo extrator do server)

const PORT = 3202;
const BASE = `http://localhost:${PORT}`;
// Contratos REAIS do catálogo (config/funcionarios-contratos.json, versionado): toda movimentação
// de EPI precisa dizer de qual obra o estoque saiu/entrou, e o número é validado contra esse
// catálogo. Usar número inventado aqui daria 400 — é justamente o que o teste CTR-2 exercita.
const CONTRATO = '4600009505';   // ORION (NTE)
const CONTRATO2 = '4600009606';  // ATLAS (NTE)
// O servidor barra mutações sem Origin/Referer (anti-CSRF); o fetch cru do Node não manda.
const ORIG = { Origin: BASE, 'Content-Type': 'application/json' };
let srv, tmp;
// Estado do processo filho: sem isto, um servidor que morre no boot (EADDRINUSE, variável de
// ambiente faltando...) some em silêncio — o spawn descartava o stderr e ninguém olhava o código
// de saída, então a suíte seguia contra o servidor alheio já de pé na porta.
let srvSaida = null; // código (ou sinal) com que o filho morreu, se morreu
let srvLog = '';     // stderr do filho, para a mensagem de erro dizer o motivo

const post = (rota, corpo) => fetch(BASE + rota, { method: 'POST', headers: ORIG, body: JSON.stringify(corpo || {}) });
const put = (rota, corpo) => fetch(BASE + rota, { method: 'PUT', headers: ORIG, body: JSON.stringify(corpo || {}) });
const del = (rota) => fetch(BASE + rota, { method: 'DELETE', headers: { Origin: BASE } });
const getEpi = async () => (await fetch(BASE + '/api/epi', { cache: 'no-store' })).json();
// PNG 1x1 válido (magic bytes de verdade: o endpoint confere o conteúdo, não o rótulo).
const PNG_1X1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const hoje = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-epi-'));
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

test('EPI: estoque é derivado das movimentações e o saldo inicial vira uma Entrada', async () => {
  const vazio = await getEpi();
  assert.deepEqual(vazio.catalogo, [], 'o catálogo começa vazio');
  assert.equal(vazio.indicadores.totalEstoque, 0);

  // Saldo inicial NÃO é campo: entra como movimentação, para o extrato fechar com o saldo.
  const r = await post('/api/epi/catalogo', {
    nome: 'Luva nitrílica G', codigo: 'LUV-G', ca: '28542', caValidade: '2027-12-31',
    fabricante: 'Acme', categoria: 'Membros superiores', unidade: 'par',
    estoqueMinimo: 40, vidaUtilMeses: 3, estoqueInicial: 100, contratos: [CONTRATO],
  });
  assert.equal(r.status, 201);
  const criado = await r.json();
  assert.equal(criado.estoque, 100, 'o estoque inicial precisa aparecer já na resposta');

  const d = await getEpi();
  assert.equal(d.catalogo.length, 1);
  assert.equal(d.catalogo[0].estoque, 100);
  assert.equal(d.movimentacoes.length, 1, 'o saldo inicial tem de ter gerado uma movimentação');
  assert.equal(d.movimentacoes[0].tipo, 'Entrada');
  assert.equal(d.movimentacoes[0].motivo, 'Saldo inicial');
  assert.equal(d.indicadores.totalEstoque, 100);

  // Entrega tira do estoque; devolução devolve; devolução com descarte NÃO devolve.
  const epiId = criado.id;
  const ficha = await (await post('/api/epi/movimentacoes', {
    tipo: 'Entrega', funcionarioNome: 'José Ribeiro', funcionarioCargo: 'Armador',
    empresa: 'Norte Engenharia', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId, quantidade: 10 }],
  })).json();
  assert.equal((await getEpi()).catalogo[0].estoque, 90);

  await post('/api/epi/movimentacoes', {
    tipo: 'Devolução', funcionarioNome: 'José Ribeiro', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId, quantidade: 4 }],
  });
  assert.equal((await getEpi()).catalogo[0].estoque, 94, 'devolução normal volta ao estoque');

  await post('/api/epi/movimentacoes', {
    tipo: 'Devolução', funcionarioNome: 'José Ribeiro', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId, quantidade: 3, descartar: true }],
  });
  assert.equal((await getEpi()).catalogo[0].estoque, 94, 'devolução DESCARTADA não volta ao estoque');

  // Substituição é sucata: sai um novo e o velho não volta.
  await post('/api/epi/movimentacoes', {
    tipo: 'Substituição', funcionarioNome: 'José Ribeiro', data: hoje(), contratoNumero: CONTRATO,
    motivo: 'desgaste', itens: [{ epiId, quantidade: 2 }],
  });
  assert.equal((await getEpi()).catalogo[0].estoque, 92, 'substituição só retira');

  // O item guarda SNAPSHOT do catálogo: CA e vida útil não podem vir do corpo do request.
  assert.equal(ficha.itens[0].ca, '28542');
  assert.equal(ficha.itens[0].vidaUtilMeses, 3);
  assert.equal(ficha.itens[0].nome, 'Luva nitrílica G');
});

test('EPI: status do CA classifica válido, a vencer e vencido', async () => {
  const daqui = (dias) => {
    const d = new Date(); d.setDate(d.getDate() + dias);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  await post('/api/epi/catalogo', { nome: 'CA vencido', ca: '1', caValidade: daqui(-5) });
  await post('/api/epi/catalogo', { nome: 'CA a vencer', ca: '2', caValidade: daqui(15) });
  await post('/api/epi/catalogo', { nome: 'CA folgado', ca: '3', caValidade: daqui(400) });
  await post('/api/epi/catalogo', { nome: 'Sem CA' });

  const d = await getEpi();
  const por = (n) => d.catalogo.find(e => e.nome === n);
  assert.equal(por('CA vencido').statusCa, 'Vencido');
  assert.equal(por('CA a vencer').statusCa, 'Próximo do vencimento');
  assert.equal(por('CA folgado').statusCa, 'Válido');
  assert.equal(por('Sem CA').statusCa, '', 'sem data de validade NÃO é "vencido"');
  assert.equal(d.indicadores.caVencido, 1);
  assert.equal(d.indicadores.caProximoVencer, 1);
  // Estoque zerado conta como abaixo do mínimo só quando existe mínimo definido.
  assert.equal(por('Sem CA').abaixoMinimo, false);
  assert.equal(por('Sem CA').semEstoque, true);
});

test('EPI: validade do CA aceita dd/mm/aaaa e descarta formato inválido (sem quebrar o alerta em silêncio)', async () => {
  const a = await (await post('/api/epi/catalogo', { nome: 'CA em BR', ca: '10', caValidade: '25/12/2030' })).json();
  assert.equal(a.caValidade, '2030-12-25', 'dd/mm/aaaa deve virar ISO');
  const b = await (await post('/api/epi/catalogo', { nome: 'CA lixo', ca: '11', caValidade: '2030-13-99 lixo' })).json();
  assert.equal(b.caValidade, '', 'formato não reconhecido é descartado, não gravado quebrado');
  assert.equal(b.statusCa, '', 'validade descartada não deve fingir estar "vencida"');
});

// Estas duas rodam SEM tocar a rede: o teste sobe com data dir vazio, então a base do CAEPI
// nunca foi sincronizada — é exatamente o estado em que a busca deve responder sem 500 (mesma
// disciplina do FP-1 do FIPE: nada aqui depende de um serviço externo estar de pé).
test('EPI-CA-1: buscar validade do CA sem a base sincronizada responde achou:false (sem 500)', async () => {
  const r = await fetch(BASE + '/api/epi/ca/54003');
  assert.equal(r.status, 200);
  const d = await r.json();
  assert.equal(d.achou, false);
  assert.equal(d.baseEm, null);
});

test('EPI-CA-2: buscar CA vazio (só caracteres não numéricos) responde 400', async () => {
  const r = await fetch(BASE + '/api/epi/ca/abc');
  assert.equal(r.status, 400);
});

test('EPI: assinatura carimba o hash, é conferível em /verificar e acende "alterado" ao editar', async () => {
  const epi = await (await post('/api/epi/catalogo', {
    nome: 'Capacete branco', ca: '31469', caValidade: '2028-01-31', unidade: 'un',
    estoqueInicial: 5, contratos: [CONTRATO],
  })).json();
  const ficha = await (await post('/api/epi/movimentacoes', {
    tipo: 'Entrega', funcionarioNome: 'Maria Alves', funcionarioCargo: 'Encarregada',
    empresa: 'Sul Empreendimentos', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 1 }],
  })).json();
  assert.equal(ficha.situacao, 'Pendente de assinatura');
  assert.equal(ficha.ficha, true, 'entrega tem de ser marcada como ficha');

  // Sem aceite o endpoint recusa — é o que dá valor de consentimento à assinatura.
  const semAceite = await post(`/api/epi/movimentacoes/${ficha.id}/assinar`, { imagem: PNG_1X1, nome: 'Maria Alves' });
  assert.equal(semAceite.status, 400, 'assinar sem aceite tem de falhar');

  const assinada = await (await post(`/api/epi/movimentacoes/${ficha.id}/assinar`, {
    imagem: PNG_1X1, nome: 'Maria Alves', aceite: true, modo: 'desenho',
  })).json();
  assert.equal(assinada.situacao, 'Assinado');
  assert.ok(assinada.assinatura && assinada.assinatura.id, 'a assinatura precisa virar mídia');
  assert.ok(assinada.assinaturaHash, 'o hash do conteúdo tem de ser carimbado');
  assert.ok(assinada.assinaturaCodigo, 'precisa de código público de conferência');
  assert.equal(assinada.alteradaAposAssinatura, false);

  // Conferência pública: sem login, e devolvendo os rótulos do módulo certo.
  const v = await (await fetch(`${BASE}/api/verificar/${assinada.assinaturaCodigo}`)).json();
  assert.equal(v.ok, true);
  assert.equal(v.modulo, 'epi');
  assert.equal(v.documento, 'Ficha de EPI');
  assert.equal(v.autentico, true);
  assert.equal(v.colaborador, 'Maria Alves');
  assert.equal(v.rotulos.itens, 'EPIs entregues');
  // Frase pronta, não adjetivo colado: "Ficha de EPI autêntico" erraria a concordância.
  assert.equal(v.rotulos.autentico, 'Ficha de EPI autêntica');
  assert.equal(v.itens[0].tipo, 'CA 31469', 'o CA vai no subtítulo do item');
  assert.equal(v.cpf, undefined, 'a página pública não pode expor CPF');

  // A ficha em PDF sai de pé (o QR e o texto passam pelo escape WinAnsi do pdf-lib).
  const pdf = await fetch(`${BASE}/api/epi/movimentacoes/${ficha.id}/ficha.pdf`);
  assert.equal(pdf.status, 200);
  assert.equal(pdf.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await pdf.arrayBuffer());
  assert.ok(buf.length > 2000, 'o PDF da ficha não pode sair vazio');
  assert.equal(buf.subarray(0, 4).toString(), '%PDF');

  // Editar depois de assinada faz o hash divergir -> "⚠ alterado", sem apagar a assinatura.
  const editada = await (await put(`/api/epi/movimentacoes/${ficha.id}`, {
    tipo: 'Entrega', funcionarioNome: 'Maria Alves', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 3 }],
  })).json();
  assert.equal(editada.alteradaAposAssinatura, true, 'editar a ficha assinada tem de acender o aviso');
  assert.ok(editada.assinatura && editada.assinatura.id, 'o PUT não pode APAGAR a assinatura');
  assert.equal(editada.assinaturaCodigo, assinada.assinaturaCodigo, 'o PUT não pode trocar o código');

  // E o PUT também não pode FORJAR uma assinatura onde não havia.
  const semAss = await (await post('/api/epi/movimentacoes', {
    tipo: 'Entrega', funcionarioNome: 'Outro', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 1 }],
  })).json();
  const forjada = await (await put(`/api/epi/movimentacoes/${semAss.id}`, {
    tipo: 'Entrega', funcionarioNome: 'Outro', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 1 }],
    assinatura: { id: 'MD-forjado', nome: 'x.png', tipo: 'image/png' }, assinaturaEm: Date.now(),
  })).json();
  assert.equal(forjada.assinatura, null, 'não deve ser possível forjar assinatura por PUT');
});

// O PDF da ficha usa o formulário oficial em Word como FUNDO, e os dois modelos foram convertidos
// com "NORTE ENGENHARIA"/CNPJ da NTE impressos no papel (o .doc da SUL é cópia do da NTE, só o logo
// mudou) — então a ficha da SUL saía identificando a empresa errada. O bloco da empresa agora é
// dado escrito por cima, e este teste é a trava: falha em SILÊNCIO (o PDF continua abrindo).
test('EPI: a ficha em PDF identifica a empresa do colaborador (a da SUL não sai como NTE)', async () => {
  const CONTRATO_SUL = '4600009101'; // MANUTENÇÃO CIVIL - BAHIA (SUL), do catálogo versionado
  const epi = await (await post('/api/epi/catalogo', {
    nome: 'Capacete das duas empresas', ca: '31469', unidade: 'un', contratos: [CONTRATO, CONTRATO_SUL],
  })).json();
  for (const ct of [CONTRATO, CONTRATO_SUL]) {
    await post('/api/epi/movimentacoes', {
      tipo: 'Entrada', data: hoje(), contratoNumero: ct, itens: [{ epiId: epi.id, quantidade: 5 }],
    });
  }
  const entregar = async (empresa, contratoNumero) => (await (await post('/api/epi/movimentacoes', {
    tipo: 'Entrega', data: hoje(), empresa, contratoNumero,
    funcionarioNome: `Colaborador ${empresa}`, funcionarioCargo: 'Servente',
    itens: [{ epiId: epi.id, quantidade: 1 }],
  })).json()).id;
  const idSul = await entregar('SUL', CONTRATO_SUL);
  const idNte = await entregar('NTE', CONTRATO);

  // Lê o TEXTO do PDF (mesmo extrator que o servidor usa nos anexos). O texto errado do modelo
  // continua extraível — ele é COBERTO por um retângulo branco, não removido —, então o que se
  // afere aqui é o que o servidor ESCREVEU: 2 ocorrências = cabeçalho + rodapé. Se só um dos dois
  // blocos fosse corrigido, a contagem cairia para 1. O tapa-buraco visual é geométrico e foi
  // conferido rasterizando os dois modelos (ver comentário de POS.empresaTopo no server.js).
  const texto = async (id) => {
    const r = await fetch(`${BASE}/api/epi/movimentacoes/${id}/ficha.pdf`);
    assert.equal(r.status, 200);
    const parser = new PDFParse({ data: Buffer.from(await r.arrayBuffer()) });
    try { return (await parser.getText()).text || ''; } finally { await parser.destroy(); }
  };
  const conta = (t, s) => t.split(s).length - 1;

  const tSul = await texto(idSul);
  assert.equal(conta(tSul, 'SUL EMPREENDIMENTOS'), 2, 'a ficha da SUL tem de escrever o nome da SUL no cabeçalho E no rodapé');
  assert.equal(conta(tSul, '98.447.360/0001-30'), 2, 'a ficha da SUL tem de escrever o CNPJ da SUL no cabeçalho E no rodapé');

  const tNte = await texto(idNte);
  assert.ok(tNte.includes('NORTE ENGENHARIA'), 'a ficha da NTE continua identificando a NTE');
  assert.ok(tNte.includes('96.105.728/0001-57'), 'a ficha da NTE continua com o CNPJ da NTE');
  assert.ok(!tNte.includes('SUL EMPREENDIMENTOS'), 'a ficha da NTE não pode receber o nome da SUL');
  assert.ok(!tNte.includes('98.447.360/0001-30'), 'a ficha da NTE não pode receber o CNPJ da SUL');
});

test('EPI: tipo de movimentação inválido é recusado (não vira Entrega em silêncio)', async () => {
  const epi = await (await post('/api/epi/catalogo', {
    nome: 'Respirador semifacial', estoqueInicial: 4, contratos: [CONTRATO],
  })).json();
  // Sem isto um "Substituicao" (sem cedilha) ou um acento corrompido viraria Entrada de
  // estoque pelo padrão do normalizador — invertendo o SINAL do saldo sem nenhum aviso.
  const r = await post('/api/epi/movimentacoes', {
    tipo: 'Substituicao', funcionarioNome: 'Teste', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 1 }],
  });
  assert.equal(r.status, 400);
  assert.match((await r.json()).erro, /inválido/i);
  const antes = (await getEpi()).catalogo.find(e => e.id === epi.id).estoque;
  assert.equal(antes, 4, 'a movimentação recusada não pode ter mexido no estoque');
  // Tipo AUSENTE continua caindo no padrão de propósito (o cliente não manda em toda tela).
  const semTipo = await post('/api/epi/movimentacoes', {
    funcionarioNome: 'Teste', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 1 }],
  });
  assert.equal(semTipo.status, 201);
  assert.equal((await semTipo.json()).tipo, 'Entrega');
});

test('EPI: entrada e devolução não recebem assinatura do colaborador', async () => {
  const epi = await (await post('/api/epi/catalogo', {
    nome: 'Bota PVC 42', unidade: 'par', estoqueInicial: 3, contratos: [CONTRATO],
  })).json();
  const entrada = await (await post('/api/epi/movimentacoes', {
    tipo: 'Entrada', fornecedor: 'Fornecedor X', notaFiscal: '4471', data: hoje(),
    contratoNumero: CONTRATO, itens: [{ epiId: epi.id, quantidade: 20 }],
  })).json();
  assert.equal(entrada.ficha, false);
  assert.equal(entrada.situacao, 'Lançado');
  const r = await post(`/api/epi/movimentacoes/${entrada.id}/assinar`, { imagem: PNG_1X1, aceite: true });
  assert.equal(r.status, 400, 'entrada de estoque não é recebimento de EPI por ninguém');
  const pdf = await fetch(`${BASE}/api/epi/movimentacoes/${entrada.id}/ficha.pdf`);
  assert.equal(pdf.status, 400, 'entrada não gera ficha de EPI');
});

test('EPI: troca programada usa a vida útil do momento da entrega', async () => {
  const epi = await (await post('/api/epi/catalogo', {
    nome: 'Protetor auricular', unidade: 'par', vidaUtilMeses: 6, estoqueInicial: 10,
    contratos: [CONTRATO],
  })).json();
  // Data bem no passado para o resultado não depender do dia em que o teste roda.
  await post('/api/epi/movimentacoes', {
    tipo: 'Entrega', funcionarioNome: 'Carlos Souza', data: '2020-01-31', contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 1 }],
  });
  const d = await getEpi();
  const p = d.posse.find(x => x.funcionarioNome === 'Carlos Souza' && x.epiId === epi.id);
  assert.ok(p, 'a posse precisa aparecer no payload');
  assert.equal(p.quantidade, 1);
  assert.equal(p.vence, '2020-07-31', '31/01 + 6 meses = 31/07');
  assert.equal(p.situacao, 'Troca vencida');
  assert.ok(p.dias < 0, 'dias tem de ser negativo quando já passou');

  // Mudar a vida útil no catálogo NÃO reescreve a regra da entrega que já aconteceu.
  await put(`/api/epi/catalogo/${epi.id}`, {
    nome: 'Protetor auricular', unidade: 'par', vidaUtilMeses: 600, contratos: [CONTRATO],
  });
  const d2 = await getEpi();
  const p2 = d2.posse.find(x => x.funcionarioNome === 'Carlos Souza' && x.epiId === epi.id);
  assert.equal(p2.vence, '2020-07-31', 'a vida útil da entrega é snapshot, não o valor atual do catálogo');

  // Trava de fim de mês: 31/01 + 1 mês tem de cair em 28/02, não escorregar para março.
  const curto = await (await post('/api/epi/catalogo', {
    nome: 'Máscara PFF2', vidaUtilMeses: 1, estoqueInicial: 5, contratos: [CONTRATO],
  })).json();
  await post('/api/epi/movimentacoes', {
    tipo: 'Entrega', funcionarioNome: 'Fim de Mês', data: '2021-01-31', contratoNumero: CONTRATO,
    itens: [{ epiId: curto.id, quantidade: 1 }],
  });
  const d3 = await getEpi();
  const pc = d3.posse.find(x => x.funcionarioNome === 'Fim de Mês');
  assert.equal(pc.vence, '2021-02-28', '31/01 + 1 mês = 28/02 (2021 não é bissexto)');

  // Devolver tudo tira a pessoa da lista de posse (e do alerta de troca).
  await post('/api/epi/movimentacoes', {
    tipo: 'Devolução', funcionarioNome: 'Fim de Mês', data: '2021-03-01', contratoNumero: CONTRATO,
    itens: [{ epiId: curto.id, quantidade: 1 }],
  });
  const d4 = await getEpi();
  assert.equal(d4.posse.some(x => x.funcionarioNome === 'Fim de Mês'), false, 'quem devolveu tudo sai da posse');
});

test('EPI: código duplicado é recusado e EPI com movimentação não pode ser excluído', async () => {
  await post('/api/epi/catalogo', { nome: 'Óculos incolor', codigo: 'OCU-1' });
  const dup = await post('/api/epi/catalogo', { nome: 'Óculos escuro', codigo: 'ocu-1' });
  assert.equal(dup.status, 400, 'código duplicado (mesmo em outra caixa) tem de ser recusado');

  const usado = await (await post('/api/epi/catalogo', {
    nome: 'Perneira', estoqueInicial: 2, contratos: [CONTRATO],
  })).json();
  const r = await del(`/api/epi/catalogo/${usado.id}`);
  assert.equal(r.status, 400, 'excluir EPI com movimentação deixaria o extrato órfão');
  assert.match((await r.json()).erro, /Desative/, 'a mensagem tem de sugerir desativar');

  const livre = await (await post('/api/epi/catalogo', { nome: 'Capa de chuva' })).json();
  assert.equal((await del(`/api/epi/catalogo/${livre.id}`)).status, 200, 'sem movimentação, exclui');
});

// ---- Estoque SEPARADO POR CONTRATO (obra) ----
// O estoque deixou de ser um número único do depósito: cada contrato tem o seu. Os testes abaixo
// travam as regras que, se cederem, corrompem o saldo em silêncio.
test('CTR-1: o estoque é separado por contrato e o total é a soma dos contratos', async () => {
  const epi = await (await post('/api/epi/catalogo', {
    nome: 'Luva vaqueta CTR', codigo: 'CTR-1', unidade: 'par', estoqueMinimo: 5,
    contratos: [CONTRATO, CONTRATO2],
  })).json();
  // Com 2 contratos o saldo inicial é ambíguo (de qual obra seria?) — tem de entrar por Entrada.
  assert.equal(epi.estoque, 0);
  await post('/api/epi/movimentacoes', {
    tipo: 'Entrada', data: hoje(), contratoNumero: CONTRATO, itens: [{ epiId: epi.id, quantidade: 30 }],
  });
  await post('/api/epi/movimentacoes', {
    tipo: 'Entrada', data: hoje(), contratoNumero: CONTRATO2, itens: [{ epiId: epi.id, quantidade: 4 }],
  });
  // Entregar por UM contrato só baixa o saldo DAQUELE contrato.
  await post('/api/epi/movimentacoes', {
    tipo: 'Entrega', funcionarioNome: 'Pedro Lima', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 10 }],
  });

  const e = (await getEpi()).catalogo.find(x => x.id === epi.id);
  assert.equal(e.estoque, 24, 'o total continua sendo a soma de todos os contratos (20 + 4)');
  const porNum = Object.fromEntries(e.estoquePorContrato.map(l => [l.numero, l]));
  assert.equal(porNum[CONTRATO].estoque, 20, 'a entrega saiu do saldo do contrato que a fez');
  assert.equal(porNum[CONTRATO2].estoque, 4, 'o outro contrato não pode ter sido tocado');
  // O mínimo é do EPI e vale em CADA contrato: 20 está acima de 5, 4 está abaixo.
  assert.equal(porNum[CONTRATO].abaixoMinimo, false);
  assert.equal(porNum[CONTRATO2].abaixoMinimo, true, 'um contrato pode estar baixo com o outro cheio');
  assert.equal(e.abaixoMinimo, true, 'o EPI é sinalizado quando QUALQUER contrato está baixo');
  assert.equal(e.naoMigrado, false);
});

test('CTR-2: movimentação sem contrato, ou com contrato inexistente, é recusada', async () => {
  const epi = await (await post('/api/epi/catalogo', { nome: 'Capuz CTR', codigo: 'CTR-2' })).json();
  const semContrato = await post('/api/epi/movimentacoes', {
    tipo: 'Entrada', data: hoje(), itens: [{ epiId: epi.id, quantidade: 1 }],
  });
  assert.equal(semContrato.status, 400, 'sem contrato o saldo não teria a que obra pertencer');
  assert.match((await semContrato.json()).erro, /contrato/i);

  const inventado = await post('/api/epi/movimentacoes', {
    tipo: 'Entrada', data: hoje(), contratoNumero: '9999999999', itens: [{ epiId: epi.id, quantidade: 1 }],
  });
  assert.equal(inventado.status, 400, 'número fora do catálogo de contratos tem de ser recusado');
  assert.equal((await getEpi()).catalogo.find(x => x.id === epi.id).estoque, 0, 'nada foi gravado');
});

test('CTR-3: EPI restrito a um contrato não pode ser movimentado por outro', async () => {
  const epi = await (await post('/api/epi/catalogo', {
    nome: 'Avental raspa CTR', codigo: 'CTR-3', contratos: [CONTRATO],
  })).json();
  const errado = await post('/api/epi/movimentacoes', {
    tipo: 'Entrada', data: hoje(), contratoNumero: CONTRATO2, itens: [{ epiId: epi.id, quantidade: 5 }],
  });
  assert.equal(errado.status, 400, 'o depósito de um contrato não pode receber EPI de outro');
  assert.match((await errado.json()).erro, /não está vinculado/i);

  const certo = await post('/api/epi/movimentacoes', {
    tipo: 'Entrada', data: hoje(), contratoNumero: CONTRATO, itens: [{ epiId: epi.id, quantidade: 5 }],
  });
  assert.equal(certo.status, 201);
});

test('CTR-4: EPI ainda NÃO migrado (sem contrato vinculado) passa em qualquer contrato', async () => {
  // Regra de rollout: como nenhum EPI nascia com contrato, travar os não migrados quebraria o
  // módulo inteiro no primeiro deploy. Eles seguem lançáveis (a tela os marca "⚠ sem contrato")
  // e passam a ser restritos SOZINHOS no instante em que alguém preencher o campo.
  const epi = await (await post('/api/epi/catalogo', { nome: 'Colete CTR', codigo: 'CTR-4' })).json();
  assert.equal(epi.naoMigrado, true);
  for (const c of [CONTRATO, CONTRATO2]) {
    const r = await post('/api/epi/movimentacoes', {
      tipo: 'Entrada', data: hoje(), contratoNumero: c, itens: [{ epiId: epi.id, quantidade: 2 }],
    });
    assert.equal(r.status, 201, 'EPI sem contrato vinculado não pode ser bloqueado em obra nenhuma');
  }
  const e = (await getEpi()).catalogo.find(x => x.id === epi.id);
  assert.equal(e.estoque, 4);
  // O saldo lançado aparece nas obras onde está, marcado como fora do vínculo — é o lembrete de
  // que falta migrar (e não um total sem origem visível).
  assert.equal(e.estoquePorContrato.length, 2);
  assert.ok(e.estoquePorContrato.every(l => l.foraDoVinculo), 'saldo sem vínculo tem de vir marcado');
  assert.equal(e.estoquePorContrato.reduce((s, l) => s + l.estoque, 0), e.estoque,
    'a soma das linhas por contrato tem de fechar com o total — nada de saldo invisível');
});

test('CTR-5: saldo inicial só é aceito com exatamente 1 contrato vinculado', async () => {
  // Um número só não dá para repartir entre obras sem inventar a divisão — e recusar ANTES de
  // gravar evita o EPI ficar criado com a resposta em erro.
  const dois = await post('/api/epi/catalogo', {
    nome: 'Bota CTR dois', codigo: 'CTR-5a', estoqueInicial: 10, contratos: [CONTRATO, CONTRATO2],
  });
  assert.equal(dois.status, 400);
  assert.match((await dois.json()).erro, /exatamente 1 contrato/i);
  assert.equal((await getEpi()).catalogo.some(e => e.codigo === 'CTR-5a'), false, 'não pode ter gravado');

  const nenhum = await post('/api/epi/catalogo', {
    nome: 'Bota CTR nenhum', codigo: 'CTR-5b', estoqueInicial: 10,
  });
  assert.equal(nenhum.status, 400, 'sem contrato também não se sabe de qual obra é o saldo');

  const um = await (await post('/api/epi/catalogo', {
    nome: 'Bota CTR um', codigo: 'CTR-5c', estoqueInicial: 10, contratos: [CONTRATO],
  })).json();
  assert.equal(um.estoque, 10);
  const mov = (await getEpi()).movimentacoes.find(m => m.motivo === 'Saldo inicial' && m.itens.some(i => i.epiId === um.id));
  assert.equal(mov.contratoNumero, CONTRATO, 'a Entrada do saldo inicial nasce no contrato vinculado');
  assert.match(mov.contrato, /ORION/i, 'o servidor resolve o rótulo do contrato, não o cliente');
});

test('CTR-6: saldo de movimentação SEM contrato aparece como linha própria (e não some no total)', async () => {
  // Todo o histórico anterior ao recurso não tem contratoNumero. Esse saldo não pode virar um
  // número fantasma que soma no total e não aparece em lugar nenhum — é o que faria a migração
  // manual parecer "já feita". Ele entra como uma linha visível até alguém reconciliar.
  const epi = await (await post('/api/epi/catalogo', {
    nome: 'Legado CTR', codigo: 'CTR-6', estoqueMinimo: 20,
  })).json();
  await post('/api/epi/movimentacoes', {
    tipo: 'Entrada', data: hoje(), contratoNumero: CONTRATO, itens: [{ epiId: epi.id, quantidade: 7 }],
  });
  // Agora vincula o EPI a um contrato DIFERENTE do que recebeu a entrada: o saldo já lançado
  // continua onde estava, visível, em vez de ser reatribuído em silêncio.
  await put(`/api/epi/catalogo/${epi.id}`, {
    nome: 'Legado CTR', codigo: 'CTR-6', estoqueMinimo: 20, contratos: [CONTRATO2],
  });
  const e = (await getEpi()).catalogo.find(x => x.id === epi.id);
  assert.equal(e.estoque, 7, 'o total não muda por causa do vínculo');
  const linha = e.estoquePorContrato.find(l => l.numero === CONTRATO);
  assert.ok(linha, 'o saldo do contrato que recebeu a entrada continua listado');
  assert.equal(linha.estoque, 7);
  assert.equal(linha.foraDoVinculo, true, 'e vem marcado como pendente de reconciliação');
  assert.equal(e.estoquePorContrato.find(l => l.numero === CONTRATO2).estoque, 0, 'o contrato novo começa zerado');
  assert.equal(e.estoquePorContrato.reduce((s, l) => s + l.estoque, 0), e.estoque,
    'a soma das linhas fecha com o total (nenhum saldo fica invisível)');
});

test('CTR-7: editar uma ficha antiga não trava porque o EPI trocou de contrato depois', async () => {
  // Sem esta folga, mexer só na observação de uma ficha de dois anos atrás falharia se o cadastro
  // do EPI tivesse mudado de contrato no meio-tempo — e a ficha assinada ficaria ineditável.
  const epi = await (await post('/api/epi/catalogo', {
    nome: 'Óculos CTR', codigo: 'CTR-7', estoqueInicial: 9, contratos: [CONTRATO],
  })).json();
  const ficha = await (await post('/api/epi/movimentacoes', {
    tipo: 'Entrega', funcionarioNome: 'Rita Alves', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 2 }],
  })).json();
  // O EPI sai do contrato da ficha.
  await put(`/api/epi/catalogo/${epi.id}`, {
    nome: 'Óculos CTR', codigo: 'CTR-7', contratos: [CONTRATO2],
  });

  // Item INALTERADO (mesmo EPI, mesma quantidade): o PUT passa.
  const soObs = await put(`/api/epi/movimentacoes/${ficha.id}`, {
    tipo: 'Entrega', funcionarioNome: 'Rita Alves', data: hoje(), contratoNumero: CONTRATO,
    obs: 'conferido pelo técnico', itens: [{ epiId: epi.id, quantidade: 2 }],
  });
  assert.equal(soObs.status, 200, 'editar campo solto de ficha antiga não pode travar');
  assert.equal((await soObs.json()).obs, 'conferido pelo técnico');

  // Mas MUDAR a quantidade é um lançamento novo naquele contrato — aí a regra vale.
  const mudaQtd = await put(`/api/epi/movimentacoes/${ficha.id}`, {
    tipo: 'Entrega', funcionarioNome: 'Rita Alves', data: hoje(), contratoNumero: CONTRATO,
    itens: [{ epiId: epi.id, quantidade: 5 }],
  });
  assert.equal(mudaQtd.status, 400, 'mexer na quantidade revalida o vínculo do EPI com o contrato');
});

test('EPI: exportações e relatórios respondem no recorte filtrado', async () => {
  const d = await getEpi();
  const xlsCat = await post('/api/epi/catalogo/exportar', { ids: d.catalogo.slice(0, 2).map(e => e.id) });
  assert.equal(xlsCat.status, 200);
  assert.match(xlsCat.headers.get('content-type') || '', /spreadsheet/);

  const xlsMov = await post('/api/epi/movimentacoes/exportar', { ids: d.movimentacoes.map(m => m.id) });
  assert.equal(xlsMov.status, 200);

  const relEstoque = await post('/api/epi/catalogo/relatorio.pdf', {});
  assert.equal(relEstoque.status, 200);
  assert.equal(Buffer.from(await relEstoque.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  const relMov = await post('/api/epi/movimentacoes/relatorio.pdf', {});
  assert.equal(relMov.status, 200);
  assert.equal(Buffer.from(await relMov.arrayBuffer()).subarray(0, 4).toString(), '%PDF');

  const zip = await post('/api/epi/movimentacoes/fichas.zip', {});
  assert.equal(zip.status, 200);
  assert.equal(Buffer.from(await zip.arrayBuffer()).subarray(0, 2).toString(), 'PK');
});

test('EPI: backup cobre as duas coleções e a assinatura da ficha não é tratada como órfã', async () => {
  // conferirCoberturaBackup LANÇA se uma chave do dump não estiver em COBERTURA_BACKUP —
  // então este 200 já prova que epiCatalogo/epiMovimentacoes estão registrados.
  const r = await fetch(`${BASE}/api/backup/gerar`, { headers: { Origin: BASE } });
  assert.equal(r.status, 200, 'a geração de backup não pode quebrar por cobertura faltando');
  const zip = Buffer.from(await r.arrayBuffer());
  assert.equal(zip.subarray(0, 2).toString(), 'PK');
  const texto = zip.toString('latin1');
  assert.ok(texto.includes('epi_catalogo.json'), 'o .zip precisa levar o catálogo');
  assert.ok(texto.includes('epi_movimentacoes.json'), 'o .zip precisa levar as movimentações');
  assert.ok(texto.includes('files/epi/'), 'a assinatura da ficha precisa ir para files/epi/');

  // A assinatura tem de estar em midiasReferenciadas(): senão a limpeza de órfãs a apagaria
  // ~1h depois de colhida (foi um bug real com os documentos de locação, v1.45.1).
  const d = await getEpi();
  const assinada = d.movimentacoes.find(m => m.assinatura && m.assinatura.id);
  assert.ok(assinada, 'o teste precisa de uma ficha assinada');
  const midia = await fetch(`${BASE}/api/midia/${assinada.assinatura.id}`);
  assert.equal(midia.status, 200, 'a imagem da assinatura tem de continuar acessível');
});

test('EPI: /verificar continua achando recibo do almoxarifado (código único entre módulos)', async () => {
  const retirada = await (await post('/api/almoxarifado', {
    funcionarioNome: 'Ana Paz', data: hoje(),
    itens: [{ nome: 'Furadeira', tipo: 'Ferramenta', quantidade: 1, unidade: 'un' }],
  })).json();
  const assinada = await (await post(`/api/almoxarifado/${retirada.id}/assinar`, {
    imagem: PNG_1X1, nome: 'Ana Paz', aceite: true, modo: 'desenho',
  })).json();
  const v = await (await fetch(`${BASE}/api/verificar/${assinada.assinaturaCodigo}`)).json();
  assert.equal(v.ok, true);
  assert.equal(v.modulo, 'almoxarifado', 'o recibo do almoxarifado não pode ter sido perdido no registro');
  assert.equal(v.documento, 'Recibo de entrega de material');
  assert.equal(v.rotulos.itens, 'Itens recebidos');
  assert.equal(v.rotulos.autentico, 'Recibo autêntico');

  // Código inexistente responde 404 com a mensagem genérica (não fala só de "recibo").
  const nada = await fetch(`${BASE}/api/verificar/ZZZZ-ZZZZ-ZZZZ`);
  assert.equal(nada.status, 404);
  assert.match((await nada.json()).erro, /documento/i);
});

// ===================== NF — Notas fiscais de compra de EPI =====================
async function subirAnexoNf(nome = 'nf.png') {
  const png = Buffer.from(PNG_1X1.split(',')[1], 'base64');
  const fd = new FormData();
  fd.append('arquivo', new Blob([png], { type: 'image/png' }), nome);
  const r = await fetch(`${BASE}/api/midia`, { method: 'POST', headers: { Origin: BASE }, body: fd });
  assert.equal(r.status, 201, 'upload do anexo da NF deve responder 201');
  return r.json();
}
const novaNf = (extra) => ({
  dataCompra: hoje(), numero: '12345', fornecedor: 'Frigelar',
  descricao: 'Luvas de vaqueta e botina de segurança', valorTotal: 1250.5,
  parcelas: 3, centroCusto: 'ORION', ...extra,
});

test('NF-1: ciclo da nota fiscal (criar, editar, excluir) e o valor da parcela sai do total', async () => {
  const criada = await (await post('/api/epi/notas-fiscais', novaNf())).json();
  assert.equal(criada.numero, '12345');
  assert.equal(criada.valorTotal, 1250.5);
  assert.equal(criada.parcelas, 3);
  assert.ok(criada.id.startsWith('EPI-NF'), 'id da NF tem prefixo próprio');

  // `valorParcela` NÃO é gravado (a tela divide total/parcelas) — igual ao estoque, que é derivado.
  assert.equal(criada.valorParcela, undefined, 'valor da parcela não pode ser gravado no modelo');

  const editada = await (await put(`/api/epi/notas-fiscais/${criada.id}`, { ...criada, valorTotal: 1400, parcelas: 2 })).json();
  assert.equal(editada.valorTotal, 1400);
  assert.equal(editada.parcelas, 2);
  assert.equal(editada.id, criada.id, 'editar não pode trocar o id');
  assert.equal(editada.ts, criada.ts, 'editar não pode reescrever a data do lançamento');

  const lista = await (await fetch(`${BASE}/api/epi/notas-fiscais`)).json();
  assert.ok(lista.some(n => n.id === criada.id));

  assert.equal((await del(`/api/epi/notas-fiscais/${criada.id}`)).status, 200);
  assert.equal((await del(`/api/epi/notas-fiscais/${criada.id}`)).status, 404, 'excluir duas vezes responde 404');
});

test('NF-2: campo obrigatório e NF repetida do mesmo fornecedor são recusados', async () => {
  for (const [campo, valor] of [['dataCompra', ''], ['numero', ''], ['fornecedor', ''], ['descricao', ''], ['valorTotal', 0], ['centroCusto', '']]) {
    const r = await post('/api/epi/notas-fiscais', novaNf({ [campo]: valor }));
    assert.equal(r.status, 400, `NF sem ${campo} tem de ser recusada`);
  }
  // Data em formato brasileiro não passa: o modelo guarda ISO e a lista ordena por string.
  assert.equal((await post('/api/epi/notas-fiscais', novaNf({ dataCompra: '29/07/2026' }))).status, 400);

  const um = await post('/api/epi/notas-fiscais', novaNf({ numero: 'NF-777' }));
  assert.equal(um.status, 201);
  const repetida = await post('/api/epi/notas-fiscais', novaNf({ numero: 'nf-777' })); // caixa não importa
  assert.equal(repetida.status, 409, 'mesma NF do mesmo fornecedor é erro de digitação');
  assert.equal((await repetida.json()).duplicada, true, 'a tela precisa saber que foi duplicidade para perguntar');
  // Com o aval explícito do usuário, entra.
  assert.equal((await post('/api/epi/notas-fiscais', novaNf({ numero: 'NF-777', permitirDuplicada: true }))).status, 201);
  // Fornecedor diferente com o mesmo número é compra legítima.
  assert.equal((await post('/api/epi/notas-fiscais', novaNf({ numero: 'NF-777', fornecedor: 'Protege EPI' }))).status, 201);

  // Parcelas fora da realidade não viram divisão sem sentido no resumo.
  const capada = await (await post('/api/epi/notas-fiscais', novaNf({ numero: 'NF-778', parcelas: 5000 }))).json();
  assert.equal(capada.parcelas, 360);
  const minima = await (await post('/api/epi/notas-fiscais', novaNf({ numero: 'NF-779', parcelas: 0 }))).json();
  assert.equal(minima.parcelas, 1, 'compra à vista conta como 1 parcela');
});

test('NF-3: a NF entra no payload da aba SEM estragar as movimentações (ordem e situação)', async () => {
  await post('/api/epi/notas-fiscais', novaNf({ numero: 'NF-PAYLOAD' }));
  let d = await getEpi();
  assert.ok(Array.isArray(d.notasFiscais), 'o payload da aba precisa trazer as notas fiscais');
  assert.ok(d.notasFiscais.some(n => n.numero === 'NF-PAYLOAD'));
  // As NFs ordenam pela data da COMPRA (não têm campo `data`).
  const datas = d.notasFiscais.map(n => n.dataCompra);
  assert.deepEqual(datas, [...datas].sort().reverse(), 'notas fiscais em ordem cronológica decrescente');

  // REGRESSÃO: ao encaixar as NFs no payload, a lista de movimentações perdeu a ordenação e o
  // comSituacaoMovEpi() — a situação das fichas passou a chegar vazia na tela.
  // Garante movimentação própria (o teste também roda isolado, com --test-name-pattern).
  if (!d.movimentacoes.length) {
    const epi = await (await post('/api/epi/catalogo', {
      nome: 'Bota NF-3', codigo: 'NF3-BOT', ca: '31000', estoqueInicial: 5, contratos: [CONTRATO],
    })).json();
    await post('/api/epi/movimentacoes', {
      tipo: 'Entrega', funcionarioNome: 'Teste NF3', data: hoje(), contratoNumero: CONTRATO,
      itens: [{ epiId: epi.id, quantidade: 1 }],
    });
    d = await getEpi();
  }
  assert.ok(d.movimentacoes.length, 'o teste precisa de movimentações lançadas antes');
  for (const m of d.movimentacoes) {
    assert.ok(m.situacao, `movimentação ${m.id} tem de vir com situação derivada`);
    assert.equal(typeof m.ficha, 'boolean', 'a interface separa fichas por este campo');
  }
  const dm = d.movimentacoes.map(m => m.data);
  assert.deepEqual(dm, [...dm].sort().reverse(), 'movimentações continuam da mais recente para a mais antiga');
});

test('NF-5: o Desfazer da aba reverte o lançamento da nota fiscal', async () => {
  // A rota /api/epi já estava em UNDO_ROTAS, mas só com os módulos de catálogo e movimentações:
  // sem `epiNotasFiscais` na lista, o snapshot não incluía as NFs e o "Desfazer" da aba
  // devolvia 200 deixando a nota lançada (desfazer que não desfaz).
  const criada = await (await post('/api/epi/notas-fiscais', novaNf({ numero: 'NF-UNDO' }))).json();
  const disponivel = async () => (await (await fetch(`${BASE}/api/desfazer/status?area=epi`)).json()).disponivel;
  const fim = Date.now() + 3000;
  while (Date.now() < fim && !(await disponivel())) await new Promise(r => setTimeout(r, 30));
  assert.equal(await disponivel(), true, 'lançar NF tem de deixar o Desfazer disponível na aba EPI');

  const r = await post('/api/desfazer/ultimo', { area: 'epi' });
  assert.equal(r.status, 200);
  const lista = await (await fetch(`${BASE}/api/epi/notas-fiscais`)).json();
  assert.equal(lista.some(n => n.id === criada.id), false, 'o Desfazer tem de remover a nota lançada');
});

test('NF-4: backup cobre as notas fiscais e o anexo não é tratado como órfão', async () => {
  const anexo = await subirAnexoNf();
  const nf = await (await post('/api/epi/notas-fiscais', novaNf({ numero: 'NF-ANEXO', anexo }))).json();
  assert.equal(nf.anexo.id, anexo.id);

  // conferirCoberturaBackup LANÇA se uma chave do dump não estiver em COBERTURA_BACKUP.
  const r = await fetch(`${BASE}/api/backup/gerar`, { headers: { Origin: BASE } });
  assert.equal(r.status, 200, 'a geração de backup não pode quebrar por cobertura faltando');
  const texto = Buffer.from(await r.arrayBuffer()).toString('latin1');
  assert.ok(texto.includes('epi_notas_fiscais.json'), 'o .zip precisa levar as notas fiscais');
  assert.ok(texto.includes('files/epi/notas-fiscais/'), 'o anexo da NF precisa ir para sua pasta no .zip');

  // Sem a NF em midiasReferenciadas(), a limpeza de órfãs apagaria o PDF/imagem ~1h depois (v1.45.1).
  const limpou = await post('/api/midia/limpar-orfas', {});
  assert.equal(limpou.status, 200);
  assert.equal((await fetch(`${BASE}/api/midia/${anexo.id}`)).status, 200, 'o anexo da NF tem de sobreviver à limpeza de órfãs');
});

test('NF-4b: o anexo da NF entra no backup do grupo certo (funcionarios), não no de frota', async () => {
  // `mapaPastaAnexos()` mandava o anexo para 'files/epi/notas-fiscais', pasta que não existia em
  // GRUPO_DE_PASTA_ANEXO — o filtro caía no fallback `|| 'frota'` EM SILÊNCIO. Resultado: backup
  // seletivo de "Funcionários" saía sem os PDFs das NFs (e o de "Frota" os levava indevidamente),
  // sem nada no manifest nem no resumo denunciando a falta. As duas metades importam.
  const anexo = await subirAnexoNf();
  await post('/api/epi/notas-fiscais', novaNf({ numero: 'NF-GRUPO', anexo }));

  const zipDe = async (grupo) => {
    const r = await fetch(`${BASE}/api/backup/gerar?grupo=${grupo}`, { headers: { Origin: BASE } });
    assert.equal(r.status, 200, `a geração do grupo ${grupo} tem de responder 200`);
    return Buffer.from(await r.arrayBuffer()).toString('latin1');
  };

  const funcs = await zipDe('funcionarios');
  assert.ok(funcs.includes('epi_notas_fiscais.json'), 'o grupo funcionarios leva o JSON das NFs');
  assert.ok(funcs.includes('files/epi/notas-fiscais/'), 'o grupo funcionarios TEM de levar o anexo da NF junto');

  const frota = await zipDe('frota');
  assert.ok(!frota.includes('files/epi/notas-fiscais/'), 'o grupo frota NÃO pode levar o anexo da NF de EPI');
});
