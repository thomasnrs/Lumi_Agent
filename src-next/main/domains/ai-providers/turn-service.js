'use strict';

const { priceFor, usageHost } = require('./pricing');

class ProviderTurnService {
  constructor(options) {
    const opts = options || {};
    if (!opts.registry) throw new Error('ProviderTurnService exige registry');
    this.registry = opts.registry;
    this.usage = opts.usage || null;
    this.onFallback = opts.onFallback || (() => {});
    this.onUsageError = opts.onUsageError || (() => {});
  }

  async turn(request) {
    const primary = request.config;
    let active = primary;
    let fallback = false;
    let result;
    try {
      result = await this.registry.turn({ ...request, config: active });
    } catch (error) {
      if (request.signal && request.signal.aborted) throw error;
      const fallbackModel = String(primary.fallbackModel || '').trim();
      if (!fallbackModel || fallbackModel === String(primary.model || '').trim()) throw error;
      fallback = true;
      active = { ...primary, model: fallbackModel };
      await this.onFallback({ error, from: primary.model, to: fallbackModel, config: active });
      result = await this.registry.turn({ ...request, config: active });
    }
    await this.record(active, result && result.usage);
    return { ...result, providerMeta: { protocol: this.registry.protocol(active), model: active.model, fallback } };
  }

  async record(config, usage) {
    if (!this.usage || !usage || (!usage.prompt_tokens && !usage.completion_tokens)) return;
    try { await this.usage.record(usageHost(config), usage, priceFor(config.model, config)); } catch (error) { this.onUsageError(error); }
  }
}

module.exports = { ProviderTurnService };
