import { newId, stepInfo } from './core.mjs';

const now = () => globalThis.performance?.now?.() ?? Date.now();
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const round = value => Math.round(value * 10) / 10;

export class Recorder {
  constructor({store, onStatus = ()=>{}} = {}) {
    if (!store) throw new Error('기록 저장소가 필요합니다.');
    this.store=store;
    this.onStatus=onStatus;
    this.pageId=newId();
    this.sequence=0;
    this._queue=[];
    this._flushing=null;
    this._active=false;
    this._context=null;
    this._listeners=[];
    this._sources=new Map();
    this._observer=null;
    this._lastPointer=-Infinity;
    this._lastScroll=-Infinity;
    this._inputStarted=new Set();
    this._failureNoted=false;
    this._volumeNoted=false;
    this.lastSavedAt=null;
  }
  pendingEvents() { return clone(this._queue); }
  get pendingCount() { return this._queue.length; }
  _status(state,message) {
    try {this.onStatus({state,message,pending:this._queue.length,mode:this.store.mode,lastSavedAt:this.lastSavedAt});} catch { /* UI feedback cannot break data collection. */ }
  }
  start(run) {
    if (this._active) {this.context(run);return this;}
    this.context(run);
    this._active=true;
    this._listen();
    this.record('recorder_started',{storageMode:this.store.mode});
    this._timer=setInterval(()=>{this.flush().catch(()=>{});},2000);
    this._heartbeat=setInterval(()=>this.record('heartbeat',{pending:this._queue.length,storageMode:this.store.mode,visibility:globalThis.document?.visibilityState ?? 'unknown',lastSavedAt:this.lastSavedAt}),15000);
    this._timer.unref?.(); this._heartbeat.unref?.();
    this._status(this.store.mode==='memory'?'memory':'saved',this.store.mode==='memory'?'자동 저장을 사용할 수 없습니다. 기록 파일을 다운로드해 보관해 주세요.':'이 기기에 저장합니다.');
    return this;
  }
  context(run) {
    const info=stepInfo(run);
    const next={runId:run.id,phase:info.phase,taskId:info.taskId,updateId:info.updateId};
    if (this._context && JSON.stringify(next)!==JSON.stringify(this._context)) {
      this._closeExposures('stage_change');
      this._inputStarted.clear();
    }
    this._context=next;
    return this;
  }
  _enqueue(type,data,context=this._context) {
    if (!this._active || !context) return;
    this._queue.push({id:newId(),...context,pageId:this.pageId,sequence:++this.sequence,at:new Date().toISOString(),monotonicMs:round(now()),type,data:clone(data)});
    if (this._queue.length>=10000 && !this._volumeNoted) {
      this._volumeNoted=true;
      this._status('error','저장 대기 중인 행동 기록이 많습니다. 자동 저장 상태를 확인하고 기록 파일을 보관해 주세요.');
    }
    if (this._queue.length>=50 && !this._flushing) this.flush().catch(()=>{});
  }
  record(type,data={}) {
    if (typeof type!=='string' || !type || type.length>80 || data===null || typeof data!=='object' || Array.isArray(data)) throw new Error('행동 기록 형식이 올바르지 않습니다.');
    // Callers provide plain JSON metadata. Native DOM events or clipboard objects are never stored.
    this._enqueue(type,data);
  }
  async flush() {
    if (this._flushing) {
      await this._flushing;
      if (this._queue.length) return this.flush();
      return;
    }
    if (!this._queue.length) return;
    this._status('saving','기록을 저장하는 중입니다.');
    this._flushing=(async()=> {
      while (this._queue.length) {
        const batch=this._queue.slice(0,500);
        try {
          await this.store.appendEvents(batch);
          this._queue.splice(0,batch.length);
          this.lastSavedAt=new Date().toISOString();
          if (this._failureNoted) {
            this._failureNoted=false;
            this._enqueue('storage_recovered',{pending:this._queue.length});
          }
        } catch (error) {
          if (!this._failureNoted) {
            this._failureNoted=true;
            this._enqueue('storage_failure',{message:String(error?.message ?? '저장 실패').slice(0,500),pending:this._queue.length});
          }
          this._status('error','행동 기록을 저장하지 못했습니다. 저장 대기 기록은 유지됩니다. 기록 파일을 보관하고 다시 시도해 주세요.');
          throw error;
        }
      }
      this._volumeNoted=false;
      this._status(this.store.mode==='memory'?'memory':'saved',this.store.mode==='memory'?'현재 탭에만 보관 중입니다. 닫기 전에 기록 파일을 다운로드해 주세요.':'이 기기에 저장됨');
    })();
    try {await this._flushing;} finally {this._flushing=null;}
  }
  _on(target,type,listener,options) {
    target.addEventListener(type,listener,options);
    this._listeners.push(()=>target.removeEventListener(type,listener,options));
  }
  _target(element) {
    if (!element || typeof element.closest!=='function') return 'page';
    const named=element.closest('[data-log-id]');
    if (named) return String(named.dataset.logId).slice(0,160);
    return String(element.id || element.getAttribute?.('name') || element.tagName || 'element').slice(0,160);
  }
  _listen() {
    const doc=globalThis.document, win=globalThis.window;
    if (!doc || !win) return;
    this._on(doc,'click',event=>this.record('click',{target:this._target(event.target),button:event.button}));
    this._on(doc,'pointerdown',event=>this.record('pointer_down',{target:this._target(event.target),pointerType:event.pointerType,x:round(event.clientX),y:round(event.clientY)}),{passive:true});
    this._on(doc,'pointermove',event=> {
      const time=now(); if (time-this._lastPointer<200 || doc.hidden) return;
      this._lastPointer=time;
      this.record('pointer_move',{target:this._target(event.target),pointerType:event.pointerType,x:round(event.clientX),y:round(event.clientY),width:win.innerWidth,height:win.innerHeight});
    },{passive:true});
    const scroll=event=> {
      const time=now(); if (event.type!=='scrollend' && time-this._lastScroll<250) return;
      this._lastScroll=time;
      const element=event.target===doc ? doc.scrollingElement : event.target;
      this.record(event.type==='scrollend'?'scroll_end':'scroll',{target:this._target(element),top:round(element?.scrollTop ?? win.scrollY ?? 0),left:round(element?.scrollLeft ?? win.scrollX ?? 0),height:element?.scrollHeight ?? doc.documentElement.scrollHeight,viewport:element?.clientHeight ?? win.innerHeight});
    };
    this._on(doc,'scroll',scroll,{passive:true,capture:true});
    this._on(doc,'scrollend',scroll,{passive:true,capture:true});
    this._on(doc,'beforeinput',event=> {
      const target=this._target(event.target), key=`${this._context?.phase}:${this._context?.taskId}:${this._context?.updateId}:${target}`;
      if (!this._inputStarted.has(key)) {this._inputStarted.add(key);this.record('input_started',{target});}
      this.record('input_action',{target,inputType:event.inputType || 'unknown',isComposing:Boolean(event.isComposing),length:typeof event.target?.value==='string'?event.target.value.length:null});
    });
    this._on(doc,'compositionstart',event=>this.record('composition_start',{target:this._target(event.target)}));
    this._on(doc,'compositionend',event=>this.record('composition_end',{target:this._target(event.target),length:typeof event.target?.value==='string'?event.target.value.length:null}));
    this._on(doc,'paste',event=>this.record('paste',{target:this._target(event.target)}));
    this._on(doc,'focusin',event=>this.record('focus_in',{target:this._target(event.target)}));
    this._on(doc,'focusout',event=>this.record('focus_out',{target:this._target(event.target)}));
    this._on(doc,'keydown',event=> {
      if (['Tab','Enter','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(event.key)) this.record('key_navigation',{target:this._target(event.target),key:event.key});
    });
    this._on(doc,'visibilitychange',()=> {
      if (doc.hidden) this._closeExposures('page_hidden');
      this.record('visibility',{state:doc.visibilityState});
      if (!doc.hidden) {
        for (const entry of this._sources.values()) if (entry.ratio>0) this._startExposure(entry);
      }
      this.flush().catch(()=>{});
    });
    this._on(win,'focus',()=>this.record('window_focus'));
    this._on(win,'blur',()=>this.record('window_blur'));
    this._on(win,'resize',()=>this.record('viewport_resize',{width:win.innerWidth,height:win.innerHeight}));
    this._on(win,'online',()=>this.record('connection',{online:true}));
    this._on(win,'offline',()=>this.record('connection',{online:false}));
    this._on(win,'pagehide',()=> {this._closeExposures('page_hide');this.record('page_hide');this.flush().catch(()=>{});});
  }
  _startExposure(entry) {
    if (!this._active || globalThis.document?.hidden || entry.start!==null) return;
    entry.start=now(); entry.context={...this._context};
    this._enqueue('source_exposure_start',{sourceId:entry.id,ratio:entry.ratio},entry.context);
  }
  _endExposure(entry,reason) {
    if (entry.start===null) return;
    this._enqueue('source_exposure_end',{sourceId:entry.id,ratio:entry.ratio,durationMs:Math.max(0,round(now()-entry.start)),reason},entry.context);
    entry.start=null;
  }
  _closeExposures(reason) {for (const entry of this._sources.values()) this._endExposure(entry,reason);}
  observe(root=globalThis.document) {
    this._closeExposures('view_replaced');
    this._observer?.disconnect(); this._sources.clear();
    if (!root?.querySelectorAll || !globalThis.IntersectionObserver || !this._active) return;
    this._observer=new IntersectionObserver(entries=> {
      for (const observed of entries) {
        const entry=this._sources.get(observed.target); if (!entry) continue;
        entry.ratio=round(observed.intersectionRatio*100)/100;
        this.record('source_viewport',{sourceId:entry.id,ratio:entry.ratio,documentVisible:!globalThis.document?.hidden});
        if (observed.isIntersecting && entry.ratio>0 && !globalThis.document?.hidden) this._startExposure(entry);
        else this._endExposure(entry,'out_of_view');
      }
    },{root:null,threshold:[0,0.25,0.5,0.75,1]});
    for (const element of root.querySelectorAll('[data-source-id]')) {
      this._sources.set(element,{id:String(element.dataset.sourceId).slice(0,160),ratio:0,start:null,context:{...this._context}});
      this._observer.observe(element);
    }
  }
  async stop() {
    if (!this._active) {await this.flush();return;}
    clearInterval(this._timer); clearInterval(this._heartbeat);
    this._listeners.splice(0).forEach(remove=>remove());
    this._closeExposures('recorder_stop');
    this._observer?.disconnect(); this._sources.clear();
    this.record('recorder_stopped');
    this._active=false;
    await this.flush();
  }
}
