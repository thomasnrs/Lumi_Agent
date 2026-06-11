<div align="center">

<img src="assets/brand/lumi.svg" width="92" alt="Lumi" />

# Lumi

### Sua companheira de I.A. na área de trabalho

Um avatar 3D que vive no seu desktop — conversa, vê, fala, ouve, lembra…
**e programa como uma engenheira sênior.**

![Electron](https://img.shields.io/badge/Electron-31-47848F?logo=electron&logoColor=white)
![Three.js](https://img.shields.io/badge/Three.js-VRM-049EF4?logo=threedotjs&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-10%2F11-0078D6?logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-X11-FCC624?logo=linux&logoColor=black)
![BYOK](https://img.shields.io/badge/I.A.-BYOK%20multi--provedor-8A2BE2)

</div>

---

**Lumi** é uma companheira 3D persistente na sua área de trabalho: um avatar VRM sempre visível, arrastável e reativo, com um **harness de I.A. completo** integrado — chat multi-provedor, agente com ~40 ferramentas, multi-agentes paralelos, editor de código estilo VS Code com terminal embutido, voz, visão e memória.

Inspirada no *Desktop Mate* (Steam), construída do zero com a I.A. no centro. Você traz seu próprio avatar (`.vrm`) e suas próprias chaves (**BYOK** — *bring your own key*; proxies locais sem chave também funcionam).

> **Stack:** Electron · Three.js · [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) · xterm.js · Monaco

---

## ✨ Destaques

| | |
|---|---|
| 🧍 **Avatar vivo** | Janela transparente sempre no topo, click-through inteligente (clica através dela fora do corpo), olhos seguem o cursor, animações `.vrma`, emoções faciais reais, senta na barra de tarefas |
| 🧠 **I.A. multi-provedor** | Qualquer endpoint OpenAI-compatível (OpenAI, OpenRouter, Groq, DeepSeek, Qwen, Ollama…) + Anthropic. Streaming, thinking, visão, fallback automático de modelo |
| 🛠️ **Agente de verdade** | ~40 ferramentas nativas com sistema de permissões, turnos longos configuráveis (até 200 passos) com compactação automática de contexto, checkpoints com **desfazer** |
| 🤖 **Multi-agentes** | Orquestradora delega a uma equipe (Programador, Designer, Testador…) que trabalha **em paralelo**, cada um com suas ferramentas e instruções |
| 🖥️ **Workspace estilo VS Code** | Editor Monaco com abas, terminal integrado (PTY) com tracker de portas ao vivo, busca global, git status, menubar, chat lateral embutido |
| 🗣️ **Voz completa** | TTS grátis (Edge), Gemini (vozes expressivas), XTTS no seu servidor, ElevenLabs — com **lip-sync real**. STT Whisper-compatível pelo microfone |
| 💚 **Companheira proativa** | Lembretes falados ("me lembra em 20min…"), saudações, boas-vindas na volta, cuidado com pausas, papo espontâneo opcional — com a personalidade dela |
| 🎨 **Design refinado** | Tema 100% customizável, vidro acrílico nativo (Win11), barras de título customizadas, menus com blur, fonte própria |

---

## 🧰 Ferramentas da I.A. (tool calling)

A Lumi decide quando usar cada ferramenta. Tudo passa pelo **sistema de permissões** (perguntar / permitir / bloquear, por categoria).

### 📂 Arquivos & código
| Ferramenta | O que faz |
|---|---|
| `read_file` | Lê arquivos **paginado** (offset/limit) — navega arquivos de qualquer tamanho sem truncar |
| `edit_file` | Edição **cirúrgica**: substitui um trecho exato sem reescrever o arquivo |
| `write_file` / `append_file` | Cria/sobrescreve · acrescenta ao fim |
| `grep_files` | Busca texto/regex no projeto inteiro (arquivo + linha de cada match) |
| `list_dir` / `make_dir` / `delete_file` | Navegação e manutenção de arquivos |
| `read_project_memory` / `update_project_memory` | Memória por projeto (`.lumi-memory.md`) — o contexto sobrevive entre sessões |

### ⚡ Execução
| Ferramenta | O que faz |
|---|---|
| `run_command` | Comando rápido no shell (com saída de volta pra ela) |
| `run_in_terminal` | Processo **longo** (dev server, watch) num terminal visível — sem travar a conversa |
| `read_terminal` / `list_terminals` / `kill_terminal` | Acompanha a saída, lista e encerra terminais |

### 🌐 Web & rede
| Ferramenta | O que faz |
|---|---|
| `web_search` | Busca em cadeia **grátis e sem chave** (SearXNG próprio → instâncias públicas → DuckDuckGo) ou Tavily/Brave com chave |
| `fetch_url` | Abre páginas em **modo leitura** (HTML vira texto limpo, paginado) |
| `http_request` | GET/POST/PUT/PATCH/DELETE com headers e body — testa APIs, inclusive o servidor que ela mesma subiu |
| `see_page` | **Renderiza uma URL e enxerga o resultado** (screenshot → visão) — ela confere o site que criou no `localhost` |
| `open_url` | Abre links no navegador |

### 👁️ Visão & mídia
| Ferramenta | O que faz |
|---|---|
| `see_screen` | Captura sua tela e analisa o que você está vendo |
| `view_image` | Abre imagens do projeto (mockups, assets) como visão |
| `generate_image` | Gera imagens (provedor independente do chat; galeria integrada) |

### 🖱️ Controle do PC (computer use)
`screen_info` · `move_mouse` · `click` · `scroll` · `type_text` · `press_keys` · `focus_window` — ela vê a tela, clica e digita (categoria própria de permissão, supervisão recomendada).

### 💬 Interação & organização
| Ferramenta | O que faz |
|---|---|
| `ask_user` | **Pausa e pergunta pra você** com opções clicáveis antes de decisões importantes |
| `update_plan` | Checklist vivo no chat (`📋 Plano — 2/5`) que ela atualiza conforme trabalha |
| `set_reminder` / `list_reminders` / `cancel_reminder` | Lembretes falados na hora marcada (persistem ao reiniciar) |
| `remember_fact` / `recall_facts` | Memória de longo prazo sobre você |
| `delegate_to_agent` | Delega subtarefas à equipe de agentes (execução **paralela**) |
| `get_datetime` / `play_animation` | Data/hora · reações do avatar |

### 🔌 MCP (Model Context Protocol)
Plugue servidores MCP externos (GitHub, bancos, o que quiser) — as ferramentas deles aparecem pra Lumi automaticamente.

---

## 🦾 O modo dev (estilo Claude Code)

- **Modo arquiteto**: aponte um workspace e ela trabalha no projeto com memória própria, detecção de stack (Node, Python, Go, Rust, C#, Java… com boas práticas por linguagem) e comando de verificação sugerido.
- **Regras do repositório**: se o projeto tem `CLAUDE.md`, `AGENTS.md`, `.cursorrules` ou `copilot-instructions.md`, ela **segue à risca**.
- **Verificação automática**: após editar, roda o lint/test/build do projeto e **corrige sozinha** se falhar (até 3 tentativas).
- **Checkpoints**: cada turno que altera arquivos vira um ponto de restauração — botão **↩ desfazer** no chat.
- **Turnos de maratona**: teto de passos configurável (4–200) com compactação interna do contexto; se bater o teto, "continua" retoma do ponto exato.
- **Steering & Stop**: redirecione-a no meio da tarefa digitando, ou pare na hora com ⏹ (mantendo o progresso).
- **@menções e /comandos**: `@arquivo` anexa conteúdo do projeto; `/fork`, `/buscar`, `/tela`… O **arquivo ativo do editor** vira um chip no input e é anexado automaticamente a cada mensagem.
- **Fôlego visual**: diffs em cards com badges `+/-`, ações agrupadas em "🔧 N ações", plano fixo, indicador de digitação, busca na conversa (Ctrl+F) e regeneração da última resposta.

---

## 🚀 Como rodar

```bash
npm install
npm start          # builda o renderer e abre o Electron
```

1. Coloque um avatar `.vrm` em `assets/` (grátis em [VRoid Hub](https://hub.vroid.com)).
2. (Opcional) Animações `.vrma` em `animations/` — idle, saudação, sentar, gestos (emoções em `animations/emotions/`).
3. Abra as **Configurações** (engrenagem ⚙ no avatar ou bandeja) e configure provedor, modelo e chave.

> Os modelos `.vrm`/`.vrma` **não são versionados** (licenças de terceiros) — cada um traz os seus.

### Produção

```bash
npm run dist            # instalador NSIS (Windows) com código protegido
npm run dist -- --linux # AppImage + deb (rode no WSL2/Linux)
npm run pack            # build rápido sem instalador, pra teste
```

### Linux 🐧
Suporte **X11** (Wayland roda via XWayland, forçado automaticamente). Detalhes, dependências e o plano completo em [`port.md`](port.md).

---

## ⌨️ Atalhos

| Onde | Atalho | Ação |
|---|---|---|
| Global | `Ctrl+Shift+C` | Atravessar cliques (liga/desliga) |
| Global | `Ctrl+Shift+Q` | Sair |
| Chat | `Ctrl+F` | Buscar na conversa |
| Chat | `Enter` / `Shift+Enter` | Enviar / nova linha |
| Editor | `Ctrl+S` | Salvar |
| Editor | `` Ctrl+` `` | Terminal integrado |
| Editor | `Ctrl+Shift+F` | Buscar no projeto |
| Editor | `Ctrl+G` | Ir para a linha |

---

## 🗂️ Estrutura

```
src/
├── main/
│   ├── main.js        # processo principal: I.A. (provedores, agente, ferramentas,
│   │                  # permissões, multi-agentes), terminais PTY, TTS/STT, MCP,
│   │                  # memória, checkpoints, proatividade, janelas e bandeja
│   └── preload.js     # ponte segura (contextBridge/IPC)
└── renderer/
    ├── index.html     # avatar 3D + configurações (modo janela dedicada via ?settings=1)
    ├── main.js        # cena Three.js: VRM, animações, olhar, emoções, lip-sync
    └── pages/         # chat, workspace (Monaco + xterm), agentes, imagem, MCP,
                       # galeria, animações, sobre + design system compartilhado
```

### 💾 Dados (em `%APPDATA%/ai-desktop-mate/`)
`config.json` (configurações) · `facts.json` (memória de longo prazo) · `chats/*.json` (conversas com linha do tempo completa) · `presets.json` (perfis) · `reminders.json` (lembretes). Imagens geradas: `Imagens/Lumi/`. Memória por projeto: `<workspace>/.lumi-memory.md`.

---

## ⚠️ Notas

- "Ver" (imagens, tela, páginas) exige **modelo multimodal** (gpt-4o, Claude, Gemini, Qwen-VL…).
- O terminal integrado usa **PTY real** quando o `node-pty` compila (`npm run rebuild:pty`); senão cai automaticamente num modo compatível.
- Monaco e MCP baixam dependências na primeira execução (internet necessária uma vez).
- Consumo de ~600–900 MB de RAM é majoritariamente overhead do Chromium — é o preço do Electron.

## 🗺️ Roadmap

✅ Avatar vivo · ✅ I.A. multi-provedor · ✅ Voz + lip-sync · ✅ Memória & personalidade · ✅ Agente + multi-agentes · ✅ Workspace/terminal · ✅ Proatividade · 🔜 Wizard de primeiro uso · 🔜 Auto-update + CI · 🔜 i18n (EN) · 🎯 **Steam**

---

<div align="center">

Feito com 💜 por [@thomasnrs](https://github.com/thomasnrs) — com a ajuda da própria Lumi.

</div>
