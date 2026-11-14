// Leitura dos mods instalados (so leitura) e montagem do catalogo mod -> repositorio do GitHub.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const zip = require('./zip');

const RE_BR = /(^|\/)(l10n|translation)[_-]br\.xml$/i;
const RE_GITHUB = /(?:https?:\/\/)?(?:www\.)?(?:github\.com\/([\w.-]+)\/([\w.-]+)|raw\.githubusercontent\.com\/([\w.-]+)\/([\w.-]+)|api\.github\.com\/repos\/([\w.-]+)\/([\w.-]+))/gi;
const DONOS_FALSOS = new Set(['topics', 'search', 'features', 'marketplace', 'settings', 'orgs', 'login', 'signup', 'sponsors', 'about']);
const REPOS_FALSOS = new Set(['issues', 'pull', 'pulls', 'releases', 'archive', 'blob', 'tree', 'wiki', 'actions', 'projects', 'discussions', 'compare', 'commit', 'commits']);
const EXT_TEXTO = new Set(['.xml', '.lua', '.md', '.txt', '.json', '.yml', '.yaml', '.html', '.htm', '.cfg', '.ini', '.properties', '.toml', '.js']);

// ---------- trava estrutural: o app so grava dentro da pasta de trabalho ----------
function dentro(pai, filho) {
  const r = path.relative(path.resolve(pai), path.resolve(filho));
  return r === '' || (!r.startsWith('..') && !path.isAbsolute(r));
}
function conferirTrava(pastaMods, pastaTrabalho) {
  if (!pastaTrabalho) throw new Error('Pasta de trabalho não definida');
  if (dentro(pastaMods, pastaTrabalho)) throw new Error('A pasta de trabalho não pode ficar dentro da pasta de mods');
}
// caminho de gravacao: recusa qualquer coisa fora da pasta de trabalho
function destino(pastaTrabalho, ...partes) {
  const alvo = path.join(pastaTrabalho, ...partes);
  if (!dentro(pastaTrabalho, alvo)) throw new Error('Gravação fora da pasta de trabalho recusada: ' + alvo);
  return alvo;
}

const carimbo = (d = new Date()) => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
};
const texto = b => b.toString('utf8').replace(/^﻿/, '');
const versaoDoModDesc = t => ((/<version>\s*([^<]+)/i.exec(t) || [])[1] || '').trim();

// versao e traducoes PT-BR de um mod instalado (le so o modDesc.xml)
async function infoLocal(pastaMods, mod) {
  const arq = path.join(pastaMods, mod);
  if (!fs.existsSync(arq) || !fs.statSync(arq).isFile()) return { existe: false, versao: '', br: [] };
  let z;
  try {
    z = await zip.abrir(arq);
    const desc = z.entradas.find(e => e.nome.toLowerCase() === 'moddesc.xml');
    return {
      existe: true,
      versao: desc ? versaoDoModDesc(texto(await z.ler(desc.nome))) : '',
      br: z.entradas.map(e => e.nome.replace(/\\/g, '/')).filter(n => RE_BR.test(n)),
    };
  } catch (e) { return { existe: true, versao: '', br: [], erro: e.message }; }
  finally { if (z) z.fechar(); }
}

function extrairLinks(t) {
  const achados = new Set();
  for (const m of t.matchAll(RE_GITHUB)) {
    const dono = m[1] || m[3] || m[5];
    const repo = (m[2] || m[4] || m[6]).replace(/[.,;:)\]}]+$/, '').replace(/\.git$/, '');
    if (!dono || !repo || DONOS_FALSOS.has(dono.toLowerCase()) || REPOS_FALSOS.has(repo.toLowerCase())) continue;
    achados.add(`https://github.com/${dono}/${repo}`);
  }
  return achados;
}

// Procura links do GitHub dentro de cada mod .zip da pasta. So le; nao altera nada.
// Devolve [{ mod, repo, evidencia: 'modDesc.xml' | 'documentação' | 'código', confiavel }]
async function procurarLinks(pastaMods, progresso = () => {}) {
  const zips = (await fsp.readdir(pastaMods, { withFileTypes: true })).filter(d => d.isFile() && /\.zip$/i.test(d.name)).map(d => d.name)
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const achados = [], erros = [];
  for (let i = 0; i < zips.length; i++) {
    const mod = zips[i];
    progresso({ atual: i + 1, total: zips.length, nome: mod });
    let z;
    try {
      z = await zip.abrir(path.join(pastaMods, mod));
      const refs = new Map();
      for (const e of z.entradas) {
        if (!EXT_TEXTO.has(path.extname(e.nome).toLowerCase()) || e.tamanho > 1024 * 1024) continue;
        let t; try { t = texto(await z.ler(e.nome)); } catch (_) { continue; }
        for (const url of extrairLinks(t)) { if (!refs.has(url)) refs.set(url, []); refs.get(url).push(e.nome.replace(/\\/g, '/')); }
      }
      for (const [repo, arquivos] of refs) {
        const base = a => path.posix.basename(a).toLowerCase();
        const noModDesc = arquivos.some(a => base(a) === 'moddesc.xml');
        const naDoc = arquivos.some(a => /^(readme|changelog|license)/.test(base(a)));
        achados.push({
          mod, repo, evidencia: noModDesc ? 'modDesc.xml' : naDoc ? 'documentação' : 'código',
          // link no modDesc.xml apontando para um repositorio FS25_*: e o proprio mod
          confiavel: noModDesc && /^fs25[_-]/i.test(repo.split('/').pop()),
        });
      }
    } catch (e) { erros.push({ mod, erro: e.message }); }
    finally { if (z) z.fechar(); }
  }
  return { achados, erros, zips: zips.length };
}

// CSV do catalogo antigo: Mod;Repositorio_GitHub;Evidencia;Observacao
function importarCSV(conteudo) {
  const linhas = conteudo.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim());
  const campos = l => (l.match(/("([^"]|"")*"|[^;]*)(;|$)/g) || []).map(c => c.replace(/;$/, '').replace(/^"|"$/g, '').replace(/""/g, '"'));
  const cab = campos(linhas.shift() || '').map(c => c.trim().toLowerCase());
  const iMod = cab.indexOf('mod'), iRepo = cab.findIndex(c => c.startsWith('repositorio') || c === 'github'), iEv = cab.findIndex(c => c.startsWith('evidencia') || c === 'classificacao');
  if (iMod < 0 || iRepo < 0) throw new Error('CSV sem as colunas Mod e Repositorio_GitHub');
  return linhas.map(campos).filter(c => c[iMod] && /github\.com\//i.test(c[iRepo] || ''))
    .map(c => ({ mod: c[iMod].trim(), repo: c[iRepo].trim(), evidencia: (iEv >= 0 && c[iEv]) || 'importado' }));
}

module.exports = { RE_BR, dentro, conferirTrava, destino, carimbo, texto, versaoDoModDesc, infoLocal, procurarLinks, extrairLinks, importarCSV };
