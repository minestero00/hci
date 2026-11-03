import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { BrowserStore } from '../web/storage.mjs';
import { Recorder } from '../web/recorder.mjs';
import { createRun, submitStep, validateEnvelope } from '../web/core.mjs';

const clone=value=>structuredClone(value);
const makeRun=()=>createRun({participantCode:'IDB-P001',condition:'control',mode:'pilot'});
function advance(run) {return submitStep(run,{complete:true},new Date(new Date(run.updatedAt).getTime()+1).toISOString());}
function event(run,id='event-1',sequence=1) {return {id,runId:run.id,pageId:'page-1',sequence,at:run.startedAt,monotonicMs:10*sequence,phase:'practice',taskId:null,updateId:null,type:'sample',data:{count:1}};}
async function setup() {
  Object.defineProperty(globalThis,'indexedDB',{value:new IDBFactory(),writable:true,configurable:true});
  const store=await new BrowserStore().init();
  assert.equal(store.mode,'indexeddb');
  return store;
}

test('IndexedDB snapshots survive close/reopen and are isolated from caller mutation',async()=> {
  const store=await setup(), run=makeRun();
  await store.saveRun(run);
  const next=advance(run);
  next.draft={key:'decision:event:',values:{choice:'unknown'}};
  const saving=store.saveRun(next);
  next.draft.values.choice='changed-after-call';
  await saving;
  const persisted=await store.getRun(run.id);
  assert.equal(persisted.stage.phase,'decision');
  assert.equal(persisted.draft.values.choice,'unknown');
  await store.close();
  const reopened=await new BrowserStore().init();
  assert.equal(reopened.mode,'indexeddb');
  assert.deepEqual(await reopened.getRun(run.id),persisted);
  await reopened.close();
});

test('IndexedDB append is idempotent, conflicts abort the whole batch, and retries remain usable',async()=> {
  const store=await setup(),run=makeRun();
  await store.saveRun(run);
  const first=event(run);
  await store.appendEvents([first,clone(first)]);
  await store.appendEvents([clone(first)]);
  assert.equal((await store.eventsForRun(run.id)).length,1);
  const conflict=clone(first);conflict.data.count=2;
  const newEvent=event(run,'event-2',2);
  await assert.rejects(store.appendEvents([newEvent,conflict]),/원본/);
  assert.deepEqual((await store.eventsForRun(run.id)).map(row=>row.id),['event-1']);
  await store.appendEvents([newEvent]);
  const exported=await store.exportRun(run.id);
  assert.equal(exported.events.length,2);
  assert.equal(validateEnvelope(exported),true);
  await store.close();
});

test('IndexedDB rejects old history or identity changes without losing the latest record',async()=> {
  const store=await setup(),run=makeRun(),next=advance(run);
  await store.saveRun(run);
  await store.saveRun(next);
  await assert.rejects(store.saveRun(run),/이전 상태|다른 답안/);
  const changed=clone(next);changed.condition='assisted';
  await assert.rejects(store.saveRun(changed),/배정|참가 정보/);
  assert.deepEqual(await store.getRun(run.id),next);
  const fresh=makeRun();await store.saveRun(fresh);
  assert.equal((await store.getRun(fresh.id)).participantCode,'IDB-P001');
  await store.close();
});

test('an aborted IndexedDB event write keeps recorder events pending until a successful retry',async()=> {
  const store=await setup(),run=makeRun();
  await store.saveRun(run);
  const transaction=store._db.transaction.bind(store._db);
  let abortNext=true;
  store._db.transaction=(...args)=> {
    const tx=transaction(...args);
    if (abortNext && args[0]==='events' && args[1]==='readwrite') {
      abortNext=false;
      queueMicrotask(()=>tx.abort());
    }
    return tx;
  };
  const statuses=[],recorder=new Recorder({store,onStatus:status=>statuses.push(status)});
  recorder.start(run);recorder.record('meaningful_action',{choice:'unknown'});
  const expected=recorder.pendingEvents().map(row=>row.id);
  await assert.rejects(recorder.flush(),/저장/);
  assert.ok(recorder.pendingCount>=expected.length);
  assert.equal((await store.eventsForRun(run.id)).length,0);
  assert.ok(statuses.some(status=>status.state==='error'));
  await recorder.flush();
  const saved=await store.eventsForRun(run.id);
  assert.ok(expected.every(id=>saved.some(row=>row.id===id)));
  assert.equal(saved.filter(row=>row.type==='meaningful_action').length,1);
  assert.equal(recorder.pendingCount,0);
  assert.ok(saved.some(row=>row.type==='storage_failure'));
  assert.ok(saved.some(row=>row.type==='storage_recovered'));
  await recorder.stop();await store.close();
});
