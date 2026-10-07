"""Etapa 3a — Gera a planilha .xlsx (6 abas) com gráficos nativos do Excel.

As abas de dados alimentam os gráficos da aba Dashboard por REFERÊNCIA de células,
então editar os números atualiza os gráficos sozinho.
"""
from collections import defaultdict
from datetime import date

from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.chart import PieChart, BarChart, LineChart, Reference
from openpyxl.utils import get_column_letter

from .comum import XLSX_SAIDA, FMT_XLSX_MOEDA, FMT_XLSX_PCT, data_br, DIR_OUTPUT

AZUL = "1E3A5F"
AZUL_CLARO = "DCE6F1"
CINZA = "F2F2F2"
VERDE = "2E7D32"
_hdr_font = Font(bold=True, color="FFFFFF")
_hdr_fill = PatternFill("solid", fgColor=AZUL)
_tot_font = Font(bold=True)
_tot_fill = PatternFill("solid", fgColor=AZUL_CLARO)
_thin = Side(style="thin", color="BFBFBF")
_borda = Border(left=_thin, right=_thin, top=_thin, bottom=_thin)


def _cabecalho(ws, titulos, linha=1):
    for c, t in enumerate(titulos, 1):
        cel = ws.cell(row=linha, column=c, value=t)
        cel.font = _hdr_font
        cel.fill = _hdr_fill
        cel.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        cel.border = _borda


def _largura(ws, larguras):
    for i, w in enumerate(larguras, 1):
        ws.column_dimensions[get_column_letter(i)].width = w


def _moeda(cel):
    cel.number_format = FMT_XLSX_MOEDA


def _pct(cel):
    cel.number_format = FMT_XLSX_PCT


def gerar_xlsx(c):
    wb = Workbook()
    _aba_posicoes(wb, c)
    _aba_resumo(wb, c)
    _aba_historico(wb, c)
    _aba_encerradas(wb, c)
    _aba_impostos(wb, c)
    _aba_dashboard(wb, c)
    # remove a sheet padrão vazia
    if "Sheet" in wb.sheetnames:
        del wb["Sheet"]
    DIR_OUTPUT.mkdir(exist_ok=True)
    wb.save(XLSX_SAIDA)
    return XLSX_SAIDA


# ---------------- Aba 1 — Posições Abertas ----------------
def _aba_posicoes(wb, c):
    ws = wb.create_sheet("Posições Abertas")
    cols = ["Banco", "Produto", "Vencimento", "Data de aplicação", "Dias corridos",
            "Valor aplicado", "Rendimento bruto", "Saldo bruto", "Alíquota IR",
            "IR previsto", "IOF previsto", "Valor líquido (resgate hoje)", "Rentabilidade %"]
    _cabecalho(ws, cols)
    _largura(ws, [12, 26, 12, 14, 11, 15, 15, 15, 10, 13, 12, 18, 13])
    r = 2
    for a in c["posicoes_abertas"]:
        ws.cell(r, 1, a["banco"])
        ws.cell(r, 2, a["produto"])
        ws.cell(r, 3, data_br(a["vencimento"]))
        ws.cell(r, 4, data_br(a["data_aplicacao"]))
        ws.cell(r, 5, a["dias_corridos"])
        _moeda(ws.cell(r, 6, a["valor_aplicado"]))
        _moeda(ws.cell(r, 7, a["rendimento_bruto"]))
        _moeda(ws.cell(r, 8, a["saldo_bruto"]))
        ws.cell(r, 9, a["aliquota_ir"]).number_format = FMT_XLSX_PCT
        _moeda(ws.cell(r, 10, a["ir_previsto"]))
        _moeda(ws.cell(r, 11, a["iof_previsto"]))
        _moeda(ws.cell(r, 12, a["valor_liquido"]))
        _pct(ws.cell(r, 13, a["rentabilidade_pct"]))
        r += 1
    # linha de total
    ws.cell(r, 1, "TOTAL").font = _tot_font
    for col in (6, 7, 8, 10, 11, 12):
        cel = ws.cell(r, col, f"=SUM({get_column_letter(col)}2:{get_column_letter(col)}{r-1})")
        _moeda(cel); cel.font = _tot_font; cel.fill = _tot_fill
    for col in range(1, 14):
        cc = ws.cell(r, col); cc.fill = _tot_fill
        if cc.font != _tot_font:
            cc.font = _tot_font
    ws.freeze_panes = "A2"
    ws._n_dados = r - 2  # nº de linhas de dados (uso interno p/ gráficos)
    ws._linha_total = r


# ---------------- Aba 2 — Resumo da Carteira ----------------
def _aba_resumo(wb, c):
    ws = wb.create_sheet("Resumo da Carteira")
    _largura(ws, [34, 20, 4, 16, 16])
    r = c["resumo"]
    ws.cell(1, 1, "RESUMO DA CARTEIRA").font = Font(bold=True, size=14, color=AZUL)
    ws.cell(2, 1, f"Data-base: {data_br(c['meta']['data_base'])}").font = Font(italic=True)
    linhas = [
        ("Total aplicado", r["total_aplicado"], "moeda"),
        ("Saldo bruto atual", r["saldo_bruto"], "moeda"),
        ("Rendimento bruto acumulado", r["rendimento_bruto"], "moeda"),
        ("IR previsto (provisão)", r["ir_previsto"], "moeda"),
        ("IOF previsto (provisão)", r["iof_previsto"], "moeda"),
        ("Total líquido (resgate hoje)", r["valor_liquido"], "moeda"),
        ("Rentabilidade média", r["rentabilidade_media_pct"], "pct"),
    ]
    rr = 4
    for rotulo, valor, tipo in linhas:
        ws.cell(rr, 1, rotulo).font = Font(bold=True)
        cel = ws.cell(rr, 2, valor)
        _moeda(cel) if tipo == "moeda" else _pct(cel)
        ws.cell(rr, 1).fill = PatternFill("solid", fgColor=CINZA)
        rr += 1

    # Quadro: quanto vence por ano
    ws.cell(rr + 1, 1, "Vencimentos por ano (valor aplicado)").font = Font(bold=True, color=AZUL)
    base = rr + 2
    _cabecalho(ws, ["Ano", "Valor aplicado"], base)
    por_ano = defaultdict(float)
    for a in c["posicoes_abertas"]:
        por_ano[a["vencimento"][:4]] += a["valor_aplicado"]
    i = 0
    for ano in sorted(por_ano):
        ws.cell(base + 1 + i, 1, ano)
        _moeda(ws.cell(base + 1 + i, 2, round(por_ano[ano], 2)))
        i += 1
    ws.freeze_panes = "A2"


# ---------------- Aba 3 — Histórico de Movimentações ----------------
def _aba_historico(wb, c):
    ws = wb.create_sheet("Histórico")
    cols = ["Data", "Banco", "Produto", "Vencimento", "Histórico", "Valor", "IR", "IOF", "Saldo após"]
    _cabecalho(ws, cols)
    _largura(ws, [12, 12, 26, 12, 42, 14, 12, 12, 15])
    r = 2
    for h in c["historico"]:
        ws.cell(r, 1, data_br(h["data"]))
        ws.cell(r, 2, h["banco"])
        ws.cell(r, 3, h["produto"])
        ws.cell(r, 4, data_br(h["vencimento"]))
        ws.cell(r, 5, h["historico"])
        _moeda(ws.cell(r, 6, h["valor"]))
        _moeda(ws.cell(r, 7, h["ir"]))
        _moeda(ws.cell(r, 8, h["iof"]))
        _moeda(ws.cell(r, 9, h["saldo"]))
        r += 1
    ws.freeze_panes = "A2"


# ---------------- Aba 4 — Aplicações Encerradas ----------------
def _aba_encerradas(wb, c):
    ws = wb.create_sheet("Encerradas")
    cols = ["Produto", "Vencimento", "Data de aplicação", "Data de encerramento", "Valor aplicado",
            "Rendimento total recebido", "IR total pago", "IOF total pago",
            "Valor líquido recebido", "Rentabilidade líquida %"]
    _cabecalho(ws, cols)
    _largura(ws, [26, 12, 16, 18, 15, 18, 13, 13, 16, 16])
    r = 2
    for e in c["encerradas"]:
        ws.cell(r, 1, e["produto"])
        ws.cell(r, 2, data_br(e["vencimento"]))
        ws.cell(r, 3, data_br(e["data_aplicacao"]))
        ws.cell(r, 4, data_br(e["data_encerramento"]))
        _moeda(ws.cell(r, 5, e["valor_aplicado"]))
        if e.get("incompleto"):
            ws.cell(r, 6, "histórico incompleto").font = Font(italic=True, color="B00020")
            for col in (7, 8, 9, 10):
                ws.cell(r, col, "—")
        else:
            _moeda(ws.cell(r, 6, e["rendimento_total_recebido"]))
            _moeda(ws.cell(r, 7, e["ir_total_pago"]))
            _moeda(ws.cell(r, 8, e["iof_total_pago"]))
            _moeda(ws.cell(r, 9, e["valor_liquido_recebido"]))
            _pct(ws.cell(r, 10, e["rentabilidade_liquida_pct"]))
        r += 1
    ws.freeze_panes = "A2"


# ---------------- Aba 5 — Impostos ----------------
def _aba_impostos(wb, c):
    ws = wb.create_sheet("Impostos")
    _largura(ws, [40, 20])
    r = c["resumo"]
    ws.cell(1, 1, "IMPOSTOS — PAGOS x PROVISÃO A PAGAR").font = Font(bold=True, size=13, color=AZUL)
    blocos = [
        ("JÁ PAGO (retido no histórico)", [
            ("IR retido na fonte (pago)", r["ir_pago"]),
            ("IOF pago", r["iof_pago"]),
            ("Total já pago", round(r["ir_pago"] + r["iof_pago"], 2)),
        ]),
        ("PROVISÃO A PAGAR (posições abertas, se resgatar hoje)", [
            ("IR previsto", r["ir_previsto"]),
            ("IOF previsto", r["iof_previsto"]),
            ("Total provisão a pagar", round(r["ir_previsto"] + r["iof_previsto"], 2)),
        ]),
    ]
    rr = 3
    for titulo, itens in blocos:
        ws.cell(rr, 1, titulo).font = Font(bold=True, color=AZUL)
        rr += 1
        for rotulo, valor in itens:
            ws.cell(rr, 1, rotulo)
            _moeda(ws.cell(rr, 2, valor))
            if rotulo.startswith("Total"):
                ws.cell(rr, 1).font = _tot_font
                ws.cell(rr, 2).font = _tot_font
                ws.cell(rr, 1).fill = _tot_fill
                ws.cell(rr, 2).fill = _tot_fill
            rr += 1
        rr += 1
    ws.cell(rr, 1, "Obs.: 'IR já pago' reflete os resgates registrados nos extratos.").font = Font(italic=True, size=9)
    ws.freeze_panes = "A2"


# ---------------- Aba 6 — Dashboard ----------------
def _aba_dashboard(wb, c):
    ws = wb.create_sheet("Dashboard")
    _largura(ws, [22, 18, 4, 18, 18, 18, 18])
    r = c["resumo"]
    ws.cell(1, 1, "DASHBOARD — CARTEIRA DE RENDA FIXA (Banco Inter)").font = Font(bold=True, size=16, color=AZUL)
    ws.cell(2, 1, f"Data-base: {data_br(c['meta']['data_base'])}").font = Font(italic=True)

    # KPIs
    kpis = [
        ("Total Aplicado", r["total_aplicado"]),
        ("Saldo Bruto Atual", r["saldo_bruto"]),
        ("Rendimento Acumulado", r["rendimento_bruto"]),
        ("IR + IOF a Pagar", round(r["ir_previsto"] + r["iof_previsto"], 2)),
        ("Líquido se Resgatar Hoje", r["valor_liquido"]),
    ]
    col = 1
    for rotulo, valor in kpis:
        t = ws.cell(4, col, rotulo); t.font = Font(bold=True, size=10, color="FFFFFF")
        t.fill = PatternFill("solid", fgColor=AZUL); t.alignment = Alignment(horizontal="center")
        v = ws.cell(5, col, valor); _moeda(v); v.font = Font(bold=True, size=12)
        v.fill = PatternFill("solid", fgColor=AZUL_CLARO); v.alignment = Alignment(horizontal="center")
        col += 1

    # ----- tabelas-fonte dos gráficos (numa área à direita, linhas 30+) -----
    base_r = 30
    # distribuição do saldo bruto por aplicação
    ws.cell(base_r, 1, "Aplicação (venc.)"); ws.cell(base_r, 2, "Saldo bruto")
    i = 1
    for a in c["posicoes_abertas"]:
        ws.cell(base_r + i, 1, f"{data_br(a['data_aplicacao'])}→{data_br(a['vencimento'])}")
        _moeda(ws.cell(base_r + i, 2, a["saldo_bruto"]))
        i += 1
    fim_dist = base_r + i - 1

    # vencimentos por mês/ano
    por_mes = defaultdict(float)
    for a in c["posicoes_abertas"]:
        ym = a["vencimento"][:7]
        por_mes[ym] += a["valor_aplicado"]
    base_v = fim_dist + 3
    ws.cell(base_v, 1, "Mês vencimento"); ws.cell(base_v, 2, "Valor aplicado")
    j = 1
    for ym in sorted(por_mes):
        ws.cell(base_v + j, 1, f"{ym[5:7]}/{ym[:4]}")
        _moeda(ws.cell(base_v + j, 2, round(por_mes[ym], 2)))
        j += 1
    fim_v = base_v + j - 1

    # rendimento bruto por aplicação (ranking)
    rank = sorted(c["posicoes_abertas"], key=lambda a: a["rendimento_bruto"], reverse=True)
    base_rk = fim_v + 3
    ws.cell(base_rk, 1, "Aplicação"); ws.cell(base_rk, 2, "Rendimento bruto")
    k = 1
    for a in rank:
        ws.cell(base_rk + k, 1, data_br(a["data_aplicacao"]))
        _moeda(ws.cell(base_rk + k, 2, a["rendimento_bruto"]))
        k += 1
    fim_rk = base_rk + k - 1

    # evolução do principal sob gestão ao longo do tempo
    serie = _serie_evolucao(c)
    base_e = fim_rk + 3
    ws.cell(base_e, 1, "Mês"); ws.cell(base_e, 2, "Principal ativo")
    m = 1
    for ym, val in serie:
        ws.cell(base_e + m, 1, ym)
        _moeda(ws.cell(base_e + m, 2, round(val, 2)))
        m += 1
    fim_e = base_e + m - 1

    # ----- gráficos nativos ligados às células -----
    # Rosca: distribuição do saldo
    pie = PieChart(); pie.title = "Distribuição do saldo bruto por aplicação"; pie.height = 8; pie.width = 14
    dados = Reference(ws, min_col=2, min_row=base_r, max_row=fim_dist)
    cats = Reference(ws, min_col=1, min_row=base_r + 1, max_row=fim_dist)
    pie.add_data(dados, titles_from_data=True); pie.set_categories(cats)
    try:
        pie.holeSize = 50
    except Exception:
        pass
    ws.add_chart(pie, "A8")

    # Colunas: vencimentos por mês
    barv = BarChart(); barv.type = "col"; barv.title = "Cronograma de vencimentos (mês)"; barv.height = 8; barv.width = 14
    barv.legend = None
    d = Reference(ws, min_col=2, min_row=base_v, max_row=fim_v)
    ct = Reference(ws, min_col=1, min_row=base_v + 1, max_row=fim_v)
    barv.add_data(d, titles_from_data=True); barv.set_categories(ct)
    ws.add_chart(barv, "E8")

    # Barras horizontais: rendimento por aplicação (ranking)
    barh = BarChart(); barh.type = "bar"; barh.title = "Rendimento bruto por aplicação (ranking)"; barh.height = 8; barh.width = 14
    barh.legend = None
    d2 = Reference(ws, min_col=2, min_row=base_rk, max_row=fim_rk)
    ct2 = Reference(ws, min_col=1, min_row=base_rk + 1, max_row=fim_rk)
    barh.add_data(d2, titles_from_data=True); barh.set_categories(ct2)
    ws.add_chart(barh, "A24")

    # Linha: evolução do principal
    line = LineChart(); line.title = "Evolução do principal sob gestão"; line.height = 8; line.width = 14
    line.legend = None
    d3 = Reference(ws, min_col=2, min_row=base_e, max_row=fim_e)
    ct3 = Reference(ws, min_col=1, min_row=base_e + 1, max_row=fim_e)
    line.add_data(d3, titles_from_data=True); line.set_categories(ct3)
    ws.add_chart(line, "E24")

    # move o Dashboard para o início
    wb.move_sheet("Dashboard", -(len(wb.sheetnames) - 1))


def _serie_evolucao(c):
    """Principal ativo (aplicado − encerrado) por mês, das aplicações e resgates totais."""
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
    ini = meses[0]; fim = meses[-1]
    y, mth = int(ini[:4]), int(ini[5:7])
    yf, mf = int(fim[:4]), int(fim[5:7])
    serie = []
    acum = 0.0
    while (y, mth) <= (yf, mf):
        ym = f"{y:04d}-{mth:02d}"
        acum += eventos.get(ym, 0.0)
        serie.append((f"{mth:02d}/{y}", acum))
        mth += 1
        if mth > 12:
            mth = 1; y += 1
    return serie


if __name__ == "__main__":
    import json
    from .comum import JSON_CONSOLIDADO
    gerar_xlsx(json.load(open(JSON_CONSOLIDADO, encoding="utf-8")))
