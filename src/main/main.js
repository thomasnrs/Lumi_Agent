const { app, BrowserWindow, ipcMain, globalShortcut, screen, Menu, Tray, nativeImage, session, shell, dialog, desktopCapturer, clipboard } = require('electron');
const path = require('path');
// Em produção (empacotado) os recursos ficam em process.resourcesPath; em dev, na raiz.
function resBase() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, '..', '..');
}
const ICON_PATH = path.join(resBase(), 'icone.png'); // ícone do app
const fs = require('fs');
const url = require('url');
const crypto = require('crypto');
const WebSocket = require('ws');
const { exec } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);

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
let chatEvents = []; // [{a: nº de msgs no history quando ocorreu, t: tipo, d: dados, ts}]
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
      // carimbo de hora da mensagem recém-adicionada ao history (sem duplicar)
      const a = history.length - 1;
      if (a >= 0 && !chatEvents.some((e) => e.t === 'mts' && e.a === a)) chatEvents.push({ a, t: 'mts', ts: Date.now() });
      return;
    }
    const map = { 'chat:tool': 'tool', 'chat:tool-result': 'result', 'chat:agent': 'agent', 'chat:diff': 'diff' };
    const t = map[channel];
    if (!t) return;
    chatEvents.push({ a: history.length, t, d: slimVal(payload, 0), ts: Date.now() });
    if (chatEvents.length > 400) chatEvents = chatEvents.slice(-400);
  } catch (e) {
    /* nunca pode derrubar o broadcast */
  }
}

function broadcast(channel, ...args) {
  logChatEvent(channel, args[0]); // grava na linha do tempo do chat (quando for evento de chat)
  BrowserWindow.getAllWindows().forEach((w) => {
    if (w.isDestroyed()) return;
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

// ============================================================
//  Configuracao (BYOK - o usuario traz a propria chave)
// ============================================================
const DEFAULT_CONFIG = {
  provider: 'openai', // 'openai' (compativel) ou 'anthropic'
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
  theme: {}, // cores customizadas da UI (tokens CSS) - editor na aba Tema
  acrylic: true, // efeito vidro nativo do Windows 11 nas janelas (se disponivel)
  sounds: true, // sons sutis do chat (enviar/receber) - toggle no painel rapido
  modelsCache: {}, // cache da lista de modelos por provedor (evita refazer a busca)
  toolsEnabled: true, // ferramentas/agente (requer modelo compativel)
  memoryEnabled: true, // memoria persistente (fatos no contexto + historico em disco)
  architectMode: false, // modo arquiteto (codigo) com memoria por workspace
  workspace: '', // pasta do projeto atual
  selectedVrm: '', // personagem escolhido (nome do .vrm em assets/; vazio = o primeiro)
  autoVerify: false, // após editar arquivos, roda o comando de verificação e corrige se falhar
  verifyCommand: '', // comando de verificação (vazio = detecta da stack: npm test, pytest...)
  imageModel: 'sourceful/riverflow-v2.5-fast:free', // modelo para gerar imagens (OpenRouter)
  imageBaseUrl: '', // provedor de imagem (vazio = usa o do chat)
  imageApiKey: '', // chave do provedor de imagem (vazio = usa a do chat)
  // busca na web
  searchProvider: 'duckduckgo', // 'tavily' (preciso) | 'brave' | 'duckduckgo' (sem chave)
  searchApiKey: '',
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
        'Você é uma engenheira de software sênior. Implemente a tarefa de ponta a ponta: leia o código relevante antes, faça a mudança mínima necessária seguindo o padrão do projeto, e VERIFIQUE rodando o comando/teste pertinente. Ao final, resuma o que fez em poucas linhas.',
      model: '',
      temperature: 0.3,
      tools: ['list_dir', 'read_file', 'write_file', 'append_file', 'make_dir', 'delete_file', 'run_command', 'web_search', 'read_project_memory', 'update_project_memory'],
    },
    {
      name: 'Revisor',
      description: 'Revisa código/textos (somente leitura) e aponta melhorias.',
      systemPrompt:
        'Você é um revisor crítico e construtivo. Leia o material com atenção e aponte bugs, riscos, problemas de segurança/performance e melhorias CONCRETAS (com o porquê e como corrigir). Priorize o que importa. NÃO altere arquivos — apenas analise e recomende.',
      model: '',
      temperature: 0.3,
      tools: ['list_dir', 'read_file', 'read_project_memory'],
    },
    {
      name: 'Testador',
      description: 'Escreve e roda testes; relata o que passou/falhou.',
      systemPrompt:
        'Você é uma engenheira de QA. Entenda o que precisa ser testado, escreva testes claros (seguindo o framework de testes do projeto) e RODE-OS com run_command. Relate o que passou e o que falhou, com a causa provável das falhas. Não conserte o código de produção sem ser pedido — foque em cobrir e diagnosticar.',
      model: '',
      temperature: 0.3,
      tools: ['list_dir', 'read_file', 'write_file', 'append_file', 'run_command', 'read_project_memory'],
    },
    {
      name: 'Refatorador',
      description: 'Melhora o código SEM mudar o comportamento.',
      systemPrompt:
        'Você é uma engenheira especialista em refatoração. Melhore legibilidade, organização e qualidade do código SEM alterar o comportamento externo. Faça mudanças pequenas e seguras, mantendo o padrão do projeto, e VERIFIQUE com o comando/teste pertinente para garantir que nada quebrou. Explique cada melhoria brevemente.',
      model: '',
      temperature: 0.3,
      tools: ['list_dir', 'read_file', 'write_file', 'append_file', 'run_command', 'read_project_memory', 'update_project_memory'],
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
      tools: ['list_dir', 'read_file', 'write_file', 'append_file', 'make_dir', 'web_search', 'generate_image', 'read_project_memory'],
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

function loadConfig() {
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(configPath(), 'utf8')) };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
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

// Padrao OpenAI -> cobre OpenAI, OpenRouter, Qwen, Groq, DeepSeek, Ollama local, etc.
async function streamOpenAI(cfg, history, onToken) {
  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const messages = [{ role: 'system', content: buildSystemPrompt(cfg) }, ...history];
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      temperature: cfg.temperature,
      stream: true,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  await readSSE(res, (data) => {
    if (data === '[DONE]') return;
    try {
      const j = JSON.parse(data);
      const t = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (t) onToken(t);
    } catch (e) {
      /* ignora linhas que nao sao JSON */
    }
  });
}

// Converte o historico (formato OpenAI) para o formato de imagens do Anthropic
function toAnthropicMessages(history) {
  return history.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, content: m.content };
    const parts = m.content.map((p) => {
      if (p.type === 'image_url') {
        const mt = /^data:([^;]+);base64,(.*)$/.exec(p.image_url.url);
        if (mt) return { type: 'image', source: { type: 'base64', media_type: mt[1], data: mt[2] } };
      }
      return { type: 'text', text: p.text || '' };
    });
    return { role: m.role, content: parts };
  });
}

// Padrao Anthropic (Claude) -> formato proprio
async function streamAnthropic(cfg, history, onToken) {
  const base = (cfg.baseUrl || 'https://api.anthropic.com/v1').replace(/\/$/, '');
  const res = await fetch(base + '/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cfg.apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: cfg.model,
      system: buildSystemPrompt(cfg),
      messages: toAnthropicMessages(history),
      max_tokens: 1024,
      temperature: cfg.temperature,
      stream: true,
    }),
    signal: chatAbort ? chatAbort.signal : undefined, // botão Stop
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  await readSSE(res, (data) => {
    try {
      const j = JSON.parse(data);
      if (j.type === 'content_block_delta' && j.delta && j.delta.text) onToken(j.delta.text);
    } catch (e) {
      /* ignora */
    }
  });
}

function streamChat(cfg, history, onToken) {
  return cfg.provider === 'anthropic'
    ? streamAnthropic(cfg, history, onToken)
    : streamOpenAI(cfg, history, onToken);
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
  '1. ENTENDA antes de mexer: leia os arquivos relevantes (read_file/list_dir) e siga os imports/usos para entender o código DE VERDADE. Não invente APIs nem suponha assinaturas — confirme no código.\n' +
  '2. SIGA o padrão do projeto: imite o estilo, a nomenclatura, a formatação e as bibliotecas que já existem. Não introduza padrões/dependências novas sem necessidade clara.\n' +
  '3. Mudanças FOCADAS e mínimas: resolva exatamente a tarefa, sem reescrever o que não precisa e sem quebrar o que já funciona. Prefira o menor diff que resolve.\n' +
  '4. Para CRIAR ou EDITAR arquivos use SEMPRE write_file / append_file (e read_file antes, pra não sobrescrever errado). NUNCA use echo/Set-Content/cat no terminal para escrever arquivos — isso some com o diff e dessincroniza o editor.\n' +
  '5. VERIFIQUE o seu trabalho: depois de editar, releia o trecho alterado ou rode o comando/teste/lint/build pertinente (run_command) e LEIA a saída. Se der erro, leia a mensagem e corrija a CAUSA RAIZ — não chute repetidamente.\n' +
  '6. Caminhos SEMPRE relativos ao workspace.\n' +
  '7. Quando não souber algo (lib, versão atual, API, erro estranho), use web_search em vez de adivinhar.\n' +
  '8. Seja CONCISA e direta: explique decisões importantes em poucas linhas; o foco é a ação e o resultado, não textão. Mostre o progresso em passos pequenos (os diffs aparecem no chat).\n' +
  '9. Segurança: não rode comandos destrutivos sem motivo claro; confirme antes de apagar/sobrescrever coisas importantes.\n' +
  '10. Depois de mudanças relevantes, ATUALIZE a memória do projeto com update_project_memory (visão geral, arquitetura, decisões, estrutura de arquivos e tarefas pendentes) — é isso que mantém seu contexto entre sessões/chats novos.';

// Detecta a stack do projeto (pelos arquivos-chave) + sugere um comando de verificação
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
  '- Tome iniciativa: se faltar um passo óbvio, faça; se algo der errado, conserte a causa em vez de só relatar.';

// Monta o system prompt com os fatos memorizados + (opcional) memoria do projeto
// SO da máquina — pro modelo gerar comandos certos (PowerShell no Windows, bash no Linux)
const OS_NOTE =
  process.platform === 'win32'
    ? 'Sistema operacional: Windows (terminal = PowerShell/cmd; caminhos com \\).'
    : process.platform === 'linux'
      ? 'Sistema operacional: Linux (terminal = bash; use ls/grep/apt, NUNCA comandos de Windows).'
      : 'Sistema operacional: macOS (terminal = zsh/bash).';

function buildSystemPrompt(cfg) {
  let sp = (cfg.systemPrompt || '') + '\n\n' + COMPANION_BASE + '\n' + OS_NOTE;
  if (cfg.memoryEnabled !== false) {
    const facts = loadFacts().map((x) => x.fact).slice(-50);
    if (facts.length) {
      sp += '\n\n# O que você lembra sobre o usuário (use naturalmente):\n' + facts.map((f) => '- ' + f).join('\n');
    }
  }
  if (convSummary) {
    sp += '\n\n# Resumo da conversa até aqui (contexto anterior já compactado):\n' + convSummary;
  }
  // MODO ARQUITETO: injeta a memoria do projeto (contexto que sobrevive a chats novos)
  if (cfg.architectMode && cfg.workspace) {
    let mem = '';
    try {
      mem = fs.readFileSync(workspaceMemoryPath(cfg), 'utf8');
    } catch (e) {
      mem = '(memória do projeto ainda vazia — crie uma com update_project_memory)';
    }
    const det = detectStack(cfg.workspace);
    let proj = `\n\n# Projeto atual\nWorkspace: ${cfg.workspace}`;
    if (det.stack) proj += `\nStack detectada: ${det.stack}`;
    if (det.verify) proj += `\nComando sugerido para VERIFICAR suas mudanças: \`${det.verify}\` (rode com run_command e leia a saída antes de dizer que terminou).`;
    if (det.guide) proj += `\n\n## Boas práticas desta stack (siga-as)\n${det.guide}`;
    sp += '\n\n' + CODING_GUIDE + proj + `\n\n## Memória do projeto (.lumi-memory.md):\n${mem}`;
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

async function checkPermission(category, summary) {
  if (!category) return true; // ferramenta segura, sem necessidade de permissao
  const cfg = loadConfig();
  const mode = (cfg.perms && cfg.perms[category]) || 'ask';
  if (mode === 'allow') return true;
  if (mode === 'deny') return false;
  // 'ask' -> dialogo nativo, com opcao de "sempre permitir" (bypass) por categoria
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

  // DuckDuckGo (sem chave) — parser do HTML "lite". Básico, mas funciona out-of-box.
  const res = await fetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36' },
  });
  if (!res.ok) return { error: `DuckDuckGo HTTP ${res.status}` };
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
}

// diff por linha (LCS) -> [{t:' '|'+'|'-', v}]; transmite pro chat ao editar arquivos
function lineDiff(oldStr, newStr) {
  const a = (oldStr || '').split('\n');
  const b = (newStr || '').split('\n');
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) out.push({ t: ' ', v: a[i++], j: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', v: a[i++] });
    else out.push({ t: '+', v: b[j++] });
  }
  while (i < m) out.push({ t: '-', v: a[i++] });
  while (j < n) out.push({ t: '+', v: b[j++] });
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

// Registro de ferramentas: schema (pro modelo) + category (permissao) + run (execucao)
const TOOLS = {
  get_datetime: {
    category: null,
    schema: { name: 'get_datetime', description: 'Retorna a data e a hora atuais do PC.', parameters: { type: 'object', properties: {} } },
    run: async () => ({ datetime: new Date().toLocaleString('pt-BR') }),
  },
  play_animation: {
    category: null,
    schema: {
      name: 'play_animation',
      description: 'Faz a avatar reagir com uma emoção. Valores: happy, sad, angry, surprised, blush.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
    },
    run: async ({ name }) => {
      broadcast('tool:animation', String(name || '').toLowerCase());
      return { played: name };
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
      description: 'Lê a memória do projeto atual (.lumi-memory.md no workspace). Use no início para retomar o contexto.',
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
        'Salva/atualiza a memória do projeto (.lumi-memory.md). Inclua visão geral, arquitetura, decisões, estrutura de arquivos e tarefas pendentes.',
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
      const newC = String(content || '');
      fs.writeFileSync(fp, newC);
      broadcastDiff('.lumi-memory.md', oldC, newC); // mostra no chat o que ela resumiu/mudou
      return { ok: true };
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
    summary: (a) => `ler o arquivo "${a.path}"`,
    schema: {
      name: 'read_file',
      description: 'Lê o conteúdo de um arquivo de texto.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
    run: async ({ path: p }) => {
      const txt = fs.readFileSync(resolvePath(p), 'utf8');
      return { content: truncate(txt, 24000), truncated: txt.length > 24000 };
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
      let oldC = '';
      try {
        oldC = fs.readFileSync(fp, 'utf8');
      } catch (e) {
        /* arquivo novo */
      }
      const newC = content == null ? '' : String(content);
      fs.writeFileSync(fp, newC);
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
      let oldC = '';
      try {
        oldC = fs.readFileSync(fp, 'utf8');
      } catch (e) {
        /* novo */
      }
      const add = String(content || '');
      fs.appendFileSync(fp, add);
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
      fs.rmSync(resolvePath(p), { recursive: true, force: true });
      return { deleted: resolvePath(p) };
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
      try {
        const { stdout, stderr } = await execAsync(String(command), {
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
      description: 'Faz uma requisição HTTP e retorna o corpo (texto). Útil para buscar dados/APIs.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' },
          method: { type: 'string', description: 'GET (padrão) ou POST' },
          body: { type: 'string' },
        },
        required: ['url'],
      },
    },
    run: async ({ url, method, body }) => {
      const res = await fetch(url, {
        method: method || 'GET',
        body: body || undefined,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
      });
      const t = await res.text();
      return { status: res.status, body: truncate(t, 16000) };
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

let editedSinceTurn = false; // algum arquivo foi escrito neste turno? (p/ verificação automática)
let chatAbort = null; // AbortController do turno atual (botão Stop)
let agentRunning = false; // há um turno do agente em andamento?
let steerQueue = []; // mensagens enviadas DURANTE o processamento (steering)
const WRITE_TOOLS = ['write_file', 'append_file', 'make_dir', 'delete_file'];
async function runTool(name, args) {
  const a = args || {};
  // ferramenta MCP?
  const mt = mcpTools.find((t) => t.fn === name);
  if (mt) {
    const ok = await checkPermission('mcp', `usar ${mt.toolName} (servidor ${mt.server})`);
    if (!ok) return { error: 'permissão negada pelo usuário (mcp)' };
    try {
      const res = await mcpClients[mt.server].callTool({ name: mt.toolName, arguments: a });
      const text = (res.content || [])
        .map((c) => (c.type === 'text' ? c.text : `[${c.type}]`))
        .join('\n');
      return { content: truncate(text, 8000), isError: !!res.isError };
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  }
  // ferramenta nativa
  const t = TOOLS[name];
  if (!t) return { error: 'ferramenta desconhecida: ' + name };
  const ok = await checkPermission(t.category, t.summary ? t.summary(a) : null);
  if (!ok) return { error: `permissão negada pelo usuário (${t.category})` };
  try {
    const res = await t.run(a);
    if (WRITE_TOOLS.includes(name) && !(res && res.error)) editedSinceTurn = true; // p/ verificação automática
    return res;
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
}

// VERIFICAÇÃO AUTOMÁTICA: roda o comando do projeto após edições e devolve o resultado.
// Retorna true se FALHOU (o orquestrador deve pedir correção ao modelo).
async function maybeAutoVerify(cfg, messages) {
  if (cfg.autoVerify !== true || !cfg.workspace || !editedSinceTurn) return false;
  if ((cfg.perms || {}).exec === 'deny') return false;
  const cmd = (cfg.verifyCommand && cfg.verifyCommand.trim()) || detectStack(cfg.workspace).verify;
  if (!cmd) return false;
  editedSinceTurn = false; // consome (só verifica de novo se editar de novo)
  broadcast('chat:tool', { name: 'run_command', args: { command: cmd }, agent: '🔁 auto-verificação' });
  let r;
  try {
    const { stdout, stderr } = await execAsync(cmd, { cwd: cfg.workspace, timeout: 180000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    r = { ok: true, output: truncate((stdout || '') + (stderr || ''), 4000) };
  } catch (e) {
    r = { ok: false, output: truncate((e.stdout || '') + '\n' + (e.stderr || '') + '\n' + (e.message || ''), 8000) };
  }
  broadcast('chat:tool-result', { name: 'run_command', args: { command: cmd }, result: { ok: r.ok, output: r.output }, agent: '🔁 auto-verificação' });
  if (r.ok) return false; // passou -> nada a corrigir
  broadcast('chat:newbubble'); // separa a próxima resposta (a correção) num balão novo
  messages.push({
    role: 'user',
    content: `[verificação automática] O comando \`${cmd}\` FALHOU. Saída:\n${r.output}\n\nCorrija a CAUSA RAIZ no código e ajuste o necessário. Depois eu rodo a verificação de novo.`,
  });
  return true;
}

// Uma "rodada" no endpoint OpenAI-compativel: devolve { text, toolCalls }
// onToken = resposta visivel; onThink = raciocinio (modelos "thinking")
async function openaiTurn(cfg, messages, tools, onToken, onThink) {
  const endpoint = cfg.baseUrl.replace(/\/$/, '') + '/chat/completions';
  const headers = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`; // chave opcional
  const body = { model: cfg.model, messages, temperature: cfg.temperature, stream: true };
  if (tools && tools.length) body.tools = tools;
  const t0 = Date.now();
  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: chatAbort ? chatAbort.signal : undefined, // permite o botão Stop abortar
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
    if (chatAbort && chatAbort.signal.aborted) {
      if (buf && !inThink) text += buf;
      return { text, toolCalls: toolCalls.filter(Boolean), usage, ms: Date.now() - t0, aborted: true };
    }
    throw e;
  }
  if (buf && !inThink) { text += buf; onToken(buf); } // descarrega o resto

  return { text, toolCalls: toolCalls.filter(Boolean), usage, ms: Date.now() - t0 };
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

// Monta o system prompt do subagente: persona + projeto/workspace + contexto da conversa
function subAgentSystemPrompt(cfg, agent) {
  let sp = (agent.systemPrompt || 'Você é um assistente especializado.') + '\n' + OS_NOTE;
  // agente "de código"? (tem ferramentas de arquivo/comando) -> ganha o guia de engenharia
  const CODER_TOOLS = ['write_file', 'append_file', 'read_file', 'list_dir', 'make_dir', 'delete_file', 'run_command'];
  const isCoder = Array.isArray(agent.tools) && agent.tools.some((t) => CODER_TOOLS.includes(t));
  // memória do projeto / workspace (para o subagente "enxergar" o projeto)
  if (cfg.workspace) {
    if (isCoder) sp += '\n\n' + CODING_GUIDE;
    let mem = '';
    try {
      mem = fs.readFileSync(workspaceMemoryPath(cfg), 'utf8');
    } catch (e) {
      mem = '(memória do projeto ainda vazia)';
    }
    const det = detectStack(cfg.workspace);
    let proj = `\n\n# Projeto atual\nWorkspace: ${cfg.workspace}`;
    if (det.stack) proj += `\nStack: ${det.stack}`;
    if (isCoder && det.verify) proj += `\nVerifique suas mudanças rodando \`${det.verify}\` (run_command) e leia a saída.`;
    if (isCoder && det.guide) proj += `\n\n## Boas práticas desta stack (siga-as)\n${det.guide}`;
    sp += proj + `\n\n## Memória do projeto (.lumi-memory.md):\n${mem}`;
  }
  // resumo do que já rolou na conversa principal
  if (convSummary) {
    sp += `\n\n# Contexto da conversa principal (resumo):\n${convSummary}`;
  }
  // últimas mensagens da conversa principal (o que está rolando agora)
  const recent = sanitizeForSave(history)
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
  let full = '';
  let lastText = ''; // última narração não-vazia (caso o turno final venha sem texto)
  const did = []; // ações executadas (fallback p/ quando o modelo não resume no fim)
  let completed = false; // terminou de fato (vs. atingiu o limite de passos)
  for (let step = 0; step < 12; step++) {
    if (chatAbort && chatAbort.signal.aborted) break; // botão Stop para os subagentes também
    let turn;
    try {
      turn = await openaiTurn(sub, messages, tools, () => {}, () => {});
    } catch (e) {
      if (chatAbort && chatAbort.signal.aborted) break; // parado pelo usuário
      if (tools.length) {
        tools = [];
        turn = await openaiTurn(sub, messages, tools, () => {}, () => {});
      } else {
        throw e;
      }
    }
    if (turn.text && turn.text.trim()) lastText = turn.text; // guarda narração (some no fim em alguns modelos)
    if (turn.aborted) { full = turn.text; completed = true; break; } // Stop: devolve o parcial do subagente
    if (turn.toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: turn.toolCalls.map((tc) => ({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })),
      });
      for (const tc of turn.toolCalls) {
        let args = {};
        try {
          args = JSON.parse(tc.arguments || '{}');
        } catch (e) {
          /* ok */
        }
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
  editedSinceTurn = false; // reseta o rastreio de edições (verificação automática)
  const onToken = (t) => broadcast('chat:token', t);
  const onThink = (t) => broadcast('chat:thinking', t);
  const messages = [{ role: 'system', content: buildSystemPrompt(cfg) }, ...history];
  let tools = cfg.toolsEnabled === false ? [] : toolSchemas({ delegate: agentsAvailable(cfg) });
  let full = '';
  let verifyAttempts = 0;
  for (let step = 0; step < 12; step++) {
    if (chatAbort && chatAbort.signal.aborted) break; // botão Stop
    // STEERING: mensagens enviadas durante o processamento entram como turno do usuário
    if (steerQueue.length) {
      for (const s of steerQueue.splice(0)) {
        messages.push({ role: 'user', content: s.content });
        editedSinceTurn = false; // a verificação considera só as edições após o novo pedido
      }
    }
    let turn;
    try {
      turn = await openaiTurn(cfg, messages, tools, onToken, onThink);
    } catch (e) {
      if (chatAbort && chatAbort.signal.aborted) break; // parado pelo usuário
      if (tools.length) {
        tools = []; // modelo pode nao suportar ferramentas -> tenta sem
        turn = await openaiTurn(cfg, messages, tools, onToken, onThink);
      } else {
        throw e;
      }
    }
    if (turn.toolCalls.length) {
      messages.push({
        role: 'assistant',
        content: turn.text || null,
        tool_calls: turn.toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        })),
      });
      // separa delegações (podem rodar EM PARALELO) das demais ferramentas
      // (arquivos/comando/tela continuam sequenciais — ordem e efeitos colaterais importam)
      const delegations = turn.toolCalls.filter((tc) => tc.name === 'delegate_to_agent');
      const others = turn.toolCalls.filter((tc) => tc.name !== 'delegate_to_agent');

      for (const tc of others) {
        let args = {};
        try {
          args = JSON.parse(tc.arguments || '{}');
        } catch (e) {
          /* args invalidos */
        }
        broadcast('chat:tool', { name: tc.name, args });
        const result = await runTool(tc.name, args);
        broadcast('chat:tool-result', { name: tc.name, args, result });
        if (result && result._image) {
          // captura de tela -> responde a tool e injeta a imagem como visao
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: true, note: 'Captura anexada como imagem.' }) });
          messages.push({
            role: 'user',
            content: [
              { type: 'text', text: 'Esta é a captura da minha tela agora:' },
              { type: 'image_url', image_url: { url: result._image } },
            ],
          });
          broadcast('chat:user', { text: '📸 captura de tela', images: [result._image] });
        } else {
          // nao reenvia base64 de imagem gerada pro modelo (estoura o contexto)
          const forModel =
            result && result.images
              ? { ok: true, generated: result.images.length, note: 'Imagem gerada e exibida ao usuário.' }
              : result;
          messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(forModel) });
        }
      }

      // DELEGAÇÕES EM PARALELO: vários subagentes trabalham ao mesmo tempo (ex.: Programador 1 + 2 + Revisor)
      if (delegations.length) {
        const dres = await Promise.all(
          delegations.map(async (tc) => {
            let args = {};
            try {
              args = JSON.parse(tc.arguments || '{}');
            } catch (e) {
              /* args invalidos */
            }
            broadcast('chat:tool', { name: tc.name, args });
            const result = await runTool(tc.name, args);
            broadcast('chat:tool-result', { name: tc.name, args, result });
            return { id: tc.id, result };
          })
        );
        // devolve os resultados ao modelo (cada um casado pelo seu tool_call_id)
        for (const { id, result } of dres) {
          messages.push({ role: 'tool', tool_call_id: id, content: JSON.stringify(result) });
        }
      }
      continue; // volta pro modelo com os resultados
    }
    full = turn.text;
    if (turn.aborted || (chatAbort && chatAbort.signal.aborted)) break; // botão Stop: mantém o parcial, não verifica
    // VERIFICAÇÃO AUTOMÁTICA: se editou arquivos e o comando falhar, o modelo corrige (até 3x)
    if (verifyAttempts < 3 && (await maybeAutoVerify(cfg, messages))) {
      verifyAttempts++;
      continue;
    }
    // estatisticas: usa o "usage" exato quando vier; senao estima (~4 chars/token)
    const est = (s) => Math.round((s || '').length / 4);
    const out = (turn.usage && turn.usage.completion_tokens) || est(full);
    const ctx = (turn.usage && turn.usage.prompt_tokens) || est(JSON.stringify(messages));
    const secs = Math.max(0.001, (turn.ms || 1) / 1000);
    broadcast('chat:stats', {
      tps: Math.round(out / secs),
      out,
      ctx,
      total: (turn.usage && turn.usage.total_tokens) || out + ctx,
      exact: !!turn.usage,
    });
    break;
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
let history = [];
let convSummary = '';

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

// Completa uma mensagem (nao-streaming) no provedor atual — usado p/ resumir
async function llmComplete(cfg, messages) {
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
  const KEEP = 12;
  if (history.length <= 20) return;
  const cut = history.length - KEEP;
  const toSum = history.slice(0, cut);
  const rest = history.slice(cut);
  const text = toSum
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[conteúdo multimídia]'}`)
    .join('\n')
    .slice(0, 12000);
  try {
    const summary = await llmComplete(cfg, [
      {
        role: 'system',
        content:
          'Você resume conversas preservando fatos, nomes, decisões, preferências e contexto técnico importante. Conciso, completo, em português.',
      },
      { role: 'user', content: `Resumo anterior:\n${convSummary || '(nenhum)'}\n\nIncorpore estas mensagens ao resumo:\n${text}` },
    ]);
    if (summary && summary.trim()) {
      convSummary = summary.trim();
      history = rest;
      // realinha a linha do tempo: as msgs antigas saíram, então desloca os anchors
      chatEvents = chatEvents.map((e) => ({ ...e, a: e.a - cut })).filter((e) => e.a >= 0);
      saveSummary();
      saveHistory();
      broadcast('chat:compacted', { kept: rest.length });
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
  if (loadConfig().memoryEnabled === false || !currentChatId) return;
  try {
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(chatFile(currentChatId), 'utf8')) || {};
    } catch (e) {
      /* chat novo */
    }
    const data = {
      id: currentChatId,
      title: meta.customTitle ? meta.title : titleFromHistory(history),
      customTitle: !!meta.customTitle,
      createdAt: meta.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      summary: convSummary,
      history: sanitizeForSave(history),
      events: chatEvents, // linha do tempo (tools/agentes/diffs/horários) — sobrevive ao reiniciar
    };
    fs.writeFileSync(chatFile(currentChatId), JSON.stringify(data));
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
    history = Array.isArray(j.history) ? j.history : [];
    convSummary = j.summary || '';
    chatEvents = Array.isArray(j.events) ? j.events : [];
    currentChatId = j.id || id;
    return true;
  } catch (e) {
    return false;
  }
}
function setCurrentChatId(id) {
  currentChatId = id;
  try {
    const c = loadConfig();
    c.currentChatId = id;
    saveConfig(c);
  } catch (e) {
    /* ok */
  }
}
// começa um chat novo (opcionalmente semeado com um resumo) e o torna atual
function newChat(seedSummary) {
  history = [];
  convSummary = seedSummary || '';
  chatEvents = [];
  setCurrentChatId(genChatId());
  saveCurrentChat();
  return currentChatId;
}
// salva o atual e abre um chat novo (Nova conversa)
function startNewChat() {
  saveCurrentChat();
  newChat('');
  broadcast('chat:reload');
}
function switchChat(id) {
  if (!id || id === currentChatId) return;
  saveCurrentChat();
  if (loadChatInto(id)) {
    setCurrentChatId(id);
    broadcast('chat:reload');
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
    history = [];
    convSummary = '';
    currentChatId = '';
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
  // migração do formato antigo (history.json + summary.txt)
  const old = loadHistory();
  if (old.length) {
    history = old;
    convSummary = loadSummary();
    setCurrentChatId(genChatId());
    saveCurrentChat();
    return;
  }
  newChat('');
}

// Resume TODA a conversa atual (incorpora o resumo anterior) -> novo resumo
async function summarizeAll(cfg) {
  const text = history
    .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : '[conteúdo multimídia]'}`)
    .join('\n')
    .slice(0, 16000);
  if (!text.trim()) return convSummary;
  const summary = await llmComplete(cfg, [
    {
      role: 'system',
      content:
        'Você resume conversas preservando fatos, nomes, decisões, preferências e contexto técnico importante. Conciso, completo, em português.',
    },
    {
      role: 'user',
      content:
        `Resumo anterior:\n${convSummary || '(nenhum)'}\n\n` +
        `Incorpore TODA esta conversa ao resumo, para continuarmos em um NOVO chat sem perder o contexto:\n${text}`,
    },
  ]);
  return summary && summary.trim() ? summary.trim() : convSummary;
}

// Forka: salva o chat atual e abre um chat NOVO levando o resumo (contexto leve)
async function forkConversation() {
  const cfg = loadConfig();
  let seed = convSummary;
  try {
    seed = (await summarizeAll(cfg)) || convSummary || '';
  } catch (e) {
    /* se o resumo falhar, segue com o resumo atual */
  }
  saveCurrentChat(); // o chat original continua salvo (na sua própria conversa)
  newChat(seed); // novo chat, leve, carregando o resumo
  broadcast('chat:reload');
  broadcast('chat:forked', { hasSummary: !!convSummary, archived: true });
  return { ok: true, hasSummary: !!convSummary };
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
  // tenta sentar na taskbar
  const b = win.getBounds();
  const d = screen.getPrimaryDisplay();
  const taskbarTop = d.workArea.y + d.workArea.height;
  if (footPixelY && b.y + footPixelY > taskbarTop - 70) {
    win.setPosition(b.x, Math.round(taskbarTop - footPixelY));
    win.webContents.send('sit-start');
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
      { label: 'Animações (testar)', click: () => openPage('anims', 'animations.html', 'Animações', 360, 500) },
      { label: 'Personagem', submenu: vrmMenuItems() },
      { label: 'Configurações…', click: () => win.webContents.send('open-settings') },
      {
        label: 'Nova conversa',
        click: () => startNewChat(),
      },
      { label: 'Forkar conversa (novo chat + resumo)', click: () => forkConversation() },
      { type: 'separator' },
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

function openPage(id, file, title, w, h) {
  // se ja estiver aberta, so foca (evita duplicar)
  if (openPages.has(id)) {
    openPages.get(id).focus();
    return;
  }
  const pageWin = new BrowserWindow({
    width: w,
    height: h,
    title,
    icon: ICON_PATH,
    resizable: true,
    minimizable: true,
    maximizable: false,
    backgroundColor: '#16161e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: true, // o preload (window.api) também roda dentro de iframes (chat embutido no editor)
    },
    ...acrylicOpts(), // vidro nativo do Win11 (sobrescreve o backgroundColor quando ativo)
  });
  pageWin.setMenuBarVisibility(false);
  pageWin.loadFile(path.join(__dirname, '..', 'renderer', 'pages', file));
  pageWin.on('closed', () => openPages.delete(id));
  openPages.set(id, pageWin);
}

// ============================================================
//  Menu de contexto (clique direito no boneco)
// ============================================================
function showContextMenu() {
  const template = [
    { label: 'Abrir chat', click: () => openPage('chat', 'chat.html', 'Chat', 380, 560) },
    { label: 'Gerar imagem', click: () => openPage('imagegen', 'imagegen.html', 'Gerar imagem', 520, 640) },
    { label: 'Modo arquiteto', click: () => openPage('architect', 'architect.html', 'Modo arquiteto', 540, 620) },
    { label: 'Workspace (editor)', click: () => openPage('workspace', 'workspace.html', 'Workspace', 1320, 720) },
    { label: 'MCP (ferramentas)', click: () => openPage('mcp', 'mcp.html', 'MCP', 560, 620) },
    { label: 'Agentes (multi-agente)', click: () => openPage('agents', 'agents.html', 'Agentes', 620, 680) },
    { label: 'Galeria', click: () => openPage('gallery', 'gallery.html', 'Galeria', 540, 560) },
    { label: 'Animações (testar)', click: () => openPage('anims', 'animations.html', 'Animações', 360, 500) },
    { label: 'Personagem', submenu: vrmMenuItems() },
    { label: 'Configurações…', click: () => win.webContents.send('open-settings') },
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
    { label: 'Sobre', click: () => openPage('about', 'about.html', 'Sobre', 400, 480) },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ];
  Menu.buildFromTemplate(template).popup({ window: win });
}

app.whenReady().then(() => {
  initChats(); // multi-chat: retoma o chat atual (ou migra/cria)
  startWorkspaceWatcher(); // auto-refresh do editor quando arquivos mudam
  connectMcpServers().catch((e) => console.error('MCP:', e)); // conecta ferramentas externas

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
const WS_IGNORE = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache']);
function walkWorkspace(dir, base, out, depth) {
  if (depth > 8 || out.length > 3000) return;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return;
  }
  for (const name of names) {
    if (WS_IGNORE.has(name)) continue;
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (st.isDirectory()) walkWorkspace(full, base, out, depth + 1);
    else out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
}
// garante que o caminho relativo nao escapa do workspace
function safeWsPath(cfg, rel) {
  const fp = path.resolve(cfg.workspace, rel || '');
  return fp.startsWith(path.resolve(cfg.workspace)) ? fp : null;
}
ipcMain.handle('workspace:tree', () => {
  const cfg = loadConfig();
  if (!cfg.workspace) return [];
  const out = [];
  walkWorkspace(cfg.workspace, cfg.workspace, out, 0);
  return out.sort();
});
ipcMain.handle('workspace:read', (_e, rel) => {
  const cfg = loadConfig();
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp) return null;
  try {
    return fs.readFileSync(fp, 'utf8');
  } catch (e) {
    return null;
  }
});
// lê um arquivo de imagem do workspace como data URL (para o preview no editor)
ipcMain.handle('workspace:read-image', (_e, rel) => {
  const cfg = loadConfig();
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
ipcMain.handle('workspace:write', (_e, { rel, content }) => {
  const cfg = loadConfig();
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp) return false;
  let oldC = '';
  try {
    oldC = fs.readFileSync(fp, 'utf8');
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

// árvore COMPLETA (pastas + arquivos, aninhada) para o editor estilo VS Code
function buildWsTree(absDir, base, depth) {
  let names = [];
  try {
    names = fs.readdirSync(absDir);
  } catch (e) {
    return [];
  }
  const dirs = [];
  const files = [];
  for (const name of names) {
    // esconde internos .lumi-* MAS mostra a memória do projeto (o usuário quer vê-la/editá-la)
    if (WS_IGNORE.has(name) || (name.startsWith('.lumi-') && name !== '.lumi-memory.md')) continue;
    const full = path.join(absDir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (e) {
      continue;
    }
    const rel = path.relative(base, full).replace(/\\/g, '/');
    if (st.isDirectory()) {
      dirs.push({ name, path: rel, dir: true, children: depth < 12 ? buildWsTree(full, base, depth + 1) : [] });
    } else {
      files.push({ name, path: rel, dir: false });
    }
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => a.name.localeCompare(b.name));
  return dirs.concat(files);
}
ipcMain.handle('workspace:fulltree', () => {
  const cfg = loadConfig();
  if (!cfg.workspace) return null;
  return buildWsTree(cfg.workspace, cfg.workspace, 0);
});
ipcMain.handle('workspace:create', (_e, { rel, dir }) => {
  const cfg = loadConfig();
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
ipcMain.handle('workspace:delete', (_e, rel) => {
  const cfg = loadConfig();
  const fp = cfg.workspace && safeWsPath(cfg, rel);
  if (!fp || fp === path.resolve(cfg.workspace)) return { error: 'caminho inválido' };
  try {
    fs.rmSync(fp, { recursive: true, force: true });
    return { ok: true };
  } catch (e) {
    return { error: String((e && e.message) || e) };
  }
});
ipcMain.handle('workspace:rename', (_e, { rel, name }) => {
  const cfg = loadConfig();
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
ipcMain.handle('workspace:move', (_e, { src, destDir }) => {
  const cfg = loadConfig();
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

// ---- watcher: avisa o editor quando arquivos mudam (auto-refresh) ----
let wsWatcher = null;
let wsWatchTimer = null;
function startWorkspaceWatcher() {
  try {
    if (wsWatcher) wsWatcher.close();
  } catch (e) {
    /* ok */
  }
  wsWatcher = null;
  const ws = loadConfig().workspace;
  if (!ws) return;
  try {
    wsWatcher = fs.watch(ws, { recursive: true }, (_evt, filename) => {
      const f = String(filename || '');
      if (/(^|[\\/])(node_modules|\.git|dist|build|out|\.next|\.cache)([\\/]|$)/.test(f)) return;
      // ignora internos .lumi-* MAS deixa a memória do projeto atualizar a árvore (aparece ao ser criada)
      if (/\.lumi-/.test(f) && !/\.lumi-memory\.md$/.test(f)) return;
      clearTimeout(wsWatchTimer);
      wsWatchTimer = setTimeout(() => broadcast('workspace:changed'), 300);
    });
  } catch (e) {
    // fs.watch recursive indisponível (Linux antigo / FS de rede) -> polling leve como fallback
    wsWatcher = { close: () => clearInterval(wsPollTimer) };
    let lastSig = '';
    const wsPollTimer = setInterval(() => {
      try {
        // assinatura barata: nomes + mtime do 1º nível (suficiente pra disparar o refresh da árvore)
        const sig = fs
          .readdirSync(ws)
          .filter((n) => !['node_modules', '.git', 'dist'].includes(n))
          .map((n) => {
            try {
              return n + fs.statSync(path.join(ws, n)).mtimeMs;
            } catch (_) {
              return n;
            }
          })
          .join('|');
        if (lastSig && sig !== lastSig) broadcast('workspace:changed');
        lastSig = sig;
      } catch (_) {
        /* workspace pode ter sumido */
      }
    }, 3000);
  }
}

ipcMain.handle('workspace:get-memory', () => {
  const cfg = loadConfig();
  if (!cfg.workspace) return '';
  try {
    return fs.readFileSync(workspaceMemoryPath(cfg), 'utf8');
  } catch (e) {
    return '';
  }
});
ipcMain.handle('workspace:set-memory', (_e, content) => {
  const cfg = loadConfig();
  if (!cfg.workspace) return false;
  fs.writeFileSync(workspaceMemoryPath(cfg), content || '');
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

// topo da barra de tarefas (para a avatar "sentar" nela)
ipcMain.handle('get-work-area', () => {
  const d = screen.getPrimaryDisplay();
  return { taskbarTop: d.workArea.y + d.workArea.height };
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
  saveConfig({ ...loadConfig(), ...cfg }); // merge: nao apaga campos de outras telas
  if (cfg && 'workspace' in cfg) startWorkspaceWatcher(); // re-observa a nova pasta
  return true;
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
ipcMain.handle('presets:save', (_e, { name, config }) => {
  const p = loadPresets();
  p[name] = config;
  savePresets(p);
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

// ---- IPC: chat ----
ipcMain.handle('chat:history', () => ({ messages: history, events: chatEvents }));

// "Nova conversa": salva a atual e abre um chat novo (não perde a anterior)
ipcMain.on('chat:reset', () => startNewChat());

// fork: novo chat levando o resumo do anterior
ipcMain.handle('chat:fork', () => forkConversation());

// ---- multi-chat: listar / criar / trocar / renomear / apagar ----
ipcMain.handle('chats:list', () => listChats());
ipcMain.handle('chats:current', () => {
  const found = listChats().find((c) => c.id === currentChatId);
  return { id: currentChatId, title: (found && found.title) || titleFromHistory(history) };
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
function expandMentions(text) {
  const cfg = loadConfig();
  if (!text || !cfg.workspace) return { text: text || '', files: [] };
  let tree = [];
  try {
    walkWorkspace(cfg.workspace, cfg.workspace, tree, 0);
  } catch (e) {
    tree = [];
  }
  if (!tree.length) return { text, files: [] };
  const treeSet = new Set(tree);
  const re = /(^|\s)@([^\s@]+)/g;
  const found = [];
  let mm;
  while ((mm = re.exec(text))) {
    const p = mm[2].replace(/[.,;:!?)\]]+$/, '');
    if (p && !found.includes(p)) found.push(p);
  }
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
      blocks.push('📎 ' + p + ':\n```\n' + truncate(content, 16000) + '\n```');
      used.push(p);
    } else {
      const prefix = p.replace(/\/+$/, '') + '/';
      const inDir = tree.filter((f) => f.startsWith(prefix));
      if (inDir.length) {
        blocks.push('📁 ' + p + '/ — arquivos:\n' + inDir.slice(0, 200).join('\n'));
        used.push(p);
      }
    }
  }
  if (!blocks.length) return { text, files: [] };
  return { text: text + FILES_SENTINEL + blocks.join('\n\n'), files: used };
}

ipcMain.on('chat:send', async (_e, payload) => {
  const raw = typeof payload === 'string' ? payload : payload.text || '';
  const images = (payload && payload.images) || [];
  const cfg = loadConfig();
  const text = expandMentions(raw).text; // anexa @arquivos mencionados (workspace)
  // chave de API e opcional (proxies locais podem nao exigir)
  // monta o conteudo do usuario (com imagens = visao, formato OpenAI)
  let content = text;
  if (images.length) {
    content = [{ type: 'text', text }];
    images.forEach((url) => content.push({ type: 'image_url', image_url: { url } }));
  }
  // STEERING: se já há um turno em andamento, injeta na conversa atual (não inicia outro)
  if (agentRunning) {
    history.push({ role: 'user', content });
    steerQueue.push({ content });
    broadcast('chat:user', { text, images, steer: true });
    return;
  }

  history.push({ role: 'user', content });
  broadcast('chat:user', { text, images }); // mostra em todas as janelas
  await runChatTurn(cfg, true);
});

// Roda um turno completo do agente sobre o history atual (usado pelo enviar E pelo regenerar)
async function runChatTurn(cfg, popUserOnError) {
  agentRunning = true;
  chatAbort = new AbortController();
  let full = '';
  try {
    if (cfg.provider === 'anthropic') {
      // Anthropic: streaming simples (sem ferramentas nesta versao)
      await streamAnthropic(cfg, history, (tok) => {
        full += tok;
        broadcast('chat:token', tok);
      });
    } else {
      // OpenAI-compativel: loop do agente com ferramentas
      full = await runAgent(cfg);
    }
    history.push({ role: 'assistant', content: full });
    await maybeSummarize(cfg); // gestao de contexto: resume o antigo se crescer demais
    saveHistory(); // memoria persistente
    broadcast('chat:done');
  } catch (err) {
    if (chatAbort && chatAbort.signal.aborted) {
      // parado pelo usuário: salva o que já saiu (não é erro)
      if (full && full.trim()) history.push({ role: 'assistant', content: full });
      saveHistory();
      broadcast('chat:done');
    } else {
      if (popUserOnError) history.pop(); // remove a mensagem do usuario que falhou (no regen não há)
      // descarta eventos do turno que falhou (anchors apontariam pra msgs que não existem mais)
      chatEvents = chatEvents.filter((e) => (e.t === 'mts' ? e.a < history.length : e.a <= history.length));
      broadcast('chat:error', String((err && err.message) || err));
    }
  } finally {
    agentRunning = false;
    chatAbort = null;
    steerQueue = [];
  }
}

// Regenerar: descarta a última resposta e roda o turno de novo sobre o mesmo pedido
ipcMain.on('chat:regen', async () => {
  if (agentRunning) return; // não regenera no meio de um turno
  if (!history.length || history[history.length - 1].role !== 'assistant') return;
  history.pop();
  // remove os eventos do turno descartado (as ferramentas/horário daquela resposta)
  chatEvents = chatEvents.filter((e) => e.a < history.length);
  broadcast('chat:reload'); // a UI re-renderiza sem a última resposta
  await runChatTurn(loadConfig(), false);
});

// Stop: aborta o turno atual (botão de parar)
ipcMain.on('chat:stop', () => {
  if (chatAbort) {
    try {
      chatAbort.abort();
    } catch (e) {
      /* ok */
    }
  }
  steerQueue = [];
  broadcast('chat:stopped');
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (cursorTimer) clearInterval(cursorTimer);
  if (hookOk) {
    try {
      uIOhook.stop();
    } catch (e) {
      /* ok */
    }
  }
});
