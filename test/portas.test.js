/**
 * Auditoria ESTÁTICA das portas dos servidores de teste — não sobe nada, só lê os arquivos.
 *
 * POR QUE EXISTE: cada suíte sobe um `backend/server.js` de verdade numa porta fixa. Quando
 * dois arquivos declaram a MESMA porta, o segundo servidor morre com EADDRINUSE — e o erro era
 * invisível em toda a cadeia: `app.listen` não tratava o `error`, o spawn usava
 * `stdio: 'ignore'`, ninguém olhava o código de saída do filho, e o `esperarServidor()` aceitava
 * QUALQUER resposta 200, inclusive a do servidor rival. Resultado: a suíte perdedora rodava
 * inteira contra o servidor da outra, com outro DATA_DIR, outra COFRE_CHAVE e o teto de 600
 * req/min em vez dos 5000 do E2E_TEST — dezenas de falhas 429/404 em testes sem relação nenhuma
 * entre si. Já tinha acontecido antes e foi tapado à mão (ver a porta do SEG-8 em
 * test/modulos.test.js). Este teste mata a classe em vez de tapar o próximo buraco.
 *
 * CONVENÇÃO DE FAIXAS (siga ao criar um arquivo novo):
 *   test/**             → 3196-3209   (`node --test` roda estes arquivos em PARALELO)
 *   e2e/** + scripts/** → 3210+       (rodam por comando próprio e podem coincidir no tempo
 *                                      com o `npm test`)
 *
 * Rodar: npm test (o `node --test` descobre este arquivo sozinho)
 */
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.join(__dirname, '..');
const PASTAS = ['test', 'e2e', 'scripts'];
const EXT = /\.(?:c|m)?js$/;
// `const PORT = 3197` / `const porta = 3206` — a forma como TODO arquivo que sobe um servidor
// declara a porta hoje. Só literal: quem lê de `process.env.PORT` não disputa porta fixa.
const DECLARACAO = /\bconst\s+(?:PORT|PORTA|porta)\s*=\s*(\d{4,5})\b/g;
const FAIXA = { test: [3196, 3209], e2e: [3210, 3299], scripts: [3210, 3299] };
const PISO = 10; // quantas declarações esperamos achar hoje — trava contra o regex apodrecer

// Mesma razão do test/design-system.test.js: há prosa citando portas antigas ("era 3197") e
// comentário inline na mesma linha da declaração. Sem limpar, viram falso positivo.
// ⚠️ A ORDEM IMPORTA: linha primeiro, bloco depois. Um comentário de LINHA que cite um caminho
// com curinga (a pasta test/ seguida de dois asteriscos) contém a sequência que ABRE comentário
// de bloco; fazendo bloco primeiro, o regex engolia dali até o próximo fechamento — e levava
// junto a declaração de porta que vinha logo abaixo. O guarda `[^:]` do regex de linha é o que
// preserva "http://" dentro de string.
function semComentarios(src) {
  return src.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

function varrer(dir, saida = []) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, item.name);
    if (item.isDirectory()) { if (item.name !== 'node_modules') varrer(p, saida); }
    else if (EXT.test(item.name)) saida.push(p);
  }
  return saida;
}

function coletar() {
  const achados = [];
  for (const pasta of PASTAS) {
    const dir = path.join(RAIZ, pasta);
    if (!fs.existsSync(dir)) continue;
    for (const arq of varrer(dir)) {
      const src = semComentarios(fs.readFileSync(arq, 'utf8'));
      for (const m of src.matchAll(DECLARACAO)) {
        achados.push({ pasta, porta: Number(m[1]), onde: path.relative(RAIZ, arq).split(path.sep).join('/') });
      }
    }
  }
  return achados;
}

test('portas: nenhuma porta de servidor de teste é declarada em dois lugares', () => {
  const achados = coletar();
  assert.ok(achados.length >= PISO,
    `esperava pelo menos ${PISO} portas declaradas, achei ${achados.length} — o regex de declaração`
    + ' provavelmente ficou para trás (alguém trocou `const PORT =` por outra forma).');

  // Agrupa por VALOR da porta, não por arquivo: assim test/modulos.test.js declarar duas portas
  // (a sua e a do 2º servidor do SEG-8) não vira falso positivo, mas o mesmo número em dois
  // arquivos vira.
  const porPorta = new Map();
  for (const a of achados) porPorta.set(a.porta, [...(porPorta.get(a.porta) || []), a.onde]);
  const repetidas = [...porPorta].filter(([, ondes]) => ondes.length > 1)
    .map(([porta, ondes]) => `${porta}: ${ondes.join(' + ')}`);
  const livres = Array.from({ length: 14 }, (_, i) => 3196 + i).filter((p) => !porPorta.has(p));

  assert.deepEqual(repetidas, [],
    'porta declarada em mais de um lugar — a segunda morre com EADDRINUSE e a suíte roda contra o'
    + ` servidor errado:\n  ${repetidas.join('\n  ')}\nLivres em 3196-3209: ${livres.join(', ') || '(nenhuma)'}`);
});

test('portas: cada pasta usa a sua faixa (test 3196-3209 · e2e e scripts 3210+)', () => {
  for (const { pasta, porta, onde } of coletar()) {
    const [min, max] = FAIXA[pasta];
    assert.ok(porta >= min && porta <= max,
      `${onde} usa a porta ${porta}, fora da faixa de ${pasta}/ (${min}-${max}) — ver a convenção no topo deste arquivo`);
  }
});
