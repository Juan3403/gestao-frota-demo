/**
 * Auditoria ESTÁTICA do redimensionamento de colunas (estilo Excel) — não sobe servidor nem
 * navegador, só lê os arquivos e trava as amarras que fazem o recurso ser GLOBAL e inofensivo:
 *
 *   1. O CSS novo (design-system/10-tabela-resize.css) está referenciado no index.html — sem o
 *      <link>, o cursor da divisória e o modo `.ds-tabela-redim` somem em silêncio.
 *   2. TODO o CSS vive dentro de `@media (min-width: 768px)`: no celular as tabelas viram
 *      cartões (design-mobile.css) e não existe divisória — regra do projeto: mobile intocado.
 *   3. As classes do contrato JS↔CSS existem nos DOIS lados (.ds-col-borda, .ds-tabela-redim,
 *      .ds-redimensionando): renomear num lado só quebraria o recurso sem nenhum erro visível.
 *   4. As constantes de limite (COLW_MIN/COLW_MAX/COLW_ZONA_PX) e o prefixo de persistência
 *      `colw-` continuam no app.js — o prefixo é contrato com o localStorage dos usuários:
 *      mudá-lo descartaria as larguras já salvas de todo mundo.
 *
 * As regras gerais do CSS (sem !important, sem cor literal, sem #id de módulo) já são cobertas
 * pelo design-system.test.js, que descobre o arquivo por glob — não são repetidas aqui.
 *
 * Rodar: npm test (node --test descobre este arquivo automaticamente)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const CSS = fs.readFileSync(path.join(RAIZ, 'frontend', 'design-system', '10-tabela-resize.css'), 'utf8');
const HTML = fs.readFileSync(path.join(RAIZ, 'frontend', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(RAIZ, 'frontend', 'app.js'), 'utf8');

function semComentarios(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

test('tabela-resize: o CSS está linkado no index.html', () => {
  assert.ok(/design-system\/10-tabela-resize\.css\?v=/.test(HTML),
    'index.html deve carregar /design-system/10-tabela-resize.css com cache-buster ?v=');
});

test('tabela-resize: todo o CSS fica sob @media (min-width: 768px) — mobile intocado', () => {
  const limpo = semComentarios(CSS).trim();
  assert.ok(limpo.startsWith('@media (min-width: 768px)'),
    'o arquivo deve começar pelo @media de desktop');
  // nada de regra FORA do bloco: depois de fechar o último }, só sobra espaço em branco
  const abre = limpo.indexOf('{');
  let nivel = 0, fim = -1;
  for (let i = abre; i < limpo.length; i++) {
    if (limpo[i] === '{') nivel++;
    else if (limpo[i] === '}') { nivel--; if (nivel === 0) { fim = i; break; } }
  }
  assert.ok(fim > 0 && limpo.slice(fim + 1).trim() === '',
    'nenhuma regra pode ficar fora do @media (min-width: 768px)');
});

test('tabela-resize: contrato de classes existe no CSS e no app.js', () => {
  for (const classe of ['ds-col-borda', 'ds-col-redimensionando', 'ds-tabela-redim', 'ds-redimensionando', 'v2-colw-reset']) {
    assert.ok(CSS.includes('.' + classe), `10-tabela-resize.css deve estilizar .${classe}`);
    assert.ok(APP.includes(classe), `app.js deve usar a classe ${classe}`);
  }
  assert.ok(/cursor:\s*col-resize/.test(CSS), 'a divisória deve mostrar o cursor col-resize');
  assert.ok(/table-layout:\s*fixed/.test(CSS), '.ds-tabela-redim deve usar table-layout: fixed');
  assert.ok(CSS.includes('th:not([colspan])::after'),
    'a divisória PERMANENTE do cabeçalho (::after em todo th folha, sem depender de hover) não pode sumir');
});

test('tabela-resize: limites e persistência continuam no app.js', () => {
  assert.ok(/const COLW_MIN = \d+/.test(APP), 'COLW_MIN deve existir (largura mínima configurável)');
  assert.ok(/const COLW_MAX = \d+/.test(APP), 'COLW_MAX deve existir (largura máxima configurável)');
  assert.ok(/const COLW_ZONA_PX = \d+/.test(APP), 'COLW_ZONA_PX deve existir (zona da divisória)');
  assert.ok(APP.includes("'colw-'"), "o prefixo de chave 'colw-' é contrato com o localStorage dos usuários");
  assert.ok(APP.includes('colgroup'), 'as larguras devem morar num <colgroup> (sobrevive ao innerHTML dos render*)');
});
