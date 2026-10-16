'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');
const cmState = require('@codemirror/state'), cmView = require('@codemirror/view');
const core = require('../src/core');
const {performance} = require('node:perf_hooks');

async function fixture(text, mode = 'auto') {
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
    workspace:{on(){},onLayoutReady(){},getLeavesOfType:()=>[{view}],getActiveViewOfType:()=>view}};
  await plugin.onload();
  cm.state=cmState.EditorState.create({doc:text,extensions:[info,live,plugin.field]});
  return {plugin,cm,view,counts,timers,runIdle(){
    const pending=plugin.largePending.get(file.path);
    assert(pending);const task=timers.get(pending.timer);timers.delete(pending.timer);task.fn();
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

test('100 keystrokes in a large manuscript do not rescan; idle refreshes once and status is never falsely clean',async t=>{
  const text=Array.from({length:200},(_,i)=>('A scientific paragraph with CO₂ and helium migration. '.repeat(100)+
    `\n\n![Caption ${i}](img-${i}.png){#fig:f${i}}\n\n`)).join('');
  const start=performance.now();
  const f=await fixture(text);f.plugin.updateBlankStatus(f.view);
  const initialMs=performance.now()-start,typingStart=performance.now();
  const before={...f.counts};
  for(let i=0;i<100;i++)f.cm.dispatch({changes:{from:20,insert:'a'}});
  const typingMs=performance.now()-typingStart;
  f.plugin.updateBlankStatus(f.view);
  assert.equal(f.counts.scanDocument,before.scanDocument);
  assert.equal(f.counts.maskExamples,before.maskExamples);
  assert.equal(f.counts.blankLineViolations,before.blankLineViolations);
  assert.equal(f.counts.fakeScriptViolations,before.fakeScriptViolations);
  assert.equal(f.plugin.scriptStatus.text,'上下标待检查');
  assert.equal(f.plugin.blankStatus.text,'空行待检查');
  assert.equal(f.plugin.largePending.size,1);
  const idleStart=performance.now();f.runIdle();const idleMs=performance.now()-idleStart;
  assert.equal(f.counts.scanDocument,before.scanDocument+1);
  assert.equal(f.counts.blankLineViolations,before.blankLineViolations+1);
  assert.equal(f.counts.fakeScriptViolations,before.fakeScriptViolations+1);
  assert.match(f.plugin.scriptStatus.text,/虚假上下标 20000 处/);
  assert.equal(f.plugin.largePending.size,0);
  assert.equal(widgets(f.cm.state,f.plugin.field).filter(r=>r.widget.figure).length,200);
  t.diagnostic(`${text.length} characters, 200 figures: initial ${initialMs.toFixed(1)} ms; 100 mapped edits ${typingMs.toFixed(1)} ms; idle refresh ${idleMs.toFixed(1)} ms. Node benchmark excludes Obsidian UI/image decoding.`);
});

test('mapped figure positions update reused DOM handlers and cursor reveals source without a scan',async()=>{
  const text='intro\n\n![A](a.png){#fig:a}\n\nSee @fig:a.';
  const f=await fixture(text,'large');
  const first=widgets(f.cm.state,f.plugin.field).find(r=>r.widget.figure);
  const peer={figure:first.widget.figure};first.widget.domPeer=peer;
  const scans=f.counts.scanDocument;
  f.cm.dispatch({changes:{from:0,insert:'prefix '}});
  let image=widgets(f.cm.state,f.plugin.field).find(r=>r.widget.figure);
  assert.equal(image.from,first.from+7);
  assert.equal(image.widget.figure.from,image.from);
  assert.equal(peer.figure.from,image.from);
  f.cm.dispatch({selection:{anchor:image.from+3}});
  assert(!widgets(f.cm.state,f.plugin.field).some(r=>r.widget.figure));
  assert.equal(f.counts.scanDocument,scans);
  f.cm.dispatch({selection:{anchor:f.cm.state.doc.length}});f.runIdle();
  image=widgets(f.cm.state,f.plugin.field).find(r=>r.widget.figure);
  assert.equal(image.widget.figure.from,first.from+7);
});

test('normal mode refreshes immediately; repeated selection reuses the immutable document analysis',async()=>{
  const f=await fixture('intro\n\n![A](a.png){#fig:a}\n\nSee @fig:a.','normal');
  const first=f.counts.scanDocument;
  for(let i=0;i<20;i++)f.cm.dispatch({selection:{anchor:i}});
  assert.equal(f.counts.scanDocument,first);
  f.cm.dispatch({changes:{from:0,insert:'new '}});
  assert.equal(f.counts.scanDocument,first+1);
  assert.equal(f.plugin.largePending.size,0);
});

test('manual full check flushes pending work, bounded caches release old snapshots and unload cancels timers',async()=>{
  const f=await fixture('intro CO₂\n\n![A](a.png){#fig:a}','large');
  for(let i=0;i<10;i++){
    f.cm.dispatch({changes:{from:1,insert:'a'}});f.plugin.checkWholeDocument(f.view);
  }
  assert.equal(f.plugin.largePending.size,0);
  assert(f.plugin.analysisCache.size<=4);
  f.cm.dispatch({changes:{from:1,insert:'a'}});
  const timer=f.plugin.largePending.get('large.md').timer;
  f.plugin.app.workspace.getLeavesOfType=()=>[];
  f.plugin.onunload();
  assert(!f.timers.has(timer));assert.equal(f.plugin.analysisCache.size,0);
});

test('idle refresh waits for IME composition; explicit mode switch cancels pending refresh',async()=>{
  const f=await fixture('intro CO₂','large');
  f.cm.dispatch({changes:{from:1,insert:'a'}});const scans=f.counts.scanDocument;
  f.cm.composing=true;f.runIdle();assert.equal(f.counts.scanDocument,scans);
  assert.equal(f.plugin.largePending.size,1);
  f.cm.composing=false;
  // Avoid installing browser observers in this isolated test of the settings transition.
  f.plugin.refresh=()=>{};
  await f.plugin.setPerformanceMode('normal');
  assert.equal(f.plugin.largePending.size,0);assert.equal(f.plugin.settings.performanceMode,'normal');
});
