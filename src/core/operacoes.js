// As tres operacoes do ModUpdate: auditoria, backup das traducoes PT-BR e simulacao de atualizacao.
// Nenhuma delas grava na pasta de mods: toda escrita passa por mods.destino().
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const zip = require('./zip');
const github = require('./github');
const mods = require('./mods');
const { diff3Merge } = require('node-diff3');

const sha256 = dados => crypto.createHash('sha256').update(dados).digest('hex');
const sha256Arquivo = arq => new Promise((ok, erro) => {
  const h = crypto.createHash('sha256');
  fs.createReadStream(arq).on('data', c => h.update(c)).on('error', erro).on('end', () => ok(h.digest('hex')));
});
const gravarJSON = (arq, d) => fsp.writeFile(arq, JSON.stringify(d, null, 2), 'utf8');

// ---------- auditoria ----------
// status: ausente | indisponivel | repo_nao_encontrado | sem_release | sem_zip | em_dia | atualizacao | conferir | nao_verificado
async function auditar({ pastaMods, pastaTrabalho, catalogo, online = true }, progresso = () => {}) {
  mods.conferirTrava(pastaMods, pastaTrabalho);
  const cache = new Map(), linhas = [];
  let limiteAtingido = null;
  for (let i = 0; i < catalogo.length; i++) {
    const c = catalogo[i], slug = github.slugDe(c.repo);
    progresso({ atual: i + 1, total: catalogo.length, nome: c.mod });
    const local = await mods.infoLocal(pastaMods, c.mod);
    const l = { mod: c.mod, repo: c.repo, slug, evidencia: c.evidencia || '', versaoLocal: local.versao, br: local.br, status: 'nao_verificado', erro: local.erro || '' };
    if (!local.existe) l.status = 'ausente';
    else if (online) {
      if (!cache.has(slug)) {
        let r;
        if (limiteAtingido) r = { erro: limiteAtingido, tipo: 'limite' };
        else try {
          // uma consulta por repositorio (o limite sem token e 60 por hora); a segunda so quando nao ha lancamento,
          // para separar "sem lancamento" de "repositorio nao existe mais"
          const rel = await github.ultimaRelease(slug);
          if (!rel) await github.repositorio(slug);
          r = { release: rel && { tag: rel.tag_name, url: rel.html_url, data: rel.published_at, assets: rel.assets || [] } };
        } catch (e) {
          r = { erro: e.message, tipo: e.tipo };
          if (e.tipo === 'limite') limiteAtingido = e.message;
        }
        cache.set(slug, r);
      }
      const r = cache.get(slug);
      if (r.erro) { l.status = r.tipo === 'nao_encontrado' ? 'repo_nao_encontrado' : 'indisponivel'; l.erro = r.erro; }
      else if (!r.release) l.status = 'sem_release';
      else {
        const { asset, motivo } = github.escolherAsset(r.release, c.mod);
        Object.assign(l, { tag: r.release.tag, urlRelease: r.release.url, dataRelease: r.release.data, asset: asset ? asset.name : '', assetMotivo: motivo });
        const cmp = github.comparar(local.versao, r.release.tag);
        l.status = cmp === null ? 'conferir' : cmp < 0 ? 'atualizacao' : 'em_dia';
        if (!asset && l.status !== 'em_dia') l.status = 'sem_zip';
      }
    }
    linhas.push(l);
  }
  const resultado = { feitaEm: new Date().toISOString(), online, limite: github.limite(), linhas };
  await fsp.mkdir(pastaTrabalho, { recursive: true });
  await gravarJSON(mods.destino(pastaTrabalho, 'Auditoria_ultima.json'), resultado);
  const col = ['mod', 'repo', 'status', 'versaoLocal', 'tag', 'dataRelease', 'asset', 'assetMotivo', 'erro'];
  const csv = [col.join(';'), ...linhas.map(l => col.map(k => `"${String(l[k] ?? '').replace(/"/g, '""')}"`).join(';')), ''].join('\r\n');
  const relatorio = mods.destino(pastaTrabalho, `Auditoria_${mods.carimbo()}.csv`);
  await fsp.writeFile(relatorio, '﻿' + csv, 'utf8');
  return { ...resultado, relatorio };
}

async function ultimaAuditoria(pastaTrabalho) {
  try { const j = JSON.parse(await fsp.readFile(path.join(pastaTrabalho, 'Auditoria_ultima.json'), 'utf8')); return Array.isArray(j.linhas) ? j : null; }
  catch (_) { return null; }
}

// ---------- backup das traducoes PT-BR ----------
async function backupBR({ pastaMods, pastaTrabalho, catalogo }, progresso = () => {}) {
  mods.conferirTrava(pastaMods, pastaTrabalho);
  const pasta = mods.destino(pastaTrabalho, 'Backups_PTBR', mods.carimbo());
  await fsp.mkdir(pasta, { recursive: true });
  const manifesto = [];
  for (let i = 0; i < catalogo.length; i++) {
    const mod = catalogo[i].mod, arq = path.join(pastaMods, mod);
    progresso({ atual: i + 1, total: catalogo.length, nome: mod });
    if (!fs.existsSync(arq)) continue;
    let z;
    try {
      z = await zip.abrir(arq);
      for (const e of z.entradas) {
        const n = e.nome.replace(/\\/g, '/');
        if (!mods.RE_BR.test(n)) continue;
        zip.nomeSeguro(n);
        const dados = await z.ler(e.nome), alvo = mods.destino(pasta, mod, ...n.split('/'));
        await fsp.mkdir(path.dirname(alvo), { recursive: true });
        await fsp.writeFile(alvo, dados);
        manifesto.push({ mod, arquivo: n, sha256: sha256(dados) });
      }
    } catch (_) { /* mod ilegivel: fica fora do backup e aparece na auditoria */ }
    finally { if (z) z.fechar(); }
  }
  await gravarJSON(path.join(pasta, 'manifest.json'), manifesto);
  return { pasta, arquivos: manifesto.length, mods: new Set(manifesto.map(m => m.mod)).size };
}

// ---------- simulacao de atualizacao ----------
function diferencas(antigo, novo) {
  const alterados = [], novos = [], removidos = [];
  for (const [n, d] of novo) { if (!antigo.has(n)) novos.push(n); else if (!antigo.get(n).equals(d)) alterados.push(n); }
  for (const n of antigo.keys()) if (!novo.has(n)) removidos.push(n);
  return { alterados: alterados.sort(), novos: novos.sort(), removidos: removidos.sort() };
}
const pegarModDesc = itens => { for (const [n, d] of itens) if (n.toLowerCase() === 'moddesc.xml') return mods.versaoDoModDesc(mods.texto(d)); return ''; };
const EXT_MESCLAVEL = new Set(['.xml', '.lua', '.i3d', '.txt', '.md', '.json', '.cfg', '.ini', '.yml', '.yaml', '.gui']);
const ehTexto = (n, ...bufs) => EXT_MESCLAVEL.has(path.extname(n).toLowerCase()) && bufs.every(b => !b.includes(0));
const linhas = b => b.toString('utf8').split(/(?<=\n)/);

// Junta a sua edicao com a mudanca do autor, linha a linha. null = os dois mexeram no mesmo trecho.
function mesclar(seu, base, novo) {
  const blocos = diff3Merge(linhas(seu), linhas(base), linhas(novo), { excludeFalseConflicts: true });
  if (blocos.some(b => b.conflict)) return null;
  return Buffer.from(blocos.map(b => b.ok.join('')).join(''), 'utf8');
}

// chaves de texto de um arquivo de traducao: <text name="x"> ou <e k="x">
const chaves = b => new Set([...mods.texto(b).matchAll(/<(?:text\s+name|e\s+k)\s*=\s*"([^"]+)"/g)].map(m => m[1]));
// textos que existem na traducao de referencia (en) do pacote novo e faltam na sua traducao BR
function traducoesFaltando(preparado) {
  const faltando = [];
  for (const [n, d] of preparado) {
    if (!mods.RE_BR.test(n)) continue;
    const ref = [...preparado.keys()].find(x => x.toLowerCase() === n.toLowerCase().replace(/([_-])br\.xml$/, '$1en.xml'));
    if (!ref) continue;
    const tem = chaves(d), novas = [...chaves(preparado.get(ref))].filter(k => !tem.has(k));
    if (novas.length) faltando.push({ arquivo: n, total: novas.length, chaves: novas.slice(0, 200) });
  }
  return faltando;
}

// Procura no GitHub o lancamento oficial da MESMA versao instalada: e a base para saber o que voce editou.
async function buscarBase(slug, mod, versaoLocal) {
  const lista = await github.releases(slug);
  for (const r of lista.filter(x => github.comparar(versaoLocal, x.tag_name) === 0)) {
    const { asset } = github.escolherAsset(r, mod);
    if (!asset) continue;
    const { itens } = zip.normalizarRaiz(await zip.lerTudo(await github.baixar(asset.browser_download_url), 'versão oficial instalada'));
    if (github.comparar(versaoLocal, pegarModDesc(itens)) === 0) return { itens, origem: `${r.tag_name} · ${asset.name}`, zip: null };
  }
  return null;
}

// Baixa (ou recebe) o pacote novo e monta um ZIP de previa em <pastaTrabalho>\Simulacoes preservando o que voce editou.
// Com a base oficial da versao instalada: mescla de tres vias, arquivo por arquivo.
// Sem a base: preserva so as traducoes PT-BR e lista o que mudou para revisao.
// O mod instalado e so lido; o hash dele e conferido antes e depois.
async function simular({ pastaMods, pastaTrabalho, mod, repo, pacoteLocal, baseLocal }, etapa = () => {}) {
  mods.conferirTrava(pastaMods, pastaTrabalho);
  const original = path.join(pastaMods, mod);
  if (!fs.existsSync(original)) throw new Error('Mod instalado não encontrado: ' + mod);
  const slug = github.slugDe(repo);

  etapa('Lendo o mod instalado');
  const hashAntes = await sha256Arquivo(original);
  const { itens: seu } = zip.normalizarRaiz(await zip.lerTudo(original, 'mod instalado'));
  const versaoLocal = pegarModDesc(seu);

  let release = { tag_name: 'PACOTE_LOCAL', html_url: '' }, baixado, asset, motivo;
  if (pacoteLocal) {
    baixado = await fsp.readFile(pacoteLocal);
    asset = { name: path.basename(pacoteLocal), browser_download_url: pacoteLocal }; motivo = 'pacote_local';
  } else {
    etapa('Consultando o lançamento no GitHub');
    release = await github.ultimaRelease(slug);
    if (!release) throw new Error('O repositório não tem lançamento (release) publicado');
    ({ asset, motivo } = github.escolherAsset(release, mod));
    if (!asset) throw new Error(motivo === 'sem_asset_zip' ? 'O lançamento não tem ZIP do mod (só código-fonte)' : 'O lançamento tem vários ZIPs e não dá para saber qual é o mod');
    etapa(`Baixando ${asset.name}`);
    baixado = await github.baixar(asset.browser_download_url);
  }

  etapa('Conferindo o pacote novo');
  const { itens: novo, prefixo } = zip.normalizarRaiz(await zip.lerTudo(baixado, 'pacote novo'));
  const versaoNova = pegarModDesc(novo);
  if (!versaoNova) throw new Error('O pacote novo não tem versão válida no modDesc.xml');

  // base = versao oficial que voce tem instalada (para separar as suas edicoes das do autor)
  let base = null, baseErro = '';
  etapa('Procurando a versão oficial que você tem instalada');
  try {
    if (baseLocal) base = { itens: zip.normalizarRaiz(await zip.lerTudo(await fsp.readFile(baseLocal), 'base local')).itens, origem: 'arquivo local · ' + path.basename(baseLocal) };
    else if (!pacoteLocal) base = await buscarBase(slug, mod, versaoLocal);
  } catch (e) { baseErro = e.message; }

  await fsp.mkdir(mods.destino(pastaTrabalho, 'Simulacoes'), { recursive: true });
  let pasta;   // uma pasta nova por simulacao: nunca reaproveita uma existente
  for (let t = Date.now(); ; t += 1000) {
    pasta = mods.destino(pastaTrabalho, 'Simulacoes', `${mod.replace(/\.zip$/i, '')}_${mods.carimbo(new Date(t))}`);
    try { await fsp.mkdir(pasta); break; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
  await fsp.writeFile(path.join(pasta, 'release_original.zip'), baixado);

  etapa('Aplicando as suas edições sobre a versão nova');
  const preparado = new Map(novo);
  const r = { suas: { alterados: [], adicionados: [], removidos: [] }, mantidas: [], mescladas: [], conflitos: [], brPreservadas: [], brConflitos: [] };
  const acharNovo = n => [...preparado.keys()].find(x => x.toLowerCase() === n.toLowerCase());
  const guardarSua = async (n, d) => {   // copia da sua versao, para resolver o conflito a mao
    const alvo = mods.destino(pasta, 'suas_versoes', ...n.split('/'));
    await fsp.mkdir(path.dirname(alvo), { recursive: true }); await fsp.writeFile(alvo, d);
  };
  const usarBR = (n, d) => {
    const igual = acharNovo(n);
    if (igual && !preparado.get(igual).equals(d)) r.brConflitos.push(n);
    preparado.set(igual || n, d); r.brPreservadas.push(n);
  };

  if (base) {
    for (const [n, d] of seu) {
      const b = base.itens.get(n), editado = !b || !b.equals(d);
      if (mods.RE_BR.test(n)) {
        // traducao: se o autor tambem mexeu no arquivo BR, tenta juntar (a sua + os textos novos dele); se nao der, fica a sua
        const nv = novo.get(n), junto = editado && b && nv && !nv.equals(b) && !nv.equals(d) && ehTexto(n, d, b, nv) ? mesclar(d, b, nv) : null;
        if (junto) { preparado.set(n, junto); r.mescladas.push(n); r.brPreservadas.push(n); }
        else if (editado || !acharNovo(n)) usarBR(n, d);
        if (editado) r.suas[b ? 'alterados' : 'adicionados'].push(n);
        continue;
      }
      if (!editado) continue;                                   // voce nao mexeu: fica o do pacote novo
      r.suas[b ? 'alterados' : 'adicionados'].push(n);
      const nv = novo.get(n);
      if (nv && nv.equals(d)) continue;                         // o autor chegou no mesmo resultado
      if (!b) {                                                 // arquivo que voce adicionou
        if (!nv) { preparado.set(n, d); r.mantidas.push(n); }
        else { r.conflitos.push({ arquivo: n, motivo: 'você adicionou este arquivo e a versão nova também traz um com o mesmo nome' }); await guardarSua(n, d); }
      } else if (!nv) { r.conflitos.push({ arquivo: n, motivo: 'você editou, mas o autor removeu este arquivo na versão nova' }); await guardarSua(n, d); }
      else if (nv.equals(b)) { preparado.set(n, d); r.mantidas.push(n); }       // so voce mexeu
      else {                                                    // os dois mexeram
        const junto = ehTexto(n, d, b, nv) ? mesclar(d, b, nv) : null;
        if (junto) { preparado.set(n, junto); r.mescladas.push(n); }
        else { r.conflitos.push({ arquivo: n, motivo: ehTexto(n, d, b, nv) ? 'você e o autor mexeram no mesmo trecho' : 'você e o autor mexeram neste arquivo (não é texto, não dá para juntar)' }); await guardarSua(n, d); }
      }
    }
    for (const [n, b] of base.itens) if (!seu.has(n)) {         // arquivos que voce apagou
      r.suas.removidos.push(n);
      const nv = novo.get(n);
      if (nv && nv.equals(b)) preparado.delete(n);
      else if (nv) r.conflitos.push({ arquivo: n, motivo: 'você apagou este arquivo, mas o autor o alterou na versão nova (ficou o do autor)' });
    }
  } else for (const [n, d] of seu) if (mods.RE_BR.test(n)) usarBR(n, d);

  const comparacaoRelease = diferencas(seu, novo), comparacaoPrevia = diferencas(seu, preparado);
  const sensiveis = base ? r.conflitos.map(c => c.arquivo)
    : [...comparacaoRelease.alterados, ...comparacaoRelease.removidos].filter(n => !mods.RE_BR.test(n) && ['.lua', '.xml', '.i3d', '.shapes'].includes(path.extname(n).toLowerCase()));

  etapa('Gerando o ZIP de prévia');
  const previa = path.join(pasta, `${mod.replace(/\.zip$/i, '')}_PREVIA_NAO_INSTALAR.zip`);
  await zip.gravar(previa, preparado);
  const { itens: conferido } = zip.normalizarRaiz(await zip.lerTudo(previa, 'prévia'));
  if (conferido.size !== preparado.size || [...preparado].some(([n, d]) => !conferido.has(n) || !conferido.get(n).equals(d))) throw new Error('Falha na conferência de integridade da prévia');

  const hashDepois = await sha256Arquivo(original);
  const revisar = r.conflitos.length || (!base && sensiveis.length) || motivo === 'unico_zip_validar_nome';
  const relatorio = {
    modo: 'DRY_RUN_NUNCA_INSTALA',
    status: revisar ? 'REVISAO_OBRIGATORIA' : 'PREVIA_GERADA_REVISAR',
    mod, github: slug, feitaEm: new Date().toISOString(),
    original, original_sha256_antes: hashAntes, original_sha256_depois: hashDepois, original_intacto: hashAntes === hashDepois,
    version_local: versaoLocal, release_tag: release.tag_name, release_url: release.html_url || '', version_remota_moddesc: versaoNova,
    asset: asset.name, asset_url: asset.browser_download_url, asset_selecao: motivo, prefixo_removido_do_pacote: prefixo,
    base_oficial: base ? base.origem : null, base_erro: baseErro,
    suas_edicoes: base ? r.suas : null,
    edicoes_mantidas: r.mantidas.sort(), edicoes_mescladas: r.mescladas.sort(), conflitos_de_edicao: r.conflitos,
    traducoes_brasileiras_preservadas: r.brPreservadas, traducoes_com_conflito_de_conteudo: r.brConflitos,
    traducoes_faltando: traducoesFaltando(preparado),
    preview: previa, preview_sha256: await sha256Arquivo(previa),
    comparacao_release: comparacaoRelease, comparacao_previa: comparacaoPrevia,
    arquivos_sensiveis_para_revisao: sensiveis,
    nota: base
      ? 'Suas edições foram identificadas comparando o mod instalado com a versão oficial de mesmo número. Arquivos mesclados automaticamente precisam de teste no jogo.'
      : 'Sem a versão oficial instalada para comparar: não dá para separar o que você mudou do que o autor mudou. Só as traduções PT-BR foram preservadas; revise os arquivos listados.',
  };
  await gravarJSON(path.join(pasta, 'relatorio.json'), relatorio);
  await fsp.writeFile(path.join(pasta, 'LEIA_ANTES.txt'), 'SIMULAÇÃO APENAS. NÃO INSTALE ESTE ZIP SEM REVISAR.\r\nO ZIP da pasta de mods não foi modificado.\r\nRevise o relatorio.json antes de qualquer substituição.\r\nA pasta suas_versoes (quando existe) guarda a sua versão dos arquivos em conflito.\r\n', 'utf8');
  if (!relatorio.original_intacto) throw new Error('O mod instalado mudou durante a simulação (outro programa mexeu no arquivo). Confira antes de continuar.');
  return { ...relatorio, pasta };
}

async function listarSimulacoes(pastaTrabalho) {
  const raiz = path.join(pastaTrabalho, 'Simulacoes');
  let dirs; try { dirs = await fsp.readdir(raiz, { withFileTypes: true }); } catch (_) { return []; }
  const lista = [];
  for (const d of dirs.filter(x => x.isDirectory())) {
    try {
      const r = JSON.parse(await fsp.readFile(path.join(raiz, d.name, 'relatorio.json'), 'utf8'));
      lista.push({ ...r, pasta: path.join(raiz, d.name), id: d.name });
    } catch (_) { /* pasta sem relatorio: ignora */ }
  }
  return lista.sort((a, b) => b.id.slice(-15).localeCompare(a.id.slice(-15)));
}

module.exports = { auditar, ultimaAuditoria, backupBR, simular, listarSimulacoes, sha256Arquivo };
