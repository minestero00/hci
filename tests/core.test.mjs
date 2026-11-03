import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDY, TASKS } from '../web/content.mjs';
import { ANSWER_KEY } from '../web/research-key.mjs';
import {createRun, stepInfo, submitStep, validateRun, makeEnvelope, validateEnvelope, mergeEnvelopes, analyseRun, toCSV, makeInvitations, parseInvitation} from '../web/core.mjs';
import { BrowserStore } from '../web/storage.mjs';
import { Recorder } from '../web/recorder.mjs';

const clone=value=>structuredClone(value);
const makeRun=()=>createRun({participantCode:'P001',condition:'assisted',mode:'pilot',order:TASKS.map(task=>task.id),updateOrders:Object.fromEntries(TASKS.map(task=>[task.id,task.updates.map(update=>update.id)]))});
function advance(run, values) {return submitStep(run,values,new Date(new Date(run.updatedAt).getTime()+1).toISOString());}
function finish(run=makeRun(),{unknown=false}={}) {
  while (run.stage.phase!=='done') {
    const info=stepInfo(run),task=TASKS.find(task=>task.id===info.taskId);
    let values;
    if (info.phase==='practice') values={complete:true};
    if (info.phase==='decision') values={choice:ANSWER_KEY[task.id].initial};
    if (info.phase==='estimate') values={burden:3,prediction:3.5};
    if (info.phase==='update') values={choice:unknown?'unknown':ANSWER_KEY[task.id].updates[info.updateId]};
    if (info.phase==='memo') values=unknown?{unknown:true}:{text:'관계에 근거한 인계 메모'};
    run=advance(run,values);
  }
  return run;
}
function event(run,id='event-1') {return {id,runId:run.id,pageId:'page-1',sequence:1,at:run.startedAt,monotonicMs:10,phase:'practice',taskId:null,updateId:null,type:'test',data:{count:1}};}

test('all stages submit once, predictions lock, and original state is unchanged',()=> {
  const original=makeRun(), snapshot=clone(original);
  let run=advance(original,{complete:true});
  assert.deepEqual(original,snapshot);
  assert.equal(stepInfo(run).phase,'decision');
  run=advance(run,{choice:ANSWER_KEY.event.initial});
  assert.equal(stepInfo(run).phase,'estimate');
  assert.throws(()=>advance(run,{choice:'unknown'}));
  assert.throws(()=>advance(run,{burden:3,prediction:1.2}));
  assert.throws(()=>advance(run,{burden:0,prediction:4}));
  run=advance(run,{burden:3,prediction:0});
  assert.equal(run.responses.event.estimate.prediction,0);
  assert.equal(stepInfo(run).phase,'update');
  assert.throws(()=>advance(run,{burden:1,prediction:4}));
  const done=finish(run);
  assert.equal(done.status,'completed');
  assert.equal(done.submissions.length,16);
  assert.equal(stepInfo(done).progress,1);
  assert.equal(stepInfo(done).step,16);
  assert.ok(done.finishedAt);
  assert.throws(()=>advance(done,{complete:true}),/완료/);
});

test('imports reject invented stage, changed responses and invalid IDs',()=> {
  const run=finish();
  for (const mutate of [
    data=>{data.stage={phase:'decision',taskIndex:0,updateIndex:0};},
    data=>{data.responses.event.estimate.prediction=2;},
    data=>{data.assignment.order=['event','event','submission'];},
    data=>{data.assignment.updateOrders.event=['not-an-update','roster'];},
    data=>{data.studyVersion='old-version';},
    data=>{data.submissions[1].at='not-a-time';},
    data=>{data.submissions[1].id=data.submissions[0].id;},
    data=>{data.responses.event.memo.text='different to its submission';}
  ]) {
    const bad=clone(run);mutate(bad);assert.throws(()=>validateRun(bad));
  }
  const blank=makeRun();
  assert.throws(()=>advance(blank,{complete:true,extra:'unknown'}));
});

test('memo accepts explicit unknown, rejects blank or oversized strings',()=> {
  let run=makeRun();
  run=advance(run,{complete:true});
  run=advance(run,{choice:'unknown'});
  run=advance(run,{burden:7,prediction:4});
  run=advance(run,{choice:'unknown'});
  run=advance(run,{choice:'unknown'});
  assert.equal(run.stage.phase,'memo');
  assert.throws(()=>advance(run,{text:'   '}));
  assert.throws(()=>advance(run,{text:'x'.repeat(2001)}));
  assert.throws(()=>advance(run,{unknown:true,text:'some answer'}));
  const result=advance(run,{unknown:true});
  assert.deepEqual(result.responses.event.memo,{text:'',unknown:true,at:result.updatedAt});
});

test('human, AI, mixed grades and case-wise absolute errors stay separate',()=> {
  const run=finish();
  const none=analyseRun(run,ANSWER_KEY);
  assert.equal(none.summary.completeCases,3);
  assert.equal(none.summary.meanGap,null);
  assert.equal(none.cases[0].mcScore,2);
  assert.equal(none.cases[0].humanScore,null);
  const ratings=Object.fromEntries(TASKS.map((task,index)=>[`${run.id}:${task.id}:memo`,{consensus:[0,2,1][index],ai:[2,0,1][index]}]));
  const result=analyseRun(run,ANSWER_KEY,ratings);
  assert.deepEqual(result.cases.map(row=>row.humanScore),[2,4,3]);
  assert.deepEqual(result.cases.map(row=>row.aiScore),[4,2,3]);
  assert.deepEqual(result.cases.map(row=>row.mixedScore),[3,3,3]);
  assert.equal(result.summary.meanGap,0.5);
  assert.equal(result.summary.meanAbsoluteError,(1.5+0.5+0.5)/3);
  assert.notEqual(result.summary.meanAbsoluteError,Math.abs(result.summary.meanGap));
  const partial=clone(ratings);delete partial[`${run.id}:event:memo`].consensus;
  assert.equal(analyseRun(run,ANSWER_KEY,partial).summary.meanGap,null);
  assert.throws(()=>analyseRun(run,ANSWER_KEY,{[`${run.id}:event:memo`]:{consensus:1.5}}));
});

test('explicit unknown has zero multiple-choice points but missing grades stay null',()=> {
  const run=finish(makeRun(),{unknown:true});
  const result=analyseRun(run,ANSWER_KEY);
  assert.ok(result.cases.every(row=>row.mcScore===0 && row.humanScore===null));
  const ratings=Object.fromEntries(TASKS.map(task=>[`${run.id}:${task.id}:memo`,{consensus:0,ai:0}]));
  const graded=analyseRun(run,ANSWER_KEY,ratings);
  assert.ok(graded.cases.every(row=>row.humanScore===0));
  assert.equal(graded.summary.meanGap,3.5);
});

test('envelope validation catches foreign logs and merge preserves conflicting originals',()=> {
  const run=finish(),first=makeEnvelope(run,[event(run)]);
  const repeat=clone(first);repeat.exportedAt=new Date(Date.now()+100).toISOString();
  const merged=mergeEnvelopes([first],[repeat]);
  assert.equal(merged.items.length,1);assert.equal(merged.duplicates,1);
  const conflict=clone(first);conflict.events[0].data.count=2;
  const result=mergeEnvelopes([first],[conflict]);
  assert.equal(result.conflicts.length,1);assert.deepEqual(result.items[0],first);
  const foreign=clone(first);foreign.events[0].runId='another-run';
  assert.throws(()=>validateEnvelope(foreign));
  const duplicate=clone(first);duplicate.events.push(clone(duplicate.events[0]));
  assert.throws(()=>validateEnvelope(duplicate));
  assert.equal(first.studyVersion,STUDY.version);
});

test('invitation batches balance blocks and six-order bags; parser rejects malformed links',()=> {
  const invites=makeInvitations(24,'https://example.org/hci/');
  for (let i=0;i<invites.length;i+=4) assert.equal(invites.slice(i,i+4).filter(item=>item.condition==='assisted').length,2);
  for (const condition of ['control','assisted']) {
    const rows=invites.filter(item=>item.condition===condition);
    for (let i=0;i<rows.length;i+=6) assert.equal(new Set(rows.slice(i,i+6).map(item=>item.order.join(','))).size,6);
  }
  for (const invitation of invites) {
    const parsed=parseInvitation(new URL(invitation.url).hash);
    assert.equal(parsed.id,invitation.id);
    assert.equal(parsed.condition,invitation.condition);
    assert.deepEqual(parsed.order,invitation.order);
    assert.equal(new URL(invitation.url).pathname,'/hci/');
  }
  assert.equal(parseInvitation(''),null);
  assert.equal(parseInvitation('#'),null);
  assert.throws(()=>parseInvitation('#unrelated'));
  assert.throws(()=>parseInvitation('#invite=not-valid-json'));
  assert.throws(()=>makeInvitations(0,'https://example.org'));
  assert.throws(()=>makeInvitations(2,'javascript:alert(1)'));
});

test('CSV preserves quoted Korean text, nulls, numbers and neutralizes formula strings',()=> {
  const csv=toCSV([{text:'메모, "인용"\n다음 줄',prediction:null,score:0,formula:'  =SUM(A1:A2)',negative:-1}],['text','prediction','score','formula','negative']);
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"메모, ""인용""\n다음 줄"'));
  assert.ok(csv.includes('"","0"'));
  assert.ok(csv.includes('"\'  =SUM(A1:A2)"'));
  assert.ok(csv.includes('"-1"'));
});

test('memory fallback is explicit and storage will not roll back committed answers',async()=> {
  const store=await new BrowserStore().init();
  assert.equal(store.mode,'memory');
  const original=makeRun();await store.saveRun(original);
  const next=advance(original,{complete:true});await store.saveRun(next);
  await assert.rejects(store.saveRun(original),/이전 상태|다른 답안/);
  const stored=await store.getRun(original.id);
  assert.equal(stored.stage.phase,'decision');
  stored.participantCode='modified copy';
  assert.equal((await store.getRun(original.id)).participantCode,'P001');
  const first=event(next);await store.appendEvents([first,clone(first)]);
  assert.equal((await store.eventsForRun(next.id)).length,1);
  const different=clone(first);different.data.count=99;
  await assert.rejects(store.appendEvents([different]),/원본/);
  assert.equal((await store.eventsForRun(next.id))[0].data.count,1);
  assert.equal((await store.exportRun(next.id)).run.stage.phase,'decision');
});

test('failed event flush retains original queue and retry is lossless',async()=> {
  const persisted=[],status=[];
  let failing=true;
  const store={mode:'indexeddb',async appendEvents(events){if(failing)throw new Error('disk full');persisted.push(...clone(events));}};
  const recorder=new Recorder({store,onStatus:value=>status.push(value)});
  recorder.start(makeRun());recorder.record('custom',{count:1});
  await assert.rejects(recorder.flush(),/disk full/);
  assert.ok(recorder.pendingCount>=2);
  const pending=recorder.pendingEvents();pending[0].data.modified=true;
  assert.equal(recorder.pendingEvents()[0].data.modified,undefined);
  assert.ok(status.some(item=>item.state==='error'));
  failing=false;await recorder.flush();
  assert.equal(recorder.pendingCount,0);
  assert.equal(persisted.filter(item=>item.type==='custom').length,1);
  assert.ok(persisted.some(item=>item.type==='storage_failure'));
  assert.ok(persisted.some(item=>item.type==='storage_recovered'));
  await recorder.stop();
  assert.equal(new Set(persisted.map(item=>item.id)).size,persisted.length);
});
