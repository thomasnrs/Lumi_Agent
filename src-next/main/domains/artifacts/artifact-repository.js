'use strict';

const nodeFs = require('fs');
const nodePath = require('path');
const crypto = require('crypto');

function artifactId(tool, content) { return 'art_' + crypto.createHash('sha256').update(String(tool || 'tool') + '\0' + String(content || '')).digest('hex').slice(0, 24); }

class ArtifactRepository {
  constructor(options) {
    const opts = options || {}; if (!opts.directory) throw new Error('ArtifactRepository exige directory');
    this.directory = opts.directory; this.fs = opts.fs || nodeFs.promises; this.path = opts.path || nodePath;
    this.clock = opts.clock || { now: () => Date.now(), date: () => new Date() };
    this.maxItemChars = Number(opts.maxItemChars) || 8 * 1024 * 1024; this.maxItems = Number(opts.maxItems) || 80;
    this.maxBytes = Number(opts.maxBytes) || 64 * 1024 * 1024; this.maxAgeMs = Number(opts.maxAgeMs) || 14 * 86400000;
  }
  file(id) { return /^art_[a-f0-9]{24}$/.test(String(id)) ? this.path.join(this.directory, `${id}.json`) : ''; }
  async save(tool, content, metadata) {
    const text = String(content || ''); if (text.length > this.maxItemChars) return null;
    const id = artifactId(tool, text); const file = this.file(id); await this.fs.mkdir(this.directory, { recursive: true });
    try { await this.fs.utimes(file, this.clock.date(), this.clock.date()); return { id, reused: true }; } catch (_) {}
    const item = { id, tool: String(tool || 'tool'), content: text, chars: text.length, at: this.clock.now(), ...(metadata || {}) };
    const temp = `${file}.tmp-${process.pid}-${this.clock.now()}`;
    await this.fs.writeFile(temp, JSON.stringify(item), { encoding: 'utf8', mode: 0o600 }); await this.fs.rename(temp, file);
    return { id, reused: false };
  }
  async load(id) {
    const file = this.file(id); if (!file) return null;
    try { const item = JSON.parse(await this.fs.readFile(file, 'utf8')); if (item.id !== id || artifactId(item.tool, item.content) !== id) return null; await this.fs.utimes(file, this.clock.date(), this.clock.date()).catch(() => {}); return item; } catch (_) { return null; }
  }
  async sweep() {
    await this.fs.mkdir(this.directory, { recursive: true }); const entries = await this.fs.readdir(this.directory, { withFileTypes: true }); const files = [];
    for (const entry of entries) if (entry.isFile() && /^art_[a-f0-9]{24}\.json$/.test(entry.name)) try { const file = this.path.join(this.directory, entry.name); const stat = await this.fs.stat(file); files.push({ file, size: stat.size, mtimeMs: stat.mtimeMs }); } catch (_) {}
    files.sort((a, b) => b.mtimeMs - a.mtimeMs); let bytes = 0; let removed = 0; const now = this.clock.now();
    for (let index = 0; index < files.length; index++) { bytes += files[index].size; if (index >= this.maxItems || bytes > this.maxBytes || now - files[index].mtimeMs > this.maxAgeMs) { await this.fs.unlink(files[index].file).catch(() => {}); removed++; } }
    return removed;
  }
}
module.exports = { ArtifactRepository, artifactId };
