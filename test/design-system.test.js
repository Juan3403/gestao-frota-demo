/**
 * Auditoria ESTÁTICA do Design System — não sobe servidor nem navegador, só lê os arquivos CSS
 * e verifica as regras que valem para qualquer módulo migrado (ver CLAUDE.md e os docstrings
 * dos próprios arquivos):
 *
 *   1. Nenhum `!important` (a ponte de tokens em 02-themes.css é o que evita precisar disso) —
 *      vale para o Design System genérico E para as camadas por módulo (design-v2.css,
 *      design-manutencao.css...): "não usar !important" é regra do projeto, não só do DS.
 *   2. Nenhuma cor literal (hex/rgb/hsl/nomeada) fora de 01-tokens.css, que é o único arquivo
 *      autorizado a ter valor bruto — todo o resto, genérico ou por módulo, só consome
 *      var(--ds-*).
 *   3. Nenhum seletor do Design System GENÉRICO (frontend/design-system/) referenciando o ID de
 *      um módulo específico (#frota, #multas...) — quem pode fazer isso é a camada do PRÓPRIO
 *      módulo (frontend/design-v2.css, design-manutencao.css...), nunca o DS genérico.
 *
 * Comentários são ignorados nas três checagens: o histórico de decisão costuma citar hex
 * antigos ("era #dbeafe, virou token") e nomes de módulo ("achado ao migrar Rastreadores") como
 * documentação, o que é diferente de um SELETOR ou VALOR real usar isso.
 *
 * Rodar: npm test (node --test descobre este arquivo automaticamente)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const DIR_FRONTEND = path.join(RAIZ, 'frontend');
const DIR_DS = path.join(DIR_FRONTEND, 'design-system');
const ARQUIVOS_DS = fs.readdirSync(DIR_DS).filter((f) => f.endsWith('.css')).sort().map((f) => path.join(DIR_DS, f));
// Camadas POR MÓDULO na raiz de frontend/ (design-v2.css = Frota, design-manutencao.css =
// Manutenção...): têm o mesmo nome de arquivo do padrão `design-<modulo>.css`, exceto o piloto
// original da Frota, que manteve o nome histórico `design-v2.css`. Descobertas por padrão, não
// por lista fixa — uma camada nova já entra na checagem sem precisar editar este teste.
const ARQUIVOS_MODULO = fs.readdirSync(DIR_FRONTEND).filter((f) => /^design-.*\.css$/.test(f)).sort().map((f) => path.join(DIR_FRONTEND, f));
const ARQUIVO_PRIMITIVOS = path.join(DIR_DS, '01-tokens.css'); // único autorizado a ter cor literal

function semComentarios(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}
function ler(caminho) {
  return fs.readFileSync(caminho, 'utf8');
}

test('design-system: nenhum arquivo (genérico ou por módulo) tem !important', () => {
  for (const arquivo of [...ARQUIVOS_DS, ...ARQUIVOS_MODULO]) {
    const limpo = semComentarios(ler(arquivo));
    assert.ok(!/!important/i.test(limpo), `${path.basename(arquivo)} não pode ter !important (a ponte de tokens existe para evitar isso)`);
  }
});

test('design-system: nenhuma cor literal fora de 01-tokens.css', () => {
  // hex, rgb()/rgba(), hsl()/hsla() — nomes de cor (white/black/red...) ficam de fora de
  // propósito: são raros o bastante no CSS legítimo (ex.: `currentColor`, `transparent`) para
  // o regex de hex/rgb/hsl já pegar o problema real sem gerar falso positivo em toda parte.
  const PADRAO_COR = /#[0-9a-fA-F]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\(/;
  for (const arquivo of [...ARQUIVOS_DS, ...ARQUIVOS_MODULO]) {
    if (arquivo === ARQUIVO_PRIMITIVOS) continue;
    const limpo = semComentarios(ler(arquivo));
    const achado = limpo.match(PADRAO_COR);
    assert.ok(!achado, `${path.basename(arquivo)} tem cor literal (${achado?.[0]}) — deveria consumir var(--ds-*)`);
  }
});

test('design-system: nenhum seletor do DS genérico conhece o ID de um módulo específico', () => {
  // A lista de módulos vem do próprio index.html (cada `<section id="...">` de view), não de
  // uma lista fixa aqui — um módulo novo já entra na checagem sem precisar editar este teste.
  // Só o DS GENÉRICO (frontend/design-system/) é checado: as camadas por módulo (ARQUIVOS_MODULO)
  // existem exatamente para referenciar o ID do próprio módulo, isso é o trabalho delas.
  const html = fs.readFileSync(path.join(DIR_FRONTEND, 'index.html'), 'utf8');
  const ids = [...html.matchAll(/<section id="([a-z0-9-]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 10, 'esperava encontrar várias <section id="..."> em index.html');

  for (const arquivo of ARQUIVOS_DS) {
    const limpo = semComentarios(ler(arquivo));
    for (const id of ids) {
      assert.ok(!limpo.includes(`#${id}`), `${path.basename(arquivo)} não pode referenciar #${id} — Design System é agnóstico de módulo`);
    }
  }
});

test('design-system: forma (raio/sombra/espessura) só por token fora de 01-tokens.css', () => {
  // Irmão da checagem de cor acima, e pelo mesmo motivo: a FORMA também é sistema. O legado tinha
  // nove raios simultâneos (8, 9, 10, 11, 12, 13, 14, 16, 18px) contra os três do DS — foi assim
  // que um campo de 7px sobreviveu escondido até a auditoria de navegador medi-lo
  // (scripts/auditoria-design.mjs). Sem esta trava, o próximo valor solto entra do mesmo jeito.
  //
  // `0`, `50%` (círculo) e `inherit` passam: são formas absolutas, não pontos de uma escala.
  const PROPS = /(?:^|[;{\s])(border-radius|box-shadow|border-width|border-(?:top|right|bottom|left)-width)\s*:\s*([^;}]+)/g;
  const LIVRES = /^(?:0|0px|0%|50%|inherit|initial|unset|none|revert)$/;
  for (const arquivo of [...ARQUIVOS_DS, ...ARQUIVOS_MODULO]) {
    if (arquivo === ARQUIVO_PRIMITIVOS) continue;
    const limpo = semComentarios(ler(arquivo));
    for (const [, prop, bruto] of limpo.matchAll(PROPS)) {
      const valor = bruto.trim();
      let ok;
      if (prop === 'box-shadow') {
        // Numa sombra o que precisa ser sistema é a COR (e a elevação inteira, quando vem de
        // token). Os deslocamentos de um TRAÇO — a barra de 2px que marca a linha vencida, o anel
        // do cartão-filtro — são geometria do desenho, não um degrau de escala.
        ok = LIVRES.test(valor) || valor.includes('var(--');
      } else {
        // raio e espessura: cada pedaço é ponto de escala ("var(--ds-x) var(--ds-y)" também vale)
        ok = valor.split(/\s+/).filter(Boolean).every((p) => p.startsWith('var(--') || LIVRES.test(p));
      }
      assert.ok(ok, `${path.basename(arquivo)}: ${prop}: ${valor} — use var(--ds-radius-*)/var(--ds-shadow-*)/var(--ds-border*)`);
    }
  }
});

test('design-system: todo módulo marcado .ds-modulo existe de fato como <section>', () => {
  // Confere o inverso do teste anterior: a classe .ds-modulo só faz sentido em cima de uma
  // <section id="..."> real, senão a regra de 05-components.css nunca casa com nada.
  const html = fs.readFileSync(path.join(RAIZ, 'frontend', 'index.html'), 'utf8');
  const secoes = [...html.matchAll(/<section id="([a-z0-9-]+)" class="([^"]*)"/g)];
  assert.ok(secoes.length > 10, 'esperava encontrar várias <section id="..." class="..."> em index.html');
  const migrados = secoes.filter(([, , classes]) => classes.split(/\s+/).includes('ds-modulo'));
  assert.ok(migrados.length >= 4, 'esperava ao menos Frota, Multas, Rastreadores e Instalações migrados');
  for (const [, id] of migrados) {
    assert.ok(/^[a-z0-9-]+$/.test(id), `id de módulo migrado com formato inesperado: ${id}`);
  }
});
