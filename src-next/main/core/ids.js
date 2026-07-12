'use strict';

const crypto = require('crypto');

function safePrefix(prefix) {
  const value = String(prefix || 'id').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return value || 'id';
}

function createIdFactory(options) {
  const opts = options || {};
  const randomUUID = opts.randomUUID || (() => crypto.randomUUID());
  const now = opts.now || (() => Date.now());
  let sequence = 0;
  return function nextId(prefix) {
    sequence = (sequence + 1) % 0x1000000;
    const random = String(randomUUID()).replace(/-/g, '').slice(0, 12);
    return `${safePrefix(prefix)}_${Number(now()).toString(36)}_${sequence.toString(36)}_${random}`;
  };
}

module.exports = { createIdFactory, safePrefix };
