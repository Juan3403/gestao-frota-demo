# 🚚 Sistema de Gestão de Frota — Norte Engenharia

Aplicativo web para gerenciar os veículos da frota. Tudo que você altera na tela é
**gravado automaticamente** no arquivo `data.json` — não é preciso mexer em código.

---

## ✅ O que você precisa ter instalado (só uma vez)

**Node.js** — é o programa que faz o site funcionar.

1. Acesse: https://nodejs.org
2. Baixe a versão **LTS** (botão da esquerda) e instale clicando em "Avançar" até o fim.
3. Pronto. Você só faz isso uma vez nesta máquina.

---

## ▶️ Como iniciar o sistema (toda vez que for usar)

1. Abra a pasta do projeto:
   `C:\Users\Juan\Desktop\gestao-frota-demo`
2. Clique duas vezes no arquivo **`INICIAR.bat`**.
   - Vai abrir uma janela preta (o "servidor"). **Deixe essa janela aberta** enquanto usa o sistema.
3. Abra o navegador (Chrome, Edge...) e acesse:
   ## 👉 http://localhost:3000

> **Para encerrar:** feche a janela preta (ou pressione `Ctrl + C` nela).

> Se preferir iniciar manualmente: abra o "Prompt de Comando" na pasta e digite `npm start`.
> (Na primeiríssima vez, rode antes `npm install` para baixar os componentes — o `INICIAR.bat` já faz isso sozinho.)

---

## 🖥️ As 3 telas

### 1) Frota
- Tabela com todos os veículos.
- **Buscar:** digite placa, modelo, chassi, dono... na caixa de busca.
- **Filtrar:** use os menus (Status, Gravame, Centro de Custo, Dono, Modelo).
- **Ordenar:** clique no título de qualquer coluna (clique de novo para inverter).
- **Linhas destacadas:**
  - 🟡 Amarelo = documento vencido
  - 🔴 Vermelho = veículo com "busca e apreensão"

### 2) Dashboard
Indicadores e gráficos que se **recalculam sozinhos** conforme você edita a frota:
totais, em atividade/oficina, documentos vencidos, alienados, valores FIPE,
distribuição por centro de custo, por responsável e análise de alienação por banco.

### 3) Análises
Tabelas por **Modelo** e por **Versão**: quantidade, % da frota, FIPE total, FIPE médio,
ano mais antigo e mais novo.

---

## ✏️ Como adicionar, editar e excluir veículos

- **Adicionar:** na tela *Frota*, clique em **“+ Adicionar veículo”**, preencha e clique em **Salvar**.
- **Editar:** clique em **“Editar”** na linha do veículo, ajuste e **Salvar**.
- **Excluir:** clique em **“Excluir”** na linha do veículo e confirme.

> Os campos **Valor Ricardo** e **Valor Marcelo** são calculados sozinhos
> (Valor FIPE × o percentual de cada um). Você só informa os percentuais.
> Dica: digite `0,75` para 75% e `0,25` para 25%.

Toda alteração é salva na hora no arquivo `data.json`.

---

## 📊 Excel: exportar e importar

- **Exportar para Excel** (botão no topo): baixa o arquivo `FROTA_CONSOLIDADA.xlsx`
  com todos os veículos, já com os valores Ricardo/Marcelo calculados.
- **Importar de Excel** (botão no topo): substitui **toda** a frota pelos dados de uma planilha.
  A planilha precisa ter uma aba com a palavra "FROTA" (ou será usada a primeira aba) e a
  coluna **PLACA**. Os nomes das colunas devem ser os mesmos do sistema
  (PLACA, MODELO, VERSÃO, ANO FAB, ... — exatamente como no arquivo exportado).

> ⚠️ Importar **apaga e substitui** os dados atuais. Se tiver dúvida, **exporte antes**
> para guardar uma cópia de segurança.

---

## 🛟 Segurança dos dados

- Os dados ficam no arquivo **`data.json`** dentro da pasta do projeto.
- A cada gravação, o sistema cria automaticamente um backup **`data.json.bak`** (a versão anterior).
- Para fazer uma cópia de segurança manual, basta copiar o arquivo `data.json` para outro lugar.

---

## ❓ Problemas comuns

| Problema | Solução |
|---|---|
| O navegador diz que não consegue acessar `localhost:3000` | A janela preta (servidor) precisa estar **aberta**. Rode o `INICIAR.bat`. |
| Os gráficos não aparecem | Eles usam internet para carregar a biblioteca de gráficos. Verifique a conexão. |
| "node não é reconhecido..." | O Node.js não está instalado. Veja a seção de instalação acima. |
| Quero mudar a porta 3000 | No `INICIAR.bat`/terminal: `set PORT=4000 && npm start` (depois acesse `localhost:4000`). |
