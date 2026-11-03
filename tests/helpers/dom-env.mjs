import { Window } from 'happy-dom';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { readFile } from 'node:fs/promises';
export async function domEnvironment(htmlFile, url = 'https://example.test/hci/index.html') {
  const window = new Window({ url, width: 1440, height: 1000, settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
  const factory = new IDBFactory(), blobs = [], downloads = [];
  for (const [key,value] of Object.entries({ window,document:window.document,navigator:window.navigator,location:window.location,history:window.history,localStorage:window.localStorage,sessionStorage:window.sessionStorage,FormData:window.FormData,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,Event:window.Event,CustomEvent:window.CustomEvent,IntersectionObserver:window.IntersectionObserver,indexedDB:factory,IDBKeyRange })) Object.defineProperty(globalThis,key,{value,configurable:true,writable:true});
  Object.defineProperty(window,'indexedDB',{value:factory,configurable:true});
  window.scrollTo = () => {};
  globalThis.confirm = () => true;
  const originalAnchorClick = window.HTMLAnchorElement.prototype.click;
  window.HTMLAnchorElement.prototype.click = function () {
    if(this.hasAttribute('download')) downloads.push({href:this.href,name:this.download});
    else originalAnchorClick.call(this);
  };
  const originalCreate = URL.createObjectURL, originalRevoke = URL.revokeObjectURL;
  URL.createObjectURL = blob => {blobs.push(blob);return `blob:https://example.test/${blobs.length}`;}; URL.revokeObjectURL = () => {};
  const html = await readFile(htmlFile,'utf8'); window.document.write(html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,''));
  return {window,document:window.document,blobs,downloads,async cleanup(){window.dispatchEvent(new window.Event('pagehide'));await new Promise(resolve=>setTimeout(resolve,20));URL.createObjectURL=originalCreate;URL.revokeObjectURL=originalRevoke;await window.happyDOM.abort();window.close();}};
}
export async function until(predicate, label = 'condition', timeout = 8000) {
  const start=Date.now();
  while(Date.now()-start<timeout){const result=await predicate();if(result)return result;await new Promise(resolve=>setTimeout(resolve,15));}
  throw Error(`Timed out: ${label}. DOM: ${globalThis.document?.body?.textContent?.slice(-1200)}`);
}
export function submit(document, id) {const form=document.getElementById(id);if(!form)throw Error(`Missing form ${id}`);form.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));}
export function choose(document,name,value){const element=[...document.querySelectorAll(`input[name="${name}"]`)].find(e=>e.value===String(value));if(!element)throw Error(`Missing ${name}=${value}`);element.checked=true;element.dispatchEvent(new window.Event('change',{bubbles:true}));}
