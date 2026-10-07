# RECEITA-FROTA.md — Frota como referência visual (medido)

Valores coletados com Playwright (`getComputedStyle` + `getBoundingClientRect`) na aba **Frota**, viewport 1440×900, base semeada por `scripts/seed-mock.js`, nos dois temas (`claro`/`escuro`). Cada linha traz o **valor computado** e o **token correspondente** em `frontend/design-system/01-tokens.css`.

Achado geral: os dois temas produzem **exatamente os mesmos números** (mesma altura, padding, raio) — só a cor muda. Isso confirma a regra de ouro do Design System (§4 do `docs/DESIGN.md`): tema é só variável, nenhum componente é redesenhado por tema. Por isso a tabela abaixo não repete claro/escuro quando só a cor muda — a cor de cada tema vem listada uma vez.

## Cabeçalho de tabela (`#tabela thead th`)

| Propriedade | Medido | Token |
|---|---|---|
| Altura da célula | 42.25px | (padding + line-height + borda) |
| Padding | `8px 12px` | `var(--ds-space-4) var(--ds-space-6)` |
| Fonte | 12px / peso 600 | `var(--ds-text-xs)` / `var(--ds-weight-semibold)` |
| Cor (claro) | `rgb(92,104,95)` | `--ds-muted` (claro) |
| Cor (escuro) | `rgb(159,176,190)` | `--ds-muted` (escuro) |
| Borda inferior | `1px solid` cor de `--ds-line` | `var(--ds-border)` |
| Fundo (claro) | `rgb(233,237,233)` | `--ds-surface-subtle` |
| Ícone de ordenação | seta ◇/▲/▼ ao lado do rótulo, mesma cor do texto | `iconeOrd()` no `app.js` |

## Linha de tabela (densidade compacta, padrão)

| Propriedade | Medido | Token |
|---|---|---|
| Altura da linha | **32px** | `var(--ds-row-compact)` |
| Padding da célula | `4px 12px` | `var(--ds-space-2) var(--ds-space-6)` |
| Fonte da célula | 13px | `var(--ds-text-base)` |
| Borda inferior | `1px solid var(--ds-line)` | `var(--ds-border)` |
| Zebra | nenhuma (desligada de propósito) | — |

## Coluna de ações (`.acoes button`)

| Propriedade | Medido | Token |
|---|---|---|
| Tamanho do botão | 22×22px | `var(--ds-action-h)` |
| Raio | 4px | `var(--ds-radius-sm)` |
| Borda | `1px solid var(--ds-line)` | `var(--ds-border)` |
| Fundo | `--ds-surface` | |
| Hover (editar) | borda/texto/fundo `--ds-primary`/`--ds-info-soft` | |
| Hover (excluir) | borda/texto/fundo `--ds-danger`/`--ds-danger-soft` | |

## Pílula de Status/Situação (`.pill-trigger`, coluna "Status")

| Propriedade | Medido | Token |
|---|---|---|
| Raio | **4px** | `var(--ds-radius-sm)` |
| Padding | `2px 8px` | `var(--ds-space-1) var(--ds-space-4)` |
| Fonte | 12px / peso 500 | `var(--ds-text-xs)` / `var(--ds-weight-medium)` |
| Entrelinha | 16.8px (=1.4×12) | `var(--ds-leading-normal)` |
| Altura final | 22.8px | (padding + entrelinha) |
| Ponto colorido | 6px, `currentColor` | `var(--ds-space-3)` |
| Borda | `1px solid` cor do estado a 34% | `color-mix(...)` |

Mesma receita para a variante `.cc` (Centro de Custo, dropdown neutro) — só a paleta muda (transparente + borda neutra em vez de cor de estado).

## Placa Mercosul (`.placa-chip`)

| Propriedade | Medido | Token |
|---|---|---|
| Raio | 4px | `var(--ds-radius-sm)` |
| Faixa azul de topo | 4px | `var(--ds-border-plate)` |
| Fonte | 12px mono, peso 700 | `var(--ds-text-xs)` / `--mono` |
| Tracking | 0.84px (=.07em×12) | `var(--ds-tracking-plate)` |
| Padding | `0 7px 1px` | |

## Busca e filtros

| Elemento | Altura | Padding | Raio | Fonte |
|---|---|---|---|---|
| `#busca` (campo de busca) | 34px | `0 12px 0 32px` | 4px | 13.5px |
| `#frotaFiltrosBtn` (botão Filtros) | 34px | `0 11px` | 4px | 13px |
| `.v2-dens-btn` (densidade) | 32×32px | — | 0 (quadrado, parte de grupo segmentado) | — |

Todos os controles de altura 34px = `var(--ds-control-h)`; raio 4px = `var(--ds-radius-sm)`.

## KPIs (`#frotaKpis .v2-kpi`)

| Propriedade | Medido | Token |
|---|---|---|
| Rótulo: fonte/peso/cor | 12px / 500 / `--ds-muted` | `--ds-text-xs` / `--ds-weight-medium` |
| Valor: fonte/família | 21px mono | `--ds-text-2xl` / `--mono` |
| Valor: peso | 500 | `--ds-weight-medium` (não é bold — ver nota) |
| Valor: entrelinha | 24.15px (≈1.15×21) | `--ds-leading-tight` |
| Padding do card | `8px 14px` | `--ds-space-4` / 14px |
| Raio do contêiner | 8px | `--ds-radius-lg` |
| Borda do contêiner | `1px solid var(--ds-line)` | |
| Gap entre cards | 1px (cria divisória) | |

## Faixa de alerta (equivalente `.ds-alert` na Frota: `#frotaOficinaAlertas`)

| Propriedade | Medido | Token |
|---|---|---|
| Altura total | **41px** | (referência oficial, ver commit `e98bc11`) |
| Padding | `6px 10px` | `var(--ds-space-3) var(--ds-space-5)` |
| Raio | 8px | `var(--ds-radius-lg)` |
| Botão de ação | 27px de altura (sem `height` fixo, só padding `4px 10px 3px`) | |

## Rodapé / contador de resultados (`#frotaRodape`)

| Propriedade | Medido | Token |
|---|---|---|
| Altura | 26.75px | |
| Fonte | 12.5px / peso 400 | `--ds-text-sm` |
| Cor | `--ds-muted` | |
| Padding | `8px 2px 0` | |

## Sub-abas (`.subtab.active`)

| Propriedade | Medido | Token |
|---|---|---|
| Fonte | 13.5px / peso 600 | `--ds-text-md` / `--ds-weight-semibold` |
| Borda inferior ativa | 2px sólida `--ds-primary` | `--ds-border-tab` |
| Padding | `7px 12px` | |

## Estado vazio (`#vazio`)

| Propriedade | Medido | Nota |
|---|---|---|
| Fonte | 14px / peso 400 | **não bate com nenhum token** (`--ds-text-lg`=15px, `--ds-text-md`=13.5px) — literal legado, não migrado. Baixo impacto visual, registrado mas fora do pacote de correção desta rodada (mensagem simples, sem componente de layout). |
| Padding | `54px 20px` | |

## Modal (veículo — `#modal`, `.modal-confortavel`)

| Propriedade | Medido | Token |
|---|---|---|
| Raio da caixa | 6px | `var(--ds-radius-md)` |
| Largura máx. | 760px | |
| Altura do campo | **40px** | `var(--ds-row-comfortable)` (via `.modal-confortavel`, §11.7 do DESIGN.md) |
| Raio do campo | 4px | `var(--ds-radius-sm)` |
| Padding do campo | `0 12px` | |

---

## Como foi medido

Script Playwright ad hoc (não commitado — análise pontual): sobe `backend/server.js` numa pasta temporária semeada por `scripts/seed-mock.js`, sem login, e coleta `getComputedStyle`/`getBoundingClientRect` dos seletores acima nos dois temas via `localStorage.tema`. Reprodutível com `scripts/screenshots.mjs` (prints) + qualquer script Playwright equivalente para os números — não incluído no repositório por ser específico desta auditoria (os números aqui são o registro permanente).
