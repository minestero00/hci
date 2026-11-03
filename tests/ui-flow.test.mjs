import test from 'node:test';
import assert from 'node:assert/strict';
import { domEnvironment,until,submit,choose } from './helpers/dom-env.mjs';
import { makeInvitations,stepInfo,validateEnvelope } from '../web/core.mjs';
import { BrowserStore } from '../web/storage.mjs';
import { ANSWER_KEY } from '../web/research-key.mjs';

test('participant app completes a real DOM/IndexedDB assisted run and exports its raw log',async t=>{
 const invite=makeInvitations(4,'https://example.test/hci/index.html').find(i=>i.condition==='assisted');
 const env=await domEnvironment(new URL('../web/index.html',import.meta.url),invite.url);t.after(()=>env.cleanup());
 await import('../web/app.mjs?dom-flow');
 await until(()=>env.document.querySelector('#start-form'),'welcome');
 env.document.querySelector('input[name=consent]').checked=true;submit(env.document,'start-form');
 const store=await new BrowserStore().init();
 const getRun=async()=>{const id=localStorage.getItem('hci-workspace.activeRun');return id?store.getRun(id):null;};
 await until(async()=>{const run=await getRun();return run?.stage.phase==='practice'&&env.document.querySelector('#step-form');},'practice');
 choose(env.document,'practiceChoice','안내');env.document.querySelector('textarea[name=practiceMemo]').value='연습했습니다.';submit(env.document,'step-form');
 let iterations=0;
 while(iterations++<18){
   const run=await until(async()=>{const r=await getRun();return r&&r.stage.phase!=='practice'?r:null;},'run step');
   const info=stepInfo(run);if(info.phase==='done')break;
   await until(()=>env.document.querySelector('#step-form')&&!env.document.querySelector('#step-form button[type=submit]')?.disabled,'step UI');
   if(info.phase==='decision'){assert.ok(env.document.querySelector('.ai-card'));choose(env.document,'choice',ANSWER_KEY[info.taskId].initial);}
   if(info.phase==='estimate'){assert.ok(env.document.querySelector('.ai-card'));choose(env.document,'burden',3);choose(env.document,'prediction',0);}
   if(info.phase==='update'){assert.equal(env.document.querySelector('.ai-card'),null);choose(env.document,'choice',ANSWER_KEY[info.taskId].updates[info.updateId]);}
   if(info.phase==='memo'){
     assert.equal(env.document.querySelector('.ai-card'),null);
     const area=env.document.querySelector('textarea[name=text]');area.value='조건의 관계를 확인했습니다. <script>실행되지 않는 답안</script>';
     area.dispatchEvent(new window.Event('compositionstart',{bubbles:true}));area.dispatchEvent(new window.Event('input',{bubbles:true}));area.dispatchEvent(new window.Event('compositionend',{bubbles:true}));
     await until(async()=>{const saved=await getRun();return saved?.draft.values.text===area.value;},'IME draft persisted');
   }
   const count=run.submissions.length;submit(env.document,'step-form');
   await until(async()=>{const saved=await getRun();return saved?.submissions.length===count+1;},'next committed step');
 }
 const final=await getRun();assert.equal(final.status,'completed');assert.equal(final.submissions.length,16);
 await until(()=>env.document.querySelector('.completion-card'),'completion UI');
 assert.equal(env.document.querySelector('.ai-card'),null);
 env.document.querySelector('.completion-card [data-action=download]').click();
 await until(()=>env.blobs.length,'JSON download');
 const envelope=JSON.parse(await env.blobs.at(-1).text());assert.equal(validateEnvelope(envelope),true);assert.equal(envelope.run.status,'completed');assert.equal(envelope.run.mode,'pilot');assert.ok(envelope.events.length>20);assert.equal(envelope.run.responses[invite.order[0]].estimate.prediction,0);
 assert.match(env.downloads.at(-1).name,/\.json$/);assert.ok(!('scores' in envelope.run));
 const originalAppend=BrowserStore.prototype.appendEvents;
 t.after(()=>{BrowserStore.prototype.appendEvents=originalAppend;});
 BrowserStore.prototype.appendEvents=async()=>{throw Error('simulated log write failure');};
 env.document.querySelector('.completion-card [data-action=finish-home]').click();
 await until(()=>document.getElementById('storage-warning')?.textContent.includes('이동하지 않았습니다'),'home navigation blocked on pending log failure');
 assert.ok(document.querySelector('.completion-card'));
 const priorDownloads=env.blobs.length;document.querySelector('.completion-card [data-action=download]').click();
 await until(()=>env.blobs.length>priorDownloads,'recovery download');
 const recovery=JSON.parse(await env.blobs.at(-1).text());assert.equal(validateEnvelope(recovery),true);
 assert.ok(recovery.events.some(e=>e.type==='recorder_stopped'));assert.ok(recovery.events.some(e=>e.type==='export_warning'));
 BrowserStore.prototype.appendEvents=originalAppend;
 document.querySelector('.completion-card [data-action=finish-home]').click();
 await until(()=>document.querySelector('#start-form'),'safe home after storage recovery');
});
