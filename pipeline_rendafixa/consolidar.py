"""Etapa 2 — Consolidação auditável.

- Dedup das aplicações pela chave Tipo + Data aplicação + Vencimento + Valor aplicado (CDB).
  (LCD não traz data/valor de aplicação no cabeçalho — é agrupado por Vencimento.)
- Dedup do histórico de movimentações (linhas repetidas entre extratos sobrepostos).
- Posições abertas vêm do extrato de POSIÇÃO (carteira em <data-base>), enriquecidas com a
  separação IR/IOF previsto lida das linhas DEFINITIVO da movimentação mais recente.
- Aplicações encerradas (saldo zerou) calculadas pela identidade de caixa.

Gera o dicionário consolidado e grava ./output/dados_consolidados.json.
"""
import json
from datetime import date
from pathlib import Path

from . import parse
from .comum import (DIR_EXTRATOS, JSON_CONSOLIDADO, DIR_OUTPUT, aliquota_ir_rotulo,
                    data_iso, hoje_iso)

# categorias que representam movimentação real (entram no histórico — Aba 3)
CATS_MOV = {"aplicacao", "rendimento", "resgate", "ir_retido", "iof_retido"}


def _chave_cdb(tipo, data_aplicacao, vencimento, valor):
    return f"{tipo}|{data_aplicacao}|{vencimento}|{round(valor or 0, 2)}"


def _d(s):
    return date.fromisoformat(s) if s else None


def _br(iso):
    d = _d(iso)
    return d.strftime("%d/%m/%Y") if d else (iso or "?")


def _buracos_periodo(movs):
    """Detecta intervalos NÃO cobertos pelos extratos de movimentação (períodos sobrepostos
    são unidos). Retorna lista de (ini_iso, fim_iso) faltantes."""
    from datetime import timedelta
    periodos = sorted((m["periodo_ini"], m["periodo_fim"]) for m in movs
                      if m.get("periodo_ini") and m.get("periodo_fim"))
    buracos, max_fim = [], None
    for ini, fim in periodos:
        di, df = _d(ini), _d(fim)
        if max_fim is not None and di > max_fim + timedelta(days=1):
            buracos.append(((max_fim + timedelta(days=1)).isoformat(), (di - timedelta(days=1)).isoformat()))
        if max_fim is None or df > max_fim:
            max_fim = df
    return buracos


def consolidar(dir_extratos=None, dir_output=None, gravar_json=True):
    dir_extratos = Path(dir_extratos) if dir_extratos else DIR_EXTRATOS
    dir_output = Path(dir_output) if dir_output else DIR_OUTPUT
    json_consolidado = dir_output / JSON_CONSOLIDADO.name
    pdfs = sorted(dir_extratos.glob("*.pdf"))
    avisos = []  # mensagens de atenção mostradas ao final (guard-rails)
    movs, posicoes_pdf = [], []
    for p in pdfs:
        # extrato de POSIÇÃO x MOVIMENTAÇÃO pelo nome
        if "posicao" in p.name.lower() or "posição" in p.name.lower():
            posicoes_pdf.append(parse.parse_posicao(p))
        else:
            movs.append(parse.parse_movimentacao(p))

    # Guard-rail 1: se houver MAIS DE UM extrato de posição, usa o de data mais nova
    # (não o primeiro alfabético) e avisa — evita carteira desatualizada sem perceber.
    posicao = None
    if posicoes_pdf:
        posicoes_pdf.sort(key=lambda x: (x.get("posicao_em") or ""))
        posicao = posicoes_pdf[-1]
        if len(posicoes_pdf) > 1:
            usados = ", ".join(f"{x['arquivo']} (em {x.get('posicao_em') or '?'})" for x in posicoes_pdf)
            avisos.append(f"Há {len(posicoes_pdf)} extratos de POSIÇÃO na pasta — usei o mais recente "
                          f"({posicao['arquivo']}, posição em {posicao.get('posicao_em')}). Deixe só o mais novo. "
                          f"Encontrados: {usados}.")

    # ordena movimentações por fim de período (mais antigo -> mais recente)
    movs.sort(key=lambda m: (m["periodo_fim"] or ""))

    # data-base = posição (se houver) senão o fim de período mais recente
    if posicao and posicao.get("posicao_em"):
        data_base = posicao["posicao_em"]
    else:
        data_base = movs[-1]["periodo_fim"] if movs else hoje_iso()
        if not posicao:
            avisos.append("Nenhum extrato de POSIÇÃO na pasta — sem ele as posições abertas não são "
                          "calculadas. Baixe o 'extrato-posicao-renda-fixa.pdf' e coloque em extratos/.")

    # Guard-rail 2: buracos de período entre os extratos de movimentação
    for ini, fim in _buracos_periodo(movs):
        avisos.append(f"Buraco de período sem extrato: {_br(ini)} a {_br(fim)} — baixe o extrato "
                      f"de movimentação desse intervalo (senão o histórico/encerradas ficam incompletos).")

    # Guard-rail 3: posição mais antiga que o último movimento (esqueceu de atualizar a posição?)
    if posicao and posicao.get("posicao_em") and movs:
        ult_mov = movs[-1]["periodo_fim"]
        if ult_mov and posicao["posicao_em"] < ult_mov:
            avisos.append(f"O extrato de POSIÇÃO é de {_br(posicao['posicao_em'])}, mas há movimentação até "
                          f"{_br(ult_mov)}. Atualize o extrato de posição para a data mais recente.")

    # ---------- aplicações únicas + histórico dedup ----------
    aplicacoes = {}            # chave -> info da aplicação (com bloco mais recente)
    hist_visto = set()
    historico = []
    n_blocos = 0
    n_linhas_mov_total = 0

    for m in movs:
        for b in m["blocos"]:
            n_blocos += 1
            if b["tipo"] == "CDB":
                chave = _chave_cdb(b["tipo"], b["data_aplicacao"], b["vencimento"], b["valor_aplicado"])
            else:  # LCD: agrupa por vencimento (cabeçalho não traz data/valor de aplicação)
                chave = f"LCD|{b['vencimento']}"
            # guarda/atualiza a aplicação com o bloco do extrato MAIS RECENTE
            ap = aplicacoes.get(chave)
            if ap is None or (m["periodo_fim"] or "") >= (ap["_periodo_fim"] or ""):
                aplicacoes[chave] = {
                    "chave": chave, "tipo": b["tipo"], "produto": b["produto"],
                    "data_aplicacao": b["data_aplicacao"], "vencimento": b["vencimento"],
                    "valor_aplicado": b["valor_aplicado"],
                    "_periodo_fim": m["periodo_fim"], "_arquivo": m["arquivo"],
                    "_bloco": b,
                }
            # histórico: só categorias de movimentação, dedup entre extratos sobrepostos
            for ln in b["linhas"]:
                if ln["categoria"] not in CATS_MOV:
                    continue
                n_linhas_mov_total += 1
                kh = (b["produto"], b["data_aplicacao"], b["vencimento"], ln["data"],
                      ln["categoria"], ln["valor"], ln["saldo"])
                if kh in hist_visto:
                    continue
                hist_visto.add(kh)
                historico.append({
                    "data": ln["data"], "banco": "Banco Inter", "produto": b["produto"],
                    "vencimento": b["vencimento"], "historico": ln["historico"],
                    "categoria": ln["categoria"], "valor": ln["valor"],
                    "ir": (ln["valor"] if ln["categoria"] == "ir_retido" else ln.get("ir")),
                    "iof": (ln["valor"] if ln["categoria"] == "iof_retido" else ln.get("iof")),
                    "saldo": ln["saldo"], "origem": m["arquivo"],
                })

    historico.sort(key=lambda h: (h["data"] or "", h["produto"], h["vencimento"] or ""))

    # ---------- posições abertas (fonte: extrato de POSIÇÃO) ----------
    abertas = []
    chaves_abertas = set()
    if posicao:
        for p in posicao["posicoes"]:
            chave = _chave_cdb("CDB", p["data_aplicacao"], p["vencimento"], p["valor_aplicado"])
            chaves_abertas.add(chave)
            dias = (_d(data_base) - _d(p["data_aplicacao"])).days if p["data_aplicacao"] else None
            # separa IR/IOF previsto pelas linhas DEFINITIVO da movimentação mais recente
            ir_prev, iof_prev = _previstos_da_mov(aplicacoes.get(chave))
            if ir_prev is None:  # sem dado na movimentação: usa o total do extrato de posição
                ir_prev, iof_prev = p["previsao_desconto"], 0.0
            soma_prev = round((ir_prev or 0) + (iof_prev or 0), 2)
            if abs(soma_prev - round(p["previsao_desconto"], 2)) > 1.0:
                avisos.append(
                    f"IR+IOF previsto da movimentação (R$ {soma_prev:.2f}) difere da Previsão de "
                    f"Desconto da posição (R$ {p['previsao_desconto']:.2f}) para a Nota {p['nota']}.")
            abertas.append({
                "nota": p["nota"], "banco": "Banco Inter", "produto": p["produto"],
                "vencimento": p["vencimento"], "data_aplicacao": p["data_aplicacao"],
                "dias_corridos": dias, "valor_aplicado": p["valor_aplicado"],
                "rendimento_bruto": p["rendimento_bruto"], "saldo_bruto": p["saldo_bruto"],
                "aliquota_ir": p["aliquota_ir"], "aliquota_ir_rotulo": aliquota_ir_rotulo(dias) if dias is not None else "",
                "ir_previsto": round(ir_prev or 0, 2), "iof_previsto": round(iof_prev or 0, 2),
                "valor_liquido": p["valor_liquido"],
                "rentabilidade_pct": (p["rendimento_bruto"] / p["valor_aplicado"]) if p["valor_aplicado"] else 0.0,
            })

    # confere soma da Aba 1 com o total bruto do extrato de posição
    soma_bruto = round(sum(a["saldo_bruto"] for a in abertas), 2)
    if posicao and posicao["totais"].get("bruto") is not None:
        if abs(soma_bruto - round(posicao["totais"]["bruto"], 2)) > 1.0:
            avisos.append(f"Soma do saldo bruto da Aba 1 (R$ {soma_bruto:.2f}) não bate com o "
                          f"Valor Bruto Total do extrato de posição (R$ {posicao['totais']['bruto']:.2f}).")

    # ---------- aplicações encerradas (saldo zerou e não está aberta) ----------
    encerradas = []
    for chave, ap in aplicacoes.items():
        if chave in chaves_abertas:
            continue
        enc = _encerrada(ap, aplicacoes_movs=movs)
        if enc:
            encerradas.append(enc)
            if enc.get("incompleto"):
                avisos.append(
                    f"Encerrada {enc['produto']} (apl {enc['data_aplicacao']}, venc {enc['vencimento']}): "
                    f"histórico incompleto (movimentações no período sem extrato) — rendimento/IR não confiáveis, "
                    f"deixados em branco.")
        else:
            # apareceu, saldo não zerou e não está na posição -> avisar (pode ter sido resgatada no buraco jan-fev/2026)
            ult = _ultimo_saldo(ap)
            if ult and ult > 1.0:
                avisos.append(f"Aplicação {ap['produto']} venc {ap['vencimento']} (apl {ap['data_aplicacao']}) "
                              f"sumiu dos extratos com saldo R$ {ult:.2f} > 0 e não está na posição atual — conferir.")
    encerradas.sort(key=lambda e: (e["data_encerramento"] or ""))

    # ---------- impostos ----------
    ir_pago = round(sum(h["valor"] for h in historico if h["categoria"] == "ir_retido"), 2)
    iof_pago = round(sum(h["valor"] for h in historico if h["categoria"] == "iof_retido"), 2)
    ir_previsto_total = round(sum(a["ir_previsto"] for a in abertas), 2)
    iof_previsto_total = round(sum(a["iof_previsto"] for a in abertas), 2)

    consolidado = {
        "meta": {
            "gerado_em": hoje_iso(),
            "data_base": data_base,
            "fonte_posicao": posicao["arquivo"] if posicao else None,
            "pdfs_movimentacao": [m["arquivo"] for m in movs],
            "contagens": {
                "pdfs_total": len(pdfs),
                "pdfs_movimentacao": len(movs),
                "blocos_movimentacao": n_blocos,
                "aplicacoes_unicas": len(aplicacoes),
                "posicoes_abertas": len(abertas),
                "encerradas": len(encerradas),
                "linhas_hist_total": n_linhas_mov_total,
                "linhas_hist_dedup": len(historico),
                "linhas_duplicadas_descartadas": n_linhas_mov_total - len(historico),
            },
            "avisos": avisos,
        },
        "resumo": {
            "total_aplicado": round(sum(a["valor_aplicado"] for a in abertas), 2),
            "saldo_bruto": soma_bruto,
            "rendimento_bruto": round(sum(a["rendimento_bruto"] for a in abertas), 2),
            "ir_previsto": ir_previsto_total,
            "iof_previsto": iof_previsto_total,
            "valor_liquido": round(sum(a["valor_liquido"] for a in abertas), 2),
            "rentabilidade_media_pct": (
                round(sum(a["rendimento_bruto"] for a in abertas) / sum(a["valor_aplicado"] for a in abertas), 6)
                if abertas else 0.0),
            "ir_pago": ir_pago, "iof_pago": iof_pago,
        },
        "posicoes_abertas": abertas,
        "encerradas": encerradas,
        "historico": historico,
        "totais_posicao_extrato": posicao["totais"] if posicao else {},
    }

    if gravar_json:
        dir_output.mkdir(parents=True, exist_ok=True)
        # remove campos internos (com _) antes de gravar
        with open(json_consolidado, "w", encoding="utf-8") as f:
            json.dump(consolidado, f, ensure_ascii=False, indent=2)
    return consolidado


def _previstos_da_mov(ap):
    """Lê IR e IOF previstos das linhas DEFINITIVO (Previsão...) do bloco mais recente."""
    if not ap or "_bloco" not in ap:
        return None, None
    ir = iof = None
    for ln in ap["_bloco"]["linhas"]:
        if ln["categoria"] == "previsao_ir":
            ir = ln["valor"]
        elif ln["categoria"] == "previsao_iof":
            iof = ln["valor"]
    if ir is None and iof is None:
        return None, None
    return (ir or 0.0), (iof or 0.0)


def _ultimo_saldo(ap):
    linhas = ap["_bloco"]["linhas"]
    return linhas[-1]["saldo"] if linhas else None


def _todas_linhas_da_aplicacao(ap, movs):
    """Junta (dedup) todas as linhas de TODOS os extratos para esta aplicação."""
    chave = ap["chave"]
    vistos = set()
    linhas = []
    for m in movs:
        for b in m["blocos"]:
            if b["tipo"] == "CDB":
                ck = _chave_cdb(b["tipo"], b["data_aplicacao"], b["vencimento"], b["valor_aplicado"])
            else:
                ck = f"LCD|{b['vencimento']}"
            if ck != chave:
                continue
            for ln in b["linhas"]:
                k = (ln["data"], ln["categoria"], ln["valor"], ln["saldo"])
                if k in vistos:
                    continue
                vistos.add(k)
                linhas.append(ln)
    linhas.sort(key=lambda l: (l["data"] or ""))
    return linhas


def _encerrada(ap, aplicacoes_movs):
    """Se o saldo chegou a ~0, devolve o resumo da aplicação encerrada; senão None."""
    linhas = _todas_linhas_da_aplicacao(ap, aplicacoes_movs)
    if not linhas:
        return None
    # data de encerramento = última linha com saldo ~0
    enc = [l for l in linhas if (l["saldo"] is not None and abs(l["saldo"]) < 0.5)]
    if not enc:
        return None
    data_encerramento = enc[-1]["data"]

    principal = ap["valor_aplicado"]
    if principal is None:  # LCD: soma das aplicações
        principal = round(sum(l["valor"] or 0 for l in linhas if l["categoria"] == "aplicacao"), 2)
    soma_resgate = round(sum(l["valor"] or 0 for l in linhas if l["categoria"] == "resgate"), 2)
    ir_total = round(sum((l["valor"] or 0) for l in linhas if l["categoria"] == "ir_retido")
                     + sum((l["ir"] or 0) for l in linhas if l["categoria"] in ("resgate", "saldo_final")), 2)
    iof_total = round(sum((l["valor"] or 0) for l in linhas if l["categoria"] == "iof_retido")
                      + sum((l["iof"] or 0) for l in linhas if l["categoria"] in ("resgate", "saldo_final")), 2)
    # identidade de caixa: líquido recebido = soma dos resgates; rendimento bruto = resgates+IR+IOF-principal
    liquido_recebido = soma_resgate
    rendimento_bruto = round(soma_resgate + ir_total + iof_total - (principal or 0), 2)
    rendimento_liquido = round(liquido_recebido - (principal or 0), 2)
    primeira_apl = next((l["data"] for l in linhas if l["categoria"] == "aplicacao"), ap["data_aplicacao"])
    # Rendimento bruto negativo é impossível num CDB/LCD → sinal de que faltam movimentações
    # (período sem extrato). Marca como incompleto e não reporta números não confiáveis.
    incompleto = rendimento_bruto < -0.5
    base = {
        "produto": ap["produto"], "vencimento": ap["vencimento"],
        "data_aplicacao": ap["data_aplicacao"] or primeira_apl,
        "data_encerramento": data_encerramento, "valor_aplicado": principal,
        "incompleto": incompleto,
    }
    if incompleto:
        base.update({
            "rendimento_total_recebido": None, "ir_total_pago": None, "iof_total_pago": None,
            "valor_liquido_recebido": None, "rentabilidade_liquida_pct": None,
        })
    else:
        base.update({
            "rendimento_total_recebido": rendimento_bruto, "ir_total_pago": ir_total,
            "iof_total_pago": iof_total, "valor_liquido_recebido": liquido_recebido,
            "rentabilidade_liquida_pct": (rendimento_liquido / principal) if principal else 0.0,
        })
    return base


if __name__ == "__main__":
    consolidar()
