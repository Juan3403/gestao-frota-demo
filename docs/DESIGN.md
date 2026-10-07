# DESIGN.md — Frota NTE / Gestão RM

Fonte de verdade do padrão visual. Tudo aqui foi extraído dos arquivos reais — `frontend/design-system/01-tokens.css` e `02-themes.css` (tokens e temas), `03..09-*.css` (componentes) e `frontend/styles.css` (legado ainda em uso) — não é aspiração, é o que o sistema já faz. Mudança de estilo nova tem que seguir este documento; se contrariar, atualize o documento junto (andam como versão + CHANGELOG).

A numeração das seções 6 (Movimento), 9 (NUNCA usar), 10 (camada `design-v2`) e 11 (registro de exceções) é ESTÁVEL — comentários no CSS/HTML referenciam "§11.4", "§11.7", "seção 9 item 13" etc. Ao reorganizar o documento, preserve esses números.

O redesign anterior ("Centro de comando", raio 14/18/10px, Bricolage Grotesque, 12 temas) está preservado no **Apêndice histórico** no fim do arquivo — não é normativo. (O `docs/DESIGN.pdf`, que refletia a versão antiga deste documento, foi removido em ago/2026.)

## 1. Identidade — "Registro Operacional Industrial"

Nasceu como piloto de UMA tela (Frota, ago/2026) e foi promovido: é a identidade padrão do sistema. Um registro operacional calmo e chapado:

- **Superfície chapada**: fundo `--ds-surface` + borda 1px `--ds-line`, **sem sombra** (`--ds-shadow-none`). Sombra existe SÓ em quem realmente flutua: menus portados, modais, toasts, o aviso de versão (`--ds-shadow-float`).
- **Sem relevo**: nada de `translateY` no hover — quem responde ao mouse é cor e borda, não altura. Cartão é uma LINHA, não um cartão de marketing.
- **Sem gradiente decorativo**: degradê só quando ele É o conteúdo (amostra de tema, cartão de crédito — ver o registro de exceções, §11).
- **Hanken Grotesk em tudo** (`--display` aponta para `--body` dentro do escopo — o Bricolage saiu); **JetBrains Mono** só em placa, código técnico e valores/KPIs.
- **Sidebar grafite nos dois temas** — âncora visual do desenho (`--ds-shell-*`).
- Cabeçalho de tabela em **sentence case** 12px/600 — o mono uppercase de 9,5px não entra.
- O page-head global (título + subtítulo, `SUBTITULOS_ABA` no app.js) é a única identificação da tela — sem kicker/eyebrow decorativo.

## 2. Tokens (`frontend/design-system/01-tokens.css`)

### Paleta primitiva
| Família | Principais | Papel |
|---|---|---|
| Mineral (claro) | `--ds-mineral-50 #f3f5f2` · `-100 #e9ede9` · `-150 #eef1ed` · `-200 #d4dad5` · `-500 #808d85` · `-600 #5c685f` · `-900 #17211b` · `--ds-white #ffffff` | canvas, superfícies, divisórias, borda de controle, texto |
| Grafite (shell/escuro) | `-950 #0e1013` · `-900 #121417` · `-850 #17191d` · `-650 #1f2227` (ladrilho do logo) · `-500 #282c32` · `-380 #6e7780` · `-100 #e8eaed` · `-50 #f0f1f3` | sidebar, tema escuro |
| Primária (grafite; nomes `--ds-blue-*` por retrocompat — o azul saiu em ago/2026) | `-900 #31363e` · `-800 #4a5058` · `-600 #565d66` (foco) · `-400 #a6acb3` · `-300 #bfc4ca` · `-200 #d5d9dd` · `-100 #eef0f2` · `-950 #1d2024` | primária, foco, info |
| Estado | verde `#1f6f4a`/`#e7f4ec` · âmbar `#8a5700`/`#fff3d6` · vermelho `#b42318`/`#fdecea` (+ variantes escuras) | sucesso/aviso/erro |

⚠️ **Borda de controle é `--ds-line-strong` (`#808d85`), não a divisória** — `#d4dad5` dá 1,3:1 sobre branco e reprova o mínimo de 3:1 da WCAG 1.4.11 para limite de campo. Dois tons de propósito.

### Semânticos (`02-themes.css`)
`--ds-canvas` · `--ds-surface` · `--ds-surface-subtle` · `--ds-surface-hover` · `--ds-ink` · `--ds-muted` · `--ds-line` / `--ds-line-strong` · `--ds-primary` / `--ds-primary-hover` / `--ds-on-primary` · `--ds-focus` · `--ds-success/-warning/-danger/-info` (+ `-soft`) · `--ds-selected-veil(-hover)` · `--ds-backdrop` · shell: `--ds-shell-bg/-tile/-tile-line/-line/-ink/-ink-2/-muted/-muted-2/-accent`.

### Forma, espaço, movimento
- **Raios**: `--ds-radius-xs` 3px · `--ds-radius-sm` **4px** (controle: botão, input, item de menu) · `--ds-radius-md` **6px** (modal) · `--ds-radius-lg` **8px** (painel, cartão, tabela) · `--ds-radius-pill` 999px (cápsula, avatar).
- **Sombras**: `--ds-shadow-none` (superfícies) · `--ds-shadow-float: 0 8px 24px rgba(16,26,36,.12)` (flutuantes) · `--ds-shadow-toast`. Anel de foco `--ds-ring-width` 3px.
- **Espaço**: `--ds-space-1..8` = 2/4/6/8/10/12/16/24px.
- **Texto**: `--ds-text-3xs` 11px → `--ds-text-3xl` 24px; pesos 400/500/600/700; tracking `-.015em` (títulos), `-.01em`, `.07em` (placa), `.04em` (código).
- **Densidade**: linha compacta `--ds-row-compact` **32px** / confortável `--ds-row-comfortable` **40px**; controles `--ds-control-h` 34px / `--ds-control-h-sm` 30px.
- **Transições**: `--ds-transition-fast` .12s ease · `--ds-transition` .18s ease.
- Breakpoint do DS: `--ds-bp-ds` **768px** — abaixo disso o Design System não entra (celular segue o legado, por definição).

## 3. Temas — regra de ouro

**Tema = só variáveis.** Nenhum componente é reescrito por tema; toda cor vem de `var(--ds-*)`, nunca escrita solta num componente.

**Duas aparências selecionáveis, e só duas** (`CONFIG_TEMA`/`TEMAS` no `app.js`; botões `.tema-opcao[data-tema]` no `index.html`):

| Aparência | `data-tema` | Caráter | `--ds-primary` |
|---|---|---|---|
| **Claro** (padrão) | `claro` | `body.tema-claro` — canvas `#f3f5f2`, superfície `#ffffff` | `#1e3a5f` |
| **Escuro** | `escuro` | `body.tema-escuro` (+ classe `dark`) — canvas `#0e1013` | `#9cc0f0` (a primária institucional some no escuro; inverte para um tom claro) |
| Automático | `auto` | Não é uma terceira paleta: resolve para Claro ou Escuro por `prefers-color-scheme` (`sistemaEscuro()`), reavaliado ao vivo | segue a resolvida |

- Fonte dos tokens: `02-themes.css`, blocos `body.tema-claro`/`body.tema-escuro` — os únicos dois seletores de tema do arquivo. Cada um remapeia os `--ds-*` semânticos para a paleta primitiva.
- **Ponte para o legado** (a partir da ~linha 206 do `02-themes.css`): `--panel`, `--ink`, `--line`, `--brand`, `--display`… são reapontados para os `--ds-*` dentro do escopo — é o que faz os componentes existentes se vestirem sozinhos, com **zero `!important`** na camada.
- **Alto contraste** não é uma terceira aparência — é um interruptor à parte ("Acessibilidade" no mesmo menu) que liga **por cima** do Claro ou do Escuro (`alto-contraste`/`alto-contraste-escuro`): bordas 2px, contraste calculado. **Não desliga o Design System** (desde a 1.51.23).
- ⚠️ Nomes antigos (Comando, Dark, Preto, Cinza, Sépia, SUL, Oceano, Roxo, Lavanda) não existem mais como opção; `aplicarTema()` cai em Claro para qualquer nome desconhecido.
- Os tokens `--epi-*` são declarados em **`body`, não em `:root`** — os temas redefinem em `body.<tema>`, e um `var()` no `:root` resolveria contra o próprio `:root`.

## 4. Tipografia

| Família | Uso |
|---|---|
| **Hanken Grotesk** (fallback Inter, system-ui) | tudo: corpo, títulos, KPIs (dentro do escopo DS, `--display` → `--body`) |
| **JetBrains Mono** | placa, código técnico, valores/KPIs, pílula de versão |

- Números tabulares (`font-variant-numeric: tabular-nums`) em tabelas, valores, datas e placas.
- Hierarquia por peso e tamanho, não por cor. Cabeçalho de tabela 12px/600 em sentence case.
- Mais de uma família por tela além da base é proibido (§9, item 11).

## 5. Componentes

### Botões (`.btn`)
Contrato do DS (`08-modal.css §5`, `05-components.css §3.2`): altura `--ds-control-h` (34px; `.small` 30px), raio `--ds-radius-sm`, peso 500, **sem sombra e sem pulo no hover** (`transform: none`).
- `.btn-primary`: sólido `--ds-primary`, texto `--ds-on-primary`; hover `--ds-primary-hover`; sheen legado morto (`::after { content: none }`).
- `.btn-ghost`: `--ds-surface` + borda `--ds-line-strong`; hover pinta borda/texto de `--ds-primary` e fundo `--ds-surface-subtle`.
- Botão de ação de tabela: quadradinho com SVG `currentColor`.

### Inputs e formulários
- Campo: raio `--ds-radius-sm`, borda `--ds-line-strong`, foco = borda `--ds-focus` + anel de 3px (`color-mix` 22%).
- `.calc input` (campo calculado): fundo `--ds-info-soft` + barra de acento — **é informação**; `:disabled` puro continua neutro (o app desabilita campo em runtime em ~142 pontos; pintar isso de "calculado" trocaria o significado).
- `required` nativo é proibido em formulário com abas ocultas — validar em JS.
- **Select próprio (`.cs-btn`) segue a MESMA régua do campo** no modal (`08-modal.css §4`: `--ds-control-h`, borda `--ds-line-strong`, fonte `--ds-text-base`; hover/lista aberta em `--ds-primary`; na `.modal-confortavel`, os 40px da variante). Antes ficava com os 9px/14px do legado (38px) e desnivelava a linha ao lado de um campo de 34px.
- **Texto de ajuda (`.dica`) vai DEPOIS do campo**, nunca entre o rótulo e o campo: como o `label` é coluna, ele vira uma linha a mais e desce a caixa em relação à vizinha.
- **Campo de data segmentado** (`.hdate`, padrão HeroUI DateField) nos filtros: segmentos `dd/mm/aaaa`, ↑/↓ incrementam, calendário `dp-cal` compartilhado; variante `mm/aaaa` (`.hdate.so-mes`). ⚠️ Detectar month pelo ATRIBUTO (`getAttribute('type')`) — no Firefox a propriedade `.type` devolve `"text"`. Formulários continuam no proxy `dp-input`.

### Tabelas
- Painel raio `--ds-radius-lg`; **só linhas horizontais** (sem zebra, sem trilho vertical), hover único via token.
- Densidade compacta **32px** / confortável **40px** (`data-densidade`, via `height` na `<td>` — vale como mínimo).
- Leitura por coluna: texto à ESQUERDA, número à direita via `.num`; `tabular-nums`.
- (O modo card do celular — `TABELAS_COMPACTAS`/`rotularParaCards` — foi removido em ago/2026 junto com todo o visual mobile, a pedido do usuário, para reconstrução do zero.)

### Modais (`08-modal.css`)
- Véu `--ds-backdrop`; caixa raio `--ds-radius-md` + `--ds-shadow-float`; cabeçalho sticky.
- Variante **opt-in `.modal-confortavel`** (`#modal`, `#funcModal`, `#multaModal`, `#almoxModal`): campos 40px, validação `:invalid`, `.com-historico { max-width: 1080px }`. Não é o padrão de todo modal — promover sem gate mudaria ~68 modais de uma vez (decisão registrada em §11.7).
- Painel de histórico lateral `.modal-hist` é genérico (sem gate).
- **Painel lateral `.modal-lateral`** (opt-in no `.modal-overlay`, `08-modal.css §9`, desde 1.55.45): a mesma casca do modal ancorada à direita na altura toda, sem raio e só com a borda esquerda; cabeçalho e rodapé fixos, só o miolo rola; entra deslizando da direita (`painelLateralIn`, transform/opacity). É para ver o DETALHE de uma linha sem perder a lista de vista (primeiro uso: painel do convite no Acompanhamento da Integração); formulário de cadastro continua sendo modal centrado.

### Pílulas e badges (família unificada, `05-components.css §8–9`)
Catorze classes de badge-pílula (uma por módulo: `.tipo-badge`, `.mntv-tipo`, `.func-pill`, `.almox-sit`, `.usr-badge`…) entram na MESMA regra de forma: raio `--ds-radius-sm`, padding `--ds-space-1 --ds-space-4`, fonte `--ds-text-xs`/peso 500 (detalhe da auditoria em §11.8). A paleta por estado continua no `styles.css` de cada módulo. Tags de status em pastel via `color-mix` — o matiz carrega o significado, sem blocos saturados.

### Faixa de alerta (`.ds-alert`, `07-alert.css`)
Componente único para "N registros precisam de atenção" no topo de uma aba. Estrutura: `.ds-alert` → `.ds-alert-icon` (SVG `currentColor`) → `.ds-alert-content` (título/subtítulo) → `.ds-alert-action` ou `.ds-alert-cta`. **4 variantes** (`-warning/-error/-success/-info`), só a cor de destaque muda, tudo por token. Lista expansível (`.ds-alert-lista`, `<ul>` real, `aria-expanded`/`aria-controls`, Escape recolhe só com foco dentro e devolve o foco ao botão). Montagem por `montarFaixaAlerta({...})` + helper `plural(n, um, muitos)` no `app.js`. Consomem: Multas, Funcionários, Programas SST, Início (backup); Frota usa forma equivalente (`.v2-ofi-*`, travada por e2e); EPI fica de fora de propósito (vocabulário próprio por grupo).

### KPIs (`.v2-kpi`)
Fonte base com `tabular-nums` (sem `--display`). **O escopo vai no TEXTO, nunca só no arranjo visual**: os cartões contam a lista FILTRADA e o rótulo muda com o recorte ("Veículos ativos" → "Veículos no recorte"); o total vai nomeado na nota. Fonte única da pergunta "há recorte?": `temFiltroOuBuscaFrota()` (padrão a replicar por módulo).

### Estados de tela (padrão da Frota, `06-states.css`)
Quatro estados mutuamente exclusivos: **carregando** (esqueleto; nada de zero) / **ok** (lista vazia = estado vazio de verdade) / **erro** (KPIs viram `—`, linha "Dados indisponíveis" no corpo da tabela). ⚠️ **Zero é um dado; "não consegui consultar" não é** — erro nunca reusa o caminho do vazio. Erro de CARGA fala pela faixa persistente (`role="alert"`); erro de AÇÃO fala pelo toast. Um erro, um canal. Falha DEPOIS de carregado não vira erro inicial: os últimos dados válidos ficam e o aviso vai por toast. "Tentar de novo" usa `aria-disabled`, não `disabled` (a propriedade nativa tira o foco do elemento).

### Menus
Mesma carcaça (`09-superficies.css §1`): raio `--ds-radius-lg`, borda `--ds-line`, `--ds-shadow-float` explícito (flutuante recebe sombra mesmo com `--shadow` zerado no escopo), itens raio `--ds-radius-sm`, animação `menuIn`. Datalist e `<select>` nativos substituídos pelos componentes próprios (`.ac-menu`, `.cs`).

### Aviso de nova versão (`.update-banner`, `09-superficies.css §2`)
Cartão fixo no canto inferior direito — flutua de verdade, então mantém sombra (`--ds-shadow-float`), raio de painel, acento de 3px `--ds-primary` na borda esquerda, título na fonte base e botões no contrato do DS. O banner de instalação (PWA) usa a mesma carcaça com acento `--ds-success`, à esquerda. A variante `.obrigatoria` (bloqueia a tela, pulso `pulseUpd`, véu) é exceção registrada (§11.4) — mas herda botões/tipografia/acento por token (`--ds-danger`): a exceção é o pulso, não uma paleta própria.

### Dashboard bento (Resumo de Custos)
Grade `2fr + 1fr`: card hero + coluna lateral; 1 coluna `≤1100px`. Selo de variação pastel via `color-mix` (a COR segue a notícia, não a direção). Card escuro de destaque `.cstd-destaque` via `--ds-shell-bg` (um por tela, exceção registrada). Distribuição por grupo em barra segmentada HTML + legenda (não donut).

### Toolbar e filtros
Multi-seleção via `criarMultiSelect(id, rotulo, onChange)` (`MSEL[id]`, `getSel(id)`). No DS os filtros saem da linha e abrem num painel ancorado no botão de filtros — o painel É o `.filtros` de sempre em `position: absolute`; `role="dialog"` + `aria-haspopup` fixos (postos por `criarPainelFiltros().sincronizar()` quando a instância nasce); sem focus trap (o DOM já ordena o Tab); Esc devolve o foco ao botão; contador conta valores selecionados. Botão "Limpar" desabilita quando não há filtro nem busca.
Em telas de cards/lista o filtro é o **chip de alternância** (`.forn-chip`/`.func-chip`/`.loc-chip`/`.adm-chip`, `05-components.css §11`): raio de controle `--ds-radius-sm` (quadrado, como botão e campo) desde 1.55.45; a cápsula antiga destoava do resto do sistema. O `.v2-chip` (filtro ATIVO removível, com ×) é outro componente e continua cápsula.

### Feedback
- **Toast**: fixo embaixo no centro; `.ok` verde, `.erro` vermelho; sobe quando a barra de seleção está visível. `.toast-acao` no contrato do DS (`06-states.css`).
- **Progresso de upload**: barra de 3px no TOPO (embaixo já disputam toast + sel-bar).

## 6. Movimento

**Regra: só `transform` e `opacity`, disparado por interação.** Easing padrão de entrada: `cubic-bezier(0.16, 1, 0.3, 1)`.

| Animação | Alvo | Duração |
|---|---|---|
| `overlayIn` / `modalIn` | modal | .2s / .34s |
| `menuIn` | menus suspensos | .14–.16s |
| `viewIn` | troca de aba (fade-up 6px) | .3s |
| `barUp` | barra de seleção | .3s |
| micro | active `scale(.985)` | .12–.15s |

- Dentro do escopo DS o hover **não** translada (superfície chapada não pula).
- `prefers-reduced-motion: reduce` → tudo a `.01ms` (global, `!important`).
- **NUNCA animar entrada de tabelas/cards** — re-renderizam a cada filtro e piscariam.

## 7. Responsividade

Breakpoints (max-width, salvo nota): **1400/1500** (grades largas de KPI) · **1100** (bento vira 1 coluna) · **980** (histórico do modal empilha) · **≥901 (min)** — trilho da sidebar e linha de título compacta · **≥768 (min)** — escopo do DS.

- Container queries onde o componente responde ao próprio tamanho (cards KPI via `cqi`).
- **⚠️ ago/2026: TODO o layout de celular (≤900px — gaveta, tabelas→cards, FABs, polimento mobile) foi REMOVIDO a pedido do usuário para reconstrução do zero.** A reconstrução aconteceu ainda em ago/2026: o novo visual vive em `frontend/design-mobile.css` (camada única `<768px`, modelo aprovado na v1.53.62, regras no cabeçalho do próprio arquivo; entra no `test/design-system.test.js`). Entre 768px e ~900px vale o layout desktop.
- **Regra do usuário: não mexer no layout de celular sem pedido explícito.**

## 8. Acessibilidade (não regredir)

1. **Foco de teclado visível**: `:focus-visible` com outline 2px em TODO interativo (pílulas, cards clicáveis, selects custom incluídos). Só teclado — mouse não vê.
2. **Contraste AA calculado**, não chutado — a paleta do DS foi verificada combinação a combinação (relatório da 1.51.5); os comentários do CSS registram as razões. Manter o hábito ao criar cor nova. Borda de campo obedece WCAG 1.4.11 (3:1) — daí `--ds-line-strong`.
3. Alto contraste como interruptor por cima do tema (bordas 2px), sem desligar o DS.
4. `prefers-reduced-motion` respeitado globalmente.
5. Disclosure sem focus trap e sem `role="dialog"` gratuito: nome acessível carrega quantidade e escopo; Escape age só com foco dentro e devolve o foco ao gatilho (padrão da faixa de oficina/`.ds-alert`).
6. `aria-disabled` em vez de `disabled` quando o foco precisa sobreviver à espera.

## 9. NUNCA usar (vinculante)

1. Cor escrita solta num componente — toda cor vem de token; tema redefine variável, nunca reescreve componente.
2. Animação de entrada em tabela/card de dados (pisca a cada filtro).
3. Animar propriedade fora de `transform`/`opacity` no caminho quente.
4. `!important` ou seletor com ID de módulo em qualquer arquivo coberto por `test/design-system.test.js`.
5. `translateY`/sombra de hover em superfície do DS (relevo é vocabulário de marketing).
6. `required` nativo em campo de formulário com abas ocultas (quebra o submit) — validar em JS.
7. Cor de status inventada — pílulas usam a paleta fixa por significado do módulo.
8. `.hero__eyebrow-dot` e número decorativo em título de seção — banidos.
9. Travessão `—` em texto de interface (rótulo, tooltip, título, dica, toast). Separar com vírgula, dois-pontos, `·` ou parênteses. Placeholder de valor vazio em célula pode continuar `—`.
10. Kicker/eyebrow decorativo acima de título: o page-head global é a única identificação da tela.
11. Mais de uma família tipográfica por tela além da base: `--mono` reservada a placa/código técnico; display não entra em tela de dados.
12. Emoji como ícone de interface — SVG stroke `currentColor` sempre.
13. **Tratamento visual próprio sem entrada no registro da seção 11.** "Esta tela tem identidade própria" não é justificativa: ou o componente está na tabela de exceções, ou segue o Design System.
14. Gradiente decorativo de fundo — sai em favor de superfície chapada + borda (exceto quando o degradê É o conteúdo, §11).

## 10. A camada `design-v2` — arquitetura e escopo

**Nasceu como piloto de UMA tela (Frota, ago/2026) e foi promovida: é a identidade única do sistema.** As 28 abas do painel carregam `ds-modulo` (a classe na `<section>`, ver `sincronizarShellDS()` no `app.js`) e `body.design-v2` é fixa desde o boot.

- **Arquivos:** `frontend/design-system/*.css` (tokens, temas, base, shell, componentes, estados, alert, modal, superfícies) + camadas de correção por módulo (`design-v2.css` = Frota, nome histórico; `design-manutencao.css`, `design-multas.css`…). Carregados DEPOIS do `styles.css`, que eles **nunca editam**.
- **Alcance:** todo o painel, **só ≥768px** (celular fora por definição), sempre sob `body.design-v2` (classe fixa). O shell veste `body.ds-shell` quando a view ativa tem `ds-modulo`.
- **Kill switch aposentado (ago/2026):** o antigo `?design=off` foi removido — a query é ignorada. O `styles.css` não guarda uma aparência alternativa mantida, então "desligar" só deixava o app sem estilo; histórico: era permanente em `localStorage` até 1.53.51, virou por-sessão em 1.53.52 e saiu de vez na faxina do design antigo.
- **Escopo em dois níveis:** `body.design-v2 .ds-modulo …` para conteúdo; `body.ds-shell …` para o shell e menus portados ao `<body>` (`.pill-menu-portaled`, `.msel-menu-flutuante`); `body.design-v2 .modal-overlay` para qualquer modal; componentes soltos no body (aviso de versão) direto em `body.design-v2 …`. Sair para um contexto sem `ds-modulo` devolve o tema escolhido.
- **Método:** ponte de tokens (§3) — a camada tem **zero `!important` e zero cor literal**, travado por `test/design-system.test.js` (que também proíbe seletor com ID de módulo dentro de `design-system/`).

### 10.0 Cobertura versionada

`e2e/frota-design-v2.e2e.js` (porta 3211, `npm run test:e2e:design-v2`) — ativação por padrão (`?design=off` é ignorado), isolamento entre módulos, alto contraste, painel de filtros (ARIA, teclado, Esc, clique fora), densidade 32/40px, os três estados da tabela, os dois canais de erro, escopo dos KPIs. Detecta módulos pelo próprio DOM (`.ds-modulo`) — migração nova não exige editar o teste. Desde 1.51.11 há comparação automatizada de estilos computados: IGUAL entre dois módulos migrados nos componentes genéricos. Auditoria estática complementar em `test/design-system.test.js` (sem browser).

### 10.1 Telas públicas (login, verificar, admissão, treinamento, assinar-epi, 404, hub)

Telas públicas **não carregam `design-system/`** (fora do escopo do DS — ver §11.4). O padrão, inaugurado no redesign do login (v1.53.52) e estendido às demais na faxina do design antigo (ago/2026 — verificar, admissão, treinamento, assinar-epi e 404 migraram; o hub migrou por último, na v1.55.45):

- **Cópia literal dos tokens** num `<style>` próprio da página, com comentário de origem obrigatório citando `01-tokens.css`/`02-themes.css` e esta seção — mudou token lá, atualiza a cópia.
- Nomes locais sem prefixo (`--canvas`, `--surface`, `--ink`, `--primary`, `--focus`…) + bloco shell grafite (`--shell-*`), **idêntico nos dois temas**.
- Tema escuro por classe `dark` no `<body>`, que só redefine variáveis.
- **O alternador de tema grava a MESMA chave `localStorage['tema']` do app** (`claro`/`escuro`/`auto`) — o tema escolhido no login vale dentro do sistema e vice-versa.
- Layout do login: painel institucional grafite à esquerda (marca em ladrilho 42px raio 8px + glifo por CSS mask, título, lista de valor) + cartão de acesso à direita (`max-width` 400px, raio 8px, borda 1px, **sem sombra**); `≤900px` empilha e o shell vira faixa de topo.
- Controles: campo 40px raio 4px borda `--line-strong`, foco com anel de 3px; botão principal 40px sólido `--primary`; pílula de versão em JetBrains Mono raio 999px.
- **Hub de acesso (`hub/`, servido em `/`, v1.55.45)** — mesmo painel grafite do login à esquerda (marca, frase, lista de **atalhos de teclado** com `<kbd>` em JetBrains Mono) + à direita um cartão por sistema (`.sistema`): prévia chapada da tela (moldura de janela raio 6px, sem inclinação nem sombra), ladrilho 40px, selo "Último acesso" (família de badges, raio 4px), módulos, endereço em mono, tecla do atalho e botão "Entrar". **Um só botão sólido por tela**: o do cartão `marcado` (último acesso ou o que tem foco; é o que o Enter abre); o outro é ghost. O cartão inteiro é a área de clique do ÚNICO link dele (`::after` do "Entrar"), e o anel de foco vive nesse `::after` — por isso o cartão **não** tem `overflow: hidden` e o link **não** leva `transform` (viraria o bloco de contenção do `::after`). Estado "Abrindo…" no botão em vez de overlay de tela cheia (sai sozinho em 10 s se a navegação for cancelada). `≤1199px` os cartões empilham; `≤900px` o grafite vira faixa de topo de 69px (tema vira botão de 44px sobre ela) e somem prévia, módulos e endereço. **Teclado:** ← → de qualquer ponto; **1 e 2 só com o foco num cartão** (WCAG 2.1.4: atalho de tecla única não pode valer na página inteira sem como desligar); por isso o foco nasce no cartão marcado quando há `pointer: fine`. Duas diferenças de propósito em relação ao login: (1) o tema escuro vai no **`<html>`** (`:root.dark`), aplicado pelo `hub/script.js` carregado **síncrono no `<head>`** — no fim do `<body>` a página piscava clara para quem usa o escuro; (2) a cópia dos tokens mora em **`hub/styles.css`** (folha própria servida em `/hub/*`, com o mesmo comentário de origem), não num `<style>` da página. A chave de tema é a compartilhada (`tema`); a antiga do hub (`hub-nte:tema`, preto/branco) é migrada uma vez e apagada. Nota de cópia: `--shell-muted-2` do login e do hub é o graphite-200 (`#aab0b7`), não o graphite-350 do `--ds-shell-muted-2` do app — diferença herdada do redesign do login, mantida igual nas duas telas públicas.
- Hanken Grotesk + JetBrains Mono, `prefers-reduced-motion` respeitado.

### 10.2 Trabalho futuro (registrado, não implementado)

- **Escolher quais colunas aparecem** nas tabelas (densidade não substitui isso: densidade muda a altura da linha, seleção de colunas muda o que é exibido).
- **Paginação de verdade** (a Frota renderiza a lista inteira; o rodapé é informativo).
- **Cobertura e2e dos contratos visuais dos modais** (o e2e cobre telas, não modal). Combinado com o usuário, não iniciado.
- **Eliminar `.veic-doc-box`** consolidando com `.prog-doc-*` (§11.7). Combinado com o usuário, não iniciado.
- **Unificar `#frotaOficinaAlertas`** (`.v2-ofi-*`) em `.ds-alert` — exige reescrever a suíte e2e junto.
- **Ícone da busca** (`background-image` com hex no data URI — hoje `%238a9aa2`; `<input>` não renderiza `::before` e data URI não interpola variável): SVG inline pediria wrapper no DOM. Registrado, não bloqueante.

## 11. Exceção visual controlada (registro vinculante)

Escrita na auditoria visual e estrutural de ago/2026 (v1.51.24), depois de a auditoria ter derrubado três "identidades visuais próprias" que na verdade eram só desenho antigo. A regra existe para que essa decisão não volte a ser tomada caso a caso, no olho.

### 11.1 A regra

**Duas categorias, e só duas:**

1. **Componente FUNCIONAL** — existe para o usuário ler um dado, tomar uma decisão ou executar uma ação. Cabeçalho de seção, cartão de dado, ficha, linha, painel, campo, botão, selo, menu, modal, aviso.
   → **Segue o Design System, sem discussão.** Forma, raio, sombra, relevo, densidade e cor vêm dos tokens. Não há tela com direito a "um jeitinho só dela": um botão de Senhas é o botão de Multas.

2. **IDENTIDADE INSTITUCIONAL** — não é interface, é um *objeto* que a interface exibe: a marca da empresa, um documento oficial impresso, um artefato físico ou regulado que o usuário reconhece pela aparência. Aqui a aparência **é** o conteúdo; normalizá-la destruiria a informação.
   → Pode ter **tratamento próprio CONTROLADO**, nas condições de 11.3.

### 11.2 O teste de decisão

Na dúvida, três perguntas. Basta um **não** para o componente ser funcional:

1. **A aparência carrega informação que o texto não carrega?** A faixa azul da placa Mercosul diz "isto é uma placa brasileira"; um degradê num cabeçalho de página não diz nada.
2. **O objeto existe fora do sistema?** Cartão de crédito, crachá, placa e a marca da empresa existem no mundo. Um cartão de pasta não.
3. **É único, ou é um padrão repetido?** Componente usado em mais de uma tela é, por definição, funcional. Foi o que decidiu `.empresa-hero`: ele aparece em três telas.

### 11.3 Condições de uma exceção (todas obrigatórias)

- **Entrada nesta tabela**, com o motivo — não vale só um comentário no CSS.
- **Escopo fechado** por classe ou ID do próprio objeto. Exceção não vaza para o componente vizinho.
- **Cor vinda de token** sempre que o objeto não exigir uma cor fixa do mundo real. "É exceção" libera a forma, não libera hex solto.
- **Só o objeto, nunca a moldura.** O que está em volta (ladrilho, cartão, contêiner) continua do Design System — ver `.logo` em 11.4.
- **Acessibilidade não é exceção.** Contraste AA, foco visível e `prefers-reduced-motion` valem sempre.

### 11.4 Registro de exceções em vigor

| Objeto | Tratamento próprio | Por quê | Onde |
|---|---|---|---|
| `.cartao-cc` (Cartões) | Degradê, raio 16px, anel interno, proporção 1.586, escuro em todos os temas | Representa um cartão de crédito **físico**; a aparência é o objeto | `styles.css` |
| `.placa-chip` e `.placa-visu` (Frota/Multas/Rastreadores) | Faixa azul de topo (`--ds-border-plate`) e tracking de placa (`--ds-tracking-plate`); a `.placa-visu` (pré-visualização no modal) reproduz a placa física inteira — moldura escura e azul Mercosul `#003da5` são o conteúdo | Artefato **regulado** (Mercosul); a faixa é o que a identifica | `05-components.css §7.1` · `styles.css` |
| `.logo` + `.brand-text` (sidebar) | A **arte** da marca é intocada | Marca institucional Gestão RM / NTE | `04-shell.css §2` |
| `.cracha-*`, `#crachaModal` | Sem casca de janela, sem raio, fundo branco fixo | É folha de **impressão**, não superfície de tela | `styles.css` (`!important` de impressão) |
| `.sw-auto`, `.sw-contraste` (menu Aparência) | Degradê meio-a-meio | O degradê **é o conteúdo** (mostra claro × escuro) | `styles.css` |
| `.update-banner.obrigatoria` | Pulso (`pulseUpd`) + véu | Diálogo que **bloqueia** a tela; chamar atenção é a função. Botões, tipografia e acento seguem o DS por token (desde 1.53.53) — a exceção é o pulso, não a paleta | `styles.css` |
| `#camModal` | Tela cheia, raio 0 | Visor de câmera ao vivo | `styles.css` |
| `.midia-lightbox` | Véu próprio, sem `.modal` dentro | Visor de mídia em tela cheia | `styles.css` |
| Sidebar grafite | Escura nos **dois** temas | Âncora visual do desenho, decisão do próprio DS | `01-tokens.css`, `02-themes.css §3` |
| `.cstd-destaque` (Custos) | Continua **escuro** nos dois temas | Mesmo papel de âncora da sidebar — via `--ds-shell-bg`, não degradê literal | `09-superficies.css §6` |
| `.av-wrap[data-moldura] .av-moldura` (foto de perfil) | `conic-gradient` com hex próprios + giro no hover | Moldura **escolhida pelo usuário** como adorno da própria foto (halo/neon/ouro/fogo/coroa) — o degradê é o conteúdo, como nos `.sw-*`; regularizada na auditoria de ago/2026 (§9 item 13) | `styles.css` |
| `.sistema-tile--fluxo` (hub de acesso) | Ladrilho violeta `#6d28d9` (= `--ds-violet-700`, copiado como `--fluxo-marca`) com glifo branco redesenhado em SVG, igual nos dois temas | **Desvio consciente da condição 4 de 11.3** (que manda o ladrilho seguir o DS, como no `.logo`): aqui o ladrilho colorido FAZ o papel de ícone de app de **outro produto**, cuja identidade é violeta (sidebar e logo do Fluxo RM), e é o que diz "este cartão é o Fluxo" antes de ler. O glifo é um redesenho, não a arte original (`hub/assets/fluxorm.png`, um PNG borrado de baixa resolução). Aprovado pelo usuário no canvas do redesenho do hub (24/09/2026). O cartão em volta, o botão e o selo seguem o DS (o Gestão RM usa o ladrilho grafite do shell) | `hub/styles.css` |
| `PALETA_GRAF_CLARA`/`PALETA_GRAF_ESCURA` (gráficos) | 8 hex fixos por modo | Paleta categórica **validada** (banda de luminosidade, croma, daltonismo, contraste ≥3:1) — token de tema não garante essas propriedades entre vizinhos; todo hex de render passa por `coresGraficoDoTema()`/`corGraficoTema()` | `app.js` (comentário junto às constantes) |

**Fora do registro, por não serem exceção e sim ausência de escopo:** o celular (`<768px`), onde o Design System não entra por definição; e as telas públicas (`login`, `verificar`, `admissao`, `treinamento`, `assinar-epi`, `404`, `hub`), que não carregam o `design-system/` — elas seguem o padrão de cópia de tokens da §10.1 (o hub também, desde a v1.55.45, salvo o ladrilho do Fluxo registrado acima).

**Não é exceção (nota de correção):** alto contraste **não** desliga mais o Design System (desde a 1.51.23).

### 11.5 Classificação: telas Senhas (`#senhas`) e Documentos (`#documentos`)

Auditadas componente a componente pelo teste de 11.2. **Resultado: nenhum componente de identidade — todos funcionais.** Nenhuma exceção nova foi criada.

| Componente | O que é, de fato | Veredito |
|---|---|---|
| `.empresa-hero` | Cabeçalho de seção (kicker + título + descrição + ação). Usado em **três** telas: Senhas, Documentos e a sub-aba Termos de Multas | **Funcional** — reprovou nas 3 perguntas |
| `.empresa-toolbar`, `.busca`, `.ord-select` | Barra de ferramentas | **Funcional** (já no DS desde `05-components §3.1`) |
| `.empresa-grid`, `.empresa-card` | Cartão de credencial: dado + ações | **Funcional** |
| `.empresa-icone` | Ladrilho com a **primeira letra do serviço** ou o **formato do arquivo** (`PDF`), `aria-hidden="true"` | **Funcional** — é avatar gerado a partir de um texto que já está ao lado, não a marca de ninguém |
| `.empresa-tag`, `.senha-observacao-badge` | Categoria e selo de observação | **Funcional** |
| `.documento-empresa-grid`, `.documento-empresa-card` | Cartão de pasta/arquivo: navegação | **Funcional** |
| `.doc-emp-pasta`, `.doc-emp-editar`, `.cofre-card-abrir` | Ícone de pasta, ação de editar, área clicável | **Funcional** |

**Consequência registrada:** a rejeição anterior de `.empresa-hero`, `.documento-empresa-card` e `.empresa-icone` ("identidade visual própria") não sobrevive ao teste — nenhum dos três é objeto, dois deles se repetem em mais de uma tela e o degradê não carregava informação alguma. Os dois testes e2e negativos que travavam o degradê foram reescritos para o contrato novo, com o histórico da reversão dentro deles (`e2e/frota-design-v2.e2e.js`).

### 11.6 `.empresa-kicker` — avaliado e REMOVIDO (1.51.24)

Critério aplicado: conteúdo funcional de domínio fica; título decorativo sai. As três instâncias existentes foram medidas contra o que **já estava na tela** no mesmo momento:

| Kicker | Tela | Já na tela | Veredito |
|---|---|---|---|
| `Cofre da empresa` | Senhas | page-head: **"Senhas" / "Cofre de credenciais da empresa"** | **Decorativo** — repetição literal do subtítulo |
| `Arquivo institucional` | Documentos | page-head: **"Documentos" / "Documentos empresariais organizados"** + `<h3>` "Documentos em pastas…" | **Decorativo** — sinônimo do subtítulo |
| `Arquivo de multas` | sub-aba Termos (Multas) | aba **Multas** + sub-aba **Termos** + `<h3>` "Termos e modelos em pastas" | **Decorativo** — o escopo já vem da aba e da sub-aba |

Nenhuma carregava dado, contagem, estado ou recorte: eram rótulos de posicionamento, não de domínio. As três saíram do `index.html`, confirmando o item 10 da seção 9 (o page-head global é a única identificação da tela). O `<h3>` e o parágrafo de cada hero ficam — eles explicam o que a tela faz.

A regra `.empresa-kicker` (sem nenhum consumidor desde a remoção acima) foi apagada do `styles.css` na auditoria de padronização visual (ago/2026), junto com `.vazio-limpar` (regra morta: o botão do estado vazio usa `.empty-acao`).

### 11.7 Migração de `#funcModal`/`#multaModal`/`#almoxModal` — a dívida de sequenciamento do `#modal` foi resolvida

Das 4 divergências que só `#modal` tinha, 3 subiram para o genérico e 1 ficou — não porque "foi o primeiro modal", mas porque passou pelo teste de 11.2 linha a linha, não por decreto.

**O que subiu para `08-modal.css`/`09-superficies.css`:**

- **Densidade de campo (`--ds-row-comfortable`, 40px)** — virou a variante opt-in `.modal-confortavel` (classe posta em `#modal`, `#funcModal`, `#multaModal`, `#almoxModal` no `index.html`), **não** o padrão de todo modal. Motivo: promover sem gate mudaria os ~68 modais do app de uma vez — `design-v2` deixou de ser opt-in por usuário em ago/2026, então "genérico" hoje significa "todo mundo, imediatamente", inclusive diálogos pequenos (assinatura, câmera, confirmação) nunca avaliados nessa altura. Decisão tomada com o usuário nesses termos.
- **`.calc input` com fundo `--ds-info-soft` + barra de acento** — subiu **sem** gate, mas **sem `:disabled` puro junto**: campo calculado é informação, campo desabilitado por permissão/estado é outra coisa (o `app.js` desabilita campo em runtime em 142 pontos — pintar isso de "calculado" trocaria o SIGNIFICADO da cor, não só a aparência). `:disabled` sozinho continua com o tratamento neutro de sempre.
- **Painel de histórico lateral (`.modal-hist`, incluindo o ícone do estado vazio)** — subiu sem gate: confirmado que só `#modal`/`#multaModal` usam a classe no app inteiro, então não havia blast radius para conter. A largura reduzida (`.modal.com-historico { max-width: 1080px }`) entrou dentro de `.modal-confortavel` — dos dois consumidores, só `#multaModal` ganhou o valor de fato (`#modal` já tinha).
- A validação nativa (`:invalid`) que `#modal` também tinha **foi para dentro de `.modal-confortavel`** pelo mesmo motivo da densidade: ~30 campos `required` espalhados por mais de uma dezena de outros modais tornavam a promoção sem gate arriscada.

**O que ficou — os DOIS resíduos de `design-veiculo-modal.css` (não um só):**

| Resíduo | Por quê fica |
|---|---|
| `.veic-doc-box` como linha administrativa (sem card) | Componente que só existe no domínio veículo (FIPE vinculado, CRLV) — `09-superficies.css §3` continua tratando a classe como painel para quem mais a usasse fora daqui. Não é exceção de identidade (reprova o teste de 11.2); é candidato a **desaparecer**, não a virar padrão, quando for consolidado com `.prog-doc-*` (§10.2) — aí a pergunta "linha ou card" some porque a classe some. |
| `#inpFipe` (campo de FIPE, calculado mas editável) | **Corte de escopo daquela entrega**, não decisão de design — não chegou a ser avaliado se vira classe (ex.: `.calc` num field ainda editável). Última referência por ID do arquivo. |

Também fechou, na mesma migração, dois buracos que nunca foram decisão nenhuma: 4 classes do funcionário (`.func-adm-ficha`, `.func-docs-zipbar`, `.func-obrig-aviso`, `.func-fichaepi-chip`) que já eram tratadas como card dentro de `.ds-modulo` mas não dentro de `.modal-overlay` (`#funcModal` não vive dentro de nenhuma `.ds-modulo`), e o checklist do Detran em `#multaModal` (`.detran-etapa`, `.detran-obs-btn.tem-obs`), que fixava `#2563eb`/`#60a5fa` por tema sem nenhuma cobertura do DS — `--ds-info`/`--ds-info-soft` resolvem os dois tons sozinhos.

⚠️ **Pendência não fechada, registrada em vez de silenciada:** `.campo-travado` (`#almoxModal`, campo "Obra/contrato") é o análogo do almoxarifado ao `.calc`/`:disabled` do veículo — um campo travado que deveria ler como informação, não como formulário desabilitado. Não entrou porque a regra em `styles.css` usa **dois `background`/`border-color` com `!important`**; uma regra do Design System não pode usar `!important` (proibido por `test/design-system.test.js`). Resolver exige primeiro remover o `!important` do legado em `styles.css` — faxina própria, mesmo tratamento dado a `.empresa-kicker`/`.vazio-limpar`.

**Resultado prático:** `#funcModal`, `#multaModal` e `#almoxModal` não ganharam arquivo próprio por ID nenhum — fecharam inteiros com classe (`.modal-confortavel`) e com as adições acima nos dois arquivos genéricos. `design-veiculo-modal.css` encolheu de ~220 para ~90 linhas.

### 11.8 Auditoria de padronização visual (ago/2026) — família de badges-pílula unificada

Rastreadores era o **único** caso conhecido de `.tipo-badge` (Instalado/Removível/Outros) em pílula 999px ao lado de uma coluna Situação já na forma do DS. Medindo (Playwright, `getComputedStyle`) o mesmo padrão nas demais abas — um detector geométrico varreu toda `<td>` de toda tabela migrada procurando cápsulas de raio ≥ metade da altura, sem depender de adivinhar nome de classe —, apareceram **treze reimplementações** do mesmo componente, uma por módulo, todas nascidas antes deste padrão existir: `.mntv-tipo` (Manutenção), `.apt-pill` (Controles), `.func-pill` (Funcionários, cartão e tabela), `.treino-status` (Integração), `.seg-area`/`.acao-tag` (Segurança), `.inv-fonte` (Investimentos), `.loc-table-contrato` (Locações), `.almox-sit` (Almoxarifado), `.usr-badge` (Usuários), `.fb-status`/`.fb-tipo` (Feedback), `.adm-pill` (Admissão).

Todas as catorze classes (`.tipo-badge` incluída) agora entram na MESMA regra de forma em `05-components.css §9` — raio `--ds-radius-sm`, padding `--ds-space-1 --ds-space-4`, fonte `--ds-text-xs`/`--ds-weight-medium`, entrelinha `--ds-leading-normal` — igual, byte a byte, à pílula de Status (§8). A paleta por estado (cor de fundo/texto de cada variante) continua declarada no `styles.css` do próprio módulo, sem tocar.

**Ficaram de fora, de propósito:**
- `.dev-pill` — painel interno de diagnóstico do desenvolvedor (`#devPainelModal`), fora de qualquer `.ds-modulo`.
- `.almox-pill` — não é um rótulo simples: tem ícone (`.almox-pill-marca`) e sub-selo de quantidade (`.almox-pill-qtd`), uma tag composta com forma própria. Continua fora do DS geométrico, junto com `.epi-est-n`/`.epi-mov` (já registrados).
- `.campo-travado`/`.veic-doc-box` — pendências já registradas em §11.7, bloqueadas por motivo próprio.

---

## Apêndice histórico (não normativo)

<details>
<summary>Redesign "Centro de comando" (antecedeu o Design System) — identidade, tokens, componentes e medições do piloto</summary>

Descreve o padrão que valeu até a promoção do `design-v2`: raio 14/18/10px, sistema de temas antigo (12 nomes), Bricolage Grotesque em títulos, hover `translateY`. Nada disso é referência para trabalho novo.

### Identidade
"Centro de comando" MINIMAL (ago/2026) — painel operacional chapado: fundo sólido, atmosfera desligada (`body::before/::after { display: none }`; os tokens `--grid`/`--glow-*`/`--grain-opacity` continuavam definidos), superfícies flat (`--panel` + borda `--line`, sem sombra; sombra só em flutuantes). Rótulos técnicos em mono uppercase espaçado (eyebrows, `thead th`, KPIs); ponto de status com glow nos cards KPI (`.card::before`, cor por `--card-c`); botão primário sólido `--brand`/`--brand-dark`; aba ativa da sidebar em pílula suave estilo Gmail (`--brand-halo`); tags de status pastel via `color-mix`; perfil do usuário no rodapé da sidebar.

### Tokens legados (`:root` = tema Claro; temas só redefiniam variáveis)
`--bg`/`--bg-2 #eef1f8` · `--panel #ffffff` · `--ink #14203a` · `--muted #525c70` · `--faint`/`--label #5f6a80` · `--line #e2e7f1` · `--brand #1b56ff` / `--brand-dark #1142e0` / `--brand-2 #4f7bff` · `--accent #ef8a17` · `--green #16a34a` / `--amber #d97706` / `--red #dc2626` · softs `#fef2f2`/`#fffbeb` · `--row-hover #e9f0ff`. Raios: 14px card/painel (16–18 nos temas de vidro), 10px controle, 11px menu, 18px modal, 999px selo. `--brand-halo` = `color-mix(brand 22%, transparent)`, anel de 3px no foco. Hoje esses nomes seguem vivos como PONTE: remapeados para `--ds-*` dentro do escopo do DS (§3).

### Tipografia
Bricolage Grotesque (`--display`) em h1–h3/KPIs (700/800, `-.02em`); Hanken Grotesk (`--body`) no corpo (14px, 1.5); JetBrains Mono (`--mono`) em eyebrows/`thead th` (9–10.5px, 700, uppercase, `.13em–.22em`). KPIs com `clamp(...cqi...)` (container query).

### Componentes (valores antigos)
`.btn` padding 9px 16px raio 10px peso 600; `.btn-primary` sólido `--brand`; `.btn-ghost` `--panel`+`--line`; `.btn-perigo` `--red`. Cards KPI de vidro com ponto de status e hover `translateY(-3px)`. Pílulas de status com cores fixas por significado (veículo: ativo `#16a34a` · oficina `#c2410c` · galpão `#7c3aed` · parado `#475569`; multa: pago `#16a34a` · andamento `#b45309` · pendente `#dc2626`; rastreador: ativo `#16a34a` · removido `#475569` · devolvido `#0369a1` · trocado `#b45309` · transferido `#7c3aed`) — a paleta por significado segue válida (§9, item 7); a forma migrou para o DS (§11.8). Tabelas raio 14px, `thead` mono 9.5px uppercase sticky. Modais raio 18px, `max-width` 760px (1300px com histórico). Toast fixo embaixo `#111827` raio 12px. Banners `update-card` com `border-left` 5px.

### Medições do piloto Frota (1.51.5–1.51.6)
Regressão visual em 1440×900 (worktree em HEAD, dois servidores, mesma base):

| Comparação | Diferença |
|---|---|
| A) HEAD puro × HEAD + as duas correções gerais | 25,087% (o subtítulo desloca a página inteira) |
| B) HEAD + correções × árvore atual com o piloto desligado | 0,000% |
| C) árvore atual, piloto desligado × ligado | 89,015% |
| D) aba Multas: HEAD × árvore atual com o piloto ligado | 0,000% |

Formulação correta: "com o piloto desligado não há diferença visual causada pela camada design-v2; permanecem as duas correções gerais documentadas da Frota". Ao medir D, mover o ponteiro para área neutra antes da captura (hover fantasma deu falso positivo de 0,65%).

Layout medido (base de 24+2 veículos): Y da tabela 354,7px → 284,1px com o piloto (ganho de 70,6px ≈ 9 linhas a mais); toolbar de 3 linhas/182px → 1 linha/50px; linha de tabela 41,5px → 32px. Cenário extremo (aviso + 5 filtros longos, 1024×768): Y 557,5px, sem meta de posição. A faixa de oficina rola por dentro em 1024px (`overflow-x: auto` na lista interna) — proposital, a rever se o aviso virar padrão.

### Armadilhas registradas na migração (seguem úteis)
A grade blueprint morava em `.main-area`, não no `body::after`; `@media (min-width: 701px)` fixa `min-height: 28px` nos botões de ação; `.toolbar .btn/.msel-btn` têm `min-height: 38px` desde a 1.51.0; a `.busca` da toolbar-cartão carrega `margin-bottom: 6px` — declarar só `height` não basta. Regras que escondem DOM exclusivo do piloto são por ID (`#frotaKpis`…) — seletor só de classe não vence. `getComputedStyle(el).display` não responde "está na tela?" (um elemento dentro de um pai `display:none` continua computando `grid`) — quem responde é `offsetParent`/`getBoundingClientRect`.

### Detalhes do piloto Frota preservados
- **Faixa de oficina** (`faixaOficinaV2`, `OFICINA_EXPANDIDA`): resumo recolhido + lista expansível inline, largura inteira, sem `overflow-x`, sem popover. `<button>` nativo com `aria-expanded`/`aria-controls` e nome acessível com quantidade E escopo; `<ul>`/`<li>` de verdade; Escape recolhe só com foco dentro. `OFICINA_EXPANDIDA` é módulo-level porque `renderTabela()` remonta a faixa a cada filtro. ⚠️ Escopo diferente dos KPIs: `veiculosNaOficina()` lê `VEICULOS` direto (cadastro inteiro, `ESCOPO_OFICINA` no texto), enquanto os KPIs contam `fleetAtiva()` filtrada. Única parte do piloto com dois caminhos de DOM no JS (`if (design-v2)`) — exceção controlada de migração, não precedente.
- **"20 de 24"**: `aplicarFiltros()`/`fleetAtiva()` (sem vendidos, filtrada) ≠ `VEICULOS.length` (tudo, vendidos inclusive) — por isso os rótulos nomeiam o recorte.

</details>
