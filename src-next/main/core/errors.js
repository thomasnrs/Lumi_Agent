'use strict';

class LumiError extends Error {
  constructor(code, message, options) {
    super(String(message || code || 'erro desconhecido'), options && options.cause ? { cause: options.cause } : undefined);
    this.name = 'LumiError';
    this.code = String(code || 'UNKNOWN');
    this.retryable = !!(options && options.retryable);
    this.details = options && options.details !== undefined ? options.details : undefined;
  }
}

function normalizeError(error, fallbackCode) {
  if (error instanceof LumiError) return error;
  if (error instanceof Error) {
    return new LumiError(fallbackCode || error.code || 'INTERNAL', error.message, {
      cause: error,
      details: error.details,
      retryable: error.retryable,
    });
  }
  return new LumiError(fallbackCode || 'INTERNAL', typeof error === 'string' ? error : 'erro não identificado', {
    details: error && typeof error === 'object' ? error : undefined,
  });
}

function serializeError(error, options) {
  const normalized = normalizeError(error);
  const output = {
    name: normalized.name,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
  };
  if (normalized.details !== undefined) output.details = normalized.details;
  if (options && options.includeStack && normalized.stack) output.stack = normalized.stack;
  return output;
}

module.exports = { LumiError, normalizeError, serializeError };
