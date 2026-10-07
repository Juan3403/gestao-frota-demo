// Assinatura a distância de Ficha de EPI — Gestão RM.
// Servido sem login; a proteção é o token na URL (/assinar-epi/<token>). Sem handlers inline
// (CSP do site não permite 'unsafe-inline' em script-src) → tudo via addEventListener.
(function () {
  'use strict';

  const TOKEN = decodeURIComponent((location.pathname.split('/').filter(Boolean).pop() || ''));
  const API = '/api/epi/publico/assinar/' + encodeURIComponent(TOKEN);

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function toast(msg, tipo) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'show' + (tipo === 'erro' ? ' erro' : '');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.className = ''; }, 3800);
  }

  function mostrarStatus(icon, titulo, msg) {
    $('status-icon').textContent = icon;
    $('status-title').textContent = titulo;
    $('status-msg').textContent = msg;
    $('status-screen').style.display = 'block';
    $('form-main').style.display = 'none';
    $('success-screen').style.display = 'none';
  }

  const DECLARACAO = 'Declaro ter recebido(a) equipamento(s) de proteção(ões) individual(ais) descritos nessa ficha, destinados ao '
    + 'meu uso pessoal durante o serviço. Declaro ter recebido treinamento(s) e orientação(ões) sobre o uso, guarda e conservação dos mesmos, '
    + 'responsabilizando-me também por sua devolução à empresa na eventual rescisão do meu contrato de trabalho, ou quando não mais se fizerem '
    + 'necessários ao fim a que se destinam. Conforme o item 6.7.1 da NR-6 e o art. 461 da CLT, o prejuízo decorrente do extravio ou danificação '
    + 'do equipamento a mim confiado poderá ser descontado do meu salário, salvo quando causado pelo desgaste natural de utilização. Que na não '
    + 'observância do seu uso, por negligência, os danos e/ou lesões resultantes de acidentes serão de minha inteira responsabilidade.';

  // ---- Quadro de assinatura (desenho à mão + modo digitado) ----
  const ctxAssina = { canvas: null, ctx: null, tracos: [], atual: null, desenhando: false, temTraco: false, modo: 'desenho' };

  function prepararCanvas() {
    const cv = $('assina-canvas');
    const rect = cv.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.max(1, Math.round(rect.width * dpr));
    cv.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.lineWidth = 2.4; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = '#14181f';
    ctxAssina.canvas = cv; ctxAssina.ctx = ctx;
    redesenhar();
  }
  function redesenhar() {
    const { ctx, canvas, tracos } = ctxAssina;
    if (!ctx || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    for (const traco of tracos) {
      if (!traco.length) continue;
      ctx.beginPath(); ctx.moveTo(traco[0].x, traco[0].y);
      if (traco.length === 1) ctx.lineTo(traco[0].x + 0.1, traco[0].y);
      else for (let i = 1; i < traco.length; i++) ctx.lineTo(traco[i].x, traco[i].y);
      ctx.stroke();
    }
    ctxAssina.temTraco = tracos.some(t => t.length);
    $('dica-assina').hidden = ctxAssina.temTraco;
    $('btn-desfazer').disabled = !tracos.length;
    atualizarBotaoConfirmar();
  }
  function pontoAssina(ev) {
    const rect = ctxAssina.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top };
  }
  function ligarCanvas() {
    const cv = $('assina-canvas');
    cv.addEventListener('pointerdown', (ev) => {
      if (!ctxAssina.ctx) prepararCanvas();
      ev.preventDefault();
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* segue sem captura */ }
      ctxAssina.desenhando = true;
      const p = pontoAssina(ev);
      ctxAssina.atual = [p];
      ctxAssina.tracos.push(ctxAssina.atual);
      ctxAssina.ctx.beginPath(); ctxAssina.ctx.moveTo(p.x, p.y); ctxAssina.ctx.lineTo(p.x + 0.1, p.y); ctxAssina.ctx.stroke();
      ctxAssina.temTraco = true;
      $('dica-assina').hidden = true;
      $('btn-desfazer').disabled = false;
      atualizarBotaoConfirmar();
    });
    cv.addEventListener('pointermove', (ev) => {
      if (!ctxAssina.desenhando) return;
      ev.preventDefault();
      const p = pontoAssina(ev);
      if (ctxAssina.atual) ctxAssina.atual.push(p);
      ctxAssina.ctx.lineTo(p.x, p.y); ctxAssina.ctx.stroke();
    });
    const soltar = (ev) => {
      if (!ctxAssina.desenhando) return;
      ctxAssina.desenhando = false; ctxAssina.atual = null;
      try { cv.releasePointerCapture(ev.pointerId); } catch (e) { /* ponteiro já liberado */ }
    };
    cv.addEventListener('pointerup', soltar);
    cv.addEventListener('pointercancel', soltar);
    cv.addEventListener('pointerleave', soltar);
  }
  function recortarAssinatura(cv) {
    const ctx = cv.getContext('2d');
    const { width: w, height: h } = cv;
    let dados;
    try { dados = ctx.getImageData(0, 0, w, h).data; } catch (e) { return cv; }
    let minX = w, minY = h, maxX = -1, maxY = -1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (dados[(y * w + x) * 4 + 3] > 8) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const folga = Math.round(Math.min(w, h) * 0.04);
    minX = Math.max(0, minX - folga); minY = Math.max(0, minY - folga);
    maxX = Math.min(w - 1, maxX + folga); maxY = Math.min(h - 1, maxY + folga);
    const out = document.createElement('canvas');
    out.width = maxX - minX + 1; out.height = maxY - minY + 1;
    out.getContext('2d').drawImage(cv, minX, minY, out.width, out.height, 0, 0, out.width, out.height);
    return out;
  }
  function canvasDaAssinaturaDigitada(nome) {
    const texto = String(nome || '').trim();
    if (!texto) return null;
    const cv = document.createElement('canvas');
    const escala = 3;
    const fonte = (px) => `italic 600 ${px}px "Segoe Script", "Brush Script MT", "Snell Roundhand", cursive`;
    const ctx = cv.getContext('2d');
    let tam = 64; ctx.font = fonte(tam);
    const larguraAlvo = 620;
    const larg = ctx.measureText(texto).width;
    if (larg > larguraAlvo) tam = Math.max(26, Math.floor(tam * (larguraAlvo / larg)));
    cv.width = Math.ceil((Math.min(larg, larguraAlvo) + 40) * escala);
    cv.height = Math.ceil((tam + 30) * escala);
    const c2 = cv.getContext('2d');
    c2.scale(escala, escala); c2.font = fonte(tam); c2.fillStyle = '#14181f'; c2.textBaseline = 'middle';
    c2.fillText(texto, 20, (tam + 30) / 2);
    return cv;
  }
  function atualizarBotaoConfirmar() {
    const btn = $('btn-confirmar');
    const nome = $('nome-quem-assina').value.trim();
    const temAssinatura = ctxAssina.modo === 'digitado' ? nome.length >= 3 : ctxAssina.temTraco;
    const aceite = $('aceite-check').checked;
    btn.disabled = !(temAssinatura && aceite);
  }

  function iniciarQuadroAssinatura() {
    ligarCanvas();
    requestAnimationFrame(prepararCanvas);
    window.addEventListener('resize', () => { if (ctxAssina.modo === 'desenho') prepararCanvas(); });
    $('modo-desenhar').addEventListener('click', () => trocarModo('desenho'));
    $('modo-digitar').addEventListener('click', () => trocarModo('digitado'));
    $('btn-limpar').addEventListener('click', () => { ctxAssina.tracos = []; redesenhar(); });
    $('btn-desfazer').addEventListener('click', () => { ctxAssina.tracos.pop(); redesenhar(); });
    $('nome-quem-assina').addEventListener('input', () => {
      $('previa-assinatura').textContent = $('nome-quem-assina').value.trim();
      atualizarBotaoConfirmar();
    });
    $('aceite-check').addEventListener('change', atualizarBotaoConfirmar);
  }
  function trocarModo(modo) {
    ctxAssina.modo = modo;
    $('modo-desenhar').classList.toggle('on', modo === 'desenho');
    $('modo-digitar').classList.toggle('on', modo === 'digitado');
    $('quadro-desenho').style.display = modo === 'desenho' ? 'block' : 'none';
    $('quadro-digitado').style.display = modo === 'digitado' ? 'flex' : 'none';
    if (modo === 'desenho') requestAnimationFrame(prepararCanvas);
    atualizarBotaoConfirmar();
  }

  // ---- Carrega o status do link e monta a tela ----
  async function iniciar() {
    if (!TOKEN) { mostrarStatus('⚠️', 'Link inválido', 'Esse endereço não tem um código de assinatura válido.'); return; }
    let r, j;
    try { r = await fetch(API); j = await r.json(); }
    catch (e) { mostrarStatus('⚠️', 'Falha de conexão', 'Não consegui carregar o link agora. Verifique sua internet e recarregue a página.'); return; }
    if (!r.ok || !j.ok) { mostrarStatus('⚠️', 'Link inválido', 'Este link de assinatura não existe ou foi removido.'); return; }
    if (j.estado === 'assinado') {
      mostrarStatus('✅', 'Ficha já assinada', `${j.nome ? esc(j.nome) + ' já assinou' : 'Esta ficha já foi assinada'} esta ficha` + (j.assinadoEm ? ` em ${new Date(j.assinadoEm).toLocaleString('pt-BR')}` : '') + '.');
      return;
    }
    if (j.estado === 'expirado') {
      mostrarStatus('⏰', 'Link expirado', 'Este link de assinatura não é mais válido. Peça para gerarem um novo.');
      return;
    }
    montarFormulario(j.ficha || {});
  }

  function montarFormulario(ficha) {
    $('status-screen').style.display = 'none';
    $('form-main').style.display = 'block';
    $('colab-nome').textContent = ficha.funcionarioNome || 'colaborador';
    $('nome-quem-assina').value = ficha.funcionarioNome || '';
    $('previa-assinatura').textContent = ficha.funcionarioNome || '';
    $('aceite-texto').textContent = DECLARACAO;
    $('itens-lista').innerHTML = (ficha.itens || []).map(i => {
      const meta = [i.ca ? `CA ${esc(i.ca)}` : '', i.tamanho ? `tam. ${esc(i.tamanho)}` : ''].filter(Boolean).join(' · ');
      return `<div class="item"><span class="item-tit">${esc(i.nome)} <b>${esc(String(i.quantidade))} ${esc(i.unidade || 'un')}</b></span>`
        + (meta ? `<span class="item-sub">${meta}</span>` : '') + '</div>';
    }).join('') || '<p class="item-sub">Nenhum item nesta ficha.</p>';
    iniciarQuadroAssinatura();
    $('btn-confirmar').addEventListener('click', confirmarAssinatura);
  }

  async function confirmarAssinatura() {
    const btn = $('btn-confirmar');
    if (btn.disabled) return;
    const erroBox = $('erro-envio');
    erroBox.style.display = 'none';
    let cvFinal;
    if (ctxAssina.modo === 'digitado') {
      cvFinal = canvasDaAssinaturaDigitada($('nome-quem-assina').value);
    } else {
      cvFinal = recortarAssinatura(ctxAssina.canvas);
    }
    if (!cvFinal) { toast('Assine no quadro antes de confirmar.', 'erro'); return; }
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const imagem = cvFinal.toDataURL('image/png');
      const r = await fetch(API, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imagem, aceite: $('aceite-check').checked, nome: $('nome-quem-assina').value.trim(), modo: ctxAssina.modo,
        }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.erro || 'Não foi possível registrar a assinatura.');
      $('form-main').style.display = 'none';
      $('success-screen').style.display = 'block';
    } catch (e) {
      erroBox.textContent = e.message || 'Não foi possível registrar a assinatura. Tente novamente.';
      erroBox.style.display = 'block';
      btn.disabled = false; btn.textContent = 'Confirmar assinatura';
      atualizarBotaoConfirmar();
    }
  }

  iniciar();
})();
