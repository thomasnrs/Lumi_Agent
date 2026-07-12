'use strict';

class Scheduler {
  constructor(clock) {
    this.clock = clock || { setTimeout, clearTimeout, setInterval, clearInterval };
    this.handles = new Map();
    this.disposed = false;
    this.sequence = 0;
  }

  timeout(owner, task, delayMs) {
    return this.add('timeout', owner, task, delayMs);
  }

  interval(owner, task, delayMs) {
    return this.add('interval', owner, task, delayMs);
  }

  add(kind, owner, task, delayMs) {
    if (this.disposed) throw new Error('scheduler descartado');
    if (!owner || typeof task !== 'function') throw new Error('timer exige owner e task');
    const id = `timer-${++this.sequence}`;
    const delay = Math.max(0, Number(delayMs) || 0);
    const invoke = () => {
      if (kind === 'timeout') this.handles.delete(id);
      task();
    };
    const handle = kind === 'interval' ? this.clock.setInterval(invoke, delay) : this.clock.setTimeout(invoke, delay);
    this.handles.set(id, { kind, owner, handle });
    return () => this.cancel(id);
  }

  cancel(id) {
    const entry = this.handles.get(id);
    if (!entry) return false;
    this.handles.delete(id);
    if (entry.kind === 'interval') this.clock.clearInterval(entry.handle);
    else this.clock.clearTimeout(entry.handle);
    return true;
  }

  cancelOwner(owner) {
    let count = 0;
    for (const [id, entry] of [...this.handles]) if (entry.owner === owner && this.cancel(id)) count++;
    return count;
  }

  dispose() {
    if (this.disposed) return;
    for (const id of [...this.handles.keys()]) this.cancel(id);
    this.disposed = true;
  }
}

module.exports = { Scheduler };
