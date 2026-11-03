import test from 'node:test';
import assert from 'node:assert/strict';
import { domEnvironment,until,submit,choose } from './helpers/dom-env.mjs';
import { createRun,submitStep,stepInfo,makeEnvelope } from '../web/core.mjs';
import { ANSWER_KEY } from '../web/research-key.mjs';
import { TASKS } from '../web/content.mjs';
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
 const original=fixture();upload(env,'research-files',original);
 await until(()=>document.querySelector('.r-table')?.textContent.includes('UI_TEST'),'imported record');
 upload(env,'research-files',original,'same-record.json');await until(()=>document.getElementById('research-message').textContent.includes('중복 1'),'dedup');
 document.querySelector('[data-view=invite]').click();document.getElementById('invite-count').value='4';submit(document,'invite-form');
 await until(()=>document.querySelectorAll('.copy-invite').length===4,'invitation batch');
 const links=[...document.querySelectorAll('.r-table a')].map(a=>a.href);assert.equal(links.length,4);assert.ok(links.every(link=>link.startsWith('https://example.test/hci/index.html#invite=')));
 document.querySelector('[data-view=grade]').click();document.getElementById('new-packet').click();
 await until(()=>document.getElementById('grade-form'),'blind deck');
 assert.equal(document.querySelector('.r-answer img'),null);assert.ok(document.querySelector('.r-answer').textContent.includes('<img'));
 for(const role of ['rater1','rater2','consensus']){
  const select=document.getElementById('grade-role');select.value=role;select.dispatchEvent(new window.Event('change',{bubbles:true}));await settled();
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
});
