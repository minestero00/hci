import test from 'node:test';
import assert from 'node:assert/strict';
import { domEnvironment,until,submit,choose } from './helpers/dom-env.mjs';
import { createRun,submitStep,stepInfo,makeEnvelope } from '../web/core.mjs';
import { ANSWER_KEY } from '../web/research-key.mjs';
import { TASKS } from '../web/content.mjs';
import { ResearchStore } from '../web/research-store.mjs';
function fixture(){
 let run=createRun({participantCode:'UI_TEST',mode:'pilot',condition:'control',invitationId:'research-test-invite'});
 while(run.stage.phase!=='done'){
  const i=stepInfo(run);let v;
  if(i.phase==='practice')v={complete:true};if(i.phase==='decision')v={choice:ANSWER_KEY[i.taskId].initial};if(i.phase==='estimate')v={burden:3,prediction:0};if(i.phase==='update')v={choice:ANSWER_KEY[i.taskId].updates[i.updateId]};if(i.phase==='memo')v={text:`${i.taskId}의 관계를 설명합니다. <img src=x onerror=alert(1)>`};run=submitStep(run,v);
 }
 return makeEnvelope(run,[]);
}
function upload(env,id,value,name='record.json'){
 const raw=JSON.stringify(value),input=env.document.getElementById(id);
 Object.defineProperty(input,'files',{configurable:true,value:[{name,size:Buffer.byteLength(raw),text:async()=>raw}]});
 input.dispatchEvent(new window.Event('change',{bubbles:true}));
}
const settled=()=>until(()=>document.getElementById('research-save')?.textContent==='이 브라우저에 저장됨','research save');
test('research DOM imports records, grades independently, merges packets and exports eligible CSV',async t=>{
 const env=await domEnvironment(new URL('../web/research.html',import.meta.url),'https://example.test/hci/research.html');t.after(()=>env.cleanup());
 await import('../web/research.mjs?dom-research');
 document.querySelector('[data-view=grade]').click();assert.equal(document.getElementById('new-packet').disabled,true);assert.match(document.getElementById('research-view').textContent,/채점할 메모가 없습니다/);document.querySelector('[data-view=collect]').click();
 const original=fixture();upload(env,'research-files',original);
 await until(()=>document.querySelector('.r-table')?.textContent.includes('UI_TEST'),'imported record');
 upload(env,'research-files',original,'same-record.json');await until(()=>document.getElementById('research-message').textContent.includes('중복 1'),'dedup');
 document.querySelector('[data-view=invite]').click();document.getElementById('invite-count').value='4';submit(document,'invite-form');
 await until(()=>document.querySelectorAll('.copy-invite').length===4,'invitation batch');
 assert.match(document.getElementById('research-view').textContent,/생성한 참여 링크/);assert.match(document.getElementById('research-view').textContent,/링크 목록 JSON은 전달용/);document.getElementById('invite-json').click();assert.match(document.getElementById('research-download-status').textContent,/다운로드를 요청했습니다/);
 const links=[...document.querySelectorAll('.r-table a')].map(a=>a.href);assert.equal(links.length,4);assert.ok(links.every(link=>link.startsWith('https://example.test/hci/index.html#invite=')));
 document.querySelector('[data-view=grade]').click();document.getElementById('new-packet').click();
 await until(()=>document.getElementById('grade-form'),'blind deck');
 assert.equal(document.querySelector('.r-answer img'),null);assert.ok(document.querySelector('.r-answer').textContent.includes('<img'));
 for(const role of ['rater1','rater2','consensus']){
  const select=document.getElementById('grade-role');select.value=role;select.dispatchEvent(new window.Event('change',{bubbles:true}));await settled();if(role==='consensus')assert.match(document.querySelector('#research-view h1').textContent,/두 독립 채점/);
  for(let index=0;index<3;index++){
   if(role!=='rater1')while(!document.getElementById('grade-prev').disabled){document.getElementById('grade-prev').click();}
   if(role!=='rater1')for(let previous=0;previous<index;previous++)document.getElementById('grade-next').click();
   choose(document,'score',0);document.getElementById('grade-reason').value='유효한 설명이 없습니다.';submit(document,'grade-form');await settled();
   if(role==='rater1'&&index<2)document.getElementById('grade-next').click();
  }
 }
 document.getElementById('grade-export').click();let latest=JSON.parse(await env.blobs.at(-1).text());assert.equal(latest.role,'consensus');assert.equal(latest.ratings.length,3);assert.ok(latest.ratings.every(r=>r.score===0));
 document.querySelector('[data-view=export]').click();document.querySelector('[data-export=participants]').click();
 const csv=await env.blobs.at(-1).text();assert.match(csv,/primary_eligible/);assert.match(csv,/UI_TEST/);assert.match(csv,/mean_gap/);assert.match(csv,/"-2"/);
 document.getElementById('blind-export').click();latest=JSON.parse(await env.blobs.at(-1).text());assert.equal(latest.items.length,3);assert.equal(JSON.stringify(latest).includes('UI_TEST'),false);
 document.getElementById('archive-download').click();const backup=JSON.parse(await env.blobs.at(-1).text());assert.equal(backup.envelopes.length,1);assert.equal(backup.invitations.length,4);assert.ok(backup.packet);assert.equal(Object.keys(backup.ratings).length,TASKS.length);
 document.querySelector('[data-view=collect]').click();upload(env,'research-files',backup,'archive.json');await until(()=>document.getElementById('research-message').textContent.includes('보관 자료'),'archive restore');assert.ok(!document.getElementById('research-message').textContent.includes('형식이 올바르지'));
 const conflicting=structuredClone(backup),id=Object.keys(conflicting.ratings)[0];conflicting.ratings[id].consensus.score=1;
 conflicting.gradeHistory.push({responseId:id,role:'consensus',previous:{score:0,reason:'이전 근거'},at:new Date(Date.now()+1000).toISOString()});
 upload(env,'research-files',conflicting,'conflict-archive.json');await until(()=>document.getElementById('research-message').textContent.includes('채점 충돌 1건'),'grading conflict');
 document.getElementById('archive-download').click();const restored=JSON.parse(await env.blobs.at(-1).text());assert.equal(restored.ratings[id].consensus.score,0);assert.equal(restored.gradeHistory.length,backup.gradeHistory.length+1);
 upload(env,'research-files',conflicting,'conflict-again.json');await until(()=>document.getElementById('research-message').textContent.includes('conflict-again.json'),'repeat archive');document.getElementById('archive-download').click();assert.equal(JSON.parse(await env.blobs.at(-1).text()).gradeHistory.length,restored.gradeHistory.length);
});

test('research workflow filters records, explores bounded telemetry and advances independent grading accessibly',async t=>{
 const env=await domEnvironment(new URL('../web/research.html',import.meta.url),'https://example.test/hci/research.html');t.after(()=>env.cleanup());
 await import('../web/research.mjs?behavior-research');
 const original=fixture(),pageId=crypto.randomUUID(),taskId=original.run.assignment.order[0];
 const row=(type,data,sequence)=>({id:crypto.randomUUID(),runId:original.run.id,pageId,sequence,at:new Date(Date.parse(original.run.startedAt)+sequence*100).toISOString(),monotonicMs:sequence*100,phase:'decision',taskId,updateId:null,type,data:{telemetryVersion:2,...data}});
 original.events=Array.from({length:65},(_,index)=>row('click',{target:'choice',region:'response'},index+1));
 original.events.push(row('engagement_segment',{durationMs:10000,foregroundMs:9000,activeMs:7000,idleMs:2000,hiddenMs:1000,blurredMs:0},66));
 original.events.push(row('source_exposure_end',{sourceId:'source-test',durationMs:3000,ratio:1},67));
 upload(env,'research-files',original);await until(()=>document.querySelector('.inspect-run'),'record import');
 const search=document.getElementById('collection-search');search.focus();search.value='missing';search.dispatchEvent(new window.Event('input',{bubbles:true}));assert.equal(document.querySelector('.inspect-run'),null);assert.match(document.getElementById('collection-count').textContent,/0 \/ 1/);assert.equal(document.activeElement,search);
 search.value='UI_TEST';search.dispatchEvent(new window.Event('input',{bubbles:true}));document.querySelector('.inspect-run').click();
 assert.match(document.getElementById('record-detail').textContent,/UI_TEST의 행동 기록/);assert.match(document.getElementById('record-detail').textContent,/10\.0초/);assert.match(document.getElementById('record-detail').textContent,/읽기, 주의 집중, 이해를 의미하지 않습니다/);
 assert.match(document.getElementById('timeline-list').textContent,/1–60개/);document.getElementById('timeline-next').click();assert.match(document.getElementById('timeline-list').textContent,/61–67개/);
 const type=document.getElementById('timeline-type');type.value='engagement_segment';type.dispatchEvent(new window.Event('change',{bubbles:true}));assert.match(document.getElementById('timeline-list').textContent,/1개 중 1–1개/);assert.equal(document.getElementById('timeline-next').disabled,true);
 document.getElementById('behavior-download').click();const summary=JSON.parse(await env.blobs.at(-1).text());assert.equal(summary.summary.totals.durationMs,10000);assert.equal(summary.summary.sources[0].sourceId,'source-test');
 document.getElementById('record-download').click();assert.deepEqual(JSON.parse(await env.blobs.at(-1).text()),original);
 document.getElementById('close-record').click();assert.equal(document.getElementById('record-detail').textContent,'');assert.equal(document.querySelector('.inspect-run').getAttribute('aria-expanded'),'false');
 document.querySelector('[data-view=export]').click();
 document.querySelector('[data-behavior-export=runs]').click();let csv=await env.blobs.at(-1).text();assert.match(csv,/event_count/);assert.match(csv,/foreground_ms/);assert.match(csv,/has_segments/);assert.match(csv,/UI_TEST/);assert.match(csv,/"10000"/);
 document.querySelector('[data-behavior-export=stages]').click();csv=await env.blobs.at(-1).text();assert.match(csv,/task_id/);assert.match(csv,/choice_changes/);
 document.querySelector('[data-behavior-export=sources]').click();csv=await env.blobs.at(-1).text();assert.match(csv,/exposure_ms/);assert.match(csv,/source-test/);
 document.querySelector('[data-view=collect]').click();
 const tab=document.querySelector('[data-view=collect]');tab.dispatchEvent(new window.KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}));assert.equal(document.querySelector('[data-view=invite]').getAttribute('aria-selected'),'true');assert.equal(document.activeElement.dataset.view,'invite');
 document.querySelector('[data-view=grade]').click();document.getElementById('new-packet').click();await until(()=>document.getElementById('grade-form'),'grading');
 choose(document,'score',2);document.getElementById('grade-reason').value='아직 저장하지 않은 근거';globalThis.confirm=()=>false;upload(env,'grading-files',original,'while-dirty.json');assert.equal(document.getElementById('grade-reason').value,'아직 저장하지 않은 근거');assert.equal(document.querySelector('input[name=score]:checked').value,'2');globalThis.confirm=()=>true;
 const answer=document.querySelector('.r-answer').textContent;choose(document,'score',1);document.getElementById('grade-reason').value='첫 번째 관계 설명';
 const form=document.getElementById('grade-form'),event=new window.Event('submit',{bubbles:true,cancelable:true});Object.defineProperty(event,'submitter',{value:form.querySelector('[value=save-next]')});form.dispatchEvent(event);
 await settled();await until(()=>document.querySelector('.r-grade-progress').textContent.includes('1 / 3'),'grade advanced');assert.notEqual(document.querySelector('.r-answer').textContent,answer);assert.equal(document.querySelector('input[name=score]:checked'),null);
 document.getElementById('grade-prev').click();assert.equal(document.querySelector('input[name=score]:checked').value,'1');document.getElementById('grade-unrated').click();assert.equal(document.querySelector('input[name=score]:checked'),null);
 assert.equal(document.getElementById('record-detail'),null);assert.equal(document.querySelector('.r-grade-progress').textContent.includes('UI_TEST'),false);
});


test('invitation creation preserves actionable storage failure and downloadable recovery',async t=>{
 const env=await domEnvironment(new URL('../web/research.html',import.meta.url),'https://example.test/hci/research.html');t.after(()=>env.cleanup());
 const originalSave=ResearchStore.prototype.save;t.after(()=>{ResearchStore.prototype.save=originalSave;});
 await import('../web/research.mjs?failed-research-save');
 ResearchStore.prototype.save=async()=>{throw Error('저장 실패 주입');};
 document.querySelector('[data-view=invite]').click();document.getElementById('invite-count').value='4';submit(document,'invite-form');
 await until(()=>document.getElementById('research-message').textContent.includes('만들었지만 자동 저장에 실패'),'visible storage failure');
 assert.equal(document.getElementById('research-message').getAttribute('role'),'alert');assert.match(document.getElementById('research-save').textContent,/저장 실패/);
 document.getElementById('invite-json').click();assert.equal(JSON.parse(await env.blobs.at(-1).text()).invitations.length,4);assert.equal(document.querySelector('#invite-form button[type=submit]').disabled,false);
});
