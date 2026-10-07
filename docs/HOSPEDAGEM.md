# ☁️ Como publicar o sistema na internet (grátis, 24/7)

Vamos usar 3 serviços **gratuitos**:

1. **GitHub** — guarda o código do projeto.
2. **MongoDB Atlas** — o banco de dados grátis onde os veículos ficam salvos (não some).
3. **Render** — coloca o site no ar 24 horas.

> Faça na ordem: **MongoDB → GitHub → Render**. Leva uns 20–30 minutos na primeira vez.
> Vai precisar criar uma conta (grátis) em cada um.

---

## PARTE 1 — Banco de dados (MongoDB Atlas)

1. Acesse **https://www.mongodb.com/cloud/atlas/register** e crie uma conta.
2. Crie um cluster gratuito: escolha a opção **M0 / FREE** (0 dólares). Pode deixar o nome padrão.
3. **Database Access** (menu lateral) → **Add New Database User**:
   - Usuário: `frota`
   - Senha: crie uma senha **só com letras e números** (anote!) — evite símbolos para não dar problema na URL.
   - Permissão: **Read and write to any database** → **Add User**.
4. **Network Access** (menu lateral) → **Add IP Address** → clique em **ALLOW ACCESS FROM ANYWHERE** (`0.0.0.0/0`) → **Confirm**.
5. **Database** (menu lateral) → botão **Connect** no seu cluster → **Drivers** →
   copie a **connection string**. Ela parece com isto:
   ```
   mongodb+srv://frota:<password>@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
   ```
6. **Troque `<password>`** pela senha que você criou no passo 3. Guarde essa URL final —
   é o seu **MONGODB_URI**. (Ex.: `mongodb+srv://frota:MinhaSenha123@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority`)

---

## PARTE 2 — Subir o código (GitHub)

A forma mais fácil sem usar comandos:

1. Crie conta em **https://github.com**.
2. Baixe e instale o **GitHub Desktop**: https://desktop.github.com
3. Abra o GitHub Desktop → **File → Add Local Repository** → escolha a pasta
   `C:\Users\Juan\Desktop\gestao-frota-demo`.
   - Se ele disser que não é um repositório, clique em **"create a repository"** (criar) e confirme.
4. Clique em **Publish repository**.
   - Pode marcar **"Keep this code private"** (recomendado, mantém o código privado).
   - **Publish**.

> A pasta `node_modules` (pesada) é ignorada automaticamente pelo arquivo `.gitignore` — não se preocupe.

---

## PARTE 3 — Colocar no ar (Render)

1. Crie conta em **https://render.com** (pode entrar com a conta do GitHub).
2. No painel: **New +** → **Web Service**.
3. **Connect** o seu repositório `gestao-frota-demo` do GitHub (autorize o Render a acessar, se pedir).
4. Configurações:
   - **Name**: `frota` (ou o que quiser — vira parte do endereço)
   - **Region**: a mais próxima (ex.: Oregon ou Ohio)
   - **Build Command**: `npm install && python3 -m pip install -r pipeline_rendafixa/requirements.txt`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. Role até **Environment Variables** → **Add Environment Variable** e adicione **duas**:
   | Key (nome) | Value (valor) |
   |---|---|
   | `MONGODB_URI` | a URL que você montou na Parte 1 (passo 6) |
   | `APP_PASSWORD` | uma senha de acesso ao site que **você inventa** (ex.: `NTE2026frota`) |
6. Clique em **Create Web Service**. O Render vai instalar e iniciar (leva 2–4 min na primeira vez).
7. Quando aparecer **"Live"**, o endereço do seu site fica no topo, algo como:
   **https://frota.onrender.com**

Pronto! 🎉 Acesse esse endereço de qualquer lugar.

---

## 🔐 Como entrar no site

Ao abrir o endereço, o navegador vai pedir **usuário e senha**:
- **Usuário**: pode ser qualquer coisa (ex.: `nte`)
- **Senha**: a que você colocou em `APP_PASSWORD`

---

## ℹ️ Coisas importantes de saber

- **Os dados ficam salvos no MongoDB** — não somem quando o Render reinicia ou você atualiza o código.
- **Na primeira vez**, o sistema sobe já com os **46 veículos** (a partir do arquivo `data.json` do projeto). Depois disso, tudo que você editar fica no banco.
- **O plano grátis do Render "dorme"** após ~15 min sem ninguém usando. O primeiro acesso depois disso pode demorar **uns 30–50 segundos** para "acordar" — é normal. Depois fica rápido.
- **Atualizar o site no futuro**: se eu mexer no código, é só você abrir o GitHub Desktop, clicar em **Commit** e depois **Push** — o Render publica a nova versão sozinho.
- **No seu PC continua funcionando igual** (pelo `INICIAR.bat`), usando os arquivos locais — sem senha e sem depender da internet. As duas coisas convivem.

---

## ❓ Deu algum erro?

- **Página "Application failed to respond" / erro no Render**: confira se as duas variáveis (`MONGODB_URI` e `APP_PASSWORD`) foram salvas certas. Veja os **Logs** no painel do Render.
- **"MongoServerError: bad auth"**: a senha dentro do `MONGODB_URI` está errada ou tem símbolos. Refaça com uma senha só de letras e números.
- **Não pede senha**: você esqueceu de definir `APP_PASSWORD` no Render.
- Qualquer dúvida, me chame que eu te ajudo a ler o log e resolver.
