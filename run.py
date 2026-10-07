#!/usr/bin/env python
"""Pipeline de renda fixa (Banco Inter PJ - NTE) — ponto de entrada.

Uso:  python run.py
      Lê todos os PDFs de ./extratos/, consolida e gera ./output/ (.json, .xlsx, .html).

Reexecutável: a cada mês, adicione os novos PDFs em ./extratos/ e rode de novo.
"""
import sys
import io

# saída UTF-8 no Windows (acentos no terminal)
try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

from pipeline_rendafixa import consolidar, gerar_xlsx, gerar_html
from pipeline_rendafixa.comum import fmt_money, fmt_pct, data_br, JSON_CONSOLIDADO


def main():
    print("=" * 72)
    print("PIPELINE RENDA FIXA — Banco Inter PJ (Norte Engenharia)")
    print("=" * 72)

    print("\n[1/3] Lendo e consolidando extratos...")
    c = consolidar.consolidar()
    m = c["meta"]; cont = m["contagens"]; r = c["resumo"]

    print(f"  PDFs lidos: {cont['pdfs_total']} "
          f"({cont['pdfs_movimentacao']} de movimentação + posição)")
    print(f"  Blocos lidos: {cont['blocos_movimentacao']}")
    print(f"  Aplicações únicas: {cont['aplicacoes_unicas']} "
          f"(abertas: {cont['posicoes_abertas']} | encerradas: {cont['encerradas']})")
    print(f"  Histórico: {cont['linhas_hist_total']} linhas → {cont['linhas_hist_dedup']} "
          f"após dedup  | DUPLICADAS descartadas: {cont['linhas_duplicadas_descartadas']}")
    print(f"  Data-base: {data_br(m['data_base'])}")

    print("\n  --- APLICAÇÕES ABERTAS (conferência) ---")
    print(f"  {'Aplicação':<12}{'Vencimento':<12}{'Valor aplicado':>17}{'Saldo bruto':>17}")
    for a in c["posicoes_abertas"]:
        print(f"  {data_br(a['data_aplicacao']):<12}{data_br(a['vencimento']):<12}"
              f"{fmt_money(a['valor_aplicado']):>17}{fmt_money(a['saldo_bruto']):>17}")
    print(f"  {'TOTAL':<24}{fmt_money(r['total_aplicado']):>17}{fmt_money(r['saldo_bruto']):>17}")

    print("\n  --- RESUMO ---")
    print(f"  Total aplicado .............. {fmt_money(r['total_aplicado'])}")
    print(f"  Saldo bruto atual ........... {fmt_money(r['saldo_bruto'])}")
    print(f"  Rendimento bruto acumulado .. {fmt_money(r['rendimento_bruto'])}")
    print(f"  IR+IOF a pagar (provisão) ... {fmt_money(r['ir_previsto'] + r['iof_previsto'])}")
    print(f"  Líquido se resgatar hoje .... {fmt_money(r['valor_liquido'])}")
    print(f"  Rentabilidade média ......... {fmt_pct(r['rentabilidade_media_pct'])}")
    print(f"  IR já pago / IOF já pago .... {fmt_money(r['ir_pago'])} / {fmt_money(r['iof_pago'])}")

    # conferência interna: soma da Aba 1 x total do extrato de posição
    tot = c.get("totais_posicao_extrato", {})
    if tot.get("bruto") is not None:
        dif = abs(r["saldo_bruto"] - tot["bruto"])
        ok = "OK" if dif < 1.0 else f"DIVERGE em {fmt_money(dif)}"
        print(f"  Conferência saldo bruto x extrato de posição: {ok}")

    if m["avisos"]:
        print("\n  ⚠️  AVISOS:")
        for a in m["avisos"]:
            print(f"    - {a}")
    else:
        print("\n  Sem inconsistências detectadas.")

    print(f"\n  Arquivo auditável: {JSON_CONSOLIDADO}")

    print("\n[2/3] Gerando planilha Excel (.xlsx)...")
    x = gerar_xlsx.gerar_xlsx(c)
    print(f"  -> {x}")

    print("\n[3/3] Gerando dashboard (.html)...")
    h = gerar_html.gerar_html(c)
    print(f"  -> {h}")

    # Veredito final: diz claramente se pode importar no site ou se há o que revisar.
    print("\n" + "=" * 72)
    bruto_ok = (tot.get("bruto") is None) or (abs(r["saldo_bruto"] - tot["bruto"]) < 1.0)
    if not m["avisos"] and bruto_ok:
        print("✅ TUDO OK — pode importar o arquivo abaixo na aba Investimentos do site:")
        print(f"   {JSON_CONSOLIDADO}")
    else:
        n = len(m["avisos"]) + (0 if bruto_ok else 1)
        print(f"⛔ ATENÇÃO ({n} ponto(s) a revisar ANTES de importar):")
        if not bruto_ok:
            print("   - Saldo bruto da carteira não bate com o total do extrato de posição.")
        for a in m["avisos"]:
            print(f"   - {a}")
        print("\n   Revise os itens acima (geralmente: trocar o extrato de posição pelo mais novo,")
        print("   ou adicionar o extrato de um mês que faltou) e rode de novo.")
    print("=" * 72)


if __name__ == "__main__":
    main()
