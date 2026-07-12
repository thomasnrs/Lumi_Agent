'use strict';

const nodeFs = require('fs');
const nodePath = require('path');
const { clone } = require('../../../shared/schema');

class AtomicJsonStore {
  constructor(options) {
    const opts = options || {};
    if (!opts.filePath) throw new Error('AtomicJsonStore exige filePath');
    this.filePath = opts.filePath;
    this.backupPath = opts.backupPath || `${opts.filePath}.bak`;
    this.fs = opts.fs || nodeFs.promises;
    this.path = opts.path || nodePath;
    this.schema = opts.schema || null;
    this.defaultValue = opts.defaultValue;
    this.maxBytes = Math.max(1024, Number(opts.maxBytes) || 8 * 1024 * 1024);
    this.pretty = opts.pretty !== false;
    this.clock = opts.clock || { now: () => Date.now() };
    this.sequence = 0;
    this.queue = Promise.resolve();
  }

  parse(text, source) {
    if (Buffer.byteLength(text, 'utf8') > this.maxBytes) throw new Error(`${source} excede ${this.maxBytes} bytes`);
    const value = JSON.parse(text);
    return this.schema ? this.schema.parse(value) : value;
  }

  async readFile(file, source) {
    return this.parse(await this.fs.readFile(file, 'utf8'), source);
  }

  async read() {
    try {
      return { value: clone(await this.readFile(this.filePath, 'arquivo principal')), source: 'primary', recovered: false };
    } catch (primaryError) {
      try {
        const value = await this.readFile(this.backupPath, 'backup');
        await this.recoverPrimary();
        return { value: clone(value), source: 'backup', recovered: true, primaryError };
      } catch (backupError) {
        if (this.defaultValue === undefined) throw primaryError;
        return { value: clone(this.defaultValue), source: 'default', recovered: false, primaryError, backupError };
      }
    }
  }

  async recoverPrimary() {
    const corrupt = `${this.filePath}.corrupt-${this.clock.now()}-${++this.sequence}`;
    try { await this.fs.rename(this.filePath, corrupt); } catch (_) {}
    await this.fs.mkdir(this.path.dirname(this.filePath), { recursive: true });
    await this.fs.copyFile(this.backupPath, this.filePath);
  }

  write(value) {
    const candidate = clone(value);
    const operation = this.queue.then(() => {
      const validated = this.schema ? this.schema.parse(candidate) : candidate;
      return this.writeNow(validated);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }

  async writeNow(value) {
    const dir = this.path.dirname(this.filePath);
    await this.fs.mkdir(dir, { recursive: true });
    const text = JSON.stringify(value, null, this.pretty ? 2 : 0) + '\n';
    if (Buffer.byteLength(text, 'utf8') > this.maxBytes) throw new Error(`conteúdo excede ${this.maxBytes} bytes`);
    const temp = this.path.join(dir, `.${this.path.basename(this.filePath)}.tmp-${process.pid}-${++this.sequence}`);
    let handle;
    try {
      handle = await this.fs.open(temp, 'w', 0o600);
      await handle.writeFile(text, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      try { await this.fs.copyFile(this.filePath, this.backupPath); } catch (error) { if (error && error.code !== 'ENOENT') throw error; }
      await this.fs.rename(temp, this.filePath);
      return clone(value);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await this.fs.unlink(temp).catch(() => {});
    }
  }

  async update(mutator) {
    if (typeof mutator !== 'function') throw new Error('update exige mutator');
    const operation = this.queue.then(async () => {
      const current = (await this.read()).value;
      const next = await mutator(clone(current));
      const validated = this.schema ? this.schema.parse(next) : clone(next);
      return this.writeNow(validated);
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
}

module.exports = { AtomicJsonStore };
