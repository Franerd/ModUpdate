// Versoes do app: lista os lancamentos do GitHub e "promove" um deles a versao oficial,
// baixando o instalador para o FraNerdServer e conferindo o hash do latest.yml.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const https = require('https');
const crypto = require('crypto');

function pedir(url, { token, json, destino, redirecionamentos = 6 } = {}) {
  return new Promise((ok, erro) => {
    const u = new URL(url);
    const headers = { 'User-Agent': 'ModUpdate-Servidor', Accept: json ? 'application/vnd.github+json' : 'application/octet-stream' };
    // o token so vai para a API do GitHub, nunca para o servidor de arquivos para onde ela redireciona
    if (token && u.hostname === 'api.github.com') headers.Authorization = `Bearer ${token}`;
    https.get(u, { headers, timeout: 60000 }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirecionamentos > 0) {
        res.resume();
        return ok(pedir(new URL(res.headers.location, url).href, { token, json, destino, redirecionamentos: redirecionamentos - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return erro(new Error(`HTTP ${res.statusCode} em ${u.pathname}`)); }
      if (destino) {
        const w = fs.createWriteStream(destino);
        res.pipe(w); w.on('finish', () => w.close(() => ok(destino))); w.on('error', erro); res.on('error', erro);
      } else {
        const partes = []; res.on('data', c => partes.push(c)); res.on('error', erro);
        res.on('end', () => { const t = Buffer.concat(partes).toString('utf8'); try { ok(json ? JSON.parse(t) : t); } catch (e) { erro(e); } });
      }
    }).on('timeout', function () { this.destroy(new Error('GitHub não respondeu')); }).on('error', erro);
  });
}

// latest.yml do electron-builder: versao, arquivo e sha512 (base64)
function lerYml(t) {
  const v = (/^version:\s*(.+)$/m.exec(t) || [])[1];
  const p = (/^path:\s*(.+)$/m.exec(t) || [])[1];
  const h = (/^sha512:\s*(.+)$/m.exec(t) || [])[1];
  if (!v || !p || !h) throw new Error('latest.yml incompleto');
  return { versao: v.trim().replace(/^['"]|['"]$/g, ''), arquivo: p.trim(), sha512: h.trim() };
}
const sha512 = arq => new Promise((ok, erro) => {
  const h = crypto.createHash('sha512');
  fs.createReadStream(arq).on('data', c => h.update(c)).on('error', erro).on('end', () => ok(h.digest('base64')));
});

module.exports = function criar({ pasta, repo, token, log }) {
  fs.mkdirSync(pasta, { recursive: true });
  const ARQ_PRODUCAO = path.join(pasta, 'producao.json');
  const lerProducao = () => { try { return JSON.parse(fs.readFileSync(ARQ_PRODUCAO, 'utf8')); } catch (_) { return { atual: null, anteriores: [] }; } };

  async function listar() {
    const rel = await pedir(`https://api.github.com/repos/${repo}/releases?per_page=15`, { token: token(), json: true });
    return rel.filter(r => !r.draft).map(r => ({
      tag: r.tag_name, versao: r.tag_name.replace(/^v/, ''), teste: r.prerelease, data: r.published_at,
      pronta: r.assets.some(a => a.name === 'latest.yml'),
    }));
  }

  async function promover(tag) {
    const r = await pedir(`https://api.github.com/repos/${repo}/releases/tags/${encodeURIComponent(tag)}`, { token: token(), json: true });
    const asset = nome => r.assets.find(a => a.name === nome);
    const yml = asset('latest.yml'); if (!yml) throw new Error(`O lançamento ${tag} não tem latest.yml`);
    const textoYml = await pedir(yml.url, { token: token() });
    const info = lerYml(textoYml);
    const dir = path.join(pasta, info.versao), tmp = dir + '.baixando';
    await fsp.rm(tmp, { recursive: true, force: true }); await fsp.mkdir(tmp, { recursive: true });
    for (const nome of [info.arquivo, info.arquivo + '.blockmap']) {
      const a = asset(nome); if (!a) { if (nome.endsWith('.blockmap')) continue; throw new Error(`Falta ${nome} no lançamento`); }
      log(`Baixando ${nome} (${Math.round(a.size / 1048576)} MB) do GitHub…`);
      await pedir(a.url, { token: token(), destino: path.join(tmp, nome) });
    }
    if (await sha512(path.join(tmp, info.arquivo)) !== info.sha512) throw new Error('Hash do instalador não confere com o latest.yml: promoção cancelada');
    await fsp.writeFile(path.join(tmp, 'latest.yml'), textoYml);
    await fsp.rm(dir, { recursive: true, force: true }); await fsp.rename(tmp, dir);
    const p = lerProducao();
    if (p.atual && p.atual !== info.versao) p.anteriores = [p.atual, ...p.anteriores.filter(v => v !== p.atual && v !== info.versao)].slice(0, 2);
    p.atual = info.versao; p.promovidaEm = new Date().toISOString();
    await fsp.writeFile(ARQ_PRODUCAO, JSON.stringify(p, null, 2));
    // guarda so a atual e as 2 anteriores
    for (const d of await fsp.readdir(pasta)) {
      if (/^\d+\.\d+\.\d+/.test(d) && ![p.atual, ...p.anteriores].includes(d)) await fsp.rm(path.join(pasta, d), { recursive: true, force: true });
    }
    log(`Versão ${info.versao} promovida para produção`);
    return p;
  }

  async function voltar() {
    const p = lerProducao();
    if (!p.anteriores.length) throw new Error('Não há versão anterior guardada');
    const [ant, ...resto] = p.anteriores;
    p.anteriores = [p.atual, ...resto].slice(0, 2); p.atual = ant; p.promovidaEm = new Date().toISOString();
    await fsp.writeFile(ARQ_PRODUCAO, JSON.stringify(p, null, 2));
    log(`Produção voltou para a versão ${ant}`);
    return p;
  }

  // arquivo servido aos apps: so os da versao em producao
  function arquivo(nome) {
    const p = lerProducao(); if (!p.atual) return null;
    const dir = path.join(pasta, p.atual), alvo = path.join(dir, path.basename(nome));
    return fs.existsSync(alvo) ? alvo : null;
  }
  function instalador() {
    const p = lerProducao(); if (!p.atual) return null;
    try { return lerYml(fs.readFileSync(path.join(pasta, p.atual, 'latest.yml'), 'utf8')).arquivo; } catch (_) { return null; }
  }

  return { listar, promover, voltar, arquivo, instalador, producao: lerProducao };
};
