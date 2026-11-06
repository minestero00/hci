import { firebaseConfig } from './cloud-config.mjs';
export const cloudEnabled = () => Boolean(firebaseConfig.projectId && (globalThis.location?.hostname==='minestero00.github.io'||(['localhost','127.0.0.1'].includes(globalThis.location?.hostname)&&new URLSearchParams(globalThis.location.search).get('cloud')==='1')));
export async function eventHash(ids){const bytes=new TextEncoder().encode([...ids].sort().join('\n'));return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export function eventGroups(events){
 const groups=[];let group=[],size=2;
 for(const event of events){const n=new TextEncoder().encode(JSON.stringify(event)).length+1;if(n>180000)throw Error('행동 기록 하나가 전송 제한을 초과했습니다. 기록 파일을 보관해 주세요.');if(group.length&&(group.length>=100||size+n>180000)){groups.push(group);group=[];size=2;}group.push(event);size+=n;}
 if(group.length)groups.push(group);return groups;
}
async function browserAdapter(){
 const sdk=await import('./firebase-sdk.mjs');const app=sdk.initializeApp(firebaseConfig,'hci-participant'),auth=sdk.getAuth(app),db=sdk.getFirestore(app);
 await auth.authStateReady();
 if(!auth.currentUser)await sdk.signInAnonymously(auth);
 const uid=auth.currentUser.uid;
 return {uid,async put(path,data){await sdk.setDoc(sdk.doc(db,...path.split('/')),data);},async get(path){const value=await sdk.getDocFromServer(sdk.doc(db,...path.split('/')));return value.exists()?value.data():null;}};
}
const consented=new Set();
export function hasCloudConsent(id){try{return consented.has(id)||localStorage.getItem(`hci.cloud.consent.${firebaseConfig.projectId}.${id}`)==='yes';}catch{return consented.has(id);}}
export function markCloudConsent(id){consented.add(id);try{localStorage.setItem(`hci.cloud.consent.${firebaseConfig.projectId}.${id}`,'yes');}catch{}}
const copy=x=>structuredClone(x);
export class CloudSync {
 constructor({store,adapterFactory=browserAdapter,onStatus=()=>{},storage=globalThis.localStorage}={}){this.store=store;this.factory=adapterFactory;this.onStatus=onStatus;this.storage=storage;this.active=null;this.queue=Promise.resolve();this.adapter=null;this.timer=null;this.lastPayload=new Map();this.receipts=new Map();this.state={state:'idle'};}
 emit(state,extra={}){this.state={state,...extra};this.onStatus(this.state);}
 start(run){this.active=copy(run);if(!this.timer){this.timer=setInterval(()=>this.sync().catch(()=>{}),15000);this.timer.unref?.();}return this;}
 update(run){if(this.active?.id===run.id)this.active=copy(run);}
 stop(){clearInterval(this.timer);this.timer=null;this.active=null;}
 sync({final=false}={}){
  const run=this.active?copy(this.active):null;if(!run||(run.status==='completed'&&!final))return Promise.resolve(null);
  const job=this.queue.catch(()=>{}).then(()=>this.send(run,final));this.queue=job;return job;
 }
 async send(run,final){
  this.emit('sending',{runId:run.id});
  try{
   this.adapter??=await this.factory();const {uid}=this.adapter;
   const key=`hci.cloud.v1.${uid}.${run.id}`;let known={};try{known=JSON.parse(this.storage?.getItem(key)||'{}');}catch{}
   if(!known||typeof known!=='object'||Array.isArray(known))known={};
   const events=[...new Map((await this.store.eventsForRun(run.id)).map(e=>[e.id,e])).values()];
   if(events.some(e=>e.runId!==run.id))throw Error('다른 실행의 행동 기록이 섞였습니다.');
   const payload=JSON.stringify(run);
   if(this.lastPayload.get(run.id)!==payload){await this.adapter.put(`runs/${run.id}`,{ownerUid:uid,payload,updatedAt:run.updatedAt||run.startedAt});this.lastPayload.set(run.id,payload);}
   const ids=new Set(events.map(e=>e.id));
   const acknowledged=new Set(Object.values(known).flat());
   const chunks=eventGroups(events.filter(e=>!acknowledged.has(e.id)));
   for(const batch of chunks){
    const id=await eventHash(batch.map(e=>e.id));
    await this.adapter.put(`runs/${run.id}/chunks/${id}`,{ownerUid:uid,payload:JSON.stringify(batch),createdAt:batch[0].at});
    known[id]=batch.map(e=>e.id);try{this.storage?.setItem(key,JSON.stringify(known));}catch{}
   }
   if(final){
    if(run.status!=='completed')throw Error('완료한 응답만 최종 제출할 수 있습니다.');
    const hash=await eventHash([...ids]);
    const previous=this.receipts.get(run.id);if(previous?.eventIdsHash===hash&&previous.submissionCount===run.submissions.length){this.emit('complete',{runId:run.id,receipt:previous});return previous;}
    const manifest=Object.entries(known).filter(([,values])=>values.every(id=>ids.has(id))).map(([id])=>id);
    const remoteEvents=[];
    for(const chunkId of manifest){const chunk=await this.adapter.get(`runs/${run.id}/chunks/${chunkId}`);if(chunk?.ownerUid!==uid){delete known[chunkId];try{this.storage?.setItem(key,JSON.stringify(known));}catch{}throw Error('서버 행동 기록을 확인하지 못했습니다.');}const rows=JSON.parse(chunk.payload);if(!Array.isArray(rows)||await eventHash(rows.map(e=>e.id))!==chunkId)throw Error('서버 행동 묶음이 일치하지 않습니다.');remoteEvents.push(...rows);}
    const remoteIds=new Set(remoteEvents.map(e=>e.id));
    if(remoteIds.size!==ids.size||await eventHash([...remoteIds])!==await eventHash([...ids]))throw Error('서버 행동 기록 수신 범위가 일치하지 않습니다.');
    const receipt={runId:run.id,eventCount:events.length,eventIdsHash:await eventHash([...ids]),chunkIds:manifest,submissionCount:run.submissions.length,completedAt:run.finishedAt,uiVersion:globalThis.document?.body?.dataset?.uiVersion||'unknown',receivedAt:new Date().toISOString()};
    const receiptPayload=JSON.stringify(receipt);
    await this.adapter.put(`runs/${run.id}/receipts/final`,{ownerUid:uid,payload:receiptPayload,createdAt:run.finishedAt});
    const [remote,received]=await Promise.all([this.adapter.get(`runs/${run.id}`),this.adapter.get(`runs/${run.id}/receipts/final`)]);
    if(remote?.payload!==payload||received?.payload!==receiptPayload)throw Error('서버 수신 확인이 일치하지 않습니다. 다시 제출해 주세요.');
    clearInterval(this.timer);this.timer=null;this.receipts.set(run.id,receipt);this.emit('complete',{runId:run.id,receipt});return receipt;
   }
   this.emit('synced',{runId:run.id,eventCount:events.length});return null;
  }catch(error){this.emit('error',{runId:run.id,message:'서버 전송을 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하거나 기록 파일을 보관해 주세요.'});throw error;}
 }
}
