'use strict';

const crypto = require('node:crypto');

function modelIdsFromResponse(value) {
  const items = value && (value.data || value.models) || [];
  return [...new Set(items.map((item) => typeof item === 'string' ? item : item && (item.id || item.name)).filter(Boolean).map((id) => String(id).replace(/^models\//, '')))].sort();
}

function catalogKey(config) {
  const raw = [config && config.provider, config && config.baseUrl].map((value) => String(value || '').toLowerCase().replace(/\/+$/, '')).join('|');
  return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 24);
}

class ModelCatalogService {
  constructor(options) {
    const opts = options || {};
    if (!opts.fetchPolicy) throw new Error('ModelCatalogService exige fetchPolicy');
    this.fetchPolicy = opts.fetchPolicy;
    this.clock = opts.clock || { now: () => Date.now() };
    this.ttlMs = Math.max(1000, Number(opts.ttlMs) || 10 * 60 * 1000);
    this.cache = opts.cache || new Map();
  }

  async list(config, options) {
    const key = catalogKey(config);
    const cached = this.cache.get(key);
    if (!(options && options.force) && cached && this.clock.now() - cached.at < this.ttlMs) return { models: [...cached.models], cached: true, stale: false };
    try {
      const response = await this.fetchPolicy.request(config, this.url(config), { headers: this.headers(config), signal: options && options.signal });
      if (!response.ok) throw new Error(`models HTTP ${response.status}: ${await response.text()}`);
      const models = modelIdsFromResponse(await response.json());
      this.cache.set(key, { at: this.clock.now(), models: [...models] });
      return { models, cached: false, stale: false };
    } catch (error) {
      if (cached) return { models: [...cached.models], cached: true, stale: true, error: String(error && error.message || error) };
      throw error;
    }
  }

  url(config) {
    const provider = String(config && config.provider || '').toLowerCase();
    const fallback = provider === 'anthropic' ? 'https://api.anthropic.com/v1' : provider === 'gemini' || provider === 'google' ? 'https://generativelanguage.googleapis.com/v1beta' : 'https://api.openai.com/v1';
    return String(config && config.baseUrl || fallback).replace(/\/$/, '') + '/models';
  }

  headers(config) {
    const provider = String(config && config.provider || '').toLowerCase();
    if (provider === 'anthropic') return { 'x-api-key': config.apiKey || '', 'anthropic-version': '2023-06-01' };
    if (provider === 'gemini' || provider === 'google') return config.apiKey ? { 'x-goog-api-key': config.apiKey } : {};
    return config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {};
  }
}

module.exports = { ModelCatalogService, modelIdsFromResponse, catalogKey };
