// Cliente do ModUpdate Servidor (FraNerdServer): versao oficial do app, Promover e Voltar versao.
let base = '', agente = 'ModUpdate';
function configurar(url, versao) { base = (url || '').replace(/\/+$/, ''); agente = `ModUpdate/${versao}`; }

async function pedir(metodo, caminho, { chave, corpo, timeout = 15000 } = {}) {
  if (!base) throw new Error('Servidor do ModUpdate não configurado');
  let res;
  try {
    res = await fetch(base + caminho, {
      method: metodo, signal: AbortSignal.timeout(timeout),
      headers: { 'User-Agent': agente, Accept: 'application/json', ...(chave ? { Authorization: `Bearer ${chave}` } : {}), ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined,
    });
  } catch (_) { throw new Error('O servidor do ModUpdate não respondeu'); }
  let j = null; try { j = await res.json(); } catch (_) {}
  if (!res.ok) throw Object.assign(new Error((j && j.erro) || `Servidor respondeu ${res.status}`), { status: res.status });
  return j;
}

module.exports = {
  configurar, ativo: () => !!base, url: () => base,
  admin: {
    eu: chave => pedir('GET', '/v1/admin/eu', { chave }),
    versoes: chave => pedir('GET', '/v1/admin/versoes', { chave }),
    promover: (chave, tag) => pedir('POST', '/v1/admin/promover', { chave, corpo: { tag }, timeout: 600000 }),
    voltar: chave => pedir('POST', '/v1/admin/voltar', { chave, corpo: {} }),
  },
};
