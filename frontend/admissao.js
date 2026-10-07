// Formulário público de Admissão — Gestão RM.
// Servido sem login; a proteção é o token na URL (/admissao/<token>). Sem handlers inline
// (o CSP do site não permite 'unsafe-inline' em script-src) → tudo via addEventListener.
(function () {
  'use strict';

  const TOKEN = decodeURIComponent((location.pathname.split('/').filter(Boolean).pop() || ''));
  const API = '/api/admissao/publico/' + encodeURIComponent(TOKEN);

  const totalSecoes = 4; // a ficha rola inteira (sem etapas escondidas); seções 1..4 sempre visíveis
  const filesMap = {};   // chave -> [{ id, nome, tipo }]  (já enviados ao servidor)
  let filhoCount = 0;
  let enviando = false;

  // Documentos obrigatórios (espelha os asteriscos da etapa 2)
  const DOCS_OBRIGATORIOS = ['ctps', 'foto', 'rg-doc', 'cpf-doc', 'vacina', 'residencia', 'certidao', 'escolar', 'sus', 'pis-doc'];
  // Campos de texto obrigatórios da etapa 1
  const CAMPOS_OBRIGATORIOS = ['nome', 'cpf', 'rg', 'pis', 'email', 'endereco', 'cidade', 'estado', 'banco', 'escolaridade'];

  const $ = (id) => document.getElementById(id);
  const val = (id) => ($(id) ? $(id).value.trim() : '');

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

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
  }

  function configurarEmpresa(valor) {
    const sigla = String(valor || '').trim().toUpperCase().startsWith('SUL') ? 'SUL' : 'NTE';
    const marca = sigla === 'SUL'
      ? { nome: 'Sul Empreendimentos', arquivo: '/img/logo-sul.png' }
      : { nome: 'Norte Engenharia', arquivo: '/img/logo-nte.png' };
    const img = $('empresa-logo');
    const fallback = $('empresa-logo-fallback');
    img.hidden = false;
    fallback.hidden = true;
    fallback.textContent = sigla;
    img.alt = 'Logo da ' + marca.nome;
    img.onerror = () => { img.hidden = true; fallback.hidden = false; };
    img.src = marca.arquivo;
  }

  function abrirFormulario(nomeCandidato, empresa) {
    $('status-screen').style.display = 'none';
    $('form-main').style.display = 'block';
    configurarEmpresa(empresa);
    if (nomeCandidato) $('cand-nome').textContent = nomeCandidato;
    const d = new Date();
    $('decl-data').textContent = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }

  // Verifica o estado do link no servidor antes de mostrar o formulário.
  async function init() {
    if (!TOKEN) { mostrarStatus('🔗', 'Link inválido', 'Este endereço não contém um código de acesso válido.'); return; }
    mostrarStatus('⏳', 'Carregando…', 'Validando o seu link de acesso.');
    try {
      const r = await fetch(API, { headers: { 'Accept': 'application/json' } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) { mostrarStatus('🔗', 'Link inválido', d.erro || 'Este link de admissão não foi encontrado.'); return; }
      if (d.status === 'aguardando') { abrirFormulario(d.nome, d.empresa); return; }
      if (d.status === 'preenchido' || d.status === 'aplicado') {
        mostrarStatus('✅', 'Ficha já enviada', 'Esta ficha já foi preenchida e enviada. Se precisar corrigir alguma informação, fale com o RH.');
        return;
      }
      if (d.status === 'expirado') {
        mostrarStatus('⌛', 'Link expirado', 'O prazo para preencher esta ficha acabou. Peça um novo link ao RH.');
        return;
      }
      mostrarStatus('🚫', 'Link indisponível', 'Esta ficha não está mais disponível.');
    } catch (e) {
      mostrarStatus('⚠️', 'Erro de conexão', 'Não foi possível validar o link. Verifique sua internet e tente recarregar a página.');
    }
  }

  // Envia cada arquivo selecionado para o cofre, na hora.
  async function handleFiles(input, key) {
    const arquivos = Array.from(input.files || []);
    input.value = '';
    if (!filesMap[key]) filesMap[key] = [];
    for (const f of arquivos) {
      const tagId = 'tmp-' + key + '-' + Date.now() + '-' + Math.round(Math.random() * 1e6);
      addTempTag(key, f.name, tagId);
      try {
        const fd = new FormData();
        fd.append('arquivo', f);
        fd.append('chave', key);
        const r = await fetch(API + '/midia', { method: 'POST', body: fd });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.id) throw new Error(d.erro || 'Falha no envio');
        filesMap[key].push({ id: d.id, nome: d.nome || f.name, tipo: d.tipo });
      } catch (err) {
        toast('Não foi possível enviar "' + f.name + '": ' + err.message, 'erro');
      } finally {
        const t = $(tagId); if (t) t.remove();
        renderFileList(key);
      }
    }
  }

  function addTempTag(key, nome, tagId) {
    const list = $(`list-${key}`);
    if (!list) return;
    const tag = document.createElement('div');
    tag.className = 'file-tag enviando';
    tag.id = tagId;
    tag.innerHTML = `<span class="nome">⏳ ${escapeHtml(nome)}</span><span style="font-size:11px;">enviando…</span>`;
    list.appendChild(tag);
  }

  function renderFileList(key) {
    const list = $(`list-${key}`);
    if (!list) return;
    list.querySelectorAll('.file-tag:not(.enviando)').forEach(e => e.remove());
    (filesMap[key] || []).forEach((f, i) => {
      const tag = document.createElement('div');
      tag.className = 'file-tag';
      tag.innerHTML = `<span class="nome">📄 ${escapeHtml(f.nome)}</span><button type="button" title="Remover arquivo" aria-label="Remover ${escapeHtml(f.nome)}" data-rm-key="${escapeHtml(key)}" data-rm-idx="${i}">✕</button>`;
      list.appendChild(tag);
    });
    atualizarEstadoDoc(key);
  }

  // O item do checklist ganha o ✓ verde quando tem pelo menos um arquivo enviado.
  function atualizarEstadoDoc(key) {
    const item = document.querySelector(`[data-box="${key}"]`);
    if (!item) return;
    const tem = !!(filesMap[key] && filesMap[key].length);
    item.classList.toggle('tem-arquivo', tem);
    if (tem) limparErroDoc(key);
  }

  function removeFile(key, idx) {
    if (!filesMap[key]) return;
    filesMap[key].splice(idx, 1);
    renderFileList(key);
  }

  function toggleDep(show) {
    $('dep-fields').style.display = show ? 'block' : 'none';
  }

  function addFilho() {
    filhoCount++;
    const c = $('filhos-container');
    const div = document.createElement('div');
    div.className = 'filho-card';
    div.id = `filho-${filhoCount}`;
    div.dataset.filho = filhoCount;
    div.innerHTML = `
      <div class="filho-cabeca">
        <strong>Filho(a) ${filhoCount}</strong>
        <button type="button" data-del-filho="${filhoCount}" title="Remover" aria-label="Remover filho ${filhoCount}">✕</button>
      </div>
      <div class="grid-2">
        <div class="field"><label>Nome</label><input type="text" class="filho-nome" placeholder="Nome completo"></div>
        <div class="field"><label>Data de nascimento</label><input type="date" class="filho-nasc"></div>
        <div class="field"><label>CPF</label><input type="text" class="filho-cpf" placeholder="000.000.000-00" inputmode="numeric"></div>
      </div>
      <div class="doc-lista" style="margin-top:14px;">
        <div class="doc-item" data-box="filho-${filhoCount}-doc">
          <div class="doc-linha">
            <span class="doc-check" aria-hidden="true"></span>
            <div class="doc-texto"><div class="doc-nome">Certidão de nascimento + CPF + RG</div></div>
            <label class="doc-anexar">📎 Anexar<input type="file" accept=".pdf,.jpg,.jpeg,.png" multiple data-key="filho-${filhoCount}-doc" aria-label="Anexar documentos do filho ${filhoCount}"></label>
          </div>
          <div class="file-list" id="list-filho-${filhoCount}-doc"></div>
        </div>
      </div>`;
    c.appendChild(div);
  }

  // ---- Erros inline: mensagem embaixo do campo + borda vermelha ----
  function marcarErro(id, msg) {
    const el = $(id);
    if (!el) return;
    el.classList.add('error');
    el.setAttribute('aria-invalid', 'true');
    const span = $(`erro-${id}`);
    if (span) span.textContent = msg || 'Preencha este campo.';
    const limpar = () => {
      el.classList.remove('error');
      el.removeAttribute('aria-invalid');
      if (span) span.textContent = '';
    };
    el.addEventListener('input', limpar, { once: true });
    el.addEventListener('change', limpar, { once: true });
  }
  function marcarErroDoc(key, msg) {
    const item = document.querySelector(`[data-box="${key}"]`);
    if (!item) return;
    item.classList.add('error');
    const span = item.querySelector('.field-erro');
    if (span) span.textContent = msg || 'Anexe pelo menos um arquivo.';
  }
  function limparErroDoc(key) {
    const item = document.querySelector(`[data-box="${key}"]`);
    if (!item) return;
    item.classList.remove('error');
    const span = item.querySelector('.field-erro');
    if (span) span.textContent = '';
  }
  function focarPrimeiroErro() {
    const alvo = document.querySelector('.section-card .error, .section-card .doc-item.error');
    if (alvo) {
      alvo.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const campo = alvo.matches('input, select, textarea') ? alvo : alvo.querySelector('input, select, textarea');
      if (campo && campo.type !== 'file') campo.focus({ preventScroll: true });
    }
  }

  // ---- Validação por etapa (roda no "Continuar" e de novo no envio final) ----
  function validarEtapa(n) {
    let ok = true;
    if (n === 1) {
      for (const id of CAMPOS_OBRIGATORIOS) {
        if (!val(id)) {
          marcarErro(id, $(id) && $(id).tagName === 'SELECT' ? 'Selecione uma opção.' : 'Preencha este campo.');
          ok = false;
        }
      }
      const email = val('email');
      if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { marcarErro('email', 'Informe um e-mail válido.'); ok = false; }
    }
    if (n === 2) {
      for (const key of DOCS_OBRIGATORIOS) {
        if (!(filesMap[key] && filesMap[key].length)) { marcarErroDoc(key); ok = false; }
      }
    }
    if (n === 4) {
      if (!val('bota')) { marcarErro('bota', 'Selecione o número da bota.'); ok = false; }
      if (!val('macacao')) { marcarErro('macacao', 'Selecione o tamanho do macacão.'); ok = false; }
      if (!$('confirm-check').checked) {
        const span = $('erro-confirm');
        if (span) span.textContent = 'Marque a declaração para poder enviar.';
        ok = false;
      }
    }
    return ok;
  }

  // Reúne todos os campos do formulário em um objeto "resposta".
  function coletarResposta() {
    const resp = {
      nome: val('nome'), cpf: val('cpf'), rg: val('rg'), pis: val('pis'), titulo: val('titulo'),
      reservista: val('reservista'), email: val('email'), endereco: val('endereco'),
      cidade: val('cidade'), estado: val('estado'), banco: val('banco'), agencia: val('agencia'),
      conta: val('conta'), pix: val('pix'), escolaridade: val('escolaridade'), registro: val('registro'),
      bota: val('bota'), macacao: val('macacao'), obs: val('obs'),
      temDependentes: (document.querySelector('input[name="tem-dep"]:checked') || {}).value || 'nao',
    };
    if (resp.temDependentes === 'sim') {
      resp.conjuge = { nome: val('conjuge-nome'), cpf: val('conjuge-cpf'), rg: val('conjuge-rg') };
      resp.filhos = [];
      document.querySelectorAll('#filhos-container [data-filho]').forEach(div => {
        const nome = (div.querySelector('.filho-nome') || {}).value || '';
        const nasc = (div.querySelector('.filho-nasc') || {}).value || '';
        const cpf = (div.querySelector('.filho-cpf') || {}).value || '';
        if (nome.trim() || nasc || cpf.trim()) resp.filhos.push({ nome: nome.trim(), nascimento: nasc, cpf: cpf.trim() });
      });
    }
    return resp;
  }

  function todosOsDocIds() {
    const ids = [];
    Object.values(filesMap).forEach(arr => (arr || []).forEach(f => ids.push(f.id)));
    return ids;
  }

  // Validação completa antes do envio; devolve a primeira etapa com pendência.
  function validar() {
    if (!validarEtapa(1)) return { ok: false, etapa: 1, msg: 'Ainda faltam campos nos Dados pessoais.' };
    if (!validarEtapa(2)) return { ok: false, etapa: 2, msg: 'Anexe todos os documentos obrigatórios (marcados com *).' };
    if (!validarEtapa(4)) return { ok: false, etapa: 4, msg: 'Complete o fardamento e marque a declaração.' };
    return { ok: true };
  }

  async function submitForm() {
    if (enviando) return;
    const v = validar();
    if (!v.ok) {
      toast(v.msg, 'erro');
      setTimeout(focarPrimeiroErro, 80); // a ficha é única: rola direto até o primeiro campo com erro
      return;
    }
    enviando = true;
    const btn = $('btn-enviar');
    btn.disabled = true; btn.textContent = 'Enviando…';
    try {
      const r = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ resposta: coletarResposta(), docIds: todosOsDocIds() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.ok) throw new Error(d.erro || 'Falha ao enviar a ficha.');
      for (let i = 1; i <= totalSecoes; i++) { const el = $(`step-${i}`); if (el) el.style.display = 'none'; }
      $('success-screen').style.display = 'block';
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (err) {
      toast(err.message, 'erro');
      btn.disabled = false; btn.textContent = 'Enviar ficha de admissão';
      enviando = false;
    }
  }

  // ---- Listeners (delegação) ----
  document.addEventListener('click', (e) => {
    const act = e.target.closest('[data-action]');
    if (act) {
      if (act.dataset.action === 'add-filho') addFilho();
      else if (act.dataset.action === 'submit') submitForm();
      return;
    }
    const rm = e.target.closest('[data-rm-key]');
    if (rm) { removeFile(rm.dataset.rmKey, Number(rm.dataset.rmIdx)); return; }
    const delf = e.target.closest('[data-del-filho]');
    if (delf) { const d = $(`filho-${delf.dataset.delFilho}`); if (d) d.remove(); return; }
  });

  document.addEventListener('change', (e) => {
    if (e.target.matches('input[type="file"][data-key]')) { handleFiles(e.target, e.target.dataset.key); return; }
    if (e.target.name === 'tem-dep') { toggleDep(e.target.value === 'sim'); return; }
    if (e.target.id === 'confirm-check' && e.target.checked) { const s = $('erro-confirm'); if (s) s.textContent = ''; return; }
  });

  // Máscara de CPF (titular e dependentes usam a mesma)
  function mascaraCpf(e) {
    let v = e.target.value.replace(/\D/g, '').slice(0, 11);
    v = v.replace(/(\d{3})(\d)/, '$1.$2');
    v = v.replace(/(\d{3})(\d)/, '$1.$2');
    v = v.replace(/(\d{3})(\d{1,2})$/, '$1-$2');
    e.target.value = v;
  }
  document.addEventListener('input', (e) => {
    if (e.target.id === 'cpf' || e.target.id === 'conjuge-cpf' || e.target.classList.contains('filho-cpf')) mascaraCpf(e);
  });

  init();
})();
