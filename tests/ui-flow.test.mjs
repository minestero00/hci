import test from 'node:test';
import assert from 'node:assert/strict';
import { domEnvironment,until,submit,choose } from './helpers/dom-env.mjs';
import { makeInvitations,stepInfo,validateEnvelope } from '../web/core.mjs';
import { BrowserStore } from '../web/storage.mjs';
import { ANSWER_KEY } from '../web/research-key.mjs';

for(const condition of ['assisted','control'])test(`participant ${condition} screens preserve disclosure boundaries and export a complete run`,async t=>{
 const invite=makeInvitations(4,'https://example.test/hci/index.html').find(i=>i.condition===condition);
 const env=await domEnvironment(new URL('../web/legacy-v3.html',import.meta.url),invite.url);t.after(()=>env.cleanup());
 await import(`../web/app.mjs?dom-flow-${condition}`);
 await until(()=>env.document.querySelector('#start-form'),'welcome');
 assert.equal(document.querySelector('a[href*=research]'),null);assert.match(document.querySelector('.welcome-lead').textContent,/가상 업무/);assert.ok(!document.getElementById('main').textContent.includes('명단, 인력, 준비 시간'));
 env.document.querySelector('input[name=consent]').checked=true;submit(env.document,'start-form');
 const store=await new BrowserStore().init();
 const getRun=async()=>{const id=localStorage.getItem('hci-workspace.activeRun');return id?store.getRun(id):null;};
 await until(async()=>{const run=await getRun();return run?.stage.phase==='practice'&&env.document.querySelector('#step-form');},'practice');
 choose(env.document,'practiceChoice','안내');env.document.querySelector('textarea[name=practiceMemo]').value='연습했습니다.';submit(env.document,'step-form');
 let iterations=0,midrunExported=false;
 while(iterations++<18){
   const run=await until(async()=>{const r=await getRun();return r&&r.stage.phase!=='practice'?r:null;},'run step');
   const info=stepInfo(run);if(info.phase==='done')break;
   await until(()=>env.document.querySelector('#step-form')&&!env.document.querySelector('#step-form button[type=submit]')?.disabled,'step UI');
   assert.equal(document.querySelector('a[href*=research]'),null);assert.ok(!document.getElementById('main').textContent.includes('분석에서 제외'));
   if(info.phase==='decision'){assert.equal(Boolean(env.document.querySelector('.ai-card')),condition==='assisted');choose(env.document,'choice',ANSWER_KEY[info.taskId].initial);}
   if(info.phase==='estimate'){assert.equal(Boolean(env.document.querySelector('.ai-card')),condition==='assisted');assert.match(document.querySelector('.prediction-hint').textContent,/처음 선택한 실행안은.*포함되지 않습니다/);assert.match(document.querySelector('.rating-section:last-of-type legend').textContent,/이번 업무/);choose(env.document,'burden',3);choose(env.document,'prediction',0);}
   if(info.phase==='update'){assert.equal(env.document.querySelector('.ai-card'),null);choose(env.document,'choice',ANSWER_KEY[info.taskId].updates[info.updateId]);}
   if(info.phase==='memo'){
     assert.equal(env.document.querySelector('.ai-card'),null);
     const area=env.document.querySelector('textarea[name=text]');area.value='조건의 관계를 확인했습니다. <script>실행되지 않는 답안</script>';
     area.dispatchEvent(new window.Event('compositionstart',{bubbles:true}));area.dispatchEvent(new window.Event('input',{bubbles:true}));area.dispatchEvent(new window.Event('compositionend',{bubbles:true}));
     await until(async()=>{const saved=await getRun();return saved?.draft.values.text===area.value;},'IME draft persisted');await until(()=>document.getElementById('save-status').textContent==='이 브라우저에 자동 저장','IME draft save status settled');
   }
   if(!midrunExported&&info.phase==='estimate'){document.querySelector('button[data-action=download]').click();await until(()=>env.blobs.length===1,'intermediate export');await until(()=>!document.querySelector('#step-form button[type=submit]').disabled,'export settled');midrunExported=true;}
   const count=run.submissions.length;submit(env.document,'step-form');
   await until(async()=>{const saved=await getRun();return saved?.submissions.length===count+1;},'next committed step');
 }
 const final=await getRun();assert.equal(final.status,'completed');assert.equal(final.submissions.length,16);
 await until(()=>env.document.querySelector('.completion-card'),'completion UI');
 assert.equal(env.document.querySelector('.ai-card'),null);
 assert.ok(!document.getElementById('download-status').textContent.includes('다운로드를 요청했습니다'));assert.equal(document.querySelector('.completion-card').textContent.includes('별도로 채점'),false);
 const beforeFinalExport=env.blobs.length;env.document.querySelector('.completion-card [data-action=download]').click();
 await until(()=>env.blobs.length>beforeFinalExport,'JSON download');
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
