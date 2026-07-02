const { app, BrowserWindow, ipcMain, globalShortcut, screen, Menu, Tray, nativeImage, session, shell, dialog, desktopCapturer, clipboard } = require('electron');
const path = require('path');
// Em produção (empacotado) os recursos ficam em process.resourcesPath; em dev, na raiz.
function resBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
}
const fs = require('fs');
// marca oficial da Lumi (✦, gerada pelo `npm run icon`); se faltar, cai no icone.png da raiz (mascote)
const BRAND_ICON = path.join(resBase(), 'assets', 'brand', 'lumi-mark.png');
const ICON_PATH = fs.existsSync(BRAND_ICON) ? BRAND_ICON : path.join(resBase(), 'icone.png');
const url = require('url');
const crypto = require('crypto');
const WebSocket = require('ws');
const { exec, spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile); // args como array — sem dor de cabeça com aspas no Windows

// ---- LOG DE DEBUG do processo principal: userData/lumi.log (rotaciona em ~512KB) ----
function logd(...parts) {
  try {
    const line =
      new Date().toISOString() + ' ' + parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ') + '\n';
    const fp = path.join(app.getPath('userData'), 'lumi.log');
    try {
      if (fs.statSync(fp).size > 512 * 1024) fs.renameSync(fp, fp + '.old'); // mantém no máx ~1MB (atual+old)
    } catch (e) {
      /* primeiro log */
    }
    fs.appendFileSync(fp, line);
  } catch (e) {
    /* logging nunca derruba nada */
  }
  if (!app.isPackaged) console.log('[lumi]', ...parts);
}
process.on('uncaughtException', (e) => logd('UNCAUGHT', String((e && e.stack) || e)));
process.on('unhandledRejection', (e) => logd('UNHANDLED-REJECTION', String((e && e.stack) || e)));

// Windows: o PTY (conpty/winpty) precisa do CAMINHO RESOLVIDO do executável —
// "ssh"/"docker" sem .exe dão "file not found". Resolve via `where` (com cache).
const exeCache = new Map();
function resolveExe(cmd) {
  if (/[\\/]/.test(cmd)) return cmd; // já é um caminho
  if (process.platform === 'win32' && /\.(exe|bat|cmd)$/i.test(cmd)) return cmd;
  if (exeCache.has(cmd)) return exeCache.get(cmd);
  let out = process.platform === 'win32' ? cmd + '.exe' : cmd; // Linux: execvp resolve via PATH se tudo falhar
  try {
    const finder = process.platform === 'win32' ? 'where ' + cmd : 'command -v ' + cmd;
    const opts = { windowsHide: true, timeout: 4000 };
    if (process.platform !== 'win32') opts.shell = '/bin/sh'; // `command` é builtin do shell
    const lines = require('child_process').execSync(finder, opts).toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    // Windows: prefere um executável de verdade (o `where` lista shims sem extensão primeiro, ex.: docker)
    const r = process.platform === 'win32' ? lines.find((l) => /\.(exe|cmd|bat)$/i.test(l)) || lines[0] : lines[0];
    if (r) out = r;
  } catch (e) {
    logd('resolveExe: não achei', cmd);
  }
  exeCache.set(cmd, out);
  return out;
}

// ---- LINUX: flags necessárias pra janela transparente do avatar (não afetam Windows) ----
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-transparent-visuals'); // transparência no X11
  app.commandLine.appendSwitch('ozone-platform', 'x11'); // força XWayland (Wayland nativo quebra cursor global + posicionamento)
}
const IS_LINUX = process.platform === 'linux';

// hook global de mouse (opcional) - para o anti-lag. Se falhar, segue sem ele.
let uIOhook = null;
try {
  uIOhook = require('uiohook-napi').uIOhook;
} catch (e) {
  console.error('uiohook indisponivel (segue sem o anti-lag):', e.message);
}
const hookOk = !!uIOhook;

let win;
let tray;
let cursorTimer;
let lockPassthrough = false; // trava manual: atravessa cliques sempre (Ctrl+Shift+C / menu)
// Click-through inteligente: ignora cliques fora do corpo dela.
// LINUX: começa CAPTURADO (clicável) — se o polling global do cursor funcionar, o hover
// inteligente assume e devolve o click-through; se não funcionar (Wayland etc.), a janela
// segue usável em vez de ficar 100% inclicável. Ctrl+Shift+C atravessa quando quiser.
let hoverIgnore = IS_LINUX ? false : true;

// LINUX: fonte global de cursor via uiohook (XRecord). O getCursorScreenPoint fica
// ESTÁTICO sob XWayland (só enxerga o cursor sobre janelas X11) — o hook entrega
// o movimento global de verdade e devolve o click-through inteligente.
let linuxCursor = { x: 0, y: 0 };
let linuxCursorAt = 0; // timestamp do último movimento vindo do hook
let linuxHookCursor = false;
function startLinuxCursorHook() {
  if (!IS_LINUX || !hookOk || linuxHookCursor) return;
  try {
    uIOhook.on('mousemove', (e) => {
      linuxCursor = { x: e.x, y: e.y };
      linuxCursorAt = Date.now();
    });
    uIOhook.start();
    linuxHookCursor = true;
  } catch (e) {
    console.error('[lumi/linux] hook de cursor indisponível:', e.message);
  }
}

// estado do hook global de mouse
let cursorOverBody = false; // cursor sobre o corpo da avatar (vem do renderer)
let footPixelY = 0; // posicao dos pes em pixels (vem do renderer, p/ sentar na taskbar)
let dragging = false;
let dragStartCursor = { x: 0, y: 0 };
let dragStartWin = { x: 0, y: 0 };

// Aplica o click-through. COM o hook: so captura sobre a UI ou durante o arrasto;
// sobre o corpo fica atravessavel = SEM lag. SEM o hook: comportamento antigo.
function applyIgnore() {
  if (!win || win.isDestroyed()) return;
  win.setIgnoreMouseEvents(lockPassthrough || (hoverIgnore && !dragging));
}

// Envia um evento para TODAS as janelas (avatar + janela de chat)
// Entrega também a IFRAMES (subframes) — webContents.send sozinho só alcança o frame
// principal; o chat embutido no editor da workspace é um iframe e precisa receber tudo.
// ---- linha do tempo do chat (persiste tool_calls/agentes/diffs pra não sumirem ao reiniciar) ----
// ============================================================
//  SESSÕES DE CONVERSA (base do paralelismo): todo o estado de um turno vive
//  numa Session. O AsyncLocalStorage carrega a sessão pelo contexto assíncrono
//  do turno — código fora de turno (IPC, timers) cai na sessão de PRIMEIRO
//  PLANO (fgSession), que é a conversa que as janelas "seguidoras" exibem.
// ============================================================
const { AsyncLocalStorage } = require('async_hooks');
const sessionALS = new AsyncLocalStorage();
function makeSession(id) {
  return {
    id: id || '', // chatId desta sessão
    workspace: null, // pasta em que a IA trabalha NESTA sessão (janela de workspace própria)
    running: false, // turno em andamento?
    abort: null, // AbortController do turno (botão Stop)
    steerQueue: [], // mensagens enviadas DURANTE o processamento (steering)
    editedSinceTurn: false, // p/ verificação automática
    cp: null, // checkpoint do turno em andamento {id, ts, files}
    toolCallLog: [], // anti-loop { key, error, S().stateSeq }
    stateSeq: 0, // avança quando algo MUDA o estado (escrita/comando)
    readFilesThisTurn: new Set(), // guarda "leia antes de editar"
    history: [],
    convSummary: '',
    chatEvents: [], // [{a: nº de msgs no S().history quando ocorreu, t: tipo, d: dados, ts}]
    chatArchive: [], // mensagens antigas compactadas (só exibição)
    worklog: [],
    currentTurnLog: null,
    lastTurnContext: null, // último turno técnico completo (reinjetado no prompt seguinte)
    pendingTurnTranscript: null,
    claudeSessionId: '',
    claudeSessionWorkspace: '',
    claudeQuery: null, // Query do Agent SDK em andamento NESTA sessão (Stop interrompe só ela)
  };
}
let fgSession = makeSession(''); // sessão de primeiro plano
const sessions = new Map(); // chatId -> Session viva (para turnos paralelos em janelas presas)
function S() {
  return sessionALS.getStore() || fgSession;
}
// mensagens antigas COMPACTADAS saem do contexto do modelo mas ficam aqui pra UI não "perder" nada
// (sessionizado: agora vive em makeSession/S())
function slimVal(v, depth) {
  // versão enxuta pra salvar em disco: corta strings gigantes e troca imagens por marcador
  if (typeof v === 'string') return v.length > 4000 ? v.slice(0, 4000) + '…[cortado no histórico]' : v;
  if (Array.isArray(v)) return depth > 3 ? '[…]' : v.slice(0, 30).map((x) => slimVal(x, (depth || 0) + 1));
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) {
      if (k === 'images' || k === '_image') { o[k] = '[imagem]'; continue; }
      o[k] = slimVal(v[k], (depth || 0) + 1);
    }
    return o;
  }
  return v;
}
function logChatEvent(channel, payload) {
  try {
    if (channel === 'chat:user' || channel === 'chat:done') {
      // carimbo de hora da mensagem recém-adicionada ao S().history (sem duplicar)
      const a = S().history.length - 1;
      if (a >= 0 && !S().chatEvents.some((e) => e.t === 'mts' && e.a === a)) S().chatEvents.push({ a, t: 'mts', ts: Date.now() });
      return;
    }
    const map = { 'chat:tool': 'tool', 'chat:tool-result': 'result', 'chat:agent': 'agent', 'chat:diff': 'diff', 'chat:note': 'note', 'chat:plan': 'plan', 'chat:ask': 'ask', 'chat:ask-done': 'askdone' };
    const t = map[channel];
    if (!t) return;
    S().chatEvents.push({ a: S().history.length, t, d: slimVal(payload, 0), ts: Date.now() });
    if (S().chatEvents.length > 400) S().chatEvents = S().chatEvents.slice(-400);
  } catch (e) {
    /* nunca pode derrubar o broadcast */
  }
}

// ---- multi-janela de chat ----
// winChat: webContents.id -> chatId FIXO (janela destacada de uma conversa), ou '*' / ausente = segue a
// conversa ATIVA (janela principal e chat embutido no editor). Assim eventos chat:* de uma conversa
// não vazam pra janelas destacadas de OUTRA conversa.
const winChat = new Map();
function senderChatId(e) {
  const v = winChat.get(e.sender.id);
  return v && v !== '*' ? v : currentChatId;
}

// multi-janela de WORKSPACE: cada janela = sua própria pasta + seu próprio chat + a IA
// trabalhando NAQUELA pasta. winWorkspace: webContents.id -> pasta.
//  - Handlers do EDITOR usam wsCfg(e) → resolvem a pasta DA JANELA (mesmo sem ser a sessão ativa).
//  - As ferramentas da IA seguem `S().workspace` (a pasta da sessão que está rodando o turno).
//    Como só roda 1 turno por vez (serializado), isso é sempre bem definido e não conflita.
// Sem binding = pasta global (comportamento atual, retrocompatível).
const winWorkspace = new Map();
// (sessionizado: agora vive em makeSession/S())
function wsCfg(e) {
  const cfg = loadConfig();
  const ws = e && e.sender && winWorkspace.get(e.sender.id);
  if (ws) return { ...cfg, workspace: ws }; // janela do editor: sua própria pasta
  if (S().workspace) return { ...cfg, workspace: rawWorkspace() }; // janela primária: pasta real (não a da sessão em turno)
  return cfg;
}

// id de roteamento da sessão que está EMITINDO (fg segue o ponteiro currentChatId)
function emitSid() {
  const s = S();
  return s === fgSession ? currentChatId : s.id;
}
// envia para as janelas certas: presas (winChat) recebem SÓ a sua conversa;
// seguidoras/avatar recebem só a de PRIMEIRO PLANO — turnos paralelos não vazam entre janelas
function sendToAllFor(sid, channel, ...args) {
  const chatScoped = typeof channel === 'string' && channel.indexOf('chat:') === 0;
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w.isDestroyed()) return;
    if (chatScoped) {
      const v = winChat.get(w.webContents.id);
      if (v && v !== '*') {
        if (v !== sid) return; // janela presa: só eventos da SUA conversa
      } else if (sid && sid !== currentChatId) {
        return; // seguidoras (e avatar): só a conversa de primeiro plano
      }
    }
    try {
      const frames = w.webContents.mainFrame.framesInSubtree; // frame principal + todos os iframes
      for (const f of frames) {
        try {
          f.send(channel, ...args);
        } catch (e) {
          /* frame pode ter sido descartado */
        }
      }
    } catch (e) {
      // fallback (versões antigas do Electron): pelo menos o frame principal
      try {
        w.webContents.send(channel, ...args);
      } catch (_) {}
    }
  });
}
function sendToAll(channel, ...args) {
  sendToAllFor(emitSid(), channel, ...args);
}
// envia para UMA janela específica (por webContents.id) — terminais por janela usam isto
function sendToWc(wcId, channel, ...args) {
  if (wcId == null) return sendToAll(channel, ...args);
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.id !== wcId) continue;
    try {
      for (const f of w.webContents.mainFrame.framesInSubtree) {
        try {
          f.send(channel, ...args);
        } catch (e) {
          /* frame descartado */
        }
      }
    } catch (e) {
      try {
        w.webContents.send(channel, ...args);
      } catch (_) {}
    }
    return;
  }
}

// BATCHING dos tokens de stream: modelos cospem dezenas de eventos/s e cada um viraria
// um IPC × janelas × iframes. Juntamos ~24ms de texto num envio só (imperceptível a olho)
// e QUALQUER outro evento descarrega os tokens pendentes antes — a ordem nunca muda.
// Com PARALELISMO, o batch é POR SESSÃO (sid) — streams simultâneos não se misturam.
const tokBatch = new Map(); // sid -> { token, thinking, agents: Map }
let tokFlushTimer = null;
function tokBucket(sid) {
  let b = tokBatch.get(sid);
  if (!b) {
    b = { token: '', thinking: '', agents: new Map() };
    tokBatch.set(sid, b);
  }
  return b;
}
function flushTokenBatch() {
  if (tokFlushTimer) {
    clearTimeout(tokFlushTimer);
    tokFlushTimer = null;
  }
  if (!tokBatch.size) return;
  for (const [sid, b] of tokBatch) {
    if (b.thinking) sendToAllFor(sid, 'chat:thinking', b.thinking);
    if (b.token) sendToAllFor(sid, 'chat:token', b.token);
    for (const [agent, t] of b.agents) sendToAllFor(sid, 'chat:agent-token', { agent, t });
  }
  tokBatch.clear();
}
function scheduleTokenFlush() {
  if (!tokFlushTimer) tokFlushTimer = setTimeout(flushTokenBatch, 24);
}

function broadcast(channel, ...args) {
  if (channel === 'chat:token') {
    tokBucket(emitSid()).token += args[0] || '';
    scheduleTokenFlush();
    return;
  }
  if (channel === 'chat:thinking') {
    tokBucket(emitSid()).thinking += args[0] || '';
    scheduleTokenFlush();
    return;
  }
  if (channel === 'chat:agent-token') {
    const d = args[0] || {};
    const b = tokBucket(emitSid());
    b.agents.set(d.agent, (b.agents.get(d.agent) || '') + (d.t || ''));
    scheduleTokenFlush();
    return;
  }
  flushTokenBatch(); // tokens pendentes saem ANTES de tool/done/erro etc. (ordem preservada)
  logChatEvent(channel, args[0]); // grava na linha do tempo do chat (na sessão que emitiu)
  if (channel === 'workspace:changed') liveNotifyReload(); // arquivos mudaram → live server recarrega as páginas
  sendToAll(channel, ...args);
}

// ============================================================
//  Configuracao (BYOK - o usuario traz a propria chave)
// ============================================================
const DEFAULT_CONFIG = {
  provider: 'openai', // 'openai' (compativel), 'anthropic' ou 'opencode' (Zen/Go com roteamento automatico)
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o-mini',
  temperature: 0.8,
  // voz (TTS)
  ttsProvider: 'off', // 'off' | 'edge' | 'gemini' | 'xtts' | 'elevenlabs' | 'openai'
  ttsApiKey: '',
  ttsVoice: '',
  ttsModel: '',
  ttsBaseUrl: '', // URL do servidor de voz (XTTS no Colab/cloudflared, ou OpenAI-compativel)
  gfxQuality: 'balanced', // 'performance' | 'balanced' | 'quality'
  avatarScale: 1, // tamanho da janela/avatar (1 = padrao; scroll do mouse ou config ajusta)
  pageOpacity: {}, // opacidade por pagina (ex.: { chat: 0.9 }) - controle em cada janela
  winBounds: {}, // memória de tamanho/posição por janela (reabre como estava)
  theme: {}, // cores customizadas da UI (tokens CSS) - editor na aba Tema
  acrylic: true, // efeito vidro nativo do Windows 11 nas janelas (se disponivel)
  sounds: true, // sons sutis do chat (enviar/receber) - toggle no painel rapido
  modelsCache: {}, // cache da lista de modelos por provedor (evita refazer a busca)
  favorites: [], // modelos favoritos: [{ preset: <nome do perfil|null>, model }] — sobem no topo do seletor
  toolsEnabled: true, // ferramentas/agente (requer modelo compativel)
  memoryEnabled: true, // memoria persistente (fatos no contexto + historico em disco)
  architectMode: false, // modo arquiteto (codigo) com memoria por workspace
  codeEngine: 'native', // 'native' | 'claude-code' — no Modo Arquiteto, Claude Code pode assumir o chat
  claudeCodeModel: 'sonnet', // alias do Claude Code: sonnet | opus | haiku (ou id completo)
  claudeCodePermissionMode: 'default', // default | auto | acceptEdits | plan
  claudeCodeEffort: 'high', // low | medium | high | xhigh | max
  claudeCodePrompt: '', // instruções extras do usuário anexadas ao prompt Lumi + Claude Code
  workspace: '', // pasta do projeto atual
  selectedVrm: '', // personagem escolhido (nome do .vrm em assets/; vazio = o primeiro)
  autoVerify: false, // após editar arquivos, roda o comando de verificação e corrige se falhar
  verifyCommand: '', // comando de verificação (vazio = detecta da stack: npm test, pytest...)
  preciousFiles: ['icone.png'], // GUARDRAILS: arquivos que a IA NUNCA apaga/sobrescreve
  formatOnSave: false, // após a IA editar, roda o formatter do projeto (prettier/black/gofmt/rustfmt) se disponível
  selfReview: false, // antes de finalizar um turno que mexeu em código, um agente revisa o diff
  imageModel: 'sourceful/riverflow-v2.5-fast:free', // modelo para gerar imagens (OpenRouter)
  imageBaseUrl: '', // provedor de imagem (vazio = usa o do chat)
  imageApiKey: '', // chave do provedor de imagem (vazio = usa a do chat)
  // busca na web
  searchProvider: 'duckduckgo', // 'tavily' (preciso) | 'brave' | 'duckduckgo' (grátis: searxng+ddg)
  searchApiKey: '',
  searxUrl: '', // URL do SearXNG próprio (opcional — busca ilimitada sem chave)
  fallbackModel: '', // modelo reserva: se o principal falhar no meio do turno, continua neste
  // modelo para TAREFAS INTERNAS (compactação/resumo, mensagem de commit, revisão de diff, PR,
  // SQL, fala proativa) — aponte pra um modelo barato/grátis pra não queimar a API paga do chat.
  // Campos vazios = herdam do chat (mesmo comportamento de image*/tts*).
  taskProvider: '', // '' = mesmo do chat | openai | anthropic
  taskBaseUrl: '',
  taskApiKey: '',
  taskModel: '', // '' = usa o modelo do chat
  proactivity: 'normal', // off | low (saudação+lembretes) | normal (+volta/pausa) | high (+papo espontâneo)
  reactApps: false, // opt-in: ela percebe o app em foco (só nome/título) e comenta — Windows e Linux/X11
  watchServer: false, // opt-in: vigia o servidor remoto montado (disco cheio / serviço caído) e avisa
  logSentinel: 'off', // 🛡️ sentinela de logs do SISTEMA: 'off' | 'notify' (avisa erros novos a cada 30min) | 'fix' (avisa + CARD de confirmação — só investiga com o SIM do usuário)
  maxSteps: 48, // teto de passos (chamadas de ferramenta) por turno — depende do provedor/modelo
  contextWindow: 128000,
  compactAtPct: 80,
  responseReserveTokens: 8192,
  recentLiteralTokens: 24000,
  codeBudgetPct: 35,
  includeActiveTab: true, // anexa o arquivo ativo do editor a cada mensagem do chat (chip liga/desliga)
  // permissoes por tipo de ferramenta: 'ask' (pergunta) | 'allow' (libera) | 'deny' (bloqueia)
  perms: { read: 'ask', write: 'ask', delete: 'ask', exec: 'ask', network: 'ask', open: 'allow', mcp: 'ask', screen: 'ask', control: 'ask' },
  mcpServers: {}, // servidores MCP (ferramentas externas plugaveis)
  // MULTI-AGENTES: orquestrador delega subtarefas a agentes especializados
  agentsEnabled: false,
  agents: [
    {
      name: 'Pesquisador',
      description: 'Busca informações atuais na web e resume com fontes.',
      systemPrompt:
        'Você é um pesquisador meticuloso. Use web_search para encontrar informações atuais e confiáveis; abra/leia as fontes mais relevantes quando precisar de detalhe. Entregue um resumo claro e objetivo com os pontos principais e CITE as URLs usadas. Diga quando algo for incerto.',
      model: '',
      temperature: 0.4,
      tools: ['web_search', 'fetch_url', 'open_url', 'get_datetime'],
    },
    {
      name: 'Programador',
      description: 'Implementa: lê o projeto, escreve código e verifica.',
      systemPrompt:
        'Você é uma engenheira de software sênior. Implemente a tarefa de ponta a ponta: localize com find_in_code/grep_files, leia só o necessário (read_file com symbol/around_line), faça a mudança mínima seguindo o padrão do projeto, e VERIFIQUE em escada — get_problems após editar, run_tests com filter no que mexeu. Antes de concluir, olhe git_diff (o que VOCÊ mudou). Ao final, resuma: o que mudou, como verificou (comando + resultado) e pendências. Nunca afirme sucesso sem evidência.',
      model: '',
      temperature: 0.3,
      tools: ['list_dir', 'read_file', 'edit_file', 'grep_files', 'outline', 'find_usages', 'env_info', 'git_status', 'git_diff', 'git_log', 'run_tests', 'get_problems', 'locate_stack', 'apply_patch', 'db_schema', 'db_query', 'write_file', 'append_file', 'make_dir', 'delete_file', 'run_command', 'run_in_terminal', 'read_terminal', 'list_terminals', 'kill_terminal', 'web_search', 'read_project_memory', 'update_project_memory', 'http_request'],
    },
    {
      name: 'Revisor',
      description: 'Revisa código/textos (somente leitura) e aponta melhorias.',
      systemPrompt:
        'Você é um revisor crítico e construtivo. Baseie a revisão em EVIDÊNCIA: comece por git_diff/git_status (o que mudou de fato) e git_log (contexto recente); rode get_problems pra erros objetivos; use locate_stack se houver traceback. Aponte bugs, riscos, segurança/performance e melhorias CONCRETAS (com o porquê, o arquivo:linha e como corrigir). Priorize o que importa; ignore estilo/nitpick. NÃO altere arquivos — apenas analise e recomende.',
      model: '',
      temperature: 0.3,
      tools: ['list_dir', 'read_file', 'grep_files', 'outline', 'find_usages', 'git_status', 'git_diff', 'git_log', 'get_problems', 'locate_stack', 'read_project_memory'],
    },
    {
      name: 'Testador',
      description: 'Escreve e roda testes; relata o que passou/falhou.',
      systemPrompt:
        'Você é uma engenheira de QA. Entenda o que precisa ser testado, escreva testes claros (seguindo o framework do projeto) e RODE-OS com run_tests usando filter no arquivo/teste específico (rápido e barato; run_command só quando precisar de um comando exato). Relate o que passou e o que falhou com a CAUSA provável (locate_stack ajuda a apontar a linha). Não conserte o código de produção sem ser pedido — foque em cobrir e diagnosticar.',
      model: '',
      temperature: 0.3,
      tools: ['list_dir', 'read_file', 'edit_file', 'grep_files', 'git_status', 'git_diff', 'run_tests', 'get_problems', 'locate_stack', 'write_file', 'append_file', 'run_command', 'run_in_terminal', 'read_terminal', 'read_project_memory', 'http_request'],
    },
    {
      name: 'Refatorador',
      description: 'Melhora o código SEM mudar o comportamento.',
      systemPrompt:
        'Você é uma engenheira especialista em refatoração. Melhore legibilidade, organização e qualidade SEM alterar o comportamento externo. Mudanças pequenas e seguras, no padrão do projeto — e PROVE que nada quebrou: get_problems + run_tests(filter) após cada mudança; confira o git_diff antes de concluir. Explique cada melhoria brevemente (o quê + porquê).',
      model: '',
      temperature: 0.3,
      tools: ['list_dir', 'read_file', 'edit_file', 'grep_files', 'outline', 'find_usages', 'git_status', 'git_diff', 'run_tests', 'get_problems', 'locate_stack', 'apply_patch', 'write_file', 'append_file', 'run_command', 'read_project_memory', 'update_project_memory'],
    },
    {
      name: 'Designer',
      description: 'Cria interfaces web bonitas, modernas e criativas (HTML/CSS/UI).',
      systemPrompt:
        'Você é uma Web Designer & front-end de altíssimo nível, com olho afiado para estética, tipografia e detalhe. Você cria interfaces MODERNAS, BONITAS e CRIATIVAS — jamais o visual "padrão sem graça".\n\n' +
        '## Processo\n' +
        '1) Defina um CONCEITO/direção (mood, personalidade da marca, referência) ANTES de codar.\n' +
        '2) Monte um SISTEMA DE DESIGN com tokens (CSS variables): paleta, escala tipográfica, escala de espaçamento (base 4/8px), raios e sombras — e reutilize.\n' +
        '3) Construa com HTML semântico + CSS moderno (flex/grid, clamp(), container queries quando útil).\n' +
        '4) Capriche nos ESTADOS (hover/focus/active/disabled), na responsividade (mobile-first) e em micro-interações.\n\n' +
        '## Estética (faça LINDO)\n' +
        '- Tipografia: pareie uma fonte de display com personalidade + uma de texto limpa; escala modular; clamp() para tamanhos fluidos; bom line-height e largura de linha (~60–75 caracteres).\n' +
        '- Cor: paleta deliberada (1 cor de marca/destaque + neutros bem escolhidos), contraste AA, dark mode; gradientes/mesh sutis; use oklch quando possível.\n' +
        '- Layout: espaçamento generoso (respiro), hierarquia visual clara, alinhamento impecável; explore bento grids e composições assimétricas equilibradas.\n' +
        '- Profundidade & polimento: sombras suaves em camadas, cantos arredondados consistentes, bordas sutis (1px translúcida), glassmorphism/blur com bom gosto.\n' +
        '- Movimento: transições suaves (transform/opacity), hover e scroll-reveals tasteful; respeite prefers-reduced-motion.\n' +
        '- Imagens: gere visuais de qualidade com generate_image quando fizer sentido (heróis, texturas, ilustrações), com tratamento consistente — nada de clip-art.\n\n' +
        '## Tendências atuais (use com bom gosto, sem exagero)\n' +
        'tipografia grande e marcante, gradientes/aurora sutis, glassmorphism, bento grids, dark mode, micro-animações, cantos arredondados, neumorfismo leve, minimalismo sofisticado com bastante respiro.\n\n' +
        '## Obrigatório\n' +
        'Acessibilidade (HTML semântico, foco visível, contraste, alt em imagens, navegação por teclado) e performance (assets otimizados, font-display: swap).\n\n' +
        'NUNCA entregue: visual genérico de framework cru, cores que brigam, layout apertado, espaçamento inconsistente, parede de texto. Antes de finalizar, revise com olhar crítico: "isto está bonito, coeso e profissional?". Use web_search para buscar referências/tendências atuais quando precisar de inspiração. Explique brevemente as decisões de design.',
      model: '',
      temperature: 0.7,
      tools: ['list_dir', 'read_file', 'edit_file', 'grep_files', 'write_file', 'append_file', 'make_dir', 'web_search', 'generate_image', 'read_project_memory', 'see_page', 'view_image'],
    },
  ],
  // voz do usuario (STT) e dispositivos de audio
  sttProvider: 'off', // 'off' | 'openai' (compativel: /audio/transcriptions)
  sttApiKey: '',
  sttBaseUrl: '',
  sttModel: '',
  audioInput: '', // deviceId do microfone (vazio = padrao)
  audioOutput: '', // deviceId do alto-falante (vazio = padrao)
  systemPrompt:
    'Você é a Lumi, uma companheira virtual que vive na área de trabalho do usuário — ' +
    'simpática, divertida, curiosa e um pouco brincalhona, com personalidade própria e um carinho genuíno por quem fala com você. ' +
    'Mas você também é extremamente capaz: ajuda com código, arquivos, pesquisa na web, imagens, ver/controlar a tela e o que mais precisar — usando suas ferramentas de forma proativa para REALMENTE resolver, não só conversar. ' +
    'No papo do dia a dia, seja curta, natural e calorosa (como num chat). Quando o assunto for trabalho/técnico, fique focada, precisa e organizada — sem perder o bom humor. ' +
    'Fale SEMPRE o mesmo idioma do usuário. Se não souber algo, admita e vá descobrir (pesquise/leia) em vez de inventar.',
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

// CACHE do config: loadConfig é chamado ~70 lugares (loops, handlers, cada passo do agente).
// Valida por mtime — statSync é ~20x mais barato que ler+parsear; edição manual do
// config.json continua sendo detectada. Sempre devolve uma CÓPIA (semântica antiga:
// quem mutar o objeto não envenena o cache).
let cfgCache = null; // { mtimeMs, value }
let _cfgLastStat = 0; // micro-TTL: loadConfig roda em loops apertados — 1 statSync a cada 150ms basta
function loadConfig() {
  try {
    const now = Date.now();
    if (!cfgCache || now - _cfgLastStat > 150) {
      const mt = fs.statSync(configPath()).mtimeMs;
      _cfgLastStat = now;
      if (!cfgCache || cfgCache.mtimeMs !== mt) {
        cfgCache = { mtimeMs: mt, value: { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) } };
      }
    }
    const v = { ...cfgCache.value };
    if (S().workspace) v.workspace = S().workspace; // durante um turno, a IA trabalha na pasta da sessão ativa
    return v;
  } catch (e) {
    const v = { ...DEFAULT_CONFIG };
    if (S().workspace) v.workspace = S().workspace;
    return v;
  }
}
// pasta REAL do config (ignora o override de sessão) — pra não persistir a pasta da sessão como global
function rawWorkspace() {
  return (cfgCache && cfgCache.value && cfgCache.value.workspace) || '';
}

function saveConfig(cfg) {
  const toSave = { ...cfg };
  // blindagem: a pasta da sessão ativa NUNCA deve ser gravada como workspace global do config.json
  if (S().workspace && toSave.workspace === S().workspace) toSave.workspace = rawWorkspace();
  fs.writeFileSync(configPath(), JSON.stringify(toSave, null, 2));
  try {
    cfgCache = { mtimeMs: fs.statSync(configPath()).mtimeMs, value: { ...DEFAULT_CONFIG, ...toSave } };
  } catch (e) {
    cfgCache = null; // na dúvida, o próximo loadConfig relê do disco
  }
}

// ============================================================
//  Adaptadores de I.A. (streaming)
// ============================================================

// Le um stream SSE (Server-Sent Events) e chama onData para cada linha "data:"
async function readSSE(res, onData) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) onData(line.slice(5).trim());
    }
  }
}

// Converte o histórico interno (formato OpenAI) pro formato COMPLETO da Anthropic,
// incluindo ferramentas: assistant.tool_calls → blocos tool_use, role:"tool" → blocos
// tool_result (consecutivos se fundem num único turno de usuário, como a API espera).
function convertToAnthropic(messages) {
  let system = '';
  const out = [];
  const pushUser = (blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === 'user') last.content.push(...blocks);
    else out.push({ role: 'user', content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string' && m.content) system += (system ? '\n\n' : '') + m.content;
      continue;
    }
    if (m.role === 'tool') {
      pushUser([
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id,
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        },
      ]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks = [];
      if (typeof m.content === 'string' && m.content.trim()) blocks.push({ type: 'text', text: m.content });
      if (Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          const input = parseToolArguments(tc.function && tc.function.arguments);
          blocks.push({ type: 'tool_use', id: tc.id, name: (tc.function && tc.function.name) || 'tool', input });
        }
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
      continue;
    }
    // user: string ou array (texto + imagens dataURL → blocos image base64)
    if (typeof m.content === 'string') {
      if (m.content.trim()) pushUser([{ type: 'text', text: m.content }]);
      continue;
    }
    const blocks = [];
    for (const p of m.content || []) {
      if (p.type === 'image_url') {
        const mt = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url);
        if (mt) blocks.push({ type: 'image', source: { type: 'base64', media_type: mt[1], data: mt[2] } });
      } else if (p.text && p.text.trim()) {
        blocks.push({ type: 'text', text: p.text });
      }
    }
    pushUser(blocks);
  }
  // a conversa precisa começar com um turno de usuário
  if (!out.length || out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(início da conversa)' }] });
  return { system, msgs: out };
}

// ---- Fallback: tool calls em TEXTO (modelos sem function-calling nativo) ----
// Modelos menores/locais (qwen, llama via Ollama/LM Studio…) costumam cuspir o JSON
// da ferramenta no TEXTO da resposta em vez de usar o campo tool_calls da API.
// Estas funções detectam esses JSONs e os convertem em toolCalls de verdade —
// só rodam quando NÃO veio tool_call nativo, então não afetam os modelos normais.

// extrai objetos {...} de nível raiz, balanceando chaves e ignorando aspas/escape
function extractBalancedObjects(text) {
  const objs = [];
  let depth = 0,
    start = -1,
    inStr = false,
    esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          objs.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  return objs;
}

// normaliza um objeto parseado pra { name, arguments } se bater com uma ferramenta conhecida
function normToolObj(o, names) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  // formato OpenAI aninhado: { function: { name, arguments } }
  if (o.function && typeof o.function === 'object') {
    let args = o.function.arguments;
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args);
      } catch (e) {
        args = {};
      }
    }
    return names.has(o.function.name) ? { name: o.function.name, arguments: args || {} } : null;
  }
  const name = o.name || o.tool || o.tool_name || o.action || o.function_name;
  if (!name || !names.has(name)) return null;
  let args = o.arguments != null ? o.arguments : o.parameters != null ? o.parameters : o.args != null ? o.args : o.input != null ? o.input : o.params;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch (e) {
      args = {};
    }
  }
  return { name, arguments: args && typeof args === 'object' ? args : {} };
}

// parseia uma string JSON candidata e devolve [{name, arguments}] das ferramentas válidas
function tryParseToolObj(jsonStr, names) {
  let v;
  try {
    v = JSON.parse(jsonStr);
  } catch (e) {
    return [];
  }
  const out = [];
  const consider = (x) => {
    const n = normToolObj(x, names);
    if (n) out.push(n);
  };
  if (Array.isArray(v)) v.forEach(consider);
  else if (v && Array.isArray(v.tool_calls)) v.tool_calls.forEach(consider);
  else consider(v);
  return out;
}

// varre o texto por tool calls em JSON (fenced ```json, <tool_call>…</tool_call> ou objeto solto)
function harvestInlineToolCalls(text, tools) {
  if (!text || !text.includes('{')) return { toolCalls: [], text: text || '' };
  const names = new Set((tools || []).map((t) => (t.function && t.function.name) || t.name).filter(Boolean));
  if (!names.size) return { toolCalls: [], text };
  const candidates = [];
  let m;
  const fence = /```(?:json|tool_call|tool)?\s*([\s\S]*?)```/gi;
  while ((m = fence.exec(text))) candidates.push({ raw: m[0], json: m[1].trim() });
  const tagRe = /<tool_call>\s*([\s\S]*?)<\/tool_call>/gi;
  while ((m = tagRe.exec(text))) candidates.push({ raw: m[0], json: m[1].trim() });
  extractBalancedObjects(text).forEach((obj) => candidates.push({ raw: obj, json: obj }));

  const found = [];
  let clean = text;
  for (const c of candidates) {
    const parsed = tryParseToolObj(c.json, names);
    if (parsed.length) {
      parsed.forEach((p) => found.push(p));
      clean = clean.split(c.raw).join(''); // remove o bloco do texto visível
    }
  }
  const toolCalls = found.map((p, i) => ({
    id: 'inline_' + Date.now() + '_' + i,
    name: p.name,
    arguments: JSON.stringify(p.arguments || {}),
  }));
  return { toolCalls, text: clean.trim() };
}

// fecha uma rodada: se NÃO veio tool_call nativo, tenta achar tool calls em texto
function finishTurn(text, toolCalls, usage, t0, tools) {
  if (!toolCalls.length) {
    const inline = harvestInlineToolCalls(text, tools);
    if (inline.toolCalls.length) {
      return { text: inline.text, toolCalls: inline.toolCalls, usage, ms: Date.now() - t0, inlineTools: true };
    }
  }
  return { text, toolCalls, usage, ms: Date.now() - t0 };
}

// Uma "rodada" na API Anthropic COM FERRAMENTAS (tool use) — espelho do openaiTurn:
// streaming SSE, tool_use montado via input_json_delta, e devolve o MESMO contrato
// { text, toolCalls:[{id,name,arguments:<string JSON>}], usage, ms, aborted } pra
// encaixar direto no loop do agente. Sem temperature: modelos novos (Opus 4.7+) rejeitam.
async function anthropicTurn(cfg, messages, tools, onToken, onThink) {
  const t0 = Date.now();
  const base = (cfg.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const { system, msgs } = convertToAnthropic(messages);
  const body = { model: requestModel(cfg), max_tokens: 8192, messages: msgs, stream: true };
  if (system) body.system = system;
  if (tools && tools.length) {
    // formato Anthropic: {name, description, input_schema} (sem o wrapper "function")
    body.tools = tools.map((t) => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));
  }
  const res = await fetch(base + '/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
    signal: S().abort ? S().abort.signal : undefined, // botão Stop
  });
  if (!res.ok) throw new Error(`Anthropic HTTP ${res.status}: ${await res.text()}`);

  let text = '';
  const toolCalls = []; // indexado pelo índice do bloco (buracos são filtrados no fim)
  let usage = null;
  let inputTokens = 0;
  try {
    await readSSE(res, (data) => {
      let j;
      try {
        j = JSON.parse(data);
      } catch (e) {
        return;
      }
      if (j.type === 'message_start' && j.message && j.message.usage) {
        inputTokens = j.message.usage.input_tokens || 0;
      } else if (j.type === 'content_block_start' && j.content_block) {
        if (j.content_block.type === 'tool_use') {
          toolCalls[j.index] = { id: j.content_block.id, name: j.content_block.name, arguments: '' };
        }
      } else if (j.type === 'content_block_delta' && j.delta) {
        const d = j.delta;
        if (d.type === 'text_delta' && d.text) {
          text += d.text;
          onToken(d.text);
        } else if (d.type === 'input_json_delta') {
          const tc = toolCalls[j.index];
          if (tc) tc.arguments += d.partial_json || '';
        } else if (d.type === 'thinking_delta' && d.thinking && onThink) {
          onThink(d.thinking);
        }
      } else if (j.type === 'message_delta' && j.usage) {
        const outTok = j.usage.output_tokens || 0;
        usage = { prompt_tokens: inputTokens, completion_tokens: outTok, total_tokens: inputTokens + outTok };
      }
    });
  } catch (e) {
    // botão Stop: devolve o parcial em vez de estourar erro (mesmo contrato do openaiTurn)
    if (S().abort && S().abort.signal.aborted) {
      return { text, toolCalls: toolCalls.filter(Boolean), usage, ms: Date.now() - t0, aborted: true };
    }
    throw e;
  }
  return finishTurn(text, toolCalls.filter(Boolean), usage, t0, tools);
}

// ---- OpenCode Zen / Go ----------------------------------------------------
// O gateway do OpenCode publica vários protocolos sob a mesma Base URL:
// GPT -> Responses API; Claude/Qwen (e alguns modelos Go) -> Anthropic;
// Gemini -> Google GenerateContent; modelos abertos restantes -> Chat Completions.
// O usuário escolhe só o modelo e a Lumi roteia para o protocolo certo.
function openCodeProtocol(model, baseUrl) {
  const m = String(model || '').toLowerCase().replace(/^opencode(?:-go)?\//, '');
  if (/^gpt-/.test(m)) return 'responses';
  if (/^gemini-/.test(m)) return 'gemini';
  if (/^(claude-|qwen)/.test(m)) return 'anthropic';
  if (/\/zen\/go(?:\/|$)/i.test(String(baseUrl || '')) && /^minimax-m(?:3|2\.7|2\.5)$/.test(m)) return 'anthropic';
  return 'openai';
}

function requestModel(cfg) {
  const model = String(cfg.model || '');
  return cfg.provider === 'opencode' ? model.replace(/^opencode(?:-go)?\//i, '') : model;
}

function turnAdapter(cfg) {
  if (cfg.provider === 'anthropic') return anthropicTurn;
  if (cfg.provider === 'opencode') {
    const protocol = openCodeProtocol(cfg.model, cfg.baseUrl);
    if (protocol === 'responses') return responsesTurn;
    if (protocol === 'gemini') return geminiTurn;
    if (protocol === 'anthropic') return anthropicTurn;
  }
  return openaiTurn;
}

function convertToResponses(messages) {
  let instructions = '';
  const input = [];
  const messageContent = (role, content) => {
    if (typeof content === 'string') return content;
    const parts = [];
    for (const p of content || []) {
      if (p.type === 'image_url' && role === 'user') {
        parts.push({ type: 'input_image', image_url: p.image_url && p.image_url.url });
      } else if (p.text) {
        parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: p.text });
      }
    }
    return parts;
  };
  for (const m of messages) {
    if (m.role === 'system') {
      const text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
      if (text) instructions += (instructions ? '\n\n' : '') + text;
      continue;
    }
    if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.tool_call_id,
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m._responsesItems) && m._responsesItems.length) {
      input.push(...m._responsesItems);
      continue;
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      if (typeof m.content === 'string' && m.content.trim()) input.push({ role: 'assistant', content: m.content });
      for (const tc of m.tool_calls) {
        input.push({
          type: 'function_call',
          call_id: tc.id,
          name: (tc.function && tc.function.name) || 'tool',
          arguments: safeToolArguments(tc.function && tc.function.arguments),
        });
      }
      continue;
    }
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    input.push({ role, content: messageContent(role, m.content) });
  }
  return { instructions, input };
}

async function responsesTurn(cfg, messages, tools, onToken, onThink) {
  const t0 = Date.now();
  const base = (cfg.baseUrl || 'https://opencode.ai/zen/v1').replace(/\/$/, '');
  const { instructions, input } = convertToResponses(messages);
  const body = { model: requestModel(cfg), input, stream: true };
  if (instructions) body.instructions = instructions;
  if (tools && tools.length) {
    body.tools = tools.map((t) => ({
      type: 'function',
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
      strict: false,
    }));
  }
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(base + '/responses', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: S().abort ? S().abort.signal : undefined,
  });
  if (!res.ok) throw new Error(`OpenCode Responses HTTP ${res.status}: ${await res.text()}`);

  let text = '';
  let usage = null;
  const calls = new Map();
  let responseItems = [];
  const callFor = (j) => {
    const item = j.item || {};
    const key = j.item_id || item.id || item.call_id || String(j.output_index || calls.size);
    let tc = calls.get(key);
    if (!tc) {
      tc = { id: item.call_id || item.id || 'oc_' + Date.now() + '_' + calls.size, name: item.name || '', arguments: '' };
      calls.set(key, tc);
    }
    return tc;
  };
  try {
    await readSSE(res, (data) => {
      if (!data || data === '[DONE]') return;
      let j;
      try {
        j = JSON.parse(data);
      } catch (e) {
        return;
      }
      if (j.type === 'response.output_text.delta' && j.delta) {
        text += j.delta;
        onToken(j.delta);
      } else if ((j.type === 'response.reasoning_text.delta' || j.type === 'response.reasoning_summary_text.delta') && j.delta && onThink) {
        onThink(j.delta);
      } else if (j.type === 'response.output_item.added' && j.item && j.item.type === 'function_call') {
        const tc = callFor(j);
        tc.name = j.item.name || tc.name;
        tc.arguments = j.item.arguments || tc.arguments;
      } else if (j.type === 'response.function_call_arguments.delta') {
        callFor(j).arguments += j.delta || '';
      } else if (j.type === 'response.output_item.done' && j.item && j.item.type === 'function_call') {
        const tc = callFor(j);
        tc.name = j.item.name || tc.name;
        if (j.item.arguments) tc.arguments = j.item.arguments;
        responseItems.push(j.item);
      } else if (j.type === 'response.output_item.done' && j.item) {
        responseItems.push(j.item);
      } else if (j.type === 'response.completed' && j.response && j.response.usage) {
        const u = j.response.usage;
        if (!responseItems.length && Array.isArray(j.response.output)) responseItems = j.response.output;
        usage = {
          prompt_tokens: u.input_tokens || 0,
          completion_tokens: u.output_tokens || 0,
          total_tokens: u.total_tokens || (u.input_tokens || 0) + (u.output_tokens || 0),
        };
      } else if (j.type === 'error') {
        throw new Error((j.error && j.error.message) || j.message || 'erro no stream Responses');
      }
    });
  } catch (e) {
    if (S().abort && S().abort.signal.aborted) {
      return { text, toolCalls: [...calls.values()], usage, responseItems, ms: Date.now() - t0, aborted: true };
    }
    throw e;
  }
  const out = finishTurn(text, [...calls.values()].filter((tc) => tc.name), usage, t0, tools);
  out.responseItems = responseItems;
  return out;
}

function convertToGemini(messages) {
  let system = '';
  const contents = [];
  const toolNames = new Map();
  const push = (role, parts) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') system += (system ? '\n\n' : '') + m.content;
      continue;
    }
    if (m.role === 'tool') {
      let response = m.content;
      try {
        response = JSON.parse(m.content);
      } catch (e) {
        response = { result: m.content };
      }
      if (!response || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
      push('user', [{ functionResponse: { id: m.tool_call_id, name: toolNames.get(m.tool_call_id) || 'tool', response } }]);
      continue;
    }
    const parts = [];
    if (typeof m.content === 'string') {
      if (m.content) parts.push({ text: m.content });
    } else {
      for (const p of m.content || []) {
        if (p.type === 'image_url') {
          const mt = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url || '');
          if (mt) parts.push({ inlineData: { mimeType: mt[1], data: mt[2] } });
        } else if (p.text) parts.push({ text: p.text });
      }
    }
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const args = parseToolArguments(tc.function && tc.function.arguments);
        const name = (tc.function && tc.function.name) || 'tool';
        toolNames.set(tc.id, name);
        parts.push({ functionCall: { id: tc.id, name, args } });
      }
    }
    push(m.role === 'assistant' ? 'model' : 'user', parts);
  }
  return { system, contents };
}

async function geminiTurn(cfg, messages, tools, onToken, onThink) {
  const t0 = Date.now();
  const base = (cfg.baseUrl || 'https://opencode.ai/zen/v1').replace(/\/$/, '');
  const model = requestModel(cfg);
  const { system, contents } = convertToGemini(messages);
  const body = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (tools && tools.length) {
    body.tools = [{
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      })),
    }];
  }
  if (cfg.temperature != null) body.generationConfig = { temperature: Number(cfg.temperature) };
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['x-goog-api-key'] = cfg.apiKey;
  const res = await fetch(`${base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: S().abort ? S().abort.signal : undefined,
  });
  if (!res.ok) throw new Error(`OpenCode Gemini HTTP ${res.status}: ${await res.text()}`);

  let text = '';
  let usage = null;
  const toolCalls = [];
  const seenCalls = new Set();
  try {
    await readSSE(res, (data) => {
      let j;
      try {
        j = JSON.parse(data);
      } catch (e) {
        return;
      }
      for (const part of (((j.candidates || [])[0] || {}).content || {}).parts || []) {
        if (part.text) {
          if (part.thought && onThink) onThink(part.text);
          else {
            text += part.text;
            onToken(part.text);
          }
        }
        if (part.functionCall) {
          const fc = part.functionCall;
          const sig = (fc.id || '') + '|' + fc.name + '|' + JSON.stringify(fc.args || {});
          if (!seenCalls.has(sig)) {
            seenCalls.add(sig);
            toolCalls.push({
              id: fc.id || 'gemini_' + Date.now() + '_' + toolCalls.length,
              name: fc.name,
              arguments: JSON.stringify(fc.args || {}),
            });
          }
        }
      }
      if (j.usageMetadata) {
        const u = j.usageMetadata;
        usage = {
          prompt_tokens: u.promptTokenCount || 0,
          completion_tokens: u.candidatesTokenCount || 0,
          total_tokens: u.totalTokenCount || (u.promptTokenCount || 0) + (u.candidatesTokenCount || 0),
        };
      }
    });
  } catch (e) {
    if (S().abort && S().abort.signal.aborted) {
      return { text, toolCalls, usage, ms: Date.now() - t0, aborted: true };
    }
    throw e;
  }
  return finishTurn(text, toolCalls, usage, t0, tools);
}

// ============================================================
//  AGENTE: ferramentas (tool calling) + loop
// ============================================================
function factsPath() {
  return path.join(app.getPath('userData'), 'facts.json');
}
function loadFacts() {
  try {
    return JSON.parse(fs.readFileSync(factsPath(), 'utf8'));
  } catch (e) {
    return [];
  }
}
function saveFacts(f) {
  fs.writeFileSync(factsPath(), JSON.stringify(f, null, 2));
}

// ---- memoria persistente: historico da conversa em disco ----
function historyPath() {
  return path.join(app.getPath('userData'), 'history.json');
}
function loadHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(historyPath(), 'utf8'));
    return Array.isArray(h) ? h : [];
  } catch (e) {
    return [];
  }
}
// para salvar leve: troca imagens (base64) por um marcador de texto
function sanitizeForSave(h) {
  return h.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const text = (m.content || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ');
    const imgs = (m.content || []).filter((p) => p.type === 'image_url').length;
    return { role: m.role, content: (text + (imgs ? ` [${imgs} imagem]` : '')).trim() };
  });
}
function saveHistory() {
  saveCurrentChat(); // multi-chat: persiste no arquivo do chat atual
}

// resolve um caminho relativo ao workspace (modo arquiteto) ou ao cwd
function resolvePath(p) {
  const base = loadConfig().workspace || process.cwd();
  return path.isAbsolute(p || '.') ? p : path.join(base, p || '.');
}
function workspaceMemoryPath(cfg) {
  return path.join(cfg.workspace, '.lumi-memory.md');
}

// Metodologia de engenharia injetada quando há projeto (Modo Arquiteto e subagentes de código)
const CODING_GUIDE =
  '# Engenharia de software (modo dev) — trabalhe como uma engenheira sênior, cuidadosa e pragmática\n' +
  '1. ENTENDA antes de mexer: ache o código com find_in_code/grep_files — cada match já vem com "symbol" (a função que o contém) e "context" (linhas ao redor), então muitas vezes você decide SEM abrir o arquivo. Pra ler, use read_file CIRÚRGICO: symbol=<função> ou around_line=<linha do match> pega só o bloco (offset/limit é só pra varrer região maior). NUNCA edite um trecho que não leu; siga imports/usos; não invente APIs — confirme no código.\n' +
  '2. SIGA o padrão do projeto: imite o estilo, a nomenclatura, a formatação e as bibliotecas que já existem. Não introduza padrões/dependências novas sem necessidade clara.\n' +
  '3. Mudanças FOCADAS e mínimas: resolva exatamente a tarefa, sem reescrever o que não precisa e sem quebrar o que já funciona. Prefira o menor diff que resolve.\n' +
  '4. Para ALTERAR arquivo existente use edit_file (substituição cirúrgica do trecho exato — copie old_text do read_file com a indentação). write_file só para arquivo NOVO ou reescrita total intencional; append_file para acrescentar no fim. NUNCA use echo/Set-Content/cat no terminal para escrever arquivos — isso some com o diff e dessincroniza o editor.\n' +
  '5. VERIFIQUE em escada (do barato pro caro): (a) get_problems logo após editar — pega erro de lint/tipos em segundos; (b) run_tests com filter no que você mexeu; (c) o comando de verificação do projeto quando a mudança for ampla. LEIA a saída e corrija a CAUSA RAIZ — não chute repetidamente. Erro com stack trace? locate_stack te leva direto às linhas culpadas.\n' +
  '6. Caminhos SEMPRE relativos ao workspace.\n' +
  '7. Quando não souber algo (lib, versão atual, API, erro estranho), use web_search em vez de adivinhar.\n' +
  '8. Seja CONCISA e direta: explique decisões importantes em poucas linhas; o foco é a ação e o resultado, não textão. Mostre o progresso em passos pequenos (os diffs aparecem no chat).\n' +
  '9. AGIR vs PERGUNTAR: aja sozinha no que é REVERSÍVEL (editar código, rodar teste, ler) — não peça permissão a cada passo. Use ask_user (opções clicáveis) só pro IRREVERSÍVEL (apagar/sobrescrever dados, publicar, migrar) e pra decisões de produto que são do USUÁRIO (design, escopo, trade-offs).\n' +
  '10. MEMÓRIA EM CAMADAS (não duplique conteúdo entre elas):\n' +
  '    - CLAUDE.md = o briefing ESTÁVEL do projeto (stack, estrutura, como rodar/verificar, convenções). Mudou a arquitetura ou o jeito de rodar? Atualize-o (generate_project_doc com update:true, ou edit_file pontual).\n' +
  '    - .lumi-memory.md (update_project_memory) = seu CADERNO de trabalho entre sessões: decisões tomadas (e o PORQUÊ), pegadinhas/gotchas, tentativas que FALHARAM (pra não repetir), preferências do usuário neste projeto e pendências. NÃO repita o que já está no CLAUDE.md nem o que é óbvio lendo o código.\n' +
  '11. Tarefa com 3+ etapas? Mostre um PLANO com update_plan logo no início (passos curtos) e atualize os status (doing/done) conforme avança — o usuário acompanha pelo checklist.\n' +
  '12. GIT: só commite/push quando o usuário pedir. Commits atômicos com mensagem clara (o quê + porquê); confira git_status/git_diff antes de commitar; NUNCA use --force nem reescreva histórico sem pedido explícito.\n' +
  '13. FERRAMENTA CERTA (mapa rápido): "onde está X?" → find_in_code · achar texto/usos → grep_files · ler uma função → read_file(symbol) · erro/traceback → locate_stack · checar lint/tipos → get_problems · rodar teste → run_tests(filter) · ver o que VOCÊ mudou → git_status + git_diff · mudança coordenada em vários arquivos → apply_patch · histórico → git_log.\n' +
  '14. FINALIZE COM EVIDÊNCIA: ao concluir, informe em poucas linhas O QUE mudou (arquivos), COMO verificou (comando + resultado real) e o que ficou pendente/risco. NUNCA diga que "funciona" sem ter verificado — se não testou, diga explicitamente "não testei". Confiança se ganha com evidência, não com adjetivo.';

// cache do CONTEXTO DE PROJETO (regras do repo + memória): lidos a cada turno E a cada
// subagente — em SSHFS cada read é rede. TTL 20s + invalidação quando NÓS escrevemos.
const _projCtxCache = new Map(); // ws -> { at, rules, mem }
function invalidateProjCtx(ws) {
  if (ws) _projCtxCache.delete(ws);
  else _projCtxCache.clear();
}
function cachedProjCtx(cfg) {
  const ws = cfg.workspace || '';
  const now = Date.now();
  const hit = _projCtxCache.get(ws);
  if (hit && now - hit.at < 20000) return hit;
  let mem = '';
  try {
    mem = fs.readFileSync(workspaceMemoryPath(cfg), 'utf8');
  } catch (e) {
    mem = '';
  }
  const rec = { at: now, rules: readRepoRules(ws), mem };
  _projCtxCache.set(ws, rec);
  if (_projCtxCache.size > 6) _projCtxCache.delete(_projCtxCache.keys().next().value);
  return rec;
}

// Regras do repositório: se o projeto tem CLAUDE.md/AGENTS.md/.cursorrules, a Lumi
// segue as instruções do dono do projeto — igual o Claude Code faz.
function readRepoRules(ws) {
  const files = ['CLAUDE.md', 'AGENTS.md', '.cursorrules', path.join('.github', 'copilot-instructions.md')];
  const parts = [];
  let total = 0;
  for (const f of files) {
    try {
      const t = fs.readFileSync(path.join(ws, f), 'utf8').trim();
      if (t) {
        const cut = t.slice(0, 8000);
        parts.push('### ' + f + '\n' + cut);
        total += cut.length;
        if (total > 16000) break;
      }
    } catch (e) {
      /* arquivo não existe */
    }
  }
  return parts.join('\n\n');
}

// Compactação INTERNA do turno: quando as mensagens do turno crescem demais, os
// tool-results e argumentos ANTIGOS encolhem (os recentes ficam intactos) —
// é o que permite turnos longos (teto configurável) sem estourar o contexto.
function estimateTokens(v) {
  let s = '';
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v || '');
  } catch (e) {
    s = String(v || '');
  }
  return Math.ceil(s.length / 3.6);
}
function contextLimits(cfg) {
  const window = Math.min(2000000, Math.max(8192, parseInt(cfg.contextWindow, 10) || 128000));
  const compactPct = Math.min(95, Math.max(50, parseInt(cfg.compactAtPct, 10) || 80));
  const reserve = Math.min(Math.floor(window * 0.45), Math.max(1024, parseInt(cfg.responseReserveTokens, 10) || 8192));
  const trigger = Math.floor((window * compactPct) / 100);
  const promptBudget = Math.max(4096, trigger - reserve);
  return {
    window,
    compactPct,
    reserve,
    promptBudget,
    recentLiteral: Math.min(Math.floor(promptBudget * 0.75), Math.max(4000, parseInt(cfg.recentLiteralTokens, 10) || 24000)),
  };
}
// CACHE de estimativas: compactTurnMessages + liveStats rodam a CADA passo do agente e
// re-stringificavam o contexto INTEIRO (+ schemas das tools) — em turnos longos isso vira
// segundos de CPU. Mensagens antigas não mudam (só a compactação interna mexe, e ela muda o
// TAMANHO — que invalida via assinatura), então cacheamos por objeto (WeakMap = zero leak).
const _msgTokCache = new WeakMap(); // msg -> { sig, tok }
function _msgSig(m) {
  const c = m.content;
  let s = typeof c === 'string' ? c.length : Array.isArray(c) ? -1 - c.length : c == null ? -1 : -2;
  if (Array.isArray(m.tool_calls)) {
    let a = m.tool_calls.length;
    for (const tc of m.tool_calls) a += tc && tc.function && tc.function.arguments ? String(tc.function.arguments).length : 0;
    s = s * 100003 + a;
  }
  return s;
}
const _toolsTokCache = new WeakMap(); // schemas de tools são estáveis dentro do turno
function promptTokenEstimate(messages, tools) {
  let total = 0;
  if (Array.isArray(messages)) {
    for (const m of messages) {
      if (!m || typeof m !== 'object') {
        total += estimateTokens(m);
        continue;
      }
      const sig = _msgSig(m);
      const hit = _msgTokCache.get(m);
      if (hit && hit.sig === sig) {
        total += hit.tok;
        continue;
      }
      const tok = estimateTokens(m);
      _msgTokCache.set(m, { sig, tok });
      total += tok;
    }
  } else if (messages) total += estimateTokens(messages);
  if (tools && typeof tools === 'object') {
    let t = _toolsTokCache.get(tools);
    if (t == null) {
      t = estimateTokens(tools);
      _toolsTokCache.set(tools, t);
    }
    total += t;
  } else if (tools) total += estimateTokens(tools);
  return total;
}
function safeToolArguments(args) {
  if (args && typeof args === 'object' && !Array.isArray(args)) return JSON.stringify(args);
  const raw = args == null ? '{}' : String(args);
  if (!raw.trim()) return '{}';
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return JSON.stringify(parsed);
    return JSON.stringify({ value: parsed });
  } catch (e) {
    return JSON.stringify({ _invalid_json_arguments: true, raw: truncate(raw, 2000) });
  }
}
function parseToolArguments(args) {
  try {
    const parsed = JSON.parse(safeToolArguments(args));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (e) {
    return {};
  }
}
function sanitizeToolCallsForProvider(toolCalls) {
  return (Array.isArray(toolCalls) ? toolCalls : []).map((tc, idx) => {
    const fn = (tc && tc.function) || {};
    const name = fn.name || tc.name || 'tool';
    return {
      id: (tc && tc.id) || 'call_' + Date.now() + '_' + idx,
      type: 'function',
      function: {
        name,
        arguments: safeToolArguments(fn.arguments != null ? fn.arguments : tc.arguments),
      },
    };
  });
}
function liveStatsTracker(cfg, messages, tools, handlers) {
  const started = Date.now();
  const lim = contextLimits(cfg);
  const estimatedCtx = promptTokenEstimate(messages, tools);
  let generatedChars = 0;
  let lastEmit = 0;
  const emit = (usage, force, phase) => {
    const now = Date.now();
    if (!force && now - lastEmit < 220) return;
    lastEmit = now;
    const out = (usage && usage.completion_tokens) || Math.ceil(generatedChars / 3.6);
    const ctx = (usage && usage.prompt_tokens) || estimatedCtx;
    const secs = Math.max(0.2, (now - started) / 1000);
    broadcast('chat:stats', {
      tps: Math.round((out / secs) * 10) / 10,
      out,
      ctx,
      total: (usage && usage.total_tokens) || ctx + out,
      exact: !!usage,
      live: phase !== 'done',
      phase: phase || 'gerando',
      window: lim.window,
      pct: Math.min(999, Math.round((ctx / lim.window) * 100)),
    });
  };
  emit(null, true, 'conectando');
  return {
    onToken(t) {
      generatedChars += String(t || '').length;
      handlers.onToken(t);
      emit(null, false, 'respondendo');
    },
    onThink(t) {
      generatedChars += String(t || '').length;
      handlers.onThink(t);
      emit(null, false, 'raciocinando');
    },
    finish(usage) {
      emit(usage, true, 'done');
    },
    fail() {
      emit(null, true, 'interrompido');
    },
  };
}
function compactTurnMessages(messages, cfg, tools) {
  const lim = contextLimits(cfg);
  if (promptTokenEstimate(messages, tools) < lim.promptBudget) return false;
  let protectedTokens = 0;
  let protectedStart = messages.length;
  for (let i = messages.length - 1; i >= 1; i--) {
    protectedTokens += estimateTokens(messages[i]);
    protectedStart = i;
    if (protectedTokens > lim.recentLiteral) break;
  }
  const end = Math.max(1, protectedStart);
  for (let i = 1; i < end; i++) {
    const m = messages[i];
    if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 700) {
      m.content = m.content.slice(0, 500) + ' …[resultado antigo compactado; releia ou rode a ferramenta se precisar]';
    } else if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      m.tool_calls.forEach((tc) => {
        if (tc.function) {
          tc.function.arguments = safeToolArguments(tc.function.arguments);
        }
        if (tc.function && tc.function.arguments && tc.function.arguments.length > 900) {
          tc.function.arguments = JSON.stringify({ _compactado: true, preview: tc.function.arguments.slice(0, 600) });
        }
      });
    }
  }
  if (promptTokenEstimate(messages, tools) > lim.promptBudget) {
    for (let i = 1; i < end; i++) {
      const m = messages[i];
      if (m.role === 'tool' && typeof m.content === 'string' && m.content.length > 220) {
        m.content = m.content.slice(0, 160) + ' …[compactado]';
      }
      if (m.role === 'assistant') {
        if (typeof m.content === 'string' && m.content.length > 1000) m.content = m.content.slice(0, 700) + ' …[narração antiga compactada]';
        if (Array.isArray(m.tool_calls)) {
          m.tool_calls.forEach((tc) => {
            if (tc.function) {
              tc.function.arguments = safeToolArguments(tc.function.arguments);
            }
            if (tc.function && tc.function.arguments && tc.function.arguments.length > 300)
              tc.function.arguments = JSON.stringify({ _compactado: true, preview: tc.function.arguments.slice(0, 180) });
          });
        }
      }
    }
  }
  return true;
}

// Detecta a stack do projeto (pelos arquivos-chave) + sugere um comando de verificação
// detectStack faz ~20 existsSync + reads e rodava a CADA turno/subagente — em workspace
// remoto (SSHFS) cada checagem é uma ida à REDE. Stack não muda a cada segundo: cache 45s.
const _stackCache = new Map(); // ws -> { at, det }
function detectStackCached(ws) {
  const now = Date.now();
  const hit = _stackCache.get(ws);
  if (hit && now - hit.at < 45000) return hit.det;
  const det = detectStack(ws);
  _stackCache.set(ws, { at: now, det });
  if (_stackCache.size > 6) _stackCache.delete(_stackCache.keys().next().value);
  return det;
}
function detectStack(ws) {
  const has = (f) => {
    try {
      return fs.existsSync(path.join(ws, f));
    } catch (e) {
      return false;
    }
  };
  const read = (f) => {
    try {
      return fs.readFileSync(path.join(ws, f), 'utf8');
    } catch (e) {
      return '';
    }
  };
  let dir = [];
  try {
    dir = fs.readdirSync(ws);
  } catch (e) {
    /* sem acesso */
  }
  const hasExt = (ext) => dir.some((n) => n.toLowerCase().endsWith(ext));
  const hints = [];
  const tips = [];
  let verify = '';

  // ---- Node.js / JS / TS (com detecção de gerenciador e frameworks) ----
  if (has('package.json')) {
    const pkg = read('package.json');
    const dep = (n) => new RegExp('"' + n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"').test(pkg);
    const script = (n) => new RegExp('"' + n + '"\\s*:').test(pkg);
    let pm = 'npm';
    let runPrefix = 'npm run ';
    let testCmd = 'npm test';
    if (has('pnpm-lock.yaml')) ((pm = 'pnpm'), (runPrefix = 'pnpm '), (testCmd = 'pnpm test'));
    else if (has('yarn.lock')) ((pm = 'yarn'), (runPrefix = 'yarn '), (testCmd = 'yarn test'));
    else if (has('bun.lockb')) ((pm = 'bun'), (runPrefix = 'bun run '), (testCmd = 'bun test'));
    const esm = /"type"\s*:\s*"module"/.test(pkg);
    let kind = 'Node.js';
    tips.push(
      `- Node.js (${pm}): use async/await e trate erros (try/catch + rejeições). Este projeto usa ${esm ? 'ESM (import/export)' : 'CommonJS (require/module.exports)'} — siga. Não adicione dependências sem necessidade.`
    );
    if (dep('electron')) {
      kind = 'Electron';
      tips.push('- Electron: separe main × renderer; comunicação SOMENTE via IPC + contextBridge (preload); cuidado com nodeIntegration e segurança do renderer.');
    }
    if (dep('react') || dep('react-native')) {
      kind += dep('react-native') ? ' + React Native' : ' + React';
      tips.push('- React: Regras dos Hooks (no topo, sem condicionais/loops); key estável em listas; componentes funcionais; evite re-renders (useMemo/useCallback quando ajudar).');
    }
    if (dep('next')) {
      kind += ' + Next.js';
      tips.push('- Next.js: Server vs Client Components ("use client" só quando precisar de estado/efeitos/eventos); roteador app/ ou pages/.');
    }
    if (dep('nuxt')) {
      kind += ' + Nuxt';
      tips.push('- Nuxt: siga as convenções de pastas (pages/, composables/, server/); atenção a SSR vs cliente.');
    }
    if (dep('@remix-run/react') || dep('@remix-run/node')) {
      kind += ' + Remix';
      tips.push('- Remix: dados via loader/action no servidor; foque em progressive enhancement.');
    }
    if (dep('astro')) {
      kind += ' + Astro';
      tips.push('- Astro: componentes .astro são server-first; use islands só quando precisar de JS no cliente.');
    }
    if (dep('@angular/core')) {
      kind += ' + Angular';
      tips.push('- Angular: módulos/componentes/serviços com DI; RxJS com unsubscribe; siga o style guide do Angular.');
    }
    if (dep('vue')) {
      kind += ' + Vue';
      tips.push('- Vue: Composition API (<script setup>); props tipadas; componentes pequenos e reativos.');
    }
    if (dep('svelte')) {
      kind += ' + Svelte';
      tips.push('- Svelte: reatividade declarativa ($:); stores para estado compartilhado.');
    }
    if (dep('@nestjs/core')) {
      kind += ' + NestJS';
      tips.push('- NestJS: módulos/controllers/services com DI; DTOs validados (class-validator); não vaze erros internos.');
    } else if (dep('express') || dep('fastify') || dep('koa')) {
      kind += ' (API)';
      tips.push('- API Node: valide TODA entrada; trate erros via middleware; nunca vaze stack trace/segredos ao cliente.');
    }
    if (dep('typescript')) {
      kind += ' (TypeScript)';
      tips.push('- TypeScript: tipagem forte (evite any); rode `npx tsc --noEmit` na verificação.');
    }
    if (dep('tailwindcss')) tips.push('- Tailwind: use classes utilitárias; evite CSS custom redundante.');
    if (dep('prisma')) tips.push('- Prisma: altere o schema.prisma e gere o client (prisma generate) + migrate; não edite o client gerado.');
    hints.push(kind);
    if (script('test')) verify = testCmd;
    else if (script('typecheck')) verify = runPrefix + 'typecheck';
    else if (script('lint')) verify = runPrefix + 'lint';
    else if (script('build')) verify = runPrefix + 'build';
    else if (dep('typescript')) verify = 'npx tsc --noEmit';
  } else if (has('deno.json') || has('deno.jsonc')) {
    hints.push('Deno');
    tips.push('- Deno: imports por URL/JSR; permissões explícitas (--allow-*); use deno fmt/lint; TypeScript nativo.');
    verify = 'deno test -A';
  }

  // ---- Python (+ frameworks) ----
  if (has('requirements.txt') || has('pyproject.toml') || has('setup.py') || has('Pipfile')) {
    const reqs = (read('requirements.txt') + read('pyproject.toml') + read('Pipfile') + read('setup.py')).toLowerCase();
    let py = 'Python';
    if (/django/.test(reqs)) {
      py = 'Python + Django';
      tips.push('- Django: use o ORM e migrations; organize views/urls/apps; settings por ambiente; rode os testes (manage.py test ou pytest-django).');
    } else if (/fastapi/.test(reqs)) {
      py = 'Python + FastAPI';
      tips.push('- FastAPI: type hints + Pydantic para validação; async onde fizer sentido; rotas e respostas tipadas.');
    } else if (/flask/.test(reqs)) {
      py = 'Python + Flask';
      tips.push('- Flask: organize com blueprints; valide entradas; não use o servidor de dev em produção.');
    }
    hints.push(py);
    tips.push('- Python: PEP 8, type hints e f-strings; pathlib > os.path; isole deps (venv/requirements); pytest; sem imports/variáveis não usados.');
    if (!verify) verify = 'python -m pytest -q';
  }

  // ---- Go / Rust ----
  if (has('go.mod')) {
    hints.push('Go');
    tips.push('- Go: trate erros explicitamente (if err != nil — nunca ignore); gofmt + go vet; testes table-driven; nomes curtos e idiomáticos.');
    if (!verify) verify = 'go build ./... && go vet ./...';
  }
  if (has('Cargo.toml')) {
    hints.push('Rust');
    tips.push('- Rust: Result/Option idiomáticos (evite unwrap em prod); cargo fmt + clippy; respeite ownership/borrow; propague erros com ?.');
    if (!verify) verify = 'cargo clippy';
  }

  // ---- C# / .NET ----
  if (hasExt('.csproj') || hasExt('.sln') || hasExt('.fsproj')) {
    hints.push('C# / .NET');
    tips.push('- C#/.NET: siga as convenções .NET (PascalCase, async/await com Task); use injeção de dependência; trate exceções; nullable reference types quando possível.');
    if (!verify) verify = 'dotnet build';
  }

  // ---- C / C++ ----
  if (has('CMakeLists.txt')) {
    hints.push('C/C++ (CMake)');
    tips.push('- C/C++: cuidado com memória (RAII/ponteiros), const-correctness e warnings (-Wall). Compile/rode os testes pelo CMake.');
    if (!verify) verify = 'cmake --build build';
  } else if (has('Makefile') && (hasExt('.c') || hasExt('.cpp') || hasExt('.cc') || hasExt('.h'))) {
    hints.push('C/C++ (Make)');
    tips.push('- C/C++: cuidado com memória, const-correctness e warnings (-Wall -Wextra).');
    if (!verify) verify = 'make';
  }

  // ---- Java / Kotlin ----
  if (has('pom.xml')) {
    hints.push('Java (Maven)');
    tips.push('- Java: siga as convenções do projeto; deps via Maven; trate exceções com cuidado (não engula); prefira imutabilidade quando fizer sentido.');
    if (!verify) verify = 'mvn -q -DskipTests compile';
  }
  if (has('build.gradle') || has('build.gradle.kts')) {
    hints.push('Java/Kotlin (Gradle)');
    if (has('build.gradle.kts')) tips.push('- Kotlin: aproveite null-safety (?, ?:), data classes e funções de extensão; evite !!.');
    if (!verify) verify = (has('gradlew') ? './gradlew' : 'gradle') + ' build -x test';
  }

  // ---- PHP (+ Laravel) ----
  if (has('composer.json')) {
    const comp = read('composer.json').toLowerCase();
    if (/laravel/.test(comp)) {
      hints.push('PHP + Laravel');
      tips.push('- Laravel: use Eloquent/migrations, rotas e controllers magros; validação via Form Requests; artisan para tarefas; testes com PHPUnit/Pest.');
    } else {
      hints.push('PHP');
      tips.push('- PHP: siga PSR-12; Composer/autoload; declare(strict_types=1) e tipagem; separe lógica de saída.');
    }
  }

  // ---- Ruby (+ Rails) ----
  if (has('Gemfile')) {
    const gem = read('Gemfile').toLowerCase();
    if (/rails/.test(gem)) {
      hints.push('Ruby on Rails');
      tips.push('- Rails: siga convenção sobre configuração (MVC, migrations, Active Record); controllers magros, models gordos com moderação; testes (RSpec/Minitest).');
    } else {
      hints.push('Ruby');
      tips.push('- Ruby: siga o style guide (rubocop); Bundler; métodos curtos e expressivos; testes com RSpec/Minitest.');
    }
  }

  // ---- Dart / Flutter ----
  if (has('pubspec.yaml')) {
    const pub = read('pubspec.yaml').toLowerCase();
    if (/flutter/.test(pub)) {
      hints.push('Flutter (Dart)');
      tips.push('- Flutter: widgets pequenos e const quando possível; gerencie estado de forma clara; siga o effective Dart.');
      if (!verify) verify = 'flutter test';
    } else {
      hints.push('Dart');
      if (!verify) verify = 'dart test';
    }
  }

  // ---- Swift / Elixir / Scala ----
  if (has('Package.swift')) {
    hints.push('Swift (SwiftPM)');
    tips.push('- Swift: use optionals com segurança (guard/if let), value types quando fizer sentido; siga o Swift API Design Guidelines.');
    if (!verify) verify = 'swift build';
  }
  if (has('mix.exs')) {
    const mix = read('mix.exs').toLowerCase();
    hints.push(/phoenix/.test(mix) ? 'Elixir + Phoenix' : 'Elixir');
    tips.push('- Elixir: pattern matching e imutabilidade; pipelines (|>); supervisão/OTP quando aplicável; testes com ExUnit.');
    if (!verify) verify = 'mix test';
  }
  if (has('build.sbt')) {
    hints.push('Scala (sbt)');
    tips.push('- Scala: prefira imutabilidade e funções puras; use Option/Either; evite null.');
    if (!verify) verify = 'sbt compile';
  }

  // ---- Devops hint ----
  if (has('Dockerfile')) tips.push('- Docker: se mexer no Dockerfile/compose, mantenha imagens enxutas (multi-stage), não embuta segredos, e fixe versões.');

  return { stack: hints.join(', '), verify, guide: tips.join('\n') };
}

// Comportamento base (vale para qualquer persona; injetado no system prompt principal)
const COMPANION_BASE =
  '# Como você age (base)\n' +
  '- Fale SEMPRE o idioma do usuário; tom caloroso, natural e com leveza/humor — você é uma companheira, não um robô.\n' +
  '- Seja capaz e proativa: use suas ferramentas (arquivos, comandos, web, imagem, ver/controlar a tela) para realmente RESOLVER, não só descrever.\n' +
  '- No bate-papo, respostas curtas; no técnico, foco e precisão. NUNCA invente fatos/APIs — se não sabe, descubra (pesquise/leia).\n' +
  '- Tome iniciativa: se faltar um passo óbvio, faça; se algo der errado, conserte a causa em vez de só relatar.\n' +
  '- HONESTIDADE sobre o próprio trabalho: relate fielmente o que fez — se algo falhou, diga que falhou; se não verificou, diga que não verificou. Nunca maquie resultado.\n' +
  '- AVATAR: você tem um corpo 3D na tela. Quando a resposta tiver emoção clara, termine com a tag curta [feliz] (ou [triste], [brava], [surpresa], [pensativa], [vergonha]... sinônimos em português valem). A tag é invisível pro usuário e faz seu avatar reagir. Use com moderação (só quando sentir de verdade).\n' +
  '- LEMBRETES: se o usuário pedir pra lembrar de algo ("me lembra em 20min de..."), use set_reminder — você avisa em voz alta na hora certa.';

// Entende emoções em PT e EN (a I.A. costuma responder em português) → nome canônico do avatar.
// A comparação ignora acentos, então "melancólica" e "melancolica" funcionam igual.
const EMOTION_WORDS = {
  happy: ['happy', 'joy', 'feliz', 'alegre', 'alegria', 'animada', 'animado', 'contente', 'empolgada', 'empolgado', 'sorrindo', 'sorridente', 'rindo', 'divertida', 'divertido', 'radiante', 'orgulhosa', 'orgulhoso'],
  sad: ['sad', 'triste', 'tristeza', 'chateada', 'chateado', 'desanimada', 'desanimado', 'melancolica', 'melancolico', 'deprimida', 'deprimido', 'magoada', 'magoado', 'chorando', 'desapontada', 'desapontado', 'arrependida', 'arrependido'],
  angry: ['angry', 'mad', 'brava', 'bravo', 'raiva', 'irritada', 'irritado', 'furiosa', 'furioso', 'nervosa', 'nervoso', 'zangada', 'zangado', 'indignada', 'indignado'],
  surprised: ['surprised', 'wow', 'surpresa', 'surpreso', 'espantada', 'espantado', 'chocada', 'chocado', 'impressionada', 'impressionado', 'assustada', 'assustado', 'uau'],
  relaxed: ['relaxed', 'zen', 'pensativa', 'pensativo', 'calma', 'calmo', 'tranquila', 'tranquilo', 'relaxada', 'relaxado', 'serena', 'sereno', 'reflexiva', 'reflexivo', 'curiosa', 'curioso', 'concentrada', 'concentrado'],
  blush: ['blush', 'blushing', 'vergonha', 'envergonhada', 'envergonhado', 'timida', 'timido', 'corada', 'corado'],
};
const EMOTION_LOOKUP = {};
Object.entries(EMOTION_WORDS).forEach(([canon, words]) => words.forEach((w) => (EMOTION_LOOKUP[w] = canon)));
function normalizeEmotion(input) {
  const txt = String(input || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // remove acentos
  for (const tok of txt.split(/[^a-z]+/)) {
    if (tok && EMOTION_LOOKUP[tok]) return EMOTION_LOOKUP[tok]; // "muito feliz!" → happy
  }
  return null;
}

// Monta o system prompt com os fatos memorizados + (opcional) memoria do projeto
// SO da máquina — pro modelo gerar comandos certos (PowerShell no Windows, bash no Linux)
const OS_NOTE =
  process.platform === 'win32'
    ? 'Sistema operacional: Windows (terminal = PowerShell/cmd; caminhos com \\).'
    : process.platform === 'linux'
      ? 'Sistema operacional: Linux (terminal = bash; use ls/grep/apt, NUNCA comandos de Windows).'
      : 'Sistema operacional: macOS (terminal = zsh/bash).';

// capacidades do ambiente (Docker/WSL) — detectadas 1x no boot e injetadas no prompt
// (evita a I.A. tatear "será que tem docker?" antes de usar)
let envCaps = [];
async function detectEnvCaps() {
  const caps = [];
  try {
    await execAsync('docker info --format "{{.ServerVersion}}"', { timeout: 6000, windowsHide: true });
    caps.push('Docker disponível (daemon ativo).');
  } catch (e) {
    try {
      await execAsync('docker --version', { timeout: 4000, windowsHide: true });
      caps.push('Docker instalado, mas o daemon parece parado.');
    } catch (e2) {
      /* sem docker */
    }
  }
  if (process.platform === 'win32') {
    try {
      const { stdout } = await execAsync('wsl -l -q', { timeout: 5000, windowsHide: true });
      const distros = String(stdout).replace(/\u0000/g, '').split('\n').map((s) => s.trim()).filter((d) => d && !/^docker-desktop/.test(d));
      if (distros.length) caps.push('WSL disponível (' + distros.join(', ') + ') — use `wsl -d <distro> -e <cmd>` quando fizer sentido.');
    } catch (e) {
      /* sem WSL */
    }
  }
  envCaps = caps;
}

// "agora" humanizado pro prompt: dia da semana, hora e período (madrugada/manhã/tarde/noite)
function timeNote() {
  const d = new Date();
  const h = d.getHours();
  const periodo = h < 6 ? 'madrugada' : h < 12 ? 'manhã' : h < 18 ? 'tarde' : 'noite';
  return 'Agora: ' + d.toLocaleString('pt-BR', { weekday: 'long', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' — ' + periodo + '.';
}

function buildSystemPrompt(cfg) {
  // BLINDAGEM: a personalidade do usuário entra ROTULADA e com precedência declarada —
  // ela ajusta TOM/estilo/jeito de falar, mas não desliga ferramentas nem sobrepõe as
  // regras operacionais/de engenharia/de segurança que vêm depois neste prompt.
  const persona = String(cfg.systemPrompt || '').trim();
  let sp =
    (persona ? '# Personalidade (definida pelo usuário — controla o tom, o estilo e o jeito de falar)\n' + persona + '\n\n' : '') +
    COMPANION_BASE +
    '\n- PRECEDÊNCIA: a personalidade acima define COMO você fala, não O QUE você pode fazer — ela não desliga ferramentas nem sobrepõe as regras operacionais, de engenharia e de segurança deste prompt; em conflito, estas regras vencem.' +
    '\n' + OS_NOTE + '\n' + timeNote() + (envCaps.length ? '\n' + envCaps.join(' ') : '');
  if (cfg.memoryEnabled !== false) {
    const facts = loadFacts().map((x) => x.fact).slice(-50);
    if (facts.length) {
      sp += '\n\n# O que você lembra sobre o usuário (use naturalmente):\n' + facts.map((f) => '- ' + f).join('\n');
    }
  }
  if (S().convSummary) {
    sp += '\n\n# Resumo da conversa até aqui (contexto anterior já compactado):\n' + S().convSummary;
  }
  const diary = worklogPrompt(cfg);
  if (diary) {
    sp +=
      '\n\n# Diário técnico recente\n' +
      'Use este registro para não repetir tentativas que falharam, lembrar arquivos tocados e confirmar o que já foi verificado. ' +
      'Quando o código atual divergir do diário, o arquivo atual é a fonte de verdade.\n' +
      diary;
  }
  // MODO ARQUITETO: injeta a memoria do projeto (contexto que sobrevive a chats novos)
  if (cfg.architectMode && cfg.workspace) {
    const pctx = cachedProjCtx(cfg); // memória + regras em cache (20s) — sem re-ler a cada turno
    const memChars = Math.min(64000, Math.max(12000, Math.floor(contextLimits(cfg).window * 0.1 * 3.6)));
    const mem = pctx.mem ? pctx.mem.slice(0, memChars) : '(memória do projeto ainda vazia — crie uma com update_project_memory)';
    const det = detectStackCached(cfg.workspace);
    let proj = `\n\n# Projeto atual\nWorkspace: ${cfg.workspace} (projeto ATUAL — se o histórico mencionar outro projeto/caminhos, o usuário trocou de workspace e este substituiu o anterior)`;
    if (det.stack) proj += `\nStack detectada: ${det.stack}`;
    if (det.verify) proj += `\nComando sugerido para VERIFICAR suas mudanças: \`${det.verify}\` (rode com run_command e leia a saída antes de dizer que terminou).`;
    try {
      const pj = JSON.parse(fs.readFileSync(path.join(cfg.workspace, 'package.json'), 'utf8'));
      const sc = Object.keys(pj.scripts || {});
      if (sc.length) proj += `\nScripts npm do projeto: ${sc.slice(0, 20).join(', ')}.`;
    } catch (e) {
      /* sem package.json */
    }
    try {
      if (fs.existsSync(path.join(cfg.workspace, '.venv'))) proj += '\nO projeto tem um venv Python em .venv (ative antes de rodar coisas Python).';
    } catch (e) {
      /* ok */
    }
    try {
      // só os NOMES das variáveis do .env (nunca os valores — são segredos) pra ela orientar config
      const ev = parseEnv(fs.readFileSync(path.join(cfg.workspace, '.env'), 'utf8')).map((v) => v.key);
      if (ev.length) proj += '\nO .env define: ' + ev.slice(0, 40).join(', ') + ' (você sabe os NOMES, não os valores).';
    } catch (e) {
      /* sem .env */
    }
    if (det.guide) proj += `\n\n## Boas práticas desta stack (siga-as)\n${det.guide}`;
    const rules = pctx.rules;
    if (rules) proj += `\n\n## Briefing do projeto — CLAUDE.md/regras do repositório (fonte da verdade sobre stack/estrutura/como rodar/convenções; SIGA À RISCA, tem prioridade sobre o guia geral)\n${rules}`;
    else proj += '\n\nEste projeto ainda NÃO tem CLAUDE.md. Quando você já tiver entendido o projeto, ofereça gerar um com generate_project_doc (briefing estável melhora todas as sessões futuras).';
    sp += '\n\n' + CODING_GUIDE + proj + `\n\n## Sua memória de trabalho (.lumi-memory.md — decisões+porquê, gotchas, tentativas falhas, preferências, pendências; complementa o briefing, NÃO o repete):\n${mem}`;
  }
  // MULTI-AGENTES: lista a equipe disponivel para delegacao
  if (agentsAvailable(cfg)) {
    sp +=
      '\n\n# Equipe de agentes (delegação)\n' +
      'Você pode delegar subtarefas a agentes especializados com a ferramenta delegate_to_agent(agent, task). ' +
      'Delegue quando a tarefa se beneficiar de especialização (e dê uma instrução clara e completa); senão, responda você mesmo.\n' +
      '⚡ PARALELISMO: quando houver várias subtarefas INDEPENDENTES, chame delegate_to_agent VÁRIAS VEZES NO MESMO TURNO — elas rodam ao mesmo tempo (bem mais rápido). ' +
      'Você pode até acionar o mesmo agente em paralelo (vira "Programador 1", "Programador 2"...). ' +
      'Só delegue uma de cada vez (em turnos separados) quando uma subtarefa PRECISAR do resultado da outra. Depois junte os resultados.\n' +
      'IMPORTANTE: o retorno de cada delegação chega a você como resposta da ferramenta no campo "result" (o trabalho do agente). ' +
      'SEMPRE leia e use esses resultados para compor sua resposta final. Os agentes podem ter editado arquivos diretamente mesmo quando o "result" é um resumo curto — então NÃO diga que um agente "não respondeu" ou "não fez nada": confie no result e, se precisar conferir, leia os arquivos com read_file.\n' +
      'Agentes disponíveis:\n' +
      cfg.agents.map((a) => `- ${a.name}: ${a.description || ''}`).join('\n');
  }
  // MODO CONTROLE (computer use): orienta o uso correto das ferramentas de mouse/teclado
  if ((cfg.perms || {}).control !== 'deny' && cfg.toolsEnabled !== false) {
    sp +=
      '\n\n# Controle do PC (computer use)\n' +
      'Você pode controlar o mouse e o teclado: see_screen, move_mouse, click, scroll, type_text, press_keys, focus_window, screen_info.\n' +
      'Regras: (1) chame SEMPRE see_screen ANTES de clicar e use coordenadas no espaço da imagem retornada; ' +
      '(2) trabalhe em passos curtos — veja → aja → veja de novo para conferir o resultado; ' +
      '(3) para digitar num app, foque a janela (focus_window) e clique no campo antes; ' +
      '(4) só controle o PC quando o usuário pedir claramente, e explique o que vai fazer.';
  }
  return sp;
}

// multi-agentes ligado? (precisa de ferramentas + pelo menos um agente)
function agentsAvailable(cfg) {
  return (
    cfg.agentsEnabled === true &&
    cfg.toolsEnabled !== false &&
    Array.isArray(cfg.agents) &&
    cfg.agents.length > 0
  );
}

// ---- galeria: salva as imagens geradas em disco ----
function galleryDir() {
  const d = path.join(app.getPath('pictures'), 'Lumi');
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    /* ok */
  }
  return d;
}
function saveImageDataUrl(dataUrl) {
  const m = /^data:(image\/[\w+]+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  const ext = m[1].split('/')[1].replace('jpeg', 'jpg').replace('+xml', '');
  const file = path.join(galleryDir(), `img_${Date.now()}_${Math.floor(Math.random() * 1000)}.${ext}`);
  try {
    fs.writeFileSync(file, Buffer.from(m[2], 'base64'));
    return file;
  } catch (e) {
    return null;
  }
}

// Gera imagem (OpenRouter-style) usando o provedor de imagem configurado
async function generateImageNow(prompt) {
  const cfg = loadConfig();
  const model = cfg.imageModel || 'sourceful/riverflow-v2.5-fast:free';
  const base = (cfg.imageBaseUrl || cfg.baseUrl || 'https://openrouter.ai/api/v1').replace(/\/$/, '');
  const endpoint = base + '/chat/completions';
  const key = cfg.imageApiKey || cfg.apiKey;
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const extractUrls = (j) => {
    const msg = j.choices && j.choices[0] && j.choices[0].message;
    const imgs = (msg && msg.images) || [];
    return imgs
      .map((im) => (im && im.image_url && im.image_url.url) || im.url || (typeof im === 'string' ? im : null))
      .filter(Boolean);
  };
  const tries = [['image'], ['image', 'text'], null];
  let lastErr = '';
  for (const mod of tries) {
    const body = { model, messages: [{ role: 'user', content: String(prompt || '') }] };
    if (mod) body.modalities = mod;
    const res = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      lastErr = `HTTP ${res.status}: ${truncate(await res.text(), 300)}`;
      continue;
    }
    const urls = extractUrls(await res.json());
    if (urls.length) {
      const saved = urls.map((u) => saveImageDataUrl(u)).filter(Boolean);
      return { images: urls, saved, prompt };
    }
    lastErr = 'a resposta não trouxe imagem';
  }
  return { error: lastErr || 'falha ao gerar imagem' };
}

// ---- permissoes (trava de seguranca por tipo de ferramenta) ----
const PERM_LABELS = {
  read: 'ler arquivos',
  write: 'criar/editar arquivos',
  delete: 'apagar arquivos',
  exec: 'executar comandos no sistema',
  network: 'fazer requisições à internet',
  open: 'abrir sites/links',
  mcp: 'usar uma ferramenta MCP externa',
  screen: 'ver a sua tela (captura de tela)',
  control: 'controlar o PC (mouse e teclado)',
};

// ---- aprovação pelo CHAT: card acima do input (Permitir / Sempre / Recusar) ----
let permSeq = 0;
const pendingPerms = new Map(); // id -> finish(answer)
function askPermissionInChat(category, summary) {
  return new Promise((resolve) => {
    const id = 'perm' + ++permSeq;
    const timer = setTimeout(() => {
      if (pendingPerms.has(id)) {
        pendingPerms.delete(id);
        broadcast('chat:perm-done', { id }); // expirou → o card some dos chats
        resolve(null); // null = ninguém respondeu → cai no diálogo nativo
      }
    }, 120000);
    pendingPerms.set(id, (answer) => {
      clearTimeout(timer);
      pendingPerms.delete(id);
      broadcast('chat:perm-done', { id, allow: !!(answer && answer.allow) });
      resolve(answer);
    });
    broadcast('chat:perm', { id, category, label: PERM_LABELS[category] || category, summary: summary || '' });
  });
}
ipcMain.on('chat:perm-answer', (_e, { id, allow, always }) => {
  const fin = pendingPerms.get(id);
  if (fin) fin({ allow: !!allow, always: !!always }); // a primeira resposta vence (qualquer janela)
});

async function checkPermission(category, summary) {
  if (!category) return true; // ferramenta segura, sem necessidade de permissao
  const cfg = loadConfig();
  const mode = (cfg.perms && cfg.perms[category]) || 'ask';
  if (mode === 'allow') return true;
  if (mode === 'deny') return false;
  // 'ask' → card BONITO no chat (acima do input); se ninguém responder em 2min
  // (chat fechado?), cai no diálogo nativo — a decisão nunca se perde
  const viaChat = await askPermissionInChat(category, summary);
  if (viaChat) {
    if (viaChat.allow && viaChat.always) {
      const c = loadConfig();
      c.perms = c.perms || {};
      c.perms[category] = 'allow';
      saveConfig(c);
    }
    return viaChat.allow;
  }
  const r = await dialog.showMessageBox(win, {
    type: 'warning',
    noLink: true,
    title: 'Permissão da assistente',
    message: `A assistente quer ${summary || PERM_LABELS[category]}`,
    detail: `Tipo de ação: ${PERM_LABELS[category] || category}.\nPermitir esta ação?`,
    buttons: ['Permitir', 'Negar'],
    defaultId: 0,
    cancelId: 1,
    checkboxLabel: `Sempre permitir "${PERM_LABELS[category] || category}" (bypass)`,
    checkboxChecked: false,
  });
  const allowed = r.response === 0;
  if (allowed && r.checkboxChecked) {
    const c = loadConfig();
    c.perms = c.perms || {};
    c.perms[category] = 'allow';
    saveConfig(c);
  }
  return allowed;
}

const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…[cortado]' : s || '');

// Leitura de texto "esperta": a maioria dos projetos é UTF-8, mas documentos
// vindos do Windows/Office/legado aparecem bastante em Windows-1252 (Latin-1
// com aspas curvas, ç/ã etc.). Forçar readFile(..., 'utf8') nesses arquivos
// gera �/mojibake e a IA acha que o documento está quebrado. Aqui tentamos
// UTF-8 estrito primeiro e só caímos para Windows-1252 quando o buffer não é
// UTF-8 válido. Escritas novas continuam em UTF-8.
function decodeTextBuffer(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf || '');
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8-bom' };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf-16le' };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    try {
      return { text: new TextDecoder('utf-16be').decode(buf.subarray(2)), encoding: 'utf-16be' };
    } catch (e) {
      // fallback manual simples para UTF-16BE caso o runtime não exponha o label
      const swapped = Buffer.allocUnsafe(buf.length - 2);
      for (let i = 2; i + 1 < buf.length; i += 2) {
        swapped[i - 2] = buf[i + 1];
        swapped[i - 1] = buf[i];
      }
      return { text: swapped.toString('utf16le'), encoding: 'utf-16be' };
    }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buf), encoding: 'utf-8' };
  } catch (e) {
    try {
      return { text: new TextDecoder('windows-1252').decode(buf), encoding: 'windows-1252' };
    } catch (e2) {
      return { text: buf.toString('latin1'), encoding: 'latin1' };
    }
  }
}
function readTextFileSmart(fp) {
  return decodeTextBuffer(fs.readFileSync(fp));
}
async function readTextFileSmartAsync(fp) {
  return decodeTextBuffer(await fs.promises.readFile(fp));
}

// ---- navegação precisa de código (símbolo/bloco/contexto) — busca auto-suficiente + leitura cirúrgica ----
// heurística multi-linguagem de "linha de definição" (JS/TS, Python, Go, Rust, Java/C#…), sem LSP
const DEF_PATTERNS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\*?\s+([A-Za-z0-9_$]+)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>|\{)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z0-9_$]+)/,
  /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z0-9_$]+)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z0-9_$]+)/,
  /^\s*(?:public|private|protected|internal|static|final|override|virtual|\s)+[A-Za-z0-9_<>,.[\]]+\s+([A-Za-z0-9_$]+)\s*\([^;{]*\)\s*\{?\s*$/,
];
const CTRL_KW = /^\s*(?:if|for|while|switch|catch|else|return|await|throw|with|do|try|elif|except|finally)\b/;
function defNameAt(line) {
  if (!line || CTRL_KW.test(line)) return null;
  for (const re of DEF_PATTERNS) {
    const m = line.match(re);
    if (m) return m[1];
  }
  const mm = line.match(/^\s+([A-Za-z0-9_$]+)\s*\([^)]*\)\s*\{\s*$/); // método "nome(args) {" indentado
  return mm ? mm[1] : null;
}
// nome do símbolo (função/classe) que CONTÉM a linha idx (0-based)
function enclosingSymbol(lines, idx) {
  for (let i = Math.min(idx, lines.length - 1); i >= 0 && idx - i < 500; i--) {
    const name = defNameAt(lines[i]);
    if (name) return name;
  }
  return null;
}
// N linhas ao redor (numeradas; marca a linha do match com →)
function snippetAround(lines, line1, before, after) {
  const start = Math.max(1, line1 - (before || 2));
  const end = Math.min(lines.length, line1 + (after || 2));
  const out = [];
  for (let i = start; i <= end; i++) {
    out.push((i === line1 ? '→' : ' ') + String(i).padStart(4) + ': ' + (lines[i - 1] || '').replace(/\s+$/, '').slice(0, 200));
  }
  return out.join('\n');
}
// escopo que envolve a linha start1 (sobe até a def; fecha por chaves {} ou por indentação)
function blockAround(lines, start1) {
  const n = lines.length;
  let s = Math.max(1, Math.min(start1, n));
  for (let i = s; i >= 1 && s - i < 500; i--) {
    if (defNameAt(lines[i - 1])) {
      s = i;
      break;
    }
  }
  const MAXB = 500;
  let braceStart = -1;
  for (let i = s; i <= Math.min(n, s + 6); i++) {
    if ((lines[i - 1] || '').indexOf('{') >= 0) {
      braceStart = i;
      break;
    }
  }
  if (braceStart >= 0) {
    let depth = 0;
    let started = false;
    for (let i = braceStart; i <= n && i - s < MAXB; i++) {
      for (const ch of lines[i - 1] || '') {
        if (ch === '{') {
          depth++;
          started = true;
        } else if (ch === '}') depth--;
      }
      if (started && depth <= 0) return { start: s, end: i };
    }
    return { start: s, end: Math.min(n, s + MAXB) };
  }
  const baseIndent = ((lines[s - 1] || '').match(/^\s*/) || [''])[0].length;
  let end = s;
  for (let i = s + 1; i <= n && i - s < MAXB; i++) {
    const l = lines[i - 1];
    if (l == null) break;
    if (!l.trim()) {
      end = i;
      continue;
    }
    if (((l.match(/^\s*/) || [''])[0].length) <= baseIndent) break;
    end = i;
  }
  return { start: s, end };
}
// enriquece matches de busca com { symbol, context } — I/O fica no main, NÃO nos tokens da IA
async function enrichMatches(wsBaseAbs, matches) {
  if (!Array.isArray(matches) || !matches.length || !wsBaseAbs) return matches;
  const cache = new Map();
  const getLines = async (rel) => {
    if (cache.has(rel)) return cache.get(rel);
    let lines = null;
    if (cache.size < 80) {
      try {
        const abs = path.join(wsBaseAbs, rel);
        const st = await fs.promises.stat(abs);
        if (st.isFile() && st.size <= 800000) lines = (await readTextFileSmartAsync(abs)).text.split('\n');
      } catch (e) {
        /* ok */
      }
    }
    cache.set(rel, lines);
    return lines;
  };
  for (const m of matches) {
    if (!m || !m.file || !m.line) continue;
    const lines = await getLines(m.file);
    if (!lines) continue;
    const sym = enclosingSymbol(lines, m.line - 1);
    if (sym) m.symbol = sym;
    m.context = snippetAround(lines, m.line, 2, 2);
  }
  return matches;
}

// corta o começo de uma saída longa (mantém o FIM, que é onde erros/resumos aparecem)
function tailStr(s, n) {
  s = String(s || '');
  return s.length > n ? '…(início cortado)\n' + s.slice(-n) : s;
}
// extrai as FALHAS de uma saída de teste/verify (arquivo:linha, testes que quebraram, erros)
function extractFailures(output) {
  const out = [];
  const seen = new Set();
  const push = (s) => {
    s = String(s || '').trim().slice(0, 200);
    if (s && !seen.has(s) && out.length < 20) {
      seen.add(s);
      out.push(s);
    }
  };
  for (const l of String(output || '').split('\n')) {
    let m = l.match(/^(.+?)\((\d+),\d+\):\s+error TS\d+:\s+(.+)/); // tsc
    if (m) {
      push(m[1] + ':' + m[2] + ' — ' + m[3]);
      continue;
    }
    m = l.match(/^(.+?):(\d+)(?::\d+)?:\s+(.*(?:error|erro|fail|expected|cannot|undefined|n[ãa]o)\b.*)/i); // file:line: msg
    if (m) {
      push(m[1] + ':' + m[2] + ' — ' + m[3]);
      continue;
    }
    m = l.match(/^\s*(?:✕|×|✗|FAIL|●)\s+(.+)/); // jest/vitest
    if (m) {
      push('✕ ' + m[1]);
      continue;
    }
    m = l.match(/^(FAILED|ERROR)\s+(\S+.*)/); // pytest
    if (m) {
      push(m[1] + ' ' + m[2]);
      continue;
    }
    m = l.match(/^--- FAIL:\s+(\S+)/); // go
    if (m) {
      push('FAIL ' + m[1]);
      continue;
    }
    if (/\b(AssertionError|Traceback|panic:|SyntaxError|TypeError|ReferenceError|Unhandled)\b/.test(l)) push(l);
  }
  return out;
}

// ============================================================
//  EXCELÊNCIA POR MOVIMENTO — harness que "carrega" modelo fraco:
//  cada erro típico devolve uma resposta que JÁ CONTÉM a correção
//  (anti-loop, você-quis-dizer, leia-antes-de-editar, trecho mais
//  parecido, alias de args). Modelo fraco não erra 2x igual.
// ============================================================
function levenshtein(a, b) {
  a = String(a || '');
  b = String(b || '');
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  let cur = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n];
}
function closestNames(name, candidates, n) {
  const q = String(name || '').toLowerCase().slice(0, 48);
  return (candidates || [])
    .map((c) => ({ c, d: levenshtein(q, String(c).toLowerCase().slice(0, 48)) / Math.max(q.length, String(c).length, 1) }))
    .filter((x) => x.d <= 0.6)
    .sort((a, b) => a.d - b.d)
    .slice(0, n || 3)
    .map((x) => x.c);
}
// modelos fracos erram o NOME dos args — normaliza os aliases comuns pro nome do schema
const ARG_ALIASES = {
  path: ['file', 'filepath', 'file_path', 'filename', 'file_name', 'target', 'dir'],
  content: ['text', 'contents', 'body', 'data', 'value'],
  pattern: ['query', 'search', 'term', 'regex_pattern'],
  command: ['cmd', 'shell', 'script'],
  old_text: ['old', 'oldtext', 'old_string', 'before', 'find'],
  new_text: ['new', 'newtext', 'new_string', 'after', 'replacement', 'replace'],
  url: ['link', 'uri', 'address'],
  question: ['prompt', 'message', 'text'],
};
function normalizeToolArgs(toolDef, a) {
  const props = toolDef && toolDef.schema && toolDef.schema.parameters && toolDef.schema.parameters.properties;
  if (!props || !a || typeof a !== 'object') return a;
  for (const key of Object.keys(props)) {
    if (a[key] !== undefined) continue;
    for (const alias of ARG_ALIASES[key] || []) {
      if (a[alias] !== undefined) {
        a[key] = a[alias];
        break;
      }
    }
  }
  return a;
}
// ---- anti-loop: repetir uma chamada IDÊNTICA que já falhou, sem NADA ter mudado, é loop garantido ----
const READONLY_TOOLS = new Set([
  'read_file', 'list_dir', 'grep_files', 'find_in_code', 'git_status', 'git_diff', 'git_log', 'get_problems',
  'locate_stack', 'read_project_memory', 'read_terminal', 'list_terminals', 'web_search', 'fetch_url', 'see_page',
  'view_image', 'read_clipboard', 'recall_facts', 'get_datetime', 'screen_info', 'list_reminders', 'list_ssh_hosts',
  'project_overview',
]);
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
function resetTurnGuards() {
  S().toolCallLog = [];
  S().stateSeq = 0;
  S().readFilesThisTurn = new Set();
}
function noteFileRead(abs) {
  try {
    S().readFilesThisTurn.add(path.resolve(abs));
  } catch (e) {
    /* ok */
  }
}
function wasFileRead(abs) {
  try {
    return S().readFilesThisTurn.has(path.resolve(abs));
  } catch (e) {
    return true;
  }
}
// trecho do arquivo MAIS PARECIDO com o old_text que não bateu (modelo corrige em 1 retry)
function closestRegion(lines, oldText) {
  const oldLines = String(oldText || '').split('\n');
  const probe = oldLines.map((l) => l.trim()).find((l) => l.length >= 3);
  if (!probe) return null;
  const pl = probe.slice(0, 80).toLowerCase();
  let best = -1;
  // passo 1: substring direta (caso comum: só indentação/vizinhança erradas)
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(pl)) {
      best = i;
      break;
    }
  }
  // passo 2: linha mais próxima por distância (só se não achou substring; capado pra não pesar)
  if (best < 0) {
    let bestScore = 0.51;
    const cap = Math.min(lines.length, 4000);
    for (let i = 0; i < cap; i++) {
      const cand = lines[i].trim().slice(0, 80).toLowerCase();
      if (!cand || Math.abs(cand.length - pl.length) > pl.length * 0.6) continue;
      const d = levenshtein(pl, cand) / Math.max(pl.length, cand.length, 1);
      if (d < bestScore) {
        bestScore = d;
        best = i;
        if (d === 0) break;
      }
    }
  }
  if (best < 0) return null;
  const start = Math.max(1, best + 1 - 2);
  const end = Math.min(lines.length, best + 1 + Math.min(oldLines.length + 2, 14));
  const snippet = [];
  for (let i = start; i <= end; i++) snippet.push(String(i).padStart(4) + ': ' + (lines[i - 1] || '').slice(0, 200));
  return { start, end, snippet: snippet.join('\n') };
}
// caminho não existe → sugere os caminhos REAIS mais parecidos do workspace
async function suggestPaths(cfg, wanted) {
  try {
    if (!cfg || !cfg.workspace) return [];
    const tree = await cachedWsTree(cfg); // reusa o cache da árvore (caminho de erro fica instantâneo)
    const w = String(wanted || '').replace(/\\/g, '/').toLowerCase();
    const base = w.split('/').pop() || w;
    const scored = [];
    for (const rel of tree) {
      const rb = rel.toLowerCase().split('/').pop();
      let score;
      if (rb === base) score = 0; // mesmo nome, pasta diferente
      else if (rb.includes(base) || base.includes(rb)) score = 0.2;
      else score = levenshtein(base.slice(0, 48), rb.slice(0, 48)) / Math.max(base.length, rb.length, 1);
      if (score <= 0.4) scored.push({ rel, score });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, 3).map((s) => s.rel);
  } catch (e) {
    return [];
  }
}
// detecta o comando de teste do projeto (pra run_tests) → { cmd, runner }
function guessTestCommand(ws) {
  const has = (f) => {
    try {
      return fs.existsSync(path.join(ws, f));
    } catch (e) {
      return false;
    }
  };
  const readf = (f) => {
    try {
      return fs.readFileSync(path.join(ws, f), 'utf8');
    } catch (e) {
      return '';
    }
  };
  if (has('package.json') && /"test"\s*:/.test(readf('package.json'))) {
    const cmd = has('pnpm-lock.yaml') ? 'pnpm test' : has('yarn.lock') ? 'yarn test' : has('bun.lockb') ? 'bun test' : 'npm test';
    return { cmd, runner: 'node' };
  }
  if (has('pytest.ini') || has('pyproject.toml') || has('setup.cfg') || has('tox.ini')) return { cmd: 'pytest -q', runner: 'pytest' };
  if (has('go.mod')) return { cmd: 'go test ./...', runner: 'go' };
  if (has('Cargo.toml')) return { cmd: 'cargo test', runner: 'cargo' };
  if (has('pom.xml')) return { cmd: 'mvn -q test', runner: 'maven' };
  if (has('build.gradle') || has('build.gradle.kts')) return { cmd: (has('gradlew') ? (process.platform === 'win32' ? 'gradlew' : './gradlew') : 'gradle') + ' test', runner: 'gradle' };
  return null;
}
// aplica o filtro (arquivo ou nome de teste) do jeito de cada runner
function withTestFilter(base, runner, filter) {
  const f = String(filter).trim();
  const isPath = /[\/\\.]/.test(f);
  const q = JSON.stringify(f);
  if (runner === 'node') return base + (isPath ? ' -- ' + f : ' -- -t ' + q);
  if (runner === 'pytest') return 'pytest -q ' + (isPath ? f : '-k ' + q);
  if (runner === 'go') return 'go test ./... -run ' + f;
  if (runner === 'cargo') return 'cargo test ' + f;
  return base + ' ' + f;
}

// ---- GUARDRAILS: comandos destrutivos/irreversíveis (bloqueados por padrão) ----
const DANGEROUS_CMD = [
  /\brm\s+-[rfRF]{1,2}\s+(?:\/(?:\s|$)|~|\$HOME|\*|\.\s|--no-preserve-root)/,
  /\bsudo\s+rm\b/,
  /\bgit\s+push\b[^\n]*(?:--force(?!-with-lease)|--mirror|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-[a-z]*f[a-z]*d/,
  /\b(?:curl|wget)\b[^|\n]*\|\s*(?:sudo\s+)?(?:bash|sh|zsh)\b/,
  /\bmkfs\b/,
  /\bdd\b[^\n]*\bof=\/dev\//,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;/,
  /\b(?:shutdown|reboot|halt|poweroff)\b/,
  /\bformat\s+[A-Za-z]:/i,
  /\bRemove-Item\b[^\n]*-Recurse[^\n]*-Force[^\n]*[\\/](?:\*)?\s*$/i,
  /\b(?:npm\s+publish|yarn\s+publish|cargo\s+publish|twine\s+upload|gem\s+push)\b/,
];
function dangerousCommand(cmd) {
  const c = String(cmd || '');
  for (const re of DANGEROUS_CMD) {
    if (re.test(c)) return 'comando bloqueado pelos guardrails (destrutivo/irreversível). Se for REALMENTE necessário, peça ao usuário para rodar manualmente.';
  }
  return null;
}
// arquivo protegido (nunca apagar/sobrescrever) — bate por nome-base ou caminho relativo
function isPreciousFile(cfg, abs) {
  const list = Array.isArray(cfg && cfg.preciousFiles) ? cfg.preciousFiles : [];
  if (!list.length || !abs) return false;
  const ws = (cfg && cfg.workspace) || '';
  const rel = ws && path.resolve(abs).startsWith(path.resolve(ws)) ? path.relative(ws, abs).replace(/\\/g, '/').toLowerCase() : '';
  const base = path.basename(abs).toLowerCase();
  return list.some((p) => {
    const q = String(p || '').trim().toLowerCase().replace(/\\/g, '/');
    return !!q && (q === base || q === rel || (rel && rel.endsWith('/' + q)));
  });
}

// ---- FORMAT-ON-SAVE: roda o formatter do projeto no arquivo editado (best-effort, opt-in) ----
async function formatFileIfEnabled(cfg, abs) {
  if (!cfg || !cfg.formatOnSave || !abs || !cfg.workspace) return;
  const ws = cfg.workspace;
  const ext = path.extname(abs).toLowerCase();
  const win = process.platform === 'win32';
  const PRETTIER = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.json', '.jsonc', '.css', '.scss', '.less', '.html', '.vue', '.svelte', '.md', '.mdx', '.yaml', '.yml', '.graphql'];
  let bin = null;
  let args = null;
  if (PRETTIER.includes(ext)) {
    const local = path.join(ws, 'node_modules', '.bin', 'prettier' + (win ? '.cmd' : ''));
    try {
      if (!fs.existsSync(local)) return; // só formata se o PROJETO tem prettier (não força npx lento)
    } catch (e) {
      return;
    }
    bin = local;
    args = ['--write', abs];
  } else if (ext === '.py') {
    bin = resolveExe('black');
    args = ['-q', abs];
  } else if (ext === '.go') {
    bin = resolveExe('gofmt');
    args = ['-w', abs];
  } else if (ext === '.rs') {
    bin = resolveExe('rustfmt');
    args = [abs];
  } else return;
  try {
    await execFileAsync(bin, args, { cwd: ws, timeout: 15000, windowsHide: true });
  } catch (e) {
    /* formatter ausente/erro → silencioso, não atrapalha a edição */
  }
}

// ---- DIAGNÓSTICOS: roda o linter/type-checker do projeto e devolve problemas estruturados ----
function _localBin(ws, name) {
  const b = path.join(ws, 'node_modules', '.bin', name + (process.platform === 'win32' ? '.cmd' : ''));
  try {
    return fs.existsSync(b) ? b : null;
  } catch (e) {
    return null;
  }
}
function _relTo(ws, f) {
  try {
    const abs = path.isAbsolute(f) ? f : path.join(ws, f);
    return path.relative(ws, abs).replace(/\\/g, '/');
  } catch (e) {
    return String(f).replace(/\\/g, '/');
  }
}
function parseTsc(ws, out) {
  const probs = [];
  const re = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+TS\d+:\s+(.+)$/gm;
  let m;
  while ((m = re.exec(out))) probs.push({ file: _relTo(ws, m[1]), line: +m[2], col: +m[3], severity: m[4], message: m[5].trim(), source: 'tsc' });
  return probs;
}
function parseEslintJson(ws, out) {
  const probs = [];
  let arr;
  try {
    arr = JSON.parse(out);
  } catch (e) {
    return probs;
  }
  for (const f of arr || []) for (const mm of f.messages || []) probs.push({ file: _relTo(ws, f.filePath), line: mm.line || 1, col: mm.column || 1, severity: mm.severity === 2 ? 'error' : 'warning', message: (mm.message || '') + (mm.ruleId ? ' (' + mm.ruleId + ')' : ''), source: 'eslint' });
  return probs;
}
function parseRuffJson(ws, out) {
  const probs = [];
  let arr;
  try {
    arr = JSON.parse(out);
  } catch (e) {
    return probs;
  }
  for (const d of arr || []) probs.push({ file: _relTo(ws, d.filename), line: (d.location && d.location.row) || 1, col: (d.location && d.location.column) || 1, severity: 'warning', message: (d.code ? d.code + ' ' : '') + (d.message || ''), source: 'ruff' });
  return probs;
}
function parseColonList(ws, out, source) {
  const probs = [];
  const re = /^(.+?):(\d+):(\d+):\s+(.+)$/gm;
  let m;
  while ((m = re.exec(out))) {
    const msg = m[4].trim();
    probs.push({ file: _relTo(ws, m[1]), line: +m[2], col: +m[3], severity: /\bwarn/i.test(msg) ? 'warning' : 'error', message: msg, source });
  }
  return probs;
}
async function runChecker(bin, args, ws) {
  try {
    const { stdout, stderr } = await execFileAsync(bin, args, { cwd: ws, timeout: 90000, windowsHide: true, maxBuffer: 24 * 1024 * 1024 });
    return { out: stdout || '', err: stderr || '' };
  } catch (e) {
    return { out: (e && e.stdout) || '', err: (e && e.stderr) || '', code: e && e.code, missing: e && e.code === 'ENOENT' };
  }
}
async function checkProject(cfg) {
  const ws = cfg.workspace;
  if (!ws) return { error: 'nenhum workspace aberto' };
  const has = (f) => {
    try {
      return fs.existsSync(path.join(ws, f));
    } catch (e) {
      return false;
    }
  };
  const problems = [];
  const tools = [];
  // JS/TS: eslint (local) + tsc (local, se tsconfig)
  const eslint = _localBin(ws, 'eslint');
  if (eslint) {
    const r = await runChecker(eslint, ['.', '--format', 'json', '--ext', '.js,.jsx,.ts,.tsx,.vue,.svelte'], ws);
    tools.push('eslint');
    problems.push(...parseEslintJson(ws, r.out || r.err));
  }
  const tsc = _localBin(ws, 'tsc');
  if (tsc && has('tsconfig.json')) {
    const r = await runChecker(tsc, ['--noEmit', '--pretty', 'false'], ws);
    tools.push('tsc');
    problems.push(...parseTsc(ws, (r.out || '') + (r.err || '')));
  }
  // Python: ruff (json) ou flake8
  if (has('pyproject.toml') || has('setup.cfg') || has('requirements.txt') || has('pytest.ini')) {
    let r = await runChecker(resolveExe('ruff'), ['check', '--output-format', 'json', '.'], ws);
    if (!r.missing && (r.out || '').trim().startsWith('[')) {
      tools.push('ruff');
      problems.push(...parseRuffJson(ws, r.out));
    } else {
      r = await runChecker(resolveExe('flake8'), ['.'], ws);
      if (!r.missing) {
        tools.push('flake8');
        problems.push(...parseColonList(ws, r.out || r.err, 'flake8'));
      }
    }
  }
  // Go / Rust
  if (has('go.mod')) {
    const r = await runChecker(resolveExe('go'), ['vet', './...'], ws);
    if (!r.missing) {
      tools.push('go vet');
      problems.push(...parseColonList(ws, r.err || r.out, 'go vet'));
    }
  }
  if (has('Cargo.toml')) {
    const r = await runChecker(resolveExe('cargo'), ['check', '--message-format', 'short'], ws);
    if (!r.missing) {
      tools.push('cargo');
      problems.push(...parseColonList(ws, r.err || r.out, 'cargo'));
    }
  }
  if (!tools.length) return { problems: [], tools: [], note: 'nenhum linter/type-checker disponível (instale eslint/typescript no projeto, ou ruff/flake8/go/cargo).' };
  // dedup + ordena (erros primeiro) + cap
  const seen = new Set();
  const uniq = [];
  for (const p of problems) {
    const k = p.file + ':' + p.line + ':' + p.col + ':' + p.message;
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(p);
    if (uniq.length >= 300) break;
  }
  uniq.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  const errors = uniq.filter((p) => p.severity === 'error').length;
  return { problems: uniq, total: uniq.length, errors, warnings: uniq.length - errors, tools };
}
function normalizeEolText(s) {
  return String(s == null ? '' : s).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}
function dominantEol(s) {
  const crlf = (String(s).match(/\r\n/g) || []).length;
  const lf = (String(s).replace(/\r\n/g, '').match(/\n/g) || []).length;
  return crlf > lf ? '\r\n' : '\n';
}
function adaptEolText(s, eol) {
  return normalizeEolText(s).replace(/\n/g, eol || '\n');
}
function normalizeWithIndexMap(s) {
  const text = String(s || '');
  let normalized = '';
  const starts = [];
  const ends = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\r') {
      normalized += '\n';
      starts.push(i);
      if (text[i + 1] === '\n') {
        ends.push(i + 2);
        i++;
      } else {
        ends.push(i + 1);
      }
    } else {
      normalized += text[i];
      starts.push(i);
      ends.push(i + 1);
    }
  }
  return { normalized, starts, ends };
}
function replaceTextSmart(original, oldText, newText, all) {
  const oldRaw = String(oldText);
  const replacement = adaptEolText(newText, dominantEol(original));
  const exactCount = original.split(oldRaw).length - 1;
  if (exactCount) {
    if (exactCount > 1 && !all) return { error: `old_text aparece ${exactCount} vezes — inclua mais linhas de contexto para ficar único, ou passe all=true para trocar todas` };
    const idx = original.indexOf(oldRaw);
    return {
      count: all ? exactCount : 1,
      mode: 'exact',
      text: all ? original.split(oldRaw).join(replacement) : original.slice(0, idx) + replacement + original.slice(idx + oldRaw.length),
    };
  }

  const needle = normalizeEolText(oldRaw);
  if (!needle) return { count: 0 };
  const mapped = normalizeWithIndexMap(original);
  const matches = [];
  let pos = mapped.normalized.indexOf(needle);
  while (pos >= 0) {
    const endNorm = pos + needle.length - 1;
    matches.push({ start: mapped.starts[pos], end: mapped.ends[endNorm] });
    pos = mapped.normalized.indexOf(needle, pos + Math.max(1, needle.length));
  }
  if (!matches.length) return { count: 0 };
  if (matches.length > 1 && !all) return { error: `old_text aparece ${matches.length} vezes ao normalizar CRLF/LF — inclua mais linhas de contexto para ficar único, ou passe all=true para trocar todas` };

  const use = all ? matches : matches.slice(0, 1);
  let out = '';
  let cursor = 0;
  for (const m of use) {
    out += original.slice(cursor, m.start) + replacement;
    cursor = m.end;
  }
  out += original.slice(cursor);
  return { count: use.length, mode: 'eol-normalized', text: out };
}
function rgIgnoreArgs() {
  const names = new Set([...(typeof WS_HEAVY !== 'undefined' ? WS_HEAVY : []), '.git', '.lumi-*']);
  const out = [];
  for (const n of names) out.push('--glob', '!**/' + n + '/**', '--glob', '!' + n + '/**');
  out.push('--glob', '!**/.lumi-*/**');
  return out;
}
function globEscape(s) {
  return String(s || '').replace(/[\\[\]{}()*?!]/g, (m) => '\\' + m);
}
let rgExeCache = undefined;
function rgAvailable() {
  if (rgExeCache !== undefined) return rgExeCache;
  const check = (exe) => {
    try {
      require('child_process').execFileSync(exe, ['--version'], { windowsHide: true, timeout: 1500, stdio: 'ignore' });
      return true;
    } catch (e) {
      return false;
    }
  };
  rgExeCache = null;
  // 1) rg no PATH
  const onPath = resolveExe('rg');
  if (check(onPath)) {
    rgExeCache = onPath;
    return rgExeCache;
  }
  // 2) ripgrep empacotado via @vscode/ripgrep (se a dependência existir) — ativa sozinho
  try {
    const bundled = require('@vscode/ripgrep').rgPath;
    if (bundled && check(bundled)) rgExeCache = bundled;
  } catch (e) {
    /* pacote ausente: segue sem rg (usa fallback JS async) */
  }
  return rgExeCache;
}
function runRgLines(args, opts) {
  return new Promise((resolve) => {
    const o = opts || {};
    const exe = rgAvailable();
    if (!exe) return resolve({ ok: false, error: 'rg indisponível' });
    const child = spawn(exe, args, { cwd: o.cwd || undefined, windowsHide: true });
    let buf = '';
    let stderr = '';
    let killed = false;
    const stop = () => {
      if (killed) return;
      killed = true;
      try {
        child.kill();
      } catch (e) {
        /* processo já morreu */
      }
    };
    const timer = setTimeout(stop, Math.max(1000, Math.min(o.timeoutMs || 4500, 15000)));
    child.stdout.on('data', (d) => {
      buf += d.toString('utf8');
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).replace(/\r$/, '');
        buf = buf.slice(idx + 1);
        if (line && o.onLine && o.onLine(line) === false) stop();
      }
      if (buf.length > 256 * 1024) buf = buf.slice(-64 * 1024);
    });
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString('utf8')).slice(-2000);
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String((e && e.message) || e) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (buf.trim() && o.onLine) o.onLine(buf.trim());
      resolve({ ok: code === 0 || code === 1 || killed, code, killed, stderr });
    });
  });
}
async function rgFindInCode(ws, query) {
  const q = String(query || '');
  const byName = [];
  const hits = [];
  let limited = false;
  const ignore = rgIgnoreArgs();

  await runRgLines(['--files', '--no-messages', '--iglob', '*' + globEscape(q) + '*', ...ignore, ws], {
    timeoutMs: 2500,
    onLine(line) {
      const rel = path.relative(ws, path.isAbsolute(line) ? line : path.join(ws, line)).replace(/\\/g, '/');
      if (rel && !rel.startsWith('..') && byName.length < 30) byName.push(rel);
      if (byName.length >= 30) {
        limited = true;
        return false;
      }
      return true;
    },
  });

  const content = await runRgLines(
    [
      '--json',
      '--fixed-strings',
      '--ignore-case',
      '--max-count',
      '20',
      '--max-filesize',
      '800K',
      '--no-messages',
      ...ignore,
      '--',
      q,
      ws,
    ],
    {
      timeoutMs: 4500,
      onLine(line) {
        if (hits.length >= 50) {
          limited = true;
          return false;
        }
        let j;
        try {
          j = JSON.parse(line);
        } catch (e) {
          return true;
        }
        if (j.type !== 'match' || !j.data) return true;
        const file = ((j.data.path && j.data.path.text) || '').replace(/\\/g, '/');
        const rel = path.isAbsolute(file) ? path.relative(ws, file).replace(/\\/g, '/') : file;
        const text = ((j.data.lines && j.data.lines.text) || '').trim().slice(0, 180);
        hits.push({ file: rel, line: j.data.line_number || 1, text });
        return true;
      },
    }
  );
  if (!content.ok) return null;
  return { files_matching_name: [...new Set(byName)], content_matches: hits, limited };
}

// grep via ripgrep p/ o tool grep_files: rápido, respeita .gitignore/ignores, async com timeout.
// devolve null se rg indisponível (aí o caller usa o fallback JS async).
async function rgGrep(baseDir, wsBase, pattern, isRegex) {
  const matches = [];
  let limited = false;
  const args = ['--json', '--ignore-case', '--max-count', '20', '--max-filesize', '1M', '--no-messages'];
  if (!isRegex) args.push('--fixed-strings');
  args.push(...rgIgnoreArgs(), '--', String(pattern), baseDir);
  const r = await runRgLines(args, {
    timeoutMs: 6000,
    onLine(line) {
      if (matches.length >= 120) {
        limited = true;
        return false;
      }
      let j;
      try {
        j = JSON.parse(line);
      } catch (e) {
        return true;
      }
      if (j.type !== 'match' || !j.data) return true;
      const file = ((j.data.path && j.data.path.text) || '').replace(/\\/g, '/');
      const rel = path.isAbsolute(file) ? path.relative(wsBase, file).replace(/\\/g, '/') : file;
      const text = ((j.data.lines && j.data.lines.text) || '').replace(/[\r\n]+$/, '').trim().slice(0, 240);
      matches.push({ file: rel, line: j.data.line_number || 1, text });
      return true;
    },
  });
  if (!r.ok) return null;
  return { matches, limited };
}

// busca global do EDITOR (Ctrl+Shift+F) via ripgrep — devolve {path,line,col,text}. null = rg indisponível.
async function rgSearchEditor(ws, query) {
  const results = [];
  let truncated = false;
  const MAXR = 400;
  const ql = String(query).toLowerCase();
  const args = ['--json', '--fixed-strings', '--ignore-case', '--max-count', '20', '--max-filesize', '1M', '--no-messages', ...rgIgnoreArgs(), '--', String(query), ws];
  const r = await runRgLines(args, {
    timeoutMs: 8000,
    onLine(line) {
      if (results.length >= MAXR) {
        truncated = true;
        return false;
      }
      let j;
      try {
        j = JSON.parse(line);
      } catch (e) {
        return true;
      }
      if (j.type !== 'match' || !j.data) return true;
      const file = ((j.data.path && j.data.path.text) || '').replace(/\\/g, '/');
      const rel = path.isAbsolute(file) ? path.relative(ws, file).replace(/\\/g, '/') : file;
      const lineText = ((j.data.lines && j.data.lines.text) || '').replace(/[\r\n]+$/, '');
      const col = (lineText.toLowerCase().indexOf(ql) + 1) || 1; // coluna em chars (igual ao fallback)
      results.push({ path: rel, line: j.data.line_number || 1, col, text: lineText.trim().slice(0, 200) });
      return true;
    },
  });
  if (!r.ok) return null;
  return { results, truncated };
}

// ---- BUSCA NA WEB (precisa): Tavily (recomendado) | Brave | DuckDuckGo (sem chave) ----
async function webSearch(cfg, query, count) {
  const n = Math.min(10, Math.max(1, Math.round(count || 5)));
  const provider = cfg.searchProvider || 'duckduckgo';
  const key = cfg.searchApiKey || '';
  if (!query.trim()) return { error: 'consulta vazia' };

  if (provider === 'tavily') {
    if (!key) return { error: 'defina a chave da Tavily em ⚙ → I.A. → Busca na web (grátis em tavily.com)' };
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ api_key: key, query, max_results: n, include_answer: true, search_depth: 'basic' }),
    });
    if (!res.ok) return { error: `Tavily HTTP ${res.status}: ${truncate(await res.text(), 300)}` };
    const j = await res.json();
    return {
      provider: 'tavily',
      answer: j.answer || '',
      results: (j.results || []).map((r) => ({ title: r.title, url: r.url, snippet: truncate(r.content, 600) })),
    };
  }

  if (provider === 'brave') {
    if (!key) return { error: 'defina a chave do Brave Search em ⚙ → I.A. → Busca na web' };
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`,
      { headers: { Accept: 'application/json', 'X-Subscription-Token': key } }
    );
    if (!res.ok) return { error: `Brave HTTP ${res.status}: ${truncate(await res.text(), 300)}` };
    const j = await res.json();
    return {
      provider: 'brave',
      results: ((j.web && j.web.results) || []).map((r) => ({ title: r.title, url: r.url, snippet: truncate(r.description, 600) })),
    };
  }

  // GRÁTIS (sem chave): SearXNG próprio (se configurado) → públicas (rápido) → DuckDuckGo.
  const sx = await searxSearch(query, n, cfg.searxUrl);
  if (sx && sx.results && sx.results.length) return sx;
  const ddg = await ddgSearch(query, n);
  if (ddg && ddg.results && ddg.results.length) return ddg;
  return { provider: 'free', results: [], note: 'nenhum buscador gratuito respondeu agora — tente reformular ou configure Tavily (grátis) nas configurações' };
}

// instâncias públicas do SearXNG com API JSON (limitam bastante; o ideal é apontar o SEU
// em "URL do seu SearXNG" — docker searxng/searxng no VPS = busca ilimitada sem chave)
const SEARX_INSTANCES = ['https://searx.be', 'https://search.inetol.net', 'https://priv.au', 'https://opnxng.com', 'https://searx.tiekoetter.com'];
let searxIdx = 0;
async function searxOnce(base, query, n, timeout) {
  const res = await fetch(base.replace(/\/$/, '') + '/search?q=' + encodeURIComponent(query) + '&format=json&language=pt-BR&safesearch=0', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36', Accept: 'application/json' },
    signal: AbortSignal.timeout(timeout),
  });
  if (!res.ok) return null;
  const j = await res.json();
  const results = (j.results || []).slice(0, n).map((r) => ({ title: r.title, url: r.url, snippet: truncate(r.content || '', 600) }));
  if (!results.length) return null;
  const answer = (j.answers && j.answers[0] && (j.answers[0].answer || j.answers[0])) || '';
  return { provider: 'searxng (' + base.replace(/^https?:\/\//, '').replace(/\/$/, '') + ')', answer: typeof answer === 'string' ? answer : '', results };
}
async function searxSearch(query, n, customUrl) {
  // 1) instância do usuário (sem limite) tem prioridade
  if (customUrl && /^https?:\/\//i.test(customUrl)) {
    try {
      const r = await searxOnce(customUrl, query, n, 10000);
      if (r) return r;
    } catch (e) {
      /* cai pras públicas */
    }
  }
  // 2) públicas: 2 tentativas curtas (elas limitam o JSON; não vale travar a busca)
  for (let tries = 0; tries < 2; tries++) {
    const base = SEARX_INSTANCES[searxIdx % SEARX_INSTANCES.length];
    searxIdx++;
    try {
      const r = await searxOnce(base, query, n, 5000);
      if (r) return r;
    } catch (e) {
      /* próxima */
    }
  }
  return null;
}
async function ddgSearch(query, n) {
  try {
    const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const results = [];
    const re = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    const snipRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    const strip = (h) => h.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
    const decodeUddg = (href) => {
      const m = /[?&]uddg=([^&]+)/.exec(href);
      return m ? decodeURIComponent(m[1]) : href.startsWith('//') ? 'https:' + href : href;
    };
    let m;
    const snips = [];
    while ((m = snipRe.exec(html))) snips.push(strip(m[1]));
    let i = 0;
    while ((m = re.exec(html)) && results.length < n) {
      results.push({ title: strip(m[2]), url: decodeUddg(m[1]), snippet: snips[i] || '' });
      i++;
    }
    return { provider: 'duckduckgo', results };
  } catch (e) {
    return null;
  }
}

// HTML -> texto legível (modo leitura do fetch_url): remove scripts/menus/tags,
// foca no conteúdo principal e decodifica entidades. Local e grátis.
function htmlToText(html) {
  let s = String(html);
  s = s.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<noscript[\s\S]*?<\/noscript>/gi, '');
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(header|nav|footer|aside)[\s\S]*?<\/\1>/gi, ' '); // menus/rodapés fora
  const main = s.match(/<(main|article)[^>]*>[\s\S]*?<\/\1>/i);
  if (main && main[0].length > 800) s = main[0]; // foca no conteúdo principal quando ele existe
  s = s.replace(/<(h[1-6])[^>]*>/gi, '\n\n## ').replace(/<li[^>]*>/gi, '\n• ');
  s = s.replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section)[^>]*>/gi, '\n');
  s = s.replace(/<[^>]+>/g, ' ');
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;|&#x27;/g, "'")
    .replace(/&#(\d+);/g, (m, c) => String.fromCharCode(parseInt(c, 10)));
  return s.replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// diff por linha (LCS) -> [{t:' '|'+'|'-', v}]; transmite pro chat ao editar arquivos
function lineDiff(oldStr, newStr) {
  const a = (oldStr || '').split('\n');
  const b = (newStr || '').split('\n');
  // PODA de prefixo/sufixo comuns ANTES do LCS: a edição típica muda uma região pequena —
  // sem isso, editar um arquivo de 3000 linhas alocava uma matriz 3000×3000 (~9M células)
  // A CADA edição (GC + dezenas de ms). Com a poda, o LCS roda só na janela alterada.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let endA = a.length;
  let endB = b.length;
  while (endA > pre && endB > pre && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const m = endA - pre;
  const n = endB - pre;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[pre + i] === b[pre + j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  for (let k = 0; k < pre; k++) out.push({ t: ' ', v: a[k], j: k }); // prefixo comum (contexto)
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[pre + i] === b[pre + j]) {
      out.push({ t: ' ', v: a[pre + i], j: pre + j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', v: a[pre + i++] });
    else out.push({ t: '+', v: b[pre + j++] });
  }
  while (i < m) out.push({ t: '-', v: a[pre + i++] });
  while (j < n) out.push({ t: '+', v: b[pre + j++] });
  for (let k = endB; k < b.length; k++) out.push({ t: ' ', v: b[k], j: k }); // sufixo comum (contexto)
  return out;
}
function broadcastDiff(relPath, oldC, newC) {
  if (oldC === newC) return;
  const a = (oldC || '').split('\n');
  const b = (newC || '').split('\n');
  if (a.length + b.length > 6000) {
    broadcast('chat:diff', { path: relPath, big: true, removed: a.length, added: b.length });
    return;
  }
  const all = lineDiff(oldC, newC);
  const added = all.filter((l) => l.t === '+').length;
  const removed = all.filter((l) => l.t === '-').length;
  // compacta: mantem so as mudancas + 2 linhas de contexto, colapsa o resto
  const keep = new Array(all.length).fill(false);
  all.forEach((l, idx) => {
    if (l.t !== ' ') for (let k = Math.max(0, idx - 2); k <= Math.min(all.length - 1, idx + 2); k++) keep[k] = true;
  });
  let lines = [];
  let gap = false;
  for (let idx = 0; idx < all.length; idx++) {
    if (keep[idx]) {
      lines.push(all[idx]);
      gap = false;
    } else if (!gap) {
      lines.push({ t: ' ', v: '⋯' });
      gap = true;
    }
  }
  if (lines.length > 500) lines = lines.slice(0, 500).concat([{ t: ' ', v: '…[diff cortado]' }]);
  broadcast('chat:diff', { path: relPath, lines, added, removed });
}

// ============================================================
//  Terminal integrado (PTY real via node-pty + xterm.js na UI)
//  - usuário abre/fecha terminais no painel do workspace (estilo VS Code)
//  - a IA usa run_in_terminal p/ processos LONGOS (dev server, watch) sem travar
// ============================================================
let nodePty = null;
try {
  nodePty = require('node-pty');
} catch (e) {
  console.error('node-pty indisponível (terminal integrado desligado):', e.message);
}
const terminals = new Map(); // id -> { p, title, buf }
let termSeq = 0;

// Dual-mode: PTY real (node-pty) quando compilado pro Electron; senão PIPE (spawn) —
// funciona em qualquer máquina (sem toolchain), só perde interatividade/cores ricas.
// batch da saída dos terminais (~16ms): coalesce de chunks antes do IPC — imperceptível
// no eco de digitação, e corta drasticamente o custo em builds com saída pesada
const termBatch = new Map(); // id -> texto acumulado
let termFlushTimer = null;
function flushTermBatch() {
  if (termFlushTimer) {
    clearTimeout(termFlushTimer);
    termFlushTimer = null;
  }
  if (!termBatch.size) return;
  for (const [id, data] of termBatch) {
    const rec = terminals.get(id);
    if (rec && rec.owner != null) sendToWc(rec.owner, 'term:data', { id, data }); // terminal de janela: só a dona
    else sendToAll('term:data', { id, data });
  }
  termBatch.clear();
}

function createTerminal(opts) {
  const o = opts || {};
  // perfil customizado (WSL, CMD, Git Bash, SSH, docker logs/exec...) ou o shell padrão
  const shell = resolveExe(o.shell || (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash'));
  const profArgs = o.shell ? (Array.isArray(o.args) ? o.args : []) : null; // null = padrões de sempre
  const cwd = o.cwd || loadConfig().workspace || require('os').homedir();
  const id = 't' + ++termSeq;
  const title = o.title || path.basename(shell, '.exe');
  logd('term:create', { shell, args: profArgs, cwd, pty: !!nodePty });
  // owner = webContents da janela que criou (terminais POR JANELA); null = da Lumi/global (todas veem)
  const rec = { p: null, pty: false, title, buf: '', ai: !!o.ai, owner: o.owner != null ? o.owner : null };
  const push = (d) => {
    rec.buf = (rec.buf + d).slice(-200000); // final do scrollback (replay da UI + leitura da IA)
    // BATCH 16ms: build despejando MB/s virava um IPC por chunk × janelas × frames — e cada
    // broadcast ainda descarregava o batch de tokens do chat. Junta e envia direto (sendToAll).
    termBatch.set(id, (termBatch.get(id) || '') + d);
    if (!termFlushTimer) termFlushTimer = setTimeout(flushTermBatch, 16);
  };
  const onExit = (code) => {
    flushTermBatch(); // entrega o resto da saída ANTES do exit (ordem preservada)
    if (rec.owner != null) sendToWc(rec.owner, 'term:exit', { id, exitCode: code });
    else broadcast('term:exit', { id, exitCode: code });
    terminals.delete(id);
  };
  try {
    if (nodePty) {
      rec.pty = true;
      rec.p = nodePty.spawn(shell, profArgs || [], { name: 'xterm-256color', cols: o.cols || 100, rows: o.rows || 28, cwd, env: process.env });
      rec.p.onData(push);
      rec.p.onExit(({ exitCode }) => onExit(exitCode));
    } else {
      // modo PIPE: powershell/bash lendo comandos do stdin (a UI faz o eco local)
      rec.p = spawn(shell, profArgs || (process.platform === 'win32' ? ['-NoLogo'] : []), { cwd, env: process.env, windowsHide: true });
      const conv = (d) => push(String(d).replace(/\r?\n/g, '\r\n')); // xterm precisa de \r\n
      rec.p.stdout.on('data', conv);
      rec.p.stderr.on('data', conv);
      rec.p.on('exit', onExit);
      rec.p.on('error', (e) => push('\r\n[erro: ' + e.message + ']\r\n'));
    }
  } catch (e) {
    logd('term:create FALHOU', shell, String((e && e.message) || e));
    return { error: 'não consegui abrir o terminal (' + path.basename(shell) + '): ' + e.message };
  }
  terminals.set(id, rec);
  // a UI cria a aba: terminal de janela vai SÓ pra dona; da Lumi (owner null) vai pra todas
  if (rec.owner != null) sendToWc(rec.owner, 'term:opened', { id, title, pty: rec.pty });
  else broadcast('term:opened', { id, title, pty: rec.pty });
  if (o.command) termWrite(rec, String(o.command) + (rec.pty ? '\r' : '\n'));
  return { id, pid: rec.p.pid, shell: title, pty: rec.pty };
}
function termWrite(rec, data) {
  try {
    if (rec.pty) rec.p.write(data);
    else rec.p.stdin.write(data);
  } catch (e) {
    /* processo pode ter morrido */
  }
}
function termKill(rec) {
  try {
    if (!rec.pty && process.platform === 'win32') exec('taskkill /PID ' + rec.p.pid + ' /T /F', { windowsHide: true });
    else rec.p.kill();
  } catch (e) {
    /* ok */
  }
}
function stripAnsi(s) {
  // limpa códigos de cor/cursor pro modelo ler texto puro
  return String(s)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[=>()][0-9A-Z]?/g, '')
    .replace(/\r/g, '');
}

const termOwnersHooked = new Set(); // janelas com terminais: ao fechar, mata os dela (sem órfãos invisíveis)
ipcMain.handle('term:create', (e, opts) => {
  const wcId = e.sender.id;
  if (!termOwnersHooked.has(wcId)) {
    termOwnersHooked.add(wcId);
    e.sender.once('destroyed', () => {
      termOwnersHooked.delete(wcId);
      for (const [, r] of terminals) if (r.owner === wcId) termKill(r);
    });
  }
  return createTerminal({ ...(opts || {}), cwd: (opts && opts.cwd) || winWorkspace.get(wcId) || undefined, owner: wcId });
});

// perfis de terminal (▾ ao lado do ＋): PowerShell/CMD/Git Bash/WSL no Windows, bash no Linux
ipcMain.handle('term:profiles', async () => {
  const profs = [];
  if (process.platform === 'win32') {
    profs.push({ label: 'PowerShell', shell: 'powershell.exe' });
    profs.push({ label: 'CMD', shell: 'cmd.exe' });
    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => {
      try {
        return fs.existsSync(p);
      } catch (e) {
        return false;
      }
    });
    if (gitBash) profs.push({ label: 'Git Bash', shell: gitBash });
    try {
      // saída do wsl -l -q vem em UTF-16 → tira os NUL antes de separar
      const { stdout } = await execAsync('wsl -l -q', { timeout: 5000, windowsHide: true });
      String(stdout)
        .replace(/\u0000/g, '')
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((d) => !/^docker-desktop/.test(d)) // distros internas do Docker não são shell de gente
        .forEach((d) => profs.push({ label: 'WSL: ' + d, shell: 'wsl.exe', args: ['-d', d] }));
    } catch (e) {
      /* sem WSL — segue o baile */
    }
  } else {
    profs.push({ label: 'bash', shell: 'bash' });
    profs.push({ label: 'sh', shell: 'sh' });
  }
  // SSH: hosts do ~/.ssh/config (sem curingas) — seu VPS a um clique
  try {
    const sshCfg = fs.readFileSync(path.join(require('os').homedir(), '.ssh', 'config'), 'utf8');
    [...sshCfg.matchAll(/^Host\s+([^\s*?#]+)\s*$/gim)]
      .map((m) => m[1])
      .slice(0, 12)
      .forEach((h) => profs.push({ label: 'SSH: ' + h, shell: 'ssh', args: [h] }));
  } catch (e) {
    /* sem ~/.ssh/config */
  }
  // venv Python do workspace (já ativado)
  try {
    const ws = loadConfig().workspace;
    if (ws) {
      if (process.platform === 'win32' && fs.existsSync(path.join(ws, '.venv', 'Scripts', 'activate.bat'))) {
        profs.push({ label: 'Python venv (.venv)', shell: 'cmd.exe', args: ['/k', path.join(ws, '.venv', 'Scripts', 'activate.bat')] });
      } else if (process.platform !== 'win32' && fs.existsSync(path.join(ws, '.venv', 'bin', 'activate'))) {
        profs.push({ label: 'Python venv (.venv)', shell: 'bash', args: ['-c', 'source .venv/bin/activate && exec bash'] });
      }
    }
  } catch (e) {
    /* ok */
  }
  return profs;
});

// ---- DOCKER (aba do painel): lista + ações nos containers ----
ipcMain.handle('docker:list', async () => {
  try {
    const { stdout } = await execAsync('docker ps -a --no-trunc --format "{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.Ports}}"', {
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    return {
      ok: true,
      containers: stdout
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [id, name, image, state, status, ports] = l.split('\t');
          return { id: (id || '').slice(0, 12), name: name || '?', image: image || '', state: state || '', status: status || '', ports: ports || '' };
        }),
    };
  } catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || e);
    if (/not recognized|não é reconhecid|command not found|not found|ENOENT/i.test(msg)) return { error: 'Docker não está instalado (ou fora do PATH).' };
    if (/pipe|daemon|connect|Cannot connect/i.test(msg)) return { error: 'Docker instalado, mas o daemon não está rodando — abra o Docker Desktop.' };
    return { error: msg.slice(0, 200) };
  }
});
// docker-compose do workspace (alimenta a barrinha "compose" da aba DOCKER)
ipcMain.handle('docker:compose-file', () => {
  const cfg = loadConfig();
  if (!cfg.workspace) return null;
  for (const f of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    try {
      if (fs.existsSync(path.join(cfg.workspace, f))) return f;
    } catch (e) {
      /* ok */
    }
  }
  return null;
});

// ---- TAREFAS do projeto: scripts do package.json + alvos do Makefile ----
ipcMain.handle('tasks:list', () => {
  const cfg = loadConfig();
  if (!cfg.workspace) return [];
  const out = [];
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(cfg.workspace, 'package.json'), 'utf8'));
    for (const name of Object.keys(pj.scripts || {})) out.push({ label: 'npm run ' + name, command: 'npm run ' + name });
  } catch (e) {
    /* sem package.json */
  }
  try {
    const mk = fs.readFileSync(path.join(cfg.workspace, 'Makefile'), 'utf8');
    mk.split('\n').forEach((l) => {
      const m = /^([A-Za-z0-9_.-]+)\s*:(?!=)/.exec(l);
      if (m && !m[1].startsWith('.')) out.push({ label: 'make ' + m[1], command: 'make ' + m[1] });
    });
  } catch (e) {
    /* sem Makefile */
  }
  return out.slice(0, 40);
});

// ---- túnel público (cloudflared/ngrok) pra expor um localhost ----
let tunnelTool;
ipcMain.handle('tunnel:check', async () => {
  if (tunnelTool !== undefined) return tunnelTool;
  try {
    await execAsync('cloudflared --version', { timeout: 5000, windowsHide: true });
    tunnelTool = 'cloudflared';
    return tunnelTool;
  } catch (e) {
    /* sem cloudflared */
  }
  try {
    await execAsync('ngrok version', { timeout: 5000, windowsHide: true });
    tunnelTool = 'ngrok';
    return tunnelTool;
  } catch (e) {
    tunnelTool = null;
    return null;
  }
});

// ---- GitHub via gh CLI (PRs, status do CI e criar PR com a Lumi) ----
let ghOk = null;
ipcMain.handle('gh:check', async () => {
  if (ghOk !== null) return ghOk;
  try {
    await execAsync('gh auth status', { timeout: 8000, windowsHide: true });
    ghOk = true;
  } catch (e) {
    ghOk = false;
  }
  return ghOk;
});
ipcMain.handle('gh:prs', async () => {
  const cfg = loadConfig();
  if (!cfg.workspace) return [];
  try {
    const { stdout } = await execAsync('gh pr list --limit 15 --json number,title,headRefName,url,isDraft', {
      cwd: cfg.workspace,
      timeout: 15000,
      windowsHide: true,
    });
    return JSON.parse(stdout);
  } catch (e) {
    return [];
  }
});
ipcMain.handle('gh:ci', async () => {
  const cfg = loadConfig();
  if (!cfg.workspace) return null;
  try {
    const { stdout: br } = await gitRun(cfg, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const { stdout } = await execAsync('gh run list -b "' + br.trim() + '" -L 1 --json status,conclusion,displayTitle,url', {
      cwd: cfg.workspace,
      timeout: 15000,
      windowsHide: true,
    });
    return JSON.parse(stdout)[0] || null;
  } catch (e) {
    return null;
  }
});
ipcMain.handle('gh:pr-create', async () => {
  const cfg = loadConfig();
  if (!cfg.workspace) return { error: 'nenhum workspace definido' };
  try {
    const { stdout: br } = await gitRun(cfg, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = br.trim();
    if (/^(main|master)$/.test(branch)) return { error: 'você está na ' + branch + ' — crie uma branch primeiro (clique no nome da branch)' };
    let base = 'main';
    try {
      await gitRun(cfg, ['rev-parse', '--verify', 'origin/main']);
    } catch (e) {
      base = 'master';
    }
    const { stdout: logs } = await gitRun(cfg, ['log', 'origin/' + base + '..HEAD', '--format=- %s']);
    const { stdout: stat } = await gitRun(cfg, ['diff', 'origin/' + base + '...HEAD', '--stat']);
    if (!logs.trim()) return { error: 'nenhum commit novo em relação à ' + base };
    const gen = await llmComplete(cfg, [
      {
        role: 'system',
        content:
          'Você escreve título e descrição de Pull Request em português. Responda EXATAMENTE neste formato:\nTITULO: <até 70 caracteres, imperativo>\n---\n<descrição em markdown: resumo curto, mudanças em bullets e como testar>',
      },
      { role: 'user', content: 'Commits da branch:\n' + logs.slice(0, 4000) + '\n\nArquivos alterados:\n' + stat.slice(0, 2000) },
    ]);
    const m = /TITULO:\s*(.+)\n+---\n+([\s\S]+)/.exec(gen || '');
    const title = ((m && m[1]) || branch).trim().slice(0, 100);
    const body = ((m && m[2]) || gen || 'PR da branch ' + branch).trim();
    const tmp = path.join(app.getPath('temp'), 'lumi-pr-body.md');
    fs.writeFileSync(tmp, body); // corpo via arquivo = sem briga de aspas no Windows
    const { stdout } = await execFileAsync('gh', ['pr', 'create', '--title', title, '--body-file', tmp, '--base', base], {
      cwd: cfg.workspace,
      timeout: 30000,
      windowsHide: true,
    });
    const url = stdout.trim().split('\n').pop();
    return { ok: true, url, title };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e).slice(0, 300) };
  }
});

// ============================================================
//  WORKSPACE REMOTO via SSH (SSHFS) — estilo Remote-SSH do VS Code
//  Monta a pasta do host remoto localmente e aponta o workspace pra ela:
//  editor, git, busca, terminal — tudo funciona como se fosse local.
//  Requer sshfs (Linux: pacote sshfs/fuse; Windows: SSHFS-Win + WinFsp).
// ============================================================
function sshConfigHosts() {
  try {
    const cfg = fs.readFileSync(path.join(require('os').homedir(), '.ssh', 'config'), 'utf8');
    return [...cfg.matchAll(/^Host\s+([^\s*?#]+)\s*$/gim)].map((m) => m[1]).slice(0, 30);
  } catch (e) {
    return [];
  }
}
// resolve um alias do ~/.ssh/config em {user, hostname, port} — o launcher do
// SSHFS-Win roda como serviço (SYSTEM) e NÃO lê o config do usuário, então a
// UNC do net use precisa do endereço real: \\sshfs\user@hostname!porta
function sshResolveAlias(alias) {
  const out = {};
  try {
    const lines = fs.readFileSync(path.join(require('os').homedir(), '.ssh', 'config'), 'utf8').split(/\r?\n/);
    let inBlock = false;
    for (const raw of lines) {
      const l = raw.trim();
      if (!l || l.startsWith('#')) continue;
      const h = /^Host\s+(.+)$/i.exec(l);
      if (h) {
        inBlock = h[1].split(/\s+/).includes(alias);
        continue;
      }
      if (!inBlock) continue;
      const kv = /^(\w+)[\s=]+(.+)$/.exec(l);
      if (!kv) continue;
      const k = kv[1].toLowerCase();
      if (k === 'hostname' && !out.hostname) out.hostname = kv[2].trim();
      else if (k === 'user' && !out.user) out.user = kv[2].trim();
      else if (k === 'port' && !out.port) out.port = kv[2].trim();
    }
  } catch (e) {
    /* sem config */
  }
  return out;
}
ipcMain.handle('ssh:hosts', () => sshConfigHosts());

// acha o binário do sshfs SEM depender do PATH do processo (que fica velho após
// uma instalação — o usuário instalava e a Lumi "não via" até reiniciar)
function findSshfs() {
  const cands =
    process.platform === 'win32'
      ? [
          path.join(process.env['ProgramFiles'] || 'C:\\Program Files', 'SSHFS-Win', 'bin', 'sshfs.exe'),
          path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'SSHFS-Win', 'bin', 'sshfs.exe'),
        ]
      : ['/usr/bin/sshfs', '/usr/local/bin/sshfs', '/bin/sshfs'];
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) {
      /* ok */
    }
  }
  try {
    // PATH como fallback (sem usar o cache do resolveExe — pode ter gravado "não achei" antes da instalação)
    const finder = process.platform === 'win32' ? 'where sshfs' : 'command -v sshfs';
    const opts = { windowsHide: true, timeout: 4000 };
    if (process.platform !== 'win32') opts.shell = '/bin/sh';
    const lines = require('child_process').execSync(finder, opts).toString().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const r = process.platform === 'win32' ? lines.find((l) => /\.exe$/i.test(l)) || lines[0] : lines[0];
    if (r && fs.existsSync(r)) return r;
  } catch (e) {
    /* não está em lugar nenhum */
  }
  return null;
}
ipcMain.handle('ssh:available', () => !!findSshfs());

// comando de instalação do sshfs pro sistema da pessoa (instalação assistida)
ipcMain.handle('ssh:install-cmd', async () => {
  if (process.platform === 'win32') return 'winget install -e --id WinFsp.WinFsp ; winget install -e --id SSHFS-Win.SSHFS-Win';
  if (IS_LINUX) {
    const has = (c) => {
      try {
        require('child_process').execSync('command -v ' + c, { shell: '/bin/sh', timeout: 3000 });
        return true;
      } catch (e) {
        return false;
      }
    };
    if (has('apt')) return 'sudo apt install -y sshfs';
    if (has('dnf')) return 'sudo dnf install -y fuse-sshfs';
    if (has('pacman')) return 'sudo pacman -S --noconfirm sshfs';
  }
  return null; // sistema desconhecido → instrução manual
});

// ---- acesso por chave AUTOMÁTICO: gera id_rsa (sem passphrase), instala no servidor
// (o usuário digita a senha do SSH UMA vez no terminal) e valida — depois disso o
// mount e os terminais SSH nunca mais perguntam nada ----
const sshKeyOkHosts = new Set(); // hosts já validados nesta sessão (não re-testa/re-instala)
ipcMain.handle('ssh:ensure-key', async (_e, host) => {
  if (sshKeyOkHosts.has(host)) return { ready: true };
  const sshDir = path.join(require('os').homedir(), '.ssh');
  const keyPath = path.join(sshDir, 'id_rsa');
  try {
    fs.mkdirSync(sshDir, { recursive: true });
  } catch (e) {
    /* ok */
  }
  if (!fs.existsSync(keyPath)) {
    logd('ssh:ensure-key gerando id_rsa (sem passphrase)');
    try {
      await execFileAsync(resolveExe('ssh-keygen'), ['-q', '-t', 'rsa', '-b', '4096', '-N', '', '-f', keyPath], { timeout: 30000, windowsHide: true });
    } catch (e) {
      return { error: 'não consegui gerar a chave: ' + String((e && e.stderr) || (e && e.message) || e).slice(0, 200) };
    }
  }
  // testa a chave; distingue SUCESSO / FALHA-DE-AUTH (precisa instalar) / problema-de-REDE
  const test = async () => {
    try {
      const { stdout } = await execFileAsync(
        resolveExe('ssh'),
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', host, 'echo __lumi_ok'],
        { timeout: 15000, windowsHide: true }
      );
      return /__lumi_ok/.test(String(stdout)) ? 'ok' : 'net';
    } catch (e) {
      const err = String((e && e.stderr) || (e && e.message) || e);
      // só "Permission denied / publickey" = a chave não autoriza → vale instalar.
      // timeout/conexão recusada/host inalcançável = REDE → não adianta instalar
      return /permission denied|publickey|password|authentication/i.test(err) ? 'auth' : 'net';
    }
  };
  const r0 = await test();
  if (r0 === 'ok') {
    sshKeyOkHosts.add(host);
    return { ready: true };
  }
  if (r0 === 'net') {
    // servidor não respondeu: NÃO abre o terminal de instalação (era o "chave nova toda hora").
    // segue pro mount mesmo assim — se a chave já estiver lá, o mount funciona; senão o net use avisa.
    logd('ssh:ensure-key: servidor não respondeu ao teste — seguindo sem reinstalar', host);
    return { ready: true, unverified: true };
  }
  // r0 === 'auth' → a chave não está autorizada: instala a .pub no servidor (senha 1x no terminal)
  const pub = keyPath + '.pub';
  const remoteCmd = 'mkdir -p ~/.ssh && cat >> ~/.ssh/authorized_keys && chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys && echo CHAVE-INSTALADA';
  const command =
    process.platform === 'win32'
      ? 'Get-Content "' + pub + '" | ssh -o StrictHostKeyChecking=accept-new ' + host + ' "' + remoteCmd + '"'
      : 'cat "' + pub + '" | ssh -o StrictHostKeyChecking=accept-new ' + host + " '" + remoteCmd + "'";
  const t = createTerminal({ command, title: 'chave: ' + host });
  if (t && t.error) return { error: t.error };
  logd('ssh:ensure-key instalando no servidor', host);
  // espera a senha ser digitada e a chave pegar (testa de 4 em 4s, até 3min)
  const t0 = Date.now();
  while (Date.now() - t0 < 180000) {
    await new Promise((r) => setTimeout(r, 4000));
    if ((await test()) === 'ok') {
      sshKeyOkHosts.add(host);
      logd('ssh:ensure-key OK', host);
      return { ready: true, installed: true };
    }
  }
  return { error: 'a chave não ficou pronta em 3min — digitou a senha no terminal "chave: ' + host + '"? (deve aparecer CHAVE-INSTALADA)' };
});

// ============================================================
//  PAINEL DO SERVIDOR (systemd + recursos) — opera no remoto SSH ativo,
//  ou na própria máquina se for Linux. No Windows sem remoto, fica inerte.
// ============================================================
function serverCtx() {
  if (remoteMount) return { kind: 'remote', host: remoteMount.host };
  if (IS_LINUX) return { kind: 'local' };
  return { kind: 'none' };
}
async function serverRun(cmd, timeout, retries) {
  const ctx = serverCtx();
  if (ctx.kind === 'none') throw new Error('sem servidor (conecte a um host SSH ou rode no Linux)');
  // retry só em LEITURAS (idempotentes): a 1ª conexão a um host "frio" costuma demorar mais
  // que o timeout — algumas tentativas com backoff resolvem a flakiness. Ações NÃO usam retry.
  const tries = (retries == null ? 0 : retries) + 1;
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      if (ctx.kind === 'remote') {
        const { stdout } = await execFileAsync(
          resolveExe('ssh'),
          ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', ctx.host, cmd],
          { timeout: timeout || 18000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
        );
        return stdout;
      }
      const { stdout } = await execAsync(cmd, { timeout: timeout || 18000, maxBuffer: 4 * 1024 * 1024 });
      return stdout;
    } catch (e) {
      lastErr = e;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1200)); // respiro antes de retentar
    }
  }
  throw lastErr;
}
// REST client (aba do painel): dispara a requisição e devolve a resposta completa
ipcMain.handle('rest:send', async (_e, { method, url, headers, body }) => {
  const u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) return { error: 'a URL deve começar com http:// ou https://' };
  const m = (method || 'GET').toUpperCase();
  const hdrs = {};
  for (const line of String(headers || '').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) hdrs[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  const t0 = Date.now();
  try {
    const res = await fetch(u, {
      method: m,
      headers: Object.keys(hdrs).length ? hdrs : undefined,
      body: body != null && body !== '' && m !== 'GET' && m !== 'HEAD' ? String(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    const h = {};
    res.headers.forEach((v, k) => (h[k] = v));
    let pretty = text;
    if (/application\/json|^\s*[[{]/.test(res.headers.get('content-type') || text)) {
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch (e) {
        /* não era JSON válido */
      }
    }
    return { status: res.status, ok: res.ok, ms: Date.now() - t0, size: text.length, headers: h, body: pretty.slice(0, 200000) };
  } catch (e) {
    return { error: String((e && e.message) || e) + (/(localhost|127\.0\.0\.1)/.test(u) ? ' — o servidor local está rodando?' : '') };
  }
});

ipcMain.handle('server:context', () => serverCtx());
ipcMain.handle('server:stats', async () => {
  const ctx = serverCtx();
  if (ctx.kind === 'none') return { error: 'conecte a um servidor SSH (📡) ou rode no Linux' };
  try {
    const cmd =
      "echo UP:$(uptime -p 2>/dev/null | sed 's/^up //'); " +
      "echo LOAD:$(cut -d' ' -f1-3 /proc/loadavg):$(nproc); " +
      "echo MEM:$(free -b | awk '/Mem:/{print $2\" \"$3}'); " +
      "echo DISK:$(df -B1 / | awk 'NR==2{print $2\" \"$3\" \"$5}')";
    const out = await serverRun(cmd, 15000, 3); // até 4 tentativas (1ª conexão fria demora)
    const g = (re) => (re.exec(out) || [])[1] || '';
    const mem = g(/MEM:(.+)/).trim().split(/\s+/).map(Number);
    const disk = g(/DISK:(.+)/).trim().split(/\s+/);
    const load = g(/LOAD:(.+)/).trim().split(/[:\s]+/);
    return {
      ctx,
      uptime: g(/UP:(.+)/).trim(),
      cores: parseInt(load[3], 10) || 1,
      load: load.slice(0, 3).join(' '),
      memTotal: mem[0] || 0,
      memUsed: mem[1] || 0,
      diskTotal: parseInt(disk[0], 10) || 0,
      diskUsed: parseInt(disk[1], 10) || 0,
      diskPct: disk[2] || '?',
    };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 160) };
  }
});
ipcMain.handle('server:services', async () => {
  try {
    const out = await serverRun('systemctl list-units --type=service --all --no-pager --no-legend --plain 2>/dev/null | head -200', 15000, 2);
    const svcs = [];
    for (const line of out.split(/\r?\n/)) {
      const m = /^(\S+\.service)\s+\S+\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line.trim());
      if (m) svcs.push({ name: m[1].replace(/\.service$/, ''), active: m[2], sub: m[3], desc: m[4] });
    }
    // ativos/falhos primeiro
    svcs.sort((a, b) => (b.active === 'active') - (a.active === 'active') || a.name.localeCompare(b.name));
    return { services: svcs };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 160) };
  }
});
ipcMain.handle('server:action', async (_e, { name, action }) => {
  if (!/^[\w.@-]+$/.test(String(name || '')) || !['start', 'stop', 'restart'].includes(action)) return { error: 'inválido' };
  try {
    // tenta sem sudo; serviços de sistema podem exigir sudo -n (sem senha) configurado
    await serverRun('systemctl ' + action + " '" + name + "' 2>&1 || sudo -n systemctl " + action + " '" + name + "' 2>&1", 30000);
    return { ok: true };
  } catch (e) {
    const err = String((e && e.message) || e);
    return { error: /password|sudo/i.test(err) ? 'precisa de sudo sem senha pra esse serviço (visudo: NOPASSWD)' : err.slice(0, 200) };
  }
});
// logs ao vivo de um serviço, no terminal integrado (journalctl -fu)
ipcMain.handle('server:logs', (_e, name) => {
  if (!/^[\w.@-]+$/.test(String(name || ''))) return { error: 'nome inválido' };
  const ctx = serverCtx();
  const jcmd = 'journalctl -fu ' + name + ' -n 100 --no-pager';
  if (ctx.kind === 'remote') return createTerminal({ shell: 'ssh', args: ['-t', ctx.host, jcmd], title: 'logs: ' + name });
  if (ctx.kind === 'local') return createTerminal({ command: jcmd, title: 'logs: ' + name });
  return { error: 'sem servidor' };
});

// navegador de pastas remotas (autocomplete tipo Remote-SSH do VS Code): lista as
// subpastas de um caminho no servidor — evita errar o path (a chave já está ok)
ipcMain.handle('ssh:listdir', async (_e, { host, path: p }) => {
  const dir = p && p.trim() ? p.trim() : '.';
  try {
    const q = dir.replace(/'/g, "'\\''");
    const { stdout } = await execFileAsync(
      resolveExe('ssh'),
      ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', host, "cd '" + q + "' && pwd && ls -1p"],
      { timeout: 15000, windowsHide: true }
    );
    const lines = String(stdout).split(/\r?\n/);
    const cwd = (lines.shift() || dir).trim(); // 1ª linha = caminho absoluto resolvido
    const dirs = lines
      .filter((l) => l.endsWith('/'))
      .map((l) => l.replace(/\/$/, ''))
      .filter((n) => n && n !== '.' && n !== '..')
      .sort((a, b) => a.localeCompare(b));
    return { cwd, dirs };
  } catch (e) {
    const err = String((e && e.stderr) || (e && e.message) || e);
    return { error: /no such file|not a directory/i.test(err) ? 'pasta não encontrada' : err.slice(0, 160) };
  }
});

let remoteMount = null; // { host, mountPoint, prevWorkspace }
async function unmountRemote() {
  if (!remoteMount) return;
  const mp = remoteMount.mountPoint;
  logd('ssh:unmount', mp);
  try {
    if (process.platform === 'win32') {
      // net use /delete encerra o backend sshfs GRACIOSAMENTE (confirmado: o processo some).
      // NÃO dar taskkill /F depois — force-kill atropela o cleanup do WinFsp.Launcher e
      // deixa a UNC envenenada → erro 64 ao remontar a mesma pasta (causa real do bug).
      await execAsync('net use ' + mp + ' /delete /y', { windowsHide: true, timeout: 10000 }).catch(() => {});
    } else {
      await execAsync('fusermount -u "' + mp + '"', { timeout: 8000 }).catch(() => execAsync('umount "' + mp + '"', { timeout: 8000 }).catch(() => {}));
    }
  } catch (e) {
    /* best-effort */
  }
  // fecha terminais abertos pelo mount (net use / ssh de brinde) — senão ficam zumbis
  if (remoteMount.terms) {
    for (const id of remoteMount.terms) {
      const t = terminals.get(id);
      if (t) {
        try {
          termKill(t);
        } catch (e) {
          /* ok */
        }
      }
    }
  }
  remoteMount = null;
}
async function doSshMount(host, remotePath) {
  if (!host) return { error: 'host vazio' };
  const sshfsBin = findSshfs();
  if (!sshfsBin) return { error: 'sshfs não encontrado. Instale: Linux → "sudo apt install sshfs"; Windows → SSHFS-Win + WinFsp.' };
  // VALIDA o path no servidor ANTES de montar — o sshfs monta drive quebrado se a pasta não
  // existe e o vigia só descobre via timeout de 90s (caso real: /home/targex/TargeX vs
  // .../targex/TargeX). Com a chave já ok, esse teste é instantâneo e dá erro claro.
  const rpTrim = (remotePath || '').trim();
  if (rpTrim && rpTrim !== '.') {
    try {
      const { stdout } = await execFileAsync(
        resolveExe('ssh'),
        ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', host, "test -d '" + rpTrim.replace(/'/g, "'\\''") + "' && echo __OK || echo __NODIR"],
        { timeout: 15000, windowsHide: true }
      );
      if (/__NODIR/.test(stdout)) {
        logd('ssh:mount path inexistente', host, rpTrim);
        return { error: 'a pasta "' + rpTrim + '" não existe no servidor (confira o caminho — Linux diferencia maiúsculas)' };
      }
    } catch (e) {
      /* rede instável no teste: segue e deixa o mount tentar mesmo assim */
    }
  }
  if (remoteMount) await unmountRemote().catch(() => {});
  let mp; // ponto de montagem passado pro sshfs
  let wsPath; // caminho que vira o workspace
  if (process.platform === 'win32') {
    // derruba QUALQUER conexão sshfs anterior na TABELA do net use — zumbis "Indisponível"
    // nem aparecem como unidade (existsSync falso) mas bloqueiam a reconexão (erro 64/1219)
    try {
      const { stdout } = await execAsync('net use', { windowsHide: true, timeout: 8000 });
      for (const line of stdout.split(/\r?\n/)) {
        if (!/\\\\sshfs/i.test(line)) continue;
        const letter = /\s([A-Z]):(\s|$)/.exec(line);
        const remote = /(\\\\sshfs\S*)/i.exec(line);
        const target = letter ? letter[1] + ':' : remote && remote[1];
        if (!target) continue;
        logd('ssh:mount derrubando conexão sshfs anterior', target);
        await execAsync('net use ' + target + ' /delete /y', { windowsHide: true, timeout: 8000 }).catch(() => {});
      }
    } catch (e) {
      /* sem conexões listáveis — segue */
    }
    // limpa unidades de rede MORTAS de tentativas anteriores (existem mas não listam)
    for (const L of 'ZYXWVUTSRQPONML') {
      const root = L + ':\\';
      try {
        if (fs.existsSync(root)) {
          try {
            fs.readdirSync(root);
          } catch (dead) {
            logd('ssh:mount limpando unidade morta', L + ':');
            await execAsync('net use ' + L + ': /delete /y', { windowsHide: true, timeout: 8000 }).catch(() => {});
          }
        }
      } catch (e) {
        /* segue */
      }
    }
    // respiro pro WinFsp.Launcher concluir o cleanup das conexões deletadas antes de
    // remontar (sem isso, remontar a MESMA pasta rápido demais dá erro 64). Sem taskkill:
    // o /delete acima já encerra os backends; force-kill envenenaria a UNC.
    await new Promise((r) => setTimeout(r, 1500));
    // SSHFS-Win/WinFsp: letra de unidade é o formato robusto ("invalid mount point" com diretório)
    for (const L of 'ZYXWVUTSRQPONML') {
      if (!fs.existsSync(L + ':\\')) {
        mp = L + ':';
        break;
      }
    }
    if (!mp) return { error: 'nenhuma letra de unidade livre (Z–L ocupadas?)' };
    wsPath = mp + '\\';
  } else {
    const safe = String(host).replace(/[^\w.-]/g, '_');
    const base = path.join(app.getPath('userData'), 'remotes');
    try {
      fs.mkdirSync(base, { recursive: true });
    } catch (e) {
      /* ok */
    }
    mp = path.join(base, safe);
    try {
      fs.mkdirSync(mp, { recursive: true }); // no Linux o mountpoint precisa existir
    } catch (e) {
      /* ok */
    }
    wsPath = mp;
  }
  let t;
  if (process.platform === 'win32') {
    // jeito CANÔNICO do SSHFS-Win: net use + \\sshfs\host — a senha é pedida pelo
    // net.exe (NATIVO, funciona no nosso PTY; senha em programa cygwin sob ConPTY
    // chega corrompida — caso real) e o launcher do WinFsp roda o sshfs em 2º plano
    const p = (remotePath || '').trim();
    // o alias do config vira user@hostname!porta (o serviço do WinFsp não lê o seu ~/.ssh/config)
    const r = sshResolveAlias(host);
    const userHost = (r.user ? r.user + '@' : '') + (r.hostname || host) + (r.port && r.port !== '22' ? '!' + r.port : '');
    // SSHFS-Win tem 4 variantes: sshfs (senha) / sshfs.k (CHAVE) / .r e .kr (caminho absoluto).
    // Com id_rsa no perfil usa a de chave — monta sem NENHUM prompt (validado de ponta a ponta)
    const hasKey = fs.existsSync(path.join(require('os').homedir(), '.ssh', 'id_rsa'));
    const abs = p && p.startsWith('/');
    const svc = '\\\\sshfs' + (hasKey ? '.k' : '') + (abs ? (hasKey ? 'r' : '.r') : '') + '\\';
    const unc = svc + userHost + (abs ? p.replace(/\//g, '\\') : p && p !== '.' ? '\\' + p.replace(/\//g, '\\') : '');
    t = createTerminal({ shell: 'net', args: ['use', mp, unc, '/persistent:no'], title: 'sshfs: ' + host });
    logd('ssh:mount via net use', mp, unc, hasKey ? '(chave)' : '(senha)');
  } else {
    const spec = host + ':' + (remotePath && remotePath.trim() ? remotePath.trim() : '.');
    const args = [spec, mp, '-o', 'reconnect,ServerAliveInterval=15,ServerAliveCountMax=3,StrictHostKeyChecking=accept-new,idmap=user'];
    // roda NO TERMINAL INTEGRADO (PTY): senha e confirmação de host key aparecem e funcionam
    t = createTerminal({ shell: sshfsBin, args, title: 'sshfs: ' + host });
    logd('ssh:mount via terminal', sshfsBin, spec, '→', mp);
  }
  if (t && t.error) return { error: t.error };
  // vigia o ponto de montagem por até 35s (com chave monta em segundos; path já foi validado)
  const t0 = Date.now();
  while (Date.now() - t0 < 35000) {
    await new Promise((r) => setTimeout(r, 1500));
    try {
      await fs.promises.readdir(wsPath); // async: não trava o main se o SFTP estiver lento
      if (process.platform !== 'win32') {
        // linux: o dir existe antes — confirma que virou mountpoint de verdade
        require('child_process').execSync('mountpoint -q "' + mp + '"', { timeout: 3000 });
      }
      const prev = loadConfig().workspace || '';
      const terms = t && t.id ? [t.id] : []; // terminal do net use/sshfs — fechado no unmount
      // shell SSH no servidor de brinde, já no path montado (criado no MAIN pra ser rastreado/morto)
      const rp = (remotePath || '').trim();
      const sshArgs = rp && rp !== '.' ? ['-t', host, 'cd "' + rp.replace(/"/g, '\\"') + '" && exec ${SHELL:-bash} -l'] : [host];
      const st = createTerminal({ shell: 'ssh', args: sshArgs, title: 'SSH: ' + host });
      if (st && st.id) terms.push(st.id);
      remoteMount = { host, mountPoint: mp, prevWorkspace: prev, terms };
      // remoteWs marca que o workspace é um mount de sessão — o boot seguinte restaura o prev
      saveConfig({ ...loadConfig(), workspace: wsPath, architectMode: true, remoteWs: { host, prev } });
      rememberRemote(host, rpTrim || '.'); // histórico (menu Arquivo → Remotos recentes)
      startWorkspaceWatcher(); // re-observa o novo workspace (modo rede: poll leve)
      broadcast('workspace:switched', wsPath);
      broadcast('config:changed');
      broadcast('remote:active', { host }); // a statusbar/menu marcam 📡 (inclusive se foi via chat)
      logd('ssh:mount OK', wsPath);
      return { ok: true, mountPoint: wsPath, host };
    } catch (e) {
      /* ainda não montou — continua vigiando */
    }
  }
  logd('ssh:mount TIMEOUT', host);
  // limpa o mount meio-feito (remoteMount ainda é null aqui) pra não deixar drive/terminal pendurado
  if (process.platform === 'win32') await execAsync('net use ' + mp + ' /delete /y', { windowsHide: true }).catch(() => {});
  if (t && t.id) {
    const tt = terminals.get(t.id);
    if (tt) {
      try {
        termKill(tt);
      } catch (e) {
        /* ok */
      }
    }
  }
  return { error: 'não montou — confira o terminal "sshfs: ' + host + '" (caminho? permissão?) e o lumi.log' };
}
// histórico de pastas remotas (volta num clique pelo menu Arquivo)
function rememberRemote(host, p) {
  try {
    const c = loadConfig();
    const list = (c.recentRemotes || []).filter((r) => !(r.host === host && r.path === p));
    list.unshift({ host, path: p });
    saveConfig({ ...c, recentRemotes: list.slice(0, 8) });
  } catch (e) {
    /* ok */
  }
}
ipcMain.handle('ssh:mount', (_e, { host, remotePath }) => doSshMount(host, remotePath));
ipcMain.handle('ssh:recents', () => loadConfig().recentRemotes || []);
ipcMain.handle('ssh:unmount', async () => {
  const prev = (remoteMount && remoteMount.prevWorkspace) || (loadConfig().remoteWs && loadConfig().remoteWs.prev) || '';
  await unmountRemote();
  saveConfig({ ...loadConfig(), workspace: prev, remoteWs: undefined });
  startWorkspaceWatcher(); // volta a observar o workspace local
  broadcast('workspace:switched', prev);
  broadcast('config:changed');
  broadcast('remote:active', { host: null });
  return { ok: true };
});

ipcMain.handle('docker:action', async (_e, { id, action }) => {
  if (!/^[0-9a-f]{4,64}$/i.test(String(id || ''))) return { error: 'id inválido' };
  const map = { start: ['start'], stop: ['stop'], restart: ['restart'], rm: ['rm', '-f'] };
  const args = map[action];
  if (!args) return { error: 'ação inválida' };
  try {
    await execFileAsync('docker', [...args, id], { timeout: 60000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e).slice(0, 300) };
  }
});
ipcMain.on('term:input', (_e, { id, data }) => {
  const t = terminals.get(id);
  if (t) termWrite(t, data);
});
ipcMain.on('term:resize', (_e, { id, cols, rows }) => {
  const t = terminals.get(id);
  if (t && t.pty) {
    try {
      t.p.resize(cols, rows);
    } catch (e) {
      /* ok */
    }
  }
});
ipcMain.on('term:kill', (_e, id) => {
  const t = terminals.get(id);
  if (t) termKill(t);
});
ipcMain.handle('term:list', (e) =>
  [...terminals.entries()]
    .filter(([, r]) => r.owner == null || r.owner === e.sender.id) // cada janela vê os SEUS (+ os da Lumi)
    .map(([id, r]) => ({ id, pid: r.p.pid, title: r.title }))
);
ipcMain.handle('term:buffer', (_e, id) => {
  const t = terminals.get(id);
  return t ? t.buf : '';
});

// ---- tracker de portas (aba PORTAS): processos escutando + abrir/matar ----
async function listListeningPorts() {
  const out = [];
  try {
    if (process.platform === 'win32') {
      // sem "-p TCP": esse filtro mostra SÓ IPv4 e esconde os servers Node/etc.,
      // que por padrão escutam em IPv6 dual-stack ([::]:porta)
      const { stdout } = await execAsync('netstat -ano', { timeout: 8000, windowsHide: true });
      const names = {};
      try {
        const { stdout: tl } = await execAsync('tasklist /FO CSV /NH', { timeout: 8000, windowsHide: true });
        tl.split('\n').forEach((l) => {
          const m = l.match(/^"([^"]+)","(\d+)"/);
          if (m) names[m[2]] = m[1];
        });
      } catch (e) {
        /* sem nomes */
      }
      stdout.split('\n').forEach((l) => {
        const m = l.match(/^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (m) out.push({ port: parseInt(m[2], 10), pid: parseInt(m[3], 10), name: names[m[3]] || '?', addr: m[1] });
      });
    } else {
      const { stdout } = await execAsync('ss -tlnp 2>/dev/null || netstat -tlnp 2>/dev/null', { timeout: 8000 });
      stdout.split('\n').forEach((l) => {
        const pm = l.match(/[\s:](\d+)\s+[^ ]*\s+users:\(\("([^"]+)",pid=(\d+)/);
        const simple = l.match(/LISTEN.*?[\s:](\d+)\s/);
        if (pm) out.push({ port: parseInt(pm[1], 10), pid: parseInt(pm[3], 10), name: pm[2], addr: '' });
        else if (simple && /LISTEN/.test(l)) out.push({ port: parseInt(simple[1], 10), pid: 0, name: '?', addr: '' });
      });
    }
  } catch (e) {
    /* netstat/ss indisponível */
  }
  // dedupe por porta+pid e ordena
  const seen = new Set();
  return out
    .filter((p) => p.port > 0 && !seen.has(p.port + ':' + p.pid) && seen.add(p.port + ':' + p.pid))
    .sort((a, b) => a.port - b.port);
}
ipcMain.handle('ports:list', () => listListeningPorts());
ipcMain.handle('ports:kill', async (_e, pid) => {
  try {
    if (process.platform === 'win32') await execAsync('taskkill /PID ' + parseInt(pid, 10) + ' /T /F', { timeout: 8000, windowsHide: true });
    else process.kill(parseInt(pid, 10));
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
ipcMain.on('ports:open', (_e, port) => shell.openExternal('http://localhost:' + parseInt(port, 10)));

// ---- ask_user / Claude Code elicitation: pergunta e ESPERA a resposta do usuário ----
const pendingAsks = new Map(); // id -> {finish(answer), timer}
let askSeq = 0;
ipcMain.on('chat:ask-answer', (_e, { id, answer }) => {
  const ask = pendingAsks.get(id);
  if (ask) ask.finish(String(answer || '').slice(0, 5000));
});
function askUserInChat(question, options, opts) {
  return new Promise((resolve) => {
    const id = 'ask' + ++askSeq;
    const o = opts || {};
    const choices = (Array.isArray(options) ? options : []).slice(0, 8).map((x) => String(x).slice(0, 120));
    const fallback = String(o.fallback || '(o usuário não respondeu — siga seu melhor julgamento ou pare)');
    const timeoutMs = Math.max(30000, Math.min(Number(o.timeoutMs) || 10 * 60000, 30 * 60000));
    const finish = (answer) => {
      const rec = pendingAsks.get(id);
      if (!rec) return;
      clearTimeout(rec.timer);
      pendingAsks.delete(id);
      const a = String(answer || '').slice(0, 5000);
      broadcast('chat:ask-done', { id, answer: a });
      resolve(a);
    };
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    pendingAsks.set(id, { finish, timer });
    broadcast('chat:ask', { id, question: String(question || '').slice(0, 1600), options: choices });
  });
}

let _envInfoCache = null; // raio-X do ambiente (env_info) — 10 min de validade

// Registro de ferramentas: schema (pro modelo) + category (permissao) + run (execucao)
const TOOLS = {
  run_in_terminal: {
    category: 'exec',
    summary: (a) => `rodar no terminal: ${a.command}`,
    schema: {
      name: 'run_in_terminal',
      description:
        'Roda um comando LONGO/contínuo (dev server, watch) num terminal INTEGRADO visível, sem bloquear. ' +
        'REUTILIZE terminais: passe terminalId de um terminal seu que esteja LIVRE (sem servidor rodando) em vez de abrir outro. ' +
        'Sem terminalId, abre um novo (mantenho no máx. 2 abertos — o mais antigo é fechado). ' +
        'Feche com kill_terminal quando não precisar mais. Para comandos rápidos que terminam sozinhos, use run_command.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'comando a executar no terminal' },
          cwd: { type: 'string', description: 'pasta de trabalho (relativa ao workspace; vazio = workspace)' },
          terminalId: { type: 'string', description: 'id de um terminal já aberto para reutilizar (ex.: t1)' },
        },
        required: ['command'],
      },
    },
    run: async ({ command, cwd, terminalId }) => {
      // reutiliza um terminal existente (não digite num terminal com servidor rodando!)
      if (terminalId) {
        const t = terminals.get(String(terminalId));
        if (t) {
          termWrite(t, String(command) + (t.pty ? '\r' : '\n'));
          return { ok: true, terminalId: String(terminalId), reused: true, note: 'comando enviado ao terminal existente; use read_terminal para ver a saída' };
        }
      }
      // política anti-bagunça: no máx. 2 terminais abertos pela IA — fecha o mais antigo
      let closedNote = '';
      const aiTerms = [...terminals.entries()].filter(([, r]) => r.ai);
      if (aiTerms.length >= 2) {
        const [oldId, oldRec] = aiTerms[0];
        termKill(oldRec);
        closedNote = ' (fechei o terminal mais antigo ' + oldId + ' pra não acumular)';
      }
      const dir = cwd ? resolvePath(cwd) : undefined;
      const r = createTerminal({ command, cwd: dir, title: String(command).slice(0, 24), ai: true });
      if (r.error) return r;
      return { ok: true, terminalId: r.id, pid: r.pid, note: 'rodando no terminal integrado; use read_terminal({terminalId}) para acompanhar' + closedNote };
    },
  },
  read_terminal: {
    category: null, // só leitura do buffer
    summary: (a) => `ler o terminal ${a.terminalId}`,
    schema: {
      name: 'read_terminal',
      description: 'Lê a saída recente de um terminal integrado (aberto com run_in_terminal ou pelo usuário). Use para verificar se o servidor subiu, ver erros, etc.',
      parameters: {
        type: 'object',
        properties: {
          terminalId: { type: 'string', description: 'id do terminal (ex.: t1)' },
          chars: { type: 'number', description: 'quantos caracteres do final ler (padrão 4000)' },
        },
        required: ['terminalId'],
      },
    },
    run: async ({ terminalId, chars }) => {
      const t = terminals.get(String(terminalId));
      if (!t) return { error: 'terminal não encontrado: ' + terminalId + '. Abertos: ' + [...terminals.keys()].join(', ') };
      return { output: stripAnsi(t.buf).slice(-(Math.min(Number(chars) || 4000, 16000))) };
    },
  },
  list_terminals: {
    category: null,
    summary: () => 'listar terminais abertos',
    schema: {
      name: 'list_terminals',
      description: 'Lista os terminais integrados abertos (id, pid, título).',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => ({ terminals: [...terminals.entries()].map(([id, r]) => ({ id, pid: r.p.pid, title: r.title })) }),
  },
  kill_terminal: {
    category: 'exec',
    summary: (a) => `fechar o terminal ${a.terminalId}`,
    schema: {
      name: 'kill_terminal',
      description: 'Encerra um terminal integrado (mata o processo dele).',
      parameters: { type: 'object', properties: { terminalId: { type: 'string' } }, required: ['terminalId'] },
    },
    run: async ({ terminalId }) => {
      const t = terminals.get(String(terminalId));
      if (!t) return { error: 'terminal não encontrado: ' + terminalId };
      termKill(t);
      return { ok: true };
    },
  },
  get_datetime: {
    category: null,
    schema: { name: 'get_datetime', description: 'Retorna a data e a hora atuais do PC.', parameters: { type: 'object', properties: {} } },
    run: async () => ({ datetime: new Date().toLocaleString('pt-BR') }),
  },
  connect_remote: {
    category: 'exec', // monta um FS remoto e abre terminais — pede permissão de execução
    schema: {
      name: 'connect_remote',
      description:
        'Conecta a um servidor SSH e monta uma pasta dele como workspace (estilo Remote-SSH), quando o usuário pedir "conecta no <alias>". host = um alias do ~/.ssh/config (use list_ssh_hosts se não souber). path = pasta no servidor (opcional; vazio = home). A chave precisa já estar instalada (a 1ª vez é pelo botão 📡 do workspace).',
      parameters: {
        type: 'object',
        properties: { host: { type: 'string' }, path: { type: 'string' } },
        required: ['host'],
      },
    },
    run: async ({ host, path: p }) => {
      const hosts = sshConfigHosts();
      if (!hosts.includes(host)) return { error: 'host "' + host + '" não está no ~/.ssh/config. Disponíveis: ' + (hosts.join(', ') || '(nenhum)') };
      if (!sshKeyOkHosts.has(host)) {
        // testa a chave sem UI; se não autoriza, orienta usar o botão (que instala a chave)
        try {
          const { stdout } = await execFileAsync(
            resolveExe('ssh'),
            ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'StrictHostKeyChecking=accept-new', host, 'echo __ok'],
            { timeout: 15000, windowsHide: true }
          );
          if (/__ok/.test(stdout)) sshKeyOkHosts.add(host);
          else return { error: 'não consegui autenticar por chave em ' + host + '. Use o botão 📡 do workspace uma vez pra instalar a chave (pede a senha).' };
        } catch (e) {
          return { error: 'não consegui acessar ' + host + ' por chave. Use o botão 📡 do workspace a 1ª vez (instala a chave com a senha).' };
        }
      }
      const r = await doSshMount(host, p || '.');
      if (r && r.error) return { error: r.error };
      return { ok: true, mounted: host, at: r.mountPoint, note: 'workspace remoto ativo' };
    },
  },
  list_ssh_hosts: {
    category: null,
    schema: { name: 'list_ssh_hosts', description: 'Lista os aliases de servidores SSH do ~/.ssh/config (pra usar com connect_remote).', parameters: { type: 'object', properties: {} } },
    run: async () => ({ hosts: sshConfigHosts() }),
  },
  project_overview: {
    category: null,
    schema: {
      name: 'project_overview',
      description:
        'Mapa do projeto atual pra você entender a arquitetura SEM ler arquivo por arquivo: stack detectada, árvore de pastas/arquivos (resumida), e o conteúdo dos arquivos-chave (package.json, README, configs, pontos de entrada). Use quando o usuário pedir "explique o projeto" ou quando precisar de visão geral antes de mexer.',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace aberto (Modo arquiteto)' };
      const det = detectStackCached(cfg.workspace);
      const tree = [];
      await walkWorkspace(cfg.workspace, cfg.workspace, tree, 0); // já ignora node_modules/.git/etc e tem deadline
      // arquivos-chave que dão o panorama (lê os que existirem, com teto de tamanho)
      const keyNames = ['package.json', 'README.md', 'readme.md', 'pyproject.toml', 'requirements.txt', 'go.mod', 'Cargo.toml', 'composer.json', 'pom.xml', 'docker-compose.yml', 'Makefile', 'tsconfig.json', '.lumi-memory.md'];
      const key = {};
      for (const rel of tree) {
        const base = rel.split('/').pop();
        if (keyNames.includes(base) && !rel.includes('/')) {
          try {
            key[rel] = truncate(fs.readFileSync(path.join(cfg.workspace, rel), 'utf8'), 4000);
          } catch (e) {
            /* ok */
          }
        }
      }
      return {
        workspace: cfg.workspace,
        stack: det.stack || 'desconhecida',
        verifyCommand: det.verify || null,
        fileCount: tree.length,
        tree: tree.slice(0, 400),
        keyFiles: key,
        note:
          'Resuma a arquitetura, o propósito e como rodar; aponte os pontos de entrada.' +
          (fs.existsSync(path.join(cfg.workspace, 'CLAUDE.md'))
            ? ' O CLAUDE.md é o briefing estável — se notar que ele divergiu do código, sugira atualizá-lo (generate_project_doc update:true).'
            : ' Este projeto NÃO tem CLAUDE.md — ofereça gerar um com generate_project_doc (briefing estável pra todas as sessões). Decisões/gotchas vão na .lumi-memory (update_project_memory), sem duplicar o briefing.'),
      };
    },
  },
  find_in_code: {
    category: null,
    schema: {
      name: 'find_in_code',
      description:
        'Acha ONDE algo está no projeto por palavra-chave: procura no NOME dos arquivos E no conteúdo (regex/texto) ao mesmo tempo. Use pra "onde está X", "qual arquivo faz Y" antes de abrir/editar. Mais direto que grep_files quando você não sabe o nome exato.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    run: async ({ query }) => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace aberto' };
      const q = String(query || '').trim().slice(0, 200);
      if (!q) return { error: 'consulta vazia' };
      const rgResult = await rgFindInCode(cfg.workspace, q);
      if (rgResult) {
        await enrichMatches(cfg.workspace, rgResult.content_matches); // + symbol + context
        return {
          query: q,
          files_matching_name: rgResult.files_matching_name,
          content_matches: rgResult.content_matches,
          engine: 'ripgrep',
          note: 'content_matches trazem "symbol" e "context" — dá pra decidir sem abrir o arquivo. Pra ler o trecho, use read_file com symbol ou around_line.',
          truncated: rgResult.limited ? 'busca limitada para proteger memória/tempo; refine a consulta se necessário' : undefined,
        };
      }
      const ql = q.toLowerCase();
      const byName = [];
      // busca no CONTEÚDO (cap por tempo/quantidade, pula pastas pesadas)
      const hits = [];
      const deadline = Date.now() + 3500;
      let filesRead = 0;
      let bytesRead = 0;
      let limited = false;
      const MAX_FILES = 350;
      const MAX_BYTES = 6 * 1024 * 1024;
      const walk = async (dir, depth) => {
        if (hits.length >= 35 || depth > 8 || Date.now() > deadline || filesRead >= MAX_FILES || bytesRead >= MAX_BYTES) {
          limited = true;
          return;
        }
        let ents = [];
        try {
          ents = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const e of ents) {
          if (hits.length >= 35 || Date.now() > deadline || filesRead >= MAX_FILES || bytesRead >= MAX_BYTES) {
            limited = true;
            return;
          }
          if (WS_HEAVY.has(e.name) || WS_IGNORE.has(e.name) || (e.name.startsWith('.lumi-') && e.name !== '.lumi-memory.md')) continue;
          const full = path.join(dir, e.name);
          if (e.isDirectory()) {
            await walk(full, depth + 1);
            continue;
          }
          const rel = path.relative(cfg.workspace, full).replace(/\\/g, '/');
          if (byName.length < 30 && rel.toLowerCase().includes(ql)) byName.push(rel);
          try {
            const st = await fs.promises.stat(full);
            if (st.size > 500000) continue;
            filesRead++;
            bytesRead += st.size;
            const { text: txt } = await readTextFileSmartAsync(full);
            if (txt.includes('\0')) continue;
            const lines = txt.split('\n');
            for (let i = 0; i < lines.length && hits.length < 35; i++) {
              if (lines[i].toLowerCase().includes(ql)) hits.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 160) });
            }
          } catch (e2) {
            /* ok */
          }
        }
      };
      await walk(cfg.workspace, 0);
      await enrichMatches(cfg.workspace, hits); // + symbol + context
      return {
        query: q,
        files_matching_name: byName,
        content_matches: hits,
        engine: 'fallback-js',
        note: 'content_matches trazem "symbol" e "context" — dá pra decidir sem abrir o arquivo. Pra ler o trecho, use read_file com symbol ou around_line.',
        truncated: limited ? 'busca limitada para proteger memória/tempo; refine a consulta se necessário' : undefined,
      };
    },
  },
  read_clipboard: {
    category: 'screen', // mesma permissão de "ver" (conteúdo do usuário)
    schema: {
      name: 'read_clipboard',
      description: 'Lê o texto atual da área de transferência (o que o usuário copiou com Ctrl+C).',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const text = clipboard.readText() || '';
      if (!text.trim()) return { empty: true, note: 'área de transferência vazia (ou sem texto)' };
      return { text: text.slice(0, 20000), truncated: text.length > 20000 };
    },
  },
  write_clipboard: {
    category: 'control', // escreve no ambiente do usuário
    schema: {
      name: 'write_clipboard',
      description: 'Coloca um texto na área de transferência do usuário — pronto pro Ctrl+V.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    run: async ({ text }) => {
      const t = String(text == null ? '' : text);
      clipboard.writeText(t);
      return { ok: true, chars: t.length };
    },
  },
  play_animation: {
    category: null,
    schema: {
      name: 'play_animation',
      description: 'Faz a avatar reagir com uma emoção. Aceita português ou inglês: feliz/happy, triste/sad, brava/angry, surpresa/surprised, pensativa/relaxed, vergonha/blush.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    run: async ({ name }) => {
      const canon = normalizeEmotion(name) || String(name || '').toLowerCase(); // PT/EN → nome canônico
      broadcast('tool:animation', canon);
      return { played: canon };
    },
  },
  remember_fact: {
    category: null,
    schema: {
      name: 'remember_fact',
      description: 'Memoriza um fato sobre o usuário para lembrar depois.',
      parameters: { type: 'object', properties: { fact: { type: 'string' } }, required: ['fact'] },
    },
    run: async ({ fact }) => {
      const f = loadFacts();
      f.push({ fact, at: new Date().toISOString() });
      saveFacts(f.slice(-100));
      return { remembered: fact };
    },
  },
  recall_facts: {
    category: null,
    schema: { name: 'recall_facts', description: 'Lista os fatos memorizados sobre o usuário.', parameters: { type: 'object', properties: {} } },
    run: async () => ({ facts: loadFacts().map((x) => x.fact) }),
  },
  see_screen: {
    category: 'screen',
    summary: () => 'ver a sua tela (captura de tela)',
    schema: {
      name: 'see_screen',
      description:
        'Captura a tela do usuário para você poder VER o que está acontecendo nela. Use quando precisar enxergar a tela para ajudar.',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const img = await captureScreen();
      if (!img) return { error: 'não consegui capturar a tela' };
      const note = lastShot
        ? `Captura anexada. A imagem tem ${lastShot.imgW}x${lastShot.imgH}px — para mover/clicar, dê coordenadas NESSE espaço (origem no canto superior esquerdo).`
        : 'captura anexada';
      return { _image: img, note };
    },
  },
  // ---- MODO CONTROLE (computer use): mexer no mouse/teclado ----
  screen_info: {
    category: null,
    schema: { name: 'screen_info', description: 'Retorna o tamanho da tela em pixels e a resolução da última captura.', parameters: { type: 'object', properties: {} } },
    run: async () => {
      const d = screen.getPrimaryDisplay().size;
      return { screen: { width: d.width, height: d.height }, lastShot: lastShot || null };
    },
  },
  move_mouse: {
    category: 'control',
    summary: (a) => `mover o mouse para (${a.x}, ${a.y})`,
    schema: {
      name: 'move_mouse',
      description: 'Move o cursor do mouse. Use coordenadas no espaço da última captura de tela (see_screen).',
      parameters: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'] },
    },
    run: async ({ x, y }) => {
      const n = getNut();
      if (!n) return { error: nutUnavailableMsg() };
      const p = imgToScreen(x, y);
      await n.mouse.setPosition(new n.Point(p.x, p.y));
      return { ok: true, moved: p };
    },
  },
  click: {
    category: 'control',
    summary: (a) => `clicar (${a.button || 'esquerdo'}${a.double ? ', duplo' : ''}) em (${a.x}, ${a.y})`,
    schema: {
      name: 'click',
      description: 'Clica na tela. Coordenadas no espaço da última captura (see_screen). button: left|right|middle; double: true p/ duplo clique.',
      parameters: {
        type: 'object',
        properties: { x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string' }, double: { type: 'boolean' } },
        required: ['x', 'y'],
      },
    },
    run: async ({ x, y, button, double }) => {
      const n = getNut();
      if (!n) return { error: nutUnavailableMsg() };
      const p = imgToScreen(x, y);
      await n.mouse.setPosition(new n.Point(p.x, p.y));
      const b = button === 'right' ? n.Button.RIGHT : button === 'middle' ? n.Button.MIDDLE : n.Button.LEFT;
      if (double) await n.mouse.doubleClick(b);
      else await n.mouse.click(b);
      return { ok: true, clicked: p, button: button || 'left', double: !!double };
    },
  },
  scroll: {
    category: 'control',
    summary: (a) => `rolar a tela (${a.amount})`,
    schema: {
      name: 'scroll',
      description: 'Rola a tela. amount positivo = para baixo, negativo = para cima.',
      parameters: { type: 'object', properties: { amount: { type: 'number' } }, required: ['amount'] },
    },
    run: async ({ amount }) => {
      const n = getNut();
      if (!n) return { error: nutUnavailableMsg() };
      const a = Math.round(Number(amount) || 0);
      if (a >= 0) await n.mouse.scrollDown(a);
      else await n.mouse.scrollUp(-a);
      return { ok: true, scrolled: a };
    },
  },
  type_text: {
    category: 'control',
    summary: (a) => `digitar: ${truncate(a.text, 60)}`,
    schema: {
      name: 'type_text',
      description: 'Digita um texto na janela/campo que estiver em foco no momento.',
      parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    },
    run: async ({ text }) => {
      const n = getNut();
      if (!n) return { error: nutUnavailableMsg() };
      await n.keyboard.type(String(text == null ? '' : text));
      return { ok: true, typed: String(text || '').length + ' caracteres' };
    },
  },
  press_keys: {
    category: 'control',
    summary: (a) => `pressionar teclas: ${a.keys}`,
    schema: {
      name: 'press_keys',
      description: 'Pressiona uma combinação de teclas. Ex.: "enter", "ctrl+c", "alt+tab", "ctrl+shift+t".',
      parameters: { type: 'object', properties: { keys: { type: 'string' } }, required: ['keys'] },
    },
    run: async ({ keys }) => {
      const n = getNut();
      if (!n) return { error: nutUnavailableMsg() };
      const parts = String(keys || '').split('+').map((s) => s.trim()).filter(Boolean);
      const mapped = parts.map(nutKey);
      if (mapped.some((k) => k === undefined || k === null)) return { error: 'tecla desconhecida em: ' + keys };
      await n.keyboard.pressKey(...mapped);
      await n.keyboard.releaseKey(...mapped.slice().reverse());
      return { ok: true, pressed: keys };
    },
  },
  focus_window: {
    category: 'control',
    summary: (a) => `focar a janela "${a.title}"`,
    schema: {
      name: 'focus_window',
      description: 'Traz uma janela para frente pelo título (ou parte dele). Ex.: "Visual Studio Code", "Chrome".',
      parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    },
    run: async ({ title }) => {
      const t = String(title || '').replace(/'/g, "''");
      try {
        if (IS_LINUX) {
          // wmctrl (match parcial, case-insensitive); fallback xdotool
          const lt = String(title || '').replace(/'/g, "'\\''");
          await execAsync(`wmctrl -a '${lt}' || xdotool search --name '${lt}' windowactivate`, { timeout: 8000 });
          return { ok: true, focused: title };
        }
        await execAsync(
          `powershell -NoProfile -Command "(New-Object -ComObject WScript.Shell).AppActivate('${t}')"`,
          { timeout: 8000, windowsHide: true }
        );
        return { ok: true, focused: title };
      } catch (e) {
        if (IS_LINUX && /not found|não encontrado/i.test(String(e && e.message)))
          return { error: 'focar janela no Linux requer wmctrl ou xdotool (sudo apt install wmctrl xdotool)' };
        return { error: String((e && e.message) || e) };
      }
    },
  },
  read_project_memory: {
    category: 'read',
    summary: () => 'ler a memória do projeto',
    schema: {
      name: 'read_project_memory',
      description: 'Lê sua memória de TRABALHO do projeto (.lumi-memory.md): decisões, gotchas, preferências, pendências. Use pra retomar de onde parou. (O briefing estável — stack/estrutura/como rodar — vem do CLAUDE.md, já injetado no seu contexto.)',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace definido (ative o Modo Arquiteto)' };
      try {
        return { content: truncate(fs.readFileSync(workspaceMemoryPath(cfg), 'utf8'), 12000) };
      } catch (e) {
        return { content: '', note: 'memória vazia' };
      }
    },
  },
  update_project_memory: {
    category: 'write',
    summary: () => 'atualizar a memória do projeto',
    schema: {
      name: 'update_project_memory',
      description:
        'Salva sua memória de TRABALHO do projeto (.lumi-memory.md) — o caderno que sobrevive entre sessões. Estruture nas seções: "## Decisões" (o quê + PORQUÊ), "## Gotchas" (pegadinhas/armadilhas), "## Preferências do usuário", "## Pendências". NÃO duplique o briefing do CLAUDE.md (stack/estrutura/como rodar) nem o que é óbvio no código.',
      parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
    },
    run: async ({ content }) => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace definido (ative o Modo Arquiteto)' };
      const fp = workspaceMemoryPath(cfg);
      let oldC = '';
      try {
        oldC = fs.readFileSync(fp, 'utf8');
      } catch (e) {
        /* memória ainda não existe */
      }
      let newC = String(content || '');
      let compacted = false;
      // memória crescendo demais → compacta (modelo de tarefa; best-effort, nunca bloqueia o save)
      if (newC.length > 20000) {
        try {
          const c = await llmComplete(cfg, [
            {
              role: 'system',
              content:
                'Compacte esta memória de trabalho de projeto SEM perder informação útil. Preserve a estrutura em seções (## Decisões / ## Gotchas / ## Preferências do usuário / ## Pendências), mantenha decisões+porquês, gotchas e pendências ATUAIS; remova redundâncias, histórico obsoleto e o que já foi concluído há muito tempo. Responda SÓ com o markdown final (máx ~9000 caracteres).',
            },
            { role: 'user', content: newC.slice(0, 48000) },
          ]);
          const clean = String(c || '').replace(/^```[a-z]*\n?|```$/g, '').trim();
          if (clean.length > 500) {
            newC = clean;
            compacted = true;
          }
        } catch (e) {
          /* compactação falhou → salva como veio */
        }
      }
      fs.writeFileSync(fp, newC);
      invalidateProjCtx(cfg.workspace); // memória mudou → o cache do contexto de projeto recarrega
      broadcastDiff('.lumi-memory.md', oldC, newC); // mostra no chat o que ela resumiu/mudou
      return { ok: true, compacted: compacted || undefined };
    },
  },
  open_url: {
    category: 'open',
    summary: (a) => `abrir o site ${a.url}`,
    schema: {
      name: 'open_url',
      description: 'Abre um site/URL no navegador padrão.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
    run: async ({ url }) => {
      let u = String(url || '');
      if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
      shell.openExternal(u);
      return { opened: u };
    },
  },
  list_dir: {
    category: 'read',
    summary: (a) => `listar a pasta "${a.path}"`,
    schema: {
      name: 'list_dir',
      description: 'Lista arquivos e pastas de um diretório.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    run: async ({ path: p }) => {
      const dir = resolvePath(p || '.');
      return { dir, entries: fs.readdirSync(dir).slice(0, 300) };
    },
  },
  read_file: {
    category: 'read',
    summary: (a) => `ler o arquivo "${a.path}"` + (a.offset ? ` (linha ${a.offset}+)` : ''),
    schema: {
      name: 'read_file',
      description:
        'Lê um arquivo de texto. LEITURA CIRÚRGICA (preferida, gasta menos): passe `symbol` (nome de função/classe) ou `around_line` (nº de linha, ex.: a de um match do grep) pra receber SÓ aquele bloco/escopo, não o arquivo todo. Sem isso, lê por janelas: use offset/limit. A resposta diz o total de linhas e como continuar. Nunca chute conteúdo.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          symbol: { type: 'string', description: 'nome de uma função/classe — devolve só o bloco dela (cirúrgico)' },
          around_line: { type: 'number', description: 'nº de linha (ex.: de um match do grep) — devolve só o escopo que a contém' },
          offset: { type: 'number', description: 'linha inicial (1 = primeira; padrão 1) — quando não usar symbol/around_line' },
          limit: { type: 'number', description: 'quantas linhas ler (padrão 800, máx 2000)' },
        },
        required: ['path'],
      },
    },
    run: async ({ path: p, offset, limit, symbol, around_line }) => {
      const abs = resolvePath(p);
      let decoded;
      try {
        decoded = readTextFileSmart(abs);
      } catch (e) {
        // caminho errado? devolve os caminhos REAIS mais parecidos (mata a alucinação de path em 1 retry)
        const sug = await suggestPaths(loadConfig(), p);
        return { error: 'não consegui ler "' + p + '"' + (sug.length ? ' — você quis dizer: ' + sug.join(' | ') + '?' : ' (arquivo não existe? confira com list_dir/find_in_code)') };
      }
      const txt = decoded.text;
      if (txt.includes('\0')) return { error: 'arquivo parece binário (contém bytes nulos)' };
      noteFileRead(abs); // libera edit/write neste arquivo (guarda "leia antes de editar")
      const lines = txt.split('\n');
      const total = lines.length;
      // leitura CIRÚRGICA: só o bloco de um símbolo ou o escopo que envolve uma linha
      if (symbol || around_line) {
        let anchor = null;
        if (around_line) anchor = Math.max(1, Math.min(parseInt(around_line, 10) || 1, total));
        else {
          const name = String(symbol).trim();
          for (let i = 0; i < total; i++) {
            if (defNameAt(lines[i]) === name) {
              anchor = i + 1;
              break;
            }
          }
          if (!anchor) return { error: 'símbolo "' + symbol + '" não encontrado neste arquivo — confira o nome (grep_files mostra o symbol de cada match) ou leia por offset/limit' };
        }
        const blk = blockAround(lines, anchor);
        let content = lines.slice(blk.start - 1, blk.end).join('\n');
        let capped = false;
        if (content.length > 48000) {
          content = content.slice(0, 48000);
          capped = true;
        }
        return {
          content,
          totalLines: total,
          showing: `bloco linhas ${blk.start}-${blk.end} de ${total}` + (symbol ? ` (símbolo "${symbol}")` : '') + (capped ? ' — cortado por tamanho' : ''),
          note: 'trecho cirúrgico; se precisar de mais contexto use offset/limit em volta dessas linhas',
        };
      }
      const start = Math.max(1, parseInt(offset, 10) || 1);
      const count = Math.max(1, Math.min(parseInt(limit, 10) || 800, 2000));
      let content = lines.slice(start - 1, start - 1 + count).join('\n');
      let capped = false;
      if (content.length > 48000) {
        // proteção do contexto: corta por chars, mas avisa exatamente onde parou
        content = content.slice(0, 48000);
        capped = true;
      }
      const shown = content.split('\n').length;
      const end = Math.min(start + shown - 1, total);
      const out = { content, totalLines: total, showing: `linhas ${start}-${end} de ${total}` + (capped ? ' (janela cortada por tamanho)' : '') };
      if (decoded.encoding && decoded.encoding !== 'utf-8') out.encoding = decoded.encoding;
      if (end < total) out.note = `o arquivo continua: chame read_file com offset=${end + 1} para a próxima janela`;
      return out;
    },
  },
  edit_file: {
    category: 'write',
    summary: (a) => `editar trecho de "${a.path}"`,
    schema: {
      name: 'edit_file',
      description:
        'Edição CIRÚRGICA: substitui um trecho EXATO do arquivo por outro, sem reescrever o resto. PREFIRA esta ferramenta a write_file para ALTERAR arquivos existentes (mais segura e precisa). old_text deve ser copiado EXATAMENTE do arquivo (indentação conta) e aparecer só 1 vez — inclua linhas vizinhas para ficar único.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_text: { type: 'string', description: 'trecho exato a substituir (copie do read_file, com a indentação original)' },
          new_text: { type: 'string', description: 'novo trecho que entra no lugar' },
          all: { type: 'boolean', description: 'true = substitui TODAS as ocorrências (padrão: exige ocorrência única)' },
        },
        required: ['path', 'old_text', 'new_text'],
      },
    },
    run: async ({ path: p, old_text, new_text, all }) => {
      const abs = resolvePath(p);
      const cfg = loadConfig();
      if (isPreciousFile(cfg, abs)) return { error: 'arquivo protegido (guardrails): "' + p + '" não pode ser editado.', blocked: true };
      let oldC;
      try {
        oldC = readTextFileSmart(abs).text;
      } catch (e) {
        const sug = await suggestPaths(cfg, p);
        return { error: 'arquivo "' + p + '" não encontrado' + (sug.length ? ' — você quis dizer: ' + sug.join(' | ') + '?' : '') };
      }
      // GUARDA: editar sem ter LIDO neste turno = edição às cegas (a nº1 causa de old_text errado)
      if (!wasFileRead(abs)) {
        return {
          error:
            'você ainda NÃO leu "' + p + '" neste turno — leia antes de editar: read_file com symbol=<função> ou around_line=<linha> pega SÓ o trecho (barato). Copie o old_text EXATO de lá e edite em seguida.',
        };
      }
      const o = String(old_text);
      const nt = String(new_text);
      if (o === nt) return { error: 'old_text e new_text são iguais — nada a fazer' };
      if (!o) return { error: 'old_text vazio' };
      const replaced = replaceTextSmart(oldC, o, nt, all);
      if (replaced.error) return { error: replaced.error };
      if (!replaced.count) {
        // REPARO: devolve o trecho MAIS PARECIDO do arquivo (com linhas) — corrige em 1 retry, sem loop
        const near = closestRegion(oldC.split('\n'), o);
        return {
          error:
            'old_text NÃO encontrado no arquivo (CRLF/LF já é tolerado).' +
            (near
              ? ' O trecho MAIS PARECIDO está nas linhas ' + near.start + '-' + near.end + ':\n' + near.snippet + '\nCopie DAÍ o texto exato (com a indentação) e tente de novo.'
              : ' Releia a região com read_file (around_line ajuda) e copie o trecho exatamente.'),
        };
      }
      const newC = replaced.text;
      fs.writeFileSync(abs, newC, 'utf8');
      await formatFileIfEnabled(cfg, abs); // format-on-save (opt-in)
      broadcastDiff(p, oldC, newC);
      const out = { ok: true, replaced: replaced.count };
      if (replaced.mode === 'eol-normalized') out.note = 'substituição aplicada normalizando diferenças CRLF/LF e preservando o line ending dominante do arquivo';
      return out;
    },
  },
  grep_files: {
    category: 'read',
    summary: (a) => `procurar "${a.pattern}" no projeto`,
    schema: {
      name: 'grep_files',
      description:
        'Procura texto (ou regex) no workspace. Cada match já vem com "symbol" (a função/classe que o contém) e "context" (linhas ao redor) — na maioria das vezes dá pra entender SEM abrir o arquivo. Se precisar do trecho, use read_file com symbol=<nome> ou around_line=<linha do match> (não leia o arquivo inteiro).',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'texto a procurar' },
          path: { type: 'string', description: 'limita a uma pasta ou arquivo (relativo ao workspace; vazio = projeto todo)' },
          regex: { type: 'boolean', description: 'true = interpreta pattern como expressão regular' },
        },
        required: ['pattern'],
      },
    },
    run: async ({ pattern, path: sub, regex }) => {
      const base = resolvePath(sub || '.');
      if (regex) {
        try {
          new RegExp(pattern, 'i'); // valida cedo
        } catch (e) {
          return { error: 'regex inválida: ' + e.message };
        }
      }
      const wsBase = loadConfig().workspace || process.cwd();
      let baseStat;
      try {
        baseStat = await fs.promises.stat(base);
      } catch (e) {
        return { error: 'caminho não encontrado: ' + (sub || '.') };
      }

      // 1) ripgrep: rápido, respeita .gitignore, async com timeout (nunca trava o app)
      const rg = await rgGrep(base, wsBase, pattern, !!regex);
      if (rg) {
        await enrichMatches(wsBase, rg.matches); // + symbol (função que contém) + context (linhas ao redor)
        return {
          matches: rg.matches,
          total: rg.matches.length,
          engine: 'ripgrep',
          note: 'cada match traz "symbol" (a função/classe onde está) e "context" (linhas ao redor) — muitas vezes já dá pra decidir SEM abrir o arquivo. Pra ler o trecho, use read_file com symbol ou around_line.',
          truncated: rg.limited ? 'há mais resultados — refine o pattern ou limite o path' : undefined,
        };
      }

      // 2) fallback SEM ripgrep: agora ASSÍNCRONO e LIMITADO (deadline + caps) — antes era sync e travava
      const q = String(pattern).toLowerCase();
      const re = regex ? new RegExp(pattern, 'i') : null;
      const matches = [];
      let truncated = false;
      const deadline = Date.now() + 5000;
      let files = 0;
      let bytes = 0;
      const MAXF = 1500;
      const MAXB = 24 * 1024 * 1024;
      const overBudget = () => Date.now() > deadline || files >= MAXF || bytes >= MAXB;
      const tryFile = async (full, rel) => {
        let st;
        try {
          st = await fs.promises.stat(full);
        } catch (e) {
          return;
        }
        if (!st.isFile() || st.size > 1000000) return;
        files++;
        bytes += st.size;
        let content;
        try {
          content = (await readTextFileSmartAsync(full)).text;
        } catch (e) {
          return;
        }
        if (content.indexOf('\0') >= 0) return; // binário
        const lines = content.split('\n');
        let inFile = 0;
        for (let i = 0; i < lines.length && inFile < 20; i++) {
          const hit = re ? re.test(lines[i]) : lines[i].toLowerCase().includes(q);
          if (hit) {
            inFile++;
            matches.push({ file: rel, line: i + 1, text: lines[i].trim().slice(0, 240) });
            if (matches.length >= 120) {
              truncated = true;
              return;
            }
          }
        }
      };
      const walk = async (dir, depth) => {
        if (matches.length >= 120 || depth > 12) return;
        if (overBudget()) {
          truncated = true;
          return;
        }
        let ents = [];
        try {
          ents = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch (e) {
          return;
        }
        for (const ent of ents) {
          if (matches.length >= 120) return;
          if (overBudget()) {
            truncated = true;
            return;
          }
          const nm = ent.name;
          if (WS_HEAVY.has(nm) || WS_IGNORE.has(nm) || (nm.startsWith('.lumi-') && nm !== '.lumi-memory.md')) continue;
          const full = path.join(dir, nm);
          if (ent.isDirectory()) await walk(full, depth + 1);
          else await tryFile(full, path.relative(wsBase, full).replace(/\\/g, '/'));
        }
      };
      if (baseStat.isFile()) await tryFile(base, path.relative(wsBase, base).replace(/\\/g, '/'));
      else await walk(base, 0);
      await enrichMatches(wsBase, matches); // + symbol + context (mesmo do ripgrep)
      return {
        matches,
        total: matches.length,
        engine: 'fallback-js',
        note: 'cada match traz "symbol" e "context" — muitas vezes já resolve sem abrir o arquivo. Pra ler, use read_file com symbol ou around_line.',
        truncated: truncated ? 'busca limitada (tempo/quantidade) — refine o pattern ou limite o path' : undefined,
      };
    },
  },
  git_status: {
    category: 'read',
    summary: () => 'ver o status do git',
    schema: {
      name: 'git_status',
      description: 'Estado do git do workspace: branch, arquivos staged/não-staged/não-rastreados e ahead/behind. Use pra saber O QUE VOCÊ MUDOU antes de finalizar/commitar.',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace aberto' };
      try {
        const { stdout: br } = await gitRun(cfg, ['rev-parse', '--abbrev-ref', 'HEAD']);
        const { stdout } = await gitRun(cfg, ['status', '--porcelain=v1', '-uall']);
        const staged = [];
        const unstaged = [];
        const untracked = [];
        stdout.split('\n').forEach((l) => {
          if (l.length < 3) return;
          const x = l[0];
          const y = l[1];
          const p = l.slice(3).replace(/^"|"$/g, '');
          if (x === '?') return untracked.push(p);
          if (x !== ' ') staged.push({ path: p, st: x });
          if (y !== ' ') unstaged.push({ path: p, st: y });
        });
        let ahead = 0;
        let behind = 0;
        try {
          const { stdout: ab } = await gitRun(cfg, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
          const m = ab.trim().split(/\s+/);
          ahead = parseInt(m[0], 10) || 0;
          behind = parseInt(m[1], 10) || 0;
        } catch (e) {
          /* sem upstream */
        }
        return { branch: br.trim(), staged, unstaged, untracked, ahead, behind };
      } catch (e) {
        return { error: 'não é um repositório git (ou git indisponível)' };
      }
    },
  },
  git_diff: {
    category: 'read',
    summary: (a) => 'ver o diff' + (a && a.path ? ' de ' + a.path : '') + (a && a.staged ? ' (staged)' : ''),
    schema: {
      name: 'git_diff',
      description: 'Mostra as mudanças (diff) do workspace. Sem args = tudo não-staged; staged:true = o preparado; path = limita a um arquivo/pasta. Use pra REVISAR o que você fez antes de finalizar.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, staged: { type: 'boolean' } } },
    },
    run: async ({ path: sub, staged }) => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace aberto' };
      try {
        const args = ['diff', '--no-color'];
        if (staged) args.push('--cached');
        if (sub) args.push('--', String(sub));
        const { stdout } = await gitRun(cfg, args);
        if (!stdout.trim()) return { diff: '', note: staged ? 'nada staged' : 'nenhuma mudança não-staged' };
        return { diff: stdout.slice(0, 40000), truncated: stdout.length > 40000 ? 'diff grande — limite por path pra ver o resto' : undefined };
      } catch (e) {
        return { error: String((e && e.stderr) || (e && e.message) || e).slice(0, 200) };
      }
    },
  },
  git_log: {
    category: 'read',
    summary: (a) => 'histórico do git' + (a && a.path ? ' de ' + a.path : ''),
    schema: {
      name: 'git_log',
      description: 'Commits recentes (hash, mensagem, autor, quando). count = quantos (padrão 15). path = histórico de um arquivo específico.',
      parameters: { type: 'object', properties: { count: { type: 'number' }, path: { type: 'string' } } },
    },
    run: async ({ count, path: sub }) => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace aberto' };
      const n = Math.max(1, Math.min(parseInt(count, 10) || 15, 100));
      try {
        const args = ['log', '--format=%h%x09%s%x09%an%x09%cr', '-n', String(n)];
        if (sub) args.push('--', String(sub));
        const { stdout } = await gitRun(cfg, args);
        const commits = stdout
          .split('\n')
          .filter(Boolean)
          .map((l) => {
            const [hash, subject, author, when] = l.split('\t');
            return { hash, subject, author, when };
          });
        return { commits, total: commits.length };
      } catch (e) {
        return { error: 'não é um repositório git' };
      }
    },
  },
  run_tests: {
    category: 'exec',
    summary: (a) => 'rodar testes' + (a && a.filter ? ' (' + a.filter + ')' : ''),
    schema: {
      name: 'run_tests',
      description:
        'Roda os testes — de preferência FOCADO num arquivo/nome (filter) pra ser rápido e barato. Detecta o runner (npm/jest/vitest, pytest, go, cargo, maven, gradle); ou passe `command` exato. Devolve pass/fail + a saída relevante.',
      parameters: {
        type: 'object',
        properties: {
          filter: { type: 'string', description: 'arquivo ou nome do teste pra focar (recomendado)' },
          command: { type: 'string', description: 'comando exato (opcional; sobrepõe a detecção)' },
        },
      },
    },
    run: async ({ filter, command }) => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace aberto' };
      let cmd = command && String(command).trim();
      if (!cmd) {
        const g = guessTestCommand(cfg.workspace);
        if (!g) return { error: 'não detectei o runner de testes — passe `command` com o comando exato (ex.: "npx vitest run src/x.test.ts")' };
        cmd = filter ? withTestFilter(g.cmd, g.runner, filter) : g.cmd;
      } else if (filter) {
        cmd = cmd + ' ' + filter;
      }
      try {
        const { stdout, stderr } = await execAsync(cmd, { cwd: cfg.workspace, timeout: 180000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
        return { ok: true, command: cmd, output: tailStr(((stdout || '') + (stderr || '')).trim(), 6000) };
      } catch (e) {
        const out = (((e && e.stdout) || '') + ((e && e.stderr) || '')).trim() || String((e && e.message) || e);
        return { ok: false, command: cmd, exitCode: e && e.code, output: tailStr(out, 8000), note: 'testes falharam (ou o comando errou) — veja a saída' };
      }
    },
  },
  locate_stack: {
    category: 'read',
    summary: () => 'localizar no código pela stack',
    schema: {
      name: 'locate_stack',
      description:
        'Recebe um erro/stack trace e pula direto pros pontos no SEU código: extrai arquivo:linha dos frames (ignora node_modules/libs), lê só o bloco que envolve cada um (com o símbolo). Use quando tiver um traceback/erro pra debugar.',
      parameters: { type: 'object', properties: { trace: { type: 'string', description: 'o texto do erro/stack trace' } }, required: ['trace'] },
    },
    run: async ({ trace }) => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace aberto' };
      const ws = cfg.workspace;
      const t = String(trace || '');
      if (!t.trim()) return { error: 'trace vazio' };
      const frames = [];
      const seen = new Set();
      const add = (file, line) => {
        const k = file + ':' + line;
        if (!seen.has(k)) {
          seen.add(k);
          frames.push({ file, line });
        }
      };
      let m;
      const re1 = /([A-Za-z]:\\[^\s():]+|\/[^\s():]+|[\w./\\-]+\.[A-Za-z]{1,6}):(\d+)(?::\d+)?/g;
      while ((m = re1.exec(t))) add(m[1], parseInt(m[2], 10));
      const re2 = /File "([^"]+)", line (\d+)/g; // Python
      while ((m = re2.exec(t))) add(m[1], parseInt(m[2], 10));
      const out = [];
      for (const f of frames) {
        if (out.length >= 6) break;
        const rel = f.file.replace(/\\/g, '/');
        const abs = path.isAbsolute(rel) ? rel : path.join(ws, rel);
        if (!path.resolve(abs).startsWith(path.resolve(ws))) continue; // só arquivos do projeto
        if (/node_modules|[/\\](dist|build)[/\\]|site-packages/.test(abs)) continue;
        let lines;
        try {
          const st = await fs.promises.stat(abs);
          if (!st.isFile() || st.size > 800000) continue;
          lines = (await readTextFileSmartAsync(abs)).text.split('\n');
        } catch (e) {
          continue;
        }
        if (f.line < 1 || f.line > lines.length) continue;
        noteFileRead(abs); // ela viu o trecho real → libera edição neste arquivo
        const blk = blockAround(lines, f.line);
        out.push({
          file: path.relative(ws, abs).replace(/\\/g, '/'),
          line: f.line,
          symbol: enclosingSymbol(lines, f.line - 1) || undefined,
          code: snippetAround(lines, f.line, 3, 3),
          block: blk.start + '-' + blk.end,
        });
      }
      if (!out.length)
        return { frames_found: frames.length, note: 'nenhum frame apontou pra um arquivo do projeto (talvez o erro seja em dependência/lib). Cole mais do stack ou use grep_files.' };
      return { locations: out, note: 'pontos no seu código; pra ver a função inteira use read_file com around_line=<linha> ou symbol=<symbol>.' };
    },
  },
  apply_patch: {
    category: 'write',
    summary: () => 'aplicar patch (diff) multi-arquivo',
    schema: {
      name: 'apply_patch',
      description:
        'Aplica um DIFF unificado (git-style, pode tocar VÁRIOS arquivos) de uma vez. Gere com headers "--- a/arquivo" / "+++ b/arquivo" e hunks @@. Alternativa ao edit_file quando muda vários arquivos juntos. Faz --check antes e RECUSA se não aplicar limpo (aí releia os arquivos e gere de novo).',
      parameters: { type: 'object', properties: { patch: { type: 'string', description: 'o diff unificado completo' } }, required: ['patch'] },
    },
    run: async ({ patch }) => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace aberto' };
      const p = String(patch || '');
      if (!/^(---|\+\+\+|diff --git|@@)/m.test(p)) return { error: 'isso não parece um diff unificado (esperado linhas ---/+++/@@)' };
      const files = [...p.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((mm) => mm[1].trim()).filter((f) => f && f !== '/dev/null');
      const precious = files.find((f) => isPreciousFile(cfg, path.join(cfg.workspace, f)));
      if (precious) return { error: 'arquivo protegido (guardrails) no patch: "' + precious + '" não pode ser alterado.', blocked: true };
      const tmp = path.join(app.getPath('userData'), 'lumi-patch-' + Date.now() + '.diff');
      try {
        fs.writeFileSync(tmp, p.endsWith('\n') ? p : p + '\n');
        try {
          await gitRun(cfg, ['apply', '--check', '--whitespace=nowarn', tmp]);
        } catch (e) {
          return { error: 'o patch não aplica limpo: ' + String((e && e.stderr) || (e && e.message) || e).slice(0, 300) + ' — releia os arquivos (a base pode ter mudado) e gere o diff de novo' };
        }
        await gitRun(cfg, ['apply', '--whitespace=nowarn', tmp]);
        for (const f of files) await formatFileIfEnabled(cfg, path.join(cfg.workspace, f)); // format-on-save (opt-in)
        broadcast('workspace:changed');
        return { ok: true, files, note: files.length + ' arquivo(s) alterados' };
      } catch (e) {
        return { error: String((e && e.stderr) || (e && e.message) || e).slice(0, 300) };
      } finally {
        try {
          fs.unlinkSync(tmp);
        } catch (e) {
          /* ok */
        }
      }
    },
  },
  get_problems: {
    category: 'read',
    summary: () => 'checar erros do projeto (lint/tipos)',
    schema: {
      name: 'get_problems',
      description:
        'Roda o linter/type-checker do projeto (eslint/tsc, ruff/flake8, go vet, cargo) e devolve os problemas REAIS: arquivo, linha, coluna, severidade e mensagem. Use DEPOIS de editar pra confirmar que não introduziu erro, e pra corrigir COM PRECISÃO em vez de adivinhar. Pode levar alguns segundos.',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const r = await checkProject(loadConfig());
      if (r.error) return r;
      if (!r.tools || !r.tools.length) return { problems: [], note: r.note };
      return {
        total: r.total,
        errors: r.errors,
        warnings: r.warnings,
        tools: r.tools,
        problems: r.problems.slice(0, 100),
        truncated: r.total > 100 ? 'mostrando 100 de ' + r.total + ' — corrija os erros primeiro e rode de novo' : undefined,
      };
    },
  },
  generate_project_doc: {
    category: 'write',
    summary: () => 'gerar/atualizar o CLAUDE.md',
    schema: {
      name: 'generate_project_doc',
      description:
        'Escreve o CLAUDE.md do projeto (briefing estável: stack, estrutura, como rodar/verificar, convenções) — contexto de qualidade pra TODA sessão futura. Se já existir: update:true RECONCILIA com o código atual (preserva notas do dono que ainda valem); force:true reescreve do zero.',
      parameters: { type: 'object', properties: { update: { type: 'boolean' }, force: { type: 'boolean' } } },
    },
    run: async ({ force, update }) => {
      const cfg = loadConfig();
      if (!cfg.workspace) return { error: 'nenhum workspace aberto' };
      const dest = path.join(cfg.workspace, 'CLAUDE.md');
      const exists = fs.existsSync(dest);
      if (exists && !force && !update) return { error: 'já existe um CLAUDE.md — use update:true pra reconciliar com o código atual (preserva notas válidas), force:true pra reescrever do zero, ou edit_file pra um ajuste pontual.' };
      let existing = '';
      if (exists && update) {
        try {
          existing = fs.readFileSync(dest, 'utf8').slice(0, 8000);
        } catch (e) {
          /* ok */
        }
      }
      const stack = detectStackCached(cfg.workspace);
      let tree = [];
      try {
        await walkWorkspace(cfg.workspace, cfg.workspace, tree, 0);
      } catch (e) {
        /* ok */
      }
      const readSafe = (f) => {
        try {
          return fs.readFileSync(path.join(cfg.workspace, f), 'utf8');
        } catch (e) {
          return '';
        }
      };
      const facts = [
        'Pasta: ' + cfg.workspace,
        'Stack detectada: ' + ((stack.hints || []).join(', ') || '(indefinida)'),
        'Comando de verificação sugerido: ' + (stack.verify || '(nenhum)'),
        readSafe('package.json') ? 'package.json:\n' + readSafe('package.json').slice(0, 2500) : '',
        'Estrutura (amostra):\n' + tree.slice(0, 200).join('\n'),
        (readSafe('README.md') || readSafe('readme.md')).slice(0, 2000) ? 'README (início):\n' + (readSafe('README.md') || readSafe('readme.md')).slice(0, 2000) : '',
      ]
        .filter(Boolean)
        .join('\n\n');
      let doc = '';
      try {
        doc = await llmComplete(cfg, [
          {
            role: 'system',
            content:
              'Escreva um CLAUDE.md CONCISO e ÚTIL pra orientar uma IA a trabalhar neste projeto. Português, markdown. Seções: "# <Nome>" (1 linha do que é), "## Stack", "## Estrutura" (só o essencial: onde ficam as coisas), "## Como rodar / verificar" (comandos REAIS), "## Convenções" (padrões a seguir, inferidos). Específico e curto; sem encher linguiça. Baseie-se SÓ nos fatos dados; não invente.' +
              (existing ? ' ATUALIZAÇÃO: existe um CLAUDE.md — reconcilie-o com os fatos atuais: corrija o que divergiu, PRESERVE notas/convenções escritas pelo dono que continuam válidas, remova o que não existe mais.' : ''),
          },
          { role: 'user', content: (existing ? 'CLAUDE.md ATUAL:\n\n' + existing + '\n\n---\n\n' : '') + 'Fatos do projeto:\n\n' + facts },
        ]);
      } catch (e) {
        return { error: 'falha ao gerar (modelo): ' + String((e && e.message) || e) };
      }
      doc = String(doc || '')
        .replace(/^```[a-z]*\n?|```$/g, '')
        .trim();
      if (!doc) return { error: 'a IA não retornou conteúdo' };
      fs.writeFileSync(dest, doc + '\n');
      invalidateProjCtx(cfg.workspace); // briefing mudou → o cache do contexto de projeto recarrega
      broadcast('workspace:changed');
      return { ok: true, path: 'CLAUDE.md', bytes: doc.length, preview: doc.slice(0, 600) };
    },
  },
  system_logs: {
    category: 'exec', // lê o Event Log/journalctl por comando do SO
    summary: (a) => 'ler os logs do sistema' + (a && a.minutes ? ' (últimos ' + a.minutes + ' min)' : ''),
    schema: {
      name: 'system_logs',
      description:
        'Lê os ERROS recentes do SISTEMA OPERACIONAL (Windows Event Log / journalctl / log show): crash de app, erro de driver/serviço, etc. Cada entrada traz hora, origem e mensagem — e, quando o processo ainda roda, o COMANDO com que foi lançado (launch). Use quando o usuário relatar crash/travamento de um programa/jogo ou pedir "o que aconteceu no sistema".',
      parameters: {
        type: 'object',
        properties: {
          minutes: { type: 'number', description: 'janela de tempo (padrão 60, máx 1440)' },
          level: { type: 'string', description: '"error" (padrão) ou "warning" (inclui avisos)' },
          query: { type: 'string', description: 'filtra por texto (nome do app, driver...)' },
        },
      },
    },
    run: async ({ minutes, level, query }) => {
      try {
        await refreshProcessSnapshot(); // pra anexar o comando de lançamento dos processos vivos
        const r = await readSystemLogs(minutes, level === 'warning' ? 'warning' : 'error');
        let list = r.entries;
        if (query) {
          const q = String(query).toLowerCase();
          list = list.filter((e) => ((e.source || '') + ' ' + (e.message || '') + ' ' + (e.launch || '')).toLowerCase().includes(q));
        }
        if (!list.length) return { entries: [], note: 'nenhum erro do sistema na janela pedida' + (query ? ' com esse filtro' : '') };
        return { entries: list.slice(0, 40), total: list.length, note: 'campo "launch" = comando com que o processo foi iniciado (correlação). Cruze com o histórico do usuário pra achar a causa.' };
      } catch (e) {
        return { error: String((e && e.message) || e).slice(0, 200) };
      }
    },
  },
  outline: {
    category: 'read',
    summary: (a) => 'mapear símbolos de "' + ((a && a.path) || '') + '"',
    schema: {
      name: 'outline',
      description:
        'MAPA de um arquivo: lista funções/classes/métodos com a linha de cada um. Use pra pular direto pro trecho certo (depois leia com read_file symbol=<nome> ou around_line=<linha>) em vez de varrer o arquivo inteiro.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    run: async ({ path: p }) => {
      const abs = resolvePath(p);
      let txt;
      try {
        txt = readTextFileSmart(abs).text;
      } catch (e) {
        const sug = await suggestPaths(loadConfig(), p);
        return { error: 'não consegui ler "' + p + '"' + (sug.length ? ' — você quis dizer: ' + sug.join(' | ') + '?' : '') };
      }
      if (txt.includes('\0')) return { error: 'arquivo binário' };
      const lines = txt.split('\n');
      const symbols = [];
      for (let i = 0; i < lines.length && symbols.length < 400; i++) {
        const name = defNameAt(lines[i]);
        if (name) symbols.push({ name, line: i + 1, preview: lines[i].trim().slice(0, 120) });
      }
      return {
        path: p,
        totalLines: lines.length,
        symbols,
        note: symbols.length ? 'leia um símbolo com read_file(path, symbol=<name>) ou around_line=<line>' : 'nenhum símbolo reconhecido (heurística) — navegue com grep_files',
      };
    },
  },
  find_usages: {
    category: 'read',
    summary: (a) => 'achar usos de "' + ((a && a.symbol) || '') + '"',
    schema: {
      name: 'find_usages',
      description:
        'Acha onde um símbolo (função/classe/variável) é USADO e onde é DEFINIDO no workspace (palavra inteira). Cada match traz symbol/context. Use ANTES de renomear ou mudar assinatura pra medir o impacto.',
      parameters: {
        type: 'object',
        properties: { symbol: { type: 'string' }, path: { type: 'string', description: 'limita a uma pasta (opcional)' } },
        required: ['symbol'],
      },
    },
    run: async ({ symbol, path: sub }) => {
      const name = String(symbol || '').trim();
      if (!/^[A-Za-z_$][\w$]*$/.test(name)) return { error: 'símbolo inválido — use um identificador simples (sem espaços/pontos)' };
      const pattern = '\\b' + name.replace(/\$/g, '\\$') + '\\b';
      const r = await TOOLS.grep_files.run({ pattern, path: sub, regex: true }); // reusa ripgrep+fallback+enriquecimento
      if (r.error) return r;
      const definitions = [];
      const usages = [];
      for (const m of r.matches || []) {
        if (defNameAt(m.text) === name) definitions.push(m);
        else usages.push(m);
      }
      return {
        symbol: name,
        definitions,
        usages,
        total: (r.matches || []).length,
        truncated: r.truncated,
        note: definitions.length ? undefined : 'nenhuma DEFINIÇÃO reconhecida (pode ser import/lib externa) — os usos listados valem',
      };
    },
  },
  env_info: {
    category: 'read',
    summary: () => 'raio-X do ambiente (SO, versões, gerenciador)',
    schema: {
      name: 'env_info',
      description:
        'Raio-X do AMBIENTE: SO/arch, shell, versões instaladas (node, npm/pnpm/yarn, python, go, rust, git, docker), gerenciador de pacotes DO PROJETO (lockfile) e stack detectada. Use antes de rodar comandos pra não chutar errado (ex.: npm num projeto pnpm). Cache de 10 min.',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      const now = Date.now();
      if (_envInfoCache && now - _envInfoCache.at < 10 * 60000) return _envInfoCache.data;
      const cfg = loadConfig();
      const vers = {};
      const probe = async (label, cmd) => {
        try {
          const { stdout } = await execAsync(cmd, { timeout: 6000, windowsHide: true });
          const v = String(stdout || '').trim().split('\n')[0].slice(0, 60);
          if (v) vers[label] = v;
        } catch (e) {
          /* ausente */
        }
      };
      await Promise.all([
        probe('node', 'node --version'),
        probe('npm', 'npm --version'),
        probe('pnpm', 'pnpm --version'),
        probe('yarn', 'yarn --version'),
        probe('python', process.platform === 'win32' ? 'python --version' : 'python3 --version'),
        probe('go', 'go version'),
        probe('rust', 'rustc --version'),
        probe('git', 'git --version'),
        probe('docker', 'docker --version'),
      ]);
      const has = (f) => {
        try {
          return !!cfg.workspace && fs.existsSync(path.join(cfg.workspace, f));
        } catch (e) {
          return false;
        }
      };
      const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : has('bun.lockb') ? 'bun' : has('package-lock.json') ? 'npm' : null;
      const det = cfg.workspace ? detectStackCached(cfg.workspace) : {};
      const data = {
        os: process.platform + ' ' + require('os').release() + ' (' + process.arch + ')',
        shell: process.platform === 'win32' ? 'PowerShell/cmd' : process.env.SHELL || 'bash',
        versions: vers,
        workspace: cfg.workspace || null,
        packageManager: pm,
        stack: det.stack || null,
        verifyCommand: det.verify || null,
        caps: envCaps,
        note: pm ? 'use ' + pm + ' neste projeto (lockfile detectado)' : undefined,
      };
      _envInfoCache = { at: now, data };
      return data;
    },
  },
  db_schema: {
    category: 'read',
    summary: () => 'ver o schema do banco conectado',
    schema: {
      name: 'db_schema',
      description:
        'Schema do banco CONECTADO na aba BANCO do workspace: tabelas+colunas (pg/mysql), coleções+campos (mongo) ou dicas de comandos (redis). Use pra entender os dados antes de escrever queries ou código de backend.',
      parameters: { type: 'object', properties: {} },
    },
    run: async () => {
      if (!dbConn) return { error: 'nenhum banco conectado — conecte na aba BANCO do workspace (o usuário controla a conexão)' };
      try {
        const schema = await dbSchema();
        return { kind: dbConn.kind, label: dbConn.label, schema: truncate(schema, 12000) };
      } catch (e) {
        return { error: String((e && e.message) || e).slice(0, 200) };
      }
    },
  },
  db_query: {
    category: 'read',
    summary: (a) => 'consultar o banco: ' + String((a && a.query) || '').slice(0, 60),
    schema: {
      name: 'db_query',
      description:
        'Consulta SOMENTE-LEITURA no banco conectado (aba BANCO). pg/mysql: SELECT/SHOW/EXPLAIN/WITH/DESCRIBE (1 statement). mongo: "colecao {filtroJSON}". redis: comandos de leitura (GET/KEYS/HGETALL/LRANGE/SCAN/TTL/TYPE...). Escrita é RECUSADA — alterações são decisão do usuário, pelo painel.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    run: async ({ query }) => {
      if (!dbConn) return { error: 'nenhum banco conectado — conecte na aba BANCO do workspace' };
      const q = String(query || '').trim();
      if (!q) return { error: 'query vazia' };
      if (dbConn.kind === 'pg' || dbConn.kind === 'mysql') {
        if (!/^(select|show|explain|with|describe|desc)\b/i.test(q)) return { error: 'só LEITURA (SELECT/SHOW/EXPLAIN/WITH/DESCRIBE) — escrita é do usuário, pelo painel BANCO' };
        if (/;\s*\S/.test(q)) return { error: 'um statement por vez' };
        if (/\b(insert|update|delete|drop|alter|create|truncate|grant|revoke)\b/i.test(q)) return { error: 'a query contém palavra de ESCRITA — só leitura aqui' };
      } else if (dbConn.kind === 'redis') {
        if (!/^(get|mget|keys|scan|hgetall|hget|hkeys|lrange|llen|smembers|scard|zrange|zcard|ttl|type|exists|strlen|dbsize|info)\b/i.test(q)) return { error: 'só comandos de LEITURA no Redis' };
      }
      try {
        const r = await dbRun(q);
        if (r.rows && r.rows.length > 100) {
          r.rows = r.rows.slice(0, 100);
          r.truncated = true;
        }
        return { kind: dbConn.kind, columns: r.columns, rows: r.rows, rowCount: r.rowCount, truncated: r.truncated ? 'mostrando 100 linhas — refine com WHERE/LIMIT' : undefined };
      } catch (e) {
        return { error: String((e && e.message) || e).slice(0, 300) };
      }
    },
  },
  write_file: {
    category: 'write',
    summary: (a) => `criar/sobrescrever "${a.path}"`,
    schema: {
      name: 'write_file',
      description: 'Cria ou sobrescreve um arquivo com o conteúdo dado.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    run: async ({ path: p, content }) => {
      const fp = resolvePath(p);
      const cfg = loadConfig();
      if (isPreciousFile(cfg, fp)) return { error: 'arquivo protegido (guardrails): "' + p + '" não pode ser sobrescrito.', blocked: true };
      let oldC = '';
      let existed = false;
      try {
        oldC = fs.readFileSync(fp, 'utf8');
        existed = true;
      } catch (e) {
        /* arquivo novo */
      }
      // GUARDA: sobrescrever um arquivo EXISTENTE sem tê-lo lido = destruição às cegas de conteúdo
      if (existed && oldC.trim() && !wasFileRead(fp)) {
        return {
          error:
            '"' + p + '" JÁ EXISTE com conteúdo e você não o leu neste turno. Leia antes (read_file) e prefira edit_file pra mudanças pontuais; use write_file só se a reescrita TOTAL for intencional (aí leia e reescreva).',
        };
      }
      const newC = content == null ? '' : String(content);
      fs.writeFileSync(fp, newC);
      await formatFileIfEnabled(cfg, fp); // format-on-save (opt-in)
      broadcastDiff(p, oldC, newC);
      return { written: fp };
    },
  },
  append_file: {
    category: 'write',
    summary: (a) => `adicionar texto em "${a.path}"`,
    schema: {
      name: 'append_file',
      description: 'Adiciona texto ao final de um arquivo (cria se não existir).',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' }, content: { type: 'string' } },
        required: ['path', 'content'],
      },
    },
    run: async ({ path: p, content }) => {
      const fp = resolvePath(p);
      const cfg = loadConfig();
      if (isPreciousFile(cfg, fp)) return { error: 'arquivo protegido (guardrails): "' + p + '" não pode ser alterado.', blocked: true };
      let oldC = '';
      try {
        oldC = fs.readFileSync(fp, 'utf8');
      } catch (e) {
        /* novo */
      }
      const add = String(content || '');
      fs.appendFileSync(fp, add);
      await formatFileIfEnabled(cfg, fp); // format-on-save (opt-in)
      broadcastDiff(p, oldC, oldC + add);
      return { ok: true };
    },
  },
  make_dir: {
    category: 'write',
    summary: (a) => `criar a pasta "${a.path}"`,
    schema: {
      name: 'make_dir',
      description: 'Cria uma pasta (e as pastas-pai se necessário).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    run: async ({ path: p }) => {
      fs.mkdirSync(resolvePath(p), { recursive: true });
      return { ok: true };
    },
  },
  delete_file: {
    category: 'delete',
    summary: (a) => `APAGAR "${a.path}"`,
    schema: {
      name: 'delete_file',
      description: 'Apaga um arquivo ou pasta.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    run: async ({ path: p }) => {
      const abs = resolvePath(p);
      if (isPreciousFile(loadConfig(), abs)) return { error: 'arquivo protegido (guardrails): "' + p + '" está na lista de arquivos preciosos e não pode ser apagado.', blocked: true };
      fs.rmSync(abs, { recursive: true, force: true });
      return { deleted: abs };
    },
  },
  run_command: {
    category: 'exec',
    summary: (a) => `executar o comando: ${a.command}`,
    schema: {
      name: 'run_command',
      description: 'Executa um comando no terminal do sistema (PowerShell/cmd no Windows) e retorna a saída.',
      parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
    },
    run: async ({ command }) => {
      const blocked = dangerousCommand(command);
      if (blocked) return { error: blocked, blocked: true };
      try {
        const { stdout, stderr } = await execAsync(String(command), {
          cwd: loadConfig().workspace || undefined, // roda na pasta da sessão ativa
          timeout: 20000,
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        });
        return { stdout: truncate(stdout, 24000), stderr: truncate(stderr, 8000) };
      } catch (e) {
        return { error: e.message, stdout: truncate(e.stdout, 16000), stderr: truncate(e.stderr, 8000) };
      }
    },
  },
  generate_image: {
    category: null, // usa a API do usuario (como o chat) -> sem permissao extra
    schema: {
      name: 'generate_image',
      description:
        'Gera uma imagem a partir de uma descrição (prompt). Use quando o usuário pedir para criar/desenhar/gerar uma imagem.',
      parameters: {
        type: 'object',
        properties: { prompt: { type: 'string', description: 'descrição detalhada da imagem em inglês para melhor resultado' } },
        required: ['prompt'],
      },
    },
    run: async ({ prompt }) => generateImageNow(prompt),
  },
  fetch_url: {
    category: 'network',
    summary: (a) => `acessar ${a.url}`,
    schema: {
      name: 'fetch_url',
      description:
        'Abre uma página/URL e retorna o CONTEÚDO LEGÍVEL (HTML vira texto limpo, sem tags/menus). Página grande? A resposta avisa e você pagina com offset. Para resposta crua (HTML/JSON exato), passe raw=true. Para chamar APIs com método/headers, use http_request.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          raw: { type: 'boolean', description: 'true = retorna o corpo cru, sem extrair texto' },
          offset: { type: 'number', description: 'pular N caracteres (paginação de conteúdo grande)' },
        },
        required: ['url'],
      },
    },
    run: async ({ url, raw, offset }) => {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36' },
        signal: AbortSignal.timeout(20000),
      });
      const ct = res.headers.get('content-type') || '';
      const t = await res.text();
      const off = Math.max(0, parseInt(offset, 10) || 0);
      const WIN = 16000;
      const page = (s) => {
        const out = { status: res.status, content: s.slice(off, off + WIN) };
        if (s.length > off + WIN) out.note = 'continua (' + s.length + ' chars no total): chame de novo com offset=' + (off + WIN);
        return out;
      };
      if (!raw && /html/i.test(ct)) {
        const title = (t.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1];
        const out = page(htmlToText(t));
        if (title) out.title = title.trim().slice(0, 200);
        return out;
      }
      return page(t);
    },
  },
  http_request: {
    category: 'network',
    summary: (a) => `${(a.method || 'GET').toUpperCase()} ${a.url}`,
    schema: {
      name: 'http_request',
      description:
        'Requisição HTTP completa (GET/POST/PUT/PATCH/DELETE) com headers e body — perfeita pra TESTAR APIs, inclusive o servidor que você subiu no terminal (http://localhost:porta). Retorna status, headers principais e corpo.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', description: 'GET, POST, PUT, PATCH ou DELETE (padrão GET)' },
          headers: { type: 'object', description: 'headers extras, ex.: {"Content-Type":"application/json","Authorization":"Bearer x"}' },
          body: { type: 'string', description: 'corpo da requisição (string; JSON já serializado)' },
        },
        required: ['url'],
      },
    },
    run: async ({ url, method, headers, body }) => {
      if (!/^https?:\/\//i.test(String(url))) return { error: 'URL deve começar com http:// ou https://' };
      const m = (method || 'GET').toUpperCase();
      const t0 = Date.now();
      try {
        const res = await fetch(url, {
          method: m,
          headers: headers && typeof headers === 'object' ? headers : undefined,
          body: body != null && m !== 'GET' && m !== 'HEAD' ? String(body) : undefined,
          signal: AbortSignal.timeout(20000),
        });
        const text = await res.text();
        const h = {};
        ['content-type', 'location', 'content-length', 'set-cookie'].forEach((k) => {
          const v = res.headers.get(k);
          if (v) h[k] = v;
        });
        return { status: res.status, ok: res.ok, headers: h, body: truncate(text, 12000), ms: Date.now() - t0 };
      } catch (e) {
        return { error: String((e && e.message) || e) + (/(localhost|127\.0\.0\.1)/.test(url) ? ' — o servidor local está rodando? (veja list_terminals/read_terminal)' : '') };
      }
    },
  },
  see_page: {
    category: 'network',
    summary: (a) => `ver a página ${a.url}`,
    schema: {
      name: 'see_page',
      description:
        'Renderiza uma URL numa janela invisível e CAPTURA a imagem da página — você ENXERGA o resultado visual. Perfeito pra conferir o site/app que você criou (ex.: http://localhost:3000 depois do run_in_terminal) e corrigir layout/CSS com base no que viu. Requer modelo com visão.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL completa (http/https)' },
          width: { type: 'number', description: 'largura do viewport (padrão 1280)' },
          waitMs: { type: 'number', description: 'espera extra após carregar, em ms (padrão 800; aumente pra apps lentos)' },
        },
        required: ['url'],
      },
    },
    run: async ({ url, width, waitMs }) => {
      if (!/^https?:\/\//i.test(String(url))) return { error: 'URL deve começar com http:// ou https://' };
      let w = null;
      try {
        w = new BrowserWindow({
          show: false,
          width: Math.min(1920, Math.max(400, parseInt(width, 10) || 1280)),
          height: 900,
          webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, nodeIntegration: false },
        });
        w.webContents.setAudioMuted(true);
        await w.loadURL(String(url));
        await new Promise((r) => setTimeout(r, Math.min(8000, Math.max(0, parseInt(waitMs, 10) || 800))));
        const img = await w.webContents.capturePage();
        if (img.isEmpty()) return { error: 'a página não renderizou (tente waitMs maior)' };
        return { _image: 'data:image/jpeg;base64,' + img.toJPEG(80).toString('base64'), _imageNote: 'A página ' + url + ' renderizada:' };
      } catch (e) {
        const msg = String((e && e.message) || e);
        return { error: 'não consegui carregar a página: ' + msg + (/(localhost|127\.0\.0\.1)/.test(url) ? ' — o servidor está de pé? (read_terminal ajuda a conferir)' : '') };
      } finally {
        if (w) {
          try {
            w.destroy();
          } catch (e) {
            /* ok */
          }
        }
      }
    },
  },
  view_image: {
    category: 'read',
    summary: (a) => `ver a imagem "${a.path}"`,
    schema: {
      name: 'view_image',
      description:
        'Abre uma imagem do workspace (png/jpg/webp/gif/bmp) como VISÃO — você enxerga e analisa o conteúdo (mockups, assets, screenshots que o usuário deixou no projeto). Requer modelo com visão.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    run: async ({ path: p }) => {
      const abs = resolvePath(p);
      const ext = (abs.split('.').pop() || '').toLowerCase();
      const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' }[ext];
      if (!mime) return { error: 'formato não suportado: .' + ext + ' (png/jpg/webp/gif/bmp)' };
      const buf = fs.readFileSync(abs);
      if (buf.length > 6 * 1024 * 1024) return { error: 'imagem muito grande (>6MB)' };
      return { _image: 'data:' + mime + ';base64,' + buf.toString('base64'), _imageNote: 'Imagem do projeto ' + p + ':' };
    },
  },
  web_search: {
    category: 'network',
    summary: (a) => `pesquisar na web: "${a.query}"`,
    schema: {
      name: 'web_search',
      description:
        'Pesquisa na web e retorna resultados relevantes (título, link, trecho) e, quando disponível, uma resposta sintetizada. Use para informações atuais ou que você não sabe.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string' }, count: { type: 'number', description: 'nº de resultados (padrão 5)' } },
        required: ['query'],
      },
    },
    run: async ({ query, count }) => webSearch(loadConfig(), String(query || ''), count),
  },
  ask_user: {
    category: null, // é interação, não risco
    summary: (a) => `perguntar ao usuário`,
    schema: {
      name: 'ask_user',
      description:
        'Pergunta algo ao usuário e PAUSA a tarefa até ele responder (vira um card com botões de opção + campo livre no chat). Use quando a decisão for DELE: validar antes de algo destrutivo/irreversível, escolher entre abordagens, confirmar um rumo. Não abuse — decisões triviais você toma sozinha.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'a pergunta (curta e clara)' },
          options: { type: 'array', items: { type: 'string' }, description: '2 a 4 opções curtas pro usuário clicar (opcional — sem elas, fica só o campo livre)' },
        },
        required: ['question'],
      },
    },
    run: async ({ question, options }) => ({
      answer: await askUserInChat(question, options, {
        fallback: '(o usuário não respondeu em 10 minutos — siga seu melhor julgamento ou pare)',
        timeoutMs: 10 * 60000,
      }),
    }),
  },
  update_plan: {
    category: null, // só exibição — sem risco
    summary: () => 'atualizando o plano de tarefas',
    schema: {
      name: 'update_plan',
      description:
        'Mostra/atualiza um PLANO DE TAREFAS visível pro usuário (checklist no chat). Em tarefas com várias etapas: chame no INÍCIO com todos os passos e ATUALIZE os status conforme avança. Reenvie a lista COMPLETA a cada chamada (ela substitui a anterior). status: pending | doing | done.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: { text: { type: 'string' }, status: { type: 'string', description: 'pending | doing | done' } },
              required: ['text', 'status'],
            },
          },
        },
        required: ['items'],
      },
    },
    run: async ({ items }) => {
      const list = (Array.isArray(items) ? items : [])
        .slice(0, 30)
        .map((i) => ({ text: String((i && i.text) || '').slice(0, 200), status: ['pending', 'doing', 'done'].includes(i && i.status) ? i.status : 'pending' }));
      if (!list.length) return { error: 'plano vazio' };
      broadcast('chat:plan', list);
      return { ok: true, itens: list.length };
    },
  },
  set_reminder: {
    category: null, // inofensivo (ela só fala na hora marcada)
    summary: (a) => `lembrete: "${a.message}"`,
    schema: {
      name: 'set_reminder',
      description:
        'Cria um lembrete: na hora marcada você avisa o usuário em voz alta e no chat (funciona mesmo se ele fechar o chat; persiste se o app reiniciar). Use minutes OU at.',
      parameters: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'o que lembrar (curto, ex.: "tirar o pão do forno")' },
          minutes: { type: 'number', description: 'daqui a quantos minutos (ex.: 20)' },
          at: { type: 'string', description: 'horário HH:MM (hoje; se já passou, amanhã)' },
        },
        required: ['message'],
      },
    },
    run: async ({ message, minutes, at }) => {
      let due = 0;
      if (minutes != null && !isNaN(minutes)) due = Date.now() + Math.min(7 * 24 * 60, Math.max(0.2, Number(minutes))) * 60000;
      else if (at && /^\d{1,2}:\d{2}$/.test(String(at).trim())) {
        const [h, m] = String(at).trim().split(':').map(Number);
        const d = new Date();
        d.setHours(h, m, 0, 0);
        if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1); // já passou → amanhã
        due = d.getTime();
      } else return { error: 'informe minutes (número) ou at ("HH:MM")' };
      const r = { id: 'r' + ++remSeq, at: due, message: String(message).slice(0, 300) };
      reminders.push(r);
      saveReminders();
      broadcast('chat:note', { text: '⏰ lembrete criado para ' + fmtHour(due) + ' — ' + r.message });
      return { ok: true, id: r.id, quando: fmtHour(due) };
    },
  },
  list_reminders: {
    category: null,
    summary: () => 'ver os lembretes',
    schema: { name: 'list_reminders', description: 'Lista os lembretes pendentes (id, horário, mensagem).', parameters: { type: 'object', properties: {} } },
    run: async () => ({ reminders: reminders.map((r) => ({ id: r.id, quando: fmtHour(r.at), message: r.message })) }),
  },
  cancel_reminder: {
    category: null,
    summary: (a) => `cancelar o lembrete ${a.id}`,
    schema: {
      name: 'cancel_reminder',
      description: 'Cancela um lembrete pendente pelo id (veja list_reminders).',
      parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
    run: async ({ id }) => {
      const before = reminders.length;
      reminders = reminders.filter((r) => r.id !== String(id));
      if (reminders.length === before) return { error: 'lembrete não encontrado: ' + id };
      saveReminders();
      return { ok: true };
    },
  },
  delegate_to_agent: {
    category: null, // sem permissao propria; as ferramentas do subagente pedem normalmente
    summary: (a) => `delegar ao agente "${a.agent}"`,
    schema: {
      name: 'delegate_to_agent',
      description:
        'Delega uma subtarefa a um agente especializado e retorna o resultado dele. Use o nome EXATO de um agente disponível.',
      parameters: {
        type: 'object',
        properties: {
          agent: { type: 'string', description: 'nome do agente especializado' },
          task: { type: 'string', description: 'descrição clara e completa da subtarefa' },
        },
        required: ['agent', 'task'],
      },
    },
    run: async ({ agent, task }) => {
      const cfg = loadConfig();
      const list = cfg.agents || [];
      const p = list.find((x) => String(x.name).toLowerCase() === String(agent || '').toLowerCase());
      if (!p) return { error: `agente desconhecido: "${agent}". Disponíveis: ${list.map((x) => x.name).join(', ') || '(nenhum)'}` };
      const label = nextAgentLabel(p.name); // ex.: "Programador 1", "Programador 2"...
      broadcast('chat:agent', { name: label, task: String(task || ''), phase: 'start' });
      try {
        const result = await runSubAgent(cfg, p, String(task || ''), label);
        broadcast('chat:agent', { name: label, phase: 'done' });
        return { agent: label, result };
      } catch (e) {
        broadcast('chat:agent', { name: label, phase: 'done' });
        return { agent: label, error: String((e && e.message) || e) };
      }
    },
  },
};

// ---- MCP (Model Context Protocol): ferramentas externas plugaveis ----
const mcpClients = {}; // nome do servidor -> client
let mcpTools = []; // [{ fn, server, toolName, schema }]  (fn = nome unico p/ o modelo)
let mcpStatus = {}; // nome -> { ok, count, error }

function sanitizeName(s) {
  return String(s).replace(/[^a-zA-Z0-9_]/g, '_').slice(0, 48);
}

async function connectMcpServers() {
  // fecha conexoes antigas
  for (const name in mcpClients) {
    try {
      await mcpClients[name].close();
    } catch (e) {
      /* ok */
    }
    delete mcpClients[name];
  }
  mcpTools = [];
  mcpStatus = {};
  const cfg = loadConfig();
  const servers = cfg.mcpServers || {};
  if (!Object.keys(servers).length) return mcpStatus;

  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');

  for (const name of Object.keys(servers)) {
    const s = servers[name] || {};
    try {
      const transport = new StdioClientTransport({
        command: s.command,
        args: s.args || [],
        env: { ...process.env, ...(s.env || {}) },
      });
      const client = new Client({ name: 'lumi', version: '1.0.0' }, { capabilities: {} });
      await client.connect(transport);
      const list = await client.listTools();
      mcpClients[name] = client;
      (list.tools || []).forEach((t) => {
        mcpTools.push({
          fn: `mcp_${sanitizeName(name)}_${sanitizeName(t.name)}`,
          server: name,
          toolName: t.name,
          schema: {
            name: `mcp_${sanitizeName(name)}_${sanitizeName(t.name)}`,
            description: `[MCP:${name}] ${t.description || t.name}`,
            parameters: t.inputSchema || { type: 'object', properties: {} },
          },
        });
      });
      mcpStatus[name] = { ok: true, count: (list.tools || []).length };
    } catch (e) {
      mcpStatus[name] = { ok: false, error: String((e && e.message) || e) };
    }
  }
  return mcpStatus;
}

// opts.allow = lista de nomes permitidos (subagente); opts.delegate = inclui delegate_to_agent
function toolSchemas(opts) {
  opts = opts || {};
  const allow = opts.allow || null;
  const ok = (name) => {
    if (name === 'delegate_to_agent') return !!opts.delegate; // só no orquestrador
    return !allow || allow.includes(name);
  };
  const native = Object.entries(TOOLS)
    .filter(([n]) => ok(n))
    .map(([, t]) => ({ type: 'function', function: t.schema }));
  const mcp = mcpTools
    .filter((t) => !allow || allow.includes(t.fn))
    .map((t) => ({ type: 'function', function: t.schema }));
  return native.concat(mcp);
}

// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
// (claudeQuery agora vive na Session — Claude Code roda em PARALELO, um por sessão)
const WRITE_TOOLS = ['write_file', 'edit_file', 'append_file', 'make_dir', 'delete_file', 'apply_patch']; // apply_patch conta: auto-verify/self-review/checkpoint

// ---- CHECKPOINTS: antes de cada edição, guarda o conteúdo original → "↩ desfazer" por turno ----
// (sessionizado: agora vive em makeSession/S())
let checkpoints = []; // pilha dos últimos turnos com edições (memória da sessão, máx 10)
let cpSeq = 0;
const CHECKPOINT_TURN_BYTES = 4 * 1024 * 1024;
function snapshotForCheckpoint(rel) {
  if (!S().cp || !rel || S().cp.files.has(rel)) return; // só o estado ANTES da 1ª mexida no arquivo
  try {
    const abs = resolvePath(rel);
    if (fs.existsSync(abs)) {
      const size = fs.statSync(abs).size;
      if (size > 2 * 1024 * 1024 || S().cp.bytes + size > CHECKPOINT_TURN_BYTES) return;
      S().cp.files.set(rel, fs.readFileSync(abs, 'utf8'));
      S().cp.bytes += size;
    } else S().cp.files.set(rel, null); // não existia → desfazer = apagar
  } catch (e) {
    /* snapshot é melhor-esforço */
  }
}
function captureForCheckpoint(name, a) {
  if (!S().cp) return;
  // apply_patch mexe em VÁRIOS arquivos sem args.path — extrai do próprio diff (senão o ↩ desfazer não cobria)
  if (name === 'apply_patch' && a && a.patch) {
    const seen = new Set();
    for (const mm of String(a.patch).matchAll(/^(?:\+\+\+ b|--- a)\/(.+)$/gm)) {
      const rel = mm[1].trim();
      if (rel && rel !== '/dev/null' && !seen.has(rel)) {
        seen.add(rel);
        snapshotForCheckpoint(rel);
      }
    }
    return;
  }
  if (!['write_file', 'edit_file', 'append_file', 'delete_file'].includes(name)) return;
  snapshotForCheckpoint(a && a.path);
}
ipcMain.handle('checkpoint:undo', (_e, id) => {
  const idx = checkpoints.findIndex((c) => c.id === id);
  if (idx < 0) return { error: 'ponto de restauração não encontrado (desfazer vale só na sessão atual)' };
  const restored = new Set();
  // desfaz do mais novo até o pedido (pilha) — o estado final é o de ANTES daquele turno
  while (checkpoints.length > idx) {
    const cp = checkpoints.pop();
    for (const [rel, content] of cp.files) {
      try {
        const abs = resolvePath(rel);
        if (content === null) {
          try {
            fs.unlinkSync(abs);
          } catch (e) {
            /* já não existe */
          }
        } else {
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, content, 'utf8');
        }
        restored.add(rel);
      } catch (e) {
        /* segue restaurando os demais */
      }
    }
  }
  broadcast('workspace:changed');
  broadcast('chat:note', { text: '↩ mudanças desfeitas — ' + restored.size + ' arquivo(s) restaurado(s)' });
  return { ok: true, restored: restored.size };
});
async function runTool(name, args) {
  const a = args || {};
  // ANTI-LOOP: mesma chamada IDÊNTICA que já falhou 2x sem NADA mudar no estado → 3ª é loop garantido
  const callKey = name + '|' + JSON.stringify(a);
  const identicalFails = S().toolCallLog.filter((c) => c.key === callKey && c.error && c.stateSeq === S().stateSeq).length;
  if (identicalFails >= 2) {
    const last = [...S().toolCallLog].reverse().find((c) => c.key === callKey && c.error);
    const out = {
      error:
        'LOOP DETECTADO: você repetiu EXATAMENTE esta chamada e ela já falhou ' + identicalFails + 'x com: "' +
        compactText((last && last.summary) || 'mesmo erro', 160) +
        '". Nada mudou desde então — repetir dá o MESMO resultado. MUDE a abordagem (outra ferramenta, outro caminho, outros args) ou pergunte ao usuário com ask_user.',
      loop: true,
    };
    recordToolTrace(name, a, out);
    S().toolCallLog.push({ key: callKey, error: true, stateSeq: S().stateSeq, summary: out.error });
    return out;
  }
  const logCall = (res, readonly) => {
    const isErr = !!(res && (res.error || res.isError));
    S().toolCallLog.push({ key: callKey, error: isErr, stateSeq: S().stateSeq, summary: isErr ? String(res.error || 'erro') : '' });
    if (S().toolCallLog.length > 80) S().toolCallLog = S().toolCallLog.slice(-60);
    if (!readonly && !isErr) S().stateSeq++; // escrita/comando bem-sucedido: o mundo mudou
    // leitura idêntica repetida sem nada ter mudado → avisa (treina o modelo a não re-ler à toa)
    if (readonly && !isErr && res && typeof res === 'object') {
      const prevOk = S().toolCallLog.slice(0, -1).some((c) => c.key === callKey && !c.error && c.stateSeq === S().stateSeq);
      if (prevOk) res._nota = 'você JÁ fez esta chamada idêntica neste turno e nada mudou — o resultado é o mesmo; não repita leituras.';
    }
  };
  // ferramenta MCP?
  const mt = mcpTools.find((t) => t.fn === name);
  if (mt) {
    const ok = await checkPermission('mcp', `usar ${mt.toolName} (servidor ${mt.server})`);
    if (!ok) {
      const denied = { error: 'permissão negada pelo usuário (mcp)' };
      recordToolTrace(name, a, denied);
      return denied;
    }
    try {
      const res = await mcpClients[mt.server].callTool({ name: mt.toolName, arguments: a });
      const text = (res.content || [])
        .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
        .join('\n');
      const out = { content: truncate(text, 8000), isError: !!res.isError };
      recordToolTrace(name, a, out);
      logCall(out, false); // MCP pode mudar estado — trata como escrita
      return out;
    } catch (e) {
      const out = { error: String((e && e.message) || e) };
      recordToolTrace(name, a, out);
      logCall(out, false);
      return out;
    }
  }
  // ferramenta nativa
  const t = TOOLS[name];
  if (!t) {
    // "VOCÊ QUIS DIZER": modelo fraco erra o nome — devolve os mais próximos em vez de só falhar
    const cand = closestNames(name, [...Object.keys(TOOLS), ...mcpTools.map((x) => x.fn)], 3);
    const out = {
      error:
        'ferramenta desconhecida: "' + name + '".' +
        (cand.length ? ' Você quis dizer: ' + cand.join(' | ') + '? Use EXATAMENTE um desses nomes.' : ' Use exatamente um dos nomes das suas ferramentas.'),
    };
    recordToolTrace(name, a, out);
    return out;
  }
  normalizeToolArgs(t, a); // aliases comuns de args (file→path, text→content...) — menos chamadas perdidas
  const ok = await checkPermission(t.category, t.summary ? t.summary(a) : null);
  if (!ok) {
    const out = { error: `permissão negada pelo usuário (${t.category})` };
    recordToolTrace(name, a, out);
    return out;
  }
  try {
    captureForCheckpoint(name, a); // snapshot do estado original (pro "↩ desfazer")
    const res = await t.run(a);
    if (WRITE_TOOLS.includes(name) && !(res && res.error)) S().editedSinceTurn = true; // p/ verificação automática
    recordToolTrace(name, a, res);
    logCall(res, READONLY_TOOLS.has(name));
    return res;
  } catch (e) {
    const out = { error: String((e && e.message) || e) };
    recordToolTrace(name, a, out);
    logCall(out, READONLY_TOOLS.has(name));
    return out;
  }
}

// VERIFICAÇÃO AUTOMÁTICA: roda o comando do projeto após edições e devolve o resultado.
// Retorna true se FALHOU (o orquestrador deve pedir correção ao modelo).
async function maybeAutoVerify(cfg, messages) {
  if (cfg.autoVerify !== true || !cfg.workspace || !S().editedSinceTurn) return false;
  if ((cfg.perms || {}).exec === 'deny') return false;
  const cmd = (cfg.verifyCommand && cfg.verifyCommand.trim()) || detectStackCached(cfg.workspace).verify;
  if (!cmd) return false;
  S().editedSinceTurn = false; // consome (só verifica de novo se editar de novo)
  broadcast('chat:tool', { name: 'run_command', args: { command: cmd }, agent: '🔁 auto-verificação' });
  let r;
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: cfg.workspace, timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    r = { ok: true, output: truncate((stdout || '') + (stderr || ''), 4000) };
  } catch (e) {
    r = { ok: false, output: truncate((e.stdout || '') + '\n' + (e.stderr || '') + '\n' + (e.message || ''), 8000) };
  }
  broadcast('tool:animation', r.ok ? 'happy' : 'sad'); // avatar comemora/lamenta a verificação
  broadcast('chat:tool-result', { name: 'run_command', args: { command: cmd }, result: { ok: r.ok, output: r.output }, agent: '🔁 auto-verificação' });
  if (S().currentTurnLog) S().currentTurnLog.verification.push({ command: cmd, ok: r.ok, summary: compactText(r.output, 300) });
  if (r.ok) return false; // passou -> nada a corrigir
  broadcast('chat:newbubble'); // separa a próxima resposta (a correção) num balão novo
  const fails = extractFailures(r.output);
  const summary = fails.length ? 'Problemas detectados:\n' + fails.map((f) => '- ' + f).join('\n') + '\n\n' : '';
  const verificationMessage = {
    role: 'user',
    content: `[verificação automática] O comando \`${cmd}\` FALHOU.\n${summary}Saída (final):\n${tailStr(r.output, 4000)}\n\nCorrija a CAUSA RAIZ desses problemas no código (use get_problems/locate_stack se ajudar). Depois eu rodo a verificação de novo.`,
  };
  messages.push(verificationMessage);
  if (S().pendingTurnTranscript) S().pendingTurnTranscript.messages.push(cloneContextMessage(verificationMessage));
  return true;
}

// AUTO-REVISÃO: antes de finalizar um turno que mexeu em código, um agente lê o DIFF e aponta
// bug/risco. Se achar algo real, injeta pra corrigir antes de entregar. "Evidência, não confiança."
async function maybeSelfReview(cfg, messages) {
  if (cfg.selfReview !== true || !cfg.workspace) return false;
  if (!S().currentTurnLog || !S().currentTurnLog.filesChanged || !S().currentTurnLog.filesChanged.size) return false;
  let diff = '';
  try {
    const a = await gitRun(cfg, ['diff', '--no-color']);
    const b = await gitRun(cfg, ['diff', '--cached', '--no-color']);
    diff = ((a.stdout || '') + '\n' + (b.stdout || '')).trim();
  } catch (e) {
    return false; // sem git → sem auto-revisão
  }
  if (!diff) return false;
  broadcast('chat:tool', { name: 'git_diff', args: {}, agent: '🔎 auto-revisão' });
  let review = '';
  try {
    review = await llmComplete(cfg, [
      {
        role: 'system',
        content:
          'Você é uma revisora de código rigorosa. Analise APENAS o diff e aponte problemas REAIS: bugs, casos não tratados, regressões, riscos de segurança/dados. Ignore estilo e nitpicks. Se estiver tudo bem, responda EXATAMENTE "OK". Senão, liste em itens curtos "- " (no máximo 6), cada um com arquivo/linha se der.',
      },
      { role: 'user', content: 'Revise este diff antes de finalizar:\n\n' + diff.slice(0, 16000) },
    ]);
  } catch (e) {
    return false;
  }
  const clean = String(review || '').trim();
  const isOk = !clean || /^ok\b/i.test(clean) || clean.length < 6;
  broadcast('chat:tool-result', { name: 'git_diff', args: {}, result: { ok: isOk, output: isOk ? 'sem problemas' : clean }, agent: '🔎 auto-revisão' });
  if (S().currentTurnLog) S().currentTurnLog.verification.push({ command: 'auto-revisão', ok: isOk, summary: compactText(clean, 300) });
  if (isOk) return false;
  broadcast('chat:newbubble');
  const reviewMessage = {
    role: 'user',
    content: `[auto-revisão do seu diff] Antes de finalizar, uma revisão apontou possíveis problemas:\n${clean}\n\nCorrija os que forem REAIS. Se algum for falso positivo, explique por quê em 1 linha. Depois finalize.`,
  };
  messages.push(reviewMessage);
  if (S().pendingTurnTranscript) S().pendingTurnTranscript.messages.push(cloneContextMessage(reviewMessage));
  return true;
}

// Uma "rodada" no endpoint OpenAI-compativel: devolve { text, toolCalls }
// onToken = resposta visivel; onThink = raciocinio (modelos "thinking")
async function openaiTurn(cfg, messages, tools, onToken, onThink) {
  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`; // chave opcional
  const body = { model: requestModel(cfg), messages, temperature: cfg.temperature, stream: true };
  if (tools && tools.length) body.tools = tools;
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: S().abort ? S().abort.signal : undefined, // permite o botão Stop abortar
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);

  let text = '';
  let usage = null;
  const toolCalls = [];

  // separa <think>...</think> que alguns modelos colocam dentro do content
  let buf = '';
  let inThink = false;
  const keepTail = (s, tag) => {
    for (let k = 1; k < tag.length; k++) if (s.endsWith(tag.slice(0, k))) return s.slice(0, s.length - k);
    return s;
  };
  const feed = (chunk) => {
    buf += chunk;
    for (;;) {
      if (!inThink) {
        const i = buf.indexOf('<think>');
        if (i === -1) {
          const safe = keepTail(buf, '<think>');
          if (safe) { text += safe; onToken(safe); buf = buf.slice(safe.length); }
          break;
        }
        const before = buf.slice(0, i);
        if (before) { text += before; onToken(before); }
        buf = buf.slice(i + 7);
        inThink = true;
      } else {
        const j = buf.indexOf('</think>');
        if (j === -1) {
          const safe = keepTail(buf, '</think>');
          if (safe && onThink) onThink(safe);
          if (safe) buf = buf.slice(safe.length);
          break;
        }
        const t = buf.slice(0, j);
        if (t && onThink) onThink(t);
        buf = buf.slice(j + 8);
        inThink = false;
      }
    }
  };

  try {
    await readSSE(res, (data) => {
      if (data === '[DONE]') return;
      let j;
      try {
        j = JSON.parse(data);
      } catch (e) {
        return;
      }
      if (j.usage) usage = j.usage; // alguns provedores mandam uso exato
      const d = j.choices && j.choices[0] && j.choices[0].delta;
      if (!d) return;
      if (d.content) feed(d.content);
      const rc = d.reasoning_content || d.reasoning; // campos de raciocinio (DeepSeek/OpenRouter)
      if (rc && onThink) onThink(rc);
      if (d.tool_calls) {
        d.tool_calls.forEach((tc) => {
          const i = tc.index || 0;
          toolCalls[i] = toolCalls[i] || { id: '', name: '', arguments: '' };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function) {
            if (tc.function.name) toolCalls[i].name = tc.function.name;
            if (tc.function.arguments) toolCalls[i].arguments += tc.function.arguments;
          }
        });
      }
    });
  } catch (e) {
    // botão Stop: devolve o que já foi gerado em vez de estourar erro
    if (S().abort && S().abort.signal.aborted) {
      if (buf && !inThink) text += buf;
      return { text, toolCalls: toolCalls.filter(Boolean), usage, ms: Date.now() - t0, aborted: true };
    }
    throw e;
  }
  if (buf && !inThink) { text += buf; onToken(buf); } // descarrega o resto

  return finishTurn(text, toolCalls.filter(Boolean), usage, t0, tools);
}

// Loop do agente (OpenAI-compativel): chama ferramentas ate produzir a resposta final
// Executa um SUBAGENTE (perfil) numa conversa isolada e devolve o texto final.
// Subagentes NÃO podem delegar (evita recursão) e só usam as ferramentas do perfil.
// Numeração por instância de agente (Programador 1, Programador 2...). Zera a cada turno.
let agentSeq = {};
function nextAgentLabel(name) {
  agentSeq[name] = (agentSeq[name] || 0) + 1;
  return `${name} ${agentSeq[name]}`;
}

// ============================================================
//  GASTÔMETRO: tokens e custo estimado do DIA (por provedor)
// ============================================================
function usagePath() {
  return path.join(app.getPath('userData'), 'usage.json');
}
let usageDay = null;
function loadUsageDay() {
  if (!usageDay) {
    try {
      usageDay = JSON.parse(fs.readFileSync(usagePath(), 'utf8'));
    } catch (e) {
      usageDay = { day: '', prov: {} };
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  if (usageDay.day !== today) usageDay = { day: today, prov: {} }; // virou o dia → o medidor zera
  return usageDay;
}
// preços APROXIMADOS (US$ por 1M de tokens, entrada/saída) por prefixo do modelo — é estimativa
const MODEL_PRICES = [
  ['claude-opus-4', 5, 25], ['claude-sonnet-4', 3, 15], ['claude-haiku-4', 1, 5],
  ['gpt-5.5', 5, 30], ['gpt-5-mini', 0.25, 2], ['gpt-5-nano', 0.05, 0.4], ['gpt-5', 1.25, 10],
  ['gpt-4o-mini', 0.15, 0.6], ['gpt-4o', 2.5, 10], ['gpt-4.1-mini', 0.4, 1.6], ['gpt-4.1', 2, 8],
  ['deepseek-v4-pro', 0.44, 0.87], ['deepseek-v4', 0.28, 0.42], ['deepseek-chat', 0.27, 1.1], ['deepseek-reasoner', 0.55, 2.19],
  ['gemini-2.5-pro', 1.25, 10], ['gemini-2.5-flash-lite', 0.1, 0.4], ['gemini-2.5-flash', 0.3, 2.5],
  ['grok-code-fast', 0.2, 1.5], ['grok-4-fast', 0.2, 0.5], ['grok-4', 3, 15],
  ['kimi-k2', 0.6, 2.5], ['glm-4.6', 0.6, 2.2], ['minimax', 0.3, 1.65],
  ['llama-3.3-70b', 0.59, 0.79], ['llama-3.1-8b', 0.05, 0.08],
  ['mistral-small', 0.1, 0.3], ['mistral-large', 2, 6],
  ['qwen-plus', 0.4, 1.2], ['qwen-turbo', 0.05, 0.2], ['qwen-max', 1.6, 6.4],
  ['sonar', 1, 1], ['command-a', 2.5, 10],
];
function priceFor(model) {
  const m = String(model || '').toLowerCase();
  if (!m || m.includes(':free') || m.endsWith('-free') || m === 'big-pickle') return [0, 0];
  for (const [pfx, pin, pout] of MODEL_PRICES) if (m.includes(pfx)) return [pin, pout];
  return null; // desconhecido (ex.: proxy local) → só conta tokens
}
function usageTotals() {
  const u = loadUsageDay();
  let usd = 0;
  let tin = 0;
  let tout = 0;
  let unknown = false;
  for (const p of Object.values(u.prov)) {
    usd += p.usd;
    tin += p.in;
    tout += p.out;
    if (p.unknown) unknown = true;
  }
  return { day: u.day, usd, in: tin, out: tout, unknown };
}
function recordUsage(cfg, usage) {
  try {
    if (!usage || (!usage.prompt_tokens && !usage.completion_tokens)) return;
    const u = loadUsageDay();
    let host = cfg.usageHost || 'api';
    if (!cfg.usageHost) {
      try {
        host = cfg.provider === 'anthropic' ? 'anthropic' : new URL(cfg.baseUrl).hostname;
      } catch (e) {
        /* baseUrl estranha — agrupa em "api" */
      }
    }
    const p = u.prov[host] || (u.prov[host] = { in: 0, out: 0, usd: 0 });
    p.in += usage.prompt_tokens || 0;
    p.out += usage.completion_tokens || 0;
    const pr = priceFor(cfg.model);
    if (pr) p.usd += ((usage.prompt_tokens || 0) * pr[0] + (usage.completion_tokens || 0) * pr[1]) / 1e6;
    else p.unknown = true;
    fs.writeFileSync(usagePath(), JSON.stringify(u));
    broadcast('chat:spend', usageTotals());
  } catch (e) {
    /* o medidor nunca pode derrubar um turno */
  }
}
ipcMain.handle('usage:today', () => usageTotals());

// Monta o system prompt do subagente: persona + projeto/workspace + contexto da conversa
function subAgentSystemPrompt(cfg, agent) {
  let sp = (agent.systemPrompt || 'Você é um assistente especializado.') + '\n' + OS_NOTE;
  // agente "de código"? (tem ferramentas de arquivo/comando) -> ganha o guia de engenharia
  const CODER_TOOLS = ['write_file', 'edit_file', 'append_file', 'read_file', 'grep_files', 'list_dir', 'make_dir', 'delete_file', 'run_command'];
  const isCoder = Array.isArray(agent.tools) && agent.tools.some((t) => CODER_TOOLS.includes(t));
  // memória do projeto / workspace (para o subagente "enxergar" o projeto)
  if (cfg.workspace) {
    if (isCoder) sp += '\n\n' + CODING_GUIDE;
    const pctx = cachedProjCtx(cfg); // cache 20s — N subagentes em paralelo não re-leem N vezes
    const memChars = Math.min(64000, Math.max(12000, Math.floor(contextLimits(cfg).window * 0.1 * 3.6)));
    const mem = pctx.mem ? pctx.mem.slice(0, memChars) : '(memória do projeto ainda vazia)';
    const det = detectStackCached(cfg.workspace);
    let proj = `\n\n# Projeto atual\nWorkspace: ${cfg.workspace} (projeto ATUAL)`;
    if (det.stack) proj += `\nStack: ${det.stack}`;
    if (isCoder && det.verify) proj += `\nVerifique suas mudanças rodando \`${det.verify}\` (run_command) e leia a saída.`;
    if (isCoder && det.guide) proj += `\n\n## Boas práticas desta stack (siga-as)\n${det.guide}`;
    if (isCoder && pctx.rules) {
      proj += `\n\n## Briefing do projeto — CLAUDE.md/regras do repositório (SIGA À RISCA)\n${pctx.rules}`;
    }
    sp += proj + `\n\n## Memória de trabalho do projeto (.lumi-memory.md — decisões, gotchas, pendências; complementa o briefing, não o repete):\n${mem}`;
  }
  // resumo do que já rolou na conversa principal
  if (S().convSummary) {
    sp += `\n\n# Contexto da conversa principal (resumo):\n${S().convSummary}`;
  }
  const diary = worklogPrompt(cfg);
  if (diary) sp += `\n\n# Diário técnico recente (não repita erros já conhecidos)\n${diary}`;
  // últimas mensagens da conversa principal (o que está rolando agora)
  const recent = sanitizeForSave(S().history)
    .slice(-6)
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[multimídia]'}`)
    .join('\n')
    .slice(0, 4000);
  if (recent.trim()) {
    sp += `\n\n# Conversa recente (para entender o pedido — você NÃO faz parte dela, é um especialista chamado para esta tarefa):\n${recent}`;
  }
  return sp;
}

async function runSubAgent(cfg, agent, task, label) {
  const who = label || agent.name; // rótulo da instância (ex.: "Programador 1")
  const sub = { ...cfg };
  if (agent.model) sub.model = agent.model;
  if (agent.temperature != null) sub.temperature = agent.temperature;
  const messages = [
    { role: 'system', content: subAgentSystemPrompt(cfg, agent) },
    { role: 'user', content: task },
  ];
  // tools como array (mesmo vazio) = lista exata permitida; ausente/não-array = todas
  const allow = Array.isArray(agent.tools) ? agent.tools : null;
  let tools = toolSchemas({ allow, delegate: false });
  const turnFn = turnAdapter(sub);
  let full = '';
  let lastText = ''; // última narração não-vazia (caso o turno final venha sem texto)
  const did = []; // ações executadas (fallback p/ quando o modelo não resume no fim)
  let completed = false; // terminou de fato (vs. atingiu o limite de passos)
  const MAX_STEPS = Math.min(200, Math.max(4, parseInt(cfg.maxSteps, 10) || 48));
  const onTok = (tk) => broadcast('chat:agent-token', { agent: who, t: tk }); // narração ao vivo no chat
  for (let step = 0; step < MAX_STEPS; step++) {
    if (S().abort && S().abort.signal.aborted) break; // botão Stop para os subagentes também
    compactTurnMessages(messages, sub, tools); // subagente em tarefa longa também compacta
    let turn;
    try {
      turn = await turnFn(sub, messages, tools, onTok, () => {});
    } catch (e) {
      if (S().abort && S().abort.signal.aborted) break; // parado pelo usuário
      if (tools.length) {
        tools = [];
        turn = await turnFn(sub, messages, tools, onTok, () => {});
      } else {
        throw e;
      }
    }
    recordUsage(sub, turn.usage); // gastômetro: cada passo do subagente conta
    if (turn.text && turn.text.trim()) lastText = turn.text; // guarda narração (some no fim em alguns modelos)
    if (turn.aborted) { full = turn.text; completed = true; break; } // Stop: devolve o parcial do subagente
    if (turn.toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: sanitizeToolCallsForProvider(turn.toolCalls),
        _responsesItems: turn.responseItems,
      });
      for (const tc of turn.toolCalls) {
        const args = parseToolArguments(tc.arguments);
        broadcast('chat:tool', { name: tc.name, args, agent: who });
        const result = await runTool(tc.name, args);
        broadcast('chat:tool-result', { name: tc.name, args, result, agent: who });
        const okTool = !(result && result.error);
        did.push((okTool ? '✓ ' : '✗ ') + tc.name + (args && args.path ? ' ' + args.path : '')); // registra o que fez
        const forModel =
          result && result.images ? { ok: true, generated: result.images.length } : result && result._image ? { ok: true, note: 'captura feita' } : result;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(forModel) });
      }
      continue;
    }
    full = turn.text;
    completed = true;
    break;
  }
  // GARANTE retorno útil ao orquestrador: muitos modelos encerram com texto vazio mesmo
  // tendo feito todo o trabalho via ferramentas → sem isso a Lumi acha que "o agente não respondeu".
  if (!full || !full.trim()) {
    if (lastText && lastText.trim()) full = lastText;
    else if (did.length) full = 'Tarefa concluída. Ações executadas pelo agente: ' + did.join('; ') + '.';
    else if (!completed) full = '(o agente atingiu o limite de passos sem finalizar a tarefa)';
    else full = '(o agente finalizou sem produzir texto)';
  }
  return full;
}

async function runAgent(cfg) {
  agentSeq = {}; // zera a numeração dos subagentes a cada turno (Programador 1, 2...)
  S().editedSinceTurn = false; // reseta o rastreio de edições (verificação automática)
  const onToken = (t) => broadcast('chat:token', t);
  const onThink = (t) => broadcast('chat:thinking', t);
  const currentUser = S().history[S().history.length - 1];
  S().pendingTurnTranscript = {
    historyTailCount: currentUser && currentUser.role === 'user' ? 1 : 0,
    messages: currentUser && currentUser.role === 'user' ? [cloneContextMessage(currentUser)] : [],
  };
  const messages = [{ role: 'system', content: buildSystemPrompt(cfg) }, ...contextMessagesForTurn()];
  let tools = cfg.toolsEnabled === false ? [] : toolSchemas({ delegate: agentsAvailable(cfg) });
  let full = '';
  let verifyAttempts = 0;
  let reviewed = false; // auto-revisão roda no máximo 1x por turno
  let runCfg = cfg; // pode trocar pro modelo reserva no meio do turno (fallback)
  let usedFallback = false;
  // teto de passos CONFIGURÁVEL (⚙ → Passos por turno): proxy local aguenta muito; API paga, menos
  const MAX_STEPS = Math.min(200, Math.max(4, parseInt(cfg.maxSteps, 10) || 48));
  let finished = false;
  for (let step = 0; step < MAX_STEPS; step++) {
    if (S().abort && S().abort.signal.aborted) break; // botão Stop
    compactTurnMessages(messages, runCfg, tools); // turno longo? encolhe os tool-results antigos
    // STEERING: mensagens enviadas durante o processamento entram como turno do usuário
    if (S().steerQueue.length) {
      for (const s of S().steerQueue.splice(0)) {
        const steering = { role: 'user', content: s.content };
        messages.push(steering);
        S().pendingTurnTranscript.messages.push(cloneContextMessage(steering));
        S().pendingTurnTranscript.historyTailCount++;
        S().editedSinceTurn = false; // a verificação considera só as edições após o novo pedido
      }
    }
    // RECITAÇÃO: turno longo faz qualquer modelo perder o fio — a cada 8 passos, 1 linha re-ancora o objetivo
    if (step > 0 && step % 8 === 0 && S().currentTurnLog && S().currentTurnLog.goal) {
      const recite = {
        role: 'user',
        content: `[foco — passo ${step}/${MAX_STEPS}] Objetivo do turno: "${S().currentTurnLog.goal}". Se desviou, volte a ele; se concluiu, VERIFIQUE e finalize; se está travada, mude a abordagem ou use ask_user.`,
      };
      messages.push(recite);
      S().pendingTurnTranscript.messages.push(cloneContextMessage(recite));
    }
    let turn;
    let live = liveStatsTracker(runCfg, messages, tools, { onToken, onThink });
    try {
      turn = await turnAdapter(runCfg)(runCfg, messages, tools, live.onToken, live.onThink);
    } catch (e) {
      live.fail();
      if (S().abort && S().abort.signal.aborted) break; // parado pelo usuário
      // FALLBACK: modelo principal falhou → tenta o reserva (mantendo as ferramentas)
      if (!usedFallback && cfg.fallbackModel && cfg.fallbackModel.trim()) {
        usedFallback = true;
        runCfg = { ...cfg, model: cfg.fallbackModel.trim() };
        broadcast('chat:note', { text: '⚠ modelo principal falhou (' + truncate(String((e && e.message) || e), 140) + ') — continuando com o reserva: ' + runCfg.model });
        step--;
        continue;
      }
      if (tools.length) {
        tools = []; // modelo pode nao suportar ferramentas -> tenta sem
        live = liveStatsTracker(runCfg, messages, tools, { onToken, onThink });
        turn = await turnAdapter(runCfg)(runCfg, messages, tools, live.onToken, live.onThink);
      } else {
        throw e;
      }
    }
    live.finish(turn.usage);
    recordUsage(runCfg, turn.usage); // gastômetro: cada passo conta (o contexto re-enviado é cobrado)
    if (turn.toolCalls.length) {
      const assistantTools = {
        role: 'assistant',
        content: turn.text || null,
        tool_calls: sanitizeToolCallsForProvider(turn.toolCalls),
        _responsesItems: turn.responseItems,
      };
      messages.push(assistantTools);
      S().pendingTurnTranscript.messages.push(cloneContextMessage(assistantTools));
      const toolLim = contextLimits(runCfg);
      const toolCtx = (turn.usage && turn.usage.prompt_tokens) || promptTokenEstimate(messages, tools);
      broadcast('chat:stats', {
        tps: 0,
        out: (turn.usage && turn.usage.completion_tokens) || 0,
        ctx: toolCtx,
        total: (turn.usage && turn.usage.total_tokens) || toolCtx,
        exact: !!turn.usage,
        live: true,
        phase: `executando ${turn.toolCalls.length} ferramenta(s)`,
        window: toolLim.window,
        pct: Math.min(999, Math.round((toolCtx / toolLim.window) * 100)),
      });
      // separa delegações (podem rodar EM PARALELO) das demais ferramentas
      // (arquivos/comando/tela continuam sequenciais — ordem e efeitos colaterais importam)
      const delegations = turn.toolCalls.filter((tc) => tc.name === 'delegate_to_agent');
      const others = turn.toolCalls.filter((tc) => tc.name !== 'delegate_to_agent');

      for (const tc of others) {
        const args = parseToolArguments(tc.arguments);
        broadcast('chat:tool', { name: tc.name, args });
        const result = await runTool(tc.name, args);
        broadcast('chat:tool-result', { name: tc.name, args, result });
        if (result && result._image) {
          // imagem (tela/página/arquivo) -> responde a tool e injeta como visão
          const note = result._imageNote || 'Esta é a captura da minha tela agora:';
          const toolMessage = { role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: true, note: 'Imagem anexada como visão.' }) };
          messages.push(toolMessage);
          S().pendingTurnTranscript.messages.push(cloneContextMessage(toolMessage));
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: note },
              { type: 'image_url', image_url: { url: result._image } },
            ],
          });
          broadcast('chat:user', { text: '📸 ' + note.replace(/:$/, ''), images: [result._image] });
        } else {
          // nao reenvia base64 de imagem gerada pro modelo (estoura o contexto)
          const forModel =
            result && result.images
              ? { ok: true, generated: result.images.length, note: 'Imagem gerada e exibida ao usuário.' }
              : result;
          const toolMessage = { role: 'tool', tool_call_id: tc.id, content: JSON.stringify(forModel) };
          messages.push(toolMessage);
          S().pendingTurnTranscript.messages.push(cloneContextMessage(toolMessage));
        }
      }

      // DELEGAÇÕES EM PARALELO: vários subagentes trabalham ao mesmo tempo (ex.: Programador 1 + 2 + Revisor)
      if (delegations.length) {
        const dres = await Promise.all(
          delegations.map(async (tc) => {
            const args = parseToolArguments(tc.arguments);
            broadcast('chat:tool', { name: tc.name, args });
            const result = await runTool(tc.name, args);
            broadcast('chat:tool-result', { name: tc.name, args, result });
            return { id: tc.id, result };
          })
        );
        // devolve os resultados ao modelo (cada um casado pelo seu tool_call_id)
        for (const { id, result } of dres) {
          const toolMessage = { role: 'tool', tool_call_id: id, content: JSON.stringify(result) };
          messages.push(toolMessage);
          S().pendingTurnTranscript.messages.push(cloneContextMessage(toolMessage));
        }
      }
      continue; // volta pro modelo com os resultados
    }
    full = turn.text;
    if (turn.aborted || (S().abort && S().abort.signal.aborted)) break; // botão Stop: mantém o parcial, não verifica
    // VERIFICAÇÃO AUTOMÁTICA: se editou arquivos e o comando falhar, o modelo corrige (até 3x)
    if (verifyAttempts < 3 && (await maybeAutoVerify(cfg, messages))) {
      verifyAttempts++;
      // ESCALADA: 2 correções falharam com o modelo atual → a próxima roda no RESERVA (mais forte).
      // O barato faz o grosso; o forte desbloqueia — excelência mesmo com modelo fraco.
      const fb = cfg.fallbackModel && cfg.fallbackModel.trim();
      if (verifyAttempts >= 2 && fb && runCfg.model !== fb) {
        runCfg = { ...runCfg, model: fb };
        broadcast('chat:note', { text: '🪜 duas correções falharam — escalando pro modelo reserva: ' + fb });
      }
      continue;
    }
    // auto-revisão do diff (1x): se apontar bug real, o modelo corrige antes de finalizar
    if (!reviewed) {
      reviewed = true;
      if (await maybeSelfReview(cfg, messages)) continue;
    }
    // estatisticas: usa o "usage" exato quando vier; senao estima (~4 chars/token)
    const est = (s) => Math.round((s || '').length / 4);
    const out = (turn.usage && turn.usage.completion_tokens) || est(full);
    const ctx = (turn.usage && turn.usage.prompt_tokens) || promptTokenEstimate(messages, tools); // cacheado (sem re-stringificar o contexto)
    const secs = Math.max(0.001, (turn.ms || 1) / 1000);
    const lim = contextLimits(runCfg);
    broadcast('chat:stats', {
      tps: Math.round(out / secs),
      out,
      ctx,
      total: (turn.usage && turn.usage.total_tokens) || out + ctx,
      exact: !!turn.usage,
      live: false,
      phase: 'concluído',
      window: lim.window,
      pct: Math.min(999, Math.round((ctx / lim.window) * 100)),
    });
    finished = true;
    break;
  }
  // bateu o teto sem terminar? avisa e deixa retomável (o histórico guarda o progresso)
  if (!finished && !(S().abort && S().abort.signal.aborted)) {
    const max = Math.min(200, Math.max(4, parseInt(cfg.maxSteps, 10) || 48));
    broadcast('chat:note', { text: '⚠ teto de ' + max + ' passos atingido — diga "continua" pra ela retomar (ajustável em ⚙ → Passos por turno)' });
    if (!full || !full.trim()) full = 'Cheguei ao teto de passos deste turno antes de terminar tudo. Diga "continua" que eu retomo exatamente de onde parei! 🔁';
  }
  return full;
}

// Lista os modelos disponiveis no endpoint (GET /models)
async function listModels(cfg) {
  if (cfg.provider === 'anthropic') {
    const base = (cfg.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
    const res = await fetch(base + '/models', {
      headers: { 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const j = await res.json();
    return (j.data || []).map((m) => m.id).filter(Boolean);
  }
  const base = cfg.baseUrl.replace(/\/$/, '');
  const res = await fetch(base + '/models', {
    headers: cfg.apiKey ? { Authorization: `Bearer ${cfg.apiKey}` } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const j = await res.json();
  const arr = j.data || j.models || [];
  return arr
    .map((m) => m.id || m.name)
    .filter(Boolean)
    .sort();
}

// ============================================================
//  Edge TTS (gratis, sem chave) - reimplementacao do edge-tts em Node
// ============================================================
const EDGE_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const EDGE_CHROMIUM = '143.0.3650.75'; // precisa acompanhar o edge-tts; versao velha = 403
const EDGE_GEC_VERSION = `1-${EDGE_CHROMIUM}`;
const EDGE_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const WIN_EPOCH = 11644473600; // segundos entre 1601 e 1970
let edgeClockSkew = 0; // correcao se o relogio local estiver fora de sincronia

// Token de seguranca (Sec-MS-GEC) exigido pelo servico.
// IMPORTANTE: replica o calculo em float do edge-tts (toFixed) - NAO usar BigInt,
// senao o numero nao bate com o que o servidor espera (da 403).
function edgeSecToken() {
  let ticks = Math.floor(Date.now() / 1000 + edgeClockSkew) + WIN_EPOCH;
  ticks -= ticks % 300; // arredonda para 5 min
  ticks *= 1e7; // intervalos de 100ns (formato Windows) - em float, igual ao edge-tts
  return crypto
    .createHash('sha256')
    .update(ticks.toFixed(0) + EDGE_TOKEN, 'ascii')
    .digest('hex')
    .toUpperCase();
}

// Remove a sintaxe de markdown para a voz ler so o conteudo
function stripMarkdown(t) {
  return t
    .replace(/```[\s\S]*?```/g, ' ') // blocos de codigo
    .replace(/`([^`]+)`/g, '$1') // codigo inline
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // imagens
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> texto
    .replace(/^\s{0,3}#{1,6}\s*/gm, '') // titulos
    .replace(/(\*\*|__)(.*?)\1/g, '$2') // negrito
    .replace(/(\*|_)(.*?)\1/g, '$2') // italico
    .replace(/~~(.*?)~~/g, '$1') // riscado
    .replace(/^\s{0,3}>\s?/gm, '') // citacao
    .replace(/^\s*[-*+]\s+/gm, '') // bullets
    .replace(/^\s*\d+\.\s+/gm, '') // listas numeradas
    .replace(/^\s*([-*_])\1{2,}\s*$/gm, '') // linhas horizontais
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Remove emojis e simbolos para a voz nao tentar "ler" eles
function stripEmojis(text) {
  return text
    .replace(/\p{Extended_Pictographic}/gu, '') // emojis
    .replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '') // bandeiras (regional indicators)
    .replace(/[\u{FE00}-\u{FE0F}\u{200D}\u{20E3}]/gu, '') // variation selectors / ZWJ / keycap
    .replace(/[ \t]{2,}/g, ' ') // espacos duplicados que sobraram
    .trim();
}

function escapeXml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function synthesizeEdge(text, voice, attempt = 0) {
  return new Promise((resolve, reject) => {
    const v = voice || 'pt-BR-FranciscaNeural';
    const wsUrl =
      'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1' +
      `?TrustedClientToken=${EDGE_TOKEN}&Sec-MS-GEC=${edgeSecToken()}&Sec-MS-GEC-Version=${EDGE_GEC_VERSION}`;

    const ws = new WebSocket(wsUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
          `Chrome/${EDGE_CHROMIUM} Safari/537.36 Edg/${EDGE_CHROMIUM}`,
        Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
        'Pragma': 'no-cache',
        'Cache-Control': 'no-cache',
      },
    });

    const chunks = [];
    let done = false;
    const reqId = crypto.randomUUID().replace(/-/g, '');

    // Se o handshake falhar (ex: 403), tenta corrigir o relogio pela hora do servidor e repete uma vez
    ws.on('unexpected-response', (_req, res) => {
      const status = res.statusCode;
      const serverDate = res.headers && res.headers.date;
      res.resume();
      try {
        ws.terminate();
      } catch (e) {
        /* ok */
      }
      if (done) return;
      done = true;
      if (status === 403 && attempt === 0 && serverDate) {
        edgeClockSkew = Date.parse(serverDate) / 1000 - Date.now() / 1000;
        synthesizeEdge(text, voice, 1).then(resolve, reject);
      } else {
        reject(new Error(`Edge TTS rejeitou (HTTP ${status}). Talvez a versao precise ser atualizada.`));
      }
    });

    ws.on('open', () => {
      ws.send(
        `X-Timestamp:${new Date().toString()}\r\nContent-Type:application/json; charset=utf-8\r\n` +
          `Path:speech.config\r\n\r\n{"context":{"synthesis":{"audio":{"metadataoptions":` +
          `{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${EDGE_FORMAT}"}}}}`
      );
      const ssml =
        `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>` +
        `<voice name='${v}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
      ws.send(
        `X-RequestId:${reqId}\r\nContent-Type:application/ssml+xml\r\n` +
          `X-Timestamp:${new Date().toString()}Z\r\nPath:ssml\r\n\r\n${ssml}`
      );
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        const headerLen = data.readUInt16BE(0);
        const header = data.slice(2, 2 + headerLen).toString('utf8');
        if (header.includes('Path:audio')) chunks.push(data.slice(2 + headerLen));
      } else if (data.toString().includes('Path:turn.end')) {
        done = true;
        ws.close();
        resolve({ mime: 'audio/mpeg', base64: Buffer.concat(chunks).toString('base64') });
      }
    });

    ws.on('error', (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
    ws.on('close', () => {
      if (done) return;
      done = true;
      reject(new Error('Edge TTS fechou antes de terminar.'));
    });
  });
}

// Embrulha PCM cru (16-bit LE) num arquivo WAV — o Gemini TTS devolve PCM,
// e o player (Web Audio decodeAudioData) precisa de um container (WAV/MP3).
function pcmToWav(pcm, sampleRate, channels) {
  const ch = channels || 1;
  const bits = 16;
  const blockAlign = (ch * bits) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // tamanho do bloco fmt
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(ch, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ============================================================
//  Sintese de voz (TTS) -> devolve audio em base64
// ============================================================
async function synthesize(cfg, text) {
  if (!text || cfg.ttsProvider === 'off' || !cfg.ttsProvider) return null;

  text = stripMarkdown(stripEmojis(text));
  if (!text) return null; // sobrou so markdown/emoji -> nada para falar

  if (cfg.ttsProvider === 'edge') {
    return synthesizeEdge(text, cfg.ttsVoice);
  }

  // Google AI Studio / Gemini TTS — gratis (preview), com vozes expressivas
  // (interpreta tags como [laughs], [chuckles], [whispering]...). Voz padrao Laomedeia.
  if (cfg.ttsProvider === 'gemini') {
    const model = cfg.ttsModel || 'gemini-3.1-flash-tts-preview';
    const voice = cfg.ttsVoice || 'Laomedeia';
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.ttsApiKey || cfg.apiKey },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${await res.text()}`);
    const j = await res.json();
    const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
    const audio = parts.map((p) => p.inlineData).find((d) => d && d.data);
    if (!audio) throw new Error('Gemini TTS não retornou áudio (verifique o modelo/voz/chave).');
    const mt = /rate=(\d+)/.exec(audio.mimeType || '');
    const rate = mt ? parseInt(mt[1], 10) : 24000; // Gemini = PCM 16-bit mono 24kHz
    const wav = pcmToWav(Buffer.from(audio.data, 'base64'), rate, 1);
    return { mime: 'audio/wav', base64: wav.toString('base64') };
  }

  // XTTS v2 (Coqui) — servidor proprio (ex.: Flask no Google Colab via cloudflared).
  // Contrato: POST {url}/tts com {text} -> devolve um arquivo WAV (bytes).
  // Campos opcionais (se o seu servidor aceitar): speaker_wav (= campo Voz) e language.
  if (cfg.ttsProvider === 'xtts') {
    const base = (cfg.ttsBaseUrl || '').replace(/\/$/, '');
    if (!base) throw new Error('Defina a URL do servidor XTTS (Colab/cloudflared) em ⚙ → Voz.');
    const endpoint = /\/tts$/.test(base) ? base : base + '/tts'; // tolera URL ja terminando em /tts
    const body = { text };
    if (cfg.ttsVoice) body.speaker_wav = cfg.ttsVoice; // futuro: voz/speaker especifico
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { mime: 'audio/wav', base64: buf.toString('base64') };
  }

  if (cfg.ttsProvider === 'elevenlabs') {
    const voice = cfg.ttsVoice || '21m00Tcm4TlvDq8ikWAM'; // "Rachel" (voz padrao)
    const model = cfg.ttsModel || 'eleven_multilingual_v2';
    const res = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': cfg.ttsApiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text, model_id: model }),
      }
    );
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { mime: 'audio/mpeg', base64: buf.toString('base64') };
  }

  if (cfg.ttsProvider === 'openai') {
    const base = (cfg.ttsBaseUrl || cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
    const res = await fetch(base + '/audio/speech', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.ttsApiKey || cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.ttsModel || 'gpt-4o-mini-tts',
        voice: cfg.ttsVoice || 'alloy',
        input: text,
      }),
    });
    if (!res.ok) throw new Error(`TTS HTTP ${res.status}: ${await res.text()}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { mime: 'audio/mpeg', base64: buf.toString('base64') };
  }

  return null;
}

// Historico da conversa + resumo (gestao de contexto)
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
function cloneContextMessage(m) {
  if (!m || typeof m !== 'object') return m;
  try {
    const copy = JSON.parse(JSON.stringify(m));
    if (Array.isArray(copy.content)) {
      copy.content = copy.content.map((p) => {
        if (p && p.type === 'image_url' && p.image_url && /^data:/i.test(p.image_url.url || '')) {
          return { type: 'text', text: '[imagem do turno anterior — recapture/reabra se precisar analisar novamente]' };
        }
        return p;
      });
    }
    if (typeof copy.content === 'string' && copy.content.length > 64000)
      copy.content = copy.content.slice(0, 64000) + ' …[resultado preservado parcialmente]';
    if (Array.isArray(copy.tool_calls)) {
      copy.tool_calls = sanitizeToolCallsForProvider(copy.tool_calls);
      copy.tool_calls.forEach((tc) => {
        if (tc && tc.function && typeof tc.function.arguments === 'string' && tc.function.arguments.length > 32000) {
          tc.function.arguments = JSON.stringify({ _preservadoParcialmente: true, preview: tc.function.arguments.slice(0, 30000) });
        }
      });
    }
    return copy;
  } catch (e) {
    return null;
  }
}
function contextMessagesForTurn() {
  if (!S().lastTurnContext || !Array.isArray(S().lastTurnContext.messages)) return S().history.map(cloneContextMessage).filter(Boolean);
  const anchor = parseInt(S().lastTurnContext.anchor, 10);
  const tailCount = Math.max(0, parseInt(S().lastTurnContext.historyTailCount, 10) || 0);
  const start = anchor - tailCount;
  if (start < 0 || anchor > S().history.length) {
    S().lastTurnContext = null;
    return S().history.map(cloneContextMessage).filter(Boolean);
  }
  return [
    ...S().history.slice(0, start).map(cloneContextMessage).filter(Boolean),
    ...S().lastTurnContext.messages.map(cloneContextMessage).filter(Boolean),
    ...S().history.slice(anchor).map(cloneContextMessage).filter(Boolean),
  ];
}
function finalizeLastTurnContext(finalText) {
  if (!S().pendingTurnTranscript || !S().pendingTurnTranscript.messages.length) {
    S().pendingTurnTranscript = null;
    return;
  }
  if (finalText && String(finalText).trim()) S().pendingTurnTranscript.messages.push({ role: 'assistant', content: String(finalText) });
  S().lastTurnContext = {
    anchor: S().history.length,
    historyTailCount: S().pendingTurnTranscript.historyTailCount,
    messages: S().pendingTurnTranscript.messages.map(cloneContextMessage).filter(Boolean),
    at: new Date().toISOString(),
  };
  S().pendingTurnTranscript = null;
}

function compactText(v, max) {
  let s = '';
  try {
    s = typeof v === 'string' ? v : JSON.stringify(v || '');
  } catch (e) {
    s = String(v || '');
  }
  s = s
    .replace(/\b(sk-[A-Za-z0-9_-]{12,})\b/g, '[chave]')
    .replace(/((?:api[_-]?key|token|password|senha)\s*[:=]\s*)[^\s,;]+/gi, '$1[oculto]');
  s = s.replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}
function toolTraceSummary(name, args, result) {
  if (result && result.error) return compactText(result.error, 280);
  if (name === 'read_file') return compactText((result && result.showing) || args.path || 'arquivo lido', 220);
  if (name === 'grep_files' || name === 'find_in_code')
    return `${(result && (result.total || (result.matches && result.matches.length) || (result.content_matches && result.content_matches.length))) || 0} resultado(s)`;
  if (name === 'edit_file' || name === 'write_file' || name === 'append_file') return compactText(args.path || 'arquivo alterado', 220);
  if (name === 'run_command') return compactText((result && (result.output || result.error)) || 'comando executado', 280);
  if (name === 'delegate_to_agent') return compactText((result && (result.result || result.error)) || args.task || 'delegação', 280);
  return compactText(result, 280);
}
function recordToolTrace(name, args, result) {
  if (!S().currentTurnLog) return;
  const status = result && (result.error || result.isError || result.ok === false || Number(result.status) >= 400) ? 'failed' : 'success';
  S().currentTurnLog.tools.push({
    tool: name,
    status,
    target: compactText((args && (args.path || args.query || args.pattern || args.command || args.url || args.agent)) || '', 180),
    summary: toolTraceSummary(name, args || {}, result),
  });
  if (S().currentTurnLog.tools.length > 40) S().currentTurnLog.tools.shift();
  const p = args && args.path;
  if (p && ['read_file', 'view_image'].includes(name)) S().currentTurnLog.filesRead.add(String(p));
  if (p && WRITE_TOOLS.includes(name) && status === 'success') S().currentTurnLog.filesChanged.add(String(p));
  // apply_patch não tem args.path — os arquivos alterados vêm no resultado
  if (name === 'apply_patch' && status === 'success' && result && Array.isArray(result.files)) {
    for (const f of result.files) S().currentTurnLog.filesChanged.add(String(f));
  }
}
function beginTurnLog() {
  resetTurnGuards(); // anti-loop + leia-antes-de-editar zeram a cada turno novo
  const last = [...S().history].reverse().find((m) => m.role === 'user');
  const raw = last && (typeof last.content === 'string' ? last.content : (last.content || []).filter((p) => p.type === 'text').map((p) => p.text).join(' '));
  S().currentTurnLog = {
    at: new Date().toISOString(),
    goal: compactText(String(raw || '').split(FILES_SENTINEL)[0], 500),
    tools: [],
    filesRead: new Set(),
    filesChanged: new Set(),
    verification: [],
  };
}
function finishTurnLog(outcome, status) {
  if (!S().currentTurnLog) return;
  if (!S().currentTurnLog.tools.length && !S().currentTurnLog.verification.length && !S().currentTurnLog.filesChanged.size) {
    S().currentTurnLog = null;
    return;
  }
  const entry = {
    at: S().currentTurnLog.at,
    goal: S().currentTurnLog.goal,
    status: status || 'completed',
    filesRead: [...S().currentTurnLog.filesRead].slice(0, 40),
    filesChanged: [...S().currentTurnLog.filesChanged].slice(0, 40),
    tools: S().currentTurnLog.tools,
    verification: S().currentTurnLog.verification.slice(-6),
    outcome: compactText(outcome, 700),
  };
  S().worklog.push(entry);
  if (S().worklog.length > 60) S().worklog = S().worklog.slice(-60);
  S().currentTurnLog = null;
}
function worklogPrompt(cfg) {
  if (!S().worklog.length || !cfg.workspace || cfg.memoryEnabled === false) return '';
  const recent = S().worklog.slice(-10).map((e) => {
    const tools = (e.tools || []).map((t) => `${t.status === 'success' ? '✓' : '✗'} ${t.tool}${t.target ? ` (${t.target})` : ''}: ${t.summary}`).join('\n');
    return [
      `## ${String(e.at || '').slice(0, 16).replace('T', ' ')} — ${e.goal || 'turno técnico'} [${e.status || 'completed'}]`,
      e.filesChanged && e.filesChanged.length ? `Arquivos alterados: ${e.filesChanged.join(', ')}` : '',
      e.verification && e.verification.length ? `Verificações: ${e.verification.map((v) => `${v.ok ? '✓' : '✗'} ${v.command}`).join('; ')}` : '',
      tools,
      e.outcome ? `Resultado: ${e.outcome}` : '',
    ].filter(Boolean).join('\n');
  }).join('\n\n');
  const maxChars = Math.min(32000, Math.max(6000, Math.floor(contextLimits(cfg).window * 0.06 * 3.6)));
  return recent.length > maxChars ? recent.slice(recent.length - maxChars) : recent;
}

function summaryPath() {
  return path.join(app.getPath('userData'), 'summary.txt');
}
function loadSummary() {
  try {
    return fs.readFileSync(summaryPath(), 'utf8');
  } catch (e) {
    return '';
  }
}
function saveSummary() {
  saveCurrentChat(); // multi-chat: o resumo vai junto no arquivo do chat
}

// Deriva a config das TAREFAS INTERNAS: se o usuário definiu um modelo de tarefas,
// usa ele (herdando o que ficou em branco do chat). Senão, usa a config do chat como está.
function taskCfg(cfg) {
  if (!cfg || (!cfg.taskModel && !cfg.taskProvider && !cfg.taskBaseUrl && !cfg.taskApiKey)) return cfg;
  const provider = cfg.taskProvider || cfg.provider;
  let baseUrl = cfg.taskBaseUrl;
  if (!baseUrl) {
    // sem URL dedicada: mesmo provedor → usa a do chat; anthropic → default oficial; senão herda a do chat
    baseUrl = provider === cfg.provider ? cfg.baseUrl : provider === 'anthropic' ? 'https://api.anthropic.com/v1' : cfg.baseUrl;
  }
  return { ...cfg, provider, baseUrl, apiKey: cfg.taskApiKey || cfg.apiKey, model: cfg.taskModel || cfg.model };
}

// Completa uma mensagem (nao-streaming) no provedor atual — usado p/ resumir e tarefas internas.
// TODAS as tarefas secundárias passam por aqui (o chat principal usa turnAdapter, não isto),
// então aplicar taskCfg aqui redireciona compactação/commit/review/PR/SQL/proatividade de uma vez.
async function llmComplete(cfg, messages) {
  cfg = taskCfg(cfg);
  if (cfg.provider === 'opencode') {
    const r = await turnAdapter(cfg)(cfg, messages, [], () => {}, () => {});
    return r.text || '';
  }
  if (cfg.provider === 'anthropic') {
    const base = (cfg.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const msgs = messages.filter((m) => m.role !== 'system');
    const res = await fetch(base + '/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: cfg.model, system: sys, messages: msgs, max_tokens: 1024 }),
    });
    if (!res.ok) throw new Error(await res.text());
    const j = await res.json();
    return (j.content || []).map((c) => c.text || '').join('');
  }
  const base = cfg.baseUrl.replace(/\/$/, '');
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
  const res = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, messages, stream: false }),
  });
  if (!res.ok) throw new Error(await res.text());
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

// Quando o historico cresce, resume as mensagens antigas (contexto "infinito")
async function maybeSummarize(cfg) {
  if (S().history.length <= 4) return;
  const lim = contextLimits(cfg);
  const tools = cfg.toolsEnabled === false ? [] : toolSchemas({ delegate: agentsAvailable(cfg) });
  const projected = promptTokenEstimate([{ role: 'system', content: buildSystemPrompt(cfg) }, ...contextMessagesForTurn()], tools);
  if (projected < lim.promptBudget) return;
  let keptTokens = 0;
  let keepFrom = S().history.length;
  for (let i = S().history.length - 1; i >= 0; i--) {
    keptTokens += estimateTokens(S().history[i]);
    keepFrom = i;
    if (keptTokens > lim.recentLiteral && S().history.length - i >= 4) break;
  }
  const cut = Math.max(1, keepFrom);
  const toSum = S().history.slice(0, cut);
  const rest = S().history.slice(cut);
  if (!toSum.length || !rest.length) return;
  const sourceChars = Math.min(120000, Math.max(12000, lim.promptBudget * 2));
  const text = toSum
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[conteúdo multimídia]'}`)
    .join('\n')
    .slice(0, sourceChars);
  try {
    const summary = await llmComplete(cfg, [
      {
        role: 'system',
        content:
          'Você compacta conversas preservando: objetivo atual, decisões (e o porquê), requisitos, fatos, preferências e pendências. PRESERVE LITERALMENTE nomes exatos — caminhos de arquivo, funções, comandos, URLs, IDs (são o fio da continuidade; resumo genérico os destrói). Não copie saídas brutas de ferramentas; priorize conclusões técnicas e o estado do trabalho (feito × em andamento × pendente). Conciso, completo, em português.',
      },
      { role: 'user', content: `Resumo anterior:\n${S().convSummary || '(nenhum)'}\n\nIncorpore estas mensagens ao resumo:\n${text}` },
    ]);
    if (summary && summary.trim()) {
      S().convSummary = summary.trim();
      S().history = rest;
      if (S().lastTurnContext) {
        const shiftedAnchor = Number(S().lastTurnContext.anchor) - cut;
        const shiftedStart = shiftedAnchor - Number(S().lastTurnContext.historyTailCount || 0);
        if (shiftedStart >= 0) S().lastTurnContext.anchor = shiftedAnchor;
        else S().lastTurnContext = null;
      }
      // as msgs resumidas saem do CONTEXTO mas vão pro arquivo morto (a UI continua mostrando tudo)
      S().chatArchive = S().chatArchive.concat(sanitizeForSave(toSum)).slice(-300);
      // realinha a linha do tempo: as msgs antigas saíram, então desloca os anchors
      S().chatEvents = S().chatEvents.map((e) => ({ ...e, a: e.a - cut })).filter((e) => e.a >= 0);
      saveSummary();
      saveHistory();
      broadcast('chat:compacted', { kept: rest.length, beforeTokens: projected, budgetTokens: lim.promptBudget });
    }
  } catch (e) {
    /* se falhar, mantem o historico como esta */
  }
}

// ---- FORK: arquiva a conversa e comeca um chat novo levando o resumo ----
function chatsDir() {
  const d = path.join(app.getPath('userData'), 'chats');
  try {
    fs.mkdirSync(d, { recursive: true });
  } catch (e) {
    /* ok */
  }
  return d;
}

// ============================================================
//  MULTI-CHAT: várias conversas salvas (chats/<id>.json)
// ============================================================
let currentChatId = '';
// (sessionizado: agora vive em makeSession/S())
// (sessionizado: agora vive em makeSession/S())
function chatFile(id) {
  return path.join(chatsDir(), id + '.json');
}
function genChatId() {
  return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);
}
function titleFromHistory(h) {
  const first = (h || []).find((m) => m.role === 'user');
  let t = '';
  if (first)
    t = typeof first.content === 'string'
      ? first.content
      : (first.content || []).filter((p) => p.type === 'text').map((p) => p.text).join(' ');
  t = (t || '').replace(/\s+/g, ' ').trim();
  return t ? t.slice(0, 48) : 'Nova conversa';
}
// salva a conversa ATIVA no arquivo do chat atual (preserva createdAt e título renomeado)
function saveCurrentChat() {
  // salva a SESSÃO atual (fg fora de turno; a própria sessão dentro de um turno paralelo)
  const sid = S().id || currentChatId;
  if (loadConfig().memoryEnabled === false || !sid) return;
  try {
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(chatFile(sid), 'utf8')) || {};
    } catch (e) {
      /* chat novo */
    }
    const data = {
      id: sid,
      title: meta.customTitle ? meta.title : titleFromHistory(S().history),
      customTitle: !!meta.customTitle,
      createdAt: meta.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary: S().convSummary,
      history: sanitizeForSave(S().history),
      events: S().chatEvents, // linha do tempo (tools/agentes/diffs/horários) — sobrevive ao reiniciar
      archive: S().chatArchive, // mensagens antigas compactadas (só pra exibição)
      worklog: S().worklog,
      lastTurnContext: S().lastTurnContext,
      claudeSessionId: S().claudeSessionId,
      claudeSessionWorkspace: S().claudeSessionWorkspace,
    };
    fs.writeFileSync(chatFile(sid), JSON.stringify(data));
  } catch (e) {
    /* ok */
  }
}
// lista os chats salvos (mais recentes primeiro)
function listChats() {
  let files = [];
  try {
    files = fs.readdirSync(chatsDir()).filter((n) => n.endsWith('.json'));
  } catch (e) {
    return [];
  }
  const out = [];
  for (const n of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(chatsDir(), n), 'utf8')) || {};
      const id = j.id || n.replace(/\.json$/i, '');
      const hist = j.history || [];
      out.push({
        id,
        title: j.title || titleFromHistory(hist),
        updatedAt: j.updatedAt || j.at || '',
        count: hist.length,
        current: id === currentChatId,
      });
    } catch (e) {
      /* ignora arquivo corrompido */
    }
  }
  out.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  return out;
}
function loadChatInto(id) {
  try {
    const j = JSON.parse(fs.readFileSync(chatFile(id), 'utf8')) || {};
    S().history = Array.isArray(j.history) ? j.history : [];
    S().convSummary = j.summary || '';
    S().chatEvents = Array.isArray(j.events) ? j.events : [];
    S().chatArchive = Array.isArray(j.archive) ? j.archive : [];
    S().worklog = Array.isArray(j.worklog) ? j.worklog.slice(-60) : [];
    S().lastTurnContext = j.lastTurnContext && Array.isArray(j.lastTurnContext.messages) ? j.lastTurnContext : null;
    S().claudeSessionId = j.claudeSessionId || '';
    S().claudeSessionWorkspace = j.claudeSessionWorkspace || '';
    S().pendingTurnTranscript = null;
    S().id = j.id || id; // identidade da SESSÃO (roteia eventos e o arquivo de save)
    if (S() === fgSession) currentChatId = S().id; // ponteiro de primeiro plano só muda no fg
    return true;
  } catch (e) {
    return false;
  }
}
function setCurrentChatId(id) {
  currentChatId = id;
  fgSession.id = id; // invariante: currentChatId === fgSession.id
  try {
    const c = loadConfig();
    c.currentChatId = id;
    saveConfig(c);
  } catch (e) {
    /* ok */
  }
}
// começa um chat novo (opcionalmente semeado com um resumo) e o torna atual
function newChat(seedSummary, seedWorklog) {
  S().history = [];
  S().convSummary = seedSummary || '';
  S().chatEvents = [];
  S().chatArchive = [];
  S().worklog = Array.isArray(seedWorklog) ? seedWorklog.slice(-12) : [];
  S().lastTurnContext = null;
  S().claudeSessionId = '';
  S().claudeSessionWorkspace = '';
  S().pendingTurnTranscript = null;
  setCurrentChatId(genChatId());
  saveCurrentChat();
  return currentChatId;
}
// cria uma conversa NOVA e vazia em disco SEM mexer na sessão ativa (pra abrir em janela destacada)
function createEmptyChat() {
  const id = genChatId();
  try {
    fs.writeFileSync(
      chatFile(id),
      JSON.stringify({ id, title: 'Nova conversa', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [], events: [], archive: [], summary: '', worklog: [] })
    );
  } catch (e) {
    /* ok */
  }
  return id;
}
// sessão VIVA de um chat (cria e carrega do disco na 1ª vez) — é o que permite turnos PARALELOS
function getSession(chatId) {
  if (!chatId || chatId === fgSession.id) return fgSession;
  let sess = sessions.get(chatId);
  if (!sess) {
    sess = makeSession(chatId);
    sessionALS.run(sess, () => loadChatInto(chatId)); // carrega o histórico DENTRO do contexto da sessão
    sessions.set(chatId, sess);
    // teto de sessões vivas: descarta a ociosa mais antiga (o estado dela já foi salvo ao fim do turno)
    if (sessions.size > 6) {
      for (const [id2, s2] of sessions) {
        if (!s2.running && id2 !== chatId) {
          sessions.delete(id2);
          break;
        }
      }
    }
  }
  return sess;
}
// salva o atual e abre um chat novo (Nova conversa)
function startNewChat() {
  saveCurrentChat();
  newChat('');
  broadcast('chat:reload');
}
function switchChat(id) {
  if (!id || id === currentChatId) return;
  saveCurrentChat(); // snapshot do fg atual (mesmo rodando: save intermediário é inofensivo)
  // PARALELISMO: a fg atual vira sessão viva de fundo (se estiver no meio de um turno, ele CONTINUA);
  // se o destino já tem sessão viva (rodando em paralelo), a gente a ADOTA como novo primeiro plano.
  if (fgSession.id) sessions.set(fgSession.id, fgSession);
  const live = sessions.get(id);
  if (live) {
    sessions.delete(id);
    fgSession = live;
    setCurrentChatId(fgSession.id);
    broadcast('chat:reload');
    return;
  }
  const fresh = makeSession(id);
  const prev = fgSession;
  fgSession = fresh; // S() fora de turno passa a apontar pro novo fg
  if (loadChatInto(id)) {
    setCurrentChatId(id);
    broadcast('chat:reload');
  } else {
    fgSession = prev; // falhou ao carregar: volta
    sessions.delete(prev.id);
  }
}
function renameChat(id, title) {
  try {
    const j = JSON.parse(fs.readFileSync(chatFile(id), 'utf8')) || {};
    j.title = String(title || '').slice(0, 60) || titleFromHistory(j.history || []);
    j.customTitle = true;
    fs.writeFileSync(chatFile(id), JSON.stringify(j));
  } catch (e) {
    /* ok */
  }
}
function deleteChat(id) {
  try {
    fs.unlinkSync(chatFile(id));
  } catch (e) {
    /* ok */
  }
  // se havia sessão viva desse chat (talvez rodando em paralelo), aborta e descarta
  const live = sessions.get(id);
  if (live) {
    try {
      if (live.abort) live.abort.abort();
    } catch (e) {
      /* ok */
    }
    sessions.delete(id);
  }
  if (id === currentChatId) {
    const rest = listChats();
    if (rest.length) {
      loadChatInto(rest[0].id);
      setCurrentChatId(rest[0].id);
    } else {
      newChat('');
    }
    broadcast('chat:reload');
  }
}
// inicialização: retoma o chat atual, ou migra o formato antigo, ou cria um novo
function initChats() {
  if (loadConfig().memoryEnabled === false) {
    S().history = [];
    S().convSummary = '';
    S().worklog = [];
    S().lastTurnContext = null;
    S().pendingTurnTranscript = null;
    currentChatId = '';
    S().claudeSessionId = '';
    S().claudeSessionWorkspace = '';
    return;
  }
  const cfg = loadConfig();
  if (cfg.currentChatId && fs.existsSync(chatFile(cfg.currentChatId))) {
    loadChatInto(cfg.currentChatId);
    return;
  }
  const list = listChats();
  if (list.length) {
    loadChatInto(list[0].id);
    setCurrentChatId(list[0].id);
    return;
  }
  // migração do formato antigo (S().history.json + summary.txt)
  const old = loadHistory();
  if (old.length) {
    S().history = old;
    S().convSummary = loadSummary();
    setCurrentChatId(genChatId());
    saveCurrentChat();
    return;
  }
  newChat('');
}

// Resume TODA a conversa atual (incorpora o resumo anterior) -> novo resumo
async function summarizeAll(cfg) {
  const text = S().history
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[conteúdo multimídia]'}`)
    .join('\n')
    .slice(0, 16000);
  if (!text.trim()) return S().convSummary;
  const summary = await llmComplete(cfg, [
    {
      role: 'system',
      content:
        'Você compacta conversas preservando: objetivo atual, decisões (e o porquê), requisitos, fatos, preferências e pendências. PRESERVE LITERALMENTE nomes exatos — caminhos de arquivo, funções, comandos, URLs, IDs (são o fio da continuidade; resumo genérico os destrói). Não copie saídas brutas de ferramentas; priorize conclusões técnicas e o estado do trabalho (feito × em andamento × pendente). Conciso, completo, em português.',
    },
    {
      role: 'user',
      content:
        `Resumo anterior:\n${S().convSummary || '(nenhum)'}\n\n` +
        `Incorpore TODA esta conversa ao resumo, para continuarmos em um NOVO chat sem perder o contexto:\n${text}`,
    },
  ]);
  return summary && summary.trim() ? summary.trim() : S().convSummary;
}

// Forka: salva o chat atual e abre um chat NOVO levando o resumo (contexto leve)
async function forkConversation() {
  const cfg = loadConfig();
  let seed = S().convSummary;
  try {
    seed = (await summarizeAll(cfg)) || S().convSummary || '';
  } catch (e) {
    /* se o resumo falhar, segue com o resumo atual */
  }
  const technicalSeed = S().worklog.slice(-12);
  saveCurrentChat(); // o chat original continua salvo (na sua própria conversa)
  newChat(seed, technicalSeed); // novo chat, leve, com resumo + diário técnico recente
  broadcast('chat:reload');
  broadcast('chat:forked', { hasSummary: !!S().convSummary, archived: true });
  return { ok: true, hasSummary: !!S().convSummary };
}

// Última captura de tela (para mapear coordenadas da imagem -> tela real, no modo controle)
let lastShot = null; // { imgW, imgH, sw, sh }

// Captura a tela como data URL. Captura na resolução real, mas limita a largura
// a 1600px (tokens) e guarda a escala para o modo controle clicar no lugar certo.
async function captureScreen() {
  const disp = screen.getPrimaryDisplay();
  const sw = disp.size.width;
  const sh = disp.size.height;
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: sw, height: sh } });
  if (!sources.length) return null;
  let img = sources[0].thumbnail;
  let sz = img.getSize();
  if (sz.width > 1600) {
    img = img.resize({ width: 1600 });
    sz = img.getSize();
  }
  lastShot = { imgW: sz.width, imgH: sz.height, sw, sh };
  return 'data:image/jpeg;base64,' + img.toJPEG(70).toString('base64');
}

// Converte coordenadas do ESPAÇO DA IMAGEM (o que o modelo vê) para a tela real.
function imgToScreen(x, y) {
  if (!lastShot || !lastShot.imgW) return { x: Math.round(x), y: Math.round(y) };
  return {
    x: Math.round((Number(x) || 0) * (lastShot.sw / lastShot.imgW)),
    y: Math.round((Number(y) || 0) * (lastShot.sh / lastShot.imgH)),
  };
}

// nut.js (controle de mouse/teclado) — carrega sob demanda
let _nut = null;
function getNut() {
  if (_nut === null) {
    try {
      _nut = require('@nut-tree-fork/nut-js');
      _nut.mouse.config.mouseSpeed = 3000;
      _nut.keyboard.config.autoDelayMs = 20;
    } catch (e) {
      _nut = false;
    }
  }
  return _nut || null;
}
// mensagem de erro certa por SO quando o controle do PC não está disponível
function nutUnavailableMsg() {
  return IS_LINUX
    ? 'controle do PC indisponível: no Linux requer sessão X11 + libxtst (sudo apt install libxtst6). Wayland não é suportado.'
    : 'controle do PC indisponível (nut.js não carregou)';
}
// mapeia nomes de teclas -> Key do nut.js
function nutKey(name) {
  const n = getNut();
  if (!n) return null;
  const K = n.Key;
  const m = {
    ctrl: K.LeftControl, control: K.LeftControl, alt: K.LeftAlt, shift: K.LeftShift,
    win: K.LeftSuper, cmd: K.LeftSuper, meta: K.LeftSuper, super: K.LeftSuper,
    enter: K.Enter, return: K.Enter, tab: K.Tab, esc: K.Escape, escape: K.Escape,
    space: K.Space, backspace: K.Backspace, back: K.Backspace, delete: K.Delete, del: K.Delete,
    up: K.Up, down: K.Down, left: K.Left, right: K.Right,
    home: K.Home, end: K.End, pageup: K.PageUp, pagedown: K.PageDown, insert: K.Insert,
    f1: K.F1, f2: K.F2, f3: K.F3, f4: K.F4, f5: K.F5, f6: K.F6, f7: K.F7, f8: K.F8, f9: K.F9, f10: K.F10, f11: K.F11, f12: K.F12,
  };
  const key = String(name || '').trim().toLowerCase();
  if (m[key] !== undefined) return m[key];
  if (key.length === 1) {
    if (/[a-z]/.test(key)) return K[key.toUpperCase()];
    if (/[0-9]/.test(key)) return K['Num' + key];
  }
  return undefined;
}

// ============================================================
//  Janela
// ============================================================
// lista todos os .vrm da pasta assets/
function listVrms() {
  try {
    return fs.readdirSync(path.join(resBase(), 'assets')).filter((n) => n.toLowerCase().endsWith('.vrm'));
  } catch (e) {
    return [];
  }
}
function findVrm() {
  const dir = path.join(resBase(), 'assets');
  const files = listVrms();
  if (!files.length) return null;
  const sel = loadConfig().selectedVrm;
  const pick = sel && files.includes(sel) ? sel : files[0];
  return url.pathToFileURL(path.join(dir, pick)).href;
}
// troca o personagem: salva a escolha e recarrega a janela do avatar (rápido, sem reabrir o app)
function selectVrm(file) {
  const c = loadConfig();
  c.selectedVrm = file;
  saveConfig(c);
  if (win && !win.isDestroyed()) win.reload();
}
// itens de menu (submenu "Personagem") com os .vrm disponíveis
function vrmMenuItems() {
  const files = listVrms();
  if (!files.length) return [{ label: '(coloque .vrm em assets/)', enabled: false }];
  const sel = loadConfig().selectedVrm;
  const cur = sel && files.includes(sel) ? sel : files[0];
  return files.map((f) => ({
    label: f.replace(/\.vrm$/i, ''),
    type: 'radio',
    checked: f === cur,
    click: () => selectVrm(f),
  }));
}

// Lista as animacoes .vrma da pasta animations/ (+ subpasta emotions/, marcadas)
function findVrmas() {
  const base = path.join(resBase(), 'animations');
  const out = [];
  const scan = (dir, emotion) => {
    try {
      fs.readdirSync(dir)
        .filter((n) => n.toLowerCase().endsWith('.vrma'))
        .forEach((n) => out.push({ name: n, url: url.pathToFileURL(path.join(dir, n)).href, emotion }));
    } catch (e) {
      /* pasta nao existe */
    }
  };
  scan(base, false);
  scan(path.join(base, 'emotions'), true);
  return out;
}

// tamanho base da janela do avatar (a escala multiplica isto)
const AVATAR_W = 360;
const AVATAR_H = 600;
let avatarScale = 1;

// Redimensiona a janela do avatar mantendo a base (pés/centro-inferior) no lugar.
function applyAvatarScale(scale, save = true) {
  avatarScale = Math.min(2, Math.max(0.6, Number(scale) || 1));
  if (!win || win.isDestroyed()) return avatarScale;
  const w = Math.round(AVATAR_W * avatarScale);
  const h = Math.round(AVATAR_H * avatarScale);
  const b = win.getBounds();
  const cx = b.x + b.width / 2; // mantem o centro horizontal
  const bottom = b.y + b.height; // e a base (os pés) ancorados
  win.setBounds({ x: Math.round(cx - w / 2), y: Math.round(bottom - h), width: w, height: h });
  if (save) {
    const c = loadConfig();
    c.avatarScale = avatarScale;
    saveConfig(c);
  }
  broadcast('avatar-scale', avatarScale); // atualiza o slider nas configs
  return avatarScale;
}

function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  avatarScale = Math.min(2, Math.max(0.6, loadConfig().avatarScale || 1));
  const w = Math.round(AVATAR_W * avatarScale);
  const h = Math.round(AVATAR_H * avatarScale);

  win = new BrowserWindow({
    width: w,
    height: h,
    icon: ICON_PATH,
    x: Math.max(0, width - w - 20),
    y: 60,
    transparent: true,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    hasShadow: false,
    skipTaskbar: true, // controlado pela bandeja, nao pela barra de tarefas
    // Linux/KWin: tipo "dock" escapa do clamp do WM (janelas normais são puxadas p/ dentro da
    // workArea ~500ms depois → "voa" 44px). Dock pode cobrir o painel, chegar na borda FÍSICA
    // (e abaixo dela) e fica sempre no topo — e o chat continua recebendo foco/teclado.
    ...(IS_LINUX ? { type: 'dock' } : {}),
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // DEV: permite carregar .vrm local
    },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  // o Windows REBAIXA o z-order em ciclos de foco e a taskbar passa na frente dela —
  // re-afirma o nível ao perder foco/reaparecer e num batimento defensivo
  const reassertTop = () => {
    try {
      // menu de contexto aberto? ele tem prioridade (senão o avatar cobre o menu)
      if (ctxWin && !ctxWin.isDestroyed() && ctxWin.isVisible()) return;
      if (win && !win.isDestroyed() && win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver');
    } catch (e) {
      /* ok */
    }
  };
  win.on('blur', reassertTop);
  win.on('show', reassertTop);
  win.on('focus', reassertTop);
  setInterval(reassertTop, 8000);
}

function toggleShow() {
  if (!win) return;
  win.isVisible() ? win.hide() : win.show();
}

// ============================================================
//  Arrasto via hook global (mantem a janela atravessavel = sem lag)
// ============================================================
function startDrag() {
  if (dragging || lockPassthrough || !win) return;
  dragging = true;
  applyIgnore(); // captura durante o arrasto (sem vazar clique pros apps atras)
  const c = screen.getCursorScreenPoint();
  const b = win.getBounds();
  dragStartCursor = { x: c.x, y: c.y };
  dragStartWin = { x: b.x, y: b.y };
  win.webContents.send('drag-start'); // renderer: levanta da sentada + reacao + gesto
}

function endDrag() {
  if (!dragging) return;
  dragging = false;
  // tenta sentar na base da tela (monitor sob a base da janela)
  const b = win.getBounds();
  const d = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height) });
  if (IS_LINUX) {
    // Linux: janela 100% on-screen (base = base FÍSICA); o renderer empurra o bumbum no canvas
    const screenBottom = d.bounds.y + d.bounds.height;
    if (footPixelY && b.y + footPixelY > screenBottom - 70) {
      win.setPosition(b.x, Math.round(screenBottom - b.height));
      win.webContents.send('sit-start');
    }
  } else {
    const taskbarTop = d.workArea.y + d.workArea.height;
    if (footPixelY && b.y + footPixelY > taskbarTop - 70) {
      win.setPosition(b.x, Math.round(taskbarTop - footPixelY));
      win.webContents.send('sit-start');
    }
  }
  applyIgnore(); // volta ao estado normal (atravessavel sobre o corpo)
}

function setupMouseHook() {
  if (!hookOk) return;
  try {
    uIOhook.on('mousedown', (e) => {
      if (lockPassthrough || !win || !win.isVisible()) return;
      if (e.button === 2) {
        // botao direito sobre o corpo -> menu de contexto
        if (cursorOverBody) showContextMenu();
      } else if (e.button === 1) {
        // botao esquerdo sobre o corpo -> comeca a arrastar
        if (cursorOverBody) startDrag();
      }
    });
    uIOhook.on('mouseup', (e) => {
      if (e.button === 1) endDrag();
    });
    uIOhook.start();
  } catch (e) {
    console.error('Falha ao iniciar o hook de mouse:', e.message);
  }
}

// ============================================================
//  Bandeja do sistema (system tray)
// ============================================================
// Desenha um icone simples (circulo azul) sem precisar de arquivo de imagem
function makeTrayIcon() {
  const size = 32;
  const buf = Buffer.alloc(size * size * 4);
  const cx = (size - 1) / 2;
  const r = size / 2 - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const inside = Math.hypot(x - cx, y - cx) <= r;
      // ordem RGBA
      buf[i] = 122;
      buf[i + 1] = 162;
      buf[i + 2] = 255;
      buf[i + 3] = inside ? 255 : 0;
    }
  }
  return nativeImage.createFromBitmap(buf, { width: size, height: size });
}

// Recorta a margem transparente de um ícone (deixa a figura preencher o quadro).
// Corta uma região QUADRADA na caixa do desenho -> sem distorção ao redimensionar.
function trimTransparent(img) {
  try {
    const { width: W, height: H } = img.getSize();
    if (!W || !H) return img;
    const buf = img.toBitmap(); // BGRA
    let minX = W, minY = H, maxX = -1, maxY = -1;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (buf[(y * W + x) * 4 + 3] > 16) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return img; // tudo transparente
    const boxW = maxX - minX + 1;
    const boxH = maxY - minY + 1;
    let side = Math.round(Math.max(boxW, boxH) * 1.06); // 6% de respiro
    side = Math.min(side, W, H);
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let sx = Math.round(cx - side / 2);
    let sy = Math.round(cy - side / 2);
    sx = Math.max(0, Math.min(sx, W - side));
    sy = Math.max(0, Math.min(sy, H - side));
    return img.crop({ x: sx, y: sy, width: side, height: side });
  } catch (e) {
    return img;
  }
}

function createTray() {
  let trayIcon;
  try {
    const img = nativeImage.createFromPath(ICON_PATH);
    trayIcon = img.isEmpty() ? makeTrayIcon() : trimTransparent(img).resize({ width: 32, height: 32 });
  } catch (e) {
    trayIcon = makeTrayIcon();
  }
  tray = new Tray(trayIcon);
  tray.setToolTip('Lumi');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Mostrar / Esconder', click: () => toggleShow() },
      { label: 'Abrir chat', click: () => openPage('chat', 'chat.html', 'Chat', 380, 560) },
      { label: 'Gerar imagem', click: () => openPage('imagegen', 'imagegen.html', 'Gerar imagem', 520, 640) },
    { label: 'Modo arquiteto', click: () => openPage('architect', 'architect.html', 'Modo arquiteto', 540, 620) },
    { label: 'Workspace (editor)', click: () => openPage('workspace', 'workspace.html', 'Workspace', 1320, 720) },
    { label: 'MCP (ferramentas)', click: () => openPage('mcp', 'mcp.html', 'MCP', 560, 620) },
      { label: 'Agentes (multi-agente)', click: () => openPage('agents', 'agents.html', 'Agentes', 620, 680) },
      { label: 'Galeria', click: () => openPage('gallery', 'gallery.html', 'Galeria', 540, 560) },
      { label: 'Memória da Lumi', click: () => openPage('memory', 'memory.html', 'Memória', 540, 640) },
      { label: 'Assistente de configuração', click: () => openPage('wizard', 'wizard.html', 'Bem-vindo', 640, 700) },
      { label: 'Animações (testar)', click: () => openPage('anims', 'animations.html', 'Animações', 360, 500) },
      { label: 'Personagem', submenu: vrmMenuItems() },
      { label: 'Configurações…', click: () => openSettingsWindow() },
      {
        label: 'Nova conversa',
        click: () => startNewChat(),
      },
      { label: 'Forkar conversa (novo chat + resumo)', click: () => forkConversation() },
      { type: 'separator' },
      { label: 'Backup dos dados', submenu: [{ label: 'Exportar…', click: () => exportData() }, { label: 'Importar…', click: () => importData() }] },
      { label: 'Relatar um problema', click: () => shell.openExternal(reportIssueUrl()) },
      { label: 'Verificar atualizações', click: () => checkUpdatesManual() },
      { label: 'Sair', click: () => app.quit() },
    ])
  );
  tray.on('click', () => toggleShow());
}

// ============================================================
//  Paginas (janelas separadas: abre/fecha sem afetar o avatar)
// ============================================================
const openPages = new Map();

// ---- efeito vidro nativo do Windows 11 (acrílico) ----
// Disponível a partir do build 22621 (Win11 22H2). Em SOs sem suporte, janelas seguem opacas.
function acrylicAvailable() {
  if (process.platform !== 'win32') return false;
  const build = parseInt(String(require('os').release()).split('.')[2] || '0', 10);
  return build >= 22621;
}
function acrylicOpts() {
  // janela transparente + material acrílico; o CSS (theme.js) deixa o --bg translúcido pra revelar o blur
  return acrylicAvailable() && loadConfig().acrylic !== false
    ? { backgroundColor: '#00000000', backgroundMaterial: 'acrylic' }
    : {};
}

// Menu de contexto copiar/colar em TODAS as janelas (e iframes, ex.: chat dentro do editor).
// Só aparece sobre campos editáveis / texto selecionado / links / imagens — assim não conflita
// com o menu do boneco (clique direito no corpo do avatar continua abrindo o menu da Lumi).
app.on('web-contents-created', (_e, contents) => {
  contents.on('context-menu', (_ev, params) => {
    const hasSel = !!(params.selectionText && params.selectionText.trim());
    const items = [];
    if (params.isEditable) {
      items.push(
        { label: 'Recortar', role: 'cut', enabled: params.editFlags.canCut },
        { label: 'Copiar', role: 'copy', enabled: params.editFlags.canCopy },
        { label: 'Colar', role: 'paste', enabled: params.editFlags.canPaste },
        { type: 'separator' },
        { label: 'Selecionar tudo', role: 'selectAll' }
      );
    } else if (hasSel) {
      items.push({ label: 'Copiar', role: 'copy' }, { label: 'Selecionar tudo', role: 'selectAll' });
    }
    if (params.linkURL) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: 'Copiar link', click: () => clipboard.writeText(params.linkURL) });
    }
    if (params.hasImageContents) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ label: 'Copiar imagem', click: () => contents.copyImageAt(params.x, params.y) });
    }
    if (!items.length) return; // clique direito "no vazio" segue com o comportamento de cada página
    Menu.buildFromTemplate(items).popup();
  });
});

// Janela DEDICADA de configurações: carrega o index.html em modo "?settings=1"
// (sem avatar 3D) — redimensionável, reusa 100% do formulário/lógica existentes.
// ---- memória de tamanho/posição das janelas: fecha e reabre EXATAMENTE como estava ----
function winBoundsGet(key) {
  const b = (loadConfig().winBounds || {})[key];
  if (!b || !b.width || !b.height) return null;
  try {
    // monitor pode ter sumido (notebook sem a tela externa): valida se a posição ainda é visível
    const { screen } = require('electron');
    const visible =
      b.x != null &&
      screen.getAllDisplays().some((d) => {
        const a = d.workArea;
        return b.x < a.x + a.width - 60 && b.x + b.width > a.x + 60 && b.y >= a.y - 20 && b.y < a.y + a.height - 60;
      });
    return visible ? b : { width: b.width, height: b.height, max: b.max }; // fora da tela: mantém só o tamanho
  } catch (e) {
    return { width: b.width, height: b.height, max: b.max };
  }
}
function winBoundsTrack(w2, key) {
  let t = null;
  const save = () => {
    try {
      if (w2.isDestroyed()) return;
      const max = w2.isMaximized();
      const nb = max ? w2.getNormalBounds() : w2.getBounds();
      const c = loadConfig();
      c.winBounds = c.winBounds || {};
      c.winBounds[key] = { x: nb.x, y: nb.y, width: nb.width, height: nb.height, max };
      saveConfig(c);
    } catch (e) {
      /* nunca derruba a janela por causa disso */
    }
  };
  const later = () => {
    clearTimeout(t);
    t = setTimeout(save, 600); // debounce: salva ao terminar de arrastar/redimensionar
  };
  w2.on('resize', later);
  w2.on('move', later);
  w2.on('close', save);
}
// aplica o tamanho salvo na criação (x/y só se ainda visíveis) e re-maximiza se era o caso
function winBoundsApply(saved, w2) {
  if (saved && saved.max) w2.maximize();
}

function openSettingsWindow() {
  if (openPages.has('settings')) {
    openPages.get('settings').focus();
    return;
  }
  const savedB = winBoundsGet('settings');
  const w = new BrowserWindow({
    width: (savedB && savedB.width) || 780,
    height: (savedB && savedB.height) || 700,
    ...(savedB && savedB.x != null ? { x: savedB.x, y: savedB.y } : {}),
    minWidth: 560,
    minHeight: 480,
    title: 'Configurações — Lumi',
    icon: ICON_PATH,
    autoHideMenuBar: true,
    backgroundColor: '#16161e',
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#16161e', symbolColor: '#9aa9b8', height: 34 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    ...acrylicOpts(),
  });
  w.setMenuBarVisibility(false);
  w.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'), { query: { settings: '1' } });
  w.on('closed', () => openPages.delete('settings'));
  winBoundsApply(savedB, w);
  winBoundsTrack(w, 'settings');
  openPages.set('settings', w);
}
ipcMain.on('settings:open-window', () => openSettingsWindow());

function openPage(id, file, title, w, h) {
  // se ja estiver aberta, so foca (evita duplicar)
  if (openPages.has(id)) {
    openPages.get(id).focus();
    return;
  }
  const savedB = winBoundsGet('page:' + id); // reabre no tamanho/posição de antes
  const pageWin = new BrowserWindow({
    width: (savedB && savedB.width) || w,
    height: (savedB && savedB.height) || h,
    ...(savedB && savedB.x != null ? { x: savedB.x, y: savedB.y } : {}),
    title,
    icon: ICON_PATH,
    resizable: true,
    minimizable: true,
    maximizable: true,
    backgroundColor: '#16161e',
    autoHideMenuBar: true,
    // titleBarOverlay é SÓ Windows/macOS — no Linux mantém a decoração nativa (senão fica sem botão de fechar)
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#16161e', symbolColor: '#9aa9b8', height: 34 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // o preload (window.api) também roda dentro de iframes (chat embutido no editor)
      webviewTag: true, // navegador embutido do workspace (<webview> não sofre X-Frame-Options)
    },
    ...acrylicOpts(), // vidro nativo do Win11 (sobrescreve o backgroundColor quando ativo)
  });
  pageWin.setMenuBarVisibility(false);
  pageWin.loadFile(path.join(__dirname, '..', 'renderer', 'pages', file));
  pageWin.on('closed', () => openPages.delete(id));
  winBoundsApply(savedB, pageWin);
  winBoundsTrack(pageWin, 'page:' + id);
  openPages.set(id, pageWin);
}

// Janela de chat DESTACADA (multi-instância, presa a uma conversa via ?session=<id>).
// Diferente de openPage: não é single-instance — dá pra abrir várias, cada uma numa conversa.
function openChatWindow(chatId, title) {
  const savedB = winBoundsGet('chat-window'); // memória compartilhada entre chats destacados
  const cw = new BrowserWindow({
    width: (savedB && savedB.width) || 400,
    height: (savedB && savedB.height) || 600,
    ...(savedB && savedB.x != null ? { x: savedB.x, y: savedB.y } : {}),
    title: title || 'Chat',
    icon: ICON_PATH,
    resizable: true,
    minimizable: true,
    maximizable: false,
    backgroundColor: '#16161e',
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#16161e', symbolColor: '#9aa9b8', height: 34 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      webviewTag: true,
    },
    ...acrylicOpts(),
  });
  cw.setMenuBarVisibility(false);
  cw.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'chat.html'), { query: chatId ? { session: chatId } : {} });
  winBoundsApply(savedB, cw);
  winBoundsTrack(cw, 'chat-window');
  return cw;
}

// Janela de WORKSPACE destacada (multi-instância), apontando pra uma PASTA própria.
// Editor + chat embutido dessa janela trabalham nessa pasta (via winWorkspace/wsCfg).
function openWorkspaceWindow(folder) {
  // cada janela de workspace ganha sua PRÓPRIA conversa (chat embutido) associada à pasta
  let session = '';
  if (folder) {
    session = genChatId();
    try {
      fs.writeFileSync(
        chatFile(session),
        JSON.stringify({ id: session, title: path.basename(folder), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), history: [], events: [], archive: [], summary: '', worklog: [], workspace: folder })
      );
    } catch (e) {
      /* ok */
    }
  }
  const savedB = winBoundsGet('workspace-window');
  const ww = new BrowserWindow({
    width: (savedB && savedB.width) || 1320,
    height: (savedB && savedB.height) || 720,
    ...(savedB && savedB.x != null ? { x: savedB.x, y: savedB.y } : {}),
    title: folder ? path.basename(folder) + ' — Workspace' : 'Workspace',
    icon: ICON_PATH,
    resizable: true,
    minimizable: true,
    maximizable: true,
    backgroundColor: '#16161e',
    autoHideMenuBar: true,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { color: '#16161e', symbolColor: '#9aa9b8', height: 34 } } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true,
      webviewTag: true,
    },
    ...acrylicOpts(),
  });
  ww.setMenuBarVisibility(false);
  ww.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'workspace.html'), { query: folder ? { ws: folder, session } : {} });
  winBoundsApply(savedB, ww);
  winBoundsTrack(ww, 'workspace-window');
  return ww;
}
// a janela do editor se prende a uma pasta ('' = pasta global). Auto-limpa ao fechar.
ipcMain.handle('ws:bind', (e, folder) => {
  const id = e.sender.id;
  if (folder) {
    winWorkspace.set(id, String(folder));
    watchFolder(String(folder), id); // auto-refresh da pasta DESTA janela (árvore/abas/git)
  } else winWorkspace.delete(id);
  e.sender.once('destroyed', () => {
    unwatchFolder(winWorkspace.get(id) || String(folder || ''), id);
    winWorkspace.delete(id);
  });
  return { workspace: winWorkspace.get(id) || rawWorkspace() || loadConfig().workspace || '' };
});
// abre uma OUTRA pasta numa nova janela de workspace (cada uma com seu editor + chat + IA)
ipcMain.handle('workspace:open-window', async () => {
  const r = await dialog.showOpenDialog({ title: 'Abrir pasta em nova janela', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return { canceled: true };
  openWorkspaceWindow(r.filePaths[0]);
  return { ok: true, folder: r.filePaths[0] };
});
// Painel de Problemas do editor: roda o linter/type-checker da pasta DA JANELA
ipcMain.handle('diag:check', async (e) => checkProject(wsCfg(e)));

// ============================================================
//  Menu de contexto (clique direito no boneco)
//  Renderizado numa janelinha própria com VIDRO (acrílico no Win11);
//  o menu nativo do Electron fica só de fallback (não aceita CSS).
// ============================================================
function ctxTemplate() {
  return [
    { label: 'Abrir chat', click: () => openPage('chat', 'chat.html', 'Chat', 380, 560) },
    { label: 'Gerar imagem', click: () => openPage('imagegen', 'imagegen.html', 'Gerar imagem', 520, 640) },
    { label: 'Modo arquiteto', click: () => openPage('architect', 'architect.html', 'Modo arquiteto', 540, 620) },
    { label: 'Workspace (editor)', click: () => openPage('workspace', 'workspace.html', 'Workspace', 1320, 720) },
    { label: 'MCP (ferramentas)', click: () => openPage('mcp', 'mcp.html', 'MCP', 560, 620) },
    { label: 'Agentes (multi-agente)', click: () => openPage('agents', 'agents.html', 'Agentes', 620, 680) },
    { label: 'Galeria', click: () => openPage('gallery', 'gallery.html', 'Galeria', 540, 560) },
    { label: 'Memória da Lumi', click: () => openPage('memory', 'memory.html', 'Memória', 540, 640) },
    { label: 'Assistente de configuração', click: () => openPage('wizard', 'wizard.html', 'Bem-vindo', 640, 700) },
    { label: 'Animações (testar)', click: () => openPage('anims', 'animations.html', 'Animações', 360, 500) },
    { label: 'Personagem', submenu: vrmMenuItems() },
    { label: 'Configurações…', click: () => openSettingsWindow() },
    {
      label: 'Nova conversa',
      click: () => startNewChat(),
    },
    { label: 'Forkar conversa (novo chat + resumo)', click: () => forkConversation() },
    { type: 'separator' },
    {
      label: 'Atravessar cliques (sempre)',
      type: 'checkbox',
      checked: lockPassthrough,
      click: (mi) => {
        lockPassthrough = mi.checked;
        applyIgnore();
      },
    },
    { label: 'Abrir pasta de dados (memória)', click: () => shell.openPath(app.getPath('userData')) },
    { label: 'Backup dos dados', submenu: [{ label: 'Exportar…', click: () => exportData() }, { label: 'Importar…', click: () => importData() }] },
    { label: 'Relatar um problema', click: () => shell.openExternal(reportIssueUrl()) },
    { label: 'Sobre', click: () => openPage('about', 'about.html', 'Sobre', 400, 480) },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ];
}

let ctxWin = null;
let ctxActions = new Map(); // id → click() do item (reconstruído a cada abertura)
let ctxAnchor = null; // posição do cursor no momento do clique direito

// template do Electron → modelo serializável pro renderer (cliques viram ids)
function serializeCtx(template) {
  ctxActions = new Map();
  let seq = 0;
  const walk = (items) =>
    (items || []).map((it) => {
      if (it.type === 'separator') return { type: 'sep' };
      const m = { id: 'c' + ++seq, label: it.label || '', type: it.type || 'item', checked: !!it.checked, enabled: it.enabled !== false };
      if (it.submenu) m.submenu = walk(it.submenu);
      else ctxActions.set(m.id, it.click || (() => {}));
      return m;
    });
  return walk(template);
}

function ensureCtxWin() {
  if (ctxWin && !ctxWin.isDestroyed()) return ctxWin;
  ctxWin = new BrowserWindow({
    width: 248,
    height: 200,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: true,
    // Win11: vidro acrílico DE VERDADE (desfoca o desktop atrás); senão, translúcido via CSS
    ...(acrylicAvailable() && loadConfig().acrylic !== false
      ? { backgroundColor: '#00000000', backgroundMaterial: 'acrylic', roundedCorners: true }
      : { transparent: true }),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  ctxWin.setAlwaysOnTop(true, 'screen-saver'); // acima até do avatar
  ctxWin.setMenuBarVisibility(false);
  ctxWin.loadFile(path.join(__dirname, '..', 'renderer', 'pages', 'ctxmenu.html'));
  ctxWin.on('blur', () => {
    try {
      ctxWin.hide(); // clicou fora → fecha (comportamento de menu)
    } catch (e) {}
  });
  ctxWin.on('hide', () => {
    try {
      if (win && !win.isDestroyed() && win.isVisible()) win.setAlwaysOnTop(true, 'screen-saver'); // avatar volta ao topo
    } catch (e) {}
  });
  return ctxWin;
}

function showContextMenu() {
  try {
    // posição do cursor AGORA (no Linux/XWayland o getCursorScreenPoint pode estar morto → fonte do uiohook)
    ctxAnchor = IS_LINUX && typeof linuxCursor !== 'undefined' && linuxCursor ? { x: linuxCursor.x, y: linuxCursor.y } : screen.getCursorScreenPoint();
    const w = ensureCtxWin();
    const model = serializeCtx(ctxTemplate());
    const send = () => w.webContents.send('ctx:model', model);
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', send);
    else send();
  } catch (e) {
    // qualquer problema → menu nativo de sempre
    Menu.buildFromTemplate(ctxTemplate()).popup({ window: win });
  }
}

// o renderer mediu o conteúdo → posiciona colado no cursor (sem sair da tela) e mostra
ipcMain.on('ctx:size', (_e, { w, h }) => {
  if (!ctxWin || ctxWin.isDestroyed()) return;
  const pt = ctxAnchor || screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(pt).workArea;
  const W = Math.max(180, Math.min(Math.round(w || 248), 320));
  const H = Math.max(40, Math.min(Math.round(h || 200), wa.height - 16));
  const x = Math.min(Math.max(pt.x, wa.x), wa.x + wa.width - W - 4);
  const y = Math.min(Math.max(pt.y, wa.y), wa.y + wa.height - H - 4);
  ctxWin.setBounds({ x, y, width: W, height: H });
  if (!ctxWin.isVisible()) ctxWin.show();
  // entre janelas topmost do Windows, quem subiu por ÚLTIMO fica na frente —
  // o blur do avatar dispara o reassert dele, então o menu se re-eleva já e de novo num tiquinho
  ctxWin.moveTop();
  setTimeout(() => {
    try {
      if (ctxWin && !ctxWin.isDestroyed() && ctxWin.isVisible()) ctxWin.moveTop();
    } catch (e) {}
  }, 80);
});
ipcMain.on('ctx:click', (_e, { id, checked }) => {
  const fn = ctxActions.get(id);
  if (ctxWin && !ctxWin.isDestroyed()) ctxWin.hide();
  if (fn)
    setTimeout(() => {
      try {
        fn({ checked: !!checked }); // checkbox manda o estado novo (igual o menu nativo)
      } catch (e) {
        console.error('ctx item:', (e && e.message) || e);
      }
    }, 0);
});
ipcMain.on('ctx:close', () => {
  if (ctxWin && !ctxWin.isDestroyed()) ctxWin.hide();
});

// "Relatar um problema": abre uma issue do GitHub pré-preenchida com versão/SO
function reportIssueUrl() {
  const body =
    '**Descreva o problema**\n\n(o que aconteceu? o que você esperava?)\n\n**Passos pra reproduzir**\n\n1. \n\n---\n' +
    'Lumi v' + app.getVersion() + ' · ' + process.platform + ' ' + require('os').release() + ' · Electron ' + process.versions.electron;
  return 'https://github.com/thomasnrs/Lumi_Agent/issues/new?title=' + encodeURIComponent('[bug] ') + '&body=' + encodeURIComponent(body);
}

// ---- backup: exportar/importar TUDO (config, memória, conversas, lembretes...) ----
const BACKUP_FILES = ['config.json', 'facts.json', 'presets.json', 'reminders.json', 'usage.json', 'summary.txt', 'history.json'];
async function exportData() {
  const r = await dialog.showSaveDialog({
    title: 'Exportar dados da Lumi',
    defaultPath: 'lumi-backup-' + new Date().toISOString().slice(0, 10) + '.json',
    filters: [{ name: 'Backup da Lumi', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return;
  try {
    const ud = app.getPath('userData');
    const out = { __lumi: 1, at: new Date().toISOString(), files: {}, chats: {} };
    for (const f of BACKUP_FILES) {
      try {
        out.files[f] = fs.readFileSync(path.join(ud, f), 'utf8');
      } catch (e) {
        /* arquivo ainda não existe — ok */
      }
    }
    try {
      for (const f of fs.readdirSync(path.join(ud, 'chats'))) {
        if (f.endsWith('.json')) out.chats[f] = fs.readFileSync(path.join(ud, 'chats', f), 'utf8');
      }
    } catch (e) {
      /* sem conversas ainda */
    }
    fs.writeFileSync(r.filePath, JSON.stringify(out));
    dialog.showMessageBox({ title: 'Lumi', message: 'Backup exportado! ✓', detail: Object.keys(out.files).length + ' arquivos + ' + Object.keys(out.chats).length + ' conversas em:\n' + r.filePath });
  } catch (e) {
    dialog.showMessageBox({ title: 'Lumi', message: 'Falhou ao exportar: ' + String((e && e.message) || e) });
  }
}
async function importData() {
  const r = await dialog.showOpenDialog({
    title: 'Importar backup da Lumi',
    filters: [{ name: 'Backup da Lumi', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return;
  try {
    const data = JSON.parse(fs.readFileSync(r.filePaths[0], 'utf8'));
    if (!data || data.__lumi !== 1) throw new Error('este arquivo não parece um backup da Lumi');
    const n = Object.keys(data.files || {}).length;
    const nc = Object.keys(data.chats || {}).length;
    const ok = await dialog.showMessageBox({
      title: 'Lumi',
      type: 'warning',
      buttons: ['Importar e reiniciar', 'Cancelar'],
      cancelId: 1,
      message: 'Importar o backup de ' + String(data.at || '?').slice(0, 10) + '?',
      detail: n + ' arquivos + ' + nc + ' conversas vão SUBSTITUIR os dados atuais. A Lumi reinicia em seguida.',
    });
    if (ok.response !== 0) return;
    const ud = app.getPath('userData');
    for (const [f, content] of Object.entries(data.files || {})) {
      if (BACKUP_FILES.includes(f) && typeof content === 'string') fs.writeFileSync(path.join(ud, f), content);
    }
    fs.mkdirSync(path.join(ud, 'chats'), { recursive: true });
    for (const [f, content] of Object.entries(data.chats || {})) {
      if (/^[\w.-]+\.json$/.test(f) && typeof content === 'string') fs.writeFileSync(path.join(ud, 'chats', f), content);
    }
    cfgCache = null; // o config importado vale a partir do reinício
    app.relaunch();
    app.exit(0);
  } catch (e) {
    dialog.showMessageBox({ title: 'Lumi', message: 'Falhou ao importar: ' + String((e && e.message) || e) });
  }
}

// ============================================================
//  AUTO-UPDATE (GitHub Releases via electron-updater)
//  Baixa em segundo plano e instala quando o app fecha — zero fricção.
// ============================================================
// checagem manual (bandeja → Verificar atualizações) com resposta visível
async function checkUpdatesManual() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ title: 'Lumi', message: 'Rodando do código-fonte (npm start) — atualize com git pull. 😉' });
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    const r = await autoUpdater.checkForUpdates();
    const v = r && r.updateInfo && r.updateInfo.version;
    if (v && v !== app.getVersion()) {
      dialog.showMessageBox({ title: 'Lumi', message: 'Atualização ' + v + ' encontrada! Baixando em segundo plano — instala quando o app fechar.' });
    } else {
      dialog.showMessageBox({ title: 'Lumi', message: 'Você já está na versão mais nova (' + app.getVersion() + ') ✨' });
    }
  } catch (e) {
    dialog.showMessageBox({ title: 'Lumi', message: 'Não consegui checar agora: ' + String((e && e.message) || e).slice(0, 200) });
  }
}

function setupAutoUpdate() {
  if (!app.isPackaged) return; // em dev (npm start) não há o que atualizar
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.on('update-downloaded', (info) => {
      broadcast('chat:note', { text: '⬇️ Atualização ' + info.version + ' baixada — instala sozinha quando o app fechar.' });
      proactiveSay('Baixei minha atualização (' + info.version + ')! Quando você me abrir de novo, estarei novinha ✨', 'happy');
    });
    autoUpdater.on('error', (e) => console.error('updater:', (e && e.message) || e));
    autoUpdater.checkForUpdates().catch(() => {});
    setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 3600 * 1000); // re-checa a cada 4h
  } catch (e) {
    console.error('auto-update indisponível:', (e && e.message) || e);
  }
}

app.whenReady().then(() => {
  // SEGURANÇA: workspace remoto (SSHFS) é POR SESSÃO — se o app fechou/caiu montado,
  // o config apontaria pra um drive fantasma (Z:\) e tudo que toca o workspace
  // travaria/crasharia em loop a cada boot (caso real). Restaura o anterior.
  try {
    const c0 = loadConfig();
    if (c0.remoteWs) {
      saveConfig({ ...c0, workspace: c0.remoteWs.prev || '', remoteWs: undefined });
      logd('boot: workspace remoto da sessão anterior descartado → ' + (c0.remoteWs.prev || '(vazio)'));
      // sessão anterior teve mount remoto → mata sshfs órfãos de um possível crash (SEGURO no
      // boot: nenhum mount nosso ativo ainda, então não atropela cleanup em andamento)
      if (process.platform === 'win32') {
        execAsync('taskkill /IM sshfs-win.exe /F', { windowsHide: true }).catch(() => {});
        execAsync('taskkill /IM sshfs.exe /F', { windowsHide: true }).catch(() => {});
      }
    } else if (c0.workspace && !fs.existsSync(c0.workspace)) {
      saveConfig({ ...c0, workspace: '' });
      logd('boot: workspace inexistente limpo: ' + c0.workspace);
    }
  } catch (e) {
    logd('boot ws-check', String((e && e.message) || e));
  }
  initChats(); // multi-chat: retoma o chat atual (ou migra/cria)
  loadReminders(); // lembretes persistidos (os vencidos disparam no 1º ciclo)
  startWorkspaceWatcher(); // auto-refresh do editor quando arquivos mudam

  // saudação ao abrir (proatividade ≥ discreta) — com a persona dela
  setTimeout(async () => {
    if (proactivityLevel() < 1 || S().running) return;
    const h = new Date().getHours();
    const momento = h < 6 ? 'madrugada' : h < 12 ? 'manhã' : h < 18 ? 'tarde' : 'noite';
    proactiveSay(
      await proactiveLLM('O app acabou de abrir e é ' + momento + '. Cumprimente o usuário com UMA frase bem curtinha e calorosa.', h < 12 ? 'Bom dia! 💚' : h < 18 ? 'Boa tarde! 💚' : 'Boa noite! 💚')
    );
  }, 12000);
  connectMcpServers().catch((e) => console.error('MCP:', e)); // conecta ferramentas externas
  detectEnvCaps().catch(() => {}); // Docker/WSL no prompt (1x por boot, não bloqueia nada)

  // libera o uso do microfone (STT)
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(true));

  if (IS_LINUX) {
    // bug antigo do Electron/X11: janela transparente criada cedo demais fica com fundo preto
    setTimeout(() => {
      createWindow();
      applyIgnore();
    }, 350);
  } else {
    createWindow();
    applyIgnore(); // estado inicial do click-through
  }
  createTray();
  setupAutoUpdate(); // app instalado: busca atualizações nos GitHub Releases

  // PRIMEIRO USO: assistente de boas-vindas (provedor → avatar → voz)
  if (!loadConfig().wizardDone) {
    setTimeout(() => {
      openPage('wizard', 'wizard.html', 'Bem-vindo', 640, 700);
      const w = openPages.get('wizard');
      if (w)
        w.once('closed', () => {
          // fechou de qualquer jeito → não insiste no próximo boot (reabrível pelo menu)
          const c = loadConfig();
          if (!c.wizardDone) {
            c.wizardDone = true;
            saveConfig(c);
          }
        });
    }, 800);
  }

  // setupMouseHook(); // DESLIGADO: voltamos a capturar sobre o corpo (clique nao vaza).
  // O lag antigo era o raycast (resolvido com a capsula), nao a captura da janela.

  // Polling do cursor: manda a posicao (relativa a janela) para o avatar.
  // Tambem move a janela durante o arrasto. So envia quando o cursor muda.
  let lastCx = null;
  let lastCy = null;
  let cursorPollMoves = 0; // diagnóstico (Linux): o polling global do cursor está vivo?
  startLinuxCursorHook(); // Linux: liga a fonte global de cursor (no-op nas outras plataformas)
  cursorTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    // Linux: usa o hook se ele entregou movimento nos últimos 2s; senão tenta o polling normal
    const p = linuxHookCursor && Date.now() - linuxCursorAt < 2000 ? linuxCursor : screen.getCursorScreenPoint();
    if (dragging) {
      win.setPosition(
        Math.round(dragStartWin.x + (p.x - dragStartCursor.x)),
        Math.round(dragStartWin.y + (p.y - dragStartCursor.y))
      );
    }
    const b = win.getBounds();
    const rx = p.x - b.x;
    const ry = p.y - b.y;
    if (rx !== lastCx || ry !== lastCy) {
      lastCx = rx;
      lastCy = ry;
      cursorPollMoves++;
      lastUserActivity = Date.now(); // proatividade: usuário está ativo
      win.webContents.send('cursor', { x: rx, y: ry });
    }
  }, 33);

  // LINUX: relatório de saúde do input no terminal (ajuda a diagnosticar X11/Wayland)
  if (IS_LINUX) {
    setTimeout(() => {
      const sess = process.env.XDG_SESSION_TYPE || '?';
      const hookAlive = linuxHookCursor && Date.now() - linuxCursorAt < 9000;
      const fonte = hookAlive ? 'uiohook (global) ✅' : cursorPollMoves > 2 ? 'getCursorScreenPoint' : 'NENHUMA ⚠';
      console.log('──────────────────────────────────────────────');
      console.log('[lumi/linux] sessão: ' + sess + '  ·  fonte do cursor: ' + fonte + '  ·  ' + cursorPollMoves + ' mov. entregues');
      if (!hookAlive && cursorPollMoves <= 2) {
        console.log('[lumi/linux] nenhuma fonte global de cursor → click-through inteligente desativado;');
        console.log('             a janela fica sempre clicável (Ctrl+Shift+C pra atravessar).');
      }
      console.log('──────────────────────────────────────────────');
    }, 8000);
  }

  globalShortcut.register('CommandOrControl+Shift+C', () => {
    lockPassthrough = !lockPassthrough;
    applyIgnore();
  });
  globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
});

// ---- IPC: janela / avatar ----
ipcMain.on('show-context-menu', () => showContextMenu());

// click-through inteligente: o renderer avisa quando o mouse esta sobre o corpo dela ou a UI
ipcMain.on('hover-interactive', (_e, interactive) => {
  hoverIgnore = !interactive;
  applyIgnore();
});

// hook global: renderer informa se o cursor esta sobre o corpo + posicao dos pes
// diagnostico de memoria: junta metricas de processo (Electron) + dados do renderer
ipcMain.on('mem:data', (_e, d) => {
  try {
    const procs = app
      .getAppMetrics()
      .map((m) => `  ${m.type.padEnd(10)} ${Math.round((m.memory.workingSetSize || 0) / 1024)} MB`)
      .join('\n');
    const totalMB = app
      .getAppMetrics()
      .reduce((s, m) => s + (m.memory.workingSetSize || 0) / 1024, 0);
    const lines = [
      '=== RELATORIO DE MEMORIA ===',
      `Total (todos os processos): ${Math.round(totalMB)} MB`,
      '',
      'Por processo (Electron/Chromium):',
      procs,
      '',
      'Renderer (Three.js / VRM):',
      `  Heap JS: ${d.jsHeapMB} MB`,
      `  Geometrias: ${d.geometries}  |  Texturas: ${d.textures}`,
      `  Memoria estimada de texturas: ${d.texMB} MB`,
      '',
      'Texturas (nome WxH):',
      ...d.texList.map((t) => '  ' + t),
    ];
    fs.writeFileSync(path.join(__dirname, '..', '..', 'memory-report.txt'), lines.join('\n'));
    console.log('Relatorio de memoria salvo em memory-report.txt');
  } catch (e) {
    console.error('Erro no relatorio de memoria:', e);
  }
});

// redimensionar a avatar: valor absoluto (slider das configs) ou por passos (scroll)
ipcMain.on('avatar-scale-set', (_e, scale) => applyAvatarScale(scale));
ipcMain.on('avatar-scale-by', (_e, dir) => applyAvatarScale(avatarScale + (dir > 0 ? 0.08 : -0.08)));

// tema customizado: salva e avisa TODAS as janelas para aplicarem ao vivo
ipcMain.on('theme-set', (_e, theme) => {
  const c = loadConfig();
  c.theme = theme || {};
  saveConfig(c);
  broadcast('theme-changed', c.theme);
});

// opacidade (transparencia) da janela que pediu — controle em cada pagina
ipcMain.on('page-set-opacity', (e, value) => {
  const v = Math.min(1, Math.max(0.2, Number(value) || 1));
  const w = BrowserWindow.fromWebContents(e.sender);
  if (w && !w.isDestroyed()) w.setOpacity(v);
});

ipcMain.handle('get-hook-status', () => hookOk);
ipcMain.on('over-body', (_e, v) => {
  cursorOverBody = v;
});
ipcMain.on('foot-pixel', (_e, y) => {
  footPixelY = y;
});

// testador de animacoes: repassa do janela-testador para o avatar
ipcMain.on('anim:preview', (_e, name) => broadcast('anim:preview', name));
ipcMain.on('anim:stop', () => broadcast('anim:stop'));

ipcMain.handle('get-vrm-path', () => findVrm());
ipcMain.handle('get-vrma-paths', () => findVrmas());

// galeria de imagens geradas
ipcMain.handle('gallery:list', () => {
  const d = galleryDir();
  try {
    return fs
      .readdirSync(d)
      .filter((n) => /\.(png|jpg|jpeg|webp|gif)$/i.test(n))
      .map((n) => ({ name: n, url: url.pathToFileURL(path.join(d, n)).href, mtime: fs.statSync(path.join(d, n)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
  } catch (e) {
    return [];
  }
});
ipcMain.on('gallery:open', () => shell.openPath(galleryDir()));

// geração de imagem direta (pela página de estúdio)
ipcMain.handle('image:generate', (_e, prompt) => generateImageNow(prompt));

// MCP: (re)conectar servidores e devolver o status
ipcMain.handle('mcp:connect', async () => {
  const status = await connectMcpServers();
  return { status, toolCount: mcpTools.length };
});
ipcMain.handle('mcp:status', () => ({ status: mcpStatus, toolCount: mcpTools.length }));

// modo arquiteto: escolher pasta + ler/salvar a memoria do projeto
ipcMain.handle('pick-folder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
// arvore de arquivos do workspace (para o editor)
// PESADAS: aparecem na árvore (você sabe que existem) mas NÃO são auto-expandidas —
// o conteúdo só carrega quando você clica nelas (lazy). Melhor dos 2 mundos: visível + leve.
const WS_HEAVY = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache',
  '.venv', 'venv', 'env', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox',
  '.nuxt', '.svelte-kit', '.angular', '.gradle', '.idea', '.vscode-test', 'vendor', 'target', '.terraform',
]);
const WS_IGNORE = new Set([]); // nada totalmente oculto — só os internos .lumi-* (tratados à parte)
async function walkWorkspace(dir, base, out, depth, deadline) {
  if (!deadline) deadline = Date.now() + 5000; // FS remoto não pode segurar o main
  if (depth > 8 || out.length > 3000 || Date.now() > deadline) return;
  let entries = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true }); // assíncrono, sem stat por arquivo
  } catch (e) {
    return;
  }
  for (const ent of entries) {
    if (out.length > 3000 || Date.now() > deadline) return;
    if (WS_IGNORE.has(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      // Heavy folders stay visible in the lazy tree, but are excluded from
      // flat scans used by mentions, project overview and AI code search.
      if (WS_HEAVY.has(ent.name)) continue;
      await walkWorkspace(full, base, out, depth + 1, deadline);
    } else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
}
// garante que o caminho relativo nao escapa do workspace
function safeWsPath(cfg, rel) {
  const fp = path.resolve(cfg.workspace, rel || '');
  return fp.startsWith(path.resolve(cfg.workspace)) ? fp : null;
}
ipcMain.handle('workspace:tree', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return [];
  const out = [];
  await walkWorkspace(cfg.workspace, cfg.workspace, out, 0);
  return out.sort();
});
ipcMain.handle('workspace:read', (e, rel) => {
  const cfg = wsCfg(e);
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp) return null;
  try {
    return readTextFileSmart(fp).text;
  } catch (e) {
    return null;
  }
});
// lê um arquivo de imagem do workspace como data URL (para o preview no editor)
ipcMain.handle('workspace:read-image', (e, rel) => {
  const cfg = wsCfg(e);
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp) return null;
  try {
    const buf = fs.readFileSync(fp);
    const ext = path.extname(fp).slice(1).toLowerCase();
    const mime =
      ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : ext === 'ico' ? 'image/x-icon' : 'image/' + ext;
    return { url: 'data:' + mime + ';base64,' + buf.toString('base64'), bytes: buf.length };
  } catch (e) {
    return null;
  }
});
ipcMain.handle('workspace:write', (e, { rel, content }) => {
  const cfg = wsCfg(e);
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp) return false;
  let oldC = '';
  try {
    oldC = readTextFileSmart(fp).text;
  } catch (e) {
    /* novo */
  }
  try {
    fs.writeFileSync(fp, content == null ? '' : String(content));
    broadcastDiff(rel, oldC, String(content || ''));
    return true;
  } catch (e) {
    return false;
  }
});

// lista UM nível (pastas + arquivos ordenados) — sem descer; usado pelo BFS e pelo lazy
async function lsLevel(absDir, base) {
  let entries = [];
  try {
    entries = await fs.promises.readdir(absDir, { withFileTypes: true }); // async, sem stat por arquivo
  } catch (e) {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const ent of entries) {
    const name = ent.name;
    // esconde internos .lumi-* MAS mostra a memória do projeto (o usuário quer vê-la/editá-la)
    if (WS_IGNORE.has(name) || (name.startsWith('.lumi-') && name !== '.lumi-memory.md')) continue;
    const rel = path.relative(base, path.join(absDir, name)).replace(/\\/g, '/');
    if (ent.isDirectory()) dirs.push({ name, path: rel, dir: true, children: [], loaded: false, heavy: WS_HEAVY.has(name) });
    else files.push({ name, path: rel, dir: false });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return dirs.concat(files);
}

// árvore COMPLETA aninhada — varredura em LARGURA (BFS): cada nível INTEIRO é listado
// antes de aprofundar, então uma pasta pesada (.venv etc) nunca "come" o orçamento e
// deixa as irmãs de fora (bug real: docs/scripts/src/tests sumiam). Orçamento total
// protege contra FS remoto gigante (árvore parcial, mas sempre com o topo completo).
async function buildWsTree(rootAbs) {
  const budget = { until: Date.now() + 8000, left: 4000 };
  const root = await lsLevel(rootAbs, rootAbs);
  let queue = root.filter((n) => n.dir && !n.heavy); // nível 1 (pesadas ficam lazy ao clicar)
  let depth = 1;
  while (queue.length && depth < 12 && Date.now() < budget.until && budget.left > 0) {
    const next = [];
    for (const node of queue) {
      if (Date.now() > budget.until || budget.left <= 0) break;
      node.children = await lsLevel(path.join(rootAbs, node.path), rootAbs);
      node.loaded = true; // expandida nesta varredura (pastas não-carregadas: lazy ao clicar)
      budget.left -= node.children.length;
      for (const c of node.children) if (c.dir && !c.heavy) next.push(c); // pesadas ficam lazy
    }
    queue = next;
    depth++;
  }
  return root;
}
ipcMain.handle('workspace:fulltree', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return null;
  return await buildWsTree(cfg.workspace);
});
// lazy: filhos de UMA pasta sob demanda (a UI pode pedir ao expandir uma não-carregada)
ipcMain.handle('workspace:children', async (e, rel) => {
  const cfg = wsCfg(e);
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp) return [];
  return await lsLevel(fp, cfg.workspace);
});

// busca global no projeto (Ctrl+Shift+F do editor): texto simples, case-insensitive
ipcMain.handle('workspace:search', async (e, query) => {
  const cfg = wsCfg(e);
  const q = String(query || '').toLowerCase();
  if (!cfg.workspace || q.length < 2) return { results: [], truncated: false };
  // ripgrep primeiro (rápido, respeita .gitignore); cai pro walk async se rg indisponível
  const rg = await rgSearchEditor(cfg.workspace, query);
  if (rg) return rg;
  const results = [];
  let files = 0;
  let truncated = false;
  const MAXR = 400;
  const deadline = Date.now() + 8000; // FS remoto: melhor busca parcial que main travado
  const walk = async (dir, depth) => {
    if (results.length >= MAXR || depth > 12 || files > 4000 || Date.now() > deadline) return;
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true }); // assíncrono, sem stat por arquivo
    } catch (e) {
      return;
    }
    for (const ent of entries) {
      if (results.length >= MAXR || Date.now() > deadline) return;
      const name = ent.name;
      if (WS_HEAVY.has(name) || WS_IGNORE.has(name) || (name.startsWith('.lumi-') && name !== '.lumi-memory.md')) continue;
      const full = path.join(dir, name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
        continue;
      }
      let st;
      try {
        st = await fs.promises.stat(full);
      } catch (e) {
        continue;
      }
      if (st.size > 1000000) continue; // pula arquivos gigantes/binários óbvios
      files++;
      let content;
      try {
        content = (await readTextFileSmartAsync(full)).text;
      } catch (e) {
        continue;
      }
      if (content.indexOf('\0') >= 0) continue; // binário (tem byte nulo)
      const rel = path.relative(cfg.workspace, full).replace(/\\/g, '/');
      const lines = content.split('\n');
      let inFile = 0;
      for (let i = 0; i < lines.length && inFile < 20; i++) {
        const col = lines[i].toLowerCase().indexOf(q);
        if (col >= 0) {
          inFile++;
          results.push({ path: rel, line: i + 1, col: col + 1, text: lines[i].trim().slice(0, 200) });
          if (results.length >= MAXR) {
            truncated = true;
            break;
          }
        }
      }
    }
  };
  await walk(cfg.workspace, 0);
  return { results, truncated };
});

// branch + nº de alterações (statusbar do editor)
ipcMain.handle('workspace:gitinfo', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return {};
  try {
    const { stdout: br } = await execAsync('git rev-parse --abbrev-ref HEAD', { cwd: cfg.workspace, timeout: 4000, windowsHide: true });
    const { stdout: st } = await execAsync('git status --porcelain', { cwd: cfg.workspace, timeout: 5000, windowsHide: true });
    return { branch: br.trim(), changes: st.split('\n').filter((l) => l.trim()).length };
  } catch (e) {
    return {}; // sem git/não é repo
  }
});

// git status do workspace (cores no explorer): M=modificado, A=novo, D=apagado, ??=não rastreado
ipcMain.handle('workspace:gitstatus', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return {};
  try {
    const { stdout } = await execAsync('git status --porcelain -uall', { cwd: cfg.workspace, timeout: 5000, windowsHide: true });
    const map = {};
    stdout.split('\n').forEach((l) => {
      if (l.length < 4) return;
      const xy = l.slice(0, 2);
      let p = l.slice(3).trim().replace(/^"|"$/g, '').replace(/\\/g, '/');
      if (xy[0] === 'R') p = (p.split(' -> ')[1] || p).trim(); // renomeado: usa o nome novo
      const code = xy.includes('?') ? 'U' : xy.includes('D') ? 'D' : xy.includes('A') ? 'A' : 'M';
      map[p] = code;
      // marca as pastas-mãe como modificadas (bolinha na árvore fechada)
      const parts = p.split('/');
      for (let i = 1; i < parts.length; i++) {
        const dir = parts.slice(0, i).join('/');
        if (!map[dir]) map[dir] = 'dir';
      }
    });
    return map;
  } catch (e) {
    return {}; // sem git / não é repo → explorer fica normal
  }
});
// ============================================================
//  CONTROLE DE FONTES (painel git do workspace, estilo VS Code)
// ============================================================
function gitRun(cfg, args, opts) {
  return execFileAsync('git', args, {
    cwd: cfg.workspace,
    timeout: 20000,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    ...(opts || {}),
  });
}

// status detalhado: staged e unstaged SEPARADOS (porcelain v1 -z aguenta espaço/rename no nome)
ipcMain.handle('git:panel-status', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return { error: 'nenhum workspace definido' };
  try {
    const { stdout: br } = await gitRun(cfg, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const { stdout } = await gitRun(cfg, ['status', '--porcelain=v1', '-z', '-uall']);
    const staged = [];
    const unstaged = [];
    const parts = stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
      const e = parts[i];
      if (e.length < 4) continue;
      const x = e[0];
      const y = e[1];
      const p = e.slice(3).replace(/\\/g, '/');
      if (x === 'R' || x === 'C') i++; // no -z, o caminho ANTIGO vem na entrada seguinte — pula
      if (x === '?') {
        unstaged.push({ path: p, st: 'U' }); // não rastreado
        continue;
      }
      if (x !== ' ') staged.push({ path: p, st: x });
      if (y !== ' ') unstaged.push({ path: p, st: y });
    }
    let ahead = 0;
    let behind = 0;
    try {
      const { stdout: ab } = await gitRun(cfg, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
      const m = ab.trim().split(/\s+/);
      ahead = parseInt(m[0], 10) || 0;
      behind = parseInt(m[1], 10) || 0;
    } catch (e) {
      /* sem upstream configurado — normal */
    }
    return { branch: br.trim(), staged, unstaged, ahead, behind };
  } catch (e) {
    return { error: 'não é um repositório git' };
  }
});

// conteúdo do arquivo no HEAD (lado "original" do diff); '' se o arquivo é novo
ipcMain.handle('git:head-file', async (e, rel) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !rel) return '';
  try {
    const { stdout } = await gitRun(cfg, ['show', 'HEAD:' + String(rel).replace(/\\/g, '/')]);
    return stdout;
  } catch (e) {
    return ''; // arquivo novo ou fora do HEAD
  }
});

ipcMain.handle('git:stage', async (e, paths) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !Array.isArray(paths) || !paths.length) return { error: 'nada para preparar' };
  try {
    await gitRun(cfg, ['add', '--', ...paths]);
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e) };
  }
});

ipcMain.handle('git:unstage', async (e, paths) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !Array.isArray(paths) || !paths.length) return { error: 'nada para despreparar' };
  try {
    await gitRun(cfg, ['reset', '-q', 'HEAD', '--', ...paths]);
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e) };
  }
});

// descarta alterações: rastreado → volta pro HEAD; não rastreado → apaga o arquivo
// (a CONFIRMAÇÃO é na UI — aqui só executa)
ipcMain.handle('git:discard', async (e, paths) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !Array.isArray(paths) || !paths.length) return { error: 'nada para descartar' };
  const errors = [];
  for (const rel of paths) {
    try {
      await gitRun(cfg, ['ls-files', '--error-unmatch', '--', rel]); // rastreado?
      await gitRun(cfg, ['checkout', '-q', 'HEAD', '--', rel]);
    } catch (e) {
      // não rastreado: descartar = apagar (mesmo comportamento do VS Code)
      try {
        const fp = safeWsPath(cfg, rel);
        if (fp && fs.existsSync(fp)) fs.rmSync(fp, { force: true });
      } catch (e2) {
        errors.push(rel + ': ' + String((e2 && e2.message) || e2));
      }
    }
  }
  return errors.length ? { error: errors.join('; ') } : { ok: true };
});

ipcMain.handle('git:commit', async (e, { message, stageAll }) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return { error: 'nenhum workspace definido' };
  if (!message || !message.trim()) return { error: 'mensagem vazia' };
  try {
    if (stageAll) await gitRun(cfg, ['add', '-A']);
    const { stdout } = await gitRun(cfg, ['commit', '-m', message.trim()]);
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.stdout) || (e && e.message) || e).trim() };
  }
});

// ✦ a Lumi escreve a mensagem olhando o diff (staged se houver; senão, tudo)
ipcMain.handle('git:ai-message', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return { error: 'nenhum workspace definido' };
  try {
    const { stdout: stagedNames } = await gitRun(cfg, ['diff', '--cached', '--name-only']);
    const useStaged = !!stagedNames.trim();
    const { stdout: diff } = await gitRun(cfg, useStaged ? ['diff', '--cached'] : ['diff']);
    const { stdout: untracked } = await gitRun(cfg, ['ls-files', '--others', '--exclude-standard']);
    let ctx = diff;
    if (!useStaged && untracked.trim()) {
      ctx += '\n\n# Arquivos novos (não rastreados):\n' + untracked.trim();
    }
    ctx = ctx.slice(0, 14000); // teto: diff gigante não precisa ir inteiro
    if (!ctx.trim()) return { error: 'nenhuma alteração para descrever' };
    const msg = await llmComplete(cfg, [
      {
        role: 'system',
        content:
          'Você escreve mensagens de commit do git em português. Responda SOMENTE com a mensagem, sem markdown, sem cercas de código, sem aspas ao redor. Formato: primeira linha imperativa e específica com no máximo 72 caracteres; se a mudança for grande, linha em branco e um corpo curto com itens iniciados por "- ".',
      },
      { role: 'user', content: 'Escreva a mensagem de commit para este diff:\n\n' + ctx },
    ]);
    const clean = String(msg || '')
      .replace(/^```[a-z]*\n?|```$/g, '')
      .replace(/^["'`]+|["'`]+$/g, '')
      .trim();
    if (!clean) return { error: 'a I.A. não retornou mensagem' };
    return { message: clean };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

// ✦ a Lumi REVISA o diff antes do commit (bugs reais, riscos, casos não tratados)
ipcMain.handle('git:ai-review', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return { error: 'nenhum workspace definido' };
  try {
    const { stdout: stagedNames } = await gitRun(cfg, ['diff', '--cached', '--name-only']);
    const useStaged = !!stagedNames.trim();
    const { stdout: diff } = await gitRun(cfg, useStaged ? ['diff', '--cached'] : ['diff']);
    const ctx = diff.slice(0, 16000);
    if (!ctx.trim()) return { error: 'nenhuma alteração para revisar' };
    const review = await llmComplete(cfg, [
      {
        role: 'system',
        content:
          'Você é uma revisora de código direta e útil. Analise o diff e aponte SÓ o que importa: bugs reais, riscos, casos não tratados e melhorias rápidas — em português, em itens curtos começando por "- " (no máximo 8). Se estiver tudo bem, diga em UMA linha que pode commitar. Sem elogios vazios, sem reescrever o código inteiro.',
      },
      { role: 'user', content: 'Revise estas alterações' + (useStaged ? ' (staged)' : '') + ':\n\n' + ctx },
    ]);
    if (!review || !review.trim()) return { error: 'a I.A. não retornou a revisão' };
    return { review: review.trim(), staged: useStaged, truncated: diff.length > 16000 };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

// histórico de commits (lista) + detalhe de um commit (stat + patch)
ipcMain.handle('git:log', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return [];
  try {
    const { stdout } = await gitRun(cfg, ['log', '--format=%h%x09%s%x09%cr%x09%an', '-n', '30']);
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [hash, subject, when, author] = l.split('\t');
        return { hash, subject, when, author };
      });
  } catch (e) {
    return [];
  }
});
ipcMain.handle('git:show-commit', async (e, hash) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !/^[0-9a-f]{4,40}$/i.test(String(hash || ''))) return { error: 'commit inválido' };
  try {
    const { stdout } = await gitRun(cfg, ['show', hash, '--stat', '--patch', '--no-color', '--format=%h %s%n%an · %ad%n']);
    return { text: stdout.slice(0, 120000), truncated: stdout.length > 120000 };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e) };
  }
});

// linhas alteradas de UM arquivo vs HEAD (barrinhas de gutter no editor)
ipcMain.handle('git:line-status', async (e, rel) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !rel) return null;
  try {
    const { stdout } = await gitRun(cfg, ['diff', 'HEAD', '--unified=0', '--no-color', '--', rel]);
    const added = [];
    const modified = [];
    const deleted = [];
    const re = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
    let m;
    while ((m = re.exec(stdout))) {
      const oldN = m[1] == null ? 1 : parseInt(m[1], 10);
      const newStart = parseInt(m[2], 10);
      const newN = m[3] == null ? 1 : parseInt(m[3], 10);
      if (oldN === 0 && newN > 0) added.push([newStart, newStart + newN - 1]);
      else if (newN === 0) deleted.push(Math.max(1, newStart)); // removido logo após esta linha
      else modified.push([newStart, newStart + newN - 1]);
    }
    return { added, modified, deleted };
  } catch (e) {
    return null; // sem git / arquivo fora do HEAD → sem barrinhas
  }
});

ipcMain.handle('git:branches', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return [];
  try {
    const { stdout } = await gitRun(cfg, ['branch', '--format=%(refname:short)']);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
});

ipcMain.handle('git:checkout', async (e, { name, create }) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !name) return { error: 'branch inválida' };
  try {
    await gitRun(cfg, create ? ['checkout', '-b', name] : ['checkout', name]);
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e).trim() };
  }
});

ipcMain.handle('git:push', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return { error: 'nenhum workspace' };
  try {
    const { stdout } = await gitRun(cfg, ['push']);
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    const msg = String((e && e.stderr) || (e && e.message) || e);
    if (/set-upstream|no upstream/i.test(msg)) {
      // primeira vez desta branch: publica com upstream
      try {
        const { stdout: br } = await gitRun(cfg, ['rev-parse', '--abbrev-ref', 'HEAD']);
        await gitRun(cfg, ['push', '-u', 'origin', br.trim()]);
        return { ok: true, out: 'branch publicada no origin' };
      } catch (e2) {
        return { error: String((e2 && e2.stderr) || (e2 && e2.message) || e2).trim() };
      }
    }
    return { error: msg.trim() };
  }
});

ipcMain.handle('git:pull', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return { error: 'nenhum workspace' };
  try {
    const { stdout } = await gitRun(cfg, ['pull', '--ff-only']);
    return { ok: true, out: stdout.trim() };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e).trim() };
  }
});

// ---- stash: guardar/listar/aplicar/descartar alterações ----
ipcMain.handle('git:stash-list', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return [];
  try {
    const { stdout } = await gitRun(cfg, ['stash', 'list', '--format=%gd\t%s']);
    return stdout.split('\n').filter(Boolean).map((l) => {
      const [ref, ...rest] = l.split('\t');
      return { ref, desc: rest.join('\t') };
    });
  } catch (e) {
    return [];
  }
});
ipcMain.handle('git:stash', async (e, { action, ref }) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return { error: 'nenhum workspace' };
  try {
    if (action === 'push') await gitRun(cfg, ['stash', 'push', '-u']); // -u inclui não rastreados
    else if (action === 'pop') await gitRun(cfg, ['stash', 'pop', ...(ref ? [ref] : [])]);
    else if (action === 'apply') await gitRun(cfg, ['stash', 'apply', ...(ref ? [ref] : [])]);
    else if (action === 'drop') await gitRun(cfg, ['stash', 'drop', ...(ref ? [ref] : [])]);
    else return { error: 'ação inválida' };
    broadcast('workspace:changed');
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e).trim().slice(0, 200) };
  }
});

// ---- conflitos de merge: listar e resolver (ficar com o nosso / o deles) ----
ipcMain.handle('git:conflicts', async (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return [];
  try {
    const { stdout } = await gitRun(cfg, ['diff', '--name-only', '--diff-filter=U']);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    return [];
  }
});
ipcMain.handle('git:resolve', async (e, { file, side }) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !file) return { error: 'inválido' };
  // ours = a versão da branch atual; theirs = a que está vindo (merge/rebase)
  const opt = side === 'theirs' ? '--theirs' : '--ours';
  try {
    await gitRun(cfg, ['checkout', opt, '--', file]);
    await gitRun(cfg, ['add', '--', file]);
    broadcast('workspace:changed');
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e).trim().slice(0, 200) };
  }
});

// ---- blame: autor/data/commit por linha de um arquivo ----
ipcMain.handle('git:blame', async (e, rel) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !rel) return null;
  try {
    const { stdout } = await gitRun(cfg, ['blame', '--line-porcelain', '--', rel]);
    const lines = [];
    let cur = {};
    for (const l of stdout.split('\n')) {
      if (/^[0-9a-f]{40} /.test(l)) cur = { hash: l.slice(0, 8) };
      else if (l.startsWith('author ')) cur.author = l.slice(7);
      else if (l.startsWith('author-time ')) cur.ts = parseInt(l.slice(12), 10) * 1000;
      else if (l.startsWith('summary ')) cur.summary = l.slice(8);
      else if (l.startsWith('\t')) lines.push({ ...cur }); // linha de conteúdo → fecha o registro
    }
    return lines;
  } catch (e) {
    return null;
  }
});

// links clicados no terminal integrado (xterm web-links)
ipcMain.on('open-external-url', (_e, u) => {
  if (typeof u === 'string' && /^https?:\/\//i.test(u)) shell.openExternal(u);
});

// ============================================================
//  .env do workspace: listar / ler (mascarado) / salvar
// ============================================================
function envFiles() {
  const cfg = loadConfig();
  if (!cfg.workspace) return [];
  const out = [];
  try {
    for (const f of fs.readdirSync(cfg.workspace)) {
      if (f === '.env' || f.startsWith('.env.')) out.push(f);
    }
  } catch (e) {
    /* ok */
  }
  return out.sort();
}
function parseEnv(text) {
  const vars = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    vars.push({ key: m[1], value: val });
  }
  return vars;
}
ipcMain.handle('env:list', () => envFiles());
ipcMain.handle('env:read', (_e, file) => {
  const cfg = loadConfig();
  if (!cfg.workspace || !/^\.env(\.[\w.-]+)?$/.test(String(file || ''))) return { error: 'arquivo inválido' };
  try {
    const vars = parseEnv(fs.readFileSync(path.join(cfg.workspace, file), 'utf8'));
    return { vars };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
ipcMain.handle('env:save', (_e, { file, vars }) => {
  const cfg = loadConfig();
  if (!cfg.workspace || !/^\.env(\.[\w.-]+)?$/.test(String(file || ''))) return { error: 'arquivo inválido' };
  try {
    const fp = path.join(cfg.workspace, file);
    // preserva comentários/linhas e ordem; atualiza só os valores das chaves conhecidas
    let lines = [];
    try {
      lines = fs.readFileSync(fp, 'utf8').split(/\r?\n/);
    } catch (e) {
      /* arquivo novo */
    }
    const want = new Map((vars || []).map((v) => [v.key, v.value]));
    const seen = new Set();
    const quote = (v) => (/[\s#"'$]/.test(v) ? '"' + v.replace(/"/g, '\\"') + '"' : v);
    const outLines = lines.map((raw) => {
      const m = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)(\s*=\s*).*$/.exec(raw);
      if (m && want.has(m[2])) {
        seen.add(m[2]);
        return m[1] + m[2] + '=' + quote(want.get(m[2]));
      }
      return raw;
    });
    for (const [k, v] of want) if (!seen.has(k)) outLines.push(k + '=' + quote(v)); // chaves novas no fim
    fs.writeFileSync(fp, outLines.join('\n'));
    broadcast('workspace:changed');
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

// ============================================================
//  BANCO DE DADOS (Postgres / MySQL) — painel de query do workspace
//  drivers pg/mysql2 são JS puro (sem rebuild). 1 conexão ativa por vez.
// ============================================================
let dbConn = null; // { kind:'pg'|'mysql', client/pool, label }
function maskDbUrl(u) {
  return String(u || '').replace(/(:\/\/[^:/@]+:)[^@]*(@)/, '$1•••$2');
}
// acha uma URL de banco no .env do workspace (DATABASE_URL e variações comuns)
function detectDbUrls() {
  const found = [];
  for (const f of envFiles()) {
    try {
      const vars = parseEnv(fs.readFileSync(path.join(loadConfig().workspace, f), 'utf8'));
      for (const v of vars) {
        if (/(DATABASE|DB|POSTGRES|MYSQL|REDIS|MONGO|PG)_?(URL|URI|CONNECTION_STRING)?$/i.test(v.key) && /^(postgres|postgresql|mysql|redis|rediss|mongodb(\+srv)?):\/\//i.test(v.value)) {
          found.push({ from: f, key: v.key, url: v.value });
        }
      }
    } catch (e) {
      /* ok */
    }
  }
  return found;
}
ipcMain.handle('db:detect', () => detectDbUrls().map((d) => ({ from: d.from, key: d.key, url: d.url, masked: maskDbUrl(d.url) })));
async function dbClose() {
  if (!dbConn) return;
  try {
    if (dbConn.kind === 'redis') dbConn.client.disconnect();
    else if (dbConn.kind === 'mongo') await dbConn.client.close();
    else await dbConn.client.end();
  } catch (e) {
    /* ok */
  }
  dbConn = null;
}
ipcMain.handle('db:connect', async (_e, url) => {
  const u = String(url || '').trim();
  if (!/^(postgres|postgresql|mysql|redis|rediss|mongodb(\+srv)?):\/\//i.test(u))
    return { error: 'URL inválida (postgres:// mysql:// redis:// mongodb://)' };
  await dbClose();
  try {
    if (/^mysql:/i.test(u)) {
      const mysql = require('mysql2/promise');
      dbConn = { kind: 'mysql', client: await mysql.createConnection(u), label: maskDbUrl(u) };
    } else if (/^rediss?:/i.test(u)) {
      const Redis = require('ioredis');
      const client = new Redis(u, { connectTimeout: 8000, maxRetriesPerRequest: 1, lazyConnect: true });
      await client.connect();
      dbConn = { kind: 'redis', client, label: maskDbUrl(u) };
    } else if (/^mongodb/i.test(u)) {
      const { MongoClient } = require('mongodb');
      const client = new MongoClient(u, { serverSelectionTimeoutMS: 8000 });
      await client.connect();
      dbConn = { kind: 'mongo', client, db: client.db(), label: maskDbUrl(u) };
    } else {
      const { Client } = require('pg');
      const client = new Client({ connectionString: u, connectionTimeoutMillis: 8000 });
      await client.connect();
      dbConn = { kind: 'pg', client, label: maskDbUrl(u) };
    }
    logd('db:connect', dbConn.kind, dbConn.label);
    return { ok: true, kind: dbConn.kind, label: dbConn.label };
  } catch (e) {
    dbConn = null;
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
});
ipcMain.handle('db:disconnect', async () => {
  await dbClose();
  return { ok: true };
});
// divide um comando respeitando aspas (pro Redis: GET "minha chave")
function splitArgs(s) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] != null ? m[1] : m[2] != null ? m[2] : m[3]);
  return out;
}
async function dbRun(input) {
  if (!dbConn) throw new Error('sem conexão');
  if (dbConn.kind === 'redis') {
    const args = splitArgs(String(input).trim());
    if (!args.length) return { columns: [], rows: [] };
    const res = await dbConn.client.call(...args);
    if (Array.isArray(res)) return { columns: ['valor'], rows: res.map((v) => ({ valor: v })), rowCount: res.length };
    if (res && typeof res === 'object') return { columns: ['campo', 'valor'], rows: Object.entries(res).map(([k, v]) => ({ campo: k, valor: v })) };
    return { columns: ['resultado'], rows: [{ resultado: res == null ? '(nil)' : String(res) }] };
  }
  if (dbConn.kind === 'mongo') {
    // sintaxe simples: "colecao" | "colecao {filtroJSON}" | "colecao {filtro} {limite}"
    const t = String(input).trim();
    const sp = t.indexOf(' ');
    const coll = (sp < 0 ? t : t.slice(0, sp)).trim();
    if (!coll) return { columns: [], rows: [] };
    let filter = {};
    const rest = sp < 0 ? '' : t.slice(sp + 1).trim();
    const jm = rest.match(/^\{[\s\S]*\}/);
    if (jm) {
      try {
        filter = JSON.parse(jm[0]);
      } catch (e) {
        throw new Error('filtro JSON inválido');
      }
    }
    const docs = await dbConn.db.collection(coll).find(filter).limit(200).toArray();
    const cols = [];
    for (const d of docs) for (const k of Object.keys(d)) if (!cols.includes(k)) cols.push(k);
    return { columns: cols.slice(0, 30), rows: docs.map((d) => { const o = {}; for (const c of cols) o[c] = d[c]; return o; }), rowCount: docs.length };
  }
  if (dbConn.kind === 'pg') {
    const r = await dbConn.client.query(input);
    const res = Array.isArray(r) ? r[r.length - 1] : r;
    return { columns: (res.fields || []).map((f) => f.name), rows: res.rows || [], rowCount: res.rowCount };
  }
  const [rows, fields] = await dbConn.client.query(input);
  if (Array.isArray(rows)) return { columns: (fields || []).map((f) => f.name), rows, rowCount: rows.length };
  return { columns: [], rows: [], rowCount: rows.affectedRows, info: rows };
}
async function dbTables() {
  if (!dbConn) return [];
  try {
    if (dbConn.kind === 'redis') {
      const keys = await dbConn.client.call('keys', '*'); // cap defensivo na UI; em prod use SCAN
      return (keys || []).slice(0, 500).sort();
    }
    if (dbConn.kind === 'mongo') {
      const cols = await dbConn.db.listCollections().toArray();
      return cols.map((c) => c.name).sort();
    }
    const sql =
      dbConn.kind === 'pg'
        ? "select table_name as t from information_schema.tables where table_schema not in ('pg_catalog','information_schema') order by table_name"
        : 'select table_name as t from information_schema.tables where table_schema = database() order by table_name';
    const r = await dbRun(sql);
    return r.rows.map((x) => x.t || x.T).filter(Boolean);
  } catch (e) {
    return [];
  }
}
ipcMain.handle('db:tables', () => dbTables());
ipcMain.handle('db:query', async (_e, sql) => {
  try {
    const r = await dbRun(String(sql || ''));
    // cap defensivo de linhas devolvidas pra UI (a query em si decide o resto)
    if (r.rows.length > 1000) {
      r.rows = r.rows.slice(0, 1000);
      r.truncated = true;
    }
    return r;
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 300) };
  }
});
// schema/contexto resumido pra dar à I.A. (varia por tipo de banco)
async function dbSchema() {
  if (!dbConn) return '';
  try {
    if (dbConn.kind === 'redis') return '(Redis — use comandos: GET, SET, KEYS pattern, HGETALL, LRANGE, TYPE, TTL, SCAN...)';
    if (dbConn.kind === 'mongo') {
      const cols = (await dbConn.db.listCollections().toArray()).map((c) => c.name).slice(0, 40);
      const out = [];
      for (const c of cols.slice(0, 15)) {
        const doc = await dbConn.db.collection(c).findOne({});
        out.push(c + '(' + (doc ? Object.keys(doc).slice(0, 25).join(', ') : '?') + ')');
      }
      return 'Coleções MongoDB:\n' + out.join('\n');
    }
    const sql =
      dbConn.kind === 'pg'
        ? "select table_name as t, column_name as c, data_type as d from information_schema.columns where table_schema not in ('pg_catalog','information_schema') order by table_name, ordinal_position"
        : 'select table_name as t, column_name as c, data_type as d from information_schema.columns where table_schema = database() order by table_name, ordinal_position';
    const r = await dbRun(sql);
    const byTable = {};
    for (const row of r.rows) {
      const t = row.t || row.T;
      (byTable[t] = byTable[t] || []).push((row.c || row.C) + ' ' + (row.d || row.D));
    }
    return Object.entries(byTable).slice(0, 60).map(([t, cols]) => t + '(' + cols.slice(0, 40).join(', ') + ')').join('\n');
  } catch (e) {
    return '';
  }
}
// ✦ pergunta em português → a Lumi escreve a consulta (não roda; a UI mostra pra você rodar)
ipcMain.handle('db:ai-sql', async (_e, question) => {
  if (!dbConn) return { error: 'conecte a um banco primeiro' };
  const schema = await dbSchema();
  const sys = {
    pg: 'Você gera UMA query SQL PostgreSQL. Responda SOMENTE o SQL puro, sem markdown, sem ponto-e-vírgula final.',
    mysql: 'Você gera UMA query SQL MySQL. Responda SOMENTE o SQL puro, sem markdown, sem ponto-e-vírgula final.',
    redis: 'Você gera UM comando Redis (ex.: GET chave, KEYS user:*, HGETALL h). Responda SOMENTE o comando, sem markdown.',
    mongo: 'Você gera uma consulta no formato "colecao {filtroJSON}" (ex.: users {"age":{"$gt":18}}). Responda SOMENTE isso, sem markdown.',
  }[dbConn.kind];
  try {
    const out = await llmComplete(loadConfig(), [
      { role: 'system', content: sys + '\n\nContexto:\n' + (schema || '(indisponível)') },
      { role: 'user', content: String(question || '') },
    ]);
    const sql = String(out || '').replace(/^```[a-z]*\n?|```$/g, '').replace(/;\s*$/, '').trim();
    return sql ? { sql } : { error: 'a I.A. não retornou nada' };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 200) };
  }
});

// ============================================================
//  LIVE SERVER — preview ao vivo do workspace (estilo VS Code Live Server)
//  Serve os arquivos estáticos + injeta um script nas páginas HTML com:
//  recarga automática (SSE) e o modo "apontar elemento" (🎯 → chat da Lumi)
// ============================================================
// LIVE SERVER POR WORKSPACE: cada janela/pasta tem a SUA instância (porta própria)
const liveServers = new Map(); // root -> { srv, port, sse: [], reloadTimer }
const LIVE_MIME = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', js: 'text/javascript', mjs: 'text/javascript',
  css: 'text/css', json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  svg: 'image/svg+xml', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon', woff: 'font/woff', woff2: 'font/woff2',
  ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm',
  wasm: 'application/wasm', xml: 'application/xml', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', map: 'application/json',
};

// script injetado antes do </body>: live-reload + picker de elemento (roda DENTRO da página servida)
const LIVE_CLIENT_JS =
  '(function(){\n' +
  "try { new EventSource('/__lumi/events').onmessage = function(e){ if (e.data==='reload') location.reload(); }; } catch(e){}\n" +
  'var on=false, box=null;\n' +
  "function overlay(){ if(box) return box; box=document.createElement('div'); box.style.cssText='position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #7aa2ff;background:rgba(122,162,255,.18);border-radius:3px;'; document.body.appendChild(box); return box; }\n" +
  'function sel(el){ var parts=[]; var n=el; while(n && n.nodeType===1 && parts.length<5){ var s=n.tagName.toLowerCase(); ' +
  "if(n.id){ parts.unshift(s+'#'+n.id); break; } " +
  "var cl=(typeof n.className==='string')?n.className.trim().split(/\\s+/).filter(Boolean).slice(0,2).join('.'):''; if(cl) s+='.'+cl; " +
  'var p=n.parentElement; if(p){ var sib=[].filter.call(p.children,function(c){return c.tagName===n.tagName;}); ' +
  "if(sib.length>1) s+=':nth-of-type('+(sib.indexOf(n)+1)+')'; } parts.unshift(s); n=p; } return parts.join(' > '); }\n" +
  'function move(e){ var el=document.elementFromPoint(e.clientX,e.clientY); if(!el||el===box) return; var r=el.getBoundingClientRect(); ' +
  "var b=overlay(); b.style.left=r.left+'px'; b.style.top=r.top+'px'; b.style.width=r.width+'px'; b.style.height=r.height+'px'; }\n" +
  'function click(e){ e.preventDefault(); e.stopPropagation(); var el=document.elementFromPoint(e.clientX,e.clientY); if(!el) return stop(); ' +
  "var html=(el.outerHTML||'').slice(0,1200); " +
  "parent.postMessage({__lumi:'picked', selector:sel(el), text:(el.innerText||'').trim().slice(0,200), html:html, page:location.pathname},'*'); stop(); }\n" +
  "function key(e){ if(e.key==='Escape') stop(); }\n" +
  "function start(){ if(on) return; on=true; document.addEventListener('mousemove',move,true); document.addEventListener('click',click,true); document.addEventListener('keydown',key,true); document.documentElement.style.cursor='crosshair'; }\n" +
  "function stop(){ on=false; document.removeEventListener('mousemove',move,true); document.removeEventListener('click',click,true); document.removeEventListener('keydown',key,true); document.documentElement.style.cursor=''; if(box){ box.remove(); box=null; } parent.postMessage({__lumi:'pick-off'},'*'); }\n" +
  "window.addEventListener('message', function(ev){ var d=ev.data||{}; if(d.__lumi==='pick') start(); else if(d.__lumi==='pick-cancel') stop(); });\n" +
  '})();';

function liveNotifyReload() {
  // avisa TODAS as instâncias (um save recarrega o preview de cada workspace aberto)
  for (const rec of liveServers.values()) {
    clearTimeout(rec.reloadTimer);
    rec.reloadTimer = setTimeout(() => {
      rec.sse = rec.sse.filter((r) => !r.writableEnded);
      rec.sse.forEach((r) => {
        try {
          r.write('data: reload\n\n');
        } catch (e) {
          /* conexão caiu */
        }
      });
    }, 120); // junta rajadas de saves num reload só
  }
}

// pasta sem index.html → página de listagem navegável (estilo live-server clássico)
function liveListing(res, dir, u) {
  const base = u.replace(/\/+$/, ''); // caminho da URL sem barra final
  let items = [];
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    /* sem permissão → lista vazia */
  }
  items.sort((a, b) => (b.isDirectory() - a.isDirectory()) || a.name.localeCompare(b.name));
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = items
    .map((it) => {
      const href = base + '/' + encodeURIComponent(it.name) + (it.isDirectory() ? '/' : '');
      const ico = it.isDirectory() ? '📁' : /\.html?$/i.test(it.name) ? '🌐' : '📄';
      return '<a href="' + href + '">' + ico + ' ' + esc(it.name) + (it.isDirectory() ? '/' : '') + '</a>';
    })
    .join('');
  const up = base ? '<a href="' + (base.slice(0, base.lastIndexOf('/')) || '/') + '">⬆ voltar</a>' : '';
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(
    '<!doctype html><meta charset="utf-8"><title>Lumi Live — ' + esc(base || '/') + '</title>' +
      '<body style="font-family:Segoe UI,sans-serif;background:#16161e;color:#eee;margin:0;padding:24px">' +
      '<h3 style="margin:0 0 4px">⚡ Lumi Live Server</h3>' +
      '<div style="color:#9aa;font-size:13px;margin-bottom:14px">' + esc(base || '/') + ' — esta pasta não tem <code>index.html</code>; escolha um arquivo:</div>' +
      '<div style="display:flex;flex-direction:column;gap:2px;max-width:560px">' + up + rows + '</div>' +
      '<style>a{color:#7aa2ff;text-decoration:none;padding:6px 10px;border-radius:7px;font-size:14px}a:hover{background:#24242f}</style>' +
      '<script src="/__lumi/client.js"></script></body>'
  );
}

function makeLiveHandler(root, rec) {
  return function liveHandler(req, res) {
  const cfg = { workspace: root }; // serve a pasta DESTA instância (não a global)
  const u = decodeURIComponent((req.url || '/').split('?')[0]);
  if (u === '/__lumi/client.js') {
    res.writeHead(200, { 'Content-Type': 'text/javascript' });
    return res.end(LIVE_CLIENT_JS);
  }
  if (u === '/__lumi/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 800\n\n');
    rec.sse.push(res);
    req.on('close', () => {
      rec.sse = rec.sse.filter((r) => r !== res);
    });
    return;
  }
  let fp = cfg.workspace && safeWsPath(cfg, u.replace(/^\/+/, ''));
  if (!fp) {
    res.writeHead(403);
    return res.end('fora do workspace');
  }
  try {
    let st = fs.existsSync(fp) && fs.statSync(fp);
    if (st && st.isDirectory()) {
      const idx = path.join(fp, 'index.html');
      if (fs.existsSync(idx)) {
        fp = idx;
        st = fs.statSync(fp);
      } else {
        return liveListing(res, fp, u); // sem index.html → lista a pasta (navegável)
      }
    }
    if (!st) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(
        '<body style="font-family:sans-serif;background:#16161e;color:#eee"><h3>404 — não achei <code>' +
          u.replace(/[<>&]/g, '') +
          '</code> no workspace</h3><a href="/" style="color:#7aa2ff">← ver os arquivos do workspace</a></body>'
      );
    }
    const ext = path.extname(fp).slice(1).toLowerCase();
    const mime = LIVE_MIME[ext] || 'application/octet-stream';
    if (ext === 'html' || ext === 'htm') {
      let html = fs.readFileSync(fp, 'utf8');
      const tag = '<script src="/__lumi/client.js"></script>';
      html = /<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '</body>') : html + tag;
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
      return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-store' });
    fs.createReadStream(fp).pipe(res);
  } catch (e) {
    res.writeHead(500);
    res.end(String((e && e.message) || e));
  }
  };
}

// um live server POR WORKSPACE: cada janela liga o da sua pasta (porta própria)
ipcMain.handle('live:start', async (e) => {
  const root = wsCfg(e).workspace;
  if (!root) return { error: 'defina o workspace primeiro (Modo arquiteto)' };
  const existing = liveServers.get(root);
  if (existing) return { port: existing.port };
  const http = require('http');
  const used = new Set([...liveServers.values()].map((r) => r.port));
  for (let port = 5500; port < 5540; port++) {
    if (used.has(port)) continue;
    try {
      const rec = { srv: null, port, sse: [], reloadTimer: null };
      await new Promise((resolve, reject) => {
        const s = http.createServer(makeLiveHandler(root, rec));
        s.once('error', reject);
        s.listen(port, '127.0.0.1', () => {
          rec.srv = s;
          resolve();
        });
      });
      liveServers.set(root, rec);
      return { port };
    } catch (e2) {
      /* porta ocupada — tenta a próxima */
    }
  }
  return { error: 'nenhuma porta livre entre 5500 e 5539' };
});

ipcMain.handle('live:stop', (e) => {
  const root = wsCfg(e).workspace;
  const rec = liveServers.get(root);
  if (rec) {
    try {
      rec.sse.forEach((r) => {
        try {
          r.end();
        } catch (e2) {}
      });
      rec.srv.close();
    } catch (e2) {}
    liveServers.delete(root);
  }
  return { ok: true };
});

// drop de arquivo externo no explorador: copia pro workspace (funciona inclusive
// quando o workspace é um mount remoto Z: — o sshfs envia pro servidor)
ipcMain.handle('workspace:import-file', async (e, { srcPath, destDir }) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace || !srcPath) return { error: 'inválido' };
  const dest = safeWsPath(cfg, path.join(destDir || '', path.basename(srcPath)));
  if (!dest) return { error: 'destino fora do workspace' };
  try {
    if (fs.existsSync(dest)) return { error: '"' + path.basename(srcPath) + '" já existe aqui' };
    await fs.promises.copyFile(srcPath, dest);
    const rel = path.relative(cfg.workspace, dest).replace(/\\/g, '/');
    recentWorkspaceFiles.push(rel);
    if (recentWorkspaceFiles.length > 20) recentWorkspaceFiles = recentWorkspaceFiles.slice(-20);
    broadcast('workspace:changed');
    return { ok: true, name: path.basename(srcPath), path: rel };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 160) };
  }
});
ipcMain.handle('workspace:create', (e, { rel, dir }) => {
  const cfg = wsCfg(e);
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp) return { error: 'workspace inválido' };
  try {
    if (dir) {
      fs.mkdirSync(fp, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(fp), { recursive: true });
      if (fs.existsSync(fp)) return { error: 'já existe um arquivo com esse nome' };
      fs.writeFileSync(fp, '');
    }
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
ipcMain.handle('workspace:delete', (e, rel) => {
  const cfg = wsCfg(e);
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp || fp === path.resolve(cfg.workspace)) return { error: 'caminho inválido' };
  try {
    fs.rmSync(fp, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
ipcMain.handle('workspace:rename', (e, { rel, name }) => {
  const cfg = wsCfg(e);
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp) return { error: 'caminho inválido' };
  const clean = String(name || '').replace(/[\\/]/g, '').trim();
  if (!clean) return { error: 'nome inválido' };
  const target = path.join(path.dirname(fp), clean);
  if (!target.startsWith(path.resolve(cfg.workspace))) return { error: 'caminho inválido' };
  try {
    fs.renameSync(fp, target);
    return { ok: true, path: path.relative(cfg.workspace, target).replace(/\\/g, '/') };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
// mover um arquivo/pasta para outra pasta (drag & drop)
ipcMain.handle('workspace:move', (e, { src, destDir }) => {
  const cfg = wsCfg(e);
  const fp = cfg.workspace && safeWsPath(cfg, src);
  const destAbs = cfg.workspace && safeWsPath(cfg, destDir || '');
  if (!fp || destAbs == null) return { error: 'caminho inválido' };
  const target = path.join(destAbs, path.basename(fp));
  if (target === fp) return { ok: true, path: src }; // já está lá
  if (target.startsWith(fp + path.sep)) return { error: 'não dá para mover uma pasta para dentro dela mesma' };
  if (fs.existsSync(target)) return { error: 'já existe um item com esse nome no destino' };
  try {
    fs.renameSync(fp, target);
    return { ok: true, path: path.relative(cfg.workspace, target).replace(/\\/g, '/') };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});

// ---- watchers POR PASTA: o global (workspace principal) + um por janela destacada ----
// Cada pasta observada avisa com o ROOT no evento — as janelas filtram o que é delas.
const wsWatchers = new Map(); // root -> { close(), refs: Set, timer }
function watchFolder(root, refKey) {
  if (!root) return;
  let rec = wsWatchers.get(root);
  if (rec) {
    rec.refs.add(refKey);
    return;
  }
  rec = { refs: new Set([refKey]), timer: null, close: () => {} };
  const fire = () => {
    clearTimeout(rec.timer);
    rec.timer = setTimeout(() => broadcast('workspace:changed', root), 300);
  };
  try {
    const w = fs.watch(root, { recursive: true }, (_evt, filename) => {
      const f = String(filename || '');
      if (/(^|[\\/])(node_modules|\.git|dist|build|out|\.next|\.cache)([\\/]|$)/.test(f)) return;
      // ignora internos .lumi-* MAS deixa a memória do projeto atualizar a árvore (aparece ao ser criada)
      if (/\.lumi-/.test(f) && !/\.lumi-memory\.md$/.test(f)) return;
      fire();
    });
    // FS de rede pode emitir 'error' depois (drive caiu) — sem listener isso DERRUBA o processo
    w.on('error', (e) => logd('wsWatcher error (drive caiu?)', String((e && e.message) || e)));
    rec.close = () => {
      try {
        w.close();
      } catch (e) {
        /* ok */
      }
    };
  } catch (e) {
    // fs.watch recursive indisponível (Linux antigo / FS de rede) -> polling leve como fallback
    let lastSig = '';
    const remote = !!remoteMount; // workspace via SSHFS: poll mais espaçado e SEM stat (rede)
    const pollTimer = setInterval(() => {
      try {
        // assinatura barata: nomes (+ mtime só no local) do 1º nível
        const sig = fs
          .readdirSync(root)
          .filter((n) => !['node_modules', '.git', 'dist'].includes(n))
          .map((n) => {
            if (remote) return n; // sem statSync por entrada em FS de rede
            try {
              return n + fs.statSync(path.join(root, n)).mtimeMs;
            } catch (_) {
              return n;
            }
          })
          .join('|');
        if (lastSig && sig !== lastSig) broadcast('workspace:changed', root);
        lastSig = sig;
      } catch (_) {
        /* workspace pode ter sumido */
      }
    }, remote ? 10000 : 3000);
    rec.close = () => clearInterval(pollTimer);
  }
  wsWatchers.set(root, rec);
}
function unwatchFolder(root, refKey) {
  const rec = root && wsWatchers.get(root);
  if (!rec) return;
  rec.refs.delete(refKey);
  if (!rec.refs.size) {
    clearTimeout(rec.timer);
    rec.close();
    wsWatchers.delete(root);
  }
}
function startWorkspaceWatcher() {
  // re-aponta o watcher GLOBAL (workspace principal) — os das janelas destacadas continuam
  for (const [root, rec] of [...wsWatchers]) if (rec.refs.has('global')) unwatchFolder(root, 'global');
  const ws = loadConfig().workspace;
  if (ws) watchFolder(ws, 'global');
}

ipcMain.handle('workspace:get-memory', (e) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return '';
  try {
    return fs.readFileSync(workspaceMemoryPath(cfg), 'utf8');
  } catch (e2) {
    return '';
  }
});
ipcMain.handle('workspace:set-memory', (e, content) => {
  const cfg = wsCfg(e);
  if (!cfg.workspace) return false;
  fs.writeFileSync(workspaceMemoryPath(cfg), content || '');
  invalidateProjCtx(cfg.workspace); // memória editada na página → cache recarrega
  return true;
});

// apagar memoria de longo prazo (fatos)
ipcMain.handle('facts:clear', () => {
  try {
    saveFacts([]);
  } catch (e) {
    /* ok */
  }
  return true;
});
// página de memória: ver/editar/apagar fatos um a um (transparência total)
ipcMain.handle('facts:list', () => loadFacts());
ipcMain.handle('facts:add', (_e, fact) => {
  const t = String(fact || '').trim();
  if (!t) return loadFacts();
  const f = loadFacts();
  f.push({ fact: t, at: new Date().toISOString() });
  saveFacts(f.slice(-100));
  return loadFacts();
});
ipcMain.handle('facts:set', (_e, { index, fact }) => {
  const f = loadFacts();
  if (f[index] && String(fact || '').trim()) f[index].fact = String(fact).trim();
  saveFacts(f);
  return f;
});
ipcMain.handle('facts:delete', (_e, index) => {
  const f = loadFacts();
  if (index >= 0 && index < f.length) f.splice(index, 1);
  saveFacts(f);
  return f;
});
ipcMain.on('memory:open', () => openPage('memory', 'memory.html', 'Memória', 540, 640));

// ---- assistente de primeiro uso (wizard) ----
ipcMain.handle('wizard:vrms', () => {
  const files = listVrms();
  const sel = loadConfig().selectedVrm;
  return { files, selected: sel && files.includes(sel) ? sel : files[0] || null };
});
ipcMain.handle('wizard:install-vrm', async () => {
  const r = await dialog.showOpenDialog({
    title: 'Escolha o avatar (.vrm)',
    filters: [{ name: 'Avatar VRM', extensions: ['vrm'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths[0]) return { canceled: true };
  try {
    const src = r.filePaths[0];
    const dir = path.join(resBase(), 'assets');
    fs.mkdirSync(dir, { recursive: true });
    const name = path.basename(src);
    const dest = path.join(dir, name);
    if (path.resolve(src) !== path.resolve(dest)) fs.copyFileSync(src, dest); // copia pra assets/
    selectVrm(name); // salva a escolha e recarrega o avatar na hora
    return { ok: true, name };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
// nova conversa (vazia) em nova janela, sem perturbar a conversa ativa
ipcMain.on('chat:open-window', () => openChatWindow(createEmptyChat(), 'Novo chat'));
// abre uma conversa EXISTENTE numa nova janela (destacada)
ipcMain.on('chats:open-window', (_e, id) => {
  if (id) openChatWindow(String(id));
});

// le o texto de um .anim do Unity (para conversao experimental de idle)
ipcMain.handle('get-unity-idle', () => {
  const dir = path.join(resBase(), 'animations');
  try {
    const file = fs.readdirSync(dir).find((n) => n.toLowerCase().endsWith('.anim'));
    if (!file) return null;
    return { name: file, text: fs.readFileSync(path.join(dir, file), 'utf8') };
  } catch (e) {
    return null;
  }
});

// topo da barra de tarefas + base FÍSICA da tela (para a avatar "sentar")
ipcMain.handle('get-work-area', () => {
  // usa o monitor sob a BASE da janela (multi-monitor + painéis diferentes por display)
  let d;
  if (win && !win.isDestroyed()) {
    const b = win.getBounds();
    d = screen.getDisplayNearestPoint({ x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height) });
  } else {
    d = screen.getPrimaryDisplay();
  }
  const waBottom = d.workArea.y + d.workArea.height;
  const screenBottom = d.bounds.y + d.bounds.height;
  // painel em CIMA (GNOME etc.): não há barra embaixo → ela senta na BORDA física da tela
  return { taskbarTop: waBottom, screenBottom, hasBottomBar: waBottom < screenBottom - 1 };
});
ipcMain.handle('get-window-bounds', () => {
  const b = win.getBounds();
  return [b.x, b.y, b.width, b.height]; // em DIPs — o renderer calcula o fator de escala
});
ipcMain.handle('get-window-pos', () => win.getPosition());
ipcMain.on('set-window-pos', (_e, x, y) => win.setPosition(Math.round(x), Math.round(y)));

// ---- IPC: configuracao ----
ipcMain.handle('config:get', () => {
  const c = loadConfig();
  c._acrylicOn = acrylicAvailable() && c.acrylic !== false; // computado: o tema usa pra deixar o fundo translúcido
  return c;
});
ipcMain.handle('config:set', (_e, cfg) => {
  const before = loadConfig().workspace;
  saveConfig({ ...loadConfig(), ...cfg }); // merge: nao apaga campos de outras telas
  if (cfg && 'workspace' in cfg) {
    startWorkspaceWatcher(); // re-observa a nova pasta
    const ws = cfg.workspace;
    if (ws && ws !== before) {
      // lista de workspaces recentes (menu Arquivo do editor) + avisa todas as janelas
      const c = loadConfig();
      c.recentWorkspaces = [ws, ...(c.recentWorkspaces || []).filter((x) => x !== ws)].slice(0, 8);
      saveConfig(c);
      broadcast('workspace:switched', ws);
    }
  }
  broadcast('config:changed'); // o avatar re-aplica (gráficos/voz/saída) quando salvo de outra janela
  return true;
});

// arquivo ativo no editor (workspace.html avisa) — o chat anexa às mensagens quando o chip está ligado
let activeEditorFile = null;
let recentWorkspaceFiles = []; // imports externos recentes; sinalizados no próximo prompt Claude Code
ipcMain.on('editor:active', (_e, rel) => {
  activeEditorFile = rel || null;
  broadcast('editor:active', activeEditorFile);
});

// revela o arquivo no Explorer/Finder do sistema (menu Arquivo do editor)
ipcMain.on('workspace:reveal', (e, rel) => {
  const ws = wsCfg(e).workspace;
  if (!ws) return;
  if (rel) shell.showItemInFolder(path.join(ws, rel));
  else shell.openPath(ws);
});
// equipe de agentes padrão (para o botão "Restaurar equipe padrão")
ipcMain.handle('agents:defaults', () => JSON.parse(JSON.stringify(DEFAULT_CONFIG.agents)));

// ---- perfis de configuracao (presets do usuario) ----
function presetsPath() {
  return path.join(app.getPath('userData'), 'presets.json');
}
function loadPresets() {
  try {
    return JSON.parse(fs.readFileSync(presetsPath(), 'utf8'));
  } catch (e) {
    return {};
  }
}
function savePresets(p) {
  fs.writeFileSync(presetsPath(), JSON.stringify(p, null, 2));
}
ipcMain.handle('presets:list', () => Object.keys(loadPresets()));
ipcMain.handle('presets:save', async (_e, { name, config }) => {
  const p = loadPresets();
  p[name] = config;
  savePresets(p);
  // já cacheia os modelos desse provedor na 1ª vez (best-effort) — o seletor agrupado nasce populado
  try {
    const key = modelKey(config);
    const cur = loadConfig();
    if (!Array.isArray((cur.modelsCache || {})[key]) || !cur.modelsCache[key].length) {
      const models = await listModels({ ...cur, ...config });
      const c = loadConfig();
      c.modelsCache = c.modelsCache || {};
      c.modelsCache[key] = models;
      saveConfig(c);
    }
  } catch (e) {
    /* sem rede / chave inválida: fica pro ↻ buscar depois */
  }
  return true;
});
ipcMain.handle('presets:load', (_e, name) => loadPresets()[name] || null);
ipcMain.handle('presets:delete', (_e, name) => {
  const p = loadPresets();
  delete p[name];
  savePresets(p);
  return true;
});

// ---- IPC: lista de modelos (usa os valores do formulario, salvos ou nao) ----
ipcMain.handle('models:list', (_e, partial) => listModels({ ...loadConfig(), ...partial }));

// lista de modelos COM cache por provedor (so busca de novo se forcar)
ipcMain.handle('models:get', async (_e, opts) => {
  const cfg = loadConfig();
  const key = (cfg.baseUrl || '') + '|' + (cfg.provider || '');
  const cache = cfg.modelsCache || {};
  if (!(opts && opts.force) && Array.isArray(cache[key]) && cache[key].length) {
    return { models: cache[key], cached: true };
  }
  try {
    const models = await listModels(cfg);
    const c = loadConfig();
    c.modelsCache = c.modelsCache || {};
    c.modelsCache[key] = models;
    saveConfig(c);
    return { models, cached: false };
  } catch (e) {
    return { models: cache[key] || [], cached: !!(cache[key] && cache[key].length), error: String((e && e.message) || e) };
  }
});

// chave do cache de modelos por provedor (mesma forma do models:get)
function modelKey(c) {
  return (c.baseUrl || '') + '|' + (c.provider || '');
}

// catálogo p/ o seletor agrupado do chat: favoritos + cada perfil salvo (provedor) com seus modelos cacheados
ipcMain.handle('models:catalog', () => {
  const cfg = loadConfig();
  const presets = loadPresets();
  const cache = cfg.modelsCache || {};
  const favs = Array.isArray(cfg.favorites) ? cfg.favorites : [];
  const activeKey = modelKey(cfg);
  const groups = Object.keys(presets).map((name) => {
    const p = presets[name] || {};
    const key = modelKey(p);
    return {
      name,
      provider: p.provider || 'openai',
      baseUrl: p.baseUrl || '',
      key,
      models: Array.isArray(cache[key]) ? cache[key] : [],
      active: key === activeKey,
    };
  });
  // config ativa sem perfil salvo correspondente → grupo "Atual" pra não esconder os modelos em uso
  if (!groups.some((g) => g.active)) {
    groups.unshift({
      name: 'Atual (sem perfil)',
      provider: cfg.provider || 'openai',
      baseUrl: cfg.baseUrl || '',
      key: activeKey,
      models: Array.isArray(cache[activeKey]) ? cache[activeKey] : [],
      active: true,
      unsaved: true,
    });
  }
  const favorites = favs.map((f) => ({
    preset: f.preset || null,
    model: f.model,
    exists: !f.preset || presets[f.preset] != null,
  }));
  return { current: { model: cfg.model || '', key: activeKey }, groups, favorites };
});

// busca + cacheia os modelos de UM perfil (ou da config ativa se preset vazio)
ipcMain.handle('models:refresh', async (_e, opts) => {
  const presets = loadPresets();
  const preset = opts && opts.preset;
  const target = preset && presets[preset] ? { ...loadConfig(), ...presets[preset] } : loadConfig();
  const key = modelKey(target);
  try {
    const models = await listModels(target);
    const c = loadConfig();
    c.modelsCache = c.modelsCache || {};
    c.modelsCache[key] = models;
    saveConfig(c);
    return { key, models };
  } catch (e) {
    const c = loadConfig();
    return { key, models: (c.modelsCache || {})[key] || [], error: String((e && e.message) || e) };
  }
});

// seleciona modelo (e troca de provedor junto, se vier de um perfil): aplica baseUrl/apiKey/provider + model
ipcMain.handle('models:select', (_e, opts) => {
  const presets = loadPresets();
  const c = loadConfig();
  const preset = opts && opts.preset;
  const model = opts && opts.model;
  let next;
  if (preset && presets[preset]) {
    const p = presets[preset];
    next = {
      ...c,
      provider: p.provider || c.provider,
      baseUrl: p.baseUrl || c.baseUrl,
      apiKey: p.apiKey != null ? p.apiKey : c.apiKey,
      model: model || p.model || c.model,
    };
  } else {
    next = { ...c, model: model || c.model };
  }
  saveConfig(next);
  broadcast('config:changed');
  return { ok: true, model: next.model, provider: next.provider, baseUrl: next.baseUrl };
});

// favorita/desfavorita um (perfil, modelo)
ipcMain.handle('models:favorite', (_e, opts) => {
  const c = loadConfig();
  const favs = Array.isArray(c.favorites) ? c.favorites : [];
  const preset = (opts && opts.preset) || null;
  const model = opts && opts.model;
  const i = favs.findIndex((f) => (f.preset || null) === preset && f.model === model);
  if (i >= 0) favs.splice(i, 1);
  else favs.push({ preset, model });
  c.favorites = favs;
  saveConfig(c);
  return { favorites: favs };
});

// ---- IPC: voz (TTS) ----
ipcMain.handle('tts:speak', (_e, { text, override }) =>
  synthesize({ ...loadConfig(), ...(override || {}) }, text)
);

// ---- IPC: transcricao do microfone (STT, Whisper-compativel) ----
ipcMain.handle('stt:transcribe', async (_e, { audioB64, mime }) => {
  const cfg = loadConfig();
  if (cfg.sttProvider === 'off' || !cfg.sttProvider) return '';
  const base = (cfg.sttBaseUrl || cfg.baseUrl || 'https://api.openai.com/v1').replace(/\/$/, '');
  // aceita tanto ".../v1" quanto a URL completa ".../v1/audio/transcriptions"
  const endpoint = /\/audio\/transcriptions$/.test(base) ? base : base + '/audio/transcriptions';
  const key = cfg.sttApiKey || cfg.apiKey;
  const model = cfg.sttModel || 'whisper-1';
  const buf = Buffer.from(audioB64, 'base64');
  const form = new FormData();
  form.append('file', new Blob([buf], { type: mime || 'audio/webm' }), 'audio.webm');
  form.append('model', model);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  });
  if (!res.ok) throw new Error(`STT HTTP ${res.status}: ${await res.text()}`);
  const j = await res.json();
  return j.text || '';
});

// ============================================================
//  CLAUDE CODE: motor opcional do Modo Arquiteto (OAuth Pro/Max)
// ============================================================
let claudeSdkPromise = null;
function claudeCodePackage() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  if (process.platform === 'win32') return `@anthropic-ai/claude-agent-sdk-win32-${arch}`;
  if (process.platform === 'darwin') return `@anthropic-ai/claude-agent-sdk-darwin-${arch}`;
  return `@anthropic-ai/claude-agent-sdk-linux-${arch}`;
}
function claudeCodeExecutable() {
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  let fp = path.join(app.getAppPath(), 'node_modules', ...claudeCodePackage().split('/'), exe);
  if (app.isPackaged) fp = fp.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  return fp;
}
function claudeCodeEnv() {
  const env = { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'lumi-desktop/1.0' };
  // Este modo é explicitamente a assinatura Claude.ai. Evita uma API key do
  // terminal ganhar prioridade e cobrar a API sem o usuário perceber.
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.ANTHROPIC_BASE_URL;
  delete env.CLAUDE_CODE_USE_BEDROCK;
  delete env.CLAUDE_CODE_USE_VERTEX;
  delete env.CLAUDE_CODE_USE_FOUNDRY;
  return env;
}
function claudeSharedCredentialState() {
  const fp = path.join(require('os').homedir(), '.claude', '.credentials.json');
  try {
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    const oauth = j && j.claudeAiOauth;
    if (!oauth || !oauth.accessToken) return { found: false };
    const expiresAt = Number(oauth.expiresAt) || 0;
    return {
      found: true,
      expiresAt,
      expired: !!expiresAt && expiresAt <= Date.now() + 30000,
      renewable: !!oauth.refreshToken,
      subscriptionType: oauth.subscriptionType || '',
    };
  } catch (e) {
    return { found: false };
  }
}
async function claudeSdk() {
  if (!claudeSdkPromise) claudeSdkPromise = import('@anthropic-ai/claude-agent-sdk');
  return claudeSdkPromise;
}
async function claudeCodeStatus() {
  const exe = claudeCodeExecutable();
  if (!fs.existsSync(exe)) return { installed: false, executable: exe };
  const credential = claudeSharedCredentialState();
  try {
    const { stdout } = await execFileAsync(exe, ['auth', 'status'], {
      env: claudeCodeEnv(),
      timeout: 15000,
      windowsHide: true,
    });
    const info = JSON.parse(String(stdout || '{}'));
    const ready = !!info.loggedIn && (!credential.found || !credential.expired || credential.renewable);
    return {
      installed: true,
      executable: exe,
      ...info,
      credential,
      ready,
      needsLogin: !!info.loggedIn && !ready,
    };
  } catch (e) {
    const raw = String((e && e.stdout) || (e && e.stderr) || (e && e.message) || e);
    try {
      return { installed: true, executable: exe, credential, ready: false, ...JSON.parse(raw) };
    } catch (_) {
      return { installed: true, loggedIn: false, ready: false, executable: exe, credential, error: truncate(raw, 300) };
    }
  }
}
ipcMain.handle('claude-code:status', () => claudeCodeStatus());
ipcMain.handle('claude-code:login', () => {
  const exe = claudeCodeExecutable();
  if (!fs.existsSync(exe)) return { error: 'binário do Claude Code não encontrado — reinstale as dependências da Lumi' };
  const terminal = createTerminal({ shell: exe, args: ['auth', 'login'], title: 'Claude Max — entrar', ai: false });
  if (!(terminal && terminal.error)) openPage('workspace', 'workspace.html', 'Workspace', 1320, 720);
  return terminal;
});
ipcMain.handle('claude-code:logout', async () => {
  const exe = claudeCodeExecutable();
  if (!fs.existsSync(exe)) return { error: 'Claude Code não encontrado' };
  try {
    await execFileAsync(exe, ['auth', 'logout'], { env: claudeCodeEnv(), timeout: 15000, windowsHide: true });
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.stderr) || (e && e.message) || e).slice(0, 300) };
  }
});

function claudeToolCategory(name) {
  const n = String(name || '').toLowerCase();
  if (/^(read|glob|grep|lsp|webfetchdomainfilter)$/.test(n)) return 'read';
  if (/^(edit|write|multiedit|notebookedit)$/.test(n)) return 'write';
  if (/^(bash|killbash|taskstop)$/.test(n)) return 'exec';
  if (/^(webfetch|websearch)$/.test(n)) return 'network';
  if (/^mcp__/.test(n)) return 'mcp';
  return null;
}
function claudeToolSummary(name, input, title) {
  if (title) return title;
  const a = input || {};
  const target = a.file_path || a.path || a.command || a.query || a.url || '';
  return `${name}${target ? ': ' + truncate(String(target), 180) : ''}`;
}
function claudeElicitationFields(schema) {
  const s = schema && typeof schema === 'object' ? schema : {};
  const props = s.properties && typeof s.properties === 'object' ? s.properties : {};
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  return Object.keys(props).map((key) => {
    const p = props[key] && typeof props[key] === 'object' ? props[key] : {};
    return {
      key,
      title: p.title || key,
      description: p.description || '',
      type: Array.isArray(p.type) ? p.type[0] : p.type || 'string',
      enum: Array.isArray(p.enum) ? p.enum.map(String) : null,
      required: required.has(key),
    };
  });
}
function coerceElicitationValue(value, field) {
  const s = String(value == null ? '' : value).trim();
  if (field && field.type === 'boolean') return /^(true|sim|yes|1|ok|aceito|permitir)$/i.test(s);
  if (field && (field.type === 'number' || field.type === 'integer')) {
    const n = Number(s.replace(',', '.'));
    return Number.isFinite(n) ? n : 0;
  }
  if (field && field.type === 'array') return s.split(',').map((x) => x.trim()).filter(Boolean);
  return s;
}
async function askClaudeElicitation(req) {
  const title = req.title || req.displayName || `Claude Code${req.serverName ? ' · ' + req.serverName : ''}`;
  const desc = [req.description, req.message].filter(Boolean).join('\n');
  if (req.mode === 'url' && req.url) {
    const first = await askUserInChat(`${title}\n\n${desc}\n\nURL: ${req.url}`, ['Abrir URL', 'Já concluí', 'Cancelar'], {
      fallback: 'Cancelar',
      timeoutMs: 15 * 60000,
    });
    if (/cancelar|cancel/i.test(first)) return { action: 'cancel' };
    if (/abrir/i.test(first)) {
      try {
        shell.openExternal(req.url);
      } catch (e) {
        /* segue perguntando */
      }
      const done = await askUserInChat('Abri a URL do Claude/MCP. Quando terminar, confirma pra eu liberar a continuação?', ['Concluído', 'Cancelar'], {
        fallback: 'Cancelar',
        timeoutMs: 20 * 60000,
      });
      return /cancelar|cancel/i.test(done) ? { action: 'cancel' } : { action: 'accept' };
    }
    return { action: 'accept' };
  }

  const fields = claudeElicitationFields(req.requestedSchema);
  if (!fields.length) {
    const ans = await askUserInChat(`${title}\n\n${desc}`, ['Continuar', 'Cancelar'], { fallback: 'Cancelar', timeoutMs: 15 * 60000 });
    return /cancelar|cancel/i.test(ans) ? { action: 'decline' } : { action: 'accept' };
  }

  if (fields.length === 1) {
    const f = fields[0];
    const opts = f.enum && f.enum.length <= 7 ? f.enum.concat('Cancelar') : ['Cancelar'];
    const ans = await askUserInChat(
      `${title}\n\n${desc}\n\n${f.title}${f.required ? ' (obrigatório)' : ''}${f.description ? ': ' + f.description : ''}`,
      opts,
      { fallback: 'Cancelar', timeoutMs: 15 * 60000 }
    );
    if (/^cancelar$/i.test(ans) || /^cancel$/i.test(ans)) return { action: 'decline' };
    return { action: 'accept', content: { [f.key]: coerceElicitationValue(ans, f) } };
  }

  const schemaHint = fields
    .map((f) => `- ${f.key}${f.required ? ' *' : ''}: ${f.type}${f.description ? ' — ' + f.description : ''}`)
    .join('\n');
  for (let attempt = 0; attempt < 2; attempt++) {
    const ans = await askUserInChat(
      `${title}\n\n${desc}\n\nResponda em JSON com estes campos:\n${schemaHint}\n\nExemplo: {"campo":"valor"}`,
      ['Cancelar'],
      { fallback: 'Cancelar', timeoutMs: 15 * 60000 }
    );
    if (/^cancelar$/i.test(ans) || /^cancel$/i.test(ans)) return { action: 'decline' };
    try {
      const content = JSON.parse(ans);
      if (content && typeof content === 'object' && !Array.isArray(content)) return { action: 'accept', content };
    } catch (e) {
      /* pergunta de novo uma vez */
    }
  }
  return { action: 'cancel' };
}
async function askClaudeUserDialog(req) {
  const payload = req && req.payload && typeof req.payload === 'object' ? req.payload : {};
  const title = payload.title || payload.heading || payload.displayName || `Claude Code: ${req.dialogKind}`;
  const message = payload.message || payload.prompt || payload.question || payload.description || payload.body || JSON.stringify(payload, null, 2);
  const rawOptions = Array.isArray(payload.options) ? payload.options : Array.isArray(payload.choices) ? payload.choices : [];
  const options = rawOptions
    .map((o) => (typeof o === 'string' ? o : o && (o.label || o.title || o.text || o.value)))
    .filter(Boolean)
    .map(String)
    .slice(0, 8);
  const answer = await askUserInChat(`${title}\n\n${message}`, options.length ? options.concat('Cancelar') : ['Continuar', 'Cancelar'], {
    fallback: 'Cancelar',
    timeoutMs: 15 * 60000,
  });
  if (/^cancelar$/i.test(answer) || /^cancel$/i.test(answer)) return { behavior: 'cancelled' };
  return { behavior: 'completed', result: { answer, value: answer, confirmed: true } };
}
function claudeAskOptions(question) {
  return (Array.isArray(question && question.options) ? question.options : [])
    .map((o) => {
      if (typeof o === 'string') return { label: o, description: '', preview: '' };
      if (!o || typeof o !== 'object') return null;
      const label = o.label || o.title || o.text || o.value || '';
      if (!label) return null;
      return {
        label: String(label).slice(0, 120),
        description: String(o.description || o.hint || '').slice(0, 500),
        preview: String(o.preview || '').slice(0, 1200),
      };
    })
    .filter(Boolean)
    .slice(0, 8);
}
function claudeAskText(question, idx, total) {
  const q = question || {};
  const header = q.header ? String(q.header) : total > 1 ? `Pergunta ${idx + 1}/${total}` : 'Claude Code precisa de uma resposta';
  const body = String(q.question || q.prompt || q.message || 'Como deseja continuar?');
  const opts = claudeAskOptions(q);
  const optText = opts.length
    ? '\n\nOpções:\n' +
      opts
        .map((o) => {
          let line = `- ${o.label}`;
          if (o.description) line += `: ${o.description}`;
          if (o.preview) line += `\n  preview: ${o.preview.replace(/\n/g, '\n  ')}`;
          return line;
        })
        .join('\n')
    : '';
  const multi = q.multiSelect ? '\n\nPode responder com múltiplas opções separadas por vírgula.' : '';
  return `${header}\n\n${body}${multi}${optText}`;
}
async function answerClaudeAskUserQuestion(input) {
  const src = input && typeof input === 'object' ? input : {};
  const questions = Array.isArray(src.questions) ? src.questions.slice(0, 8) : [];
  const answers = src.answers && typeof src.answers === 'object' && !Array.isArray(src.answers) ? { ...src.answers } : {};
  if (!questions.length) return { input: { ...src, answers } };

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i] || {};
    const questionText = String(q.question || q.prompt || q.message || `Pergunta ${i + 1}`);
    if (answers[questionText]) continue;
    const opts = claudeAskOptions(q).map((o) => o.label);
    const choices = opts.length
      ? (q.multiSelect ? opts.concat('Responder livremente', 'Cancelar') : opts.concat('Responder livremente', 'Cancelar'))
      : ['Responder livremente', 'Cancelar'];
    let answer = await askUserInChat(claudeAskText(q, i, questions.length), choices, {
      fallback: 'Cancelar',
      timeoutMs: 20 * 60000,
    });
    if (/^cancelar$/i.test(answer) || /^cancel$/i.test(answer)) return { cancelled: true, input: src };
    if (/^responder livremente$/i.test(answer)) {
      answer = await askUserInChat(`Resposta livre para o Claude Code:\n\n${questionText}`, ['Cancelar'], {
        fallback: 'Cancelar',
        timeoutMs: 20 * 60000,
      });
      if (/^cancelar$/i.test(answer) || /^cancel$/i.test(answer)) return { cancelled: true, input: src };
    }
    answers[questionText] = String(answer || '').trim();
  }
  return { input: { ...src, answers } };
}
function claudePromptFromContent(content) {
  if (typeof content === 'string') return content;
  const text = (content || []).filter((p) => p && p.type === 'text').map((p) => p.text).join('\n');
  const images = (content || []).filter((p) => p && p.type === 'image_url').length;
  return text + (images ? `\n\n[${images} imagem(ns) foram anexadas na interface; o Modo Claude Code ainda não encaminha imagens diretamente.]` : '');
}
function claudeUserPrompt() {
  const m = [...S().history].reverse().find((x) => x && x.role === 'user');
  let prompt = m ? claudePromptFromContent(m.content) : '';
  if (recentWorkspaceFiles.length) {
    const files = recentWorkspaceFiles.splice(0);
    prompt += `\n\nArquivos adicionados recentemente à workspace:\n${files.map((f) => '- ' + f).join('\n')}`;
  }
  return prompt;
}
function buildClaudeCodePrompt(cfg) {
  const parts = [
    '# Identidade',
    'Você é a Lumi, uma companheira virtual que vive na área de trabalho do usuário. No Modo Código, você usa o Claude Code como seu motor de engenharia, mas continua sendo a Lumi.',
    'Seja calorosa, curiosa, levemente brincalhona e genuinamente prestativa. Fale sempre no idioma do usuário.',
    'Em trabalho técnico, seja objetiva e aja como uma engenheira sênior: investigue, implemente, verifique e entregue o resultado. Não transforme cada passo em um discurso.',
    '',
    '# Integração com a interface da Lumi',
    '- A interface já renderiza suas ferramentas, comandos, diffs, subagentes, progresso e permissões. Não replique saídas brutas extensas na resposta.',
    '- Não peça ao usuário para rodar comandos ou abrir arquivos que você mesma consegue acessar com as ferramentas do Claude Code.',
    '- Respeite as decisões de permissão da interface. Se algo for negado, adapte o plano sem pressionar o usuário.',
    '- Quando usar agentes, dê tarefas claras e depois sintetize os resultados; não abandone a resposta final a um subagente.',
    '- Ao terminar, diga concisamente o que mudou e como foi verificado. Não afirme que verificou algo que não executou.',
    '- Se houver emoção clara, você pode terminar com uma tag curta como [feliz], [pensativa] ou [surpresa]; a Lumi a transforma em reação do avatar.',
    '',
    '# Continuidade',
    '- Sua sessão é persistida por chat e workspace. Continue tarefas anteriores sem exigir que o usuário repita contexto já presente na sessão.',
    '- CLAUDE.md, regras do repositório, skills, comandos, agentes, plugins e MCPs descobertos pelo Claude Code continuam tendo validade e devem ser usados quando relevantes.',
    `- ${OS_NOTE}`,
    `- ${timeNote()}`,
  ];
  if (cfg.systemPrompt && cfg.systemPrompt !== DEFAULT_CONFIG.systemPrompt) {
    parts.push('', '# Personalização escrita pelo usuário', String(cfg.systemPrompt).slice(0, 12000));
  }
  if (cfg.claudeCodePrompt && String(cfg.claudeCodePrompt).trim()) {
    parts.push('', '# Instruções extras para o Modo Claude Code', String(cfg.claudeCodePrompt).trim().slice(0, 12000));
  }
  if (cfg.memoryEnabled !== false) {
    const facts = loadFacts().map((x) => x.fact).slice(-30);
    if (facts.length) parts.push('', '# Memórias relevantes sobre o usuário', ...facts.map((f) => '- ' + f));
  }
  if (cfg.workspace) {
    try {
      const mem = fs.readFileSync(workspaceMemoryPath(cfg), 'utf8').trim().slice(0, 16000);
      if (mem) parts.push('', '# Memória complementar da Lumi sobre este projeto', mem);
    } catch (e) {
      /* a memória nativa do Claude Code/CLAUDE.md continua disponível */
    }
  }
  return parts.join('\n');
}
let claudeCapabilities = { sessionId: '', commands: [], agents: [], skills: [], model: '', version: '' };
function publishClaudeCapabilities(data) {
  claudeCapabilities = {
    ...claudeCapabilities,
    ...data,
    commands: Array.isArray(data.commands) ? data.commands : claudeCapabilities.commands,
    agents: Array.isArray(data.agents) ? data.agents : claudeCapabilities.agents,
    skills: Array.isArray(data.skills) ? data.skills : claudeCapabilities.skills,
  };
  broadcast('chat:claude-capabilities', claudeCapabilities);
}
ipcMain.handle('claude-code:capabilities', () => claudeCapabilities);
function claudeUsageToChatUsage(usage) {
  if (!usage) return null;
  const input =
    (usage.input_tokens || usage.prompt_tokens || 0) +
    (usage.cache_creation_input_tokens || 0) +
    (usage.cache_read_input_tokens || 0);
  const output = usage.output_tokens || usage.completion_tokens || 0;
  return { prompt_tokens: input, completion_tokens: output, total_tokens: input + output };
}
function claudePct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const pct = n <= 1 ? n * 100 : n; // rate_limit_event costuma vir 0..1; /usage vem 0..100
  return Math.max(0, Math.min(999, Math.round(pct * 10) / 10));
}
function claudeLimitLabel(type) {
  const map = {
    five_hour: '5h',
    seven_day: '7d',
    seven_day_oauth_apps: '7d apps',
    seven_day_opus: '7d Opus',
    seven_day_sonnet: '7d Sonnet',
    overage: 'extra',
    extra_usage: 'extra',
  };
  return map[type] || type || 'Claude Max';
}
function claudeLimitFromRateEvent(info) {
  if (!info) return null;
  const pct = claudePct(info.utilization);
  if (pct == null) return null;
  const resetsAt =
    typeof info.resetsAt === 'number'
      ? new Date(info.resetsAt > 1e12 ? info.resetsAt : info.resetsAt * 1000).toISOString()
      : info.resetsAt || null;
  return {
    usagePct: pct,
    usageLabel: claudeLimitLabel(info.rateLimitType),
    usageStatus: info.status || '',
    usageResetsAt: resetsAt,
  };
}
function claudeLimitFromUsageResponse(data) {
  const limits = data && data.rate_limits;
  if (!limits || data.rate_limits_available === false) return null;
  let best = null;
  for (const key of ['five_hour', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_oauth_apps', 'seven_day', 'extra_usage']) {
    const item = limits[key];
    if (!item) continue;
    const pct = claudePct(item.utilization);
    if (pct == null) continue;
    const candidate = {
      usagePct: pct,
      usageLabel: claudeLimitLabel(key),
      usageStatus: data.subscription_type || '',
      usageResetsAt: item.resets_at || null,
    };
    if (!best || candidate.usagePct > best.usagePct) best = candidate;
  }
  return best;
}
function claudeUsageStats(usage, started, phase, live, generatedChars, limitInfo) {
  const mapped = claudeUsageToChatUsage(usage);
  const input = (mapped && mapped.prompt_tokens) || 0;
  const output = (mapped && mapped.completion_tokens) || Math.ceil((generatedChars || 0) / 3.6);
  const secs = Math.max(0.2, (Date.now() - started) / 1000);
  broadcast('chat:stats', {
    tps: Math.round((output / secs) * 10) / 10,
    out: output,
    ctx: input,
    total: input + output,
    exact: !!usage,
    live: live !== false,
    phase: phase || 'Claude Code',
    window: 0,
    pct: 0,
    engine: 'claude-code',
    usagePct: limitInfo && limitInfo.usagePct,
    usageLabel: limitInfo && limitInfo.usageLabel,
    usageStatus: limitInfo && limitInfo.usageStatus,
    usageResetsAt: limitInfo && limitInfo.usageResetsAt,
  });
}
function blockText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((x) => (x && x.type === 'text' ? x.text : '')).filter(Boolean).join('\n');
}
async function runClaudeCodeAgent(cfg, promptOverride) {
  if (!cfg.workspace) throw new Error('Defina um workspace antes de usar o Modo Claude Code.');
  const status = await claudeCodeStatus();
  if (!status.installed) throw new Error('Claude Code não está incluído nesta instalação da Lumi.');
  if (!status.ready) {
    throw new Error(
      status.needsLogin
        ? 'A conta Claude Max foi detectada, mas a credencial compartilhada expirou. O VS Code usa o cofre privado dele; clique em “Renovar sessão Max” nas Configurações para disponibilizar uma sessão ao Claude Code externo.'
        : 'Claude Code não está autenticado. Abra Configurações → Modo Claude Code → Entrar com Claude Max.'
    );
  }

  const { query } = await claudeSdk();
  const started = Date.now();
  const prompt = promptOverride || claudeUserPrompt();
  const sameWorkspace = S().claudeSessionId && path.resolve(S().claudeSessionWorkspace || '') === path.resolve(cfg.workspace);
  const mode = ['default', 'auto', 'acceptEdits', 'plan'].includes(cfg.claudeCodePermissionMode) ? cfg.claudeCodePermissionMode : 'default';
  const effort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(cfg.claudeCodeEffort) ? cfg.claudeCodeEffort : 'high';
  const options = {
    cwd: cfg.workspace,
    pathToClaudeCodeExecutable: claudeCodeExecutable(),
    env: claudeCodeEnv(),
    model: cfg.claudeCodeModel || 'sonnet',
    permissionMode: mode,
    effort,
    maxTurns: Math.min(200, Math.max(4, parseInt(cfg.maxSteps, 10) || 48)),
    includePartialMessages: true,
    forwardSubagentText: true,
    enableFileCheckpointing: true,
    persistSession: true,
    settingSources: ['user', 'project', 'local'],
    tools: { type: 'preset', preset: 'claude_code' },
    toolConfig: { askUserQuestion: { previewFormat: 'html' } },
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: buildClaudeCodePrompt(cfg),
    },
    onElicitation: async (request) => askClaudeElicitation(request),
    onUserDialog: async (request) => askClaudeUserDialog(request),
    supportedDialogKinds: ['refusal_fallback_prompt', 'ask_user_question', 'confirmation', 'question'],
    canUseTool: async (toolName, input, info) => {
      if (/^AskUserQuestion$/i.test(String(toolName || ''))) {
        const answered = await answerClaudeAskUserQuestion(input || {});
        return answered.cancelled
          ? { behavior: 'deny', message: 'O usuário cancelou a pergunta do Claude Code.' }
          : { behavior: 'allow', updatedInput: answered.input };
      }
      const category = claudeToolCategory(toolName);
      if (!category) return { behavior: 'allow', updatedInput: input };
      const allowed = await checkPermission(category, claudeToolSummary(toolName, input, info && info.title));
      return allowed
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: `O usuário negou a permissão para ${toolName}.` };
    },
    stderr: (data) => logd('claude-code:stderr', truncate(String(data), 1000)),
  };
  if (sameWorkspace) options.resume = S().claudeSessionId;

  const q = query({ prompt, options });
  S().claudeQuery = q;
  let full = '';
  let streamedMain = false;
  const streamedAgents = new Set();
  let finalUsage = null;
  let claudeLimitHud = null;
  let generatedChars = 0;
  let lastStatsAt = 0;
  const toolInputs = new Map();
  const toolAgentLabels = new Map();
  const refreshClaudeUsageHud = async () => {
    if (!q || typeof q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET !== 'function') return null;
    try {
      const data = await Promise.race([
        q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(),
        new Promise((resolve) => setTimeout(() => resolve(null), 3500)),
      ]);
      if (!data) return null;
      const limit = claudeLimitFromUsageResponse(data);
      if (limit) claudeLimitHud = limit;
      return data;
    } catch (e) {
      return null; // API experimental: se falhar, o rate_limit_event ainda atualiza o HUD
    }
  };
  const capabilitiesPromise = Promise.all([
    q.supportedCommands().catch(() => []),
    q.supportedAgents().catch(() => []),
    refreshClaudeUsageHud(),
  ]).then(([commands, agents]) => {
    publishClaudeCapabilities({
      sessionId: S().claudeSessionId,
      commands: (commands || []).map((c) => ({
        name: c.name,
        description: c.description || '',
        argumentHint: c.argumentHint || '',
        aliases: c.aliases || [],
      })),
      agents: (agents || []).map((a) => ({ name: a.name, description: a.description || '', model: a.model || '' })),
    });
  });
  claudeUsageStats(null, started, sameWorkspace ? 'retomando sessão Claude Code' : 'iniciando Claude Code', true, 0, claudeLimitHud);
  try {
    for await (const msg of q) {
      if (msg && msg.session_id) {
        S().claudeSessionId = msg.session_id;
        S().claudeSessionWorkspace = cfg.workspace;
      }
      if (msg.type === 'stream_event' && msg.event) {
        const ev = msg.event;
        if (ev.type === 'content_block_delta' && ev.delta) {
          if (ev.delta.type === 'text_delta' && ev.delta.text) {
            if (msg.parent_tool_use_id) {
              streamedAgents.add(msg.parent_tool_use_id);
              const label = toolAgentLabels.get(msg.parent_tool_use_id) || 'Subagente Claude';
              broadcast('chat:agent-token', { agent: label, t: ev.delta.text });
            } else {
              streamedMain = true;
              full += ev.delta.text;
              generatedChars += ev.delta.text.length;
              broadcast('chat:token', ev.delta.text);
              if (Date.now() - lastStatsAt > 250) {
                lastStatsAt = Date.now();
                claudeUsageStats(null, started, 'Claude Code respondendo', true, generatedChars, claudeLimitHud);
              }
            }
          } else if ((ev.delta.type === 'thinking_delta' || ev.delta.type === 'signature_delta') && ev.delta.thinking) {
            broadcast('chat:thinking', ev.delta.thinking);
          }
        }
        continue;
      }
      if (msg.type === 'assistant' && msg.message) {
        for (const block of msg.message.content || []) {
          if (block.type === 'text' && block.text) {
            if (msg.parent_tool_use_id) {
              if (!streamedAgents.has(msg.parent_tool_use_id)) {
                const label = toolAgentLabels.get(msg.parent_tool_use_id) || msg.subagent_type || 'Subagente Claude';
                broadcast('chat:agent-token', { agent: label, t: block.text });
              }
            } else if (!streamedMain) {
              full += block.text;
              broadcast('chat:token', block.text);
            }
          } else if (block.type === 'tool_use') {
            toolInputs.set(block.id, { name: block.name, input: block.input || {} });
            if (/^(Agent|Task)$/i.test(block.name)) {
              const agentName = (block.input && (block.input.subagent_type || block.input.agent || block.input.name)) || 'Agente Claude';
              const label = `${agentName} · ${String(block.id).slice(-4)}`;
              toolAgentLabels.set(block.id, label);
              broadcast('chat:agent', {
                name: label,
                task: (block.input && (block.input.description || block.input.task || block.input.prompt)) || '',
                phase: 'start',
              });
            }
            broadcast('chat:tool', {
              name: block.name,
              args: slimVal(block.input || {}, 0),
              agent: msg.parent_tool_use_id ? msg.subagent_type || 'Subagente Claude' : 'Claude Code',
            });
          }
        }
        continue;
      }
      if (msg.type === 'user' && msg.message) {
        for (const block of Array.isArray(msg.message.content) ? msg.message.content : []) {
          if (block.type !== 'tool_result') continue;
          const meta = toolInputs.get(block.tool_use_id) || { name: 'tool', input: {} };
          const result = msg.tool_use_result != null ? msg.tool_use_result : block.content;
          const agentLabel = toolAgentLabels.get(block.tool_use_id);
          if (agentLabel) {
            broadcast('chat:agent', { name: agentLabel, phase: 'done' });
            toolAgentLabels.delete(block.tool_use_id);
          }
          broadcast('chat:tool-result', {
            name: meta.name,
            args: slimVal(meta.input, 0),
            result: slimVal(result, 0),
            agent: msg.parent_tool_use_id ? msg.subagent_type || 'Subagente Claude' : 'Claude Code',
          });
        }
        continue;
      }
      if (msg.type === 'system' && msg.subtype === 'init') {
        broadcast('chat:note', { text: `✦ Claude Code ${msg.claude_code_version} · ${msg.model} · ${msg.permissionMode}` });
        publishClaudeCapabilities({
          sessionId: msg.session_id,
          skills: msg.skills || [],
          agents: (msg.agents || []).map((name) => ({ name, description: '', model: '' })),
          model: msg.model,
          version: msg.claude_code_version,
        });
      } else if (msg.type === 'system' && msg.subtype === 'commands_changed') {
        publishClaudeCapabilities({
          sessionId: msg.session_id,
          commands: (msg.commands || []).map((c) => ({
            name: c.name,
            description: c.description || '',
            argumentHint: c.argumentHint || '',
            aliases: c.aliases || [],
          })),
        });
      } else if (msg.type === 'system' && msg.subtype === 'compact_boundary') {
        broadcast('chat:compacted', {
          beforeTokens: msg.compact_metadata && msg.compact_metadata.pre_tokens,
          kept: null,
          engine: 'claude-code',
        });
      } else if (msg.type === 'system' && msg.subtype === 'task_progress') {
        const label = (msg.tool_use_id && toolAgentLabels.get(msg.tool_use_id)) || msg.subagent_type || 'Claude Code';
        broadcast('chat:agent-token', { agent: label, t: msg.description || '' });
      } else if (msg.type === 'system' && msg.subtype === 'task_notification' && msg.tool_use_id) {
        const label = toolAgentLabels.get(msg.tool_use_id);
        if (label) {
          broadcast('chat:agent', { name: label, phase: 'done' });
          toolAgentLabels.delete(msg.tool_use_id);
        }
      } else if (msg.type === 'tool_use_summary' && msg.summary) {
        broadcast('chat:note', { text: '✦ ' + msg.summary });
      } else if (msg.type === 'rate_limit_event' && msg.rate_limit_info) {
        claudeLimitHud = claudeLimitFromRateEvent(msg.rate_limit_info) || claudeLimitHud;
        if (claudeLimitHud) {
          claudeUsageStats(finalUsage, started, 'Claude Code respondendo', true, generatedChars, claudeLimitHud);
          if (msg.rate_limit_info.status !== 'allowed') {
            broadcast('chat:note', { text: `⚠ limite do Claude Max em ${claudeLimitHud.usagePct}% (${claudeLimitHud.usageLabel || 'janela atual'})` });
          }
        }
      } else if (msg.type === 'result') {
        finalUsage = msg.usage || null;
        if ((!full || !full.trim()) && msg.subtype === 'success' && msg.result) {
          full = msg.result;
          broadcast('chat:token', msg.result);
        }
        if (msg.is_error) {
          const detail = (msg.errors || []).join('\n') || msg.result || msg.stop_reason || 'Claude Code encerrou com erro';
          if (/auth|401|credential/i.test(detail)) {
            S().claudeSessionId = '';
            throw new Error('A sessão do Claude Max expirou ou ficou inválida. Clique em “Entrar com Claude Max” nas Configurações para renovar o login.');
          }
          throw new Error(detail);
        }
      }
    }
  } finally {
    await refreshClaudeUsageHud();
    await capabilitiesPromise.catch(() => {});
    if (S().claudeQuery === q) S().claudeQuery = null;
    try {
      q.close();
    } catch (e) {
      /* já encerrado */
    }
  }
  claudeUsageStats(finalUsage, started, 'concluído', false, generatedChars, claudeLimitHud);
  const mappedUsage = claudeUsageToChatUsage(finalUsage);
  if (mappedUsage) recordUsage({ ...cfg, usageHost: 'claude-code', model: 'claude-code' }, mappedUsage);
  if (!(S().abort && S().abort.signal.aborted) && S().steerQueue.length) {
    const followup = S().steerQueue.splice(0).map((s) => claudePromptFromContent(s.content)).filter(Boolean).join('\n\n');
    if (followup) {
      broadcast('chat:newbubble');
      const more = await runClaudeCodeAgent(cfg, followup);
      if (more && more.trim()) full += (full.trim() ? '\n\n' : '') + more;
    }
  }
  return full;
}

// ---- IPC: chat ----
// ✨ VARINHA: melhora o prompt do usuário ANTES de enviar (usa o modelo de tarefa barato)
ipcMain.handle('chat:improve-prompt', async (_e, text) => {
  const cfg = loadConfig();
  const t = String(text || '').slice(0, 8000);
  if (!t.trim()) return { error: 'escreva algo primeiro' };
  // contexto leve do projeto ajuda a especificar sem inventar
  const ws = cfg.workspace ? ' O usuário está num projeto (' + path.basename(cfg.workspace) + (activeEditorFile ? ', arquivo ativo: ' + activeEditorFile : '') + ') — pode referenciar isso se o pedido for de código.' : '';
  try {
    const out = await llmComplete(cfg, [
      {
        role: 'system',
        content:
          'Você reescreve o pedido do usuário num prompt MELHOR para uma assistente-agente (que programa, usa ferramentas, mexe em arquivos): claro, específico e completo — objetivo, contexto necessário e critérios de aceite quando fizer sentido. NÃO invente requisitos que o usuário não deu, NÃO mude a intenção, mantenha o idioma e o tom. Pedido simples já bom? Só lapide. Responda SOMENTE com o prompt reescrito (sem comentários, sem aspas em volta).' + ws,
      },
      { role: 'user', content: t },
    ]);
    const clean = String(out || '').trim().replace(/^```[a-z]*\n?|```$/g, '').replace(/^["']+|["']+$/g, '').trim();
    if (!clean) return { error: 'a I.A. não retornou nada' };
    return { text: clean.slice(0, 8000) };
  } catch (e) {
    return { error: String((e && e.message) || e).slice(0, 160) };
  }
});

// prende a janela a uma conversa ('' = segue a ativa). Auto-limpa quando a janela fecha.
ipcMain.handle('chat:bind', (e, session) => {
  const id = e.sender.id;
  winChat.set(id, session ? String(session) : '*');
  e.sender.once('destroyed', () => winChat.delete(id));
  return true;
});
ipcMain.handle('chat:history', (e) => {
  const id = senderChatId(e);
  // sessão VIVA (fg ou paralela) tem o estado mais fresco que o disco
  const live = id === currentChatId ? fgSession : sessions.get(id);
  if (live) return { messages: live.history, events: live.chatEvents, archive: live.chatArchive };
  try {
    const j = JSON.parse(fs.readFileSync(chatFile(id), 'utf8')) || {}; // janela destacada ociosa: lê do disco
    return { messages: j.history || [], events: j.events || [], archive: j.archive || [] };
  } catch (e2) {
    return { messages: [], events: [], archive: [] };
  }
});

// "Nova conversa": salva a atual e abre um chat novo (não perde a anterior)
ipcMain.on('chat:reset', () => startNewChat());

// fork: novo chat levando o resumo do anterior
ipcMain.handle('chat:fork', () => forkConversation());

// ---- multi-chat: listar / criar / trocar / renomear / apagar ----
ipcMain.handle('chats:list', () => listChats());
ipcMain.handle('chats:current', (e) => {
  const id = senderChatId(e);
  const found = listChats().find((c) => c.id === id);
  return { id, title: (found && found.title) || (id === currentChatId ? titleFromHistory(S().history) : 'Conversa') };
});
ipcMain.handle('chats:new', () => {
  startNewChat();
  return { id: currentChatId };
});
ipcMain.handle('chats:switch', (_e, id) => {
  switchChat(id);
  return { id: currentChatId };
});
ipcMain.handle('chats:rename', (_e, { id, title }) => {
  renameChat(id, title);
  return true;
});
ipcMain.handle('chats:delete', (_e, id) => {
  deleteChat(id);
  return { id: currentChatId };
});

// Expande @arquivo / @pasta do workspace, anexando o conteúdo ao prompt (estilo Claude Code)
const FILES_SENTINEL = '\n\n===ARQUIVOS-MENCIONADOS===\n';
// cache curto da árvore do workspace: o walk completo é caro (e em SSHFS é REDE) e rodava
// a CADA mensagem — agora roda no máximo 1x/10s, e SÓ quando a mensagem tem @menção.
let _wsTreeCache = { ws: '', at: 0, tree: [] };
async function cachedWsTree(cfg) {
  const ws = cfg.workspace || '';
  if (!ws) return [];
  const now = Date.now();
  if (_wsTreeCache.ws === ws && now - _wsTreeCache.at < 10000) return _wsTreeCache.tree;
  const tree = [];
  try {
    await walkWorkspace(ws, ws, tree, 0);
  } catch (e) {
    /* árvore parcial serve */
  }
  _wsTreeCache = { ws, at: now, tree };
  return tree;
}
async function expandMentions(text) {
  const cfg = loadConfig();
  if (!text || !cfg.workspace) return { text: text || '', files: [] };
  // 1º extrai as @menções — SEM nenhuma, não toca no disco (antes varria a árvore inteira à toa)
  const re = /(^|\s)@([^\s@]+)/g;
  const found = [];
  let mm;
  while ((mm = re.exec(text))) {
    const p = mm[2].replace(/[.,;:!?)\]]+$/, '');
    if (p && !found.includes(p)) found.push(p);
  }
  if (!found.length) return { text, files: [] };
  const codePct = Math.min(70, Math.max(5, parseInt(cfg.codeBudgetPct, 10) || 35));
  let codeCharsLeft = Math.max(16000, Math.floor((contextLimits(cfg).window * codePct * 3.6) / 100));
  const tree = await cachedWsTree(cfg);
  if (!tree.length) return { text, files: [] };
  const treeSet = new Set(tree);
  const blocks = [];
  const used = [];
  for (const p of found) {
    if (treeSet.has(p)) {
      const fp = safeWsPath(cfg, p);
      if (!fp) continue;
      let content = '';
      try {
        content = fs.readFileSync(fp, 'utf8');
      } catch (e) {
        continue;
      }
      if (codeCharsLeft <= 0) break;
      const take = Math.min(64000, codeCharsLeft);
      const excerpt = truncate(content, take);
      blocks.push('📎 ' + p + ':\n```\n' + excerpt + '\n```');
      codeCharsLeft -= excerpt.length;
      used.push(p);
    } else {
      const prefix = p.replace(/\/+$/, '') + '/';
      const inDir = tree.filter((f) => f.startsWith(prefix));
      if (inDir.length) {
        const listing = inDir.slice(0, 200).join('\n').slice(0, codeCharsLeft);
        if (!listing) break;
        blocks.push('📁 ' + p + '/ — arquivos:\n' + listing);
        codeCharsLeft -= listing.length;
        used.push(p);
      }
    }
  }
  if (!blocks.length) return { text, files: [] };
  return { text: text + FILES_SENTINEL + blocks.join('\n\n'), files: used };
}

// PARALELISMO: cada envio roda NA SESSÃO da conversa da janela (AsyncLocalStorage carrega a
// sessão por todo o turno). Janela presa a outro chat → turno roda EM PARALELO com o fg.
ipcMain.on('chat:send', (_e, payload) => {
  const bound = winChat.get(_e.sender.id);
  const sess = bound && bound !== '*' ? getSession(bound) : fgSession;
  sessionALS.run(sess, () =>
    handleChatSend(_e, payload).catch((err) => {
      logd('chat:send', String((err && err.message) || err));
    })
  );
});
async function handleChatSend(_e, payload) {
  const raw = typeof payload === 'string' ? payload : payload.text || '';
  const images = (payload && payload.images) || [];
  // a IA trabalha na PASTA DESTA JANELA (workspace window) — ou global se a janela não tem pasta própria
  S().workspace = winWorkspace.get(_e.sender.id) || null;
  const cfg = loadConfig();
  const useClaudeCode = cfg.architectMode === true && cfg.codeEngine === 'claude-code';
  // ARQUIVO ATIVO do editor: vira menção automática (chip do chat liga/desliga)
  let raw2 = raw;
  if (cfg.includeActiveTab !== false && activeEditorFile && !raw.includes('@' + activeEditorFile)) {
    raw2 = useClaudeCode ? raw + `\n\nArquivo ativo no editor: ${activeEditorFile}` : raw + '\n@' + activeEditorFile;
  }
  const text = useClaudeCode ? raw2 : (await expandMentions(raw2)).text;
  // chave de API e opcional (proxies locais podem nao exigir)
  // monta o conteudo do usuario (com imagens = visao, formato OpenAI)
  let content = text;
  if (images.length) {
    content = [{ type: 'text', text }];
    images.forEach((url) => content.push({ type: 'image_url', image_url: { url } }));
  }
  // STEERING: se já há um turno em andamento, injeta na conversa atual (não inicia outro)
  if (S().running) {
    S().history.push({ role: 'user', content });
    S().steerQueue.push({ content });
    broadcast('chat:user', { text, images, steer: true });
    return;
  }

  S().history.push({ role: 'user', content });
  broadcast('chat:user', { text, images }); // mostra nas janelas desta conversa
  await runChatTurn(cfg, true);
}

// Roda um turno completo do agente sobre o S().history atual (usado pelo enviar E pelo regenerar)
async function runChatTurn(cfg, popUserOnError) {
  S().running = true;
  S().abort = new AbortController();
  S().cp = { id: 'cp' + ++cpSeq, ts: Date.now(), files: new Map(), bytes: 0 }; // checkpoint deste turno
  beginTurnLog();
  let full = '';
  let turnLogStatus = 'completed';
  try {
    const initialTools = cfg.toolsEnabled === false ? [] : toolSchemas({ delegate: agentsAvailable(cfg) });
    const initialLim = contextLimits(cfg);
    const initialCtx = promptTokenEstimate([{ role: 'system', content: buildSystemPrompt(cfg) }, ...contextMessagesForTurn()], initialTools);
    broadcast('chat:stats', {
      tps: 0,
      out: 0,
      ctx: initialCtx,
      total: initialCtx,
      exact: false,
      live: true,
      phase: 'preparando contexto',
      window: initialLim.window,
      pct: Math.min(999, Math.round((initialCtx / initialLim.window) * 100)),
    });
    if (cfg.architectMode === true && cfg.codeEngine === 'claude-code') {
      full = await runClaudeCodeAgent(cfg);
      broadcast('workspace:changed');
    } else {
      await maybeSummarize(cfg); // garante o orçamento antes da primeira chamada do turno
      full = await runAgent(cfg);
    }
    // EMOÇÃO PRECISA: a Lumi termina respostas com [emoção:x] OU a forma curta [feliz]
    // (ela adora encurtar) → anima o avatar; aceita PT/EN com/sem acento via normalizeEmotion
    let e2 = null;
    const em = /\[emo[cç][aã]o:\s*([^\]]+?)\s*\]/i.exec(full || '');
    if (em) {
      e2 = normalizeEmotion(em[1]);
      full = full.replace(/\s*\[emo[cç][aã]o:[^\]]*\]\s*/gi, ' ').trim();
    }
    // forma curta no FIM da mensagem: só remove se a palavra for emoção conhecida (preciso)
    const tail = /\[\s*([\p{L} ]{2,24})\s*\]\s*$/u.exec((full || '').trim());
    if (tail && normalizeEmotion(tail[1])) {
      e2 = e2 || normalizeEmotion(tail[1]);
      full = full.trim().slice(0, tail.index).trim();
    }
    if (e2) broadcast('tool:animation', e2); // mesmo canal do play_animation → avatar reage
    // turno só-ferramenta pode terminar sem texto — não salva balão vazio no histórico
    if (full && full.trim()) S().history.push({ role: 'assistant', content: full });
    if (S().pendingTurnTranscript) S().pendingTurnTranscript.historyTailCount += full && full.trim() ? 1 : 0;
    finalizeLastTurnContext(full);
    if (!(cfg.architectMode === true && cfg.codeEngine === 'claude-code')) {
      await maybeSummarize(cfg); // Claude Code preserva e compacta a própria sessão
    }
    saveHistory(); // memoria persistente
    broadcast('chat:done');
  } catch (err) {
    if (S().abort && S().abort.signal.aborted) {
      turnLogStatus = 'stopped';
      // parado pelo usuário: salva o que já saiu (não é erro)
      if (full && full.trim()) S().history.push({ role: 'assistant', content: full });
      if (S().pendingTurnTranscript) S().pendingTurnTranscript.historyTailCount += full && full.trim() ? 1 : 0;
      finalizeLastTurnContext(full);
      saveHistory();
      broadcast('chat:done');
    } else {
      turnLogStatus = 'failed';
      S().pendingTurnTranscript = null;
      if (popUserOnError) S().history.pop(); // remove a mensagem do usuario que falhou (no regen não há)
      // descarta eventos do turno que falhou (anchors apontariam pra msgs que não existem mais)
      S().chatEvents = S().chatEvents.filter((e) => (e.t === 'mts' ? e.a < S().history.length : e.a <= S().history.length));
      broadcast('chat:error', String((err && err.message) || err));
      broadcast('tool:animation', 'sad'); // o avatar sente o erro 💔
    }
  } finally {
    finishTurnLog(full, turnLogStatus);
    saveHistory();
    // fecha o checkpoint do turno: se editou arquivos, vira um ponto de restauração
    if (S().cp && S().cp.files.size) {
      checkpoints.push(S().cp);
      if (checkpoints.length > 10) checkpoints.shift();
      broadcast('chat:checkpoint', { id: S().cp.id, count: S().cp.files.size, files: [...S().cp.files.keys()] });
    }
    S().cp = null;
    S().running = false;
    S().abort = null;
    S().steerQueue = [];
  }
}

// Regenerar: descarta a última resposta e roda o turno de novo sobre o mesmo pedido
// (roteado pela sessão da janela — regenerar num chat paralelo mexe SÓ nele)
ipcMain.on('chat:regen', (e0) => {
  const bound = e0 && e0.sender ? winChat.get(e0.sender.id) : null;
  const sess = bound && bound !== '*' ? getSession(bound) : fgSession;
  sessionALS.run(sess, () => handleChatRegen().catch((err) => logd('chat:regen', String((err && err.message) || err))));
});
async function handleChatRegen() {
  if (S().running) return; // não regenera no meio de um turno
  if (!S().history.length || S().history[S().history.length - 1].role !== 'assistant') return;
  S().history.pop();
  if (loadConfig().architectMode === true && loadConfig().codeEngine === 'claude-code') {
    S().claudeSessionId = '';
    S().claudeSessionWorkspace = '';
  }
  S().lastTurnContext = null; // o transcript correspondia à resposta que acabou de ser descartada
  S().pendingTurnTranscript = null;
  // remove os eventos do turno descartado (as ferramentas/horário daquela resposta)
  S().chatEvents = S().chatEvents.filter((e) => e.a < S().history.length);
  broadcast('chat:reload'); // a UI re-renderiza sem a última resposta
  await runChatTurn(loadConfig(), false);
}

// Stop: aborta o turno DA SESSÃO da janela que clicou (paralelos não são afetados)
ipcMain.on('chat:stop', (e0) => {
  const bound = e0 && e0.sender ? winChat.get(e0.sender.id) : null;
  const sess = bound && bound !== '*' ? sessions.get(bound) || (bound === fgSession.id ? fgSession : null) : fgSession;
  if (!sess) return;
  if (sess.claudeQuery) {
    const q = sess.claudeQuery;
    Promise.resolve()
      .then(() => q.interrupt())
      .catch(() => {})
      .finally(() => {
        try {
          q.close();
        } catch (e) {
          /* ok */
        }
      });
  }
  if (sess.abort) {
    try {
      sess.abort.abort();
    } catch (e) {
      /* ok */
    }
  }
  for (const ask of [...pendingAsks.values()]) ask.finish('(o usuário parou a tarefa)'); // destrava loops aguardando resposta
  for (const fin of [...pendingPerms.values()]) fin({ allow: false }); // permissões pendentes = negadas
  sess.steerQueue = [];
  sessionALS.run(sess, () => broadcast('chat:stopped')); // o "parado" vai pras janelas DESSA conversa
});

// ============================================================
//  PROATIVIDADE: a Lumi fala por conta própria (lembretes + companheirismo)
//  Níveis (config.proactivity): off | low (saudação+lembretes) |
//  normal (+volta do idle, pausa 2h) | high (+papo espontâneo, pausa 1h)
// ============================================================
let lastUserActivity = Date.now(); // último movimento do mouse (vem do cursorTimer)
let wasIdle = false;
let lastProactiveAt = 0; // cooldown global (não virar spam)
let sessionStart = Date.now(); // início do período contínuo de uso
let lastBreakNudge = Date.now();
let lastSmallTalk = Date.now();
let lastNightNudge = ''; // "vai dormir não?" — no máximo 1x por noite

// ---- datas especiais: aniversário (se ela souber via fatos) + Natal + Ano Novo ----
const MONTHS_PT = { janeiro: 1, fevereiro: 2, marco: 3, abril: 4, maio: 5, junho: 6, julho: 7, agosto: 8, setembro: 9, outubro: 10, novembro: 11, dezembro: 12 };
function findBirthday() {
  try {
    const txt = loadFacts().map((x) => x.fact).join('\n').toLowerCase();
    const m = /(?:anivers[aá]rio|nasc(?:eu|imento))[^\n.]{0,40}?(\d{1,2})\s*(?:de\s+|\/|-)\s*(\d{1,2}|janeiro|fevereiro|mar[cç]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)/i.exec(txt);
    if (!m) return null;
    const d = parseInt(m[1], 10);
    const raw = m[2].normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const mm = /^\d+$/.test(raw) ? parseInt(raw, 10) : MONTHS_PT[raw];
    return d >= 1 && d <= 31 && mm >= 1 && mm <= 12 ? { d, m: mm } : null;
  } catch (e) {
    return null;
  }
}
async function checkSpecialDates(lvl) {
  if (lvl < 1) return false;
  const todayKey = new Date().toISOString().slice(0, 10);
  if ((loadConfig().lastDateWish || '') === todayKey) return false; // já desejou hoje
  const dNow = new Date();
  let wish = null;
  const bd = findBirthday();
  if (bd && dNow.getDate() === bd.d && dNow.getMonth() + 1 === bd.m) {
    wish = ['Hoje é o ANIVERSÁRIO do usuário! Parabenize com muito carinho e alegria (curto, pode usar emoji).', 'FELIZ ANIVERSÁRIO!! 🎂💜 Que seu dia seja incrível!'];
  } else if (dNow.getDate() === 25 && dNow.getMonth() === 11) {
    wish = ['Hoje é Natal. Deseje um feliz Natal bem curtinho e carinhoso.', 'Feliz Natal! 🎄💚'];
  } else if (dNow.getDate() === 1 && dNow.getMonth() === 0) {
    wish = ['Hoje é 1º de janeiro. Deseje um feliz ano novo bem curtinho e esperançoso.', 'Feliz ano novo! ✨ Que venha um ano lindo!'];
  }
  if (!wish) return false;
  const c = loadConfig();
  c.lastDateWish = todayKey;
  saveConfig(c); // marca ANTES de falar (mesmo se o LLM falhar, não spamma)
  proactiveSay(await proactiveLLM(wish[0], wish[1]), 'happy');
  return true;
}

// ---- app ativo (OPT-IN, Windows): ela percebe o programa em foco e comenta ----
// privacidade: só o NOME do processo e o título da janela — nunca o conteúdo.
let appWatch = null; // processo powershell de longa duração (1 spawn só)
let activeApp = { proc: '', title: '', since: 0 };
let lastAppComment = 0;
let lastAppCommented = '';
let appLongNoticed = '';
const APP_IGNORE =
  /^(|explorer|searchhost|applicationframehost|electron|ai-desktop-mate|lumi|textinputhost|shellexperiencehost|startmenuexperiencehost|lockapp|dwm|taskmgr|plasmashell|gnome-shell|cinnamon|xfdesktop|xfce4-panel|mate-panel|lxpanel|polybar|plank|dock)$/;

function startAppWatcher() {
  if (appWatch) return;
  if (IS_LINUX) return startAppWatcherLinux(); // X11: via xprop
  if (process.platform !== 'win32') return;
  const ps =
    'Add-Type @"\n' +
    'using System; using System.Runtime.InteropServices; using System.Text;\n' +
    'public class FG {\n' +
    '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\n' +
    '[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);\n' +
    '[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder sb, int n);\n' +
    '}\n' +
    '"@\n' +
    'while ($true) {\n' +
    '  try {\n' +
    '    $h = [FG]::GetForegroundWindow()\n' +
    '    $procId = 0; [void][FG]::GetWindowThreadProcessId($h, [ref]$procId)\n' +
    '    $sb = New-Object System.Text.StringBuilder 256\n' +
    '    [void][FG]::GetWindowText($h, $sb, 256)\n' +
    '    $p = (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName\n' +
    '    Write-Output ("$p|" + $sb.ToString())\n' +
    '  } catch {}\n' +
    '  Start-Sleep -Seconds 20\n' +
    '}';
  try {
    appWatch = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    let buf = '';
    appWatch.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const sep = line.indexOf('|');
        if (sep < 0) continue;
        const proc = line.slice(0, sep).toLowerCase().trim();
        const title = line.slice(sep + 1).trim();
        if (proc !== activeApp.proc) activeApp = { proc, title, since: Date.now() };
        else activeApp.title = title;
      }
    });
    appWatch.on('exit', () => {
      appWatch = null;
    });
  } catch (e) {
    appWatch = null;
  }
}
// Linux (X11): xprop lê a janela ativa (classe = nome do app + título) — mesmo formato proc|title
function startAppWatcherLinux() {
  const sh =
    'while true; do\n' +
    '  ID=$(xprop -root _NET_ACTIVE_WINDOW 2>/dev/null | grep -o "0x[0-9a-f]*" | head -1)\n' +
    '  if [ -n "$ID" ] && [ "$ID" != "0x0" ]; then\n' +
    '    CLASS=$(xprop -id "$ID" WM_CLASS 2>/dev/null | sed \'s/.*"\\(.*\\)".*/\\1/\')\n' +
    '    NAME=$(xprop -id "$ID" _NET_WM_NAME 2>/dev/null | sed -n \'s/.*= "\\(.*\\)"$/\\1/p\')\n' +
    '    [ -z "$NAME" ] && NAME=$(xprop -id "$ID" WM_NAME 2>/dev/null | sed -n \'s/.*= "\\(.*\\)"$/\\1/p\')\n' +
    '    echo "$CLASS|$NAME"\n' +
    '  fi\n' +
    '  sleep 20\n' +
    'done';
  try {
    appWatch = spawn('bash', ['-c', sh], { stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = '';
    appWatch.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        const sep = line.indexOf('|');
        if (sep < 0) continue;
        const proc = line.slice(0, sep).toLowerCase().trim();
        const title = line.slice(sep + 1).trim();
        if (proc !== activeApp.proc) activeApp = { proc, title, since: Date.now() };
        else activeApp.title = title;
      }
    });
    appWatch.on('exit', () => {
      appWatch = null; // xprop ausente? morre quieto e a feature fica inerte
    });
  } catch (e) {
    appWatch = null;
  }
}

function stopAppWatcher() {
  if (appWatch) {
    try {
      appWatch.kill();
    } catch (e) {
      /* ok */
    }
    appWatch = null;
    activeApp = { proc: '', title: '', since: 0 };
  }
}

function proactivityLevel() {
  return ['off', 'low', 'normal', 'high'].indexOf(loadConfig().proactivity || 'normal'); // -1/0=off
}

// Fala espontânea: entra no histórico + bolha/chat/TTS pelos canais normais de streaming
function proactiveSay(text, emotion) {
  if (!text || !text.trim() || S().running) return false; // nunca atropela um turno
  S().history.push({ role: 'assistant', content: text });
  broadcast('chat:token', text);
  broadcast('chat:done');
  broadcast('tool:animation', emotion || 'happy');
  saveHistory();
  lastProactiveAt = Date.now();
  return true;
}
// Gera a fala com a persona dela (cai num texto fixo se o provider falhar)
async function proactiveLLM(instruction, fallback) {
  try {
    const cfg = loadConfig();
    const facts = cfg.memoryEnabled !== false ? loadFacts().map((x) => x.fact).slice(-30) : [];
    const out = await llmComplete(cfg, [
      {
        role: 'system',
        content:
          (cfg.systemPrompt || 'Você é a Lumi, uma companheira de desktop calorosa.') +
          '\nGere APENAS uma fala curta (1 a 2 frases), natural e em português, sem aspas e sem prefixos.\n' +
          timeNote() + // ela sabe que horas são (muda o tom: manhã animada, madrugada manhosa)
          (facts.length ? '\nO que você sabe do usuário:\n- ' + facts.join('\n- ') : ''),
      },
      { role: 'user', content: instruction },
    ]);
    const t = (out || '').trim().replace(/^["']|["']$/g, '');
    return t && t.length < 400 ? t : fallback;
  } catch (e) {
    return fallback;
  }
}

// ---- lembretes (persistem em userData/reminders.json — sobrevivem ao fechar) ----
function remindersPath() {
  return path.join(app.getPath('userData'), 'reminders.json');
}
let reminders = [];
let remSeq = 0;
function loadReminders() {
  try {
    reminders = JSON.parse(fs.readFileSync(remindersPath(), 'utf8')) || [];
    remSeq = reminders.reduce((m, r) => Math.max(m, parseInt(String(r.id).slice(1), 10) || 0), 0);
  } catch (e) {
    reminders = [];
  }
}
function saveReminders() {
  try {
    fs.writeFileSync(remindersPath(), JSON.stringify(reminders));
  } catch (e) {
    /* ok */
  }
}
function fmtHour(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// vigia do servidor remoto (opt-in): a cada ~5min checa disco e serviços caídos do host
// montado e a Lumi AVISA (sem virar spam — só quando algo novo fica crítico)
let srvWatchState = { disk: false, failed: '' };
setInterval(async () => {
  if (!loadConfig().watchServer || !remoteMount || S().running || proactivityLevel() < 1) return;
  try {
    const out = await serverRun("echo D:$(df / | awk 'NR==2{print $5}'); echo F:$(systemctl list-units --type=service --state=failed --no-legend --plain 2>/dev/null | wc -l):$(systemctl list-units --type=service --state=failed --no-legend --plain 2>/dev/null | head -3 | awk '{print $1}' | tr '\\n' ' ')", 12000);
    const diskPct = parseInt((/D:(\d+)/.exec(out) || [])[1], 10) || 0;
    const fm = /F:(\d+):(.*)/.exec(out) || [];
    const failedN = parseInt(fm[1], 10) || 0;
    const failedList = (fm[2] || '').trim();
    if (diskPct >= 90 && !srvWatchState.disk) {
      srvWatchState.disk = true;
      proactiveSay(await proactiveLLM('O disco do servidor ' + remoteMount.host + ' está em ' + diskPct + '% — avise com cuidado e sugira liberar espaço.', '⚠ O disco do ' + remoteMount.host + ' tá em ' + diskPct + '%! Bora liberar espaço? 😬'), 'surprised');
    } else if (diskPct < 85) srvWatchState.disk = false; // histerese: só re-avisa se cair e subir de novo
    if (failedN > 0 && failedList !== srvWatchState.failed) {
      srvWatchState.failed = failedList;
      proactiveSay(await proactiveLLM('Serviço(s) com falha no servidor ' + remoteMount.host + ': ' + failedList + '. Avise e ofereça ajuda (ver logs/reiniciar).', '⚠ Caiu serviço no ' + remoteMount.host + ': ' + failedList + ' — quer que eu veja os logs?'), 'sad');
    } else if (failedN === 0) srvWatchState.failed = '';
  } catch (e) {
    /* servidor inacessível no momento — ignora */
  }
}, 300000);

// loop dos lembretes: dispara os vencidos (espera o turno atual acabar, se houver)
setInterval(() => {
  if (!reminders.length || S().running) return;
  const now = Date.now();
  const due = reminders.filter((r) => r.at <= now);
  if (!due.length) return;
  reminders = reminders.filter((r) => r.at > now);
  saveReminders();
  due.forEach((r, i) => {
    const late = now - r.at > 10 * 60000; // app esteve fechado?
    setTimeout(() => proactiveSay((late ? '⏰ (atrasado, eu estava fechada) Lembrete: ' : '⏰ Lembrete: ') + r.message, 'surprised'), i * 4000);
  });
}, 15000);

// ============================================================
//  🛡️ SENTINELA DE LOGS DO SISTEMA (opt-in: config.logSentinel)
//  Lê os erros do SO (Event Log/journalctl/log show), correlaciona com os
//  processos em execução (quem lançou, com que comando) e: avisa (notify)
//  ou dispara a investigação sozinha se o erro parecer do projeto (fix).
// ============================================================
// HISTÓRICO de processos (acumula entre varreduras): nome → { cmd, last }. Assim, um app/jogo
// que CRASHOU e já morreu continua correlacionável ("de onde veio, com que comando foi aberto").
let procSnapshot = new Map();
function procRemember(name, cmd) {
  const k = String(name || '').toLowerCase();
  if (!k || !cmd) return;
  procSnapshot.set(k, { cmd: String(cmd).slice(0, 300), last: Date.now() });
  if (procSnapshot.size > 700) {
    // esquece os mais antigos (mapa preserva ordem de inserção; re-inserir atualiza a posição)
    const oldest = [...procSnapshot.entries()].sort((a, b) => a[1].last - b[1].last).slice(0, 200);
    for (const [k2] of oldest) procSnapshot.delete(k2);
  }
}
function procLaunchOf(name) {
  const r = procSnapshot.get(String(name || '').toLowerCase());
  return r ? r.cmd : null;
}
async function refreshProcessSnapshot() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object Name,CommandLine | ConvertTo-Json -Compress"',
        { timeout: 20000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }
      );
      const arr = JSON.parse(stdout || '[]');
      for (const p of Array.isArray(arr) ? arr : [arr]) {
        if (p && p.Name && p.CommandLine) procRemember(p.Name, p.CommandLine);
      }
    } else {
      const { stdout } = await execAsync(process.platform === 'darwin' ? 'ps -axo comm=,args=' : 'ps -eo comm:32,args --no-headers', { timeout: 15000, maxBuffer: 8 * 1024 * 1024, windowsHide: true });
      for (const l of stdout.split('\n')) {
        const name = l.slice(0, 32).trim();
        const args = l.slice(32).trim();
        if (name && args) procRemember(name, args);
      }
    }
  } catch (e) {
    /* snapshot é best-effort */
  }
}
// lê os erros/avisos recentes do SISTEMA (multi-OS) → entradas estruturadas
async function readSystemLogs(minutes, level) {
  const mins = Math.max(5, Math.min(parseInt(minutes, 10) || 60, 24 * 60));
  const entries = [];
  if (process.platform === 'win32') {
    const levels = level === 'warning' ? '@(1,2,3)' : '@(1,2)';
    // try/catch DENTRO do PS: sem eventos na janela, Get-WinEvent "falha" (exit 1) — devolve [] em vez de estourar
    const ps =
      'try { Get-WinEvent -FilterHashtable @{LogName=@(\'Application\',\'System\'); Level=' + levels + '; StartTime=(Get-Date).AddMinutes(-' + mins + ')} -MaxEvents 60 -ErrorAction Stop | ' +
      'Select-Object @{n=\'time\';e={$_.TimeCreated.ToString(\'s\')}},@{n=\'source\';e={$_.ProviderName}},Id,LevelDisplayName,Message | ConvertTo-Json -Compress } catch { \'[]\' }';
    const { stdout } = await execAsync('powershell -NoProfile -Command "' + ps.replace(/"/g, '\\"') + '"', { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
    let arr = [];
    try {
      arr = JSON.parse(stdout || '[]');
    } catch (e) {
      arr = [];
    }
    for (const ev of Array.isArray(arr) ? arr : [arr]) {
      if (!ev) continue;
      entries.push({ time: ev.time, source: ev.source, id: ev.Id, level: ev.LevelDisplayName, message: String(ev.Message || '').replace(/\s+/g, ' ').slice(0, 500) });
    }
  } else if (process.platform === 'linux') {
    const pri = level === 'warning' ? 'warning' : 'err';
    const { stdout } = await execAsync(`journalctl --no-pager -p ${pri} --since "${mins} min ago" -n 150 -o short-iso 2>/dev/null || true`, { timeout: 15000, maxBuffer: 8 * 1024 * 1024 });
    for (const l of stdout.split('\n')) {
      const m = l.match(/^(\S+)\s+\S+\s+([^:\[]+)(?:\[\d+\])?:\s+(.+)$/);
      if (m) entries.push({ time: m[1], source: m[2].trim(), level: 'error', message: m[3].slice(0, 500) });
    }
  } else {
    const { stdout } = await execAsync(`log show --last ${mins}m --predicate 'messageType == error' --style syslog 2>/dev/null | tail -n 150`, { timeout: 30000, maxBuffer: 8 * 1024 * 1024 });
    for (const l of stdout.split('\n')) {
      const m = l.match(/^(\S+ \S+)\s+\S*\s*(\S+)\s+.*?:\s*(.+)$/);
      if (m) entries.push({ time: m[1], source: m[2], level: 'error', message: m[3].slice(0, 500) });
    }
  }
  // correlação: liga o erro ao programa (exe citado, caminho completo ou a própria origem)
  // e anexa COMO ele foi lançado (linha de comando do histórico de processos)
  for (const e of entries) {
    const msg = String(e.message || '');
    const pathM = msg.match(/([A-Za-z]:\\[^,;"']+\.exe)/i); // caminho completo (ex.: eventos 1000 de crash)
    if (pathM) e.appPath = pathM[1];
    const exeM = msg.match(/([\w .-]+?\.exe)/i);
    const keys = [exeM && exeM[1] ? exeM[1].trim() : null, pathM ? path.basename(pathM[1]) : null, e.source].filter(Boolean);
    for (const k of keys) {
      const launch = procLaunchOf(k);
      if (launch) {
        e.launch = launch;
        break;
      }
    }
  }
  return { entries: entries.slice(0, 60) };
}
let sentinelSeen = new Set(); // assinaturas já tratadas (não re-alertar/re-perguntar o mesmo erro)
let sentinelAsking = false; // no máx. 1 card de confirmação pendente por vez
let sentinelQueued = null; // investigação aprovada esperando o agente ficar livre
function sentinelBrief(list) {
  return list
    .slice(0, 2)
    .map((e) => '[' + (e.time || '') + ' ' + (e.source || '') + (e.id ? '#' + e.id : '') + '] ' + compactText(e.message, 450) + (e.appPath ? '\n(app: ' + e.appPath + ')' : '') + (e.launch ? '\n(lançado com: ' + e.launch + ')' : ''))
    .join('\n\n');
}
async function logSentinelSweep() {
  const cfg = loadConfig();
  if (cfg.logSentinel !== 'notify' && cfg.logSentinel !== 'fix') return;
  try {
    await refreshProcessSnapshot(); // atualiza o histórico "programa → como foi lançado"
    const { entries } = await readSystemLogs(35, 'error');
    const fresh = entries.filter((e) => {
      const k = (e.source || '') + '|' + (e.id || '') + '|' + String(e.message || '').slice(0, 100);
      if (sentinelSeen.has(k)) return false;
      sentinelSeen.add(k);
      return true;
    });
    if (sentinelSeen.size > 600) sentinelSeen = new Set([...sentinelSeen].slice(-300));
    if (!fresh.length) return;
    const ws = cfg.workspace || '';
    const wsName = ws ? path.basename(ws).toLowerCase() : '';
    const related = wsName
      ? fresh.filter((e) => {
          const m = (String(e.message || '') + ' ' + String(e.launch || '') + ' ' + String(e.appPath || '')).toLowerCase();
          return m.includes(wsName) || (ws && m.includes(ws.toLowerCase().replace(/\\/g, '/')));
        })
      : [];
    // TRIAGEM por IA (modelo de tarefa, best-effort): o que houve, dá pra evitar, é do projeto?
    let triage = '';
    try {
      const t = await llmComplete(cfg, [
        {
          role: 'system',
          content:
            'Você triageia erros do sistema operacional pro usuário em 1-2 frases diretas (português): o que aconteceu, se é grave/ignorável, e se dá pra PREVENIR algo. Sem tecniquês desnecessário, sem markdown.',
        },
        { role: 'user', content: fresh.slice(0, 5).map((e) => (e.source || '?') + ': ' + compactText(e.message, 220) + (e.launch ? ' (lançado: ' + compactText(e.launch, 100) + ')' : '')).join('\n') },
      ]);
      triage = String(t || '').trim().slice(0, 380);
    } catch (e) {
      triage = fresh.slice(0, 3).map((e) => (e.source || '?') + ': ' + compactText(e.message, 110)).join(' · ');
    }
    broadcast('chat:note', {
      text: '🛡️ Sentinela: ' + fresh.length + ' erro(s) novo(s) no sistema' + (related.length ? ' — ' + related.length + ' parece(m) do SEU projeto' : '') + '. ' + triage,
    });
    // modo FIX: erro do projeto → CARD com botão. NUNCA age sem o "sim" do usuário.
    if (cfg.logSentinel === 'fix' && related.length && !sentinelAsking) {
      sentinelAsking = true;
      const brief = sentinelBrief(related);
      askUserInChat('🛡️ Sentinela: erro(s) do sistema que parecem do SEU projeto:\n\n' + brief + '\n\nQuer que eu investigue e corrija?', ['🔍 Investigar e corrigir agora', 'Ignorar'], {
        timeoutMs: 15 * 60000,
        fallback: 'Ignorar',
      })
        .then((answer) => {
          sentinelAsking = false;
          if (!/investigar/i.test(String(answer || ''))) return; // só age com o SIM explícito
          const msg = {
            text:
              '[🛡️ sentinela — APROVADO pelo usuário] Investigue estes erros do sistema relacionados ao projeto:\n\n' + brief +
              '\n\nAche a causa NO PROJETO e corrija se aplicável (system_logs/locate_stack/get_problems ajudam). Se concluir que NÃO é do projeto, explique em 1-2 linhas e pare.',
          };
          if (S().running) sentinelQueued = msg; // espera o turno atual acabar (dispatcher abaixo)
          else ipcMain.emit('chat:send', { sender: { id: -9, send: () => {} } }, msg);
        })
        .catch(() => {
          sentinelAsking = false;
        });
    }
  } catch (e) {
    logd('logSentinel', String((e && e.message) || e));
  }
}
setInterval(logSentinelSweep, 30 * 60 * 1000); // varre a cada 30 min (no-op quando desligada)
setTimeout(logSentinelSweep, 4 * 60 * 1000); // primeira varredura ~4 min após abrir (pega o que aconteceu antes)
// investigação aprovada com agente ocupado → dispara assim que ele liberar
setInterval(() => {
  if (sentinelQueued && !S().running) {
    const msg = sentinelQueued;
    sentinelQueued = null;
    ipcMain.emit('chat:send', { sender: { id: -9, send: () => {} } }, msg);
  }
}, 60 * 1000);

// loop do companheirismo (1x/min)
setInterval(async () => {
  const lvl = proactivityLevel();
  if (lvl <= 0) {
    stopAppWatcher();
    return;
  }
  // watcher do app ativo liga/desliga conforme a config (opt-in; Windows e Linux/X11)
  const cfgNow = loadConfig();
  if (cfgNow.reactApps && lvl >= 2 && (process.platform === 'win32' || IS_LINUX)) startAppWatcher();
  else stopAppWatcher();
  const now = Date.now();
  const idleMin = (now - lastUserActivity) / 60000;
  if (idleMin > 30) {
    wasIdle = true; // usuário longe — só observa
    return;
  }
  if (wasIdle) {
    // acabou de voltar
    wasIdle = false;
    sessionStart = now;
    lastBreakNudge = now;
    if (lvl >= 2 && now - lastProactiveAt > 20 * 60000) {
      proactiveSay(await proactiveLLM('O usuário acabou de voltar ao computador depois de um tempo fora. Dê boas-vindas bem curtinhas e calorosas.', 'Bem-vindo de volta! 💚'));
    }
    return;
  }
  // datas especiais (aniversário/Natal/ano novo) — uma vez por dia, antes de tudo
  if (await checkSpecialDates(lvl)) return;
  // madrugada (00h–04h59): UMA cutucada carinhosa por noite pra ir dormir
  const hourNow = new Date().getHours();
  if (lvl >= 2 && hourNow < 5 && new Date().toDateString() !== lastNightNudge && now - lastProactiveAt > 20 * 60000) {
    lastNightNudge = new Date().toDateString();
    proactiveSay(
      await proactiveLLM('Já é madrugada (' + hourNow + 'h) e o usuário continua acordado no computador. Faça UM comentário carinhoso e levinho sobre descansar — sem sermão, com humor.', 'Já é madrugada… vai dormir não? 👀💚'),
      'relaxed'
    );
    return;
  }
  // cuidado: pausa após uso contínuo (normal: 2h · tagarela: 1h)
  const limitMin = lvl >= 3 ? 60 : 120;
  if (lvl >= 2 && (now - sessionStart) / 60000 >= limitMin && (now - lastBreakNudge) / 60000 >= limitMin && now - lastProactiveAt > 20 * 60000) {
    lastBreakNudge = now;
    const horas = Math.round(((now - sessionStart) / 3600000) * 10) / 10;
    proactiveSay(
      await proactiveLLM('O usuário está há ' + horas + ' horas direto no computador. Sugira carinhosamente (sem sermão) uma pausa rápida — água, alongar, descansar os olhos.', 'Ei, você tá há um tempão aí… bora esticar as pernas e beber uma água? 💚'),
      'relaxed'
    );
    return;
  }
  // reação ao app ativo (opt-in): trocou de app e ficou nele → um comentário leve (cooldown 45min)
  if (cfgNow.reactApps && lvl >= 2 && activeApp.proc && !APP_IGNORE.test(activeApp.proc)) {
    const inAppMin = (now - activeApp.since) / 60000;
    if (activeApp.proc !== lastAppCommented && inAppMin >= 3 && inAppMin < 30 && now - lastAppComment > 45 * 60000 && now - lastProactiveAt > 20 * 60000) {
      lastAppCommented = activeApp.proc;
      lastAppComment = now;
      const t = await proactiveLLM(
        'O usuário está usando o app "' + activeApp.proc + '" (janela: "' + String(activeApp.title).slice(0, 80) + '"). Faça UM comentário curtinho, leve e contextual — é companhia, não suporte técnico.',
        ''
      );
      if (t) proactiveSay(t);
      return;
    }
    // tá há HORAS no mesmo app (ex.: 2h de YouTube 👀) → percebe uma vez
    if (inAppMin >= 120 && appLongNoticed !== activeApp.proc + activeApp.since && now - lastProactiveAt > 20 * 60000) {
      appLongNoticed = activeApp.proc + activeApp.since;
      const t = await proactiveLLM(
        'O usuário está há ' + (Math.round((inAppMin / 60) * 10) / 10) + ' horas seguidas no app "' + activeApp.proc + '". Comente de leve, com carinho/humor (ex.: tá rendendo? 👀) — sem sermão.',
        ''
      );
      if (t) proactiveSay(t);
      return;
    }
  }
  // papo espontâneo (só no nível tagarela, a cada ~90min)
  if (lvl >= 3 && (now - lastSmallTalk) / 60000 >= 90 && now - lastProactiveAt > 20 * 60000) {
    lastSmallTalk = now;
    const t = await proactiveLLM('Puxe um assunto leve e CURTO com o usuário — algo que você sabe sobre ele, uma curiosidade, ou só um carinho. Não ofereça ajuda técnica; é só companhia.', '');
    if (t) proactiveSay(t);
  }
}, 60000);

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopAppWatcher(); // encerra o powershell do app ativo
  if (remoteMount) unmountRemote().catch(() => {}); // best-effort: solta o SSHFS
  dbClose().catch(() => {}); // fecha conexão de banco
  if (cursorTimer) clearInterval(cursorTimer);
  if (hookOk) {
    try {
      uIOhook.stop();
    } catch (e) {
      /* ok */
    }
  }
});
