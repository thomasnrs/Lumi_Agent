'use strict';

const fs = require('node:fs');
const path = require('node:path');

class NodeFilesystem {
  async stat(target) { return fs.promises.stat(target); }
  async readDir(target, options) { return fs.promises.readdir(target, options); }
  async readFile(target) { return fs.promises.readFile(target); }
  async writeFile(target, value) { await fs.promises.mkdir(path.dirname(target), { recursive: true }); return fs.promises.writeFile(target, value); }
  async appendFile(target, value) { await fs.promises.mkdir(path.dirname(target), { recursive: true }); return fs.promises.appendFile(target, value); }
  async mkdir(target) { return fs.promises.mkdir(target, { recursive: true }); }
  async remove(target) { return fs.promises.rm(target, { recursive: true, force: true }); }
  async exists(target) { try { await fs.promises.access(target); return true; } catch (_) { return false; } }
  resolve(...parts) { return path.resolve(...parts); }
  relative(from, to) { return path.relative(from, to); }
  join(...parts) { return path.join(...parts); }
  dirname(target) { return path.dirname(target); }
  isAbsolute(target) { return path.isAbsolute(target); }
}

module.exports = { NodeFilesystem };
