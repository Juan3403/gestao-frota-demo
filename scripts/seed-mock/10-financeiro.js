/**
 * seed-mock/10-financeiro.js — dados FICTÍCIOS do grupo FINANCEIRO da barra lateral.
 *
 * Preenche as abas que abriam vazias na demonstração:
 *   - Simulador ......... simulacoes.json   (comparações salvas: financiamento × empréstimo × consórcio)
 *   - Contratos ......... contratos.json    (acrescenta séries em ctx.contratos — o seed principal grava)
 *   - Cartões ........... cartoes.json      (marca, 4 últimos dígitos e portador — nada sensível)
 *   - Controles ......... aportes.json / emprestimos.json / percentuais.json / retiradas.json
 *   - Contabilidade ..... contabilidade.json (DRE, Balanço e Faturamento das duas empresas + PDF fictício)
 *   - Investimentos ..... investimentos.json (snapshot da carteira de renda fixa, no formato do pipeline)
 *   - Custos ............ custos.json + custos_config.json + horas_extras.json (sub-aba Equipe)
 *
 * Tudo inventado e relativo a HOJE (o "mês atual" da demo é sempre o mês em que o seed roda).
 * Empresas: Norte Engenharia (NTE) e Sul Empreendimentos (SUL); cliente: Delta Energia.
 * Bancos aparecem só como instituição financeira (como no resto do seed).
 *
 * USO (chamado pelo scripts/seed-mock.js, que grava cada arquivo devolvido em DATA_DIR):
 *   const arquivos = await require('./seed-mock/10-financeiro').montar(ctx);
 *   // → { 'simulacoes.json': { simulacoes: [...] }, 'cartoes.json': { cartoes: [...] }, ... }
 */

// ---------------------------------------------------------------------------
// Utilitários locais (datas e contas)
// ---------------------------------------------------------------------------

// Data no dia N do mês (HOJE + desloc meses), ao meio-dia (evita escorregar de fuso no iso()).
// USO: diaDoMes(ctx, -2, 10) → Date de 10/<mês retrasado>
function diaDoMes(ctx, desloc, diaMes) {
  return new Date(ctx.HOJE.getFullYear(), ctx.HOJE.getMonth() + desloc, diaMes, 12, 0, 0, 0);
}

// 'aaaa-mm' de uma Date. USO: chaveMes(new Date(2026, 9, 8)) → '2026-10'
function chaveMes(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Arredonda em centavos. USO: centavos(10.005) → 10.01
const centavos = (v) => Math.round(v * 100) / 100;

// Taxa mensal (TIR) que iguala o valor recebido ao fluxo de parcelas — bisseção simples.
// USO: taxaMensal(100000, 3200, 48) → 0.0178 (1,78% a.m.)
function taxaMensal(valorPresente, parcela, n, carencia = 0) {
  const vp = (i) => {
    let s = 0;
    for (let t = 1; t <= n; t++) s += parcela / Math.pow(1 + i, t + carencia);
    return s - valorPresente;
  };
  let lo = 0, hi = 0.2;
  if (vp(lo) <= 0) return 0; // parcelas não pagam nem o principal → sem juros
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (vp(mid) > 0) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
// Anualiza a taxa mensal. USO: anualizar(0.01) → 0.1268
const anualizar = (im) => Math.pow(1 + im, 12) - 1;

// ---------------------------------------------------------------------------
// SIMULADOR — comparações salvas (cada login vê só as suas; local sem login vê todas)
// ---------------------------------------------------------------------------

// Monta as comparações no formato de normalizarSimulacao (números já calculados, como o cliente faz).
// USO: montarSimulacoes(ctx) → [{ id, ts, usuario:'dev.demo', banco:'Itaú', rotulo:'Financiamento 48x',
//        montante, custoRS, cetAnual:0.23, prazo:48, posseImediata:true }, ...]
function montarSimulacoes(ctx) {
  const fin = (usuario, banco, valor, entrada, parcela, n, diasAtras) => {
    const financiado = valor - entrada;
    const im = taxaMensal(financiado, parcela, n);
    return { usuario, banco, rotulo: `Financiamento ${n}x`, montante: centavos(entrada + parcela * n),
      custoRS: centavos(parcela * n - financiado), cetAnual: anualizar(im), prazo: n, posseImediata: true, diasAtras };
  };
  const emp = (usuario, banco, valor, parcela, n, diasAtras) => {
    const im = taxaMensal(valor, parcela, n);
    return { usuario, banco, rotulo: `Empréstimo ${n}x`, montante: centavos(parcela * n),
      custoRS: centavos(parcela * n - valor), cetAnual: anualizar(im), prazo: n, posseImediata: true, diasAtras };
  };
  // Consórcio: CET calculado assumindo contemplação imediata (mesma premissa da tela).
  const con = (usuario, banco, carta, parcela, n, diasAtras) => {
    const im = taxaMensal(carta, parcela, n);
    return { usuario, banco, rotulo: `Consórcio ${n}x`, montante: centavos(parcela * n),
      custoRS: centavos(parcela * n - carta), cetAnual: anualizar(im), prazo: n, posseImediata: false, diasAtras };
  };
  const lista = [
    // dev.demo — compra de uma picape para a obra de Natal (R$ 285 mil)
    fin('dev.demo', 'Itaú', 285000, 57000, 7180.40, 48, 3),
    fin('dev.demo', 'Bradesco', 285000, 57000, 7420.15, 48, 3),
    fin('dev.demo', 'Banco do Brasil', 285000, 57000, 7055.90, 48, 2),
    con('dev.demo', 'Sicredi', 228000, 3390.00, 80, 2),
    emp('dev.demo', 'Caixa', 228000, 7890.00, 48, 1),
    // gestor.demo — capital de giro para o contrato da Delta Energia
    emp('gestor.demo', 'Santander', 150000, 7780.00, 24, 9),
    emp('gestor.demo', 'Banco do Nordeste', 150000, 7350.00, 24, 8),
    emp('gestor.demo', 'Sicoob', 150000, 7525.50, 24, 8),
    // leitura.demo — retroescavadeira (consórcio × financiamento)
    con('leitura.demo', 'Porto Seguro Consórcio', 420000, 4620.00, 100, 15),
    fin('leitura.demo', 'BNDES Finame (via Bradesco)', 420000, 84000, 7940.00, 60, 14),
  ];
  return lista.map((s) => ({
    id: ctx.id('S'),
    ts: ctx.ts(ctx.dia(-s.diasAtras)),
    usuario: s.usuario,
    banco: s.banco,
    rotulo: s.rotulo,
    montante: s.montante,
    custoRS: s.custoRS,
    cetAnual: Math.round(s.cetAnual * 1e6) / 1e6,
    prazo: s.prazo,
    posseImediata: s.posseImediata,
  }));
}

// ---------------------------------------------------------------------------
// CONTRATOS — séries extras (consórcio, financiamento, empréstimo, CDC, uma na justiça)
// ---------------------------------------------------------------------------

// Gera as parcelas de uma série no formato de normalizarContrato (1 linha = 1 parcela).
// Mostra 6 parcelas para trás e 6 para a frente da parcela do mês atual (`pAtual`).
// `atrasadas` = nº das parcelas vencidas que NÃO foram pagas (viram "Pendente" atrasada).
// USO: serieContrato(ctx, { banco:'Itaú', produto:'Financiamento', empresa:'NTE', material:'VW Saveiro',
//        valor:2890.5, total:48, pAtual:14, diaVenc:10, atrasadas:[13] }) → [{ parcela:'08/48', ... }, ...]
function serieContrato(ctx, s) {
  const serieId = ctx.id('CS');
  const linhas = [];
  const largura = String(s.total).length;
  const ini = Math.max(1, s.pAtual - (s.antes ?? 6));
  const fim = Math.min(s.total, s.pAtual + (s.depois ?? 5));
  for (let p = ini; p <= fim; p++) {
    const venc = diaDoMes(ctx, p - s.pAtual, s.diaVenc);
    const vencido = venc < ctx.HOJE;
    const pago = vencido && !(s.atrasadas || []).includes(p) && !s.naJustica;
    const pagoEm = new Date(venc.getTime() - ctx.inteiro(0, 3) * 864e5);
    linhas.push({
      id: ctx.id('C'),
      ts: ctx.ts(venc),
      serieId,
      dataEmissao: ctx.br(diaDoMes(ctx, -s.pAtual, 1)),
      fornecedor: s.fornecedor,
      banco: s.banco,
      produto: s.produto,
      grupo: s.grupo || '',
      cota: s.cota || '',
      material: s.material,
      empresa: s.empresa,
      localCarro: s.local,
      parcela: `${String(p).padStart(largura, '0')}/${s.total}`,
      totalParcelas: s.total,
      parcelasPagas: '',
      parcelasFaltantes: '',
      valorParcela: s.valor,
      saldoQuitacao: centavos(s.valor * (s.total - p) * 0.86),
      descontoQuitacao: '',
      descontoQuitacaoRS: '',
      carencia: '',
      inicioParcelas: ctx.br(diaDoMes(ctx, 1 - s.pAtual, s.diaVenc)),
      vencimento: ctx.br(venc),
      dataPagamento: pago ? ctx.br(pagoEm) : '',
      escritorio: s.escritorio || 'SEDE',
      valorPago: pago ? s.valor : '',
      conta: s.conta,
      naJustica: !!s.naJustica,
    });
  }
  return linhas;
}

// Acrescenta séries em ctx.contratos (o seed principal grava contratos.json DEPOIS dos módulos).
// USO: completarContratos(ctx) → nº de parcelas acrescentadas (ex.: 60)
function completarContratos(ctx) {
  const series = [
    { banco: 'Itaú', produto: 'Financiamento', empresa: 'NTE', material: 'VW Saveiro Robust 1.6 — placa DEM9I09',
      fornecedor: 'Concessionária Exemplo Motors', valor: 2890.50, total: 48, pAtual: 14, diaVenc: 10, local: 'NATAL',
      conta: 'Conta Corrente DEMO — Itaú', atrasadas: [] },
    { banco: 'Caixa', produto: 'Empréstimo', empresa: 'SUL', material: 'Capital de giro — contrato Delta Energia',
      fornecedor: 'Caixa (capital de giro)', valor: 6420.00, total: 24, pAtual: 9, diaVenc: 20, local: 'PAULO AFONSO',
      conta: 'Conta Corrente DEMO — Caixa', atrasadas: [8] },
    { banco: 'Sicredi', produto: 'Consórcio', empresa: 'NTE', material: 'Carta de crédito — caminhão munck',
      fornecedor: 'Administradora de Consórcios Demo', grupo: '0875', cota: '112', valor: 4150.00, total: 100, pAtual: 31,
      diaVenc: 15, local: 'CAMPINA GRANDE', conta: 'Conta Corrente DEMO — Sicredi', atrasadas: [] },
    { banco: 'Banco do Nordeste', produto: 'Financiamento', empresa: 'SUL', material: 'Retroescavadeira 4x4 (FNE Demo)',
      fornecedor: 'Máquinas Pesadas Exemplo Ltda', valor: 9870.35, total: 60, pAtual: 22, diaVenc: 5, local: 'PAULO AFONSO',
      conta: 'Conta Corrente DEMO — BNB', atrasadas: [] },
    { banco: 'Santander', produto: 'CDC', empresa: 'NTE', material: 'Fiat Strada Endurance — placa TST1K11',
      fornecedor: 'Revenda Fictícia Veículos', valor: 1985.00, total: 36, pAtual: 20, diaVenc: 25, local: 'SEDE',
      conta: 'Conta Corrente DEMO — Santander', naJustica: true, antes: 4, depois: 3 },
  ];
  let n = 0;
  for (const s of series) {
    const linhas = serieContrato(ctx, s);
    ctx.contratos.push(...linhas);
    n += linhas.length;
  }
  return n;
}

// ---------------------------------------------------------------------------
// CARTÕES — só identificação visual (marca, final, portador)
// ---------------------------------------------------------------------------

// USO: montarCartoes(ctx) → [{ id:'cart-…', nome:'Ana Paula Ribeiro', marca:'XP VISA', ultimos4:'4821', obs:'…', ts }]
function montarCartoes(ctx) {
  const pessoas = ctx.PESSOAS.map(p => p.nome);
  const base = [
    { marca: 'XP VISA', ultimos4: '4821', nome: ctx.RESPONSAVEIS[0], obs: 'Compras gerais da sede' },
    { marca: 'XP VISA', ultimos4: '7730', nome: ctx.RESPONSAVEIS[1], obs: 'Viagens e hospedagem' },
    { marca: 'BRADESCO ELO', ultimos4: '1094', nome: pessoas[2] || 'Motorista Demo', obs: 'Combustível — frota SEDE' },
    { marca: 'BRADESCO ELO', ultimos4: '5562', nome: pessoas[4] || 'Encarregado Demo', obs: 'Combustível — frota NATAL' },
    { marca: 'ITAÚ MASTERCARD', ultimos4: '3318', nome: ctx.RESPONSAVEIS[2], obs: 'Assinaturas de software' },
    { marca: 'INTER MASTERCARD', ultimos4: '9047', nome: pessoas[0] || 'Encarregado Demo', obs: 'Pequenas compras de obra — Paulo Afonso' },
    { marca: 'NUBANK', ultimos4: '2286', nome: pessoas[9] || 'Almoxarife Demo', obs: 'Almoxarifado — Campina Grande' },
  ];
  return base.map((c, i) => ({
    id: `cart-demo-${String(i + 1).padStart(2, '0')}`,
    nome: c.nome,
    marca: c.marca,
    ultimos4: c.ultimos4,
    obs: c.obs,
    ts: ctx.ts(ctx.dia(-(40 + i * 11))),
  }));
}

// ---------------------------------------------------------------------------
// CONTROLES — aportes, empréstimos entre contratos, percentuais por NF e retiradas
// ---------------------------------------------------------------------------

// Divide um valor entre sócios pelas frações (a última fecha a conta dos centavos).
// USO: dividir(1000, { marcelo:0.5, ricardo:0.5 }) → { marcelo:500, ricardo:500, fernando:0, tiago:0 }
function dividir(valor, fracoes) {
  const out = { marcelo: 0, ricardo: 0, fernando: 0, tiago: 0 };
  const chaves = Object.keys(fracoes);
  let resto = valor;
  chaves.forEach((k, i) => {
    const v = i === chaves.length - 1 ? centavos(resto) : centavos(valor * fracoes[k]);
    out[k] = v; resto -= v;
  });
  return out;
}

// Aportes dos sócios nos contratos — ativos (rendem até hoje) e quitados (rendem até a quitação).
// USO: montarAportes(ctx) → [{ id, ts, data:'dd/mm/aaaa', grupo:'ORION', contrato:'…', valor, marcelo, …,
//        taxaJuros:0.000416667, dataQuitacao:'', obs }]
function montarAportes(ctx) {
  const T125 = 0.000416667; // 1,25% a.m. como fração diária (formato gravado pelo servidor)
  const T100 = 0.000333333; // 1,00% a.m.
  const defs = [
    { m: -14, d: 5, grupo: 'ORION', contrato: 'ORION', valor: 120000, div: { marcelo: 0.5, ricardo: 0.3, fernando: 0.2 }, taxa: T125, quit: null, obs: 'Mobilização do canteiro de Campina Grande' },
    { m: -11, d: 18, grupo: 'ORION', contrato: 'ORION - Etapa 2', valor: 85000, div: { marcelo: 0.4, ricardo: 0.4, fernando: 0.2 }, taxa: T125, quit: null, obs: 'Compra de materiais da etapa 2' },
    { m: -10, d: 2, grupo: 'ATLAS', contrato: 'ATLAS', valor: 60000, div: { ricardo: 0.5, tiago: 0.5 }, taxa: T100, quit: { m: -4, d: 12 }, obs: 'Folha de pagamento antecipada' },
    { m: -8, d: 22, grupo: 'PAULO AFONSO', contrato: 'Delta Energia - Manutenção Civil', valor: 95000, div: { marcelo: 0.34, ricardo: 0.33, fernando: 0.33 }, taxa: T125, quit: null, obs: 'Capital de giro até o 1º recebimento da Delta Energia' },
    { m: -7, d: 9, grupo: 'NATAL', contrato: 'Manutenção de Linha', valor: 40000, div: { fernando: 1 }, taxa: 0, quit: { m: -2, d: 28 }, obs: 'Sem rendimento (acordo entre sócios)' },
    { m: -6, d: 14, grupo: 'ATLAS', contrato: 'ATLAS', valor: 35000, div: { ricardo: 0.5, tiago: 0.5 }, taxa: T100, quit: null, obs: '' },
    { m: -5, d: 3, grupo: 'SEDE', contrato: 'SEDE', valor: 25000, div: { marcelo: 0.5, ricardo: 0.5 }, taxa: 0, quit: { m: -1, d: 15 }, obs: 'Reforma do escritório' },
    { m: -4, d: 27, grupo: 'VEÍCULOS', contrato: 'VEÍCULOS', valor: 70000, div: { marcelo: 0.5, fernando: 0.5 }, taxa: T125, quit: null, obs: 'Entrada de duas picapes (financiamento Itaú)' },
    { m: -3, d: 11, grupo: 'PAULO AFONSO', contrato: 'Delta Energia - Manutenção Civil', valor: 48000, div: { marcelo: 0.34, ricardo: 0.33, fernando: 0.33 }, taxa: T125, quit: null, obs: '' },
    { m: -2, d: 6, grupo: 'NATAL', contrato: 'Manutenção de Linha', valor: 22000, div: { fernando: 0.6, tiago: 0.4 }, taxa: T100, quit: null, obs: 'Ferramental de linha viva' },
    { m: -1, d: 19, grupo: 'ORION', contrato: 'ORION - Etapa 3', valor: 55000, div: { marcelo: 0.4, ricardo: 0.4, fernando: 0.2 }, taxa: T125, quit: null, obs: '' },
    { m: 0, d: 2, grupo: 'SEDE', contrato: 'SEDE', valor: 12000, div: { tiago: 1 }, taxa: 0, quit: null, obs: 'Licenças de software do ano' },
  ];
  return defs.map((a) => {
    const data = diaDoMes(ctx, a.m, a.d);
    return {
      id: ctx.id('A'),
      ts: ctx.ts(data),
      data: ctx.br(data),
      grupo: a.grupo.toUpperCase(),
      contrato: a.contrato,
      valor: a.valor,
      ...dividir(a.valor, a.div),
      taxaJuros: a.taxa,
      dataQuitacao: a.quit ? ctx.br(diaDoMes(ctx, a.quit.m, a.quit.d)) : '',
      obs: a.obs,
    };
  });
}

// Empréstimos entre contratos (origem → destino): em aberto, parcial e quitado.
// USO: montarEmprestimos(ctx) → [{ id, ts, data, valor:30000, origem:'ATLAS', destino:'ORION', valorPago:0, dataPagamento:'', obs }]
function montarEmprestimos(ctx) {
  const defs = [
    { m: -9, d: 8, valor: 30000, origem: 'ATLAS', destino: 'ORION', pago: 30000, pagoEm: { m: -6, d: 20 }, obs: 'Cobrir medição atrasada' },
    { m: -7, d: 15, valor: 18500, origem: 'PAULO AFONSO', destino: 'NATAL', pago: 18500, pagoEm: { m: -5, d: 2 }, obs: '' },
    { m: -5, d: 21, valor: 42000, origem: 'ORION', destino: 'PAULO AFONSO', pago: 20000, pagoEm: null, obs: 'Pagamento parcial em andamento' },
    { m: -4, d: 4, valor: 12000, origem: 'SEDE', destino: 'VEÍCULOS', pago: 0, pagoEm: null, obs: 'IPVA da frota' },
    { m: -3, d: 17, valor: 26000, origem: 'NATAL', destino: 'ATLAS', pago: 26000, pagoEm: { m: -1, d: 10 }, obs: '' },
    { m: -2, d: 9, valor: 15000, origem: 'ATLAS', destino: 'SEDE', pago: 5000, pagoEm: null, obs: 'Devolução combinada em 3 vezes' },
    { m: -1, d: 23, valor: 35000, origem: 'PAULO AFONSO', destino: 'ORION', pago: 0, pagoEm: null, obs: 'Folha da etapa 3' },
  ];
  return defs.map((e) => {
    const data = diaDoMes(ctx, e.m, e.d);
    return {
      id: ctx.id('E'),
      ts: ctx.ts(data),
      data: ctx.br(data),
      valor: e.valor,
      origem: e.origem,
      destino: e.destino,
      valorPago: e.pago,
      dataPagamento: e.pagoEm ? ctx.br(diaDoMes(ctx, e.pagoEm.m, e.pagoEm.d)) : '',
      obs: e.obs,
    };
  });
}

// Distribuição do lucro por nota fiscal (14 meses → dois anos no filtro "Ano").
// USO: montarPercentuais(ctx) → [{ id, ts, nf:'1042', data:'dd/mm/aaaa', cidade:'Paulo Afonso', faturamento, ricardo, marcelo, fernando, obs }]
function montarPercentuais(ctx) {
  const cidades = ['Paulo Afonso', 'Natal', 'Campina Grande', 'Paulo Afonso', 'Recife', 'Natal', 'Campina Grande'];
  const lista = [];
  let nf = 1031;
  for (let m = -13; m <= 0; m++) {
    const qtd = m === 0 ? 1 : (m % 3 === 0 ? 2 : 1);
    for (let k = 0; k < qtd; k++) {
      const data = diaDoMes(ctx, m, 8 + k * 12);
      if (data > ctx.HOJE) continue;
      const faturamento = ctx.dinheiro(48000, 165000);
      const lucro = faturamento * (0.14 + ctx.rnd() * 0.08); // 14% a 22% de margem distribuível
      const partes = dividir(lucro, { ricardo: 0.4, marcelo: 0.35, fernando: 0.25 });
      lista.push({
        id: ctx.id('P'),
        ts: ctx.ts(data),
        nf: String(nf++),
        data: ctx.br(data),
        cidade: cidades[(nf + k) % cidades.length],
        faturamento,
        ricardo: partes.ricardo,
        marcelo: partes.marcelo,
        fernando: partes.fernando,
        obs: k === 1 ? 'Medição complementar Delta Energia' : '',
      });
    }
  }
  return lista;
}

// Retiradas dos sócios: lucro e devolução de capital (abate o aporte no Dashboard).
// USO: montarRetiradas(ctx) → [{ id, ts, data, socio:'Marcelo', tipo:'Lucro', valor, grupo:'ORION', obs }]
function montarRetiradas(ctx) {
  const defs = [
    { m: -11, d: 28, socio: 'Marcelo', tipo: 'Lucro', valor: 18000, grupo: 'ORION' },
    { m: -10, d: 28, socio: 'Ricardo', tipo: 'Lucro', valor: 15000, grupo: 'ATLAS' },
    { m: -8, d: 30, socio: 'Fernando', tipo: 'Devolução de capital', valor: 20000, grupo: 'NATAL', obs: 'Parte do aporte de ferramental' },
    { m: -7, d: 28, socio: 'Marcelo', tipo: 'Lucro', valor: 22000, grupo: 'PAULO AFONSO' },
    { m: -6, d: 10, socio: 'Tiago', tipo: 'Devolução de capital', valor: 15000, grupo: 'ATLAS' },
    { m: -4, d: 28, socio: 'Ricardo', tipo: 'Lucro', valor: 19500, grupo: 'ORION' },
    { m: -3, d: 28, socio: 'Fernando', tipo: 'Lucro', valor: 12800, grupo: 'PAULO AFONSO' },
    { m: -2, d: 15, socio: 'Marcelo', tipo: 'Devolução de capital', valor: 30000, grupo: 'ORION', obs: 'Devolução parcial do aporte da etapa 1' },
    { m: -1, d: 28, socio: 'Tiago', tipo: 'Lucro', valor: 9600, grupo: 'SEDE' },
    { m: -1, d: 28, socio: 'Ricardo', tipo: 'Lucro', valor: 17200, grupo: 'PAULO AFONSO' },
  ];
  return defs.map((r) => {
    const data = diaDoMes(ctx, r.m, r.d);
    return {
      id: ctx.id('R'),
      ts: ctx.ts(data),
      data: ctx.br(data),
      socio: r.socio,
      tipo: r.tipo,
      valor: r.valor,
      grupo: r.grupo.toUpperCase(),
      obs: r.obs || '',
    };
  });
}

// ---------------------------------------------------------------------------
// CONTABILIDADE — DRE, Balanço e Faturamento anuais por empresa, cada um com PDF fictício
// ---------------------------------------------------------------------------

const BR = (v) => 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Monta o store da Contabilidade ({ contabilidade, empresas }) já no formato de normalizarContabilidade.
// USO: await montarContabilidade(ctx) → { contabilidade:[{ tipo:'dre', competencia:'2025-12', empresaId, dados:{…}, arquivo:{id,…} }], empresas:[…] }
async function montarContabilidade(ctx) {
  const ano = ctx.HOJE.getFullYear();
  const empresas = [
    { id: 'CTBE-DEMO-NTE', nome: 'Norte Engenharia Ltda (demo)', cnpj: '11.111.111/0001-11', observacoes: 'Escritório contábil fictício — Contabilidade Exemplo S/S',
      receita: [3.85e6, 4.62e6, 5.31e6], margemCusto: [0.61, 0.6, 0.58], margemDesp: [0.17, 0.165, 0.16], ativoX: 0.74, liquidez: 1.62 },
    { id: 'CTBE-DEMO-SUL', nome: 'Sul Empreendimentos Ltda (demo)', cnpj: '22.222.222/0001-22', observacoes: 'Escritório contábil fictício — Contabilidade Exemplo S/S',
      receita: [2.12e6, 1.94e6, 2.48e6], margemCusto: [0.66, 0.71, 0.65], margemDesp: [0.19, 0.22, 0.18], ativoX: 0.68, liquidez: 0.86 },
  ];
  const criadoEm = ctx.ts(ctx.mes(-20));
  const contabilidade = [];
  const registro = (emp, tipo, competencia, dados, meses, arquivo, revisado) => ({
    id: ctx.id('CTB'),
    ts: ctx.ts(ctx.dia(-ctx.inteiro(10, 400))),
    tipo,
    competencia,
    empresaId: emp.id,
    empresa: emp.nome,
    cnpj: emp.cnpj,
    fonte: 'PDF Methodus (demonstração)',
    arquivo,
    dados,
    meses,
    linhas: [],
    avisos: [],
    revisadoPor: revisado ? 'Gestor Demonstração' : '',
    revisadoEm: revisado ? ctx.ts(ctx.dia(-ctx.inteiro(5, 60))) : 0,
  });
  const dadosVazios = {
    faturamento: 0, receitaBruta: 0, deducoes: 0, receitaLiquida: 0, custos: 0, despesas: 0, despesasOperacionais: 0,
    despesasAdministrativas: 0, lucroBruto: 0, resultadoOperacional: 0, resultadoAntesIR: 0, lucroLiquido: 0,
    ativo: 0, ativoCirculante: 0, ativoNaoCirculante: 0, estoques: 0, realizavelLongoPrazo: 0, passivo: 0,
    passivoCirculante: 0, passivoNaoCirculante: 0, passivoLongoPrazo: 0, patrimonioLiquido: 0,
  };
  // Faturamento mês a mês (sazonal: dezembro/janeiro mais fracos), somando exatamente `total`.
  const mesesFaturamento = (anoRef, total, ateMes = 12) => {
    const pesos = Array.from({ length: ateMes }, (_, i) => [0.72, 0.85, 1, 1.04, 1.08, 1.06, 1.1, 1.12, 1.05, 1.07, 1.02, 0.89][i]);
    const soma = pesos.reduce((s, p) => s + p, 0);
    let resto = total;
    return pesos.map((p, i) => {
      const valor = i === pesos.length - 1 ? centavos(resto) : centavos(total * p / soma);
      resto -= valor;
      return { competencia: `${anoRef}-${String(i + 1).padStart(2, '0')}`, rotulo: `${String(i + 1).padStart(2, '0')}/${anoRef}`, valor };
    });
  };

  for (const emp of empresas) {
    let plAcumulado = emp.receita[0] * 0.21;
    for (let k = 0; k < 3; k++) {
      const anoRef = ano - 3 + k;
      const RB = emp.receita[k];
      const deducoes = centavos(RB * 0.1133);
      const RL = centavos(RB - deducoes);
      const custos = centavos(RL * emp.margemCusto[k]);
      const LB = centavos(RL - custos);
      const despOper = centavos(RB * emp.margemDesp[k]);
      const despAdm = centavos(despOper * 0.42);
      const resOper = centavos(LB - despOper);
      const antesIR = centavos(resOper - RB * 0.006);
      const lucro = centavos(antesIR > 0 ? antesIR * 0.76 : antesIR);
      const sigla = emp.id.slice(-3);
      const pdfDre = await ctx.novoPdf(`dre-${sigla.toLowerCase()}-${anoRef}.pdf`, `DRE ${anoRef} — ${emp.nome}`, [
        `CNPJ: ${emp.cnpj}`, `Período: 01/01/${anoRef} a 31/12/${anoRef}`, '',
        `Receita bruta de serviços .......... ${BR(RB)}`, `(-) Deduções (ISS, PIS, COFINS) .... ${BR(deducoes)}`,
        `Receita líquida .................... ${BR(RL)}`, `(-) Custo dos serviços prestados ... ${BR(custos)}`,
        `Lucro bruto ........................ ${BR(LB)}`, `(-) Despesas operacionais .......... ${BR(despOper)}`,
        `    das quais administrativas ...... ${BR(despAdm)}`, `Resultado operacional .............. ${BR(resOper)}`,
        `Resultado antes do IR/CSLL ......... ${BR(antesIR)}`, `Lucro (prejuízo) líquido ........... ${BR(lucro)}`,
      ]);
      contabilidade.push(registro(emp, 'dre', `${anoRef}-12`, {
        ...dadosVazios, faturamento: RB, receitaBruta: RB, deducoes, receitaLiquida: RL, custos, despesas: despOper,
        despesasOperacionais: despOper, despesasAdministrativas: despAdm, lucroBruto: LB, resultadoOperacional: resOper,
        resultadoAntesIR: antesIR, lucroLiquido: lucro,
      }, [], pdfDre, k < 2));

      // Balanço: AC/PC respeita a liquidez escolhida para a empresa (NTE folgada, SUL apertada).
      plAcumulado = centavos(plAcumulado + lucro * 0.55);
      const ativo = centavos(RB * emp.ativoX);
      const ac = centavos(ativo * 0.58);
      const anc = centavos(ativo - ac);
      const pc = centavos(ac / (emp.liquidez - 0.05 + k * 0.05));
      const pl = Math.min(plAcumulado, centavos(ativo - pc - ativo * 0.05));
      const pnc = centavos(ativo - pc - pl);
      const estoques = centavos(ac * 0.12);
      const rlp = centavos(anc * 0.18);
      const pdfBal = await ctx.novoPdf(`balanco-${sigla.toLowerCase()}-${anoRef}.pdf`, `Balanço Patrimonial ${anoRef} — ${emp.nome}`, [
        `CNPJ: ${emp.cnpj}`, `Encerrado em 31/12/${anoRef}`, '',
        `ATIVO TOTAL ........................ ${BR(ativo)}`, `  Ativo circulante ................. ${BR(ac)}`,
        `    Estoques ....................... ${BR(estoques)}`, `  Ativo não circulante ............. ${BR(anc)}`,
        `    Realizável a longo prazo ....... ${BR(rlp)}`, '',
        `PASSIVO + PL ....................... ${BR(ativo)}`, `  Passivo circulante ............... ${BR(pc)}`,
        `  Passivo não circulante ........... ${BR(pnc)}`, `  Patrimônio líquido ............... ${BR(pl)}`,
      ]);
      contabilidade.push(registro(emp, 'balanco', `${anoRef}-12`, {
        ...dadosVazios, ativo, ativoCirculante: ac, ativoNaoCirculante: anc, estoques, realizavelLongoPrazo: rlp,
        passivo: ativo, passivoCirculante: pc, passivoNaoCirculante: pnc, passivoLongoPrazo: pnc, patrimonioLiquido: pl,
      }, [], pdfBal, k < 2));

      const mesesFat = mesesFaturamento(anoRef, RB);
      const pdfFat = await ctx.novoPdf(`faturamento-${sigla.toLowerCase()}-${anoRef}.pdf`, `Relação de Faturamento ${anoRef} — ${emp.nome}`,
        [`CNPJ: ${emp.cnpj}`, '', ...mesesFat.map(m => `${m.rotulo} ........................ ${BR(m.valor)}`), '', `TOTAL ${anoRef} ................... ${BR(RB)}`]);
      contabilidade.push(registro(emp, 'faturamento', `${anoRef}-12`, { ...dadosVazios, faturamento: RB, receitaBruta: RB },
        mesesFat, pdfFat, true));
    }
    // Ano corrente: só o faturamento até o mês passado — a tela marca o ano como "(parc.)".
    const mesesFeitos = ctx.HOJE.getMonth(); // meses completos já fechados no ano
    if (mesesFeitos > 0) {
      const parcial = centavos(emp.receita[2] * 1.08 * mesesFeitos / 12);
      const mesesFat = mesesFaturamento(ano, parcial, mesesFeitos);
      const pdfFat = await ctx.novoPdf(`faturamento-${emp.id.slice(-3).toLowerCase()}-${ano}-parcial.pdf`, `Relação de Faturamento ${ano} (parcial) — ${emp.nome}`,
        [`CNPJ: ${emp.cnpj}`, '', ...mesesFat.map(m => `${m.rotulo} ........................ ${BR(m.valor)}`), '', `ACUMULADO ${ano} ............... ${BR(parcial)}`]);
      contabilidade.push(registro(emp, 'faturamento', `${ano}-12`, { ...dadosVazios, faturamento: parcial, receitaBruta: parcial },
        mesesFat, pdfFat, false));
    }
  }
  return {
    contabilidade,
    empresas: empresas.map(e => ({ id: e.id, nome: e.nome, cnpj: e.cnpj, observacoes: e.observacoes, criadoEm, atualizadoEm: criadoEm })),
  };
}

// ---------------------------------------------------------------------------
// INVESTIMENTOS — snapshot da carteira de renda fixa (formato gravado por normalizarInvestimentos)
// ---------------------------------------------------------------------------

// Alíquota regressiva de IR por dias corridos. USO: aliquotaIR(400) → 0.175
function aliquotaIR(dias) { return dias <= 180 ? 0.225 : dias <= 360 ? 0.2 : dias <= 720 ? 0.175 : 0.15; }
// Tabela regressiva do IOF (dia 1 = 96% do rendimento … dia 30 = 0%). USO: aliquotaIOF(20) → 0.33
function aliquotaIOF(dias) { return dias >= 30 ? 0 : Math.round((96 - (dias - 1) * (96 / 29)) ) / 100; }

// Último dia útil (seg–sex) antes de `d`. USO: diaUtilAnterior(new Date('2026-10-12')) → sexta 09/10
function diaUtilAnterior(d) {
  const x = new Date(d); x.setDate(x.getDate() - 1);
  while (x.getDay() === 0 || x.getDay() === 6) x.setDate(x.getDate() - 1);
  return x;
}

// USO: montarInvestimentos(ctx) → { snapshot:{ meta, resumo, posicoes_abertas, encerradas, historico, … },
//        data_base:'2026-10-07', cdi_anual:0.1415, projecao:{…}, historico_diario:[…] }
function montarInvestimentos(ctx) {
  const CDI = 0.1415; // % a.a. fictício usado na demo
  const DIA = 864e5;
  const base = diaUtilAnterior(ctx.HOJE);
  const dataBase = ctx.iso(base);
  // Saldo de uma aplicação em uma data (taxa anual efetiva → composição diária corrida, só para a demo).
  const saldoEm = (p, d) => {
    const dias = Math.max(0, Math.round((d - p.aplic) / DIA));
    return centavos(p.valor * Math.pow(1 + p.taxaAno, dias / 365));
  };
  const defs = [
    { produto: 'CDB Pós-fixado 100% CDI', diasAtras: 430, prazoDias: 1080, valor: 150000, taxaAno: CDI * 1.0, isento: false },
    { produto: 'CDB Pós-fixado 105% CDI', diasAtras: 250, prazoDias: 730, valor: 80000, taxaAno: CDI * 1.05, isento: false },
    { produto: 'LCI 92% CDI', diasAtras: 205, prazoDias: 540, valor: 60000, taxaAno: CDI * 0.92, isento: true },
    { produto: 'LCA 90% CDI', diasAtras: 120, prazoDias: 365, valor: 45000, taxaAno: CDI * 0.9, isento: true },
    { produto: 'CDB Pré-fixado 12,40% a.a.', diasAtras: 800, prazoDias: 1460, valor: 50000, taxaAno: 0.124, isento: false },
    { produto: 'CDB Pós-fixado 100% CDI', diasAtras: 20, prazoDias: 720, valor: 30000, taxaAno: CDI * 1.0, isento: false },
  ];
  const posicoes = defs.map((p, i) => {
    const aplic = new Date(base.getTime() - p.diasAtras * DIA);
    const venc = new Date(aplic.getTime() + p.prazoDias * DIA);
    const pos = { ...p, aplic, nota: String(4100231 + i * 3797).padStart(9, '0') };
    const saldo = saldoEm(pos, base);
    const rend = centavos(saldo - p.valor);
    const iof = centavos(rend * aliquotaIOF(p.diasAtras));
    const aliq = p.isento ? 0 : aliquotaIR(p.diasAtras);
    const ir = centavos((rend - iof) * aliq);
    return {
      _pos: pos,
      nota: pos.nota, banco: 'Banco Inter', produto: p.produto, vencimento: ctx.iso(venc), data_aplicacao: ctx.iso(aplic),
      dias_corridos: p.diasAtras, valor_aplicado: p.valor, rendimento_bruto: rend, saldo_bruto: saldo,
      aliquota_ir: aliq, aliquota_ir_rotulo: p.isento ? 'Isento' : `${(aliq * 100).toFixed(1).replace('.', ',')}%`,
      ir_previsto: ir, iof_previsto: iof, valor_liquido: centavos(saldo - ir - iof),
      rentabilidade_pct: p.valor ? rend / p.valor : 0,
    };
  });

  // Encerradas: três completas e uma com período sem extrato (incompleta → gera aviso do pipeline).
  const encDefs = [
    { produto: 'CDB Pós-fixado 100% CDI', aplicDias: 900, encDias: 520, valor: 70000, taxaAno: CDI * 0.95 },
    { produto: 'LCI 95% CDI', aplicDias: 700, encDias: 335, valor: 40000, taxaAno: CDI * 0.95, isento: true },
    { produto: 'CDB Pré-fixado 11,80% a.a.', aplicDias: 610, encDias: 150, valor: 55000, taxaAno: 0.118 },
    { produto: 'LCA 88% CDI', aplicDias: 560, encDias: 380, valor: 25000, taxaAno: CDI * 0.88, isento: true, incompleto: true },
  ];
  const encerradas = encDefs.map((e) => {
    const aplic = new Date(base.getTime() - e.aplicDias * DIA);
    const enc = new Date(base.getTime() - e.encDias * DIA);
    const dias = e.aplicDias - e.encDias;
    const bruto = centavos(e.valor * Math.pow(1 + e.taxaAno, dias / 365) - e.valor);
    const ir = e.isento ? 0 : centavos(bruto * aliquotaIR(dias));
    const liquido = centavos(e.valor + bruto - ir);
    return {
      produto: e.produto, vencimento: ctx.iso(enc), data_aplicacao: ctx.iso(aplic), data_encerramento: ctx.iso(enc),
      valor_aplicado: e.valor, incompleto: !!e.incompleto,
      rendimento_total_recebido: e.incompleto ? null : bruto,
      ir_total_pago: e.incompleto ? null : ir,
      iof_total_pago: e.incompleto ? null : 0,
      valor_liquido_recebido: e.incompleto ? null : liquido,
      rentabilidade_liquida_pct: e.incompleto ? null : (liquido - e.valor) / e.valor,
      _ir: ir, _bruto: bruto,
    };
  });

  // Movimentações (extratos): aplicação de cada posição, rendimentos dos 3 últimos fechamentos e resgates.
  const historico = [];
  const fimDeMes = (desloc) => new Date(ctx.HOJE.getFullYear(), ctx.HOJE.getMonth() + desloc + 1, 0, 12);
  for (const p of posicoes) {
    historico.push({ data: p.data_aplicacao, banco: 'Banco Inter', produto: p.produto, vencimento: p.vencimento,
      historico: 'APLICAÇÃO', valor: p.valor_aplicado, ir: null, iof: null, saldo: p.valor_aplicado });
    for (const desloc of [-3, -2, -1]) {
      const d = fimDeMes(desloc);
      if (d <= p._pos.aplic) continue;
      const saldo = saldoEm(p._pos, d);
      // saldoEm antes da aplicação devolve o próprio valor aplicado (dias = 0)
      const rend = centavos(saldo - saldoEm(p._pos, fimDeMes(desloc - 1)));
      historico.push({ data: ctx.iso(d), banco: 'Banco Inter', produto: p.produto, vencimento: p.vencimento,
        historico: 'RENDIMENTO DO PERÍODO', valor: rend, ir: null, iof: null, saldo });
    }
  }
  for (const e of encerradas) {
    historico.push({ data: e.data_aplicacao, banco: 'Banco Inter', produto: e.produto, vencimento: e.vencimento,
      historico: 'APLICAÇÃO', valor: e.valor_aplicado, ir: null, iof: null, saldo: e.valor_aplicado });
    if (e.incompleto) continue;
    if (e._ir) historico.push({ data: e.data_encerramento, banco: 'Banco Inter', produto: e.produto, vencimento: e.vencimento,
      historico: 'IR RETIDO NA FONTE', valor: e._ir, ir: e._ir, iof: null, saldo: centavos(e.valor_aplicado + e._bruto - e._ir) });
    historico.push({ data: e.data_encerramento, banco: 'Banco Inter', produto: e.produto, vencimento: e.vencimento,
      historico: 'RESGATE NO VENCIMENTO', valor: e.valor_liquido_recebido, ir: null, iof: null, saldo: 0 });
  }
  historico.sort((a, b) => a.data.localeCompare(b.data) || a.produto.localeCompare(b.produto));

  // Histórico diário: âncoras reais (fonte 'extrato') nos 3 últimos fechamentos e na data-base.
  // Com duas âncoras crescentes por posição o servidor CALIBRA a taxa e projeta até hoje no 1º GET.
  const historico_diario = [];
  for (const p of posicoes) {
    for (const desloc of [-3, -2, -1]) {
      const d = fimDeMes(desloc);
      if (d <= p._pos.aplic || d >= base) continue;
      historico_diario.push({ data: ctx.iso(d), nota: p.nota, produto: p.produto, saldo: saldoEm(p._pos, d), rendimento_dia: 0, fonte: 'extrato' });
    }
    historico_diario.push({ data: dataBase, nota: p.nota, produto: p.produto, saldo: p.saldo_bruto, rendimento_dia: 0, fonte: 'extrato' });
  }

  const posLimpas = posicoes.map(({ _pos, ...resto }) => resto);
  const encLimpas = encerradas.map(({ _ir, _bruto, ...resto }) => resto);
  const soma = (arr, c) => centavos(arr.reduce((s, x) => s + (Number(x[c]) || 0), 0));
  const fatorDia = Math.pow(1 + CDI, 1 / 252) - 1;
  const posProj = {};
  for (const p of posLimpas) posProj[p.nota] = { saldo_projetado: p.saldo_bruto, rendimento_dia: centavos(p.saldo_bruto * fatorDia) };
  const totalAplicado = soma(posLimpas, 'valor_aplicado');
  const rendBruto = soma(posLimpas, 'rendimento_bruto');
  const pdfsMov = ['-3', '-2', '-1'].map(dl => `extrato-movimentacao-${chaveMes(fimDeMes(Number(dl)))}-demo.pdf`);

  return {
    snapshot: {
      meta: {
        data_base: dataBase,
        gerado_em: ctx.iso(ctx.HOJE),
        fonte_posicao: `extrato-posicao-${dataBase}-demo.pdf`,
        pdfs_movimentacao: pdfsMov,
        contagens: {
          pdfs_total: pdfsMov.length + 1, pdfs_movimentacao: pdfsMov.length, blocos_movimentacao: posLimpas.length * 3,
          aplicacoes_unicas: posLimpas.length + encLimpas.length, posicoes_abertas: posLimpas.length, encerradas: encLimpas.length,
          linhas_hist_total: historico.length + 6, linhas_hist_dedup: historico.length, linhas_duplicadas_descartadas: 6,
        },
        avisos: encLimpas.filter(e => e.incompleto).map(e =>
          `Encerrada ${e.produto} (apl ${e.data_aplicacao}, venc ${e.vencimento}): histórico incompleto (movimentações no período sem extrato) — rendimento/IR não confiáveis, deixados em branco.`),
      },
      resumo: {
        total_aplicado: totalAplicado,
        saldo_bruto: soma(posLimpas, 'saldo_bruto'),
        rendimento_bruto: rendBruto,
        ir_previsto: soma(posLimpas, 'ir_previsto'),
        iof_previsto: soma(posLimpas, 'iof_previsto'),
        valor_liquido: soma(posLimpas, 'valor_liquido'),
        rentabilidade_media_pct: totalAplicado ? Math.round(rendBruto / totalAplicado * 1e6) / 1e6 : 0,
        ir_pago: centavos(historico.reduce((s, h) => s + (h.ir || 0), 0)),
        iof_pago: 0,
      },
      posicoes_abertas: posLimpas,
      encerradas: encLimpas,
      historico,
      totais_posicao_extrato: { bruto: soma(posLimpas, 'saldo_bruto'), liquido: soma(posLimpas, 'valor_liquido') },
    },
    data_base: dataBase,
    importado_em: ctx.ts(ctx.dia(-1)),
    importado_por: 'Gestor Demonstração',
    cdi_anual: CDI,
    projecao: { ultima_data: dataBase, posicoes: posProj },
    historico_diario,
  };
}

// ---------------------------------------------------------------------------
// CUSTOS — razão de lançamentos + recebimentos (12 meses), grupos ajustados e horas extras
// ---------------------------------------------------------------------------

// Categorias do razão (nomes como o Conta Azul exporta) → faixa mensal por contrato.
// A última ('Aluguel de Container') não está no mapa padrão do app: o custos_config a reclassifica.
const CATEGORIAS_CUSTO = [
  { cat: 'Folha de Pagamento (Equipe Operacional)', forn: 'Folha — equipe operacional', min: 14000, max: 19000, conta: 'banco' },
  { cat: 'Vale Alimento', forn: 'Benefícios Exemplo Ltda', min: 4200, max: 5600, conta: 'banco' },
  { cat: 'Plano de Saúde Colaboradores', forn: 'Operadora de Saúde Exemplo', min: 3100, max: 3900, conta: 'banco' },
  { cat: 'FGTS Mensal', forn: 'Caixa — FGTS (guia demo)', min: 1300, max: 1700, conta: 'banco' },
  { cat: 'DCTFWeb', forn: 'Receita Federal — DCTFWeb (guia demo)', min: 4200, max: 5900, conta: 'banco' },
  { cat: 'ISS (Imposto Sobre Serviços)', forn: 'Prefeitura Municipal (guia demo)', min: 2600, max: 4100, conta: 'banco' },
  { cat: 'Combustível para Frota', forn: 'Posto Rodovia Demo', min: 5200, max: 8900, conta: 'cartao' },
  { cat: 'Manutenção para Frota', forn: 'Oficina Exemplo Ltda', min: 900, max: 5200, conta: 'banco', prob: 0.8 },
  { cat: 'Materiais Aplicados na Prestação de Serviços', forn: 'Materiais de Construção Fictícia', min: 6500, max: 21000, conta: 'banco' },
  { cat: 'EPI, EPC e Uniformes', forn: 'EPI Exemplo Comércio', min: 700, max: 2600, conta: 'cartao', prob: 0.7 },
  { cat: 'Aluguel de Alojamento', forn: 'Imobiliária Exemplo', min: 3200, max: 3600, conta: 'banco' },
  { cat: 'Exames Médicos', forn: 'Clínica Ocupacional Demo', min: 350, max: 1400, conta: 'banco', prob: 0.5 },
  { cat: 'Telefonia e Internet', forn: 'Telecom Exemplo S.A.', min: 420, max: 680, conta: 'cartao' },
  { cat: 'Aluguel de Container', forn: 'Containers Demo Locações', min: 1800, max: 1800, conta: 'banco', prob: 0.9 },
];
// Custos só da SEDE (administrativos) — contrato sem faturamento próprio.
const CATEGORIAS_SEDE = [
  { cat: 'Folha de Pagamento (Equipe Administrativa)', forn: 'Folha — equipe administrativa', min: 7000, max: 8500, conta: 'banco' },
  { cat: 'Software/Licença de Uso', forn: 'Software Demo SaaS', min: 1450, max: 1450, conta: 'cartao' },
  { cat: 'Energia', forn: 'Distribuidora de Energia (demo)', min: 900, max: 1500, conta: 'banco' },
  { cat: 'Passagens Aéreas', forn: 'Agência de Viagens Exemplo', min: 1200, max: 5400, conta: 'cartao', prob: 0.6 },
  { cat: 'IPVA/DPVAT/Licenciamento/Taxas com Detran', forn: 'Detran (guia demo)', min: 2400, max: 7800, conta: 'banco', prob: 0.25 },
  { cat: 'Retirada de Sócios', forn: 'Distribuição aos sócios', min: 15000, max: 30000, conta: 'banco', prob: 0.5 },
];

// USO: montarCustos(ctx) → { lancamentos:[{fornecedor,data:'aaaa-mm-dd',descricao,valor,categoria,centroCusto,conta}],
//        recebimentos:[{protocolo,fatura,nf,contrato,referencia,dataFaturamento,dataPagamento,valorFaturado,valorReceber,status}],
//        porContrato:{ 'PAULO AFONSO':{…} }, meta:{…}, importadoEm, importadoPor, arquivo }
function montarCustos(ctx) {
  // Contratos com receita (Delta Energia) e o "tamanho" de cada um; SEDE só tem custo.
  // C.G = Campina Grande (o servidor canoniza o centro de custo para "C.G").
  const contratos = [
    { nome: 'PAULO AFONSO', escala: 1.0, faturamento: [85000, 98000], banco: 'Conta Corrente DEMO — Banco do Brasil' },
    { nome: 'NATAL', escala: 0.72, faturamento: [57000, 66000], banco: 'Conta Corrente DEMO — Caixa' },
    { nome: 'C.G', escala: 0.85, faturamento: [68000, 79000], banco: 'Conta Corrente DEMO — Sicredi', mesRuim: -4 },
  ];
  const cartao = 'Cartão XP VISA final 4821';
  const lancamentos = [];
  const recebimentos = [];
  let protocolo = 7001, nf = 1188;
  // 12 meses FECHADOS (até o mês passado): mês corrente pela metade distorceria as variações.
  for (let m = -12; m <= -1; m++) {
    const dataNoMes = () => ctx.iso(diaDoMes(ctx, m, ctx.inteiro(1, 28)));
    const ref = diaDoMes(ctx, m, 1);
    const refTxt = ref.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
    const lancar = (centro, cats, escala, banco) => {
      for (const c of cats) {
        if (c.prob != null && ctx.rnd() > c.prob) continue;
        lancamentos.push({
          fornecedor: c.forn,
          data: dataNoMes(),
          descricao: `${c.cat} — ${refTxt}`,
          valor: ctx.dinheiro(c.min * escala, c.max * escala),
          categoria: c.cat,
          centroCusto: centro,
          conta: c.conta === 'cartao' ? cartao : banco,
        });
      }
    };
    for (const k of contratos) {
      // mês ruim do C.G: compra grande de material (resultado negativo naquele mês)
      const extra = k.mesRuim === m ? [{ cat: 'Materiais Aplicados na Prestação de Serviços', forn: 'Materiais de Construção Fictícia', min: 98000, max: 112000, conta: 'banco' }] : [];
      lancar(k.nome, CATEGORIAS_CUSTO.concat(extra), k.escala, k.banco);
      const valorFaturado = ctx.dinheiro(k.faturamento[0], k.faturamento[1]);
      const fat = diaDoMes(ctx, m, 25);
      const pagoEm = diaDoMes(ctx, m + 1, 24);
      // pagas até 3 meses atrás; a de NATAL de 2 meses atrás está vencida; a do mês passado, em aberto
      const vencida = m === -2 && k.nome === 'NATAL';
      const pago = m <= -3 || (m === -2 && !vencida);
      recebimentos.push({
        protocolo: `PROT-${protocolo++}`,
        fatura: `FAT-${chaveMes(ref).replace('-', '')}-${k.nome.replace(/[^A-Z]/g, '').slice(0, 3)}`,
        nf: String(nf++),
        contrato: k.nome,
        referencia: `Medição ${String(ref.getMonth() + 1).padStart(2, '0')}/${ref.getFullYear()} — Delta Energia`,
        dataFaturamento: ctx.iso(fat),
        dataPagamento: pago ? ctx.iso(pagoEm) : '',
        valorFaturado,
        valorReceber: pago ? 0 : centavos(valorFaturado * 0.8865), // líquido de retenções (INSS/ISS/IR)
        status: pago ? 'PAGA' : (vencida ? 'VENCIDA' : 'EM ABERTO'),
      });
    }
    lancar('SEDE', CATEGORIAS_SEDE, 1, 'Conta Corrente DEMO — Banco do Brasil');
  }
  lancamentos.sort((a, b) => a.data.localeCompare(b.data));
  const datas = lancamentos.map(l => l.data);
  const importadoEm = ctx.ts(ctx.dia(-2));
  const arquivo = 'CUSTOS DEMO (fictício).xlsx';
  const porContrato = {};
  for (const nome of ['PAULO AFONSO', 'NATAL', 'C.G', 'SEDE']) {
    porContrato[nome] = { nome, importadoEm, importadoPor: 'Gestor Demonstração', arquivo, lancamentos: lancamentos.filter(l => l.centroCusto === nome).length };
  }
  return {
    lancamentos,
    recebimentos,
    porContrato,
    meta: { periodoDe: datas[0], periodoAte: datas[datas.length - 1], totalLancamentos: lancamentos.length, contratos: Object.values(porContrato).map(x => x.nome) },
    importadoEm,
    importadoPor: 'Gestor Demonstração',
    arquivo,
  };
}

// Horas extras digitadas na sub-aba Custos › Equipe (uma por contrato/mês, últimos 6 meses).
// USO: montarHorasExtras(ctx) → [{ id, ts, competencia:'2026-09', centroCusto:'NATAL', valor:4210.5, obs, quem, atualizadoEm }]
function montarHorasExtras(ctx) {
  const lista = [];
  const faixas = { 'PAULO AFONSO': [3200, 7400], NATAL: [2400, 6100], 'C.G': [1800, 5200], SEDE: [0, 1600] };
  for (let m = -6; m <= -1; m++) {
    for (const [centro, [min, max]] of Object.entries(faixas)) {
      const valor = ctx.dinheiro(min, max);
      if (valor < 300) continue; // a SEDE quase não faz hora extra
      const quando = diaDoMes(ctx, m + 1, 5);
      lista.push({
        id: ctx.id('HE'),
        ts: ctx.ts(quando),
        competencia: chaveMes(diaDoMes(ctx, m, 1)),
        centroCusto: centro,
        valor,
        obs: centro === 'NATAL' && m === -2 ? 'Atendimento emergencial (chuvas)' : '',
        quem: 'Gestor Demonstração',
        atualizadoEm: ctx.ts(quando),
      });
    }
  }
  return lista;
}

// Salário base fictício por cargo (Custos › Equipe soma a folha a partir das vigências).
const SALARIO_CARGO = {
  'Encarregado de Manutenção': 4300, 'Engenheira Civil': 9800, 'Motorista': 2650, 'Auxiliar Administrativo': 2100,
  'Eletricista de Linha Viva': 3900, 'Técnica de Segurança do Trabalho': 3600, 'Pedreiro': 2550,
  'Assistente de Departamento Pessoal': 2800, 'Operador de Retroescavadeira': 3300, 'Almoxarife': 2400,
  'Auxiliar de Escritório': 1950, 'Servente': 1750,
};
// Completa `salarios` (vigências {desde:'aaaa-mm', valor}) SÓ de quem está sem nenhuma — não mexe
// no que outro módulo (ex.: 30-pessoas) já tenha preenchido. Reajuste de 5,5% há 5 meses (dissídio).
// USO: completarSalarios(ctx) → nº de colaboradores completados (ex.: 14)
function completarSalarios(ctx) {
  let n = 0;
  for (const f of ctx.funcionarios || []) {
    if (Array.isArray(f.salarios) && f.salarios.length) continue;
    const base = SALARIO_CARGO[f.cargo] || 2500;
    const admissao = String(f.admissao || '').slice(0, 7) || chaveMes(ctx.mes(-24));
    const dissidio = chaveMes(diaDoMes(ctx, -5, 1));
    f.salarios = admissao < dissidio
      ? [{ desde: admissao, valor: base }, { desde: dissidio, valor: centavos(base * 1.055) }]
      : [{ desde: admissao, valor: base }];
    n++;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Ponto de entrada do módulo
// ---------------------------------------------------------------------------
exports.montar = async (ctx) => {
  completarContratos(ctx);
  completarSalarios(ctx);
  return {
    'simulacoes.json': { simulacoes: montarSimulacoes(ctx) },
    'cartoes.json': { cartoes: montarCartoes(ctx) },
    'aportes.json': { aportes: montarAportes(ctx) },
    'emprestimos.json': { emprestimos: montarEmprestimos(ctx) },
    'percentuais.json': { percentuais: montarPercentuais(ctx) },
    'retiradas.json': { retiradas: montarRetiradas(ctx) },
    'contabilidade.json': await montarContabilidade(ctx),
    'investimentos.json': montarInvestimentos(ctx),
    'custos.json': montarCustos(ctx),
    // Ajuste do usuário no mapa categoria→grupo (chave canônica: maiúscula e sem acento).
    'custos_config.json': { gruposCategoria: { 'ALUGUEL DE CONTAINER': 'Materiais e serviços' } },
    'horas_extras.json': { horasExtras: montarHorasExtras(ctx) },
  };
};
