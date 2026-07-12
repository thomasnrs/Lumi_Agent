'use strict';

function requestModel(config) {
  const model = String(config && config.model || '');
  return config && config.provider === 'opencode' ? model.replace(/^opencode(?:-go)?\//i, '') : model;
}

function openCodeProtocol(model, baseUrl) {
  const normalized = String(model || '').toLowerCase().replace(/^opencode(?:-go)?\//, '');
  if (/^gpt-/.test(normalized)) return 'responses';
  if (/^gemini-/.test(normalized)) return 'gemini';
  if (/^(claude-|qwen)/.test(normalized)) return 'anthropic';
  if (/\/zen\/go(?:\/|$)/i.test(String(baseUrl || '')) && /^minimax-m(?:3|2\.7|2\.5)$/.test(normalized)) return 'anthropic';
  return 'openai';
}

function providerProtocol(config) {
  const provider = String(config && config.provider || 'openai').toLowerCase();
  if (provider === 'opencode') return openCodeProtocol(config.model, config.baseUrl);
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'gemini' || provider === 'google') return 'gemini';
  if (provider === 'responses' || provider === 'openai-responses') return 'responses';
  return 'openai';
}

function modelCapabilityKey(config) {
  return [config && config.provider, config && config.baseUrl, config && config.model]
    .map((value) => String(value || '').toLowerCase().replace(/\/+$/, ''))
    .join('|');
}

function isExplicitToolUnsupportedError(error) {
  const message = String(error && error.message || error || '');
  if (/tool_calls?\[?\]?\.?(?:function\.)?arguments|invalid tool call in messages|invalid json/i.test(message)) return false;
  return /(?:tools?|function(?: calling|s)?)\b.{0,100}\b(?:not supported|unsupported|not allowed|unknown|unrecognized|disabled|does not support|extra_forbidden)|(?:not supported|unsupported|not allowed|unknown|unrecognized|disabled|does not support|extra inputs?|extra_forbidden)\b.{0,100}\b(?:tools?|function(?: calling|s)?)/i.test(message);
}

module.exports = { requestModel, openCodeProtocol, providerProtocol, modelCapabilityKey, isExplicitToolUnsupportedError };
