/* ============================================================================
   odometro-calc.js · linha do tempo do odômetro (Manutenção › Odômetro)

   Cálculo COMPARTILHADO entre a tela (app.js, via <script src="/odometro-calc.js">,
   global `OdometroCalc`) e a exportação em Excel do servidor (backend/server.js faz
   require deste arquivo, como já faz com o qrcode.js). Um lugar só para a regra:
   a tabela da tela e a planilha baixada nunca discordam dos números.

   Leitura = { id, placa, data: 'aaaa-mm-dd', km: Number, obs, origem, ... }.
   Nada aqui é gravado: km rodado, trecho, média e alerta são sempre DERIVADOS da
   lista bruta de leituras, recalculados a cada render/exportação.

   Regras:
   - "Km rodados" = km da ÚLTIMA leitura − km da PRIMEIRA (no período filtrado).
     Um erro de digitação NO MEIO do histórico não contamina o total; ele aparece
     como alerta nos trechos vizinhos.
   - Trecho = diferença para a leitura imediatamente anterior do mesmo veículo.
   - Alerta 'voltou': o odômetro ficou MENOR que na leitura anterior (digitação
     errada ou painel trocado). Alerta 'salto': média do trecho acima de
     KM_DIA_SUSPEITO (provável zero a mais).
   ============================================================================ */
(function (raiz, fabrica) {
  if (typeof module === 'object' && module.exports) module.exports = fabrica();
  else raiz.OdometroCalc = fabrica();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KM_DIA_SUSPEITO = 1000;   // trecho com média acima disso pede conferência
  const DIAS_SEM_LEITURA = 30;    // última leitura mais velha que isso = "sem leitura recente"
  const DIAS_MES = 30;            // "média por mês" = média de 30 dias (conta simples de explicar)
  const DIA_MS = 86400000;

  // 'aaaa-mm-dd' → número do dia (UTC), para diferença de dias sem fuso nem horário de verão.
  //   diaNum('2026-08-01') - diaNum('2026-07-01') // => 31
  function diaNum(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DIA_MS : NaN;
  }

  // Ordem cronológica estável: data, depois km (duas leituras no mesmo dia), depois ts.
  //   ordenarLeituras([{data:'2026-08-02',km:9},{data:'2026-08-01',km:5}]) // => [5, 9] pela data
  function ordenarLeituras(leituras) {
    return (leituras || []).slice().sort((a, b) =>
      String(a.data).localeCompare(String(b.data)) || (a.km - b.km) || ((a.ts || 0) - (b.ts || 0)));
  }

  // Linha do tempo de UM veículo: cada leitura ganha o trecho desde a anterior e o
  // acumulado desde a primeira.
  // USO:
  //   linhaDoTempo([{data:'2026-07-01',km:45000},{data:'2026-07-11',km:45800}])
  //   // => [{...,km:45000,delta:null,dias:null,kmDia:null,desdeInicio:0,alerta:''},
  //   //     {...,km:45800,delta:800,dias:10,kmDia:80,desdeInicio:800,alerta:''}]
  function linhaDoTempo(leituras) {
    const ord = ordenarLeituras(leituras);
    if (!ord.length) return [];
    const kmInicial = ord[0].km;
    return ord.map((l, i) => {
      const ant = i ? ord[i - 1] : null;
      const delta = ant ? l.km - ant.km : null;
      const dias = ant ? diaNum(l.data) - diaNum(ant.data) : null;
      const kmDia = (delta !== null && delta >= 0 && dias > 0) ? delta / dias : null;
      let alerta = '';
      if (delta !== null && delta < 0) alerta = 'voltou';
      else if (kmDia !== null && kmDia > KM_DIA_SUSPEITO) alerta = 'salto';
      return Object.assign({}, l, { delta, dias, kmDia, desdeInicio: l.km - kmInicial, alerta });
    });
  }

  // Período inclusivo em ISO ('' = aberto daquele lado).
  //   dentroDoPeriodo({data:'2026-08-10'}, '2026-08-01', '') // => true
  function dentroDoPeriodo(l, de, ate) {
    return (!de || l.data >= de) && (!ate || l.data <= ate);
  }

  // Resumo de UM veículo no período. Devolve null se ele não tem leitura no período.
  // `todas` são TODAS as leituras dele (o "sem leitura há N dias" olha a última de todas,
  // não a última do período filtrado).
  // USO:
  //   resumoVeiculo('ABC1D23', leiturasDaPlaca, { de: '', ate: '', hoje: '2026-09-22' })
  //   // => { placa:'ABC1D23', qtd:3, primeira:{...}, ultima:{...}, km:3320, dias:62,
  //   //      kmDia:53.5, kmMes:1606, alertas:0, diasSemLeitura:21, semLeituraRecente:false,
  //   //      linha:[...linhaDoTempo do período...] }
  function resumoVeiculo(placa, todas, opcoes) {
    const o = opcoes || {};
    const noPeriodo = (todas || []).filter(l => dentroDoPeriodo(l, o.de, o.ate));
    if (!noPeriodo.length) return null;
    const linha = linhaDoTempo(noPeriodo);
    const primeira = linha[0], ultima = linha[linha.length - 1];
    const km = ultima.km - primeira.km;
    const dias = diaNum(ultima.data) - diaNum(primeira.data);
    const kmDia = dias > 0 && km >= 0 ? km / dias : null;
    const ultimaGeral = ordenarLeituras(todas).pop();
    const diasSemLeitura = o.hoje ? diaNum(o.hoje) - diaNum(ultimaGeral.data) : null;
    return {
      placa, qtd: linha.length, primeira, ultima, km, dias, kmDia,
      kmMes: kmDia === null ? null : kmDia * DIAS_MES,
      alertas: linha.filter(l => l.alerta).length,
      diasSemLeitura,
      semLeituraRecente: diasSemLeitura !== null && diasSemLeitura > DIAS_SEM_LEITURA,
      linha,
    };
  }

  // Agrupa por placa e resume cada veículo. `placas` (opcional) restringe o recorte.
  // USO:
  //   resumoFrota(leituras, { de: '2026-08-01', ate: '2026-08-31', hoje: '2026-09-22' })
  //   // => { veiculos:[resumoVeiculo...], km: 12840, leituras: 57, alertas: 2, semLeituraRecente: 1, kmDiaMedio: 61.2 }
  function resumoFrota(leituras, opcoes) {
    const o = opcoes || {};
    const filtro = Array.isArray(o.placas) && o.placas.length ? new Set(o.placas) : null;
    const porPlaca = new Map();
    for (const l of (leituras || [])) {
      if (!l || !l.placa || filtro && !filtro.has(l.placa)) continue;
      if (!porPlaca.has(l.placa)) porPlaca.set(l.placa, []);
      porPlaca.get(l.placa).push(l);
    }
    const veiculos = [];
    for (const [placa, lista] of porPlaca) {
      const r = resumoVeiculo(placa, lista, o);
      if (r) veiculos.push(r);
    }
    const comMedia = veiculos.filter(v => v.kmDia !== null);
    return {
      veiculos,
      km: veiculos.reduce((s, v) => s + Math.max(0, v.km), 0),
      leituras: veiculos.reduce((s, v) => s + v.qtd, 0),
      alertas: veiculos.reduce((s, v) => s + v.alertas, 0),
      semLeituraRecente: veiculos.filter(v => v.semLeituraRecente).length,
      kmDiaMedio: comMedia.length ? comMedia.reduce((s, v) => s + v.kmDia, 0) / comMedia.length : null,
    };
  }

  // Frase curta do alerta de um trecho, para a tela e para a coluna "CONFERIR" do Excel.
  //   textoAlerta({alerta:'voltou', delta:-1200}) // => 'Voltou 1.200 km'
  //   textoAlerta({alerta:'salto', kmDia:1450})   // => 'Salto de 1.450 km/dia'
  function textoAlerta(l) {
    const n = (v) => Math.round(Math.abs(v)).toLocaleString('pt-BR');
    if (!l || !l.alerta) return '';
    if (l.alerta === 'voltou') return `Voltou ${n(l.delta)} km`;
    return `Salto de ${n(l.kmDia)} km/dia`;
  }

  return {
    KM_DIA_SUSPEITO, DIAS_SEM_LEITURA, DIAS_MES,
    diaNum, ordenarLeituras, linhaDoTempo, dentroDoPeriodo, resumoVeiculo, resumoFrota, textoAlerta,
  };
});
