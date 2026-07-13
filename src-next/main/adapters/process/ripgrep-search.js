'use strict';

const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');

const execFileAsync = promisify(execFile);
const DEFAULT_IGNORES = ['node_modules', '.git', 'dist', 'build', 'out', '.next', '.cache', '.lumi-*'];
function globEscape(value) { return String(value || '').replace(/[\\[\]{}()*?!]/g, (match) => `\\${match}`); }
function ignoreArgs() { return DEFAULT_IGNORES.flatMap((name) => ['--glob', `!**/${name}/**`, '--glob', `!${name}/**`]); }
function rel(root, file) { return path.relative(root, path.isAbsolute(file) ? file : path.join(root, file)).replace(/\\/g, '/'); }
function parseMatch(line, root, width) {
  let event; try { event = JSON.parse(line); } catch (_) { return null; }
  if (event.type !== 'match' || !event.data) return null;
  return { file: rel(root, event.data.path && event.data.path.text || ''), line: event.data.line_number || 1, text: String(event.data.lines && event.data.lines.text || '').replace(/[\r\n]+$/, '').trim().slice(0, width || 240) };
}

class RipgrepSearch {
  constructor(options) { const opts = options || {}; this.exe = opts.exe || 'rg'; this.spawn = opts.spawn || spawn; this.execFile = opts.execFile || execFileAsync; this.available = undefined; }
  async isAvailable() {
    if (this.available !== undefined) return this.available;
    try { await this.execFile(this.exe, ['--version'], { timeout: 1500, windowsHide: true }); this.available = true; } catch (_) { this.available = false; }
    return this.available;
  }
  async lines(args, options) {
    const opts = options || {};
    if (!await this.isAvailable()) return null;
    return new Promise((resolve) => {
      const child = this.spawn(this.exe, args, { windowsHide: true });
      let buffer = '', done = false, limited = false;
      const finish = (value) => { if (done) return; done = true; clearTimeout(timer); if (opts.signal) opts.signal.removeEventListener('abort', stop); resolve(value); };
      const stop = () => { limited = true; try { child.kill(); } catch (_) {} };
      const timer = setTimeout(stop, Math.max(1000, Math.min(Number(opts.timeoutMs) || 5000, 15000)));
      if (opts.signal) { if (opts.signal.aborted) return finish({ ok: false, aborted: true, limited: true }); opts.signal.addEventListener('abort', stop, { once: true }); }
      child.stdout.on('data', (chunk) => {
        buffer += String(chunk); let index;
        while ((index = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, index).replace(/\r$/, ''); buffer = buffer.slice(index + 1);
          if (line && opts.onLine && opts.onLine(line) === false) stop();
        }
        if (buffer.length > 256 * 1024) buffer = buffer.slice(-64 * 1024);
      });
      child.on('error', () => finish(null));
      child.on('close', (code) => { if (buffer.trim() && opts.onLine) opts.onLine(buffer.trim()); finish({ ok: code === 0 || code === 1 || limited, limited }); });
    });
  }
  async search(request) {
    const req = request || {}, root = req.root, query = String(req.query || '');
    if (!root || !query) return null;
    const ignores = ignoreArgs();
    if (req.find) {
      const files_matching_name = [], content_matches = []; let limited = false;
      await this.lines(['--files', '--no-messages', '--iglob', `*${globEscape(query)}*`, ...ignores, root], { timeoutMs: 2500, signal: req.signal, onLine: (line) => { files_matching_name.push(rel(root, line)); return files_matching_name.length < 30; } });
      const content = await this.lines(['--json', '--fixed-strings', '--ignore-case', '--max-count', '20', '--max-filesize', '800K', '--no-messages', ...ignores, '--', query, root], { timeoutMs: 4500, signal: req.signal, onLine: (line) => { const hit = parseMatch(line, root, 160); if (hit) content_matches.push(hit); if (content_matches.length >= 50) { limited = true; return false; } return true; } });
      if (!content) return null;
      return { engine: 'ripgrep', files_matching_name: [...new Set(files_matching_name)], content_matches, limited: limited || content.limited };
    }
    const matches = []; let limited = false;
    const args = ['--json', '--ignore-case', '--max-count', '20', '--max-filesize', '1M', '--no-messages'];
    if (!req.regex) args.push('--fixed-strings');
    args.push(...ignores, '--', query, req.base || root);
    const result = await this.lines(args, { timeoutMs: 6000, signal: req.signal, onLine: (line) => { const hit = parseMatch(line, root, 240); if (hit) matches.push(hit); if (matches.length >= 120) { limited = true; return false; } return true; } });
    return result ? { engine: 'ripgrep', matches, limited: limited || result.limited } : null;
  }
}

module.exports = { RipgrepSearch, parseMatch, globEscape, ignoreArgs };
