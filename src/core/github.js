// Consultas ao GitHub. Erro de consulta (limite, rede) nunca vira "mod desatualizado":
// quem chama recebe um erro com .tipo e decide mostrar "indisponível".
const fs = require('fs');
const MAX_DOWNLOAD = 1024 * 1024 * 1024;
let token = null, agente = 'ModUpdate';
let limite = { restante: null, total: null, renovaEm: null };

function configurar({ versao, tokenGithub } = {}) {
  if (versao) agente = `ModUpdate/${versao}`;
  if (tokenGithub !== undefined) token = tokenGithub || null;
}

async function pedir(url, { json = true, timeout = 20000 } = {}) {
  const api = new URL(url).hostname === 'api.github.com';
  const headers = { 'User-Agent': agente, Accept: json ? 'application/vnd.github+json' : 'application/octet-stream' };
  if (token && api) headers.Authorization = `Bearer ${token}`;   // o token so vai para a API
  let res;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(timeout), redirect: 'follow' }); }
  catch (e) { throw Object.assign(new Error('Sem resposta do GitHub: ' + (e.cause && e.cause.code || e.message)), { tipo: 'rede' }); }
  if (api && res.headers.get('x-ratelimit-remaining') !== null) {
    limite = { restante: +res.headers.get('x-ratelimit-remaining'), total: +res.headers.get('x-ratelimit-limit'), renovaEm: +res.headers.get('x-ratelimit-reset') * 1000 };
  }
  if (res.status === 404) throw Object.assign(new Error('Não encontrado no GitHub'), { tipo: 'nao_encontrado' });
  if (res.status === 401) throw Object.assign(new Error('O GitHub recusou o token'), { tipo: 'token' });
  if (res.status === 403 || res.status === 429) {
    const quando = limite.renovaEm ? ` (libera às ${new Date(limite.renovaEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })})` : '';
    throw Object.assign(new Error('Limite de consultas do GitHub atingido' + quando), { tipo: 'limite' });
  }
  if (!res.ok) throw Object.assign(new Error(`GitHub respondeu ${res.status}`), { tipo: 'http' });
  return res;
}

const slugDe = url => String(url).replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\.git$/, '').replace(/\/+$/, '');

async function repositorio(slug) { return (await pedir(`https://api.github.com/repos/${slug}`)).json(); }
// null = repositorio existe mas nao tem lancamento
async function ultimaRelease(slug) {
  try { return await (await pedir(`https://api.github.com/repos/${slug}/releases/latest`)).json(); }
  catch (e) { if (e.tipo === 'nao_encontrado') return null; throw e; }
}

async function releases(slug) { return (await pedir(`https://api.github.com/repos/${slug}/releases?per_page=100`)).json(); }

// Separa a lista de lancamentos em: o estavel mais novo e o pre-lancamento (beta) mais novo.
// O pre-lancamento so conta se saiu depois do estavel (senao ja foi superado).
function separar(lista) {
  const validos = (lista || []).filter(r => !r.draft).sort((x, y) => new Date(y.published_at || y.created_at) - new Date(x.published_at || x.created_at));
  const estavel = validos.find(r => !r.prerelease) || null;
  let pre = validos.find(r => r.prerelease) || null;
  if (pre && estavel && validos.indexOf(pre) > validos.indexOf(estavel)) pre = null;
  return { estavel, pre };
}

// Escolhe o ZIP do mod entre os arquivos do lancamento. Nunca usa o ZIP do codigo-fonte.
function escolherAsset(release, mod) {
  const zips = (release.assets || []).filter(a => (a.name || '').toLowerCase().endsWith('.zip'));
  if (!zips.length) return { asset: null, motivo: 'sem_asset_zip' };
  const base = mod.replace(/\.zip$/i, '').toLowerCase();
  const exatos = zips.filter(a => a.name.replace(/\.zip$/i, '').toLowerCase() === base);
  const parecidos = zips.filter(a => a.name.toLowerCase().includes(base));
  if (exatos.length === 1) return { asset: exatos[0], motivo: 'nome_exato' };
  if (parecidos.length === 1) return { asset: parecidos[0], motivo: 'nome_compativel' };
  if (zips.length === 1) return { asset: zips[0], motivo: 'unico_zip_validar_nome' };
  return { asset: null, motivo: 'multiplos_assets_ambiguos' };
}

// Baixa direto para um arquivo (nao guarda na memoria). andamento(pct) e chamado a cada 1%.
async function baixar(url, destino, andamento = () => {}) {
  const res = await pedir(url, { json: false, timeout: 30 * 60000 });
  const total = +res.headers.get('content-length') || 0;
  if (total > MAX_DOWNLOAD) throw new Error('Download grande demais (mais de 1 GB)');
  const saida = fs.createWriteStream(destino);
  let lido = 0, ultimo = -1;
  try {
    for await (const c of res.body) {
      lido += c.length;
      if (lido > MAX_DOWNLOAD) throw new Error('Download ultrapassou o limite de 1 GB');
      if (!saida.write(c)) await new Promise(ok => saida.once('drain', ok));
      const pct = total ? Math.floor(lido / total * 100) : -1;
      if (pct !== ultimo) { ultimo = pct; andamento(pct, lido); }
    }
  } catch (e) { saida.destroy(); fs.rmSync(destino, { force: true }); throw e.tipo ? e : new Error('O download foi interrompido: ' + e.message); }
  await new Promise((ok, erro) => saida.end(e => e ? erro(e) : ok()));
  return destino;
}

// "v1.3.0.7", "FS25_1.2.0.0", "release-8.0.0.1" -> [1,3,0,7]; null se nao der para ler
function numeros(v) {
  const m = String(v || '').match(/\d+(?:\.\d+)+/g);
  return m ? m[m.length - 1].split('.').map(Number) : null;
}
// -1 local mais antiga, 0 igual, 1 local mais nova, null = nao da para comparar
function comparar(local, remota) {
  const a = numeros(local), b = numeros(remota);
  if (!a || !b) return null;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

module.exports = { configurar, slugDe, repositorio, ultimaRelease, releases, separar, escolherAsset, baixar, comparar, numeros, limite: () => limite, temToken: () => !!token };
