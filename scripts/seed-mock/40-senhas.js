// Módulo do seed: cofre de senhas (aba Senhas) com credenciais FICTÍCIAS.
//
// Os segredos são cifrados como o servidor faz (AES-256-GCM, chaveCofre() em backend/server.js):
// chave = SHA-256 da env COFRE_CHAVE ou, sem ela, da frase fixa do modo local. Por isso abrem
// em qualquer máquina que rode o demo sem login. Com COFRE_CHAVE no terminal, o seed usa a mesma.
// ⚠️ Mudou chaveCofre()/criptografarSegredo() no servidor? Muda aqui.
//
// USO: node scripts/seed-mock.js --apply   → data/senhas.json com 7 credenciais de exemplo
const crypto = require('crypto');

const FRASE_LOCAL = 'gestao-frota-demo-local-desenvolvimento';

// USO: cifrar('senha-demo-123') → { v: 1, iv, tag, dados } (base64), igual ao criptografarSegredo do servidor
function cifrar(valor) {
  const chave = crypto.createHash('sha256').update(process.env.COFRE_CHAVE || FRASE_LOCAL).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', chave, iv);
  const dados = Buffer.concat([cipher.update(String(valor), 'utf8'), cipher.final()]);
  return { v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), dados: dados.toString('base64') };
}

// USO: await montar(ctx) → { 'senhas.json': { senhas: [...], categorias: ['Portais do governo', ...] } }
exports.montar = async (ctx) => {
  const { id, ts, mes, dia } = ctx;
  const credencial = (servico, categoria, usuario, url, senha, observacoes, quando) => ({
    id: id('SE-'), ts: ts(quando), servico, categoria, usuario, url, observacoes,
    segredo: cifrar(senha), atualizadoEm: ts(quando), atualizadoPor: 'Gestor Demonstração',
  });
  const senhas = [
    credencial('Portal do fornecedor Delta Energia (demo)', 'Fornecedor', 'compras@nte.example.com', 'https://fornecedores.example.com', 'Demo#Forn2026', 'Acesso para envio de medições e notas.', mes(-5)),
    credencial('E-mail financeiro', 'E-mail', 'financeiro@nte.example.com', 'https://mail.example.com', 'Demo#Mail2026', 'Caixa compartilhada do financeiro.', mes(-4)),
    credencial('Internet banking (demo)', 'Banco', 'empresa.demo', 'https://banco.example.com', 'Demo#Banco2026', 'Token físico fica com o financeiro.', mes(-3)),
    credencial('Plataforma de rastreamento', 'Software', 'frota@nte.example.com', 'https://rastreio.example.com', 'Demo#Rast2026', 'Usuário de consulta da frota.', mes(-2)),
    credencial('Prefeitura - emissão de NFS-e (demo)', 'Portais do governo', '00.000.000/0001-00', 'https://nfse.example.com', 'Demo#Nfse2026', 'Certificado digital A1 instalado no computador do financeiro.', mes(-2)),
    credencial('Perfil da empresa na rede social', 'Rede social', '@norte.engenharia.demo', 'https://social.example.com', 'Demo#Social2026', '', dia(-20)),
    credencial('Wi-Fi do escritório', 'Sistemas internos', 'NTE-Escritorio', '', 'Demo#Wifi2026', 'Rede de visitantes é separada.', dia(-7)),
  ];
  return { 'senhas.json': { senhas, categorias: ['Portais do governo', 'Sistemas internos'] } };
};
