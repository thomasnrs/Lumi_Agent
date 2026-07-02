'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

function newestExtensionBinary(home, platform, arch) {
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const preferredDir =
    platform === 'win32'
      ? `windows-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`
      : platform === 'darwin'
        ? `macos-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`
        : `linux-${arch === 'arm64' ? 'aarch64' : 'x86_64'}`;
  const roots = [
    path.join(home, '.vscode', 'extensions'),
    path.join(home, '.vscode-insiders', 'extensions'),
    path.join(home, '.cursor', 'extensions'),
    path.join(home, '.windsurf', 'extensions'),
  ];
  const found = [];
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch (_) {
      continue;
    }
    for (const name of names) {
      if (!/^openai\.chatgpt-/i.test(name)) continue;
      const bin = path.join(root, name, 'bin');
      const candidates = [path.join(bin, preferredDir, exe)];
      try {
        for (const dir of fs.readdirSync(bin, { withFileTypes: true })) {
          if (dir.isDirectory()) candidates.push(path.join(bin, dir.name, exe));
        }
      } catch (_) {}
      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) found.push(candidate);
      }
    }
  }
  found.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  return found[0] || '';
}

function findCodexExecutable() {
  const envPath = process.env.CODEX_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const extension = newestExtensionBinary(os.homedir(), process.platform, process.arch);
  if (extension) return extension;
  const common =
    process.platform === 'win32'
      ? [
          path.join(process.env.APPDATA || '', 'npm', 'codex.cmd'),
          path.join(process.env.LOCALAPPDATA || '', 'Programs', 'codex', 'codex.exe'),
        ]
      : [
          path.join(os.homedir(), '.local', 'bin', 'codex'),
          path.join(os.homedir(), '.npm-global', 'bin', 'codex'),
          '/usr/local/bin/codex',
          '/opt/homebrew/bin/codex',
          '/usr/bin/codex',
        ];
  for (const candidate of common) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd', 'codex'] : ['codex'];
  for (const name of names) {
    try {
      const finder = process.platform === 'win32' ? 'where.exe' : 'which';
      const out = require('child_process')
        .execFileSync(finder, [name], { windowsHide: true, timeout: 4000 })
        .toString()
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (out) return out;
    } catch (_) {
      /* tenta o próximo */
    }
  }
  return '';
}

function codexEnvironment() {
  const env = { ...process.env, CODEX_CLIENT_NAME: 'lumi-desktop' };
  // Este motor usa deliberadamente a conta ChatGPT já autenticada no Codex.
  // Variáveis de API não devem ganhar prioridade e gerar cobrança sem querer.
  delete env.OPENAI_API_KEY;
  delete env.CODEX_API_KEY;
  delete env.OPENAI_BASE_URL;
  return env;
}

function asError(value) {
  if (!value) return new Error('O Codex encerrou sem informar o motivo.');
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

function commandFor(executable, args) {
  if (process.platform !== 'win32' || !/\.(cmd|bat)$/i.test(executable)) {
    return { command: executable, args };
  }
  const quoted = [executable, ...args].map((part) => `"${String(part).replace(/"/g, '""')}"`).join(' ');
  return {
    command: process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', `"${quoted}"`],
  };
}

class CodexAppServer {
  constructor(options) {
    this.executable = options.executable;
    this.version = options.version || '1.0.0';
    this.log = options.log || (() => {});
    this.process = null;
    this.buffer = '';
    this.seq = 0;
    this.pending = new Map();
    this.runs = new Map();
    this.startPromise = null;
  }

  async start() {
    if (this.process && !this.process.killed) return this;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this._start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async _start() {
    if (!this.executable || !fs.existsSync(this.executable)) throw new Error('Codex CLI não encontrado neste computador.');
    const launch = commandFor(this.executable, ['app-server', '--listen', 'stdio://']);
    const proc = spawn(launch.command, launch.args, {
      env: codexEnvironment(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.process = proc;
    proc.stdout.setEncoding('utf8');
    proc.stderr.setEncoding('utf8');
    proc.stdout.on('data', (chunk) => this._feed(chunk));
    proc.stderr.on('data', (chunk) => this.log('codex:stderr', String(chunk).slice(0, 1500)));
    proc.stdin.on('error', (error) => this._closed(error));
    proc.on('error', (error) => this._closed(error));
    proc.on('exit', (code, signal) => this._closed(new Error(`Codex app-server encerrou (${signal || code || 0}).`)));
    await this.request('initialize', {
      clientInfo: { name: 'lumi-desktop', title: 'Lumi Desktop', version: this.version },
      capabilities: { experimentalApi: true, mcpServerOpenaiFormElicitation: true },
    });
    this.notify('initialized', {});
    return this;
  }

  _feed(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.log('codex:invalid-json', line.slice(0, 1000));
        continue;
      }
      this._message(message);
    }
  }

  _message(message) {
    if (message.id != null && !message.method) {
      const item = this.pending.get(String(message.id));
      if (!item) return;
      this.pending.delete(String(message.id));
      clearTimeout(item.timer);
      if (message.error) item.reject(asError(message.error.message || message.error));
      else item.resolve(message.result);
      return;
    }
    const params = message.params || {};
    const threadId = params.threadId || (params.thread && params.thread.id);
    const run = threadId && this.runs.get(threadId);
    if (message.id != null && message.method) {
      Promise.resolve(run ? run.handleRequest(message.method, params) : this._defaultRequest(message.method))
        .then((result) => this._send({ id: message.id, result: result == null ? {} : result }))
        .catch((error) =>
          this._send({ id: message.id, error: { code: -32000, message: String((error && error.message) || error) } })
        );
      return;
    }
    if (message.method === 'account/updated' || message.method === 'account/login/completed') {
      for (const active of this.runs.values()) active.callbacks.authChanged?.(params);
    }
    if (run) run.notification(message.method, params);
  }

  _defaultRequest(method) {
    if (method === 'account/chatgptAuthTokens/refresh') {
      throw new Error('A Lumi usa a autenticação gerenciada localmente pelo próprio Codex.');
    }
    if (/requestApproval$/i.test(method)) return { decision: 'decline' };
    throw new Error(`Solicitação do Codex sem turno ativo: ${method}`);
  }

  _send(message) {
    if (!this.process || this.process.killed || !this.process.stdin.writable) throw new Error('Codex app-server não está disponível.');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  request(method, params, timeoutMs) {
    return new Promise((resolve, reject) => {
      const id = String(++this.seq);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex demorou demais em ${method}.`));
      }, timeoutMs || 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this._send({ id, method, params: params || {} });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this._send({ method, params: params || {} });
  }

  _closed(error) {
    if (!this.process) return;
    this.process = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const run of this.runs.values()) run.fail(error);
    this.runs.clear();
  }

  close() {
    const proc = this.process;
    this.process = null;
    const error = new Error('Codex app-server encerrado pela Lumi.');
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    for (const run of this.runs.values()) run.fail(error);
    this.runs.clear();
    if (proc) {
      try {
        proc.kill();
      } catch (_) {}
    }
  }
}

function approvalSettings(mode) {
  if (mode === 'readOnly') return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'read-only' };
  if (mode === 'fullAccess') return { approvalPolicy: 'never', approvalsReviewer: 'user', sandbox: 'danger-full-access' };
  if (mode === 'auto') return { approvalPolicy: 'on-request', approvalsReviewer: 'auto_review', sandbox: 'workspace-write' };
  return { approvalPolicy: 'on-request', approvalsReviewer: 'user', sandbox: 'workspace-write' };
}

function parseDiff(diff, filePath) {
  const lines = [];
  let added = 0;
  let removed = 0;
  for (const raw of String(diff || '').split(/\r?\n/)) {
    if (/^\+\+\+ |^--- /.test(raw)) continue;
    if (raw.startsWith('+')) {
      added++;
      lines.push({ t: '+', v: raw.slice(1) });
    } else if (raw.startsWith('-')) {
      removed++;
      lines.push({ t: '-', v: raw.slice(1) });
    } else if (raw.startsWith('@@')) {
      lines.push({ t: ' ', v: raw });
    } else {
      lines.push({ t: ' ', v: raw.startsWith(' ') ? raw.slice(1) : raw });
    }
  }
  return { path: filePath, lines: lines.slice(0, 600), added, removed };
}

function itemTool(item) {
  if (!item) return null;
  if (item.type === 'commandExecution') {
    return { name: 'run_command', args: { command: item.command, cwd: item.cwd } };
  }
  if (item.type === 'fileChange') {
    return { name: 'apply_patch', args: { files: (item.changes || []).map((c) => c.path) } };
  }
  if (item.type === 'webSearch') return { name: 'web_search', args: { query: item.query || '' } };
  if (item.type === 'mcpToolCall') return { name: `mcp:${item.server}:${item.tool}`, args: item.arguments || {} };
  if (item.type === 'dynamicToolCall') return { name: item.tool || 'dynamic_tool', args: item.arguments || {} };
  return null;
}

class CodexRun {
  constructor(server, options) {
    this.server = server;
    this.threadId = options.threadId;
    this.callbacks = options.callbacks || {};
    this.started = Date.now();
    this.full = '';
    this.generatedChars = 0;
    this.lastStatsAt = 0;
    this.streamedItems = new Set();
    this.items = new Map();
    this.turnId = '';
    this.usage = null;
    this.rateLimits = null;
    this.done = false;
    this.promise = new Promise((resolve, reject) => {
      this.resolve = resolve;
      this.reject = reject;
    });
  }

  async handleRequest(method, params) {
    if (method === 'item/commandExecution/requestApproval') {
      const allowed = await this.callbacks.approve?.('exec', params.reason || `executar: ${params.command || 'comando do Codex'}`);
      return { decision: allowed ? 'accept' : 'decline' };
    }
    if (method === 'item/fileChange/requestApproval') {
      const allowed = await this.callbacks.approve?.('write', params.reason || 'aplicar alterações de arquivos do Codex');
      return { decision: allowed ? 'accept' : 'decline' };
    }
    if (method === 'item/tool/requestUserInput') {
      const answers = {};
      for (const question of params.questions || []) {
        const options = (question.options || []).map((o) => o.label).filter(Boolean);
        const answer = await this.callbacks.ask?.(question.question || question.header || 'Como deseja continuar?', options);
        answers[question.id] = { answers: [String(answer == null ? '' : answer)] };
      }
      return { answers };
    }
    if (method === 'mcpServer/elicitation/request') {
      return (await this.callbacks.elicitation?.(params)) || { action: 'decline' };
    }
    if (method === 'item/permissions/requestApproval') {
      const allowed = await this.callbacks.approve?.('exec', params.reason || 'ampliar as permissões do Codex');
      return {
        permissions: allowed ? params.permissions || params.requestedPermissions || {} : {},
        scope: 'turn',
      };
    }
    if (/requestApproval$/i.test(method)) return { decision: 'decline' };
    throw new Error(`Solicitação ainda não suportada pelo cliente Lumi: ${method}`);
  }

  notification(method, params) {
    try {
      if (method === 'turn/started') {
        this.turnId = params.turn && params.turn.id ? params.turn.id : this.turnId;
        this.callbacks.note?.(`✦ Codex iniciou o turno${this.turnId ? ' · ' + this.turnId.slice(0, 8) : ''}`);
      } else if (method === 'item/agentMessage/delta') {
        this.streamedItems.add(params.itemId);
        this.full += params.delta || '';
        this.generatedChars += String(params.delta || '').length;
        this.callbacks.token?.(params.delta || '');
        if (Date.now() - this.lastStatsAt > 220) {
          this.lastStatsAt = Date.now();
          this._stats(true, 'Codex respondendo');
        }
      } else if (method === 'item/reasoning/summaryTextDelta') {
        this.callbacks.think?.(params.delta || '');
      } else if (method === 'item/started') {
        this._itemStarted(params.item);
      } else if (method === 'item/completed') {
        this._itemCompleted(params.item);
      } else if (method === 'turn/plan/updated') {
        this.callbacks.plan?.(
          (params.plan || []).map((p) => ({
            text: p.step,
            status: p.status === 'inProgress' ? 'doing' : p.status === 'completed' ? 'done' : 'pending',
          }))
        );
      } else if (method === 'thread/tokenUsage/updated') {
        this.usage = params.tokenUsage || this.usage;
        this._stats(true, 'Codex trabalhando');
      } else if (method === 'account/rateLimits/updated') {
        this.rateLimits = params.rateLimits || this.rateLimits;
        this._stats(true, 'Codex trabalhando');
      } else if (method === 'thread/compacted') {
        this.callbacks.compacted?.({ engine: 'codex', beforeTokens: null, kept: null });
      } else if (method === 'error') {
        this.fail(asError(params.error || params.message || params));
      } else if (method === 'turn/completed') {
        const turn = params.turn || {};
        if (turn.status === 'failed') this.fail(asError((turn.error && turn.error.message) || turn.error || 'O turno do Codex falhou.'));
        else this.finish();
      }
    } catch (error) {
      this.fail(error);
    }
  }

  _itemStarted(item) {
    if (!item || !item.id) return;
    this.items.set(item.id, item);
    const tool = itemTool(item);
    if (tool) this.callbacks.toolStart?.({ ...tool, agent: 'Codex' });
    if (item.type === 'collabAgentToolCall') {
      this.callbacks.agent?.({
        name: `Codex · ${(item.tool || 'agente').replace(/([A-Z])/g, ' $1').trim()}`,
        task: item.prompt || '',
        phase: 'start',
      });
    }
  }

  _itemCompleted(item) {
    if (!item) return;
    if (item.type === 'agentMessage' && item.text && !this.streamedItems.has(item.id)) {
      this.full += item.text;
      this.generatedChars += item.text.length;
      this.callbacks.token?.(item.text);
      return;
    }
    const tool = itemTool(item);
    if (tool) {
      const result =
        item.type === 'commandExecution'
          ? { status: item.status, exitCode: item.exitCode, output: String(item.aggregatedOutput || '').slice(-16000) }
          : item.type === 'fileChange'
            ? { status: item.status, files: (item.changes || []).map((c) => c.path) }
            : item.result || item.error || { status: item.status };
      this.callbacks.toolResult?.({ ...tool, result, agent: 'Codex' });
    }
    if (item.type === 'fileChange') {
      for (const change of item.changes || []) this.callbacks.diff?.(parseDiff(change.diff, change.path));
      this.callbacks.workspaceChanged?.();
    } else if (item.type === 'collabAgentToolCall') {
      this.callbacks.agent?.({
        name: `Codex · ${(item.tool || 'agente').replace(/([A-Z])/g, ' $1').trim()}`,
        phase: 'done',
      });
    }
  }

  _stats(live, phase) {
    const usage = (this.usage && (this.usage.last || this.usage.total)) || {};
    const input = usage.inputTokens || 0;
    const output = usage.outputTokens || Math.ceil(this.generatedChars / 3.6);
    const total = usage.totalTokens || input + output;
    const window = (this.usage && this.usage.modelContextWindow) || 0;
    const limits = [this.rateLimits && this.rateLimits.primary, this.rateLimits && this.rateLimits.secondary].filter(Boolean);
    const activeLimit = limits.sort((a, b) => (b.usedPercent || 0) - (a.usedPercent || 0))[0] || null;
    const secs = Math.max(0.2, (Date.now() - this.started) / 1000);
    this.callbacks.stats?.({
      tps: Math.round((output / secs) * 10) / 10,
      out: output,
      ctx: input,
      total,
      exact: !!this.usage,
      live,
      phase,
      window,
      pct: window ? Math.min(999, Math.round((input / window) * 100)) : 0,
      engine: 'codex',
      usagePct: activeLimit ? activeLimit.usedPercent : null,
      usageLabel: activeLimit ? `${activeLimit.windowDurationMins || '?'}min` : 'ChatGPT',
      usageResetsAt: activeLimit && activeLimit.resetsAt ? new Date(activeLimit.resetsAt * 1000).toISOString() : null,
    });
  }

  finish() {
    if (this.done) return;
    this.done = true;
    this._stats(false, 'concluído');
    this.resolve({ text: this.full, usage: this.usage, turnId: this.turnId });
  }

  fail(error) {
    if (this.done) return;
    this.done = true;
    this.reject(asError(error));
  }
}

function createCodexEngine(options) {
  let executable = '';
  let server = null;
  let versionCache = '';

  function detect() {
    if (!executable || !fs.existsSync(executable)) executable = findCodexExecutable();
    return executable;
  }

  async function ensureServer() {
    const exe = detect();
    if (!exe) throw new Error('Codex CLI não encontrado. Instale o Codex ou a extensão oficial da OpenAI no VS Code.');
    if (!versionCache) {
      try {
        const launch = commandFor(exe, ['--version']);
        const { stdout } = await execFileAsync(launch.command, launch.args, {
          env: codexEnvironment(),
          windowsHide: true,
          timeout: 8000,
        });
        versionCache = String(stdout || '').trim();
      } catch (_) {}
    }
    if (!server) {
      server = new CodexAppServer({
        executable: exe,
        version: options.version || '1.0.0',
        log: options.log,
      });
    }
    await server.start();
    return server;
  }

  async function status() {
    const exe = detect();
    if (!exe) return { installed: false, ready: false };
    try {
      const appServer = await ensureServer();
      const result = await appServer.request('account/read', { refreshToken: true }, 20000);
      const account = result && result.account;
      return {
        installed: true,
        executable: exe,
        version: versionCache,
        loggedIn: !!account,
        ready: !!account && account.type === 'chatgpt',
        accountType: account && account.type,
        email: account && account.email,
        planType: account && account.planType,
        requiresOpenaiAuth: !!(result && result.requiresOpenaiAuth),
      };
    } catch (error) {
      return { installed: true, executable: exe, ready: false, error: String(error.message || error).slice(0, 300) };
    }
  }

  async function models() {
    const appServer = await ensureServer();
    const result = await appServer.request('model/list', {}, 20000);
    return (result && result.data) || [];
  }

  async function login() {
    const appServer = await ensureServer();
    const result = await appServer.request('account/login/start', { type: 'chatgpt' }, 20000);
    if (result && result.authUrl) options.openExternal?.(result.authUrl);
    return { ok: true, pending: true, loginId: result && result.loginId, authUrl: result && result.authUrl };
  }

  async function logout() {
    const appServer = await ensureServer();
    await appServer.request('account/logout', {}, 20000);
    return { ok: true };
  }

  async function run(params) {
    const appServer = await ensureServer();
    const auth = await status();
    if (!auth.ready) {
      throw new Error(
        auth.accountType === 'apiKey'
          ? 'O Codex está usando uma API key. Entre com sua conta ChatGPT nas configurações da Lumi para usar o plano do Codex.'
          : 'Codex não autenticado. Entre com sua conta ChatGPT nas configurações da Lumi.'
      );
    }
    const settings = approvalSettings(params.permissionMode);
    let threadId = params.threadId || '';
    let threadResponse;
    if (threadId) {
      try {
        threadResponse = await appServer.request('thread/resume', {
          threadId,
          cwd: params.workspace,
          developerInstructions: params.instructions,
          model: params.model || undefined,
          ...settings,
        });
      } catch (error) {
        options.log?.('codex:resume-failed', String(error.message || error));
        threadId = '';
      }
    }
    if (!threadId) {
      threadResponse = await appServer.request('thread/start', {
        cwd: params.workspace,
        developerInstructions: params.instructions,
        model: params.model || undefined,
        personality: 'friendly',
        serviceName: 'Lumi Desktop',
        ...settings,
      });
      threadId = threadResponse.thread.id;
    }
    params.onThread?.(threadId, threadResponse);
    const run = new CodexRun(appServer, { threadId, callbacks: params.callbacks });
    appServer.runs.set(threadId, run);
    try {
      try {
        const limits = await appServer.request('account/rateLimits/read', {}, 10000);
        run.rateLimits = limits && limits.rateLimits;
      } catch (_) {
        /* alguns provedores/contas não publicam rate limits */
      }
      const turn = await appServer.request('turn/start', {
        threadId,
        input: params.input,
        cwd: params.workspace,
        effort: params.effort || 'high',
        model: params.model || undefined,
        approvalPolicy: settings.approvalPolicy,
        approvalsReviewer: settings.approvalsReviewer,
      });
      run.turnId = turn.turn.id;
      params.onControl?.({
        interrupt: () => appServer.request('turn/interrupt', { threadId, turnId: run.turnId }, 10000),
        steer: (input) =>
          appServer.request('turn/steer', { threadId, expectedTurnId: run.turnId, input }, 15000),
      });
      const result = await run.promise;
      return { ...result, threadId, model: threadResponse.model || params.model || '' };
    } finally {
      appServer.runs.delete(threadId);
      params.onControl?.(null);
    }
  }

  return {
    detect,
    status,
    models,
    login,
    logout,
    run,
    close() {
      if (server) server.close();
      server = null;
    },
  };
}

module.exports = { createCodexEngine, findCodexExecutable };
