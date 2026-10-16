'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const {referenceItems, documentIssues, blankLineViolations, blankLineEdits} = require('../src/core');
const doc = '![CO<sub>2</sub> 氦气迁移 [@real]](a.png){#fig:a}\n\n: 样品统计 {#tbl:b}\n\n$$\nx=1\n$$\n{#eq:c}\n\n$$\ny=2\n$$\n{#eq:d}';
test('reference search shows captions and isolates the adjacent equation', () => {
  assert.equal(referenceItems(doc, '@fig:迁移')[0].title, 'CO2 氦气迁移');
  assert.equal(referenceItems(doc, '@tbl:统计')[0].value, '@tbl:b');
  assert.equal(referenceItems(doc, '@eq:y')[0].title, 'y=2');
  assert.equal(referenceItems(doc, '@fig:统计').length, 0);
});
test('diagnostics separate missing files, deleted targets, duplicated labels and reused sources', () => {
  const text = doc + '\n\n![重复](a.png){#fig:a}\n\n@fig:deleted @eq:missing\n\n{#fig:orphan}\n\n`@fig:example`\n';
  const issues = documentIssues(text, () => false);
  assert.equal(issues.filter(i => i.type === 'missing-image').length, 2);
  assert.equal(issues.filter(i => i.type === 'missing-reference').length, 2);
  assert.equal(issues.filter(i => i.type === 'duplicate-label').length, 1);
  assert.equal(issues.filter(i => i.type === 'reused-image').length, 1);
  assert.equal(issues.filter(i => i.type === 'orphan-label').length, 1);
});
function apply(text, edits) { for (const e of [...edits].reverse()) text = text.slice(0,e.from) + e.insert + text.slice(e.to ?? e.from); return text; }
test('selected blank repair preserves citations, metadata and CRLF in one edit plan', () => {
  const text = '---\r\ntags: [a]\r\ndate modified: old\r\n---\r\n正文 [@real]\r\n![图](a.png){#fig:a}\r\n下一段\r\n';
  const issues = blankLineViolations(text).violations;
  assert.equal(issues.length, 2);
  const result = apply(text, blankLineEdits(text, [issues[0]], '2026.10.16 12:00:00'));
  assert(result.includes('正文 [@real]\r\n\r\n![图](a.png){#fig:a}\r\n下一段'));
  assert(result.includes('tags: [a]\r\ndate modified: 2026.10.16 12:00:00'));
  assert(!/(?<!\r)\n/.test(result));
});
test('repair adds a timestamp only when edits are selected', () => {
  const text = '正文\n![图](a.png)';
  assert.equal(blankLineEdits(text, [], 'now').length, 0);
  const result = apply(text, blankLineEdits(text, blankLineViolations(text).violations, 'now'));
  assert(result.startsWith('---\ndate modified: now\n---\n正文\n\n'));
});
