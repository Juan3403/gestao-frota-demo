/* Conferência pública de um documento assinado (recibo do almoxarifado, ficha de EPI...).
   O layout é o mesmo para todos: o servidor manda `documento` e `rotulos` para trocar só os
   textos que mudam de módulo para módulo (ver MODULOS_VERIFICACAO no server.js).
   JS externo (sem handler inline) por causa do CSP `script-src 'self'` · mesmo motivo
   de admissao.js e treinamento.js. */
(() => {
  const form = document.getElementById('formVerificar');
  const campo = document.getElementById('codigo');
  const botao = document.getElementById('btnVerificar');
  const caixa = document.getElementById('resultado');

  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const dataBR = (iso) => {
    const m = String(iso || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso || '—');
  };
  const carimbo = (ts) => ts ? new Date(ts).toLocaleString('pt-BR') : '—';

  // Deixa o código sempre no formato impresso (XXXX-XXXX-XXXX) enquanto a pessoa digita,
  // aceitando que ela cole com ou sem os hífens.
  function formatar(valor) {
    const limpo = String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    return limpo.replace(/(.{4})(?=.)/g, '$1-');
  }
  campo.addEventListener('input', () => {
    const pos = campo.selectionStart === campo.value.length;
    campo.value = formatar(campo.value);
    if (pos) campo.setSelectionRange(campo.value.length, campo.value.length);
  });

  const selo = (classe, ico, titulo, texto) => `
    <div class="selo ${classe}">
      <div class="selo-ico" aria-hidden="true">${ico}</div>
      <div class="selo-txt"><strong>${esc(titulo)}</strong><span>${esc(texto)}</span></div>
    </div>`;

  function mostrarErro(mensagem) {
    caixa.hidden = false;
    caixa.innerHTML = selo('erro', '!', 'Não foi possível confirmar', mensagem);
  }

  function mostrar(d) {
    const campos = [
      ['Colaborador', d.colaborador],
      ['Cargo', d.cargo],
      ['Empresa', d.empresa],
      [(d.rotulos && d.rotulos.data) || 'Data da retirada', dataBR(d.data) + (d.hora ? ' às ' + d.hora : '')],
      ['Entregue por', d.entreguePor],
    ].filter(([, v]) => String(v || '').trim());

    const evidencias = [
      ['Assinado por', d.assinadoPor],
      ['Data da assinatura', carimbo(d.assinadoEm)],
      ['Forma', d.forma],
      ['Dispositivo', d.dispositivo],
      ['Declaração de recebimento', d.aceite ? 'Confirmada pelo signatário' : 'sem registro'],
    ].filter(([, v]) => String(v || '').trim());

    const itens = (d.itens || []).map(i => `
      <div class="item">
        <span>${esc(i.nome)}${i.tipo ? `<span class="tipo">${esc(i.tipo)}</span>` : ''}</span>
        <b>${esc(String(i.quantidade))} ${esc(i.unidade || 'un')}</b>
      </div>`).join('') || '<div class="item"><span>Nenhum item registrado</span></div>';

    // A frase do selo vem PRONTA do servidor (rotulos.autentico): colar um adjetivo no nome do
    // documento erra a concordância — "Ficha de EPI autêntico". Cada módulo manda a sua.
    const cabeca = d.alteradoAposAssinatura
      ? selo('alerta', '!', 'Assinatura encontrada, mas o documento mudou',
          'Este documento foi alterado depois de assinado. A assinatura vale para o conteúdo original, não para o que está sendo exibido agora; confirme com o setor responsável antes de aceitá-lo.')
      : selo('ok', '✓', (d.rotulos && d.rotulos.autentico) || 'Documento autêntico',
          'A assinatura confere e o conteúdo continua exatamente como estava quando foi assinado.');

    caixa.hidden = false;
    caixa.innerHTML = cabeca
      + `<div class="campos">${campos.map(([r, v]) =>
          `<div><div class="campo-rot">${esc(r)}</div><div class="campo-val">${esc(v)}</div></div>`).join('')}</div>`
      + `<div class="secao-tit">${esc((d.rotulos && d.rotulos.itens) || 'Itens recebidos')}</div><div class="itens">${itens}</div>`
      + `<div class="secao-tit">Assinatura eletrônica</div>`
      + `<div class="campos">${evidencias.map(([r, v]) =>
          `<div><div class="campo-rot">${esc(r)}</div><div class="campo-val">${esc(v)}</div></div>`).join('')}</div>`
      + `<div><div class="campo-rot">Código</div><div class="campo-val">${esc(d.codigo)}</div></div>`
      + (d.impressao ? `<div style="margin-top:12px"><div class="campo-rot">Impressão digital do documento</div><div class="impressao">${esc(d.impressao)}</div></div>` : '');
  }

  async function consultar(codigo) {
    const limpo = String(codigo || '').toUpperCase().replace(/[^A-Z0-9-]/g, '');
    if (!limpo) { campo.focus(); return; }
    botao.disabled = true;
    const txt = botao.textContent;
    botao.textContent = 'Conferindo...';
    caixa.hidden = true;
    try {
      const r = await fetch('/api/verificar/' + encodeURIComponent(limpo), { cache: 'no-store' });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        mostrarErro(j.erro || 'Não encontramos nenhum documento com este código. Confira se digitou exatamente como está impresso.');
        return;
      }
      mostrar(j);
    } catch (e) {
      mostrarErro('Não foi possível consultar agora. Verifique sua conexão e tente de novo.');
    } finally {
      botao.disabled = false;
      botao.textContent = txt;
    }
  }

  form.addEventListener('submit', (e) => { e.preventDefault(); consultar(campo.value); });

  // Veio pelo QR do recibo (/verificar/<codigo>): já consulta, sem a pessoa digitar nada.
  const daUrl = decodeURIComponent((location.pathname.split('/verificar/')[1] || '').trim());
  if (daUrl) {
    campo.value = formatar(daUrl);
    consultar(daUrl);
  } else {
    campo.focus();
  }
})();
