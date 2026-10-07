const fs = require('fs');
const sharp = require('sharp');
const Tesseract = require('tesseract.js');

async function main() {
  const pdfPath = process.argv[2];
  const maxPaginas = Math.max(1, Math.min(Number(process.argv[3]) || 3, 6));
  const scale = Number(process.argv[4]) || 3;
  if (!pdfPath || !fs.existsSync(pdfPath)) throw new Error('PDF nao encontrado para OCR.');

  const { pdf } = await import('pdf-to-img');
  const doc = await pdf(pdfPath, { scale });
  let texto = '';
  let pagina = 0;
  try {
    for await (const image of doc) {
      pagina++;
      const img = await sharp(image).grayscale().normalize().sharpen().png().toBuffer();
      const r = await Tesseract.recognize(img, 'por');
      texto += `\n\n--- OCR PAGINA ${pagina} ---\n` + ((r && r.data && r.data.text) || '');
      if (pagina >= maxPaginas) break;
    }
  } finally {
    if (doc && typeof doc.destroy === 'function') {
      try { await doc.destroy(); } catch (e) { /* ok */ }
    }
  }
  process.stdout.write(JSON.stringify({ ok: true, paginas: pagina, texto }));
}

main().catch((e) => {
  process.stderr.write((e && e.stack) || (e && e.message) || String(e));
  process.exit(1);
});
