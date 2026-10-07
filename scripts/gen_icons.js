// Gera os ícones do Gestão RM (favicon + PWA): a engrenagem BRANCA sobre o tile
// GRAFITE #1f2227 — o mesmo desenho do ladrilho da sidebar e do painel de login
// (pedido de ago/2026; substituiu o tile azul #1b56ff do hub, que era o ícone anterior).
// A arte vem de frontend/img/logo-rm.png (glifo transparente, a MESMA imagem que a
// sidebar usa como máscara CSS) — o glifo é pintado de branco pelo canal alpha,
// porque os pixels da arte não são brancos (a máscara CSS só olha o alpha).
// Uso: node scripts/gen_icons.js  → escreve os PNGs em frontend/.
const path = require('path');
const sharp = require('sharp');

const ORIGEM = path.join(__dirname, '..', 'frontend', 'img', 'logo-rm.png');
const DESTINO = path.join(__dirname, '..', 'frontend');
const GRAFITE = '#1f2227'; // --ds-shell-tile (ladrilho do logo, 01-tokens.css)
const BORDA = '#31363e';   // --ds-shell-tile-line
const TRANSP = { r: 0, g: 0, b: 0, alpha: 0 };

// Aba/atalho: tile arredondado com o glifo ocupando ~78% (proporção do tile da sidebar: 34px/42px).
const NORMAIS = [
  ['icon-512.png', 512], ['icon-256.png', 256], ['icon-192.png', 192], ['icon-128.png', 128],
  ['favicon-64.png', 64], ['favicon-48.png', 48], ['favicon-32.png', 32],
];

// Tile grafite arredondado (raio ~19% = 8px/42px do .marca-tile), com borda sutil.
function tileSvg(tam, raioFrac) {
  const r = Math.round(tam * raioFrac);
  const b = Math.max(1, Math.round(tam / 42)); // ~1px na escala do tile de 42px
  return Buffer.from(
    `<svg width="${tam}" height="${tam}" xmlns="http://www.w3.org/2000/svg">` +
    `<rect x="${b / 2}" y="${b / 2}" width="${tam - b}" height="${tam - b}" rx="${r}" fill="${GRAFITE}" stroke="${BORDA}" stroke-width="${b}"/></svg>`
  );
}

// Glifo branco: pega SÓ o alpha da arte e o aplica sobre branco puro.
async function glifoBranco(aparado, interno) {
  const base = await sharp(aparado).resize(interno, interno, { fit: 'contain', background: TRANSP }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const alpha = await sharp(base.data, { raw: { width: base.info.width, height: base.info.height, channels: 4 } })
    .extractChannel(3).toBuffer();
  return sharp({ create: { width: base.info.width, height: base.info.height, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .joinChannel(alpha, { raw: { width: base.info.width, height: base.info.height, channels: 1 } })
    .png().toBuffer();
}

// Compõe o ícone: tile grafite + glifo branco centrado ocupando `fracao` do quadrado.
async function icone(aparado, tam, fracao, raioFrac) {
  const interno = Math.round(tam * fracao);
  const glifo = await glifoBranco(aparado, interno);
  return sharp(tileSvg(tam, raioFrac)).composite([{ input: glifo, gravity: 'centre' }]).png();
}

// A arte tem uma MOLDURA fantasma de 1px com alpha ~54 (invisível na máscara CSS de
// 34px da sidebar, mas visível no ícone de 256px — e ela enganava o trim()). Zera
// qualquer alpha < 70 antes de tudo; o glifo de verdade tem alpha ≥ ~128 nas bordas.
async function limparArte() {
  const b = await sharp(ORIGEM).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  for (let i = 3; i < b.data.length; i += 4) if (b.data[i] < 70) b.data[i] = 0;
  return sharp(b.data, { raw: { width: b.info.width, height: b.info.height, channels: 4 } }).png().toBuffer();
}

(async () => {
  const aparado = await sharp(await limparArte()).trim().toBuffer(); // remove a margem transparente do PNG

  for (const [nome, tam] of NORMAIS) {
    await (await icone(aparado, tam, 0.78, 0.19)).toFile(path.join(DESTINO, nome));
    console.log('gerado', nome, tam + 'x' + tam);
  }

  // iOS pinta de PRETO o que for transparente no apple-touch-icon → tile SEM cantos
  // transparentes: grafite cheio (raio 0; o iOS arredonda sozinho).
  await (await icone(aparado, 180, 0.72, 0)).toFile(path.join(DESTINO, 'apple-touch-icon.png'));
  console.log('gerado apple-touch-icon.png 180x180 (grafite cheio)');

  // Maskable (Android corta em círculo/squircle): glifo na zona segura (~64%) sobre grafite cheio.
  for (const tam of [192, 512]) {
    await (await icone(aparado, tam, 0.64, 0)).toFile(path.join(DESTINO, `icon-${tam}-maskable.png`));
    console.log(`gerado icon-${tam}-maskable.png ${tam}x${tam} (grafite cheio, zona segura)`);
  }
  console.log('OK');
})();
