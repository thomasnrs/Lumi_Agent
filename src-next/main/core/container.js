'use strict';

class Container {
  constructor() {
    this.definitions = new Map();
    this.instances = new Map();
    this.resolving = [];
  }

  value(name, value) {
    return this.factory(name, () => value);
  }

  factory(name, create) {
    if (!name || typeof create !== 'function') throw new Error('definição de dependência inválida');
    if (this.definitions.has(name)) throw new Error(`dependência duplicada: ${name}`);
    this.definitions.set(name, create);
    return this;
  }

  resolve(name) {
    if (this.instances.has(name)) return this.instances.get(name);
    const create = this.definitions.get(name);
    if (!create) throw new Error(`dependência não registrada: ${name}`);
    if (this.resolving.includes(name)) throw new Error(`dependência circular: ${[...this.resolving, name].join(' -> ')}`);
    this.resolving.push(name);
    try {
      const instance = create((dependency) => this.resolve(dependency));
      this.instances.set(name, instance);
      return instance;
    } finally {
      this.resolving.pop();
    }
  }

  clear() {
    this.instances.clear();
    this.resolving.length = 0;
  }
}

module.exports = { Container };
