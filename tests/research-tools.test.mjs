import test from 'node:test';
import assert from 'node:assert/strict';
import { TASKS,STUDY } from '../web/content.mjs';
import { createRun,submitStep,stepInfo,makeEnvelope } from '../web/core.mjs';
import { ANSWER_KEY } from '../web/research-key.mjs';
import { blindPacket,knownResponses,applyRatings,analysisTables,responseId,validateRatings,validateBlindPacket,numericRatings } from '../web/research-tools.mjs';
function completed(mode='pilot',invitationId='invitation-one'){
 let run=createRun({participantCode:'PRIVATE_CODE',condition:'assisted',mode,invitationId});
 while(run.stage.phase!=='done'){
  const i=stepInfo(run);let v;
  if(i.phase==='practice')v={complete:true};if(i.phase==='decision')v={choice:ANSWER_KEY[i.taskId].initial};if(i.phase==='estimate')v={burden:3,prediction:0};if(i.phase==='update')v={choice:ANSWER_KEY[i.taskId].updates[i.updateId]};if(i.phase==='memo')v={text:'두 관계를 설명한 답안'};run=submitStep(run,v);
 }
 return run;
}
const file=(role,ratings,extra={})=>({format:'hci-ratings',schemaVersion:1,studyVersion:STUDY.version,role,ratings,...extra});
test('blind packets omit condition, prediction, identity and AI recommendation',()=>{
 const envelope=makeEnvelope(completed(),[]),packet=blindPacket([envelope]);
 assert.equal(packet.items.length,3);assert.equal(JSON.stringify(packet).includes('PRIVATE_CODE'),false);
 assert.deepEqual(Object.keys(packet.items[0]).sort(),['responseId','taskId','text']);
 for(const task of packet.tasks){assert.ok(!('ai' in task));assert.ok(!('updates' in task.rubric));}
});
test('missing grades stay null, consensus requires both humans, and zero is a score',()=>{
 const run=completed(),envelope=makeEnvelope(run,[]),ids=knownResponses([envelope]);let grades={};
 assert.equal(analysisTables([envelope]).participants[0].primary_eligible,0);
 assert.equal(analysisTables([envelope]).participants[0].mean_score,null);
 const entries=TASKS.map(task=>({responseId:responseId(run.id,task.id),score:0,reason:'근거 부족'}));
 assert.throws(()=>applyRatings(grades,file('consensus',entries),ids),/독립 채점/);
 for(const role of ['rater1','rater2','consensus'])grades=applyRatings(grades,file(role,entries),ids).ratings;
 const result=analysisTables([envelope],grades);assert.equal(result.participants[0].primary_eligible,1);assert.equal(result.participants[0].mean_score,2);assert.equal(result.participants[0].mean_gap,-2);
});
test('conflicting scores are preserved and AI provenance is required',()=>{
 const run=completed(),e=makeEnvelope(run,[]),ids=knownResponses([e]),id=responseId(run.id,TASKS[0].id);
 let result=applyRatings({},file('rater1',[{responseId:id,score:1}]),ids);
 result=applyRatings(result.ratings,file('rater1',[{responseId:id,score:2}]),ids);assert.equal(result.conflicts.length,1);assert.equal(result.ratings[id].rater1.score,1);
 assert.throws(()=>validateRatings(file('ai',[{responseId:id,score:2}]),ids),/모델/);
 const ai=applyRatings(result.ratings,file('ai',[{responseId:id,score:2,criteriaSatisfied:[1,2]}],{model:'test-model',promptVersion:'v1'}),ids);assert.deepEqual(ai.ratings[id].ai.criteriaSatisfied,[1,2]);
});
test('demo is excluded by default and reused invitations are flagged rather than doubled',()=>{
 const a=makeEnvelope(completed(),[]),b=makeEnvelope(completed(),[]),demo=makeEnvelope(completed('demo','demo-invite'),[]);
 const result=analysisTables([a,b,demo]);assert.equal(result.participants.length,2);assert.ok(result.participants.every(p=>p.duplicate_invitation===1&&p.primary_eligible===0));assert.equal(analysisTables([demo],{},true).participants.length,1);
});
test('untrusted grading identifiers cannot pollute prototypes or manufacture human consensus',()=>{
 for(const id of ['__proto__','constructor','prototype']){
  assert.throws(()=>validateBlindPacket({format:'hci-blind-grading-packet',schemaVersion:1,studyVersion:STUDY.version,items:[{responseId:id,taskId:'event',text:'x'}]}));
  assert.throws(()=>applyRatings({},file('rater1',[{responseId:id,score:2}]),new Set([id])));
 }
 assert.equal(Object.prototype.rater1,undefined);assert.equal(Object.prototype.rater2,undefined);
 const run=completed(),id=responseId(run.id,'event');
 const inherited=Object.create({rater1:{score:2},rater2:{score:2}});inherited.consensus={score:2};
 assert.equal(numericRatings({[id]:inherited})[id].consensus,undefined);
 assert.throws(()=>applyRatings({[id]:inherited},file('consensus',[{responseId:id,score:2}]),new Set([id])),/독립 채점/);
});
