'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
const fn = source.slice(source.indexOf('class ReferenceSuggest'), source.indexOf('function appendRichText'));
const context = {EditorSuggest: class {}, EditorState: {languageData: {of: f => f}}, editorInfoField: 1,
  ...require('../src/core')};
vm.createContext(context);
vm.runInContext(fn + ';this.suggest = new ReferenceSuggest();', context);
test('Obsidian suggestion triggers on @fig and replaces its entire source token', () => {
  const text = '正文（@fig）';
  let replacement, cursor;
  const editor = {getLine: () => text, getValue: () => '![图](a.png){#fig:a}',
    replaceRange: (...args) => {replacement = args;}, setCursor: pos => {cursor = pos;}};
  const trigger = context.suggest.onTrigger({line: 0, ch: 7}, editor, {path: 'note.md'});
  assert.equal(trigger.query, '@fig');
  const suggestions = context.suggest.getSuggestions({...trigger, editor});
  assert.equal(suggestions[0].value, '@fig:a');
  context.suggest.context = {...trigger, editor};
  context.suggest.close = () => {};
  context.suggest.selectSuggestion(suggestions[0]);
  assert.equal(replacement[0], '@fig:a');
  assert.equal(replacement[1].ch, 3);
  assert.equal(replacement[2].ch, 7);
  assert.equal(cursor.ch, 9);
});
test('native suggestion searches Chinese captions and avoids citation keys, examples and IME composition', () => {
  const editor = {getLine: () => '@fig:迁移', getValue: () => '![氦气迁移](a.png){#fig:a}'};
  const trigger = context.suggest.onTrigger({line: 0, ch: 7}, editor, {path: 'note.md'});
  assert.equal(context.suggest.getSuggestions({...trigger, editor})[0].title, '氦气迁移');
  editor.getLine = () => '@Smith2024';
  assert.equal(context.suggest.onTrigger({line: 0, ch: 10}, editor, {}), null);
  editor.getLine = () => '`@fig`'; editor.getValue = () => '`@fig`'; editor.posToOffset = pos => pos.ch;
  assert.equal(context.suggest.onTrigger({line: 0, ch: 5}, editor, {}), null);
  editor.cm = {composing: true};
  assert.equal(context.suggest.onTrigger({line: 0, ch: 5}, editor, {}), null);
});
