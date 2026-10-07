// Service worker do Gestão RM — habilita a instalação (atalho na tela inicial) e
// dá um cache leve do "shell" (CSS/JS/ícones). NÃO intercepta a API nem o login:
// dados sempre frescos e autenticação preservada.
const CACHE = 'nucleorm-v58'; // v58: multa-ocr.js lendo o print do portal SENATRAN (ícone no título, tabela do órgão, glifo partido no Nº do auto, cidade como nome) (1.55.52); v57: descrição OCR em títulos e várias linhas sem interromper por palavras da infração (1.55.52); v56: preenchimento automático e rótulo exato da data/hora da infração (1.55.51); v55: interpretador multa-ocr.js, conferência do print e Responsável IDENTIFICAR (1.55.50); v54: design-multas.css e app.js com o "Gerar termo" das multas (1.55.49); v53: design-v2.css com o sinal de CRLV ao lado da placa (1.55.48); v52: 08-modal.css com o select próprio (.cs-btn) na régua dos campos do modal — Tipo × Validade no Novo treinamento (1.55.46); v51: Acompanhamento da Integração redesenhado (design-integracao.css, 08-modal.css com o painel lateral .modal-lateral, app.js) e chip de filtro quadrado (05-components.css), 1.55.45; v50: design-integracao.css com a coluna Ações centralizada e o card do catálogo mais largo (1.55.42); v49: design-integracao.css com a exclusão e o vídeo travado (1.55.40/1.55.41); v48: design-integracao.css (Integração: reenviar/gerar novo link no Acompanhamento); v47: odometro-calc.js
// SEM ?v= de propósito: o index.html versiona os estáticos na query e essa string vivia
// desencontrada da daqui (o SW guardava ?v=1.46.1 e a página pedia outra), então o shell
// pré-cacheado NUNCA casava e o app offline abria sem CSS nem JS. Guardamos o caminho limpo
// e a busca é feita com ignoreSearch, que casa com qualquer versão da query.
// ⚠️ TODOS os arquivos do design-system/ precisam estar AQUI: sem eles o app instalado abre
// offline sem o Design System (o index.html os pede, o cache não os tem). A ordem repete a do
// index.html só por leitura — quem define a cascata é o HTML, não esta lista.
// ⚠️ Arquivo novo no design-system/ = mais uma linha aqui E `CACHE` bumpado acima, senão quem
// já tem o app instalado continua servindo o shell velho (foi o que aconteceu com 07-alert,
// que ficou de fora da lista quando entrou).
const SHELL = ['/styles.css',
  '/design-system/01-tokens.css', '/design-system/02-themes.css', '/design-system/03-base.css',
  '/design-system/04-shell.css', '/design-system/05-components.css', '/design-system/06-states.css',
  '/design-system/07-alert.css', '/design-system/08-modal.css', '/design-system/09-superficies.css',
  '/design-system/10-tabela-resize.css',
  '/design-v2.css', '/design-manutencao.css', '/design-rastreadores.css', '/design-multas.css', '/design-almoxarifado.css',
  '/design-epi.css', '/design-usuarios.css', '/design-veiculo-modal.css', '/design-ti.css',
  '/design-acoes-sst.css', '/design-locacoes.css', '/design-integracao.css', '/design-mobile.css',
  '/app.js', '/qrcode.js', '/odometro-calc.js', '/multa-ocr.js', '/pdf.min.mjs', '/pdf.worker.min.mjs', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;                 // escrita (POST/PUT/DELETE): nunca intercepta
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // CDNs (fontes/Chart.js): deixa o browser
  if (url.pathname.startsWith('/api/')) return;     // API: sempre rede (dados + auth)

  // Navegação (abrir o app): rede primeiro; offline cai no shell salvo.
  // O app vive em /painel — SÓ navegações /painel* viram/usam o shell. O hub ('/' e /hub/*)
  // e as páginas públicas (verificação, admissão, treinamento, login) seguem pela rede e
  // NUNCA entram como shell: quem abrisse uma delas passaria a vê-la ao abrir o app offline.
  if (req.mode === 'navigate') {
    const painel = /^\/painel(?:\/|$)/.test(url.pathname);
    e.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && !res.redirected && painel) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/painel', copy)); }
          return res;
        })
        .catch(() => (painel ? caches.match('/painel') : caches.match(req, { ignoreSearch: true })))
    );
    return;
  }

  // Estáticos (css/js/ícones): REDE PRIMEIRO — sempre pega a versão mais nova quando online;
  // o cache fica só como reserva pra quando estiver offline. Evita o app.js/styles.css "velho"
  // do cache esconder mudanças recém-publicadas (era a causa de "não vejo minhas alterações").
  // ignoreSearch: o app.js pedido é "/app.js?v=1.48.0" e o guardado é "/app.js" — sem isso
  // o fallback offline não encontra nada e a tela abre em branco.
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true }))
  );
});

// Notificações push (recebidas do servidor ou de clientes)
self.addEventListener('push', (e) => {
  if (!e.data) return;
  try {
    const dados = typeof e.data === 'string' ? JSON.parse(e.data) : e.data.json();
    self.registration.showNotification(dados.titulo || 'Gestão RM', {
      body: dados.mensagem || '',
      icon: '/icon-192.png',
      badge: '/favicon-64.png',
      vibrate: [200, 100, 200],
      data: { url: dados.url || '/painel' },
    });
  } catch (err) { /* ignora push mal formatado */ }
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data && e.notification.data.url ? e.notification.data.url : '/painel';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { if (c.url === url && 'focus' in c) return c.focus(); }
    if (clients.openWindow) return clients.openWindow(url);
  }));
});
