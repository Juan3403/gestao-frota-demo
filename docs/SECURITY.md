# Segurança — Frota NTE / Gestão RM

Documento de segurança do sistema interno de gestão de frota. Cobre o modelo de ameaça,
política de segredos, resposta a vazamentos, rotação de credenciais e como rodar as
auditorias no Linux. A matriz de endpoints fica em [`SECURITY_ENDPOINTS.md`](./SECURITY_ENDPOINTS.md).

> Resumo da postura atual: login individual com aprovação de admin, autorização por aba
> aplicada **no servidor**, sessão HMAC com timeout, cabeçalhos de segurança + CSP,
> anti-CSRF por origem, rate limit + anti-força-bruta, validação de upload, trilha de
> auditoria de ações sensíveis e exportações protegidas contra injeção de fórmula.

---

## 1. Modelo de ameaça (resumido)

| Ativo | Ameaça | Mitigação no sistema |
|---|---|---|
| Dados da frota/multas/funcionários (PII: CPF/RG/PPP, financeiro) | Acesso não autorizado | Login obrigatório em produção + autorização por aba (`exigeVer`/`exigeEditar`/`exigeAdmin`) no backend; mídia (`/api/midia/:id`) exige permissão da área |
| Sessão do usuário | Roubo/forja de cookie | Cookie HMAC assinado com `SESSION_SECRET` (pepper) + hash da senha; `HttpOnly`, `SameSite=lax`, `Secure` em produção; timeout de inatividade e absoluto |
| Mutações (POST/PUT/DELETE) | CSRF | Verificação de `Origin`/`Referer` same-origin em toda mutação + `SameSite=lax` |
| Login | Força bruta / enumeração de usuários | Limite por IP (8 erros/15 min → 429 com `Retry-After`); mensagens genéricas |
| API | Abuso/DoS leve | Rate limit global por IP (600 req/min) |
| Transporte | MITM / downgrade | Render serve HTTPS; HSTS quando `req.secure`; cookies `Secure`; CSP restritiva |
| Uploads | Upload de conteúdo executável / travessia de caminho | Allowlist de MIME+extensão, bloqueio de nomes perigosos, teto de 10 MB, 1 arquivo; mídia servida com `nosniff` e `Content-Disposition` seguro |
| Exportações Excel/CSV | Injeção de fórmula (CSV injection) | Células iniciadas por `= + - @` são prefixadas (`protegerCelula`) |
| Segredos | Vazamento em commit | `.gitignore` abrangente, `.env.example` sem valores, scanner de segredos + CI |
| Ações sensíveis | Falta de rastreabilidade | Trilha de auditoria (`seglogs`) + logs de acesso (`loginlogs`) |

**Fora de escopo / aceito:** ataque interno por admin legítimo (admin tem acesso total por
design, mas ações críticas são logadas); proteção contra dispositivo do usuário comprometido.

---

## 2. Variáveis de ambiente (segredos)

Configuradas no **Render → Environment** (produção) ou em `.env` local (nunca versionado).
Veja o modelo em [`.env.example`](./.env.example).

| Variável | Obrigatória em produção | Para que serve |
|---|---|---|
| `MONGODB_URI` | sim | Conexão do MongoDB Atlas. Sem ela, o app usa arquivos JSON locais. |
| `SENHA_ADMIN` | sim | Senha do admin mestre (`juan`). |
| `SESSION_SECRET` | **sim** | Assina as sessões. Sem ela, todos são deslogados a cada deploy. |
| `APP_PASSWORD` | não | Compatibilidade (senha antiga). Prefira `SENHA_ADMIN`. |
| `SESSION_INATIVIDADE_MIN` | não (padrão 60) | Minutos de ociosidade até deslogar. |
| `SESSION_ABSOLUTO_H` | não (padrão 12) | Horas de vida máxima da sessão. |
| `NODE_ENV` | recomendado (`production`) | Ambiente. |

**Nunca** cole `MONGODB_URI` ou qualquer segredo em chat, issue, commit, log, changelog ou
captura de tela.

---

## 3. Política de segredos & resposta a vazamento

### Prevenção
- `.gitignore` ignora `.env`, `.env.*` (exceto `.env.example`), dados reais, backups, dumps e relatórios de scan.
- Scanner de segredos: `npm run security:secrets` (CI roda em todo push/PR — ver `.github/workflows/security.yml`).
- Hook opcional de pré-commit: ver seção 6.

### Se um segredo vazar (ex.: `MONGODB_URI`/`SENHA_ADMIN`/`SESSION_SECRET` num commit)
1. **Não** apague só o arquivo e pronto — o segredo permanece no **histórico** do git.
2. **Rotacione imediatamente** a credencial na origem (ver seção 4). Considere o valor vazado como comprometido para sempre.
3. Gere o **fingerprint redigido** (sem expor o valor) com `npm run security:secrets` e registre: tipo, arquivo, linha, commit, sha256 parcial.
4. Atualize a variável no **Render** e force **novo deploy**.
5. Se necessário, limpe o histórico (`git filter-repo` ou BFG) e faça force-push **coordenado** com quem tem clones.
6. Reveja os **logs de segurança** (`/api/seguranca/logs`) e de acesso para detectar uso indevido.

---

## 4. Rotação de credenciais

**`MONGODB_URI` (MongoDB Atlas):**
1. Atlas → Database Access → crie um novo usuário (ou troque a senha do atual) com *Read/Write*.
2. Atualize `MONGODB_URI` no Render → Manual Deploy → *Deploy latest commit*.
3. Confirme o boot (`MongoDB conectado.`). Remova o usuário antigo no Atlas.
4. Restrinja **Network Access** aos IPs do Render (evite `0.0.0.0/0` em produção).

**`SESSION_SECRET`:**
1. Gere: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`.
2. Atualize no Render e faça deploy. Efeito: todos relogam uma vez (esperado).

**`SENHA_ADMIN` / `APP_PASSWORD`:**
1. Defina nova senha forte no Render e faça deploy. Sessões do admin caem (o token depende da senha).

---

## 5. Checklist de produção (Render / Atlas / GitHub)

- [ ] `SESSION_SECRET` definido (valor aleatório forte).
- [ ] `SENHA_ADMIN` definido (senha única e longa).
- [ ] `MONGODB_URI` definido; **Network Access** restrito aos IPs do Render.
- [ ] `NODE_ENV=production`.
- [ ] HTTPS ativo (padrão no Render) e cookies chegando como `Secure`.
- [ ] GitHub Actions de segurança verde (`.github/workflows/security.yml`).
- [ ] `npm audit --audit-level=high` sem vulnerabilidades.
- [ ] Backups verificados (download manual `/api/backup` funciona; é só admin).

---

## 6. Como rodar no Linux

```bash
npm install

# Desenvolvimento (modo aberto, dados em JSON local):
npm run dev          # ou: npm start

# Simulando produção (login ativo) — valores apenas locais, troque-os:
export APP_PASSWORD='trocar-em-dev'
export SESSION_SECRET='dev-secret-longo-apenas-local'
export MONGODB_URI='mongodb+srv://...'   # opcional
npm start

# Sem Mongo (usa arquivos JSON):
unset MONGODB_URI
npm start
```

**Auditorias:**
```bash
npm run security:secrets   # scanner de segredos (usa gitleaks se instalado; senão, scanner Node interno) — saída redigida
npm run security:audit     # npm audit (nível high) + scanner de segredos
npm test                   # testes de fumaça + testes de segurança
```

**Hook de pré-commit (opcional):**
```bash
cp scripts/pre-commit .git/hooks/pre-commit
chmod +x .git/hooks/pre-commit
# para pular pontualmente: git commit --no-verify
```

---

## 7. Como reportar um problema de segurança

Reporte de forma privada ao responsável pelo sistema (Juan / contato@example.com).
**Não** abra issue pública com detalhes exploráveis nem inclua segredos reais. Inclua:
passos de reprodução, impacto e, se houver, fingerprint **redigido** do segredo afetado.

---

## 8. Trilha de auditoria

- **Logs de acesso** (`loginlogs`, `GET /api/usuarios/logs`, admin): `entrou`/`falhou`/`bloqueado` com IP+UA.
- **Logs de segurança** (`seglogs`, `GET /api/seguranca/logs`, admin): aprovação/recusa/exclusão de usuário,
  troca de senha/nível/permissões, download de backup, exportação sensível, CSRF recusado,
  acesso negado (403), upload recusado. PII mascarada; **nunca** grava senha, cookie, token ou URI do Mongo.

Ambos são capados (1.000 / 2.000 eventos mais recentes) e entram no backup completo.
