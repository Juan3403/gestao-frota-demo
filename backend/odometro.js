// ============================================================================
// odometro.js · regras de ENTRADA das leituras de odômetro (Manutenção › Odômetro)
//
// Só a parte de servidor: ler placa/data/km de uma célula de planilha ou do formulário,
// achar as colunas pelo cabeçalho e decidir o que entra numa importação. O cálculo da
// linha do tempo (km rodados, trechos, alertas) mora em frontend/odometro-calc.js, que
// a tela e a exportação compartilham.
//
// A importação é SOMA, nunca substituição: leitura igual (mesma placa + data + km) já
// existente é ignorada, então reimportar a mesma planilha, ou o próprio Excel exportado,
// não duplica nada.
// ============================================================================
'use strict';

// Placa antiga (ABC1234) ou Mercosul (ABC1D23), já sem traço/espaço.
const RE_PLACA = /^[A-Z]{3}\d[A-Z0-9]\d{2}$/;
const KM_MAXIMO = 2000000;
// Linha de exemplo da planilha modelo: a OBSERVAÇÃO começa com "EXEMPLO". Esquecer de
// apagá-la não cria leitura de mentira.
const RE_EXEMPLO = /^EXEMPLO\b/;

// Texto de cabeçalho/célula comparável: sem acento, maiúsculo, só letras/números/espaço.
//   chaveTexto(' Odômetro (km) ') // => 'ODOMETRO KM'
function chaveTexto(v) {
  return String(v == null ? '' : v).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
}

// USO: lerPlaca('abc-1d23') // => 'ABC1D23'   ·   lerPlaca('AB12') // => ''
function lerPlaca(v) {
  const p = String(v == null ? '' : v).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return RE_PLACA.test(p) ? p : '';
}

// Número do painel. Aceita número do Excel ou texto em pt-BR ("45.320", "45.320,5 km").
// USO: lerKm('45.320 km') // => 45320  ·  lerKm(45320.46) // => 45320.5  ·  lerKm('abc') // => null
function lerKm(v) {
  if (v === '' || v === null || v === undefined) return null;
  let n;
  if (typeof v === 'number') n = v;
  else {
    const s = String(v).trim().toLowerCase().replace(/km/g, '').replace(/\s+/g, '');
    if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(s)) n = Number(s.replace(/\./g, '').replace(',', '.'));      // 45.320,5
    else if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) n = Number(s.replace(/,/g, ''));                    // 45,320.5
    else if (/^\d+(,\d+)?$/.test(s)) n = Number(s.replace(',', '.'));                                 // 45320,5
    else if (/^\d+(\.\d+)?$/.test(s)) n = Number(s);                                                   // 45320.5
    else return null;
  }
  if (!Number.isFinite(n) || n < 0 || n > KM_MAXIMO) return null;
  return Math.round(n * 10) / 10;
}

const pad = (n) => String(n).padStart(2, '0');
function isoValido(a, m, d) {
  const dt = new Date(Date.UTC(a, m - 1, d));
  return dt.getUTCFullYear() === a && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? `${a}-${pad(m)}-${pad(d)}` : '';
}

// Data da leitura → 'aaaa-mm-dd' ('' se ilegível). Aceita serial do Excel, Date,
// "dd/mm/aaaa" (com ou sem hora), "dd/mm/aa", "dd-mm-aaaa" e "aaaa-mm-dd".
// USO: lerData(46235) // => '2026-07-31'  ·  lerData('01/08/2026 07:30') // => '2026-08-01'
function lerData(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : isoValido(v.getFullYear(), v.getMonth() + 1, v.getDate());
  if (typeof v === 'number' || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 1 || n > 80000) return '';
    const d = new Date(Math.round((Math.floor(n) - 25569) * 86400000)); // 25569 = 01/01/1970 no serial do Excel
    return isoValido(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return isoValido(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})\b/.exec(s);
  if (m) {
    const ano = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return isoValido(ano, Number(m[2]), Number(m[1]));
  }
  return '';
}

// 'aaaa-mm-dd' do dia de hoje no fuso de Brasília (o servidor do Render roda em UTC).
function hojeISO(agora = new Date()) {
  const br = new Date(agora.getTime() - 3 * 3600000);
  return `${br.getUTCFullYear()}-${pad(br.getUTCMonth() + 1)}-${pad(br.getUTCDate())}`;
}

// Normaliza uma leitura vinda do formulário ou de uma linha da planilha.
// USO:
//   normalizarLeitura({ placa: 'abc-1d23', data: '01/08/2026', km: '45.320', obs: '' }, { hoje: '2026-09-22' })
//   // => { leitura: { placa:'ABC1D23', data:'2026-08-01', km:45320, obs:'' } }
//   normalizarLeitura({ placa: 'ABC1D23', data: '01/08/2030', km: 10 }, { hoje: '2026-09-22' })
//   // => { erro: 'data no futuro (01/08/2030)' }
function normalizarLeitura(bruta, opcoes = {}) {
  const b = bruta || {};
  const hoje = opcoes.hoje || hojeISO();
  const placaBruta = String(b.placa == null ? '' : b.placa).trim();
  if (!placaBruta) return { erro: 'placa vazia' };
  const placa = lerPlaca(placaBruta);
  if (!placa) return { erro: `placa inválida (${placaBruta.slice(0, 20)})` };
  const dataBruta = b.data;
  if (dataBruta === '' || dataBruta === null || dataBruta === undefined) return { erro: 'data vazia' };
  const data = lerData(dataBruta);
  if (!data) return { erro: `data inválida (${String(dataBruta).slice(0, 20)})` };
  if (data < '1990-01-01') return { erro: `data muito antiga (${data.split('-').reverse().join('/')})` };
  if (data > hoje) return { erro: `data no futuro (${data.split('-').reverse().join('/')})` };
  if (b.km === '' || b.km === null || b.km === undefined) return { erro: 'odômetro vazio' };
  const km = lerKm(b.km);
  if (km === null) return { erro: `odômetro inválido (${String(b.km).slice(0, 20)})` };
  const obs = String(b.obs == null ? '' : b.obs).trim().slice(0, 200);
  return { leitura: { placa, data, km, obs } };
}

// Chave de duplicidade: a mesma placa, no mesmo dia, com o mesmo km, é a mesma leitura.
// Mesmo dia com km diferente são DUAS leituras (manhã e fim do dia), não duplicata.
//   chaveLeitura({ placa:'ABC1D23', data:'2026-08-01', km:45320 }) // => 'ABC1D23|2026-08-01|45320'
const chaveLeitura = (l) => `${l.placa}|${l.data}|${l.km}`;

// Cabeçalhos aceitos por campo, já em chaveTexto(). A comparação é EXATA de propósito:
// o Excel exportado tem "KM/DIA NO TRECHO" e "DIAS DESDE A ANTERIOR", que um "contém KM"
// ou "contém DIA" confundiria com o odômetro e a data.
const SINONIMOS = {
  placa: ['PLACA', 'PLACAS', 'VEICULO', 'PLACA DO VEICULO', 'PLACA VEICULO'],
  data: ['DATA', 'DATA DA LEITURA', 'DATA LEITURA', 'DIA', 'DATA HORA', 'DATA E HORA', 'DATA DO REGISTRO'],
  km: ['ODOMETRO', 'ODOMETRO KM', 'HODOMETRO', 'HODOMETRO KM', 'KM', 'KM ATUAL', 'QUILOMETRAGEM',
    'QUILOMETRAGEM KM', 'LEITURA', 'LEITURA KM', 'KM DO VEICULO', 'KM DO PAINEL', 'ODOMETRO ATUAL'],
  obs: ['OBSERVACAO', 'OBSERVACOES', 'OBS', 'OBS.'],
};
// USO: mapearCabecalho(['Placa', 'Data', 'Odômetro (km)', 'Obs']) // => { placa:0, data:1, km:2, obs:3 }
//      mapearCabecalho(['Nome', 'Valor'])                       // => null (faltam as 3 obrigatórias)
function mapearCabecalho(linha) {
  const cab = (linha || []).map(chaveTexto);
  const mapa = {};
  for (const [campo, nomes] of Object.entries(SINONIMOS)) {
    const i = cab.findIndex(c => nomes.includes(c));
    mapa[campo] = i;
  }
  return mapa.placa >= 0 && mapa.data >= 0 && mapa.km >= 0 ? mapa : null;
}

// Analisa as abas da planilha (a primeira cujo cabeçalho tem PLACA, DATA e ODÔMETRO nas
// 15 primeiras linhas) e separa o que entra do que não entra. Não grava nada.
// USO:
//   analisarPlanilha([{ nome: 'LEITURAS', linhas: [['PLACA','DATA','ODÔMETRO (KM)'], ['ABC1D23','01/08/2026',45320]] }],
//     leiturasJaGravadas, { hoje: '2026-09-22', gerarId: () => 'ODO1', ts: 1, por: 'Juan', arquivo: 'odo.xlsx' })
//   // => { aba:'LEITURAS', novas:[{id:'ODO1',placa:'ABC1D23',data:'2026-08-01',km:45320,obs:'',origem:'planilha',...}],
//   //      repetidas:0, exemplos:0, erros:[] }
//   // Sem cabeçalho reconhecível: { erroGeral: 'Não encontrei as colunas...' }
function analisarPlanilha(abas, existentes, opcoes = {}) {
  let aba = null, mapa = null, linhaCab = -1;
  for (const a of (abas || [])) {
    const linhas = a.linhas || [];
    for (let i = 0; i < Math.min(15, linhas.length); i++) {
      const m = mapearCabecalho(linhas[i]);
      if (m) { aba = a; mapa = m; linhaCab = i; break; }
    }
    if (aba) break;
  }
  if (!aba) return { erroGeral: 'Não encontrei as colunas PLACA, DATA e ODÔMETRO. Baixe a planilha modelo e use o mesmo cabeçalho.' };
  const jaTem = new Set((existentes || []).map(chaveLeitura));
  const novas = [], erros = [];
  let repetidas = 0, exemplos = 0;
  const celula = (linha, i) => (i >= 0 ? linha[i] : '');
  aba.linhas.slice(linhaCab + 1).forEach((linha, k) => {
    const numero = linhaCab + k + 2; // número da linha como o Excel mostra (1 = cabeçalho na 1ª linha)
    const bruta = { placa: celula(linha, mapa.placa), data: celula(linha, mapa.data), km: celula(linha, mapa.km), obs: celula(linha, mapa.obs) };
    if ([bruta.placa, bruta.data, bruta.km].every(v => String(v == null ? '' : v).trim() === '')) return; // linha em branco
    if (RE_EXEMPLO.test(chaveTexto(bruta.obs))) { exemplos++; return; }
    const { leitura, erro } = normalizarLeitura(bruta, opcoes);
    if (erro) { erros.push({ linha: numero, motivo: erro }); return; }
    const chave = chaveLeitura(leitura);
    if (jaTem.has(chave)) { repetidas++; return; }
    jaTem.add(chave);
    novas.push(Object.assign({ id: opcoes.gerarId ? opcoes.gerarId() : '' }, leitura, {
      origem: 'planilha', arquivo: String(opcoes.arquivo || '').slice(0, 120), ts: opcoes.ts || Date.now(), por: opcoes.por || '',
    }));
  });
  return { aba: aba.nome, novas, repetidas, exemplos, erros };
}

module.exports = {
  RE_PLACA, KM_MAXIMO, SINONIMOS,
  chaveTexto, lerPlaca, lerKm, lerData, hojeISO, normalizarLeitura, chaveLeitura, mapearCabecalho, analisarPlanilha,
};
