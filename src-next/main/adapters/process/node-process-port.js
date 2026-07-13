'use strict';

const { spawn } = require('node:child_process');

function appendCapped(current, chunk, cap) {
  const currentBytes = Buffer.byteLength(current);
  if (currentBytes >= cap) return { value: current, limited: true };
  const room = cap - currentBytes;
  const next = String(chunk == null ? '' : chunk);
  if (Buffer.byteLength(next) <= room) return { value: current + next, limited: false };
  let end = Math.min(next.length, room);
  while (end > 0 && Buffer.byteLength(next.slice(0, end)) > room) end--;
  return { value: current + next.slice(0, end), limited: true };
}

/** child_process isolado: não lança por exit code, sempre devolve o resultado observado. */
class NodeProcessPort {
  constructor(options) { const opts = options || {}; this.spawn = opts.spawn || spawn; this.platform = opts.platform || process.platform; this.env = opts.env || process.env; }
  execute(input) {
    const request = input || {};
    return new Promise((resolve, reject) => {
      const cap = Math.max(1024, Number(request.maxOutputBytes) || 1024 * 1024);
      const file = request.file || request.command, args = request.file ? request.args || [] : [];
      let child;
      try { child = this.spawn(file, args, { cwd: request.cwd, env: request.env ? { ...this.env, ...request.env } : this.env, shell: request.file ? false : request.shell !== false, windowsHide: true }); }
      catch (error) { reject(error); return; }
      let stdout = '', stderr = '', settled = false, timedOut = false, aborted = false, outputLimited = false;
      const finish = (result) => { if (settled) return; settled = true; clearTimeout(timer); if (request.signal) request.signal.removeEventListener('abort', abort); resolve(result); };
      const stop = (kind) => {
        if (kind === 'timeout') timedOut = true;
        if (kind === 'abort') aborted = true;
        try { child.kill(); } catch (_) {}
      };
      const abort = () => stop('abort');
      const timer = setTimeout(() => stop('timeout'), Math.max(1000, Number(request.timeoutMs) || 20000));
      if (request.signal) { if (request.signal.aborted) abort(); else request.signal.addEventListener('abort', abort, { once: true }); }
      const collect = (kind, chunk) => {
        const current = kind === 'stdout' ? stdout : stderr, result = appendCapped(current, chunk, cap);
        if (kind === 'stdout') stdout = result.value; else stderr = result.value;
        if (result.limited && !outputLimited) { outputLimited = true; stop('output'); }
      };
      if (child.stdout) child.stdout.on('data', (chunk) => collect('stdout', chunk));
      if (child.stderr) child.stderr.on('data', (chunk) => collect('stderr', chunk));
      child.once('error', (error) => finish({ stdout, stderr, exitCode: null, timedOut, aborted, outputLimited, error: error.message }));
      child.once('close', (code) => finish({ stdout, stderr, exitCode: code == null ? null : code, timedOut, aborted, outputLimited }));
    });
  }
}

module.exports = { NodeProcessPort, appendCapped };
