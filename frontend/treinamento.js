// Página pública de Treinamento — Gestão RM.
// Servida sem login; a proteção é o token na URL (/treinamento/<token>). Sem handlers inline
// (o CSP do site não permite 'unsafe-inline' em script-src) → tudo via JS externo.
// Fluxo (plano 01-03): assistir o vídeo → responder a prova de múltipla escolha → o servidor
// corrige (gabarito secreto), calcula a nota e devolve { nota, aprovado }. Tentativas ilimitadas
// dentro do prazo (D-06): reprovado pode refazer; aprovado vê o estado concluído.
//
// Vídeo travado (Parte B): quando o /entrar traz treino.video (vídeo enviado ao bucket), a página
// monta um <video> SEM controles nativos + controles próprios numa faixa abaixo dele; não deixa
// adiantar nem acelerar e só libera a prova quando o SERVIDOR confirma o fim
// (POST .../video {evento:'fim'}). Sem treino.video → iframe do Drive de sempre, sem trava.
(function () {
  'use strict';

  const TOKEN = decodeURIComponent((location.pathname.split('/').filter(Boolean).pop() || ''));
  const API = '/api/treinamentos/publico/' + encodeURIComponent(TOKEN);

  const $ = (id) => document.getElementById(id);

  let TREINO = null;       // dados do treinamento (sem gabarito) vindos do servidor
  let CONCLUIDO = false;   // link já aprovado (status 'concluido')
  // Vídeo travado. VIDEO = treino.video do /entrar ({url, duracaoSeg, mime, ref, expiraTs}) ou null
  // (treinamento no Drive). PROGRESSO = progresso do /entrar ({iniciadoTs, concluidoTs, liberadoRh,
  // provaLiberada}). PROVA_LIBERADA = servidor liberou a prova (fim confirmado, RH liberou ou sem vídeo).
  let VIDEO = null;
  // O treinamento TEM vídeo enviado, mas o /entrar não trouxe URL usável (armazenamento desligado
  // ou falha ao gerar a URL): a prova continua bloqueada (o servidor exige o vídeo) e a página
  // avisa que o vídeo está indisponível. Saída: o RH usa "Liberar prova".
  let VIDEO_INDISP = false;
  let PROGRESSO = null;
  let PROVA_LIBERADA = true;
  let PLAYER = null;       // { video, wrap, S, pintar } do player travado montado

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg, tipo) {
    const t = $('toast');
    if (!t) return;
    t.textContent = msg;
    t.className = (tipo === 'erro' ? 'erro ' : '') + 'show';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = t.className.replace('show', '').trim(); }, 3200);
  }

  // Ícones das telas de status e do resultado (SVG com currentColor, 1.55.42). Emoji não aparece em
  // todo aparelho: o 🪪 do CPF virava um quadrado vazio no Windows. Declarados aqui (e não junto do
  // ICONES do player, mais abaixo) porque mostrarStatus roda antes daquele trecho do arquivo.
  // `TOM_TELA` dá a cor pelo data-tom (CSS da página): aviso, erro, ok ou neutro.
  // Ex.: mostrarStatus('expirado', 'Link expirado', '…') → ampulheta em --warning no #status-icon.
  const svgTela = (corpo) => '<svg viewBox="0 0 24 24" width="56" height="56" aria-hidden="true" focusable="false"'
    + ' fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' + corpo + '</svg>';
  const ICONES_TELA = {
    carregando: svgTela('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
    aviso: svgTela('<path d="M10.3 3.9 2.4 17.6a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
    bloqueado: svgTela('<circle cx="12" cy="12" r="9"/><path d="m5.6 5.6 12.8 12.8"/>'),
    expirado: svgTela('<path d="M6 3h12"/><path d="M6 21h12"/><path d="M7 3v3a5 5 0 0 0 10 0V3"/><path d="M7 21v-3a5 5 0 0 1 10 0v3"/>'),
    link: svgTela('<path d="M10 13a5 5 0 0 0 7.07 0l3-3a5 5 0 0 0-7.07-7.07l-1.5 1.5"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3a5 5 0 0 0 7.07 7.07l1.5-1.5"/>'),
    aprovado: svgTela('<circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.8 2.8 5.7-5.8"/>'),
    reprovado: svgTela('<rect x="6" y="4" width="12" height="17" rx="2"/><path d="M9 4.5V3h6v1.5"/><path d="M9 11h6"/><path d="M9 15h4"/>'),
  };
  const TOM_TELA = { carregando: 'neutro', aviso: 'aviso', bloqueado: 'erro', expirado: 'aviso', link: 'neutro', aprovado: 'ok', reprovado: 'erro' };
  // Desenha um ícone de ICONES_TELA num elemento. Ex.: pintarIconeTela($('resultIcon'), 'aprovado').
  function pintarIconeTela(el, nome) {
    if (!el) return;
    const n = ICONES_TELA[nome] ? nome : 'aviso';
    el.innerHTML = ICONES_TELA[n];
    el.dataset.tom = TOM_TELA[n] || 'neutro';
  }

  // Tela de status (link inválido, vencido, erro, treinamento atualizado). `icone` = nome em ICONES_TELA.
  // Ex.: mostrarStatus('link', 'Link inválido', 'Este link de treinamento não foi encontrado.')
  function mostrarStatus(icone, titulo, msg) {
    pintarIconeTela($('status-icon'), icone);
    $('status-title').textContent = titulo;
    $('status-msg').textContent = msg;
    const acoes = $('status-actions');
    if (acoes) acoes.hidden = true; // só a tela de "treinamento atualizado" mostra o Recarregar
    $('status-screen').style.display = 'block';
    $('player-main').style.display = 'none';
  }

  // O RH trocou ou tirou o vídeo com a página aberta (409 VIDEO_PENDENTE no envio da prova, ou
  // SEM_VIDEO nas rotas do vídeo): o player na tela é do vídeo ANTIGO, então só recarregar resolve
  // (o /entrar devolve a URL e o ref novos e o progresso começa do zero). Para o vídeo e mostra a
  // tela de status com o botão Recarregar.
  // Ex.: mostrarTreinoAtualizado(); → "O treinamento foi atualizado. Recarregue a página." + [Recarregar].
  function mostrarTreinoAtualizado() {
    if (PLAYER) { try { PLAYER.video.pause(); } catch (e) { /* segue */ } sairPseudoCheia(); }
    ligarBatimento(false);
    $('cpf-screen').style.display = 'none';
    mostrarStatus('aviso', 'Treinamento atualizado', 'O treinamento foi atualizado. Recarregue a página.');
    const acoes = $('status-actions'), btn = $('btnRecarregar');
    if (acoes && btn) {
      acoes.hidden = false;
      if (!btn.dataset.ligado) { btn.dataset.ligado = '1'; btn.addEventListener('click', () => location.reload()); }
      try { btn.focus(); } catch (e) { /* segue */ }
    }
  }

  // Tela de link fechado (expirado/cancelado): usada no init (GET de status) e quando uma rota
  // devolve 409 {codigo:'LINK_FECHADO', status}. Para o vídeo e sai da tela cheia antes.
  // Ex.: mostrarLinkFechado('expirado') → "Link expirado"; mostrarLinkFechado('cancelado') → "Link indisponível".
  function mostrarLinkFechado(status) {
    if (PLAYER) { try { PLAYER.video.pause(); } catch (e) { /* segue */ } sairPseudoCheia(); }
    $('cpf-screen').style.display = 'none';
    if (status === 'cancelado') {
      mostrarStatus('bloqueado', 'Link indisponível', 'Este treinamento não está mais disponível. Fale com o RH.');
    } else {
      mostrarStatus('expirado', 'Link expirado', 'O prazo deste treinamento acabou. Peça um novo link ao RH.');
    }
  }

  // ----- Passos (Vídeo / Prova / Resultado) -----
  const PANEIS = { video: 'panelVideo', prova: 'panelProva', result: 'panelResult' };
  const TABS = { video: 'stepTabVideo', prova: 'stepTabProva', result: 'stepTabResult' };
  function mostrarPasso(nome) {
    Object.keys(PANEIS).forEach(k => { $(PANEIS[k]).hidden = (k !== nome); });
    Object.keys(TABS).forEach(k => { $(TABS[k]).classList.toggle('on', k === nome); });
    // Saiu do passo Vídeo com o player travado: pausa (não fica tocando escondido atrás da prova).
    if (nome !== 'video' && PLAYER) { try { PLAYER.video.pause(); } catch (e) { /* segue */ } sairPseudoCheia(); }
  }

  // ----- Gate da prova (vídeo travado) -----
  // A prova fica bloqueada enquanto o treinamento tem vídeo travado e o servidor ainda não liberou.
  // Ex.: provaBloqueada() → true logo após entrar sem ter assistido (ou com o vídeo indisponível);
  // false no modo Drive ou depois do 'fim' aceito pelo servidor (ou da liberação pelo RH).
  function provaBloqueada() { return (!!VIDEO || VIDEO_INDISP) && !PROVA_LIBERADA && !CONCLUIDO; }

  // Texto do aviso da prova bloqueada. Ex.: msgGateProva() → 'Assista ao vídeo até o fim para
  // liberar a prova.'; com VIDEO_INDISP → 'O vídeo está indisponível no momento. Fale com o RH.'
  function msgGateProva() {
    return VIDEO_INDISP ? 'O vídeo está indisponível no momento. Fale com o RH.' : 'Assista ao vídeo até o fim para liberar a prova.';
  }

  // Aplica o bloqueio na aba "2. Prova" e no "Ir para a prova" (disabled + aria-disabled) e escreve
  // o aviso no #gateProva (aria-live). msgLiberada = texto a anunciar quando a prova acabou de liberar.
  // Ex.: PROVA_LIBERADA = false; aplicarGateProva(); → aba/botão desabilitados com
  //      "Assista ao vídeo até o fim para liberar a prova."
  function aplicarGateProva(msgLiberada) {
    const bloq = provaBloqueada();
    const tab = $('stepTabProva'), btn = $('btnIrProva'), aviso = $('gateProva');
    if (!CONCLUIDO) tab.disabled = bloq;
    tab.setAttribute('aria-disabled', tab.disabled ? 'true' : 'false');
    btn.disabled = bloq;
    btn.setAttribute('aria-disabled', bloq ? 'true' : 'false');
    if (aviso) aviso.textContent = bloq ? msgGateProva() : (msgLiberada || '');
  }

  // Servidor confirmou o fim do vídeo (ou o RH liberou a prova): destrava a aba/botão da prova.
  // Ex.: liberarProva() → aba "2. Prova" ativa + aviso "Vídeo concluído. A prova está liberada."
  function liberarProva() {
    const antes = PROVA_LIBERADA;
    PROVA_LIBERADA = true;
    avisarPlayer('');
    aplicarGateProva(antes ? '' : 'Vídeo concluído. A prova está liberada.');
    if (!antes) toast('Prova liberada.');
  }

  // ----- Utilidades do player travado -----
  // Ex.: await dormir(1000) → espera 1 s.
  const dormir = (ms) => new Promise(r => setTimeout(r, ms));

  // Tempo legível: mm:ss (h:mm:ss a partir de 1 hora).
  // Ex.: fmtTempo(75) → '01:15'; fmtTempo(3725) → '1:02:05'; fmtTempo(NaN) → '00:00'.
  function fmtTempo(seg) {
    const s = Math.max(0, Math.floor(Number(seg) || 0));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
    const dd = (n) => String(n).padStart(2, '0');
    return h ? (h + ':' + dd(m) + ':' + dd(r)) : (dd(m) + ':' + dd(r));
  }

  // Mensagem persistente do player (#playerAviso, role=status/aria-live): carregando, liberando a
  // prova, contagem, erro de carga. Avisos passageiros (tentou adiantar) vão por toast().
  // Ex.: avisarPlayer('Liberando a prova…'); avisarPlayer('') → limpa (o elemento some pelo :empty).
  function avisarPlayer(msg) { const a = $('playerAviso'); if (a) a.textContent = msg || ''; }

  // Aceita só treino.video com URL relativa do próprio site (driver local) ou https (R2 pré-assinada).
  // Ex.: videoValido({url:'/api/treinamentos/publico/abc/video?r=1a2b', duracaoSeg:600, ref:'1a2b…'}) → o objeto;
  //      videoValido(null) → null (modo Drive); videoValido({url:'javascript:…'}) → null.
  function videoValido(v) {
    if (!v || typeof v !== 'object' || typeof v.url !== 'string' || !v.url) return null;
    if (!(/^\/(?!\/)/.test(v.url) || /^https:\/\//i.test(v.url))) return null;
    return v;
  }

  // Duração do vídeo: a do elemento quando já conhecida; senão a declarada pelo servidor.
  // Ex.: duracaoDe(video) → 612.4 (após loadedmetadata) ou VIDEO.duracaoSeg antes disso.
  function duracaoDe(video) {
    const d = video ? video.duration : NaN;
    return (isFinite(d) && d > 0) ? d : (Number(VIDEO && VIDEO.duracaoSeg) || 0);
  }

  // iOS ignora o volume ajustado por JS (sempre lê 1) → lá só existe o botão Mudo.
  // Ex.: volumeAjustavel() → false no iPhone/iPad; true no Android/desktop.
  function volumeAjustavel() {
    try { const v = document.createElement('video'); v.volume = 0.5; return Math.abs(v.volume - 0.5) < 0.01; } catch (e) { return false; }
  }

  // ----- Progresso local (retomar de onde parou) -----
  // Chave 'trn-video:<token>:<ref>' → {max:segundos assistidos de verdade, fim:boolean}. O ref muda
  // quando o RH troca o vídeo, então o progresso antigo não vale para o vídeo novo. Tudo em try/catch
  // (aba anônima/armazenamento bloqueado → segue sem retomar).
  // Ex.: lerProgressoLocal() → {max: 132.5, fim: false}; sem nada gravado → {max: 0, fim: false}.
  function chaveProgressoLocal() { return 'trn-video:' + TOKEN + ':' + ((VIDEO && VIDEO.ref) || ''); }
  function lerProgressoLocal() {
    try {
      const o = JSON.parse(localStorage.getItem(chaveProgressoLocal()) || 'null');
      if (o && typeof o === 'object') return { max: Math.max(0, Number(o.max) || 0), fim: o.fim === true };
    } catch (e) { /* sem armazenamento */ }
    return { max: 0, fim: false };
  }
  // Ex.: gravarProgressoLocal(132.5, false); gravarProgressoLocal(612, true) ao terminar.
  function gravarProgressoLocal(max, fim) {
    try { localStorage.setItem(chaveProgressoLocal(), JSON.stringify({ max: Math.floor((Number(max) || 0) * 10) / 10, fim: !!fim })); } catch (e) { /* sem armazenamento */ }
  }

  // ----- Conversa com o servidor sobre o vídeo -----
  // POST .../video {evento}. Nunca lança: devolve {status, d} (status 0 = rede caiu/timeout).
  // Ex.: const r = await postVideo('fim', 90000); r.status === 200 && r.d.ok → prova liberada.
  async function postVideo(evento, timeoutMs) {
    const ctl = (typeof AbortController === 'function') ? new AbortController() : null;
    const tm = ctl ? setTimeout(() => ctl.abort(), timeoutMs || 20000) : null;
    try {
      const r = await fetch(API + '/video', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ evento }),
        signal: ctl ? ctl.signal : undefined,
      });
      const d = await r.json().catch(() => ({}));
      return { status: r.status, d: d || {} };
    } catch (e) {
      return { status: 0, d: {} };
    } finally {
      if (tm) clearTimeout(tm);
    }
  }

  // Falha transitória (rede, timeout, Render acordando/5xx, 408/429) → vale tentar de novo.
  // Ex.: transitorio(0) → true; transitorio(503) → true; transitorio(404) → false.
  function transitorio(status) { return status === 0 || status >= 500 || status === 408 || status === 429; }

  // Trata os códigos que encerram a tentativa (link fechado, sem acesso, sem vídeo).
  // Devolve true quando tratou (quem chamou para de tentar).
  // Ex.: if (tratarCodigoVideo(r)) return;
  function tratarCodigoVideo(r) {
    const cod = r && r.d && r.d.codigo;
    if (cod === 'LINK_FECHADO') { mostrarLinkFechado(r.d.status); return true; }
    // O RH tirou o vídeo com a página aberta: o player mostra o vídeo antigo → pede para recarregar
    // (depois do reload a página vem no modo Drive, com a prova livre).
    if (cod === 'SEM_VIDEO') { mostrarTreinoAtualizado(); return true; }
    if (cod === 'SEM_ACESSO') { avisarPlayer('Sua entrada não foi confirmada. Recarregue a página e digite o CPF de novo.'); return true; }
    return false;
  }

  // Registra o início do vídeo no servidor (1º play). Chamado DEPOIS do video.play() no clique, sem
  // await antes do play (iOS exige play() síncrono no gesto). Reenvia até o servidor confirmar.
  // Ex.: video.play(); registrarInicio(); → POST .../video {evento:'inicio'} (retentativa 2 s, 4 s… até 30 s).
  let inicioOk = false, inicioEnviando = false;
  async function registrarInicio() {
    if (inicioOk || inicioEnviando || !VIDEO) return;
    if (PROGRESSO && PROGRESSO.iniciadoTs) { inicioOk = true; return; }
    inicioEnviando = true;
    let espera = 2000;
    try {
      for (;;) {
        const r = await postVideo('inicio');
        if (r.status === 200 && r.d.ok) {
          inicioOk = true;
          if (r.d.progresso) PROGRESSO = r.d.progresso;
          if (PROGRESSO && PROGRESSO.provaLiberada) liberarProva();
          return;
        }
        if (tratarCodigoVideo(r) || !transitorio(r.status)) return;
        await dormir(espera);
        espera = Math.min(espera * 2, 30000);
      }
    } finally { inicioEnviando = false; }
  }

  // Tempo aproximado por extenso, para anunciar ao leitor de tela.
  // Ex.: fmtCerca(1) → '1 segundo'; fmtCerca(42) → '42 segundos'; fmtCerca(95) → '2 minutos'; fmtCerca(70) → '1 minuto'.
  function fmtCerca(seg) {
    const s = Math.max(1, Math.round(Number(seg) || 0));
    if (s < 60) return s + (s === 1 ? ' segundo' : ' segundos');
    const m = Math.max(1, Math.round(s / 60));
    return m + (m === 1 ? ' minuto' : ' minutos');
  }

  // Contagem regressiva do 409 VIDEO_CEDO (servidor ainda não contou o tempo mínimo do vídeo).
  // A região aria-live (#playerAviso) é escrita só no INÍCIO ("cerca de N segundos") e no FIM
  // ("Liberando a prova…"); os segundos descem no #playerContagem, que tem aria-hidden (o leitor de
  // tela não anuncia cada segundo).
  // Ex.: await esperarContagem(42) → anuncia "A prova será liberada em cerca de 42 segundos." e
  //      mostra "Tempo restante: 00:42" descendo a cada segundo.
  async function esperarContagem(seg) {
    let rest = Math.max(1, Math.ceil(Number(seg) || 5));
    const cont = $('playerContagem');
    avisarPlayer('A prova será liberada em cerca de ' + fmtCerca(rest) + '.');
    try {
      while (rest > 0) {
        if (cont) cont.textContent = 'Tempo restante: ' + fmtTempo(rest);
        await dormir(1000);
        rest--;
      }
    } finally {
      if (cont) cont.textContent = '';
    }
    avisarPlayer('Liberando a prova…');
  }

  // Avisa o servidor que o vídeo terminou (ended válido) e libera a prova quando ele confirmar.
  // 200 → liberarProva(); 409 VIDEO_CEDO {faltamSeg} → contagem e tenta de novo sozinho;
  // rede/Render acordando → "Liberando a prova… (pode levar até 1 minuto)", timeout de 90 s e retentativa.
  // Ex.: enviarFim(); (no 'ended' válido, ou ao abrir quando o localStorage diz fim e o servidor não).
  let fimEnviando = false;
  async function enviarFim() {
    if (fimEnviando || !VIDEO) return;
    fimEnviando = true;
    const mostrar = !PROVA_LIBERADA; // já liberada pelo RH: registra em silêncio
    let espera = 3000;
    try {
      for (;;) {
        if (mostrar) avisarPlayer('Liberando a prova… (pode levar até 1 minuto)');
        const r = await postVideo('fim', 90000);
        if (r.status === 200 && r.d.ok) {
          if (r.d.progresso) PROGRESSO = r.d.progresso;
          inicioOk = true;
          liberarProva();
          return;
        }
        if (r.status === 409 && r.d.codigo === 'VIDEO_CEDO') {
          if (mostrar) await esperarContagem(r.d.faltamSeg); else await dormir(Math.max(1, Number(r.d.faltamSeg) || 5) * 1000);
          continue;
        }
        if (tratarCodigoVideo(r)) return;
        if (!transitorio(r.status)) {
          if (mostrar) avisarPlayer((r.d && r.d.erro) || 'Não foi possível liberar a prova. Recarregue a página e tente de novo.');
          return;
        }
        await dormir(espera);
        espera = Math.min(espera * 2, 20000);
      }
    } finally { fimEnviando = false; }
  }

  // Batimento: enquanto o vídeo toca, GET leve no status do link a cada 5 min (mantém o Render
  // acordado para o 'fim' não cair no servidor dormindo). Só leitura; resposta ignorada.
  // Ex.: ligarBatimento(true) no 'playing'; ligarBatimento(false) no 'pause'/'ended'.
  let batTimer = null;
  function ligarBatimento(on) {
    if (on && !batTimer) {
      batTimer = setInterval(() => {
        fetch(API, { headers: { 'Accept': 'application/json' }, cache: 'no-store' }).catch(() => {});
      }, 5 * 60 * 1000);
    } else if (!on && batTimer) {
      clearInterval(batTimer); batTimer = null;
    }
  }

  // Renova a URL do vídeo (a pré-assinada expira) no 'error' do <video>: guarda a posição, pede
  // POST .../video/url, troca o src, load(), e o loadedmetadata/canplay voltam para a posição (<= max).
  // Máximo de 5 renovações seguidas sem conseguir tocar (evita laço com arquivo que o aparelho não toca).
  // Ex.: video.addEventListener('error', () => renovarUrl());
  let renovando = false, renovacoes = 0;
  async function renovarUrl() {
    if (!PLAYER || renovando) return;
    const { video, S } = PLAYER;
    if (video.error && video.error.code === 1) return; // MEDIA_ERR_ABORTED: troca de src nossa
    if (renovacoes >= 5) {
      avisarPlayer('Não foi possível carregar o vídeo neste aparelho. Verifique a internet e recarregue a página; se continuar, fale com o RH.');
      return;
    }
    renovando = true; renovacoes++;
    const pos = Math.min(S.ultimaPos || 0, S.max);
    try {
      const r = await fetch(API + '/video/url', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: '{}',
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok && videoValido({ url: d.url })) {
        VIDEO.url = d.url;
        if (d.expiraTs) VIDEO.expiraTs = d.expiraTs;
        S.pos = pos;
        video.src = d.url;
        video.load();
      } else if (!tratarCodigoVideo({ status: r.status, d })) {
        avisarPlayer((d && d.erro) || 'Não foi possível carregar o vídeo. Recarregue a página.');
      }
    } catch (e) {
      avisarPlayer('Sem conexão para carregar o vídeo. Verifique a internet e toque em Reproduzir de novo.');
    } finally { renovando = false; }
  }

  // ----- Tela cheia do CONTÊINER (vídeo + faixa de controles) -----
  // A tela cheia é do #videoWrap inteiro, para os controles próprios continuarem valendo. iPhone não
  // tem Fullscreen API para elemento → pseudo tela cheia por CSS (.cheia: fixed, 100dvh, safe-area).
  // Ex.: alternarTelaCheia($('videoWrap')) → entra; chamar de novo (ou Esc) → sai.
  function telaCheiaNativa() { return document.fullscreenElement || document.webkitFullscreenElement || null; }
  function alternarTelaCheia(wrap) {
    if (telaCheiaNativa()) {
      const sair = document.exitFullscreen || document.webkitExitFullscreen;
      if (sair) { try { const p = sair.call(document); if (p && p.catch) p.catch(() => {}); } catch (e) { /* segue */ } }
      return;
    }
    if (wrap.classList.contains('cheia')) { sairPseudoCheia(); return; }
    const pedir = wrap.requestFullscreen || wrap.webkitRequestFullscreen;
    if (pedir) {
      try {
        const p = pedir.call(wrap);
        if (p && p.catch) p.catch(() => entrarPseudoCheia(wrap));
        return;
      } catch (e) { /* cai na pseudo tela cheia */ }
    }
    entrarPseudoCheia(wrap);
  }
  // Ex.: entrarPseudoCheia($('videoWrap')) → contêiner fixo ocupando a tela, rolagem da página travada.
  function entrarPseudoCheia(wrap) {
    wrap.classList.add('cheia');
    document.documentElement.classList.add('sem-rolagem');
    if (PLAYER) PLAYER.pintar();
  }
  // Ex.: sairPseudoCheia() → volta ao tamanho normal (sem efeito se não estava em pseudo tela cheia).
  function sairPseudoCheia() {
    const w = $('videoWrap');
    if (!w || !w.classList.contains('cheia')) return;
    w.classList.remove('cheia');
    document.documentElement.classList.remove('sem-rolagem');
    if (PLAYER) PLAYER.pintar();
  }

  // Ícones SVG (currentColor) dos controles — sem emoji na interface.
  const SVG_ABRE = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"';
  const SVG_TRACO = ' fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  const ICONES = {
    play: SVG_ABRE + '><path fill="currentColor" d="M8 5.14v13.72a1 1 0 0 0 1.52.85l10.6-6.86a1 1 0 0 0 0-1.7L9.52 4.29A1 1 0 0 0 8 5.14z"/></svg>',
    pausa: SVG_ABRE + '><path fill="currentColor" d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z"/></svg>',
    som: SVG_ABRE + SVG_TRACO + '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
    mudo: SVG_ABRE + SVG_TRACO + '<path d="M11 5 6 9H3v6h3l5 4V5z"/><path d="m16 9 5 6"/><path d="m21 9-5 6"/></svg>',
    cheia: SVG_ABRE + SVG_TRACO + '<path d="M4 9V4h5"/><path d="M20 9V4h-5"/><path d="M4 15v5h5"/><path d="M20 15v5h-5"/></svg>',
    sairCheia: SVG_ABRE + SVG_TRACO + '<path d="M9 4v5H4"/><path d="M15 4v5h5"/><path d="M9 20v-5H4"/><path d="M15 20v-5h5"/></svg>',
  };

  // Travas do player: não deixa ir além do trecho já assistido, nem acelerar, nem "terminar" pulando.
  // S = { max, fim, ancoraMidia, ancoraReal, corrigindo, ultimaPos, pos }. max = segundo mais
  // adiantado assistido de verdade. Âncora = (posição do vídeo, performance.now()) fixada em
  // play/playing/pause/waiting/seeked: o máximo só avança se o vídeo andou, DESDE A ÂNCORA, no
  // máximo o tempo real decorrido × 1,1 + 1 s (a folga não se renova a cada timeupdate, então
  // acelerar por fora, como faz uma extensão de velocidade, não passa). Aba em segundo plano
  // (timeupdate espaçado) não atrapalha: a conta é acumulada, não por evento.
  // Quem já concluiu (S.fim) revê qualquer trecho.
  // Ex.: ligarTravas(video, S, () => enviarFim()); → arrastar para frente volta para S.max;
  //      playbackRate = 2 volta para 1 (no ratechange e, se ele for barrado, no timeupdate);
  //      'ended' antes do fim real não conta.
  function ligarTravas(video, S, aoConcluir) {
    const voltarPara = (t) => {
      S.corrigindo = true;
      try { video.currentTime = t; } catch (e) { S.corrigindo = false; }
    };
    // Reancora na posição atual. Ex.: reancorar() no 'seeked' (inclusive o −10 s) e ao retomar.
    const reancorar = () => { S.ancoraMidia = video.currentTime || 0; S.ancoraReal = performance.now(); };
    // Velocidade sempre 1×. Ex.: travarVelocidade() no ratechange e em todo timeupdate.
    const travarVelocidade = () => {
      if (video.playbackRate !== 1) video.playbackRate = 1;
      if (video.defaultPlaybackRate !== 1) video.defaultPlaybackRate = 1;
    };
    let salvo = -1;
    const salvarLocal = () => {
      const s = Math.floor(S.max);
      if (s !== salvo) { salvo = s; gravarProgressoLocal(S.max, S.fim); }
    };

    video.addEventListener('seeking', () => {
      if (S.corrigindo || S.fim) return;
      if (video.currentTime > S.max + 1) {
        voltarPara(S.max);
        toast('O vídeo precisa ser assistido até o fim; não é possível adiantar.');
      }
    });
    video.addEventListener('seeked', () => { S.corrigindo = false; reancorar(); });
    // Pausa e buffering (waiting) reancoram: o tempo real parado não vira folga para acelerar depois.
    ['play', 'playing', 'pause', 'waiting'].forEach(ev => video.addEventListener(ev, reancorar));

    video.addEventListener('timeupdate', () => {
      // Extensão de velocidade pode barrar o 'ratechange' (captura + stopImmediatePropagation):
      // o timeupdate ela não barra, então a velocidade volta a 1× aqui também.
      travarVelocidade();
      if (video.seeking || S.corrigindo) return;
      const t = video.currentTime;
      if (S.ancoraReal == null) reancorar();
      if (!S.fim && t > S.max) {
        const real = (performance.now() - S.ancoraReal) / 1000;
        if (t - S.ancoraMidia <= real * 1.1 + 1) { S.max = t; salvarLocal(); }
        else voltarPara(S.max); // salto sem 'seeking' (ou tempo andando mais rápido que o relógio)
      }
      S.ultimaPos = video.currentTime;
    });

    video.addEventListener('ratechange', travarVelocidade);

    video.addEventListener('ended', () => {
      const d = duracaoDe(video);
      if (S.fim || S.max >= d - 2) {
        const novo = !S.fim;
        S.fim = true; S.max = d;
        gravarProgressoLocal(d, true);
        if (novo || !PROVA_LIBERADA) aoConcluir();
      } else {
        voltarPara(S.max);
      }
    });

    // Tela cheia NATIVA do iOS (player do sistema): só acontece quando o iOS a força (WebView de
    // app sem reprodução inline), e ali fechar deixaria o vídeo impossível de assistir (o iOS pausa
    // ao sair). Deixa tocar: é o mesmo <video>, então as travas de seeking/timeupdate/ratechange
    // continuam valendo. Aviso discreto, uma vez só.
    // Ex.: toque em Reproduzir num WebView sem inline → abre a tela cheia do sistema e segue tocando.
    let avisouTelaCheiaIos = false;
    video.addEventListener('webkitbeginfullscreen', () => {
      if (avisouTelaCheiaIos) return;
      avisouTelaCheiaIos = true;
      toast('Mesmo na tela cheia do aparelho, o vídeo não pode ser adiantado.');
    });
    video.addEventListener('webkitendfullscreen', () => { if (PLAYER) PLAYER.pintar(); });
    video.addEventListener('enterpictureinpicture', () => {
      try { if (document.exitPictureInPicture) document.exitPictureInPicture().catch(() => {}); } catch (e) { /* segue */ }
    });
    video.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('pagehide', () => gravarProgressoLocal(S.max, S.fim));
  }

  // Monta o player travado (vídeo enviado) no #videoWrap: <video> sem controles nativos + faixa de
  // controles abaixo (Play/Pausa, −5 s, −10 s, Mudo/volume, Tela cheia, progresso só de exibição, tempo).
  // Usa VIDEO/PROGRESSO/CONCLUIDO já preenchidos pelo carregarConteudo.
  // Ex.: VIDEO = d.treino.video; montarPlayerTravado(); → PLAYER.video tocando só pelos nossos botões.
  function montarPlayerTravado() {
    const wrap = $('videoWrap');
    wrap.innerHTML = '';
    wrap.classList.add('player');

    const tela = document.createElement('div');
    tela.className = 'player-tela';
    const video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.setAttribute('disablepictureinpicture', '');
    video.setAttribute('disableremoteplayback', '');
    video.setAttribute('x-webkit-airplay', 'deny');
    video.setAttribute('preload', 'metadata');
    video.setAttribute('controlslist', 'nodownload noplaybackrate noremoteplayback');
    video.setAttribute('aria-label', 'Vídeo do treinamento');
    video.playsInline = true;
    video.controls = false;
    tela.appendChild(video);

    const volOk = volumeAjustavel();
    const barra = document.createElement('div');
    barra.className = 'player-barra';
    barra.setAttribute('role', 'group');
    barra.setAttribute('aria-label', 'Controles do vídeo');
    barra.innerHTML =
      '<div class="player-prog" role="progressbar" aria-label="Progresso do vídeo" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">' +
        '<span class="player-prog-max"></span><span class="player-prog-atual"></span>' +
      '</div>' +
      '<div class="player-botoes">' +
        '<button type="button" class="player-btn" data-acao="play" aria-label="Reproduzir"></button>' +
        '<button type="button" class="player-btn player-btn-voltar" data-acao="voltar" data-seg="5" aria-label="Voltar 5 segundos">−5 s</button>' +
        '<button type="button" class="player-btn player-btn-voltar" data-acao="voltar" data-seg="10" aria-label="Voltar 10 segundos">−10 s</button>' +
        '<span class="player-tempo" aria-hidden="true">00:00 / 00:00</span>' +
        '<span class="player-espaco"></span>' +
        '<button type="button" class="player-btn" data-acao="mudo" aria-label="Tirar o som"></button>' +
        (volOk ? '<input type="range" class="player-vol" min="0" max="1" step="0.05" value="1" aria-label="Volume">' : '') +
        '<button type="button" class="player-btn" data-acao="cheia" aria-label="Tela cheia"></button>' +
      '</div>';
    wrap.appendChild(tela);
    wrap.appendChild(barra);

    const btnPlay = barra.querySelector('[data-acao="play"]');
    const btnsVoltar = barra.querySelectorAll('[data-acao="voltar"]');
    const btnMudo = barra.querySelector('[data-acao="mudo"]');
    const btnCheia = barra.querySelector('[data-acao="cheia"]');
    const vol = barra.querySelector('.player-vol');
    const prog = barra.querySelector('.player-prog');
    const progMax = barra.querySelector('.player-prog-max');
    const progAtual = barra.querySelector('.player-prog-atual');
    const tempo = barra.querySelector('.player-tempo');

    // Estado das travas. Concluído no servidor/localStorage (ou link já aprovado) → revê à vontade.
    const loc = lerProgressoLocal();
    const servidorFim = !!(PROGRESSO && PROGRESSO.concluidoTs);
    const S = { max: loc.max, fim: loc.fim || servidorFim || CONCLUIDO, ancoraMidia: 0, ancoraReal: null, corrigindo: false, ultimaPos: 0, pos: null };
    if (S.fim) {
      S.max = Number(VIDEO.duracaoSeg) || S.max;
      if (!loc.fim) gravarProgressoLocal(S.max, true);
    }
    // Retoma de onde parou (aplicado no loadedmetadata; quem já concluiu começa do início).
    S.pos = (!S.fim && S.max > 2) ? S.max : 0;
    if (inicioOk === false && PROGRESSO && PROGRESSO.iniciadoTs) inicioOk = true;

    // Repinta botões, tempo e barra. Ex.: pintar() depois de play/pause/timeupdate/volumechange.
    function pintar() {
      const dur = duracaoDe(video);
      const tocando = !video.paused && !video.ended;
      btnPlay.innerHTML = tocando ? ICONES.pausa : ICONES.play;
      btnPlay.setAttribute('aria-label', tocando ? 'Pausar' : 'Reproduzir');
      const semSom = video.muted || video.volume === 0;
      btnMudo.innerHTML = semSom ? ICONES.mudo : ICONES.som;
      btnMudo.setAttribute('aria-label', semSom ? 'Ativar o som' : 'Tirar o som');
      if (vol && document.activeElement !== vol) vol.value = String(video.muted ? 0 : video.volume);
      const cheio = !!telaCheiaNativa() || wrap.classList.contains('cheia');
      btnCheia.innerHTML = cheio ? ICONES.sairCheia : ICONES.cheia;
      btnCheia.setAttribute('aria-label', cheio ? 'Sair da tela cheia' : 'Tela cheia');
      const t = Math.min(video.currentTime || 0, dur || 0);
      const pct = dur ? Math.min(100, (t / dur) * 100) : 0;
      const pctMax = dur ? Math.min(100, (Math.min(S.max, dur) / dur) * 100) : 0;
      progAtual.style.width = pct.toFixed(2) + '%';
      progMax.style.width = pctMax.toFixed(2) + '%';
      prog.setAttribute('aria-valuenow', String(Math.round(pct)));
      prog.setAttribute('aria-valuetext', fmtTempo(t) + ' de ' + fmtTempo(dur));
      tempo.textContent = fmtTempo(t) + ' / ' + fmtTempo(dur);
    }

    // Play/Pausa. play() é chamado de forma SÍNCRONA no gesto (iOS); o 'inicio' vai depois, sem await.
    // Ex.: alternarPlay() no clique do botão ou do próprio vídeo.
    function alternarPlay() {
      if (video.paused || video.ended) {
        const p = video.play();
        if (p && p.catch) p.catch(() => { toast('Não foi possível iniciar o vídeo. Toque em Reproduzir de novo.', 'erro'); pintar(); });
        registrarInicio();
      } else {
        video.pause();
      }
    }

    btnPlay.addEventListener('click', alternarPlay);
    tela.addEventListener('click', alternarPlay);
    tela.addEventListener('contextmenu', (e) => e.preventDefault());
    // Voltar N segundos (−5 s e −10 s, 1.55.42): voltar é sempre permitido (a trava só barra ADIANTAR
    // além do já assistido); o 'seeked' reancora o relógio. Ex.: clique em "−5 s" com o vídeo em
    // 00:12 → 00:07; em 00:03 → 00:00.
    btnsVoltar.forEach((b) => b.addEventListener('click', () => {
      const seg = Number(b.dataset.seg) || 10;
      try { video.currentTime = Math.max(0, (video.currentTime || 0) - seg); } catch (e) { /* segue */ }
    }));
    btnMudo.addEventListener('click', () => {
      if (video.muted || video.volume === 0) { video.muted = false; if (video.volume === 0) video.volume = 1; }
      else video.muted = true;
    });
    if (vol) {
      vol.addEventListener('input', () => {
        const v = Math.max(0, Math.min(1, Number(vol.value) || 0));
        video.volume = v;
        video.muted = (v === 0);
      });
    }
    btnCheia.addEventListener('click', () => alternarTelaCheia(wrap));
    document.addEventListener('fullscreenchange', pintar);
    document.addEventListener('webkitfullscreenchange', pintar);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') sairPseudoCheia(); });

    ligarTravas(video, S, enviarFim);

    // Retomada: loadedmetadata leva à posição pendente (<= max); o canplay repete porque o Safari
    // às vezes ignora o currentTime aplicado cedo demais.
    video.addEventListener('loadedmetadata', () => {
      S.corrigindo = false;
      const dur = duracaoDe(video);
      if (S.fim) S.max = dur;
      else if (S.max > dur) S.max = dur;
      if (S.pos != null) {
        const alvo = Math.max(0, Math.min(S.pos, S.max, dur ? dur - 0.5 : S.pos));
        if (alvo > 0.5) { try { video.currentTime = alvo; } catch (e) { /* segue */ } }
      }
      pintar();
    });
    video.addEventListener('canplay', () => {
      if (S.pos == null) return;
      const alvo = Math.max(0, Math.min(S.pos, S.max));
      if (alvo > 0.5 && Math.abs((video.currentTime || 0) - alvo) > 1) {
        try { video.currentTime = alvo; } catch (e) { /* segue */ }
      }
      S.pos = null;
    });
    // Tocou de verdade: zera as renovações de URL e limpa avisos de carga (menos o "Liberando a prova…").
    video.addEventListener('playing', () => { renovacoes = 0; if (!fimEnviando) avisarPlayer(''); ligarBatimento(true); });
    video.addEventListener('pause', () => { ligarBatimento(false); gravarProgressoLocal(S.max, S.fim); });
    video.addEventListener('ended', () => ligarBatimento(false));
    video.addEventListener('error', () => { ligarBatimento(false); renovarUrl(); });
    ['play', 'pause', 'ended', 'timeupdate', 'durationchange', 'volumechange', 'seeked'].forEach(ev => video.addEventListener(ev, pintar));

    PLAYER = { video, wrap, S, pintar };
    pintar();
    video.src = VIDEO.url;
  }

  // Monta o player (iframe /preview do Drive) dentro do wrapper 16:9. O FILE_ID já vem
  // sanitizado do servidor; ainda assim validamos o formato antes de injetar na URL.
  // Mensagem centralizada no lugar do vídeo (fundo preto do #videoWrap).
  // Ex.: mensagemNoVideo('O vídeo está indisponível no momento. Fale com o RH.');
  function mensagemNoVideo(msg) {
    const wrap = $('videoWrap');
    wrap.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'video-msg';
    div.textContent = msg;
    wrap.appendChild(div);
  }

  function montarPlayer(treino) {
    const wrap = $('videoWrap');
    const fileId = (treino && treino.fileId) || '';
    if (!/^[A-Za-z0-9_-]{20,}$/.test(fileId)) {
      mensagemNoVideo('Vídeo ainda não configurado para este treinamento. Fale com o RH.');
      return;
    }
    const iframe = document.createElement('iframe');
    iframe.src = 'https://drive.google.com/file/d/' + encodeURIComponent(fileId) + '/preview';
    iframe.setAttribute('allow', 'autoplay');
    iframe.setAttribute('allowfullscreen', '');
    iframe.title = 'Vídeo do treinamento';
    wrap.appendChild(iframe);
    // Obs.: NÃO dá p/ bloquear de forma confiável só a barra de progresso do player. O vídeo é um
    // iframe do Drive que, por dentro, roda o player do YouTube (origem cruzada — não alcançável por
    // JS daqui). Uma camada por cima exigiria chutar a posição da barra (o YouTube muda esse layout
    // em testes A/B e ela encolhe no celular) e, pior, some quando o usuário entra em tela cheia
    // (o iframe vai p/ frente de tudo), deixando a barra livre. Com tela cheia liberada, qualquer
    // bloqueio é furado por ela. Mantido o player normal; a trava existe só no vídeo ENVIADO
    // (montarPlayerTravado), que roda num <video> nosso.
  }

  // Cabeçalho + player. Recebe { nome, ...treino }.
  function montarPagina(treino) {
    const nome = (treino && treino.nome) || '';
    $('status-screen').style.display = 'none';
    $('player-main').style.display = 'block';

    if (nome) { $('trnSaud').textContent = 'Olá, ' + nome + '.'; }
    $('trnTit').childNodes[0].nodeValue = (treino && treino.titulo) || 'Treinamento';
    const tipoEl = $('trnTipo');
    if (treino && treino.tipo) {
      tipoEl.textContent = treino.tipo === 'curso' ? 'Curso' : 'NR';
      tipoEl.hidden = false;
    }
    if (treino && treino.descricao) {
      const d = $('trnDesc'); d.textContent = treino.descricao; d.hidden = false;
    }
    // Vídeo enviado → player travado; vídeo enviado sem URL → aviso de indisponível (sem a dica do
    // Drive, que não se aplica); senão, o Drive de sempre (com a dica de compartilhamento).
    if (VIDEO) {
      montarPlayerTravado();
    } else if (VIDEO_INDISP) {
      mensagemNoVideo('O vídeo está indisponível no momento. Fale com o RH.');
    } else {
      $('playerHelp').hidden = false;
      montarPlayer(treino);
    }
  }

  // Renderiza a prova: uma escolha (radio) por questão. esc() em todo texto (sem XSS).
  function renderProva(questoes) {
    const box = $('provaQuestoes');
    box.innerHTML = '';
    (questoes || []).forEach((q, qi) => {
      const fs = document.createElement('fieldset');
      fs.className = 'q';
      fs.dataset.qid = q.id;
      const enun = document.createElement('div');
      enun.className = 'q-enun';
      enun.innerHTML = '<span class="num">' + (qi + 1) + '.</span> ' + escapeHtml(q.enunciado);
      fs.appendChild(enun);
      (q.alternativas || []).forEach(a => {
        const lab = document.createElement('label');
        lab.className = 'alt';
        const inp = document.createElement('input');
        inp.type = 'radio';
        inp.name = 'q_' + q.id;
        inp.value = a.id;
        const span = document.createElement('span');
        span.textContent = a.texto;
        lab.appendChild(inp);
        lab.appendChild(span);
        fs.appendChild(lab);
      });
      box.appendChild(fs);
    });
  }

  // Coleta as respostas marcadas → { [questaoId]: alternativaId }. Retorna null se faltar alguma.
  function coletarRespostas() {
    const respostas = {};
    const questoes = (TREINO && TREINO.questoes) || [];
    for (const q of questoes) {
      const sel = document.querySelector('input[name="q_' + (window.CSS && CSS.escape ? CSS.escape(q.id) : q.id) + '"]:checked');
      if (!sel) return null; // questão sem resposta
      respostas[q.id] = sel.value;
    }
    return respostas;
  }

  function limparRespostas() {
    document.querySelectorAll('#provaQuestoes input[type="radio"]:checked').forEach(i => { i.checked = false; });
  }

  // Tela de resultado. nota pode ser null quando o link é reaberto já concluído (nota desconhecida).
  function mostrarResultado(aprovado, nota) {
    $('stepTabResult').disabled = false;
    mostrarPasso('result');
    const icon = $('resultIcon'), tit = $('resultTit'), msg = $('resultMsg'), acoes = $('resultActions');
    acoes.innerHTML = '';
    if (aprovado) {
      pintarIconeTela(icon, 'aprovado');
      tit.textContent = 'Aprovado';
      tit.className = 'result-tit ok';
      msg.textContent = (nota != null)
        ? ('Aprovado! Nota ' + nota + '. Seu atestado já está nos seus documentos.')
        : ('Você já concluiu este treinamento. Seu atestado está nos seus documentos.');
    } else {
      pintarIconeTela(icon, 'reprovado');
      tit.textContent = 'Não aprovado';
      tit.className = 'result-tit fail';
      msg.textContent = 'Você não atingiu a nota mínima (' + (nota != null ? nota : 0) + '). Reveja o vídeo e tente novamente.';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn';
      btn.textContent = 'Refazer prova';
      btn.addEventListener('click', () => {
        limparRespostas();
        $('stepTabResult').disabled = true;
        // Vídeo travado já concluído: refazer a prova NÃO exige rever o vídeo (vai direto à prova).
        // Drive: volta ao vídeo, como sempre foi.
        mostrarPasso((VIDEO || VIDEO_INDISP) && !provaBloqueada() ? 'prova' : 'video');
      });
      acoes.appendChild(btn);
    }
  }

  // Envia as respostas para correção no servidor.
  async function enviar() {
    const respostas = coletarRespostas();
    if (!respostas) { toast('Responda todas as questões antes de enviar.', 'erro'); return; }
    const btn = $('btnEnviar');
    btn.disabled = true;
    try {
      const r = await fetch(API + '/responder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ respostas }),
      });
      const d = await r.json().catch(() => ({}));
      // O servidor exige um vídeo que esta página não está mostrando (o RH trocou o vídeo, ou o
      // treinamento passou do Drive para vídeo enviado, com a página aberta): voltar ao player
      // antigo não resolve → pede para recarregar.
      if (r.status === 409 && d && d.codigo === 'VIDEO_PENDENTE') {
        // Vídeo indisponível: a prova já estava bloqueada e só o RH destrava; recarregar não ajuda.
        if (VIDEO_INDISP) {
          PROVA_LIBERADA = false;
          aplicarGateProva();
          mostrarPasso('video');
          toast(msgGateProva(), 'erro');
          return;
        }
        mostrarTreinoAtualizado();
        return;
      }
      if (r.status === 409 && d && d.codigo === 'SEM_VIDEO') { mostrarTreinoAtualizado(); return; }
      if (r.status === 409 && d && d.codigo === 'LINK_FECHADO') { mostrarLinkFechado(d.status); return; }
      if (!r.ok || !d.ok) {
        toast((d && d.erro) || 'Não foi possível enviar as respostas. Tente novamente.', 'erro');
        return;
      }
      if (d.aprovado) { CONCLUIDO = true; }
      mostrarResultado(!!d.aprovado, typeof d.nota === 'number' ? d.nota : null);
    } catch (e) {
      toast('Erro de conexão ao enviar. Verifique sua internet e tente de novo.', 'erro');
    } finally {
      btn.disabled = false;
    }
  }

  // ----- Comentários (coluna à direita do vídeo) -----
  // A pessoa diz se o vídeo/página funcionou ("Está OK" / "Tem problema") e pode descrever.
  // "Tem problema" exige texto (o servidor também confere). Cada envio ACRESCENTA um comentário;
  // a lista abaixo mostra o que ela já mandou, do mais novo para o mais antigo.
  // USO: renderComentarios([{ id, ts, avaliacao: 'ok', texto: 'Tudo certo' }]) → preenche #comentLista.
  function renderComentarios(lista) {
    const itens = (Array.isArray(lista) ? lista : []).slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
    $('comentHist').hidden = !itens.length;
    $('comentHistTit').textContent = itens.length === 1 ? 'Você enviou 1 comentário' : 'Você enviou ' + itens.length + ' comentários';
    const ul = $('comentLista');
    ul.innerHTML = '';
    itens.forEach(c => {
      const li = document.createElement('li');
      li.className = 'coment-item';
      const cab = document.createElement('div');
      cab.className = 'coment-item-cab';
      const tag = document.createElement('span');
      tag.className = 'coment-tag ' + (c.avaliacao === 'problema' ? 'problema' : 'ok');
      tag.textContent = c.avaliacao === 'problema' ? 'Tem problema' : 'Está OK';
      const quando = document.createElement('span');
      quando.className = 'coment-quando';
      quando.textContent = c.ts ? new Date(c.ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
      cab.appendChild(tag); cab.appendChild(quando); li.appendChild(cab);
      if (c.texto) { const p = document.createElement('p'); p.textContent = c.texto; li.appendChild(p); }
      ul.appendChild(li);
    });
  }
  function avaliacaoMarcada() {
    const sel = document.querySelector('input[name="comentAval"]:checked');
    return sel ? sel.value : '';
  }
  function atualizarFormComentario() {
    const txt = $('comentTexto');
    $('comentCont').textContent = txt.value.length + '/1000';
    $('comentTxtObrig').textContent = avaliacaoMarcada() === 'problema' ? '(obrigatório)' : '(opcional)';
  }
  function erroComentario(msg) {
    const el = $('comentErro');
    el.textContent = msg || '';
    el.hidden = !msg;
  }
  async function enviarComentario() {
    const avaliacao = avaliacaoMarcada();
    const texto = $('comentTexto').value.trim();
    if (!avaliacao) { erroComentario('Escolha "Está OK" ou "Tem problema".'); return; }
    if (avaliacao === 'problema' && !texto) { erroComentario('Descreva o problema que você encontrou.'); $('comentTexto').focus(); return; }
    erroComentario('');
    const btn = $('comentEnviar');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    try {
      const r = await fetch(API + '/comentarios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ avaliacao, texto }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { erroComentario((d && d.erro) || 'Não foi possível enviar o comentário. Tente de novo.'); return; }
      $('comentTexto').value = '';
      document.querySelectorAll('input[name="comentAval"]').forEach(i => { i.checked = false; });
      atualizarFormComentario();
      renderComentarios(d.comentarios);
      toast('Comentário enviado. Obrigado!');
    } catch (e) {
      erroComentario('Erro de conexão. Verifique sua internet e tente de novo.');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Enviar comentário';
    }
  }

  function ligarEventos() {
    $('comentEnviar').addEventListener('click', enviarComentario);
    $('comentTexto').addEventListener('input', atualizarFormComentario);
    document.querySelectorAll('input[name="comentAval"]').forEach(i => i.addEventListener('change', () => { erroComentario(''); atualizarFormComentario(); }));
    $('btnIrProva').addEventListener('click', () => {
      if (provaBloqueada()) { aplicarGateProva(); return; }
      mostrarPasso('prova');
    });
    $('btnVoltarVideo').addEventListener('click', () => mostrarPasso('video'));
    $('btnEnviar').addEventListener('click', enviar);
    // Abas: Vídeo/Prova navegáveis livremente (a Prova só depois do vídeo travado concluído);
    // Resultado só após ter um resultado (disabled controla).
    $('stepTabVideo').addEventListener('click', () => mostrarPasso('video'));
    $('stepTabProva').addEventListener('click', () => { if (!CONCLUIDO && !provaBloqueada()) mostrarPasso('prova'); });
    $('stepTabResult').addEventListener('click', () => { if (!$('stepTabResult').disabled) mostrarPasso('result'); });
  }

  // ----- Gate de CPF: confirma a identidade antes de liberar o conteúdo -----
  function mascararCpfBR(v) {
    const d = String(v || '').replace(/\D/g, '').slice(0, 11);
    if (d.length > 9) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{1,2})/, '$1.$2.$3-$4');
    if (d.length > 6) return d.replace(/(\d{3})(\d{3})(\d{1,3})/, '$1.$2.$3');
    if (d.length > 3) return d.replace(/(\d{3})(\d{1,3})/, '$1.$2');
    return d;
  }
  function mostrarGateCpf() {
    $('status-screen').style.display = 'none';
    $('player-main').style.display = 'none';
    $('cpf-screen').style.display = 'block';
    const inp = $('cpfInput'); if (inp) inp.focus();
  }
  let _gateLigado = false;
  function ligarGateCpf() {
    if (_gateLigado) return; _gateLigado = true;
    const inp = $('cpfInput'), btn = $('cpfEntrar');
    if (inp) {
      inp.addEventListener('input', () => { inp.value = mascararCpfBR(inp.value); });
      inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); entrarComCpf(); } });
    }
    if (btn) btn.addEventListener('click', entrarComCpf);
  }
  async function entrarComCpf() {
    const inp = $('cpfInput'), btn = $('cpfEntrar'), erro = $('cpfErro');
    const dig = (inp.value || '').replace(/\D/g, '');
    if (dig.length !== 11) { erro.textContent = 'Digite os 11 dígitos do seu CPF.'; erro.style.display = 'block'; return; }
    erro.style.display = 'none'; btn.disabled = true;
    try {
      const r = await fetch(API + '/entrar', {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ cpf: dig }),
      });
      const d = await r.json().catch(() => ({}));
      // Link venceu/foi cancelado entre abrir a página e digitar o CPF → tela de status.
      if (r.status === 409 && d && d.codigo === 'LINK_FECHADO') { mostrarLinkFechado(d.status); return; }
      if (!r.ok || !d.ok) { erro.textContent = (d && d.erro) || 'Não foi possível entrar. Tente novamente.'; erro.style.display = 'block'; btn.disabled = false; return; }
      $('cpf-screen').style.display = 'none';
      carregarConteudo(d);
    } catch (e) {
      erro.textContent = 'Erro de conexão. Verifique sua internet e tente de novo.'; erro.style.display = 'block'; btn.disabled = false;
    }
  }
  // Monta o treinamento a partir dos dados liberados após o gate de CPF.
  function carregarConteudo(d) {
    if (!d.treino) { mostrarStatus('aviso', 'Treinamento indisponível', 'O conteúdo deste treinamento não foi encontrado. Fale com o RH.'); return; }
    TREINO = d.treino;
    CONCLUIDO = (d.status === 'concluido');
    VIDEO = videoValido(d.treino.video);
    // treino.video veio (o treinamento tem vídeo enviado), mas sem URL usável → vídeo indisponível.
    VIDEO_INDISP = !VIDEO && !!d.treino.video && typeof d.treino.video === 'object';
    PROGRESSO = (d.progresso && typeof d.progresso === 'object') ? d.progresso : null;
    // Sem vídeo enviado a prova é livre; com vídeo (mesmo indisponível), vale o que o servidor disser.
    PROVA_LIBERADA = (VIDEO || VIDEO_INDISP) ? !!(PROGRESSO && PROGRESSO.provaLiberada) : true;
    $('player-main').style.display = 'block';
    montarPagina(Object.assign({ nome: d.nome }, d.treino));
    renderProva(d.treino.questoes || []);
    renderComentarios(d.comentarios);
    ligarEventos();
    aplicarGateProva();
    // Link já aprovado: mostra direto o estado concluído (sem permitir nova tentativa) — Open Question 1.
    if (CONCLUIDO) {
      $('stepTabProva').disabled = true;
      mostrarResultado(true, null);
    } else {
      mostrarPasso('video');
    }
    // Terminou o vídeo antes (localStorage) mas o servidor não registrou o fim → reenvia ao abrir.
    if (VIDEO && !CONCLUIDO && !(PROGRESSO && PROGRESSO.concluidoTs) && lerProgressoLocal().fim) enviarFim();
  }

  // Valida o estado do link no servidor; depois pede o CPF (gate) antes de liberar o conteúdo.
  async function init() {
    if (!TOKEN) { mostrarStatus('link', 'Link inválido', 'Este endereço não contém um código de acesso válido.'); return; }
    try {
      const r = await fetch(API, { headers: { 'Accept': 'application/json' } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { mostrarStatus('link', 'Link inválido', (d && d.erro) || 'Este link de treinamento não foi encontrado.'); return; }
      if (d.status === 'expirado' || d.status === 'cancelado') {
        mostrarLinkFechado(d.status);
        return;
      }
      // aguardando / concluído → exige confirmar o CPF para entrar.
      ligarGateCpf();
      mostrarGateCpf();
    } catch (e) {
      mostrarStatus('aviso', 'Erro de conexão', 'Não foi possível validar o link. Verifique sua internet e tente recarregar a página.');
    }
  }

  init();
})();
