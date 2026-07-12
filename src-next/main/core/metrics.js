'use strict';

function labelKey(labels) {
  return Object.entries(labels || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${String(value)}`).join(',');
}

class MetricsRegistry {
  constructor(options) {
    const opts = options || {};
    this.clock = opts.clock || { now: () => Date.now() };
    this.maxSeries = Math.max(10, Number(opts.maxSeries) || 500);
    this.series = new Map();
  }

  entry(type, name, labels) {
    const metric = String(name || '').trim();
    if (!/^[a-z][a-z0-9_.-]*$/i.test(metric)) throw new Error(`nome de métrica inválido: ${name}`);
    const key = `${type}:${metric}:${labelKey(labels)}`;
    if (!this.series.has(key)) {
      if (this.series.size >= this.maxSeries) throw new Error(`limite de séries excedido (${this.maxSeries})`);
      this.series.set(key, { type, name: metric, labels: { ...(labels || {}) }, count: 0, sum: 0, min: null, max: null, value: 0 });
    }
    return this.series.get(key);
  }

  increment(name, amount, labels) {
    const entry = this.entry('counter', name, labels);
    const value = amount == null ? 1 : Number(amount);
    if (!Number.isFinite(value) || value < 0) throw new Error('counter exige incremento finito e não negativo');
    entry.value += value;
    return entry.value;
  }

  gauge(name, value, labels) {
    const entry = this.entry('gauge', name, labels);
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error('gauge exige valor finito');
    entry.value = number;
    return number;
  }

  observe(name, value, labels) {
    const entry = this.entry('histogram', name, labels);
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) throw new Error('histogram exige valor finito e não negativo');
    entry.count++;
    entry.sum += number;
    entry.min = entry.min == null ? number : Math.min(entry.min, number);
    entry.max = entry.max == null ? number : Math.max(entry.max, number);
    return number;
  }

  timer(name, labels) {
    const started = this.clock.now();
    let ended = false;
    return () => {
      if (ended) return null;
      ended = true;
      return this.observe(name, Math.max(0, this.clock.now() - started), labels);
    };
  }

  snapshot() {
    return [...this.series.values()].map((entry) => ({ ...entry, labels: { ...entry.labels } })).sort((a, b) => a.name.localeCompare(b.name) || labelKey(a.labels).localeCompare(labelKey(b.labels)));
  }
}

module.exports = { MetricsRegistry, labelKey };
