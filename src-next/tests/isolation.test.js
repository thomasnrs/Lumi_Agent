'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');

function sourceFiles(dir, out) {
  const files = out || [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sourceFiles(full, files);
    else if (/\.(?:js|cjs|mjs|html|css|json)$/.test(entry.name)) files.push(full);
  }
  return files;
}

test('src-next permanece fora do entrypoint, build e pacote atuais', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'src/main/main.js');
  assert.match(pkg.scripts.build, /src\/renderer\/main\.js/);
  assert.ok((pkg.build.files || []).some((entry) => entry === 'src/**/*'));
  assert.ok(!(pkg.build.files || []).some((entry) => String(entry).includes('src-next')));
});

test('a árvore de produção não referencia src-next antes do cutover', () => {
  const violations = [];
  for (const file of sourceFiles(path.join(root, 'src'))) {
    const content = fs.readFileSync(file, 'utf8');
    if (/src-next|src_next/.test(content)) violations.push(path.relative(root, file));
  }
  assert.deepEqual(violations, []);
});
