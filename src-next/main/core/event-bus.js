'use strict';

const { EventEmitter } = require('events');

class EventBus {
  constructor(options) {
    this.emitter = new EventEmitter();
    this.emitter.setMaxListeners((options && options.maxListeners) || 100);
    this.disposed = false;
  }

  on(event, listener) {
    if (this.disposed) throw new Error('event bus descartado');
    if (!event || typeof listener !== 'function') throw new Error('inscrição inválida');
    this.emitter.on(event, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.emitter.off(event, listener);
    };
  }

  emit(event, payload) {
    if (this.disposed) return false;
    return this.emitter.emit(event, payload);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.emitter.removeAllListeners();
  }
}

module.exports = { EventBus };
