"""Pipeline de renda fixa (Banco Inter PJ - Norte Engenharia).

Lê os extratos PDF de ./extratos/, consolida num JSON auditável e gera
a planilha de controle (.xlsx) e o dashboard (.html) em ./output/.

Etapas: parse -> consolidar -> gerar_xlsx / gerar_html.
Reexecutável: basta adicionar novos PDFs em ./extratos/ e rodar `python run.py`.
"""
