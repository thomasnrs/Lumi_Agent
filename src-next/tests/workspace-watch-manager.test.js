'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { WorkspaceWatchManager, shouldIgnore } = require('../main/domains/workspace/workspace-watch-manager');

class Clock {
  constructor() { this.next = 1; this.timeouts = new Map(); this.intervals = new Map(); }
  setTimeout(fn) { const id = this.next++; this.timeouts.set(id, fn); return id; }
  clearTimeout(id) { this.timeouts.delete(id); }
  setInterval(fn) { const id = this.next++; this.intervals.set(id, fn); return id; }
  clearInterval(id) { this.intervals.delete(id); }
  tickTimeouts() { const current = [...this.timeouts.values()]; this.timeouts.clear(); current.forEach((fn) => fn()); }
  async tickIntervals() { for (const fn of [...this.intervals.values()]) await fn(); }
}

test('watch manager compartilha watcher por root, ignora ruído e debounce mudanças', () => {
  const clock = new Clock(), changes = [], contexts = [];
  let handler, closes = 0, watches = 0;
  const manager = new WorkspaceWatchManager({
    clock, port: { watch: (_root, next) => (watches++, handler = next, { close: () => closes++ }) },
    onChange: (event) => changes.push(event), onProjectContextChange: (event) => contexts.push(event),
  });
  const offA = manager.subscribe('/ws', 'a'), offB = manager.subscribe('/ws', 'b');
  assert.equal(watches, 1);
  handler('change', 'node_modules/a.js'); clock.tickTimeouts(); assert.equal(changes.length, 0);
  handler('change', 'package.json'); handler('change', 'src/a.js');
  assert.equal(contexts.length, 1); clock.tickTimeouts();
  assert.equal(changes.length, 1); assert.equal(changes[0].root, '/ws');
  offA(); assert.equal(closes, 0); offB(); assert.equal(closes, 1);
});

test('watch manager usa polling quando watch não está disponível e libera timer', async () => {
  const clock = new Clock(), changes = [];
  const signatures = ['a', 'b'];
  const manager = new WorkspaceWatchManager({
    clock,
    port: { watch: () => { throw new Error('recursive indisponível'); }, signature: async () => signatures.shift() || 'b' },
    onChange: (event) => changes.push(event),
  });
  const off = manager.subscribe('/remote', 'owner', { remote: true });
  await clock.tickIntervals(); await clock.tickIntervals(); clock.tickTimeouts();
  assert.equal(changes.length, 1);
  off(); assert.equal(clock.intervals.size, 0);
});

test('filtro preserva .lumi-memory e descarta internos/pastas pesadas', () => {
  assert.equal(shouldIgnore('.lumi-cache/x'), true);
  assert.equal(shouldIgnore('.lumi-memory.md'), false);
  assert.equal(shouldIgnore('src/node_modules/a.js'), true);
  assert.equal(shouldIgnore('src/a.js'), false);
});
