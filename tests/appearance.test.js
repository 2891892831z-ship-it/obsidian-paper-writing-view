'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const source = fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
const context = {};
vm.runInNewContext(source.slice(source.indexOf('const DEFAULTS'),source.indexOf('// Use Obsidian')) + ';this.variables=appearanceVariables;this.defaults=DEFAULTS;this.keys=APPEARANCE_KEYS;', context);

test('language decisions expose priority and uncertainty for mixed or short prose', () => {
  const c={maskExamples:require('../src/core').maskExamples};
  vm.runInNewContext(source.slice(source.indexOf('const DEFAULTS'),source.indexOf('// Use Obsidian'))+';this.decide=languageDecision;',c);
  assert.equal(c.decide({lang:'en-US'},'', 'zh').source,'手动选择');
  assert.equal(c.decide({lang:'en-US'}).source,'lang: en-US');
  assert.equal(c.decide({},'Short').uncertain,true);
  const mixed='中文段落'.repeat(25)+' English paragraph'.repeat(20);
  assert.equal(c.decide({},mixed).uncertain,true);
  assert.equal(c.decide({},'English manuscript text. '.repeat(20)).uncertain,false);
});

test('manual language choices follow exact file and folder renames without prefix collisions', () => {
  const c={};
  vm.runInNewContext(source.slice(source.indexOf('const DEFAULTS'),source.indexOf('// Use Obsidian'))+';this.rename=renamedLanguageChoices;',c);
  const original={'a/paper.md':'en','a/sub/zh.md':'zh','ab/keep.md':'zh'};
  const moved=c.rename(original,'a','b');
  assert.equal(moved['b/paper.md'],'en');
  assert.equal(moved['b/sub/zh.md'],'zh');
  assert.equal(moved['ab/keep.md'],'zh');
  assert.equal(moved['a/paper.md'],undefined);
  assert.equal(original['a/paper.md'],'en');
  assert.equal(c.rename(original,'missing.md','new.md'),null);
  assert.equal(c.rename({'a.md':'en','b.md':'zh'},'a.md','b.md')['b.md'],'zh');
});
test('appearance defaults preserve paper spacing and follow Obsidian font size', () => {
  const vars=context.variables({});
  assert.equal(vars['--pcp-body-size'],'var(--font-text-size)');
  assert.equal(vars['--pcp-body-line'],'1.5');
  assert.equal(vars['--pcp-reference-color'],'#3498db');
  assert.equal(vars['--pcp-body-color'],'var(--text-normal)');
  assert.equal(vars['--pcp-image-border-width'],'1.5px');
});
test('font, color, table and spacing controls produce independent CSS variables', () => {
  const vars=context.variables({bodySize:22,bodyLineHeight:1.8,bodyThemeColor:false,bodyColor:'#123456',latinFont:'Georgia',punctuationSong:false,tableSize:16,tableLineHeight:1.4});
  assert.equal(vars['--pcp-body-size'],'22px');
  assert.equal(vars['--pcp-body-line'],'1.8');
  assert.equal(vars['--pcp-body-color'],'#123456');
  assert(vars['--pcp-font'].startsWith('"Georgia"'));
  assert.equal(vars['--pcp-table-size'],'16px');
  assert.equal(vars['--pcp-table-line'],'1.4');
  assert(context.keys.every(key=>context.defaults[key]!==undefined));
});

test('saved appearance snapshots exclude functional switches and other profiles', () => {
  const c={};
  vm.runInNewContext(source.slice(source.indexOf('const DEFAULTS'),source.indexOf('// Use Obsidian'))+';this.snapshot=appearanceSnapshot;',c);
  const result=c.snapshot({bodySize:24,citations:false,appearanceProfiles:{old:{bodySize:18}},quietBlankWarnings:false});
  assert.equal(result.bodySize,24);
  assert.equal('citations' in result,false);
  assert.equal('appearanceProfiles' in result,false);
  assert.equal('quietBlankWarnings' in result,false);
});

test('English manuscript overrides Chinese punctuation and indent without changing Chinese settings', () => {
  const c={};
  vm.runInNewContext(source.slice(source.indexOf('const DEFAULTS'),source.indexOf('// Use Obsidian'))+';this.vars=manuscriptVariables;this.lang=manuscriptLanguage;',c);
  assert.equal(c.lang({lang:'en-GB'}),'en');
  assert.equal(c.lang({cssclasses:['en-doc']}),'en');
  assert.equal(c.lang({lang:'zh-CN',cssclasses:['en-doc']}),'zh');
  assert.equal(c.vars({}, {lang:'en-US'})['--pcp-font'],'"Times New Roman", serif');
  assert.equal(c.vars({}, {lang:'en-US'})['--pcp-indent'],'1em');
  assert.equal(c.vars({indentParagraphs:false}, {lang:'en-US'})['--pcp-indent'],'0em');
  assert.equal(c.vars({indentSize:3}, {lang:'en-US'})['--pcp-indent'],'1.5em');
  assert.equal(c.vars({}, {lang:'zh-CN'})['--pcp-indent'],'2em');
  assert(c.vars({}, {lang:'zh-CN'})['--pcp-font'].includes('PCP Chinese Punctuation'));
});

test('language detection respects metadata and ignores code, citations and image paths', () => {
  const c={maskExamples:require('../src/core').maskExamples};
  vm.runInNewContext(source.slice(source.indexOf('const DEFAULTS'),source.indexOf('// Use Obsidian'))+';this.lang=manuscriptLanguage;',c);
  const en='Fault activity controls helium migration and accumulation within the sedimentary basin. '.repeat(8);
  assert.equal(c.lang({},en),'en');
  assert.equal(c.lang({},'断裂活动控制氦气运移和富集。'.repeat(8)),'zh');
  assert.equal(c.lang({lang:'zh-CN'},en),'zh');
  assert.equal(c.lang({},'中文正文。\n```\n'+en+'\n```\n![图](long-english-image-path.png)\n[@longEnglishCitationKey]'),'zh');
});

test('CSL conflict detection examines actual locale and citation punctuation, not filename', () => {
  const c={};
  vm.runInNewContext(source.slice(source.indexOf('const DEFAULTS'),source.indexOf('// Use Obsidian'))+';this.issues=citationStyleIssues;',c);
  assert.equal(c.issues('en','<style default-locale="en-US"><citation><layout prefix="(" suffix=")"/></citation></style>').length,0);
  assert.equal(c.issues('en','<style default-locale="zh-CN"><citation/></style>').length,1);
  assert.equal(c.issues('en','<style><citation><layout prefix="（" suffix="）"/></citation></style>').length,1);
  assert.equal(c.issues('zh','<style default-locale="en-US"/>').length,0);
});

test('citation setup diagnoses platform paths and rejects YAML lists while preserving note priority', () => {
  const c={};
  vm.runInNewContext(source.slice(source.indexOf('const DEFAULTS'),source.indexOf('// Use Obsidian'))+';this.config=citationConfiguration;',c);
  const settings={pathToBibliography:'refs/library.bib',cslStylePath:'styles/default.csl',pathToPandoc:'/opt/homebrew/bin/pandoc'};
  assert.equal(c.config({csl:'styles/note.csl'},settings,'mac').style,'styles/note.csl');
  assert.equal(c.config({},settings,'mac').issues.length,0);
  assert(c.config({csl:['a.csl']},settings,'mac').issues.some(s=>s.includes('单字符串')));
  assert(c.config({csl:'C:/Users/test/style.csl'},settings,'mac').issues.some(s=>s.includes('Windows 路径')));
  assert(c.config({},settings,'win').issues.some(s=>s.includes('macOS 路径')));
  assert(c.config({}, {}, 'mac').issues.length>=3);
});
