"""Helpers comuns: parsing de número/data BR, normalização de texto, tabelas de IR/IOF."""
import re
import unicodedata
from datetime import date, datetime

# ----- Pastas (relativas à raiz do projeto) -----
from pathlib import Path
RAIZ = Path(__file__).resolve().parent.parent
DIR_EXTRATOS = RAIZ / "extratos"
DIR_OUTPUT = RAIZ / "output"
JSON_CONSOLIDADO = DIR_OUTPUT / "dados_consolidados.json"
XLSX_SAIDA = DIR_OUTPUT / "controle_investimentos.xlsx"
HTML_SAIDA = DIR_OUTPUT / "dashboard.html"


def sem_acento(s):
    """Remove acentos e baixa caixa — para casar rótulos de forma robusta."""
    if not s:
        return ""
    nfkd = unicodedata.normalize("NFKD", str(s))
    return "".join(c for c in nfkd if not unicodedata.combining(c)).lower().strip()


_NUM_RE = re.compile(r"-?\d{1,3}(?:\.\d{3})*,\d{2}|-?\d+,\d{2}")


def parse_num(txt):
    """'R$ 1.006.608,88' -> 1006608.88 ; retorna None se não houver número."""
    if txt is None:
        return None
    m = _NUM_RE.search(str(txt))
    if not m:
        return None
    return float(m.group(0).replace(".", "").replace(",", "."))


_DATA_RE = re.compile(r"(\d{2})/(\d{2})/(\d{4})")


def parse_data(txt):
    """'29/06/2026' -> date(2026,6,29) ; None se não casar."""
    if txt is None:
        return None
    m = _DATA_RE.search(str(txt))
    if not m:
        return None
    d, mth, y = (int(x) for x in m.groups())
    try:
        return date(y, mth, d)
    except ValueError:
        return None


def data_iso(d):
    return d.isoformat() if isinstance(d, date) else None


def data_br(d):
    if isinstance(d, str):
        d = date.fromisoformat(d)
    return d.strftime("%d/%m/%Y") if isinstance(d, date) else ""


def hoje_iso():
    return datetime.now().date().isoformat()


# ----- Tabela regressiva de IR (renda fixa) — só para conferência / quando o PDF não traz -----
def aliquota_ir(dias):
    """Alíquota de IR por dias corridos entre aplicação e resgate."""
    if dias <= 180:
        return 0.225
    if dias <= 360:
        return 0.20
    if dias <= 720:
        return 0.175
    return 0.15


def aliquota_ir_rotulo(dias):
    return f"{aliquota_ir(dias) * 100:.1f}%".replace(".", ",")


# ----- IOF regressivo (resgate < 30 dias). Só conferência: o extrato traz o valor real. -----
_IOF_TABELA = [96, 93, 90, 86, 83, 80, 76, 73, 70, 66, 63, 60, 56, 53, 50,
               46, 43, 40, 36, 33, 30, 26, 23, 20, 16, 13, 10, 6, 3, 0]


def fator_iof(dias):
    """Fração do rendimento tomada pelo IOF se resgatar em `dias` (<30); 0 a partir de 30."""
    if dias < 1:
        return 1.0
    if dias >= 30:
        return 0.0
    return _IOF_TABELA[dias - 1] / 100.0


# ----- Formatação BR para exibição -----
def fmt_money(v):
    if v is None:
        return ""
    s = f"{abs(v):,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")
    return ("-" if v < 0 else "") + "R$ " + s


def fmt_pct(v, casas=2):
    if v is None:
        return ""
    return f"{v * 100:.{casas}f}%".replace(".", ",")


# Formato de número para células do Excel (separador de milhar BR + R$)
FMT_XLSX_MOEDA = 'R$ #,##0.00'
FMT_XLSX_PCT = '0.00%'
