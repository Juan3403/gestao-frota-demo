#!/usr/bin/env node
/**
 * seed-mock.js — popula o ambiente LOCAL com dados FICTÍCIOS de desenvolvimento.
 *
 * Substitui o "banco" local (a pasta `data/`, modo arquivo) por um conjunto de dados
 * inventados que exercita os cenários de cada aba: veículo alienado e vendido, multa em
 * cada situação do Detran, EPI com CA vencido, retirada de almoxarifado com devolução
 * parcial, colaborador desligado, documento a vencer, etc.
 *
 * NENHUM dado aqui é real: placas, CPFs, CNPJs, nomes, telefones e números de contrato
 * são gerados. Os CPFs têm dígito verificador válido só para as validações da tela
 * passarem — não pertencem a ninguém.
 *
 * USO (PowerShell, da pasta do projeto):
 *   node scripts/seed-mock.js                  # dry-run: mostra o que faria, não grava
 *   node scripts/seed-mock.js --apply          # grava os arquivos fictícios
 *   node scripts/seed-mock.js --apply --limpar # apaga o conteúdo atual de data/ antes
 *   node scripts/seed-mock.js --apply --seed 7 # outra amostra (a semente muda os sorteios)
 *
 * SEGURANÇA:
 *   - Só escreve ARQUIVO LOCAL (respeita a env DATA_DIR, igual ao servidor). Nunca abre
 *     conexão com o Mongo. Se MONGODB_URI estiver definida no ambiente o script ABORTA,
 *     para não haver dúvida sobre estar mexendo em produção.
 *   - Com --limpar, faz uma cópia do que existe em `<DATA_DIR>/_backup-antes-do-seed-<ts>/`
 *     antes de apagar qualquer coisa.
 *
 * EXEMPLO — regerar tudo do zero e subir o servidor:
 *   node scripts/seed-mock.js --apply --limpar
 *   npm start
 *   # login: admin / demo1234 (ou o APP_PASSWORD do .env)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { recuperarLegado } = require('../backend/rastreador-vinculos');

// ---------------------------------------------------------------------------
// Argumentos e trilhos de segurança
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const temFlag = (f) => argv.includes(f);
const valorFlag = (f, padrao) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : padrao;
};

const APLICAR = temFlag('--apply');
const LIMPAR = temFlag('--limpar');
const SEMENTE = Number(valorFlag('--seed', '42')) || 42;

if (process.env.MONGODB_URI) {
  console.error('\n✖ MONGODB_URI está definida no ambiente.');
  console.error('  Este script só popula o ambiente LOCAL (arquivos em data/). Rode-o num');
  console.error('  terminal sem MONGODB_URI para não haver risco de confundir com produção.\n');
  process.exit(1);
}

// Mesma regra do servidor (backend/server.js): raiz do repo + /data, trocável por DATA_DIR.
const RAIZ = path.join(__dirname, '..');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(RAIZ, 'data');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// ---------------------------------------------------------------------------
// Sorteio determinístico — a mesma semente gera sempre a mesma base.
// Testes que dependem de um registro específico não quebram a cada re-seed.
// ---------------------------------------------------------------------------
function criarRandom(semente) {
  let a = semente >>> 0;
  return function random() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = criarRandom(SEMENTE);
const inteiro = (min, max) => min + Math.floor(rnd() * (max - min + 1));
const escolher = (lista) => lista[inteiro(0, lista.length - 1)];
const dinheiro = (min, max) => Math.round((min + rnd() * (max - min)) * 100) / 100;

let contadorId = 0;
/** Id estável no formato do servidor (prefixo + base36 + hex), mas determinístico. */
function id(prefixo) {
  contadorId += 1;
  const hex = crypto.createHash('sha256').update(`${SEMENTE}:${prefixo}:${contadorId}`).digest('hex');
  return prefixo + (1700000000000 + contadorId * 97).toString(36) + hex.slice(0, 10);
}
function idMidia() {
  contadorId += 1;
  const hex = crypto.createHash('sha256').update(`${SEMENTE}:midia:${contadorId}`).digest('hex');
  return 'MD-' + hex.slice(0, 16);
}

// ---------------------------------------------------------------------------
// Datas — tudo relativo a HOJE, para os cenários "vencido" / "a vencer" continuarem
// fazendo sentido daqui a seis meses.
// ---------------------------------------------------------------------------
const HOJE = new Date();
HOJE.setHours(12, 0, 0, 0);
const dia = (n) => { const d = new Date(HOJE); d.setDate(d.getDate() + n); return d; };
const mes = (n) => { const d = new Date(HOJE); d.setMonth(d.getMonth() + n); return d; };
const iso = (d) => d.toISOString().slice(0, 10);                       // 2026-08-12
const br = (d) => iso(d).split('-').reverse().join('/');               // 12/08/2026
const ts = (d) => d.getTime();

// ---------------------------------------------------------------------------
// Geradores de identificadores brasileiros — VÁLIDOS na forma, FICTÍCIOS no conteúdo.
// ---------------------------------------------------------------------------
/** CPF com dígito verificador correto (a tela valida DV; o número não é de ninguém). */
function cpfFake(indice) {
  const base = String(10000000000 + indice * 7654321).slice(0, 9).split('').map(Number);
  const dv = (nums) => {
    let soma = 0;
    for (let i = 0; i < nums.length; i++) soma += nums[i] * (nums.length + 1 - i);
    const r = (soma * 10) % 11;
    return r === 10 ? 0 : r;
  };
  const d1 = dv(base);
  const d2 = dv([...base, d1]);
  const n = [...base, d1, d2].join('');
  return `${n.slice(0, 3)}.${n.slice(3, 6)}.${n.slice(6, 9)}-${n.slice(9)}`;
}
const rgFake = (i) => `${String(10 + i).padStart(2, '0')}.${String(100 + i * 7).slice(0, 3)}.${String(200 + i * 13).slice(0, 3)}`;
const telFake = (i) => `(8${inteiro(1, 9)}) 9${String(8000 + i * 37).slice(0, 4)}-${String(1000 + i * 91).slice(0, 4)}`;
const cepFake = (i) => `${String(48000 + i * 11).slice(0, 5)}-${String(100 + i).slice(0, 3)}`;
/** Placa Mercosul fictícia (LLLNLNN) — os prefixos usados não pertencem a nenhuma frota real. */
const PLACAS = ['MOK1A01', 'MOK2B02', 'MOK3C03', 'MOK4D04', 'MOK5E05', 'MOK6F06',
  'DEM7G07', 'DEM8H08', 'DEM9I09', 'DEM0J10', 'TST1K11', 'TST2L12'];

// ---------------------------------------------------------------------------
// Vocabulário do domínio (mesmos valores que as telas filtram)
// ---------------------------------------------------------------------------
const CENTROS = ['SEDE', 'PAULO AFONSO', 'NATAL', 'CAMPINA GRANDE', 'AL/PE'];
const RESPONSAVEIS = ['Ana Paula Ribeiro', 'Carlos Menezes', 'Débora Nunes'];

// Catálogo de contratos FICTÍCIO. Gravado em cadastros.contratosFuncionarios, que tem
// precedência sobre config/funcionarios-contratos.json (ver lerCatalogoContratosFunc no
// servidor) — assim o ambiente local roda 100% com números inventados sem alterar o
// arquivo de configuração versionado.
const CONTRATOS_CAT = [
  {
    sigla: 'SUL',
    nome: 'SUL EMPREENDIMENTOS (DEMO)',
    razao: 'SUL DEMONSTRACAO SERVICOS LTDA',
    contratos: [
      { numero: '4600000101', nome: 'MANUTENÇÃO CIVIL - DEMO BAHIA', frentes: ['PAULO AFONSO'] },
      { numero: '4500000202', nome: 'MANUTENÇÃO CIVIL - DEMO SEDE', frentes: [''] },
      { numero: 'ESCRITORIO-SUL', nome: 'ESCRITÓRIO', frentes: [''] },
    ],
  },
  {
    sigla: 'NTE',
    nome: 'NORTE ENGENHARIA (DEMO)',
    razao: 'NTE DEMONSTRACAO CONSTRUTORA LTDA',
    contratos: [
      { numero: '4600000303', nome: 'ORION - EXECUÇÃO DE OBRAS (DEMO)', frentes: ['CAMPINA GRANDE'] },
      { numero: '4500000404', nome: 'MANUTENÇÃO DE LINHA - DEMO', frentes: ['NATAL'] },
      { numero: 'ESCRITORIO-NTE', nome: 'ESCRITÓRIO', frentes: [''] },
    ],
  },
];
const CT_SUL_BA = '4600000101';
const CT_SUL_SEDE = '4500000202';
const CT_NTE_ORION = '4600000303';
const CT_NTE_LINHA = '4500000404';

// ---------------------------------------------------------------------------
// Cofre de mídia — assinaturas e fotos de mentira, geradas na hora.
// Formato do servidor: data/uploads/<id>.json = { tipo, nome, b64, ts }
// ---------------------------------------------------------------------------
const midiasParaGravar = [];

/** SVG de rabisco "cursivo" derivado do nome — parece assinatura, não é de ninguém. */
function svgAssinatura(nome) {
  const semente = [...nome].reduce((t, c) => t + c.charCodeAt(0), 0);
  const r = criarRandom(semente);
  let d = 'M 20 90';
  for (let i = 1; i <= 9; i++) {
    const x = 20 + i * 46;
    const cy1 = 90 - r() * 60;
    const cy2 = 40 + r() * 60;
    d += ` C ${x - 30} ${cy1.toFixed(1)}, ${x - 12} ${cy2.toFixed(1)}, ${x} ${(60 + r() * 25).toFixed(1)}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="460" height="130">
  <rect width="460" height="130" fill="none"/>
  <path d="${d}" fill="none" stroke="#111827" stroke-width="3" stroke-linecap="round"/>
</svg>`;
}

/** Retângulo colorido com legenda — faz as vezes de "foto da entrega". */
function svgFoto(legenda, cor) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320">
  <rect width="480" height="320" fill="${cor}"/>
  <rect x="16" y="16" width="448" height="288" fill="none" stroke="#ffffff" stroke-width="3" stroke-dasharray="10 8"/>
  <text x="240" y="150" text-anchor="middle" font-family="sans-serif" font-size="26" fill="#ffffff">FOTO DE EXEMPLO</text>
  <text x="240" y="188" text-anchor="middle" font-family="sans-serif" font-size="20" fill="#ffffff">${legenda}</text>
</svg>`;
}

// PNG 1×1 transparente — plano B se o sharp não estiver disponível na máquina.
const PNG_VAZIO = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
let sharp = null;
try { sharp = require('sharp'); } catch (e) { /* opcional */ }

async function svgParaPngB64(svg) {
  if (!sharp) return PNG_VAZIO;
  try { return (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64'); }
  catch (e) { return PNG_VAZIO; }
}

/** Registra uma mídia no cofre e devolve a referência {id, nome, tipo} que vai no registro. */
async function novaMidia(nomeArquivo, svg) {
  const mid = idMidia();
  midiasParaGravar.push({ id: mid, conteudo: { tipo: 'image/png', nome: nomeArquivo, b64: await svgParaPngB64(svg), ts: ts(HOJE) } });
  return { id: mid, nome: nomeArquivo, tipo: 'image/png' };
}
const novaAssinatura = (nome) => novaMidia(`assinatura-${nome.split(' ')[0].toLowerCase()}.png`, svgAssinatura(nome));

/** Grava um arquivo qualquer no cofre. USO: await novaMidiaBuffer('modelo.docx', MIME_DOCX, buf) → {id, nome, tipo} */
async function novaMidiaBuffer(nomeArquivo, tipo, buf) {
  const mid = idMidia();
  midiasParaGravar.push({ id: mid, conteudo: { tipo, nome: nomeArquivo, b64: Buffer.from(buf).toString('base64'), ts: ts(HOJE) } });
  return { id: mid, nome: nomeArquivo, tipo };
}

let PDFLib = null;
try { PDFLib = require('pdf-lib'); } catch (e) { /* opcional */ }
/**
 * PDF fictício de uma página (faixa "DOCUMENTO FICTÍCIO", título e linhas de texto).
 * USO: await novoPdf('crlv-MOK1A01.pdf', 'CRLV (exemplo)', ['Placa: MOK1A01', 'Ano: 2024'])
 *      → { id, nome: 'crlv-MOK1A01.pdf', tipo: 'application/pdf' }
 */
async function novoPdf(nomeArquivo, titulo, linhas = []) {
  if (!PDFLib) return novaMidia(nomeArquivo.replace(/\.pdf$/i, '.png'), svgFoto(titulo, '#334155'));
  const { PDFDocument, StandardFonts, rgb } = PDFLib;
  const doc = await PDFDocument.create();
  doc.setTitle(titulo); doc.setAuthor('Gestão RM (demonstração)');
  const page = doc.addPage([595.28, 841.89]);
  const fonte = await doc.embedFont(StandardFonts.Helvetica);
  const negrito = await doc.embedFont(StandardFonts.HelveticaBold);
  page.drawRectangle({ x: 0, y: 800, width: 595.28, height: 42, color: rgb(0.12, 0.16, 0.22) });
  page.drawText('DOCUMENTO FICTÍCIO - DEMONSTRAÇÃO', { x: 40, y: 815, size: 11, font: negrito, color: rgb(1, 1, 1) });
  page.drawText(titulo, { x: 40, y: 760, size: 18, font: negrito, color: rgb(0.1, 0.1, 0.1) });
  let y = 725;
  for (const l of linhas) {
    page.drawText(String(l), { x: 40, y, size: 11, font: fonte, color: rgb(0.2, 0.2, 0.2) });
    y -= 18;
    if (y < 60) break;
  }
  page.drawText('Gerado pelo scripts/seed-mock.js - nenhum dado real.', { x: 40, y: 30, size: 8, font: fonte, color: rgb(0.5, 0.5, 0.5) });
  return novaMidiaBuffer(nomeArquivo, 'application/pdf', await doc.save());
}

// ---------------------------------------------------------------------------
// Assinatura eletrônica — o hash precisa BATER com o que o servidor recalcula, senão
// todo recibo/ficha da base de teste nasce com o aviso "⚠ alterado" aceso.
// As duas funções abaixo são cópias fiéis de conteudoAssinadoAlmox / conteudoAssinadoEpi
// (backend/server.js). Mudou lá? Muda aqui.
// ---------------------------------------------------------------------------
function conteudoAssinadoAlmox(r) {
  return JSON.stringify({
    colaborador: r.funcionarioNome, cpf: r.funcionarioCpf, data: r.data, hora: r.hora,
    finalidade: r.finalidade, responsavel: r.responsavel,
    itens: (r.itens || []).map(i => [i.nome, i.tipo, i.quantidade, i.unidade, i.ca]),
    fotos: (r.fotos || []).map(f => f.id),
  });
}
function conteudoAssinadoEpi(m) {
  return JSON.stringify({
    colaborador: m.funcionarioNome, cpf: m.funcionarioCpf, cargo: m.funcionarioCargo,
    tipo: m.tipo, data: m.data, hora: m.hora, motivo: m.motivo, responsavel: m.responsavel,
    itens: (m.itens || []).map(i => [i.nome, i.codigo, i.ca, i.caValidade, i.tamanho, i.quantidade, i.unidade, i.vidaUtilMeses]),
  });
}
const sha256 = (txt) => crypto.createHash('sha256').update(txt).digest('hex');

const ALFABETO_CODIGO = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
const codigosUsados = new Set();
function codigoVerificacao() {
  let cod;
  do {
    cod = '';
    for (let i = 0; i < 12; i++) {
      if (i && i % 4 === 0) cod += '-';
      cod += ALFABETO_CODIGO[inteiro(0, ALFABETO_CODIGO.length - 1)];
    }
  } while (codigosUsados.has(cod));
  codigosUsados.add(cod);
  return cod;
}

/** Carimba as evidências de assinatura num recibo/ficha já montado. */
function assinar(registro, refAssinatura, quemAssinou, quandoTs, calcularHash) {
  registro.assinatura = refAssinatura;
  registro.assinaturaNome = quemAssinou;
  registro.assinaturaEm = quandoTs;
  registro.assinaturaHash = calcularHash(registro);
  registro.assinaturaCodigo = codigoVerificacao();
  registro.assinaturaIp = `192.168.${inteiro(0, 8)}.${inteiro(2, 250)}`;
  registro.assinaturaDispositivo = escolher(['Chrome · Android · celular', 'Chrome · Windows · computador', 'Safari · iOS · celular']);
  registro.assinaturaModo = escolher(['desenho', 'digitado']);
  registro.assinaturaAceite = true;
  return registro;
}

// ===========================================================================
// PESSOAS — a base de tudo: funcionários alimentam almoxarifado, EPI e multas.
// ===========================================================================
const PESSOAS = [
  { nome: 'Adriano Coelho Vasques', cargo: 'Encarregado de Manutenção', empresa: 'SUL', status: 'Ativo', contrato: CT_SUL_BA, centro: 'PAULO AFONSO', dirige: true, cnh: 'D' },
  { nome: 'Beatriz Salgado Furtado', cargo: 'Engenheira Civil', empresa: 'NTE', status: 'Ativo', contrato: CT_NTE_ORION, centro: 'CAMPINA GRANDE', dirige: true, cnh: 'B' },
  { nome: 'Caio Ferrer de Andrade', cargo: 'Motorista', empresa: 'SUL', status: 'Ativo', contrato: CT_SUL_SEDE, centro: 'SEDE', dirige: true, cnh: 'E' },
  { nome: 'Daniela Prates Moreira', cargo: 'Auxiliar Administrativo', empresa: 'NTE', status: 'Ativo', contrato: 'ESCRITORIO-NTE', centro: 'SEDE', dirige: false, cnh: '' },
  { nome: 'Eduardo Tavares Bittencourt', cargo: 'Eletricista de Linha Viva', empresa: 'NTE', status: 'Ativo', contrato: CT_NTE_LINHA, centro: 'NATAL', dirige: true, cnh: 'AB' },
  { nome: 'Fabiana Rocha Quintela', cargo: 'Técnica de Segurança do Trabalho', empresa: 'SUL', status: 'Ativo', contrato: CT_SUL_BA, centro: 'PAULO AFONSO', dirige: false, cnh: '' },
  { nome: 'Gustavo Peixoto Aragão', cargo: 'Pedreiro', empresa: 'SUL', status: 'Afastado', contrato: CT_SUL_BA, centro: 'PAULO AFONSO', dirige: false, cnh: '' },
  { nome: 'Helena Marques Vilanova', cargo: 'Assistente de Departamento Pessoal', empresa: 'NTE', status: 'Férias', contrato: 'ESCRITORIO-NTE', centro: 'SEDE', dirige: false, cnh: '' },
  { nome: 'Ícaro Bastos Ferrugem', cargo: 'Operador de Retroescavadeira', empresa: 'SUL', status: 'Ativo', contrato: CT_SUL_SEDE, centro: 'SEDE', dirige: true, cnh: 'C' },
  { nome: 'Juliana Cardoso Peçanha', cargo: 'Almoxarife', empresa: 'NTE', status: 'Ativo', contrato: CT_NTE_ORION, centro: 'CAMPINA GRANDE', dirige: false, cnh: '' },
  { nome: 'Kleber Antunes Sampaio', cargo: 'Eletricista de Linha Viva', empresa: 'NTE', status: 'Ativo', contrato: CT_NTE_LINHA, centro: 'NATAL', dirige: true, cnh: 'AB' },
  { nome: 'Lorena Fagundes Teixeira', cargo: 'Auxiliar de Escritório', empresa: 'SUL', status: 'Ativo', contrato: 'ESCRITORIO-SUL', centro: 'SEDE', dirige: false, cnh: '' },
  { nome: 'Murilo Assunção Barreto', cargo: 'Servente', empresa: 'SUL', status: 'Desligado', contrato: CT_SUL_BA, centro: 'PAULO AFONSO', dirige: false, cnh: '' },
  { nome: 'Natália Werneck Guimarães', cargo: 'Motorista', empresa: 'NTE', status: 'Ativo', contrato: CT_NTE_ORION, centro: 'CAMPINA GRANDE', dirige: true, cnh: 'D' },
];

const nomeContrato = (numero) => {
  for (const emp of CONTRATOS_CAT) {
    const c = emp.contratos.find(x => x.numero === numero);
    if (c) return c.nome;
  }
  return numero;
};
const localContrato = (numero) => {
  for (const emp of CONTRATOS_CAT) {
    const c = emp.contratos.find(x => x.numero === numero);
    if (c) return c.frentes[0] || '';
  }
  return '';
};

/**
 * Documentos do colaborador — mistura de propósito:
 *   índice 0 → vencido        (acende "Documento vencido" nas Pendências)
 *   índice 1 → vence em ~20d  (acende "A vencer", janela de 30 dias)
 *   índice 2 → em dia
 *   índice 3 → linha só de controle, sem arquivo anexado
 */
function documentosDoFuncionario(i) {
  const docs = [
    { nome: 'ASO', categoria: 'Segurança', emissao: iso(mes(-12)), validade: iso(dia(-15)) },
    { nome: 'NR-10 — Reciclagem', categoria: 'Treinamento', emissao: iso(mes(-23)), validade: iso(dia(20)) },
    { nome: 'Contrato de Trabalho', categoria: 'Contratual', emissao: iso(mes(-14)), validade: '', semValidade: true },
    { nome: 'Comprovante de Residência', categoria: 'Pessoal', emissao: iso(mes(-3)), validade: '', semValidade: true },
  ];
  return docs.slice(0, 2 + (i % 3)).map((d, k) => ({
    id: '',                       // sem binário: linha de controle (o cofre de mídia fica de fora)
    nome: d.nome,
    tipo: '',
    categoria: d.categoria,
    validade: d.validade || '',
    emissao: d.emissao,
    semValidade: !!d.semValidade,
    nomeOriginal: '',
    uploadTs: 0,
    uploadPor: '',
    versoes: [],
    obs: k === 0 ? 'Documento de exemplo gerado pelo seed' : '',
  }));
}

function montarFuncionarios() {
  return PESSOAS.map((p, i) => {
    const desligado = p.status === 'Desligado';
    const validadeCnh = p.dirige ? iso(mes(i % 3 === 0 ? -2 : 14 + i)) : ''; // alguns vencidos de propósito
    return {
      id: id('FN'),
      ts: ts(mes(-18 + i)),
      nome: p.nome,
      cargo: p.cargo,
      empresa: p.empresa,
      status: p.status,
      dataDemissao: desligado ? iso(mes(-2)) : '',
      motivoDemissao: desligado ? 'Pedido de demissão' : '',
      ppp: null,
      asoDemissional: null,
      cpf: cpfFake(i + 1),
      rg: rgFake(i + 1),
      orgaoEmissor: 'SSP/BA',
      matricula: String(9000 + i),
      nascimento: iso(new Date(1985 + (i % 15), (i * 3) % 12, 1 + (i % 27))),
      admissao: iso(mes(-20 - i)),
      admissao2: '',
      telefone: telFake(i + 1),
      email: `${p.nome.split(' ')[0].toLowerCase().normalize('NFD').replace(/[^a-z]/g, '')}.demo@exemplo.test`,
      endereco: `Rua das Demonstrações, ${100 + i * 7}`,
      cidade: escolher(['Paulo Afonso', 'Campina Grande', 'Natal', 'Salvador']),
      uf: escolher(['BA', 'PB', 'RN']),
      cep: cepFake(i + 1),
      emergNome: 'Contato de Emergência ' + (i + 1),
      emergTelefone: telFake(i + 40),
      emergParentesco: escolher(['Cônjuge', 'Mãe', 'Pai', 'Irmão(ã)']),
      setor: p.cargo.includes('Eletricista') ? 'Operação' : 'Administrativo',
      centroCusto: p.centro,
      tipoVinculo: 'CLT',
      baseTrabalho: p.centro,
      escala: escolher(['5x2', '6x1', '12x36']),
      experienciaCalculo: 'admissao',
      experienciaFim: '',
      experienciaFim2: '',
      contratos: [{ numero: p.contrato, nome: nomeContrato(p.contrato), local: localContrato(p.contrato) }],
      contratoNome: nomeContrato(p.contrato),
      contratoNumero: p.contrato,
      local: localContrato(p.contrato),
      cnhNumero: p.dirige ? String(10000000000 + i * 137) : '',
      cnhCategoria: p.cnh,
      cnhValidade: validadeCnh,
      podeDirigir: !!p.dirige && !desligado,
      cipa: i % 7 === 0 && !desligado,

      veiculoVinculado: p.dirige ? PLACAS[i % PLACAS.length] : '',
      obs: '',
      foto: null,
      fichaEpi: null,
      salarios: [],
      salarioDoc: null,
      documentos: documentosDoFuncionario(i),
      itens: [],
      soDev: false,
    };
  });
}

// ===========================================================================
// FROTA — cobre status, gravame, venda, compra e vencimentos.
// ===========================================================================
const MODELOS = [
  { modelo: 'Fiat Strada', versao: 'Endurance 1.4 CS', motor: '1.4', fipe: 'FIAT' },
  { modelo: 'VW Saveiro', versao: 'Robust 1.6 CS', motor: '1.6', fipe: 'VW' },
  { modelo: 'Toyota Hilux', versao: 'SR 2.8 4x4 Diesel', motor: '2.8', fipe: 'TOYOTA' },
  { modelo: 'Renault Duster', versao: 'Intense 1.6', motor: '1.6', fipe: 'RENAULT' },
  { modelo: 'Chevrolet S10', versao: 'LT 2.8 4x4 Diesel', motor: '2.8', fipe: 'GM' },
  { modelo: 'Ford Ranger', versao: 'XLS 3.2 Diesel', motor: '3.2', fipe: 'FORD' },
  { modelo: 'Fiat Toro', versao: 'Freedom 1.8', motor: '1.8', fipe: 'FIAT' },
  { modelo: 'Hyundai HR', versao: 'HD78 2.5 Diesel', motor: '2.5', fipe: 'HYUNDAI' },
  { modelo: 'Iveco Daily', versao: '35-150 Chassi', motor: '3.0', fipe: 'IVECO' },
  { modelo: 'Honda Biz', versao: '125 ES', motor: '0.1', fipe: 'HONDA' },
  { modelo: 'Mitsubishi L200', versao: 'Triton Sport GLX', motor: '2.4', fipe: 'MITSUBISHI' },
  { modelo: 'VW Gol', versao: '1.0 MPI', motor: '1.0', fipe: 'VW' },
];
// Cenários intencionais, um por veículo (o índice casa com MODELOS/PLACAS).
const CENARIOS_FROTA = [
  { status: 'EM ATIVIDADE', gravame: 'Sem gravame' },
  { status: 'OFICINA', gravame: 'Banco do Brasil', banco: 'Banco do Brasil', oficina: true },
  { status: 'EM ATIVIDADE', gravame: 'ALIENADO - Bradesco', banco: 'Bradesco' },
  { status: 'PARADO', gravame: 'Sem gravame', docVencido: true },
  { status: 'GALPÃO', gravame: 'Sem gravame' },
  { status: 'Vendido', gravame: 'Sem gravame', vendido: true },
  { status: 'EM ATIVIDADE', gravame: 'ALIENADO - Santander', banco: 'Santander', seguroAVencer: true },
  { status: 'OFICINA', gravame: 'Sem gravame', oficina: true },
  { status: 'EM ATIVIDADE', gravame: 'ALIENADO - Banco do Brasil', banco: 'Banco do Brasil', compra: true },
  { status: 'EM ATIVIDADE', gravame: 'Sem gravame' },
  { status: 'Vendido', gravame: 'Sem gravame', vendido: true },
  { status: 'PARADO', gravame: 'Sem gravame', licencVencido: true },
];

function montarVeiculos() {
  return MODELOS.map((m, i) => {
    const c = CENARIOS_FROTA[i];
    const anoFab = 2018 + (i % 7);
    const fipe = dinheiro(28000, 235000);
    // Divisão dos sócios POR veículo (fração 0–1, soma 1) — varia por centro de custo.
    const pctJ = [0.5, 0.6, 0.4, 0.7][i % 4];
    const v = {
      placa: PLACAS[i],
      modelo: m.modelo,
      versao: m.versao,
      anoFab,
      anoMod: anoFab + 1,
      cor: escolher(['Branco', 'Prata', 'Cinza', 'Preto', 'Vermelho']),
      motor: m.motor,
      tanque: null,
      centroCusto: CENTROS[i % CENTROS.length],
      dono: i % 2 === 0 ? 'Norte Engenharia' : 'Sul Empreendimentos',
      renavam: String(10000000000 + i * 987654),
      chassi: `9BD${String(100000 + i * 4321)}DEMO${String(1000 + i)}`,
      valorFipe: fipe,
      codigoFipe: `${String(1 + i).padStart(3, '0')}${String(100 + i)}-${i % 10}`,
      fipeTipo: m.modelo === 'Honda Biz' ? 'motos' : 'carros',
      fipeAno: `${anoFab}-1`,
      fipeAtualizadoEm: iso(dia(-inteiro(3, 40))),
      doc: c.docVencido ? HOJE.getFullYear() - 1 : HOJE.getFullYear(),
      ipvaVenc: iso(c.docVencido ? dia(-70) : dia(inteiro(30, 250))),
      licencVenc: iso(c.licencVencido ? dia(-25) : dia(inteiro(40, 300))),
      seguroVenc: iso(c.seguroAVencer ? dia(18) : dia(inteiro(60, 320))),
      seguroApolice: `AP-${String(700000 + i * 13)}`,
      status: c.status,
      oficinaPrevisaoSaida: c.oficina ? iso(dia(inteiro(3, 12))) : '',
      oficinaPrazoDias: c.oficina ? inteiro(3, 12) : null,
      gravame: c.gravame,
      banco: c.banco || '',
      pctRicardo: pctJ,
      pctMarcelo: Math.round((1 - pctJ) * 100) / 100,
      observacoes: c.oficina ? 'Veículo em manutenção corretiva (dado de exemplo).' : '',
      crlvDoc: null,
      compra: c.compra
        ? {
          ativo: true, data: iso(mes(-8)), valor: dinheiro(60000, 180000), forma: 'Financiamento',
          conta: 'Conta Corrente DEMO', vendedor: 'Concessionária Modelo LTDA', telefone: telFake(i + 3),
          observacao: 'Compra de exemplo gerada pelo seed',
        }
        : { ativo: false, data: '', valor: 0, forma: '', conta: '', vendedor: '', telefone: '', observacao: '' },
      venda: c.vendido
        ? {
          data: iso(mes(-3)), valor: Math.round(fipe * 0.94), desconto: 0, forma: 'PIX',
          conta: 'Conta Corrente DEMO', comprador: 'Comprador Exemplo ' + (i + 1),
          telefone: telFake(i + 20), statusAnterior: 'EM ATIVIDADE',
        }
        : { data: '', valor: 0, desconto: 0, forma: '', conta: '', comprador: '', telefone: '', statusAnterior: '' },
    };
    return v;
  });
}

// ===========================================================================
// MULTAS — uma por situação, com o processo do Detran em estágios diferentes.
// ===========================================================================
const INFRACOES = [
  { desc: 'Transitar em velocidade superior à máxima permitida em até 20%', valor: 130.16 },
  { desc: 'Estacionar em local proibido pela sinalização', valor: 195.23 },
  { desc: 'Avançar o sinal vermelho do semáforo', valor: 293.47 },
  { desc: 'Dirigir sem portar a CNH', valor: 130.16 },
  { desc: 'Conduzir o veículo com o licenciamento vencido', valor: 293.47 },
  { desc: 'Deixar de usar o cinto de segurança', valor: 195.23 },
  { desc: 'Usar o celular ao volante', valor: 293.47 },
  { desc: 'Transitar em faixa exclusiva de ônibus', valor: 293.47 },
];
const CENARIOS_MULTA = [
  { situacao: 'PENDENTE', etapas: 0 },
  { situacao: 'EM ANDAMENTO', etapas: 1 },
  { situacao: 'EM ANDAMENTO', etapas: 2 },
  { situacao: 'AGUARDANDO RETORNO', etapas: 3 },
  { situacao: 'PAGO', etapas: 4, pago: true },
  { situacao: 'PAGO', etapas: 4, pago: true },
  { situacao: 'PAGO', etapas: 2, pago: true },
  { situacao: 'PENDENTE', etapas: 0 },
];

function montarMultas(funcionarios) {
  const motoristas = funcionarios.filter(f => f.podeDirigir);
  return CENARIOS_MULTA.map((c, i) => {
    const inf = INFRACOES[i];
    const dataInf = dia(-inteiro(20, 200));
    const etapa = (n, rotulo) => c.etapas >= n;
    return {
      id: id('M'),
      placa: PLACAS[i % PLACAS.length],
      responsavel: motoristas.length ? motoristas[i % motoristas.length].nome : RESPONSAVEIS[i % 3],
      autoInfracao: `AA${String(1000000 + i * 7919)}`,
      descricao: inf.desc,
      dataInfracao: iso(dataInf),
      horaInfracao: `${String(inteiro(6, 20)).padStart(2, '0')}:${String(inteiro(0, 59)).padStart(2, '0')}`,
      local: `Av. das Demonstrações, km ${inteiro(1, 90)}`,
      cidadeEstado: escolher(['Paulo Afonso/BA', 'Campina Grande/PB', 'Natal/RN', 'Salvador/BA']),
      valor: inf.valor,
      situacao: c.situacao,
      formaPagamento: c.pago ? escolher(['Boleto', 'PIX', 'Débito em conta']) : '',
      dataVencimento: iso(new Date(dataInf.getTime() + 45 * 864e5)),
      dataPagamento: c.pago ? iso(new Date(dataInf.getTime() + 40 * 864e5)) : '',
      observacao: i === 0 ? 'Multa de exemplo — aguardando identificação do condutor.' : '',
      detranIdentificarOk: etapa(1),
      detranIdentificarData: etapa(1) ? iso(new Date(dataInf.getTime() + 5 * 864e5)) : '',
      detranIdentificarObs: etapa(1) ? 'Condutor identificado no sistema do Detran.' : '',
      detranTermoEnviadoOk: etapa(2),
      detranTermoEnviadoData: etapa(2) ? iso(new Date(dataInf.getTime() + 9 * 864e5)) : '',
      detranTermoEnviadoObs: '',
      detranTermoAssinadoOk: etapa(3),
      detranTermoAssinadoData: etapa(3) ? iso(new Date(dataInf.getTime() + 14 * 864e5)) : '',
      detranTermoAssinadoObs: etapa(3) ? 'Termo assinado e protocolado.' : '',
      detranPedidoDescontoOk: etapa(4),
      detranPedidoDescontoData: etapa(4) ? iso(new Date(dataInf.getTime() + 18 * 864e5)) : '',
      detranPedidoDescontoObs: '',
      documentos: [],
    };
  });
}

// ===========================================================================
// RASTREADORES — tipos e situações variados, um desativado.
// ===========================================================================
function montarRastreadores() {
  const cenarios = [
    { tipo: 'Instalado', situacao: 'Ativo' },
    { tipo: 'Instalado', situacao: 'Ativo' },
    { tipo: 'Removível', situacao: 'Novo' },
    { tipo: 'Removível', situacao: 'Removido', devolucao: true },
    { tipo: 'Instalado', situacao: 'Trocado', substituido: true },
    { tipo: 'Outros', situacao: 'Devolvido', devolucao: true },
    { tipo: 'Instalado', situacao: 'Ativo' },
    { tipo: 'Removível', situacao: 'Transferido' },
    { tipo: 'Instalado', situacao: 'Extraviado' },
    { tipo: 'Instalado', situacao: 'Ativo', desativado: true },
  ];
  return cenarios.map((c, i) => ({
    id: id('R'),
    codigo: String(880000 + i * 17),                      // N° Cobli (identificador único)
    esn: `ESN${String(4400000 + i * 313)}`,
    versao: escolher(['Cobli Go', 'Cobli Plug', 'Cobli Hard']),
    placa: c.situacao === 'Novo' ? '' : PLACAS[i % PLACAS.length],
    tipo: c.tipo,
    situacao: c.situacao,
    dataPedidoDevolucao: c.devolucao ? iso(dia(-40)) : '',
    dataDevolucao: c.devolucao ? iso(dia(-25)) : '',
    protocolo: c.devolucao ? `PROT-${String(50000 + i)}` : '',
    substituidoPor: c.substituido ? String(880000 + (i + 1) * 17) : '',
    veiculoDestino: c.situacao === 'Transferido' ? PLACAS[(i + 3) % PLACAS.length] : '',
    observacoes: c.desativado ? 'Equipamento fora de operação (exemplo).' : '',
    desativado: !!c.desativado,
    desativadoEm: c.desativado ? iso(dia(-12)) : '',
  }));
}

// ===========================================================================
// HISTÓRICO — entradas por placa e por rastreador (as duas consultas da tela).
// ===========================================================================
function montarHistorico(veiculos, rastreadores) {
  const linhas = [];
  const push = (o) => linhas.push({ id: id('H'), ...o });
  veiculos.slice(0, 8).forEach((v, i) => {
    push({ ts: ts(dia(-60 + i)), placa: v.placa, acao: 'criou', texto: `Veículo ${v.placa} cadastrado (${v.modelo}).`, por: escolher(RESPONSAVEIS) });
    push({ ts: ts(dia(-30 + i)), placa: v.placa, acao: 'editou', texto: `Status alterado para ${v.status}.`, por: escolher(RESPONSAVEIS) });
    if (v.status === 'Vendido') push({ ts: ts(dia(-10)), placa: v.placa, acao: 'vendeu', texto: `Veículo vendido para ${v.venda.comprador}.`, por: escolher(RESPONSAVEIS) });
  });
  rastreadores.slice(0, 6).forEach((r, i) => {
    push({ ts: ts(dia(-45 + i)), placa: r.placa || '', rast: r.codigo, acao: 'criou', texto: `Rastreador ${r.codigo} cadastrado (${r.tipo}).`, por: escolher(RESPONSAVEIS) });
    if (r.dataDevolucao) push({ ts: ts(dia(-25)), placa: r.placa || '', rast: r.codigo, acao: 'editou', texto: 'Devolução registrada.', por: escolher(RESPONSAVEIS) });
  });
  return linhas.sort((a, b) => b.ts - a.ts);
}

// ===========================================================================
// FORNECEDORES — um de cada tipo (os chips de filtro da tela).
// ===========================================================================
function montarFornecedores() {
  const base = [
    { nome: 'Oficina Central Demo', tipo: 'Oficina', emoji: '🔧', servicos: 'Mecânica geral, suspensão, freios', veiculos: 'Leves e utilitários' },
    { nome: 'Distribuidora Norte Peças', tipo: 'Distribuidora', emoji: '📦', servicos: 'Peças originais e paralelas', veiculos: 'Todos' },
    { nome: 'Concessionária Exemplo Motors', tipo: 'Concessionária', emoji: '🏢', servicos: 'Revisão de garantia, funilaria autorizada', veiculos: 'Linha leve' },
    { nome: 'Autopeças do Vale (Demo)', tipo: 'Autopeças', emoji: '⚙️', servicos: 'Filtros, correias, baterias', veiculos: 'Leves e pesados' },
    { nome: 'Funilaria Modelo', tipo: 'Funilaria', emoji: '🎨', servicos: 'Lataria, pintura, polimento', veiculos: 'Leves' },
    { nome: 'Pneus Sertão Demo', tipo: 'Pneus', emoji: '🛞', servicos: 'Venda, alinhamento, balanceamento', veiculos: 'Todos' },
    { nome: 'Guincho 24h Exemplo', tipo: 'Guincho', emoji: '🚛', servicos: 'Reboque, socorro em rodovia', veiculos: 'Até 3,5 t' },
    { nome: 'Elétrica Automotiva Teste', tipo: 'Outros', emoji: '🔌', servicos: 'Parte elétrica, ar-condicionado', veiculos: 'Leves e utilitários' },
  ];
  return base.map((f, i) => ({
    id: id('FO'),
    ts: ts(mes(-10 + i)),
    ...f,
    contato: escolher(['Sr. Exemplo', 'Sra. Demonstração', 'Atendimento']),
    telefone: telFake(i + 60),
    cidade: escolher(['Paulo Afonso', 'Campina Grande', 'Natal', 'Salvador']),
    uf: escolher(['BA', 'PB', 'RN']),
    endereco: `Rod. de Teste, km ${inteiro(2, 40)}`,
    obs: '',
    avaliacao: inteiro(3, 5),
  }));
}

// ===========================================================================
// EPI — catálogo + movimentações. O estoque é DERIVADO das movimentações, então
// cada EPI entra com um lançamento de "Saldo inicial" para o extrato fechar.
// ===========================================================================
const EPIS_BASE = [
  { nome: 'Capacete de segurança classe B', cat: 'Cabeça', un: 'un', min: 10, vida: 24, ca: '31.469', validadeCa: 14, tam: 'Único', contratos: [CT_NTE_LINHA, CT_NTE_ORION] },
  { nome: 'Luva isolante de borracha classe 2', cat: 'Membros superiores', un: 'par', min: 12, vida: 6, ca: '31.842', validadeCa: 10, tam: '10', contratos: [CT_NTE_LINHA] },
  { nome: 'Bota de segurança com biqueira composite', cat: 'Membros inferiores', un: 'par', min: 15, vida: 12, ca: '42.115', validadeCa: -2, tam: '41', contratos: [CT_SUL_BA, CT_NTE_ORION] },   // CA VENCIDO
  { nome: 'Óculos de proteção ampla visão', cat: 'Olhos e face', un: 'un', min: 20, vida: 12, ca: '29.334', validadeCaDias: 18, tam: 'Único', contratos: [CT_SUL_BA] },                             // CA A VENCER (dentro dos 30 dias de aviso)
  { nome: 'Protetor auricular tipo plug', cat: 'Auditiva', un: 'par', min: 40, vida: 6, ca: '19.578', validadeCa: 30, tam: 'Único', contratos: [CT_SUL_BA, CT_SUL_SEDE] },
  { nome: 'Respirador semifacial PFF2', cat: 'Respiratória', un: 'un', min: 30, vida: 3, ca: '38.501', validadeCa: 20, tam: 'M', contratos: [CT_SUL_SEDE] },
  { nome: 'Cinto paraquedista com talabarte duplo', cat: 'Proteção contra quedas', un: 'un', min: 6, vida: 60, ca: '35.720', validadeCa: 8, tam: 'Único', contratos: [CT_NTE_LINHA] },
  { nome: 'Vestimenta de proteção contra arco elétrico', cat: 'Corpo inteiro', un: 'un', min: 8, vida: 36, ca: '40.118', validadeCa: 26, tam: 'G', contratos: [CT_NTE_LINHA] },
  { nome: 'Colete refletivo laranja', cat: 'Tronco', un: 'un', min: 25, vida: 12, ca: '', validadeCa: null, tam: 'Único', contratos: [] },                                                          // SEM CA e SEM contrato (não migrado)
  { nome: 'Luva de vaqueta cano curto', cat: 'Membros superiores', un: 'par', min: 30, vida: 4, ca: '27.994', validadeCa: 18, tam: 'G', contratos: [CT_SUL_BA, CT_SUL_SEDE] },
  { nome: 'Perneira de segurança em raspa', cat: 'Membros inferiores', un: 'par', min: 10, vida: 18, ca: '33.207', validadeCa: 6, tam: 'Único', contratos: [CT_SUL_BA] },
  { nome: 'Máscara de solda com escurecimento automático', cat: 'Olhos e face', un: 'un', min: 4, vida: 36, ca: '36.885', validadeCa: 12, tam: 'Único', contratos: [CT_NTE_ORION] },
];

function montarEpiCatalogo() {
  return EPIS_BASE.map((e, i) => ({
    id: id('EPI'),
    ts: ts(mes(-14 + i)),
    nome: e.nome,
    codigo: `EPI-${String(i + 1).padStart(3, '0')}`,
    ca: e.ca,
    // `validadeCaDias` existe para o cenário "CA próximo do vencimento": o aviso é de 30 dias,
    // então mes(1) cairia FORA da janela (31 dias) e o status voltaria como "Válido".
    caValidade: e.validadeCaDias !== undefined ? iso(dia(e.validadeCaDias))
      : e.validadeCa === null ? '' : iso(mes(e.validadeCa)),
    fabricante: escolher(['Protec Demo', 'SegurMax Exemplo', 'EquipaSafe Teste']),
    categoria: e.cat,
    tamanho: e.tam,
    unidade: e.un,
    estoqueMinimo: e.min,
    vidaUtilMeses: e.vida,
    contratos: e.contratos,
    descricao: 'Item de exemplo gerado para desenvolvimento.',
    ativo: true,
    obs: '',
  }));
}

/** Item de movimentação = snapshot do catálogo no ato (é isto que a assinatura cobre). */
function itemEpi(epi, quantidade, extras = {}) {
  return {
    epiId: epi.id,
    nome: epi.nome,
    codigo: epi.codigo,
    ca: epi.ca,
    caValidade: epi.caValidade,
    tamanho: epi.tamanho,
    quantidade,
    unidade: epi.unidade,
    vidaUtilMeses: epi.vidaUtilMeses,
    descartar: false,
    condicao: '',
    obs: '',
    ...extras,
  };
}

function baseMovEpi(tipo, data, contratoNumero, extras = {}) {
  return {
    id: id('EPM'),
    ts: ts(data),
    tipo,
    data: iso(data),
    hora: `${String(inteiro(7, 17)).padStart(2, '0')}:${String(inteiro(0, 59)).padStart(2, '0')}`,
    funcionarioId: '',
    funcionarioNome: '',
    funcionarioCpf: '',
    funcionarioCargo: '',
    empresa: '',
    contrato: nomeContrato(contratoNumero),
    contratoNumero,
    setor: '',
    centroCusto: '',
    fornecedor: '',
    notaFiscal: '',
    responsavel: 'Juliana Cardoso Peçanha',
    responsavelUsuario: 'almoxarifado.demo',
    motivo: '',
    itens: [],
    obs: '',
    assinatura: null,
    assinaturaNome: '',
    assinaturaEm: 0,
    assinaturaHash: '',
    assinaturaCodigo: '',
    assinaturaIp: '',
    assinaturaDispositivo: '',
    assinaturaModo: '',
    assinaturaAceite: false,
    assinaturaConviteToken: '',
    assinaturaConviteValidadeTs: 0,
    ...extras,
  };
}

async function montarEpiMovimentacoes(catalogo, funcionarios) {
  const movs = [];
  const porCodigo = (cod) => catalogo.find(e => e.codigo === cod);
  const contratoDoEpi = (epi) => (epi.contratos && epi.contratos[0]) || CT_SUL_SEDE;

  // 1) Saldo inicial — uma Entrada por EPI, para o extrato fechar com o saldo do depósito.
  catalogo.forEach((epi, i) => {
    movs.push(baseMovEpi('Entrada', mes(-12), contratoDoEpi(epi), {
      motivo: 'Saldo inicial',
      fornecedor: 'Inventário inicial (demo)',
      itens: [itemEpi(epi, epi.estoqueMinimo * 3 + i)],
    }));
  });

  // 2) Compras — Entrada com nota fiscal (amarra com epi_notas_fiscais.json pelo número).
  movs.push(baseMovEpi('Entrada', mes(-5), CT_NTE_LINHA, {
    motivo: 'Compra',
    fornecedor: 'Distribuidora Norte Peças',
    notaFiscal: '000.145.902',
    itens: [itemEpi(porCodigo('EPI-002'), 40), itemEpi(porCodigo('EPI-001'), 25)],
  }));
  movs.push(baseMovEpi('Entrada', mes(-2), CT_SUL_BA, {
    motivo: 'Compra',
    fornecedor: 'SegurMax Exemplo',
    notaFiscal: '000.152.771',
    itens: [itemEpi(porCodigo('EPI-005'), 120), itemEpi(porCodigo('EPI-010'), 60)],
  }));

  // 3) Entregas assinadas — cada uma É uma ficha de EPI (NR-6).
  const entregas = [
    { pessoa: funcionarios[4], contrato: CT_NTE_LINHA, itens: [['EPI-001', 1], ['EPI-002', 1], ['EPI-007', 1]], quando: mes(-4) },
    { pessoa: funcionarios[10], contrato: CT_NTE_LINHA, itens: [['EPI-001', 1], ['EPI-008', 1]], quando: mes(-7) },   // vida útil estourando
    { pessoa: funcionarios[0], contrato: CT_SUL_BA, itens: [['EPI-003', 1], ['EPI-005', 2]], quando: mes(-1) },
  ];
  for (const e of entregas) {
    const mov = baseMovEpi('Entrega', e.quando, e.contrato, {
      funcionarioId: e.pessoa.id,
      funcionarioNome: e.pessoa.nome,
      funcionarioCpf: e.pessoa.cpf,
      funcionarioCargo: e.pessoa.cargo,
      empresa: e.pessoa.empresa,
      centroCusto: e.pessoa.centroCusto,
      setor: e.pessoa.setor,
      motivo: 'Entrega inicial',
      itens: e.itens.map(([cod, q]) => itemEpi(porCodigo(cod), q)),
    });
    assinar(mov, await novaAssinatura(e.pessoa.nome), e.pessoa.nome, ts(e.quando), (m) => sha256(conteudoAssinadoEpi(m)));
    movs.push(mov);
  }

  // 4) Entrega PENDENTE de assinatura (a ficha existe, falta o colaborador assinar).
  const pendente = funcionarios[8];
  movs.push(baseMovEpi('Entrega', dia(-3), CT_SUL_SEDE, {
    funcionarioId: pendente.id,
    funcionarioNome: pendente.nome,
    funcionarioCpf: pendente.cpf,
    funcionarioCargo: pendente.cargo,
    empresa: pendente.empresa,
    centroCusto: pendente.centroCusto,
    motivo: 'Entrega inicial',
    itens: [itemEpi(porCodigo('EPI-006'), 2), itemEpi(porCodigo('EPI-010'), 1)],
  }));

  // 5) Devolução — uma normal (volta ao estoque) e uma com descarte (não volta).
  const devolveu = funcionarios[0];
  movs.push(baseMovEpi('Devolução', dia(-20), CT_SUL_BA, {
    funcionarioId: devolveu.id,
    funcionarioNome: devolveu.nome,
    funcionarioCpf: devolveu.cpf,
    funcionarioCargo: devolveu.cargo,
    empresa: devolveu.empresa,
    motivo: 'Devolução por transferência de frente',
    itens: [itemEpi(porCodigo('EPI-005'), 1)],
  }));
  movs.push(baseMovEpi('Devolução', dia(-8), CT_NTE_LINHA, {
    funcionarioId: funcionarios[10].id,
    funcionarioNome: funcionarios[10].nome,
    funcionarioCpf: funcionarios[10].cpf,
    funcionarioCargo: funcionarios[10].cargo,
    empresa: funcionarios[10].empresa,
    motivo: 'Item danificado em serviço',
    itens: [itemEpi(porCodigo('EPI-008'), 1, { descartar: true, condicao: 'Danificado' })],
  }));

  // 6) Substituição assinada — o EPI trocado por desgaste é sucata, não volta ao estoque.
  const trocou = funcionarios[4];
  const sub = baseMovEpi('Substituição', dia(-5), CT_NTE_LINHA, {
    funcionarioId: trocou.id,
    funcionarioNome: trocou.nome,
    funcionarioCpf: trocou.cpf,
    funcionarioCargo: trocou.cargo,
    empresa: trocou.empresa,
    motivo: 'Troca por fim da vida útil',
    itens: [itemEpi(porCodigo('EPI-002'), 1, { condicao: 'Usado' })],
  });
  assinar(sub, await novaAssinatura(trocou.nome), trocou.nome, ts(dia(-5)), (m) => sha256(conteudoAssinadoEpi(m)));
  movs.push(sub);

  return movs.sort((a, b) => a.ts - b.ts);
}

function montarEpiNotasFiscais() {
  // Com e sem contrato de propósito: o dashboard de gasto agrupa as sem contrato em
  // "Sem contrato" e o filtro por contrato precisa dos dois casos para ser testável.
  return [
    { numero: '000.145.902', fornecedor: 'Distribuidora Norte Peças', dataCompra: iso(mes(-5)), descricao: 'Luvas isolantes classe 2 (40 pares) e capacetes classe B (25 un)', valorTotal: 8740.50, parcelas: 2, centroCusto: 'NATAL', contratoNumero: '4500000404', contrato: '4500000404 - MANUTENÇÃO DE LINHA - DEMO' },
    { numero: '000.152.771', fornecedor: 'SegurMax Exemplo', dataCompra: iso(mes(-2)), descricao: 'Protetores auriculares (120 pares) e luvas de vaqueta (60 pares)', valorTotal: 3120.00, parcelas: 1, centroCusto: 'PAULO AFONSO', contratoNumero: '4600000101', contrato: '4600000101 - MANUTENÇÃO CIVIL - DEMO BAHIA' },
    { numero: '000.158.310', fornecedor: 'Protec Demo', dataCompra: iso(mes(-1)), descricao: 'Cintos paraquedista com talabarte duplo (6 un)', valorTotal: 5490.90, parcelas: 3, centroCusto: 'NATAL', contratoNumero: '4500000404', contrato: '4500000404 - MANUTENÇÃO DE LINHA - DEMO' },
    { numero: '000.160.044', fornecedor: 'EquipaSafe Teste', dataCompra: iso(dia(-9)), descricao: 'Máscaras de solda automáticas (4 un)', valorTotal: 2360.00, parcelas: 1, centroCusto: 'CAMPINA GRANDE' },
  ].map((n, i) => ({
    id: id('EPI-NF'),
    ts: ts(dia(-30 - i)),
    ...n,
    observacoes: '',
    anexo: null,
    lancadoPor: 'Juliana Cardoso Peçanha',
  }));
}

// ===========================================================================
// ALMOXARIFADO — retiradas assinadas. Situação é DERIVADA (pendente/em posse/concluído).
// ===========================================================================
async function montarAlmoxarifado(funcionarios) {
  const retiradas = [];
  const base = (pessoa, data, extras = {}) => ({
    id: id('ALM'),
    ts: ts(data),
    data: iso(data),
    hora: `${String(inteiro(7, 16)).padStart(2, '0')}:${String(inteiro(0, 59)).padStart(2, '0')}`,
    funcionarioId: pessoa.id,
    funcionarioNome: pessoa.nome,
    funcionarioCpf: pessoa.cpf,
    funcionarioCargo: pessoa.cargo,
    empresa: pessoa.empresa,
    contrato: 'ORION',                                   // fixo no módulo (CONTRATO_ALMOX)
    centroCusto: pessoa.centroCusto,
    responsavel: 'Juliana Cardoso Peçanha',
    responsavelUsuario: 'almoxarifado.demo',
    finalidade: 'Serviço de exemplo',
    previsaoDevolucao: '',
    itens: [],
    assinatura: null,
    assinaturaNome: '',
    assinaturaEm: 0,
    assinaturaHash: '',
    assinaturaCodigo: '',
    assinaturaIp: '',
    assinaturaDispositivo: '',
    assinaturaModo: '',
    assinaturaAceite: false,
    obs: '',
    fotos: [],
    ...extras,
  });
  const item = (nome, tipo, quantidade, unidade, extras = {}) => ({
    nome, tipo, quantidade, unidade, ca: '', retornavel: tipo !== 'Material de consumo',
    devolucoes: [], obs: '', ...extras,
  });

  // A) Pendente de assinatura (sem assinatura → situação derivada "Pendente de assinatura")
  retiradas.push(base(funcionarios[8], dia(-2), {
    finalidade: 'Manutenção de rede — frente Campina Grande',
    previsaoDevolucao: iso(dia(12)),
    itens: [item('Furadeira de impacto 750W', 'Ferramenta', 1, 'un'), item('Jogo de chaves combinadas', 'Ferramenta', 1, 'jogo')],
  }));

  // B) Em posse (assinado, item retornável ainda não devolvido) + fotos da entrega
  const emPosse = base(funcionarios[0], dia(-25), {
    finalidade: 'Reforma do galpão — Paulo Afonso',
    previsaoDevolucao: iso(dia(5)),
    itens: [item('Betoneira 400L', 'Equipamento', 1, 'un'), item('Carrinho de mão', 'Ferramenta', 2, 'un')],
    fotos: [await novaMidia('entrega-betoneira.png', svgFoto('Betoneira 400L', '#1d4ed8'))],
  });
  assinar(emPosse, await novaAssinatura(funcionarios[0].nome), funcionarios[0].nome, ts(dia(-25)), (r) => sha256(conteudoAssinadoAlmox(r)));
  retiradas.push(emPosse);

  // C) Devolução PARCIAL — pegou 6, trouxe 3. Continua "Em posse" com saldo 3.
  const parcial = base(funcionarios[4], dia(-18), {
    finalidade: 'Reisolamento de linha — Natal',
    previsaoDevolucao: iso(dia(-2)),
    itens: [
      item('Alicate isolado 1000V', 'Ferramenta', 6, 'un', {
        devolucoes: [{ qtd: 3, data: iso(dia(-6)), devolvidoPara: 'Juliana Cardoso Peçanha', devolvidoPor: 'Kleber Antunes Sampaio', ts: ts(dia(-6)) }],
      }),
      item('Fita isolante 20m', 'Material de consumo', 10, 'un'),
    ],
  });
  assinar(parcial, await novaAssinatura(funcionarios[4].nome), funcionarios[4].nome, ts(dia(-18)), (r) => sha256(conteudoAssinadoAlmox(r)));
  retiradas.push(parcial);

  // D) Concluído — tudo devolvido (duas parcelas somando o total)
  const concluido = base(funcionarios[2], mes(-2), {
    finalidade: 'Transporte de material — SEDE',
    itens: [
      item('Cinta de amarração 5t', 'Equipamento', 4, 'un', {
        devolucoes: [
          { qtd: 2, data: iso(mes(-1)), devolvidoPara: 'Juliana Cardoso Peçanha', devolvidoPor: 'Caio Ferrer de Andrade', ts: ts(mes(-1)) },
          { qtd: 2, data: iso(dia(-9)), devolvidoPara: 'Lorena Fagundes Teixeira', devolvidoPor: 'Caio Ferrer de Andrade', ts: ts(dia(-9)) },
        ],
      }),
    ],
  });
  assinar(concluido, await novaAssinatura(funcionarios[2].nome), funcionarios[2].nome, ts(mes(-2)), (r) => sha256(conteudoAssinadoAlmox(r)));
  retiradas.push(concluido);

  // E) Só material de consumo — já sai baixado, nasce "Concluído"
  const consumo = base(funcionarios[6], dia(-40), {
    finalidade: 'Alvenaria — bloco B',
    itens: [item('Disco de corte 7"', 'Material de consumo', 10, 'un'), item('Luva de vaqueta', 'EPI', 2, 'par', { retornavel: false })],
  });
  assinar(consumo, await novaAssinatura(funcionarios[6].nome), funcionarios[6].nome, ts(dia(-40)), (r) => sha256(conteudoAssinadoAlmox(r)));
  retiradas.push(consumo);

  // F) Uniforme + EPI, ainda em posse, com observação
  const uniforme = base(funcionarios[13], dia(-11), {
    finalidade: 'Admissão — kit inicial',
    itens: [item('Camisa manga longa', 'Uniforme', 2, 'un'), item('Calça brim', 'Uniforme', 2, 'un'), item('Bota de segurança', 'EPI', 1, 'par')],
    obs: 'Kit de admissão (dado de exemplo).',
  });
  assinar(uniforme, await novaAssinatura(funcionarios[13].nome), funcionarios[13].nome, ts(dia(-11)), (r) => sha256(conteudoAssinadoAlmox(r)));
  retiradas.push(uniforme);

  return retiradas;
}

// ===========================================================================
// MANUTENÇÃO e ABASTECIMENTO — datas em formato BR (é o que os normalizadores esperam).
// ===========================================================================
function montarManutencao(veiculos) {
  const itens = ['Troca de óleo e filtros', 'Pastilhas de freio dianteiras', 'Revisão de 40.000 km',
    'Troca de correia dentada', 'Alinhamento e balanceamento', 'Reparo no ar-condicionado',
    'Troca de bateria', 'Suspensão dianteira', 'Embreagem', 'Revisão elétrica'];
  const lista = [];
  veiculos.slice(0, 10).forEach((v, i) => {
    for (let k = 0; k < 2; k++) {
      lista.push({
        id: id('MNT'),
        ts: ts(dia(-inteiro(10, 300))),
        data: br(dia(-inteiro(10, 300))),
        placa: v.placa,
        montadora: v.modelo.split(' ')[0],
        modelo: v.modelo,
        ano: String(v.anoFab),
        tipo: (i + k) % 3 === 0 ? 'Preventiva' : 'Corretiva',
        item: itens[(i * 2 + k) % itens.length],
        custo: dinheiro(180, 4800),
        centroCusto: v.centroCusto,
        motorista: escolher(PESSOAS.filter(p => p.dirige).map(p => p.nome)),
      });
    }
  });
  return lista;
}

// Leituras de odômetro (Manutenção › Odômetro): 12 veículos com leituras a cada 1 a 3 semanas
// nos últimos ~5 meses. Três cenários de propósito, para a tela mostrar todos os estados:
// o 3º veículo tem uma leitura digitada errada (o odômetro "voltou"), o 4º tem um zero a mais
// (salto), e o 5º parou de ter leitura há ~2 meses (sem leitura recente).
// USO: montarOdometros(veiculos) // => [{ id:'ODO…', placa:'MOK1A01', data:'2026-04-20', km:45120, obs:'', origem:'planilha', ... }]
function montarOdometros(veiculos) {
  const lista = [];
  veiculos.slice(0, 12).forEach((v, i) => {
    let km = inteiro(15000, 120000);
    let d = -inteiro(140, 160);
    const fim = i === 4 ? -60 : -inteiro(1, 6);
    let k = 0;
    while (d <= fim) {
      let valor = km;
      let obs = k === 0 ? 'Primeira leitura' : '';
      if (i === 2 && k === 4) { valor = km - 1800; obs = 'Leitura de exemplo digitada errada'; }
      if (i === 3 && k === 5) { valor = km * 10; obs = 'Zero a mais (exemplo)'; }
      lista.push({
        id: id('ODO'), placa: v.placa, data: iso(dia(d)), km: valor, obs,
        origem: k % 4 === 3 ? 'manual' : 'planilha', arquivo: k % 4 === 3 ? '' : 'odometro-exemplo.xlsx',
        ts: ts(dia(d)), por: escolher(RESPONSAVEIS),
      });
      const passo = inteiro(7, 21);
      d += passo;
      km += passo * inteiro(35, 140);
      k++;
    }
  });
  return lista;
}

function montarAbastecimento(veiculos) {
  const lista = [];
  veiculos.slice(0, 10).forEach((v, i) => {
    let odometro = inteiro(20000, 90000);
    for (let k = 0; k < 3; k++) {
      odometro += inteiro(300, 900);
      const litros = dinheiro(28, 72);
      const preco = dinheiro(5.4, 6.9);
      const kmL = Math.round((inteiro(60, 130) / 10) * 100) / 100;
      const alerta = kmL < 7;
      const d = dia(-inteiro(3, 120));
      lista.push({
        id: id('A'),
        ts: ts(d),
        dataHora: `${br(d)} ${String(inteiro(6, 20)).padStart(2, '0')}:${String(inteiro(0, 59)).padStart(2, '0')}`,
        placa: v.placa,
        modelo: v.modelo,
        ano: String(v.anoFab),
        motorista: escolher(PESSOAS.filter(p => p.dirige).map(p => p.nome)),
        centroCusto: v.centroCusto,
        posto: escolher(['Posto Demo BR-110', 'Auto Posto Exemplo', 'Posto Teste Centro']),
        cidade: escolher(['Paulo Afonso', 'Campina Grande', 'Natal']),
        uf: escolher(['BA', 'PB', 'RN']),
        combustivel: escolher(['Diesel S10', 'Gasolina comum', 'Etanol']),
        litros,
        precoLitro: preco,
        odometro,
        kmL,
        kmRod: inteiro(300, 900),
        valor: Math.round(litros * preco * 100) / 100,
        statusKmL: alerta ? 'ABAIXO' : 'OK',
        statusPreco: 'OK',
        alerta,
        motivos: alerta ? 'Consumo abaixo do esperado' : '',
      });
    }
  });
  return lista;
}

// ===========================================================================
// CONTRATOS (consórcio / financiamento) — duas séries de parcelas.
// ===========================================================================
function montarContratos() {
  const lista = [];
  const series = [
    { serieId: id('CS'), banco: 'Banco do Brasil', produto: 'Financiamento', empresa: 'NTE', material: 'Toyota Hilux SR 2.8', grupo: '', cota: '', valor: 3480.55, total: 48 },
    { serieId: id('CS'), banco: 'Bradesco', produto: 'Consórcio', empresa: 'SUL', material: 'Fiat Toro Freedom', grupo: '1420', cota: '317', valor: 2190.00, total: 80 },
  ];
  series.forEach((s, si) => {
    for (let p = 1; p <= 4; p++) {
      const venc = mes(-4 + p);
      const pago = p <= 2;
      lista.push({
        id: id('C'),
        ts: ts(venc),
        serieId: s.serieId,
        dataEmissao: br(mes(-12)),
        fornecedor: si === 0 ? 'Concessionária Exemplo Motors' : 'Administradora Demo',
        banco: s.banco,
        produto: s.produto,
        grupo: s.grupo,
        cota: s.cota,
        material: s.material,
        empresa: s.empresa,
        localCarro: CENTROS[si],
        parcela: `${p}/${s.total}`,
        valorParcela: s.valor,
        saldoQuitacao: Math.round(s.valor * (s.total - p) * 0.82),
        descontoQuitacao: '',
        carencia: '',
        inicioParcelas: br(mes(-5)),
        vencimento: br(venc),
        dataPagamento: pago ? br(new Date(venc.getTime() - 2 * 864e5)) : '',
        escritorio: 'SEDE',
        valorPago: pago ? s.valor : '',
        conta: 'Conta Corrente DEMO',
        naJustica: false,
      });
    }
  });
  return lista;
}

// ===========================================================================
// Demais coleções pequenas
// ===========================================================================
function montarFeedbacks() {
  return [
    { tipo: 'Sugestão', titulo: 'Filtrar multas por centro de custo', descricao: 'Seria útil um filtro por centro de custo na aba Multas.', status: 'Em análise', autor: 'Daniela Prates Moreira' },
    { tipo: 'Problema', titulo: 'Tabela de frota corta no celular', descricao: 'Em telas pequenas a coluna de valores fica escondida.', status: 'Planejado', autor: 'Adriano Coelho Vasques' },
    { tipo: 'Sugestão', titulo: 'Exportar EPI por colaborador', descricao: 'Poder baixar a ficha de EPI de uma pessoa em PDF único.', status: 'Concluído', autor: 'Fabiana Rocha Quintela', resposta: 'Disponível no botão Ficha da aba EPI.' },
    { tipo: 'Sugestão', titulo: 'Aviso de CNH vencendo', descricao: 'Notificar 30 dias antes do vencimento da CNH dos motoristas.', status: 'Novo', autor: 'Beatriz Salgado Furtado' },
  ].map((f, i) => ({
    id: id('F'),
    ts: ts(dia(-inteiro(5, 90))),
    tipo: f.tipo,
    titulo: f.titulo,
    descricao: f.descricao,
    autor: f.autor,
    autorUser: 'demo.user',
    status: f.status,
    resposta: f.resposta || '',
    respostaPor: f.resposta ? 'Equipe de desenvolvimento' : '',
    respostaTs: f.resposta ? ts(dia(-3)) : 0,
    apoios: i % 2 === 0 ? ['demo.user', 'admin'] : [],
    imagens: [],
    oculto: false,
  }));
}

function montarInstalacoes(rastreadores) {
  return rastreadores.slice(0, 4).map((r, i) => ({
    id: id('I'),
    ts: ts(dia(-inteiro(20, 150))),
    data: br(dia(-inteiro(20, 150))),
    colaborador: escolher(PESSOAS.map(p => p.nome)),
    veiculoEquip: `${PLACAS[i]} — instalação de rastreador`,
    numeroSerie: r.codigo,
    rastreadorId: r.id,
    placa: r.placa || PLACAS[i],
    local: escolher(['Paulo Afonso', 'Campina Grande', 'Natal']),
    observacoes: 'Instalação de exemplo.',
    fotos: [],
  }));
}

function montarEnvios() {
  const status = ['Aguardando postagem', 'Em trânsito', 'Entregue'];
  return status.map((st, i) => ({
    id: id('E'),
    ts: ts(dia(-inteiro(2, 40))),
    tipoItem: 'Rastreador Cobli',
    destinatario: escolher(PESSOAS.map(p => p.nome)),
    dataEnvio: br(dia(-inteiro(5, 30))),
    transportadora: escolher(['Correios (demo)', 'Transportadora Exemplo']),
    codigoRastreamento: `DM${String(100000000 + i * 7919)}BR`,
    status: st,
    dataEntrega: st === 'Entregue' ? br(dia(-2)) : '',
    observacoes: '',
    comprovantes: [],
  }));
}

async function montarDocumentosEmpresa() {
  const pastaId = id('PD');
  const arquivo = await novaMidia('alvara-demo.png', svgFoto('Alvará (exemplo)', '#0f766e'));
  return {
    pastas: [
      { id: pastaId, nome: 'Documentos institucionais', pastaPaiId: '', criadoEm: ts(mes(-6)), atualizadoEm: ts(mes(-6)), atualizadoPor: 'admin' },
    ],
    documentos: [
      {
        id: id('DE'), ts: ts(mes(-6)), pastaId, titulo: 'Alvará de funcionamento (exemplo)',
        categoria: 'Licenças', descricao: 'Documento fictício para desenvolvimento.',
        validade: iso(dia(45)), arquivo, atualizadoEm: ts(mes(-6)), atualizadoPor: 'admin',
      },
      {
        id: id('DE'), ts: ts(mes(-3)), pastaId, titulo: 'Certidão negativa (exemplo)',
        categoria: 'Certidões', descricao: 'Documento fictício para desenvolvimento.',
        validade: iso(dia(-10)), arquivo: null, atualizadoEm: ts(mes(-3)), atualizadoPor: 'admin',
      },
    ],
  };
}

/**
 * Ações de Segurança (SST): controle mensal de DDS/treinamentos/inspeções.
 * Cobre todos os cenários que a tela deriva: realizada com/sem evidência (recente e
 * com mais de 30 dias — as duas severidades do alerta), atrasada, cancelada, futura,
 * perto do prazo, prazo distante, SEM prazo (usa o fim do mês) e evidência substituída
 * (versoes[] — valida a faxina de mídia órfã e o backup das versões anteriores).
 */
async function montarAcoesSst(funcionarios) {
  const resp = (i) => (funcionarios[i % funcionarios.length] || {}).nome || RESPONSAVEIS[i % RESPONSAVEIS.length];
  const mesRef = (d) => iso(d).slice(0, 7);
  const evid = async (rotulo, cor, categoria, quando) => ({
    id: (await novaMidia(`evidencia-${rotulo.toLowerCase().replace(/\s+/g, '-')}.png`, svgFoto(rotulo, cor))).id,
    nome: rotulo, tipo: 'image/png', categoria, nomeOriginal: rotulo + '.png',
    uploadTs: ts(quando), uploadPor: 'gestor.demo', versoes: [],
  });
  const evLista = await evid('Lista de presenca DDS', '#1d4ed8', 'Lista de presença', dia(-20));
  const evFoto = await evid('Foto do DDS', '#0f766e', 'Foto', dia(-20));
  // Evidência substituída: a versão atual guarda a anterior em versoes[].
  const versaoAntiga = await novaMidia('relatorio-inspecao-v1.png', svgFoto('Relatório v1', '#b45309'));
  const evSubstituida = await evid('Relatorio de inspecao', '#7c3aed', 'Relatório', dia(-8));
  evSubstituida.versoes = [{ id: versaoAntiga.id, nome: 'Relatorio de inspecao (v1)', tipo: 'image/png', nomeOriginal: 'relatorio-v1.png', uploadTs: ts(dia(-12)), uploadPor: 'gestor.demo', substituidoTs: ts(dia(-8)), substituidoPor: 'gestor.demo' }];
  const base = (i, extra) => ({
    id: id('AS'), ts: ts(mes(-1)), descricao: 'Ação fictícia para desenvolvimento.',
    empresa: '', contratoNumero: '', cor: '',
    agendamento: 'fixa', prazo: '', dataRealizacao: '', observacaoRealizacao: '', cancelada: false, motivoCancelamento: '',
    criadoPor: 'gestor.demo', atualizadoPor: '', atualizadoEm: 0, realizadoPor: '', evidencias: [], ...extra,
  });
  return [
    // Realizada com evidências (múltiplas, uma delas com versão anterior). Vínculos de
    // empresa/contrato espalhados pelos registros (e alguns SEM vínculo = legado/ação geral)
    // para os filtros Empresa/Contrato da aba terem o que recortar.
    base(0, { mesRef: mesRef(dia(-20)), titulo: 'DDS sobre uso de EPI', tipo: 'DDS', responsavel: resp(0), empresa: 'SUL', contratoNumero: CT_SUL_BA, prazo: iso(dia(-18)), dataRealizacao: iso(dia(-20)), realizadoPor: 'gestor.demo', observacaoRealizacao: '18 participantes; sem ocorrências.', evidencias: [evLista, evFoto] }),
    base(1, { mesRef: mesRef(dia(-10)), titulo: 'Inspeção de máquinas e equipamentos', tipo: 'Inspeção', responsavel: resp(1), empresa: 'NTE', contratoNumero: CT_NTE_ORION, prazo: iso(dia(-10)), dataRealizacao: iso(dia(-10)), realizadoPor: 'gestor.demo', evidencias: [evSubstituida] }),
    // Realizada SEM evidência — recente (alerta normal) e com mais de 30 dias (alerta crítico).
    base(2, { mesRef: mesRef(dia(-5)), titulo: 'Treinamento NR-35 (reciclagem)', tipo: 'Treinamento NR', responsavel: resp(2), prazo: iso(dia(-4)), dataRealizacao: iso(dia(-5)), realizadoPor: 'sst.demo' }),
    base(3, { mesRef: mesRef(dia(-45)), titulo: 'Campanha de prevenção auditiva', tipo: 'Campanha', responsavel: resp(3), prazo: iso(dia(-44)), dataRealizacao: iso(dia(-45)), realizadoPor: 'sst.demo' }),
    // Atrasada (prazo vencido, nada realizado) e cancelada (com motivo).
    base(4, { mesRef: mesRef(dia(-15)), titulo: 'Inspeção de extintores', tipo: 'Inspeção', responsavel: resp(4), empresa: 'SUL', contratoNumero: CT_SUL_SEDE, prazo: iso(dia(-15)) }),
    base(5, { mesRef: mesRef(HOJE), titulo: 'Simulado de abandono de área', tipo: 'Treinamento', responsavel: resp(5), prazo: iso(dia(12)), cancelada: true, motivoCancelamento: 'Adiado a pedido do cliente (demo).' }),
    // Mês corrente: flexível perto do limite (flutua no dia de hoje no calendário),
    // fixa de prazo distante (Programada) e flexível SEM data limite (vale o fim do mês).
    base(6, { mesRef: mesRef(HOJE), titulo: 'DDS segurança operacional', tipo: 'DDS', responsavel: resp(6), empresa: 'NTE', contratoNumero: CT_NTE_LINHA, agendamento: 'atePrazo', prazo: iso(dia(3)), cor: 'roxo' }),
    base(7, { mesRef: mesRef(mes(1)), titulo: 'Treinamento NR-12 (máquinas)', tipo: 'Treinamento NR', responsavel: resp(7), empresa: 'SUL', prazo: iso(mes(1)) }),
    base(8, { mesRef: mesRef(HOJE), titulo: 'Inspeção de EPI nas frentes', tipo: 'Inspeção', responsavel: resp(8), empresa: 'NTE', agendamento: 'atePrazo', cor: 'verde' }),
    // Futura (mês seguinte, flexível sem data limite).
    base(9, { mesRef: mesRef(mes(1)), titulo: 'Campanha SIPAT (planejamento)', tipo: 'Campanha', responsavel: resp(9), agendamento: 'atePrazo' }),
  ];
}

/**
 * Usuários de teste. Senha de TODOS: demo1234
 * O admin do .env (APP_PASSWORD) continua funcionando — o servidor o injeta por cima da lista.
 */
const SENHA_DEMO = 'demo1234';
const AREAS_PERMISSAO = ['frota', 'multas', 'rastreadores', 'instalacoes', 'manutencao', 'abastecimento',
  'fornecedores', 'locacoes', 'funcionarios', 'almoxarifado', 'epi', 'admissao', 'integracao', 'programas', 'acoesSst',
  'simulador', 'contratos', 'cartoes', 'controles', 'contabilidade', 'investimentos', 'custos', 'senhas',
  'documentos', 'ti', 'feedback', 'cadastros'];

function permissoes(modo, excecoes = {}) {
  const p = {};
  for (const a of AREAS_PERMISSAO) p[a] = excecoes[a] || modo;
  return p;
}
function usuarioDemo(usuario, nome, nivel, status, perms, extras) {
  const salt = crypto.createHash('sha256').update('salt:' + usuario).digest('hex').slice(0, 32);
  const senhaHash = crypto.pbkdf2Sync(SENHA_DEMO, salt, 100000, 32, 'sha256').toString('hex');
  return { id: 'U-' + usuario.toUpperCase().slice(0, 6), usuario, nome, salt, senhaHash, nivel, status, criadoEm: ts(mes(-6)), permissoes: perms, ...(extras || {}) };
}
function montarUsuarios() {
  return {
    cadastrosAbertos: true,
    usuarios: [
      usuarioDemo('dev.demo', 'Dev Demonstração', 'dev', 'aprovado', permissoes('editar')),
      usuarioDemo('gestor.demo', 'Gestor Demonstração', 'admin', 'aprovado', permissoes('editar')),
      // Operacional: edita frota/multas/rastreadores, só lê o resto do operacional, nada de pessoal.
      usuarioDemo('operacao.demo', 'Operação Demonstração', 'comum', 'aprovado',
        permissoes('nenhum', { frota: 'editar', multas: 'editar', rastreadores: 'editar', manutencao: 'ver', abastecimento: 'ver', fornecedores: 'ver', feedback: 'editar' })),
      // Segurança do trabalho: só EPI e almoxarifado.
      // ⚠️ permissão em `funcionarios`/`admissao` só funciona junto com `empresasFunc`
      // ('' = nenhuma empresa → a aba some mesmo com 'ver'; ver aplicarPermissoesAbas).
      usuarioDemo('sst.demo', 'SST Demonstração', 'comum', 'aprovado',
        permissoes('nenhum', { epi: 'editar', almoxarifado: 'editar', acoesSst: 'editar', funcionarios: 'ver', feedback: 'editar' }), { empresasFunc: 'ambas' }),
      // Somente leitura, para testar a trava de edição.
      usuarioDemo('leitura.demo', 'Leitura Demonstração', 'comum', 'aprovado', permissoes('ver'), { empresasFunc: 'ambas' }),
      // Aguardando aprovação do admin (não entra até ser aprovado).
      usuarioDemo('novato.demo', 'Novato Demonstração', 'comum', 'pendente', permissoes('nenhum')),
    ],
  };
}

function montarFuncObrigatorios() {
  return {
    cargos: {
      'Motorista': ['CNH', 'ASO', 'Contrato de Trabalho'],
      'Eletricista de Linha Viva': ['ASO', 'NR-10 — Reciclagem', 'NR-35', 'Contrato de Trabalho'],
      'Pedreiro': ['ASO', 'Contrato de Trabalho'],
      'Servente': ['ASO', 'Contrato de Trabalho'],
    },
    contratos: {
      [CT_NTE_LINHA]: ['NR-10 — Reciclagem', 'NR-35'],
      [CT_SUL_BA]: ['ASO'],
    },
  };
}

// ===========================================================================
// Escrita
// ===========================================================================
function escrever(arquivo, conteudo) {
  const destino = path.join(DATA_DIR, arquivo);
  if (!APLICAR) return { arquivo, bytes: Buffer.byteLength(JSON.stringify(conteudo, null, 2)) };
  fs.mkdirSync(path.dirname(destino), { recursive: true });
  fs.writeFileSync(destino, JSON.stringify(conteudo, null, 2), 'utf-8');
  return { arquivo, bytes: fs.statSync(destino).size };
}

/** Apaga o conteúdo atual de data/ (menos o cache público de CA), com cópia antes. */
function limparDataDir() {
  const PRESERVAR = new Set(['epi_caepi.json']); // índice público do CAEPI (gov.br), não é dado da empresa
  if (!fs.existsSync(DATA_DIR)) return { copiados: 0, removidos: 0, backup: null };
  const backupDir = path.join(DATA_DIR, `_backup-antes-do-seed-${Date.now()}`);
  const alvos = fs.readdirSync(DATA_DIR).filter(n => !n.startsWith('_backup-antes-do-seed-') && !PRESERVAR.has(n));
  if (!APLICAR) return { copiados: alvos.length, removidos: alvos.length, backup: backupDir };

  fs.mkdirSync(backupDir, { recursive: true });
  let copiados = 0, removidos = 0;
  for (const nome of alvos) {
    const origem = path.join(DATA_DIR, nome);
    fs.cpSync(origem, path.join(backupDir, nome), { recursive: true });
    copiados++;
    fs.rmSync(origem, { recursive: true, force: true });
    removidos++;
  }
  return { copiados, removidos, backup: backupDir };
}

async function main() {
  console.log(`\n🌱 seed-mock — dados FICTÍCIOS para desenvolvimento`);
  console.log(`   pasta: ${DATA_DIR}`);
  console.log(`   modo:  ${APLICAR ? 'APLICAR (grava)' : 'DRY-RUN (não grava — use --apply)'}`);
  console.log(`   semente: ${SEMENTE}\n`);

  if (LIMPAR) {
    const r = limparDataDir();
    console.log(`🧹 limpeza: ${r.removidos} itens ${APLICAR ? 'removidos' : 'seriam removidos'} (cópia em ${r.backup})`);
    console.log('   preservado: epi_caepi.json (índice público de CA do gov.br)\n');
  }

  // Ordem importa: quem vem depois referencia quem veio antes.
  const funcionarios = montarFuncionarios();
  const veiculos = montarVeiculos();
  const multas = montarMultas(funcionarios);
  const rastreadores = montarRastreadores();
  const instalacoes = montarInstalacoes(rastreadores);
  // USO: o seed já traz vínculos e instalações datadas para abrir o histórico na primeira visita.
  const rastreadoresVinculos = recuperarLegado(rastreadores, instalacoes, []);
  const historico = montarHistorico(veiculos, rastreadores);
  const fornecedores = montarFornecedores();
  const epiCatalogo = montarEpiCatalogo();
  const epiMovimentacoes = await montarEpiMovimentacoes(epiCatalogo, funcionarios);
  const almoxarifado = await montarAlmoxarifado(funcionarios);
  const documentos = await montarDocumentosEmpresa();
  const acoesSst = await montarAcoesSst(funcionarios);
  const manutencao = montarManutencao(veiculos);
  const abastecimento = montarAbastecimento(veiculos);
  const odometros = montarOdometros(veiculos);
  const contratos = montarContratos();
  const feedbacks = montarFeedbacks();
  const envios = montarEnvios();

  // Módulos extras (scripts/seed-mock/*.js): cada um recebe o contexto, pode completar as
  // entidades acima (ex.: CRLV dos veículos) e devolve { 'arquivo.json': conteudo }.
  // USO (num módulo): exports.montar = async (ctx) => ({ 'vistorias.json': { vistorias: [...] } });
  const ctx = {
    HOJE, rnd, inteiro, escolher, dinheiro, id, idMidia, dia, mes, iso, br, ts, cpfFake, rgFake, telFake, cepFake,
    novaMidia, novaMidiaBuffer, novoPdf, novaAssinatura, svgFoto, svgAssinatura, sha256, codigoVerificacao,
    PLACAS, CENTROS, RESPONSAVEIS, PESSOAS, CONTRATOS_CAT, CT_SUL_BA, CT_SUL_SEDE, CT_NTE_ORION, CT_NTE_LINHA,
    funcionarios, veiculos, multas, rastreadores, instalacoes, historico, fornecedores, epiCatalogo, epiMovimentacoes,
    almoxarifado, documentos, acoesSst, manutencao, abastecimento, odometros, contratos, feedbacks, envios,
  };
  const extras = {};
  let falhasExtras = 0;
  const pastaExtras = path.join(__dirname, 'seed-mock');
  const modulos = fs.existsSync(pastaExtras) ? fs.readdirSync(pastaExtras).filter(n => n.endsWith('.js')).sort() : [];
  for (const nome of modulos) {
    try {
      Object.assign(extras, await require(path.join(pastaExtras, nome)).montar(ctx));
      console.log(`   + módulo ${nome}`);
    } catch (e) {
      falhasExtras++;
      console.error(`   ✖ módulo ${nome} falhou:`, (e && e.stack) || e);
    }
  }

  const escritos = [
    escrever('cadastros.json', {
      centrosCusto: CENTROS,
      responsaveis: RESPONSAVEIS,
      motoristas: PESSOAS.filter(p => p.dirige).map(p => p.nome),
      contratosFuncionarios: CONTRATOS_CAT,
    }),
    escrever('data.json', { veiculos }),
    escrever('multas.json', { multas }),
    escrever('rastreadores.json', { rastreadores }),
    escrever('rastreadores_vinculos.json', { eventos: rastreadoresVinculos }),
    escrever('historico.json', historico),
    escrever('funcionarios.json', { funcionarios }),
    escrever('func_obrigatorios.json', montarFuncObrigatorios()),
    escrever('fornecedores.json', { fornecedores }),
    escrever('epi_catalogo.json', { catalogo: epiCatalogo }),
    escrever('epi_movimentacoes.json', { movimentacoes: epiMovimentacoes }),
    escrever('epi_notas_fiscais.json', { notas: montarEpiNotasFiscais() }),
    escrever('almoxarifado.json', { retiradas: almoxarifado }),
    escrever('acoes_sst.json', { acoes: acoesSst }),
    escrever('manutencao.json', { manutencao }),
    escrever('abastecimento.json', { abastecimento }),
    escrever('odometros.json', { leituras: odometros }),
    escrever('contratos.json', { contratos }),
    escrever('feedbacks.json', { feedbacks }),
    escrever('instalacoes.json', { instalacoes }),
    escrever('envios.json', { envios }),
    escrever('documentos_empresa.json', documentos),
    escrever('usuarios.json', montarUsuarios()),
    // Cofre de credenciais: base vazia; os exemplos vêm de scripts/seed-mock/40-senhas.js,
    // cifrados com a mesma chave que o servidor usa (COFRE_CHAVE ou a frase do modo local).
    escrever('senhas.json', { senhas: [], categorias: ['Bancos', 'Portais do governo', 'Sistemas internos'] }),
    // Trilhas de auditoria começam VAZIAS — são registro de acesso real, não dado de exemplo.
    escrever('login_logs.json', []),
    escrever('seguranca_logs.json', []),
    escrever('sistema_config.json', {
      areasLiberadas: AREAS_PERMISSAO,
      manutencao: { ativo: false, por: '', porUsuario: '', mensagem: '', desde: 0 },
      // Vigência dos contratos (visão Contratos de Funcionários): um vigente folgado, um
      // prorrogado por aditivo vencendo em ~20 dias (badge "Vence em X d") e um encerrado —
      // cobre os três badges da tela. Datas relativas a HOJE, como o resto do seed.
      vigenciasContratos: {
        contratos: {
          [CT_SUL_BA]: { inicio: iso(mes(-10)), fimOriginal: iso(mes(8)), aditivos: [], encerramento: null },
          [CT_SUL_SEDE]: {
            inicio: iso(mes(-14)),
            fimOriginal: iso(mes(-2)),
            aditivos: [
              { numero: '1', inicio: iso(mes(-2)), novoFim: iso(dia(-40)), obs: 'Prorrogação de serviços', ts: mes(-3).toISOString(), por: 'Gestor Demo' },
              { numero: '2', inicio: iso(dia(-40)), novoFim: iso(dia(20)), obs: '', ts: dia(-45).toISOString(), por: 'Gestor Demo' },
            ],
            encerramento: null,
          },
          [CT_NTE_LINHA]: {
            inicio: iso(mes(-20)),
            fimOriginal: iso(mes(-8)),
            aditivos: [{ numero: '1', inicio: iso(mes(-8)), novoFim: iso(mes(-1)), obs: '', ts: mes(-9).toISOString(), por: 'Gestor Demo' }],
            encerramento: { data: iso(mes(-1)), motivo: 'Fim da obra (demo)', ts: mes(-1).toISOString(), por: 'Gestor Demo' },
          },
        },
      },
    }),
    // Credenciais que as automações locais (preview do .claude/launch.json) usam para logar.
    // Apontam para o usuário de teste — nenhuma senha real fica no repositório.
    escrever('.claude-dev-creds.json', { usuario: 'dev.demo', senha: SENHA_DEMO }),
    ...Object.entries(extras).map(([arquivo, conteudo]) => escrever(arquivo, conteudo)),
  ];

  // Cofre de mídia (assinaturas e fotos das telas assinadas)
  if (APLICAR) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  for (const m of midiasParaGravar) {
    if (APLICAR) fs.writeFileSync(path.join(UPLOADS_DIR, `${m.id}.json`), JSON.stringify(m.conteudo), 'utf-8');
  }

  for (const e of escritos) console.log(`   ${APLICAR ? '✔' : '·'} ${e.arquivo.padEnd(28)} ${String(e.bytes).padStart(8)} bytes`);
  console.log(`   ${APLICAR ? '✔' : '·'} uploads/ (cofre de mídia)   ${String(midiasParaGravar.length).padStart(8)} arquivos`);

  console.log(`\n📊 resumo: ${veiculos.length} veículos · ${multas.length} multas · ${rastreadores.length} rastreadores`);
  console.log(`           ${funcionarios.length} colaboradores · ${epiCatalogo.length} EPIs · ${epiMovimentacoes.length} movimentações de EPI`);
  console.log(`           ${almoxarifado.length} retiradas de almoxarifado · ${fornecedores.length} fornecedores · ${acoesSst.length} ações de segurança`);
  console.log(`\n🔑 usuários de teste (senha ${SENHA_DEMO}): dev.demo · gestor.demo · operacao.demo · sst.demo · leitura.demo · novato.demo (pendente)`);
  if (falhasExtras) { console.error(`\n✖ ${falhasExtras} módulo(s) extra(s) falharam — veja acima.`); process.exitCode = 1; }
  if (!APLICAR) console.log('\n⚠  DRY-RUN: nada foi gravado. Repita com --apply.\n');
  else console.log('\n✅ pronto. Suba o servidor com: npm start\n');
}

main().catch((e) => { console.error('\n✖ falhou:', e); process.exit(1); });
