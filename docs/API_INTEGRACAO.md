# API de integração (sistema a sistema)

Serve para outro sistema da empresa ler dados do Gestão RM sem login de pessoa. O primeiro
consumidor é o **Estoque RM**, que precisa da lista de colaboradores para registrar quem retirou
material sem recadastrar ninguém.

Base: `https://gestao.example.com/api/integracoes/v1`

## Como funciona a credencial

Token no formato `gdj_itg_<id>.<segredo>`, enviado no cabeçalho `Authorization: Bearer …`.
O `id` viaja em claro (é o que localiza o registro); do segredo, com 256 bits, o servidor guarda
só o SHA-256. **O token aparece uma única vez, na emissão.** Perdeu, emite outro e revoga o antigo.

As credenciais vivem no documento Mongo `integracoes_api`, lido a cada requisição: revogar vale
na hora, sem redeploy. Escopo disponível hoje: `funcionarios:ler`.

⚠️ **Elas não entram no backup.** Depois de restaurar o sistema num ambiente novo, reemita o token
do consumidor, senão a sincronização começa a responder 401 sem avisar ninguém.

### Emitir, listar e revogar (admin)

Só administrador logado (no localhost sem login, liberado). As rotas de mutação passam pelo
anti-CSRF, então pelo terminal é preciso mandar o `Origin`.

```bash
# emitir
curl -X POST http://localhost:3000/api/seguranca/integracoes \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:3000' \
  -d '{"nome":"Estoque RM","empresas":[],"contratos":[]}'
# → {"ok":true,"credencial":{...},"token":"gdj_itg_ab12…"}   (guarde o token agora)

# listar (nunca devolve o hash nem o segredo)
curl http://localhost:3000/api/seguranca/integracoes

# revogar (lógico: preserva a trilha de quem usou o quê)
curl -X DELETE http://localhost:3000/api/seguranca/integracoes/<id> -H 'Origin: http://localhost:3000'
```

Campos aceitos na emissão: `nome`, `escopos` (padrão `["funcionarios:ler"]`), `empresas`
(`["NTE"]`, `["SUL"]` ou vazio para todas), `contratos` (números; vazio para todos) e `expiraEm`
(epoch ms; 0 ou ausente = não expira).

## GET /funcionarios

Snapshot **completo** dos colaboradores. Sem paginação, sem filtro por data.

```bash
curl https://gestao.example.com/api/integracoes/v1/funcionarios \
  -H "Authorization: Bearer $GESTAO_DJ_TOKEN" \
  -H 'If-None-Match: "<etag da última vez>"'
```

Resposta 200:

```json
{
  "schemaVersion": 1,
  "fonte": "gestao-rm",
  "geradoEm": 1786624200000,
  "total": 183,
  "funcionarios": [
    { "id": "C1a2b3", "nome": "José da Silva",
      "matricula": "0451", "cargo": "Pedreiro", "empresa": "NTE",
      "status": "Ativo", "ativo": true }
  ]
}
```

Cabeçalhos: `ETag` (calculada sobre a lista ordenada por `id`, sem o carimbo de geração) e
`Cache-Control: no-store`. Mandando `If-None-Match` com a ETag anterior, a resposta é **304** sem
corpo quando nada mudou.

Erros: `401` credencial ausente, inválida, revogada ou expirada; `403` escopo insuficiente;
`429` com `Retry-After` (20 tentativas recusadas por minuto, por IP, além do teto global do site).

### Os campos, e por que só estes

| Campo | Observação |
|---|---|
| `id` | Identidade entre os sistemas. Estável e opaco. É por ele que se casa o cadastro. |
| `nome` | Nome completo. |
| `matricula` | Apoio, `null` quando vazia. Está preenchida em ~11% dos cadastros, então **não serve de identidade** nem de desempate. |
| `cargo` | Preenchido em ~97%. É o que ajuda a distinguir homônimo. |
| `empresa` | Sigla canônica (`NTE`, `SUL`) ou `null`. Quem está sem empresa vem mesmo assim. |
| `status` | Texto do cadastro (`Ativo`, `Desligado`, `Férias`…). |
| `ativo` | `false` quando o status é `Desligado`. |

**Nunca saem:** CPF, RG, nascimento, telefone, e-mail, endereço, contato de emergência, salário,
documentos, ficha de EPI, CNH, foto, observações, setor, centro de custo, admissão/demissão e
registros de teste (`soDev`). O DTO é montado por lista literal de campos: campo novo no cadastro
não passa a vazar sozinho. Há teste automático que falha se aparecer qualquer campo fora da lista
(`test/integracoes.test.js`).

## Como o consumidor deve sincronizar

1. **Espelhar, não consultar ao vivo.** Guarde as pessoas numa coleção própria, com o `id` daqui
   como chave (`fonteId`, índice único). A tela de retirada lê o espelho, não a rede.
2. **Snapshot inteiro, sempre.** Não existe sincronização incremental: `ts` é data de criação (o
   PUT preserva), não há marca de atualização, e a exclusão é física, sem lápide. Um `?desde=`
   perderia renomeação, desligamento e sumiço. Com ~180 registros o snapshot custa quase nada.
3. **Ausente não é apagado.** Quem some do snapshot vira indisponível (marque a data), nunca
   `delete`: movimentação já lançada precisa continuar apontando para alguém.
4. **Desligado continua no espelho.** Ele sai do seletor de nova saída, mas tem que continuar
   pesquisável para devolução e histórico. Quem foi desligado com uma ferramenta na mão é
   justamente quem o almoxarife precisa achar.
5. **Falhou, mantém o que tinha.** Em 401, 429, timeout ou resposta inválida, preserve o espelho e
   mostre a idade dele na tela. Queda maior que 20% no total merece quarentena e alerta, em vez de
   desativar gente em massa.
6. **Grave o nome junto da movimentação** (snapshot imutável: nome, cargo, empresa). Renomear o
   cadastro aqui não pode reescrever o que a pessoa assinou lá.
7. **Quem não é colaborador** (terceirizado, visitante, motorista de fornecedor) entra com o nome
   digitado, sem `id`. O vínculo com o Gestão RM é opcional por natureza.

Cadência sugerida: ao abrir a tela de movimentação, botão "atualizar agora" e uma varredura
diária. Timer curto (5 ou 15 minutos) mantém os dois serviços acordados no Render o mês inteiro,
o que só faz sentido depois de decidir o plano.

## Notas de implementação (Gestão RM)

- O router é montado **antes do gate de login** (`backend/server.js`, seção "API de integração"),
  com a autenticação no primeiro `use`: rota nova dentro dele já nasce protegida.
- A rota aparece em **Segurança › Endpoints** com o guard `token:funcionarios:ler`.
- Mudança feita direto no Mongo (script em lote) só aparece na API **depois de reiniciar** o
  serviço, porque o servidor carrega os dados em memória no boot. Pela interface, aparece na hora.
- O anti-CSRF barra mutação sem `Origin`/`Referer`. Como esta API é só leitura (GET), não afeta o
  consumidor; se um dia houver POST por token, a autenticação terá que ser assinatura do corpo.
