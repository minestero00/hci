import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudSync,eventGroups,eventHash } from '../web/cloud-sync.mjs';
import { createRun,submitStep,stepInfo } from '../web/core.mjs';
function completed(){let run=createRun({participantCode:'CLOUD_TEST',condition:'control'});while(run.status!=='completed'){const info=stepInfo(run);run=submitStep(run,info.phase==='practice'?{complete:true}:info.phase==='estimate'?{burden:2,prediction:1}:info.phase==='memo'?{unknown:true}:{choice:'unknown'});}return run;}
function fixture(run=completed()){
 const docs=new Map(),memory=new Map(),writes=[],states=[],events=Array.from({length:205},(_,i)=>({id:`event-${i}`,runId:run.id,at:new Date(100000+i).toISOString(),data:{label:'한글 표본'}}));
 const adapter={uid:'owner',async put(path,data){if(path.includes('/chunks/'))assert.ok(docs.has(`runs/${run.id}`),'parent must exist first');writes.push(path);docs.set(path,structuredClone(data));},async get(path){return docs.get(path)||null;}};
 const storage={getItem:key=>memory.get(key)||null,setItem:(key,value)=>memory.set(key,value)};
 const sync=new CloudSync({store:{eventsForRun:async()=>events},adapterFactory:async()=>adapter,storage,onStatus:value=>states.push(value)}).start(run);
 return{run,docs,memory,writes,states,events,adapter,storage,sync};
}
test('cloud upload claims parent first, chunks bounded payloads and verifies exact receipt from server',async t=>{
 const f=fixture();t.after(()=>f.sync.stop());await f.sync.sync();assert.equal(f.writes.length,0,'periodic sync cannot finalize before recorder flush');const receipt=await f.sync.sync({final:true});
 assert.equal(f.writes[0],`runs/${f.run.id}`);assert.equal(receipt.eventCount,205);assert.equal(receipt.chunkIds.length,3);assert.equal(receipt.eventIdsHash,await eventHash(f.events.map(e=>e.id)));assert.equal(f.states.at(-1).state,'complete');
 for(const id of receipt.chunkIds)assert.ok(f.docs.has(`runs/${f.run.id}/chunks/${id}`));
 const count=f.writes.length;await f.sync.sync({final:true});assert.equal(f.writes.length,count,'unchanged snapshot produces no additional writes');
});
test('failed chunk remains unacknowledged and retry after reload retains all events without duplicates',async t=>{
 const f=fixture();t.after(()=>f.sync.stop());const put=f.adapter.put;let fail=true;
 f.adapter.put=async(path,data)=>{if(fail&&path.includes('/chunks/')){fail=false;throw Error('offline');}return put(path,data);};
 await assert.rejects(f.sync.sync({final:true}),/offline/);assert.equal(f.states.at(-1).state,'error');assert.equal(f.docs.has(`runs/${f.run.id}/receipts/final`),false);assert.equal(f.events.length,205);
 f.sync.stop();const retry=new CloudSync({store:{eventsForRun:async()=>f.events},adapterFactory:async()=>f.adapter,storage:f.storage}).start(f.run);t.after(()=>retry.stop());const receipt=await retry.sync({final:true});assert.equal(receipt.eventCount,205);assert.equal(receipt.chunkIds.length,3);
});
test('locally acknowledged but missing remote chunk cannot produce confirmed completion',async t=>{
 const f=fixture();t.after(()=>f.sync.stop());await f.sync.sync({final:true});const id=JSON.parse(f.docs.get(`runs/${f.run.id}/receipts/final`).payload).chunkIds[0];f.docs.delete(`runs/${f.run.id}/chunks/${id}`);
 f.sync.stop();const retry=new CloudSync({store:{eventsForRun:async()=>f.events},adapterFactory:async()=>f.adapter,storage:f.storage}).start(f.run);t.after(()=>retry.stop());await assert.rejects(retry.sync({final:true}),/서버 행동/);assert.notEqual(retry.state.state,'complete');await retry.sync({final:true});assert.equal(retry.state.state,'complete');
});
test('server readback mismatch and foreign events never announce completion',async t=>{
 const f=fixture();t.after(()=>f.sync.stop());f.adapter.get=async()=>null;await assert.rejects(f.sync.sync({final:true}));assert.equal(f.states.at(-1).state,'error');
 f.events[0].runId='foreign';await assert.rejects(f.sync.sync({final:true}),/다른 실행/);assert.equal(f.states.at(-1).state,'error');
});
test('chunk splitter bounds UTF8 size as well as event count',()=>{
 const groups=eventGroups(Array.from({length:5},(_,i)=>({id:i,text:'한'.repeat(25000)})));assert.equal(groups.length,3);for(const group of groups)assert.ok(new TextEncoder().encode(JSON.stringify(group)).length<=180000);
 assert.throws(()=>eventGroups([{text:'한'.repeat(70000)}]),/제한/);
});
