/* ============================================================================
   Hub de acesso NTE (gestao.example.com/) — comportamento

   Carrega SÍNCRONO no <head>: a primeira coisa que faz é pôr `dark` no <html> quando o
   tema salvo pede, ANTES do primeiro paint (no fim do <body> a página piscava clara para
   quem usa o escuro). O resto espera o DOMContentLoaded.

   - Tema: MESMA chave `localStorage['tema']` do app e do login (claro | escuro | auto).
     O que se escolhe aqui vale dentro do sistema e vice-versa (docs/DESIGN.md §10.1).
   - Último acesso: `localStorage['hub-nte:ultimo-sistema']` = 'gestao' | 'fluxo'. O cartão
     dele nasce `marcado` (é o que o Enter abre) e mostra o selo "Último acesso".
   - Teclado: ← → alternam o sistema marcado de qualquer ponto (↑ ↓ também, com o foco num
     cartão); 1 e 2 abrem direto COM O FOCO NUM CARTÃO (WCAG 2.1.4: atalho de uma tecla só
     vale no componente focado; em qualquer ponto da página ele dispararia sem querer, por
     exemplo com o comando de voz); Enter entra no marcado. Por isso o foco já nasce no cartão
     marcado quando há teclado/mouse (`pointer: fine`): 1, 2 e Enter funcionam de cara.
   Sem dependências e sem handler inline (CSP `script-src 'self'`).
   ============================================================================ */
(function () {
  'use strict';

  var CHAVE_TEMA = 'tema';
  var CHAVE_TEMA_ANTIGA = 'hub-nte:tema'; // 'preto' | 'branco': o alternador do hub até a 1.55.42
  var CHAVE_ULTIMO = 'hub-nte:ultimo-sistema';
  var ABRINDO_MAX_MS = 10000; // navegação cancelada (Esc, Parar, 204, download) não prende o "Abrindo…"
  var raiz = document.documentElement;

  // Leitura/gravação no localStorage que nunca derruba o script (modo privado, armazenamento
  // bloqueado pela política do navegador).
  //
  // USO:
  //   gravar('hub-nte:ultimo-sistema', 'fluxo')
  //   ler('hub-nte:ultimo-sistema') → 'fluxo'    (armazenamento bloqueado → null)
  function ler(chave) { try { return localStorage.getItem(chave); } catch (e) { return null; } }
  function gravar(chave, valor) { try { localStorage.setItem(chave, valor); } catch (e) { /* armazenamento bloqueado */ } }
  // USO: sistemaEscuro() → true quando o sistema operacional está no tema escuro
  function sistemaEscuro() {
    try { return window.matchMedia('(prefers-color-scheme: dark)').matches; } catch (e) { return false; }
  }

  // Diz se o valor salvo em `tema` resolve para o escuro. Mesma regra do login e do app:
  // só 'escuro', ou 'auto' com o sistema operacional no escuro; qualquer outro valor
  // (vazio, nome de tema antigo) é claro.
  //
  // USO:
  //   temaEhEscuro('escuro', false) → true
  //   temaEhEscuro('auto', true)    → true   (SO no escuro)
  //   temaEhEscuro('auto', false)   → false
  //   temaEhEscuro(null, true)      → false  (nada salvo = claro, igual ao login)
  function temaEhEscuro(valor, soEscuro) {
    return valor === 'escuro' || (valor === 'auto' && !!soEscuro);
  }

  // Migração única do alternador antigo do hub (chave própria, valores preto/branco): quem
  // escolheu lá e nunca escolheu tema no app herda a escolha na chave compartilhada. A chave
  // antiga some depois, então isto roda uma vez por navegador.
  //
  // USO:
  //   { 'hub-nte:tema': 'preto' }                 → migrarTemaAntigo() → { tema: 'escuro' }
  //   { 'hub-nte:tema': 'branco', tema: 'escuro' } → migrarTemaAntigo() → { tema: 'escuro' } (a do app vence)
  function migrarTemaAntigo() {
    var antigo = ler(CHAVE_TEMA_ANTIGA);
    if (antigo === null) return;
    if (ler(CHAVE_TEMA) === null && (antigo === 'preto' || antigo === 'branco')) {
      gravar(CHAVE_TEMA, antigo === 'preto' ? 'escuro' : 'claro');
    }
    try { localStorage.removeItem(CHAVE_TEMA_ANTIGA); } catch (e) { /* armazenamento bloqueado */ }
  }

  // Põe/tira `dark` no <html> conforme o tema salvo; rotularTema acerta o nome do botão
  // (ele diz o que o clique FAZ); reaplicarTema faz os dois.
  //
  // USO:
  //   { tema: 'escuro' } → aplicarTema() → <html class="dark">
  //   { tema: 'claro' }  → reaplicarTema() → <html> sem `dark` e botão "Usar tema escuro"
  function aplicarTema() { raiz.classList.toggle('dark', temaEhEscuro(ler(CHAVE_TEMA), sistemaEscuro())); }
  function rotularTema() {
    var btn = document.getElementById('temaToggle');
    if (btn) btn.setAttribute('aria-label', raiz.classList.contains('dark') ? 'Usar tema claro' : 'Usar tema escuro');
  }
  function reaplicarTema() { aplicarTema(); rotularTema(); }

  migrarTemaAntigo();
  aplicarTema();

  // 'auto' acompanha a troca do sistema operacional ao vivo, como no app.
  try {
    var mq = window.matchMedia('(prefers-color-scheme: dark)');
    var aoMudarSO = function () { if (ler(CHAVE_TEMA) === 'auto') reaplicarTema(); };
    if (mq.addEventListener) mq.addEventListener('change', aoMudarSO);
    else if (mq.addListener) mq.addListener(aoMudarSO);
  } catch (e) { /* matchMedia indisponível */ }
  // Tema trocado em OUTRA aba do mesmo domínio (painel ou login): acompanha.
  window.addEventListener('storage', function (e) { if (e.key === CHAVE_TEMA) reaplicarTema(); });

  document.addEventListener('DOMContentLoaded', iniciar);

  // Liga o hub depois que o HTML existe: marca o último acesso, prende os eventos dos cartões,
  // do teclado, do botão de tema e da volta pelo bfcache.
  //
  // USO: document.addEventListener('DOMContentLoaded', iniciar)   (chamada única, acima)
  function iniciar() {
    var cartoes = [].slice.call(document.querySelectorAll('.sistema[data-sistema]'));
    var links = cartoes.map(function (c) { return c.querySelector('.sistema-entrar'); });
    var marcado = -1;
    var tAbrindo = null;

    // Resto da transição antiga (overlay que crescia até a tela cheia): não é mais usado.
    try { sessionStorage.removeItem('hub-nte:transicao'); } catch (e) { /* armazenamento bloqueado */ }

    // Marca o cartão `i` como o sistema que o Enter abre (um por vez): borda primária e o
    // único botão sólido da tela. `focar` leva o foco ao "Entrar" dele; `semRolar` evita que
    // a página role até o cartão (usado no carregamento).
    //
    // USO:
    //   marcar(1)             → o Fluxo RM fica marcado
    //   marcar(0, true)       → o Gestão RM fica marcado e o foco vai para o "Entrar" dele
    //   marcar(0, true, true) → idem, sem rolar a página
    function marcar(i, focar, semRolar) {
      if (i < 0 || i >= cartoes.length) return;
      marcado = i;
      cartoes.forEach(function (c, k) { c.classList.toggle('marcado', k === i); });
      if (focar) links[i].focus({ preventScroll: !!semRolar });
    }

    // Lê o último acesso salvo, acende o selo no cartão dele e o deixa marcado. Sem último
    // acesso, marca o primeiro (o Enter sempre tem destino).
    //
    // USO:
    //   { 'hub-nte:ultimo-sistema': 'fluxo' } → aplicarUltimo()     → Fluxo RM marcado, com o selo
    //   nada salvo                            → aplicarUltimo(true) → Gestão RM marcado e focado, sem selo
    function aplicarUltimo(focar) {
      var ultimo = ler(CHAVE_ULTIMO);
      var achou = -1;
      cartoes.forEach(function (c, k) {
        var eh = c.getAttribute('data-sistema') === ultimo;
        if (eh) achou = k;
        var selo = c.querySelector('.sistema-selo');
        if (selo) selo.hidden = !eh;
      });
      marcar(achou >= 0 ? achou : 0, focar, true);
    }

    // Tira o estado "Abrindo…" de todos os cartões (classe, aria-busy e o nome provisório).
    //
    // USO:
    //   depois de abrir(0, false) → limparAbrindo() → nenhum cartão com .abrindo nem aria-busy
    function limparAbrindo() {
      clearTimeout(tAbrindo);
      cartoes.forEach(function (c, k) {
        c.classList.remove('abrindo');
        c.removeAttribute('aria-busy');
        links[k].removeAttribute('aria-label');
      });
    }

    // Entra no sistema `i`: grava o último acesso, marca o cartão e mostra "Abrindo…" até a
    // página trocar. `navegar` = false quando o próprio clique no link já vai navegar. Se a
    // navegação for cancelada, o estado sai sozinho depois de ABRINDO_MAX_MS.
    //
    // USO:
    //   abrir(0, true)  → tecla 1: vai para /painel na mesma aba
    //   abrir(1, false) → clique no "Entrar" do Fluxo RM: só grava e mostra o estado; o link navega
    function abrir(i, navegar) {
      var c = cartoes[i];
      if (!c) return;
      limparAbrindo(); // escolher o outro sistema durante a espera não deixa os dois "Abrindo…"
      gravar(CHAVE_ULTIMO, c.getAttribute('data-sistema'));
      marcar(i);
      c.classList.add('abrindo');
      c.setAttribute('aria-busy', 'true');
      var nome = c.querySelector('.sistema-nome');
      links[i].setAttribute('aria-label', 'Abrindo o ' + (nome ? nome.textContent : 'sistema'));
      tAbrindo = setTimeout(limparAbrindo, ABRINDO_MAX_MS);
      if (navegar) window.location.href = links[i].href;
    }

    links.forEach(function (a, i) {
      var chave = cartoes[i].getAttribute('data-sistema');
      a.addEventListener('click', function (e) {
        if (e.defaultPrevented) return;
        // Ctrl/⌘/Shift/Alt: o navegador abre em outra aba ou janela e esta página continua
        // aqui. Grava o acesso, mas sem "Abrindo…", que ficaria na tela sem motivo.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) { gravar(CHAVE_ULTIMO, chave); return; }
        abrir(i, false);
      });
      // Botão do meio também abre em aba nova, mas dispara `auxclick`, não `click`.
      a.addEventListener('auxclick', function (e) { if (e.button === 1) gravar(CHAVE_ULTIMO, chave); });
      a.addEventListener('focus', function () { marcar(i); });
    });

    document.addEventListener('keydown', function (e) {
      if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      var alvo = e.target;
      if (alvo && (alvo.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(alvo.tagName))) return;
      var noCartao = links.indexOf(alvo) !== -1;

      // 1 e 2: só com o foco num cartão (WCAG 2.1.4, ver o cabeçalho).
      if (noCartao && /^[1-9]$/.test(e.key) && Number(e.key) <= cartoes.length) {
        e.preventDefault();
        abrir(Number(e.key) - 1, true);
        return;
      }
      // ← → valem de qualquer ponto (não são tecla de caractere) e levam o foco a um cartão;
      // ↑ ↓ só com o foco num cartão, para não roubar a rolagem da página com os cartões
      // empilhados (telas estreitas).
      var proximo = e.key === 'ArrowRight' || (noCartao && e.key === 'ArrowDown');
      var anterior = e.key === 'ArrowLeft' || (noCartao && e.key === 'ArrowUp');
      if (proximo || anterior) {
        e.preventDefault();
        var base = marcado < 0 ? 0 : marcado;
        marcar(proximo ? Math.min(cartoes.length - 1, base + 1) : Math.max(0, base - 1), true);
        return;
      }
      // Enter sem foco em nada interativo entra no marcado. Com foco num link ou botão, o próprio
      // navegador ativa o elemento (e o clique do "Entrar" cai no handler acima).
      if (e.key === 'Enter' && marcado >= 0 && (!alvo || alvo === document.body || alvo === raiz)) {
        e.preventDefault();
        abrir(marcado, true);
      }
    });

    var btnTema = document.getElementById('temaToggle');
    if (btnTema) {
      btnTema.addEventListener('click', function () {
        var escuro = !raiz.classList.contains('dark');
        raiz.classList.toggle('dark', escuro);
        gravar(CHAVE_TEMA, escuro ? 'escuro' : 'claro');
        rotularTema();
      });
    }

    // Voltar pelo botão do navegador restaura a página do bfcache ainda "Abrindo…": limpa, e
    // relê último acesso e tema (podem ter mudado no outro sistema).
    window.addEventListener('pageshow', function (e) {
      if (!e.persisted) return;
      limparAbrindo();
      aplicarUltimo();
      reaplicarTema();
    });

    // Foco inicial no cartão marcado só com teclado/mouse: no toque não há tecla para usar e o
    // foco só acenderia o anel à toa.
    var temPonteiroFino = false;
    try { temPonteiroFino = window.matchMedia('(pointer: fine)').matches; } catch (e) { /* matchMedia indisponível */ }
    aplicarUltimo(temPonteiroFino);
    rotularTema();
  }
})();
