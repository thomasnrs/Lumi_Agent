'use strict';

const SENSITIVE_KEY = /(?:api[-_]?key|token|secret|password|passwd|authorization|cookie|private[-_]?key|access[-_]?key)/i;
const INLINE_SECRET = /\b((?:sk|hf|ghp|github_pat|xox[baprs])[-_][a-z0-9._-]{8,}|Bearer\s+[a-z0-9._~+\/-]{8,})\b/gi;
const URL_CREDENTIALS = /(https?:\/\/[^\s:/]+:)([^@\s/]+)(@)/gi;

function redactString(value) {
  return String(value).replace(INLINE_SECRET, '[oculto]').replace(URL_CREDENTIALS, '$1[oculto]$3');
}

function redact(value, options, seen) {
  const opts = options || {};
  const visited = seen || new WeakSet();
  if (typeof value === 'string') return redactString(value);
  if (value == null || typeof value !== 'object') return value;
  if (visited.has(value)) return '[circular]';
  visited.add(value);
  if (Array.isArray(value)) return value.slice(0, opts.maxArray || 100).map((item) => redact(item, opts, visited));
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SENSITIVE_KEY.test(key) ? '[oculto]' : redact(item, opts, visited);
  }
  return output;
}

module.exports = { redact, redactString, SENSITIVE_KEY };
