import { newId, stepInfo } from './core.mjs';
import { TELEMETRY_VERSION, IDLE_AFTER_MS } from './telemetry.mjs';

const now = () => globalThis.performance?.now?.() ?? Date.now();
const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const round = value => Math.round((Number.isFinite(value)?value:0) * 10) / 10;
const ratio = value => Math.round(value*100)/100;
const safe = (value,max=160) => String(value??'').slice(0,max);
const editable = element => ['TEXTAREA','INPUT'].includes(element?.tagName) && !['radio','checkbox','button','submit','hidden'].includes(element.type);

export class Recorder {
  constructor({store,onStatus=()=>{},clock=now,idleAfterMs=IDLE_AFTER_MS} = {}) {
    if(!store)throw Error('기록 저장소가 필요합니다.');
    this.store=store;this.onStatus=onStatus;this._now=clock;this.idleAfterMs=idleAfterMs;
    this.pageId=newId();this.sequence=0;this._queue=[];this._flushing=null;this._active=false;this._context=null;this._listeners=[];
    this._sources=new Map();this._observer=null;this._fields=new Map();this._controls=new Map();this._scrolls=new Map();this._scrollPositions=new WeakMap();
    this._hover=null;this._lastPointer=null;this._failureNoted=false;this._volumeNoted=false;this.lastSavedAt=null;
    this._segmentStart=null;this._lastActivity=null;this._focused=true;this._visible=true;this._overlayKind=null;
  }
  pendingEvents(){return clone(this._queue);}
  get pendingCount(){return this._queue.length;}
  _status(state,message){try{this.onStatus({state,message,pending:this._queue.length,mode:this.store.mode,lastSavedAt:this.lastSavedAt});}catch{/* UI cannot break recording. */}}
  start(run){
    if(this._active){this.context(run);return this;}
    this.context(run);this._active=true;
    const doc=globalThis.document;
    this._visible=!doc?.hidden;this._focused=doc?.hasFocus?.()??true;
    this._segmentStart=this._lastActivity=this._now();this._baselineScrolls(doc);this._listen();
    this.record('recorder_started',{storageMode:this.store.mode,uiVersion:safe(doc?.body?.dataset?.uiVersion||'legacy',80),idleAfterMs:this.idleAfterMs,overlayOpen:Boolean(this._overlayKind),capabilities:{intersectionObserver:Boolean(globalThis.IntersectionObserver),scrollEnd:Boolean(globalThis.window&&'onscrollend' in globalThis.window),visibility:Boolean(doc&&'visibilityState' in doc)},sampling:{pointerMs:200,scrollMs:250,inputMs:250,selectionMs:400},viewport:this._viewport()});
    this._timer=setInterval(()=>this.flush().catch(()=>{}),2000);
    this._heartbeat=setInterval(()=>{this._checkpoint('heartbeat');this.record('heartbeat',{pending:this._queue.length,storageMode:this.store.mode,visible:this._visible,focused:this._focused,lastSavedAt:this.lastSavedAt});},15000);
    this._timer.unref?.();this._heartbeat.unref?.();
    this._status(this.store.mode==='memory'?'memory':'saved',this.store.mode==='memory'?'자동 저장을 사용할 수 없습니다. 기록 파일을 다운로드해 보관해 주세요.':'이 기기에 저장합니다.');
    return this;
  }
  context(run){
    const info=stepInfo(run),next={runId:run.id,phase:info.phase,taskId:info.taskId,updateId:info.updateId};
    const changed=this._context&&JSON.stringify(next)!==JSON.stringify(this._context);
    if(changed){
      this._checkpoint('stage_change');this._closeExposures('stage_change');this._endHover('stage_change');this._closeFields('stage_change');this._finishScrolls('stage_change');
      this._controls.clear();this._lastPointer=null;
      this._lastActivity=this._now();
    }
    this._context=next;
    if(changed)for(const entry of this._sources.values())if(entry.ratio>0)this._startExposure(entry);
    return this;
  }
  _enqueue(type,data,context=this._context){
    if(!this._active||!context)return;
    this._queue.push({id:newId(),...context,pageId:this.pageId,sequence:++this.sequence,at:new Date().toISOString(),monotonicMs:round(this._now()),type,data:{...clone(data),telemetryVersion:TELEMETRY_VERSION}});
    if(this._queue.length>=10000&&!this._volumeNoted){this._volumeNoted=true;this._status('error','저장 대기 중인 행동 기록이 많습니다. 자동 저장 상태를 확인하고 기록 파일을 보관해 주세요.');}
    if(this._queue.length>=50&&!this._flushing)this.flush().catch(()=>{});
  }
  record(type,data={}){
    if(typeof type!=='string'||!type||type.length>80||data===null||typeof data!=='object'||Array.isArray(data))throw Error('행동 기록 형식이 올바르지 않습니다.');
    this._enqueue(type,data);
  }
  checkpoint(reason='manual'){
    if(!this._active)return;
    reason=safe(reason,80);this._checkpoint(reason);this._closeFields(reason);this._finishScrolls(reason);
    for(const entry of this._sources.values())if(entry.start!==null){this._endExposure(entry,reason);this._startExposure(entry);}
    const hovered=this._hover?.element;this._endHover(reason);if(hovered)this._beginHover(hovered);
  }
  overlay(open,kind='dialog'){
    const next=open?safe(kind||'dialog',80):null;
    if(next===this._overlayKind)return;
    const previous=this._overlayKind;
    this._checkpoint(open?'overlay_open':'overlay_close');
    if(open){this._closeExposures('overlay_open');this._endHover('overlay_open');this._closeFields('overlay_open');this._finishScrolls('overlay_open');}
    this._overlayKind=next;
    this.record('overlay_state',{open:Boolean(open),kind:next||previous||safe(kind,80)});
    if(!open)for(const entry of this._sources.values())if(entry.ratio>0)this._startExposure(entry);
  }
  async flush(){
    if(this._flushing){await this._flushing;if(this._queue.length)return this.flush();return;}
    if(!this._queue.length)return;
    this._status('saving','기록을 저장하는 중입니다.');
    this._flushing=(async()=>{
      while(this._queue.length){
        const batch=this._queue.slice(0,500);
        try{await this.store.appendEvents(batch);this._queue.splice(0,batch.length);this.lastSavedAt=new Date().toISOString();
          if(this._failureNoted){this._failureNoted=false;this._enqueue('storage_recovered',{pending:this._queue.length});}
        }catch(error){
          if(!this._failureNoted){this._failureNoted=true;this._enqueue('storage_failure',{message:safe(error?.message??'저장 실패',500),pending:this._queue.length});}
          this._status('error','행동 기록을 저장하지 못했습니다. 저장 대기 기록은 유지됩니다. 기록 파일을 보관하고 다시 시도해 주세요.');throw error;
        }
      }
      this._volumeNoted=false;this._status(this.store.mode==='memory'?'memory':'saved',this.store.mode==='memory'?'현재 탭에만 보관 중입니다. 닫기 전에 기록 파일을 다운로드해 주세요.':'이 기기에 저장됨');
    })();
    try{await this._flushing;}finally{this._flushing=null;}
  }
  _on(target,type,listener,options){target.addEventListener(type,listener,options);this._listeners.push(()=>target.removeEventListener(type,listener,options));}
  _target(element){
    if(!element||typeof element.closest!=='function')return 'page';
    const control=element.closest('button,a,input,textarea,select');
    const named=element.closest('[data-track],[data-log-id]');
    if(named){
      const base=named.dataset.track||named.dataset.logId,controls=[...named.querySelectorAll('button,a,input,textarea,select')];
      if(control&&control!==named&&controls.length>1)return safe(`${base}:${control.id||control.name||control.tagName}:${controls.indexOf(control)+1}`);
      return safe(base);
    }
    if(control?.type==='radio'){
      const group=[...(control.form?.elements||globalThis.document?.querySelectorAll('input[type=radio]')||[])].filter(input=>input.type==='radio'&&input.name===control.name);
      return safe(`${control.name||'radio'}:option-${group.indexOf(control)+1}`);
    }
    return safe(control?.id||control?.getAttribute('name')||element.id||element.getAttribute('name')||element.tagName||'element');
  }
  _meta(element){return{target:this._target(element),region:safe(element?.closest?.('[data-region]')?.dataset.region||'page'),sourceId:element?.closest?.('[data-source-id]')?.dataset.sourceId?safe(element.closest('[data-source-id]').dataset.sourceId):null};}
  _viewport(){const win=globalThis.window;return{width:round(win?.innerWidth),height:round(win?.innerHeight),scale:round(win?.visualViewport?.scale??1),devicePixelRatio:round(win?.devicePixelRatio??1)};}
  _checkpoint(reason){
    if(!this._active||this._segmentStart===null)return;
    const time=this._now(),durationMs=Math.max(0,time-this._segmentStart);
    if(durationMs<=0)return;
    const foreground=this._visible&&this._focused;
    const foregroundMs=foreground?durationMs:0;
    const activeMs=foreground?Math.max(0,Math.min(time,(this._lastActivity??time)+this.idleAfterMs)-this._segmentStart):0;
    this.record('engagement_segment',{durationMs:round(durationMs),foregroundMs:round(foregroundMs),activeMs:round(activeMs),idleMs:round(foregroundMs-activeMs),hiddenMs:round(this._visible?0:durationMs),blurredMs:round(this._visible&&!this._focused?durationMs:0),reason});
    this._segmentStart=time;
  }
  _activity(){const time=this._now();if(this._lastActivity!==null&&time-this._lastActivity>this.idleAfterMs)this._checkpoint('interaction_resumed');this._lastActivity=time;}
  _field(element){
    if(!editable(element))return null;
    const meta=this._meta(element),key=element;
    if(!this._fields.has(key))this._fields.set(key,{...meta,start:this._now(),initialLength:element.value?.length??0,finalLength:element.value?.length??0,inputActions:0,inserts:0,deletes:0,historyActions:0,compositionCount:0,pastes:0,maxLength:element.value?.length??0,lastInput:-Infinity});
    return this._fields.get(key);
  }
  _endField(key,reason){const field=this._fields.get(key);if(!field)return;const{start,lastInput,...data}=field;this.record('field_session',{...data,durationMs:round(Math.max(0,this._now()-start)),reason});this._fields.delete(key);}
  _closeFields(reason){for(const key of this._fields.keys())this._endField(key,reason);}
  _hoverElement(element){return element?.closest?.('[data-track],[data-source-id],button,a,input,textarea,select')??null;}
  _beginHover(element){
    if(!element||!this._visible||!this._focused)return;
    if(this._overlayKind&&element.closest('[data-source-id]'))return;
    if(this._hover?.element===element)return;
    this._endHover('target_change');this._hover={element,start:this._now(),context:{...this._context},...this._meta(element)};
  }
  _endHover(reason){if(!this._hover)return;const{element,start,context,...data}=this._hover;const durationMs=Math.max(0,this._now()-start);if(durationMs>=80)this._enqueue('hover_end',{...data,durationMs:round(durationMs),reason},context);this._hover=null;}
  _baselineScrolls(root){
    const elements=[root?.scrollingElement,root,...(root?.querySelectorAll?.('*')||[])];
    for(const element of elements)if(element&&typeof element==='object'&&typeof element.scrollTop==='number')this._scrollPositions.set(element,{top:element.scrollTop,left:element.scrollLeft||0});
  }
  _scroll(event){
    const doc=globalThis.document,win=globalThis.window,element=event.target===doc?doc.scrollingElement:event.target;
    if(!element||!this._visible)return;
    this._activity();const time=this._now(),meta=this._meta(element),key=meta.target+':'+meta.region;
    const top=round(element.scrollTop??win?.scrollY??0),left=round(element.scrollLeft??win?.scrollX??0),height=round(element.scrollHeight??doc.documentElement.scrollHeight),viewport=round(element.clientHeight||win?.innerHeight),depth=height>viewport?Math.min(1,Math.max(0,top/(height-viewport))):1;
    let entry=this._scrolls.get(key);
    if(!entry){const baseline=this._scrollPositions.get(element);entry={...meta,start:time,last:time,lastEmit:-Infinity,top:baseline?.top??top,left:baseline?.left??left,maxDepth:depth,distancePx:0,initialPositionKnown:Boolean(baseline),reversals:0,direction:0,samples:0};this._scrolls.set(key,entry);}
    const delta=top-entry.top,direction=Math.sign(delta);
    if(direction&&entry.direction&&entry.direction!==direction)entry.reversals++;
    if(direction)entry.direction=direction;
    entry.distancePx+=Math.abs(delta);entry.top=top;entry.left=left;entry.maxDepth=Math.max(entry.maxDepth,depth);entry.last=time;entry.samples++;this._scrollPositions.set(element,{top,left});
    if(event.type!=='scrollend'&&time-entry.lastEmit>=250){entry.lastEmit=time;this.record('scroll',{...meta,top,left,height,viewport,depth:ratio(depth),direction:direction>0?'down':direction<0?'up':'stationary'});}
    clearTimeout(entry.timer);
    if(event.type==='scrollend')this._endScroll(key,'native_scrollend');else{entry.timer=setTimeout(()=>this._endScroll(key,'quiet_400ms'),400);entry.timer.unref?.();}
  }
  _endScroll(key,reason){const entry=this._scrolls.get(key);if(!entry)return;clearTimeout(entry.timer);const{start,last,lastEmit,timer,direction,...data}=entry;this.record('scroll_end',{...data,durationMs:round(last-start),distancePx:round(entry.distancePx),maxDepth:ratio(entry.maxDepth),reason});this._scrolls.delete(key);}
  _finishScrolls(reason){for(const key of this._scrolls.keys())this._endScroll(key,reason);}
  _listen(){
    const doc=globalThis.document,win=globalThis.window;if(!doc||!win)return;
    for(const type of ['click','dblclick','contextmenu'])this._on(doc,type,event=>{this._activity();this.record(type==='dblclick'?'double_click':type==='contextmenu'?'context_menu':'click',{...this._meta(event.target),button:event.button??0,detail:event.detail??0,modifiers:{alt:Boolean(event.altKey),ctrl:Boolean(event.ctrlKey),meta:Boolean(event.metaKey),shift:Boolean(event.shiftKey)}});});
    this._on(doc,'pointerdown',event=>{this._activity();this.record('pointer_down',{...this._meta(event.target),pointerType:safe(event.pointerType||'unknown',30),x:round(event.clientX),y:round(event.clientY)});},{passive:true});
    this._on(doc,'pointermove',event=>{
      if(!this._visible)return;this._activity();const time=this._now(),last=this._lastPointer;if(last&&time-last.time<200)return;
      const x=round(event.clientX),y=round(event.clientY),rect=event.target?.getBoundingClientRect?.();
      const distancePx=last&&time-last.time<=2000?round(Math.hypot(x-last.x,y-last.y)):0;
      this._lastPointer={time,x,y};this.record('pointer_move',{...this._meta(event.target),pointerType:safe(event.pointerType||'unknown',30),x,y,distancePx,width:win.innerWidth,height:win.innerHeight,relativeX:rect?.width?ratio((x-rect.left)/rect.width):null,relativeY:rect?.height?ratio((y-rect.top)/rect.height):null});
    },{passive:true});
    this._on(doc,'pointerover',event=>this._beginHover(this._hoverElement(event.target)),{passive:true});
    this._on(doc,'pointerout',event=>{if(this._hoverElement(event.relatedTarget)!==this._hover?.element)this._endHover('pointer_out');},{passive:true});
    this._on(doc,'scroll',event=>this._scroll(event),{passive:true,capture:true});this._on(doc,'scrollend',event=>this._scroll(event),{passive:true,capture:true});
    this._on(doc,'beforeinput',event=>{
      this._activity();const field=this._field(event.target);if(!field)return;
      if(!field.inputActions)this.record('input_started',this._meta(event.target));
      field.inputActions++;const type=safe(event.inputType||'unknown',60);if(type.startsWith('insert'))field.inserts++;if(type.startsWith('delete'))field.deletes++;if(type.startsWith('history'))field.historyActions++;
      if(this._now()-field.lastInput>=250){field.lastInput=this._now();this.record('input_action',{...this._meta(event.target),inputType:type,isComposing:Boolean(event.isComposing),length:typeof event.target.value==='string'?event.target.value.length:null});}
    });
    this._on(doc,'input',event=>{this._activity();const field=this._field(event.target);if(field){field.finalLength=event.target.value?.length??0;field.maxLength=Math.max(field.maxLength,field.finalLength);}});
    this._on(doc,'change',event=>{
      this._activity();const target=event.target,controlType=target?.tagName==='SELECT'?'select':target?.type;
      if(!['radio','checkbox','select'].includes(controlType))return;
      const meta=this._meta(target),group=safe(target.name||target.id||meta.target),previous=this._controls.get(group),current=controlType==='checkbox'?Boolean(target.checked):controlType==='select'?target.selectedIndex:meta.target;
      this.record('control_change',{...meta,controlType,group,revised:previous!==undefined&&previous!==current,checked:['radio','checkbox'].includes(controlType)?Boolean(target.checked):null,...(controlType==='select'?{selectedIndex:target.selectedIndex}:{})});this._controls.set(group,current);
    });
    this._on(doc,'compositionstart',event=>{this._activity();const field=this._field(event.target);if(field)field.compositionCount++;this.record('composition_start',this._meta(event.target));});
    this._on(doc,'compositionend',event=>{this._activity();this.record('composition_end',{...this._meta(event.target),length:typeof event.target?.value==='string'?event.target.value.length:null});});
    this._on(doc,'paste',event=>{this._activity();const field=this._field(event.target);if(field)field.pastes++;this.record('paste',this._meta(event.target));});
    this._on(doc,'copy',event=>{this._activity();this.record('copy',this._meta(event.target));});
    this._on(doc,'cut',event=>{this._activity();this.record('cut',this._meta(event.target));});
    this._on(doc,'focusin',event=>{this._field(event.target);this.record('focus_in',this._meta(event.target));});
    this._on(doc,'focusout',event=>{this.record('focus_out',this._meta(event.target));this._endField(event.target,'focus_out');});
    this._on(doc,'invalid',event=>this.record('validation_invalid',{...this._meta(event.target),controlType:safe(event.target?.type||event.target?.tagName,30),required:Boolean(event.target?.required)}),true);
    this._on(doc,'keydown',event=>{
      this._activity();let category=null,key=null;
      if(['Tab','Enter','Escape','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End','PageUp','PageDown'].includes(event.key)){category='navigation';key=event.key;}
      else if(['Backspace','Delete'].includes(event.key)){category='deletion';key=event.key;}
      else if((event.ctrlKey||event.metaKey)&&['a','c','v','x','z','y'].includes(String(event.key).toLowerCase())){category='editing_shortcut';key=String(event.key).toLowerCase();}
      if(category)this.record(category==='navigation'?'key_navigation':'key_action',{...this._meta(event.target),category,key,repeat:Boolean(event.repeat),modifiers:{alt:Boolean(event.altKey),ctrl:Boolean(event.ctrlKey),meta:Boolean(event.metaKey),shift:Boolean(event.shiftKey)}});
    });
    this._lastSelection=-Infinity;
    this._on(doc,'selectionchange',()=>{
      if(this._now()-this._lastSelection<400||!this._visible)return;
      const selection=doc.getSelection?.(),active=doc.activeElement;
      const length=editable(active)&&typeof active.selectionStart==='number'?Math.max(0,active.selectionEnd-active.selectionStart):selection?.toString?.().length||0;
      if(!length)return;this._lastSelection=this._now();this._activity();this.record('selection',{...this._meta(editable(active)?active:selection?.anchorNode?.parentElement),length});
    });
    this._on(doc,'visibilitychange',()=>{
      this._checkpoint('visibility_change');this._visible=!doc.hidden;
      if(!this._visible){this._closeExposures('page_hidden');this._endHover('page_hidden');this._closeFields('page_hidden');this._finishScrolls('page_hidden');}
      else for(const entry of this._sources.values())if(entry.ratio>0)this._startExposure(entry);
      this.record('visibility',{state:doc.visibilityState});this.flush().catch(()=>{});
    });
    this._on(win,'focus',()=>{this._checkpoint('window_focus');this._focused=true;for(const entry of this._sources.values())if(entry.ratio>0)this._startExposure(entry);this.record('window_focus');});
    this._on(win,'blur',()=>{this._checkpoint('window_blur');this._focused=false;this._closeExposures('window_blur');this._endHover('window_blur');this._closeFields('window_blur');this._finishScrolls('window_blur');this._lastPointer=null;this.record('window_blur');});
    let resizeTimer;
    this._on(win,'resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(()=>this.record('viewport_resize',this._viewport()),200);resizeTimer.unref?.();});this._listeners.push(()=>clearTimeout(resizeTimer));
    this._on(win,'online',()=>this.record('connection',{online:true}));this._on(win,'offline',()=>this.record('connection',{online:false}));
    this._on(win,'error',event=>this.record('runtime_error',{kind:event.error?'script':'resource',name:safe(event.error?.name||event.target?.tagName||'Error',80)}),true);
    this._on(win,'unhandledrejection',event=>this.record('runtime_error',{kind:'unhandled_rejection',name:safe(event.reason?.name||'UnknownRejection',80)}));
    this._on(win,'pagehide',event=>{this._checkpoint('page_hide');this._closeExposures('page_hide');this._endHover('page_hide');this._closeFields('page_hide');this._finishScrolls('page_hide');this.record('page_hide',{persisted:Boolean(event.persisted)});this._visible=false;this.flush().catch(()=>{});});
    this._on(win,'pageshow',event=>{this._checkpoint('page_show');this._visible=!doc.hidden;this._focused=doc.hasFocus?.()??true;this.record('page_show',{persisted:Boolean(event.persisted)});for(const entry of this._sources.values())if(entry.ratio>0)this._startExposure(entry);});
  }
  _startExposure(entry){if(!this._active||!this._visible||!this._focused||this._overlayKind||entry.start!==null)return;entry.start=this._now();entry.context={...this._context};this._enqueue('source_exposure_start',{sourceId:entry.id,ratio:entry.ratio},entry.context);}
  _endExposure(entry,reason){if(entry.start===null)return;this._enqueue('source_exposure_end',{sourceId:entry.id,ratio:entry.ratio,durationMs:Math.max(0,round(this._now()-entry.start)),reason},entry.context);entry.start=null;}
  _closeExposures(reason){for(const entry of this._sources.values())this._endExposure(entry,reason);}
  observe(root=globalThis.document){
    this._closeExposures('view_replaced');this._observer?.disconnect();this._sources.clear();
    this._baselineScrolls(root);
    for(const control of root?.querySelectorAll?.('input[type=radio]:checked,input[type=checkbox]:checked')||[]){
      const meta=this._meta(control),group=safe(control.name||control.id||meta.target);
      if(!this._controls.has(group))this._controls.set(group,control.type==='checkbox'?true:meta.target);
    }
    if(!root?.querySelectorAll||!globalThis.IntersectionObserver||!this._active)return;
    this._observer=new IntersectionObserver(entries=>{
      for(const observed of entries){const entry=this._sources.get(observed.target);if(!entry)continue;
        entry.ratio=Math.max(0,Math.min(1,observed.intersectionRatio));
        this.record('source_viewport',{sourceId:entry.id,ratio:entry.ratio,documentVisible:this._visible,windowFocused:this._focused,overlayOpen:Boolean(this._overlayKind)});
        if(observed.isIntersecting&&entry.ratio>0)this._startExposure(entry);else this._endExposure(entry,'out_of_view');
      }
    },{root:null,threshold:[0,0.25,0.5,0.75,1]});
    for(const element of root.querySelectorAll('[data-source-id]')){this._sources.set(element,{id:safe(element.dataset.sourceId),ratio:0,start:null,context:{...this._context}});this._observer.observe(element);}
  }
  async stop(){
    if(!this._active){await this.flush();return;}
    clearInterval(this._timer);clearInterval(this._heartbeat);this._listeners.splice(0).forEach(remove=>remove());
    this._checkpoint('recorder_stop');this._closeExposures('recorder_stop');this._endHover('recorder_stop');this._closeFields('recorder_stop');this._finishScrolls('recorder_stop');
    this._observer?.disconnect();this._sources.clear();this.record('recorder_stopped');this._active=false;await this.flush();
  }
}
