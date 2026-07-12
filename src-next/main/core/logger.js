'use strict';

const { redact } = require('./redaction');
const { serializeError } = require('./errors');

const LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });

function createLogger(options) {
  const opts = options || {};
  const sink = typeof opts.sink === 'function' ? opts.sink : () => {};
  const clock = opts.clock || { now: () => Date.now() };
  const threshold = LEVELS[opts.level] || LEVELS.info;
  const base = Object.freeze({ ...(opts.context || {}) });

  function write(level, message, data) {
    if (LEVELS[level] < threshold) return;
    const payload = data instanceof Error ? { error: serializeError(data, { includeStack: level === 'error' }) } : data;
    sink(redact({ ...base, ...(payload || {}), ts: clock.now(), level, message: String(message || '') }));
  }

  const logger = {
    debug: (message, data) => write('debug', message, data),
    info: (message, data) => write('info', message, data),
    warn: (message, data) => write('warn', message, data),
    error: (message, data) => write('error', message, data),
    child(context) {
      return createLogger({ ...opts, sink, clock, context: { ...base, ...(context || {}) } });
    },
    async time(name, task, context) {
      const started = clock.now();
      try {
        const result = await task();
        write('info', `${name}:done`, { ...(context || {}), durationMs: clock.now() - started });
        return result;
      } catch (error) {
        write('error', `${name}:failed`, { ...(context || {}), durationMs: clock.now() - started, error: serializeError(error) });
        throw error;
      }
    },
  };
  return Object.freeze(logger);
}

module.exports = { createLogger, LEVELS };
