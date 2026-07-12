'use strict';

const { clone } = require('../../../shared/schema');

function normalizeFact(value, clock) {
  if (typeof value === 'string') value = { fact: value };
  if (!value || typeof value !== 'object') return null;
  const fact = String(value.fact || '').trim().slice(0, 2000);
  if (!fact) return null;
  return { fact, at: value.at || clock.date().toISOString() };
}

class FactsRepository {
  constructor(options) {
    const opts = options || {};
    if (!opts.store) throw new Error('FactsRepository exige store');
    this.store = opts.store;
    this.clock = opts.clock || { date: () => new Date() };
    this.limit = Math.max(1, Number(opts.limit) || 100);
    this.items = [];
  }

  async initialize() {
    const loaded = await this.store.read();
    const source = Array.isArray(loaded.value) ? loaded.value : Array.isArray(loaded.value && loaded.value.items) ? loaded.value.items : [];
    this.items = source.map((item) => normalizeFact(item, this.clock)).filter(Boolean).slice(-this.limit);
    if (loaded.source !== 'primary' || !Array.isArray(loaded.value)) await this.persist();
    return this.list();
  }

  list() { return clone(this.items); }

  async add(fact) {
    const item = normalizeFact(fact, this.clock);
    if (!item) throw new Error('fato vazio');
    this.items.push(item);
    this.items = this.items.slice(-this.limit);
    await this.persist();
    return clone(item);
  }

  async set(index, fact) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) return false;
    const item = normalizeFact(typeof fact === 'object' ? fact : { ...this.items[i], fact }, this.clock);
    if (!item) throw new Error('fato vazio');
    this.items[i] = item;
    await this.persist();
    return true;
  }

  async delete(index) {
    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= this.items.length) return false;
    this.items.splice(i, 1);
    await this.persist();
    return true;
  }

  async clear() { this.items = []; await this.persist(); }
  persist() { return this.store.write(this.items); }
}

module.exports = { FactsRepository, normalizeFact };
