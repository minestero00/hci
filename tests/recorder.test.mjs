import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { Recorder } from '../web/recorder.mjs';
import { summarizeBehavior } from '../web/telemetry.mjs';
import { createRun,submitStep,makeEnvelope,validateEnvelope } from '../web/core.mjs';

function setup(t){
 const window=new Window({url:'https://example.test/hci/'}),document=window.document;
 document.body.dataset.uiVersion='test-ux2';document.body.innerHTML='<main data-region="sources"><section data-source-id="brief" data-track="source-brief"><button data-track="inspect">Inspect</button></section></main><form data-region="response"><input type="radio" name="choice" data-track="option-a"><input type="radio" name="choice" data-track="option-b"><textarea name="text" data-track="memo"></textarea></form>';
 Object.defineProperty(document,'hasFocus',{value:()=>true,configurable:true});
 Object.defineProperty(document,'hidden',{value:false,writable:true,configurable:true});
 for(const[key,value]of Object.entries({window,document,IntersectionObserver:window.IntersectionObserver}))Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
 let time=0;const saved=[],store={mode:'memory',async appendEvents(batch){saved.push(...structuredClone(batch));}};
 const recorder=new Recorder({store,clock:()=>time});const run=createRun({participantCode:'T001',condition:'control'});recorder.start(run);
 const fire=(element,type,properties={})=>{const event=new window.Event(type,{bubbles:true,cancelable:true});for(const[key,value]of Object.entries(properties))Object.defineProperty(event,key,{value});element.dispatchEvent(event);};
 t.after(async()=>{await recorder.stop();await window.happyDOM.abort();window.close();});
 return{window,document,recorder,run,store,saved,fire,advance:value=>{time+=value;}};
}

test('semantic telemetry captures revisions and edit aggregates without typed, clipboard or selected content',async t=>{
 const{document,recorder,saved,fire,advance,run}=setup(t);const memo=document.querySelector('textarea'),radios=document.querySelectorAll('input');
 fire(radios[0],'change');fire(radios[1],'change');fire(memo,'focusin');
 for(let i=0;i<6;i++){fire(memo,'beforeinput',{inputType:'insertText',data:'VERY_PRIVATE_TYPED'});memo.value+='secret';fire(memo,'input');advance(10);}
 fire(memo,'compositionstart',{data:'VERY_PRIVATE_IME'});fire(memo,'compositionend',{data:'VERY_PRIVATE_IME'});
 fire(memo,'paste',{clipboardData:{getData:()=> 'VERY_PRIVATE_CLIPBOARD'}});
 fire(memo,'keydown',{key:'密'});fire(memo,'keydown',{key:'Enter'});fire(memo,'focusout');
 fire(document.querySelector('button'),'click');await recorder.stop();
 const serialized=JSON.stringify(saved);assert.ok(!serialized.includes('VERY_PRIVATE'));assert.ok(!serialized.includes('secret'));assert.ok(!serialized.includes('密'));
 assert.equal(saved.find(e=>e.type==='control_change'&&e.data.revised).data.target,'option-b');
 assert.equal(saved.filter(e=>e.type==='input_action').length,1);
 const field=saved.find(e=>e.type==='field_session');assert.equal(field.data.inputActions,6);assert.equal(field.data.compositionCount,1);assert.equal(field.data.pastes,1);assert.equal(field.data.finalLength,36);
 const summary=summarizeBehavior(saved);assert.equal(summary.totals.inputActions,6);assert.equal(summary.totals.choiceChanges,1);assert.equal(summary.totals.pasteCount,1);assert.equal(summary.totals.clicks,1);
 assert.deepEqual(summary.quality.uiVersions,['test-ux2']);assert.equal(validateEnvelope(makeEnvelope(run,saved)),true);
});

test('foreground intervals partition hidden, blurred and 30s interaction idle time without overlap',async t=>{
 const{window,document,recorder,saved,fire,advance}=setup(t);
 advance(35000);fire(window,'blur');advance(5000);fire(window,'focus');advance(10000);document.hidden=true;fire(document,'visibilitychange');advance(8000);document.hidden=false;fire(document,'visibilitychange');advance(2000);await recorder.stop();
 const summary=summarizeBehavior(saved);
 assert.equal(summary.totals.durationMs,60000);assert.equal(summary.totals.foregroundMs,47000);assert.equal(summary.totals.activeMs,30000);assert.equal(summary.totals.idleMs,17000);assert.equal(summary.totals.hiddenMs,8000);assert.equal(summary.totals.blurredMs,5000);
 assert.equal(summary.totals.durationMs,summary.totals.foregroundMs+summary.totals.hiddenMs+summary.totals.blurredMs);
});

test('source exposure pauses on blur and hidden pages and preserves prior stage context',async t=>{
 const env=setup(t),{window,document,recorder,saved,fire,advance,run}=env;let callback;
 class Observer{constructor(cb){callback=cb;}observe(){}disconnect(){}}
 globalThis.IntersectionObserver=Observer;recorder.observe(document.body);
 const element=document.querySelector('[data-source-id]');callback([{target:element,isIntersecting:true,intersectionRatio:.5}]);
 advance(1000);fire(window,'blur');advance(9000);fire(window,'focus');advance(2000);
 const next=submitStep(run,{complete:true});recorder.context(next);advance(3000);await recorder.stop();
 const ends=saved.filter(e=>e.type==='source_exposure_end');assert.equal(ends.length,3);assert.equal(ends.filter(e=>e.phase==='practice').reduce((sum,e)=>sum+e.data.durationMs,0),3000);assert.equal(ends.find(e=>e.phase==='decision').data.durationMs,3000);
 const summary=summarizeBehavior(saved);assert.equal(summary.sources[0].exposureMs,6000);assert.equal(summary.sources[0].maxRatio,.5);assert.equal(summary.sources[0].exposureCount,3);
});

test('bounded pointer and scroll events retain direction, depth, hover and resume timing',async t=>{
 const{document,recorder,saved,fire,advance}=setup(t);const button=document.querySelector('button'),panel=document.querySelector('main');
 Object.defineProperties(panel,{scrollHeight:{value:1000},clientHeight:{value:400}});
 fire(button,'pointerover');for(let i=0;i<10;i++){fire(button,'pointermove',{clientX:i*10,clientY:i*5,pointerType:'mouse'});advance(20);}fire(button,'pointerout');
 panel.scrollTop=200;fire(panel,'scroll');advance(100);panel.scrollTop=500;fire(panel,'scroll');advance(200);panel.scrollTop=400;fire(panel,'scroll');fire(panel,'scrollend');
 await recorder.stop();assert.equal(saved.filter(e=>e.type==='pointer_move').length,1);assert.equal(saved.filter(e=>e.type==='scroll').length,2);
 const burst=saved.find(e=>e.type==='scroll_end');assert.equal(burst.data.reversals,1);assert.equal(burst.data.distancePx,600);assert.equal(burst.data.maxDepth,.83);assert.equal(saved.find(e=>e.type==='hover_end').data.durationMs,200);
});

test('failed stop preserves queue and repeated start/stop avoids duplicate listeners',async t=>{
 const{document,recorder,store,saved,fire,run}=setup(t);store.appendEvents=async()=>{throw Error('forced write failure');};fire(document.querySelector('button'),'click');
 const original=recorder.pendingEvents().map(e=>e.id);await assert.rejects(recorder.stop(),/forced/);assert.ok(original.every(id=>recorder.pendingEvents().some(e=>e.id===id)));
 recorder.start(run);recorder.start(run);store.appendEvents=async batch=>saved.push(...structuredClone(batch));fire(document.querySelector('button'),'click');await recorder.stop();
 assert.equal(saved.filter(e=>e.type==='click').length,2);assert.ok(original.every(id=>saved.some(e=>e.id===id)));assert.equal(new Set(saved.map(e=>e.id)).size,saved.length);
});

test('legacy summaries preserve missing durations and deduplicate event IDs',()=>{
 const event={id:'legacy',pageId:'p',phase:'memo',taskId:'event',updateId:null,type:'input_action',data:{}};
 const summary=summarizeBehavior([event,event]);assert.equal(summary.totals.events,1);assert.equal(summary.totals.inputActions,1);assert.equal(summary.totals.durationMs,null);assert.equal(summary.stages[0].durationMs,null);assert.ok(summary.quality.warnings.length);
 assert.equal(summarizeBehavior([]).totals.events,0);
 const failures=summarizeBehavior([{...event,id:'response-failed',type:'response_storage_error'},{...event,id:'export-failed',type:'export_failed'}]);
 assert.equal(failures.quality.storageFailures,1);assert.equal(failures.quality.exportWarnings,1);
});


test('partial checkpoints retain exact interval and input counts and distinguish collocated fields',async t=>{
 const{document,recorder,saved,fire,advance}=setup(t);
 const container=document.createElement('section');container.dataset.track='shared-form';container.innerHTML='<textarea name="first"></textarea><textarea name="second"></textarea>';document.body.append(container);
 const[first,second]=container.querySelectorAll('textarea');
 fire(first,'focusin');fire(first,'beforeinput',{inputType:'insertText'});first.value='one';fire(first,'input');advance(1000);recorder.checkpoint('export');
 fire(first,'beforeinput',{inputType:'insertText'});first.value+='two';fire(first,'input');fire(first,'focusout');
 fire(second,'focusin');fire(second,'beforeinput',{inputType:'insertText'});second.value='other';fire(second,'input');advance(2000);recorder.checkpoint('export');await recorder.stop();
 const summary=summarizeBehavior(saved);assert.equal(summary.totals.durationMs,3000);assert.equal(summary.totals.inputActions,3);
 const fields=saved.filter(e=>e.type==='field_session');assert.equal(new Set(fields.map(e=>e.data.target)).size,2);assert.deepEqual(fields.map(e=>e.data.inputActions),[1,1,1]);
});

test('tiny initial source intersections count without waiting for a larger threshold',async t=>{
 const{document,recorder,saved,advance}=setup(t);let callback;globalThis.IntersectionObserver=class{constructor(cb){callback=cb;}observe(){}disconnect(){}};
 recorder.observe(document.body);callback([{target:document.querySelector('[data-source-id]'),isIntersecting:true,intersectionRatio:.004}]);advance(1250);await recorder.stop();
 assert.equal(saved.find(e=>e.type==='source_exposure_end').data.durationMs,1250);assert.equal(summarizeBehavior(saved).sources[0].maxRatio,.004);
});


test('covering dialogs suspend source exposure without changing foreground timing',async t=>{
 const{document,recorder,saved,advance}=setup(t);let callback;globalThis.IntersectionObserver=class{constructor(cb){callback=cb;}observe(){}disconnect(){}};
 const source=document.querySelector('[data-source-id]');recorder.observe(document.body);callback([{target:source,isIntersecting:true,intersectionRatio:1}]);
 advance(1000);recorder.overlay(true,'help');advance(5000);callback([{target:source,isIntersecting:true,intersectionRatio:.5}]);advance(2000);recorder.overlay(false);advance(1500);await recorder.stop();
 const summary=summarizeBehavior(saved);assert.equal(summary.sources[0].exposureMs,2500);assert.equal(summary.totals.foregroundMs,9500);assert.equal(summary.totals.hiddenMs,0);assert.equal(summary.totals.blurredMs,0);
 assert.deepEqual(saved.filter(e=>e.type==='overlay_state').map(e=>({open:e.data.open,kind:e.data.kind})),[{open:true,kind:'help'},{open:false,kind:'help'}]);
});
