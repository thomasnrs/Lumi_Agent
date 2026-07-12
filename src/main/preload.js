const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Ponte segura entre o avatar (renderer) e o processo principal (janela do SO + I.A.)
contextBridge.exposeInMainWorld('api', {
  platform: process.platform, // win32 | linux | darwin (decide titlebar custom, etc.)
  // caminho real de um File arrastado do SO (File.path foi removido no Electron 32+)
  pathForFile: (file) => {
    try {
      return webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(file) : file.path || '';
    } catch (e) {
      return file && file.path ? file.path : '';
    }
  },
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
  designList: (filters) => ipcRenderer.invoke('design:list', filters || {}),
  designStatus: () => ipcRenderer.invoke('design:status'),
  designInstall: (id, overwrite) => ipcRenderer.invoke('design:install', { id, overwrite: overwrite === true }),
  getWorkspaceTree: () => ipcRenderer.invoke('workspace:tree'),
  getWorkspaceFullTree: () => ipcRenderer.invoke('workspace:fulltree'),
  wsBind: (folder) => ipcRenderer.invoke('ws:bind', folder), // prende a janela do editor a uma pasta
  openWorkspaceWindow: () => ipcRenderer.invoke('workspace:open-window'), // escolhe pasta e abre em nova janela
  diagCheck: () => ipcRenderer.invoke('diag:check'), // roda o linter/type-checker → problemas do projeto
  diagSystem: (opts) => ipcRenderer.invoke('diag:system', opts || {}),
  onSystemDiagnostics: (cb) => ipcRenderer.on('diag:system-update', (_e, data) => cb(data)),
  tasksList: () => ipcRenderer.invoke('tasks:list'), // ⏰ tarefas agendadas (cron da Lumi)
  tasksSave: (t) => ipcRenderer.invoke('tasks:save', t),
  tasksDelete: (id) => ipcRenderer.invoke('tasks:delete', id),
  tasksRunNow: (id) => ipcRenderer.invoke('tasks:run-now', id),
  getWorkspaceChildren: (rel) => ipcRenderer.invoke('workspace:children', rel),
  readWorkspaceFile: (rel) => ipcRenderer.invoke('workspace:read', rel),
  readWorkspaceImage: (rel) => ipcRenderer.invoke('workspace:read-image', rel),
  createWorkspaceEntry: (rel, dir) => ipcRenderer.invoke('workspace:create', { rel, dir }),
  importFileToWorkspace: (srcPath, destDir) => ipcRenderer.invoke('workspace:import-file', { srcPath, destDir }),
  deleteWorkspaceEntry: (rel) => ipcRenderer.invoke('workspace:delete', rel),
  renameWorkspaceEntry: (rel, name) => ipcRenderer.invoke('workspace:rename', { rel, name }),
  moveWorkspaceEntry: (src, destDir) => ipcRenderer.invoke('workspace:move', { src, destDir }),
  onWorkspaceChanged: (cb) => ipcRenderer.on('workspace:changed', (_e, root) => cb(root)), // root = pasta que mudou (janelas filtram)
  onWorkspaceSwitched: (cb) => ipcRenderer.on('workspace:switched', (_e, ws) => cb(ws)),
  setEditorActive: (detail) => ipcRenderer.send('editor:active', detail || ''),
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
  gitAiReview: () => ipcRenderer.invoke('git:ai-review'),
  gitLog: () => ipcRenderer.invoke('git:log'),
  gitShowCommit: (hash) => ipcRenderer.invoke('git:show-commit', hash),
  gitLineStatus: (rel) => ipcRenderer.invoke('git:line-status', rel),
  gitBranches: () => ipcRenderer.invoke('git:branches'),
  gitCheckout: (opts) => ipcRenderer.invoke('git:checkout', opts),
  gitPush: () => ipcRenderer.invoke('git:push'),
  gitPull: () => ipcRenderer.invoke('git:pull'),
  gitStashList: () => ipcRenderer.invoke('git:stash-list'),
  gitStash: (action, ref) => ipcRenderer.invoke('git:stash', { action, ref }),
  gitConflicts: () => ipcRenderer.invoke('git:conflicts'),
  gitResolve: (file, side) => ipcRenderer.invoke('git:resolve', { file, side }),
  gitBlame: (rel) => ipcRenderer.invoke('git:blame', rel),
  openExternal: (url) => ipcRenderer.send('open-external-url', url),

  // live server (preview ao vivo do workspace)
  liveStart: () => ipcRenderer.invoke('live:start'),
  liveStop: () => ipcRenderer.invoke('live:stop'),

  // terminal integrado (painel do workspace, estilo VS Code)
  termCreate: (opts) => ipcRenderer.invoke('term:create', opts || {}),
  termInput: (id, data) => ipcRenderer.send('term:input', { id, data }),
  termResize: (id, cols, rows) => ipcRenderer.send('term:resize', { id, cols, rows }),
  termKill: (id) => ipcRenderer.send('term:kill', id),
  termList: () => ipcRenderer.invoke('term:list'),
  termProfiles: () => ipcRenderer.invoke('term:profiles'),
  dockerList: () => ipcRenderer.invoke('docker:list'),
  dockerAction: (id, action) => ipcRenderer.invoke('docker:action', { id, action }),
  dockerComposeFile: () => ipcRenderer.invoke('docker:compose-file'),
  projectTasksList: () => ipcRenderer.invoke('project-tasks:list'),
  tunnelCheck: () => ipcRenderer.invoke('tunnel:check'),
  ghCheck: () => ipcRenderer.invoke('gh:check'),
  ghPrs: () => ipcRenderer.invoke('gh:prs'),
  ghCi: () => ipcRenderer.invoke('gh:ci'),
  ghPrCreate: () => ipcRenderer.invoke('gh:pr-create'),
  sshHosts: () => ipcRenderer.invoke('ssh:hosts'),
  sshAvailable: () => ipcRenderer.invoke('ssh:available'),
  sshInstallCmd: () => ipcRenderer.invoke('ssh:install-cmd'),
  sshEnsureKey: (host) => ipcRenderer.invoke('ssh:ensure-key', host),
  sshListDir: (host, path) => ipcRenderer.invoke('ssh:listdir', { host, path }),
  sshRecents: () => ipcRenderer.invoke('ssh:recents'),
  sshStatus: () => ipcRenderer.invoke('ssh:status'),
  onRemoteActive: (cb) => ipcRenderer.on('remote:active', (_e, d) => cb(d)),

  // REST client
  restSend: (req) => ipcRenderer.invoke('rest:send', req),

  // painel do servidor (systemd + recursos)
  serverContext: () => ipcRenderer.invoke('server:context'),
  serverStats: () => ipcRenderer.invoke('server:stats'),
  serverServices: () => ipcRenderer.invoke('server:services'),
  serverAction: (name, action) => ipcRenderer.invoke('server:action', { name, action }),
  serverLogs: (name) => ipcRenderer.invoke('server:logs', name),

  // .env viewer/editor
  envList: () => ipcRenderer.invoke('env:list'),
  envRead: (file) => ipcRenderer.invoke('env:read', file),
  envSave: (file, vars) => ipcRenderer.invoke('env:save', { file, vars }),

  // banco de dados (painel de query)
  dbDetect: () => ipcRenderer.invoke('db:detect'),
  dbConnect: (url) => ipcRenderer.invoke('db:connect', url),
  dbDisconnect: () => ipcRenderer.invoke('db:disconnect'),
  dbTables: () => ipcRenderer.invoke('db:tables'),
  dbQuery: (sql) => ipcRenderer.invoke('db:query', sql),
  dbAiSql: (question) => ipcRenderer.invoke('db:ai-sql', question),
  sshMount: (host, remotePath) => ipcRenderer.invoke('ssh:mount', { host, remotePath }),
  sshUnmount: () => ipcRenderer.invoke('ssh:unmount'),
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
  factsList: () => ipcRenderer.invoke('facts:list'),
  factsAdd: (fact) => ipcRenderer.invoke('facts:add', fact),
  factsSet: (index, fact) => ipcRenderer.invoke('facts:set', { index, fact }),
  factsDelete: (index) => ipcRenderer.invoke('facts:delete', index),
  openMemoryPage: () => ipcRenderer.send('memory:open'),
  openChatWindow: () => ipcRenderer.send('chat:open-window'), // nova conversa em nova janela
  openChatWindowFor: (id) => ipcRenderer.send('chats:open-window', id), // abre uma conversa existente em nova janela
  chatBind: (session) => ipcRenderer.invoke('chat:bind', session), // prende esta janela a uma conversa ('' = segue a ativa)
  improvePrompt: (text) => ipcRenderer.invoke('chat:improve-prompt', text), // ✨ varinha: melhora o prompt antes de enviar

  // assistente de primeiro uso
  wizardVrms: () => ipcRenderer.invoke('wizard:vrms'),
  wizardInstallVrm: () => ipcRenderer.invoke('wizard:install-vrm'),

  // diagnostico de memoria
  onMemReport: (cb) => ipcRenderer.on('mem-report', () => cb()),
  sendMemReport: (d) => ipcRenderer.send('mem:data', d),
  performanceSnapshot: () => ipcRenderer.invoke('performance:snapshot'),
  getWindowPos: () => ipcRenderer.invoke('get-window-pos'),
  getWindowBounds: () => ipcRenderer.invoke('get-window-bounds'),
  setWindowPos: (x, y) => ipcRenderer.send('set-window-pos', x, y),
  windowControl: (action) => ipcRenderer.invoke('window:control', action),
  onWindowState: (cb) => ipcRenderer.on('window:state', (_e, state) => cb(state)),

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
  // menu de contexto com vidro (janelinha própria)
  onCtxModel: (cb) => ipcRenderer.on('ctx:model', (_e, m) => cb(m)),
  ctxSize: (w, h) => ipcRenderer.send('ctx:size', { w, h }),
  ctxClick: (id, checked) => ipcRenderer.send('ctx:click', { id, checked }),
  ctxClose: () => ipcRenderer.send('ctx:close'),
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
  claudeCodeStatus: () => ipcRenderer.invoke('claude-code:status'),
  claudeCodeLogin: () => ipcRenderer.invoke('claude-code:login'),
  claudeCodeLogout: () => ipcRenderer.invoke('claude-code:logout'),
  claudeCodeCapabilities: () => ipcRenderer.invoke('claude-code:capabilities'),
  glmCodeStatus: (draft) => ipcRenderer.invoke('glm-code:status', draft),
  codexStatus: () => ipcRenderer.invoke('codex:status'),
  codexLogin: () => ipcRenderer.invoke('codex:login'),
  codexLogout: () => ipcRenderer.invoke('codex:logout'),
  codexModels: () => ipcRenderer.invoke('codex:models'),

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
  // seletor agrupado (favoritos + perfis/provedores com modelos cacheados)
  modelsCatalog: () => ipcRenderer.invoke('models:catalog'),
  modelsRefresh: (preset) => ipcRenderer.invoke('models:refresh', { preset }),
  modelsSelect: (preset, model) => ipcRenderer.invoke('models:select', { preset, model }),
  modelsFavorite: (preset, model) => ipcRenderer.invoke('models:favorite', { preset, model }),
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
  chatConfigGet: () => ipcRenderer.invoke('chat:config:get'),
  chatConfigSet: (config) => ipcRenderer.invoke('chat:config:set', config),
  onChatConfigChanged: (cb) => ipcRenderer.on('chat:config-changed', () => cb()),
  onChatsChanged: (cb) => ipcRenderer.on('chats:changed', () => cb()),
  onChatReload: (cb) => ipcRenderer.on('chat:reload', () => cb()),
  getHistory: () => ipcRenderer.invoke('chat:history'),
  onUser: (cb) => ipcRenderer.on('chat:user', (_e, m) => cb(m)),
  onToken: (cb) => ipcRenderer.on('chat:token', (_e, t) => cb(t)),
  onThinking: (cb) => ipcRenderer.on('chat:thinking', (_e, t) => cb(t)),
  onStats: (cb) => ipcRenderer.on('chat:stats', (_e, s) => cb(s)),
  onSpend: (cb) => ipcRenderer.on('chat:spend', (_e, s) => cb(s)),
  usageToday: () => ipcRenderer.invoke('usage:today'),
  onCompacted: (cb) => ipcRenderer.on('chat:compacted', (_e, info) => cb(info)),
  onDone: (cb) => ipcRenderer.on('chat:done', () => cb()),
  onNewBubble: (cb) => ipcRenderer.on('chat:newbubble', () => cb()),
  onError: (cb) => ipcRenderer.on('chat:error', (_e, m) => cb(m)),
  onAgent: (cb) => ipcRenderer.on('chat:agent', (_e, info) => cb(info)),
  onAgentToken: (cb) => ipcRenderer.on('chat:agent-token', (_e, d) => cb(d)),
  onClaudeCapabilities: (cb) => ipcRenderer.on('chat:claude-capabilities', (_e, d) => cb(d)),
  onTool: (cb) => ipcRenderer.on('chat:tool', (_e, info) => cb(info)),
  onNote: (cb) => ipcRenderer.on('chat:note', (_e, d) => cb(d)),
  onPlan: (cb) => ipcRenderer.on('chat:plan', (_e, items) => cb(items)),
  onCheckpoint: (cb) => ipcRenderer.on('chat:checkpoint', (_e, c) => cb(c)),
  undoCheckpoint: (id) => ipcRenderer.invoke('checkpoint:undo', id),
  onPerm: (cb) => ipcRenderer.on('chat:perm', (_e, p) => cb(p)),
  onPermDone: (cb) => ipcRenderer.on('chat:perm-done', (_e, d) => cb(d)),
  answerPerm: (id, allow, always) => ipcRenderer.send('chat:perm-answer', { id, allow, always }),
  onAsk: (cb) => ipcRenderer.on('chat:ask', (_e, a) => cb(a)),
  onAskDone: (cb) => ipcRenderer.on('chat:ask-done', (_e, d) => cb(d)),
  answerAsk: (id, answer) => ipcRenderer.send('chat:ask-answer', { id, answer }),
  onToolResult: (cb) => ipcRenderer.on('chat:tool-result', (_e, info) => cb(info)),
  onToolAnimation: (cb) => ipcRenderer.on('tool:animation', (_e, name) => cb(name)),
});
