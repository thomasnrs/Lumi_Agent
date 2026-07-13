'use strict';

const { spawn } = require('node:child_process');

/** Adaptador opcional de PTY. `pty` é injetado para manter node-pty fora do domínio. */
class NodeTerminalPort {
  constructor(options) {
    const opts = options || {};
    this.pty = opts.pty || null;
    this.spawn = opts.spawn || spawn;
    this.platform = opts.platform || process.platform;
    this.env = opts.env || process.env;
    this.defaultShell = opts.defaultShell || (this.platform === 'win32' ? 'powershell.exe' : this.env.SHELL || 'bash');
  }

  open(input) {
    const request = input || {}, shell = request.shell || this.defaultShell;
    const explicitShell = !!request.shell;
    const args = Array.isArray(request.args) ? request.args.map(String) : explicitShell ? [] : this.platform === 'win32' ? ['-NoLogo'] : [];
    const cwd = request.cwd || undefined, env = request.env ? { ...this.env, ...request.env } : this.env;
    if (this.pty && typeof this.pty.spawn === 'function') return this.openPty(shell, args, { cwd, env, cols: request.cols, rows: request.rows });
    return this.openPipe(shell, args, { cwd, env });
  }

  openPty(shell, args, options) {
    const p = this.pty.spawn(shell, args, { name: 'xterm-256color', cols: Math.max(1, Number(options.cols) || 100), rows: Math.max(1, Number(options.rows) || 28), cwd: options.cwd, env: options.env });
    const dataListeners = [], exitListeners = [], errorListeners = [];
    p.onData((data) => dataListeners.forEach((listener) => listener(data)));
    p.onExit(({ exitCode }) => exitListeners.forEach((listener) => listener(exitCode)));
    return {
      pid: p.pid, pty: true, write: (data) => p.write(data), kill: () => p.kill(), resize: (cols, rows) => p.resize(cols, rows),
      onData: (listener) => dataListeners.push(listener), onExit: (listener) => exitListeners.push(listener), onError: (listener) => errorListeners.push(listener),
    };
  }

  openPipe(shell, args, options) {
    const p = this.spawn(shell, args, { cwd: options.cwd, env: options.env, windowsHide: true });
    const dataListeners = [], exitListeners = [], errorListeners = [];
    const forward = (chunk) => dataListeners.forEach((listener) => listener(String(chunk).replace(/\r?\n/g, '\r\n')));
    if (p.stdout) p.stdout.on('data', forward);
    if (p.stderr) p.stderr.on('data', forward);
    p.on('exit', (code) => exitListeners.forEach((listener) => listener(code)));
    p.on('error', (error) => errorListeners.forEach((listener) => listener(error)));
    return {
      pid: p.pid, pty: false, write: (data) => p.stdin.write(data), kill: () => p.kill(),
      onData: (listener) => dataListeners.push(listener), onExit: (listener) => exitListeners.push(listener), onError: (listener) => errorListeners.push(listener),
    };
  }
}

module.exports = { NodeTerminalPort };
