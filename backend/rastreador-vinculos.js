'use strict';

const { randomUUID } = require('node:crypto');

// USO: chave(' ab12 ') => 'AB12'; placeholders não representam veículo/aparelho.
const chave = v => /[A-Z0-9]/i.test(String(v || '')) ? String(v).trim().toUpperCase() : '';

// USO: placaVinculada({ placa: 'ABC1D23', situacao: 'Removido' }) => ''.
// A placa do cadastro pode ser mantida como referência depois da retirada.
function placaVinculada(r) {
  if (!r || r.desativado || /^(removido|devolvido|extraviado|trocado)$/i.test(r.situacao || '')) return '';
  return chave(r.placa);
}

// USO: resolverRastreador({numeroSerie:'ESN1'}, [{id:'R1',codigo:'C1',esn:'ESN1'}], []) => R1.
// Código/ESN reutilizado ou ambíguo não associa nada. Um id já gravado prevalece sobre o texto.
function resolverRastreador(inst, rastreadores, historico = []) {
  if (inst.rastreadorId) return rastreadores.find(r => r.id === inst.rastreadorId) || null;
  const numero = chave(inst.numeroSerie);
  if (!numero) return null;
  const ids = new Set();
  for (const r of rastreadores) if ([chave(r.codigo), chave(r.esn)].includes(numero)) ids.add(r.id);
  for (const e of historico) {
    if ([e.codigo, e.esn, e.codigoAnterior, e.esnAnterior].map(chave).includes(numero)) ids.add(e.rastreadorId);
  }
  return ids.size === 1 ? rastreadores.find(r => ids.has(r.id)) || null : null;
}

// Modelo do histórico próprio (sem o limite de 1.000 do histórico geral).
// USO: evento({id:'R1',codigo:'C1'}, {origem:'manual',por:'João'})
// => {id:'RV…',rastreadorId:'R1',codigo:'C1',ts:…,dataInstalacao:'',…}.
function evento(r, ctx = {}) {
  return {
    id: 'RV' + randomUUID(), rastreadorId: r.id, codigo: r.codigo || '', esn: r.esn || '',
    ts: ctx.ts || Date.now(), origem: ctx.origem || 'manual', por: ctx.por || '',
    tipo: '', placaAnterior: '', placa: '', dataInstalacao: '', instalacaoId: '', fotos: [],
  };
}

// USO: eventosDeRastreadores([{id:'R1',placa:'ABC1D23'}], [{id:'R1',placa:'XYZ4E56'}])
// => um evento 'transferencia'. Reimportar o mesmo vínculo => []. A data física fica desconhecida.
function eventosDeRastreadores(antes, depois, ctx = {}) {
  const antigos = new Map(antes.map(r => [r.id, r]));
  const novos = new Map(depois.map(r => [r.id, r]));
  const eventos = [];
  for (const r of depois) {
    const a = antigos.get(r.id), de = placaVinculada(a), para = placaVinculada(r);
    let tipo = '';
    if (!a) tipo = para ? 'vinculacao' : 'cadastro';
    else if (de !== para) tipo = !para ? 'remocao' : de ? 'transferencia' : 'vinculacao';
    else if (chave(a.placa) !== chave(r.placa)) tipo = 'referencia';
    else if (chave(a.codigo) !== chave(r.codigo) || chave(a.esn) !== chave(r.esn)) tipo = 'identificacao';
    if (tipo) eventos.push({ ...evento(r, ctx), tipo,
      placaAnterior: tipo === 'referencia' ? chave(a.placa) : de,
      placa: tipo === 'referencia' ? chave(r.placa) : para,
      codigoAnterior: a && a.codigo || '', esnAnterior: a && a.esn || '' });
  }
  for (const a of antes) if (!novos.has(a.id)) {
    eventos.push({ ...evento(a, ctx), tipo: 'cadastroExcluido', placaAnterior: placaVinculada(a) });
  }
  return eventos;
}

// USO: dadosInstalacao({id:'I1',data:'10/09/2026',placa:'ABC1D23',fotos:[]})
// => retrato dos dados e evidências informados na instalação, independente da data de cadastro.
function dadosInstalacao(i) {
  return { instalacaoId: i.id, placa: chave(i.placa), dataInstalacao: i.data || '',
    colaborador: i.colaborador || '', local: i.local || '', observacoes: i.observacoes || '',
    fotos: (i.fotos || []).map(f => ({ id: f.id, nome: f.nome || '', tipo: f.tipo || '' })) };
}

// USO: eventosDeInstalacoes([], [instalacao], rastreadores, historico, {por:'João'})
// => instalação vinculada; correções/exclusões geram eventos, preservando o retrato anterior.
function eventosDeInstalacoes(antes, depois, rastreadores, historico, ctx = {}) {
  const antigos = new Map(antes.map(i => [i.id, i]));
  const novos = new Map(depois.map(i => [i.id, i]));
  const eventos = [];
  for (const i of depois) {
    const a = antigos.get(i.id);
    const r = resolverRastreador(i, rastreadores, historico);
    const ra = a && resolverRastreador(a, rastreadores, historico);
    if (a && JSON.stringify(dadosInstalacao(a)) === JSON.stringify(dadosInstalacao(i)) && ra?.id === r?.id) continue;
    if (ra && ra.id !== r?.id) eventos.push({ ...evento(ra, ctx), ...dadosInstalacao(a), tipo: 'associacaoCorrigida' });
    if (r) eventos.push({ ...evento(r, ctx), ...dadosInstalacao(i),
      tipo: a && ra?.id === r.id ? 'instalacaoCorrigida' : 'instalacao' });
  }
  for (const a of antes) if (!novos.has(a.id)) {
    const r = resolverRastreador(a, rastreadores, historico);
    if (r) eventos.push({ ...evento(r, ctx), ...dadosInstalacao(a), tipo: 'instalacaoExcluida' });
  }
  return eventos;
}

// USO: recuperarLegado(rastreadores, instalacoes, historico, 1234)
// => só entradas ausentes; repetir no próximo boot => []. Nunca usa a placa para adivinhar o aparelho.
function recuperarLegado(rastreadores, instalacoes, historico, ts = Date.now()) {
  const eventos = [];
  const vistos = new Set(historico.map(e => e.rastreadorId));
  for (const r of rastreadores) if (!vistos.has(r.id)) {
    eventos.push({ ...evento(r, { origem: 'legado', ts }), id: 'RV-INICIAL-' + r.id,
      tipo: 'estadoInicial', placa: placaVinculada(r), recuperado: true });
  }
  const registros = new Set(historico.map(e => e.instalacaoId).filter(Boolean));
  for (const i of instalacoes) if (!registros.has(i.id)) {
    const r = resolverRastreador(i, rastreadores, historico);
    if (r) eventos.push({ ...evento(r, { origem: 'instalacoes', ts: Number(i.ts) || ts }),
      ...dadosInstalacao(i), id: 'RV-INST-' + i.id, tipo: 'instalacao', recuperado: true });
  }
  return eventos;
}

module.exports = { placaVinculada, resolverRastreador, eventosDeRastreadores, eventosDeInstalacoes, recuperarLegado };
