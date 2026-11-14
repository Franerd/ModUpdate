const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const mods = require('./core/mods');
const ops = require('./core/operacoes');
const github = require('./core/github');
const producao = require('./producao');

// Em desenvolvimento usa outra pasta de dados para nao misturar com o app instalado
if (!app.isPackaged) app.setPath('userData', path.join(app.getPath('appData'), 'ModUpdate-dev'));
if (process.env.MODUPDATE_DADOS) app.setPath('userData', process.env.MODUPDATE_DADOS);

// ---------- configuracao ----------
// config.json ao lado do .exe = padrao de fabrica; %APPDATA%\ModUpdate guarda o que e seu
// (pastas, catalogo, token). Nada disso vai para o GitHub.
const PASTA_APP = app.isPackaged ? path.dirname(process.execPath) : path.join(__dirname, '..');
const dados = nome => path.join(app.getPath('userData'), nome);
const lerJSON = (f, padrao = {}) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, '')); } catch (_) { return padrao; } };
const gravarJSON = (f, d) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(d, null, 2)); };
const padrao = () => lerJSON(path.join(PASTA_APP, 'config.json'));
const config = () => ({ ...padrao(), ...lerJSON(dados('config.json')) });
const REPO = () => padrao().repo || 'Franerd/ModUpdate';

const attr = (tag, nome) => (new RegExp(`\\b${nome}="([^"]*)"`).exec(tag) || [])[1];
function pastaMods() {
  const cfg = config();
  if (cfg.pastaMods) return { pasta: cfg.pastaMods, origem: 'escolhida por você' };
  const base = path.join(app.getPath('documents'), 'My Games', 'FarmingSimulator2025');
  try {
    const tag = (/<modsDirectoryOverride\b[^>]*>/.exec(fs.readFileSync(path.join(base, 'gameSettings.xml'), 'utf8')) || [''])[0];
    if (attr(tag, 'active') === 'true' && attr(tag, 'directory')) return { pasta: attr(tag, 'directory'), origem: 'gameSettings.xml' };
  } catch (_) { /* sem gameSettings: usa o padrao do jogo */ }
  return { pasta: path.join(base, 'mods'), origem: 'padrão do jogo' };
}
const pastaTrabalho = () => config().pastaTrabalho || path.join(app.getPath('documents'), 'ModUpdate');
const contexto = () => ({ pastaMods: pastaMods().pasta, pastaTrabalho: pastaTrabalho(), catalogo: lerCatalogo() });

const lerCatalogo = () => lerJSON(dados('catalogo.json'), []);
function somarCatalogo(novos) {   // nunca troca o repositorio de um mod que ja esta no catalogo
  const cat = lerCatalogo(), tem = new Set(cat.map(c => c.mod.toLowerCase()));
  let n = 0;
  for (const c of novos) if (!tem.has(c.mod.toLowerCase())) { cat.push({ mod: c.mod, repo: c.repo, evidencia: c.evidencia || '' }); tem.add(c.mod.toLowerCase()); n++; }
  cat.sort((a, b) => a.mod.toLowerCase().localeCompare(b.mod.toLowerCase()));
  gravarJSON(dados('catalogo.json'), cat);
  return n;
}

// segredos deste PC, criptografados pelo Windows
const segredo = nome => ({
  ler: () => { try { return safeStorage.decryptString(fs.readFileSync(dados(nome))); } catch (_) { return null; } },
  gravar: v => { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.writeFileSync(dados(nome), safeStorage.encryptString(v)); },
  apagar: () => { try { fs.unlinkSync(dados(nome)); } catch (_) {} },
});
const tokenGithub = segredo('github.bin'), chaveAdmin = segredo('admin-chave.bin');
const exigirChave = () => { const c = chaveAdmin.ler(); if (!c) throw new Error('Modo administrador não está ativo'); return c; };

let janela;
function criarJanela() {
  janela = new BrowserWindow({
    width: 1120, height: 720, minWidth: 940, minHeight: 600,
    frame: false, backgroundColor: '#0f0e0c', show: false, title: 'ModUpdate',
    icon: path.join(__dirname, 'ui', 'icone.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  janela.loadFile(path.join(__dirname, 'ui', 'index.html'));
  janela.once('ready-to-show', () => janela.show());
  janela.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.CAPTURA && !app.isPackaged) {   // modo de teste: roda um script na tela e salva um print
    if (process.env.CAPTURA_JS) setTimeout(() => janela.webContents.executeJavaScript(process.env.CAPTURA_JS).catch(() => {}), 2500);
    setTimeout(async () => { fs.writeFileSync(process.env.CAPTURA, (await janela.webContents.capturePage()).toPNG()); app.quit(); }, +(process.env.CAPTURA_SEG || 6) * 1000);
  }
}
const enviar = (canal, d) => { if (janela && !janela.isDestroyed()) janela.webContents.send(canal, d); };
const log = (texto, tipo = 'info') => enviar('log', { texto, tipo, hora: new Date().toLocaleTimeString('pt-BR') });
const comLog = (canal, f) => ipcMain.handle(canal, async (_, ...a) => { try { return await f(...a); } catch (e) { log(e.message, 'erro'); throw e; } });

async function estado() {
  const pm = pastaMods(), pt = pastaTrabalho();
  let zips = []; try { zips = (await fsp.readdir(pm.pasta)).filter(n => /\.zip$/i.test(n)); } catch (_) {}
  return {
    versao: app.getVersion(), cfg: config(), pastaMods: pm, pastaTrabalho: pt, zips,
    catalogo: lerCatalogo(), sugestoes: lerJSON(dados('sugestoes.json'), []),
    auditoria: await ops.ultimaAuditoria(pt), simulacoes: await ops.listarSimulacoes(pt),
    limite: github.limite(), temToken: github.temToken(), admin: !!chaveAdmin.ler(),
  };
}

ipcMain.handle('janela', (_, acao) => {
  if (acao === 'min') janela.minimize();
  if (acao === 'max') janela.isMaximized() ? janela.unmaximize() : janela.maximize();
  if (acao === 'fechar') janela.close();
});
ipcMain.handle('app:iniciar', async () => {
  const e = await estado();
  log(`Pasta de mods: ${e.pastaMods.pasta} (só leitura) · pasta de trabalho: ${e.pastaTrabalho}`);
  return e;
});
ipcMain.handle('config:ler', estado);
comLog('config:salvar', async parcial => {
  const pm = parcial.pastaMods || pastaMods().pasta, pt = parcial.pastaTrabalho || path.join(app.getPath('documents'), 'ModUpdate');
  mods.conferirTrava(pm, pt);
  gravarJSON(dados('config.json'), { ...lerJSON(dados('config.json')), pastaMods: parcial.pastaMods || '', pastaTrabalho: parcial.pastaTrabalho || '' });
  log('Configurações salvas', 'ok');
  return estado();
});
comLog('github:token', async t => {
  if (!t) { tokenGithub.apagar(); github.configurar({ tokenGithub: null }); log('Token do GitHub removido deste PC'); return false; }
  github.configurar({ tokenGithub: t });
  try { await github.repositorio(REPO()); } catch (e) { if (e.tipo === 'token') { github.configurar({ tokenGithub: tokenGithub.ler() }); throw e; } }
  tokenGithub.gravar(t); log('Token do GitHub salvo neste PC (criptografado)', 'ok');
  return true;
});
ipcMain.handle('dialogo:pasta', async () => {
  const r = await dialog.showOpenDialog(janela, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('abrir:pasta', async (_, p) => { const alvo = p || pastaTrabalho(); await fsp.mkdir(alvo, { recursive: true }); return shell.openPath(alvo); });
ipcMain.handle('abrir:link', (_, url) => { if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+/i.test(url)) return shell.openExternal(url); });

// ---------- catalogo ----------
comLog('catalogo:procurar', async () => {
  const pm = pastaMods().pasta;
  log(`Procurando links do GitHub nos mods de ${pm}`);
  let ultimo = 0;
  const r = await mods.procurarLinks(pm, p => { if (Date.now() - ultimo > 80 || p.atual === p.total) { ultimo = Date.now(); enviar('progresso', { titulo: 'Lendo os mods', ...p }); } });
  const novos = somarCatalogo(r.achados.filter(a => a.confiavel));
  gravarJSON(dados('sugestoes.json'), r.achados.filter(a => !a.confiavel));
  r.erros.forEach(e => log(`${e.mod}: não deu para ler (${e.erro})`, 'aviso'));
  log(`${r.zips} mods lidos · ${novos} novo(s) no catálogo`, 'ok');
  return { ...(await estado()), novos, zips: r.zips };
});
comLog('catalogo:importar', async () => {
  const r = await dialog.showOpenDialog(janela, { filters: [{ name: 'Catálogo CSV', extensions: ['csv'] }], properties: ['openFile'] });
  if (r.canceled) return null;
  const novos = somarCatalogo(mods.importarCSV(await fsp.readFile(r.filePaths[0], 'utf8')));
  log(`${novos} mod(s) importado(s) de ${path.basename(r.filePaths[0])}`, 'ok');
  return { ...(await estado()), novos };
});
comLog('catalogo:adicionar', async item => { somarCatalogo([item]); return estado(); });
comLog('catalogo:remover', async mod => { gravarJSON(dados('catalogo.json'), lerCatalogo().filter(c => c.mod.toLowerCase() !== String(mod).toLowerCase())); return estado(); });

// ---------- operacoes ----------
comLog('auditar', async () => {
  const c = contexto();
  log(`Verificando ${c.catalogo.length} mod(s) no GitHub${github.temToken() ? '' : ' (sem token: 60 consultas por hora)'}`);
  const r = await ops.auditar(c, p => enviar('progresso', { titulo: 'Consultando o GitHub', ...p }));
  const n = s => r.linhas.filter(l => l.status === s).length;
  log(`${n('atualizacao')} com atualização · ${n('em_dia')} em dia · ${n('indisponivel')} sem resposta · relatório em ${r.relatorio}`, n('indisponivel') ? 'aviso' : 'ok');
  const semResposta = r.linhas.find(l => l.status === 'indisponivel');
  if (semResposta) log(`Sem resposta não quer dizer desatualizado: ${semResposta.erro}`, 'aviso');
  return estado();
});
comLog('backup', async () => {
  const r = await ops.backupBR(contexto(), p => enviar('progresso', { titulo: 'Copiando traduções', ...p }));
  log(`Backup das traduções PT-BR: ${r.arquivos} arquivo(s) de ${r.mods} mod(s) em ${r.pasta}`, 'ok');
  return r;
});
comLog('simular', async mod => {
  const c = contexto(), item = c.catalogo.find(x => x.mod === mod);
  if (!item) throw new Error('Mod fora do catálogo: ' + mod);
  log(`Simulando a atualização de ${mod}`);
  const relatorio = await ops.simular({ ...c, mod, repo: item.repo }, etapa => enviar('progresso', { etapa, nome: mod.replace(/\.zip$/i, '') }));
  const conf = relatorio.conflitos_de_edicao.length;
  log(`${mod}: ${relatorio.version_local} → ${relatorio.version_remota_moddesc} · ${relatorio.base_oficial ? `${conf} conflito(s)` : 'sem versão oficial para comparar'} · mod instalado intacto`, conf || !relatorio.base_oficial ? 'aviso' : 'ok');
  return { relatorio, simulacoes: await ops.listarSimulacoes(c.pastaTrabalho), limite: github.limite() };
});

// ---------- modo administrador (versoes do app) ----------
comLog('admin:entrar', async chave => {
  chave = String(chave || '').trim();
  await producao.admin.eu(chave);
  chaveAdmin.gravar(chave);
  log('Modo administrador ativado. Este app passa a receber as versões de teste (vale ao reabrir).', 'ok');
  return true;
});
ipcMain.handle('admin:sair', () => { chaveAdmin.apagar(); log('Modo administrador desativado'); return true; });
comLog('admin:versoes', () => producao.admin.versoes(exigirChave()));
comLog('admin:promover', async tag => { const r = await producao.admin.promover(exigirChave(), tag); log(`Versão ${r.atual} promovida a oficial`, 'ok'); return r; });
comLog('admin:voltar', async () => { const r = await producao.admin.voltar(exigirChave()); log(`Versão oficial voltou para a ${r.atual}`, 'ok'); return r; });

// ---------- atualizacao automatica do proprio app ----------
// Versao oficial: a que voce promoveu no FraNerdServer. Canal teste (app com chave de admin):
// pre-lancamentos direto do GitHub. Se o servidor nao responder, usa as versoes estaveis do GitHub.
let atualizador = null;
function iniciarAtualizador() {
  if (!app.isPackaged) return;
  try { ({ autoUpdater: atualizador } = require('electron-updater')); } catch (_) { return; }
  const [owner, repo] = REPO().split('/'), noGithub = { provider: 'github', owner, repo };
  const teste = !!chaveAdmin.ler();
  let reserva = teste || !producao.ativo();
  atualizador.autoDownload = true;
  atualizador.allowPrerelease = teste;
  atualizador.setFeedURL(reserva ? noGithub : { provider: 'generic', url: producao.url() + '/v1/app' });
  atualizador.on('update-available', i => log(`Nova versão ${i.version}${teste ? ' (teste)' : ''} encontrada, baixando…`, 'aviso'));
  atualizador.on('download-progress', p => enviar('atualizacao', { fase: 'baixando', pct: Math.floor(p.percent) }));
  atualizador.on('update-downloaded', i => { log(`Versão ${i.version} pronta para instalar`, 'ok'); enviar('atualizacao', { fase: 'pronta', versao: i.version, teste }); });
  atualizador.on('error', e => {
    if (reserva) return log('Verificação de atualização falhou: ' + (e && e.message || e).split('\n')[0], 'aviso');
    reserva = true; atualizador.setFeedURL(noGithub); atualizador.checkForUpdates().catch(() => {});
  });
  atualizador.checkForUpdates().catch(() => {});
}
ipcMain.handle('app:reiniciar', () => { if (atualizador) atualizador.quitAndInstall(false, true); });

if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => { if (janela) { if (janela.isMinimized()) janela.restore(); janela.focus(); } });

app.whenReady().then(() => {
  producao.configurar(padrao().urlProducao, app.getVersion());
  github.configurar({ versao: app.getVersion(), tokenGithub: tokenGithub.ler() });
  criarJanela();
  setTimeout(iniciarAtualizador, 4000);
});
app.on('window-all-closed', () => app.quit());
