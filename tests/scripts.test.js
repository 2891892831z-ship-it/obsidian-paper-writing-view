'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {fakeScriptViolations: scan, fakeScriptEdits: edits} = require('../src/core');
function apply(text, changes) {
  for (const c of [...changes].reverse()) text = text.slice(0,c.from)+c.insert+text.slice(c.to ?? c.from);
  return text;
}
test('detects numeric, signed and letter scripts in prose, headings, captions and tables', () => {
  const text = '# δ¹³C\n⁴He / ³He CO₂ m³ R² xⁿ H⁺ SO₄²⁻\n| xᵢ | T₉₀ |\n![CO₂](a.png){#fig:a}';
  const issues = scan(text);
  assert.deepEqual(issues.map(i=>i.original), ['¹³','⁴','³','₂','³','²','ⁿ','⁺','₄','²⁻','ᵢ','₉₀','₂']);
  const result = apply(text, edits(text,issues,'now'));
  assert(result.includes('SO<sub>4</sub><sup>2−</sup>'));
  assert(result.includes('![CO<sub>2</sub>](a.png){#fig:a}'));
  assert.equal(scan(result).length,0);
});
test('protects metadata, code, comments, math, citation keys, labels and destinations', () => {
  const text = '---\ntitle: CO₂\n---\n```md\nCO₂\n```\n`R²`\n    CO₂\n<!-- CO₂ --> %% CO₂ %%\n'+
    '$x²$ $$\nx₂\n$$\n\\(x²\\) \\[x₂\\]\n[@key₂; @other²] @key₂\n'+
    '{#fig:CO₂} [[CO₂|CO₂]]\n[CO₂](folder/CO₂(a).md) ![R²](img₂.png)\n'+
    '<a href="CO₂">CO₂</a> https://example.org/CO₂\n[ref]: folder/CO₂.md\nCO2 R2';
  const issues = scan(text);
  assert.deepEqual(issues.map(i=>i.original),['₂','²','₂']);
  assert.equal(issues[0].from,text.indexOf('[CO₂]')+3);
  assert.equal(text.slice(issues[1].from,issues[1].to),'²');
});
test('selective repair keeps offsets, CRLF, other issues and references intact, and updates timestamp', () => {
  const text = '---\r\nmodified: old\r\ntags: [a]\r\n---\r\n😀 CO₂ [@real] R²\r\n';
  const issues = scan(text);
  assert.equal(issues[0].line,4);
  assert.equal(issues[0].column,5);
  const result = apply(text, edits(text,[issues[0]],'2026.10.16 18:00:00'));
  assert(result.includes('😀 CO<sub>2</sub> [@real] R²'));
  assert(result.includes('modified: 2026.10.16 18:00:00\r\ntags: [a]'));
  assert(!/(?<!\r)\n/.test(result));
  assert.deepEqual(edits(text,[],'now'),[]);
});
test('normal numbers and genuine HTML or LaTeX scripts are not flagged', () => {
  assert.deepEqual(scan('CO2 2026 CO<sub>2</sub> <sup>4</sup>He $x^{2}+y_{i}$ `multi\nCO₂`'),[]);
});
