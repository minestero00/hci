import test from 'node:test';
import assert from 'node:assert/strict';
import {domEnvironment, until} from './helpers/dom-env.mjs';
import {BrowserStore} from '../web/storage.mjs';
import {createRun, makeEnvelope, validateRun, validateEnvelope} from '../web/crt/core.mjs';

test('CRT resume releases lock after transient read error and exports memory when storage fails', async t => {
  const env = await domEnvironment(new URL('../web/index.html', import.meta.url));
  const originalGet = BrowserStore.prototype.getRun;
  const originalEvents = BrowserStore.prototype.eventsForRun;
  const originalAppend = BrowserStore.prototype.appendEvents;
  t.after(async () => {
    BrowserStore.prototype.getRun = originalGet;
    BrowserStore.prototype.eventsForRun = originalEvents;
    BrowserStore.prototype.appendEvents = originalAppend;
    await env.cleanup();
  });
  const held = new Set();
  Object.defineProperty(env.window.navigator, 'locks', {value:{async request(name, options, callback) {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({name}); } finally {held.delete(name);}
  }}});
  const store = await new BrowserStore({dbName:'hci-crt-v4', validate:validateRun, envelope:makeEnvelope}).init();
  const run = createRun();
  await store.saveRun(run);
  env.window.localStorage.setItem('hci-crt-v4-active', run.id);
  await store.close();
  await import('../web/crt/app.mjs?recovery');
  const d = env.document;
  await until(() => d.querySelector('[data-action="resume"]'));
  let fail = true;
  BrowserStore.prototype.getRun = async function(...args) {
    if(fail) {fail=false;throw Error('transient read');}
    return originalGet.apply(this,args);
  };
  d.querySelector('[data-action="resume"]').click();
  await until(() => d.getElementById('save-state').textContent.includes('transient read'));
  await until(() => held.size === 0);
  d.querySelector('[data-action="resume"]').click();
  await until(() => d.getElementById('step-form'));
  assert.equal(held.size,1);
  BrowserStore.prototype.eventsForRun = async () => {throw Error('event read unavailable');};
  BrowserStore.prototype.appendEvents = async () => {throw Error('event writes unavailable');};
  d.querySelector('[name="major"]').value = '복구할 전공 초안';
  d.querySelector('[data-action="download"]').click();
  await until(() => env.blobs.length);
  const recovery = JSON.parse(await env.blobs.at(-1).text());
  assert.equal(recovery.format,'hci-crt-recovery');
  assert.equal(recovery.incomplete,true);
  assert.throws(() => validateEnvelope(recovery));
  assert.equal(validateEnvelope(recovery.available),true);
  assert.equal(recovery.available.run.draft.values.major,'복구할 전공 초안');
  assert.ok(recovery.available.events.some(e=>e.type==='draft_revision'));
  assert.match(d.getElementById('error').textContent,/불완전 복구/);
});
