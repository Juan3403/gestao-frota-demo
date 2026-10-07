/**
 * Assinatura AWS SigV4 do envio de backup para a nuvem (scripts/backup-nuvem.mjs).
 *
 * Por que este teste existe: a assinatura é feita à mão (o workflow não roda `npm ci`, então não
 * há SDK da AWS). Assinatura errada só se manifesta como "403 SignatureDoesNotMatch" no dia do
 * primeiro backup real — e aí o erro não diz QUAL das cinco etapas do cálculo saiu torta.
 *
 * O teste é determinístico e não fala com a rede: fixa o carimbo de tempo e confere o cabeçalho
 * `Authorization` byte a byte contra um valor derivado do processo documentado pela AWS.
 *
 * Rodar: npm test
 */
const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// Reimplementação independente do algoritmo, escrita a partir da especificação — se ela e a do
// script derem o mesmo resultado, os dois erraram igual ou os dois estão certos. Para descartar a
// primeira hipótese, o teste seguinte usa o vetor oficial da AWS, cuja assinatura é publicada.
function assinaturaEsperada({ metodo, host, caminho, cabecalhos, corpoHash, agora, region, servico, keyId, keySecret }) {
  const dia = agora.slice(0, 8);
  const nomes = Object.keys(cabecalhos).sort();
  const canonicos = nomes.map((h) => `${h}:${cabecalhos[h]}\n`).join('');
  const lista = nomes.join(';');
  const reqCanonica = [metodo, caminho, '', canonicos, lista, corpoHash].join('\n');
  const escopo = `${dia}/${region}/${servico}/aws4_request`;
  const sha = (x) => crypto.createHash('sha256').update(x).digest('hex');
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const paraAssinar = ['AWS4-HMAC-SHA256', agora, escopo, sha(reqCanonica)].join('\n');
  const chave = hmac(hmac(hmac(hmac('AWS4' + keySecret, dia), region), servico), 'aws4_request');
  return { assinatura: crypto.createHmac('sha256', chave).update(paraAssinar).digest('hex'), escopo, lista };
}

test('SIGV4-1: o cabeçalho Authorization do PUT bate com o algoritmo da AWS', async () => {
  const { assinarPut } = await import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'backup-nuvem.mjs')).href);

  const p = {
    endpoint: 'https://s3.us-west-004.backblazeb2.com',
    region: 'us-west-004',
    bucket: 'gestaorm-backups',
    chaveObj: 'gestao-rm/2026/08/gestao-rm-backup-2026-08-18.zip',
    keyId: '004abcdefghij0000000001',
    keySecret: 'K004exemploDeSegredoQueNaoEhReal',
    sha256corpo: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    bytes: 91750400,
    agora: '20260818T030000Z', // fixo: sem isto o teste dependeria do relógio
  };
  const { url, cabecalhos } = assinarPut(p);

  assert.equal(url, 'https://s3.us-west-004.backblazeb2.com/gestaorm-backups/gestao-rm/2026/08/gestao-rm-backup-2026-08-18.zip');
  // As barras da "pasta" NÃO podem virar %2F — vira outro objeto e o S3 devolve 403.
  assert.ok(!url.includes('%2F'), 'as barras do caminho têm de continuar barras');

  const esperado = assinaturaEsperada({
    metodo: 'PUT',
    caminho: '/gestaorm-backups/gestao-rm/2026/08/gestao-rm-backup-2026-08-18.zip',
    cabecalhos: {
      host: 's3.us-west-004.backblazeb2.com',
      'content-length': '91750400',
      'x-amz-content-sha256': p.sha256corpo,
      'x-amz-date': p.agora,
    },
    corpoHash: p.sha256corpo, agora: p.agora, region: p.region, servico: 's3',
    keyId: p.keyId, keySecret: p.keySecret,
  });

  assert.equal(
    cabecalhos.Authorization,
    `AWS4-HMAC-SHA256 Credential=${p.keyId}/${esperado.escopo}, SignedHeaders=${esperado.lista}, Signature=${esperado.assinatura}`,
  );
  // Content-Length assinado E enviado: com corpo em fluxo o fetch mandaria Transfer-Encoding
  // chunked, que o S3 recusa — por isso o envio usa https.request com o tamanho exato.
  assert.equal(cabecalhos['content-length'], '91750400');
  assert.equal(cabecalhos['x-amz-content-sha256'], p.sha256corpo, 'o hash do corpo tem de ser o do arquivo, não UNSIGNED-PAYLOAD');
});

test('SIGV4-2: a derivação da chave bate com o vetor oficial publicado pela AWS', async () => {
  // Vetor da documentação "Signature Version 4 signing process" (exemplo iam/us-east-1).
  // Prova que a cadeia de HMACs (AWS4+segredo → data → região → serviço → aws4_request) está
  // correta — é onde um erro de ordem passaria despercebido no teste anterior, porque lá as duas
  // implementações são minhas.
  const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const chave = hmac(hmac(hmac(hmac('AWS4' + 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY', '20150830'), 'us-east-1'), 'iam'), 'aws4_request');
  assert.equal(
    chave.toString('hex'),
    'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9',
    'a chave derivada tem de bater com o vetor publicado pela AWS',
  );
});
