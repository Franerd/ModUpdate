# ModUpdate

Mantém atualizados os mods de Farming Simulator 25 que têm repositório no GitHub **sem perder o que você editou neles**: traduções PT-BR, correções de conflito com outros mods, arquivos que você adicionou.

> **Versão de testes: só simulação.** O app lê a pasta de mods e nunca grava nela. O resultado de cada atualização é um ZIP de prévia, com relatório, dentro da pasta de trabalho.

## Como funciona

1. **Catálogo** — *Procurar mods com GitHub* lê os mods da pasta e anota o repositório de cada um. Link achado no `modDesc.xml` apontando para um repositório `FS25_*` entra direto; os outros ficam como sugestão para você conferir.
2. **Verificar no GitHub** — compara a versão instalada com o último lançamento de cada repositório. Se o GitHub não responder (limite de consultas), o mod aparece como *Sem resposta*, nunca como desatualizado.
3. **Simular** — para um mod com atualização:
   - baixa o lançamento oficial da **mesma versão que está instalada** e compara com o seu ZIP: a diferença é o que você editou;
   - aplica a versão nova arquivo por arquivo: só você mexeu → fica o seu; só o autor mexeu → fica o novo; os dois mexeram em trechos diferentes → junta; os dois mexeram no mesmo trecho → **conflito** (fica o do autor e a sua versão é guardada em `suas_versoes`);
   - traduções `l10n_br.xml` / `translation_br.xml` são sempre as suas, e o relatório lista os textos novos que ainda não têm tradução;
   - confere o hash do mod instalado antes e depois.
   
   Quando o autor não publicou o lançamento da versão instalada, não dá para saber o que é edição sua: o app avisa, preserva só as traduções e lista os arquivos que mudaram.
4. **Backup das traduções** — copia todos os arquivos PT-BR dos mods do catálogo para a pasta de trabalho.

Pasta de trabalho (padrão `Documentos\ModUpdate`): `Simulacoes\`, `Backups_PTBR\`, `Auditoria_*.csv`. O catálogo, as pastas escolhidas e o token do GitHub (opcional, sobe o limite de 60 para 5.000 consultas por hora) ficam só no seu PC, em `%APPDATA%\ModUpdate`.

## Versões do app

- Cada versão nova sai como **teste** (Actions → *Publicar versão* → canal `teste`). Só o app com a chave de administrador recebe.
- Aprovada, **Painel ADM → Promover** faz o FraNerdServer baixar o instalador, conferir o hash e entregar como versão oficial. **Voltar versão** desfaz.
- O servidor fica em [`servidor/`](servidor) e é instalado com `servidor/instalar.ps1` (tarefa agendada "ModUpdate Servidor", porta 8791 só em 127.0.0.1/::1, atrás do túnel da Cloudflare). Não guarda segredo: da chave de administrador fica só o hash.

## Desenvolvimento

```powershell
npm install
npm run teste      # testa o núcleo com um mod fictício, sem rede
npm start          # roda o app
npm run dist       # gera o instalador em dist/ (sem publicar)
```

- `src/core/` — `zip.js` (leitura segura de ZIP), `github.js`, `mods.js` (catálogo e trava de gravação), `operacoes.js` (auditoria, backup, simulação)
- `src/main.js`, `src/preload.js`, `src/ui/` — app Electron
- `servidor/` — ModUpdate Servidor
