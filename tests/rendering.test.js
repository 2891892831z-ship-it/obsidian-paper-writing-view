'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');

async function fixture(text, options = {}) {
  const info = Symbol('editorInfo'), live = Symbol('livePreview');
  class Plugin {
    async loadData() { return {citations: false, indentParagraphs: false, ...options.settings}; }
    registerEditorExtension() {} registerEditorSuggest() {} addSettingTab() {} addCommand() {} registerEvent() {} registerInterval() {}
    registerDomEvent() {}
    addStatusBarItem() { return {classList: {add(){}}, setAttribute(){}}; }
  }
  class WidgetType {}
  const doc = {
    createElement(tag) { return {ownerDocument:doc,tagName:tag.toUpperCase(), children:[], style:{}, dataset:{},
      classList:{add(){}}, append(...nodes){this.children.push(...nodes);},
      replaceChildren(){this.children=[];}, setAttribute(){}, addEventListener(){}}; },
    createTextNode(text) { return {text}; }
  };
  const decorations = {none: [], set: entries => entries,
    line: spec => ({range: from => ({...spec, from, to: from})}),
    replace: spec => ({range: (from,to) => ({...spec,from,to})}),
    widget: spec => ({range: from => ({...spec,from,to:from})})};
  const mocks = {
    obsidian: {Plugin,EditorSuggest:class{},PluginSettingTab:class{},editorInfoField:info,editorLivePreviewField:live,setIcon(){}},
    '@codemirror/state': {StateField:{define: spec => spec},StateEffect:{define:()=>({})},EditorState:{languageData:{of:()=>({})}}},
    '@codemirror/view': {WidgetType,Decoration:decorations,EditorView:{decorations:{from(){}}}},
    './core': require('../src/core')
  };
  const context = {module:{exports:{}}, require:name=>mocks[name], console,
    setInterval:()=>0, setTimeout:()=>0, clearTimeout(){}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8'), context);
  const plugin = new context.module.exports();
  plugin.app = {plugins:{plugins:{}},vault:{on(){}},metadataCache:{getFileCache:()=>({frontmatter:options.frontmatter||{}}),on(){}},
    workspace:{on(){},onLayoutReady(){},getLeavesOfType:()=>[]}};
  await plugin.onload();
  plugin.resolveImage=()=>'/fixture.png';
  const state = {field:key=>key===live?true:{file:{path:'note.md'}},
    doc:{toString:()=>text,lineAt:()=>({from:0,to:text.length})},
    selection: options.selection || {ranges:[]}};
  const ranges = plugin.field.create(state), view={dom:{ownerDocument:doc},requestMeasure(){}};
  return {ranges,view,plugin};
}
const indentOffsets = ranges =>
  // Array.from crosses the VM realm boundary so deepStrictEqual sees a host array.
  Array.from(ranges.filter(r => r.class === 'pcp-paragraph-start').map(r => r.from)).sort((a,b)=>a-b);
function tags(element, tag) { return (element.tagName===tag?1:0)+(element.children||[]).reduce((n,c)=>n+tags(c,tag),0); }

test('citation path bridge survives reference plugin reload and restores previous managers', async()=>{
  const {plugin}=await fixture('正文');
  const original=function(settings){return settings;};
  const manager={loadScopedEngine:original};
  plugin.app.vault.adapter={getBasePath:()=>'/vault'};
  plugin.app.plugins.plugins['obsidian-pandoc-reference-list']={bibManager:manager};
  plugin.installScopedCitationPaths();
  const wrapper=manager.loadScopedEngine;
  assert.equal(wrapper({style:'styles/paper.csl'}).style,'/vault/styles/paper.csl');
  plugin.installScopedCitationPaths();assert.equal(manager.loadScopedEngine,wrapper);
  const replacement={loadScopedEngine:original};
  plugin.app.plugins.plugins['obsidian-pandoc-reference-list'].bibManager=replacement;
  plugin.installScopedCitationPaths();
  assert.equal(manager.loadScopedEngine,original);
  assert.notEqual(replacement.loadScopedEngine,original);
  plugin.restoreScopedCitationPaths();assert.equal(replacement.loadScopedEngine,original);
});

test('Chinese prose stays justified with indentation off; English references have halfwidth spaces', async()=>{
  const chinese=await fixture('中文正文第一行\n第二行继续正文',{settings:{indentParagraphs:false}});
  assert.equal(chinese.ranges.filter(r=>r.class==='pcp-prose-line').length,2);
  const {ranges,view}=await fixture('![Figure](a.png){#fig:a}\n\nSee @fig:a.',{frontmatter:{lang:'en-US',figPrefix:'Fig.'}});
  assert.equal(ranges.find(r=>r.widget?.reference).widget.toDOM(view).textContent,'Fig. 1');
});

test('typing with unchanged appearance avoids redundant layout measurements', async()=>{
  const {plugin}=await fixture('正文');
  const classes=new Set(),styles=new Map();let measures=0;
  const root={classList:{contains:key=>classes.has(key),toggle(key,on){if(on)classes.add(key);else classes.delete(key);}},
    style:{getPropertyValue:key=>styles.get(key)||'',setProperty:(key,value)=>styles.set(key,value)}};
  let text='English manuscript text. '.repeat(20);
  plugin.app.workspace.getLeavesOfType=()=>[{view:{file:{path:'paper.md'},containerEl:root,
    editor:{getValue:()=>text,cm:{requestMeasure(){measures++;}}}}}];
  plugin.applyAppearance();assert.equal(measures,1);
  text+=' More prose.';plugin.applyAppearance();assert.equal(measures,1);
  plugin.settings.bodySize=24;plugin.applyAppearance();assert.equal(measures,2);
  assert.equal(styles.get('--pcp-body-size'),'24px');
});

test('English and Chinese appearance edits remain isolated and preserve shared feature settings', async()=>{
  const {plugin}=await fixture('正文');
  const chinese=plugin.appearanceEditor('zh'),english=plugin.appearanceEditor('en');
  chinese.bodySize=20;english.bodySize=24;english.bodyLineHeight=1.8;
  plugin.settings.manuscriptLanguages={'en.md':'en','zh.md':'zh'};
  assert.equal(plugin.appearanceFor({path:'en.md'}).bodySize,24);
  assert.equal(plugin.appearanceFor({path:'zh.md'}).bodySize,20);
  assert.equal(chinese.bodyLineHeight,1.5);
  assert.equal(plugin.settings.bodySize,0);
  english.citations=false;assert.equal(chinese.citations,false);
});

test('missing blank before an image survives full image replacement as a visible notice', async () => {
  const {ranges,view} = await fixture('正文\n![图](a.png){#fig:a}', {settings:{quietBlankWarnings:false}});
  const figure = ranges.find(r => r.widget?.figure?.id === 'a');
  assert.equal(figure.widget.figure.blankWarning, true);
  const dom = figure.widget.toDOM(view);
  assert(dom.children.some(c => c.className === 'pcp-blank-notice' && c.textContent.includes('缺少空行')));
});

test('prose edits reuse loaded image DOM and update source positions used by toolbar handlers', async () => {
  const {ranges,view} = await fixture('正文\n\n![图](a.png){#fig:a}');
  const original = ranges.find(r => r.widget?.figure?.id === 'a').widget;
  const dom = original.toDOM(view), image = dom.children.find(c => c.className === 'pcp-image-wrap').children[0];
  const shifted = {...original.figure, from: original.figure.from + 5, to: original.figure.to + 5};
  const next = new original.constructor(original.plugin, shifted, original.file, '更新后的正文', original.prefix, original.numbers);
  assert.equal(next.updateDOM(dom), true);
  assert.equal(original.figure.from, shifted.from);
  assert.equal(dom.children.find(c => c.className === 'pcp-image-wrap').children[0], image);
  const changed = new original.constructor(original.plugin, {...shifted, src: 'changed.png'}, original.file, '', original.prefix, original.numbers);
  assert.equal(changed.updateDOM(dom), false);
});

test('quiet warnings keep image previews clear and cached dimensions reserve image space', async () => {
  const {ranges,view}=await fixture('正文\n![图](a.png){#fig:a}');
  const widget=ranges.find(r=>r.widget?.figure).widget;
  assert.equal(widget.figure.blankWarning,false);
  assert.equal(ranges.filter(r=>r.class==='pcp-blank-warn').length,0);
  widget.plugin.imageDimensions.set('/fixture.png',{width:800,height:600});
  const dom=widget.toDOM(view),image=dom.children.find(c=>c.className==='pcp-image-wrap').children[0];
  assert.equal(image.width,800);assert.equal(image.height,600);
  assert.equal(image.style.aspectRatio,'800/600');
});

test('table captions and body figure/table references render with the legacy plugin absent', async () => {
  const text=': 统计 CO<sub>2</sub> {#tbl:data}\n\n见 @tbl:data 与 @fig:a。\n\n![普通图](a.png){#fig:a}';
  const {ranges,view}=await fixture(text);
  const title=ranges.find(r=>r.from===0);
  assert(title);
  assert.equal(tags(title.widget.toDOM(view),'SUB'),1);
  const references=ranges.filter(r=>r.widget?.reference).map(r=>r.widget.toDOM(view).textContent);
  assert.equal(references.sort().join('|'),['图 1','表 1'].sort().join('|'));
});

test('ordinary images use the same single image and toolbar as rich captions', async () => {
  const text='![普通图名](a.png){#fig:a}';
  const {ranges,view}=await fixture(text);
  assert.equal(ranges.length,1);
  assert.equal(ranges[0].from,0);
  assert.equal(ranges[0].to,text.length);
  assert.equal(ranges[0].inclusive,true, 'replacement includes native image widgets at the source boundary');
  const dom=ranges[0].widget.toDOM(view);
  assert.equal(tags(dom,'IMG'),1);
  assert.equal(tags(dom,'BUTTON'),2);
  assert(!dom.className.includes('pcp-caption-only'));
});

test('adjacent images use a single replacement block with one toolbar per image', async () => {
  const text = '![甲](a.png){#fig:a}![乙](b.png){#fig:b}';
  const {ranges, view} = await fixture(text);
  assert.equal(ranges.length, 1);
  assert.equal(ranges[0].from, 0);
  assert.equal(ranges[0].to, text.length);
  assert.equal(ranges[0].inclusive, true);
  const dom = ranges[0].widget.toDOM(view);
  assert.equal(dom.className, 'pcp-figure-group');
  assert.equal(tags(dom, 'IMG'), 2);
  assert.equal(tags(dom, 'BUTTON'), 4);
  assert.equal(ranges[0].widget.updateDOM(dom), true);
  const editing = await fixture(text, {selection: {ranges: [{from: 3, to: 3}]}});
  assert.equal(editing.ranges.length, 0);
});

test('HTML captions replace the source range and create exactly one rescue image', async () => {
  const text='![CO<sub>2</sub>](a.png){#fig:a}';
  const {ranges,view}=await fixture(text);
  assert.equal(ranges.length,1);
  assert.equal(ranges[0].from,0);
  assert.equal(ranges[0].to,text.length);
  const dom=ranges[0].widget.toDOM(view);
  assert.equal(tags(dom,'IMG'),1);
  assert.equal(tags(dom,'BUTTON'),2);
  assert.equal(tags(dom,'SUB'),1);
});

test('caption cross references and highlights are rendered inside the caption', async () => {
  const text='![见 @fig:a(a)，@tbl:data，@eq:core。==新增 CO<sub>2</sub> 结论==](a.png){#fig:a}\n: 数据 {#tbl:data}\n\n$$\nD=Z\n$$\n{#eq:core}';
  const {ranges,view}=await fixture(text);
  const fig=ranges.find(r=>r.widget?.figure);
  const dom=fig.widget.toDOM(view);
  assert.equal(tags(dom,'MARK'),1);
  assert.equal(tags(dom,'SUB'),1);
  const all=[];
  const collect=e=>{if(e.text)all.push(e.text);if(e.textContent)all.push(e.textContent);for(const c of e.children||[])collect(c);};
  collect(dom);
  assert(all.join('').includes('图 1(a)'));
  assert(all.join('').includes('表 1'));
  assert(all.join('').includes('式 1'));
  assert(!all.join('').includes('=='));
  assert(!all.join('').includes('@fig:'));
  const eqLabel=ranges.find(r=>r.widget?.text==='（式 1）');
  assert(eqLabel,'equation label line renders as （式 1）');
});

test('citation-only captions also rescue the image instead of relying on native parsing', async () => {
  const text='![中国富氦气田分布与氦气含量 [@Li2024]](a.png){#fig:a}';
  const {ranges,view}=await fixture(text);
  assert.equal(ranges.length,1);
  assert.equal(ranges[0].from,0);
  assert.equal(ranges[0].to,text.length);
  assert.equal(tags(ranges[0].widget.toDOM(view),'IMG'),1);
});

test('single Enter blank line stays flush: caret indent only where a new paragraph would form', async () => {
  const text='第一段落正文。';
  // Caret on the blank line created by ONE Enter: typing there is a soft break
  // continuation of the same paragraph, so no indent (preview matches export).
  const {ranges}=await fixture(text+'\n',{settings:{indentParagraphs:true},
    selection:{main:{head:text.length+1},ranges:[{from:text.length+1,to:text.length+1}]}});
  assert.deepEqual(indentOffsets(ranges),[0]);
});

test('double Enter blank line (previous line blank) shows the caret indent', async () => {
  const text='第一段。\n\n\n';
  // Offsets: 0 第一段, 5 blank (prev non-blank), 6 blank (prev blank, caret here).
  const second=await fixture(text,{settings:{indentParagraphs:true},
    selection:{main:{head:6},ranges:[{from:6,to:6}]}});
  assert.deepEqual(indentOffsets(second.ranges),[0,6]);
  // Same document, caret on the first blank line instead: stays flush.
  const first=await fixture(text,{settings:{indentParagraphs:true},
    selection:{main:{head:5},ranges:[{from:5,to:5}]}});
  assert.deepEqual(indentOffsets(first.ranges),[0]);
});

test('single separator blank line between paragraphs stays flush even with the caret', async () => {
  const text='第一段落。\n\n第二段落。';
  // Caret on the separating blank line itself (previous line non-blank): no indent.
  const {ranges}=await fixture(text,{settings:{indentParagraphs:true},
    selection:{main:{head:6},ranges:[{from:6,to:6}]}});
  assert.deepEqual(indentOffsets(ranges),[0,7]);
});

test('blank lines without the caret stay unindented', async () => {
  const text='第一段落。\n\n第二段落。';
  const {ranges}=await fixture(text,{settings:{indentParagraphs:true},selection:{ranges:[]}});
  assert.deepEqual(indentOffsets(ranges),[0,7]);
});

test('soft-break continuation lines are never indented', async () => {
  const text='第一段。\n续行文字。\n\n第二段。';
  // Offsets: 0 第一段, 6 续行 (soft break, must stay flush), 11 blank, 12 第二段.
  const {ranges}=await fixture(text,{settings:{indentParagraphs:true},
    selection:{main:{head:6},ranges:[{from:6,to:6}]}});
  assert.deepEqual(indentOffsets(ranges),[0,12]);
});

test('blank lines inside fenced code are never indented, even with the caret', async () => {
  const text='正文。\n\n```js\nconst a=1;\n\nconst b=2;\n```\n\n后续正文。';
  // Line starts: 0 正文, 4 blank, 5 ```js, 11 const a, 22 code blank, 23 const b, 34 ```, 38 blank, 39 后续.
  const {ranges}=await fixture(text,{settings:{indentParagraphs:true},
    selection:{main:{head:22},ranges:[{from:22,to:22}]}});
  assert.deepEqual(indentOffsets(ranges),[0,39]);
});

test('single-line $$ formulas no longer flip the math state for later paragraphs', async () => {
  const text='引言段落。\n\n$$E=mc^2$$\n\n结论段落。';
  // Offsets: 0 引言, 6 blank, 7 formula (10 chars), 18 blank, 19 结论 (must stay indented).
  const {ranges}=await fixture(text,{settings:{indentParagraphs:true},selection:{ranges:[]}});
  assert.deepEqual(indentOffsets(ranges),[0,19]);
});

test('multi-line math bodies and blank lines inside math stay unindented', async () => {
  const text='段。\n\n$$\na+b\n$$\n\n后。';
  // Offsets: 0 段, 3 blank, 4 $$, 7 a+b, 11 $$, 14 blank, 15 后.
  // Caret on the blank line right before the formula: previous line non-blank, flush.
  const outside=await fixture(text,{settings:{indentParagraphs:true},
    selection:{main:{head:3},ranges:[{from:3,to:3}]}});
  assert.deepEqual(indentOffsets(outside.ranges),[0,15]);
  // Caret inside the math body: the math line itself gets no decoration.
  const inside=await fixture(text,{settings:{indentParagraphs:true},
    selection:{main:{head:7},ranges:[{from:7,to:7}]}});
  assert.deepEqual(indentOffsets(inside.ranges),[0,15]);
});

test('frontmatter lines never receive paragraph decorations', async () => {
  const text='---\ntitle: x\n\nfigPrefix: 图\n---\n\n正文段。';
  // Offsets: 0 ---, 4 title, 13 blank, 14 figPrefix, 27 ---, 31 blank, 32 正文.
  const {ranges}=await fixture(text,{settings:{indentParagraphs:true},selection:{ranges:[]}});
  assert.deepEqual(indentOffsets(ranges),[32]);
});

test('image and table caption lines are excluded from indentation', async () => {
  const text='![图名](a.png){#fig:a}\n\n正文段。';
  // Line starts: 0 image (owned by the figure widget), 21 blank, 22 正文.
  const {ranges}=await fixture(text,{settings:{indentParagraphs:true},selection:{ranges:[]}});
  assert.deepEqual(indentOffsets(ranges),[22]);
});

test('missing blank lines before images and headings get warning decorations', async () => {
  const text='正文段落。\n![图](a.png){#fig:a}\n## 标题\n\n正常段落。\n\n![好图](b.png){#fig:b}\n\n```\ncode\n```\n\n结尾。';
  // Line starts: 0 prose, 6 image (19 chars, warn), 26 heading (warn), then clean.
  const {ranges}=await fixture(text,{settings:{blankLineWarnings:true, quietBlankWarnings:false, indentParagraphs:false},selection:{ranges:[]}});
  const warns=Array.from(ranges.filter(r=>r.class==='pcp-blank-warn').map(r=>r.from)).sort((a,b)=>a-b);
  assert.deepEqual(warns,[6,26]);
  const ok=await fixture('正常。\n\n![好图](b.png){#fig:b}',{settings:{blankLineWarnings:true, indentParagraphs:false},selection:{ranges:[]}});
  assert.equal(ok.ranges.filter(r=>r.class==='pcp-blank-warn').length,0);
});
