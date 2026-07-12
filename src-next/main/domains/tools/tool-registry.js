'use strict';

const { selectedToolNames } = require('./toolsets');

const ARG_ALIASES = Object.freeze({
  path: ['file', 'filepath', 'file_path', 'filename', 'file_name', 'target', 'dir'], content: ['text', 'contents', 'body', 'data', 'value'],
  pattern: ['query', 'search', 'term', 'regex_pattern'], command: ['cmd', 'shell', 'script'], old_text: ['old', 'oldtext', 'old_string', 'before', 'find'],
  new_text: ['new', 'newtext', 'new_string', 'after', 'replacement', 'replace'], url: ['link', 'uri', 'address'], question: ['prompt', 'message', 'text'],
});

function normalizeToolArgs(definition, input) {
  const args = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  const properties = definition && definition.schema && definition.schema.parameters && definition.schema.parameters.properties || {};
  for (const key of Object.keys(properties)) {
    if (args[key] !== undefined) continue;
    const alias = (ARG_ALIASES[key] || []).find((candidate) => args[candidate] !== undefined);
    if (alias) args[key] = args[alias];
  }
  return args;
}

class ToolRegistry {
  constructor() { this.definitions = new Map(); }
  register(name, definition) {
    const key = String(name || definition && definition.schema && definition.schema.name || '');
    if (!key || !definition || typeof definition.run !== 'function') throw new TypeError('definição de ferramenta inválida');
    if (this.definitions.has(key)) throw new Error(`ferramenta duplicada: ${key}`);
    this.definitions.set(key, { ...definition, name: key });
    return this;
  }
  get(name) { return this.definitions.get(String(name)); }
  names() { return [...this.definitions.keys()]; }
  schemas(options) {
    const opts = options || {};
    const allow = opts.allow ? new Set(opts.allow) : opts.toolsets ? selectedToolNames(opts.toolsets, opts.delegate) : null;
    return [...this.definitions.values()]
      .filter((definition) => (!allow || allow.has(definition.name)) && (definition.name !== 'delegate_to_agent' || opts.delegate))
      .map((definition) => ({ type: 'function', function: definition.schema }));
  }
}

module.exports = { ARG_ALIASES, normalizeToolArgs, ToolRegistry };
