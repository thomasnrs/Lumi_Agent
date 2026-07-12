'use strict';
const { AsyncLocalStorage } = require('async_hooks');
function createAsyncContext() { const storage = new AsyncLocalStorage(); return { get: () => storage.getStore(), run: (value, task) => storage.run(value, task) }; }
module.exports = { createAsyncContext };
