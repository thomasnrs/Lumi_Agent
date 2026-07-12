'use strict';

const { clone } = require('../../../shared/schema');
const { LumiError } = require('../../core/errors');

function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return clone(patch);
  const output = base && typeof base === 'object' && !Array.isArray(base) ? clone(base) : {};
  for (const [key, value] of Object.entries(patch)) {
    output[key] = value && typeof value === 'object' && !Array.isArray(value) ? deepMerge(output[key], value) : clone(value);
  }
  return output;
}

class ConfigService {
  constructor(options) {
    const opts = options || {};
    if (!opts.store) throw new Error('ConfigService exige store');
    this.store = opts.store;
    this.currentVersion = Math.max(1, Number(opts.currentVersion) || 1);
    this.defaults = clone(opts.defaults || {});
    this.migrations = new Map(Object.entries(opts.migrations || {}).map(([version, migrate]) => [Number(version), migrate]));
    this.validate = opts.validate || ((value) => value);
    this.value = null;
    this.source = '';
  }

  async initialize() {
    const loaded = await this.store.read();
    let value = loaded.value && typeof loaded.value === 'object' ? clone(loaded.value) : {};
    let version = Number(value.schemaVersion) || 0;
    if (version > this.currentVersion) throw new LumiError('CONFIG_FUTURE_VERSION', `config versão ${version} é mais nova que ${this.currentVersion}`);
    let migrated = false;
    while (version < this.currentVersion) {
      const migrate = this.migrations.get(version);
      if (typeof migrate !== 'function') throw new LumiError('CONFIG_MIGRATION_MISSING', `migration ausente: ${version} -> ${version + 1}`);
      value = await migrate(clone(value));
      version++;
      value.schemaVersion = version;
      migrated = true;
    }
    value = this.validate(deepMerge(this.defaults, value));
    value.schemaVersion = this.currentVersion;
    this.value = clone(value);
    this.source = loaded.source;
    if (migrated || loaded.source !== 'primary') await this.store.write(this.value);
    return this.get();
  }

  get() {
    if (!this.value) throw new Error('ConfigService ainda não inicializado');
    return clone(this.value);
  }

  async patch(partial) {
    if (!this.value) throw new Error('ConfigService ainda não inicializado');
    const next = this.validate(deepMerge(this.value, partial || {}));
    next.schemaVersion = this.currentVersion;
    await this.store.write(next);
    this.value = clone(next);
    return this.get();
  }

  async replace(value) {
    const next = this.validate(deepMerge(this.defaults, value || {}));
    next.schemaVersion = this.currentVersion;
    await this.store.write(next);
    this.value = clone(next);
    return this.get();
  }
}

module.exports = { ConfigService, deepMerge };
