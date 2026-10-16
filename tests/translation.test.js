'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {captionTargets,captionTranslationPlan,protectCaption,captionTranslationRequest,validateCaptionTranslation,captionTranslationEdits,captionBatchRequest,parseCaptionBatch,captionBatchEdits,translationBase}=require('../src/core');
const source='---\ntitle: private metadata\nmodified: old\n---\n# Paper title\n\n## Abstract\nFaults control helium migration.\n\n## Results\nLocal context.\n\n![氦气与 CO<sub>2</sub> 含量 0.1% [@key2024]](a.png){#fig:a}\n\nNext paragraph.\n';
const planFor=(text=source,type='fig')=>captionTranslationPlan(text,captionTargets(text).find(r=>r.type===type));
const apply=(text,edits)=>edits.slice().reverse().reduce((value,e)=>value.slice(0,e.from)+e.insert+value.slice(e.to??e.from),text);

test('literal import and final write allow numeric reordering without swapping actual values',()=>{
 const {importCaptionHandoff}=require('../src/core');
 const caption='GI = 1，6 个断裂段中有 5 个；WZ13-1-1 的 3 个点，LS36-1 的 6 个点；4 组共 9 点。CO<sub>2</sub> 与 <sup>4</sup>He [@existing]';
 const text='![A](a.png){#fig:a}'.replace('![A]','!['+caption+']');
 const rows=captionTargets(text),english='GI = 1; 5 of the 6 fault segments; 3 points from WZ13-1-1 and 6 from LS36-1; 9 points from 4 groups. CO<sub>2</sub> and <sup>4</sup>He [@existing]';
 const load=value=>importCaptionHandoff(JSON.stringify({translations:[{key:'fig:a',source:caption,text:value}]}),rows);
 assert.equal(load(english).get('fig:a'),english);
 const result=apply(text,captionBatchEdits(text,[{plan:captionTranslationPlan(text,rows[0]),translation:english}],'now'));
 assert(result.includes(english));
 for(const bad of [english.replace('5 of','7 of'),english+' 9',english.replace('9 points','points'),
  english.replace('WZ13-1-1','WZ13-1-3'),english.replace('CO<sub>2</sub>','CO<sup>2</sup>'),
  english.replace('CO<sub>2</sub> and <sup>4</sup>He','CO<sub>4</sub> and <sup>2</sup>He'),
  english.replace('[@existing]','[@other]')]) {
  assert.throws(()=>load(bad),/不一致/);
  assert.throws(()=>captionBatchEdits(text,[{plan:captionTranslationPlan(text,rows[0]),translation:bad}],'now'),/不一致/);
 }
});

test('side-by-side figures translate independently in source order without splitting the image line',()=>{
 for(const eol of ['\n','\r\n']) {
  const line='![甲](a.png){#fig:a}![乙](b.png){#fig:b}![丙](c.png){#fig:c}';
  const text=['---','modified: old','---',line,'','Body.'].join(eol);
  const entries=captionTargets(text).map((row,i)=>({plan:captionTranslationPlan(text,row),translation:['Alpha','Beta','Gamma'][i]}));
  const result=apply(text,captionBatchEdits(text,entries.slice().reverse(),'now'));
  assert(result.includes(line+eol));assert(result.indexOf('] Alpha')<result.indexOf('] Beta'));assert(result.indexOf('] Beta')<result.indexOf('] Gamma'));
  assert.equal((result.match(/Figure Caption EN/g)||[]).length,3);
  if(eol==='\r\n')assert(!/(?<!\r)\n/.test(result));
  const updated=captionTargets(result).map(row=>({plan:captionTranslationPlan(result,row),translation:row.id==='b'?'Revised beta':row.id==='a'?'Alpha':'Gamma'}));
  assert(updated.every(e=>e.plan.existing));
  const revised=apply(result,captionBatchEdits(result,[updated[1]],'later'));
  assert.equal((revised.match(/Figure Caption EN/g)||[]).length,3);assert(revised.includes('Revised beta'));assert(revised.includes('] Gamma'));
  const partial=apply(text,captionBatchEdits(text,[entries[1]],'now'));
  const missing=captionTranslationPlan(partial,captionTargets(partial)[0]);
  assert.equal(missing.existing,null);
  const completed=apply(partial,captionTranslationEdits(partial,missing,'Alpha','later'));
  assert.equal((completed.match(/Figure Caption EN/g)||[]).length,2);
  assert(captionTranslationPlan(completed,captionTargets(completed)[1]).existing.content.includes('Beta'));
 }
});

test('side-by-side translation refuses duplicate, unrelated and malformed adjacent English blocks',()=>{
 const line='![甲](a.png){#fig:a}![乙](b.png){#fig:b}';
 const block=id=>'\n\n::: {custom-style="Figure Caption EN"}\nFig. [-@fig:'+id+'] Title\n:::';
 for(const tail of [block('z'),block('a')+block('a'),'\n\n::: {custom-style="Figure Caption EN"}\nUnclosed']) {
  const text=line+tail;assert.throws(()=>captionTranslationPlan(text,captionTargets(text)[0]),/不匹配|重复|未闭合/);
 }
});

test('AI conversation handoff uses full text without API credentials and imports safe editable translations',()=>{
 const {captionHandoff,importCaptionHandoff}=require('../src/core');const rows=captionTargets(source);
 const prompt=captionHandoff(source,rows);assert(prompt.includes('Faults control helium migration.'));assert(prompt.includes('fig:a'));assert(!prompt.includes('private metadata'));
 const data={translations:[{key:'fig:a',source:rows[0].caption,text:'Helium and CO<sub>2</sub> content 0.1% [@key2024]'}]};
 const imported=importCaptionHandoff('```json\n'+JSON.stringify(data)+'\n```',rows);assert.match(imported.get('fig:a'),/Helium/);
 assert.throws(()=>importCaptionHandoff(JSON.stringify({translations:[{...data.translations[0],source:'Changed'}]}),rows),/不一致/);
 assert.throws(()=>importCaptionHandoff(JSON.stringify({translations:[{...data.translations[0],text:'Wrong 9'}]}),rows),/不一致/);
 assert.throws(()=>importCaptionHandoff(JSON.stringify({translations:[data.translations[0],data.translations[0]]}),rows),/重复/);
});

test('Zhipu base URL and thinking parameters differ from generic reasoning effort',()=>{
 assert.equal(translationBase('https://open.bigmodel.cn'),'https://open.bigmodel.cn/api/paas/v4');
 const settings={translationEndpoint:'https://open.bigmodel.cn',translationModel:'glm-5.3'};
 const body=choice=>JSON.parse(captionTranslationRequest({...settings,translationReasoning:choice},planFor()).body);
 assert.equal(body('default').thinking,undefined);assert.deepEqual(body('enabled').thinking,{type:'enabled'});
 assert.deepEqual(body('disabled').thinking,{type:'disabled'});assert.equal(body('enabled').reasoning_effort,undefined);
 assert.throws(()=>body('high'),/不支持/);
 const generic=JSON.parse(captionTranslationRequest({...settings,translationEndpoint:'https://example.org/v1',translationReasoning:'high'},planFor()).body);
 assert.equal(generic.reasoning_effort,'high');assert.equal(generic.thinking,undefined);
});

test('context includes title, abstract and nearby prose; never reads linked files or includes comments/code/frontmatter',()=>{
 const text=source+'\n<!-- secret comment -->\n%% secret Obsidian comment %%\n```\nsecret code\n```\n';
 const p=planFor(text);assert.match(p.context,/Paper title/);assert.match(p.context,/Faults control helium/);assert.match(p.context,/Local context/);
 for(const hidden of ['private metadata','secret comment','secret code','secret Obsidian'])assert(!p.context.includes(hidden));
 assert(captionTranslationPlan(text+'x'.repeat(120001),p.row,'full').context.length>120000);
});

test('request is explicit non-streaming chat completions with no persisted secret; validates transport and model',()=>{
 const settings={translationEndpoint:'http://localhost:11434/v1/',translationModel:'local-model',translationApiKey:'must-not-serialize'};
 const request=captionTranslationRequest(settings,planFor());
 assert.equal(request.url,'http://localhost:11434/v1/chat/completions');assert.equal(JSON.parse(request.body).stream,false);
 assert(!JSON.stringify(request).includes('must-not-serialize'));assert.match(request.body,/PWVKEEP/);
 assert.equal(captionTranslationRequest({...settings,translationEndpoint:'https://example.org/v1/chat/completions'},planFor()).url,'https://example.org/v1/chat/completions');
 for(const address of ['ftp://example.org','http://example.org/v1','https://u:p@example.org','https://example.org/?key=secret'])assert.throws(()=>captionTranslationRequest({...settings,translationEndpoint:address},planFor()));
 assert.throws(()=>captionTranslationRequest({...settings,translationModel:''},planFor()),/模型/);
});

test('preserves citations, math, numeric values and true scripts; rejects dropped/extra/reordered placeholders',()=>{
 const p=protectCaption('CO<sub>2</sub>, $R^2$ = 0.5 [@key] and @other2024');
 assert.equal(validateCaptionTranslation(p.source,p),'CO<sub>2</sub>, $R^2$ = 0.5 [@key] and @other2024');
 for(const invalid of [p.source.replace('PWVKEEP0TOKEN',''),p.source+' PWVKEEP0TOKEN',p.source.replace('PWVKEEP0TOKEN','PWVKEEP99TOKEN')])assert.throws(()=>validateCaptionTranslation(invalid,p),/保留/);
 assert.throws(()=>validateCaptionTranslation('::: malicious',p));assert.throws(()=>protectCaption('CO₂'),/上下标/);
 assert.throws(()=>validateCaptionTranslation(p.source+' 2026',p),/增加/);
 assert.throws(()=>validateCaptionTranslation(p.source+' $unclosed',p),/未闭合/);
});

test('accepted figure translation inserts one EN block with original label and metadata in one undo transaction',()=>{
 const p=planFor(), translated='Helium and CO<sub>2</sub> content 0.1% [@key2024]';
 const changes=captionTranslationEdits(source,p,translated,'2026.10.16 17:00:00');
 assert.equal(changes.length,2);
 const result=apply(source,changes);assert.match(result,/modified: 2026.10.16 17:00:00/);
 assert(result.includes(source.slice(p.row.from,p.row.to)));assert(result.includes('Next paragraph.'));
 assert.match(result,/Fig\. \[-@fig:a\] Helium and CO<sub>2<\/sub> content 0\.1% \[@key2024\]/);
 assert(result.includes('::: \n')===false);
 assert.throws(()=>captionTranslationEdits(source,p,translated.replace('0.1','0.2'),'now'),/不一致/);
});

test('table translation is inserted after the whole table, and existing matching EN block is replaced',()=>{
 const text=': 表题 {#tbl:t}\r\n\r\n| A | B |\r\n| --- | --- |\r\n| C | D |\r\n\r\nBody';
 const p=planFor(text,'tbl'), result=apply(text,captionTranslationEdits(text,p,'English title','now'));
 assert(result.indexOf('Table [-@tbl:t] English title')>result.indexOf('| C | D |'));
 assert(!/(?<!\r)\n/.test(result));
 const updated=apply(result,captionTranslationEdits(result,planFor(result,'tbl'),'Revised title','later'));
 assert(!/(?<!\r)\n/.test(updated));
 assert.equal((updated.match(/Table Caption EN/g)||[]).length,1);assert(!updated.includes('English title'));
 assert.throws(()=>planFor(': x {#tbl:t}\n\nUnrecognized table','tbl'),/标准管道/);
});

test('ambiguous labels, adjacent wrong EN labels and unclosed blocks are not overwritten',()=>{
 assert.throws(()=>planFor(source+'\n![duplicate](b.png){#fig:a}'),/重复/);
 assert.throws(()=>planFor(source.replace('\n\nNext paragraph.','\n\n::: {custom-style="Figure Caption EN"}\nFig. [-@fig:b] Wrong\n:::\n')),/不匹配/);
 assert.throws(()=>planFor(source.replace('\n\nNext paragraph.','\n\n::: {custom-style="Figure Caption EN"}\nUnclosed\n')),/未闭合/);
});

test('batch response matches stable labels rather than array order and validates every caption',()=>{
 const text=source+'\n\n![第二张含量 1.2%](b.png){#fig:b}';
 const plans=captionTargets(text).map(row=>captionTranslationPlan(text,row));
 const request=captionBatchRequest({translationEndpoint:'http://localhost/v1',translationModel:'local'},plans);
 const captions=JSON.parse(JSON.parse(request.body).messages[1].content).captions;
 assert.equal(captions.length,2);
 const translations=captions.map(c=>({key:c.key,text:c.caption.replace(/[\u3400-\u9fff]+/g,'English')})).reverse();
 const result=parseCaptionBatch(JSON.stringify({translations}),request.protections);
 assert.match(result.get('fig:b'),/1\.2%/);
 assert.throws(()=>parseCaptionBatch(JSON.stringify({translations:translations.slice(1)}),request.protections),/数量/);
 assert.throws(()=>parseCaptionBatch(JSON.stringify({translations:[translations[0],translations[0]]}),request.protections),/重复/);
 assert.throws(()=>parseCaptionBatch(JSON.stringify({translations:[{...translations[0],text:'Wrong 9'},translations[1]]}),request.protections),/保留/);
 assert.throws(()=>captionBatchRequest({},Array(21).fill(plans[0])),/20/);
});

test('batch figure and table writes share one timestamp and preserve source positions and original references',()=>{
 const text=source+'\n\n: 表题 {#tbl:t}\n\n| A | B |\n| --- | --- |\n| C | D |\n';
 const entries=captionTargets(text).map(row=>({plan:captionTranslationPlan(text,row),translation:row.type==='fig'?'Helium and CO<sub>2</sub> content 0.1% [@key2024]':'Table title'}));
 const edits=captionBatchEdits(text,entries,'real-time-test');assert.equal(edits.length,3);
 const result=apply(text,edits);
 assert.equal((result.match(/modified: real-time-test/g)||[]).length,1);
 assert(result.includes('Fig. [-@fig:a] Helium'));assert(result.includes('Table [-@tbl:t] Table title'));
 assert.equal((result.match(/\[@key2024\]/g)||[]).length,2);
 assert.throws(()=>captionBatchEdits(text,[entries[0],entries[0]],'now'),/重复/);
 assert.throws(()=>captionBatchEdits(text,[entries[0],{...entries[1],translation:'Bad 9'}],'now'),/不一致/);
});
