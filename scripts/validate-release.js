'use strict';
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '..');
const read = name => fs.readFileSync(path.join(root, name), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const pkg = JSON.parse(read('package.json'));
const versions = JSON.parse(read('versions.json'));
if (manifest.id !== 'paper-caption-preview') throw new Error('Plugin id must preserve existing installations.');
if (manifest.version !== pkg.version || versions[manifest.version] !== manifest.minAppVersion) throw new Error('Release versions do not match.');
const tag = process.argv[2];
if (tag && tag !== manifest.version) throw new Error('Release tag must exactly match manifest.version.');
const text = read('main.js');
new vm.Script(text);
if (text.includes("require('./core')")) throw new Error('Root main.js must be bundled for BRAT.');
const imports = [...text.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map(match => match[1]);
if (JSON.stringify(imports) !== JSON.stringify(['obsidian', '@codemirror/state', '@codemirror/view'])) throw new Error('Unexpected runtime dependency.');
for (const name of ['main.js', 'manifest.json', 'styles.css']) {
  const bundled = fs.readFileSync(path.join(root, 'dist', manifest.id, name));
  if (!bundled.equals(fs.readFileSync(path.join(root, name)))) throw new Error('Stale release file: ' + name);
}
console.log('BRAT release validated: ' + manifest.version);
