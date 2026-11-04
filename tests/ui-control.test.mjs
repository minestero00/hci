import test from 'node:test';
import assert from 'node:assert/strict';
import { domEnvironment,until,submit,choose } from './helpers/dom-env.mjs';
import { makeInvitations } from '../web/core.mjs';
import { BrowserStore } from '../web/storage.mjs';

test('control UI blocks narrow participation, hides AI, and accepts explicit unknown memo',async t=>{
 const invite=makeInvitations(4,'https://example.test/hci/index.html').find(i=>i.condition==='control');
 const env=await domEnvironment(new URL('../web/index.html',import.meta.url),invite.url);t.after(()=>env.cleanup());await import('../web/app.mjs?control-flow');
 await until(()=>document.getElementById('start-form'),'welcome');
 document.querySelector('input[name=consent]').checked=true;
 Object.defineProperty(window,'innerWidth',{value:800,writable:true,configurable:true});submit(document,'start-form');assert.match(document.getElementById('form-error').textContent,/PC/);assert.equal(localStorage.getItem('hci-workspace.activeRun'),null);
 window.innerWidth=1440;submit(document,'start-form');const store=await new BrowserStore().init();
 const getRun=async()=>{const id=localStorage.getItem('hci-workspace.activeRun');return id?store.getRun(id):null;};
 await until(()=>document.querySelector('input[name=practiceChoice]'),'practice');choose(document,'practiceChoice','안내');document.querySelector('textarea[name=practiceMemo]').value='연습';submit(document,'step-form');
 await until(async()=>(await getRun())?.stage.phase==='decision','decision');await until(()=>document.querySelector('input[name=choice]'),'choices');assert.equal(document.querySelector('.ai-card'),null);
 const first=invite.order[0];choose(document,'choice','unknown');submit(document,'step-form');await until(async()=>(await getRun())?.stage.phase==='estimate','estimate');await until(()=>document.querySelector('input[name=prediction]'),'prediction radios');choose(document,'burden',1);choose(document,'prediction',3.5);submit(document,'step-form');
 for(let i=0;i<2;i++){await until(async()=>{const r=await getRun();return r?.stage.phase==='update'&&r.stage.updateIndex===i;},'update');await until(()=>document.querySelector('input[name=choice]')&&!document.querySelector('#step-form button[type=submit]')?.disabled&&document.querySelector('.update-callout .eyebrow')?.textContent.includes(`새 요청 ${i+1}`),'update options settled');assert.equal(document.querySelector('.ai-card'),null);choose(document,'choice','unknown');submit(document,'step-form');}
 await until(async()=>(await getRun())?.stage.phase==='memo','memo');await until(()=>document.querySelector('input[name=unknown]'),'unknown memo');
 const checkbox=document.querySelector('input[name=unknown]');checkbox.checked=true;checkbox.dispatchEvent(new window.Event('change',{bubbles:true}));assert.equal(document.querySelector('textarea[name=text]').disabled,true);submit(document,'step-form');
 await until(async()=>(await getRun())?.responses[first].memo?.unknown===true,'unknown stored');const saved=await getRun();assert.equal(saved.responses[first].memo.text,'');assert.equal(saved.responses[first].estimate.prediction,3.5);
 await until(()=>document.querySelector('#step-form button[type=submit]')?.textContent.includes('실행안')&&!document.querySelector('#step-form button[type=submit]').disabled,'next workspace settled');
 document.querySelector('[data-action=home]').click();await until(()=>document.getElementById('session-dialog'),'pause dialog');document.querySelector('[data-dialog-result=confirm]').click();await until(()=>document.getElementById('start-form'),'safe pause');
});
