# Pipeline de Renda Fixa — Banco Inter PJ (Norte Engenharia)

Lê os extratos PDF do Banco Inter, consolida num JSON auditável e gera uma planilha de
controle (`.xlsx`, 6 abas + gráficos) e um dashboard (`.html`) para o Gestão RM.

## Como usar (todo mês)

1. Baixe no app/site do Inter e **coloque os PDFs em `../extratos/`**:
   - Extratos de **movimentação** (`extrato-movimentacao-renda-fixa*.pdf`) — um por período.
     Pode haver períodos sobrepostos; a dedupe cuida disso. **Não deixe buracos de período**
     (meses sem extrato) ou as aplicações encerradas nesse intervalo ficam sem rendimento/IR.
   - O extrato de **posição** (`extrato-posicao-renda-fixa.pdf`) — é a foto da carteira atual e a
     fonte das posições abertas. **Mantenha só o mais recente** na pasta.
2. Rode, a partir da raiz do projeto:
   ```
   python run.py
   ```
3. Confira no terminal a tabela de aplicações abertas, o total e a linha
   "Conferência saldo bruto x extrato de posição: OK". Resolva eventuais ⚠️ avisos.
4. Saídas em `../output/`:
   - `dados_consolidados.json` — intermediário auditável (abra e confira).
   - `controle_investimentos.xlsx` — planilha de controle.
   - `dashboard.html` — dashboard para abrir no navegador / embutir no Gestão RM.

## Ver no site (aba Investimentos)

O site Frota NTE tem uma aba **Investimentos** (grupo Financeiro) que mostra essa carteira.
Para atualizar direto pelo site, abra **Investimentos -> Subir extratos** e selecione os PDFs
de movimentação e posição do Banco Inter. O servidor processa esses PDFs em uma pasta temporária,
salva só o snapshot consolidado e apaga os arquivos brutos no final da requisição.

O fluxo antigo continua disponível como fallback: rode `python run.py` e importe
`output/dados_consolidados.json` em **Investimentos -> Importar JSON**.

A aba precisa de permissão `investimentos` (admin libera por usuário no painel de Usuários).
Os PDFs sobem pela API (`POST /api/investimentos/importar-extratos`); o JSON consolidado sobe por
`POST /api/investimentos/importar`.

## Instalação (uma vez)

```
python -m pip install -r pipeline_rendafixa/requirements.txt
```

## Como funciona

- `parse.py` — extração **por coordenadas** (pdfplumber). O layout do Inter posiciona as colunas
  por X; o texto linear sai embaralhado, por isso agrupamos palavras por linha (Y) e atribuímos
  cada uma à coluna pela faixa de X.
- `consolidar.py` — dedupe das aplicações (chave: Tipo + Data aplicação + Vencimento + Valor) e do
  histórico; posições abertas vêm do extrato de posição; encerradas pela identidade de caixa.
  Marca como "incompleto" qualquer encerrada cujo histórico tenha buraco (rendimento bruto < 0).
- `gerar_xlsx.py` / `gerar_html.py` — geram as saídas a partir do JSON consolidado.

## Tipos de aplicação suportados

- **CDB DI LIQUIDEZ DIÁRIA PJ** (colunas Data | Histórico | Valor | D/C | Saldo)
- **LCD DI FLUT TB** (colunas Data | Histórico | Valor | IOF | IR | Saldo)

Se o Inter mudar o layout, ajuste as bandas de X em `parse.py` (`BANDAS_CDB`, `BANDAS_LCD`,
`BANDAS_POS`).
