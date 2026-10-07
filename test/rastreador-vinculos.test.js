// USO: node --test test/rastreador-vinculos.test.js — identidade, datas e recuperação sem inventar vínculos.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { placaVinculada, resolverRastreador, eventosDeRastreadores, eventosDeInstalacoes, recuperarLegado } = require('../backend/rastreador-vinculos');
const r = { id: 'R1', codigo: 'C1', esn: 'ESN1', placa: 'ABC1D23', situacao: 'Ativo' };

test('vínculos: correção de código preserva identidade e permite reconhecer o código antigo', () => {
  const novo = { ...r, codigo: 'C2' };
  const eventos = eventosDeRastreadores([r], [novo]);
  assert.equal(eventos[0].tipo, 'identificacao');
  assert.equal(resolverRastreador({ numeroSerie: 'C1' }, [novo], eventos).id, r.id);
  assert.equal(resolverRastreador({ numeroSerie: 'ESN1' }, [novo], eventos).id, r.id);
  assert.equal(resolverRastreador({ numeroSerie: 'C1' }, [novo, { id: 'R2', codigo: 'C1' }], eventos), null);
  assert.equal(resolverRastreador({ numeroSerie: 'C1', rastreadorId: 'R1' }, [novo, { id: 'R2', codigo: 'C1' }], eventos).id, 'R1');
});

test('vínculos: correspondência ambígua entre código e ESN nunca é decidida pela placa', () => {
  assert.equal(resolverRastreador({ numeroSerie: 'C1', placa: r.placa }, [r, { id: 'R2', esn: 'C1' }]), null);
  assert.equal(resolverRastreador({ numeroSerie: '', placa: r.placa }, [r]), null);
  assert.equal(resolverRastreador({ numeroSerie: 'C1', rastreadorId: 'id-excluido' }, [r]), null);
});

for (const origem of ['manual', 'planilha', 'cobli', 'desfazer']) {
  test(`vínculos: ${origem} registra transferência/remoção e não inventa data de instalação`, () => {
    const outro = { ...r, placa: 'XYZ4E56' };
    const [ev] = eventosDeRastreadores([r], [outro], { origem, por: 'Operador', ts: 1234 });
    assert.equal(ev.tipo, 'transferencia');
    assert.equal(ev.placaAnterior, r.placa);
    assert.equal(ev.placa, outro.placa);
    assert.equal(ev.dataInstalacao, '');
    assert.equal(ev.origem, origem);
    assert.equal(ev.ts, 1234);
    assert.deepEqual(eventosDeRastreadores([outro], [{ ...outro }]), []);
    assert.equal(eventosDeRastreadores([r], [{ ...r, situacao: 'Removido' }])[0].tipo, 'remocao');
    assert.equal(placaVinculada({ ...r, desativado: true }), '');
    const removido = { ...r, situacao: 'Removido' };
    const [referencia] = eventosDeRastreadores([removido], [{ ...removido, placa: outro.placa }], { origem });
    assert.equal(referencia.tipo, 'referencia', 'mudança de placa em aparelho retirado também é registrada, sem afirmar reinstalação');
    assert.equal(referencia.placa, outro.placa);
  });
}

test('vínculos: recuperação é idempotente, aceita ESN e preserva data real e foto', () => {
  const i = { id: 'I1', numeroSerie: 'ESN1', placa: r.placa, data: '10/09/2026', ts: 1234, fotos: [{ id: 'F1', nome: 'foto.jpg', tipo: 'image/jpeg' }] };
  const eventos = recuperarLegado([r], [i], [], 5678);
  assert.equal(eventos.length, 2);
  assert.equal(eventos[0].dataInstalacao, '');
  assert.equal(eventos[1].rastreadorId, r.id);
  assert.equal(eventos[1].dataInstalacao, '10/09/2026');
  assert.equal(eventos[1].ts, 1234);
  assert.deepEqual(eventos[1].fotos, i.fotos);
  assert.deepEqual(recuperarLegado([r], [i], eventos), []);
});

test('vínculos: corrigir a instalação para outro aparelho registra os dois lados', () => {
  const r2 = { id: 'R2', codigo: 'C2' };
  const antes = { id: 'I1', numeroSerie: 'C1', rastreadorId: r.id, placa: r.placa };
  const depois = { ...antes, numeroSerie: 'C2', rastreadorId: r2.id };
  const eventos = eventosDeInstalacoes([antes], [depois], [r, r2], []);
  assert.deepEqual(eventos.map(e => [e.rastreadorId, e.tipo]), [['R1', 'associacaoCorrigida'], ['R2', 'instalacao']]);
  assert.equal(eventosDeInstalacoes([depois], [], [r, r2], [])[0].tipo, 'instalacaoExcluida');
});
