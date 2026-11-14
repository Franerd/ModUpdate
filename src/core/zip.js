// Leitura e escrita de ZIP com as travas de seguranca do ModUpdate:
// nomes de caminho inseguros, nomes duplicados, limite de tamanho expandido e conferencia de CRC.
const fs = require('fs');
const zlib = require('zlib');
const yauzl = require('yauzl');
const yazl = require('yazl');

const MAX_EXPANDIDO = 2 * 1024 * 1024 * 1024;

function nomeSeguro(n) {
  const s = n.replace(/\\/g, '/');
  const partes = s.split('/');
  if (s.startsWith('/') || partes[0].includes(':') || partes.some(p => p === '.' || p === '..' || p === '')) throw new Error('Caminho inseguro no ZIP: ' + n);
  return s;
}

// Abre um ZIP (caminho de arquivo ou Buffer) sem extrair nada.
// Devolve { entradas: [{ nome, tamanho }], ler(nome) -> Buffer, fechar() }.
function abrir(fonte) {
  return new Promise((ok, erro) => {
    const opcoes = { lazyEntries: true, autoClose: false };
    const pronto = (e, zip) => {
      if (e) return erro(new Error('ZIP inválido: ' + e.message));
      const mapa = new Map(), entradas = [];
      zip.on('error', e2 => erro(new Error('ZIP inválido: ' + e2.message)));
      zip.on('entry', ent => {
        if (!/\/$/.test(ent.fileName)) { entradas.push({ nome: ent.fileName, tamanho: ent.uncompressedSize, crc: ent.crc32 >>> 0 }); mapa.set(ent.fileName, ent); }
        zip.readEntry();
      });
      zip.on('end', () => ok({
        entradas,
        ler: nome => new Promise((ok2, erro2) => {
          const ent = mapa.get(nome);
          if (!ent) return erro2(new Error('Arquivo não existe no ZIP: ' + nome));
          zip.openReadStream(ent, (e3, fluxo) => {
            if (e3) return erro2(e3);
            const partes = [];
            fluxo.on('data', c => partes.push(c)).on('error', erro2).on('end', () => {
              const dados = Buffer.concat(partes);
              if ((zlib.crc32(dados) >>> 0) !== (ent.crc32 >>> 0)) return erro2(new Error('ZIP corrompido (CRC não confere): ' + nome));
              ok2(dados);
            });
          });
        }),
        fechar: () => { try { zip.close(); } catch (_) {} },
      }));
      zip.readEntry();
    };
    if (Buffer.isBuffer(fonte)) yauzl.fromBuffer(fonte, opcoes, pronto); else yauzl.open(fonte, opcoes, pronto);
  });
}

// Le o ZIP inteiro para a memoria: Map nome -> Buffer.
// "banco" (opcional, de bancoDe) evita descompactar de novo o que e identico a um arquivo ja lido:
// as versoes de um mod repetem quase todos os arquivos grandes, entao isso poupa memoria e tempo.
const chave = (crc, tamanho) => `${crc >>> 0}:${tamanho}`;
function bancoDe(...mapas) {
  const banco = new Map();
  for (const m of mapas) for (const d of m.values()) banco.set(chave(zlib.crc32(d), d.length), d);
  return banco;
}
async function lerTudo(fonte, origem = 'ZIP', banco = null) {
  const z = await abrir(fonte);
  try {
    if (z.entradas.reduce((t, e) => t + e.tamanho, 0) > MAX_EXPANDIDO) throw new Error(`${origem}: excede o limite de 2 GB expandido`);
    const itens = new Map(), vistos = new Set();
    for (const e of z.entradas) {
      const n = nomeSeguro(e.nome);
      if (vistos.has(n.toLowerCase())) throw new Error('Nomes duplicados no ZIP: ' + n);
      vistos.add(n.toLowerCase());
      itens.set(n, (banco && banco.get(chave(e.crc, e.tamanho))) || await z.ler(e.nome));
    }
    return itens;
  } finally { z.fechar(); }
}
// Confere um ZIP gravado contra o conteudo esperado, um arquivo por vez (sem guardar tudo na memoria).
async function conferir(arquivo, esperado, prefixo = '') {
  const z = await abrir(arquivo);
  try {
    if (z.entradas.length !== esperado.size) return false;
    for (const e of z.entradas) { const d = esperado.get(nomeSeguro(e.nome).slice(prefixo.length)); if (!d || !d.equals(await z.ler(e.nome))) return false; }
    return true;
  } finally { z.fechar(); }
}

// Se o pacote vier com tudo dentro de uma unica pasta (ZIP de codigo-fonte), tira essa pasta.
function normalizarRaiz(itens) {
  const temModDesc = m => [...m.keys()].some(n => n.toLowerCase() === 'moddesc.xml');
  if (temModDesc(itens)) return { itens, prefixo: '' };
  const raizes = new Set([...itens.keys()].map(n => n.split('/')[0]));
  if (raizes.size === 1) {
    const prefixo = [...raizes][0] + '/';
    const menor = new Map([...itens].filter(([n]) => n.startsWith(prefixo)).map(([n, d]) => [n.slice(prefixo.length), d]));
    if (temModDesc(menor)) return { itens: menor, prefixo };
  }
  throw new Error('Pacote não contém modDesc.xml na raiz (nem em uma única pasta)');
}

function gravar(destino, itens) {
  return new Promise((ok, erro) => {
    const z = new yazl.ZipFile();
    for (const n of [...itens.keys()].sort()) z.addBuffer(itens.get(n), n, { compress: true });
    z.outputStream.pipe(fs.createWriteStream(destino)).on('close', ok).on('error', erro);
    z.outputStream.on('error', erro);
    z.end();
  });
}

module.exports = { abrir, lerTudo, bancoDe, conferir, normalizarRaiz, gravar, nomeSeguro, MAX_EXPANDIDO };
