# Mapa de módulos

## Core

| Módulo | Responsabilidade |
|---|---|
| lifecycle | Inicialização, rollback e descarte ordenado |
| container | Dependências explícitas e detecção de ciclos |
| event-bus | Eventos internos com unsubscribe e ownership |
| errors | Erros normalizados e serializáveis |
| logging | Logs estruturados, redaction e rotação |
| metrics | Timings, event-loop lag, CPU e memória |
| scheduler | Timers canceláveis e clock injetável |

## Domínios do main

| Domínio | Conteúdo-alvo |
|---|---|
| config | Configuração, profiles, migrations e defaults |
| persistence | Escrita atômica, backups e recuperação |
| chats | Sessões, histórico, timeline, fork e archive |
| memory | Facts, memória de projeto, diário e artefatos |
| ai-providers | Streaming, modelos, rate limit, retry e usage |
| context | Construção, orçamento, compactação e arquivos ativos |
| agent-runtime | Loop, steering, conclusão, planos e checkpoints |
| tools | Registry, schemas, execução, resultados e anti-loop |
| permissions | Políticas, prompts e decisões persistidas |
| subagents | Delegação, paralelismo, worktrees e merge |
| code-engines | Claude Code, Codex e motores CLI |
| workspace | Paths, árvore, busca, encoding, watcher e mutações |
| git | Status, diff, commits, branches, stash e worktrees |
| terminal | PTY, buffers, processos, portas e ownership |
| remote | SSH, SSHFS, servidor remoto e contexto de execução |
| system-monitor | Logs do SO, processos, correlação e alertas |
| integrations | MCP, Docker, GitHub, databases, REST e live server |
| media | Imagem, galeria, captura e geração |
| voice | TTS, STT, dispositivos e playback |
| design-library | Presets, DESIGN.md e integração contextual |
| windows-avatar | Janelas, avatar, tray, menus, hover e atalhos |
| updater | Releases, canais, download, rollback e saúde |

## Borda Electron

| Adapter | Responsabilidade |
|---|---|
| electron-ipc | Registry único, validação e roteamento |
| electron-windows | BrowserWindow, ownership e watchdog |
| node-filesystem | Filesystem local e operações atômicas |
| node-processes | Spawn, exec, PTY e sinais |
| network | Fetch, timeout, proxy e rate limiter |
| databases | Drivers opcionais e conexões descartáveis |
| platform | Windows, Linux e macOS |

## Renderer

| Feature | Responsabilidade |
|---|---|
| shell | Navegação, janelas e tema compartilhado |
| chat | Lista virtualizada, composer, timeline e stats |
| workspace | Explorer, Monaco, painéis e terminal |
| avatar | Render 3D, animações e orçamento de FPS |
| settings | Configuração, providers, agentes e gráficos |
| auxiliary-pages | Memória, MCP, imagens, tarefas e wizard |
