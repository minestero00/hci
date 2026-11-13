import {createRequire} from 'node:module';
import {existsSync, realpathSync} from 'node:fs';
import {dirname, resolve, delimiter} from 'node:path';
import {firebaseConfig} from '../../web/cloud-config.mjs';
// Reuse a signed-in CLI administrator without exposing credentials or changing auth policy.
export async function administrator(){
 const binary=process.env.PATH.split(delimiter).map(p=>resolve(p,'firebase')).find(existsSync);
 if(!binary)throw Error('Install and sign in to Firebase CLI before live verification.');
 const require=createRequire(import.meta.url),cli=require(resolve(dirname(realpathSync(binary)),'../auth.js'));
 const account=cli.getAllAccounts().find(a=>a.user.email==='superriaco@gmail.com');
 if(!account)throw Error('Authorized researcher CLI account is required.');
 const token=await cli.getAccessToken(account.tokens.refresh_token,[]);
 const base=`https://firestore.googleapis.com/v1/projects/${firebaseConfig.projectId}/databases/(default)/documents`;
 const request=async(path,body)=>{
  const r=await fetch(`${base}${path}`,{method:body?'POST':'GET',headers:{Authorization:`Bearer ${token.access_token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
  if(!r.ok)throw Error(`Admin request ${r.status}: ${await r.text()}`);
  return r.json();
 };
 const encode=x=>typeof x==='string'?{stringValue:x}:typeof x==='number'?{integerValue:String(x)}:typeof x==='boolean'?{booleanValue:x}:Array.isArray(x)?{arrayValue:{values:x.map(encode)}}:{mapValue:{fields:Object.fromEntries(Object.entries(x).map(([k,v])=>[k,encode(v)]))}};
 const decode=x=>'stringValue'in x?x.stringValue:'integerValue'in x?Number(x.integerValue):'booleanValue'in x?x.booleanValue:'arrayValue'in x?(x.arrayValue.values??[]).map(decode):Object.fromEntries(Object.entries(x.mapValue?.fields??{}).map(([k,v])=>[k,decode(v)]));
 const document=path=>({path});
 const writes=[],createdDocumentPaths=new Set();
 const sdk={doc:(_db,...p)=>document(p.join('/')),collection:(_db,...p)=>document(p.join('/')),
  writeBatch:()=>({set:(ref,data)=>{createdDocumentPaths.add(ref.path);writes.push({update:{name:`projects/${firebaseConfig.projectId}/databases/(default)/documents/${ref.path}`,fields:encode(data).mapValue.fields}});},commit:()=>request(':commit',{writes:writes.splice(0)})}),
  setDoc:(ref,data)=>{createdDocumentPaths.add(ref.path);return request(':commit',{writes:[{update:{name:`projects/${firebaseConfig.projectId}/databases/(default)/documents/${ref.path}`,fields:encode(data).mapValue.fields}}]});},
  getDocFromServer:async ref=>{const d=await request('/'+ref.path);return{exists:()=>true,id:ref.path.split('/').at(-1),data:()=>decode({mapValue:{fields:d.fields}})};},
 };
 return {sdk,db:null,auth:{currentUser:{email:account.user.email,emailVerified:true}},request,createdDocumentPaths};
}
