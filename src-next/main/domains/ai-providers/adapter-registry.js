'use strict';

const { OpenAIAdapter } = require('./openai-adapter');
const { AnthropicAdapter } = require('./anthropic-adapter');
const { ResponsesAdapter } = require('./responses-adapter');
const { GeminiAdapter } = require('./gemini-adapter');
const { providerProtocol, modelCapabilityKey, isExplicitToolUnsupportedError } = require('./protocol');

const PROTOCOL_CAPABILITIES = Object.freeze({
  openai: Object.freeze({ streaming: true, tools: null, vision: null, reasoning: null, nativeContinuity: false }),
  anthropic: Object.freeze({ streaming: true, tools: true, vision: true, reasoning: true, nativeContinuity: false }),
  responses: Object.freeze({ streaming: true, tools: true, vision: true, reasoning: true, nativeContinuity: true }),
  gemini: Object.freeze({ streaming: true, tools: true, vision: true, reasoning: true, nativeContinuity: false }),
});

class ObservedCapabilityStore {
  constructor(options) {
    this.limit = Math.max(10, Number(options && options.limit) || 200);
    this.clock = options && options.clock || { now: () => Date.now() };
    this.entries = new Map();
  }

  get(config) {
    const current = this.entries.get(modelCapabilityKey(config));
    return current ? { ...current } : { tools: null, vision: null, reasoning: null, updatedAt: 0 };
  }

  note(config, patch) {
    const key = modelCapabilityKey(config);
    const next = { ...this.get(config), ...(patch || {}), updatedAt: this.clock.now() };
    this.entries.delete(key);
    this.entries.set(key, next);
    while (this.entries.size > this.limit) this.entries.delete(this.entries.keys().next().value);
    return { ...next };
  }
}

class ProviderAdapterRegistry {
  constructor(options) {
    this.adapters = new Map();
    this.capabilities = options && options.capabilities || new ObservedCapabilityStore();
  }

  register(protocol, adapter) {
    if (!protocol || !adapter || typeof adapter.turn !== 'function') throw new TypeError('adapter de provedor inválido');
    this.adapters.set(String(protocol), adapter);
    return this;
  }

  protocol(config) { return providerProtocol(config); }

  resolve(config) {
    const protocol = this.protocol(config);
    const adapter = this.adapters.get(protocol);
    if (!adapter) throw new Error(`protocolo de provedor não registrado: ${protocol}`);
    return { protocol, adapter };
  }

  describe(config) {
    const protocol = this.protocol(config);
    const baseline = PROTOCOL_CAPABILITIES[protocol] || {};
    const observed = this.capabilities.get(config);
    const capabilities = { ...baseline };
    for (const field of ['tools', 'vision', 'reasoning']) if (observed[field] != null) capabilities[field] = observed[field];
    return { protocol, capabilities, observed };
  }

  async turn(request) {
    const selected = this.resolve(request.config);
    try {
      const result = await selected.adapter.turn(request);
      if (request.tools && request.tools.length && result.toolCalls && result.toolCalls.length) this.capabilities.note(request.config, { tools: true });
      return result;
    } catch (error) {
      if (request.tools && request.tools.length && isExplicitToolUnsupportedError(error)) this.capabilities.note(request.config, { tools: false });
      throw error;
    }
  }
}

function createProviderAdapterRegistry(options) {
  const opts = options || {};
  if (!opts.fetchPolicy) throw new Error('createProviderAdapterRegistry exige fetchPolicy');
  const dependencies = { fetchPolicy: opts.fetchPolicy, clock: opts.clock, nextId: opts.nextId };
  return new ProviderAdapterRegistry({ capabilities: opts.capabilities })
    .register('openai', new OpenAIAdapter(dependencies))
    .register('anthropic', new AnthropicAdapter(dependencies))
    .register('responses', new ResponsesAdapter(dependencies))
    .register('gemini', new GeminiAdapter(dependencies));
}

module.exports = { PROTOCOL_CAPABILITIES, ObservedCapabilityStore, ProviderAdapterRegistry, createProviderAdapterRegistry };
