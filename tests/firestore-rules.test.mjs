import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { firebaseConfig } from '../web/cloud-config.mjs';

const enabled=process.env.HCI_FIREBASE_LIVE_TEST==='1';
test('live Firestore rules isolate anonymous owners and protect immutable chunks', {skip:!enabled}, async()=>{
 const project=firebaseConfig.projectId;
 assert.equal(project,'hci-judgment-20261107','Live smoke is restricted to the study project');
 const runId=`rules-smoke-${crypto.randomUUID()}`;
 const base=`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
 const authBase=`https://identitytoolkit.googleapis.com/v1/accounts`;
 const users=[];
 const signup=async()=>{
  const r=await fetch(`${authBase}:signUp?key=${firebaseConfig.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({returnSecureToken:true})});
  assert.equal(r.status,200,'anonymous auth enabled');const user=await r.json();users.push(user);return user;
 };
 const encode=value=>({fields:Object.fromEntries(Object.entries(value).map(([key,value])=>[key,{stringValue:value}]))});
 const request=async(method,path,user,value)=>fetch(`${base}/${path}`,{method,headers:{'Content-Type':'application/json',...(user?{Authorization:`Bearer ${user.idToken}`}:{})},...(value?{body:JSON.stringify(encode(value))}:{})});
 try{
  const [owner,other]=await Promise.all([signup(),signup()]);
  const run={ownerUid:owner.localId,payload:JSON.stringify({mode:'test',kind:'rules-smoke'}),updatedAt:new Date().toISOString()};
  assert.equal((await request('PATCH',`runs/${runId}`,owner,run)).status,200,'owner create');
  assert.equal((await request('GET',`runs/${runId}`,owner)).status,200,'owner read');
  assert.equal((await request('GET',`runs/${runId}`,other)).status,403,'other participant read denied');
  assert.equal((await request('GET',`runs/${runId}`,null)).status,403,'unauthenticated read denied');
  assert.equal((await request('PATCH',`runs/${runId}`,other,{...run,ownerUid:other.localId})).status,403,'owner takeover denied');
  assert.equal((await request('GET','runs',other)).status,403,'participant collection listing denied');
  const chunk={ownerUid:owner.localId,payload:'[]',createdAt:run.updatedAt};
  assert.equal((await request('PATCH',`runs/${runId}/chunks/sample`,owner,chunk)).status,200,'owner chunk create');
  assert.equal((await request('PATCH',`runs/${runId}/chunks/sample`,owner,chunk)).status,200,'identical chunk retry');
  assert.equal((await request('PATCH',`runs/${runId}/chunks/sample`,owner,{...chunk,payload:'[1]'})).status,403,'chunk mutation denied');
  assert.equal((await request('GET',`runs/${runId}/chunks/sample`,other)).status,403,'other participant chunk read denied');
  assert.equal((await request('PATCH',`runs/${runId}/chunks/forged`,other,{...chunk,ownerUid:other.localId})).status,403,'other participant chunk write denied');
  assert.equal((await request('DELETE',`runs/${runId}`,owner)).status,403,'participant deletion denied');
  assert.equal((await request('PATCH',`runs/${runId}/receipts/not-final`,owner,chunk)).status,403,'unknown receipt path denied');
  assert.equal((await request('PATCH',`runs/${runId}/receipts/final`,owner,chunk)).status,200,'owner final receipt path');
 }finally{
  // Delete only the synthetic run created above; user participant data is never selected.
  const cleanup=spawnSync('firebase',['firestore:delete',`runs/${runId}`,'--recursive','--force','--project',project,'--account',process.env.HCI_FIREBASE_ACCOUNT||'superriaco@gmail.com','--non-interactive'],{encoding:'utf8',timeout:30000});
  for(const user of users)await fetch(`${authBase}:delete?key=${firebaseConfig.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:user.idToken})});
  assert.equal(cleanup.status,0,'synthetic run cleanup completed');
 }
});

test('live CloudSync completes run, chunk and verified receipt roundtrip', {skip:!enabled}, async()=>{
 const {CloudSync}=await import('../web/cloud-sync.mjs');
 const {createRun,submitStep,stepInfo}=await import('../web/core.mjs');
 const project=firebaseConfig.projectId;assert.equal(project,'hci-judgment-20261107');
 const signup=await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${firebaseConfig.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({returnSecureToken:true})});assert.equal(signup.status,200);
 const user=await signup.json();
 let run=createRun({participantCode:'CLOUD_RULES_SMOKE',condition:'control',mode:'demo'});
 while(run.status!=='completed'){
  const phase=stepInfo(run).phase;
  run=submitStep(run,phase==='practice'?{complete:true}:phase==='estimate'?{burden:1,prediction:0}:phase==='memo'?{unknown:true}:{choice:'unknown'});
 }
 const events=[{id:crypto.randomUUID(),runId:run.id,pageId:crypto.randomUUID(),sequence:1,at:new Date().toISOString(),monotonicMs:1,phase:'done',taskId:null,updateId:null,type:'rules_smoke',data:{synthetic:true}}];
 const base=`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
 const headers={Authorization:`Bearer ${user.idToken}`,'Content-Type':'application/json'};
 const adapter={uid:user.localId,async put(path,value){const r=await fetch(`${base}/${path}`,{method:'PATCH',headers,body:JSON.stringify({fields:Object.fromEntries(Object.entries(value).map(([k,v])=>[k,{stringValue:v}]))})});assert.equal(r.status,200,`write ${path}`);},async get(path){const r=await fetch(`${base}/${path}`,{headers});if(r.status===404)return null;assert.equal(r.status,200,`read ${path}`);const doc=await r.json();return Object.fromEntries(Object.entries(doc.fields).map(([k,v])=>[k,v.stringValue]));}};
 const storage=new Map(),statuses=[];
 const sync=new CloudSync({store:{eventsForRun:async()=>events},adapterFactory:async()=>adapter,storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)},onStatus:s=>statuses.push(s.state)});
 try{
  sync.start(run);const receipt=await sync.sync({final:true});
  assert.equal(receipt.eventCount,1);assert.equal(receipt.submissionCount,16);assert.equal(receipt.chunkIds.length,1);assert.equal(statuses.at(-1),'complete');
  assert.equal(JSON.parse((await adapter.get(`runs/${run.id}`)).payload).participantCode,'CLOUD_RULES_SMOKE');
  assert.equal(JSON.parse((await adapter.get(`runs/${run.id}/receipts/final`)).payload).eventIdsHash,receipt.eventIdsHash);
 }finally{
  sync.stop();const cleanup=spawnSync('firebase',['firestore:delete',`runs/${run.id}`,'--recursive','--force','--project',project,'--account',process.env.HCI_FIREBASE_ACCOUNT||'superriaco@gmail.com','--non-interactive'],{encoding:'utf8',timeout:30000});
  await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:delete?key=${firebaseConfig.apiKey}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idToken:user.idToken})});
  assert.equal(cleanup.status,0,'synthetic roundtrip cleanup');
 }
});
