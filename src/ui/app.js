const $ = id => document.getElementById(id);
const esc = t => String(t ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const msgErro = e => String(e && e.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
const semZip = n => n.replace(/\.zip$/i, '');
const dataHora = d => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';

const ROTULO = {
  em_dia: 'Em dia', atualizacao: 'Atualização', conferir: 'Conferir', sem_zip: 'Sem ZIP do mod', sem_release: 'Sem lançamento',
  indisponivel: 'Sem resposta', repo_nao_encontrado: 'Repositório sumiu', ausente: 'Não instalado', nao_verificado: 'Não verificado',
};
const DICA = {
  conferir: 'Não deu para comparar a versão instalada com o nome do lançamento. Simule para ver a versão real.',
  sem_zip: 'O lançamento mais novo não traz o ZIP do mod (ou traz vários e não dá para saber qual é).',
  sem_release: 'O autor não publica lançamentos neste repositório.',
  indisponivel: 'O GitHub não respondeu. Isso não quer dizer que o mod está desatualizado.',
  ausente: 'Está no catálogo, mas o ZIP não está na pasta de mods.',
};
let estado = { catalogo: [], sugestoes: [], auditoria: null, simulacoes: [], ocupado: false };

// ---------- janela, abas, log ----------
document.querySelectorAll('[data-jan]').forEach(b => b.onclick = () => api.janela(b.dataset.jan));
document.querySelectorAll('.aba-btn').forEach(b => b.onclick = () => {
  document.querySelectorAll('.aba-btn').forEach(x => x.classList.toggle('ativa', x === b));
  document.querySelectorAll('.aba').forEach(a => a.classList.toggle('oculto', a.id !== b.dataset.aba));
});
$('logCab').onclick = () => $('log').classList.toggle('aberto');
api.aoLog(({ texto, tipo, hora }) => {
  const li = document.createElement('li'); li.className = tipo;
  li.innerHTML = `<time>${esc(hora)}</time>${esc(texto)}`;
  $('logLista').prepend(li); $('logUltimo').textContent = texto;
  while ($('logLista').children.length > 200) $('logLista').lastChild.remove();
});
function progresso(texto, pct, dir = '') {
  $('progTexto').textContent = texto; $('progDir').textContent = dir;
  $('progBarra').classList.toggle('ocupado', pct === null);
  if (pct !== null) $('progBarra').style.width = pct + '%';
}
api.aoProgresso(p => p.etapa ? progresso(p.etapa, null, p.nome || '') : progresso(p.titulo, Math.round(p.atual / p.total * 100), `${p.atual}/${p.total} · ${semZip(p.nome)}`));
function ocupar(sim) {
  estado.ocupado = sim;
  ['btnVerificar', 'btnBackup', 'btnProcurar', 'btnImportar', 'btnAdicionar'].forEach(i => $(i).disabled = sim);
  document.querySelectorAll('[data-simular]').forEach(b => b.disabled = sim);
}
async function tarefa(f) {
  if (estado.ocupado) return;
  ocupar(true);
  try { await f(); } catch (e) { progresso('Falhou: ' + msgErro(e), 0); }
  finally { ocupar(false); desenhar(); }
}

// ---------- desenho ----------
function desenhar() {
  const linhas = new Map(((estado.auditoria && estado.auditoria.linhas) || []).map(l => [l.mod.toLowerCase(), l]));
  const itens = estado.catalogo.map(c => ({ ...c, ...(linhas.get(c.mod.toLowerCase()) || { status: 'nao_verificado', br: [] }), repo: c.repo }));
  const conta = (...s) => itens.filter(i => s.includes(i.status)).length;
  const verificado = !!estado.auditoria && estado.auditoria.online;
  $('cEmDia').textContent = verificado ? conta('em_dia') : '–';
  $('cAtual').textContent = verificado ? conta('atualizacao') : '–';
  $('cConferir').textContent = verificado ? conta('conferir', 'sem_zip', 'sem_release') : '–';
  $('cFalha').textContent = verificado ? conta('indisponivel', 'repo_nao_encontrado') : '–';
  $('nCatalogo').textContent = estado.catalogo.length;
  $('nBR').textContent = estado.auditoria ? itens.filter(i => (i.br || []).length).length : '–';
  const lim = estado.limite || {};
  $('nLimite').innerHTML = lim.restante == null ? '–' : `${lim.restante}<small>/${lim.total}</small>`;
  $('ultima').textContent = estado.auditoria ? `Última verificação: ${dataHora(estado.auditoria.feitaEm)} · ${estado.pastaTrabalho}` : `Ainda não verificado · ${estado.pastaTrabalho || ''}`;

  const ordem = ['atualizacao', 'conferir', 'sem_zip', 'indisponivel', 'repo_nao_encontrado', 'sem_release', 'nao_verificado', 'em_dia', 'ausente'];
  itens.sort((a, b) => ordem.indexOf(a.status) - ordem.indexOf(b.status) || a.mod.toLowerCase().localeCompare(b.mod.toLowerCase()));
  $('listaMods').innerHTML = itens.map(i => `<li>
      <span class="nome"><b title="${esc(i.mod)}"><span class="t">${esc(semZip(i.mod))}</span>${(i.br || []).length ? `<span class="br" title="${esc(i.br.join('\n'))}">PT-BR</span>` : ''}</b>
        <button data-link="${esc(i.repo)}" title="Abrir no GitHub">${esc(i.repo.replace(/^https?:\/\/github\.com\//i, ''))}</button></span>
      <span class="ver" title="${esc(i.erro || '')}"><span class="t">${i.versaoLocal ? `<b>${esc(i.versaoLocal)}</b>` : '—'}${i.tag ? ` → ${esc(i.tag)}${i.dataRelease ? ` · ${new Date(i.dataRelease).toLocaleDateString('pt-BR')}` : ''}` : ''}</span>
        ${i.usandoBeta ? `<button class="chip-beta ligado" data-beta="${esc(i.mod)}" data-para="0" title="Este mod segue pré-lançamentos (beta). Clique para voltar a seguir só os lançamentos estáveis.">BETA</button>`
          : i.tagBeta ? `<button class="chip-beta" data-beta="${esc(i.mod)}" data-para="1" title="Existe um pré-lançamento mais novo que o estável. Clique para este mod passar a seguir o beta.">beta ${esc(i.tagBeta)}</button>` : ''}</span>
      <span class="pilula s-${i.status}" title="${esc(i.erro || DICA[i.status] || '')}">${ROTULO[i.status] || i.status}</span>
      <button class="btn mini${i.status === 'atualizacao' ? ' primario' : ''}" data-simular="${esc(i.mod)}" ${i.status === 'ausente' || i.status === 'sem_release' || estado.ocupado ? 'disabled' : ''} title="Gera uma prévia da atualização preservando as suas edições">Simular</button>
    </li>`).join('') || `<li class="vazio">O catálogo está vazio.<br>Clique em <b>Procurar mods com GitHub</b> para o app ler a sua pasta de mods e encontrar os que têm repositório,<br>ou importe um catálogo em CSV na aba <b>Catálogo</b>.</li>`;
  $('listaMods').querySelectorAll('[data-simular]').forEach(b => b.onclick = () => simular(b.dataset.simular));
  $('listaMods').querySelectorAll('[data-beta]').forEach(b => b.onclick = async () => aplicar(await api.catalogo.beta({ mod: b.dataset.beta, beta: b.dataset.para === '1' })));
  $('listaMods').querySelectorAll('[data-link]').forEach(b => b.onclick = () => api.abrirLink(b.dataset.link));

  // aba catalogo: itens do catalogo (com remover) e sugestoes (com adicionar)
  const noCat = new Set(estado.catalogo.map(c => c.mod.toLowerCase()));
  const sug = estado.sugestoes.filter(s => !noCat.has(s.mod.toLowerCase()));
  $('nSug').textContent = sug.length ? `· ${sug.length} sugest${sug.length > 1 ? 'ões' : 'ão'}` : '';
  $('listaSug').innerHTML = sug.map((s, n) => `<li>
      <span class="nome"><b>${esc(semZip(s.mod))}</b><button data-link="${esc(s.repo)}">${esc(s.repo.replace(/^https?:\/\/github\.com\//i, ''))}</button></span>
      <span class="ver">achado em: ${esc(s.evidencia)}</span>
      <button class="btn mini" data-aceitar="${n}">Adicionar</button></li>`).join('')
    + estado.catalogo.map(c => `<li>
      <span class="nome"><b>${esc(semZip(c.mod))}</b><button data-link="${esc(c.repo)}">${esc(c.repo.replace(/^https?:\/\/github\.com\//i, ''))}</button></span>
      <span class="ver">no catálogo · ${esc(c.evidencia || '')}</span>
      <button class="tirar" data-tirar="${esc(c.mod)}" title="Tirar do catálogo (não mexe no mod)">✕</button></li>`).join('');
  $('listaSug').querySelectorAll('[data-link]').forEach(b => b.onclick = () => api.abrirLink(b.dataset.link));
  $('listaSug').querySelectorAll('[data-aceitar]').forEach(b => b.onclick = async () => { const s = sug[+b.dataset.aceitar]; aplicar(await api.catalogo.adicionar({ mod: s.mod, repo: s.repo, evidencia: s.evidencia })); });
  $('listaSug').querySelectorAll('[data-tirar]').forEach(b => b.onclick = async () => aplicar(await api.catalogo.remover(b.dataset.tirar)));

  $('listaSim').innerHTML = estado.simulacoes.slice(0, 30).map((s, n) => `<li data-sim="${n}">
      <b><i class="ponto" style="--c:${s.status === 'REVISAO_OBRIGATORIA' ? 'var(--trigo)' : 'var(--verde)'}"></i>${esc(semZip(s.mod))}</b>
      <small>${esc(s.version_local)} → ${esc(s.version_remota_moddesc)} · ${dataHora(s.feitaEm)}</small></li>`).join('') || '<li class="vazio">Nenhuma simulação ainda</li>';
  $('listaSim').querySelectorAll('[data-sim]').forEach(li => li.onclick = () => detalhe(estado.simulacoes[+li.dataset.sim]));
}
function aplicar(d) {
  Object.assign(estado, d);
  if (d.pastaMods) {
    $('nomePasta').textContent = d.pastaMods.pasta.split(/[\\/]/).filter(Boolean).pop() || d.pastaMods.pasta;
    $('caminhoMods').textContent = `${d.pastaMods.pasta} · ${d.pastaMods.origem}`; $('caminhoMods').title = d.pastaMods.pasta;
  }
  if ('admin' in d) { $('seloAdm').classList.toggle('oculto', !d.admin); $('btnAdmin').classList.toggle('oculto', !d.admin); }
  desenhar();
}

// ---------- acoes ----------
$('btnVerificar').onclick = () => tarefa(async () => {
  if (!estado.catalogo.length) return progresso('O catálogo está vazio: procure os mods com GitHub primeiro', 0);
  progresso('Consultando o GitHub…', null);
  aplicar(await api.auditar());
  const l = estado.auditoria.linhas, n = s => l.filter(x => x.status === s).length;
  progresso(`Verificado: ${n('atualizacao')} com atualização · ${n('em_dia')} em dia · ${n('indisponivel')} sem resposta`, 100);
});
$('btnBackup').onclick = () => tarefa(async () => {
  progresso('Copiando as traduções PT-BR…', null);
  const r = await api.backup();
  progresso(`Backup feito: ${r.arquivos} arquivo(s) de ${r.mods} mod(s)`, 100, r.pasta);
});
$('btnProcurar').onclick = () => tarefa(async () => {
  progresso('Lendo os mods da pasta…', null);
  const r = await api.catalogo.procurar();
  aplicar(r);
  progresso(`${r.zips} mods lidos: ${r.novos} entraram no catálogo, ${r.sugestoes.length} sugest${r.sugestoes.length === 1 ? 'ão' : 'ões'} para conferir`, 100);
});
$('btnImportar').onclick = () => tarefa(async () => { const r = await api.catalogo.importar(); if (r) { aplicar(r); progresso(`${r.novos} mod(s) importado(s) para o catálogo`, 100); } });
$('btnAdicionar').onclick = async () => {
  const mod = $('novoMod').value.trim(), repo = $('novoRepo').value.trim();
  if (!/\.zip$/i.test(mod) || !/^https?:\/\/github\.com\/[\w.-]+\/[\w.-]+\/?$/i.test(repo)) return progresso('Informe o nome do ZIP do mod e o endereço do repositório (https://github.com/autor/repositorio)', 0);
  aplicar(await api.catalogo.adicionar({ mod, repo, evidencia: 'manual' })); $('novoMod').value = $('novoRepo').value = '';
};
$('btnTrabalho').onclick = $('ultima').onclick = () => api.abrirPasta();

async function simular(mod) {
  await tarefa(async () => {
    progresso('Preparando a simulação…', null, semZip(mod));
    const r = await api.simular(mod);
    estado.simulacoes = r.simulacoes; estado.limite = r.limite;
    progresso(`Prévia pronta: ${semZip(mod)} ${r.relatorio.version_local} → ${r.relatorio.version_remota_moddesc}`, 100);
    detalhe(r.relatorio);
  });
}

// ---------- detalhe da simulacao ----------
function detalhe(s) {
  const e = s.suas_edicoes, nEd = e ? e.alterados.length + e.adicionados.length + e.removidos.length : null;
  const conf = s.conflitos_de_edicao || [], falt = (s.traducoes_faltando || []).reduce((t, f) => t + f.total, 0);
  $('detMod').textContent = semZip(s.mod);
  $('detVer').innerHTML = `${esc(s.version_local || '?')} → <b>${esc(s.version_remota_moddesc)}</b> · ${s.pre_lancamento ? 'pré-lançamento (beta)' : 'lançamento'} ${esc(s.release_tag)} · ${dataHora(s.feitaEm)}`;
  const revisar = s.status === 'REVISAO_OBRIGATORIA';
  $('detStatus').className = 'pilula ' + (revisar ? 's-atualizacao' : 's-em_dia'); $('detStatus').textContent = revisar ? 'Precisa de revisão' : 'Prévia limpa';
  $('detNota').className = 'det-nota' + (s.base_oficial ? '' : ' ruim');
  $('detNota').innerHTML = s.base_oficial
    ? `Suas edições foram identificadas comparando o seu mod com a versão oficial <b>${esc(s.base_oficial)}</b>. O mod instalado não foi alterado.`
    : `Não encontrei no GitHub a versão oficial <b>${esc(s.version_local)}</b> para comparar${s.base_erro ? ` (${esc(s.base_erro)})` : ''}. Sem ela não dá para saber o que é edição sua: só as traduções PT-BR foram preservadas. Revise os arquivos alterados antes de usar a prévia.`;
  const cel = (n, t, c = '') => `<div><dd style="${c ? `--c:var(--${c})` : ''}">${n}</dd><dt>${t}</dt></div>`;
  $('detGrade').innerHTML = cel(nEd === null ? '?' : nEd, 'Edições suas')
    + cel((s.edicoes_mantidas || []).length + (s.edicoes_mescladas || []).length + (s.traducoes_brasileiras_preservadas || []).length, 'Preservadas', 'verde')
    + cel(s.base_oficial ? conf.length : (s.arquivos_sensiveis_para_revisao || []).length, s.base_oficial ? 'Conflitos' : 'Para revisar', (s.base_oficial ? conf.length : (s.arquivos_sensiveis_para_revisao || []).length) ? 'vermelho' : '')
    + cel(falt, 'Textos sem tradução', falt ? 'trigo' : '');
  // conflito com os blocos: como era, como voce deixou, como o autor deixou
  const lado = (rotulo, cls, l) => `<div class="lado ${cls}"><span>${rotulo}</span><pre>${l.length ? l.map(esc).join('\n') : '<i>(nada: trecho removido ou inexistente)</i>'}</pre></div>`;
  const blocos = c => !c.blocos ? '' : c.blocos.map((b, i) => `<div class="bloco"><small>Bloco ${i + 1} de ${c.totalBlocos}</small>
      ${lado(`Original · linha ${b.linhaOriginal}`, 'orig', b.original)}${lado(`Você · linha ${b.linhaSua} do seu arquivo`, 'seu', b.seu)}${lado(`Autor · linha ${b.linhaAutor} da versão nova`, 'autor', b.autor)}</div>`).join('')
    + (c.totalBlocos > c.blocos.length ? `<small>Mostrando ${c.blocos.length} de ${c.totalBlocos} blocos; o resto está no conflitos.txt da pasta da prévia.</small>` : '');
  const secConf = (titulo, lista) => lista.length ? `<details class="det-sec" open><summary>${titulo} <b>${lista.length}</b></summary>${lista.map(c =>
    `<details class="conf" ${lista.length === 1 ? 'open' : ''}><summary><code>${esc(c.arquivo)}</code> <small>— ${esc(c.motivo)}${c.totalBlocos ? ` · ${c.totalBlocos} bloco(s)` : ''}</small></summary>${blocos(c)}</details>`).join('')}</details>` : '';
  const sec = (titulo, lista, aberto = false) => lista && lista.length ? `<details class="det-sec" ${aberto ? 'open' : ''}><summary>${titulo} <b>${lista.length}</b></summary><ul>${lista.map(i => `<li>${i}</li>`).join('')}</ul></details>` : '';
  $('detSecoes').innerHTML = [
    secConf('Conflitos: ficou a versão do autor, a sua está na pasta suas_versoes', conf),
    secConf('Tradução em que você e o autor mexeram no mesmo trecho: ficou a sua', s.conflitos_de_traducao || []),
    !s.base_oficial ? sec('Arquivos que mudaram e precisam de revisão', (s.arquivos_sensiveis_para_revisao || []).map(esc), true) : '',
    sec('Juntados automaticamente (sua edição + mudança do autor): teste no jogo', (s.edicoes_mescladas || []).map(esc), true),
    sec('Edições suas mantidas como estavam', (s.edicoes_mantidas || []).map(esc)),
    sec('Traduções PT-BR preservadas', (s.traducoes_brasileiras_preservadas || []).map(n => esc(n) + ((s.traducoes_com_conflito_de_conteudo || []).includes(n) ? ' <small>— a versão nova traz outra tradução; ficou a sua</small>' : ''))),
    sec('Textos novos ainda sem tradução PT-BR', (s.traducoes_faltando || []).flatMap(f => f.chaves.map(k => `${esc(k)} <small>— ${esc(f.arquivo)}</small>`))),
    sec('Arquivos novos na versão do autor', ((s.comparacao_release || {}).novos || []).map(esc)),
    sec('Arquivos alterados pelo autor', ((s.comparacao_release || {}).alterados || []).map(esc)),
    sec('Arquivos removidos na versão do autor', ((s.comparacao_release || {}).removidos || []).map(esc)),
  ].join('');
  $('detPasta').onclick = () => api.abrirPasta(s.pasta);
  if (!$('dlgSim').open) $('dlgSim').showModal();
}
$('detFechar').onclick = () => $('dlgSim').close();

// ---------- configuracoes ----------
$('btnConfig').onclick = async () => {
  const d = await api.lerConfig();
  $('cfgMods').value = d.cfg.pastaMods || ''; $('cfgTrab').value = d.cfg.pastaTrabalho || '';
  $('cfgModsInfo').textContent = `Em uso: ${d.pastaMods.pasta} (${d.pastaMods.origem})`;
  $('cfgToken').value = ''; $('cfgToken').placeholder = d.temToken ? 'Token salvo (cole outro para trocar)' : 'github_pat_…';
  $('cfgTokenTirar').classList.toggle('oculto', !d.temToken);
  $('admDesligado').classList.toggle('oculto', d.admin); $('admLigado').classList.toggle('oculto', !d.admin);
  $('cfgErro').textContent = $('admErro').textContent = '';
  $('dlgConfig').showModal();
};
$('cfgModsBtn').onclick = async () => { const p = await api.escolherPasta(); if (p) $('cfgMods').value = p; };
$('cfgTrabBtn').onclick = async () => { const p = await api.escolherPasta(); if (p) $('cfgTrab').value = p; };
$('cfgTokenTirar').onclick = async () => { await api.tokenGithub(''); $('cfgTokenTirar').classList.add('oculto'); $('cfgToken').placeholder = 'github_pat_…'; };
$('cfgSalvar').onclick = async () => {
  try {
    if ($('cfgToken').value.trim()) await api.tokenGithub($('cfgToken').value.trim());
    aplicar(await api.salvarConfig({ pastaMods: $('cfgMods').value.trim(), pastaTrabalho: $('cfgTrab').value.trim() }));
    $('dlgConfig').close();
  } catch (e) { $('cfgErro').textContent = msgErro(e); }
};
$('admAtivar').onclick = async () => {
  try { await api.admin.entrar($('admChave').value); $('admChave').value = ''; aplicar({ admin: true }); $('admDesligado').classList.add('oculto'); $('admLigado').classList.remove('oculto'); $('admErro').textContent = ''; }
  catch (e) { $('admErro').textContent = msgErro(e); }
};
$('admDesativar').onclick = async () => { await api.admin.sair(); aplicar({ admin: false }); $('admDesligado').classList.remove('oculto'); $('admLigado').classList.add('oculto'); };

// ---------- painel adm: versoes do app ----------
const stVer = (t, c = '') => { $('verProducao').className = 's-info ' + c; $('verProducao').textContent = t; };
async function carregarVersoes() {
  stVer('Carregando…'); $('verLista').innerHTML = '';
  try {
    const { producao: p, lancamentos } = await api.admin.versoes();
    stVer(p.atual ? `Versão oficial: v${p.atual}${p.anteriores.length ? ` · anterior: v${p.anteriores[0]}` : ''}` : 'Nenhuma versão promovida ainda', p.atual ? 'ok' : '');
    $('verVoltar').disabled = !p.anteriores.length;
    $('verLista').innerHTML = lancamentos.slice(0, 8).map(l => `<li><span><b>v${esc(l.versao)}</b> <small>${l.teste ? 'teste' : 'estável'} · ${l.data ? new Date(l.data).toLocaleDateString('pt-BR') : ''}</small></span>
      ${l.versao === p.atual ? '<small class="ok-txt">oficial</small>' : l.pronta ? `<button type="button" class="btn mini" data-promover="${esc(l.tag)}">Promover</button>` : '<small>sem instalador</small>'}</li>`).join('') || '<li><small>Nenhum lançamento no GitHub</small></li>';
    $('verLista').querySelectorAll('[data-promover]').forEach(b => b.onclick = async () => {
      if (!confirm(`Promover ${b.dataset.promover} para versão oficial?\n\nO servidor baixa o instalador do GitHub, confere o hash e passa a entregar essa versão.`)) return;
      b.disabled = true; b.textContent = 'Baixando…';
      try { await api.admin.promover(b.dataset.promover); await carregarVersoes(); } catch (e) { stVer('Falha ao promover: ' + msgErro(e), 'erro'); b.disabled = false; b.textContent = 'Promover'; }
    });
  } catch (e) { stVer('Não foi possível listar: ' + msgErro(e), 'erro'); }
}
$('btnAdmin').onclick = () => { $('dlgAdmin').showModal(); carregarVersoes(); };
$('admFechar').onclick = () => $('dlgAdmin').close();
$('verVoltar').onclick = async () => {
  if (!confirm('Voltar a versão oficial para a anterior?')) return;
  try { await api.admin.voltar(); await carregarVersoes(); } catch (e) { stVer('Falha: ' + msgErro(e), 'erro'); }
};

// ---------- atualizacao do proprio app ----------
api.aoAtualizacao(d => {
  $('aviso').classList.remove('oculto');
  if (d.fase === 'baixando') { $('avisoTexto').textContent = `Baixando nova versão do ModUpdate… ${d.pct}%`; $('avisoBtn').classList.add('oculto'); }
  else { $('avisoTexto').textContent = `Nova versão ${d.versao}${d.teste ? ' (teste)' : ''} pronta`; $('avisoBtn').classList.remove('oculto'); }
});
$('avisoBtn').onclick = () => api.reiniciar();

(async () => {
  const d = await api.iniciar();
  $('versao').textContent = `v${d.versao}${d.admin ? ' · canal teste' : ''}`;
  $('listaZips').innerHTML = (d.zips || []).map(z => `<option value="${esc(z)}">`).join('');
  aplicar(d);
})();
