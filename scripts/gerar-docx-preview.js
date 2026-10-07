// Gera frontend/docx-preview.js: a cópia local do docx-preview 0.3.6 (leitor de .docx no
// navegador, usado só pelo "Salvar em PDF" do termo da multa) com as correções do Gestão RM para o
// termo sair como no Word. Cada correção aparece no arquivo gerado com o comentário "GESTAORM".
// Se o trecho original não for encontrado (versão diferente), o script para e diz qual.
// USO: curl -sS https://cdn.jsdelivr.net/npm/docx-preview@0.3.6/dist/docx-preview.js -o docx-preview.orig.js
//      node scripts/gerar-docx-preview.js docx-preview.orig.js
//      → "frontend/docx-preview.js gerado (7 correções, 169000 bytes)"
const fs = require('fs');
const path = require('path');

const origem = process.argv[2];
if (!origem) { console.error('Informe o dist/docx-preview.js original (veja o USO no topo do script).'); process.exit(1); }
let s = fs.readFileSync(origem, 'utf8').replace(/\r\n/g, '\n');
const troca = (de, para) => {
  if (s.split(de).length !== 2) throw new Error('Trecho do original não encontrado (ou repetido): ' + de.slice(0, 90));
  s = s.replace(de, () => para);
};

// 1) Espaçamento entre linhas: sem w:lineRule o Word usa "auto" (múltiplo da altura natural da
//    linha). O original tratava como "exata" em pt — rótulo de 6,5 pt com line=220 virava linha de
//    11 pt, e o termo crescia ~15%. "auto" vira múltiplo × 1,15 (altura natural da Arial/Consolas).
troca(`            if (line !== null) {
                switch (lineRule) {
                    case "auto":
                        style["line-height"] = \`\${(line / 240).toFixed(2)}\`;
                        break;`,
`            if (line !== null) {
                // GESTAORM: sem lineRule o padrão do Word é "auto", e "auto" multiplica a altura natural da linha (~1,15 × fonte).
                switch (lineRule || "auto") {
                    case "auto":
                        style["line-height"] = \`\${(line / 240 * 1.15).toFixed(3)}\`;
                        break;`);

// 2) Espaçamento entre letras do texto (w:spacing dentro de w:rPr, em vigésimos de ponto): o
//    original só lia o w:spacing do parágrafo. Os rótulos do termo ("D A D O S") usam isto.
troca(`                    case "spacing":
                        if (elem.localName == "pPr")
                            this.parseSpacing(c, style);
                        break;`,
`                    case "spacing":
                        if (elem.localName == "pPr")
                            this.parseSpacing(c, style);
                        // GESTAORM: espaçamento entre letras do run.
                        else if (elem.localName == "rPr" && globalXmlParser.attr(c, "val") != null)
                            style["letter-spacing"] = \`\${(parseInt(globalXmlParser.attr(c, "val"), 10) || 0) / 20}pt\`;
                        break;`);

// 3) Símbolo (w:sym): o original montava com innerHTML o código vindo do arquivo. Só aceita
//    hexadecimal dentro do Unicode (acima de 10FFFF o fromCodePoint lançaria e o termo não sairia).
troca(`            span.innerHTML = \`&#x\${elem.char};\`;`,
`            // GESTAORM: nada de innerHTML com texto do arquivo; código fora do Unicode vira "�".
            const codigo = /^[0-9A-Fa-f]{1,6}$/.test(elem.char || "") ? parseInt(elem.char, 16) : -1;
            if (codigo >= 0) span.textContent = codigo <= 0x10FFFF ? String.fromCodePoint(codigo) : "\\uFFFD";`);

// 4) Número de lista seguido de TAB com recuo deslocado ("01" + tab + texto, recuo de 32 pt): o
//    original punha o tab dentro do ::before, e o navegador o reduz a um espaço — o texto colava no
//    número. Agora o número ocupa uma caixa da largura do recuo, como a parada de tab do Word (com
//    um espaço fixo no fim, para um número mais largo que o recuo nunca encostar no texto).
troca(`                    styleText += this.styleToString(\`\${selector}:before\`, {
                        "content": this.levelTextToContent(num.levelText, num.suff, num.id, this.numFormatToCssValue(num.format)),
                        "counter-increment": counter,
                        ...num.rStyle,
                    });`,
`                    // GESTAORM: tab depois do número com recuo deslocado = caixa da largura do recuo.
                    const recuoTxt = /^-/.test(num.pStyle?.["text-indent"] ?? "") ? num.pStyle["text-indent"].slice(1) : "";
                    const recuo = (num.suff ?? "tab") == "tab" && parseFloat(recuoTxt) > 0 ? recuoTxt : null;
                    styleText += this.styleToString(\`\${selector}:before\`, {
                        "content": this.levelTextToContent(num.levelText, recuo ? "space" : num.suff, num.id, this.numFormatToCssValue(num.format)),
                        "counter-increment": counter,
                        ...(recuo ? { "display": "inline-block", "min-width": recuo, "text-indent": "0" } : {}),
                        ...num.rStyle,
                    });`);

// 5) Parada de tab: a posição do Word conta da margem da página (o original somava o recuo do
//    parágrafo em vez de subtrair, e só criava as paradas padrão até a largura do parágrafo sem o
//    recuo) e, no tab à direita/centralizado, o texto seguinte era medido no primeiro desenho —
//    quando ele já tinha quebrado de linha, o tab ficava largo demais e o rodapé ("… GESTÃO DE
//    FROTA<tab>TERMO DE …") saía em duas linhas. Agora mede o texto numa linha só (inclusive os
//    trechos, que têm white-space próprio) e desconta a largura do espaço que representa o tab.
troca(`        const lastTab = tabStops[tabStops.length - 1];
        const pWidthPt = pbb.width * pixelToPoint;`,
`        const lastTab = tabStops[tabStops.length - 1];
        // GESTAORM: paradas padrão até a borda direita do parágrafo, contada da margem da página.
        const pWidthPt = (pbb.width + Math.max(0, parseFloat(pcs.marginLeft) || 0)) * pixelToPoint;`);
troca(`        const marginLeft = parseFloat(pcs.marginLeft);
        const pOffset = pbb.left + marginLeft;`,
`        const marginLeft = parseFloat(pcs.marginLeft);
        // GESTAORM: a posição do tab conta da margem da página, antes do recuo do parágrafo.
        const pOffset = pbb.left - marginLeft;`);
troca(`            const mul = tab.style == "center" ? 0.5 : 1;
            const nextBB = range.getBoundingClientRect();
            const offset = nextBB.left + mul * nextBB.width - (pbb.left - marginLeft);
            width = tab.pos - offset * pixelToPoint;
        }
        else {
            width = tab.pos - left;
        }
        elem.innerHTML = "&nbsp;";
        elem.style.textDecoration = "inherit";
        elem.style.wordSpacing = \`\${width.toFixed(0)}pt\`;`,
`            const mul = tab.style == "center" ? 0.5 : 1;
            // GESTAORM: mede o texto seguinte numa linha só (sem a quebra do primeiro desenho).
            const nos = [p, ...p.querySelectorAll("*")];
            const antes = nos.map(n => n.style.whiteSpace);
            nos.forEach(n => { n.style.whiteSpace = "nowrap"; });
            const textoPt = range.getBoundingClientRect().width * pixelToPoint;
            nos.forEach((n, i) => { n.style.whiteSpace = antes[i]; });
            width = tab.pos - left - mul * textoPt;
        }
        else {
            width = tab.pos - left;
        }
        elem.innerHTML = "&nbsp;";
        elem.style.textDecoration = "inherit";
        // GESTAORM: o tab é um espaço + word-spacing; desconta a largura do espaço (e do espaçamento entre letras).
        elem.style.wordSpacing = "0pt";
        const espacoPt = elem.getBoundingClientRect().width * pixelToPoint;
        elem.style.wordSpacing = \`\${Math.max(0, width - espacoPt).toFixed(1)}pt\`;`);

// 6) As paradas de tab são calculadas 500 ms DEPOIS do render (setTimeout) e com o document da
//    página — o PDF imprimia antes disso, e o termo é montado num iframe. Com a opção
//    `aoCalcularTabs(fn)`, quem chama recebe a função e decide a hora (depois dos ajustes de
//    página); os cálculos usam o document do próprio parágrafo.
troca(`        const pcs = getComputedStyle(p);`, `        // GESTAORM: estilo/medidas no document do próprio parágrafo (pode ser um iframe).
        const pcs = p.ownerDocument.defaultView.getComputedStyle(p);`);
troca(`            const range = document.createRange();`, `            const range = p.ownerDocument.createRange();`);
troca(`        refreshTabStops() {
            if (!this.options.experimental)
                return;
            setTimeout(() => {
                const pixelToPoint = computePixelToPoint();
                for (let tab of this.currentTabs) {
                    updateTabStop(tab.span, tab.stops, this.defaultTabSize, pixelToPoint);
                }
            }, 500);
        }`,
`        refreshTabStops() {
            if (!this.options.experimental)
                return;
            const atualizar = () => {
                const pixelToPoint = computePixelToPoint();
                for (let tab of this.currentTabs) {
                    updateTabStop(tab.span, tab.stops, this.defaultTabSize, pixelToPoint);
                }
            };
            // GESTAORM: quem chama decide quando calcular (opção aoCalcularTabs).
            if (typeof this.options.aoCalcularTabs === "function")
                return this.options.aoCalcularTabs(atualizar);
            setTimeout(atualizar, 500);
        }`);

// 7) Borda do parágrafo (w:pBdr) com distância do texto (w:space, em pontos): o original
//    desenhava a linha colada no texto. O rodapé do termo tem a linha 4 pt acima do texto.
troca(`                    case "pBdr":
                        this.parseBorderProperties(c, style);
                        break;`,
`                    case "pBdr":
                        this.parseBorderProperties(c, style);
                        // GESTAORM: w:space da borda vira folga entre a linha e o texto.
                        for (const lado of ["top", "bottom"]) {
                            const b = globalXmlParser.element(c, lado);
                            const esp = b && parseFloat(globalXmlParser.attr(b, "space"));
                            if (esp > 0) style[\`padding-\${lado}\`] = \`\${esp}pt\`;
                        }
                        break;`);

s = s.replace('//# sourceMappingURL=docx-preview.js.map\n', '');
// Espaço excedente no CSS original; mantém a cópia gerada sem whitespace pendente no Git.
s = s.replace('align-items: center; } \n', 'align-items: center; }\n');
const cab = `/*!
 * docx-preview 0.3.6 — https://github.com/VolodymyrBaydalka/docxjs
 * Copyright Volodymyr Baydalka. Licenciado sob a Apache License 2.0 — texto completo em
 * docx-preview.LICENSE.txt (nesta mesma pasta).
 * ARQUIVO MODIFICADO pelo Gestão RM (gerado por scripts/gerar-docx-preview.js; não edite à mão).
 * Correções marcadas com "GESTAORM":
 *  1. w:spacing sem w:lineRule = "auto" (padrão do Word), e "auto" × 1,15 (altura natural da linha);
 *  2. w:spacing do run (w:rPr) vira letter-spacing;
 *  3. w:sym monta o símbolo por textContent, só com código hexadecimal válido (o original usava innerHTML);
 *  4. número de lista + tab com recuo deslocado: o número ocupa a largura do recuo (o tab virava espaço);
 *  5. parada de tab: conta da margem da página e, à direita/centralizada, mede o texto numa linha só;
 *  6. opção aoCalcularTabs(fn): quem chama decide quando calcular as paradas de tab (o original esperava
 *     500 ms) e os cálculos usam o document do parágrafo (o termo é montado num iframe);
 *  7. w:space da borda do parágrafo vira folga entre a linha e o texto.
 * Usado só pelo "Salvar em PDF" do termo da multa (abrirTermoParaPdf no app.js).
 */
`;
const destino = path.join(__dirname, '..', 'frontend', 'docx-preview.js');
fs.writeFileSync(destino, cab + s);
console.log(`frontend/docx-preview.js gerado (7 correções, ${(cab + s).length} bytes)`);
