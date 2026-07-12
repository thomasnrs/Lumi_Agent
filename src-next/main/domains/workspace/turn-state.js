'use strict';

class WorkspaceTurnState {
  constructor() { this.read = new Set(); }
  markRead(path) { this.read.add(String(path)); }
  wasRead(path) { return this.read.has(String(path)); }
  reset() { this.read.clear(); }
}

module.exports = { WorkspaceTurnState };
