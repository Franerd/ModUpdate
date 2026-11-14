// ModUpdate Servidor — versao oficial do ModUpdate no FraNerdServer.
// Entrega o instalador e o latest.yml da versao que voce promoveu; Promover e Voltar pedem a chave de administrador.
// Ouve so em 127.0.0.1 e ::1 (o acesso de fora e pelo tunel da Cloudflare). Nao guarda segredo nenhum:
// o repositorio e publico e da chave de administrador fica so o hash.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const VERSAO = '1.0.0';
const BASE = process.env.MODUPDATE_BASE || 'C:\\ProgramData\\ModUpdateServidor';
const PORTA = +process.env.MODUPDATE_PORTA || 8791;
const REPO = process.env.MODUPDATE_REPO || 'Franerd/ModUpdate';
const PASTAS = { dados: path.join(BASE, 'dados'), versoes: path.join(BASE, 'versoes'), logs: path.join(BASE, 'logs') };
Object.values(PASTAS).forEach(p => fs.mkdirSync(p, { recursive: true }));

const hoje = () => new Date().toISOString().slice(0, 10);
function log(msg) {
  const linha = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(path.join(PASTAS.logs, `modupdate-${hoje()}.log`), linha); } catch (_) {}
  if (process.stdout.isTTY) process.stdout.write(linha);
}
function limparLogs() {
  const limite = Date.now() - 30 * 864e5;
  for (const f of fs.readdirSync(PASTAS.logs)) { const p = path.join(PASTAS.logs, f); try { if (fs.statSync(p).mtimeMs < limite) fs.unlinkSync(p); } catch (_) {} }
}
const versoes = require('./versoes')({ pasta: PASTAS.versoes, repo: REPO, token: () => null, log });
const lerJSON = (f, padrao = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch (_) { return padrao; } };
const gravarJSON = (f, d) => { fs.writeFileSync(f + '.tmp', JSON.stringify(d, null, 2) + '\n'); fs.renameSync(f + '.tmp', f); };
const ARQ_ADMIN = path.join(PASTAS.dados, 'admin.json');

// ---------- chave de administrador (guardada so o hash) ----------
const hashChave = c => crypto.createHash('sha256').update(String(c)).digest('hex');
function chaveValida(c) {
  const h = hashChave(c || '');
  return lerJSON(ARQ_ADMIN, { chaves: [] }).chaves.find(k => crypto.timingSafeEqual(Buffer.from(k.hash), Buffer.from(h))) || null;
}
function novaChave(nome) {
  const chave = 'mua_' + crypto.randomBytes(24).toString('base64url');
  const adm = lerJSON(ARQ_ADMIN, { chaves: [] });
  adm.chaves.push({ nome, hash: hashChave(chave), criadaEm: new Date().toISOString() });
  gravarJSON(ARQ_ADMIN, adm);
  return chave;
}
// 5 erros seguidos por IP = bloqueio de 15 minutos
const tentativas = new Map();
const bloqueado = ip => { const t = tentativas.get(ip); return t && t.n >= 5 && Date.now() - t.ultimo < 15 * 60000; };
const errou = ip => { const t = tentativas.get(ip) || { n: 0 }; t.n = Date.now() - (t.ultimo || 0) > 15 * 60000 ? 1 : t.n + 1; t.ultimo = Date.now(); tentativas.set(ip, t); };

// ---------- HTTP ----------
const enviarJSON = (res, status, dados) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(dados)); };
const enviarArquivo = (res, arq, tipo, cache = 'no-store') => {
  if (!arq || !fs.existsSync(arq)) return enviarJSON(res, 404, { erro: 'não encontrado' });
  res.writeHead(200, { 'Content-Type': tipo, 'Content-Length': fs.statSync(arq).size, 'Cache-Control': cache });
  fs.createReadStream(arq).pipe(res);
};
const lerCorpo = req => new Promise((ok, erro) => {
  let t = ''; req.setEncoding('utf8');
  req.on('data', c => { t += c; if (t.length > 1e5) { req.destroy(); erro(new Error('corpo grande demais')); } });
  req.on('end', () => { try { ok(t ? JSON.parse(t) : {}); } catch (_) { erro(Object.assign(new Error('JSON inválido'), { status: 400 })); } });
});

async function rotear(req, res) {
  const p = new URL(req.url, 'http://x').pathname, m = req.method;
  const ip = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
  let mm;
  if (m === 'GET' && p === '/v1/saude') { const prod = versoes.producao(); return enviarJSON(res, 200, { ok: true, servidor: VERSAO, app: prod.atual, appAnteriores: prod.anteriores, hora: new Date().toISOString() }); }
  if (m === 'GET' && p === '/v1/app/latest.yml') return enviarArquivo(res, versoes.arquivo('latest.yml'), 'text/yaml; charset=utf-8');
  if (m === 'GET' && p === '/v1/app/baixar') {
    const inst = versoes.instalador(); if (!inst) return enviarJSON(res, 404, { erro: 'nenhuma versão oficial ainda' });
    res.writeHead(302, { Location: '/v1/app/' + encodeURIComponent(inst), 'Cache-Control': 'no-store' }); return res.end();
  }
  if (m === 'GET' && (mm = /^\/v1\/app\/([^/]+\.(exe|blockmap))$/.exec(p))) return enviarArquivo(res, versoes.arquivo(decodeURIComponent(mm[1])), 'application/octet-stream', 'public, max-age=3600');

  if (p.startsWith('/v1/admin/')) {
    if (bloqueado(ip)) return enviarJSON(res, 429, { erro: 'Muitas tentativas com chave errada. Tente de novo em 15 minutos.' });
    const quem = chaveValida((req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
    if (!quem) { errou(ip); log(`Chave de admin recusada (${ip})`); return enviarJSON(res, 401, { erro: 'Chave de administrador inválida' }); }
    tentativas.delete(ip);
    const corpo = m === 'POST' ? await lerCorpo(req) : {};
    if (m === 'GET' && p === '/v1/admin/eu') return enviarJSON(res, 200, { nome: quem.nome });
    if (m === 'GET' && p === '/v1/admin/versoes') return enviarJSON(res, 200, { producao: versoes.producao(), lancamentos: await versoes.listar() });
    if (m === 'POST' && p === '/v1/admin/promover') { log(`Promoção de ${corpo.tag} pedida por ${quem.nome}`); return enviarJSON(res, 200, await versoes.promover(String(corpo.tag || ''))); }
    if (m === 'POST' && p === '/v1/admin/voltar') return enviarJSON(res, 200, await versoes.voltar());
  }
  enviarJSON(res, 404, { erro: 'não encontrado' });
}

// node servidor.js --nova-chave "<nome>"  -> cria chave de admin e mostra uma vez
const args = process.argv.slice(2);
if (args[0] === '--nova-chave') { console.log(novaChave(args[1] || 'admin')); process.exit(0); }
else {
  const tratar = (req, res) => rotear(req, res).catch(e => {
    if (!e.status) log(`Erro em ${req.method} ${req.url}: ${e.message}`);
    if (!res.headersSent) enviarJSON(res, e.status || 500, { erro: e.message }); else res.destroy();
  });
  for (const host of ['127.0.0.1', '::1']) {   // "localhost" pode resolver para IPv4 ou IPv6
    const s = http.createServer(tratar);
    s.on('error', e => { log(`Não foi possível ouvir em ${host}:${PORTA} (${e.code})`); if (host === '127.0.0.1') process.exit(1); });
    s.listen(PORTA, host, () => log(`ModUpdate Servidor ${VERSAO} ouvindo em ${host}:${PORTA}`));
  }
  limparLogs(); setInterval(limparLogs, 864e5);
}
