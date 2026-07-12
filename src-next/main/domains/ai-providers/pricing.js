'use strict';

const MODEL_PRICES = Object.freeze([
  ['claude-opus-4', 5, 25], ['claude-sonnet-4', 3, 15], ['claude-haiku-4', 1, 5],
  ['gpt-5.5', 5, 30], ['gpt-5-mini', 0.25, 2], ['gpt-5-nano', 0.05, 0.4], ['gpt-5', 1.25, 10],
  ['gpt-4o-mini', 0.15, 0.6], ['gpt-4o', 2.5, 10], ['gpt-4.1-mini', 0.4, 1.6], ['gpt-4.1', 2, 8],
  ['deepseek-v4-pro', 0.44, 0.87], ['deepseek-v4', 0.28, 0.42], ['deepseek-chat', 0.27, 1.1], ['deepseek-reasoner', 0.55, 2.19],
  ['gemini-2.5-pro', 1.25, 10], ['gemini-2.5-flash-lite', 0.1, 0.4], ['gemini-2.5-flash', 0.3, 2.5],
  ['grok-code-fast', 0.2, 1.5], ['grok-4-fast', 0.2, 0.5], ['grok-4', 3, 15],
  ['kimi-k2', 0.6, 2.5], ['glm-4.6', 0.6, 2.2], ['minimax', 0.3, 1.65],
  ['llama-3.3-70b', 0.59, 0.79], ['llama-3.1-8b', 0.05, 0.08],
  ['mistral-small', 0.1, 0.3], ['mistral-large', 2, 6], ['qwen-plus', 0.4, 1.2], ['qwen-turbo', 0.05, 0.2], ['qwen-max', 1.6, 6.4],
  ['sonar', 1, 1], ['command-a', 2.5, 10],
]);

function isFreeEndpoint(config) {
  try { return new URL(String(config && config.baseUrl || '')).hostname.toLowerCase() === 'integrate.api.nvidia.com'; } catch (_) { return false; }
}

function priceFor(model, config) {
  const normalized = String(model || '').toLowerCase();
  if (isFreeEndpoint(config) || !normalized || normalized.includes(':free') || normalized.endsWith('-free') || normalized === 'big-pickle') return [0, 0];
  const found = MODEL_PRICES.find(([prefix]) => normalized.includes(prefix));
  return found ? [found[1], found[2]] : null;
}

function usageHost(config) {
  if (config && config.usageHost) return String(config.usageHost);
  if (config && config.provider === 'anthropic') return 'anthropic';
  try { return new URL(String(config && config.baseUrl || '')).hostname || 'api'; } catch (_) { return 'api'; }
}

module.exports = { MODEL_PRICES, priceFor, usageHost, isFreeEndpoint };
