import test from 'node:test';
import assert from 'node:assert/strict';
import {initializeApp, deleteApp} from 'firebase/app';
import {getAuth, signInAnonymously, signOut, deleteUser} from 'firebase/auth';
import * as firestore from 'firebase/firestore';
import {firebaseConfig} from '../web/cloud-config.mjs';
import {publishBatch, allocate, loadRecords} from '../web/crt/cloud.mjs';
import {createRun, submitStep, stepInfo, validateEnvelope} from '../web/crt/core.mjs';
import {CloudSync} from '../web/cloud-sync.mjs';
import {administrator} from './helpers/firebase-live.mjs';

const enabled=process.env.HCI_FIREBASE_LIVE_TEST==='1';

function complete(run){
 while(run.status!=='completed'){
  const s=stepInfo(run);
  const value=s.phase==='pre'?{age:23,gender:'undisclosed',major:'SYNTHETIC LIVE VERIFICATION',aiFrequency:'never',eligible:true,delivery:'in_person',device:'desktop',consent:true,noExternal:true}
   :s.phase==='decision'?{choice:'unknown'}:s.phase==='burden'?{burden:1}
   :s.phase==='estimate'?{confidence:0,predApply:0,...(s.taskId==='practice'?{}:{predExplain:0})}
   :s.phase==='item'?{answer:'',work:'',unknown:true}:s.phase==='feedback'?{acknowledged:true}
   :{used:'SYNTHETIC',predictionBasis:'SYNTHETIC',strategy:'SYNTHETIC',transfer:'SYNTHETIC',exposure:'no',externalUsed:'no',attention:'not_applicable'};
  run=submitStep(run,value);
 }
 return run;
}
test('live CRT v4: deployed central rules, receipt/import roundtrip and shared-device UID rotation', {skip:!enabled,timeout:180000},async()=>{
 assert.equal(firebaseConfig.projectId,'hci-judgment-20261107');
 const admin=await administrator(),clients=[],createdUsers=[],runPaths=new Set();let batch;
 const client=async()=>{
  const app=initializeApp(firebaseConfig,'crt-live-'+crypto.randomUUID()),auth=getAuth(app),db=firestore.getFirestore(app);
  const c={sdk:firestore,app,auth,db};clients.push(c);
  createdUsers.push((await signInAnonymously(auth)).user);return c;
 };
 try{
  batch=await publishBatch(admin,{count:6,cohort:'pilot'});
  const signups=await Promise.allSettled(Array.from({length:7},client));
  const rejected=signups.filter(s=>s.status==='rejected');
  if(rejected.length)throw new AggregateError(rejected.map(s=>s.reason),'Anonymous client setup failed');
  const participants=signups.map(s=>s.value);
  const allocation=await Promise.allSettled(participants.slice(0,6).map(c=>allocate(c,batch.batchId)));
  const allocationErrors=allocation.filter(s=>s.status==='rejected');
  if(allocationErrors.length)throw new AggregateError(allocationErrors.map(s=>s.reason),'Central allocation failed');
  const slots=allocation.map(s=>s.value);
  assert.deepEqual(slots.map(s=>s.sequence).sort((a,b)=>a-b),[1,2,3,4,5,6]);
  assert.equal(new Set(slots.map(s=>s.condition+s.latin)).size,6);
  assert.equal((await allocate(participants[0],batch.batchId)).id,slots[0].id);
  await assert.rejects(allocate(participants[6],batch.batchId),/모두 사용/);
  await assert.rejects(firestore.getDocs(firestore.collection(participants[0].db,'crtBatches',batch.batchId,'slots')),e=>e.code==='permission-denied');
  await assert.rejects(firestore.getDoc(firestore.doc(participants[1].db,'crtBatches',batch.batchId,'claims',participants[0].auth.currentUser.uid)),e=>e.code==='permission-denied');
  const runs=[];
  for(const condition of ['control','assisted']){
   const index=slots.findIndex(s=>s.condition===condition),c=participants[index];
   const partial=createRun({invitation:slots[index]});
   const run=complete(partial);runs.push(run);
   const events=[{id:crypto.randomUUID(),runId:run.id,pageId:crypto.randomUUID(),sequence:1,at:new Date().toISOString(),monotonicMs:1,phase:'done',taskId:null,updateId:null,type:'crt_live_verification',data:{synthetic:true}}];
   const adapter={uid:c.auth.currentUser.uid,put:async(path,data)=>{runPaths.add(path);await firestore.setDoc(firestore.doc(c.db,...path.split('/')),data);},get:async path=>{const d=await firestore.getDocFromServer(firestore.doc(c.db,...path.split('/')));return d.exists()?d.data():null;}};
   const storage=new Map(),sync=new CloudSync({store:{eventsForRun:async()=>events},adapterFactory:async()=>adapter,storage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}});
   try{
    sync.start(partial);await sync.sync();
    admin.sdk.getDocs=async()=>({docs:[await admin.sdk.getDocFromServer({path:`runs/${run.id}`})]});
    const incomplete=await loadRecords(admin);assert.equal(incomplete.envelopes[0].run.status,'in_progress');
    sync.update(run);const receipt=await sync.sync({final:true});
    assert.equal(receipt.submissionCount,33);assert.equal(receipt.eventCount,1);
    const imported=await loadRecords(admin);assert.equal(imported.notices.length,0);assert.equal(validateEnvelope(imported.envelopes[0]),true);
    assert.deepEqual(imported.envelopes[0].run,run);
    await assert.rejects(firestore.getDocFromServer(firestore.doc(participants[6].db,'runs',run.id)),e=>e.code==='permission-denied');
   }finally{sync.stop();}
  }
  const shared=participants[0],oldUid=shared.auth.currentUser.uid;
  await signOut(shared.auth);const next=(await signInAnonymously(shared.auth)).user;createdUsers.push(next);
  assert.notEqual(next.uid,oldUid);
  await assert.rejects(firestore.getDocFromServer(firestore.doc(shared.db,'crtBatches',batch.batchId,'claims',oldUid)),e=>e.code==='permission-denied');
  console.log('CRT_LIVE_RESULT '+JSON.stringify({version:'4.0.0',conditions:runs.map(r=>r.condition),completedSubmissions:runs.map(r=>r.submissions.length),centralClaims:6,uidRotated:true,importTransport:'CLI administrator IAM; Google popup remains human verification'}));
 }finally{
  const paths=new Set([...runPaths,...admin.createdDocumentPaths]);
  if(batch)for(const u of createdUsers)paths.add(`crtBatches/${batch.batchId}/claims/${u.uid}`);
  const tasks=[];
  if(paths.size)tasks.push(admin.request(':commit',{writes:[...paths].map(p=>({delete:`projects/${firebaseConfig.projectId}/databases/(default)/documents/${p}`}))}));
  tasks.push(...createdUsers.map(user=>deleteUser(user)));
  const cleanup=await Promise.allSettled(tasks);
  const clientsClosed=await Promise.allSettled(clients.map(async c=>{try{await firestore.terminate(c.db);}finally{await deleteApp(c.app);}}));
  const failures=[...cleanup,...clientsClosed].filter(s=>s.status==='rejected');
  if(failures.length)throw new AggregateError(failures.map(s=>s.reason),'Synthetic cleanup incomplete; retain log and investigate');
  console.log('CRT_LIVE_CLEANUP '+JSON.stringify({cleanedExactDocumentPaths:paths.size,deletedAnonymousAccounts:createdUsers.length,closedClients:clients.length}));
 }
});
