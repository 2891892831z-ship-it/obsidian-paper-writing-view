'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const root = path.resolve(__dirname, '..');
test('release is valid single-file JavaScript with only Obsidian/CodeMirror external imports', () => {
  cp.execFileSync(process.execPath, [path.join(root, 'scripts/build.js')]);
  const text = fs.readFileSync(path.join(root, 'dist/paper-caption-preview/main.js'), 'utf8');
  new vm.Script(text);
  assert(!text.includes("require('./core')"));
  const imports = [...text.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(m => m[1]);
  assert.deepEqual(imports, ['obsidian', '@codemirror/state', '@codemirror/view']);
});
