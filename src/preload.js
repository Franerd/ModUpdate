const { contextBridge, ipcRenderer } = require('electron');
const chamar = canal => (...a) => ipcRenderer.invoke(canal, ...a);
const ouvir = canal => f => ipcRenderer.on(canal, (_, d) => f(d));

contextBridge.exposeInMainWorld('api', {
  janela: chamar('janela'),
  iniciar: chamar('app:iniciar'),
  reiniciar: chamar('app:reiniciar'),
  lerConfig: chamar('config:ler'),
  salvarConfig: chamar('config:salvar'),
  tokenGithub: chamar('github:token'),
  escolherPasta: chamar('dialogo:pasta'),
  abrirPasta: chamar('abrir:pasta'),
  abrirLink: chamar('abrir:link'),
  catalogo: { procurar: chamar('catalogo:procurar'), importar: chamar('catalogo:importar'), adicionar: chamar('catalogo:adicionar'), remover: chamar('catalogo:remover'), beta: chamar('catalogo:beta') },
  auditar: chamar('auditar'),
  backup: chamar('backup'),
  simular: chamar('simular'),
  admin: { entrar: chamar('admin:entrar'), sair: chamar('admin:sair'), versoes: chamar('admin:versoes'), promover: chamar('admin:promover'), voltar: chamar('admin:voltar') },
  aoLog: ouvir('log'), aoProgresso: ouvir('progresso'), aoAtualizacao: ouvir('atualizacao'),
});
