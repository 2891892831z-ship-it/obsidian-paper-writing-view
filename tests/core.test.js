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

test('fenced caption divs are scanned with their content, nesting and exclusions', () => {
  const inner = 'Fig. [-@fig:en] Typical organic pores (oil-wet) in shale';
  const source = '![图](a.png){#fig:en}\n\n:::: landscape\n::: {custom-style="Figure Caption EN"}\n' + inner + '\n:::\n::::\n\n见 @fig:en。';
  const result = scanDocument(source);
  assert.equal(result.captionDivs.length, 1);
  const div = result.captionDivs[0];
  assert.equal(div.style, 'Figure Caption EN');
  assert(source.slice(div.from, div.to).startsWith('::: {custom-style="Figure Caption EN"}'));
  assert(source.slice(div.from, div.to).endsWith(':::'));
  assert.equal(source.slice(div.contentFrom, div.contentTo).trim(), inner);
  assert.equal(result.references.length, 1, 'inner refs render with the caption block, prose refs stay');
  assert.equal(result.references[0].id, 'en');
  const plain = scanDocument('::: {custom-style="Figure Caption EN"}\nFig. [-@fig:en] 文字\n');
  assert.equal(plain.captionDivs.length, 0, 'unclosed divs stay literal');
  assert.equal(scanDocument('::: {custom-style="First Paragraph"}\n正文\n:::').captionDivs.length, 0, 'non-caption styles stay literal');
});

test('suppressed references span the brackets or the dash and keep bare numbers', () => {
  const source = '如图 [-@fig:a] 与 -@fig:a 以及 @fig:a。';
  const result = scanDocument(source);
  const suppressed = result.references.filter(r => r.numberOnly);
  assert.deepEqual(suppressed.map(r => source.slice(r.from, r.to)), ['[-@fig:a]', '-@fig:a']);
  assert.equal(result.references.filter(r => !r.numberOnly).map(r => source.slice(r.from, r.to)).join(), '@fig:a');
  const labeled = scanDocument('![A](a.png){#fig:a}\n\n[-@fig:a]');
  assert.equal(labeled.references[0].numberOnly, true);
  assert.equal(labeled.references[0].number, 1);
});

test('nested caption divs never produce overlapping replacements, with CRLF offsets intact',()=>{
  const source=':::: {custom-style="Figure Caption EN"}\r\n::: {custom-style="Table Caption EN"}\r\nTable [-@tbl:a] Inner\r\n:::\r\n::::\r\n';
  const result=scanDocument(source);
  assert.equal(result.captionDivs.length,1);
  assert.equal(result.captionDivs[0].style,'Table Caption EN');
  const div=result.captionDivs[0];
  assert.equal(source.slice(div.contentFrom,div.contentTo).trim(),'Table [-@tbl:a] Inner');
});

test('caption syntax in code, metadata, comments or display math remains literal',()=>{
  const div='::: {custom-style="Figure Caption EN"}\nFig. [-@fig:a] English\n:::';
  const source='---\ntitle: test\n---\n```md\n'+div+'\n```\n<!-- '+div+' -->\n$$\n'+div+'\n$$';
  assert.equal(scanDocument(source).captionDivs.length,0);
  assert.equal(scanDocument('![中文图题](a.png){#fig:a}').captionDivs.length,0,'English content is never generated');
});

test('number-only references preserve unresolved source forms and escaped groups are excluded',()=>{
  const source='[-@fig:missing] -@tbl:missing @eq:missing \\[-@fig:escaped] \\-@fig:escaped';
  assert.deepEqual(scanDocument(source).references.map(r=>r.raw),['[-@fig:missing]','-@tbl:missing','@eq:missing']);
});

test('large reference inventories scan once per token without duplicate spans',()=>{
  const source='![图](a.png){#fig:a}\n\n'+Array.from({length:12000},(_,i)=>i%2?'[-@fig:a]':'@fig:a').join(' ');
  const result=scanDocument(source);
  assert.equal(result.references.length,12000);
  assert.equal(result.references.filter(r=>r.numberOnly).length,6000);
  assert(result.references.every((r,i)=>r.number===1 && (!i || r.from>=result.references[i-1].to)));
});
