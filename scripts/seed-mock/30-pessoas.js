/**
 * seed-mock/30-pessoas.js — completa o grupo PESSOAS / SST / TI da base de demonstração.
 *
 * O seed principal (scripts/seed-mock.js) já cria colaboradores, EPI, almoxarifado, ações de
 * SST e dois documentos da empresa, mas deixava várias abas vazias ou só com linhas "de
 * controle" (sem arquivo). Este módulo:
 *   1. Funcionários  — foto, documentos com PDF (ASO, NRs, contrato, CNH), versões anteriores,
 *                      ficha de EPI escaneada, itens entregues, salário e o PPP/ASO demissional
 *                      do desligado. Mantém linhas só de controle e os cenários vencido/a vencer.
 *   2. Form. Admissão — convites em todos os estados (aguardando, rascunho com uploads,
 *                      preenchido aguardando revisão, aplicado, expirado e cancelado).
 *   3. Integração     — 3 treinamentos com prova, convites em todos os estados do
 *                      Acompanhamento e o histórico de tentativas (conclusões).
 *   4. Programas SST  — PCMSO/PGR/PCMAT/LTCAT/AVCB por contrato, com PDF e validades variadas.
 *   5. TI             — equipamentos, linhas e licenças com entregas assinadas (hash igual ao
 *                      do servidor), devolução, manutenção longa, baixa, extravio e assentos.
 *   6. Documentos     — pastas e documentos institucionais com PDF.
 *   7. EPI (NF)       — notas fiscais de EPI com o PDF anexado e uma compra no mês corrente.
 *
 * TUDO é fictício: nomes inventados, CPFs só via ctx.cpfFake, e-mails @example.com, nenhuma
 * empresa ou CNPJ real. Os anexos são gravados no cofre local (data/uploads) e ficam SEMPRE
 * num campo que `midiasReferenciadas()` (backend/server.js) enxerga — senão a faxina de
 * órfãos os apagaria ~1h depois de subir o servidor.
 *
 * USO (chamado pelo seed-mock.js, não direto):
 *   const extras = await require('./seed-mock/30-pessoas.js').montar(ctx);
 *   // → { 'admissoes.json': {admissoes:[…]}, 'treinamentos.json': {…}, 'treinamento_convites.json': {…}, 'epi_notas_fiscais.json': {…},
 *   //     'treinamento_conclusoes.json': {…}, 'programas.json': {…}, 'ti_ativos.json': {…},
 *   //     'ti_movimentacoes.json': {…} }
 *   // e, de quebra, ctx.funcionarios e ctx.documentos saem enriquecidos (mutados no lugar).
 */

'use strict';

// ---------------------------------------------------------------------------
// Utilidades locais
// ---------------------------------------------------------------------------

/**
 * Avatar FICTÍCIO (círculo com iniciais) — faz as vezes de foto 3×4 sem ser foto de ninguém.
 * USO: svgAvatar('Beatriz Salgado Furtado', '#0f766e') → '<svg …>BF</svg>'
 */
function svgAvatar(nome, cor) {
  const partes = String(nome || '?').split(/\s+/).filter(Boolean);
  const ini = ((partes[0] || '?')[0] + ((partes[partes.length - 1] || '')[0] || '')).toUpperCase();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="300" height="400">
  <rect width="300" height="400" fill="#e5e7eb"/>
  <circle cx="150" cy="150" r="90" fill="${cor}"/>
  <text x="150" y="176" text-anchor="middle" font-family="sans-serif" font-size="72" font-weight="bold" fill="#ffffff">${ini}</text>
  <rect x="40" y="270" width="220" height="110" rx="55" fill="${cor}" opacity="0.85"/>
  <text x="150" y="392" text-anchor="middle" font-family="sans-serif" font-size="14" fill="#374151">FOTO FICTÍCIA</text>
</svg>`;
}

/**
 * Nome de arquivo seguro a partir de um texto livre.
 * USO: slug('NR-10 — Reciclagem') → 'nr-10-reciclagem'
 */
function slug(txt) {
  return String(txt || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'arquivo';
}

/**
 * Data ISO de N anos/meses antes de uma data ISO (para a emissão a partir da validade).
 * USO: menosMeses('2026-10-08', 12) → '2025-10-08'
 */
function menosMeses(isoData, meses) {
  const [a, m, d] = String(isoData).split('-').map(Number);
  const dt = new Date(Date.UTC(a, m - 1 - meses, d, 12));
  return dt.toISOString().slice(0, 10);
}

/**
 * Cópia FIEL de conteudoAssinadoTi (backend/server.js). O hash do termo de TI precisa bater
 * com o que o servidor recalcula, senão toda entrega nasce com "⚠ alterado". Mudou lá? Muda aqui.
 * USO: ctx.sha256(conteudoAssinadoTi(mov)) → '9f2c…' (64 hex)
 */
function conteudoAssinadoTi(m) {
  return JSON.stringify({
    colaborador: m.funcionarioNome, cpf: m.funcionarioCpf, cargo: m.funcionarioCargo,
    tipo: m.tipo, data: m.data, hora: m.hora, local: m.local, condicao: m.condicao,
    responsavel: m.responsavel,
    ativo: [m.snapshot.descricao, m.snapshot.numeroSerie, m.snapshot.imei, m.snapshot.numero, m.snapshot.produto],
  });
}

/**
 * Cópia FIEL de descricaoAtivoTi / snapshotAtivoTi (backend/server.js) — o snapshot entra no hash.
 * USO: snapshotAtivoTi({ especie:'equipamento', tipo:'Notebook', marca:'Dell', modelo:'X' })
 *      → { descricao:'Notebook Dell X', especie:'equipamento', tipo:'Notebook', … }
 */
function descricaoAtivoTi(a) {
  if (a.especie === 'linha') return [a.operadora, a.numero].filter(Boolean).join(' ') || a.descricao || 'Linha';
  if (a.especie === 'licenca') return [a.fabricante, a.produto].filter(Boolean).join(' ') || a.descricao || 'Licença';
  return [a.tipo, a.marca, a.modelo].filter(Boolean).join(' ') || a.descricao || 'Equipamento';
}
function snapshotAtivoTi(a) {
  return {
    descricao: descricaoAtivoTi(a), especie: a.especie, tipo: a.tipo || '', marca: a.marca || '',
    modelo: a.modelo || '', numeroSerie: a.numeroSerie || '', imei: a.imei || '', numero: a.numero || '', produto: a.produto || '',
  };
}

// ===========================================================================
// 1. FUNCIONÁRIOS — fotos, documentos com arquivo, versões, ficha de EPI, itens, salário
// ===========================================================================

// Cursos/NRs por cargo (o nome casa com a matriz de obrigatórios do seed principal).
const CURSOS_POR_CARGO = {
  'Encarregado de Manutenção': ['NR-35', 'NR-18'],
  'Engenheira Civil': ['NR-35', 'NR-18'],
  'Motorista': ['Direção Defensiva'],
  'Auxiliar Administrativo': [],
  'Eletricista de Linha Viva': ['NR-10 — Reciclagem', 'NR-35'],
  'Técnica de Segurança do Trabalho': ['NR-35', 'NR-10 — Básico'],
  'Pedreiro': ['NR-18', 'NR-35'],
  'Assistente de Departamento Pessoal': [],
  'Operador de Retroescavadeira': ['NR-11', 'NR-12'],
  'Almoxarife': ['NR-06', 'NR-11'],
  'Auxiliar de Escritório': [],
  'Servente': ['NR-18'],
};
const SALARIO_POR_CARGO = {
  'Encarregado de Manutenção': 4200, 'Engenheira Civil': 9800, 'Motorista': 2900, 'Auxiliar Administrativo': 2100,
  'Eletricista de Linha Viva': 4600, 'Técnica de Segurança do Trabalho': 3900, 'Pedreiro': 2600,
  'Assistente de Departamento Pessoal': 2800, 'Operador de Retroescavadeira': 3700, 'Almoxarife': 2500,
  'Auxiliar de Escritório': 1900, 'Servente': 1700,
};
const CORES_AVATAR = ['#1d4ed8', '#0f766e', '#7c3aed', '#b45309', '#be123c', '#0369a1', '#4d7c0f'];

/**
 * Documento de colaborador no formato de normalizarDocsFunc, com PDF fictício no cofre.
 * USO: await docComArquivo(ctx, f, { nome:'ASO', categoria:'Segurança', validade:'2027-01-10', emissao:'2026-01-10' })
 *      → { id:'MD-…', nome:'ASO', tipo:'application/pdf', categoria:'Segurança', validade:'2027-01-10', … }
 */
async function docComArquivo(ctx, f, d) {
  const linhas = [
    `Colaborador: ${f.nome}`, `CPF: ${f.cpf}`, `Cargo: ${f.cargo}`, `Empresa: ${f.empresa}`,
    d.emissao ? `Emissão: ${ctx.br(new Date(d.emissao + 'T12:00:00'))}` : '',
    d.validade ? `Validade: ${ctx.br(new Date(d.validade + 'T12:00:00'))}` : 'Sem validade',
    ...(d.linhas || []),
  ].filter(Boolean);
  const nomeArq = `${slug(d.nome)}-${slug(f.nome.split(' ')[0])}.pdf`;
  const pdf = await ctx.novoPdf(nomeArq, `${d.nome} (exemplo)`, linhas);
  return {
    id: pdf.id, nome: d.nome, tipo: pdf.tipo, categoria: d.categoria,
    validade: d.validade || '', emissao: d.emissao || '', semValidade: !d.validade,
    nomeOriginal: nomeArq, uploadTs: ctx.ts(new Date((d.emissao || ctx.iso(ctx.mes(-6))) + 'T12:00:00')),
    uploadPor: 'RH Demonstração', versoes: d.versoes || [],
  };
}

/** Linha "só de controle" (sem arquivo) — o cadastro registra a data mas o papel não foi digitalizado. */
function docSoControle(d) {
  return {
    id: '', nome: d.nome, tipo: '', categoria: d.categoria, validade: d.validade || '', emissao: d.emissao || '',
    semValidade: !d.validade, nomeOriginal: '', uploadTs: 0, uploadPor: '', versoes: [],
  };
}

/**
 * Reescreve documentos/foto/ficha de cada colaborador. Mantém os cenários de vencimento:
 * ASO vencido (i%5==0), ASO a vencer (i%5==1), curso a vencer (i%4==2), curso vencido (i%6==3),
 * linhas só de controle (residência de quem tem i%3==0 e o 2º curso de i%5==4), um colaborador
 * sem nenhum arquivo (Lorena, i=11) e um sem foto (i=5 e i=11).
 * USO: await enriquecerFuncionarios(ctx) // muta ctx.funcionarios no lugar
 */
async function enriquecerFuncionarios(ctx) {
  const { dia, mes, iso } = ctx;
  for (let i = 0; i < ctx.funcionarios.length; i++) {
    const f = ctx.funcionarios[i];
    const desligado = f.status === 'Desligado';
    const semArquivos = i === 11;               // fica só com linhas de controle, de propósito
    const docs = [];

    // ASO (Segurança, 1 ano)
    const asoVal = i % 5 === 0 ? iso(dia(-15)) : i % 5 === 1 ? iso(dia(18)) : iso(mes(4 + (i % 7)));
    const aso = { nome: 'ASO', categoria: 'Segurança', validade: asoVal, emissao: menosMeses(asoVal, 12), linhas: ['Tipo: Periódico', 'Resultado: APTO (exemplo)'] };
    if (semArquivos) docs.push(docSoControle(aso));
    else {
      // O ASO do 1º colaborador traz a versão do ano anterior em versoes[] (histórico de arquivos).
      if (i === 0) {
        const antigo = await ctx.novoPdf('aso-adriano-2024.pdf', 'ASO anterior (exemplo)', [`Colaborador: ${f.nome}`, 'Tipo: Periódico', 'Resultado: APTO']);
        aso.versoes = [{ id: antigo.id, nome: 'ASO', tipo: antigo.tipo, nomeOriginal: 'aso-adriano-2024.pdf', uploadTs: ctx.ts(mes(-24)), uploadPor: 'RH Demonstração', substituidoTs: ctx.ts(mes(-12)), substituidoPor: 'RH Demonstração' }];
      }
      docs.push(await docComArquivo(ctx, f, aso));
    }

    // Cursos / NRs (Segurança, 2 anos)
    const cursos = CURSOS_POR_CARGO[f.cargo] || [];
    for (let k = 0; k < cursos.length; k++) {
      const val = k === 0 && i % 4 === 2 ? iso(dia(25)) : k === 0 && i % 6 === 3 ? iso(dia(-40)) : iso(mes(8 + ((i + k) % 14)));
      const curso = { nome: cursos[k], categoria: 'Segurança', validade: val, emissao: menosMeses(val, 24), linhas: ['Carga horária: 8 h (exemplo)', 'Instrutor: Instrutor Demonstração'] };
      // O 2º curso de quem tem i%5==4 é só de controle (certificado ainda não digitalizado).
      if (semArquivos || (k === 1 && i % 5 === 4)) docs.push(docSoControle(curso));
      else docs.push(await docComArquivo(ctx, f, curso));
    }

    // Contrato de trabalho (Pessoal, não vence)
    const contrato = { nome: 'Contrato de Trabalho', categoria: 'Pessoal', emissao: f.admissao, linhas: [`Admissão: ${f.admissao}`, 'Regime: CLT', 'Documento fictício'] };
    docs.push(semArquivos ? docSoControle(contrato) : await docComArquivo(ctx, f, contrato));

    // RG/CPF digitalizado (Pessoal) para metade da equipe
    if (!semArquivos && i % 2 === 0) docs.push(await docComArquivo(ctx, f, { nome: 'RG e CPF', categoria: 'Pessoal', emissao: iso(mes(-30)), linhas: [`RG: ${f.rg}`] }));

    // CNH anexada (Pessoal, validade = cnhValidade — é o que a aba CNH sincroniza)
    if (f.cnhValidade && !semArquivos) {
      docs.push(await docComArquivo(ctx, f, { nome: 'CNH', categoria: 'Pessoal', validade: f.cnhValidade, emissao: menosMeses(f.cnhValidade, 60), linhas: [`Categoria: ${f.cnhCategoria}`, `Registro: ${f.cnhNumero}`] }));
    }

    // Comprovante de residência: linha só de controle para quem tem i%3==0
    if (i % 3 === 0) docs.push(docSoControle({ nome: 'Comprovante de Residência', categoria: 'Pessoal', emissao: iso(mes(-3)) }));

    f.documentos = docs;
    f.email = `${slug(f.nome.split(' ')[0])}.${slug(f.nome.split(' ').slice(-1)[0])}@example.com`;

    // Foto (avatar fictício) — dois colaboradores ficam sem foto para mostrar o placeholder.
    if (i !== 5 && i !== 11) f.foto = await ctx.novaMidia(`foto-${slug(f.nome.split(' ')[0])}.png`, svgAvatar(f.nome, CORES_AVATAR[i % CORES_AVATAR.length]));

    // Ficha de EPI em papel escaneada — para quem trabalha em campo.
    if (CURSOS_POR_CARGO[f.cargo] && CURSOS_POR_CARGO[f.cargo].length && !semArquivos && i % 3 !== 2) {
      f.fichaEpi = await ctx.novoPdf(`ficha-epi-${slug(f.nome.split(' ')[0])}.pdf`, 'Ficha de EPI (papel digitalizado)',
        [`Colaborador: ${f.nome}`, `Cargo: ${f.cargo}`, 'Capacete classe B - CA 31.469 - 1 un', 'Bota de segurança - CA 42.115 - 1 par', 'Luva de vaqueta - CA 27.994 - 2 pares', 'Assinado em papel (exemplo)']);
    }

    // Itens entregues (aba Itens do cadastro)
    if (!semArquivos && i % 2 === 1) {
      f.itens = [
        { id: ctx.id('I'), tipo: 'Uniforme', descricao: 'Camisa manga longa com refletivo', ca: '', quantidade: '2', dataEntrega: iso(mes(-6)), dataDevolucao: '', status: 'Entregue', obs: '' },
        { id: ctx.id('I'), tipo: 'Crachá', descricao: 'Crachá de identificação', ca: '', quantidade: '1', dataEntrega: f.admissao, dataDevolucao: '', status: 'Entregue', obs: '' },
        ...(i % 4 === 1 ? [{ id: ctx.id('I'), tipo: 'Ferramenta', descricao: 'Trena 5 m', ca: 'SN-DEMO-0' + i, quantidade: '1', dataEntrega: iso(mes(-4)), dataDevolucao: iso(dia(-10)), status: 'Devolvido', obs: 'Devolvida em bom estado' }] : []),
      ];
    }

    // Remuneração (vigências) — só se nenhum outro módulo já preencheu.
    if (!Array.isArray(f.salarios) || !f.salarios.length) {
      const base = SALARIO_POR_CARGO[f.cargo] || 2200;
      const ini = f.admissao.slice(0, 7);
      const reajuste = iso(mes(-5)).slice(0, 7);
      f.salarios = ini < reajuste ? [{ desde: ini, valor: base }, { desde: reajuste, valor: Math.round(base * 1.06) }] : [{ desde: ini, valor: base }];
      if (i % 4 === 0 && !semArquivos) {
        f.salarioDoc = await ctx.novoPdf(`contracheque-${slug(f.nome.split(' ')[0])}.pdf`, 'Contracheque (exemplo)', [`Colaborador: ${f.nome}`, `Competência: ${iso(mes(-1)).slice(0, 7)}`, 'Valores fictícios']);
      }
    }

    // Desmobilizado: PPP e ASO demissional (aba Desmobilizados).
    if (desligado) {
      f.ppp = await ctx.novoPdf(`ppp-${slug(f.nome.split(' ')[0])}.pdf`, 'PPP - Perfil Profissiográfico (exemplo)', [`Colaborador: ${f.nome}`, `Demissão: ${f.dataDemissao}`]);
      f.asoDemissional = await ctx.novoPdf(`aso-demissional-${slug(f.nome.split(' ')[0])}.pdf`, 'ASO demissional (exemplo)', [`Colaborador: ${f.nome}`, 'Resultado: APTO']);
    }
  }
}

// ===========================================================================
// 2. FORMULÁRIO DE ADMISSÃO — convites em todos os estados
// ===========================================================================

/**
 * Monta os convites de admissão (formato de normalizarAdmissao).
 * USO: const admissoes = await montarAdmissoes(ctx) // → [{ id:'ADM…', token:'<32hex>', status:'aguardando', … }, …]
 */
async function montarAdmissoes(ctx) {
  const { dia, ts, sha256 } = ctx;
  const token = (k) => sha256('admissao-demo:' + k).slice(0, 32);

  // Arquivos enviados pelo candidato (chave do formulário público → rótulo do servidor).
  const ROTULOS = {
    ctps: 'CTPS Digital + registros', foto: 'Foto 3x4', 'rg-doc': 'RG', 'cpf-doc': 'CPF', vacina: 'Cartão de Vacina',
    residencia: 'Comprovante de Residência', certidao: 'Certidão de Nascimento/Casamento', escolar: 'Histórico/Declaração Escolar',
    sus: 'Cartão do SUS', 'pis-doc': 'PIS/PASEP/NIT', cnh: 'CNH', 'conjuge-doc': 'Documentos do cônjuge',
  };
  const docCandidato = async (nome, chave, cor) => {
    if (chave === 'foto') {
      const m = await ctx.novaMidia(`foto-3x4-${slug(nome.split(' ')[0])}.png`, svgAvatar(nome, cor));
      return { chave, nome: ROTULOS[chave], id: m.id, tipo: m.tipo, nomeOriginal: m.nome };
    }
    const arq = `${chave}-${slug(nome.split(' ')[0])}.pdf`;
    const m = await ctx.novoPdf(arq, `${ROTULOS[chave]} (exemplo)`, [`Candidato(a): ${nome}`, 'Documento fictício enviado pelo formulário público']);
    return { chave, nome: ROTULOS[chave], id: m.id, tipo: m.tipo, nomeOriginal: arq };
  };
  const OBRIGATORIOS = ['ctps', 'foto', 'rg-doc', 'cpf-doc', 'vacina', 'residencia', 'certidao', 'escolar', 'sus', 'pis-doc'];

  const resposta = (nome, idx, extra = {}) => ({
    nome, cpf: ctx.cpfFake(60 + idx), rg: ctx.rgFake(60 + idx), pis: `000.${String(10000 + idx * 37).slice(0, 5)}.00-${idx % 10}`,
    titulo: `0000 ${String(1000 + idx * 13).slice(0, 4)} 00${idx}`, reservista: '', email: `${slug(nome.split(' ')[0])}.candidato@example.com`,
    endereco: `Rua das Demonstrações, ${300 + idx * 11} - Bairro Exemplo`, cidade: 'Campina Grande', estado: 'PB',
    banco: 'Banco Fictício (demo)', agencia: '0001', conta: `${10000 + idx * 7}-${idx % 10}`, pix: `${slug(nome.split(' ')[0])}.candidato@example.com`,
    escolaridade: 'Ensino Médio Completo', registro: '', bota: '41', macacao: 'G', obs: '', temDependentes: 'nao', ...extra,
  });

  const lista = [];
  const base = (extra) => ({
    id: ctx.id('ADM'), funcionarioId: '', empresa: 'NTE', nome: '', email: '', status: 'aguardando',
    validadeTs: 0, criadoPor: 'RH Demonstração', preenchidoTs: 0, ip: '', resposta: null, docs: [],
    aplicadoTs: 0, aplicadoPor: '', eventos: [], ...extra,
  });

  // A) Link enviado, aguardando o candidato (válido por mais 5 dias) — abre em /admissao/<token>.
  lista.push(base({
    token: token('A'), ts: ts(dia(-2)), validadeTs: ts(dia(5)), nome: 'Rafael Monteiro Dantas', email: 'rafael.dantas@example.com',
    empresa: 'NTE', eventos: [{ ts: ts(dia(-2)), acao: 'criado', quem: 'RH Demonstração', detalhe: 'validade 7 dia(s)' }],
  }));

  // B) Rascunho: o candidato já subiu 2 arquivos (docsPendentes) mas ainda não enviou. Link regerado uma vez.
  const pendB = [await docCandidato('Vanessa Albuquerque Lins', 'rg-doc'), await docCandidato('Vanessa Albuquerque Lins', 'foto', '#be123c')];
  lista.push(base({
    token: token('B'), ts: ts(dia(-9)), validadeTs: ts(dia(4)), nome: 'Vanessa Albuquerque Lins', email: 'vanessa.lins@example.com', empresa: 'SUL',
    docsPendentes: pendB.map(d => ({ chave: d.chave, id: d.id, nome: d.nomeOriginal, tipo: d.tipo })),
    eventos: [
      { ts: ts(dia(-9)), acao: 'criado', quem: 'RH Demonstração', detalhe: 'validade 7 dia(s)' },
      { ts: ts(dia(-3)), acao: 'regerado', quem: 'Gestor Demonstração', detalhe: '7 dia(s)' },
    ],
  }));

  // C) Preenchido, aguardando revisão — completo, com dependentes e todos os obrigatórios.
  const nomeC = 'Sabrina Lopes Carvalho';
  const docsC = [];
  for (const ch of [...OBRIGATORIOS, 'conjuge-doc']) docsC.push(await docCandidato(nomeC, ch, '#7c3aed'));
  lista.push(base({
    token: token('C'), ts: ts(dia(-6)), validadeTs: ts(dia(1)), nome: nomeC, email: 'sabrina.carvalho@example.com', empresa: 'SUL',
    status: 'preenchido', preenchidoTs: ts(dia(-1)), ip: '203.0.113.24',
    resposta: resposta(nomeC, 1, {
      cidade: 'Paulo Afonso', estado: 'BA', escolaridade: 'Técnico', registro: 'CRT-DEMO 00012', bota: '38', macacao: 'M',
      obs: 'Disponível para início imediato (exemplo).', temDependentes: 'sim',
      conjuge: { nome: 'Cônjuge Exemplo da Silva', cpf: ctx.cpfFake(71), rg: ctx.rgFake(71) },
      filhos: [{ nome: 'Filho Exemplo Carvalho', nascimento: ctx.iso(ctx.mes(-80)), cpf: ctx.cpfFake(72) }],
    }),
    docs: docsC,
    eventos: [
      { ts: ts(dia(-6)), acao: 'criado', quem: 'RH Demonstração', detalhe: 'validade 7 dia(s)' },
      { ts: ts(dia(-1)), acao: 'preenchido', quem: '', detalhe: `IP 203.0.113.24 · ${docsC.length} doc(s)` },
    ],
  }));

  // D) Preenchido, aguardando revisão — sem dependentes, só parte dos documentos (revisão mostra o que falta).
  const nomeD = 'Otávio Rezende Prado';
  const docsD = [];
  for (const ch of ['ctps', 'foto', 'rg-doc', 'cpf-doc', 'residencia', 'cnh']) docsD.push(await docCandidato(nomeD, ch, '#0369a1'));
  lista.push(base({
    token: token('D'), ts: ts(dia(-4)), validadeTs: ts(dia(3)), nome: nomeD, email: 'otavio.prado@example.com', empresa: 'NTE',
    status: 'preenchido', preenchidoTs: ts(dia(-2)), ip: '198.51.100.7',
    resposta: resposta(nomeD, 2, { cidade: 'Natal', estado: 'RN', escolaridade: 'Ensino Médio Completo', bota: '43', macacao: 'GG' }),
    docs: docsD,
    eventos: [
      { ts: ts(dia(-4)), acao: 'criado', quem: 'RH Demonstração', detalhe: 'validade 7 dia(s)' },
      { ts: ts(dia(-2)), acao: 'preenchido', quem: '', detalhe: `IP 198.51.100.7 · ${docsD.length} doc(s)` },
    ],
  }));

  // E) Aplicado ao cadastro — atualização cadastral da Natália (vínculo com funcionário existente).
  const nat = ctx.funcionarios[13];
  const docsE = [];
  for (const ch of ['ctps', 'foto', 'rg-doc', 'cpf-doc', 'residencia']) docsE.push(await docCandidato(nat.nome, ch, '#4d7c0f'));
  lista.push(base({
    token: token('E'), ts: ts(dia(-30)), validadeTs: ts(dia(-23)), funcionarioId: nat.id, nome: nat.nome, email: nat.email, empresa: nat.empresa,
    status: 'aplicado', preenchidoTs: ts(dia(-27)), ip: '192.0.2.55', aplicadoTs: ts(dia(-26)), aplicadoPor: 'RH Demonstração',
    resposta: resposta(nat.nome, 3, { cpf: nat.cpf, rg: nat.rg, cidade: 'Campina Grande', estado: 'PB', bota: '37', macacao: 'P', email: nat.email }),
    docs: docsE,
    eventos: [
      { ts: ts(dia(-30)), acao: 'criado', quem: 'RH Demonstração', detalhe: 'validade 7 dia(s)' },
      { ts: ts(dia(-27)), acao: 'preenchido', quem: '', detalhe: `IP 192.0.2.55 · ${docsE.length} doc(s)` },
      { ts: ts(dia(-26)), acao: 'aplicado', quem: 'RH Demonstração', detalhe: '' },
    ],
  }));

  // F) Expirado — link venceu sem o candidato preencher.
  lista.push(base({
    token: token('F'), ts: ts(dia(-20)), validadeTs: ts(dia(-13)), nome: 'Leandro Fontes Barcelos', email: 'leandro.barcelos@example.com', empresa: 'SUL',
    eventos: [{ ts: ts(dia(-20)), acao: 'criado', quem: 'Gestor Demonstração', detalhe: 'validade 7 dia(s)' }],
  }));

  // G) Cancelado — candidato desistiu da vaga.
  lista.push(base({
    token: token('G'), ts: ts(dia(-15)), validadeTs: ts(dia(-8)), nome: 'Priscila Nogueira Matos', email: 'priscila.matos@example.com', empresa: 'NTE',
    status: 'cancelado', eventos: [{ ts: ts(dia(-15)), acao: 'criado', quem: 'RH Demonstração', detalhe: 'validade 7 dia(s)' }],
  }));

  return lista;
}

// ===========================================================================
// 3. INTEGRAÇÃO — treinamentos, convites (todos os estados) e conclusões
// ===========================================================================

/**
 * Questão de múltipla escolha no formato de normalizarTreinamento. `correta` é o ID da
 * alternativa (não o índice) — id inexistente zeraria o gabarito em silêncio.
 * USO: questao('q1', 'Qual EPI…?', ['Capacete', 'Boné'], 0)
 *      → { id:'q1', enunciado:'Qual EPI…?', alternativas:[{id:'q1a',texto:'Capacete'},{id:'q1b',…}], correta:'q1a' }
 */
function questao(qid, enunciado, textos, certa) {
  const alternativas = textos.map((texto, k) => ({ id: qid + 'abcde'[k], texto }));
  return { id: qid, enunciado, alternativas, correta: alternativas[certa].id };
}

/**
 * Treinamentos + convites + conclusões. Também anexa o atestado (PDF) na ficha de quem foi
 * aprovado, como o servidor faz em emitirAtestado().
 * USO: const { treinamentos, convites, conclusoes } = await montarIntegracao(ctx)
 */
async function montarIntegracao(ctx) {
  const { dia, mes, ts, sha256 } = ctx;
  const F = ctx.funcionarios;
  const treinamentos = [
    {
      id: ctx.id('TRN'), ts: ts(mes(-14)), titulo: 'NR-06 - Uso correto de EPI', tipo: 'NR', validadeMeses: 12,
      fileId: 'DEMO_video_ficticio_NR06_0001',
      descricao: 'Treinamento de demonstração sobre seleção, uso, guarda e conservação dos equipamentos de proteção individual.',
      questoes: [
        questao('n6q1', 'Quem deve fornecer o EPI ao trabalhador gratuitamente?', ['O próprio trabalhador', 'O empregador', 'O sindicato'], 1),
        questao('n6q2', 'O que é o CA de um EPI?', ['Certificado de Aprovação emitido pelo órgão competente', 'Código de Armazenagem', 'Cadastro de Almoxarifado'], 0),
        questao('n6q3', 'O EPI danificado deve ser:', ['Usado até o fim do turno', 'Consertado com fita', 'Comunicado e substituído'], 2),
        questao('n6q4', 'A higienização do EPI é responsabilidade de:', ['Ninguém', 'Trabalhador, conforme orientação recebida', 'Somente do fabricante'], 1),
      ],
    },
    {
      id: ctx.id('TRN'), ts: ts(mes(-12)), titulo: 'NR-35 - Trabalho em Altura', tipo: 'NR', validadeMeses: 24,
      fileId: 'DEMO_video_ficticio_NR35_0002',
      descricao: 'Conteúdo de demonstração: análise de risco, sistemas de proteção contra quedas e resgate.',
      questoes: [
        questao('n35q1', 'Trabalho em altura é toda atividade executada acima de:', ['1,0 m', '2,0 m', '5,0 m'], 1),
        questao('n35q2', 'Antes de iniciar o trabalho em altura é obrigatório:', ['Análise de risco e permissão de trabalho', 'Apenas avisar o colega', 'Nada, se for rápido'], 0),
        questao('n35q3', 'O talabarte deve ser conectado:', ['Abaixo da cintura', 'A um ponto de ancoragem adequado', 'Em qualquer estrutura'], 1),
      ],
    },
    {
      id: ctx.id('TRN'), ts: ts(mes(-3)), titulo: 'Integração de Segurança - Novos Colaboradores', tipo: 'curso', validadeMeses: 0,
      fileId: '',
      descricao: 'Curso de boas-vindas (demonstração): regras da obra, rotas de fuga, uso de EPI e canais de comunicação. Sem vídeo configurado de propósito.',
      questoes: [
        questao('intq1', 'Ao ouvir o alarme de emergência você deve:', ['Seguir a rota de fuga até o ponto de encontro', 'Terminar a tarefa', 'Ligar para casa'], 0),
        questao('intq2', 'Quando um acidente acontecer, quem deve ser avisado primeiro?', ['Ninguém', 'O líder imediato / técnico de segurança', 'Somente o RH no fim do mês'], 1),
      ],
    },
  ];
  const [nr06, nr35, integ] = treinamentos;

  const convites = [];
  const conclusoes = [];
  const tok = (k) => sha256('treinamento-demo:' + k).slice(0, 32);
  const digitos = (cpf) => String(cpf).replace(/\D/g, '');
  const conv = (k, f, t, extra) => {
    const c = {
      id: ctx.id('TCV'), token: tok(k), ts: ts(dia(-7)), funcionarioId: f.id, nome: f.nome, treinamentoId: t.id,
      status: 'aguardando', validadeTs: ts(dia(7)), criadoPor: 'RH Demonstração', regeradoTs: 0, regeradoPor: '', regeracoes: 0,
      acessadoTs: 0, ultimoAcessoTs: 0, acessoCpf: '', acessos: 0, video: null, comentarios: [], ...extra,
    };
    if (c.acessadoTs) { c.acessoCpf = digitos(f.cpf); c.acessos = c.acessos || 1; c.ultimoAcessoTs = c.ultimoAcessoTs || c.acessadoTs; }
    convites.push(c);
    return c;
  };
  const tentativa = (c, quando, nota) => {
    const k = { id: ctx.id('TCC'), funcionarioId: c.funcionarioId, treinamentoId: c.treinamentoId, conviteId: c.id, ts: ts(quando), nota, aprovado: nota >= 80 };
    conclusoes.push(k);
    return k;
  };
  // Atestado anexado à ficha do colaborador aprovado (mesma forma do emitirAtestado do servidor).
  const atestado = async (f, t, quando) => {
    const pdf = await ctx.novoPdf(`atestado_${slug(t.titulo).replace(/-/g, '_')}_${slug(f.nome.split(' ')[0])}.pdf`, 'Atestado de treinamento (exemplo)',
      [`Colaborador: ${f.nome}`, `Treinamento: ${t.titulo}`, `Aprovado em: ${ctx.br(quando)}`]);
    let validade = '';
    if (t.validadeMeses) { const d = new Date(quando); d.setMonth(d.getMonth() + t.validadeMeses); validade = ctx.iso(d); }
    f.documentos = Array.isArray(f.documentos) ? f.documentos : [];
    f.documentos.push({ id: pdf.id, nome: t.titulo, tipo: pdf.tipo, categoria: 'Segurança', validade, emissao: ctx.iso(quando), semValidade: !validade,
      nomeOriginal: pdf.nome, uploadTs: ts(quando), uploadPor: 'Treinamento aprovado', versoes: [] });
  };

  // --- Enviados, ainda não abertos ---
  conv('env1', F[3], integ, { ts: ts(dia(-1)), validadeTs: ts(dia(6)) });
  conv('env2', F[11], nr06, { ts: ts(dia(-2)), validadeTs: ts(dia(5)) });

  // --- Em andamento: abriu e ainda não fez a prova ---
  conv('and1', F[8], nr06, { ts: ts(dia(-3)), validadeTs: ts(dia(4)), acessadoTs: ts(dia(-2)), acessos: 2,
    comentarios: [{ id: ctx.id('TCM'), ts: ts(dia(-2)), avaliacao: 'ok', texto: 'Consegui assistir pelo celular sem problemas.' }] });

  // --- Reprovado, pode refazer (link ainda valendo) + comentário de problema ---
  const rep = conv('rep1', F[9], nr06, { ts: ts(dia(-5)), validadeTs: ts(dia(3)), acessadoTs: ts(dia(-4)), acessos: 3,
    comentarios: [{ id: ctx.id('TCM'), ts: ts(dia(-4)), avaliacao: 'problema', texto: 'O vídeo travou duas vezes no meio (exemplo de comentário).' }] });
  tentativa(rep, dia(-4), 50);

  // --- Vencendo em até 2 dias (aguardando) ---
  conv('venc1', F[2], integ, { ts: ts(dia(-6)), validadeTs: ts(dia(1)) });
  conv('venc2', F[13], nr35, { ts: ts(dia(-6)), validadeTs: ts(dia(2)), acessadoTs: ts(dia(-1)), status: 'aguardando' });

  // --- Concluídos (aprovados) ---
  const ap1 = conv('ok1', F[4], nr35, { ts: ts(dia(-40)), validadeTs: ts(dia(-33)), status: 'concluido', acessadoTs: ts(dia(-39)), acessos: 2 });
  tentativa(ap1, dia(-39), 60);
  const k1 = tentativa(ap1, dia(-38), 100);
  await atestado(F[4], nr35, new Date(k1.ts));

  const ap2 = conv('ok2', F[0], nr06, { ts: ts(dia(-15)), validadeTs: ts(dia(-8)), status: 'concluido', acessadoTs: ts(dia(-14)),
    comentarios: [{ id: ctx.id('TCM'), ts: ts(dia(-14)), avaliacao: 'ok', texto: 'Conteúdo claro, gostei das perguntas.' }] });
  const k2 = tentativa(ap2, dia(-14), 100);
  await atestado(F[0], nr06, new Date(k2.ts));

  // Certificado perto de vencer: aprovado há ~11,5 meses num treinamento de 12 meses.
  const ap3 = conv('ok3', F[10], nr06, { ts: ts(dia(-352)), validadeTs: ts(dia(-345)), status: 'concluido', acessadoTs: ts(dia(-351)) });
  const k3 = tentativa(ap3, dia(-350), 80);
  await atestado(F[10], nr06, new Date(k3.ts));

  const ap4 = conv('ok4', F[5], integ, { ts: ts(dia(-60)), validadeTs: ts(dia(-53)), status: 'concluido', acessadoTs: ts(dia(-59)) });
  const k4 = tentativa(ap4, dia(-59), 100);
  await atestado(F[5], integ, new Date(k4.ts));

  // --- Expirados ---
  conv('exp1', F[6], nr35, { ts: ts(dia(-25)), validadeTs: ts(dia(-18)) });                                             // nunca abriu
  const exp2 = conv('exp2', F[1], nr35, { ts: ts(dia(-20)), validadeTs: ts(dia(-13)), acessadoTs: ts(dia(-18)), acessos: 2 }); // reprovou e venceu
  tentativa(exp2, dia(-18), 33);
  // Link regerado que ainda assim venceu (mostra "novos links" no painel do convite).
  conv('exp3', F[7], integ, { ts: ts(dia(-30)), validadeTs: ts(dia(-4)), regeradoTs: ts(dia(-11)), regeradoPor: 'Gestor Demonstração', regeracoes: 1 });

  // --- Cancelado ---
  conv('canc1', F[12], nr06, { ts: ts(dia(-70)), validadeTs: ts(dia(-63)), status: 'cancelado' });

  return { treinamentos, convites, conclusoes };
}

// ===========================================================================
// 4. PROGRAMAS DE SST — por contrato, com validades variadas
// ===========================================================================

/**
 * USO: const programas = await montarProgramas(ctx) // → [{ id:'P…', tipo:'PCMSO', contratoNumero:'4600000101', documento:{…} }, …]
 */
async function montarProgramas(ctx) {
  const { dia, mes, iso, ts } = ctx;
  const contrato = (numero) => {
    for (const emp of ctx.CONTRATOS_CAT) {
      const c = emp.contratos.find(x => x.numero === numero);
      if (c) return { contratoNumero: numero, contratoNome: c.nome, local: c.frentes[0] || '', empresa: emp.sigla };
    }
    return { contratoNumero: numero, contratoNome: numero, local: '', empresa: '' };
  };
  const MEDICO = 'Dra. Médica do Trabalho Demo (CRM-DEMO 0001)';
  const ENG = 'Eng. de Segurança Demo (CREA-DEMO 0002)';
  const itens = [
    { tipo: 'PCMSO', ct: ctx.CT_SUL_BA, validade: iso(mes(7)), resp: MEDICO, pdf: true },
    { tipo: 'PGR', ct: ctx.CT_SUL_BA, validade: iso(dia(22)), resp: ENG, art: 'ART-DEMO-2025-0101', pdf: true },          // a vencer
    { tipo: 'LTCAT', ct: ctx.CT_SUL_BA, validade: iso(mes(14)), resp: ENG, art: 'ART-DEMO-2025-0102', pdf: false, obs: 'Original arquivado no escritório (sem cópia digital).' },
    { tipo: 'PCMSO', ct: ctx.CT_SUL_SEDE, validade: iso(dia(-12)), resp: MEDICO, pdf: true, obs: 'Renovação solicitada à clínica (exemplo).' }, // vencido
    { tipo: 'PGR', ct: ctx.CT_SUL_SEDE, validade: iso(mes(10)), resp: ENG, art: 'ART-DEMO-2026-0103', pdf: true },
    { tipo: 'PCMAT', ct: ctx.CT_NTE_ORION, validade: iso(mes(9)), resp: ENG, art: 'ART-DEMO-2026-0201', pdf: true },
    { tipo: 'PCMSO', ct: ctx.CT_NTE_ORION, validade: iso(mes(5)), resp: MEDICO, pdf: true },
    { tipo: 'PGR', ct: ctx.CT_NTE_ORION, validade: iso(mes(11)), resp: ENG, art: 'ART-DEMO-2026-0202', pdf: true },
    { tipo: 'PCMSO', ct: ctx.CT_NTE_LINHA, validade: iso(mes(2)), resp: MEDICO, pdf: true },
    { tipo: 'PGR', ct: ctx.CT_NTE_LINHA, validade: iso(dia(-30)), resp: ENG, art: 'ART-DEMO-2024-0203', pdf: true },        // vencido
    { tipo: 'PCA', ct: ctx.CT_NTE_LINHA, validade: iso(mes(6)), resp: ENG, pdf: true },
    { tipo: 'AVCB', ct: 'ESCRITORIO-NTE', validade: iso(dia(28)), resp: 'Corpo técnico de prevenção (demo)', pdf: true }, // a vencer
    { tipo: 'PCMSO', ct: 'ESCRITORIO-SUL', validade: iso(mes(8)), resp: MEDICO, pdf: true },
  ];
  const lista = [];
  for (let k = 0; k < itens.length; k++) {
    const it = itens[k];
    const c = contrato(it.ct);
    const anos = it.tipo === 'LTCAT' ? 24 : 12;
    const emissao = menosMeses(it.validade, anos);
    let documento = null;
    if (it.pdf) {
      const nome = `${slug(it.tipo)}-${slug(c.contratoNumero)}.pdf`;
      documento = await ctx.novoPdf(nome, `${it.tipo} - ${c.contratoNome} (exemplo)`, [
        `Empresa: ${c.empresa}`, `Contrato: ${c.contratoNumero} - ${c.contratoNome}`, `Frente: ${c.local || 'Escritório'}`,
        `Emissão: ${emissao}`, `Validade: ${it.validade}`, `Responsável técnico: ${it.resp}`, 'Conteúdo fictício para demonstração.',
      ]);
    }
    lista.push({
      id: ctx.id('P'), ts: ts(new Date(emissao + 'T12:00:00')), tipo: it.tipo, contratoNome: c.contratoNome, contratoNumero: c.contratoNumero,
      local: c.local, emissao, validade: it.validade, responsavel: it.resp, art: it.art || '', obs: it.obs || '', documento,
    });
  }
  return lista;
}

// ===========================================================================
// 5. TI — ativos (equipamento / linha / licença) + movimentações com termo assinado
// ===========================================================================

/**
 * USO: const { ativos, movimentacoes } = await montarTi(ctx)
 *      // ativos → [{ id:'TIA…', especie:'equipamento', tipo:'Notebook', … }]
 *      // movimentacoes → [{ id:'TIM…', tipo:'Entrega', snapshot:{…}, assinaturaHash:'<sha256>' … }]
 */
async function montarTi(ctx) {
  const { dia, mes, iso, ts, sha256 } = ctx;
  const F = ctx.funcionarios;
  const ativo = (extra) => ({
    id: ctx.id('TIA'), ts: ts(mes(-12)), especie: 'equipamento', descricao: '', local: 'Escritório', empresa: '', contratoNumero: '',
    centroCusto: 'SEDE', fornecedorId: '', valor: 0, notaFiscal: '', dataCompra: '', tipo: '', marca: '', modelo: '', numeroSerie: '',
    imei: '', processador: '', memoria: '', armazenamento: '', sistema: '', conservacao: 'Bom', garantiaAte: '', operadora: '', numero: '',
    plano: '', franquia: '', mensalidade: 0, tipoLinha: '', aparelhoId: '', ativacaoEm: '', fabricante: '', produto: '', modalidade: '',
    assentos: 0, custo: 0, periodicidade: '', renovaEm: '', contaAdmin: '', chave: '', anexos: [], obs: '', ativo: true, origem: 'MANUAL', historico: [],
    ...extra,
  });
  const nf = async (nome, linhas) => [await ctx.novoPdf(nome, 'Nota fiscal de compra (exemplo)', linhas)];

  // --- Equipamentos ---
  const nb1 = ativo({ tipo: 'Notebook', marca: 'Dell', modelo: 'Latitude Demo 14', numeroSerie: 'DEMO-NB-0001', processador: 'Core i5 (demo)', memoria: '16 GB', armazenamento: '512 GB SSD', sistema: 'Windows 11 Pro', valor: 5890, notaFiscal: '000.700.101', dataCompra: iso(mes(-7)), garantiaAte: iso(mes(29)), empresa: 'NTE', contratoNumero: ctx.CT_NTE_ORION, local: 'ORION', centroCusto: 'CAMPINA GRANDE', conservacao: 'Novo' });
  nb1.anexos = await nf('nf-notebook-demo-0001.pdf', ['Fornecedor: Loja de Informática Demo', 'Item: Notebook Latitude Demo 14', 'Valor: R$ 5.890,00']);
  const nb2 = ativo({ tipo: 'Notebook', marca: 'Lenovo', modelo: 'ThinkPad Demo E14', numeroSerie: 'DEMO-NB-0002', processador: 'Ryzen 5 (demo)', memoria: '8 GB', armazenamento: '256 GB SSD', sistema: 'Windows 11 Pro', valor: 4390, dataCompra: iso(mes(-9)), garantiaAte: iso(mes(3)), empresa: 'NTE' });
  const nb3 = ativo({ tipo: 'Notebook', marca: 'Dell', modelo: 'Vostro Demo 15', numeroSerie: 'DEMO-NB-0003', memoria: '8 GB', armazenamento: '256 GB SSD', sistema: 'Windows 10 Pro', valor: 3790, dataCompra: iso(mes(-30)), garantiaAte: iso(mes(-6)), empresa: 'NTE', conservacao: 'Regular' }); // garantia vencida
  const nb4 = ativo({ tipo: 'Notebook', marca: 'Lenovo', modelo: 'IdeaPad Demo 3', numeroSerie: 'DEMO-NB-0004', memoria: '8 GB', armazenamento: '512 GB SSD', sistema: 'Windows 11 Home', valor: 3290, dataCompra: iso(mes(-11)), garantiaAte: iso(dia(20)), empresa: 'SUL', conservacao: 'Novo' }); // garantia vencendo
  const cel1 = ativo({ tipo: 'Celular', marca: 'Samsung', modelo: 'Galaxy Demo A15', numeroSerie: 'DEMO-CEL-0001', imei: 'IMEI-DEMO-000001', valor: 1290, dataCompra: iso(mes(-4)), garantiaAte: iso(mes(8)), empresa: 'SUL', contratoNumero: ctx.CT_SUL_SEDE, centroCusto: 'SEDE' });
  cel1.anexos = await nf('nf-celular-demo-0001.pdf', ['Fornecedor: Loja de Celulares Demo', 'Item: Smartphone Galaxy Demo A15', 'Valor: R$ 1.290,00']);
  const cel2 = ativo({ tipo: 'Celular', marca: 'Motorola', modelo: 'Moto Demo G34', numeroSerie: 'DEMO-CEL-0002', imei: 'IMEI-DEMO-000002', valor: 1099, dataCompra: iso(mes(-1)), garantiaAte: iso(mes(11)), empresa: 'NTE', contratoNumero: ctx.CT_NTE_ORION, local: 'ORION', centroCusto: 'CAMPINA GRANDE', conservacao: 'Novo' });
  const cel3 = ativo({ tipo: 'Celular', marca: 'Samsung', modelo: 'Galaxy Demo A05', numeroSerie: 'DEMO-CEL-0003', imei: 'IMEI-DEMO-000003', valor: 899, dataCompra: iso(mes(-20)), garantiaAte: iso(mes(-8)), empresa: 'SUL', local: 'PAULO AFONSO', conservacao: 'Ruim' });
  const tab1 = ativo({ tipo: 'Tablet', marca: 'Samsung', modelo: 'Tab Demo A9', numeroSerie: 'DEMO-TAB-0001', valor: 1490, dataCompra: iso(mes(-8)), garantiaAte: iso(mes(4)), empresa: 'SUL', contratoNumero: ctx.CT_SUL_BA, local: 'PAULO AFONSO', centroCusto: 'PAULO AFONSO' });
  const mon1 = ativo({ tipo: 'Monitor', marca: 'LG', modelo: 'Demo 24 pol.', numeroSerie: 'DEMO-MON-0001', valor: 899, dataCompra: iso(mes(-9)), garantiaAte: iso(mes(15)) });
  const mon2 = ativo({ tipo: 'Monitor', marca: 'Samsung', modelo: 'Demo 27 pol.', numeroSerie: 'DEMO-MON-0002', valor: 1190, dataCompra: iso(mes(-5)), garantiaAte: iso(mes(19)), conservacao: 'Novo' });
  const imp1 = ativo({ tipo: 'Impressora', marca: 'Epson', modelo: 'EcoTank Demo L3250', numeroSerie: 'DEMO-IMP-0001', valor: 1150, dataCompra: iso(mes(-14)), garantiaAte: iso(mes(-2)) });
  imp1.anexos = await nf('nf-impressora-demo-0001.pdf', ['Fornecedor: Papelaria e Informática Demo', 'Item: Impressora EcoTank Demo', 'Valor: R$ 1.150,00']);
  const rot1 = ativo({ tipo: 'Roteador', marca: 'TP-Link', modelo: 'Archer Demo AX23', numeroSerie: 'DEMO-ROT-0001', valor: 420, dataCompra: iso(mes(-16)), garantiaAte: iso(mes(8)) });

  // --- Linhas / chips (operadora e número claramente fictícios) ---
  const lin1 = ativo({ especie: 'linha', operadora: 'Operadora Demo', numero: '(99) 90000-0001', plano: 'Corporativo 20 GB (demo)', franquia: '20 GB', mensalidade: 59.9, tipoLinha: 'ambos', aparelhoId: cel1.id, ativacaoEm: iso(mes(-4)), empresa: 'SUL', conservacao: '' });
  const lin2 = ativo({ especie: 'linha', operadora: 'Operadora Demo', numero: '(99) 90000-0002', plano: 'Corporativo 10 GB (demo)', franquia: '10 GB', mensalidade: 44.9, tipoLinha: 'ambos', aparelhoId: cel2.id, ativacaoEm: iso(mes(-1)), empresa: 'NTE', local: 'ORION', conservacao: '' });
  const lin3 = ativo({ especie: 'linha', operadora: 'Operadora Exemplo', numero: '(99) 90000-0003', plano: 'Dados 5 GB (demo)', franquia: '5 GB', mensalidade: 29.9, tipoLinha: 'dados', ativacaoEm: iso(mes(-6)), conservacao: '', obs: 'Chip reserva, sem aparelho (exemplo).' });

  // --- Licenças / contas (produtos e chaves fictícios) ---
  const licOffice = ativo({ especie: 'licenca', fabricante: 'Fornecedor de Software Demo', produto: 'Pacote de Escritório Corporativo', modalidade: 'assinatura', assentos: 10, custo: 450, periodicidade: 'mensal', renovaEm: iso(dia(15)), contaAdmin: 'ti.admin@example.com', chave: 'DEMO-OFFC-0000-0001', conservacao: '' });
  const licAv = ativo({ especie: 'licenca', fabricante: 'Segurança Digital Demo', produto: 'Antivírus Corporativo', modalidade: 'assinatura', assentos: 15, custo: 1800, periodicidade: 'anual', renovaEm: iso(dia(-5)), contaAdmin: 'ti.admin@example.com', chave: 'DEMO-AVIR-0000-0002', conservacao: '' });
  const licCad = ativo({ especie: 'licenca', fabricante: 'Engenharia Software Demo', produto: 'CAD 2D/3D Profissional', modalidade: 'perpetua', assentos: 2, custo: 0, chave: 'DEMO-CAD0-0000-0003', empresa: 'NTE', conservacao: '' });

  const ativos = [nb1, nb2, nb3, nb4, cel1, cel2, cel3, tab1, mon1, mon2, imp1, rot1, lin1, lin2, lin3, licOffice, licAv, licCad];

  // --- Movimentações ---
  const movs = [];
  let horaSeq = 0;
  const mov = (a, tipo, quando, extra = {}) => {
    horaSeq++;
    const m = {
      id: ctx.id('TIM'), ts: ts(quando) + horaSeq, tipo, ativoId: a.id, snapshot: snapshotAtivoTi(a), data: iso(quando),
      hora: `${String(8 + (horaSeq % 9)).padStart(2, '0')}:${String((horaSeq * 7) % 60).padStart(2, '0')}`,
      funcionarioId: '', funcionarioNome: '', funcionarioCpf: '', funcionarioCargo: '', empresa: a.empresa || '', contratoNumero: a.contratoNumero || '',
      local: a.local || '', localAnterior: '', condicao: '', motivo: '', responsavel: 'Equipe de TI (demo)', responsavelUsuario: 'gestor.demo', obs: '',
      assinatura: null, assinaturaNome: '', assinaturaEm: 0, assinaturaHash: '', assinaturaCodigo: '', assinaturaIp: '', assinaturaDispositivo: '',
      assinaturaModo: '', assinaturaAceite: false, ...extra,
    };
    movs.push(m);
    return m;
  };
  const paraPessoa = (f) => ({ funcionarioId: f.id, funcionarioNome: f.nome, funcionarioCpf: f.cpf, funcionarioCargo: f.cargo, empresa: f.empresa });
  // Assina o termo com o hash que o servidor recalcula (conteudoAssinadoTi).
  const assinar = async (m, f) => {
    m.assinatura = await ctx.novaAssinatura(f.nome);
    m.assinaturaNome = f.nome;
    m.assinaturaEm = m.ts + 60000;
    m.assinaturaHash = sha256(conteudoAssinadoTi(m));
    m.assinaturaCodigo = ctx.codigoVerificacao();
    m.assinaturaIp = `192.168.${ctx.inteiro(0, 8)}.${ctx.inteiro(2, 250)}`;
    m.assinaturaDispositivo = ctx.escolher(['Chrome · Android · celular', 'Chrome · Windows · computador', 'Safari · iOS · celular']);
    m.assinaturaModo = ctx.escolher(['desenho', 'digitado']);
    m.assinaturaAceite = true;
    return m;
  };

  // Entrada de tudo (compra/ativação).
  for (const a of ativos) {
    const quando = new Date((a.dataCompra || a.ativacaoEm || iso(mes(-12))) + 'T09:00:00');
    mov(a, 'Entrada', quando, { motivo: a.especie === 'licenca' ? 'Contratação' : a.especie === 'linha' ? 'Ativação da linha' : 'Compra', condicao: a.especie === 'equipamento' ? 'Novo' : '' });
  }
  // Entregas assinadas (termo de responsabilidade).
  await assinar(mov(nb1, 'Entrega', mes(-6), { ...paraPessoa(F[1]), condicao: 'Novo', motivo: 'Uso na obra' }), F[1]);
  await assinar(mov(nb2, 'Entrega', mes(-8), { ...paraPessoa(F[3]), condicao: 'Bom', motivo: 'Uso administrativo' }), F[3]);
  mov(nb2, 'Manutenção', dia(-45), { motivo: 'Teclado com falha — enviado à assistência (exemplo)', obs: 'Aguardando peça' }); // manutenção longa (>30 dias)
  await assinar(mov(nb3, 'Entrega', mes(-10), { ...paraPessoa(F[7]), condicao: 'Bom' }), F[7]);
  await assinar(mov(nb3, 'Devolução', dia(-20), { ...paraPessoa(F[7]), condicao: 'Regular', motivo: 'Troca de função' }), F[7]);
  await assinar(mov(cel1, 'Entrega', mes(-3), { ...paraPessoa(F[2]), condicao: 'Novo', motivo: 'Comunicação em rota' }), F[2]);
  await assinar(mov(lin1, 'Entrega', mes(-3), { ...paraPessoa(F[2]), motivo: 'Linha do celular corporativo' }), F[2]);
  mov(cel2, 'Entrega', dia(-4), { ...paraPessoa(F[13]), condicao: 'Novo', motivo: 'Uso em campo' });                     // SEM termo assinado (alerta)
  mov(lin2, 'Entrega', dia(-4), { ...paraPessoa(F[13]), motivo: 'Linha do celular corporativo' });
  await assinar(mov(cel3, 'Entrega', mes(-12), { ...paraPessoa(F[12]), condicao: 'Bom' }), F[12]);
  await assinar(mov(cel3, 'Devolução', mes(-2), { ...paraPessoa(F[12]), condicao: 'Ruim', motivo: 'Desligamento' }), F[12]);
  mov(cel3, 'Baixa', dia(-10), { motivo: 'Tela quebrada, conserto inviável (exemplo)' });
  await assinar(mov(tab1, 'Entrega', mes(-5), { ...paraPessoa(F[0]), condicao: 'Bom', motivo: 'Checklists de campo' }), F[0]);
  mov(tab1, 'Extravio', dia(-30), { ...paraPessoa(F[0]), motivo: 'Extraviado na frente de obra — boletim registrado (exemplo)' });
  await assinar(mov(mon1, 'Entrega', mes(-8), { ...paraPessoa(F[3]), condicao: 'Novo' }), F[3]);
  mov(mon2, 'Transferência', dia(-50), { local: 'ORION', localAnterior: 'Escritório', motivo: 'Apoio ao escritório de obra' });
  mon2.local = 'ORION';
  mov(imp1, 'Manutenção', dia(-12), { motivo: 'Limpeza de cabeça de impressão' });
  mov(imp1, 'Retorno de manutenção', dia(-3), { condicao: 'Bom', motivo: 'Serviço concluído' });
  // Assentos de licença.
  mov(licOffice, 'Atribuição de assento', mes(-6), paraPessoa(F[1]));
  mov(licOffice, 'Atribuição de assento', mes(-6), paraPessoa(F[3]));
  mov(licOffice, 'Atribuição de assento', mes(-6), paraPessoa(F[7]));
  mov(licOffice, 'Revogação de assento', dia(-20), paraPessoa(F[7]));
  mov(licAv, 'Atribuição de assento', mes(-10), paraPessoa(F[3]));
  mov(licCad, 'Atribuição de assento', mes(-6), paraPessoa(F[1]));

  return { ativos, movimentacoes: movs.sort((x, y) => x.ts - y.ts) };
}

// ===========================================================================
// 6. DOCUMENTOS DA EMPRESA — pastas e documentos institucionais com PDF
// ===========================================================================

/**
 * Acrescenta pastas/subpastas e documentos ao objeto ctx.documentos ({pastas, documentos}).
 * USO: await enriquecerDocumentosEmpresa(ctx) // muta ctx.documentos no lugar
 */
async function enriquecerDocumentosEmpresa(ctx) {
  const { dia, mes, iso, ts } = ctx;
  const est = ctx.documentos;
  if (!est || !Array.isArray(est.pastas) || !Array.isArray(est.documentos)) return;
  const pasta = (nome, pai) => {
    const p = { id: ctx.id('PD'), nome, pastaPaiId: pai || '', criadoEm: ts(mes(-8)), atualizadoEm: ts(mes(-8)), atualizadoPor: 'admin' };
    est.pastas.push(p);
    return p.id;
  };
  const pCert = pasta('Certidões');
  const pFed = pasta('Federais', pCert);
  const pSoc = pasta('Societário');
  const pSeg = pasta('Seguros e apólices');
  const pNte = pasta('Norte Engenharia (NTE)', pSoc);
  const pSul = pasta('Sul Empreendimentos (SUL)', pSoc);
  // A certidão negativa que o seed principal deixou sem arquivo ganha um PDF e vai para Federais.
  for (const d of est.documentos) {
    if (!d.arquivo && /certid/i.test(d.titulo || '')) {
      d.arquivo = await ctx.novoPdf('certidao-negativa-demo.pdf', 'Certidão negativa (exemplo)', ['Situação: vencida (exemplo)', 'Documento fictício']);
      d.pastaId = pFed;
    }
  }
  const doc = async (pastaId, titulo, categoria, validade, linhas, criado) => {
    const nome = `${slug(titulo)}.pdf`;
    est.documentos.push({
      id: ctx.id('DE'), ts: ts(criado || mes(-4)), pastaId, titulo, categoria, descricao: 'Documento fictício para demonstração.',
      validade: validade || '', arquivo: await ctx.novoPdf(nome, titulo, [...linhas, 'Nenhum dado real.']),
      atualizadoEm: ts(criado || mes(-4)), atualizadoPor: 'admin',
    });
  };
  await doc(pFed, 'CND Federal - Norte Engenharia (exemplo)', 'Certidões', iso(dia(12)), ['Empresa: NORTE ENGENHARIA (DEMO)', 'CNPJ: 00.000.000/0001-00 (fictício)'], mes(-5));
  await doc(pFed, 'CRF do FGTS - Sul Empreendimentos (exemplo)', 'Certidões', iso(dia(24)), ['Empresa: SUL EMPREENDIMENTOS (DEMO)', 'CNPJ: 00.000.000/0002-00 (fictício)'], dia(-6));
  await doc(pCert, 'Certidão trabalhista - Norte Engenharia (exemplo)', 'Certidões', iso(mes(5)), ['Empresa: NORTE ENGENHARIA (DEMO)'], dia(-20));
  await doc(pNte, 'Contrato social consolidado - NTE (exemplo)', 'Societário', '', ['Empresa: NORTE ENGENHARIA (DEMO)', 'Última alteração: exemplo'], mes(-10));
  await doc(pSul, 'Contrato social consolidado - SUL (exemplo)', 'Societário', '', ['Empresa: SUL EMPREENDIMENTOS (DEMO)'], mes(-11));
  await doc(pSoc, 'Procuração para representação (exemplo)', 'Societário', iso(mes(6)), ['Outorgante: NORTE ENGENHARIA (DEMO)', 'Outorgado: Procurador Demonstração'], mes(-2));
  await doc(pSeg, 'Apólice de seguro de responsabilidade civil (exemplo)', 'Seguros', iso(mes(9)), ['Seguradora: Seguradora Demonstração', 'Apólice: AP-DEMO-0001'], mes(-3));
  await doc(pSeg, 'Seguro de vida em grupo (exemplo)', 'Seguros', iso(dia(-3)), ['Seguradora: Seguradora Demonstração', 'Apólice: AP-DEMO-0002'], mes(-12));
}

// ===========================================================================
// 7. EPI — notas fiscais COM anexo (a sub-aba "Notas Fiscais (NF)" vinha só com anexo vazio)
// ===========================================================================

/**
 * Reescreve epi_notas_fiscais.json: as 4 notas do seed principal (mesmos números, que amarram
 * com as Entradas de EPI) agora com o PDF da nota, mais uma compra no mês corrente para o
 * indicador "Gasto no mês" do dashboard não ficar zerado. O arquivo devolvido por este módulo
 * é gravado DEPOIS do principal, então prevalece.
 * ⚠ Se mudar montarEpiNotasFiscais() no seed-mock.js, mude aqui também.
 * USO: const notas = await montarEpiNotas(ctx) // → [{ id:'EPI-NF…', numero:'000.145.902', anexo:{ id, nome, tipo:'application/pdf' }, … }]
 */
async function montarEpiNotas(ctx) {
  const { dia, mes, iso, ts } = ctx;
  const inicioMes = new Date(ctx.HOJE.getFullYear(), ctx.HOJE.getMonth(), 1, 12);
  const base = [
    { numero: '000.145.902', fornecedor: 'Distribuidora Norte Peças', dataCompra: iso(mes(-5)), descricao: 'Luvas isolantes classe 2 (40 pares) e capacetes classe B (25 un)', valorTotal: 8740.50, parcelas: 2, centroCusto: 'NATAL', contratoNumero: '4500000404', contrato: '4500000404 - MANUTENÇÃO DE LINHA - DEMO', pdf: true },
    { numero: '000.152.771', fornecedor: 'SegurMax Exemplo', dataCompra: iso(mes(-2)), descricao: 'Protetores auriculares (120 pares) e luvas de vaqueta (60 pares)', valorTotal: 3120.00, parcelas: 1, centroCusto: 'PAULO AFONSO', contratoNumero: '4600000101', contrato: '4600000101 - MANUTENÇÃO CIVIL - DEMO BAHIA', pdf: true },
    { numero: '000.158.310', fornecedor: 'Protec Demo', dataCompra: iso(mes(-1)), descricao: 'Cintos paraquedista com talabarte duplo (6 un)', valorTotal: 5490.90, parcelas: 3, centroCusto: 'NATAL', contratoNumero: '4500000404', contrato: '4500000404 - MANUTENÇÃO DE LINHA - DEMO', pdf: true },
    { numero: '000.160.044', fornecedor: 'EquipaSafe Teste', dataCompra: iso(dia(-9)), descricao: 'Máscaras de solda automáticas (4 un)', valorTotal: 2360.00, parcelas: 1, centroCusto: 'CAMPINA GRANDE', pdf: false },
    { numero: '000.163.517', fornecedor: 'SegurMax Exemplo', dataCompra: iso(inicioMes), descricao: 'Respiradores PFF2 (50 un) e óculos de proteção (20 un)', valorTotal: 1875.40, parcelas: 1, centroCusto: 'SEDE', contratoNumero: '4500000202', contrato: '4500000202 - MANUTENÇÃO CIVIL - DEMO SEDE', pdf: true },
  ];
  const notas = [];
  for (let i = 0; i < base.length; i++) {
    const { pdf, ...n } = base[i];
    const anexo = pdf
      ? await ctx.novoPdf(`nf-epi-${n.numero.replace(/\D/g, '')}.pdf`, `Nota fiscal ${n.numero} (exemplo)`, [
        `Fornecedor: ${n.fornecedor}`, `Data da compra: ${n.dataCompra}`, `Descrição: ${n.descricao}`,
        `Valor total: R$ ${n.valorTotal.toFixed(2).replace('.', ',')}`, `Parcelas: ${n.parcelas}`, 'CNPJ do emitente: 00.000.000/0000-00 (fictício)'])
      : null;
    notas.push({ id: ctx.id('EPI-NF'), ts: ts(new Date(n.dataCompra + 'T12:00:00')), contrato: '', contratoNumero: '', ...n, observacoes: '', anexo, lancadoPor: 'Juliana Cardoso Peçanha' });
  }
  return notas;
}

// ===========================================================================
// Entrada do módulo
// ===========================================================================
exports.montar = async (ctx) => {
  await enriquecerFuncionarios(ctx);
  const admissoes = await montarAdmissoes(ctx);
  const { treinamentos, convites, conclusoes } = await montarIntegracao(ctx);
  const programas = await montarProgramas(ctx);
  const { ativos, movimentacoes } = await montarTi(ctx);
  await enriquecerDocumentosEmpresa(ctx);
  const epiNotas = await montarEpiNotas(ctx);
  return {
    'epi_notas_fiscais.json': { notas: epiNotas },
    'admissoes.json': { admissoes },
    'treinamentos.json': { treinamentos },
    'treinamento_convites.json': { treinamentoConvites: convites },
    'treinamento_conclusoes.json': { treinamentoConclusoes: conclusoes },
    'programas.json': { programas },
    'ti_ativos.json': { ativos },
    'ti_movimentacoes.json': { movimentacoes },
  };
};
