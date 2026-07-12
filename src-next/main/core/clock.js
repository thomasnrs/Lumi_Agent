'use strict';

const systemClock = Object.freeze({
  now: () => Date.now(),
  date: () => new Date(),
  setTimeout: (...args) => setTimeout(...args),
  clearTimeout: (handle) => clearTimeout(handle),
  setInterval: (...args) => setInterval(...args),
  clearInterval: (handle) => clearInterval(handle),
});

module.exports = { systemClock };
