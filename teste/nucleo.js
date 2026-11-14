// Teste do nucleo sem rede: monta um mod ficticio (base oficial, instalado com edicoes, versao nova)
// e confere a simulacao. Uso: npm run teste
const fs = require('fs'), path = require('path'), assert = require('assert');
const zip = require('../src/core/zip'), mods = require('../src/core/mods'), ops = require('../src/core/operacoes'), github = require('../src/core/github');

const tmp = path.join(__dirname, 'tmp'); fs.rmSync(tmp, { recursive: true, force: true });
const pastaMods = path.join(tmp, 'mods'), trabalho = path.join(tmp, 'trabalho'), pacotes = path.join(tmp, 'pacotes');
[pastaMods, trabalho, pacotes].forEach(p => fs.mkdirSync(p, { recursive: true }));
const B = t => Buffer.from(t, 'utf8');
const lua = (l2, l8) => ['-- mod', l2, 'c', 'd', 'e', 'f', 'g', l8, 'i', ''].join('\n');
const desc = v => `<modDesc><version>${v}</version><!-- https://github.com/Fulano/FS25_Ficticio --></modDesc>`;
const en = extra => `<l10n><texts><text name="a" text="A"/>${extra}</texts></l10n>`;

(async () => {
  const base = new Map([['modDesc.xml', B(desc('1.0.0.0'))], ['main.lua', B(lua('b', 'h'))], ['outro.xml', B('<x>\n1\n</x>\n')], ['l10n/l10n_en.xml', B(en(''))], ['apagado.txt', B('x')], ['icon.dds', B('\0bin')]]);
  const seu = new Map(base); seu.set('main.lua', B(lua('b -- minha correcao', 'h'))); seu.set('outro.xml', B('<x>\nMEU\n</x>\n'));
  seu.set('l10n/l10n_br.xml', B('<l10n><texts><text name="a" text="Á"/></texts></l10n>')); seu.delete('apagado.txt'); seu.set('meu.lua', B('-- so meu'));
  const novo = new Map(base); novo.set('modDesc.xml', B(desc('1.1.0.0'))); novo.set('main.lua', B(lua('b', 'h -- autor')));
  novo.set('outro.xml', B('<x>\nAUTOR\n</x>\n')); novo.set('l10n/l10n_en.xml', B(en('<text name="nova" text="N"/>'))); novo.set('novo.lua', B('n'));
  await zip.gravar(path.join(pastaMods, 'FS25_Ficticio.zip'), seu);
  await zip.gravar(path.join(pacotes, 'base.zip'), base);
  // pacote novo dentro de uma pasta unica, como um ZIP de codigo-fonte
  await zip.gravar(path.join(pacotes, 'novo.zip'), new Map([...novo].map(([n, d]) => ['FS25_Ficticio-1.1/' + n, d])));
  const antes = await ops.sha256Arquivo(path.join(pastaMods, 'FS25_Ficticio.zip'));

  // catalogo
  const { achados } = await mods.procurarLinks(pastaMods);
  assert.deepStrictEqual(achados.map(a => [a.mod, a.repo, a.evidencia, a.confiavel]), [['FS25_Ficticio.zip', 'https://github.com/Fulano/FS25_Ficticio', 'modDesc.xml', true]]);
  assert.strictEqual(mods.importarCSV('﻿Mod;Repositorio_GitHub;Evidencia;Observacao\nA.zip;https://github.com/x/y;modDesc.xml;"Link; obs"\n').length, 1);

  // simulacao com base (tres vias)
  const r = await ops.simular({ pastaMods, pastaTrabalho: trabalho, mod: 'FS25_Ficticio.zip', repo: 'https://github.com/Fulano/FS25_Ficticio', pacoteLocal: path.join(pacotes, 'novo.zip'), baseLocal: path.join(pacotes, 'base.zip') });
  assert.strictEqual(r.version_local, '1.0.0.0'); assert.strictEqual(r.version_remota_moddesc, '1.1.0.0');
  assert.strictEqual(r.prefixo_removido_do_pacote, 'FS25_Ficticio-1.1/');
  assert.deepStrictEqual(r.suas_edicoes, { alterados: ['main.lua', 'outro.xml'], adicionados: ['l10n/l10n_br.xml', 'meu.lua'], removidos: ['apagado.txt'] });
  assert.deepStrictEqual(r.edicoes_mescladas, ['main.lua']); assert.deepStrictEqual(r.edicoes_mantidas, ['meu.lua']);
  assert.deepStrictEqual(r.conflitos_de_edicao.map(c => c.arquivo), ['outro.xml']);
  assert.deepStrictEqual(r.conflitos_de_edicao[0].blocos, [{ linhaOriginal: 2, linhaSua: 2, linhaAutor: 2, original: ['1'], seu: ['MEU'], autor: ['AUTOR'] }]);
  assert.ok(fs.readFileSync(path.join(r.pasta, 'conflitos.txt'), 'utf8').includes('VOCÊ (linha 2 do seu arquivo)'));
  assert.deepStrictEqual(r.traducoes_brasileiras_preservadas, ['l10n/l10n_br.xml']);
  assert.deepStrictEqual(r.traducoes_faltando.map(t => [t.arquivo, t.chaves]), [['l10n/l10n_br.xml', ['nova']]]);
  assert.strictEqual(r.status, 'REVISAO_OBRIGATORIA'); assert.ok(r.original_intacto);
  const previa = await zip.lerTudo(r.preview);
  assert.strictEqual(previa.get('main.lua').toString(), lua('b -- minha correcao', 'h -- autor'));
  assert.strictEqual(previa.get('outro.xml').toString(), '<x>\nAUTOR\n</x>\n'); assert.ok(!previa.has('apagado.txt')); assert.ok(previa.has('novo.lua'));
  assert.strictEqual(fs.readFileSync(path.join(r.pasta, 'suas_versoes', 'outro.xml'), 'utf8'), '<x>\nMEU\n</x>\n');

  // sem base: so a traducao e preservada, e os arquivos alterados ficam para revisao
  const s = await ops.simular({ pastaMods, pastaTrabalho: trabalho, mod: 'FS25_Ficticio.zip', repo: 'Fulano/FS25_Ficticio', pacoteLocal: path.join(pacotes, 'novo.zip') });
  assert.strictEqual(s.base_oficial, null); assert.deepStrictEqual(s.traducoes_brasileiras_preservadas, ['l10n/l10n_br.xml']);
  assert.ok(s.arquivos_sensiveis_para_revisao.includes('main.lua'));

  // travas
  await assert.rejects(ops.simular({ pastaMods, pastaTrabalho: path.join(pastaMods, 'dentro'), mod: 'FS25_Ficticio.zip', repo: 'a/b', pacoteLocal: path.join(pacotes, 'novo.zip') }), /dentro da pasta de mods/);
  assert.throws(() => mods.destino(trabalho, '..', 'mods', 'x.zip'), /fora da pasta de trabalho/);
  await zip.gravar(path.join(pacotes, 'ruim.zip'), new Map([['modDesc.xml', B(desc('2'))], ['a/../../fora.txt', B('x')]])).catch(() => {});
  assert.strictEqual(await ops.sha256Arquivo(path.join(pastaMods, 'FS25_Ficticio.zip')), antes);
  assert.deepStrictEqual(fs.readdirSync(pastaMods), ['FS25_Ficticio.zip']);

  // backup, auditoria offline, lista de simulacoes, versoes
  const cat = [{ mod: 'FS25_Ficticio.zip', repo: 'https://github.com/Fulano/FS25_Ficticio' }, { mod: 'Sumiu.zip', repo: 'https://github.com/a/b' }];
  const bk = await ops.backupBR({ pastaMods, pastaTrabalho: trabalho, catalogo: cat }); assert.strictEqual(bk.arquivos, 1);
  const au = await ops.auditar({ pastaMods, pastaTrabalho: trabalho, catalogo: cat, online: false });
  assert.deepStrictEqual(au.linhas.map(l => l.status), ['nao_verificado', 'ausente']); assert.strictEqual(au.linhas[0].versaoLocal, '1.0.0.0');
  assert.strictEqual((await ops.listarSimulacoes(trabalho)).length, 2);
  assert.strictEqual(github.comparar('1.3.0.7', 'v1.3.0.8'), -1); assert.strictEqual(github.comparar('1.2.0.0', 'FS25_1.2.0.0'), 0);
  assert.strictEqual(github.comparar('2.0.0.0', 'release-1.9'), 1); assert.strictEqual(github.comparar('1.0', 'latest'), null);
  assert.strictEqual(github.escolherAsset({ assets: [{ name: 'FS25_Ficticio.zip' }, { name: 'docs.zip' }] }, 'FS25_Ficticio.zip').motivo, 'nome_exato');
  assert.strictEqual(github.escolherAsset({ assets: [{ name: 'a.zip' }, { name: 'b.zip' }] }, 'FS25_Ficticio.zip').asset, null);
  // traducao BR editada por voce e pelo autor em linhas diferentes: junta as duas
  const br = (a, z) => B(['<l10n>', `<text name="a" text="${a}"/>`, '<text name="b" text="B"/>', '<text name="c" text="C"/>', `<text name="z" text="${z}"/>`, '</l10n>', ''].join('\n'));
  const m2 = [['modDesc.xml', B(desc('1.0.0.0'))], ['l10n/l10n_br.xml', br('A', 'Z')]];
  await zip.gravar(path.join(pacotes, 'b2.zip'), new Map(m2));
  await zip.gravar(path.join(pastaMods, 'FS25_Dois.zip'), new Map([m2[0], ['l10n/l10n_br.xml', br('MINHA', 'Z')]]));
  await zip.gravar(path.join(pacotes, 'n2.zip'), new Map([['modDesc.xml', B(desc('1.0.1.0'))], ['l10n/l10n_br.xml', br('A', 'AUTOR')]]));
  const t = await ops.simular({ pastaMods, pastaTrabalho: trabalho, mod: 'FS25_Dois.zip', repo: 'a/b', pacoteLocal: path.join(pacotes, 'n2.zip'), baseLocal: path.join(pacotes, 'b2.zip') });
  assert.deepStrictEqual(t.edicoes_mescladas, ['l10n/l10n_br.xml']); assert.strictEqual(t.status, 'PREVIA_GERADA_REVISAR');
  assert.ok((await zip.lerTudo(t.preview)).get('l10n/l10n_br.xml').equals(br('MINHA', 'AUTOR')));
  // pre-lancamentos: o beta so vale se for mais novo que o estavel, e so e alvo quando o mod segue o beta
  const rel = (tag, data, pre) => ({ tag_name: tag, published_at: data, prerelease: pre, assets: [{ name: 'FS25_X.zip' }] });
  const sep = github.separar([rel('v0.9', '2026-01-01', true), rel('v0.12.0.0', '2026-06-01', true), rel('v0.10.0.8', '2026-03-01', false)]);
  assert.strictEqual(sep.estavel.tag_name, 'v0.10.0.8'); assert.strictEqual(sep.pre.tag_name, 'v0.12.0.0');
  assert.strictEqual(github.separar([rel('v1', '2026-03-01', false), rel('v0.9', '2026-01-01', true)]).pre, null);
  const lin = () => ({ versaoLocal: '0.10.0.8', estavel: { tag: 'v0.10.0.8', asset: 'a.zip' }, pre: { tag: 'v0.12.0.0', asset: 'a.zip' } });
  const semBeta = ops.aplicarCanal(lin(), false), comBeta = ops.aplicarCanal(lin(), true);
  assert.deepStrictEqual([semBeta.status, semBeta.tag, semBeta.tagBeta], ['em_dia', 'v0.10.0.8', 'v0.12.0.0']);
  assert.deepStrictEqual([comBeta.status, comBeta.tag, comBeta.usandoBeta], ['atualizacao', 'v0.12.0.0', true]);
  console.log('nucleo: tudo certo');
})().catch(e => { console.error('FALHOU:', e); process.exit(1); });
