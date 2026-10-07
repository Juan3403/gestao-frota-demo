"""Etapa 3b — Gera o dashboard HTML único e autocontido (gráficos SVG inline, sem CDN)."""
import html
import math
from collections import defaultdict

from .comum import HTML_SAIDA, fmt_money, fmt_pct, data_br, DIR_OUTPUT

PALETA = ["#31363e", "#2E6DA4", "#3F9C35", "#E0A800", "#C0504D", "#8064A2",
          "#4BACC6", "#F79646", "#5B9BD5", "#70AD47"]


def _esc(s):
    return html.escape(str(s))


def _donut(dados, tam=260, espessura=42):
    """dados: lista de (rotulo, valor). Retorna SVG de rosca + legenda."""
    total = sum(v for _, v in dados) or 1
    cx = cy = tam / 2
    raio = (tam - espessura) / 2 - 6
    circ = 2 * math.pi * raio
    offset = 0
    arcos = []
    for i, (rot, val) in enumerate(dados):
        frac = val / total
        cor = PALETA[i % len(PALETA)]
        dash = frac * circ
        arcos.append(
            f'<circle cx="{cx}" cy="{cy}" r="{raio}" fill="none" stroke="{cor}" '
            f'stroke-width="{espessura}" stroke-dasharray="{dash:.2f} {circ - dash:.2f}" '
            f'stroke-dashoffset="{-offset:.2f}" transform="rotate(-90 {cx} {cy})"><title>'
            f'{_esc(rot)}: {_esc(fmt_money(val))} ({frac*100:.1f}%)</title></circle>')
        offset += dash
    svg = (f'<svg viewBox="0 0 {tam} {tam}" width="{tam}" height="{tam}" role="img">'
           + "".join(arcos)
           + f'<text x="{cx}" y="{cy-4}" text-anchor="middle" font-size="13" fill="#555">Saldo bruto</text>'
           + f'<text x="{cx}" y="{cy+16}" text-anchor="middle" font-size="15" font-weight="700" fill="#31363e">{_esc(fmt_money(total))}</text>'
           + '</svg>')
    leg = '<ul class="legenda">' + "".join(
        f'<li><span class="bolinha" style="background:{PALETA[i%len(PALETA)]}"></span>'
        f'{_esc(rot)} — <b>{_esc(fmt_money(val))}</b></li>'
        for i, (rot, val) in enumerate(dados)) + '</ul>'
    return f'<div class="donut-wrap">{svg}{leg}</div>'


def _barras_h(dados, larg=420, alt_barra=26):
    """Barras horizontais. dados: lista de (rotulo, valor)."""
    if not dados:
        return "<p>Sem dados.</p>"
    vmax = max(v for _, v in dados) or 1
    alt = len(dados) * (alt_barra + 10) + 10
    larg_rot = 120
    larg_barra = larg - larg_rot - 90
    linhas = []
    for i, (rot, val) in enumerate(dados):
        y = 10 + i * (alt_barra + 10)
        w = (val / vmax) * larg_barra
        cor = PALETA[i % len(PALETA)]
        linhas.append(
            f'<text x="{larg_rot-6}" y="{y+alt_barra/2+4}" text-anchor="end" font-size="12" fill="#333">{_esc(rot)}</text>'
            f'<rect x="{larg_rot}" y="{y}" width="{w:.1f}" height="{alt_barra}" rx="4" fill="{cor}"><title>{_esc(fmt_money(val))}</title></rect>'
            f'<text x="{larg_rot+w+6:.1f}" y="{y+alt_barra/2+4}" font-size="11" fill="#333">{_esc(fmt_money(val))}</text>')
    return f'<svg viewBox="0 0 {larg} {alt}" width="100%" height="{alt}" role="img">' + "".join(linhas) + '</svg>'


def _colunas(dados, larg=420, alt=240):
    """Colunas verticais. dados: lista de (rotulo, valor)."""
    if not dados:
        return "<p>Sem dados.</p>"
    vmax = max(v for _, v in dados) or 1
    pad_b = 40; pad_t = 14; pad_l = 8
    n = len(dados)
    larg_col = (larg - pad_l) / n * 0.6
    passo = (larg - pad_l) / n
    barras = []
    for i, (rot, val) in enumerate(dados):
        h = (val / vmax) * (alt - pad_b - pad_t)
        x = pad_l + i * passo + (passo - larg_col) / 2
        y = alt - pad_b - h
        cor = PALETA[i % len(PALETA)]
        barras.append(
            f'<rect x="{x:.1f}" y="{y:.1f}" width="{larg_col:.1f}" height="{h:.1f}" rx="3" fill="{cor}"><title>{_esc(rot)}: {_esc(fmt_money(val))}</title></rect>'
            f'<text x="{x+larg_col/2:.1f}" y="{alt-pad_b+14}" text-anchor="middle" font-size="11" fill="#333">{_esc(rot)}</text>'
            f'<text x="{x+larg_col/2:.1f}" y="{y-4:.1f}" text-anchor="middle" font-size="10" fill="#555">{val/1000:.0f}k</text>')
    return f'<svg viewBox="0 0 {larg} {alt}" width="100%" height="{alt}" role="img">' + "".join(barras) + '</svg>'


def _linha(serie, larg=860, alt=240):
    """Gráfico de linha. serie: lista de (rotulo, valor)."""
    if len(serie) < 2:
        return "<p>Sem dados suficientes.</p>"
    vmax = max(v for _, v in serie) or 1
    pad_b = 36; pad_t = 14; pad_l = 56; pad_r = 12
    larg_p = larg - pad_l - pad_r
    alt_p = alt - pad_b - pad_t
    n = len(serie)
    pts = []
    for i, (rot, val) in enumerate(serie):
        x = pad_l + (i / (n - 1)) * larg_p
        y = pad_t + (1 - val / vmax) * alt_p
        pts.append((x, y, rot, val))
    poly = " ".join(f"{x:.1f},{y:.1f}" for x, y, _, _ in pts)
    area = f"{pad_l},{pad_t+alt_p} " + poly + f" {pad_l+larg_p},{pad_t+alt_p}"
    circ = "".join(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="3" fill="#31363e"><title>{_esc(rot)}: {_esc(fmt_money(val))}</title></circle>'
                   for x, y, rot, val in pts)
    # rótulos do eixo X (a cada ~n/8)
    passo = max(1, n // 8)
    xlab = "".join(f'<text x="{pts[i][0]:.1f}" y="{alt-pad_b+16}" text-anchor="middle" font-size="10" fill="#666">{_esc(pts[i][2])}</text>'
                   for i in range(0, n, passo))
    # 3 linhas de grade do eixo Y
    grid = ""
    for g in range(4):
        gy = pad_t + alt_p * g / 3
        gv = vmax * (1 - g / 3)
        grid += (f'<line x1="{pad_l}" y1="{gy:.1f}" x2="{pad_l+larg_p}" y2="{gy:.1f}" stroke="#eee"/>'
                 f'<text x="{pad_l-6}" y="{gy+4:.1f}" text-anchor="end" font-size="9" fill="#999">{gv/1e6:.1f}M</text>')
    return (f'<svg viewBox="0 0 {larg} {alt}" width="100%" height="{alt}" role="img">{grid}'
            f'<polygon points="{area}" fill="#31363e" opacity="0.08"/>'
            f'<polyline points="{poly}" fill="none" stroke="#31363e" stroke-width="2"/>{circ}{xlab}</svg>')


def _serie_evolucao(c):
    eventos = defaultdict(float)
    for a in c["posicoes_abertas"]:
        eventos[a["data_aplicacao"][:7]] += a["valor_aplicado"]
    for e in c["encerradas"]:
        if e["data_aplicacao"]:
            eventos[e["data_aplicacao"][:7]] += e["valor_aplicado"] or 0
        if e["data_encerramento"]:
            eventos[e["data_encerramento"][:7]] -= e["valor_aplicado"] or 0
    if not eventos:
        return []
    meses = sorted(eventos)
    y, mth = int(meses[0][:4]), int(meses[0][5:7])
    yf, mf = int(meses[-1][:4]), int(meses[-1][5:7])
    serie = []; acum = 0.0
    while (y, mth) <= (yf, mf):
        acum += eventos.get(f"{y:04d}-{mth:02d}", 0.0)
        serie.append((f"{mth:02d}/{str(y)[2:]}", acum))
        mth += 1
        if mth > 12:
            mth = 1; y += 1
    return serie


def gerar_html(c):
    r = c["resumo"]; meta = c["meta"]
    kpis = [
        ("Total Aplicado", fmt_money(r["total_aplicado"]), "#31363e"),
        ("Saldo Bruto Atual", fmt_money(r["saldo_bruto"]), "#2E6DA4"),
        ("Rendimento Acumulado", fmt_money(r["rendimento_bruto"]), "#3F9C35"),
        ("IR + IOF a Pagar", fmt_money(r["ir_previsto"] + r["iof_previsto"]), "#C0504D"),
        ("Líquido se Resgatar Hoje", fmt_money(r["valor_liquido"]), "#8064A2"),
    ]
    kpi_html = "".join(
        f'<div class="kpi" style="border-top:4px solid {cor}"><div class="kpi-rot">{_esc(rot)}</div>'
        f'<div class="kpi-val">{_esc(val)}</div></div>' for rot, val, cor in kpis)

    dist = [(f"{data_br(a['data_aplicacao'])}", a["saldo_bruto"]) for a in c["posicoes_abertas"]]
    rank = sorted(c["posicoes_abertas"], key=lambda a: a["rendimento_bruto"], reverse=True)
    rank_d = [(data_br(a["data_aplicacao"]), a["rendimento_bruto"]) for a in rank]
    por_mes = defaultdict(float)
    for a in c["posicoes_abertas"]:
        por_mes[a["vencimento"][:7]] += a["valor_aplicado"]
    venc_d = [(f"{ym[5:7]}/{ym[2:4]}", v) for ym, v in sorted(por_mes.items())]
    serie = _serie_evolucao(c)

    # tabela de posições abertas
    linhas_pos = "".join(
        f"<tr><td>{_esc(data_br(a['data_aplicacao']))}</td><td>{_esc(data_br(a['vencimento']))}</td>"
        f"<td class=n>{_esc(fmt_money(a['valor_aplicado']))}</td>"
        f"<td class=n>{_esc(fmt_money(a['rendimento_bruto']))}</td>"
        f"<td class=n>{_esc(fmt_money(a['saldo_bruto']))}</td>"
        f"<td class=n>{_esc(fmt_money(a['ir_previsto']+a['iof_previsto']))}</td>"
        f"<td class=n>{_esc(fmt_money(a['valor_liquido']))}</td>"
        f"<td class=n>{_esc(fmt_pct(a['rentabilidade_pct']))}</td></tr>"
        for a in c["posicoes_abertas"])

    avisos_html = ""
    if meta["avisos"]:
        avisos_html = ('<div class="avisos"><b>⚠️ Avisos:</b><ul>'
                       + "".join(f"<li>{_esc(a)}</li>" for a in meta["avisos"]) + "</ul></div>")

    doc = f"""<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Carteira Renda Fixa — NTE (Banco Inter)</title>
<style>
:root{{--azul:#31363e;--bg:#f4f6f9;--card:#fff;--linha:#e5e9f0;}}
*{{box-sizing:border-box}} body{{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:var(--bg);color:#222}}
header{{background:var(--azul);color:#fff;padding:20px 28px}}
header h1{{margin:0;font-size:20px}} header p{{margin:4px 0 0;opacity:.8;font-size:13px}}
main{{max-width:1180px;margin:0 auto;padding:20px}}
.kpis{{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:14px;margin-bottom:20px}}
.kpi{{background:var(--card);border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}}
.kpi-rot{{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.4px}}
.kpi-val{{font-size:21px;font-weight:700;color:var(--azul);margin-top:6px}}
.grid{{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}}
.card{{background:var(--card);border-radius:10px;padding:16px;box-shadow:0 1px 3px rgba(0,0,0,.08)}}
.card h2{{margin:0 0 12px;font-size:14px;color:var(--azul)}}
.card.full{{grid-column:1/-1}}
.donut-wrap{{display:flex;gap:16px;align-items:center;flex-wrap:wrap}}
.legenda{{list-style:none;margin:0;padding:0;font-size:12.5px;columns:1}}
.legenda li{{margin:3px 0}} .bolinha{{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}}
table{{width:100%;border-collapse:collapse;font-size:12.5px}}
th,td{{padding:7px 9px;border-bottom:1px solid var(--linha);text-align:left}}
th{{background:var(--azul);color:#fff;position:sticky;top:0}} td.n{{text-align:right;font-variant-numeric:tabular-nums}}
tr:nth-child(even) td{{background:#fafbfd}}
.avisos{{background:#fff7e6;border:1px solid #f0c36d;border-radius:8px;padding:12px 16px;font-size:13px;margin-bottom:16px}}
.avisos ul{{margin:6px 0 0;padding-left:18px}}
footer{{text-align:center;color:#888;font-size:11px;padding:16px}}
@media(max-width:760px){{.grid{{grid-template-columns:1fr}}}}
</style></head><body>
<header><h1>Carteira de Renda Fixa — Norte Engenharia (Banco Inter PJ)</h1>
<p>Data-base: {_esc(data_br(meta['data_base']))} · gerado por pipeline a partir de {len(meta['pdfs_movimentacao'])} extratos de movimentação + posição</p></header>
<main>
{avisos_html}
<div class="kpis">{kpi_html}</div>
<div class="grid">
  <div class="card"><h2>Distribuição do saldo bruto por aplicação</h2>{_donut(dist)}</div>
  <div class="card"><h2>Cronograma de vencimentos (mês)</h2>{_colunas(venc_d)}</div>
  <div class="card"><h2>Rendimento bruto por aplicação (ranking)</h2>{_barras_h(rank_d)}</div>
  <div class="card"><h2>Resumo</h2>
    <table><tbody>
    <tr><td>Total aplicado</td><td class=n>{_esc(fmt_money(r['total_aplicado']))}</td></tr>
    <tr><td>Saldo bruto</td><td class=n>{_esc(fmt_money(r['saldo_bruto']))}</td></tr>
    <tr><td>Rendimento bruto acumulado</td><td class=n>{_esc(fmt_money(r['rendimento_bruto']))}</td></tr>
    <tr><td>IR previsto / IOF previsto</td><td class=n>{_esc(fmt_money(r['ir_previsto']))} / {_esc(fmt_money(r['iof_previsto']))}</td></tr>
    <tr><td>Líquido se resgatar hoje</td><td class=n>{_esc(fmt_money(r['valor_liquido']))}</td></tr>
    <tr><td>Rentabilidade média</td><td class=n>{_esc(fmt_pct(r['rentabilidade_media_pct']))}</td></tr>
    <tr><td>IR já pago / IOF já pago</td><td class=n>{_esc(fmt_money(r['ir_pago']))} / {_esc(fmt_money(r['iof_pago']))}</td></tr>
    </tbody></table>
  </div>
</div>
<div class="card full"><h2>Evolução do principal sob gestão</h2>{_linha(serie)}</div>
<div class="card full"><h2>Posições abertas ({len(c['posicoes_abertas'])})</h2>
  <table><thead><tr><th>Aplicação</th><th>Vencimento</th><th>Aplicado</th><th>Rend. bruto</th><th>Saldo bruto</th><th>IR+IOF prev.</th><th>Líquido</th><th>Rentab.</th></tr></thead>
  <tbody>{linhas_pos}</tbody></table>
</div>
</main>
<footer>Banco Inter · CNPJ 018.945.670/0001-46 · documento gerado automaticamente — confira sempre com os extratos oficiais.</footer>
</body></html>"""
    DIR_OUTPUT.mkdir(exist_ok=True)
    with open(HTML_SAIDA, "w", encoding="utf-8") as f:
        f.write(doc)
    return HTML_SAIDA


if __name__ == "__main__":
    import json
    from .comum import JSON_CONSOLIDADO
    gerar_html(json.load(open(JSON_CONSOLIDADO, encoding="utf-8")))
