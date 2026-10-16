'use strict';
const {test} = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), path = require('path'), vm = require('vm');

async function fixture(text, options = {}) {
  const info = Symbol('editorInfo'), live = Symbol('livePreview');
  const modals = [], notices = [], commands = [];
  function ui() {return {children:[],style:{},classList:{add(){},toggle(){}},setAttribute(){},setText(t){this.text=t;},empty(){this.children=[];},
    createEl(tag,spec={}){const child=ui();child.tag=tag;child.text=spec.text;this.children.push(child);return child;},
    createDiv(spec){return this.createEl('div',spec);},appendText(t){this.text=t;}};}
  class Modal {constructor(){this.modalEl=ui();this.contentEl=ui();modals.push(this);}open(){}close(){this.closed=true;}}
  class Plugin {
    async loadData() { return {citations: false, indentParagraphs: false, ...options.settings}; }
    registerEditorExtension() {} registerEditorSuggest() {} addSettingTab() {} addCommand(command) {commands.push(command);} registerEvent() {} registerInterval() {}
    registerDomEvent() {}
    addStatusBarItem() { return ui(); }
  }
  class WidgetType {}
  class Setting {
    constructor(root){this.el=root.createDiv();}
    setName(){return this;}setDesc(){return this;}
    addDropdown(fn){const d={addOptions(){return this;},setValue(v){this.value=v;return this;},onChange(fn){this.change=fn;return this;}};fn(d);return this;}
  }
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
    obsidian: {Plugin,Modal,Setting,requestUrl:options.requestUrl,Notice:class{constructor(t){notices.push(t);}},EditorSuggest:class{},PluginSettingTab:class{},editorInfoField:info,editorLivePreviewField:live,setIcon(){}},
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
  return {ranges,view,plugin,modals,notices,commands};
}
const indentOffsets = ranges =>
  // Array.from crosses the VM realm boundary so deepStrictEqual sees a host array.
  Array.from(ranges.filter(r => r.class === 'pcp-paragraph-start').map(r => r.from)).sort((a,b)=>a-b);

test('translation sends only on click, previews before write, protects session secret and refuses stale acceptance',async()=>{
 let text='![中文 CO<sub>2</sub> 0.1%](a.png){#fig:a}\n\nNearby context.',requests=[],calls=0;
 const {plugin}=await fixture(text,{frontmatter:{lang:'zh-CN'},settings:{performanceMode:'lite',translationEndpoint:'http://localhost:11434/v1',translationModel:'local'},
  requestUrl:async options=>{requests.push(options);const body=JSON.parse(options.body);const caption=JSON.parse(body.messages[1].content).caption;return {status:200,json:{choices:[{message:{content:caption.replace('中文','English')}}]}};}});
 plugin.translationApiKey='session-secret';
 const source={file:{path:'note.md'},editor:{getValue:()=>text,cm:{dispatch({changes}){calls++;for(const c of Array.from(changes).reverse())text=text.slice(0,c.from)+c.insert+text.slice(c.to??c.from);}}}};
 const buttons=modal=>{const all=[];const walk=e=>{if(e.tag==='button')all.push(e);e.children.forEach(walk);};walk(modal.contentEl);return all;};
 let modal=plugin.openCaptionTranslation(source);assert.equal(requests.length,0);assert.equal(calls,0);
 await buttons(modal).find(b=>b.text==='发送并生成译文').onclick();
 assert.equal(requests.length,1);assert.equal(calls,0);assert.equal(requests[0].headers.Authorization,'Bearer session-secret');
 assert(!JSON.stringify(plugin.settings).includes('session-secret'));
 buttons(modal).find(b=>b.text==='确认写入英文题注').onclick();assert.equal(calls,1);assert.match(text,/Fig\. \[-@fig:a\] English/);
 modal=plugin.openCaptionTranslation(source);await buttons(modal).find(b=>b.text==='发送并生成译文').onclick();
 text+='changed';buttons(modal).find(b=>b.text==='确认写入英文题注').onclick();assert.equal(calls,1);
});

test('translation errors and closed modals never modify a manuscript',async()=>{
 const text='![中文](a.png){#fig:a}';let resolve,calls=0;
 const {plugin}=await fixture(text,{settings:{translationEndpoint:'http://localhost/v1',translationModel:'local'},requestUrl:()=>new Promise(r=>{resolve=r;})});
 const source={file:{path:'note.md'},editor:{getValue:()=>text,cm:{dispatch(){calls++;}}}};
 const modal=plugin.openCaptionTranslation(source),controls=modal.contentEl.children.find(c=>c.children?.some(b=>b.text==='发送并生成译文'));
 const generate=controls.children.find(b=>b.text==='发送并生成译文'),apply=controls.children.find(b=>b.text==='确认写入英文题注');
 const pending=generate.onclick();modal.onClose();resolve({status:200,json:{choices:[{message:{content:'English'}}]}});await pending;
 assert.equal(apply.disabled,true);apply.onclick();assert.equal(calls,0);
});

test('translation service errors, missing response text and changed placeholder values keep acceptance disabled',async()=>{
 for(const response of [{status:401,json:{}},{status:200,json:{choices:[]}},{status:200,json:{choices:[{message:{content:'Changed 0.2'}}]}}]){
  let writes=0;const text='![含量 0.1](a.png){#fig:a}';
  const {plugin}=await fixture(text,{settings:{translationEndpoint:'http://localhost/v1',translationModel:'local'},requestUrl:async()=>response});
  const modal=plugin.openCaptionTranslation({file:{path:'note.md'},editor:{getValue:()=>text,cm:{dispatch(){writes++;}}}});
  const controls=modal.contentEl.children.find(c=>c.children?.some(b=>b.text==='发送并生成译文'));
  await controls.children.find(b=>b.text==='发送并生成译文').onclick();
  const accept=controls.children.find(b=>b.text==='确认写入英文题注');assert.equal(accept.disabled,true);accept.onclick();assert.equal(writes,0);
 }
});

test('Chinese batch captions preview all requests, permit edits, and write figures and tables in one transaction',async()=>{
 let text='中文稿件。\n\n![第一张 0.1%](a.png){#fig:a}\n\n: 表格题 {#tbl:t}\n\n| A | B |\n| --- | --- |\n| C | D |\n',writes=0,requests=0;
 const {plugin}=await fixture(text,{frontmatter:{lang:'zh-CN'},settings:{performanceMode:'lite',translationEndpoint:'http://localhost/v1',translationModel:'local'},requestUrl:async options=>{
  requests++;const captions=JSON.parse(JSON.parse(options.body).messages[1].content).captions;
  return {status:200,json:{choices:[{message:{content:JSON.stringify({translations:captions.map(c=>({key:c.key,text:c.caption.replace(/[\u3400-\u9fff]+/g,'English')}))})}}]}};
 }});
 const source={file:{path:'note.md'},editor:{getValue:()=>text,cm:{dispatch({changes}){writes++;for(const e of Array.from(changes).reverse())text=text.slice(0,e.from)+e.insert+text.slice(e.to??e.from);}}}};
 const modal=plugin.openBatchCaptionTranslation(source),all=()=>{const result=[];const walk=e=>{result.push(e);e.children.forEach(walk);};walk(modal.contentEl);return result;};
 const button=label=>all().find(e=>e.tag==='button'&&e.text===label);
 assert.equal(requests,0);button('预览发送内容').onclick();assert.equal(requests,0);
 await button('生成所选英文图表题').onclick();assert.equal(requests,1);assert.equal(writes,0);
 const outputs=all().filter(e=>e.tag==='textarea');assert.equal(outputs.length,2);
 outputs[1].value='Edited table title';outputs[1].oninput();
 button('确认写入勾选项').onclick();assert.equal(writes,1);assert.match(text,/Table \[-@tbl:t\] Edited table title/);
});

test('English manuscripts have no caption translation modal and command checks are unavailable',async()=>{
 const text='![English figure](a.png){#fig:a}';
 const {plugin,modals,notices,commands}=await fixture(text,{frontmatter:{lang:'en-US'}});
 const view={file:{path:'note.md'},editor:{getValue:()=>text}};
 plugin.openBatchCaptionTranslation(view);plugin.openCaptionTranslation(view);assert.equal(modals.length,0);assert.equal(notices.length,2);
 plugin.markdownView=()=>view;
 for(const id of ['translate-caption','batch-translate-captions'])assert.equal(commands.find(c=>c.id===id).checkCallback(true),false);
});

test('batch editor retains manual drafts across pages and preserves existing English by default',async()=>{
 const text=Array.from({length:31},(_,i)=>'![中文图题](a.png){#fig:f'+i+'}'+(i===0?'\n\n::: {custom-style="Figure Caption EN"}\nFig. [-@fig:f0] Existing title\n:::':'')).join('\n\n');
 const {plugin}=await fixture(text,{frontmatter:{lang:'zh-CN'}});
 const modal=plugin.openBatchCaptionTranslation({file:{path:'note.md'},editor:{getValue:()=>text}});
 const rows=modal.contentEl.children.at(-1);assert.equal(rows.children.length,30);
 assert.equal(rows.children[0].children[0].children[0].checked,false);
 const output=rows.children[1].children.at(-1);output.value='Manual title';output.oninput();
 const pager=modal.contentEl.children.at(-2),next=pager.children.find(e=>e.text==='下一页'),previous=pager.children.find(e=>e.text==='上一页');
 next.onclick();assert.equal(rows.children.length,1);previous.onclick();assert.equal(rows.children[1].children.at(-1).value,'Manual title');
});

test('model retrieval is explicit and uses only the models endpoint and session credential',async()=>{
 const text='![中文题名](a.png){#fig:a}';let calls=[];
 const {plugin}=await fixture(text,{frontmatter:{lang:'zh-CN'},settings:{translationEndpoint:'https://open.bigmodel.cn',translationModel:'glm-5.3'},requestUrl:async options=>{calls.push(options);return {status:200,json:{data:[{id:'glm-5.3'},{id:'glm-5.3'},{id:'glm-other'}]}};}});
 plugin.translationApiKey='secret';const modal=plugin.openBatchCaptionTranslation({file:{path:'note.md'},editor:{getValue:()=>text}});
 const walk=e=>[e,...e.children.flatMap(walk)];const all=walk(modal.contentEl);
 assert.equal(calls.length,0);await all.find(e=>e.text==='获取模型列表').onclick();
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://open.bigmodel.cn/api/paas/v4/models');assert.equal(calls[0].headers.Authorization,'Bearer secret');assert.equal(calls[0].body,undefined);
 assert(all.some(e=>e.tag==='select'&&e.children.some(o=>o.text==='glm-other')));
});

test('translation defaults persist API settings and store keys separately; saved values reopen as editable defaults',async()=>{
 const text='![中文题名](a.png){#fig:a}';const {plugin}=await fixture(text,{frontmatter:{lang:'zh-CN'}});
 const secrets=new Map();let saved;
 plugin.app.secretStorage={setSecret:(id,value)=>secrets.set(id,value),deleteSecret:id=>secrets.delete(id)};
 plugin.saveData=async data=>{saved=JSON.parse(JSON.stringify(data));};
 await plugin.saveTranslationDefaults('https://open.bigmodel.cn','glm-5.3','enabled','private-key');
 assert.equal(saved.translationEndpoint,'https://open.bigmodel.cn/api/paas/v4');assert.equal(saved.translationReasoning,'enabled');
 assert(!JSON.stringify(saved).includes('private-key'));assert.equal(secrets.get('paper-writing-view-translation'),'private-key');
 const modal=plugin.openBatchCaptionTranslation({file:{path:'note.md'},editor:{getValue:()=>text}});
 const walk=e=>[e,...e.children.flatMap(walk)],all=walk(modal.contentEl);
 assert(!all.some(e=>e.text==='API 来源 '));const inputs=all.filter(e=>e.tag==='input');
 assert.equal(inputs[0].value,saved.translationEndpoint);assert.equal(inputs[2].value,'private-key');assert(!inputs[0].disabled);
 inputs[0].value='https://other.example/v1';inputs[0].oninput();assert.equal(inputs[2].value,'');
 await plugin.saveTranslationDefaults('http://localhost/v1','local','default','');assert.equal(secrets.size,0);
 delete plugin.app.secretStorage;await assert.rejects(plugin.saveTranslationDefaults('https://example.org','model','default','secret'),/Obsidian/);
});

test('closing the batch dialog flushes unsaved API input and key without a save button',async()=>{
 const text='![中文题名](a.png){#fig:a}';const {plugin}=await fixture(text,{frontmatter:{lang:'zh-CN'}});
 const secrets=new Map();plugin.app.secretStorage={setSecret:(id,value)=>secrets.set(id,value),deleteSecret:id=>secrets.delete(id)};plugin.saveData=async()=>{};
 const modal=plugin.openBatchCaptionTranslation({file:{path:'note.md'},editor:{getValue:()=>text}});
 const walk=e=>[e,...e.children.flatMap(walk)],all=walk(modal.contentEl),inputs=all.filter(e=>e.tag==='input');
 inputs[0].value='https://open.bigmodel.cn';inputs[0].oninput();inputs[1].value='glm-5.3';inputs[1].oninput();inputs[2].value='keep-key';inputs[2].oninput();
 assert(!all.some(e=>e.text==='保存为默认配置'));modal.onClose();await plugin.translationSaveQueue;
 assert.equal(plugin.settings.translationModel,'glm-5.3');assert.equal(secrets.get('paper-writing-view-translation'),'keep-key');
 const next=plugin.openBatchCaptionTranslation({file:{path:'note.md'},editor:{getValue:()=>text}});
 assert.equal(walk(next.contentEl).filter(e=>e.tag==='input')[2].value,'keep-key');
});

test('rate limiting respects Retry-After, exposes sanitized provider detail, and retries the same request',async()=>{
 let calls=0;const {plugin}=await fixture('中文',{requestUrl:async()=>++calls<2?{status:429,headers:{'Retry-After':'3'},json:{error:{code:'rate_limit',message:'too many requests secret-value'}}}:{status:200,json:{choices:[{message:{content:'Done'}}]}}});
 const waits=[],messages=[];plugin.waitTranslationRetry=async n=>waits.push(n);
 assert.equal(await plugin.translationText({url:'https://example.org'},'secret-value',m=>messages.push(m)),'Done');
 assert.deepEqual(waits,[3]);assert.equal(calls,2);assert(messages[0].includes('rate_limit'));assert(!messages[0].includes('secret-value'));
});

test('quota exhaustion never retries and unknown 429 stops after two retries',async()=>{
 let calls=0;const {plugin}=await fixture('中文',{requestUrl:async()=>{calls++;return {status:429,json:{error:{code:'insufficient_quota',message:'balance exhausted'}}};}});
 plugin.waitTranslationRetry=async()=>{throw Error('Should not wait');};
 await assert.rejects(plugin.translationText({},''),/insufficient_quota/);assert.equal(calls,1);
 const another=await fixture('中文',{requestUrl:async()=>({status:429,json:{error:{code:'unknown-limit',message:'rate limited'}}})});let waits=0;
 another.plugin.waitTranslationRetry=async()=>{waits++;};
 await assert.rejects(another.plugin.translationText({},''),/unknown-limit/);assert.equal(waits,2);
});

test('AI dialog import previews editable captions without any API call and writes only on acceptance',async()=>{
 let text='![中文图题](a.png){#fig:a}',writes=0,requests=0;
 const {plugin}=await fixture(text,{frontmatter:{lang:'zh-CN'},requestUrl:async()=>{requests++;throw Error('No API expected');}});
 const source={file:{path:'note.md'},editor:{getValue:()=>text,cm:{dispatch({changes}){writes++;for(const c of Array.from(changes).reverse())text=text.slice(0,c.from)+c.insert+text.slice(c.to??c.from);}}}};
 const modal=plugin.openBatchCaptionTranslation(source),walk=e=>[e,...e.children.flatMap(walk)],button=(m,t)=>walk(m.contentEl).find(e=>e.tag==='button'&&e.text===t);
 const importer=button(modal,'导入 AI 译文').onclick();walk(importer.contentEl).find(e=>e.tag==='textarea').value=JSON.stringify({translations:[{key:'fig:a',source:'中文图题',text:'English title'}]});
 button(importer,'导入到审阅列表').onclick();assert.equal(writes,0);assert.equal(requests,0);
 const output=walk(modal.contentEl).find(e=>e.tag==='textarea');assert.equal(output.value,'English title');output.value='Edited title';output.oninput();
 button(modal,'确认写入勾选项').onclick();assert.equal(writes,1);assert.match(text,/Fig\. \[-@fig:a\] Edited title/);assert.equal(requests,0);
});

test('closing a multi-request batch ignores an outstanding response and never writes automatically',async()=>{
 let count=0,resolve,writes=0;
 const text=Array.from({length:21},(_,i)=>'![中文图题](a.png){#fig:f'+i+'}').join('\n\n');
 const {plugin}=await fixture(text,{frontmatter:{lang:'zh-CN'},settings:{translationEndpoint:'http://localhost/v1',translationModel:'local'},requestUrl:async options=>{
  count++;if(count===2)return new Promise(r=>{resolve=r;});
  const captions=JSON.parse(JSON.parse(options.body).messages[1].content).captions;
  return {status:200,json:{choices:[{message:{content:JSON.stringify({translations:captions.map(c=>({key:c.key,text:'English title'}))})}}]}};
 }});
 const modal=plugin.openBatchCaptionTranslation({file:{path:'note.md'},editor:{getValue:()=>text,cm:{dispatch(){writes++;}}}});
 const actions=modal.contentEl.children.find(c=>c.children?.some(b=>b.text==='预览发送内容'));
 actions.children.find(b=>b.text==='预览发送内容').onclick();const pending=actions.children.find(b=>b.text==='生成所选英文图表题').onclick();
 for(let i=0;i<20&&!resolve;i++)await Promise.resolve();assert.equal(count,2);
 modal.onClose();resolve({status:200,json:{choices:[{message:{content:'{}'}}]}});await pending;assert.equal(writes,0);
});
function tags(element, tag) { return (element.tagName===tag?1:0)+(element.children||[]).reduce((n,c)=>n+tags(c,tag),0); }

test('fake script status follows edits, setting and active view; preview repairs in one transaction', async()=>{
  const {plugin}=await fixture('CO₂ R²');
  let text='CO₂ R²', calls=0;
  const editor={getValue:()=>text,cm:{dispatch({changes}){
    calls++;
    for(const c of Array.from(changes).reverse())text=text.slice(0,c.from)+c.insert+text.slice(c.to??c.from);
  }}};
  const source={file:{path:'note.md'},editor};
  plugin.updateBlankStatus(source);
  assert.match(plugin.scriptStatus.text,/2 处/);
  plugin.settings.fakeScriptWarnings=false;plugin.updateBlankStatus(source);
  assert.equal(plugin.scriptStatus.style.display,'none');
  const modal=plugin.fixFakeScripts(source);
  const buttons=[];const walk=e=>{if(e.tag==='button')buttons.push(e);e.children.forEach(walk);};walk(modal.contentEl);
  assert.equal(calls,0);
  buttons.find(b=>b.text==='全部修复').onclick();
  assert.equal(calls,1);assert(modal.closed);
  assert(text.includes('CO<sub>2</sub> R<sup>2</sup>'));
  assert(text.includes('date modified:'));
});

test('fake script repair refuses a stale preview after text changes or file switch', async()=>{
  const {plugin,notices}=await fixture('CO₂');
  let text='CO₂',calls=0;
  const source={file:{path:'note.md'},editor:{getValue:()=>text,cm:{dispatch(){calls++;}}}};
  const modal=plugin.fixFakeScripts(source);
  const button=modal.contentEl.children.at(-1).children.find(b=>b.text==='全部修复');
  text='changed CO₂';button.onclick();assert.equal(calls,0);
  text='CO₂';source.file={path:'other.md'};button.onclick();assert.equal(calls,0);
  assert.equal(notices.filter(n=>n.includes('笔记已变化')).length,2);
});

test('large repair previews render 100 rows per page and retain explicit selections across pages',async()=>{
  const {plugin}=await fixture('CO₂ '.repeat(250));
  let text='CO₂ '.repeat(250),calls=0;
  const source={file:{path:'note.md'},editor:{getValue:()=>text,cm:{dispatch({changes}){
    calls++;for(const c of Array.from(changes).reverse())text=text.slice(0,c.from)+c.insert+text.slice(c.to??c.from);
  }}}};
  const modal=plugin.fixFakeScripts(source),pager=modal.contentEl.children[2],list=modal.contentEl.children[3];
  const button=(root,label)=>root.children.find(c=>c.tag==='button'&&c.text===label);
  assert.equal(list.children.length,100);
  button(pager,'清空选择').onclick();
  let check=list.children[0].children[0].children[0];check.checked=true;check.onchange();
  button(pager,'下一页').onclick();
  check=list.children[0].children[0].children[0];assert.equal(check.checked,false);check.checked=true;check.onchange();
  button(pager,'下一页').onclick();assert.equal(list.children.length,50);
  button(pager,'上一页').onclick();button(pager,'上一页').onclick();
  assert.equal(list.children[0].children[0].children[0].checked,true);
  button(modal.contentEl.children.at(-1),'修复所选').onclick();
  assert.equal(calls,1);assert.equal((text.match(/<sub>2<\/sub>/g)||[]).length,2);
  assert.equal((text.match(/₂/g)||[]).length,248);
});

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

test('grouped bilingual captions render under their own images without duplicate blocks',async()=>{
  const text='![甲](a.png){#fig:a}![乙](b.png){#fig:b}\n\n::: {custom-style="Figure Caption EN"}\nFig. [-@fig:b] Beta\n:::\n\n::: {custom-style="Figure Caption EN"}\nFig. [-@fig:a] Alpha\n:::';
  const {ranges,view}=await fixture(text);
  const grouped=ranges.find(r=>r.widget?.items);
  assert(grouped);assert.equal(grouped.to,text.length);
  assert.equal(ranges.filter(r=>r.widget?.figure?.captionDiv).length,0);
  const dom=grouped.widget.toDOM(view);
  const collect=e=>[e.text||e.textContent||'',...(e.children||[]).map(collect)].join('');
  assert.equal(dom.children.length,2);
  assert(collect(dom.children[0]).includes('Fig. 1 Alpha'));
  assert(!collect(dom.children[0]).includes('Beta'));
  assert(collect(dom.children[1]).includes('Fig. 2 Beta'));
  const editing=await fixture(text,{selection:{ranges:[{from:text.indexOf('Beta'),to:text.indexOf('Beta')}]}});
  assert.equal(editing.ranges.filter(r=>r.widget?.items).length,0);
});

test('English caption divs hide the fences and resolve suppressed references', async () => {
  const text='![中文图题](a.png){#fig:a}\n\n::: {custom-style="Figure Caption EN"}\nFig. [-@fig:a] Typical organic pores (oil-wet), inorganic pores (water-wet) in shale\n:::';
  const {ranges,view}=await fixture(text);
  const div=ranges.find(r=>r.widget?.figure?.captionDiv);
  assert(div,'caption div is replaced by one widget');
  assert.equal(div.from,text.indexOf(':::'));
  assert.equal(div.to,text.length);
  const dom=div.widget.toDOM(view);
  const all=[];const collect=e=>{if(e.text)all.push(e.text);if(e.textContent)all.push(e.textContent);for(const c of e.children||[])collect(c);};
  collect(dom);
  const joined=all.join('');
  assert(joined.includes('Fig. 1'),'suppressed reference resolves to the bare number');
  assert(!joined.includes('[-@'));
  assert(!joined.includes(':::'));
  assert.equal(dom.dataset.customStyle,'Figure Caption EN');
  const editing=await fixture(text,{selection:{ranges:[{from:text.indexOf('Fig.'),to:text.indexOf('Fig.')}]}});
  assert.equal(editing.ranges.filter(r=>r.widget?.figure?.captionDiv).length,0,'cursor inside reveals the source');
});

test('prose suppressed references render the bare number with the prefix suppressed', async () => {
  const text='![图](a.png){#fig:a}\n\n见 [-@fig:a] 与 @fig:a 所示。';
  const {ranges,view}=await fixture(text);
  const suppressed=ranges.find(r=>r.widget?.reference?.numberOnly);
  assert(suppressed);
  assert.equal(text.slice(suppressed.from,suppressed.to),'[-@fig:a]');
  assert.equal(suppressed.widget.toDOM(view).textContent,'1');
  const plain=ranges.filter(r=>r.widget?.reference && !r.widget.reference.numberOnly);
  assert.equal(plain[0].widget.toDOM(view).textContent,'图 1');
});

test('English caption blocks use the chosen Latin font and support both number-only forms',async()=>{
  const text='![中文](a.png){#fig:a}\n\n::: {custom-style="Figure Caption EN"}\nFig. -@fig:a and [-@fig:a] CO<sub>2</sub>\n:::';
  const {ranges,view}=await fixture(text,{settings:{latinFont:'Times New Roman'}});
  const widget=ranges.find(r=>r.widget?.figure?.captionDiv).widget;
  const dom=widget.toDOM(view),caption=dom.children.find(c=>c.tagName==='SPAN');
  assert.equal(caption.style.fontFamily,'"Times New Roman", serif');
  const references=caption.children.filter(c=>c.className==='pcp-reference');
  assert.equal(references.length,2);assert(references.every(c=>c.textContent==='1'));
  assert.equal(tags(caption,'SUB'),1);
});

test('unresolved number-only widget displays the exact original source',async()=>{
  const {ranges,view}=await fixture('See -@fig:missing and [-@tbl:missing].');
  const refs=ranges.filter(r=>r.widget?.reference);
  assert.deepEqual(Array.from(refs,r=>r.widget.toDOM(view).textContent),['-@fig:missing','[-@tbl:missing]']);
});

test('lightweight writing skips bilingual caption and number replacements',async()=>{
  const text='![中文](a.png){#fig:a}\n\n::: {custom-style="Figure Caption EN"}\nFig. [-@fig:a] English\n:::';
  const {ranges}=await fixture(text,{settings:{performanceMode:'lite'}});
  assert.equal(ranges.length,0);
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
