'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {scanDocument, maskExamples, citationMap} = require('../src/core');

test('image inventory includes wiki, inline and list images without duplicating owned figures', () => {
  const {imageInventory,documentIssues}=require('../src/core');
  const text='![A](a.png){#fig:a}\n\n- ![[folder/b.png|200]]\n\n正文 ![C](c.png)\n\n`![[hidden.png]]`\n![[note.md]]';
  assert.deepEqual(imageInventory(text).map(f=>f.src),['a.png','folder/b.png','c.png']);
  assert.equal(documentIssues(text,()=>false).filter(i=>i.type==='missing-image').length,3);
});

test('long HTML captions with nested citation brackets and parenthesized paths', () => {
  const caption = 'CO<sub>2</sub> δ<sup>13</sup>C ' + '长图注'.repeat(400) + ' [@a; @b] [more [nested]]';
  const source = `![${caption}](figures/a(b).png){#fig:gas width=80%}\n正文 @fig:gas`;
  const result = scanDocument(source);
  assert.equal(result.figures.length, 1);
  assert.equal(result.figures[0].caption, caption);
  assert.equal(result.figures[0].src, 'figures/a(b).png');
  assert.equal(result.figures[0].width, '80%');
  assert.equal(result.references[0].number, 1);
  assert.equal(source.slice(result.figures[0].from, result.figures[0].to), source.split('\n')[0]);
});

test('ignore frontmatter, fenced and inline examples, comments and escaped images', () => {
  const source = '---\ntitle: "{#fig:hidden}"\n---\n```md\n![hidden](a.png){#fig:h}\n```\n' +
    '<!-- ![hidden](b.png){#fig:x} -->\n%% ![hidden](c.png) %%\n`![hidden](d.png)`\n' +
    '\\![escaped](e.png)\n    ![code](f.png)\n![real](g.png){#fig:real}\n';
  const result = scanDocument(source);
  assert.equal(maskExamples(source).length, source.length);
  assert.equal(result.figures.length, 1);
  assert.equal(result.figures[0].number, 1);
});

test('angle paths, optional titles, CRLF, separate attribute lines, unlabelled images', () => {
  const source = '![A [@a]](<folder/a (1).png> "title")\r\n{#fig:a}\r\n\r\n![B](b.png)\r\n';
  const result = scanDocument(source);
  assert.equal(result.figures.length, 2);
  assert.equal(result.figures[0].src, 'folder/a (1).png');
  assert.equal(result.figures[0].id, 'a');
  assert.equal(result.figures[1].number, null);
});

test('duplicate labels, unknown references, inline images left to Obsidian', () => {
  const result = scanDocument('![A](a.png){#fig:a}\n![B](b.png){#fig:a}\ntext ![C](c.png)\n@fig:missing');
  assert(result.duplicates.has('a'));
  assert.equal(result.figures.length, 2);
  assert.equal(result.references[0].number, undefined);
});

test('malformed Markdown does not consume later paragraphs', () => {
  const result = scanDocument('![bad](bad.png\n\n![good](ok.png){#fig:good}\n');
  assert.equal(result.figures.length, 1);
  assert.equal(result.figures[0].src, 'ok.png');
});

test('adjacent images share one block range and retain individual labels and captions', () => {
  const source = '  ![A](a.png){#fig:a}  ![B](b.png){#fig:b width=80%}\r\n\r\n@fig:b';
  const result = scanDocument(source);
  assert.equal(result.figures.length, 2);
  assert.deepEqual(result.figures.map(f => [f.caption, f.id, f.number]), [['A', 'a', 1], ['B', 'b', 2]]);
  assert.equal(result.figures[1].width, '80%');
  assert.equal(result.figures[0].groupFrom, 0);
  assert.equal(result.figures[0].groupTo, source.indexOf('\r\n'));
  assert.equal(result.figures[1].groupTo, result.figures[0].groupTo);
  assert.equal(result.references[0].number, 2);
  assert.equal(scanDocument('![A](a.png) ![B](b.png) trailing prose').figures.length, 0);
  assert.equal(scanDocument('text ![A](a.png) ![B](b.png)').figures.length, 0);
});

test('equation labels get sequential numbers and inline references resolve', () => {
  const source = '文字\n\n$$\na\n$$\n{#eq:first}\n\n文字 @eq:first 继续 @eq:missing 与 @fig:one\n\n![图](x.png){#fig:one}\n';
  const result = scanDocument(source);
  assert.equal(result.equations.length, 1);
  assert.equal(result.eqNumbers.get('first'), 1);
  assert.equal(source.slice(result.equations[0].from, result.equations[0].to), '{#eq:first}');
  const eq = result.references.find(r => r.type === 'eq');
  assert.equal(eq.id, 'first'); assert.equal(eq.number, 1);
  assert.equal(result.references.find(r => r.id === 'missing').number, undefined);
  assert.equal(result.references.find(r => r.type === 'fig').number, 1);
});

test('citation rendering uses the exact cluster returned by CSL, including multi cites', () => {
  const cache = {citations: [{data: [{val:'['}, {val:'@a; @b'}, {val:']'}], val:'(A, 2020; B, 2021)', citations:[{id:'a'}, {id:'b'}]}]};
  assert.equal(citationMap(cache).get('[@a; @b]').value, '(A, 2020; B, 2021)');
  assert.equal(citationMap(null).size, 0);
});
