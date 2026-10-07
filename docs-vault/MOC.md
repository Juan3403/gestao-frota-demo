# MOC — Mapa do Sistema (Frota NTE)

Índice geral (Map of Content) do app de gestão de frota da **Norte Engenharia**. Backend Node + Express (`server.js`), frontend em JavaScript puro (`public/app.js`), publicado no Render.

> **Como ler estas notas:** cada nota responde **O que faz · Por que existe · Como funciona · Quando é usado**, em linguagem direta para quem está chegando. Como o sistema é um **monólito** (um arquivo grande no back e outro no front, sem `import` entre módulos), "Dependências" significa **de quais serviços lógicos o módulo depende** — não importações de arquivo.

## 🧱 Núcleo / Infra
- [[Server]] — o motor Express que liga tudo
- [[Persistência]] — onde os dados ficam (JSON local / MongoDB)
- [[Autenticação]] — login e sessão
- [[Usuários e Permissões]] — quem pode o quê
- [[Histórico]] — diário de quem mudou o quê
- [[Mídia]] — cofre de anexos
- [[Backup]] — cópia de segurança e restauração
- [[Cadastros]] — listas-base (centros de custo / responsáveis)

## 🚗 Frota & Operação
- [[Veículos]] — a lista de carros (aba Frota)
- [[Multas]] — multas e trâmite no Detran
- [[Rastreadores]] — aparelhos Cobli
- [[Manutenção]] — consertos e revisões
- [[Abastecimento]] — combustível
- [[Fornecedores]] — oficinas e prestadores

## 💰 Financeiro
- [[Contratos]] — consórcios/financiamentos/empréstimos
- [[Simulador]] — calculadora de CET
- [[Investimentos]] — renda fixa (Inter)

## 👥 Pessoal (RH)
- [[Funcionários]] — cadastro e documentos da equipe
- [[Admissão]] — formulário público do candidato
- [[Integração]] — treinamentos (vídeo + prova)

## 🖥️ Interface & Cliente
- [[Frontend SPA]] — a interface no navegador
- [[Início]] — tela de boas-vindas
- [[Login]] — tela de acesso
- [[Página Admissão]] — tela pública de admissão
- [[Página Treinamento]] — tela pública de treinamento
- [[Service Worker]] — cache para abrir rápido

## 🔧 Transversais
- [[Modo Manutenção]] — aviso "alguém mexendo agora"
- [[Feedback]] — mural de sugestões
- [[Scripts]] — ferramentas de terminal

## 🏷️ Legenda das tags
- **#core / #infra** — peças de base que sustentam o resto
- **#api** — tem endpoints (o site conversa com o servidor)
- **#db** — guarda/lê dados
- **#auth** — envolve login/permissão
- **#frontend** — tela/interface
- **#publico** — acessível sem login (por token)
- **#rh** — área de Pessoal
- **#financeiro** — área de Finanças
- **#backup** — cópia de segurança

#moc #core
