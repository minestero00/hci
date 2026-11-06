import test from 'node:test';
import assert from 'node:assert/strict';
import { domEnvironment,until } from './helpers/dom-env.mjs';
import { BrowserStore } from '../web/storage.mjs';
import { createRun } from '../web/core.mjs';

test('a legacy local run requires explicit cloud consent and cancellation sends nothing',async t=>{
 const env=await domEnvironment(new URL('../web/index.html',import.meta.url),'https://minestero00.github.io/hci/');t.after(()=>env.cleanup());
 const store=await new BrowserStore().init(),run=createRun({participantCode:'LEGACY01',condition:'control'});await store.saveRun(run);localStorage.setItem('hci-workspace.activeRun',run.id);
 await import('../web/app.mjs?legacy-cloud-consent');await until(()=>document.querySelector('[data-action=resume]'),'legacy resume');
 document.querySelector('[data-action=resume]').click();await until(()=>document.querySelector('#session-dialog[open]'),'cloud consent');
 assert.match(document.getElementById('session-dialog').textContent,/기존 응답·수정 이력·행동 로그/);document.querySelector('[data-dialog-result=cancel]').click();await until(()=>document.getElementById('form-error')?.textContent.includes('동의하지 않았습니다'),'cancel kept local');
 assert.ok(document.getElementById('start-form'));assert.ok(document.querySelector('[data-action=download-saved]'));assert.equal(document.querySelector('[data-cloud-status]'),null);
});
