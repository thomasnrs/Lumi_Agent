'use strict';

class Lifecycle {
  constructor() {
    this.state = 'idle';
    this.entries = [];
    this.started = [];
  }

  register(name, service) {
    if (this.state !== 'idle') throw new Error(`não é possível registrar ${name} durante ${this.state}`);
    if (!name || this.entries.some((entry) => entry.name === name)) throw new Error(`serviço duplicado: ${name}`);
    this.entries.push({ name, service: service || {} });
    return service;
  }

  async start(context) {
    if (this.state !== 'idle') throw new Error(`lifecycle não pode iniciar durante ${this.state}`);
    this.state = 'starting';
    try {
      for (const entry of this.entries) {
        if (typeof entry.service.start === 'function') await entry.service.start(context);
        this.started.push(entry);
      }
      this.state = 'running';
    } catch (error) {
      await this.stop({ reason: 'start-failed', cause: error });
      throw error;
    }
  }

  async stop(context) {
    if (this.state === 'stopped' || this.state === 'stopping') return [];
    this.state = 'stopping';
    const errors = [];
    for (const entry of this.started.splice(0).reverse()) {
      try {
        if (typeof entry.service.stop === 'function') await entry.service.stop(context);
        else if (typeof entry.service.dispose === 'function') await entry.service.dispose(context);
      } catch (error) {
        errors.push({ name: entry.name, error });
      }
    }
    this.state = 'stopped';
    return errors;
  }
}

module.exports = { Lifecycle };
