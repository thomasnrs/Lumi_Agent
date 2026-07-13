'use strict';

const fs = require('node:fs');
const path = require('node:path');

class NodeWorkspaceWatchPort {
  watch(root, onChange, onError) {
    const watcher = fs.watch(root, { recursive: true }, onChange);
    watcher.on('error', onError || (() => {}));
    return watcher;
  }
  async signature(root, options) {
    const remote = !!(options && options.remote);
    const names = await fs.promises.readdir(root);
    const pieces = [];
    for (const name of names.sort()) {
      if (['node_modules', '.git', 'dist'].includes(name)) continue;
      if (remote) pieces.push(name);
      else { try { pieces.push(name + (await fs.promises.stat(path.join(root, name))).mtimeMs); } catch (_) { pieces.push(name); } }
    }
    return pieces.join('|');
  }
}

module.exports = { NodeWorkspaceWatchPort };
