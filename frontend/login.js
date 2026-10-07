// Mesma chave e valores do app (aplicarTema no app.js): claro | escuro | auto.
try {
  var t = localStorage.getItem('tema');
  var escuroSO = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (t === 'escuro' || (t === 'auto' && escuroSO)) document.body.classList.add('dark');
} catch (e) {}

// Destino após o login: o parâmetro ?next= (ex.: /funcionarios/<id> de um QR escaneado),
// aceito só se for caminho local — começa com "/" e não com "//" nem "/\" (anti open-redirect).
function destinoPosLogin() {
  try {
    var p = new URLSearchParams(location.search).get('next') || '';
    if (/^\/(?![\/\\])/.test(p)) return p;
  } catch (e) {}
  return '/painel';
}

var formLogin = document.getElementById('formLogin');
var formCadastro = document.getElementById('formCadastro');
var telaEspera = document.getElementById('telaEspera');
var subTitulo = document.getElementById('subTitulo');
var pollTimer = null;

function mostrar(qual) {
  formLogin.classList.toggle('oculto', qual !== 'login');
  formCadastro.classList.toggle('oculto', qual !== 'cadastro');
  telaEspera.classList.toggle('oculto', qual !== 'espera');
  if (qual === 'login') subTitulo.textContent = 'Central Integrada de Gestão';
  if (qual === 'cadastro') subTitulo.textContent = 'Solicitar acesso';
  if (qual === 'espera') subTitulo.textContent = 'Aguarde a aprovação';
}

// ----- LOGIN -----
var btnEntrar = document.getElementById('btnEntrar');
var erroLogin = document.getElementById('erroLogin');
try {
  var erroSso = new URLSearchParams(location.search).get('ssoError');
  if (erroSso) erroLogin.textContent = erroSso;
} catch (e) {}
formLogin.addEventListener('submit', async function (e) {
  e.preventDefault();
  erroLogin.textContent = '';
  btnEntrar.disabled = true; btnEntrar.textContent = 'Entrando...';
  try {
    var r = await fetch('/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        usuario: document.getElementById('usuario').value,
        senha: document.getElementById('senha').value,
        lembrar: !!(document.getElementById('lembrar30') || {}).checked, // "salvar neste navegador por 30 dias"
      }),
    });
    var j = await r.json().catch(function () { return {}; });
    if (r.ok) {
      window.location = j.destino || destinoPosLogin();
      return;
    }
    erroLogin.textContent = j.erro || 'Usuário ou senha incorretos.';
  } catch (err) {
    erroLogin.textContent = 'Erro de conexão. Tente de novo.';
  }
  btnEntrar.disabled = false; btnEntrar.textContent = 'Entrar no sistema';
});

// Mostra um dos estados da tela de resultado: 'spinner' | 'check' (aprovado) | 'x' (recusado/fechado)
function telaResultado(icone, titulo, sub) {
  mostrar('espera');
  document.getElementById('esperaSpinner').classList.toggle('oculto', icone !== 'spinner');
  document.getElementById('esperaCheck').classList.toggle('oculto', icone !== 'check');
  document.getElementById('esperaX').classList.toggle('oculto', icone !== 'x');
  document.getElementById('esperaTitulo').textContent = titulo;
  document.getElementById('esperaSub').textContent = sub;
  document.getElementById('btnIrLogin').classList.add('oculto');
  document.getElementById('btnVoltar2').classList.add('oculto');
}
function voltarParaLogin() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  mostrar('login');
  document.getElementById('usuario').focus();
}
document.getElementById('btnVoltar2').onclick = voltarParaLogin;
document.getElementById('voltarLogin').onclick = voltarParaLogin;

// ----- ALTERNAR LOGIN/CADASTRO -----
document.getElementById('irCadastro').onclick = async function () {
  // Se o site não estiver aceitando cadastros, já mostra o X em vez do formulário.
  try {
    var r = await fetch('/api/cadastro/aberto', { cache: 'no-store' });
    var j = await r.json();
    if (!j.aberto) {
      telaResultado('x', 'Cadastros desligados', 'Este site não está aceitando cadastros no momento.');
      document.getElementById('btnVoltar2').classList.remove('oculto');
      return;
    }
  } catch (e) {
    // Se não deu pra verificar, NÃO assume que está aberto — mostra indisponível.
    telaResultado('x', 'Indisponível no momento', 'Não consegui verificar se os cadastros estão abertos. Tente novamente em instantes.');
    document.getElementById('btnVoltar2').classList.remove('oculto');
    return;
  }
  mostrar('cadastro');
  document.getElementById('erroCadastro').textContent = '';
  document.getElementById('btnSolicitar').disabled = false;
  document.getElementById('cUsuario').focus();
};

// ----- CADASTRO -----
var btnSolicitar = document.getElementById('btnSolicitar');
var erroCadastro = document.getElementById('erroCadastro');
formCadastro.addEventListener('submit', async function (e) {
  e.preventDefault();
  erroCadastro.textContent = '';
  var usuario = document.getElementById('cUsuario').value.trim();
  var nome = document.getElementById('cNome').value.trim();
  var senha = document.getElementById('cSenha').value;
  // Validações antes de enviar
  if (usuario.length < 3) { erroCadastro.textContent = 'O usuário precisa ter pelo menos 3 caracteres.'; return; }
  if (!/[a-zA-Z]/.test(usuario)) { erroCadastro.textContent = 'O usuário precisa ter pelo menos uma letra (não pode ser só números).'; return; }
  if (!nome) { erroCadastro.textContent = 'Informe o nome de exibição.'; return; }
  if (/[0-9]/.test(nome)) { erroCadastro.textContent = 'O nome de exibição não pode conter números.'; return; }
  if (senha.length < 4) { erroCadastro.textContent = 'A senha precisa ter pelo menos 4 caracteres.'; return; }
  btnSolicitar.disabled = true; btnSolicitar.textContent = 'Enviando...';
  try {
    var r = await fetch('/api/cadastro/solicitar', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ usuario: usuario, nome: nome, senha: senha }),
    });
    var j = await r.json().catch(function () { return {}; });
    btnSolicitar.disabled = false; btnSolicitar.textContent = 'Solicitar acesso';
    if (r.ok) { iniciarEspera(j.usuario || usuario); return; }
    // Cadastros desligados (ou indisponível) → tela de X
    if (r.status === 403 || r.status === 400) {
      telaResultado('x', 'Cadastros desligados', j.erro || 'Este site não está aceitando cadastros no momento.');
      document.getElementById('btnVoltar2').classList.remove('oculto');
      return;
    }
    erroCadastro.textContent = j.erro || 'Não foi possível enviar o pedido.';
  } catch (err) {
    btnSolicitar.disabled = false; btnSolicitar.textContent = 'Solicitar acesso';
    erroCadastro.textContent = 'Erro de conexão. Tente de novo.';
  }
});

// ----- ESPERA (consulta o status até o admin aprovar/recusar) -----
function iniciarEspera(usuario) {
  telaResultado('spinner', 'Aguardando aprovação…', 'Seu pedido foi enviado. Assim que um administrador aprovar, esta tela vai avisar automaticamente; pode deixar aberta.');
  var tentativas = 0;
  var MAX_TENTATIVAS = 150; // ~10 min (a cada 4s). Evita girar pra sempre se o pedido for removido.

  async function checar() {
    // Para de consultar após um tempo (o status público não distingue "removido" de "pendente",
    // por segurança/anti-enumeração) — assim a tela não fica girando indefinidamente.
    if (++tentativas > MAX_TENTATIVAS) {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      telaResultado('x', 'Ainda em análise', 'Seu pedido continua aguardando aprovação. Você pode fechar esta tela e tentar entrar mais tarde.');
      document.getElementById('btnVoltar2').classList.remove('oculto');
      return;
    }
    try {
      var r = await fetch('/api/cadastro/status?usuario=' + encodeURIComponent(usuario), { cache: 'no-store' });
      var j = await r.json();
      if (j.status === 'aprovado') {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        telaResultado('check', 'Cadastro aprovado! 🎉', 'Seu acesso foi liberado. Agora é só entrar com seu usuário e senha.');
        var b = document.getElementById('btnIrLogin');
        b.classList.remove('oculto');
        b.onclick = function () {
          if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
          mostrar('login');
          document.getElementById('usuario').value = usuario;
          document.getElementById('senha').focus();
        };
      } else if (j.status === 'recusado') {
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        telaResultado('x', 'Cadastro não aprovado', 'Seu pedido foi recusado. Procure o administrador para mais informações.');
        document.getElementById('btnVoltar2').classList.remove('oculto');
      } else if (j.status === 'inexistente') {
        // O admin removeu o pedido pendente — não fica girando pra sempre.
        if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
        telaResultado('x', 'Pedido não encontrado', 'Seu pedido de acesso foi removido ou expirou. Solicite novamente, se precisar.');
        document.getElementById('btnVoltar2').classList.remove('oculto');
      }
    } catch (e) {}
  }
  checar();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(checar, 4000);
}

// ----- Versão do sistema no rodapé do login -----
(function () {
  fetch('/api/versao', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (v) {
      var el = document.getElementById('rodapeVersao');
      if (el && v && v.versao) el.textContent = 'v' + v.versao;
    })
    .catch(function () {});
})();

// ----- Mostrar / ocultar senha (olho) -----
// Fica aqui (e NÃO inline no HTML) porque a CSP do servidor não libera
// 'unsafe-inline' em script-src — script inline na página é bloqueado.
Array.prototype.forEach.call(document.querySelectorAll('.campo-olho'), function (btn) {
  btn.addEventListener('click', function () {
    var inp = document.getElementById(btn.getAttribute('data-alvo'));
    if (!inp) return;
    var visivel = inp.type === 'text';
    inp.type = visivel ? 'password' : 'text';
    btn.classList.toggle('ativo', !visivel);
    btn.setAttribute('aria-label', visivel ? 'Mostrar senha' : 'Ocultar senha');
  });
});

// ----- Frase que digita sozinha no hero — vanilla JS, leve, sem dependências -----
(function () {
  var el = document.getElementById('brandTyped');
  if (!el) return;
  var frases = [
    'Frota e operação',
    'Pessoas e documentos',
    'Saúde e segurança',
    'Contratos e finanças',
    'Indicadores para decisões'
  ];
  var reduz = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  // Acessibilidade reduzida: mostra uma frase fixa, sem animar.
  if (reduz) { el.textContent = frases[0]; return; }
  var txt = document.createElement('span');
  var cur = document.createElement('span');
  cur.className = 'tt-cursor'; cur.textContent = '|';
  el.appendChild(txt); el.appendChild(cur);
  var i = 0, j = 0, apagando = false;
  function passo() {
    var f = frases[i];
    j += apagando ? -1 : 1;
    txt.textContent = f.slice(0, j);
    var espera = apagando ? 45 : 75;
    if (!apagando && j === f.length) { apagando = true; espera = 1600; }      // pausa cheia
    else if (apagando && j === 0) { apagando = false; i = (i + 1) % frases.length; espera = 350; }
    setTimeout(passo, espera);
  }
  setTimeout(passo, 600);
})();

// ----- Alternador de tema (canto superior direito) -----
// Grava na MESMA chave 'tema' que o app lê no boot (aplicarTema, app.js):
// o tema escolhido aqui vale dentro do sistema após o login.
(function () {
  var btn = document.getElementById('btnTemaLogin');
  if (!btn) return;
  function rotular() {
    var escuro = document.body.classList.contains('dark');
    btn.setAttribute('aria-label', escuro ? 'Usar tema claro' : 'Usar tema escuro');
  }
  rotular();
  btn.addEventListener('click', function () {
    var escuro = document.body.classList.toggle('dark');
    try { localStorage.setItem('tema', escuro ? 'escuro' : 'claro'); } catch (e) {}
    rotular();
  });
})();
