"""Etapa 1 — Parsing por coordenadas (pdfplumber).

O layout do Inter posiciona as colunas por X; o texto sequencial sai embaralhado.
Por isso agrupamos as palavras por linha (Y) e atribuímos cada palavra a uma coluna
pela sua faixa de X (bandas medidas nos PDFs reais).

Dois leitores:
- parse_movimentacao(pdf): blocos CDB/LCD com cabeçalho + linhas de movimento.
- parse_posicao(pdf): tabela da carteira atual (1 linha por aplicação aberta).
"""
import re
from collections import defaultdict
import pdfplumber

from .comum import sem_acento, parse_num, parse_data, data_iso

# token que é exatamente uma data (e não "Vencimento:30/05/2028")
_DATA_PURA = re.compile(r"\d{2}/\d{2}/\d{4}$")


def _eh_data_pura(txt):
    return bool(txt and _DATA_PURA.fullmatch(txt))

# Bandas de X (limites superiores) por tipo de extrato de movimentação.
# CDB: Data | Histórico | Valor | D/C | Saldo
BANDAS_CDB = [("data", 150), ("historico", 355), ("valor", 425), ("dc", 505), ("saldo", 10_000)]
# LCD: Data | Histórico | Valor | IOF | IR | Saldo
BANDAS_LCD = [("data", 150), ("historico", 270), ("valor", 365), ("iof", 435), ("ir", 502), ("saldo", 10_000)]


def _linhas(pagina, tol=3):
    """Agrupa as palavras da página em linhas (por Y), ordenadas por X dentro da linha."""
    grupos = defaultdict(list)
    for w in pagina.extract_words(use_text_flow=False, keep_blank_chars=False):
        chave = round(w["top"] / tol)
        grupos[chave].append(w)
    linhas = []
    for chave in sorted(grupos):
        ws = sorted(grupos[chave], key=lambda w: w["x0"])
        linhas.append(ws)
    return linhas


def _coluna(x0, bandas):
    for nome, limite in bandas:
        if x0 < limite:
            return nome
    return bandas[-1][0]


def _por_coluna(ws, bandas):
    cols = defaultdict(list)
    for w in ws:
        cols[_coluna(w["x0"], bandas)].append(w["text"])
    return {k: " ".join(v) for k, v in cols.items()}


def _texto_linha(ws):
    return " ".join(w["text"] for w in ws)


def _periodo(texto):
    m = re.search(r"Per[ií]odo de:\s*(\d{2}/\d{2}/\d{4})\s*a\s*(\d{2}/\d{2}/\d{4})", texto)
    if m:
        return parse_data(m.group(1)), parse_data(m.group(2))
    return None, None


def _emissao(texto):
    m = re.search(r"Emiss[aã]o:\s*(\d{2}/\d{2}/\d{4})", texto)
    return parse_data(m.group(1)) if m else None


def _categoria(historico):
    """Classifica o histórico numa categoria canônica."""
    h = sem_acento(historico)
    if h.startswith("aplica"):
        return "aplicacao"
    if "rendimento ate esta data" in h:
        return "rendimento"
    if h.startswith("resgate"):
        return "resgate"
    if "imposto de renda retido" in h:
        return "ir_retido"
    if h.startswith("iof") or "i.o.f. retido" in h or "iof retido" in h:
        return "iof_retido"
    if "i.o.f" in h and ("isento apos 30 dias" in h or "ate esta data" in h):
        return "previsao_iof"  # "Previsão para I.O.F." (rótulo às vezes quebra de linha)
    if "previsao de i.r" in h or ("i.r." in h and "resgate total" in h):
        return "previsao_ir"
    if "saldo ate esta data" in h:
        return "saldo_ate"
    if "saldo inicial" in h:
        return "saldo_inicial"
    if "saldo final" in h:
        return "saldo_final"
    return "outro"


def _eh_inicio_bloco(texto):
    t = sem_acento(texto)
    if t.startswith("cdb di liquidez") or t.startswith("cdb liquidez"):
        return "CDB DI LIQUIDEZ DIÁRIA PJ"
    if t.startswith("lcd di flut"):
        return "LCD DI FLUT TB"
    return None


def _eh_cabecalho_colunas(texto):
    t = sem_acento(texto)
    return "historico" in t and "saldo" in t and "valor" in t


def parse_movimentacao(caminho):
    """Lê um extrato de MOVIMENTAÇÃO. Retorna dict com período e lista de blocos."""
    blocos = []
    with pdfplumber.open(caminho) as pdf:
        texto_todo = "\n".join((p.extract_text() or "") for p in pdf.pages)
        per_ini, per_fim = _periodo(texto_todo)
        emissao = _emissao(texto_todo)

        # Junta todas as linhas de todas as páginas, em ordem.
        todas = []
        for pagina in pdf.pages:
            todas.extend(_linhas(pagina))

        bloco = None
        bandas = BANDAS_CDB
        coletando_cabecalho = False
        buf_cabecalho = []

        def fechar():
            nonlocal bloco
            if bloco is not None:
                blocos.append(bloco)
            bloco = None

        for ws in todas:
            texto = _texto_linha(ws)
            produto = _eh_inicio_bloco(texto)
            if produto:
                fechar()
                tipo = "LCD" if produto.startswith("LCD") else "CDB"
                bandas = BANDAS_LCD if tipo == "LCD" else BANDAS_CDB
                bloco = {
                    "tipo": tipo, "produto": produto,
                    "vencimento": None, "data_aplicacao": None,
                    "valor_aplicado": None, "taxa": None, "linhas": [],
                }
                coletando_cabecalho = True
                buf_cabecalho = [texto]
                # o nome do produto pode vir junto com o cabeçalho na mesma linha
                _extrai_cabecalho(bloco, " ".join(buf_cabecalho))
                continue

            if bloco is None:
                continue

            if coletando_cabecalho:
                if _eh_cabecalho_colunas(texto):
                    coletando_cabecalho = False  # acabou o cabeçalho; começam as linhas
                    continue
                buf_cabecalho.append(texto)
                _extrai_cabecalho(bloco, " ".join(buf_cabecalho))
                # se a linha já é uma linha de movimento (começa com data pura), processa
                if not _eh_data_pura(ws[0]["text"]):
                    continue
                coletando_cabecalho = False

            # Linha de movimento: precisa começar por uma DATA PURA na 1ª coluna
            if not (ws and _eh_data_pura(ws[0]["text"]) and ws[0]["x0"] < 150):
                continue
            cols = _por_coluna(ws, bandas)
            linha = {
                "data": data_iso(parse_data(cols.get("data"))),
                "historico": cols.get("historico", "").strip(),
                "valor": parse_num(cols.get("valor")),
                "dc": cols.get("dc", "").strip() or None,
                "saldo": parse_num(cols.get("saldo")),
            }
            if bloco["tipo"] == "LCD":
                linha["iof"] = parse_num(cols.get("iof"))
                linha["ir"] = parse_num(cols.get("ir"))
            else:
                linha["iof"] = None
                linha["ir"] = None
            linha["categoria"] = _categoria(linha["historico"])
            bloco["linhas"].append(linha)
        fechar()

    return {
        "arquivo": str(caminho).split("/")[-1].split("\\")[-1],
        "periodo_ini": data_iso(per_ini),
        "periodo_fim": data_iso(per_fim),
        "emissao": data_iso(emissao),
        "blocos": blocos,
    }


def _extrai_cabecalho(bloco, texto):
    m = re.search(r"Vencimento:?\s*(\d{2}/\d{2}/\d{4})", texto)
    if m and not bloco["vencimento"]:
        bloco["vencimento"] = data_iso(parse_data(m.group(1)))
    m = re.search(r"Data aplica[cç][aã]o:?\s*(\d{2}/\d{2}/\d{4})", texto)
    if m and not bloco["data_aplicacao"]:
        bloco["data_aplicacao"] = data_iso(parse_data(m.group(1)))
    m = re.search(r"Valor:\s*R\$\s*([\d.]+,\d{2})", texto)
    if m and bloco["valor_aplicado"] is None:
        bloco["valor_aplicado"] = parse_num(m.group(1))
    m = re.search(r"Taxa:\s*([\d.]+)", texto)
    if m and bloco["taxa"] is None:
        bloco["taxa"] = m.group(1)


# Bandas da tabela do extrato de POSIÇÃO (limites superiores de X).
BANDAS_POS = [
    ("nota", 60), ("data_inicio", 105), ("vencimento", 145), ("valor_aplicado", 195),
    ("tipo", 225), ("taxa", 275), ("rendimento", 318), ("retirada", 360),
    ("desconto", 400), ("bruto", 445), ("previsao_desconto", 485), ("liquido", 535),
    ("aliquota", 10_000),
]


def parse_posicao(caminho):
    """Lê o extrato de POSIÇÃO (carteira atual). Retorna posição-base + lista de aplicações abertas."""
    posicoes = []
    posicao_em = None
    totais = {}
    with pdfplumber.open(caminho) as pdf:
        texto_todo = "\n".join((p.extract_text() or "") for p in pdf.pages)
        m = re.search(r"Posi[cç][aã]o em:\s*(\d{2}/\d{2}/\d{4})", texto_todo)
        if m:
            posicao_em = data_iso(parse_data(m.group(1)))
        for chave, rotulo in (("bruto", r"Valor Bruto Total:\s*R\$\s*([\d.]+,\d{2})"),
                              ("liquido", r"Valor L[ií]quido Total:\s*R\$\s*([\d.]+,\d{2})"),
                              ("aplicado", r"Valor Aplicado Total:\s*R\$\s*([\d.]+,\d{2})")):
            mm = re.search(rotulo, texto_todo)
            if mm:
                totais[chave] = parse_num(mm.group(1))

        for pagina in pdf.pages:
            for ws in _linhas(pagina):
                # linha de dados começa por uma "Nota" de 6+ dígitos
                if not (ws and re.fullmatch(r"\d{6,}", ws[0]["text"])):
                    continue
                cols = _por_coluna(ws, BANDAS_POS)
                m_aliq = re.search(r"([\d.,]+)\s*%", cols.get("aliquota", ""))
                posicoes.append({
                    "nota": ws[0]["text"],
                    "data_aplicacao": data_iso(parse_data(cols.get("data_inicio"))),
                    "vencimento": data_iso(parse_data(cols.get("vencimento"))),
                    "valor_aplicado": parse_num(cols.get("valor_aplicado")),
                    "tipo": "CDB",
                    "produto": "CDB DI LIQUIDEZ DIÁRIA PJ",
                    "taxa": cols.get("taxa", "").strip(),
                    "rendimento_bruto": parse_num(cols.get("rendimento")) or 0.0,
                    "retirada": parse_num(cols.get("retirada")) or 0.0,
                    "desconto_pago": parse_num(cols.get("desconto")) or 0.0,
                    "saldo_bruto": parse_num(cols.get("bruto")),
                    "previsao_desconto": parse_num(cols.get("previsao_desconto")) or 0.0,
                    "valor_liquido": parse_num(cols.get("liquido")),
                    "aliquota_ir": (float(m_aliq.group(1).replace(".", "").replace(",", ".")) / 100.0) if m_aliq else None,
                })
    return {
        "arquivo": str(caminho).split("/")[-1].split("\\")[-1],
        "posicao_em": posicao_em,
        "totais": totais,
        "posicoes": posicoes,
    }
