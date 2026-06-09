# Lumi — companheira de I.A. na área de trabalho

**Lumi** é uma companheira 3D que vive na sua área de trabalho: um avatar VRM persistente, sempre no topo, que flutua sobre os outros programas, é arrastável, reage ao mouse — e tem um **cérebro de I.A. completo** integrado (conversa, vê, fala, ouve, lembra, age).

Inspirada no *Desktop Mate* (Steam), mas feita do zero e com I.A. de verdade no centro. Você traz seu próprio avatar (`.vrm`) e suas próprias chaves de API (BYOK — *bring your own key*).

**Stack:** Electron + Three.js + [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) (+ three-vrm-animation para `.vrma`).

---

## ✨ O que ela faz

### Avatar vivo
- Janela transparente, sem bordas, sempre no topo; **arrastável** (a janela segue o mouse).
- **Click-through inteligente:** clicar fora do corpo dela passa pros programas atrás; sobre o corpo, ela captura (sem o lag clássico de janela transparente — hit-test por cápsula O(1)).
- Pisca, respira, **olha pro cursor** (cabeça + olhos), sai do T-pose.
- **Animações `.vrma`** (idle, saudação, entediada, sentar, gestos aleatórios) — coloque na pasta `animations/`.
- **Emoções** faciais + animações (feliz/triste/bravo/surpresa/blush) disparadas pelo conteúdo da resposta.
- **Senta na barra de tarefas** ao arrastar pra baixo.

### Cérebro de I.A. (o "harness 2026")
- 💬 **Chat com streaming** + suporte a **raciocínio/thinking** (mostra o "💭 Pensando…").
- 🔌 **Multi-provedor BYOK:** qualquer endpoint OpenAI-compatível (OpenAI, OpenRouter, Qwen, Groq, DeepSeek, Ollama/local…) **+** Anthropic (Claude). Chave de API **opcional** (proxies locais sem auth funcionam).
- 🧰 **Agente com ferramentas (tool-calling)** + **sistema de permissões** (pergunta/permite/bloqueia por categoria, com "sempre permitir").
- 👁️ **Visão:** mande imagens no chat (anexar/colar) e ela enxerga (precisa de modelo multimodal).
- 🖥️ **Ver a tela:** ferramenta `see_screen` captura sua tela pra ela te ajudar com o que está vendo.
- 🎨 **Geração de imagens** (página dedicada + via chat) — provedor independente do chat.
- 🗣️ **Voz (TTS):** Edge (grátis, sem chave), **Google Gemini** (grátis em preview, vozes super expressivas que interpretam tags como `[laughs]`/`[whispering]`), **XTTS v2** (seu próprio servidor, ex.: Google Colab), ElevenLabs e OpenAI-compatível — com **lip-sync** real pela amplitude do áudio.
- 🎤 **Microfone (STT):** fale com ela (Whisper-compatível: Groq grátis / OpenAI / custom).
- 🧠 **Memória persistente:** fatos sobre você + histórico da conversa (em disco).
- 🗜️ **Contexto "infinito":** quando a conversa cresce, ela **resume** o histórico antigo automaticamente.
- 🍴 **Forkar conversa:** começa um chat novo e leve **mantendo o resumo** do anterior — e **arquiva** o histórico velho (não perde nada).
- 🏗️ **Modo arquiteto:** trabalha em um projeto (workspace) com **memória por projeto** (`.lumi-memory.md`), **editor Monaco** e **diffs no chat** ao editar arquivos.
- 🔧 **MCP (Model Context Protocol):** plugue servidores externos (busca web, GitHub, etc.) e ela ganha as ferramentas automaticamente.
- 📊 **Estatísticas:** tokens/seg, contexto e saída por resposta.
- 💾 **Perfis de configuração** (salva/carrega presets) + galeria de imagens geradas.

---

## 🚀 Como rodar

1. Instalar dependências (uma vez):
   ```
   npm install
   ```
2. Colocar um arquivo `.vrm` dentro da pasta `assets/` (baixe um grátis em https://hub.vroid.com).
   - Sem `.vrm`, o app mostra um objeto girando só pra provar que está funcionando.
3. (Opcional) Colocar animações `.vrma` em `animations/` (e emoções em `animations/emotions/`).
4. Rodar:
   ```
   npm start
   ```
   (`npm start` faz o build do renderer e abre o Electron. Para desenvolver com rebuild automático: `npm run watch` em outro terminal.)

### Configurar a I.A.
Abra as **Configurações** (engrenagem no avatar, ou menu da bandeja) e preencha provedor, URL base, chave (se precisar) e modelo. Use o botão 🔄 pra puxar a lista de modelos do endpoint. Tudo é salvo em `config.json` (veja abaixo).

---

## ⌨️ Atalhos e controles
- **Ctrl+Shift+C** — liga/desliga "atravessar cliques" (clicar nos programas atrás do avatar).
- **Ctrl+Shift+Q** — fecha o app (a janela não tem botão de fechar).
- **Clique direito no avatar** ou **ícone da bandeja** — menu com: Chat, Gerar imagem, Modo arquiteto, Workspace (editor), MCP, Galeria, Animações, Configurações, Nova conversa, Forkar conversa, Sair.
- **No chat:** 🍴 forkar · 🖼️ anexar imagem · 🎤 microfone · cole imagens com **Ctrl+V** · Enter envia.

---

## 🗂️ Estrutura do projeto
- `src/main/main.js` — processo principal: janela transparente, I.A. (provedores, agente, ferramentas, permissões), TTS/STT, MCP, memória, fork, captura de tela, bandeja e menus.
- `src/main/preload.js` — ponte segura (IPC) entre o processo principal e as telas.
- `src/renderer/main.js` — cena 3D: avatar, animações, olhar, emoções, lip-sync (empacotado por esbuild em `renderer.bundle.js`).
- `src/renderer/index.html` — o avatar + painel de configurações (em abas).
- `src/renderer/pages/` — janelas auxiliares: `chat.html`, `imagegen.html`, `architect.html`, `workspace.html` (editor Monaco), `mcp.html`, `gallery.html`, `animations.html`, `about.html`.
- `assets/` — coloque aqui seu(s) avatar(es) `.vrm`.
- `animations/` — animações `.vrma` (subpasta `emotions/` para expressões).

## 💾 Onde os dados ficam salvos
Na pasta `userData` do app (no Windows: `%APPDATA%/ai-desktop-mate/`):
- `config.json` — todas as configurações.
- `facts.json` — fatos memorizados sobre você (memória de longo prazo).
- `history.json` + `summary.txt` — histórico da conversa atual + resumo.
- `chats/chat_*.json` — conversas arquivadas pelo **fork**.
- `presets.json` — perfis de configuração.

Imagens geradas vão para `Imagens/Lumi/` (pasta Pictures do usuário).

---

## ⚠️ Notas
- **Modelo multimodal** é necessário para "ver imagens" e "ver a tela".
- **Edge TTS** é grátis e sem chave; se der `403`, a versão do Chromium embutida no protocolo pode precisar ser atualizada no código.
- **MCP / Monaco** baixam pacotes/CDN na primeira vez (precisa de internet).
- Uso de memória ~600–900 MB é majoritariamente *overhead* do Chromium/Electron — não dá pra igualar os ~100 MB do Desktop Mate nativo (Unity) sem trocar de engine.

## 🗺️ Roadmap
M1 "Ela existe" ✅ · M2 "Ela pensa" ✅ · M3 voz + lip-sync ✅ · M4 memória + personalidade ✅ · **M5 empacotamento / Steam** (em vista).

Ideias futuras: fallback de modelo, ferramentas no provider Anthropic, múltiplas conversas/threads + tela pra navegar nos chats arquivados, lembretes/timers, e busca offline.
