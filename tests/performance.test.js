'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const cmState = require('@codemirror/state'), cmView = require('@codemirror/view');
const core = require('../src/core');
const {performance} = require('node:perf_hooks');

async function fixture(text, mode = 'auto') {
  const events = {};
  const file = {path:'large.md'}, counts = {}, timers = new Map(); let serial = 0;
  const parser = {...core};
  for (const key of ['scanDocument','maskExamples','blankLineViolations','fakeScriptViolations'])
    parser[key] = (...args) => {counts[key]=(counts[key]||0)+1;return core[key](...args);};
  const info = cmState.StateField.define({create:()=>({file}),update:v=>v});
  const live = cmState.StateField.define({create:()=>true,update:v=>v});
  const ui = () => ({text:'',style:{},classList:{add(){},toggle(){}},setAttribute(){},setText(t){this.text=t;}});
  class Plugin {
    async loadData(){return {citations:false,performanceMode:mode};}
    registerEditorExtension(){} registerEditorSuggest(){} addSettingTab(){} addCommand(){} registerEvent(){}
    registerInterval(){} registerDomEvent(){} async saveData(){} addStatusBarItem(){return ui();}
  }
  const mocks = {obsidian:{Plugin,MarkdownView:class{},EditorSuggest:class{},PluginSettingTab:class{},
    Notice:class{},editorInfoField:info,editorLivePreviewField:live},
    '@codemirror/state':cmState,'@codemirror/view':cmView,'./core':parser};
  const context={module:{exports:{}},require:n=>mocks[n],console,setInterval:()=>0,
    setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout:id=>timers.delete(id)};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8'),context);
  const plugin=new context.module.exports();
  const cm={requestMeasure(){},dispatch(spec){cm.state=cm.state.update(spec).state;}};
  const classes=new Set(),styles=new Map();
  const root={classList:{contains:c=>classes.has(c),toggle(c,on){if(on)classes.add(c);else classes.delete(c);}},
    style:{getPropertyValue:k=>styles.get(k)||'',setProperty:(k,v)=>styles.set(k,v)},querySelectorAll:()=>[]};
  const view={file,containerEl:root,editor:{cm,getValue:()=>cm.state.doc.toString()}};
  plugin.app={plugins:{plugins:{}},vault:{on(){}},metadataCache:{on(){},getFileCache:()=>({frontmatter:{lang:'en-US'}})},
    workspace:{on(name,fn){events[name]=fn;},onLayoutReady(){},getLeavesOfType:()=>[{view}],getActiveViewOfType:()=>view}};
  await plugin.onload();
  cm.state=cmState.EditorState.create({doc:text,extensions:[info,live,plugin.field]});
  return {plugin,cm,view,counts,timers,events,runTimers(){
    const tasks=[...timers.values()];timers.clear();tasks.forEach(task=>task.fn());
  }};
}
function widgets(state,field){const rows=[];state.field(field).between(0,state.doc.length,(from,to,value)=>{
  if(value.spec.widget)rows.push({from,to,widget:value.spec.widget});
});return rows;}

test('automatic mode honors size/image thresholds and explicit overrides',()=>{
  assert(!core.performanceDecision('auto',79999,59).large);
  assert(core.performanceDecision('auto',80000,0).large);
  assert(core.performanceDecision('auto',1000,60).large);
  assert(core.performanceDecision('large',100,0).large);
  assert(!core.performanceDecision('normal',1000000,500).large);
});


test('automatic large manuscript does no full parsing on open, typing, selection, idle status or composition',async t=>{
  const text=Array.from({length:200},(_,i)=>('A scientific paragraph with CO₂ and helium migration. '.repeat(100)+
    `\n\n![Caption ${i}](img-${i}.png){#fig:f${i}}\n\n`)).join('');
  const start=performance.now(), f=await fixture(text);
  f.plugin.updateBlankStatus(f.view);
  f.cm.composing=true;
  for(let i=0;i<100;i++){
    f.cm.dispatch({changes:{from:20,insert:'字'},selection:{anchor:21}});
    f.events['editor-change'](f.view.editor,f.view);
  }
  f.cm.composing=false;f.runTimers();
  assert.deepEqual(f.counts,{});
  assert.equal(f.plugin.scriptStatus.text,'上下标待检查');
  assert.equal(f.plugin.blankStatus.text,'空行待检查');
  assert.equal(f.plugin.analysisCache.size,0);
  assert.equal(f.plugin.largePending.size,0);
  assert.equal(widgets(f.cm.state,f.plugin.field).length,0);
  assert.equal(f.timers.size,0);
  t.diagnostic(`${text.length} characters / 200 figures: open and 100 editor events ${(performance.now()-start).toFixed(1)} ms, zero parser calls. Excludes native Obsidian rendering.`);
});

test('legacy manually selected large mode and explicit lite mode both bypass rendering and CSL',async()=>{
  for(const mode of ['large','lite']){
    const f=await fixture('intro CO₂\n\n![A](a.png){#fig:a}',mode);
    let requests=0;
    f.plugin.app.plugins.plugins['obsidian-pandoc-reference-list']={bibManager:{getReferenceList(){requests++;}}};
    f.plugin.citations.ensure(f.view.file,'[@key]');
    f.cm.dispatch({changes:{from:0,insert:'edit '}});f.plugin.updateBlankStatus(f.view);
    assert.deepEqual(f.counts,{});assert.equal(requests,0);
    assert.equal(widgets(f.cm.state,f.plugin.field).length,0);
  }
});

test('normal mode refreshes immediately; repeated selection reuses the immutable document analysis',async()=>{
  const f=await fixture('intro\n\n![A](a.png){#fig:a}\n\nSee @fig:a.','normal');
  const first=f.counts.scanDocument;
  for(let i=0;i<20;i++)f.cm.dispatch({selection:{anchor:i}});
  assert.equal(f.counts.scanDocument,first);
  f.cm.dispatch({changes:{from:0,insert:'new '}});
  assert.equal(f.counts.scanDocument,first+1);
});

test('manual lightweight checks only scan blanks/scripts and never build figure decorations',async()=>{
  const f=await fixture('intro CO₂\n![A](a.png){#fig:a}','lite');
  const before=f.cm.state.doc.toString();
  f.plugin.checkWholeDocument(f.view);
  assert.equal(f.counts.scanDocument,undefined);
  assert.equal(f.counts.blankLineViolations,1);assert.equal(f.counts.fakeScriptViolations,1);
  assert.match(f.plugin.scriptStatus.text,/1 处/);assert.match(f.plugin.blankStatus.text,/1 处/);
  assert.equal(f.cm.state.doc.toString(),before);
  f.cm.dispatch({changes:{from:1,insert:'a'}});f.events['editor-change'](f.view.editor,f.view);f.runTimers();
  assert.equal(f.counts.blankLineViolations,1);assert.equal(f.counts.fakeScriptViolations,1);
  assert.equal(f.plugin.scriptStatus.text,'上下标待检查');
});

test('lightweight checks defer during IME and unload clears all pending status work',async()=>{
  const f=await fixture('intro CO₂','lite');
  f.cm.composing=true;f.plugin.checkWholeDocument(f.view);assert.deepEqual(f.counts,{});
  f.cm.composing=false;
  f.events['editor-change'](f.view.editor,f.view);const timer=f.plugin.blankStatusTimer;
  f.plugin.app.workspace.getLeavesOfType=()=>[];f.plugin.onunload();
  assert(!f.timers.has(timer));assert.equal(f.plugin.analysisCache.size,0);
});
