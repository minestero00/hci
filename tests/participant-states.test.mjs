import test from 'node:test';
import assert from 'node:assert/strict';
import { domEnvironment, until, submit } from './helpers/dom-env.mjs';
import { BrowserStore } from '../web/storage.mjs';

test('invalid invitation presents recovery and never offers accidental demo participation',async t=>{
 const env=await domEnvironment(new URL('../web/legacy-v3.html',import.meta.url),'https://example.test/hci/#invite=broken');t.after(()=>env.cleanup());
 await import('../web/app.mjs?invalid-invite-content');
 await until(()=>document.querySelector('.blocked-wrap'),'invalid link screen');
 assert.match(document.getElementById('main').textContent,/참여 링크를 확인/);
 assert.equal(document.getElementById('start-form'),null);assert.equal(document.querySelector('[data-action=start-session]'),null);
 assert.equal(document.getElementById('main').textContent.includes('팀 자유 체험'),false);assert.equal(document.querySelector('a[href*=research]'),null);
});

test('temporary storage copy stays truthful in consent, narrow mode, privacy and pause/resume',async t=>{
 const env=await domEnvironment(new URL('../web/legacy-v3.html',import.meta.url));t.after(()=>env.cleanup());
 const original=BrowserStore.prototype.init;BrowserStore.prototype.init=async function(){this.mode='memory';return this;};t.after(()=>{BrowserStore.prototype.init=original;});
 await import('../web/app.mjs?temporary-storage-content');await until(()=>document.getElementById('start-form'),'temporary storage welcome');
 assert.match(document.querySelector('.intro-tags').textContent,/현재 탭에 임시 보관/);
 assert.match(document.querySelector('.site-footer').textContent,/창을 닫기 전에/);
 document.querySelector('[data-action=privacy]').click();await until(()=>document.querySelector('#session-dialog[open]'),'privacy');
 assert.match(document.getElementById('session-dialog').textContent,/현재 탭에 임시 보관/);assert.match(document.getElementById('session-dialog').textContent,/새로고침/);
 document.querySelector('[data-dialog-result=confirm]').click();document.querySelector('[name=participantCode]').value='MEM01';document.querySelector('[name=consent]').checked=true;submit(document,'start-form');
 await until(()=>document.getElementById('step-form')&&!document.querySelector('#step-form button[type=submit]').disabled,'practice');
 Object.defineProperty(window,'innerWidth',{value:800,configurable:true,writable:true});
 assert.equal(document.getElementById('mobile-storage-warning').hidden,false);assert.match(document.getElementById('mobile-storage-warning').textContent,/자동 저장을 사용할 수 없습니다/);
 assert.ok(document.querySelector('.mobile-gate [data-action=download]'));window.innerWidth=1440;
 document.querySelector('button[data-action=home]').click();await until(()=>document.querySelector('#session-dialog[open]'),'pause');
 assert.match(document.getElementById('session-dialog').textContent,/현재 기록은 이 탭에만/);assert.equal(document.querySelector('[data-dialog-result=confirm]').textContent,'시작 화면으로');
 document.querySelector('[data-dialog-result=confirm]').click();await until(()=>document.getElementById('start-form'),'same-tab home');assert.match(document.querySelector('.resume-card').textContent,/현재 탭의 기록/);
});
