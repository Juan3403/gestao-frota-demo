/* Interpretador de prints de multas, sem DOM, histórico ou estado global de veículos.
 * USO: MultaOCR.analisar({ text: 'Placa: KDROE17' }, { placas: ['KDR0E17'], frotaDisponivel: true })
 *      → campos.placa = { valor: 'KDR0E17', estado: 'claro', frota: true, ... }.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MultaOCR = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ROTULOS = Object.freeze({
    placa: 'Placa', autoInfracao: 'Auto de infração', descricao: 'Descrição',
    dataInfracao: 'Data da infração', horaInfracao: 'Hora da infração', valor: 'Valor original',
    local: 'Local da infração', cidadeEstado: 'Cidade/UF', codigoInfracao: 'Código da infração',
    orgaoAutuador: 'Órgão autuador', dataNotificacao: 'Data da notificação', dataVencimento: 'Vencimento'
  });
  const GRUPOS = ['OQDU0', 'IL1J', 'B8', 'S5', 'Z2', 'G6', 'A4', 'T7'];
  const NUMEROS = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', J: '1', B: '8', S: '5', Z: '2', G: '6', A: '4', T: '7' };
  const LETRAS = { 0: 'O', 1: 'I', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B' };
  const UFS = new Set('AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' '));
  const SIGLAS = new Set('CONTRAN SENATRAN DENATRAN DETRAN CTB CNH PPD ACC CRLV CRV PRF DER DNIT CET IPVA RENAINF AIT ANTT CIPP CIV'.split(' '));
  const VERBOS_DESCRICAO = 'conduzir|dirigir|transitar|estacionar|parar|deixar|executar|ultrapassar|avancar|transportar|permitir|utilizar|usar|fazer|circular|rebocar|atirar|disputar|participar|entregar|confiar|efetuar|retornar|converter|desobedecer|recusar|impedir|abandonar|bloquear|realizar|acionar|manter|aproximar|afastar|transpor|trafegar|remover|retirar|obstruir|depositar|derramar|promover|forcar|interromper';
  const INICIO_DESCRICAO = new RegExp('^(?:' + VERBOS_DESCRICAO + ')(?:-se)?\\b');
  // Comparadas com acento: "É" (ícone lido como letra) não é a conjunção "e".
  const PALAVRAS_CURTAS = new Set('a o e as os ao aos à às da de do das dos em na no nas nos se que por com sem um uma ou não nao'.split(' '));
  // Mais específicos primeiro; rótulos auxiliares delimitam trechos, sem virar campos do formulário.
  const REGRAS = [
    { campos: ['dataNotificacao'], re: /\bdata\s+(?:(?:da|de)\s+)?notificacao(?:\s+de\s+autuacao)?\b/g },
    { campos: ['dataVencimento'], re: /\b(?:data\s+(?:(?:do|de)\s+)?)?vencimento(?:\s+do\s+desconto)?\b/g },
    { campos: ['dataInfracao', 'horaInfracao'], re: /\bdata\s*\/\s*hora\s+do\s+cometimento\s+da\s+infracao\b/g },
    { campos: ['placa'], re: /\bplaca(?:\s+(?:a\s+epoca\s+(?:da|de)\s+infracao|do\s+veiculo))?\b/g },
    { campos: ['autoInfracao'], re: /\b(?:(?:n[ouº°.]|numero)\s*(?:do\s+)?)?auto\s+(?:de\s+)?infracao\b/g },
    { campos: ['codigoInfracao'], re: /\b(?:codigo|enquadramento)\s+(?:(?:da|de)\s+)?infracao\b/g },
    { campos: ['descricao'], re: /\bdescricao(?:\s+(?:da|de)\s+infracao)?\b/g },
    { campos: ['orgaoAutuador'], re: /\borgao\s+autuador\b/g },
    { campos: ['local'], re: /\blocal\s+(?:da|de)\s+infracao\b/g },
    { campos: ['cidadeEstado'], re: /\b(?:municipio|cidade)(?:\s*\/\s*(?:uf|estado)|\s+(?:da|de)\s+infracao)?\b/g },
    { campos: [], re: /\b(?:data\s*(?:e|\/)\s*hora(?:\s+(?:da|de)\s+infracao)?|cometimento(?:\s+(?:da|de)\s+infracao)?|data\s+(?:(?:da|de)\s+)?infracao|(?:hora|horario)\s+(?:(?:da|de)\s+)?infracao|valor\s+(?:com\s+(?:\d+\s*%\s*)?desconto|do\s+desconto|a\s+pagar)|desconto(?:\s+de\s+\d+\s*%)?|notificacao\s+de\s+(?:autuacao|penalidade)|dados\s+(?:do\s+veiculo|da\s+infracao)|identificacao\s+(?:do\s+veiculo|da\s+infracao)|detalhes\s+da\s+infracao|data\s+(?:de\s+pagamento|de\s+emissao)|data\s+limite|orgao\s+competente(?:\s*\/\s*responsavel)?|renavam|renainf|faixa|marca\s*\/\s*modelo|modelo|proprietario|condutor|uf)\b/g },
    { campos: ['valor'], re: /\bvalor(?:\s+(?:original|da\s+(?:multa|infracao)))?\b/g }
  ];

  // USO: normalizar('Órgão  Autuador') → 'orgao  autuador' (preserva índices dos caracteres).
  function normalizar(s) { return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase(); }
  // USO: compactar('  ABC\n  1234 ') → 'ABC 1234'.
  function compactar(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  // USO: juntarBboxes([{x0:0,y0:0,x1:10,y1:10},{x0:5,y0:2,x1:20,y1:12}]) → {x0:0,y0:0,x1:20,y1:12}.
  function juntarBboxes(boxes) {
    const b = boxes.filter(b => b && ['x0', 'y0', 'x1', 'y1'].every(k => Number.isFinite(b[k])));
    return b.length ? { x0: Math.min(...b.map(v => v.x0)), y0: Math.min(...b.map(v => v.y0)), x1: Math.max(...b.map(v => v.x1)), y1: Math.max(...b.map(v => v.y1)) } : null;
  }
  // USO: campoVazio('placa') → {valor:'', estado:'naoEncontrado', rotulo:'Placa', ...}.
  function campoVazio(campo) {
    return { valor: '', original: '', estado: 'naoEncontrado', motivo: 'Campo não encontrado no print.', alternativas: [], correcoes: [], bbox: null, confianca: null, rotulo: ROTULOS[campo] || campo, frota: false };
  }
  // Na fonte do portal da SENATRAN (Raleway) um único caractere às vezes sai como DOIS símbolos que
  // se confundem: o zero vira "O"+"0" quase no mesmo lugar, o 5 vira um "S" estreito colado no "5".
  // Pelas caixas dos símbolos dá para ver o caractere a mais: metade ou mais da largura dele está
  // coberta pelos vizinhos, ou ele é estreito demais (≤ 60% da mediana da palavra) com confiança < 90;
  // e ele se confunde com um vizinho (O/0/D, S/5, I/1…). Sai o mais coberto de cada grupo.
  // Só vale para palavras com número; zeros de verdade ficam lado a lado e não são tocados.
  // USO: semGlifosPartidos({text:'SO051576253', symbols:[…O em x 995–1005, 0 em x 996–1012…]}) → 'S051576253'
  //      semGlifosPartidos({text:'ODOOS513104', symbols:[…S com 7 px e confiança 87 antes do 5…]}) → 'ODOO513104'
  //      semGlifosPartidos({text:'ODO00512345', symbols:[…O de 9 px entre o D e o 0, encostado nos dois…]}) → 'OD00512345'
  //      semGlifosPartidos({text:'10253000297', symbols:[zeros sem sobreposição]}) → '10253000297'
  //      semGlifosPartidos({text:'ABC1234'}) → 'ABC1234' (sem símbolos, devolve como veio)
  function semGlifosPartidos(word) {
    const text = String((word && word.text) || '');
    const syms = word && Array.isArray(word.symbols) ? word.symbols : [];
    if (!/\d/.test(text) || syms.length < 3) return text;
    const letras = syms.map(s => compactar(s && s.text));
    if (syms.some((s, i) => !s.bbox || letras[i].length !== 1 || ![s.bbox.x0, s.bbox.x1].every(Number.isFinite))
      || letras.join('') !== text.replace(/\s/g, '')) return text;
    const largura = s => s.bbox.x1 - s.bbox.x0, conf = s => (Number.isFinite(s.confidence) ? s.confidence : 100);
    const sobre = (a, b) => Math.max(0, Math.min(a.bbox.x1, b.bbox.x1) - Math.max(a.bbox.x0, b.bbox.x0));
    const ordenadas = syms.map(largura).sort((a, b) => a - b), mediana = ordenadas[Math.floor(ordenadas.length / 2)];
    const candidatos = syms.map((s, i) => {
      const t = letras[i].toUpperCase(), vizinhos = [i - 1, i + 1].filter(j => j >= 0 && j < syms.length);
      if (!vizinhos.some(j => letras[j].toUpperCase() !== t && confunde(t, letras[j].toUpperCase()))) return null;
      const w = largura(s), cobertura = w > 0 ? vizinhos.reduce((n, j) => n + sobre(s, syms[j]), 0) / w : 1;
      const nota = Math.max(cobertura >= 0.5 ? cobertura : 0, w <= mediana * 0.6 && conf(s) < 90 ? 0.5 : 0);
      return nota ? { i, nota, conf: conf(s), digito: /\d/.test(t) ? 1 : 0 } : null;
    }).filter(Boolean).sort((a, b) => b.nota - a.nota || a.conf - b.conf || a.digito - b.digito);
    const remover = new Set();
    // De dois vizinhos candidatos (o "O" e o "0" do mesmo zero), sai só o mais coberto.
    for (const c of candidatos) if (!remover.has(c.i - 1) && !remover.has(c.i + 1)) remover.add(c.i);
    return remover.size ? letras.filter((_, i) => !remover.has(i)).join('') : text;
  }
  // USO: lerLinhas({text:'Placa: ABC1234'}) → [{text:'Placa: ABC1234', words:[], bbox:null, ...}].
  function lerLinhas(data) {
    const d = typeof data === 'string' ? { text: data } : (data || {});
    let raw = d.lines || [];
    if (!raw.length && d.blocks) raw = d.blocks.flatMap(b => (b.paragraphs || []).flatMap(p => p.lines || []));
    if (!raw.length) return String(d.text || '').split(/\r?\n/).map((text, i) => ({ text: compactar(text), words: [], bbox: null, confidence: null, index: i })).filter(l => l.text);
    return raw.map((l, i) => {
      let pos = 0;
      const words = (l.words || []).filter(w => compactar(w.text)).map(w => {
        const text = compactar(semGlifosPartidos(w)), start = pos; pos += text.length + 1;
        return { text, start, end: start + text.length, bbox: w.bbox || null, confidence: Number.isFinite(w.confidence) ? w.confidence : null };
      });
      return { text: words.length ? words.map(w => w.text).join(' ') : compactar(l.text), words, bbox: l.bbox || juntarBboxes(words.map(w => w.bbox)), confidence: null, index: i };
    }).filter(l => l.text);
  }
  // USO: juntarRotuloCometimento(lerLinhas({text:'Data/Hora do Cometimento da\nInfração 10/09/2026 14:37'}))
  //      → uma linha lógica que contém o rótulo completo, mantendo posições e confiança do OCR.
  function juntarRotuloCometimento(linhas) {
    const expected = 'data/hora do cometimento da infracao', result = [];
    for (let i = 0; i < linhas.length; i++) {
      const first = linhas[i], start = normalizar(first.text).search(/\bdata\s*\/\s*hora\b/);
      const anchor = start >= 0 ? trecho(first, start, first.text.length).bbox || first.bbox : first.bbox;
      let merged = first;
      if (start >= 0) {
        let partial = compactar(normalizar(first.text.slice(start))).replace(/\s*\/\s*/g, '/');
        if (partial && partial !== expected && expected.startsWith(partial)) {
          for (let n = i + 1; n < linhas.length && n <= i + 3; n++) {
            const next = linhas[n];
            if (anchor && next.bbox) {
              const height = Math.max(12, anchor.y1 - anchor.y0);
              if (next.bbox.y0 < anchor.y0 || next.bbox.y0 > merged.bbox.y1 + height * 3 || Math.abs(next.bbox.x0 - anchor.x0) > height * 4) break;
            }
            const joined = partial + ' ' + compactar(normalizar(next.text));
            if (!expected.startsWith(joined) && !joined.startsWith(expected)) break;
            const offset = merged.text.length + 1;
            merged = { ...first, text: merged.text + ' ' + next.text, words: [...merged.words, ...next.words.map(w => ({ ...w, start: w.start + offset, end: w.end + offset }))], bbox: juntarBboxes([merged.bbox, next.bbox]) };
            partial = joined;
            if (joined.startsWith(expected)) { i = n; break; }
          }
          // Fragmentos incompletos continuam linhas independentes, sem ampliar a região do valor.
          if (!partial.startsWith(expected)) merged = first;
        }
      }
      result.push(merged);
    }
    return result;
  }
  // USO: juntarRotuloDescricao(lerLinhas({text:'Descrição da\ninfração:\nTRANSITAR NA FAIXA'}))
  //      → consome as duas partes do rótulo, sem incluir "da infração" no valor ou unir colunas.
  function juntarRotuloDescricao(linhas) {
    const result = [], expected = ['descricao da infracao', 'descricao de infracao'];
    for (let i = 0; i < linhas.length; i++) {
      const pieces = fragmentosColuna(linhas[i]);
      const first = pieces.find(l => /\bdescricao(?:\s+(?:da|de))?$/.test(normalizar(l.text)));
      let complete = false, merged = first, end = i;
      const others = first ? pieces.filter(l => l !== first) : [];
      if (first) {
        const start = normalizar(first.text).search(/\bdescricao(?:\s+(?:da|de))?$/);
        let partial = compactar(normalizar(first.text.slice(start)));
        const anchor = trecho(first, start, first.text.length).bbox || first.bbox;
        for (let n = i + 1; n < linhas.length && n <= i + 6; n++) {
          const fragments = fragmentosColuna(linhas[n]);
          const next = fragments.find(l => !anchor || !l.bbox || Math.abs(l.bbox.x0 - anchor.x0) <= Math.max(12, anchor.y1 - anchor.y0) * 4);
          if (!next) { others.push(linhas[n]); continue; }
          if (anchor && next.bbox) {
            const height = Math.max(12, anchor.y1 - anchor.y0);
            if (next.bbox.y0 < anchor.y0 || next.bbox.y0 > merged.bbox.y1 + height * 3 || Math.abs(next.bbox.x0 - anchor.x0) > height * 4) break;
          }
          const joined = partial + ' ' + compactar(normalizar(next.text));
          complete = expected.some(e => joined === e || joined.startsWith(e + ':') || joined.startsWith(e + ' '));
          if (!complete && !expected.some(e => e.startsWith(joined))) break;
          const offset = merged.text.length + 1;
          merged = { ...first, text: merged.text + ' ' + next.text, words: [...merged.words, ...next.words.map(w => ({ ...w, start: w.start + offset, end: w.end + offset }))], bbox: juntarBboxes([merged.bbox, next.bbox]) };
          others.push(...fragments.filter(l => l !== next));
          partial = joined;
          if (complete) { end = n; break; }
        }
      }
      if (complete) { result.push(merged, ...others); i = end; }
      else result.push(linhas[i]);
    }
    return result;
  }
  // USO: fragmentosColuna(linha com 'Descrição da' à esquerda e 'Órgão autuador' à direita)
  //      → duas linhas lógicas, mantendo os textos/palavras de ambas as colunas.
  function fragmentosColuna(linha) {
    if (linha.words.length < 2 || linha.words.some(w => !w.bbox)) return [linha];
    const groups = [[]];
    linha.words.forEach((w, i) => {
      const previous = linha.words[i - 1], height = Math.max(12, w.bbox.y1 - w.bbox.y0);
      if (previous && w.bbox.x0 - previous.bbox.x1 > height * 3) groups.push([]);
      groups.at(-1).push(w);
    });
    if (groups.length === 1) return [linha];
    return groups.map((group, i) => {
      let offset = 0;
      const words = group.map(w => { const start = offset; offset += w.text.length + 1; return { ...w, start, end: start + w.text.length }; });
      return { ...linha, text: words.map(w => w.text).join(' '), words, bbox: juntarBboxes(words.map(w => w.bbox)), index: linha.index + ':' + i };
    });
  }
  // USO: inicioDescricao('• RECUSAR-SE A REALIZAR TESTE') → 2; 'NOTIFICAÇÃO DE AUTUAÇÃO' → -1.
  //      inicioDescricao('B TRANSITAR EM VELOCIDADE…') → 2 (o ícone do portal SENATRAN lido como "B").
  //      Prefixos visuais (símbolos ou UM token de até 3 caracteres, como "B", "É", "[E]") só são
  //      reconhecidos quando seguidos por um verbo de infração.
  function inicioDescricao(text) {
    const original = String(text || '');
    const prefixos = [/^[\s•●◦▪▫*\-–—=|\[\]()]*/, /^[\s•●◦▪▫*\-–—=|\[\]()]*(\S{1,3})\s+/];
    for (const re of prefixos) {
      const m = original.match(re), prefix = m?.[0] || '';
      // Palavra curta de verdade ("A REALIZAR…", "SE RECUSAR…") é continuação da frase, não ícone.
      if (m?.[1] && PALAVRAS_CURTAS.has(m[1].toLowerCase())) continue;
      if (INICIO_DESCRICAO.test(normalizar(original.slice(prefix.length)))) return prefix.length;
    }
    return -1;
  }
  // USO: cabecalhoDescricao('CARTEIRA DIGITAL DE TRÂNSITO') → true; ('SEM EQUIPAMENTO') → false.
  function cabecalhoDescricao(text) {
    return /^(?:notificacao\b|infracao\s*:|dados\s+d[ao]\b|detalhes\s+d[ao]\b|identificacao\s+d[ao]\b|carteira\s+digital\s+de\s+transito\b|senatran\b|cdt\b|sistema\b|secretaria\b|ministerio\b|situacao\s+d[ao]\b)/.test(normalizar(compactar(text)));
  }
  // USO: trecho(linha,7,14) → texto e bbox das palavras que contêm a placa, com menor confiança.
  function trecho(linha, start, end) {
    const words = linha.words.filter(w => w.end > start && w.start < end);
    const confidence = words.length && words.every(w => w.confidence !== null) ? Math.min(...words.map(w => w.confidence)) : null;
    return { text: linha.text.slice(start, end).replace(/^[\s:.=\-–]+/, '').trim(), bbox: juntarBboxes(words.map(w => w.bbox)), confidence, index: linha.index, start, end };
  }
  // USO: detectarRotulos(linha com 'Placa: ABC1234 Valor original: 195,23') → duas regiões delimitadas.
  function detectarRotulos(linha, emDescricao) {
    const text = normalizar(linha.text), labels = [];
    for (const regra of REGRAS) {
      regra.re.lastIndex = 0;
      let m;
      while ((m = regra.re.exec(text))) {
        if (labels.some(l => m.index < l.end && m.index + m[0].length > l.start)) continue;
        labels.push({ campos: regra.campos, start: m.index, end: m.index + m[0].length, ...trecho(linha, m.index, m.index + m[0].length) });
      }
    }
    const sorted = labels.sort((a, b) => a.start - b.start), descricao = sorted.find(l => l.campos.includes('descricao'));
    const verbal = inicioDescricao(linha.text), proseStart = emDescricao ? 0 : descricao ? descricao.end : verbal;
    return sorted.filter((label, i) => {
      const before = linha.text.slice(0, label.start), after = linha.text.slice(label.end), colon = /^\s*:/.test(after);
      const first = !compactar(before), word = linha.words.find(w => w.start <= label.start && w.end > label.start);
      const previousWord = word && linha.words[linha.words.indexOf(word) - 1];
      const gap = word?.bbox && previousWord?.bbox && word.bbox.x0 - previousWord.bbox.x1 > Math.max(12, word.bbox.y1 - word.bbox.y0) * 3;
      const inProse = proseStart >= 0 && label.start >= proseStart;
      if (label.campos.includes('descricao') && (!inProse || first || colon || gap)) return true;
      const grammar = normalizar(compactar(before || (typeof emDescricao === 'string' ? emDescricao : '')));
      // "na faixa 2" e "com placa ABC1234" continuam sendo descrição, mesmo com valores de formato válido.
      const partialDescription = /^descricao(?:\s+(?:da|de))?$/.test(grammar);
      if (inProse && !gap && !partialDescription && /\b(?:com|sem|na|no|nas|nos|da|do|das|dos|de|ao|aos|a|as|o|os|pela|pelo|pelas|pelos|ou|por)\s*$/.test(grammar)) return false;
      // Dentro da prosa, uma palavra como "placa" ou "faixa" não é por si só metadado.
      const value = after.replace(/^[\s:.=\-–]+/, '');
      const typed = label.campos.includes('placa') ? /^[A-Z0-9]{3}[\s-]?[A-Z0-9]{4,6}\b/i.test(value) && /\d/.test(value.split(/\s/)[0])
        : label.campos.includes('autoInfracao') ? /^[A-Z0-9?!|]{4,24}\b/i.test(value) && /\d/.test(value.split(/\s/)[0])
        : label.campos.includes('codigoInfracao') ? /^\d{3,4}\s*[-–.]?\s*[0-9OQD]\b/i.test(value)
        : label.campos.includes('valor') ? /^(?:R\$\s*)?\d[\d.,]*(?:\s|$)/i.test(value)
        : label.campos.includes('cidadeEstado') ? /^[\p{L}\s.-]+\/[A-Z]{2}\b/u.test(value) && UFS.has(value.match(/\/([A-Z]{2})\b/u)?.[1])
        : label.campos.some(c => /^data/.test(c)) || /^(?:data|hora|horario|cometimento)\b/.test(normalizar(label.text)) ? /^\d{2}\s*[/.-]?\s*\d{2}\s*[/.-]?\s*\d{4}\b/.test(value)
        : normalizar(label.text) === 'uf' ? /^[A-Z]{2}$/.test(value)
        : /^(?:renavam|renainf|faixa)$/.test(normalizar(label.text)) ? /^\d+\b/.test(value) : false;
      if (gap || typed && (!inProse || label.campos.length > 0 || first && (/^\d+$/.test(value) || normalizar(label.text) === 'uf'))) return true;
      if (inProse) return first && label.campos.length > 0 && !compactar(after)
        || first && label.campos.length > 0 && normalizar(label.text).split(/\s+/).length > 1
        || first && /^(?:marca\s*\/\s*modelo|renavam|renainf)$/.test(normalizar(label.text))
        || colon && (first || label.campos.length > 0 && normalizar(label.text).split(/\s+/).length > 1);
      if (first || colon) return true;
      // Conserva delimitadores lado a lado depois de um código inequívoco, sem cortar endereços/frases.
      const previous = sorted[i - 1];
      return previous && !previous.campos.includes('descricao') && previous.campos.some(c => ['placa', 'autoInfracao', 'codigoInfracao', 'valor', 'dataInfracao', 'dataNotificacao', 'dataVencimento'].includes(c));
    });
  }
  // USO: combinarFontes([trecho1,trecho2],rotulo) → uma região com texto e confiança mínima de ambos.
  function combinarFontes(parts, label) {
    const confidences = [...parts.map(p => p.confidence), label ? label.confidence : null];
    return { text: compactar(parts.map(p => p.text).join(' ')), bbox: juntarBboxes(parts.map(p => p.bbox)), confidence: confidences.every(c => c !== null) ? Math.min(...confidences) : null, label: label ? label.text : '', inferido: !label };
  }
  // USO: partesDescricao(linhas,0,trechoInicial,rotulo,limiteX) junta uma descrição mobile de 6 linhas,
  //      parando no próximo campo/cabeçalho; palavras da outra coluna não entram no valor.
  function partesDescricao(linhas, index, initial, label, right) {
    const first = linhas[index], parts = /[\p{L}\d]/u.test(initial.text) && !/^(?:da|de)$/.test(normalizar(initial.text)) ? [initial] : [];
    const anchor = label?.bbox || initial.bbox || first.bbox;
    let previous = first.bbox, length = initial.text.length;
    for (let n = index + 1; n < linhas.length && n <= index + 24 && length < 3000; n++) {
      const next = linhas[n];
      let part = trecho(next, 0, next.text.length);
      if (anchor && next.bbox) {
        const heights = first.words.filter(w => w.bbox).map(w => w.bbox.y1 - w.bbox.y0);
        const height = Math.max(12, heights.length ? Math.min(...heights) : anchor.y1 - anchor.y0);
        if (next.bbox.y0 > (previous || anchor).y1 + height * 3) break;
        if (next.bbox.y0 < anchor.y0 - height / 2 || next.bbox.x1 < anchor.x0 - height || next.bbox.x0 >= right) continue;
        let words = next.words.filter(w => w.bbox && w.bbox.x0 >= anchor.x0 - height && w.bbox.x0 < right);
        if (words.length && words[0].bbox.x0 > anchor.x0 + height * 4) continue;
        const gap = words.findIndex((w, k) => k && w.bbox.x0 - words[k - 1].bbox.x1 > height * 3);
        if (gap > 0) words = words.slice(0, gap);
        if (words.length) part = trecho(next, words[0].start, words.at(-1).end);
        else if (next.words.length || next.bbox.x0 > anchor.x0 + height * 4) continue;
      }
      if (cabecalhoDescricao(part.text) || parts.length && inicioDescricao(part.text) >= 0) break;
      const boundaries = detectarRotulos(next, parts.at(-1)?.text || true).filter(l => !part.bbox || !l.bbox || l.bbox.x0 >= part.bbox.x0 && l.bbox.x0 < part.bbox.x1);
      if (boundaries.length) {
        part = trecho(next, part.start, boundaries[0].start);
      }
      if (part.text) { parts.push(part); length += part.text.length; previous = part.bbox || next.bbox || previous; }
      if (boundaries.length) break;
    }
    return parts;
  }
  // USO: coletarFontes(linhas) → {placa:[{text:'ABC1234',label:'Placa',bbox,...}],...}; nunca atravessa outro rótulo.
  function coletarFontes(linhas) {
    const fontes = Object.fromEntries(Object.keys(ROTULOS).map(k => [k, []]));
    Object.defineProperty(fontes, 'associadas', { value: [] });
    let labels = linhas.map(l => detectarRotulos(l));
    const descriptionParts = [];
    // Coleta a descrição primeiro: códigos citados na sua prosa não podem virar campos independentes.
    linhas.forEach((linha, i) => labels[i].forEach((label, j) => {
      if (!label.campos.includes('descricao')) return;
      const same = trecho(linha, label.end, labels[i][j + 1]?.start ?? linha.text.length);
      const parts = partesDescricao(linhas, i, same, label, labels[i][j + 1]?.bbox?.x0 ?? Infinity);
      if (!parts.length) return;
      const fonte = combinarFontes(parts, label);
      descriptionParts.push(...parts);
      fontes.descricao.push(fonte); fontes.associadas.push(fonte);
    }));
    // O CDT usa a própria infração como título. Só verbos conhecidos, nunca cabeçalhos da notificação.
    if (!fontes.descricao.length) linhas.forEach((l, i) => {
      const start = inicioDescricao(l.text);
      if (start < 0 || labels[i].some(label => label.start <= start)) return;
      const boundary = labels[i].find(label => label.start > start);
      const parts = partesDescricao(linhas, i, trecho(l, 0, boundary?.start ?? l.text.length), null, boundary?.bbox?.x0 ?? Infinity);
      const fonte = combinarFontes(parts, null);
      descriptionParts.push(...parts);
      fontes.descricao.push(fonte); fontes.associadas.push(fonte);
    });
    labels = labels.map((ls, i) => ls.filter(label => !descriptionParts.some(p => p.index === linhas[i].index && label.start >= p.start && label.end <= p.end)));
    linhas.forEach((linha, i) => labels[i].forEach((label, j) => {
      if (label.campos.includes('descricao')) return;
      let parts = [];
      const same = trecho(linha, label.end, labels[i][j + 1] ? labels[i][j + 1].start : linha.text.length);
      if (same.text) parts.push(same);
      const right = labels[i][j + 1] && labels[i][j + 1].bbox ? labels[i][j + 1].bbox.x0 : Infinity;
      const multiline = label.campos.includes('local') || label.campos.includes('orgaoAutuador');
      // Tabela (portal SENATRAN): rótulo numa coluna e valor em outra, na MESMA linha e bem afastado.
      // A continuação de um valor quebrado fica na coluna do valor; linha com texto na coluna dos
      // rótulos já é a próxima linha da tabela ("Órgão Competente/Responsável" depois do "Órgão Autuador").
      const alturaLinha = linha.bbox ? Math.max(12, linha.bbox.y1 - linha.bbox.y0) : 12;
      const tabela = !!(same.text && same.bbox && label.bbox && same.bbox.x0 - label.bbox.x1 > alturaLinha * 3);
      const ancora = tabela ? same.bbox : label.bbox;
      if (!parts.length || multiline) {
        for (let n = i + 1; n < linhas.length && n <= i + (multiline ? 4 : 3); n++) {
          const next = linhas[n];
          if (linha.bbox && next.bbox && label.bbox) {
            const height = Math.max(12, linha.bbox.y1 - linha.bbox.y0);
            if (next.bbox.y0 > linha.bbox.y1 + height * (multiline ? 6 : 4)) break;
            if (tabela && next.words.some(w => w.bbox && w.bbox.x1 > label.bbox.x0 - height && w.bbox.x0 < ancora.x0 - height)) break;
            // Uma linha de outra coluna não pode fornecer o valor deste rótulo.
            if (next.bbox.y0 < linha.bbox.y0 - height / 2 || next.bbox.x1 < ancora.x0 - height || next.bbox.x0 >= right) continue;
            let regionWords = next.words.filter(w => w.bbox && w.bbox.x0 >= ancora.x0 - height && w.bbox.x0 < right);
            if (regionWords.length && regionWords[0].bbox.x0 > ancora.x0 + height * 4) continue;
            const gap = regionWords.findIndex((w, k) => k && w.bbox.x0 - regionWords[k - 1].bbox.x1 > height * 4);
            if (gap > 0) regionWords = regionWords.slice(0, gap);
            const regionRight = gap > 0 && regionWords.length ? regionWords.at(-1).bbox.x1 : right;
            const relevant = labels[n].filter(l => !l.bbox || (l.bbox.x0 >= label.bbox.x0 - height && l.bbox.x0 < regionRight));
            if (relevant.length) break;
            if (regionWords.length) parts.push(trecho(next, regionWords[0].start, regionWords[regionWords.length - 1].end));
            else if (!next.words.length && next.bbox.x0 >= ancora.x0 - height && next.bbox.x0 <= ancora.x0 + height * 4 && next.bbox.x0 < right) parts.push(trecho(next, 0, next.text.length));
          } else {
            if (labels[n].length) break;
            parts.push(trecho(next, 0, next.text.length));
          }
          if (parts.length && !multiline) break;
        }
      }
      if (parts.length) {
        const fonte = combinarFontes(parts, label);
        fontes.associadas.push(fonte);
        label.campos.forEach(c => fontes[c].push(fonte));
      }
    }));
    return fontes;
  }
  // USO: tokenAssociado({text:'ABC1234',bbox:null}, [{text:'ABC1234',bbox:null}]) → true.
  //      Exclui do fallback de placa os valores já pertencentes a outro campo ou rótulo auxiliar.
  function tokenAssociado(token, fontes) {
    return fontes.some(fonte => {
      if (token.bbox && fonte.bbox) return token.bbox.x0 < fonte.bbox.x1 && token.bbox.x1 > fonte.bbox.x0 && token.bbox.y0 < fonte.bbox.y1 && token.bbox.y1 > fonte.bbox.y0;
      return (String(fonte.text || '').toUpperCase().match(/\b[A-Z0-9]{7,9}\b/g) || []).includes(token.text.toUpperCase());
    });
  }
  // USO: confunde('O','Q') → true; confunde('A','C') → false.
  function confunde(a, b) { return a === b || GRUPOS.some(g => g.includes(a) && g.includes(b)); }
  // USO: normalizarPlaca('abc-1234') → 'ABC1234'.
  function normalizarPlaca(s) { return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); }
  // USO: brutoPlaca('KDR OE17') → 'KDROE17'; brutoPlaca('HBO1/08') → 'HBO1I08'.
  function brutoPlaca(s) {
    let valor = '';
    for (const word of String(s || '').toUpperCase().split(/\s+/)) {
      valor += word.replace(/(?<=[A-Z0-9])[|!/](?=[A-Z0-9])/g, 'I').replace(/[^A-Z0-9]/g, '');
      if (valor.length >= 7) break;
    }
    return valor;
  }
  // USO: alinharPlaca('KDROE1I7','KDR0E17') → {trocas:1,extras:1,plausivel:true}.
  function alinharPlaca(lida, placa) {
    const extras = lida.length - 7;
    if (extras < 0 || extras > 2) return null;
    let best = null;
    // USO: ir(0,0,0,0,true) percorre alinhamentos, limitando duas trocas e os extras presentes.
    function ir(i, j, pulos, trocas, plausivel) {
      if (trocas > 2 || pulos > extras) return;
      if (j === 7 && i === lida.length) {
        const candidate = { trocas, extras: pulos, plausivel };
        if (!best || (candidate.plausivel && !best.plausivel) || candidate.plausivel === best.plausivel && candidate.trocas < best.trocas) best = candidate;
        return;
      }
      if (i >= lida.length) return;
      if (j < 7 && confunde(lida[i], placa[j])) ir(i + 1, j + 1, pulos, trocas + (lida[i] === placa[j] ? 0 : 1), plausivel);
      if (pulos < extras) {
        const repetido = confunde(lida[i], lida[i - 1] || '') || confunde(lida[i], lida[i + 1] || '');
        ir(i + 1, j, pulos + 1, trocas, plausivel && repetido);
      }
    }
    ir(0, 0, 0, 0, true);
    return best;
  }
  // USO: placasPeloFormato('KDROE17') → ['KDR0E17']; sem a Frota estes resultados exigem revisão.
  function placasPeloFormato(raw) {
    const achadas = new Set();
    // USO: reduzir('KDROE1I7',1) tenta excluir um extra antes de validar as posições da placa.
    function reduzir(s, rest) {
      if (rest) { for (let i = 0; i < s.length; i++) reduzir(s.slice(0, i) + s.slice(i + 1), rest - 1); return; }
      let valor = '', trocas = 0;
      for (let i = 0; i < 7; i++) {
        let c = s[i];
        if (i < 3 && !/[A-Z]/.test(c)) { c = LETRAS[c]; trocas++; }
        if ((i === 3 || i >= 5) && !/\d/.test(c)) { c = NUMEROS[c]; trocas++; }
        if (!c || trocas > 2) return;
        valor += c;
      }
      if (validar('placa', valor)) achadas.add(valor);
    }
    if (raw.length >= 7 && raw.length <= 9) reduzir(raw, raw.length - 7);
    return [...achadas].sort();
  }
  // USO: resolverPlaca([{text:'EOW5J72',...}], {placas:['EQW5J72'],frotaDisponivel:true}) → placa clara da Frota.
  function resolverPlaca(fontes, contexto) {
    const field = campoVazio('placa');
    const sources = fontes.map(f => ({ ...f, raw: brutoPlaca(f.text) })).filter(f => f.raw.length >= 7 && f.raw.length <= 9);
    if (!sources.length) {
      if (fontes.length) {
        const source = fontes[0];
        Object.assign(field, { valor: brutoPlaca(source.text) || source.text, original: source.text, bbox: source.bbox, confianca: source.confidence, estado: 'revisar', motivo: 'A placa lida está incompleta ou ilegível. Corrija ou descarte a sugestão.' });
      }
      return field;
    }
    const registered = contexto.frotaDisponivel === false ? [] : [...new Set((contexto.placas || []).map(normalizarPlaca).filter(p => validar('placa', p)))].sort();
    const exatas = [...new Set(sources.map(s => s.raw).filter(p => registered.includes(p)))].sort();
    const matches = exatas.length ? exatas.map(p => ({ placa: p, fonte: sources.find(s => s.raw === p), match: { trocas: 0, extras: 0, plausivel: true } })) : registered.flatMap(p => {
      const candidates = sources.map(s => ({ placa: p, fonte: s, match: alinharPlaca(s.raw, p) })).filter(c => c.match);
      candidates.sort((a, b) => Number(b.match.plausivel) - Number(a.match.plausivel) || a.match.trocas - b.match.trocas);
      return candidates.length ? [candidates[0]] : [];
    });
    const source = matches.length === 1 ? matches[0].fonte : sources[0];
    Object.assign(field, { original: source.text, bbox: source.bbox, confianca: source.confidence, estado: 'revisar' });
    if (matches.length === 1) {
      const chosen = matches[0];
      field.valor = chosen.placa; field.frota = true;
      if (chosen.match.trocas) field.correcoes.push(`${chosen.match.trocas} caractere(s) conferido(s) com a Frota.`);
      if (chosen.match.extras) field.correcoes.push(`${chosen.match.extras} caractere(s) extra(s) removido(s).`);
      field.estado = chosen.match.plausivel && !source.inferido ? 'claro' : 'revisar';
      field.motivo = source.inferido ? 'Placa da Frota encontrada sem rótulo de placa. Confira se o trecho identifica o veículo.' : chosen.match.plausivel ? 'Identificada pela Frota.' : 'Placa compatível com a Frota, mas a remoção de caracteres precisa de conferência.';
    } else if (matches.length > 1) {
      field.alternativas = matches.map(m => m.placa).sort();
      field.bbox = juntarBboxes(matches.map(m => m.fonte.bbox));
      field.original = [...new Set(matches.map(m => m.fonte.text))].join(' | ');
      field.motivo = 'Mais de uma placa da Frota é compatível. Escolha o veículo.';
    } else {
      const values = [...new Set(sources.flatMap(s => placasPeloFormato(s.raw)))].sort();
      field.valor = values.length > 1 ? '' : values.length === 1 ? values[0] : source.raw;
      field.alternativas = values.length > 1 ? values : [];
      if (field.valor && field.valor !== source.raw) field.correcoes.push('Caracteres ajustados ao formato de placa; confirme a leitura.');
      if (values.length > 1) {
        field.bbox = juntarBboxes(sources.map(s => s.bbox));
        field.original = [...new Set(sources.map(s => s.text))].sort().join(' | ');
        field.motivo = 'Mais de uma placa foi lida. Escolha o veículo.' + (contexto.frotaDisponivel === false ? ' Comparação com a Frota indisponível.' : ' Placas não encontradas na Frota.');
      } else field.motivo = contexto.frotaDisponivel === false ? 'Comparação com a Frota indisponível. Confira a placa.' : 'Placa não encontrada na Frota. Confira a leitura.';
    }
    return field;
  }
  // USO: dataReal('29/02/2024') → true; dataReal('31/02/2026') → false.
  function dataReal(s) {
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(s);
    if (!m || +m[3] < 1000) return false;
    const d = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1]));
    return d.getUTCFullYear() === +m[3] && d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[1];
  }
  // USO: validar('horaInfracao','23:59') → true; validar('dataInfracao','31/02/2026') → false.
  function validar(campo, valor) {
    const s = compactar(valor);
    if (!s) return false;
    if (campo === 'placa') return /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(s);
    if (/^data/.test(campo)) return dataReal(s);
    if (campo === 'horaInfracao') return /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(s);
    if (campo === 'valor') return /^\d+(?:\.\d{1,2})?$/.test(s) && Number(s) > 0;
    if (campo === 'autoInfracao') return /^[A-Z0-9]{4,24}$/.test(s) && /\d/.test(s);
    if (campo === 'codigoInfracao') return /^\d{3,4}-\d$/.test(s);
    if (campo === 'descricao') return /[A-Za-zÀ-ÿ]/.test(s) && s.length >= 8
      && !cabecalhoDescricao(s)
      && !/^(?:descricao(?:\s+(?:da|de)(?:\s+infracao)?)?|(?:(?:da|de)\s+)?infracao)\s*[:.,;–-]*$/.test(normalizar(s));
    if (campo === 'cidadeEstado') { const uf = s.match(/\/([A-Z]{2})$/); return /[A-Za-zÀ-ÿ]{2}/.test(s) && (!uf || UFS.has(uf[1])); }
    return Object.hasOwn(ROTULOS, campo) && /[A-Za-zÀ-ÿ]/.test(s);
  }
  // USO: normalizarEdicao('placa','abc-1234') → 'ABC1234'; ('valor','R$ 1.234,56') → '1234.56'.
  //      ('codigoInfracao','5002 - O') → '5002-O' (não infere zero: validar ainda rejeita).
  function normalizarEdicao(campo, valor) {
    const s = String(valor == null ? '' : valor).trim();
    if (campo === 'placa') return s.toUpperCase().replace(/[\s-]/g, '');
    if (campo === 'autoInfracao') return s.toUpperCase().replace(/\s/g, '');
    if (campo === 'codigoInfracao') return s.toUpperCase().replace(/\s*[-–]\s*/g, '-');
    if (campo === 'valor') {
      const numeric = s.replace(/^R\$\s*/i, '');
      if (/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(numeric)) return String(Number(numeric.replace(/\./g, '').replace(',', '.')));
      if (/^\d+(?:\.\d{1,2})?$/.test(numeric)) return numeric;
    }
    return s;
  }
  // USO: limparDescricao('• RECUSAR-SE A TESTE • QUE PERMITA CERTIFICAR')
  //      → 'RECUSAR-SE A TESTE QUE PERMITA CERTIFICAR', sem modificar palavras ou consultar histórico.
  function limparDescricao(text) {
    let s = compactar(text).replace(/(?:^|\s)[•●◦▪▫*]+\s*/g, ' ');
    const start = inicioDescricao(s);
    if (start > 0) s = s.slice(start);
    return compactar(s);
  }
  // USO: chaveDescricao('Conduzir veículo, sem CNH.') === chaveDescricao('CONDUZIR VEICULO SEM CNH').
  //      'com CNH' permanece outra chave; números, % e barras são preservados.
  function chaveDescricao(text) {
    return compactar(normalizar(text).replace(/[.,;:!?"'“”‘’()[\]{}]/g, ' ').replace(/(?<=[\p{L}])[-–—](?=[\p{L}])/gu, ' '));
  }
  // USO: deduplicarDescricoes([{valor:'Veículo sem CNH'}, {valor:'VEICULO SEM CNH.'}])
  //      → um candidato já lido; acentos são preferidos, sem agrupar "com" com "sem".
  function deduplicarDescricoes(candidatos) {
    const groups = new Map();
    const sorted = [...candidatos].sort((a, b) => {
      const aAccents = (a.valor.normalize('NFD').match(/[\u0300-\u036f]/g) || []).length;
      const bAccents = (b.valor.normalize('NFD').match(/[\u0300-\u036f]/g) || []).length;
      return bAccents - aAccents || a.valor.localeCompare(b.valor, 'pt-BR');
    });
    for (const candidate of sorted) {
      const key = chaveDescricao(candidate.valor);
      if (!groups.has(key)) groups.set(key, candidate);
    }
    return [...groups.values()];
  }
  // Cidade em formato de nome, como era antes do interpretador: o portal escreve tudo em maiúsculas.
  // USO: nomeCidade('SÃO JOSÉ DOS CAMPOS/SP') → 'São José dos Campos/SP'; ('ARACAJU') → 'Aracaju';
  //      nomeCidade('recife / pe') → 'Recife/PE'
  function nomeCidade(text) {
    const m = compactar(text).match(/^(.*?)\s*(?:\/\s*([A-Za-z]{2}))?$/);
    const conectivos = new Set(['de', 'da', 'do', 'das', 'dos', 'e', "d'"]);
    const nome = (m ? m[1] : compactar(text)).toLowerCase().split(' ')
      .map((w, i) => (i && conectivos.has(w) ? w : w.replace(/^\p{L}/u, c => c.toUpperCase())))
      .map(w => w.replace(/-(\p{L})/gu, (_, c) => '-' + c.toUpperCase()))
      .join(' ');
    return m && m[2] ? nome + '/' + m[2].toUpperCase() : nome;
  }
  // USO: transformar('valor','R$ 1.234,56') → [{valor:'1234.56',correcoes:[]}]; '19523' sugere 195.23 com correção.
  function transformar(campo, text) {
    const s = compactar(text), resultados = [];
    // USO: add('195.23',[]) registra um valor candidato válido sem corrigir conteúdo.
    function add(valor, correcoes) { if (valor) resultados.push({ valor, correcoes: correcoes || [] }); }
    if (/^data/.test(campo)) {
      for (const m of s.matchAll(/\b(\d{2})\s*([/.-]?)\s*(\d{2})\s*([/.-]?)\s*(\d{4})\b/g)) add(`${m[1]}/${m[3]}/${m[5]}`, m[2] === '/' && m[4] === '/' ? [] : ['Separadores da data reconstruídos.']);
    } else if (campo === 'horaInfracao') {
      const semDatas = s.replace(/\b\d{2}\s*[/.-]\s*\d{2}\s*[/.-]\s*\d{4}\b/g, ' ');
      for (const m of semDatas.matchAll(/\b(\d{1,2})\s*([:h.])\s*(\d{2})(?:\s*:\s*\d{2})?\b/g)) add(`${m[1].padStart(2, '0')}:${m[3]}`, m[2] === ':' ? [] : ['Separador do horário reconstruído.']);
      if (!resultados.length) for (const m of semDatas.matchAll(/\b(\d{2})(\d{2})\b/g)) add(`${m[1]}:${m[2]}`, ['Separador do horário reconstruído.']);
    } else if (campo === 'valor') {
      const joined = s.replace(/(?<=\d)\s+(?=\d{3}(?:[,.\s]|$))/g, '');
      for (const m of joined.matchAll(/(?<![\w.,])\d[\d.,]*(?![\w.,])/g)) {
        if (/^\s*%/.test(joined.slice(m.index + m[0].length))) continue;
        const token = m[0];
        if (/^\d{1,3}(?:\.\d{3})*,\d{2}$/.test(token) || /^\d+,\d{2}$/.test(token)) add(String(Number(token.replace(/\./g, '').replace(',', '.'))));
        else if (/^\d+\.\d{2}$/.test(token)) add(String(Number(token)));
        else if (/^\d{3,}$/.test(token)) add(String(Number(token) / 100), ['Separador decimal ausente; centavos inferidos.']);
        else add(token.replace(',', '.'), ['Formato monetário incompleto ou inválido. Confira o valor.']);
      }
    } else if (campo === 'autoInfracao') {
      const raw = s.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '').toUpperCase();
      const original = raw.replace(/\s/g, ''), fixed = original.replace(/\?/g, '2').replace(/[|!]/g, '1').replace(/[^A-Z0-9]/g, '').replace(/^([A-Z]+?)([OQ]+)(\d+)$/, (_, prefix, zeros, nums) => prefix + zeros.replace(/[OQ]/g, '0') + nums);
      add(fixed, fixed !== original ? ['Caracteres do auto corrigidos; confira o código.'] : []);
    } else if (campo === 'codigoInfracao') {
      const m = s.match(/\b(\d{3,4})\s*[-–.]?\s*([0-9OQD])\b/i);
      if (m) add(`${m[1]}-${m[2].replace(/[OQD]/i, '0')}`, /[OQD]/i.test(m[2]) ? ['Letra interpretada como zero no código da infração.'] : []);
    } else if (campo === 'descricao') {
      const lower = limparDescricao(s).toLowerCase().replace(/[\p{L}]+/gu, w => SIGLAS.has(w.toUpperCase()) ? w.toUpperCase() : w);
      add(lower.charAt(0).toUpperCase() + lower.slice(1));
    } else if (campo === 'cidadeEstado') {
      add(nomeCidade(s));
    } else if (campo === 'local') {
      const fixed = s.replace(/\bOD(?=\s*\d)/g, 'QD').replace(/\bBL([A-Z])\b/g, 'BL $1');
      add(fixed, fixed !== s ? ['Abreviação do endereço corrigida; confira o local.'] : []);
    } else add(s);
    return resultados;
  }
  // USO: resolverCampo('dataInfracao',[fonte '31/02/2026']) → estado revisar e motivo data inválida.
  function resolverCampo(campo, fontes) {
    const field = campoVazio(campo), candidatos = fontes.flatMap(f => transformar(campo, f.text).map(v => ({ ...v, fonte: f })));
    if (!candidatos.length) {
      if (fontes.length) {
        const source = fontes[0];
        Object.assign(field, { valor: source.text, original: source.text, bbox: source.bbox, confianca: source.confidence, estado: 'revisar', motivo: 'O rótulo foi encontrado, mas o valor não pôde ser interpretado. Corrija ou descarte a sugestão.' });
      }
      return field;
    }
    const validos = candidatos.filter(c => validar(campo, c.valor));
    // Duplicatas da descrição podem perder acentos/pontuação no OCR; escolhe-se um texto lido, nunca um parecido.
    const unicos = campo === 'descricao' ? deduplicarDescricoes(validos) : validos;
    const valores = [...new Set(unicos.map(c => c.valor))].sort();
    const selected = unicos[0] || candidatos[0], source = selected.fonte;
    Object.assign(field, { valor: valores.length > 1 ? '' : selected.valor, original: source.text, bbox: source.bbox, confianca: source.confidence, correcoes: selected.correcoes, estado: 'revisar' });
    if (!validos.length) field.motivo = 'O valor lido é inválido. Corrija ou descarte a sugestão.';
    else if (valores.length > 1) { field.alternativas = valores; field.bbox = juntarBboxes(validos.map(c => c.fonte.bbox)); field.original = [...new Set(validos.map(c => c.fonte.text))].join(' | '); field.motivo = 'Foram encontrados valores diferentes para o mesmo campo.'; }
    else if (candidatos.some(c => !validar(campo, c.valor))) field.motivo = 'Há uma leitura conflitante ou inválida para este campo.';
    else if (selected.correcoes.length) field.motivo = 'A leitura precisou de correção. Confira o valor.';
    else if (source.inferido) field.motivo = 'Valor sugerido sem rótulo inequívoco. Confira o trecho.';
    else if (source.confidence === null) field.motivo = 'A confiança das palavras não está disponível. Confira o trecho.';
    else if (source.confidence < 85) field.motivo = 'A leitura tem baixa confiança. Confira o trecho.';
    else { field.estado = 'claro'; field.motivo = 'Leitura válida associada ao rótulo do campo.'; }
    return field;
  }
  // USO: analisar(ocr.data,{placas:['KDR0E17'],frotaDisponivel:true}) → {campos:{placa:{...},...},texto:'...'}.
  function analisar(data, contexto) {
    contexto = contexto || {};
    const linhas = juntarRotuloDescricao(juntarRotuloCometimento(lerLinhas(data))), fontes = coletarFontes(linhas);
    // Sem rótulo de placa, somente tokens livres com letras/números; auto, modelo e outros campos não viram placa.
    if (!fontes.placa.length) linhas.forEach(l => {
      if (detectarRotulos(l).length) return;
      const re = /\b[A-Z0-9]{7,9}\b/gi;
      let m;
      while ((m = re.exec(l.text))) if (/[A-Z]/i.test(m[0]) && /\d/.test(m[0])) {
        const token = trecho(l, m.index, m.index + m[0].length);
        if (!tokenAssociado(token, fontes.associadas)) fontes.placa.push({ ...token, label: '', inferido: true });
      }
    });
    const campos = Object.fromEntries(Object.keys(ROTULOS).map(c => [c, c === 'placa' ? resolverPlaca(fontes[c], contexto) : resolverCampo(c, fontes[c])]));
    // Cidade pode ser sugerida pelo final do local e uma UF explícita, mas nunca promovida por inferência.
    if (campos.cidadeEstado.estado === 'naoEncontrado' && campos.local.valor) {
      const parts = campos.local.valor.split(/\s+-\s+/), last = parts[parts.length - 1];
      const ufMatch = `${campos.local.valor} ${campos.orgaoAutuador.valor}`.toUpperCase().match(/\b[A-Z]{2}\b/g) || [], uf = ufMatch.find(v => UFS.has(v));
      if (parts.length > 1 && /^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ\s]{2,}$/.test(last)) campos.cidadeEstado = resolverCampo('cidadeEstado', [{ text: last + (uf ? '/' + uf : ''), bbox: campos.local.bbox, confidence: campos.local.confianca, inferido: true, label: '' }]);
    }
    return { campos, texto: typeof data === 'string' ? data : String((data && data.text) || linhas.map(l => l.text).join('\n')) };
  }
  // USO: analisarRecorte('valor',{text:'R$ 195,23'},{}) → {valor:'195.23',estado:'revisar',...}.
  //      O estado diagnostica a releitura; o chamador decide o preenchimento automático de valores válidos e únicos.
  function analisarRecorte(campo, data, contexto) {
    if (!Object.hasOwn(ROTULOS, campo)) return campoVazio(campo);
    const resultado = analisar(data, contexto).campos[campo], linhas = lerLinhas(data);
    let field = resultado;
    if (field.estado === 'naoEncontrado') {
      const source = combinarFontes(linhas.map(l => trecho(l, 0, l.text.length)), null);
      field = campo === 'placa' ? resolverPlaca([source], contexto || {}) : resolverCampo(campo, [source]);
    }
    if (field.estado !== 'naoEncontrado') { field.estado = 'revisar'; field.motivo = 'Releitura do trecho. Conferência opcional disponível.'; }
    return field;
  }

  return Object.freeze({ ROTULOS, analisar, analisarRecorte, validar, normalizarEdicao });
});
