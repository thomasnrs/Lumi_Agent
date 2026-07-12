'use strict';

const { clone } = require('../../../shared/schema');

function emptyDay(day) { return { day, prov: {} }; }

function normalizeUsage(value, day) {
  if (!value || typeof value !== 'object' || value.day !== day) return emptyDay(day);
  const prov = {};
  for (const [host, item] of Object.entries(value.prov || {})) {
    if (!item || typeof item !== 'object') continue;
    prov[String(host).slice(0, 200)] = {
      in: Math.max(0, Number(item.in) || 0), out: Math.max(0, Number(item.out) || 0), usd: Math.max(0, Number(item.usd) || 0),
      ...(item.unknown ? { unknown: true } : {}),
    };
  }
  return { day, prov };
}

class UsageRepository {
  constructor(options) {
    const opts = options || {};
    if (!opts.store) throw new Error('UsageRepository exige store');
    this.store = opts.store;
    this.clock = opts.clock || { date: () => new Date() };
    this.value = null;
  }

  today() { return this.clock.date().toISOString().slice(0, 10); }
  async initialize() { const loaded = await this.store.read(); this.value = normalizeUsage(loaded.value, this.today()); return this.snapshot(); }
  ensureDay() { const day = this.today(); if (!this.value || this.value.day !== day) this.value = emptyDay(day); }

  async record(host, usage, price) {
    this.ensureDay();
    const key = String(host || 'api').slice(0, 200);
    const current = this.value.prov[key] || (this.value.prov[key] = { in: 0, out: 0, usd: 0 });
    const input = Math.max(0, Number(usage && usage.prompt_tokens) || 0);
    const output = Math.max(0, Number(usage && usage.completion_tokens) || 0);
    current.in += input; current.out += output;
    if (Array.isArray(price)) current.usd += (input * Number(price[0] || 0) + output * Number(price[1] || 0)) / 1e6;
    else current.unknown = true;
    await this.store.write(this.value);
    return this.totals();
  }

  totals() {
    this.ensureDay();
    const result = { day: this.value.day, usd: 0, in: 0, out: 0, unknown: false };
    for (const item of Object.values(this.value.prov)) { result.usd += item.usd; result.in += item.in; result.out += item.out; if (item.unknown) result.unknown = true; }
    return result;
  }

  snapshot() { this.ensureDay(); return clone(this.value); }
}

module.exports = { UsageRepository, normalizeUsage, emptyDay };
