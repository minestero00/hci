import test from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { fitWorkspace,workspaceLayout } from '../web/workspace-layout.mjs';

test('workspace uses independent panes only when the remaining height can keep them usable',()=>{
 assert.equal(workspaceLayout({width:1440,height:900,top:280}).mode,'panes');
 assert.equal(workspaceLayout({width:1024,height:600,top:300}).mode,'page');
 assert.equal(workspaceLayout({width:800,height:1000,top:280}).mode,'page');
});

test('workspace adapts to wrapping and resize, updates scroll clearances and cleans up',async t=>{
 const win=new Window({width:1440,height:900});t.after(async()=>{await win.happyDOM.abort();win.close();});
 const oldWindow=globalThis.window,oldDocument=globalThis.document,oldObserver=globalThis.ResizeObserver;
 Object.defineProperty(globalThis,'window',{value:win,writable:true,configurable:true});Object.defineProperty(globalThis,'document',{value:win.document,writable:true,configurable:true});
 t.after(()=>{globalThis.window=oldWindow;globalThis.document=oldDocument;globalThis.ResizeObserver=oldObserver;});
 win.document.body.innerHTML='<header class="site-header"></header><main id="root"><div class="workspace-top"></div><div class="phase-steps"></div><div class="workspace-grid"><section class="source-column"><div class="source-toolbar"><span data-pane-help></span></div></section><section class="decision-column"><div class="response-pane-heading"></div></section></div></main>';
 let top=260,callback,disconnected=false;
 const root=win.document.getElementById('root'),grid=root.querySelector('.workspace-grid');
 grid.getBoundingClientRect=()=>({top});root.querySelector('.source-toolbar').getBoundingClientRect=()=>({height:90});
 globalThis.ResizeObserver=class{constructor(cb){callback=cb;}observe(){}disconnect(){disconnected=true;}};
 const layouts=[],release=fitWorkspace(root,event=>layouts.push(event));
 assert.equal(root.dataset.layout,'panes');assert.equal(root.style.getPropertyValue('--pane-height'),'616px');
 assert.equal(root.querySelector('.source-column').style.getPropertyValue('--pane-heading-height'),'106px');
 Object.defineProperty(win,'innerHeight',{value:560,configurable:true,writable:true});callback();
 await new Promise(resolve=>win.requestAnimationFrame(resolve));
 assert.equal(root.dataset.layout,'page');assert.match(root.querySelector('[data-pane-help]').textContent,/계속 참고/);
 win.innerHeight=900;top=340;win.dispatchEvent(new win.Event('resize'));await new Promise(resolve=>win.requestAnimationFrame(resolve));
 assert.equal(root.dataset.layout,'panes');assert.equal(root.style.getPropertyValue('--pane-height'),'536px');assert.equal(layouts.length,3);
 release();assert.equal(disconnected,true);win.innerHeight=400;win.dispatchEvent(new win.Event('resize'));await new Promise(resolve=>win.requestAnimationFrame(resolve));assert.equal(root.dataset.layout,'panes');
});
