#!/usr/bin/env node
/**
 * scripts/auditoria-design.mjs — auditoria VISUAL do Design System: abre o site num navegador
 * de verdade e mede o que a tela realmente pinta (getComputedStyle), em vez de ler o CSS-fonte.
 *
 * Por que medir no navegador: a correção do DS é sempre por SOBRESCRITA (styles.css nunca é
 * editado), então o CSS-fonte tem o valor antigo e o novo ao mesmo tempo — só o valor computado
 * diz qual venceu. É assim que se acha o que ainda usa o desenho antigo.
 *
 * O que é "antigo": qualquer valor de forma/cor/sombra/borda FORA da escala de tokens `--ds-*`.
 * A escala não está copiada aqui — é lida do :root da própria página, então acompanha
 * 01-tokens.css sozinha.
 *
 * Sobe um servidor efêmero (porta livre, dados fictícios do seed) e derruba tudo ao terminar —
 * não toca a pasta data/ do seu ambiente, igual ao scripts/screenshots.mjs.
 *
 * USO (da pasta do projeto):
 *   node scripts/auditoria-design.mjs                      # grava screenshots/auditoria-antes.json
 *   node scripts/auditoria-design.mjs --modo depois        # ...-depois.json (para comparar)
 *   node scripts/auditoria-design.mjs --tabs frota,multas  # só essas abas
 *   node scripts/auditoria-design.mjs --tema escuro        # o padrão é claro
 *   node scripts/auditoria-design.mjs --todos              # não filtra as exceções registradas
 *
 * Exemplo de leitura da saída:
 *   47x  .vd-inp                  borderRadius  7px      (frota)
 *   ↑ nº de elementos ↑ classe    ↑ propriedade ↑ valor   ↑ onde aparece
 *   => 47 campos das sub-abas de Frota estão com 7px onde o token de controle manda 4px.
 */
import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Porta 3212. CONVENÇÃO DE FAIXAS: a pasta `test/` fica em 3196-3209 (uma por arquivo — o
// `node --test` roda os arquivos em processos PARALELOS) e as pastas `e2e/` e `scripts/` ficam em
// 3210+, para que as duas suítes possam rodar ao mesmo tempo. Era 3197, disputada com test/almoxarifado.test.js e o e2e do design-v2.
// `test/portas.test.js` cobra unicidade e faixa — não escolha porta "no olho".
const PORT = 3212;
const BASE = `http://localhost:${PORT}`;

function argv(flag, padrao) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : padrao;
}
const MODO = argv('--modo', 'antes');
const TEMA = argv('--tema', 'claro');
const FILTRO_ABAS = argv('--tabs', null)?.split(',').map((s) => s.trim()).filter(Boolean) || null;
const SEM_FILTRO_EXCECOES = process.argv.includes('--todos');
const SAIDA = path.join(RAIZ, 'screenshots', `auditoria-${MODO}.json`);

/**
 * Exceções visuais REGISTRADAS em docs/DESIGN.md §11.4 e as pendências com motivo (§ do mesmo
 * doc + 05-components.css). Não são desvio: são decisão. A auditoria as separa em vez de
 * escondê-las — saem no relatório numa lista própria, com o motivo.
 */
const EXCECOES = [
  ['placa-chip', 'placa Mercosul — artefato regulado (§11.4)'],
  ['logo', 'marca da empresa (§11.4)'],
  ['brand-text', 'marca da empresa (§11.4)'],
  ['cstd-destaque', 'exceção registrada (§11.4)'],
  ['cartao-cc', 'representa um cartão físico (§11.4)'],
  ['sw-', 'tela de manutenção do service worker (§11.4)'],
  ['dev-pill', 'painel interno de diagnóstico, fora de .ds-modulo'],
  ['almox-pill', 'tag composta (marca + qtd) — pendência registrada'],
  ['epi-est', 'tag composta — pendência registrada'],
  ['campo-travado', 'bloqueado por !important legado — pendência registrada'],
  ['veic-doc-box', 'candidato a desaparecer, não a virar padrão'],
  ['barra-progresso', 'barra de progresso: cápsula é a forma correta'],
  ['skel', 'esqueleto de carregamento'],
  ['toast', 'notificação flutuante — forma própria registrada'],
  // 3º item (opcional) limita a exceção a UMA propriedade: o tile da logo mantém a cor da marca,
  // mas continua tendo de obedecer ao raio do sistema.
  ['contr-crono-progresso', 'sombra lateral da coluna congelada: separador funcional, não elevação', 'boxShadow'],
  ['func-empresa-logo', 'tile da marca da empresa (§11.4)', 'backgroundColor'],
];

async function esperarServidor(ms = 20000) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try { const r = await fetch(`${BASE}/api/versao`); if (r.ok) return; } catch { /* subindo */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('Servidor da auditoria não respondeu a tempo');
}

function listarAbas() {
  const html = fs.readFileSync(path.join(RAIZ, 'frontend', 'index.html'), 'utf8');
  const nav = html.slice(html.indexOf('<nav class="side-nav">'), html.indexOf('</nav>'));
  const vistas = new Set();
  for (const m of nav.matchAll(/data-tab="([a-z0-9-]+)"/g)) vistas.add(m[1]);
  const lista = [...vistas];
  return FILTRO_ABAS ? lista.filter((a) => FILTRO_ABAS.includes(a)) : lista;
}

/** Espera a view ativa parar de mudar de tamanho (mesma técnica do screenshots.mjs). */
async function layoutEstavel(page, timeout = 12000) {
  await page.evaluate(() => document.fonts.ready);
  const assinatura = () => page.evaluate(() => {
    const v = document.querySelector('.view.active');
    if (!v) return '-';
    const r = v.getBoundingClientRect();
    const esqueleto = v.querySelector('.v2-skel, .skeleton, [aria-busy="true"]');
    return `${Math.round(r.width)},${Math.round(r.height)},${esqueleto ? 1 : 0}`;
  });
  const fim = Date.now() + timeout;
  let anterior = null, iguais = 0;
  while (Date.now() < fim) {
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const atual = await assinatura();
    if (atual === anterior && !atual.endsWith(',1')) { if (++iguais >= 2) return; } else { iguais = 0; anterior = atual; }
  }
}

/**
 * Roda DENTRO da página: monta a escala válida a partir dos tokens e devolve um achado por
 * elemento fora dela. Recebe o rótulo da tela e o seletor-raiz do que medir.
 */
const COLETOR = (args) => {
  const { rotulo, raizes } = args;
  // Os tokens semânticos NÃO vivem no :root: 02-themes.css os declara em
  // `body.design-v2 .ds-modulo` (e os temas em `body.<tema>`). Ler no documentElement devolvia
  // vazio para quase todos e transformava o relatório de cor num falso positivo gigante.
  const alvoTokens = document.querySelector('.ds-modulo') || document.body;
  const cs = getComputedStyle(alvoTokens);
  const tokens = {};
  for (const folha of document.styleSheets) {
    let regras; try { regras = folha.cssRules; } catch { continue; }
    for (const r of regras || []) {
      if (!r.style || !r.selectorText) continue;
      for (const nome of r.style) if (nome.startsWith('--ds-')) tokens[nome] = cs.getPropertyValue(nome).trim();
    }
  }
  // Normaliza cor/sombra pelo próprio motor: aplica o token numa sonda e lê o valor computado,
  // que é a mesma forma ("rgb(...)") em que os elementos serão medidos.
  const sonda = document.createElement('div');
  sonda.style.position = 'fixed'; sonda.style.left = '-9999px';
  document.body.appendChild(sonda);
  const computar = (prop, valor) => {
    sonda.style[prop] = ''; sonda.style[prop] = valor;
    const v = getComputedStyle(sonda)[prop];
    return v && v !== 'none' ? v : null;
  };
  const raiosOk = new Set(['0px', '0%']);
  const bordasOk = new Set(['0px']);
  const coresOk = new Set(['rgba(0, 0, 0, 0)', 'transparent', 'currentcolor']);
  const sombrasOk = new Set(['none']);
  for (const [nome, valor] of Object.entries(tokens)) {
    if (!valor) continue;
    if (/radius/.test(nome)) raiosOk.add(valor);
    else if (/^--ds-border(-|$)/.test(nome) && /px$/.test(valor)) bordasOk.add(valor);
    else if (/shadow/.test(nome)) { const c = computar('boxShadow', valor); if (c) sombrasOk.add(c); }
    else { const c = computar('color', valor); if (c) coresOk.add(c); }
  }
  // O legado também é servido pela "ponte" de 02-themes.css; quem consome var(--radius) etc.
  // acaba no mesmo valor de token, então nada a acrescentar aqui.
  sonda.remove();

  const partes = (v) => String(v || '').split(/\s+/).filter(Boolean);
  const achados = [];
  const anota = (el, prop, valor) => {
    const classes = [...el.classList];
    // Agrupa pela classe BASE (a primeira): `.vd-inp`, `.vd-inp.vd-mini` e `.vd-inp.cp-inp` são o
    // mesmo componente com modificadores — separá-los picotaria um achado em cinco.
    const chave = classes[0] ? '.' + classes[0] : el.tagName.toLowerCase();
    achados.push({
      rotulo, chave, tag: el.tagName.toLowerCase(), classes, prop, valor,
      // Dentro de .ds-modulo/.modal-overlay o DS alcança o elemento — é corrigível por sobrescrita.
      // Fora, corrigir exigiria migrar a tela (decisão maior), então a lista separa os dois.
      alcance: el.closest('.ds-modulo, .modal-overlay') ? 'ds' : 'fora',
    });
  };

  for (const seletorRaiz of raizes) {
    for (const raiz of document.querySelectorAll(seletorRaiz)) {
      if (raiz.hidden || !raiz.getClientRects().length) continue;
      for (const el of [raiz, ...raiz.querySelectorAll('*')]) {
        if (!el.getClientRects().length) continue;               // invisível: não é o que o usuário vê
        const tag = el.tagName.toLowerCase();
        if (['svg', 'path', 'g', 'circle', 'line', 'polyline', 'rect', 'script', 'style'].includes(tag)) continue;
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();

        // Checkbox/radio nativos: forma do sistema operacional, fora de qualquer token — é o
        // mesmo motivo por que o DS os exclui de propósito da régua de controle (ver
        // 09-superficies.css). Sem isto o audit reporta "desvio" no que nunca foi pra ser tocado.
        const ehCheckboxOuRadio = tag === 'input' && (el.type === 'checkbox' || el.type === 'radio');
        for (const p of ehCheckboxOuRadio ? [] : partes(s.borderRadius)) {
          if (p === '50%' && Math.abs(r.width - r.height) < 2) continue; // círculo legítimo
          if (!raiosOk.has(p)) { anota(el, 'borderRadius', p); break; }
        }
        for (const p of new Set([s.borderTopWidth, s.borderRightWidth, s.borderBottomWidth, s.borderLeftWidth])) {
          if (!bordasOk.has(p)) { anota(el, 'borderWidth', p); break; }
        }
        // box-shadow com blur 0 (ou inset) não é ELEVAÇÃO: é traço — a barra colorida do
        // cronograma, o anel do KPI-filtro, o sublinhado da sub-aba. Só a elevação segue token.
        const ehTraco = /inset/.test(s.boxShadow) || /(?:^|\s)0px(?:\s|$)/.test(s.boxShadow.replace(/^[^)]*\)\s*/, '').split(',')[0].split(/\s+/).slice(2, 3).join(' '));
        if (s.boxShadow && !sombrasOk.has(s.boxShadow) && !ehTraco) anota(el, 'boxShadow', s.boxShadow);
        for (const [prop, valor] of [['color', s.color], ['backgroundColor', s.backgroundColor], ['borderColor', s.borderTopColor]]) {
          if (prop === 'borderColor' && s.borderTopWidth === '0px') continue;
          // `color(srgb ...)` é o que o motor devolve para color-mix() — o mecanismo com que o
          // próprio DS deriva hover/borda a partir de um token. Derivado de token não é desvio.
          if (String(valor).startsWith('color(')) continue;
          if (!coresOk.has(String(valor).toLowerCase()) && !coresOk.has(valor)) anota(el, prop, valor);
        }
      }
    }
  }
  return achados;
};

/** Sub-abas: clicar em cada uma e medir também, senão metade das telas nunca é vista. */
async function medirTela(page, rotulo, achados) {
  const lote = await page.evaluate(COLETOR, { rotulo, raizes: ['.view.active', '.modal-overlay:not([hidden])'] });
  achados.push(...lote);
}

async function main() {
  fs.mkdirSync(path.dirname(SAIDA), { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'frota-auditoria-'));
  const envBase = { ...process.env };
  delete envBase.MONGODB_URI;

  console.log('Semeando dados fictícios em', tmp, '...');
  execFileSync(process.execPath, ['scripts/seed-mock.js', '--apply', '--limpar'], {
    cwd: RAIZ, env: { ...envBase, DATA_DIR: tmp }, stdio: 'ignore',
  });

  console.log('Subindo servidor efêmero na porta', PORT, '...');
  // A porta tem de estar livre: com um servidor alheio de pé, o nosso morre com EADDRINUSE e o
  // laço de espera aceitaria o 200 do intruso — a auditoria mediria a tela de OUTRA base.
  let portaOcupada = false;
  try { await fetch(BASE + '/api/versao', { signal: AbortSignal.timeout(1500) }); portaOcupada = true; } catch (e) { /* recusou = livre */ }
  if (portaOcupada) {
    console.error(`A porta ${PORT} já está ocupada por outro processo. Encerre-o e rode de novo (convenção de portas em test/portas.test.js).`);
    process.exit(1);
  }
  const srv = spawn(process.execPath, ['backend/server.js'], {
    cwd: RAIZ,
    env: { ...envBase, DATA_DIR: tmp, PORT: String(PORT), APP_PASSWORD: '', SENHA_ADMIN: '', E2E_TEST: '1', COFRE_CHAVE: 'chave-auditoria-nao-producao' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logSrv = '';
  srv.stdout.on('data', (d) => { logSrv += d; });
  srv.stderr.on('data', (d) => { logSrv += d; });
  srv.on('exit', (c) => { if (c) console.error('Servidor saiu com código', c, '\n', logSrv.slice(-2000)); });

  const achados = [];
  try {
    await esperarServidor();
    const abas = listarAbas();
    console.log(`Auditando ${abas.length} aba(s) no tema ${TEMA}...`);

    const browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript((t) => { try { localStorage.setItem('tema', t); } catch { /* ignora */ } }, TEMA);
    const page = await ctx.newPage();

    for (const aba of abas) {
      await page.goto(`${BASE}/painel/${aba}`, { waitUntil: 'load' });
      await page.locator('.view.active').waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
      await layoutEstavel(page);
      await medirTela(page, aba, achados);

      // sub-abas da própria tela (.subtab / .func-vis-btn / .epi-sub ...)
      const subs = await page.$$('.view.active .subtab:not(.active), .view.active .func-vis-btn:not(.on)');
      for (const [i, sub] of subs.entries()) {
        if (i > 5) break; // teto de segurança: as telas têm no máximo ~5 sub-abas
        const nome = (await sub.textContent().catch(() => ''))?.trim().slice(0, 24) || `sub${i}`;
        await sub.click({ timeout: 3000 }).catch(() => {});
        await layoutEstavel(page, 6000);
        await medirTela(page, `${aba} › ${nome}`, achados);
      }
      console.log('  ✓', aba, `(${achados.length} achados acumulados)`);
    }
    await browser.close();
  } finally {
    srv.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  // ---- Agrupamento por assinatura: classe + propriedade + valor ----
  const grupos = new Map();
  for (const a of achados) {
    const id = `${a.chave}|${a.prop}|${a.valor}`;
    const g = grupos.get(id) || { chave: a.chave, classes: a.classes, prop: a.prop, valor: a.valor, n: 0, telas: new Set(), alcance: new Set() };
    g.n++; g.telas.add(a.rotulo); g.alcance.add(a.alcance);
    grupos.set(id, g);
  }
  const motivoExcecao = (classes, prop) => {
    for (const [marca, motivo, so] of EXCECOES) {
      if (so && so !== prop) continue;
      if (classes.some((c) => c.startsWith(marca))) return motivo;
    }
    return null;
  };
  const lista = [...grupos.values()].map((g) => ({
    classe: g.chave, prop: g.prop, valor: g.valor, elementos: g.n,
    alcance: g.alcance.has('ds') ? 'ds' : 'fora',
    telas: [...g.telas].sort(), excecao: motivoExcecao(g.classes, g.prop),
  })).sort((a, b) => b.elementos - a.elementos);

  const desvios = SEM_FILTRO_EXCECOES ? lista : lista.filter((g) => !g.excecao);
  const registradas = lista.filter((g) => g.excecao);

  fs.writeFileSync(SAIDA, JSON.stringify({ modo: MODO, tema: TEMA, total: achados.length, desvios, registradas }, null, 2));

  const linha = (g) => `${String(g.elementos).padStart(4)}x  ${g.classe.slice(0, 30).padEnd(30)} ${g.prop.padEnd(15)} ${String(g.valor).slice(0, 30).padEnd(30)} ${g.telas.slice(0, 3).join(', ')}`;
  for (const [rot, prop] of [['FORMA (raio)', 'borderRadius'], ['BORDA', 'borderWidth'], ['SOMBRA', 'boxShadow'], ['COR', /Color|^color$/]]) {
    const bloco = desvios.filter((g) => (prop instanceof RegExp ? prop.test(g.prop) : g.prop === prop));
    const naDs = bloco.filter((g) => g.alcance === 'ds');
    console.log(`\n=== ${rot} — ${bloco.length} assinaturas / ${bloco.reduce((n, g) => n + g.elementos, 0)} elementos (${naDs.length} alcançáveis pelo DS) ===`);
    for (const g of bloco.slice(0, 40)) console.log((g.alcance === 'ds' ? '  ' : '· ') + linha(g));
    if (bloco.length > 40) console.log(`  ... e mais ${bloco.length - 40} (ver ${path.relative(RAIZ, SAIDA)})`);
  }
  console.log(`\n${registradas.length} assinatura(s) em exceção registrada (não contam como desvio).`);
  console.log('Relatório completo:', path.relative(RAIZ, SAIDA));
}

main().catch((e) => { console.error(e); process.exit(1); });
