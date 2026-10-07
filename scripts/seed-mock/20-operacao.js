/**
 * seed-mock/20-operacao.js — completa o grupo OPERAÇÃO / FROTA da base de demonstração.
 *
 * O seed principal (scripts/seed-mock.js) cria as entidades "nuas": veículo sem CRLV, multa sem
 * anexo, instalação sem foto, Locações vazia, Vistorias e Notas fiscais da oficina inexistentes.
 * Este módulo pendura nelas arquivos de exemplo (PDFs e fotos FICTÍCIOS no cofre de mídia) e cria
 * as coleções que faltavam, para nenhuma aba do grupo abrir vazia na demonstração.
 *
 * Tudo aqui é inventado: empresas "Norte Engenharia" (NTE) e "Sul Empreendimentos" (SUL), cliente
 * "Delta Energia", placas de prefixo MOK/DEM/TST/LOC, renavam/chassi gerados e e-mails @example.com.
 *
 * Todo anexo criado aqui está num campo que `midiasReferenciadas()` (backend/server.js) enxerga —
 * senão a faxina de órfãs apagaria o arquivo ~1h depois de o servidor subir:
 *   veiculo.crlvDoc · vistorias[].fotos · oficina[].anexo · multa.documentos[] · termos_multas[].arquivo
 *   instalacoes[].fotos (e os eventos de vínculo) · envios[].comprovantes · feedbacks[].imagens
 *   locacoes.config.contratos[].documentos · locacoes_faturas[].arquivo
 *
 * USO (o seed principal chama sozinho):
 *   const extras = await require('./seed-mock/20-operacao').montar(ctx);
 *   // → { 'vistorias.json': {...}, 'oficina.json': {...}, 'termos_multas.json': {...},
 *   //     'locacoes.json': {...}, 'locacoes_faturas.json': {...}, 'rastreadores_vinculos.json': {...} }
 */
'use strict';

const PizZip = require('pizzip');
const { recuperarLegado } = require('../../backend/rastreador-vinculos');

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const QUEM = 'Gestor Demo';

// ---------------------------------------------------------------------------
// Utilitários
// ---------------------------------------------------------------------------

// ISO (aaaa-mm-dd) → dd/mm/aaaa; o que já está em BR (ou vazio) volta igual.
// USO: paraBR('2026-08-12') → '12/08/2026'   ·   paraBR('12/08/2026') → '12/08/2026'
function paraBR(valor) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(valor || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (valor || '');
}

// dd/mm/aaaa → Date (meio-dia local, como o resto do seed). USO: deBR('12/08/2026') → Date
function deBR(valor) {
  const [d, m, a] = String(valor).split('/').map(Number);
  return new Date(a, m - 1, d, 12);
}

// Texto → trecho de nome de arquivo/e-mail, sem acento. USO: slug('Notificação de autuação', '-') → 'notificacao-de-autuacao'
function slug(texto, sep = '-') {
  const limpo = String(texto).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, sep);
  return limpo.split(sep).filter(Boolean).join(sep);
}

// Valor em reais no padrão brasileiro. USO: reais(1234.5) → 'R$ 1.234,50'
function reais(v) {
  return 'R$ ' + Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------------------------------------------------------------------------
// FROTA — CRLV de exemplo, dados de oficina/compra e vistorias
// ---------------------------------------------------------------------------

// PDF de um CRLV fictício do veículo (placa, renavam e chassi já são inventados pelo seed).
// USO: v.crlvDoc = await crlvDoVeiculo(ctx, v) → { id: 'MD-…', nome: 'CRLV-MOK1A01.pdf', tipo: 'application/pdf' }
async function crlvDoVeiculo(ctx, v) {
  return ctx.novoPdf(`CRLV-${v.placa}.pdf`, 'CRLV-e - Certificado de Registro e Licenciamento (exemplo)', [
    `Exercício: ${v.doc || ctx.HOJE.getFullYear()}`,
    '',
    `Placa: ${v.placa}`,
    `Código Renavam: ${v.renavam}`,
    `Chassi: ${v.chassi}`,
    `Marca/Modelo/Versão: ${v.modelo} ${v.versao}`,
    `Ano fabricação/modelo: ${v.anoFab}/${v.anoMod}`,
    `Cor predominante: ${v.cor}`,
    `Motor: ${v.motor}`,
    `Proprietário: ${String(v.dono || '').toUpperCase()} (DEMONSTRAÇÃO)`,
    `Município de registro: ${ctx.escolher(['Paulo Afonso/BA', 'Natal/RN', 'Campina Grande/PB'])}`,
    `Restrição: ${/alienado/i.test(v.gravame || '') ? 'ALIENAÇÃO FIDUCIÁRIA - ' + (v.banco || 'banco') : 'NADA CONSTA'}`,
    '',
    'Documento gerado para a base de demonstração. Não tem validade legal.',
  ]);
}

// Completa os veículos: CRLV em todos menos o último (fica um "sem CRLV" para a tela mostrar o
// estado vazio), dados de entrada na oficina e mais duas compras para a sub-aba Comprados.
// USO: const n = await completarVeiculos(ctx) → quantidade de CRLVs anexados
async function completarVeiculos(ctx) {
  let crlvs = 0;
  const motivos = ['Troca de embreagem', 'Revisão da suspensão dianteira', 'Reparo no sistema de arrefecimento'];
  for (const [i, v] of ctx.veiculos.entries()) {
    if (i < ctx.veiculos.length - 1) { v.crlvDoc = await crlvDoVeiculo(ctx, v); crlvs++; }
    if (v.status === 'OFICINA') {
      v.oficinaDataEntrada = ctx.iso(ctx.dia(-ctx.inteiro(3, 9)));
      v.oficinaValorOrcamento = ctx.dinheiro(850, 4800);
      v.oficinaMotivo = motivos[i % motivos.length];
    }
    // Duas compras a mais (à vista e consórcio) — a sub-aba Comprados tinha só uma.
    if ((i === 0 || i === 3) && !(v.compra && v.compra.ativo)) {
      v.compra = {
        ativo: true, data: ctx.iso(ctx.mes(i === 0 ? -14 : -5)), valor: ctx.dinheiro(45000, 120000),
        forma: i === 0 ? 'À vista' : 'Consórcio contemplado', conta: 'Conta Corrente DEMO',
        vendedor: i === 0 ? 'Revenda Modelo Seminovos (fictícia)' : 'Administradora Demo de Consórcios',
        telefone: ctx.telFake(80 + i), observacao: 'Compra de exemplo (módulo 20-operacao)',
      };
    }
  }
  return crlvs;
}

const ITENS_VISTORIA = ['pneus', 'lataria', 'vidros', 'farois', 'oleo', 'agua', 'freios', 'estepe', 'extintor', 'documentos', 'limpeza'];
const ROTULO_ITEM_VIST = { pneus: 'Pneus', lataria: 'Lataria', vidros: 'Vidros', farois: 'Faróis', oleo: 'Óleo', agua: 'Água', freios: 'Freios', estepe: 'Estepe', extintor: 'Extintor', documentos: 'Documentos', limpeza: 'Limpeza' };

// Vistorias de saída/retorno (Frota › Vistorias): pares saída→retorno por veículo, algumas com
// avaria no checklist e fotos. Formato de normalizarVistoria (backend/server.js).
// USO: const vistorias = await montarVistorias(ctx) → [{ id:'VST…', placa, tipo:'Saída', data:'2026-09-30', km:'45210', itens:{pneus:'ok',…}, fotos:[…] }]
async function montarVistorias(ctx) {
  const motoristas = ctx.funcionarios.filter(f => f.podeDirigir).map(f => f.nome);
  const ativos = ctx.veiculos.filter(v => !/vendido/i.test(v.status)).slice(0, 6);
  const lista = [];
  for (const [i, v] of ativos.entries()) {
    const motorista = motoristas[i % motoristas.length];
    let km = ctx.inteiro(18000, 95000);
    const saida = ctx.dia(-ctx.inteiro(8, 40));
    // Avaria no retorno de dois veículos (riscos na lataria / farol trincado), com foto.
    const avariaNoRetorno = i === 1 ? ['lataria'] : i === 4 ? ['farois', 'limpeza'] : [];
    const temRetorno = i !== 5; // o último segue na rua (só a saída registrada)
    for (const tipo of temRetorno ? ['Saída', 'Retorno'] : ['Saída']) {
      const data = tipo === 'Saída' ? saida : new Date(saida.getTime() + ctx.inteiro(2, 6) * 864e5);
      if (tipo === 'Retorno') km += ctx.inteiro(180, 1400);
      const itens = Object.fromEntries(ITENS_VISTORIA.map(k => [k, tipo === 'Retorno' && avariaNoRetorno.includes(k) ? 'avaria' : 'ok']));
      const fotos = [];
      fotos.push(await ctx.novaMidia(`vistoria-${v.placa}-${tipo === 'Saída' ? 'saida' : 'retorno'}-frente.png`,
        ctx.svgFoto(`${v.placa} · ${tipo} · frente`, '#475569')));
      for (const k of (tipo === 'Retorno' ? avariaNoRetorno : [])) {
        fotos.push(await ctx.novaMidia(`vistoria-${v.placa}-avaria-${k}.png`, ctx.svgFoto(`${v.placa} · avaria: ${ROTULO_ITEM_VIST[k]}`, '#b45309')));
      }
      lista.push({
        id: ctx.id('VST'),
        ts: ctx.ts(data),
        placa: v.placa,
        tipo,
        data: ctx.iso(data),
        km: String(km),
        motorista,
        itens,
        avarias: tipo === 'Retorno' && avariaNoRetorno.length
          ? (i === 1 ? 'Risco de ~20 cm na porta traseira direita (exemplo).' : 'Farol esquerdo trincado e cabine com barro (exemplo).')
          : '',
        fotos,
        termoAceito: true,
        criadoPor: QUEM,
      });
    }
  }
  return lista.sort((a, b) => b.ts - a.ts);
}

// Notas fiscais de serviço da oficina (Manutenção › Notas fiscais), cada uma com o PDF anexado.
// USO: const notas = await montarOficina(ctx) → [{ id:'OF…', placa, numeroNF:'NFS-2026-0101', fornecedor, valor, anexo:{id,nome,tipo} }]
async function montarOficina(ctx) {
  // [serviço, tipo de fornecedor que o faz] — a NF sai sempre de um prestador coerente com o serviço.
  const servicos = [['Troca de óleo e filtros', 'Oficina'], ['Substituição das pastilhas de freio', 'Oficina'],
    ['Alinhamento, balanceamento e rodízio', 'Pneus'], ['Funilaria e pintura do para-choque', 'Funilaria'],
    ['Revisão dos 40.000 km', 'Concessionária'], ['Reparo do ar-condicionado', 'Outros'], ['Troca da bateria 60 Ah', 'Outros'],
    ['Troca de embreagem', 'Oficina']];
  const lista = [];
  for (let k = 0; k < 8; k++) {
    const v = ctx.veiculos[k % 8];
    const f = ctx.fornecedores.find(x => x.tipo === servicos[k][1]) || ctx.fornecedores[0];
    const data = ctx.dia(-ctx.inteiro(5, 160));
    const numeroNF = `NFS-${data.getFullYear()}-${String(101 + k * 7).padStart(4, '0')}`;
    const valor = ctx.dinheiro(220, 5200);
    const km = String(ctx.inteiro(20000, 110000));
    const anexo = await ctx.novoPdf(`${numeroNF}.pdf`, `Nota Fiscal de Serviço ${numeroNF} (exemplo)`, [
      `Prestador: ${f.nome} (fictício)`,
      `Tomador: ${String(v.dono).toUpperCase()} (DEMONSTRAÇÃO)`,
      `Data de emissão: ${ctx.br(data)}`,
      '',
      `Veículo: ${v.placa} - ${v.modelo} ${v.versao}`,
      `KM na entrada: ${km}`,
      `Serviço: ${servicos[k][0]}`,
      '',
      `Valor total: ${reais(valor)}`,
    ]);
    lista.push({
      id: ctx.id('OF'), ts: ctx.ts(data), placa: v.placa, modelo: v.modelo, numeroNF,
      fornecedor: f.nome, cnpjFornecedor: '', data: ctx.iso(data), valor,
      descricao: servicos[k][0], km, anexo, criadoPor: QUEM,
    });
  }
  return lista;
}

// Liga parte dos eventos de manutenção ao cadastro de fornecedores (fornecedorId + nome) e
// completa os dados comerciais dos fornecedores (razão social, e-mail, WhatsApp, categorias).
// USO: completarManutencaoEFornecedores(ctx) → quantidade de eventos com fornecedor
const UF_DA_CIDADE = { 'Paulo Afonso': 'BA', Salvador: 'BA', 'Campina Grande': 'PB', Natal: 'RN' };
function completarManutencaoEFornecedores(ctx) {
  const extra = {
    Oficina: { cat: ['Mecânica'], tags: ['preventiva', 'corretiva'], mat: ['óleo', 'filtro', 'pastilha de freio'] },
    Distribuidora: { cat: ['Peças'], tags: ['entrega rápida'], mat: ['filtro', 'correia', 'rolamento'] },
    'Concessionária': { cat: ['Revisão de garantia'], tags: ['autorizada'], mat: ['peça original'] },
    'Autopeças': { cat: ['Peças'], tags: ['balcão'], mat: ['bateria', 'lâmpada', 'palheta'] },
    Funilaria: { cat: ['Lataria e pintura'], tags: ['sinistro'], mat: ['tinta', 'massa'] },
    Pneus: { cat: ['Pneus'], tags: ['alinhamento'], mat: ['pneu aro 15', 'pneu aro 16'] },
    Guincho: { cat: ['Socorro'], tags: ['24 horas'], mat: [] },
    Outros: { cat: ['Elétrica'], tags: ['ar-condicionado'], mat: ['gás refrigerante', 'alternador'] },
  };
  for (const [i, f] of ctx.fornecedores.entries()) {
    const e = extra[f.tipo] || extra.Outros;
    f.razaoSocial = f.razaoSocial || `${f.nome.replace(/\s*\(Demo\)/i, '')} Serviços Ltda (fictícia)`;
    f.email = f.email || `${slug(f.nome.replace(/\s*\(Demo\)/i, ''), '.')}@example.com`;
    f.whatsapp = f.whatsapp || ctx.telFake(90 + i);
    f.categorias = f.categorias && f.categorias.length ? f.categorias : e.cat;
    f.tags = f.tags && f.tags.length ? f.tags : e.tags;
    f.materiais = f.materiais && f.materiais.length ? f.materiais : e.mat;
    f.ativo = true;
    // O seed principal sorteia cidade e UF separadamente ("Salvador / PB"): alinha a UF à cidade.
    f.uf = UF_DA_CIDADE[f.cidade] || f.uf;
  }
  const porTipo = (tipos) => ctx.fornecedores.filter(f => tipos.includes(f.tipo));
  let ligados = 0;
  for (const [i, ev] of ctx.manutencao.entries()) {
    if (i % 4 === 3) continue; // um em cada quatro fica sem fornecedor (lançamento antigo, legado)
    const candidatos = /pneu|alinhamento/i.test(ev.item) ? porTipo(['Pneus'])
      : /ar-condicionado|elétrica|bateria/i.test(ev.item) ? porTipo(['Outros', 'Autopeças'])
        : /revisão de/i.test(ev.item) ? porTipo(['Concessionária', 'Oficina'])
          : porTipo(['Oficina']);
    const f = candidatos[i % candidatos.length];
    if (!f) continue;
    ev.fornecedorId = f.id;
    ev.fornecedor = f.nome;
    ligados++;
  }
  return ligados;
}

// ---------------------------------------------------------------------------
// MULTAS — dados da notificação, anexos de exemplo e biblioteca de termos (.docx)
// ---------------------------------------------------------------------------

const CODIGOS_INFRACAO = ['745-50', '554-10', '605-01', '501-00', '659-92', '518-51', '763-31', '569-03'];
const CAMPOS_DATA_MULTA = ['dataInfracao', 'dataVencimento', 'dataPagamento', 'dataNotificacao',
  'detranIdentificarData', 'detranTermoEnviadoData', 'detranTermoAssinadoData', 'detranPedidoDescontoData'];

// Anexo de multa no formato de normalizarDocsMulta. USO: await anexoMulta(ctx, 'Boleto', m, ['Valor: R$ 130,16'])
async function anexoMulta(ctx, categoria, m, linhas, quando) {
  const arq = categoria === 'Foto'
    ? await ctx.novaMidia(`foto-radar-${m.placa}.png`, ctx.svgFoto(`Registro do equipamento · ${m.placa}`, '#1e3a8a'))
    : await ctx.novoPdf(`${slug(categoria)}-${m.autoInfracao}.pdf`, `${categoria} - auto ${m.autoInfracao} (exemplo)`, linhas);
  return {
    id: arq.id, nome: `${categoria} ${m.autoInfracao}`, tipo: arq.tipo, categoria,
    nomeOriginal: arq.nome, uploadTs: ctx.ts(quando || ctx.dia(-ctx.inteiro(2, 30))), uploadPor: QUEM, versoes: [],
  };
}

// Completa as multas: datas em dd/mm/aaaa (padrão da tela), código/órgão/data da notificação
// (o termo usa), condutor vinculado e anexos conforme a situação (notificação, boleto,
// comprovante, termo assinado, foto). Uma delas mostra um anexo SUBSTITUÍDO (com versão anterior).
// USO: const n = await completarMultas(ctx) → quantidade de anexos criados
async function completarMultas(ctx) {
  let anexos = 0;
  for (const [i, m] of ctx.multas.entries()) {
    const dataInf = new Date(m.dataInfracao + 'T12:00:00');
    m.codigoInfracao = CODIGOS_INFRACAO[i % CODIGOS_INFRACAO.length];
    m.orgaoAutuador = i % 2 === 0 ? 'DER-DEMO - Departamento de Estradas (fictício)' : 'Órgão Municipal de Trânsito (fictício)';
    m.dataNotificacao = ctx.iso(new Date(dataInf.getTime() + 12 * 864e5));
    for (const campo of CAMPOS_DATA_MULTA) if (m[campo]) m[campo] = paraBR(m[campo]);
    const func = ctx.funcionarios.find(f => f.nome === m.responsavel);
    if (func && m.detranTermoEnviadoOk) m.condutorFuncionarioId = func.id;

    if (i === 7) continue; // uma multa nova, ainda sem nada anexado
    const base = [`Placa: ${m.placa}`, `Auto de infração: ${m.autoInfracao}`, `Código: ${m.codigoInfracao}`,
      `Infração: ${m.descricao}`, `Local: ${m.local} - ${m.cidadeEstado}`, `Data/hora: ${m.dataInfracao} às ${m.horaInfracao}`,
      `Órgão autuador: ${m.orgaoAutuador}`, `Valor: ${reais(m.valor)}`];
    const docs = [await anexoMulta(ctx, 'Notificação', m, [...base, `Notificada em: ${m.dataNotificacao}`], deBR(m.dataNotificacao))];
    if (!/PAGO/.test(m.situacao)) docs.push(await anexoMulta(ctx, 'Boleto', m, [...base, `Vencimento: ${m.dataVencimento}`, 'Linha digitável: 00000.00000 00000.000000 00000.000000 0 00000000000000 (fictícia)']));
    if (/PAGO/.test(m.situacao)) docs.push(await anexoMulta(ctx, 'Comprovante de pagamento', m, [...base, `Pago em: ${m.dataPagamento}`, `Forma: ${m.formaPagamento}`]));
    if (m.detranTermoAssinadoOk) docs.push(await anexoMulta(ctx, 'Termo assinado', m, [...base, `Condutor: ${m.responsavel}`, `Assinado em: ${m.detranTermoAssinadoData}`]));
    if (i === 2 || i === 4) docs.push(await anexoMulta(ctx, 'Foto', m));
    if (i === 1) {
      // Notificação reenviada: a primeira digitalização (ilegível) fica como versão anterior.
      const antiga = await ctx.novoPdf(`notificacao-${m.autoInfracao}-v1.pdf`, `Notificação - auto ${m.autoInfracao} (digitalização ilegível)`, base);
      docs[0].versoes = [{ id: antiga.id, nome: docs[0].nome, tipo: antiga.tipo, nomeOriginal: antiga.nome,
        uploadTs: ctx.ts(ctx.dia(-40)), uploadPor: QUEM, substituidoTs: ctx.ts(ctx.dia(-38)), substituidoPor: QUEM }];
      anexos++;
    }
    m.documentos = docs;
    anexos += docs.length;
  }
  return anexos;
}

// --- .docx do termo de responsabilidade (modelo com marcadores {{…}}) -------------------------

const escXml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Runs do Word para um texto; cada {{MARCADOR}} vira um run em Consolas com realce amarelo (o
// padrão dos modelos reais: o sistema troca a fonte para Arial e tira o realce ao preencher).
// USO: runsDocx('CPF {{CPF}}', { negrito: true }) → '<w:r>…CPF </w:r><w:r>…{{CPF}}…</w:r>'
function runsDocx(texto, { negrito = false, tamanho = 22, oculto = false, cor = '' } = {}) {
  return String(texto).split(/(\{\{[A-Z_]+\}\})/).filter(Boolean).map((parte) => {
    const marcador = !oculto && /^\{\{[A-Z_]+\}\}$/.test(parte);
    const fonte = marcador ? 'Consolas' : 'Arial';
    const rPr = `<w:rFonts w:ascii="${fonte}" w:hAnsi="${fonte}" w:cs="${fonte}"/>`
      + (negrito ? '<w:b/>' : '') + (oculto ? '<w:vanish/>' : '') + (cor ? `<w:color w:val="${cor}"/>` : '')
      + `<w:sz w:val="${tamanho}"/>` + (marcador ? '<w:highlight w:val="yellow"/>' : '');
    return `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${escXml(parte)}</w:t></w:r>`;
  }).join('');
}

// Parágrafo do Word. USO: paragrafoDocx('Texto {{PLACA}}', { alinhar: 'center', negrito: true, depois: 240 })
function paragrafoDocx(texto, { alinhar = 'both', depois = 140, oculto = false, ...run } = {}) {
  const marcaOculta = oculto ? '<w:rPr><w:vanish/></w:rPr>' : '';
  return `<w:p><w:pPr><w:spacing w:after="${depois}" w:line="276" w:lineRule="auto"/><w:jc w:val="${alinhar}"/>${marcaOculta}</w:pPr>`
    + runsDocx(texto, { ...run, oculto }) + '</w:p>';
}

// Monta um .docx mínimo e válido (Content_Types, rels, styles, document) a partir dos parágrafos.
// USO: const buf = docxDeParagrafos([paragrafoDocx('Olá {{NOME_COLABORADOR}}')]) → Buffer (.docx)
function docxDeParagrafos(paragrafos) {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
    + '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>'
    + '</Types>');
  zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
    + '</Relationships>');
  zip.file('word/_rels/document.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
    + '</Relationships>');
  zip.file('word/styles.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
    + '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:sz w:val="22"/><w:lang w:val="pt-BR"/></w:rPr></w:rPrDefault>'
    + '<w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>'
    + '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>'
    + '</w:styles>');
  zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<w:body>' + paragrafos.join('')
    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1418" w:right="1418" w:bottom="1418" w:left="1418" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>'
    + '</w:body></w:document>');
  return zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// Bloco oculto de instruções (texto oculto do Word): o sistema o preserva no .docx e o tira do PDF.
const INSTRUCOES_TERMO = paragrafoDocx('[[INSTRUCOES]] Os campos entre chaves duplas, como {{NOME_COLABORADOR}} e {{PLACA}}, '
  + 'são preenchidos pelo sistema em Multas > Gerar termo. Não apague as chaves. [[FIM INSTRUCOES]]', { oculto: true, cor: '7F7F7F', tamanho: 18 });

// Modelo de termo de responsabilidade de uma empresa, usando os marcadores de MARCADORES_TERMO_MULTA.
// USO: const buf = modeloTermoDocx('NTE') → Buffer de um .docx com {{NOME_COLABORADOR}}, {{PLACA}}, …
function modeloTermoDocx(sigla) {
  const empresa = sigla === 'NTE' ? 'NORTE ENGENHARIA' : 'SUL EMPREENDIMENTOS';
  const corpo = sigla === 'NTE'
    ? [
      'Eu, {{NOME_COLABORADOR}}, inscrito(a) no CPF sob o nº {{CPF}}, RG {{RG}}, portador(a) da CNH nº {{CNH}}, categoria {{CNH_CATEGORIA}}, '
        + 'válida até {{CNH_VALIDADE}}, ocupante do cargo de {{CARGO}}, matrícula {{MATRICULA}}, residente em {{ENDERECO}}, declaro que, desde '
        + '{{RESPONSAVEL_DESDE}}, sou o(a) condutor(a) responsável pelo veículo de placa {{PLACA}}, {{MODELO_MARCA}}, ano {{ANO}}, cor {{COR}}, '
        + 'Renavam {{RENAVAM}}, chassi {{CHASSI}}, de propriedade de {{PROPRIETARIO}}.',
      'Reconheço como de minha responsabilidade a infração registrada no auto nº {{NUMERO_AUTO}} (código {{CODIGO_INFRACAO}}), lavrado por '
        + '{{ORGAO_AUTUADOR}}, por {{DESCRICAO_INFRACAO}}, ocorrida em {{LOCAL_INFRACAO}}, em {{DATA_HORA_INFRACAO}}, com notificação de autuação '
        + 'recebida em {{DATA_NOTIFICACAO}}, no valor de {{VALOR_MULTA}} e vencimento em {{VENCIMENTO}}.',
      'Autorizo a {{EMPRESA_RAZAO}}, CNPJ {{EMPRESA_CNPJ}}, a descontar o valor da multa em folha de pagamento, {{CONDICAO_PARCELAS}}, a partir '
        + 'de {{MES_INICIO_DESCONTO}}, e comprometo-me a assinar o formulário de identificação do condutor infrator no prazo legal.',
    ]
    : [
      'Pelo presente termo, {{NOME_COLABORADOR}}, CPF {{CPF}}, CNH nº {{CNH}} ({{CNH_CATEGORIA}}), {{CARGO}}, matrícula {{MATRICULA}}, '
        + 'declara ser o(a) condutor(a) do veículo {{MODELO_MARCA}}, placa {{PLACA}}, no momento da infração descrita abaixo.',
      'Auto de infração: {{NUMERO_AUTO}} · Código: {{CODIGO_INFRACAO}} · Infração: {{DESCRICAO_INFRACAO}} · Local: {{LOCAL_INFRACAO}} · '
        + 'Data e hora: {{DATA_HORA_INFRACAO}} · Valor: {{VALOR_MULTA}}.',
      'O(a) colaborador(a) autoriza o desconto do valor {{CONDICAO_PARCELAS}}, com início em {{MES_INICIO_DESCONTO}}, e assume a pontuação '
        + 'na sua CNH, nos termos do Código de Trânsito Brasileiro.',
    ];
  return docxDeParagrafos([
    INSTRUCOES_TERMO,
    paragrafoDocx(`${empresa} (DEMONSTRAÇÃO)`, { alinhar: 'center', negrito: true, tamanho: 20, cor: '595959', depois: 60 }),
    paragrafoDocx('TERMO DE RESPONSABILIDADE POR INFRAÇÃO DE TRÂNSITO', { alinhar: 'center', negrito: true, tamanho: 28, depois: 360 }),
    ...corpo.map(t => paragrafoDocx(t)),
    paragrafoDocx('{{CIDADE}}, {{DATA_ASSINATURA}}.', { alinhar: 'right', depois: 720 }),
    paragrafoDocx('_______________________________________', { alinhar: 'center', depois: 0 }),
    paragrafoDocx('{{NOME_COLABORADOR}} - Colaborador(a)', { alinhar: 'center', depois: 600 }),
    paragrafoDocx('_______________________________________', { alinhar: 'center', depois: 0 }),
    paragrafoDocx(`{{NOME_REPRESENTANTE}} - Representante da ${empresa}`, { alinhar: 'center', depois: 480 }),
    paragrafoDocx('Modelo fictício da base de demonstração - não tem validade legal.', { alinhar: 'center', tamanho: 16, cor: '7F7F7F' }),
  ]);
}

// Biblioteca de Multas › Termos: pastas, um modelo .docx por empresa (o "Gerar termo" usa), um
// modelo em PDF só de referência e os termos já assinados (PDF), arquivados por placa.
// USO: const estrutura = await montarTermosMultas(ctx) → { termos: [...], pastas: [...] }
async function montarTermosMultas(ctx) {
  const agora = ctx.ts(ctx.dia(-60));
  const pastas = [
    { id: 'TP-MODELOS', nome: 'Modelos prontos', pastaPaiId: '', criadoEm: agora, atualizadoEm: agora, atualizadoPor: QUEM },
    { id: 'TP-CARROS', nome: 'Carros', pastaPaiId: '', criadoEm: agora, atualizadoEm: agora, atualizadoPor: QUEM },
  ];
  const termos = [];
  for (const sigla of ['NTE', 'SUL']) {
    const arquivo = await ctx.novaMidiaBuffer(`Termo de Responsabilidade ${sigla}.docx`, DOCX_MIME, modeloTermoDocx(sigla));
    termos.push({
      id: ctx.id('TM-'), ts: agora, tipo: 'modelo', pastaId: 'TP-MODELOS', placa: '', motorista: '',
      titulo: `Termo de Responsabilidade - ${sigla}`,
      descricao: `Modelo da ${sigla === 'NTE' ? 'Norte Engenharia' : 'Sul Empreendimentos'} com marcadores {{…}}: use o botão "Gerar termo" na multa para preencher.`,
      arquivo, atualizadoEm: agora, atualizadoPor: QUEM,
    });
  }
  const guia = await ctx.novoPdf('Orientacoes-indicacao-de-condutor.pdf', 'Orientações para indicação de condutor (exemplo)', [
    '1. Confira os dados do auto de infração e a placa do veículo.',
    '2. Identifique o condutor pelo registro de uso do veículo.',
    '3. Gere o termo em Multas > Gerar termo e colha as assinaturas.',
    '4. Anexe o termo assinado na multa (categoria "Termo assinado").',
    '5. Protocole a indicação no órgão autuador dentro do prazo.',
  ]);
  termos.push({ id: ctx.id('TM-'), ts: agora, tipo: 'modelo', pastaId: 'TP-MODELOS', placa: '', motorista: '',
    titulo: 'Orientações para indicação de condutor', descricao: 'Passo a passo interno (PDF de referência, não é preenchido pelo sistema).',
    arquivo: guia, atualizadoEm: agora, atualizadoPor: QUEM });

  for (const m of ctx.multas.filter(x => x.detranTermoAssinadoOk)) {
    let pasta = pastas.find(p => p.nome === m.placa);
    if (!pasta) { pasta = { id: ctx.id('TP-'), nome: m.placa, pastaPaiId: 'TP-CARROS', criadoEm: agora, atualizadoEm: agora, atualizadoPor: QUEM }; pastas.push(pasta); }
    const arquivo = await ctx.novoPdf(`Termo assinado ${m.autoInfracao}.pdf`, 'Termo de responsabilidade assinado (exemplo)', [
      `Auto de infração: ${m.autoInfracao}`, `Placa: ${m.placa}`, `Condutor: ${m.responsavel}`,
      `Infração: ${m.descricao}`, `Valor: ${reais(m.valor)}`, `Assinado em: ${m.detranTermoAssinadoData}`,
      '', 'Assinaturas: (rubricas fictícias)']);
    const quando = ctx.ts(deBR(m.detranTermoAssinadoData));
    termos.push({ id: ctx.id('TM-'), ts: quando, tipo: 'assinado', pastaId: pasta.id, placa: m.placa, motorista: m.responsavel,
      titulo: `Termo assinado - auto ${m.autoInfracao}`, descricao: '', arquivo, atualizadoEm: quando, atualizadoPor: QUEM });
  }
  return { termos, pastas };
}

// ---------------------------------------------------------------------------
// RASTREADORES — fotos das instalações e comprovantes dos envios
// ---------------------------------------------------------------------------

// Fotos nas instalações, comprovante nos envios postados e eventos de vínculo recalculados
// (o seed principal os calculou antes das fotos existirem).
// USO: const r = await completarRastreadores(ctx) → { fotos: 8, comprovantes: 2, vinculos: [...] }
async function completarRastreadores(ctx) {
  let fotos = 0, comprovantes = 0;
  for (const inst of ctx.instalacoes) {
    inst.fotos = [
      await ctx.novaMidia(`instalacao-${inst.placa}-equipamento.png`, ctx.svgFoto(`Rastreador ${inst.numeroSerie} instalado`, '#0f766e')),
      await ctx.novaMidia(`instalacao-${inst.placa}-painel.png`, ctx.svgFoto(`${inst.placa} · painel ligado`, '#334155')),
    ];
    fotos += inst.fotos.length;
  }
  for (const e of ctx.envios) {
    if (e.status === 'Aguardando postagem') continue;
    e.comprovantes = [await ctx.novaMidia(`comprovante-postagem-${e.codigoRastreamento}.png`,
      ctx.svgFoto(`Postagem ${e.codigoRastreamento}`, '#7c3aed'))];
    if (e.status === 'Entregue') {
      e.comprovantes.push(await ctx.novoPdf(`aviso-recebimento-${e.codigoRastreamento}.pdf`, 'Aviso de recebimento (exemplo)', [
        `Objeto: ${e.codigoRastreamento}`, `Item: ${e.tipoItem}`, `Destinatário: ${e.destinatario}`, `Entregue em: ${e.dataEntrega}`]));
    }
    e.observacoes = e.observacoes || 'Comprovante anexado (exemplo).';
    comprovantes += e.comprovantes.length;
  }
  return { fotos, comprovantes, vinculos: recuperarLegado(ctx.rastreadores, ctx.instalacoes, []) };
}

// Feedback com print anexado (o mural mostra a miniatura). USO: await completarFeedbacks(ctx) → 2
async function completarFeedbacks(ctx) {
  let n = 0;
  for (const f of ctx.feedbacks) {
    if (f.tipo !== 'Problema' && !/Exportar EPI/.test(f.titulo)) continue;
    f.imagens = [await ctx.novaMidia(`print-${f.id}.png`, ctx.svgFoto(`Print da tela · ${f.titulo.slice(0, 28)}`, '#0e7490'))];
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// LOCAÇÕES — itens de cada tipo, contratos com documentos e histórico de faturas
// ---------------------------------------------------------------------------

// IPCA fictício por ano (o do ano Y é aplicado no aniversário da chegada que cai em Y+1).
const IPCA_DEMO = { 2024: 4.6, 2025: 4.4 };

// Mesmo cálculo de calcularCorrecaoIPCA (backend/server.js), para o histórico bater com a tela.
// USO: corrigirIpca(7000, '11/05/2024', IPCA_DEMO, new Date(2026, 9, 1)) → 7000 × 1,046 × 1,044
function corrigirIpca(valor, dataChegadaBR, ipca, referencia) {
  const base = deBR(dataChegadaBR);
  let v = valor;
  for (const [anoStr, taxa] of Object.entries(ipca).sort(([a], [b]) => a - b)) {
    const ano = Number(anoStr);
    if (ano < base.getFullYear()) continue;
    if (new Date(ano + 1, base.getMonth(), base.getDate(), 12) > referencia) continue;
    v *= 1 + taxa / 100;
  }
  return Math.round(v * 100) / 100;
}

// Competência em aberto (ciclo 15 → 14): antes do dia 15 ainda é o mês anterior.
// USO: competenciaVigente(new Date(2026, 9, 8)) → { mes: 9, ano: 2026 }   (setembro: 15/09 a 14/10)
function competenciaVigente(hoje) {
  const d = new Date(hoje.getFullYear(), hoje.getMonth(), 1, 12);
  if (hoje.getDate() < 15) d.setMonth(d.getMonth() - 1);
  return { mes: d.getMonth() + 1, ano: d.getFullYear() };
}

// Itens da fatura de uma competência — espelho simplificado de montarFaturaLocacoes: chegou
// antes do ciclo = mensalidade cheia (30 dias); chegou dentro = proporcional desde a chegada.
// USO: itensFatura(locacoes, IPCA_DEMO, 8, 2026) → [{ modelo, identificador, tipo, polo, periodo:'15/08-14/09/26', dias:30, valor }]
function itensFatura(locacoes, ipca, mes, ano) {
  const inicio = new Date(ano, mes - 1, 15, 12), fim = new Date(ano, mes, 14, 12);
  const dm = (d, anoCurto) => `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}${anoCurto ? '/' + String(d.getFullYear()).slice(-2) : ''}`;
  const itens = [];
  for (const l of locacoes) {
    const chegada = deBR(l.dataChegada);
    if (chegada > fim) continue;
    const ini = chegada >= inicio ? chegada : inicio;
    const dias = ini === inicio ? 30 : Math.max(1, Math.min(30, Math.round((fim - ini) / 864e5) + 1));
    const mensal = l.reajusteIpca === false ? l.valorInicial : corrigirIpca(l.valorInicial, l.dataChegada, ipca, fim);
    itens.push({ modelo: l.modelo, identificador: l.tipo === 'veiculo' ? l.placa : l.identificacao, tipo: l.tipo, polo: l.polo,
      periodo: `${dm(ini)}-${dm(fim, true)}`, dias, valor: Math.round(mensal / 30 * dias * 100) / 100 });
  }
  return itens.sort((a, b) => String(a.polo || '￿').localeCompare(String(b.polo || '￿'), 'pt-BR'));
}

const MESES = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];

// Locações (lista + config com contratos/documentos/IPCA) e o histórico de faturas já emitidas.
// USO: const { arquivo, faturas } = await montarLocacoes(ctx)
//      → arquivo = { locacoes: [...8 itens], config: { ipca, contratos: [...] } }, faturas = { faturas: [...3] }
async function montarLocacoes(ctx) {
  const vig = competenciaVigente(ctx.HOJE);
  const inicioCiclo = new Date(vig.ano, vig.mes - 1, 15, 12);
  // Chegada DENTRO do ciclo em aberto → a fatura atual mostra a linha proporcional.
  const chegadaNoCiclo = new Date(Math.min(inicioCiclo.getTime() + 7 * 864e5, ctx.dia(-1).getTime()));
  const base = [
    { tipo: 'veiculo', placa: 'LOC1A11', modelo: 'Toyota Hilux SR 2.8 4x4', anoFabricacao: '2022', anoModelo: '2023', chegada: ctx.mes(-22), valor: 7200, contrato: '01', polo: 'PAULO AFONSO' },
    { tipo: 'veiculo', placa: 'LOC2B22', modelo: 'Fiat Strada Endurance 1.4', anoFabricacao: '2023', anoModelo: '2023', chegada: ctx.mes(-14), valor: 3900, contrato: '01', polo: 'NATAL' },
    { tipo: 'veiculo', placa: 'LOC3C33', modelo: 'Renault Master Furgão 2.3', anoFabricacao: '2024', anoModelo: '2024', chegada: ctx.mes(-8), valor: 6500, contrato: '01', polo: 'CAMPINA GRANDE' },
    { tipo: 'veiculo', placa: 'LOC4D44', modelo: 'VW Saveiro Robust 1.6', anoFabricacao: '2024', anoModelo: '2025', chegada: chegadaNoCiclo, valor: 3600, contrato: '01', polo: 'NATAL', obs: 'Chegou no meio do ciclo: a fatura cobra proporcional.' },
    { tipo: 'equipamento', identificacao: 'PAT-DEMO-0101', modelo: 'Gerador de energia 55 kVA', chegada: ctx.mes(-13), valor: 4800, contrato: '02', polo: 'NATAL' },
    { tipo: 'equipamento', identificacao: 'SN-DEMO-7781', modelo: 'Plataforma elevatória articulada 12 m', chegada: ctx.mes(-5), valor: 5600, contrato: '02', polo: 'CAMPINA GRANDE', reajusteIpca: false, obs: 'Preço fechado em contrato, sem reajuste anual.' },
    { tipo: 'ferramental', identificacao: 'KIT-DEMO-03', modelo: 'Ferramental de linha viva (kit de reisolamento)', chegada: ctx.mes(-3), valor: 1800, contrato: '01', polo: 'PAULO AFONSO', reajusteIpca: false },
    { tipo: 'outro', identificacao: 'CNT-DEMO-12', modelo: 'Contêiner escritório 6 m', chegada: ctx.mes(-20), valor: 1500, contrato: '', polo: 'NATAL' },
  ];
  const locacoes = base.map((b, i) => ({
    id: 'loc-demo-' + String(i + 1).padStart(2, '0'),
    tipo: b.tipo,
    placa: b.placa || '',
    identificacao: b.identificacao || '',
    modelo: b.modelo,
    anoFabricacao: b.anoFabricacao || '',
    anoModelo: b.anoModelo || '',
    dataChegada: ctx.br(b.chegada),
    valorInicial: b.valor,
    contrato: b.contrato,
    polo: b.polo,
    obs: b.obs || '',
    reajusteIpca: b.reajusteIpca !== false,
    ts: ctx.ts(b.chegada),
  }));

  const contratos = [
    { numero: '01', descricao: 'Veículos e ferramentas · 24 meses', locatario: 'DELTA ENERGIA', assinadoEm: ctx.iso(ctx.mes(-23)),
      docs: [['Contrato 01 - locação de veículos e ferramentas.pdf', 'Contrato de locação nº 01 (exemplo)', ctx.mes(-23)],
        ['Aditivo 01 - inclusão de ferramental.pdf', '1º termo aditivo ao contrato nº 01 (exemplo)', ctx.mes(-3)]] },
    { numero: '02', descricao: 'Equipamentos · 12 meses', locatario: 'DELTA ENERGIA', assinadoEm: ctx.iso(ctx.mes(-14)),
      docs: [['Contrato 02 - locação de equipamentos.pdf', 'Contrato de locação nº 02 (exemplo)', ctx.mes(-14)]] },
  ];
  for (const c of contratos) {
    c.documentos = [];
    for (const [nome, titulo, quando] of c.docs) {
      const itens = locacoes.filter(l => l.contrato === c.numero);
      const ref = await ctx.novoPdf(nome, titulo, [
        'Locadora: SUL EMPREENDIMENTOS (demonstração)', `Locatária: ${c.locatario} (fictícia)`, `Objeto: ${c.descricao}`,
        `Assinado em: ${paraBR(c.assinadoEm)}`, 'Ciclo de cobrança: dia 15 ao dia 14 do mês seguinte.', '', 'Itens:',
        ...itens.map(l => `- ${l.modelo} ${l.placa || l.identificacao} · ${reais(l.valorInicial)}/mês`)]);
      c.documentos.push({ ...ref, tamanho: 0, ts: ctx.ts(quando), por: QUEM });
    }
    delete c.docs;
  }

  // Histórico: as três competências anteriores à que está em aberto; a mais recente ainda pendente de envio.
  const faturas = [];
  for (let k = 3; k >= 1; k--) {
    const d = new Date(vig.ano, vig.mes - 1 - k, 1, 12);
    const mes = d.getMonth() + 1, ano = d.getFullYear(), mm = String(mes).padStart(2, '0');
    const itens = itensFatura(locacoes, IPCA_DEMO, mes, ano);
    const total = Math.round(itens.reduce((s, i) => s + i.valor, 0) * 100) / 100;
    const emissao = new Date(ano, mes, 10, 12), vencimento = new Date(ano, mes, 15, 12);
    const arquivo = await ctx.novoPdf(`cobranca-locacoes-${ano}-${mm}.pdf`, `Cobrança de locações - ${MESES[mes - 1]}/${ano}`, [
      'Locadora: SUL EMPREENDIMENTOS · Locatária: DELTA ENERGIA', `Emissão: ${ctx.br(emissao)} · Vencimento: ${ctx.br(vencimento)}`, '',
      ...itens.map(i => `${i.polo} · ${i.modelo} ${i.identificador} · ${i.periodo} · ${i.dias} dias · ${reais(i.valor)}`),
      '', `TOTAL: ${reais(total)}`]);
    const enviada = k > 1;
    faturas.push({
      id: ctx.id('LF'), competencia: `${ano}-${mm}`, mes: mm, ano: String(ano), referencia: `${MESES[mes - 1]}/${ano}`,
      numero: `COBRANCA-${ano}${mm}`, periodoInicio: ctx.br(new Date(ano, mes - 1, 15, 12)), periodoFim: ctx.br(new Date(ano, mes, 14, 12)),
      emissao: ctx.br(emissao), vencimento: ctx.br(vencimento),
      emitente: { id: 'parte-sul', apelido: 'SUL', razaoSocial: 'SUL SERVIÇOS ESPECIALIZADOS PARA CONSTRUÇÃO LTDA', cnpj: '' },
      destinatario: { id: 'parte-delta-energia', apelido: 'DELTA ENERGIA', razaoSocial: 'DELTA ENERGIA LTDA', cnpj: '' },
      totalLiquido: total, subtotal: total, totalAjustes: 0, qtdItens: itens.length,
      apenasVeiculos: itens.every(i => i.tipo === 'veiculo'), itens,
      arquivo: { ...arquivo, tamanho: 0 },
      geradoEm: ctx.ts(emissao), geradoPor: QUEM,
      enviada, enviadaEm: enviada ? ctx.ts(emissao) + 3 * 3600e3 : 0, enviadaPor: enviada ? QUEM : '',
      obs: enviada ? '' : 'Conferir os dias do item que chegou no meio do ciclo antes de enviar.',
    });
  }
  return {
    arquivo: { locacoes, config: { ipca: IPCA_DEMO, contratos } },
    faturas: { faturas },
  };
}

// ---------------------------------------------------------------------------
// Ponto de entrada chamado por scripts/seed-mock.js
// ---------------------------------------------------------------------------
exports.montar = async (ctx) => {
  const crlvs = await completarVeiculos(ctx);
  const vistorias = await montarVistorias(ctx);
  const oficina = await montarOficina(ctx);
  const comFornecedor = completarManutencaoEFornecedores(ctx);
  const anexosMulta = await completarMultas(ctx);
  const termos = await montarTermosMultas(ctx);
  const rast = await completarRastreadores(ctx);
  const feedbacks = await completarFeedbacks(ctx);
  const loc = await montarLocacoes(ctx);
  console.log(`     20-operacao: ${crlvs} CRLVs · ${vistorias.length} vistorias · ${oficina.length} NFs de oficina · `
    + `${comFornecedor} manutenções com fornecedor · ${anexosMulta} anexos de multa · ${termos.termos.length} termos · `
    + `${rast.fotos} fotos de instalação · ${rast.comprovantes} comprovantes de envio · ${feedbacks} feedbacks com imagem · `
    + `${loc.arquivo.locacoes.length} locações · ${loc.faturas.faturas.length} faturas`);
  return {
    'vistorias.json': { vistorias },
    'oficina.json': { oficina },
    'termos_multas.json': termos,
    'locacoes.json': loc.arquivo,
    'locacoes_faturas.json': loc.faturas,
    // Recalculado depois das fotos: os eventos de vínculo guardam uma cópia das fotos da instalação.
    'rastreadores_vinculos.json': { eventos: rast.vinculos },
  };
};
