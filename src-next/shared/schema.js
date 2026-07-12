'use strict';

class SchemaError extends Error {
  constructor(path, expected, value) {
    super(`${path || '$'}: esperado ${expected}, recebido ${describe(value)}`);
    this.name = 'SchemaError';
    this.path = path || '$';
    this.expected = expected;
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function schema(parse) {
  return Object.freeze({ parse: (value, path) => parse(value, path || '$') });
}

function string(options) {
  const opts = options || {};
  return schema((input, path) => {
    if (typeof input !== 'string') throw new SchemaError(path, 'string', input);
    const value = opts.trim ? input.trim() : input;
    if (opts.min != null && value.length < opts.min) throw new SchemaError(path, `string com >= ${opts.min} caracteres`, value);
    if (opts.max != null && value.length > opts.max) throw new SchemaError(path, `string com <= ${opts.max} caracteres`, value);
    if (opts.pattern && !opts.pattern.test(value)) throw new SchemaError(path, `string compatível com ${opts.pattern}`, value);
    return value;
  });
}

function number(options) {
  const opts = options || {};
  return schema((value, path) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new SchemaError(path, 'number finito', value);
    if (opts.integer && !Number.isInteger(value)) throw new SchemaError(path, 'inteiro', value);
    if (opts.min != null && value < opts.min) throw new SchemaError(path, `number >= ${opts.min}`, value);
    if (opts.max != null && value > opts.max) throw new SchemaError(path, `number <= ${opts.max}`, value);
    return value;
  });
}

function boolean() {
  return schema((value, path) => {
    if (typeof value !== 'boolean') throw new SchemaError(path, 'boolean', value);
    return value;
  });
}

function enumeration(values) {
  const allowed = new Set(values || []);
  return schema((value, path) => {
    if (!allowed.has(value)) throw new SchemaError(path, `um de: ${[...allowed].join(', ')}`, value);
    return value;
  });
}

function optional(inner, defaultValue) {
  return schema((value, path) => value === undefined ? clone(defaultValue) : inner.parse(value, path));
}

function nullable(inner) {
  return schema((value, path) => value === null ? null : inner.parse(value, path));
}

function array(inner, options) {
  const opts = options || {};
  return schema((value, path) => {
    if (!Array.isArray(value)) throw new SchemaError(path, 'array', value);
    if (opts.max != null && value.length > opts.max) throw new SchemaError(path, `array com <= ${opts.max} itens`, value);
    if (opts.min != null && value.length < opts.min) throw new SchemaError(path, `array com >= ${opts.min} itens`, value);
    return value.map((item, index) => inner.parse(item, `${path}[${index}]`));
  });
}

function object(shape, options) {
  const fields = shape || {};
  const opts = options || {};
  return schema((value, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError(path, 'object', value);
    const output = {};
    for (const [key, inner] of Object.entries(fields)) output[key] = inner.parse(value[key], `${path}.${key}`);
    if (opts.allowUnknown) {
      for (const [key, item] of Object.entries(value)) if (!(key in fields)) output[key] = clone(item);
    } else {
      const unknown = Object.keys(value).filter((key) => !(key in fields));
      if (unknown.length) throw new SchemaError(`${path}.${unknown[0]}`, 'campo conhecido', value[unknown[0]]);
    }
    return output;
  });
}

function record(inner, options) {
  const opts = options || {};
  return schema((value, path) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SchemaError(path, 'record', value);
    const entries = Object.entries(value);
    if (opts.max != null && entries.length > opts.max) throw new SchemaError(path, `record com <= ${opts.max} campos`, value);
    return Object.fromEntries(entries.map(([key, item]) => [key, inner.parse(item, `${path}.${key}`)]));
  });
}

function clone(value) {
  if (value === undefined) return undefined;
  return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

module.exports = {
  SchemaError,
  string,
  number,
  boolean,
  enumeration,
  optional,
  nullable,
  array,
  object,
  record,
  clone,
};
