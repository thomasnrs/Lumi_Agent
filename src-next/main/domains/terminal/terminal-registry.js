'use strict';

function stripAnsi(value) {
  return String(value == null ? '' : value)
    .replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b[=>()][0-9A-Z]?/g, '')
    .replace(/\r/g, '');
}
function defaultIdFactory() { let sequence = 0; return () => `term_${Date.now().toString(36)}_${(++sequence).toString(36)}`; }

/** Mantém terminais por owner sem conhecer IPC, Electron ou PTY. */
class TerminalRegistry {
  constructor(options) {
    const opts = options || {};
    if (!opts.terminalPort || typeof opts.terminalPort.open !== 'function') throw new Error('TerminalRegistry exige terminalPort.open');
    this.port = opts.terminalPort;
    this.nextId = opts.nextId || defaultIdFactory();
    this.clock = opts.clock || global;
    this.maxBufferChars = Math.max(4096, Number(opts.maxBufferChars) || 200000);
    this.batchMs = Math.max(0, Number(opts.batchMs) || 16);
    this.onEvent = opts.onEvent || (() => {});
    this.records = new Map();
    this.pending = new Map();
    this.flushTimer = null;
  }

  canAccess(record, owner, allowShared) {
    return !!record && (record.owner === owner || (!!allowShared && record.shared));
  }

  async open(input) {
    const request = input || {}, id = this.nextId('term');
    const handle = await this.port.open({ ...request });
    if (!handle || typeof handle.write !== 'function' || typeof handle.kill !== 'function') throw new Error('terminalPort.open retornou handle inválido');
    const record = {
      id, handle, owner: request.owner == null ? null : request.owner, shared: !!request.shared,
      title: String(request.title || request.shell || 'terminal'), cwd: String(request.cwd || ''), ai: !!request.ai,
      remoteHost: String(request.remoteHost || ''), remotePath: String(request.remotePath || ''), pty: !!handle.pty,
      pid: handle.pid == null ? null : handle.pid, buffer: '', closed: false,
    };
    this.records.set(id, record);
    if (typeof handle.onData === 'function') handle.onData((data) => this.append(record, data));
    if (typeof handle.onError === 'function') handle.onError((error) => this.append(record, `\r\n[erro: ${String(error && error.message || error)}]\r\n`));
    if (typeof handle.onExit === 'function') handle.onExit((code) => this.closeRecord(record, code));
    this.onEvent({ type: 'terminal.opened', terminal: this.publicRecord(record) });
    if (request.command) this.write(id, String(request.command) + (record.pty ? '\r' : '\n'), record.owner, { allowShared: true });
    return this.publicRecord(record);
  }

  append(record, data) {
    if (!record || record.closed) return;
    const text = String(data == null ? '' : data);
    record.buffer = (record.buffer + text).slice(-this.maxBufferChars);
    this.pending.set(record.id, (this.pending.get(record.id) || '') + text);
    if (!this.flushTimer) this.flushTimer = this.clock.setTimeout(() => this.flush(), this.batchMs);
  }

  flush() {
    if (this.flushTimer) { this.clock.clearTimeout(this.flushTimer); this.flushTimer = null; }
    for (const [id, data] of this.pending) {
      const record = this.records.get(id);
      if (record) this.onEvent({ type: 'terminal.data', id, owner: record.owner, shared: record.shared, data });
    }
    this.pending.clear();
  }

  write(id, data, owner, options) {
    const record = this.records.get(String(id));
    if (!this.canAccess(record, owner, options && options.allowShared)) return { error: 'terminal não encontrado ou sem acesso' };
    if (record.closed) return { error: 'terminal já foi encerrado' };
    try { record.handle.write(String(data || '')); return { ok: true }; } catch (error) { return { error: String(error && error.message || error) }; }
  }

  read(id, owner, chars, options) {
    const record = this.records.get(String(id));
    if (!this.canAccess(record, owner, options && options.allowShared)) return { error: 'terminal não encontrado ou sem acesso' };
    const amount = Math.min(16000, Math.max(1, Number(chars) || 4000));
    return { id: record.id, output: stripAnsi(record.buffer).slice(-amount), closed: record.closed };
  }

  list(owner, options) {
    return [...this.records.values()].filter((record) => this.canAccess(record, owner, options && options.allowShared)).map((record) => this.publicRecord(record));
  }

  resize(id, owner, cols, rows, options) {
    const record = this.records.get(String(id));
    if (!this.canAccess(record, owner, options && options.allowShared)) return { error: 'terminal não encontrado ou sem acesso' };
    if (typeof record.handle.resize !== 'function') return { error: 'este terminal não suporta redimensionamento' };
    try { record.handle.resize(Math.max(1, Number(cols) || 1), Math.max(1, Number(rows) || 1)); return { ok: true }; } catch (error) { return { error: String(error && error.message || error) }; }
  }

  kill(id, owner, options) {
    const record = this.records.get(String(id));
    if (!this.canAccess(record, owner, options && options.allowShared)) return { error: 'terminal não encontrado ou sem acesso' };
    try { record.handle.kill(); return { ok: true }; } catch (error) { return { error: String(error && error.message || error) }; }
  }

  disposeOwner(owner) { for (const record of [...this.records.values()]) if (record.owner === owner) this.kill(record.id, owner); }
  closeRecord(record, code) {
    if (!record || record.closed) return;
    record.closed = true; this.flush(); this.records.delete(record.id);
    this.onEvent({ type: 'terminal.exit', id: record.id, owner: record.owner, shared: record.shared, exitCode: code == null ? null : Number(code) });
  }
  publicRecord(record) { return { id: record.id, pid: record.pid, pty: record.pty, title: record.title, cwd: record.cwd, ai: record.ai, owner: record.owner, shared: record.shared, remoteHost: record.remoteHost, remotePath: record.remotePath, closed: record.closed }; }
}

module.exports = { TerminalRegistry, stripAnsi };
