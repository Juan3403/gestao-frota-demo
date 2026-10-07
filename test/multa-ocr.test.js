'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const OCR = require('../frontend/multa-ocr');

// USO: linha('Placa: ABC1234',20,40,96) cria palavras e posições de OCR sem depender da CDN.
function linha(text, x = 20, y = 20, confidence = 96) {
  const words = text.split(' ').map(text => {
    const w = { text, confidence, bbox: { x0: x, y0: y, x1: x + text.length * 8, y1: y + 18 } };
    x = w.bbox.x1 + 8;
    return w;
  });
  return { text, words, bbox: { x0: words[0].bbox.x0, y0: y, x1: words.at(-1).bbox.x1, y1: y + 18 } };
}
// USO: dados(['Placa ABC1234','Valor Original 195,23']) monta a topologia Tesseract v5.
function dados(textos, confidence = 96) {
  const lines = textos.map((t, i) => typeof t === 'string' ? linha(t, 20, i * 32 + 20, confidence) : t);
  return { text: lines.map(l => l.text).join('\n'), blocks: [{ paragraphs: [{ lines }] }] };
}
// USO: colunas(linha('Descrição da',20,20),linha('Órgão autuador:',650,20)) preserva duas regiões na mesma linha OCR.
function colunas(esquerda, direita) {
  return { text: esquerda.text + ' ' + direita.text, words: [...esquerda.words, ...direita.words], bbox: { x0: esquerda.bbox.x0, y0: esquerda.bbox.y0, x1: direita.bbox.x1, y1: Math.max(esquerda.bbox.y1, direita.bbox.y1) } };
}
// USO: placa('EOW5J72',['EQW5J72']) devolve o campo da placa reconhecida pela Frota.
function placa(texto, placas, extras) {
  return OCR.analisar(dados(['Placa à época da infração ' + texto]), { placas, frotaDisponivel: true, ...extras }).campos.placa;
}

test('M OCR 01 — todos os campos têm contrato completo, inclusive não encontrados', () => {
  const r = OCR.analisar({ text: '' });
  assert.equal(r.texto, '');
  assert.deepEqual(Object.keys(r.campos), Object.keys(OCR.ROTULOS));
  Object.values(r.campos).forEach(c => {
    assert.equal(c.estado, 'naoEncontrado');
    assert.equal(c.valor, '');
    assert.equal(c.bbox, null);
    assert.equal(c.confianca, null);
    assert.deepEqual(c.alternativas, []);
    assert.deepEqual(c.correcoes, []);
  });
});

test('M OCR 02 — placa exata tem prioridade sobre placas semelhantes', () => {
  const p = placa('EOW5J72', ['EQW5J72', 'EOW5J72']);
  assert.equal(p.valor, 'EOW5J72');
  assert.equal(p.estado, 'claro');
  assert.equal(p.frota, true);
  assert.deepEqual(p.correcoes, []);
});

test('M OCR 03 — duas confusões clássicas podem identificar placa única', () => {
  const p = placa('EOW5I72', ['EQW5J72']);
  assert.equal(p.valor, 'EQW5J72');
  assert.equal(p.estado, 'claro');
  assert.equal(p.original, 'EOW5I72');
  assert.match(p.motivo, /Identificada pela Frota/);
});

test('M OCR 04 — duplicações de caracteres podem ser removidas', () => {
  for (const text of ['KDROE1I7', 'KDOROE17', 'KDROOE1I7']) {
    const p = placa(text, ['KDR0E17']);
    assert.equal(p.valor, 'KDR0E17', text);
    assert.equal(p.estado, 'claro', text);
    assert.ok(p.correcoes.length);
  }
});

test('M OCR 05 — remoção sem duplicação plausível exige revisão', () => {
  const p = placa('XKDR0E17', ['KDR0E17']);
  assert.equal(p.valor, 'KDR0E17');
  assert.equal(p.estado, 'revisar');
  assert.match(p.motivo, /remoção/);
});

test('M OCR 06 — ambiguidades nunca escolhem primeiro veículo e ordem é irrelevante', () => {
  const a = placa('EOW5J72', ['EQW5J72', 'EDW5J72']);
  const b = placa('EOW5J72', ['EDW5J72', 'EQW5J72']);
  assert.deepEqual(a, b);
  assert.equal(a.estado, 'revisar');
  assert.equal(a.valor, '');
  assert.deepEqual(a.alternativas, ['EDW5J72', 'EQW5J72']);
});

test('M OCR 07 — mais de duas trocas não identificam veículo automaticamente', () => {
  const p = placa('E0W5I72', ['DQW5J72']);
  assert.equal(p.frota, false);
  assert.equal(p.estado, 'revisar');
});

test('M OCR 08 — placa ausente e consulta indisponível ficam para conferência', () => {
  const ausente = placa('ABC1234', ['XYZ5678']);
  assert.equal(ausente.valor, 'ABC1234');
  assert.equal(ausente.estado, 'revisar');
  assert.equal(ausente.frota, false);
  const indisponivel = placa('ABC1234', ['ABC1234'], { frotaDisponivel: false });
  assert.equal(indisponivel.estado, 'revisar');
  assert.equal(indisponivel.frota, false);
  assert.match(indisponivel.motivo, /indisponível/);
});

test('M OCR 09 — sanitiza e deduplica placas cadastradas sem alterar o contexto', () => {
  const placas = ['abc-1234', 'ABC 1234', '', null];
  const p = placa('ABC 1234', placas);
  assert.equal(p.valor, 'ABC1234');
  assert.equal(p.estado, 'claro');
  assert.deepEqual(placas, ['abc-1234', 'ABC 1234', '', null]);
});

test('M OCR 10 — todos os demais campos claros precisam de rótulo e confiança >=85', () => {
  const textos = [
    'Auto de Infração H803798', 'Descrição DIRIGIR SEM POSSUIR CNH', 'Data/Hora do Cometimento da Infração 10/09/2026 14:37',
    'Valor Original R$ 195,23', 'Local da Infração AVENIDA CENTRAL',
    'Cidade/UF BRASILIA/DF', 'Código da Infração 5002-0', 'Órgão Autuador DETRAN DF',
    'Data da Notificação de Autuação 20/09/2026', 'Data do Vencimento do Desconto 10/10/2026'
  ];
  const r = OCR.analisar(dados(textos));
  for (const [k, c] of Object.entries(r.campos)) if (k !== 'placa') {
    assert.equal(c.estado, 'claro', k + ': ' + c.original);
    assert.equal(c.confianca, 96);
    assert.ok(c.bbox, k);
  }
  assert.equal(r.campos.descricao.valor, 'Dirigir sem possuir CNH');
  assert.equal(r.campos.valor.valor, '195.23');
});

test('M OCR 11 — dados de texto sem confiança exigem revisão exceto placa Frota', () => {
  const r = OCR.analisar({ text: 'Placa ABC1234\nValor Original R$ 195,23\nData/Hora do Cometimento da Infração 10/09/2026 14:37' }, { placas: ['ABC1234'] });
  assert.equal(r.campos.placa.estado, 'claro');
  assert.equal(r.campos.valor.estado, 'revisar');
  assert.equal(r.campos.dataInfracao.estado, 'revisar');
  assert.equal(r.campos.valor.confianca, null);
});

test('M OCR 12 — confiança usa todas as palavras, inclusive o rótulo', () => {
  const l = linha('Valor Original R$ 195,23');
  l.words[0].confidence = 84;
  const r = OCR.analisar(dados([l]));
  assert.equal(r.campos.valor.estado, 'revisar');
  assert.equal(r.campos.valor.confianca, 84);
  l.words[0].confidence = 85;
  assert.equal(OCR.analisar(dados([l])).campos.valor.estado, 'claro');
});

test('M OCR 13 — falta de confiança em uma palavra não pode promover para claro', () => {
  const l = linha('Valor Original R$ 195,23');
  delete l.words.at(-1).confidence;
  assert.equal(OCR.analisar(dados([l])).campos.valor.estado, 'revisar');
});

test('M OCR 14 — desconto antes de original não troca valor da multa', () => {
  const r = OCR.analisar(dados(['Valor com desconto R$ 156,18', 'Valor Original R$ 195,23']));
  assert.equal(r.campos.valor.valor, '195.23');
  assert.equal(r.campos.valor.estado, 'claro');
  assert.equal(OCR.analisar(dados(['Valor com 20% desconto R$ 156,18'])).campos.valor.estado, 'naoEncontrado');
});

test('M OCR 15 — valor separado por próxima linha e delimitado pelo próximo rótulo', () => {
  const r = OCR.analisar(dados(['Valor Original', 'R$ 1.234,56', 'Data da Infração 10/09/2026']));
  assert.equal(r.campos.valor.valor, '1234.56');
  assert.equal(r.campos.valor.estado, 'claro');
  assert.equal(OCR.analisar(dados(['Valor Original', 'Data da Infração 10/09/2026'])).campos.valor.estado, 'naoEncontrado');
});

test('M OCR 16 — separador decimal perdido é inferência mesmo com alta confiança', () => {
  const c = OCR.analisar(dados(['Valor Original R$ 19523'])).campos.valor;
  assert.equal(c.valor, '195.23');
  assert.equal(c.estado, 'revisar');
  assert.match(c.correcoes[0], /inferidos/);
});

test('M OCR 17 — datas da infração, notificação e vencimento permanecem distintas', () => {
  const c = OCR.analisar(dados([
    'Data da Notificação de Autuação 20/09/2026', 'Data do Vencimento do Desconto 10/10/2026',
    'Data/Hora do Cometimento da Infração 10/09/2026 14:37'
  ])).campos;
  assert.equal(c.dataInfracao.valor, '10/09/2026');
  assert.equal(c.horaInfracao.valor, '14:37');
  assert.equal(c.dataNotificacao.valor, '20/09/2026');
  assert.equal(c.dataVencimento.valor, '10/10/2026');
});

test('M OCR 18 — somente data rotulada não é inferida de notificação ou documento', () => {
  const c = OCR.analisar(dados(['NOTIFICAÇÃO DE AUTUAÇÃO', '20/09/2026', 'Data da Notificação 20/09/2026'])).campos;
  assert.equal(c.dataInfracao.estado, 'naoEncontrado');
  assert.equal(c.horaInfracao.estado, 'naoEncontrado');
  assert.equal(c.descricao.estado, 'naoEncontrado');
});

test('M OCR 19 — datas impossíveis e horários impossíveis ficam em revisão', () => {
  const c = OCR.analisar(dados(['Data/Hora do Cometimento da Infração 31/02/2026 24:37'])).campos;
  assert.equal(c.dataInfracao.estado, 'revisar');
  assert.equal(c.dataInfracao.valor, '31/02/2026');
  assert.match(c.dataInfracao.motivo, /inválido/);
  assert.equal(c.horaInfracao.estado, 'revisar');
});

test('M OCR 20 — separadores de data e hora reconstruídos exigem revisão', () => {
  const c = OCR.analisar(dados(['Data / Hora do Cometimento da Infração 10092026 1437'])).campos;
  assert.equal(c.dataInfracao.valor, '10/09/2026');
  assert.equal(c.dataInfracao.estado, 'revisar');
  assert.equal(c.horaInfracao.valor, '14:37');
  assert.equal(c.horaInfracao.estado, 'revisar');
});

test('M OCR 21 — valores conflitantes pedem revisão sem escolher primeiro', () => {
  const c = OCR.analisar(dados(['Valor Original 195,23', 'Valor Original 293,47'])).campos.valor;
  assert.equal(c.estado, 'revisar');
  assert.equal(c.valor, '');
  assert.deepEqual(c.alternativas, ['195.23', '293.47']);
});

test('M OCR 22 — auto e código com caracteres corrigidos exigem revisão', () => {
  const c = OCR.analisar(dados(['Auto de Infração NOO?135790', 'Código da Infração 5002 - O'])).campos;
  assert.equal(c.autoInfracao.valor, 'N002135790');
  assert.equal(c.autoInfracao.estado, 'revisar');
  assert.equal(c.codigoInfracao.valor, '5002-0');
  assert.equal(c.codigoInfracao.estado, 'revisar');
  const intacto = OCR.analisar(dados(['Auto de Infração JOOBS25226'])).campos.autoInfracao;
  assert.equal(intacto.valor, 'JOOBS25226');
  assert.equal(intacto.estado, 'claro');
});

test('M OCR 23 — descrição conserva sem/com, sem consulta a histórico', () => {
  const sem = OCR.analisar(dados(['Descrição CONDUZIR VEICULO SEM EQUIPAMENTO OBRIGATORIO'])).campos.descricao;
  const com = OCR.analisar(dados(['Descrição CONDUZIR VEICULO COM EQUIPAMENTO OBRIGATORIO'])).campos.descricao;
  assert.match(sem.valor, / sem /);
  assert.match(com.valor, / com /);
  assert.notEqual(sem.valor, com.valor);
  assert.equal(sem.estado, 'claro');
});

test('M OCR 24 — título verbal CDT é sugestão e cabeçalhos não são descrição', () => {
  const c = OCR.analisar(dados(['NOTIFICAÇÃO DE AUTUAÇÃO', 'DIRIGIR SEM POSSUIR CNH', 'Placa ABC1234'])).campos;
  assert.equal(c.descricao.valor, 'Dirigir sem possuir CNH');
  assert.equal(c.descricao.estado, 'revisar');
  assert.equal(OCR.analisar(dados(['Descrição', 'NOTIFICAÇÃO DE AUTUAÇÃO'])).campos.descricao.estado, 'naoEncontrado');
});

test('M OCR 25 — dois rótulos na mesma linha delimitam valores', () => {
  const c = OCR.analisar(dados(['Placa ABC1234 Auto de Infração H803798', 'Data/Hora do Cometimento da Infração 10/09/2026 14:37 Data da Notificação 20/09/2026']), { placas: ['ABC1234'] }).campos;
  assert.equal(c.placa.valor, 'ABC1234');
  assert.equal(c.autoInfracao.valor, 'H803798');
  assert.equal(c.dataInfracao.valor, '10/09/2026');
  assert.equal(c.dataNotificacao.valor, '20/09/2026');
  assert.equal(c.autoInfracao.estado, 'claro');
});

test('M OCR 26 — valores em duas colunas são associados pela posição', () => {
  const topLeft = linha('Auto de Infração', 20, 20), topRight = linha('Placa', 450, 20);
  const valueLeft = linha('H803798', 20, 52), valueRight = linha('ABC1234', 450, 52);
  const top = { text: topLeft.text + ' ' + topRight.text, words: [...topLeft.words, ...topRight.words], bbox: { x0: 20, y0: 20, x1: 490, y1: 38 } };
  const values = { text: valueLeft.text + ' ' + valueRight.text, words: [...valueLeft.words, ...valueRight.words], bbox: { x0: 20, y0: 52, x1: 506, y1: 70 } };
  const c = OCR.analisar(dados([top, values]), { placas: ['ABC1234'] }).campos;
  assert.equal(c.placa.valor, 'ABC1234');
  assert.equal(c.autoInfracao.valor, 'H803798');
  assert.equal(c.autoInfracao.estado, 'claro');
  assert.equal(c.autoInfracao.bbox.x0, 20);
  assert.equal(c.autoInfracao.bbox.x1, 76);
  assert.equal(c.placa.bbox.x0, 450);
});

test('M OCR 27 — rótulo vazio da coluna esquerda não toma valor da direita', () => {
  const c = OCR.analisar(dados([linha('Valor Original', 20, 20), linha('293,47', 450, 52), linha('Data da Infração', 20, 84)])).campos;
  assert.equal(c.valor.estado, 'naoEncontrado');
});

test('M OCR 28 — releitura mantém diagnóstico revisar e valores válidos para o chamador', () => {
  for (const [campo, text, valor] of [['placa', 'KDROE17', 'KDR0E17'], ['valor', 'R$ 195,23', '195.23'], ['dataInfracao', '10/09/2026', '10/09/2026']]) {
    const c = OCR.analisarRecorte(campo, dados([text]), { placas: ['KDR0E17'] });
    assert.equal(c.estado, 'revisar');
    assert.equal(c.valor, valor);
  }
  assert.equal(OCR.analisarRecorte('valor', dados(['Valor Original R$ 195,23'])).estado, 'revisar');
});

test('M OCR 29 — validação de edição manual e datas bissextas', () => {
  for (const [campo, value, valid] of [
    ['placa', 'ABC1234', true], ['placa', 'ABCABCD', false], ['dataInfracao', '29/02/2024', true],
    ['dataInfracao', '29/02/2026', false], ['dataInfracao', '00/09/2026', false], ['horaInfracao', '23:59', true],
    ['horaInfracao', '23:60', false], ['valor', '195.23', true], ['valor', '195,23', false], ['valor', '0', false],
    ['codigoInfracao', '5002-0', true], ['autoInfracao', 'H803798', true], ['cidadeEstado', 'Brasília/DF', true],
    ['cidadeEstado', 'Brasília/ZZ', false], ['descricao', 'NOTIFICAÇÃO DE AUTUAÇÃO', false], ['desconhecido', 'teste', false]
  ]) assert.equal(OCR.validar(campo, value), valid, campo + ': ' + value);
});

test('M OCR 30 — local corrigido e cidade inferida exigem revisão', () => {
  const c = OCR.analisar(dados(['Local da Infração DF - SAN OD 3 BLA - BRASILIA'])).campos;
  assert.equal(c.local.valor, 'DF - SAN QD 3 BL A - BRASILIA');
  assert.equal(c.local.estado, 'revisar');
  assert.equal(c.cidadeEstado.valor, 'Brasilia/DF');
  assert.equal(c.cidadeEstado.estado, 'revisar');
});

test('M OCR 31 — código do auto igual a uma placa nunca preenche placa sem rótulo', () => {
  const c = OCR.analisar(dados(['Auto de Infração ABC1234']), { placas: ['ABC1234'] }).campos;
  assert.equal(c.autoInfracao.estado, 'claro');
  assert.equal(c.placa.estado, 'naoEncontrado');
  assert.equal(c.placa.valor, '');
});

test('M OCR 32 — dinheiro malformado não é truncado e exige conferência', () => {
  for (const token of ['1.234.56', '195,2', '50']) {
    const c = OCR.analisar(dados(['Valor Original R$ ' + token])).campos.valor;
    assert.equal(c.estado, 'revisar', token);
    assert.equal(c.valor, token.replace(',', '.'), token);
    assert.notEqual(c.valor, '234.56');
  }
});

test('M OCR 33 — rótulo com conteúdo ilegível produz sugestão para correção', () => {
  const c = OCR.analisar(dados(['Data/Hora do Cometimento da Infração ??/??/???? ??', 'Valor Original R$ ?'])).campos;
  for (const campo of ['dataInfracao', 'horaInfracao', 'valor']) {
    assert.equal(c[campo].estado, 'revisar');
    assert.ok(c[campo].original);
    assert.match(c[campo].motivo, /não pôde ser interpretado/);
  }
});

test('M OCR 34 — placa incompleta ou ilegível também pode ser corrigida', () => {
  for (const text of ['ABC123', '???']) {
    const c = placa(text, ['ABC1234']);
    assert.equal(c.estado, 'revisar');
    assert.equal(c.original, text);
    assert.equal(c.frota, false);
    assert.match(c.motivo, /incompleta ou ilegível/);
  }
});

test('M OCR 35 — edição manual aceita formatos naturais sem inferir conteúdo', () => {
  for (const [campo, entrada, saida] of [
    ['placa', ' abc-1234 ', 'ABC1234'], ['placa', 'abc 1d23', 'ABC1D23'],
    ['valor', '195,23', '195.23'], ['valor', 'R$ 1.234,56', '1234.56'],
    ['valor', 'R$ 195,2', '195.2'], ['valor', '195.20', '195.20'], ['valor', 'R$ 195.23', '195.23'],
    ['autoInfracao', ' h 803798 ', 'H803798'], ['codigoInfracao', ' 5002 - 0 ', '5002-0'],
    ['descricao', '  Dirigir SEM possuir CNH  ', 'Dirigir SEM possuir CNH'],
    ['dataInfracao', '10/09/2026', '10/09/2026']
  ]) {
    assert.equal(OCR.normalizarEdicao(campo, entrada), saida, campo + ': ' + entrada);
    assert.equal(OCR.validar(campo, saida), true, saida);
  }
});

test('M OCR 36 — normalização manual não corrige caracteres ou formatos inválidos', () => {
  for (const [campo, entrada, saida] of [
    ['placa', 'kdroe17', 'KDROE17'], ['placa', 'ABC/1234', 'ABC/1234'],
    ['valor', 'R$ 1.234.56', 'R$ 1.234.56'], ['valor', '195,234', '195,234'], ['valor', '1.234', '1.234'],
    ['codigoInfracao', '5002 - O', '5002-O'], ['autoInfracao', 'noo?135790', 'NOO?135790'],
    ['dataInfracao', '10-09-2026', '10-09-2026'], ['horaInfracao', '1437', '1437']
  ]) {
    assert.equal(OCR.normalizarEdicao(campo, entrada), saida, campo + ': ' + entrada);
    assert.equal(OCR.validar(campo, saida), false, saida);
  }
});

test('M OCR 37 — data e hora só vêm do rótulo completo do cometimento', () => {
  const c = OCR.analisar(dados([
    'Data da Infração 01/01/2026', 'Hora da Infração 01:02', 'Cometimento 02/02/2026 02:03',
    'Data / Hora 03/03/2026 03:04', 'Data e Hora da Infração 04/04/2026 04:05'
  ])).campos;
  assert.equal(c.dataInfracao.estado, 'naoEncontrado');
  assert.equal(c.horaInfracao.estado, 'naoEncontrado');
});

test('M OCR 38 — rótulo completo consome todas as palavras e aceita valor na linha seguinte', () => {
  const c = OCR.analisar(dados([
    'Data da Notificação 20/09/2026', 'Data/Hora do Cometimento da Infração', '10/09/2026 14:37',
    'Data do Vencimento do Desconto 10/10/2026'
  ])).campos;
  assert.equal(c.dataInfracao.valor, '10/09/2026');
  assert.equal(c.horaInfracao.valor, '14:37');
  assert.equal(c.dataInfracao.original, '10/09/2026 14:37');
  assert.equal(c.dataInfracao.estado, 'claro');
  assert.equal(c.horaInfracao.estado, 'claro');
});

test('M OCR 39 — rótulo do cometimento quebrado em linhas conserva região e confiança', () => {
  for (const textos of [
    ['Data/Hora do Cometimento da', 'Infração 10/09/2026 14:37'],
    ['Data/Hora do', 'Cometimento da Infração', '10/09/2026 14:37'],
    ['Data / Hora', 'do Cometimento', 'da Infração', '10/09/2026 14:37']
  ]) {
    const c = OCR.analisar(dados(textos)).campos;
    assert.equal(c.dataInfracao.valor, '10/09/2026', textos.join(' | '));
    assert.equal(c.horaInfracao.valor, '14:37');
    assert.equal(c.dataInfracao.estado, 'claro');
    assert.equal(c.dataInfracao.confianca, 96);
    assert.ok(c.dataInfracao.bbox.y0 >= 52);
  }
  const plain = OCR.analisar({ text: 'Data/Hora do\nCometimento da Infração\n10/09/2026 14:37' }).campos;
  assert.equal(plain.dataInfracao.valor, '10/09/2026');
  assert.equal(plain.dataInfracao.estado, 'revisar');
});

test('M OCR 40 — notificação e vencimento antes ou depois não alteram o cometimento', () => {
  for (const textos of [
    ['Data da Notificação 20/09/2026', 'Data do Vencimento 10/10/2026', 'Data/Hora do Cometimento da Infração 10/09/2026 14:37'],
    ['Data/Hora do Cometimento da Infração 10/09/2026 14:37', 'Data da Notificação 20/09/2026', 'Data do Vencimento 10/10/2026'],
    ['Data da Infração 01/01/2026', 'Data/Hora do Cometimento da Infração 10/09/2026 14:37', 'Hora da Infração 01:02']
  ]) {
    const c = OCR.analisar(dados(textos)).campos;
    assert.equal(c.dataInfracao.valor, '10/09/2026');
    assert.equal(c.horaInfracao.valor, '14:37');
    assert.deepEqual(c.dataInfracao.alternativas, []);
    assert.deepEqual(c.horaInfracao.alternativas, []);
  }
});

test('M OCR 41 — rótulo completo sem valor não usa a notificação seguinte', () => {
  const c = OCR.analisar(dados(['Data/Hora do Cometimento da Infração', 'Data da Notificação 20/09/2026'])).campos;
  assert.equal(c.dataInfracao.estado, 'naoEncontrado');
  assert.equal(c.horaInfracao.estado, 'naoEncontrado');
  assert.equal(c.dataNotificacao.valor, '20/09/2026');
});

test('M OCR 42 — fragmentos em outra coluna não completam rótulo do cometimento', () => {
  const c = OCR.analisar(dados([
    linha('Data/Hora do Cometimento da', 20, 20), linha('Infração 10/09/2026 14:37', 450, 52)
  ])).campos;
  assert.equal(c.dataInfracao.estado, 'naoEncontrado');
  assert.equal(c.horaInfracao.estado, 'naoEncontrado');
});

test('M OCR 43 — placas múltiplas fora da Frota não oferecem primeiro valor, independentemente da ordem', () => {
  for (const frotaDisponivel of [false, true]) {
    const context = { placas: [], frotaDisponivel };
    const a = OCR.analisar({ text: 'Placa ABC1234\nPlaca XYZ5678' }, context).campos.placa;
    const b = OCR.analisar({ text: 'Placa XYZ5678\nPlaca ABC1234' }, context).campos.placa;
    assert.deepEqual(a, b);
    assert.equal(a.valor, '');
    assert.deepEqual(a.alternativas, ['ABC1234', 'XYZ5678']);
    assert.equal(a.estado, 'revisar');
    assert.match(a.motivo, /Mais de uma placa/);
  }
});

test('M OCR 44 — recorte de ambiguidade inclui ambas as placas para não selecionar uma na releitura', () => {
  const r = OCR.analisar(dados(['Placa ABC1234', 'Placa XYZ5678']), { placas: [] }).campos.placa;
  assert.equal(r.valor, '');
  assert.equal(r.bbox.y0, 20);
  assert.equal(r.bbox.y1, 70);
  assert.equal(r.original, 'ABC1234 | XYZ5678');
  const registrado = OCR.analisar(dados(['Placa ABC1234', 'Placa XYZ5678']), { placas: ['ABC1234', 'XYZ5678'] }).campos.placa;
  assert.equal(registrado.valor, '');
  assert.equal(registrado.bbox.y1, 70);
  assert.equal(registrado.original, 'ABC1234 | XYZ5678');
});

test('M OCR 45 — auto na linha seguinte também não fornece placa por fallback', () => {
  for (const data of [dados(['Auto de Infração', 'ABC1234']), { text: 'Auto de Infração\nABC1234' }]) {
    const c = OCR.analisar(data, { placas: ['ABC1234'] }).campos;
    assert.equal(c.autoInfracao.valor, 'ABC1234');
    assert.equal(c.placa.estado, 'naoEncontrado');
    assert.equal(c.placa.valor, '');
  }
});

test('M OCR 46 — token independente realmente sem rótulo continua inferível', () => {
  const c = OCR.analisar(dados(['ABC1234']), { placas: ['ABC1234'] }).campos.placa;
  assert.equal(c.valor, 'ABC1234');
  assert.equal(c.frota, true);
  assert.equal(c.estado, 'revisar');
  assert.match(c.motivo, /sem rótulo/);
});

test('M OCR 47 — valores de rótulos auxiliares não viram placa na mesma linha ou na seguinte', () => {
  for (const textos of [['Modelo ABC1234'], ['Modelo', 'ABC1234'], ['Renainf ABC1234'], ['Renainf', 'ABC1234']]) {
    const c = OCR.analisar(dados(textos), { placas: ['ABC1234'] }).campos.placa;
    assert.equal(c.estado, 'naoEncontrado', textos.join(' | '));
    assert.equal(c.valor, '');
  }
});

test('M OCR 48 — token livre separado de auto continua candidato independente', () => {
  const c = OCR.analisar(dados(['Auto de Infração', 'ABC1234', 'XYZ5678']), { placas: ['ABC1234', 'XYZ5678'] }).campos;
  assert.equal(c.autoInfracao.valor, 'ABC1234');
  assert.equal(c.placa.valor, 'XYZ5678');
  assert.deepEqual(c.placa.alternativas, []);
});

test('M OCR 49 — rótulos aparentes na prosa não truncam descrição inline ou na linha seguinte', () => {
  for (const descricao of [
    'TRANSITAR NA FAIXA EXCLUSIVA PARA TRANSPORTE COLETIVO',
    'TRANSITAR NA FAIXA 2 DA PISTA',
    'CONDUZIR VEICULO COM PLACA ABC1234 ILEGIVEL',
    'DEIXAR CONDUTOR OU PASSAGEIRO DE USAR O CINTO DE SEGURANCA',
    'CONDUZIR VEICULO DO MODELO FORA DAS ESPECIFICACOES DO FABRICANTE'
  ]) for (const textos of [['Descrição da infração: ' + descricao, 'Placa XYZ5678'], ['Descrição', descricao, 'Placa XYZ5678']]) {
    for (const input of [dados(textos), { text: textos.join('\n') }]) {
      const c = OCR.analisar(input, { placas: ['ABC1234', 'XYZ5678'] }).campos;
      assert.equal(c.descricao.valor.toUpperCase(), descricao, textos.join(' | '));
      assert.equal(c.placa.valor, 'XYZ5678');
      assert.deepEqual(c.descricao.alternativas, []);
    }
  }
});

test('M OCR 50 — título CDT reconhece verbos, bullets e preserva o original', () => {
  for (const titulo of [
    '• RECUSAR-SE A SER SUBMETIDO A TESTE QUE PERMITA CERTIFICAR INFLUENCIA DE ALCOOL',
    '— DESOBEDECER AS ORDENS EMANADAS DA AUTORIDADE COMPETENTE',
    'IMPEDIR A PASSAGEM DE VEICULO DE EMERGENCIA',
    'BLOQUEAR A VIA COM VEICULO'
  ]) for (const input of [dados([titulo, 'Placa ABC1234']), { text: titulo + '\nPlaca ABC1234' }]) {
    const c = OCR.analisar(input).campos.descricao;
    assert.ok(OCR.validar('descricao', c.valor), titulo);
    assert.equal(c.valor.toUpperCase(), titulo.replace(/^[•—]\s*/, ''));
    assert.equal(c.original, titulo);
    assert.equal(c.estado, 'revisar');
  }
  assert.equal(OCR.analisar({ text: 'SE RECUSAR A TESTE' }).campos.descricao.estado, 'naoEncontrado');
  assert.equal(OCR.analisar({ text: 'AO DIRIGIR O VEICULO' }).campos.descricao.estado, 'naoEncontrado');
});

test('M OCR 51 — título CDT multilinha em texto simples e OCR posicionado é completo', () => {
  const textos = ['RECUSAR-SE A SER SUBMETIDO A TESTE QUE', '• PERMITA CERTIFICAR INFLUENCIA DE ALCOOL', 'OU OUTRA SUBSTANCIA PSICOATIVA', 'Placa ABC1234'];
  for (const input of [dados(textos), { text: textos.join('\n') }]) {
    const c = OCR.analisar(input).campos.descricao;
    assert.equal(c.valor, 'Recusar-se a ser submetido a teste que permita certificar influencia de alcool ou outra substancia psicoativa');
    assert.match(c.original, /• PERMITA/);
    assert.equal(c.estado, 'revisar');
  }
});

test('M OCR 52 — descrição da infração quebrada consome somente seu rótulo completo', () => {
  for (const textos of [
    ['Descrição', 'da infração:', 'TRANSITAR NA FAIXA EXCLUSIVA', 'Placa ABC1234'],
    ['Descrição da', 'infração:', 'DEIXAR CONDUTOR OU PASSAGEIRO DE USAR O CINTO', 'Placa ABC1234'],
    ['Descrição de', 'infração CONDUZIR VEICULO COM PLACA ILEGIVEL', 'Placa ABC1234']
  ]) for (const input of [dados(textos), { text: textos.join('\n') }]) {
    const c = OCR.analisar(input).campos.descricao;
    assert.match(c.valor, /^(Transitar|Deixar|Conduzir) /);
    assert.doesNotMatch(c.original, /^da infração|^infração/i);
    assert.deepEqual(c.alternativas, []);
  }
  const c = OCR.analisar(dados(['Descrição', linha('da infração:', 450, 52), linha('DIRIGIR SEM CNH', 20, 84), linha('Placa ABC1234', 20, 116)])).campos.descricao;
  assert.equal(c.valor, 'Dirigir sem CNH');
  assert.doesNotMatch(c.original, /da infração/i);
});

test('M OCR 53 — descrições mobile longas não param no limite antigo de quatro linhas', () => {
  const textos = ['Descrição', 'CONDUZIR VEICULO SEM', 'EQUIPAMENTO OBRIGATORIO', 'OU ESTANDO ESTE', 'INEFICIENTE OU INOPERANTE', 'EM DESACORDO COM', 'O ESTABELECIDO PELO CONTRAN', 'Valor Original R$ 195,23'];
  for (const input of [dados(textos), { text: textos.join('\n') }]) {
    const c = OCR.analisar(input).campos;
    assert.equal(c.descricao.valor, 'Conduzir veiculo sem equipamento obrigatorio ou estando este ineficiente ou inoperante em desacordo com o estabelecido pelo CONTRAN');
    assert.equal(c.valor.valor, '195.23');
    assert.doesNotMatch(c.descricao.original, /Valor Original/);
  }
});

test('M OCR 54 — metadados reais sem dois-pontos encerram descrição sem sumir do formulário', () => {
  for (const input of [dados([
    'Descrição: TRANSITAR NA FAIXA EXCLUSIVA', 'Municipio SAO PAULO/SP', 'Placa ABC1234',
    'Local da infração', 'RUA X'
  ]), { text: 'Descrição: TRANSITAR NA FAIXA EXCLUSIVA\nMunicipio SAO PAULO/SP\nPlaca ABC1234\nLocal da infração\nRUA X' }]) {
    const c = OCR.analisar(input).campos;
    assert.equal(c.descricao.valor, 'Transitar na faixa exclusiva');
    assert.equal(c.cidadeEstado.valor, 'Sao Paulo/SP');
    assert.equal(c.local.valor, 'RUA X');
    assert.equal(c.placa.valor, 'ABC1234');
  }
  for (const textos of [
    ['Descrição', 'DIRIGIR SEM CNH', 'Placa', 'ABC1234'],
    ['Descrição', 'DIRIGIR SEM CNH', 'Local da infração', 'RUA X'],
    ['Descrição TRANSITAR NA FAIXA EXCLUSIVA Placa ABC1234 Valor Original 195,23']
  ]) {
    const c = OCR.analisar(dados(textos)).campos;
    assert.doesNotMatch(c.descricao.valor, /ABC1234|RUA X|195,23/);
    assert.equal(c.descricao.valor, textos[0].includes('TRANSITAR') ? 'Transitar na faixa exclusiva' : 'Dirigir sem CNH');
  }
});

test('M OCR 55 — placa citada em prosa entre linhas não produz campo placa', () => {
  for (const titulo of ['Descrição: CONDUZIR VEICULO COM', 'CONDUZIR VEICULO COM']) {
    const textos = [titulo, 'PLACA ABC1234 ILEGIVEL', 'NA FAIXA 2 DA PISTA', 'Valor Original 195,23'];
    for (const input of [dados(textos), { text: textos.join('\n') }]) {
      const c = OCR.analisar(input, { placas: ['ABC1234'] }).campos;
      assert.equal(c.descricao.valor, 'Conduzir veiculo com placa abc1234 ilegivel na faixa 2 da pista');
      assert.equal(c.placa.estado, 'naoEncontrado');
      assert.equal(c.valor.valor, '195.23');
    }
  }
});

test('M OCR 56 — descrições em duas colunas não engolem cabeçalhos, valores ou rótulos vizinhos', () => {
  const left = linha('Descrição', 20, 20), right = linha('Valor Original', 650, 20);
  const top = { text: left.text + ' ' + right.text, words: [...left.words, ...right.words], bbox: { x0: 20, y0: 20, x1: 770, y1: 38 } };
  const d1 = linha('TRANSITAR NA FAIXA', 20, 52), v1 = linha('195,23', 650, 52);
  const d2 = linha('EXCLUSIVA PARA ONIBUS', 20, 84), other = linha('Placa ABC1234', 650, 84);
  // USO: row(d1,v1) simula duas colunas reconhecidas pelo Tesseract na mesma linha.
  const row = (a, b) => ({ text: a.text + ' ' + b.text, words: [...a.words, ...b.words], bbox: { x0: 20, y0: a.bbox.y0, x1: b.bbox.x1, y1: a.bbox.y1 } });
  const c = OCR.analisar(dados([top, row(d1, v1), row(d2, other), linha('Local da infração RUA X', 20, 116)])).campos;
  assert.equal(c.descricao.valor, 'Transitar na faixa exclusiva para onibus');
  assert.equal(c.valor.valor, '195.23');
  assert.equal(c.placa.valor, 'ABC1234');
  assert.ok(c.descricao.bbox.x1 < 650);
  assert.equal(c.descricao.bbox.y1, 102);
});

test('M OCR 57 — cabeçalhos administrativos e bloco distante não prolongam descrição', () => {
  for (const heading of ['CARTEIRA DIGITAL DE TRÂNSITO', 'SENATRAN', 'DADOS DO VEÍCULO', 'NOTIFICAÇÃO DE AUTUAÇÃO', 'IDENTIFICAÇÃO DO VEÍCULO']) {
    const c = OCR.analisar(dados(['Descrição DIRIGIR SEM CNH', heading, 'OUTRO TEXTO ADMINISTRATIVO'])).campos.descricao;
    assert.equal(c.valor, 'Dirigir sem CNH', heading);
  }
  const c = OCR.analisar(dados([linha('Descrição DIRIGIR SEM CNH', 20, 20), linha('TEXTO MUITO DISTANTE', 20, 200)])).campos.descricao;
  assert.equal(c.valor, 'Dirigir sem CNH');
});

test('M OCR 58 — duplicatas só com acento, caixa e pontuação superficial não viram ambiguidade', () => {
  const a = 'Descrição CONDUZIR VEÍCULO SEM POSSUIR CNH.', b = 'Descrição conduzir veiculo, sem possuir CNH';
  for (const textos of [[a, b], [b, a]]) {
    const c = OCR.analisar(dados(textos)).campos.descricao;
    assert.equal(c.valor, 'Conduzir veículo sem possuir CNH.');
    assert.deepEqual(c.alternativas, []);
    assert.equal(c.estado, 'claro');
  }
});

test('M OCR 59 — sem/com, números e percentuais diferentes conservam ambiguidade real', () => {
  for (const textos of [
    ['Descrição CONDUZIR VEÍCULO SEM EQUIPAMENTO OBRIGATÓRIO', 'Descrição CONDUZIR VEICULO COM EQUIPAMENTO OBRIGATORIO'],
    ['Descrição TRANSITAR EM VELOCIDADE SUPERIOR EM 20%', 'Descrição TRANSITAR EM VELOCIDADE SUPERIOR EM 50%'],
    ['Descrição TRANSITAR EM VELOCIDADE SUPERIOR EM 20%', 'Descrição TRANSITAR EM VELOCIDADE SUPERIOR EM 20']
  ]) for (const list of [textos, [...textos].reverse()]) {
    const c = OCR.analisar(dados(list)).campos.descricao;
    assert.equal(c.valor, '');
    assert.equal(c.estado, 'revisar');
    assert.equal(c.alternativas.length, 2);
  }
});

test('M OCR 60 — releitura da descrição mantém prosa, multiline e ambiguidade real', () => {
  const c = OCR.analisarRecorte('descricao', { text: '• RECUSAR-SE A TESTE QUE\n• PERMITA CERTIFICAR INFLUENCIA DE ALCOOL' });
  assert.equal(c.valor, 'Recusar-se a teste que permita certificar influencia de alcool');
  assert.match(c.original, /•/);
  assert.equal(c.estado, 'revisar');
  const ambiguous = OCR.analisarRecorte('descricao', dados(['Descrição CONDUZIR SEM CNH', 'Descrição CONDUZIR COM CNH']));
  assert.equal(ambiguous.valor, '');
  assert.equal(ambiguous.alternativas.length, 2);
});

test('M OCR 61 — auxiliares reais UF, Marca/Modelo e Renavam encerram descrição', () => {
  for (const extras of [['UF SP'], ['Marca/Modelo', 'FIAT FICTICIO'], ['Renavam 123456789'], ['Renainf', '123456789']]) {
    const textos = ['Descrição: DIRIGIR SEM CNH', ...extras, 'Placa ABC1234'];
    for (const input of [dados(textos), { text: textos.join('\n') }]) {
      const c = OCR.analisar(input).campos;
      assert.equal(c.descricao.valor, 'Dirigir sem CNH', extras.join(' | '));
      assert.equal(c.placa.valor, 'ABC1234');
    }
  }
});

test('M OCR 62 — pontuação isolada após rótulo não impede descrição na linha seguinte', () => {
  const textos = ['Descrição da infração: ,', 'TRANSITAR COM O VEICULO NA FAIXA OU VIA DE', 'TRANSITO EXCLUSIVO PARA TRANSPORTE PUBLICO COLETIVO', 'Data/Hora do Cometimento da Infração: 05/10/2026 10:25'];
  for (const input of [dados(textos), { text: textos.join('\n') }]) {
    const c = OCR.analisar(input).campos;
    assert.equal(c.descricao.valor, 'Transitar com o veiculo na faixa ou via de transito exclusivo para transporte publico coletivo');
    assert.equal(c.dataInfracao.valor, '05/10/2026');
    assert.doesNotMatch(c.descricao.original, /^,/);
  }
});

test('M OCR 63 — rótulo de descrição quebrado em duas colunas preserva ambos os campos', () => {
  const c = OCR.analisar(dados([
    colunas(linha('Descrição da', 20, 20), linha('Órgão autuador:', 650, 20)),
    colunas(linha('infração:', 20, 52), linha('000300 - DETRAN FICTICIO', 650, 52)),
    linha('PERMITIR QUE CONDUTOR NAO HABILITADO', 20, 84),
    colunas(linha('CONDUZA VEICULO AUTOMOTOR', 20, 116), linha('Data da notificação:', 650, 116)),
    linha('06/10/2026', 650, 148),
    linha('Placa ABC1234', 20, 180)
  ])).campos;
  assert.equal(c.descricao.valor, 'Permitir que condutor nao habilitado conduza veiculo automotor');
  assert.equal(c.descricao.estado, 'claro');
  assert.ok(c.descricao.bbox.x1 < 650);
  assert.equal(c.orgaoAutuador.valor, '000300 - DETRAN FICTICIO');
  assert.equal(c.dataNotificacao.valor, '06/10/2026');
  assert.equal(c.placa.valor, 'ABC1234');
});

test('M OCR 64 — rótulo da direita não bloqueia data/hora da esquerda abaixo do rótulo', () => {
  const c = OCR.analisar(dados([
    linha('Data/Hora do Cometimento da Infração:', 20, 20),
    colunas(linha('05/10/2026 10:25', 20, 52), linha('Data de vencimento:', 650, 52)),
    linha('05/11/2026', 650, 84), linha('Valor Original 195,23', 20, 116)
  ])).campos;
  assert.equal(c.dataInfracao.valor, '05/10/2026');
  assert.equal(c.horaInfracao.valor, '10:25');
  assert.equal(c.dataInfracao.original, '05/10/2026 10:25');
  assert.equal(c.dataVencimento.valor, '05/11/2026');
});

test('M OCR 65 — fragmentos puros do rótulo não podem ser descrições válidas', () => {
  for (const text of ['Da infração:', 'De infração', 'Infração', 'Descrição da', 'Descrição da infração', 'Descrição de infração:']) {
    assert.equal(OCR.validar('descricao', text), false, text);
    const c = OCR.analisarRecorte('descricao', { text });
    assert.equal(OCR.validar('descricao', c.valor), false, text);
  }
  assert.equal(OCR.validar('descricao', 'VEICULO EM DESACORDO COM AS ESPECIFICACOES'), true);
  const c = OCR.analisar({ text: 'Descrição da Órgão autuador:\ninfração: 000300 - DETRAN FICTÍCIO' }).campos.descricao;
  assert.equal(OCR.validar('descricao', c.valor), false);
  assert.notEqual(c.estado, 'claro');
});

// Portal da SENATRAN (Carteira Digital / gov.br): ícone antes do título e da placa, tabela com a
// coluna cinza dos rótulos à esquerda e os valores numa segunda coluna, na mesma linha.
// USO: tabelaSenatran([['Órgão Autuador', '225310 - PREF. DE PE RECIFE'], ['', 'continuação']], 140)
//      → linhas OCR com rótulo em x=30 e valor em x=560, uma linha da tabela a cada 32 px.
function tabelaSenatran(linhas, y0 = 100) {
  return linhas.map(([rotulo, valor], i) => {
    const y = y0 + i * 32;
    if (!rotulo) return linha(valor, 560, y);
    return valor ? colunas(linha(rotulo, 30, y), linha(valor, 560, y)) : linha(rotulo, 30, y);
  });
}
// USO: simbolos(palavra, [['S', 560, 575], ['O', 575, 585, 96], ...]) → a palavra com as caixas
//      de cada símbolo, como o Tesseract 5 devolve em blocks (texto, x0, x1, confiança).
function simbolos(palavra, lista) {
  palavra.symbols = lista.map(([text, x0, x1, confidence = 99]) => ({ text, confidence, bbox: { x0, y0: palavra.bbox.y0, x1, y1: palavra.bbox.y1 } }));
  return palavra;
}

test('M OCR 66 — título da SENATRAN com o ícone lido como "B" preenche a descrição sem o ícone', () => {
  for (const [titulo, esperado] of [
    ['B TRANSITAR EM VELOCIDADE SUPERIOR A MAXIMA PERMITIDA EM ATÉ 20%', 'Transitar em velocidade superior a maxima permitida em até 20%'],
    ['B ESTACIONAR EM LOCAL/HORARIO PROIBIDO ESPECIFICAMENTE PELA SINALIZACAO', 'Estacionar em local/horario proibido especificamente pela sinalizacao'],
    ['É CONDUZIR O VEÍCULO SEM CNH', 'Conduzir o veículo sem CNH'],
  ]) {
    const c = OCR.analisar(dados([linha(titulo, 24, 30), linha('Placa à época da infração: QKH5G52', 24, 90),
      ...tabelaSenatran([['Órgão Autuador', '225310 - PREF. DE PE RECIFE']], 150)])).campos;
    assert.equal(c.descricao.valor, esperado, titulo);
    assert.equal(c.placa.valor, 'QKH5G52');
  }
  // Palavra curta de verdade no começo da linha seguinte continua a frase (não é ícone).
  const c = OCR.analisar(dados([linha('RECUSAR-SE', 24, 30), linha('A REALIZAR TESTE DE ALCOOLEMIA', 24, 56), linha('Placa ABC1234', 24, 110)])).campos;
  assert.equal(c.descricao.valor, 'Recusar-se a realizar teste de alcoolemia');
});

test('M OCR 67 — tabela da SENATRAN: o órgão é só a primeira linha e o local quebrado continua inteiro', () => {
  const c = OCR.analisar(dados([
    linha('B ESTACIONAR EM LOCAL/HORARIO PROIBIDO ESPECIFICAMENTE PELA SINALIZACAO', 24, 30),
    linha('Placa à época da infração: QKH5G52', 24, 64),
    ...tabelaSenatran([
      ['Órgão Autuador', '225310 - PREF. DE PE RECIFE'],
      ['Órgão Competente/Responsável', '225310 - PREF. DE PE RECIFE'],
      ['Local da Infração', 'RUA DES LULA CARDOSO AYRES ELEVADO NA INFRAERO,'],
      ['', 'AO LADO PORTAO B4 - RECIFE'],
      ['Data/Hora do Cometimento da Infração', '18/09/2026 09:15'],
      ['Número do Auto de Infração', 'OD00513104'],
      ['Código da Infração', '5550 - 0'],
      ['Número RENAINF', '11661729657'],
      ['Valor Original', 'R$ 130,16'],
      ['Data da Notificação de Autuação', '25/09/2026'],
      ['Data Limite para Interposição de Defesa Prévia', '12/11/2026'],
      ['Data Limite para Identificação do Condutor Infrator', '12/11/2026'],
    ]),
  ])).campos;
  assert.equal(c.orgaoAutuador.valor, '225310 - PREF. DE PE RECIFE');
  assert.equal(c.local.valor, 'RUA DES LULA CARDOSO AYRES ELEVADO NA INFRAERO, AO LADO PORTAO B4 - RECIFE');
  assert.equal(c.cidadeEstado.valor, 'Recife/PE');
  assert.equal(c.autoInfracao.valor, 'OD00513104');
  assert.equal(c.codigoInfracao.valor, '5550-0');
  assert.equal(c.valor.valor, '130.16');
  assert.equal(c.dataInfracao.valor, '18/09/2026');
  assert.equal(c.horaInfracao.valor, '09:15');
  assert.equal(c.dataNotificacao.valor, '25/09/2026');
  assert.equal(c.dataVencimento.estado, 'naoEncontrado', 'data limite não é vencimento');
});

test('M OCR 68 — caractere da fonte do portal lido como dois símbolos sai uma vez só', () => {
  // "S051576253": o zero saiu como "O" (x 575–585) quase em cima do "0" (x 576–592).
  const auto1 = linha('SO051576253', 560, 100);
  simbolos(auto1.words[0], [['S', 560, 575], ['O', 575, 585, 96], ['0', 576, 592, 95], ['5', 595, 607], ['1', 609, 620], ['5', 621, 633],
    ['7', 635, 648], ['6', 649, 663], ['2', 665, 678], ['5', 681, 694], ['3', 696, 709]]);
  // "OD00513104": o 5 saiu como um "S" estreito (7 px, confiança 87) colado no "5".
  const auto2 = linha('ODOOS513104', 560, 100);
  simbolos(auto2.words[0], [['O', 560, 578], ['D', 581, 597], ['O', 598, 615], ['O', 616, 632], ['S', 628, 635, 87], ['5', 634, 647],
    ['1', 648, 659], ['3', 660, 673], ['1', 675, 685], ['0', 686, 702], ['4', 704, 717]]);
  // Zeros de verdade ficam lado a lado, sem sobreposição: nada sai.
  const auto3 = linha('A1000234', 560, 100);
  simbolos(auto3.words[0], [['A', 560, 576], ['1', 578, 588], ['0', 590, 606], ['0', 608, 624], ['0', 626, 642], ['2', 644, 657], ['3', 659, 672], ['4', 674, 687]]);
  // "OD00512345" (avaliação senatran-tabela): um "O" de 9 px entre o D e o 0, encostado nos dois.
  const auto4 = linha('ODO00512345', 560, 100);
  simbolos(auto4.words[0], [['O', 908, 928], ['D', 930, 947], ['O', 943, 952, 91], ['0', 949, 964, 88], ['0', 966, 981, 96], ['5', 982, 996],
    ['1', 992, 1008], ['2', 997, 1022], ['3', 1021, 1036], ['4', 1023, 1052], ['5', 1054, 1067]]);
  for (const [palavra, esperado] of [[auto1, 'S051576253'], [auto2, 'OD00513104'], [auto3, 'A1000234'], [auto4, 'OD00512345']]) {
    const c = OCR.analisar(dados([colunas(linha('Número do Auto de Infração', 30, 100), palavra)])).campos;
    assert.equal(c.autoInfracao.valor, esperado);
  }
  // Sem símbolos (texto puro), a regra antiga do O→0 depois do prefixo continua valendo.
  assert.equal(OCR.analisar({ text: 'Número do Auto de Infração NO02630635' }).campos.autoInfracao.valor, 'N002630635');
  // Placa: o "1" lido como "1I" (I sobreposto) chega limpo, mesmo sem a Frota.
  const pl = linha('KDROE1I7', 560, 100);
  simbolos(pl.words[0], [['K', 560, 575], ['D', 577, 592], ['R', 594, 609], ['O', 611, 629], ['E', 631, 646], ['1', 648, 658], ['I', 650, 656, 80], ['7', 660, 675]]);
  const p = OCR.analisar(dados([colunas(linha('Placa à época da infração:', 30, 100), pl)]), { placas: [], frotaDisponivel: true }).campos.placa;
  assert.equal(p.valor, 'KDR0E17');
});

test('M OCR 69 — cidade sai em formato de nome, com a UF em maiúsculas', () => {
  const c = OCR.analisar(dados(['Cidade/UF: SÃO JOSÉ DOS CAMPOS/SP'])).campos;
  assert.equal(c.cidadeEstado.valor, 'São José dos Campos/SP');
  const inferida = OCR.analisar(dados(tabelaSenatran([['Local da Infração', 'BR235 KM 1,230 - ARACAJU']]))).campos;
  assert.equal(inferida.cidadeEstado.valor, 'Aracaju');
});
