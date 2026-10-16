'use strict';
// Explicit local installer utility; the plugin itself never edits other plugins.
const fs = require('fs'), path = require('path');
const target = process.argv[2];
if (!target || !path.isAbsolute(target)) throw new Error('Provide the absolute path to pandoc-live-preview/main.js.');
let text = fs.readFileSync(target, 'utf8');
if (text.includes('this.paperCaptionCompatibility = 1;')) { console.log('Compatibility bridge already installed.'); process.exit(0); }
const before = text;
const changes = [
  ['        function addDecoration(start, end, type, id, isDef, suffix = "", hasParen = false) {',
    '        function addDecoration(start, end, type, id, isDef, suffix = "", hasParen = false) {\n            const captionPlugin = currentApp?.plugins?.plugins["paper-caption-preview"];\n            if (captionPlugin?.compatibilityVersion === 1 && captionPlugin.ownsRange(text, start, end)) return;'],
  ['                const rEnd = rStart + rescueMatch[0].length;',
    '                const rEnd = rStart + rescueMatch[0].length;\n                const captionPlugin = currentApp?.plugins?.plugins["paper-caption-preview"];\n                if (captionPlugin?.compatibilityVersion === 1 && captionPlugin.ownsRange(text, rStart, rEnd)) continue;'],
  ['    async onload() {\n        await this.loadSettings();',
    '    async onload() {\n        this.paperCaptionCompatibility = 1;\n        await this.loadSettings();']
];
// Normalize only for matching; preserve original line ending style on write.
const crlf = text.includes('\r\n'); text = text.replace(/\r\n/g, '\n');
for (const [from, to] of changes) {
  if (!text.includes(from)) throw new Error('Unsupported legacy plugin version; no files changed.');
  text = text.replace(from, to);
}
const backup = target + '.before-paper-caption-preview.bak';
if (!fs.existsSync(backup)) fs.writeFileSync(backup, before);
fs.writeFileSync(target, crlf ? text.replace(/\n/g, '\r\n') : text);
console.log('Compatibility bridge installed; original saved to ' + backup);
