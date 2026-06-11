const { contextBridge, ipcRenderer } = require('electron');

// Ponte segura entre o avatar (renderer) e o processo principal (janela do SO + I.A.)
contextBridge.exposeInMainWorld('api', {
  platform: process.platform, // win32 | linux | darwin (decide titlebar custom, etc.)
  // janela / avatar
  getVrmPath: () => ipcRenderer.invoke('get-vrm-path'),
  getVrmaPaths: () => ipcRenderer.invoke('get-vrma-paths'),
  getWorkArea: () => ipcRenderer.invoke('get-work-area'),
  getUnityIdle: () => ipcRenderer.invoke('get-unity-idle'),

  // galeria de imagens + memoria de longo prazo
  getGallery: () => ipcRenderer.invoke('gallery:list'),
  openGalleryFolder: () => ipcRenderer.send('gallery:open'),
  generateImage: (prompt) => ipcRenderer.invoke('image:generate', prompt),

  // modo arquiteto + editor
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  getWorkspaceMemory: () => ipcRenderer.invoke('workspace:get-memory'),
  setWorkspaceMemory: (content) => ipcRenderer.invoke('workspace:set-memory', content),
  getWorkspaceTree: () => ipcRenderer.invoke('workspace:tree'),
  getWorkspaceFullTree: () => ipcRenderer.invoke('workspace:fulltree'),
  readWorkspaceFile: (rel) => ipcRenderer.invoke('workspace:read', rel),
  readWorkspaceImage: (rel) => ipcRenderer.invoke('workspace:read-image', rel),
  createWorkspaceEntry: (rel, dir) => ipcRenderer.invoke('workspace:create', { rel, dir }),
  deleteWorkspaceEntry: (rel) => ipcRenderer.invoke('workspace:delete', rel),
  renameWorkspaceEntry: (rel, name) => ipcRenderer.invoke('workspace:rename', { rel, name }),
  moveWorkspaceEntry: (src, destDir) => ipcRenderer.invoke('workspace:move', { src, destDir }),
  onWorkspaceChanged: (cb) => ipcRenderer.on('workspace:changed', () => cb()),
  onWorkspaceSwitched: (cb) => ipcRenderer.on('workspace:switched', (_e, ws) => cb(ws)),
  setEditorActive: (rel) => ipcRenderer.send('editor:active', rel || ''),
  onEditorActive: (cb) => ipcRenderer.on('editor:active', (_e, rel) => cb(rel)),
  revealInExplorer: (rel) => ipcRenderer.send('workspace:reveal', rel || ''),
  searchWorkspace: (q) => ipcRenderer.invoke('workspace:search', q),
  gitStatus: () => ipcRenderer.invoke('workspace:gitstatus'),
  gitInfo: () => ipcRenderer.invoke('workspace:gitinfo'),

  // controle de fontes (painel git do workspace)
  gitPanelStatus: () => ipcRenderer.invoke('git:panel-status'),
  gitHeadFile: (rel) => ipcRenderer.invoke('git:head-file', rel),
  gitStage: (paths) => ipcRenderer.invoke('git:stage', paths),
  gitUnstage: (paths) => ipcRenderer.invoke('git:unstage', paths),
  gitDiscard: (paths) => ipcRenderer.invoke('git:discard', paths),
  gitCommit: (opts) => ipcRenderer.invoke('git:commit', opts),
  gitAiMessage: () => ipcRenderer.invoke('git:ai-message'),

  // terminal integrado (painel do workspace, estilo VS Code)
  termCreate: (opts) => ipcRenderer.invoke('term:create', opts || {}),
  termInput: (id, data) => ipcRenderer.send('term:input', { id, data }),
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  termKill: (id) => ipcRenderer.send('term:kill', id),
  termList: () => ipcRenderer.invoke('term:list'),
  termBuffer: (id) => ipcRenderer.invoke('term:buffer', id),
  onTermData: (cb) => ipcRenderer.on('term:data', (_e, d) => cb(d)),
  onTermExit: (cb) => ipcRenderer.on('term:exit', (_e, d) => cb(d)),
  onTermOpened: (cb) => ipcRenderer.on('term:opened', (_e, d) => cb(d)),

  // tracker de portas
  portsList: () => ipcRenderer.invoke('ports:list'),
  portsKill: (pid) => ipcRenderer.invoke('ports:kill', pid),
  portsOpen: (port) => ipcRenderer.send('ports:open', port),
  writeWorkspaceFile: (rel, content) => ipcRenderer.invoke('workspace:write', { rel, content }),
  onDiff: (cb) => ipcRenderer.on('chat:diff', (_e, d) => cb(d)),
  clearFacts: () => ipcRenderer.invoke('facts:clear'),

  // diagnostico de memoria
  onMemReport: (cb) => ipcRenderer.on('mem-report', () => cb()),
  sendMemReport: (d) => ipcRenderer.send('mem:data', d),
  getWindowPos: () => ipcRenderer.invoke('get-window-pos'),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  setWindowPos: (x, y) => ipcRenderer.send('set-window-pos', x, y),

  // tamanho da avatar (slider nas configs + scroll do mouse) e opacidade das paginas
  setAvatarScale: (scale) => ipcRenderer.send('avatar-scale-set', scale),
  scaleAvatarBy: (dir) => ipcRenderer.send('avatar-scale-by', dir),
  onAvatarScale: (cb) => ipcRenderer.on('avatar-scale', (_e, s) => cb(s)),
  setWindowOpacity: (v) => ipcRenderer.send('page-set-opacity', v),

  // tema customizado (cores da UI) — aplica ao vivo em todas as janelas
  setTheme: (theme) => ipcRenderer.send('theme-set', theme),
  onThemeChanged: (cb) => ipcRenderer.on('theme-changed', (_e, t) => cb(t)),

  // menu de contexto (clique direito no boneco)
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  onOpenSettings: (cb) => ipcRenderer.on('open-settings', () => cb()),
  onChatReset: (cb) => ipcRenderer.on('chat-reset-ui', () => cb()),

  // click-through inteligente
  setHoverInteractive: (v) => ipcRenderer.send('hover-interactive', v),
  onCursor: (cb) => ipcRenderer.on('cursor', (_e, pos) => cb(pos)),

  // hook global de mouse (anti-lag): renderer informa estado, main controla arrasto
  getHookStatus: () => ipcRenderer.invoke('get-hook-status'),
  setOverBody: (v) => ipcRenderer.send('over-body', v),
  setFootPixel: (y) => ipcRenderer.send('foot-pixel', y),
  onDragStart: (cb) => ipcRenderer.on('drag-start', () => cb()),
  onSitStart: (cb) => ipcRenderer.on('sit-start', () => cb()),

  // testador de animacoes
  previewAnim: (name) => ipcRenderer.send('anim:preview', name),
  stopPreview: () => ipcRenderer.send('anim:stop'),
  onPreviewAnim: (cb) => ipcRenderer.on('anim:preview', (_e, n) => cb(n)),
  onStopPreview: (cb) => ipcRenderer.on('anim:stop', () => cb()),

  // configuracao (BYOK)
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (cfg) => ipcRenderer.invoke('config:set', cfg),
  onConfigChanged: (cb) => ipcRenderer.on('config:changed', () => cb()),
  openSettingsWindow: () => ipcRenderer.send('settings:open-window'),

  // MCP
  mcpConnect: () => ipcRenderer.invoke('mcp:connect'),
  mcpStatus: () => ipcRenderer.invoke('mcp:status'),


  // agentes padrão (restaurar equipe)
  getDefaultAgents: () => ipcRenderer.invoke('agents:defaults'),

  // perfis de configuracao
  listPresets: () => ipcRenderer.invoke('presets:list'),
  savePreset: (name, config) => ipcRenderer.invoke('presets:save', { name, config }),
  loadPreset: (name) => ipcRenderer.invoke('presets:load', name),
  deletePreset: (name) => ipcRenderer.invoke('presets:delete', name),

  // lista de modelos do endpoint + voz (TTS) + transcricao (STT)
  listModels: (cfg) => ipcRenderer.invoke('models:list', cfg),
  getModels: (opts) => ipcRenderer.invoke('models:get', opts), // com cache por provedor
  speak: (text, override) => ipcRenderer.invoke('tts:speak', { text, override }),
  transcribe: (audioB64, mime) => ipcRenderer.invoke('stt:transcribe', { audioB64, mime }),

  // chat com I.A. (streaming) - text + imagens (data URLs) opcionais
  sendChat: (text, images) => ipcRenderer.send('chat:send', { text, images: images || [] }),
  stopChat: () => ipcRenderer.send('chat:stop'),
  regenChat: () => ipcRenderer.send('chat:regen'),
  onStopped: (cb) => ipcRenderer.on('chat:stopped', () => cb()),
  resetChat: () => ipcRenderer.send('chat:reset'),
  forkChat: () => ipcRenderer.invoke('chat:fork'),
  onForked: (cb) => ipcRenderer.on('chat:forked', (_e, info) => cb(info)),

  // multi-chat (várias conversas)
  chatsList: () => ipcRenderer.invoke('chats:list'),
  chatsCurrent: () => ipcRenderer.invoke('chats:current'),
  chatsNew: () => ipcRenderer.invoke('chats:new'),
  chatsSwitch: (id) => ipcRenderer.invoke('chats:switch', id),
  chatsRename: (id, title) => ipcRenderer.invoke('chats:rename', { id, title }),
  chatsDelete: (id) => ipcRenderer.invoke('chats:delete', id),
  onChatReload: (cb) => ipcRenderer.on('chat:reload', () => cb()),
  getHistory: () => ipcRenderer.invoke('chat:history'),
  onUser: (cb) => ipcRenderer.on('chat:user', (_e, m) => cb(m)),
  onToken: (cb) => ipcRenderer.on('chat:token', (_e, t) => cb(t)),
  onThinking: (cb) => ipcRenderer.on('chat:thinking', (_e, t) => cb(t)),
  onStats: (cb) => ipcRenderer.on('chat:stats', (_e, s) => cb(s)),
  onCompacted: (cb) => ipcRenderer.on('chat:compacted', (_e, info) => cb(info)),
  onDone: (cb) => ipcRenderer.on('chat:done', () => cb()),
  onNewBubble: (cb) => ipcRenderer.on('chat:newbubble', () => cb()),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, m) => cb(m)),
  onAgent: (cb) => ipcRenderer.on('chat:agent', (_e, info) => cb(info)),
  onTool: (cb) => ipcRenderer.on('chat:tool', (_e, info) => cb(info)),
  onNote: (cb) => ipcRenderer.on('chat:note', (_e, d) => cb(d)),
  onPlan: (cb) => ipcRenderer.on('chat:plan', (_e, items) => cb(items)),
  onCheckpoint: (cb) => ipcRenderer.on('chat:checkpoint', (_e, c) => cb(c)),
  undoCheckpoint: (id) => ipcRenderer.invoke('checkpoint:undo', id),
  onAsk: (cb) => ipcRenderer.on('chat:ask', (_e, a) => cb(a)),
  onAskDone: (cb) => ipcRenderer.on('chat:ask-done', (_e, d) => cb(d)),
  answerAsk: (id, answer) => ipcRenderer.send('chat:ask-answer', { id, answer }),
  onToolResult: (cb) => ipcRenderer.on('chat:tool-result', (_e, info) => cb(info)),
  onToolAnimation: (cb) => ipcRenderer.on('tool:animation', (_e, name) => cb(name)),
});
