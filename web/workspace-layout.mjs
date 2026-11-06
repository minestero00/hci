/** Fit the two reading panes to the space that actually remains below the task header. */
export function workspaceLayout({width,height,top}) {
  const available=Math.floor(height-top-24);
  return {mode:width>=900&&available>=320?'panes':'page',height:Math.max(0,available)};
}
export function fitWorkspace(root,onChange=()=>{}) {
  const grid=root.querySelector('.workspace-grid');
  if(!grid)return()=>{};
  const win=globalThis.window;
  let frame=null,previous=null;
  const update=()=>{
    frame=null;if(!root.isConnected)return;
    const next=workspaceLayout({width:win.innerWidth,height:win.innerHeight,top:grid.getBoundingClientRect().top+(win.scrollY||0)});
    const metrics=[...root.querySelectorAll('.source-column,.decision-column')].map(panel=>({panel,height:Math.ceil(panel.querySelector('.source-toolbar,.response-pane-heading')?.getBoundingClientRect().height||0)+16}));
    root.dataset.layout=next.mode;
    const hint=root.querySelector('[data-pane-help]');if(hint)hint.textContent=next.mode==='panes'?'각 영역 안에서 스크롤할 수 있어요':'자료를 계속 참고할 수 있어요';
    root.style.setProperty('--pane-height',`${next.height}px`);
    for(const {panel,height} of metrics)panel.style.setProperty('--pane-heading-height',`${height}px`);
    if(previous!==next.mode){previous=next.mode;onChange({...next,viewport:{width:win.innerWidth,height:win.innerHeight}});}
  };
  const schedule=()=>{if(frame===null)frame=win.requestAnimationFrame(update);};
  win.addEventListener('resize',schedule);
  const Observer=globalThis.ResizeObserver||win.ResizeObserver;
  const observer=Observer?new Observer(schedule):null;
  for(const el of root.querySelectorAll('.workspace-top,.phase-steps,.session-banner,.source-toolbar,.response-pane-heading'))observer?.observe(el);
  const header=globalThis.document.querySelector('.site-header');if(header)observer?.observe(header);
  update();
  return()=>{win.removeEventListener('resize',schedule);observer?.disconnect();if(frame!==null)win.cancelAnimationFrame(frame);};
}
