import { STUDY, TASKS } from './content.mjs';
import { createRun, stepInfo, submitStep, validateRun, parseInvitation, makeEnvelope } from './core.mjs';
import { BrowserStore } from './storage.mjs';
import { Recorder } from './recorder.mjs';

const ACTIVE = 'hci-workspace.activeRun';
const app = document.getElementById('app');
const store = new BrowserStore();
const tabId = crypto.randomUUID();
const icons = {
  brand:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M5 5h5v14H5zM14 5h5v8h-5zM14 17h5v2h-5z" fill="currentColor"/></svg>',
  document:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M7 3h7l4 4v14H6V3h1Z" stroke="currentColor" stroke-width="1.5"/><path d="M14 3v5h4M9 12h6M9 16h6" stroke="currentColor" stroke-width="1.5"/></svg>',
  check:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m5 12 4 4L19 6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  screen:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><rect x="3" y="4" width="18" height="12" rx="2" stroke="currentColor" stroke-width="1.5"/><path d="M8 21h8M12 16v5" stroke="currentColor" stroke-width="1.5"/></svg>',
  ai:'<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" stroke="currentColor" stroke-width="1.5"/></svg>'
};
let run = null, savedRun = null, invitation = null, invitationError = '';
let recorder = null, busy = false, saveError = '', logError = '', saving = false, hasLock = false;
let releaseLock = null, lockRunId = null, leaseTimer = null;
let draftTimer = null, draftMaxTimer = null, composing = false, lastDraftJSON = '';
let writeQueue = Promise.resolve();
let latestDraft = null;
let exportCount = 0;
let exporting = false;
const sourcePositions = new Map();
const initialHash = location.hash;

const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = value => structuredClone(value);
const taskFor = id => TASKS.find(task=>task.id===id);
const draftKey = info => [info.phase,info.taskId||'',info.updateId||''].join(':');
const valuesFor = info => run?.draft?.key===draftKey(info) ? run.draft.values : {};
const button = (label,attrs='',secondary=false) => `<button class="button${secondary?' secondary':''}" ${attrs}>${label}</button>`;
const footer = () => `<footer class="site-footer"><div class="shell"><span>판단 워크스페이스 · 팀 파일럿 ${esc(STUDY.version)}</span><span>응답은 이 브라우저에 저장됩니다. <a href="./research.html">연구자 도구</a></span></div></footer>`;
const mobile = () => `<section class="mobile-gate shell"><div class="card desktop-notice">${icons.screen}<div><div class="eyebrow">PC BROWSER REQUIRED</div><h1>넓은 PC 창에서 이어가세요.</h1><p class="muted">자료를 나란히 비교하는 과제입니다. 창 너비를 900px 이상으로 넓히거나 PC 브라우저에서 열어 주세요.</p><p class="muted">작성한 응답은 현재 기기의 브라우저에 저장됩니다. 다른 기기로 자동 이동되지는 않습니다.</p><p id="mobile-storage-warning" class="notice" ${saveError||logError?'':'hidden'}>${esc(saveError||logError)}</p>${run?button('현재 기록 다운로드','type="button" data-action="download" data-track="narrow-recovery"'):savedRun?button('보관 기록 다운로드','type="button" data-action="download-saved"'):''}</div></div></section>`;

function header(){
  return `<header class="site-header"><div class="shell"><a class="brand" href="./index.html" data-action="home" data-track="workspace-home"><span class="brand-mark">${icons.brand}</span><span>판단 워크스페이스</span></a><div class="header-meta"><span class="header-tagline">자료에서 판단까지.</span><span id="save-status" role="status" aria-live="polite">${statusText()}</span>${run?button('도움말','type="button" data-action="help"',true).replace('class="button secondary"','class="button ghost small"')+button('기록 다운로드','type="button" data-action="download" data-track="download-record"',true).replace('class="button secondary"','class="button secondary small"')+button('잠시 나가기','type="button" data-action="home" data-track="pause-session"',true).replace('class="button secondary"','class="button ghost small"'):''}</div></div></header>`;
}
function statusText(){
  if(saveError||logError) return '<span class="status-dot warning"></span>저장 확인 필요';
  if(store.mode==='memory') return '<span class="status-dot warning"></span>임시 메모리 저장';
  if(saving) return '<span class="status-dot"></span>이 기기에 저장 중';
  return '<span class="status-dot"></span>이 기기 자동 저장';
}
function paintSaveStatus(){
  const el=document.getElementById('save-status');
  if(el) el.innerHTML=statusText();
  for(const warning of document.querySelectorAll('#storage-warning,#mobile-storage-warning')){
    const text=saveError||logError|| (store.mode==='memory'?'이 환경에서는 브라우저 자동 저장을 사용할 수 없습니다. 창을 닫기 전에 반드시 현재 기록을 다운로드해 주세요.':'');
    warning.textContent=text;
    warning.hidden=!text;
  }
}
function storageWarning(){ return `<div id="storage-warning" class="notice session-banner" ${saveError||logError||store.mode==='memory'?'':'hidden'}>${esc(saveError||logError||(store.mode==='memory'?'브라우저 저장이 제한되어 있습니다. 창을 닫기 전 현재 기록을 다운로드해 주세요.':''))}</div>`; }
function queueSave(snapshot=run){
  if(!snapshot) return Promise.resolve();
  const data=clone(snapshot);
  saving=true;paintSaveStatus();
  const operation=writeQueue.then(()=>{
    let owned=hasLock&&lockRunId===data.id&&run?.id===data.id;
    if(owned&&store.mode!=='memory'&&!navigator.locks?.request){
      try{const lease=JSON.parse(localStorage.getItem(`hci-workspace.lease.${data.id}`)||'null');owned=lease?.tabId===tabId&&lease.expires>Date.now();}catch{owned=false;}
    }
    if(!owned){if(run?.id===data.id)loseSession();throw Error('다른 탭이 실행을 사용 중이어서 저장하지 않았습니다. 다시 연결한 뒤 진행해 주세요.');}
    return store.saveRun(data);
  });
  writeQueue=operation.catch(error=>{
    saveError=`기록을 기기에 저장하지 못했습니다. 현재 기록을 다운로드해 보관해 주세요. (${error.message||'저장 실패'})`;
    paintSaveStatus();
  });
  return operation.then(()=>{saving=false;saveError='';paintSaveStatus();}).catch(error=>{saving=false;paintSaveStatus();throw error;});
}
function currentFormValues(form){
  const data=new FormData(form), result={};
  for(const [key,value] of data.entries()) result[key]=String(value);
  if(form.elements.namedItem('unknown')) result.unknown=Boolean(form.elements.namedItem('unknown').checked);
  const memo=form.elements.namedItem('text');
  if(memo)result.text=String(memo.value);
  if(form.elements.namedItem('text')) result.text=form.elements.namedItem('text').value;
  return result;
}
function scheduleDraft(form){
  if(!run||busy||!hasLock) return;
  latestDraft={key:draftKey(stepInfo(run)),values:currentFormValues(form)};
  clearTimeout(draftTimer);
  if(!composing) draftTimer=setTimeout(()=>saveDraftNow(),500);
  if(!draftMaxTimer) draftMaxTimer=setTimeout(()=>{draftMaxTimer=null;if(!composing)saveDraftNow();},2000);
}
async function saveDraftNow(){
  clearTimeout(draftTimer);clearTimeout(draftMaxTimer);draftTimer=draftMaxTimer=null;
  if(!run||!latestDraft||!hasLock||composing||run.status==='completed')return;
  const draft=clone(latestDraft);
  if(draft.key!==draftKey(stepInfo(run)))return;
  const json=JSON.stringify(draft);
  if(json===lastDraftJSON)return;
  run={...run,draft,updatedAt:new Date().toISOString()};
  recorder?.record('draft_revision',{field:draft.key,value:draft.values});
  try{await queueSave();lastDraftJSON=json;}catch{}
}
function clearDraftTimers(){clearTimeout(draftTimer);clearTimeout(draftMaxTimer);draftTimer=draftMaxTimer=null;latestDraft=null;lastDraftJSON='';}

async function acquireSession(id){
  if(hasLock&&lockRunId===id)return true;
  unlockSession();lockRunId=id;
  if(navigator.locks?.request){
    return new Promise(resolve=>{
      navigator.locks.request(`hci-workspace:${id}`,{ifAvailable:true},async lock=>{
        if(!lock){hasLock=false;resolve(false);return;}
        hasLock=true;resolve(true);
        await new Promise(release=>{releaseLock=release;});
      }).catch(()=>{hasLock=false;resolve(false);});
    });
  }
  const key=`hci-workspace.lease.${id}`;
  try{
    const existing=JSON.parse(localStorage.getItem(key)||'null');
    if(existing&&existing.tabId!==tabId&&existing.expires>Date.now()){hasLock=false;return false;}
    localStorage.setItem(key,JSON.stringify({tabId,expires:Date.now()+30000}));
    hasLock=true;
    leaseTimer=setInterval(()=>{
      try{
        const current=JSON.parse(localStorage.getItem(key)||'null');
        if(current?.tabId!==tabId&&current?.expires>Date.now()){loseSession();return;}
        localStorage.setItem(key,JSON.stringify({tabId,expires:Date.now()+30000}));
      }catch{loseSession();}
    },10000);
    return true;
  }catch{
    // In memory-only environments there is no shared persistent state to protect.
    hasLock=store.mode==='memory';return hasLock;
  }
}
function unlockSession(){
  releaseLock?.();releaseLock=null;
  clearInterval(leaseTimer);leaseTimer=null;
  if(lockRunId){try{const key=`hci-workspace.lease.${lockRunId}`,lease=JSON.parse(localStorage.getItem(key)||'null');if(lease?.tabId===tabId)localStorage.removeItem(key);}catch{}}
  hasLock=false;lockRunId=null;
}
function loseSession(){
  if(!hasLock)return;
  hasLock=false;
  clearInterval(leaseTimer);leaseTimer=null;
  recorder?.record('session_lock_lost');
  recorder?.flush().catch(()=>{});
  showLocked();
}
function showLocked(){
  document.getElementById('session-dialog')?.dispatchEvent(new Event('cancel',{cancelable:true}));
  if(document.getElementById('locked-dialog'))return;
  const container=document.createElement('div');container.className='locked-overlay';container.id='locked-dialog';
  container.innerHTML=`<section class="card" role="alertdialog" aria-modal="true" aria-labelledby="locked-title"><div class="eyebrow">SESSION IN USE</div><h2 id="locked-title">다른 탭에서 진행 중입니다.</h2><p class="muted">같은 실행을 두 탭에서 함께 수정할 수 없습니다. 진행 중인 탭을 닫고 여기에서 다시 연결해 주세요.</p><p id="lock-feedback" class="error" role="status"></p><div class="actions">${button('다시 연결','type="button" data-action="retry-lock"')}${button('현재 기록 다운로드','type="button" data-action="download"',true)}</div></section>`;
  document.body.append(container);
  recorder?.overlay(true,'session-lock');
  container.querySelector('button').focus();
  const workspace=document.querySelector('.workspace')||document.querySelector('.practice-wrap');if(workspace)workspace.inert=true;
  app.inert=true;
  container.addEventListener('keydown',event=>{
    if(event.key!=='Tab')return;
    const buttons=container.querySelectorAll('button'),first=buttons[0],last=buttons[buttons.length-1];
    if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
    else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
  });
}
async function enterRun(candidate){
  validateRun(candidate);
  if(recorder){
    try{await recorder.stop();}
    catch(error){logError='저장 대기 기록이 남아 있습니다. 현재 기록을 다운로드한 뒤 다시 연결해 주세요.';paintSaveStatus();throw error;}
  }
  run=clone(candidate);savedRun=null;
  const locked=await acquireSession(run.id);
  if(!locked){render();showLocked();return;}
  try{
    const latest=await store.getRun(run.id);
    if(latest){validateRun(latest);run=clone(latest);}
  }catch(error){savedRun=candidate;run=null;recorder=null;unlockSession();render();throw Error('기기의 최신 기록을 확인하지 못했습니다. 다시 연결하거나 이전 기록을 다운로드해 주세요.');}
  try{localStorage.setItem(ACTIVE,run.id);}catch{}
  recorder=new Recorder({store,onStatus:state=>{if(state?.state==='error')logError=state.message||'행동 기록의 저장이 지연되고 있습니다. 현재 기록을 다운로드해 보관해 주세요.';else if(state?.state==='saved'||state?.state==='memory')logError='';paintSaveStatus();}});
  recorder.start(run);recorder.record('session_opened',{resumed:run.submissions.length>0});
  if(document.getElementById('locked-dialog'))recorder.overlay(true,'session-lock');
  try{await queueSave();}catch{}
  render();
}

function welcome(){
  const matching=savedRun&&(!invitation||savedRun.invitationId===invitation.id);
  const resume=savedRun?`<section class="resume-card card" data-region="saved-session"><span class="eyebrow">이 기기에 보관된 기록</span><h3>${matching?'하던 곳에서 이어갈 수 있어요.':'이전 참여 링크의 기록이 있어요.'}</h3><p><strong class="saved-code">${esc(savedRun.participantCode)}</strong> · ${savedRun.status==='completed'?'완료':'진행 중'}</p><div class="actions">${matching?button(savedRun.status==='completed'?'완료 기록 열기':'이어서 진행','type="button" data-action="resume" data-track="resume-session"'):''}${button('이전 기록 다운로드','type="button" data-action="download-saved"',true)}</div>${!matching?'<p class="hint">새로 시작해도 이전 기록은 덮어쓰지 않습니다.</p>':''}</section>`:'';
  return `<main id="main" tabindex="-1" class="shell welcome desktop-content" data-region="onboarding">${storageWarning()}
    <div class="onboarding-grid"><div class="onboarding-story"><div class="welcome-heading"><div class="eyebrow">판단 워크스페이스 · 팀 파일럿</div><h1>세 가지 업무,<br>당신의 판단으로.</h1><p class="welcome-lead">흩어진 자료를 살펴보고 실행안을 정해 주세요.<br>결정한 뒤에는 새로운 요청과 인계 메모가 기다립니다.</p><div class="intro-tags"><span class="intro-tag">PC 전용</span><span class="intro-tag">시간 제한 없음</span><span class="intro-tag">이 기기에 자동 저장</span></div></div>
    <section class="case-preview" aria-label="체험할 업무"><div class="section-caption">오늘의 업무 목록<span>순서는 실행마다 다를 수 있어요</span></div>${[['01','행사 운영','명단, 인력, 준비 시간을 함께 검토합니다.'],['02','문서 공유','권한과 제출본의 관계를 확인합니다.'],['03','제출 일정','함께 진행할 일과 기다릴 일을 정합니다.']].map(([n,t,d])=>`<div class="case-preview-row"><span class="case-number">${n}</span><div><h2>${t}</h2><p>${d}</p></div><span aria-hidden="true">↗</span></div>`).join('')}</section>
    <section class="card journey-card"><h2>한 업무는 이렇게 진행됩니다.</h2><ol class="journey-list"><li><span>1</span><div><strong>자료 검토 · 실행안 선택</strong><p>원자료를 자유롭게 확인합니다. 일부 실행에는 검토된 AI 지원문이 표시됩니다.</p></div></li><li><span>2</span><div><strong>부담 · 예상 점수 기록</strong><p>결정에 든 노력과 이후 수행의 예상 점수를 남깁니다.</p></div></li><li><span>3</span><div><strong>새 요청 두 개 · 인계 메모</strong><p>AI 지원 없이 원자료로 응답합니다. 모르면 그대로 표시할 수 있습니다.</p></div></li></ol><p class="journey-footnote">먼저 짧게 조작을 연습합니다. 제출한 응답은 수정할 수 없고, 진행 중 정답·점수는 표시되지 않습니다.</p></section>${resume}</div>
    <section class="card start-card" aria-labelledby="start-title"><div class="start-state"><span class="status-dot"></span>${invitation?'배정 링크 확인됨':'팀 자유 체험'}</div><h2 id="start-title">${invitation?'파일럿에 참여하기':'직접 체험해 보세요.'}</h2><p class="muted">${invitation?'제공받은 익명 코드로 진행합니다.':'팀 체험 기록은 본 실험 자료와 구분됩니다.'}</p>${invitationError?`<div class="error" role="alert">${esc(invitationError)}</div>`:''}
    <form id="start-form" class="start-form" novalidate data-region="start-form"><label class="field"><span>익명 참가자 코드</span><input type="text" name="participantCode" data-track="participant-code" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(invitation?.participantCode||'')}" placeholder="예: TEAM01" ${invitation?'readonly':''} required aria-describedby="code-hint"><span id="code-hint" class="hint">이름·학번·연락처는 입력하지 마세요.</span></label>
    <div class="recording-note"><strong>시작 전에 확인해 주세요.</strong><ul><li>응답·수정 이력과 이 페이지 안의 클릭, 자료 노출, 스크롤, 포인터·키보드 조작 유형 등을 기록합니다.</li><li>완료 후 JSON을 내려받아 연구팀에 전달합니다. 서버 자동 제출은 없습니다.</li><li>기록을 보관하고 언제든 중단할 수 있습니다.</li></ul><button class="inline-link" type="button" data-action="privacy" data-track="recording-details">자세한 기록 안내</button></div>
    <label class="check-line"><input type="checkbox" name="consent" required data-track="participation-consent"><span>진행 방식과 기록 안내를 확인했고, 파일럿 참여에 동의합니다.</span></label><div id="form-error" class="error" role="alert" tabindex="-1"></div>${button('동의하고 연습 시작 →','type="submit" data-track="start-session"'+(invitationError?' disabled':''))}<p class="hint start-footnote">완료까지 같은 기기·브라우저를 사용해 주세요.</p></form></section></div></main>`;
}

function practice(){
  const info=stepInfo(run),values=valuesFor(info);
  return `<main id="main" tabindex="-1" class="practice-wrap desktop-content">${storageWarning()}<div class="section-top"><div><div class="eyebrow">QUICK PRACTICE</div><h1>먼저 화면을 익혀볼게요.</h1></div><span class="badge">분석에서 제외되는 연습</span></div><section class="card"><div class="practice-layout"><div class="practice-sample"><span class="sample-label">연습용 자료</span><span class="sample-word">안내</span><p class="muted" style="font-size:15px">오른쪽에서 같은 단어를 선택하고 짧은 메모를 입력해 보세요. 이 연습은 본 업무의 판단 규칙과 관계없습니다.</p></div><form id="step-form" class="practice-question" novalidate data-region="practice-form"><fieldset><legend>자료에 표시된 단어는 무엇인가요?</legend>${['기록','안내','설정'].map(text=>`<label class="choice"><input type="radio" name="practiceChoice" value="${text}" ${values.practiceChoice===text?'checked':''} required><span class="choice-text">${text}</span></label>`).join('')}</fieldset><label class="field" style="margin-top:20px"><span>연습 메모</span><textarea name="practiceMemo" maxlength="200" rows="2" style="min-height:70px" placeholder="예: 자료를 확인했습니다." required>${esc(values.practiceMemo||'')}</textarea></label><div id="form-error" class="error" role="alert" tabindex="-1"></div><div class="response-submit">${button('연습 확인 · 업무 시작 →','type="submit"')}</div></form></div></section><section class="card" style="margin-top:20px"><h2>사례당 평가 점수는 4점입니다.</h2><div class="score-guide"><div><strong>1점</strong>첫 후속 요청</div><div><strong>1점</strong>두 번째 후속 요청</div><div><strong>2점</strong>판단 근거 메모</div></div><p class="muted" style="font-size:15px">근거 메모는 필요한 관계를 정확히 연결하면 2점, 일부 근거만 맞으면 1점, 유효한 근거가 없거나 모르겠으면 0점입니다. 긴 글이나 특별한 표현은 필요하지 않습니다. 예상 점수는 0~4점에서 0.5점 간격으로 고릅니다.</p><p class="notice info" style="margin-top:16px">제출한 응답은 수정할 수 없습니다. 후속 요청은 매번 원래 상황에서 새로 출발하며, 앞 요청의 변경을 이어 붙이지 않습니다. 진행 중에는 정답과 점수를 알려드리지 않습니다.</p></section></main>`;
}
function renderBlock(block,sourceId,index){
  const attrs=`data-source-id="${esc(sourceId)}:${index}"`;
  if(block.type==='list')return `<ul ${attrs}>${block.items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`;
  if(block.type==='table')return `<div class="table-wrap"><table><thead><tr>${block.columns.map(column=>`<th scope="col">${esc(column)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row,r)=>`<tr data-source-id="${esc(sourceId)}:${index}:row:${r}">${row.map((cell,c)=>c===0?`<th scope="row">${esc(cell)}</th>`:`<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return `<p ${attrs}>${esc(block.text)}</p>`;
}
function sourceDocuments(task){
  return `<section class="card brief-card" data-source-id="${esc(task.id)}:brief" data-region="brief"><div class="eyebrow">YOUR BRIEF</div><h2>${esc(task.role)}</h2><p>${esc(task.brief)}</p></section>${task.sources.map(source=>`<section class="card source-document" id="document-${esc(source.id)}" data-track="document:${esc(source.id)}" aria-labelledby="source-${esc(source.id)}"><div class="document-heading"><div><span class="document-label">${esc(source.label)}</span><h2 id="source-${esc(source.id)}" tabindex="-1">${esc(source.title)}</h2></div><span class="document-icon">${icons.document}</span></div><div class="document-body">${source.blocks.map((block,index)=>renderBlock(block,`${task.id}:${source.id}`,index)).join('')}</div></section>`).join('')}`;
}
function aiSupport(task,info){
  if(run.condition==='assisted'&&['decision','estimate'].includes(info.phase))return `<aside class="card ai-card" data-log-id="${esc(task.id)}:ai" data-region="ai-support"><span class="ai-label">${icons.ai}AI 판단 지원</span><h2>${esc(task.ai.title)}</h2>${task.ai.paragraphs.map((paragraph,i)=>`<p data-source-id="${esc(task.id)}:ai:${i}">${esc(paragraph)}</p>`).join('')}<p class="muted" style="font-size:12px;margin-top:16px">연구팀이 미리 작성하고 정확성을 검토한 고정 지원문입니다.</p></aside>`;
  return `<aside class="card support-neutral" data-region="support-context"><strong>${['decision','estimate'].includes(info.phase)?'원자료를 자유롭게 참고하세요.':'지금은 원자료만 참고하는 단계입니다.'}</strong>${['decision','estimate'].includes(info.phase)?'필요한 조건은 왼쪽 자료 안에 있습니다. 충분히 살펴본 뒤 실행안을 정해 주세요.':'이전의 추천·설명은 제공되지 않습니다. 왼쪽 원래 자료와 현재 요청을 함께 확인해 주세요.'}</aside>`;
}
function optionChoices(options,selected,name='choice'){
  return options.map(option=>`<label class="choice" data-log-id="option:${esc(option.id)}" data-track="option:${esc(option.id)}"><input type="radio" name="${name}" value="${esc(option.id)}" ${selected===option.id?'checked':''} required><span class="choice-text"><strong>${esc(option.title)}</strong>${option.description||option.detail?`<small>${esc(option.description||option.detail)}</small>`:''}</span></label>`).join('')+`<label class="choice unknown" data-log-id="option:unknown" data-track="option:unknown"><input type="radio" name="${name}" value="unknown" ${selected==='unknown'?'checked':''} required><span class="choice-text">잘 모르겠습니다</span></label>`;
}
function scale(name,values,selected,prediction=false){
  return `<div class="rating-grid${prediction?' prediction':''}">${values.map(value=>`<label class="rating-choice" data-track="scale:${name}:${value}"><input type="radio" name="${name}" value="${value}" aria-label="${value}${prediction?'점':''}" ${Number(selected)===value&&selected!==undefined?'checked':''} required><span>${value}</span></label>`).join('')}</div>`;
}
function responseForm(task,info){
  const values=valuesFor(info);
  let body='',submit='응답 확정 →';
  if(info.phase==='decision'){
    body=`<div class="eyebrow">MAKE A DECISION</div><fieldset><legend>어떤 실행안을 선택하겠습니까?</legend>${optionChoices(task.plans,values.choice)}</fieldset>`;
    submit='실행안 선택 확정 →';
  }else if(info.phase==='estimate'){
    const initial=run.responses[task.id]?.initial?.choice;
    const selected=task.plans.find(plan=>plan.id===initial)?.title||'잘 모르겠습니다';
    body=`<div class="eyebrow">BEFORE THE NEXT REQUEST</div><h2>지금의 판단을 돌아보세요.</h2><div class="chosen-summary"><span>방금 확정한 응답</span><strong>${esc(selected)}</strong></div><fieldset class="rating-section"><legend class="rating-label">실행안을 결정하는 데 정신적인 노력이 많이 필요했다.</legend>${scale('burden',[1,2,3,4,5,6,7],values.burden)}<div class="rating-ends"><span>1 · 전혀 그렇지 않다</span><span>7 · 매우 그렇다</span></div></fieldset><fieldset class="rating-section"><legend class="rating-label">이후 평가에서 몇 점을 받을 것으로 예상하나요?</legend><p class="prediction-hint">AI 지원 없이 원자료만 보고 후속 요청 2개와 근거 메모에 응답합니다. 선택형 각 1점, 메모 2점으로 총 4점입니다.</p>${scale('prediction',Array.from({length:9},(_,i)=>i/2),values.prediction,true)}<div class="rating-ends"><span>0점</span><span>4점 만점</span></div></fieldset>`;
    submit='예상 점수 확정 · 다음 요청 →';
  }else if(info.phase==='update'){
    const update=task.updates.find(item=>item.id===info.updateId);
    body=`<div class="update-callout" data-region="current-request" data-source-id="${esc(task.id)}:request:${esc(update.id)}"><div class="eyebrow">NEW REQUEST ${info.updateIndex+1} / 2</div><p>${esc(update.notice)}</p></div><fieldset><legend>${esc(update.question)}</legend>${optionChoices(update.options,values.choice)}</fieldset><p class="update-caption">원래 상황에 이번 요청만 적용합니다. 다른 요청의 변경은 누적하지 않습니다.</p>`;
    submit='이번 요청 응답 확정 →';
  }else if(info.phase==='memo'){
    body=`<div class="eyebrow">HANDOVER NOTE</div><h2>다음 담당자에게 메모를 남겨 주세요.</h2><p class="memo-instructions">후속 요청의 변경은 적용하지 않습니다. 원래 업무 상황을 기준으로 적어 주세요.</p><label class="field"><span>${esc(task.memo.prompt)}</span><textarea class="memo-field" name="text" maxlength="2000" ${values.unknown?'disabled':''} placeholder="${esc(task.memo.placeholder||'핵심 이유를 항목으로 짧게 적어도 됩니다.')}" ${values.unknown?'':'required'}>${esc(values.text||'')}</textarea></label><div class="memo-meta"><span>분량보다 조건의 연결을 봅니다.</span><span id="character-count" aria-live="off">${String(values.text||'').length} / 2,000</span></div><label class="check-line"><input type="checkbox" name="unknown" ${values.unknown?'checked':''}><span>잘 모르겠습니다.</span></label>`;
    submit=info.taskIndex===run.assignment.order.length-1?'메모 제출 · 전체 완료 →':'메모 제출 · 다음 업무 →';
  }
  return `<form id="step-form" class="card response-card" novalidate data-region="response-form">${body}<div id="form-error" class="error" role="alert" tabindex="-1"></div><div class="response-submit">${button(submit,'type="submit" data-track="confirm-step"')}<p class="submit-note">확정 후에는 이 응답을 수정할 수 없습니다.</p></div></form>`;
}
function workspace(){
  const info=stepInfo(run),task=taskFor(info.taskId);
  const phaseLabels={decision:'자료를 살펴보고 실행안을 선택하세요.',estimate:'결정 부담과 예상 점수를 기록하세요.',update:'이번 요청만 적용해 새로 판단하세요.',memo:'원래 업무의 판단 근거를 남겨 주세요.'};
  const steps=['실행안 선택','부담·예상 점수','새 요청 1','새 요청 2','인계 메모'];
  const current=info.phase==='decision'?0:info.phase==='estimate'?1:info.phase==='update'?2+info.updateIndex:4;
  const progress=Math.max(0,Math.min(100,Math.round(info.progress<=1?info.progress*100:info.progress)));
  return `<main id="main" tabindex="-1" class="workspace desktop-content"><aside class="workspace-nav" aria-label="업무 진행 상태"><div class="nav-heading">업무 목록</div><ol class="task-nav">${run.assignment.order.map((id,index)=>{const item=taskFor(id);return `<li class="task-nav-item ${index===info.taskIndex?'active':index<info.taskIndex?'complete':''}" ${index===info.taskIndex?'aria-current="step"':''}><span class="nav-index">${index<info.taskIndex?'✓':String(index+1).padStart(2,'0')}</span><div><strong>${esc(item.title)}</strong><span>${index===info.taskIndex?'진행 중':index<info.taskIndex?'응답 완료':'다음 업무'}</span></div></li>`;}).join('')}</ol><div class="nav-session"><span>참가자 코드</span><strong>${esc(run.participantCode)}</strong><span>${run.mode==='demo'?'팀 자유 체험':'배정된 파일럿'}</span></div><div class="nav-note">시간 제한은 없습니다.<br>필요한 자료를 자유롭게 다시 확인하세요.</div>${button('진행 방식 보기','type="button" data-action="help" data-track="open-help"',true)}</aside>
  <section class="workspace-main">${storageWarning()}<div class="workspace-top"><div class="workspace-title"><div class="workspace-eyebrow">업무 ${info.taskIndex+1} / 3</div><h1>${esc(task.title)}</h1><p>${esc(phaseLabels[info.phase])}</p></div><div class="progress-wrap"><div class="progress-label"><span>전체 진행</span><strong>${progress}%</strong></div><div class="progress-track" role="progressbar" aria-label="전체 진행" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style="width:${progress}%"></span></div></div></div>
  <ol class="phase-steps" aria-label="현재 업무 단계">${steps.map((label,index)=>`<li class="${index===current?'current':index<current?'finished':''}" ${index===current?'aria-current="step"':''}><span class="phase-number">${index<current?'✓':index+1}</span><span>${label}</span></li>`).join('')}</ol>
  <div class="workspace-grid"><section class="source-column" data-region="sources" aria-label="판단에 필요한 원자료"><div class="source-toolbar"><div><strong>원자료</strong><span>모든 단계에서 확인할 수 있어요</span></div><nav class="source-shortcuts" aria-label="자료 바로가기">${task.sources.map((source,i)=>`<button type="button" data-action="source-jump" data-source-target="document-${esc(source.id)}" data-track="source-jump:${esc(source.id)}">${i+1}. ${esc(source.label)}</button>`).join('')}</nav></div>${sourceDocuments(task)}</section>
  <section class="decision-column" data-log-id="response-pane" data-region="response" aria-label="현재 단계 응답"><div class="response-pane-heading" tabindex="-1"><span>지금 할 일</span><strong>${esc(steps[current])}</strong></div>${aiSupport(task,info)}${responseForm(task,info)}</section></div></section></main>`;
}

function completed(){
  const finished=run.finishedAt?new Date(run.finishedAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}):'';
  return `<main id="main" tabindex="-1" class="completed-wrap desktop-content">${storageWarning()}<section class="card completion-card"><div class="done-emblem">${icons.check}</div><div class="eyebrow">SESSION COMPLETE</div><h1>세 가지 업무를 모두 마쳤습니다.</h1><p class="muted">이제 응답 파일을 보관해 주세요. 서술형 메모는 연구자가 별도로 채점하므로 이 화면에서는 수행 점수를 표시하지 않습니다.</p><div class="completion-summary"><div><span>익명 참가자 코드</span><strong>${esc(run.participantCode)}</strong></div><div><span>완료한 업무</span><strong>3개</strong></div><div><span>완료 시각</span><strong>${esc(finished)}</strong></div></div><ol class="delivery-steps"><li><span>1</span><div><strong>응답 JSON을 다운로드하세요.</strong><p>아래 버튼을 누른 뒤 브라우저의 다운로드 목록에서 파일을 확인해 주세요.</p></div></li><li><span>2</span><div><strong>연구 담당자에게 파일을 전달하세요.</strong><p>팀에서 안내한 전달 방법을 사용해 주세요. 다운로드만으로 제출되지는 않습니다.</p></div></li></ol><div class="notice info">외부 서버로 자동 전송되지 않습니다. 아래 JSON 파일을 다운로드한 뒤 연구팀이 안내한 방법으로 전달해 주세요.</div><div class="completion-next"><div class="actions">${button('전체 응답 JSON 다운로드','type="button" data-action="download"')}${button('시작 화면으로','type="button" data-action="finish-home"',true)}</div><p id="download-status" class="download-status" aria-live="polite">${exportCount?'다운로드를 요청했습니다. 브라우저의 다운로드 목록에서 파일을 확인해 주세요.':'응답·수정 이력·행동 로그가 하나의 파일에 포함됩니다.'}</p></div>${run.mode==='demo'?'<p class="muted" style="font-size:12px;margin-top:25px">이 실행은 팀 자유 체험으로 표시됩니다. 배정 링크로 진행한 파일럿 자료와 구분됩니다.</p>':''}</section></main>`;
}
function render(){
  const previous=document.querySelector('.source-column');
  if(previous?.dataset.taskId)sourcePositions.set(previous.dataset.taskId,previous.scrollTop);
  const info=run?stepInfo(run):null;
  app.innerHTML=header()+mobile()+(run?(info.phase==='practice'?practice():info.phase==='done'?completed():workspace()):welcome())+footer();
  const source=document.querySelector('.source-column');
  if(source){source.dataset.taskId=info.taskId;source.tabIndex=0;source.scrollTop=sourcePositions.get(info.taskId)||0;}
  const response=document.querySelector('.decision-column');
  if(response){response.tabIndex=0;response.dataset.evaluation=String(['update','memo'].includes(info.phase));}
  bindForms();
  paintSaveStatus();
  if(busy)app.querySelectorAll('button[type="submit"],[data-action="home"],[data-action="download"]').forEach(button=>{button.disabled=true;});
  if(run){
    recorder?.context(run);recorder?.observe(app);
    if(source)recorder?.record('workspace_presented',{sourceScrollTop:source.scrollTop,restored:sourcePositions.has(info.taskId),viewport:{width:window.innerWidth,height:window.innerHeight}});
    if(!hasLock)showLocked();
  }
}
function showError(message){
  const error=document.getElementById('lock-feedback')||document.getElementById('form-error');
  if(error){error.textContent=message;error.focus();}
  recorder?.record('validation_error',{message});
}
function fieldError(field,message){
  if(!field){showError(message);return;}
  const holder=field.closest('fieldset')||field.closest('.field')||field.closest('.check-line')||field.parentElement;
  const id=`error-${field.name}`;
  let error=document.getElementById(id);
  if(!error){error=document.createElement('span');error.id=id;error.className='field-error';error.setAttribute('role','alert');holder.append(error);}
  error.textContent=message;field.setAttribute('aria-invalid','true');
  const described=field.getAttribute('aria-describedby')||'';
  if(!described.split(' ').includes(id))field.setAttribute('aria-describedby',`${described} ${id}`.trim());
  field.focus();recorder?.record('validation_error',{field:field.name,reason:'required_response'});
}
function clearFieldErrors(form){
  form.querySelectorAll('.field-error').forEach(e=>e.remove());
  form.querySelectorAll('[aria-invalid]').forEach(field=>{
    field.removeAttribute('aria-invalid');
    const ids=(field.getAttribute('aria-describedby')||'').split(' ').filter(id=>id&&!id.startsWith('error-'));
    if(ids.length)field.setAttribute('aria-describedby',ids.join(' '));else field.removeAttribute('aria-describedby');
  });
  const summary=form.querySelector('#form-error');if(summary)summary.textContent='';
}
function sessionDialog(kind){
  const content={
    privacy:{title:'무엇이 기록되나요?',body:'<p>응답과 답안 수정본, 클릭·선택 변경, 포인터·스크롤 표본, 자료가 화면에 노출된 구간, 탭·창 상태, 입력·수정·IME 조작 유형을 기록합니다. 입력한 답안 본문은 응답과 수정 이력에 포함됩니다.</p><p>키보드의 모든 문자, 클립보드 내용, 선택한 원문, 다른 앱의 내용은 별도로 수집하지 않습니다. 화면 노출·조작 기록만으로 실제 읽기나 이해를 알 수는 없습니다.</p><p>데이터는 이 기기의 브라우저에 보관됩니다. 브라우저 데이터를 지우기 전에 JSON으로 내려받아 주세요. 연구팀에 파일을 직접 전달하며, 이 사이트에서 자동 전송하지 않습니다.</p>',confirm:'확인했습니다'},
    help:{title:'지금 단계에 집중해 주세요.',body:'<ul><li>왼쪽 자료는 모든 단계에서 확인할 수 있습니다. 자료 바로가기로 원하는 문서로 이동하세요.</li><li>오른쪽에서 현재 요청에 응답합니다. 선택한 뒤 확정하기 전까지는 바꿀 수 있습니다.</li><li>새 요청은 매번 원래 상황에서 출발합니다. 다른 요청의 변경을 누적하지 않습니다.</li><li>인계 메모는 원래 업무를 기준으로 작성합니다. 긴 글보다 조건 사이의 관계가 중요합니다.</li><li>시간 제한은 없습니다. 상단에서 현재 기록을 내려받거나 잠시 나갈 수 있습니다.</li></ul>',confirm:'이어서 진행'},
    pause:{title:'잠시 쉬었다 이어갈까요?',body:'<p>현재 응답과 작성 중인 메모를 이 기기에 저장한 뒤 시작 화면으로 이동합니다. 같은 기기·브라우저에서 이어서 진행할 수 있습니다.</p><p>브라우저 데이터를 지우거나 기기를 바꾸기 전에는 기록 파일도 내려받아 보관해 주세요.</p>',confirm:'저장하고 나가기',cancel:'계속 진행'},
    restart:{title:'새 체험을 시작할까요?',body:'<p>이 기기에 이전 실행이 남아 있습니다. 이전 실행은 보관되지만, 시작 화면의 이어하기는 새 실행으로 바뀝니다. 필요한 이전 기록은 먼저 다운로드해 주세요.</p>',confirm:'새 실행 시작',cancel:'돌아가기'}
  }[kind];
  if(!content||document.getElementById('session-dialog'))return Promise.resolve(false);
  const previous=document.activeElement,dialog=document.createElement('dialog');
  dialog.id='session-dialog';dialog.className='session-dialog';dialog.dataset.region='session-dialog';
  dialog.setAttribute('aria-labelledby','session-dialog-title');
  dialog.innerHTML=`<div class="dialog-body"><div class="eyebrow">참여 안내</div><h2 id="session-dialog-title">${content.title}</h2>${content.body}</div><div class="dialog-actions">${content.cancel?button(content.cancel,'type="button" data-dialog-result="cancel"',true):''}${button(content.confirm,'type="button" data-dialog-result="confirm"')}</div>`;
  document.body.append(dialog);app.inert=true;recorder?.overlay(true,kind);recorder?.record('dialog_opened',{kind});
  try{dialog.showModal();}catch{dialog.setAttribute('open','');}
  return new Promise(resolve=>{
    const finish=accepted=>{app.inert=Boolean(document.getElementById('locked-dialog'));dialog.remove();recorder?.overlay(false,kind);previous?.focus?.({preventScroll:true});recorder?.record('dialog_closed',{kind,accepted});resolve(accepted);};
    dialog.addEventListener('click',event=>{const result=event.target.closest('[data-dialog-result]');if(result)finish(result.dataset.dialogResult==='confirm');});
    dialog.addEventListener('cancel',event=>{event.preventDefault();finish(false);});
    dialog.addEventListener('keydown',event=>{
      if(event.key!=='Tab')return;
      const buttons=[...dialog.querySelectorAll('button')],first=buttons[0],last=buttons.at(-1);
      if(event.shiftKey&&document.activeElement===first){event.preventDefault();last.focus();}
      else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first.focus();}
    });
    dialog.querySelector('button').focus();
  });
}
function focusMain({response=false}={}){
  window.scrollTo({top:0,behavior:'instant'});
  const target=response?document.querySelector('.response-pane-heading'):document.getElementById('main');
  (target||document.getElementById('main'))?.focus({preventScroll:true});
}
function bindForms(){
  const start=document.getElementById('start-form');
  if(start){start.addEventListener('input',()=>clearFieldErrors(start));start.addEventListener('change',()=>clearFieldErrors(start));}
  if(start)start.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||invitationError)return;
    if(window.innerWidth<900){showError('PC 브라우저에서 참여해 주세요.');return;}
    const data=new FormData(start),code=String(data.get('participantCode')||'').trim();
    clearFieldErrors(start);
    if(!code){fieldError(start.elements.namedItem('participantCode'),'익명 참가자 코드를 입력해 주세요.');return;}
    if(!data.get('consent')){fieldError(start.elements.namedItem('consent'),'진행 방식과 기록 안내에 동의해야 시작할 수 있습니다.');return;}
    if(savedRun&&!await sessionDialog('restart'))return;
    busy=true;start.setAttribute('aria-busy','true');start.querySelector('button[type=submit]').disabled=true;start.querySelector('button[type=submit]').textContent='연습 화면 준비 중…';
    try{
      const candidate=createRun({participantCode:code,condition:invitation?.condition||(crypto.getRandomValues(new Uint32Array(1))[0]%2?'assisted':'control'),mode:invitation?'pilot':'demo',order:invitation?.order,updateOrders:invitation?.updateOrders,invitationId:invitation?.id||null});
      await enterRun(candidate);focusMain();
    }catch(error){showError(error.message||'실행을 시작하지 못했습니다.');}
    finally{busy=false;start.removeAttribute('aria-busy');const submit=document.querySelector('#start-form button[type=submit]');if(submit){submit.disabled=false;submit.textContent='동의하고 연습 시작 →';}app.querySelectorAll('button:disabled').forEach(button=>{if(!invitationError)button.disabled=false;});}
  });
  const form=document.getElementById('step-form');
  if(!form)return;
  form.addEventListener('input',()=>{
    clearFieldErrors(form);
    scheduleDraft(form);
    const area=form.elements.namedItem('text');
    if(area){const count=document.getElementById('character-count');if(count)count.textContent=`${area.value.length} / 2,000`;}
  });
  form.addEventListener('change',event=>{
    clearFieldErrors(form);
    if(event.target.name==='unknown'){
      const area=form.elements.namedItem('text');
      area.disabled=event.target.checked;area.required=!event.target.checked;
    }
    scheduleDraft(form);
  });
  form.addEventListener('compositionstart',()=>{composing=true;});
  form.addEventListener('compositionend',()=>{composing=false;scheduleDraft(form);saveDraftNow();});
  form.addEventListener('focusout',()=>{scheduleDraft(form);saveDraftNow();});
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||exporting||!hasLock||composing)return;
    clearFieldErrors(form);
    const data=new FormData(form),info=stepInfo(run);
    let values;
    if(info.phase==='practice'){
      if(data.get('practiceChoice')!=='안내'){fieldError(form.elements.namedItem('practiceChoice')?.[0],'자료에 표시된 단어를 다시 확인해 주세요.');return;}
      if(!String(data.get('practiceMemo')||'').trim()){fieldError(form.elements.namedItem('practiceMemo'),'연습 메모를 짧게 입력해 주세요.');return;}
      values={complete:true};
    }else if(info.phase==='decision'||info.phase==='update'){
      if(!data.get('choice')){fieldError(form.querySelector('input[name=choice]'),'응답 하나를 선택해 주세요. 모르면 ‘잘 모르겠습니다’를 고를 수 있습니다.');return;}
      values={choice:String(data.get('choice'))};
    }
    else if(info.phase==='estimate'){
      if(data.get('burden')===null){fieldError(form.querySelector('input[name=burden]'),'정신적 노력의 정도를 선택해 주세요.');return;}
      if(data.get('prediction')===null){fieldError(form.querySelector('input[name=prediction]'),'0~4점에서 예상 점수를 선택해 주세요.');return;}
      values={burden:Number(data.get('burden')),prediction:Number(data.get('prediction'))};
    }else {
      if(!data.get('unknown')&&!String(data.get('text')||'').trim()){fieldError(form.elements.namedItem('text'),'근거 메모를 작성하거나 ‘잘 모르겠습니다’를 선택해 주세요.');return;}
      values=data.get('unknown')?{unknown:true}:{text:String(data.get('text')||'').trim()};
    }
    busy=true;form.setAttribute('aria-busy','true');const submitButton=form.querySelector('button[type=submit]'),submitLabel=submitButton.textContent;submitButton.disabled=true;submitButton.textContent='응답 저장 중…';
    app.querySelectorAll('button[data-action=home],button[data-action=download]').forEach(button=>{button.disabled=true;});
    try{
      await saveDraftNow();
      const next=submitStep(run,values);
      recorder?.record('step_submitted',{phase:info.phase,taskId:info.taskId,updateId:info.updateId});
      clearDraftTimers();
      await queueSave(next);
      run=next;recorder?.context(run);
      recorder?.record('step_entered',{phase:stepInfo(run).phase});
      try{await recorder?.flush();}catch{logError='응답은 저장됐지만 일부 행동 기록은 저장 대기 중입니다. 창을 닫기 전 기록을 다운로드해 주세요.';}
      render();focusMain({response:info.phase!=='practice'});
    }catch(error){showError(error.message||'응답을 확정하지 못했습니다. 다시 시도해 주세요.');}
    finally{busy=false;form.removeAttribute('aria-busy');if(submitButton.isConnected)submitButton.textContent=submitLabel;app.querySelectorAll('button:disabled').forEach(button=>{button.disabled=false;});}
  });
}
async function downloadRun(target=run||savedRun){
  if(!target||exporting||busy)return;
  exporting=true;app.querySelectorAll('[data-action=download],[data-action=download-saved]').forEach(button=>{button.disabled=true;});
  app.querySelectorAll('button[data-action=home],button[data-action=resume],#step-form button[type=submit]').forEach(button=>{button.disabled=true;});
  const editingForm=document.getElementById('step-form');if(editingForm)editingForm.inert=true;
  try{
    const warnings=[];
    if(target===run){
      recorder?.record('export_requested',{status:run.status});recorder?.checkpoint('export');
      if(hasLock){
        await saveDraftNow();await writeQueue;
        try{await queueSave();}catch{warnings.push('최신 응답의 기기 저장에 실패해 현재 탭의 응답을 직접 포함했습니다.');}
      }else warnings.push('이 탭은 실행을 수정할 권한을 잃었습니다. 현재 탭의 복구 기록이며 다른 탭의 최신 응답과 다를 수 있습니다.');
      try{await recorder?.flush();}catch{warnings.push('일부 행동 기록이 아직 기기 저장소에 저장되지 않아 전송 대기열에서 포함했습니다.');}
      target=run;
    }else{
      try{const latest=await store.getRun(target.id);if(latest)target=latest;}catch{warnings.push('기기에 저장된 최신 응답을 확인하지 못해 이 화면의 보관본을 포함했습니다.');}
    }
    let persisted=[];
    try{persisted=await store.eventsForRun(target.id);}catch{warnings.push('이전에 저장된 행동 기록을 읽지 못했습니다. 이 파일의 행동 로그는 불완전할 수 있습니다.');}
    const pending=target===run?recorder?.pendingEvents()||[]:[];
    const events=[...new Map([...persisted,...pending].map(event=>[event.id,event])).values()];
    if(warnings.length){
      const info=stepInfo(target);
      events.push({id:crypto.randomUUID(),runId:target.id,pageId:`export-${crypto.randomUUID()}`,sequence:1,at:new Date().toISOString(),monotonicMs:performance.now(),phase:info.phase,taskId:info.taskId,updateId:info.updateId,type:'export_warning',data:{warnings,persistedCount:persisted.length,pendingCount:pending.length}});
    }
    const envelope=makeEnvelope(target,events);
    const blob=new Blob([JSON.stringify(envelope,null,2)],{type:'application/json;charset=utf-8'});
    const url=URL.createObjectURL(blob),a=document.createElement('a');
    a.href=url;a.download=`hci_${warnings.length?'recovery_':''}${String(target.participantCode).replace(/[^A-Za-z0-9_-]/g,'_')}_${target.id.slice(0,8)}.json`;
    document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500);
    exportCount++;
    const label=document.getElementById('download-status');if(label)label.textContent=warnings.length?'복구용 기록 파일을 만들었습니다. 파일에 저장 문제를 표시했으니 연구팀에도 알려 주세요.':'다운로드를 요청했습니다. 브라우저의 다운로드 목록에서 파일을 확인해 주세요.';
    if(warnings.length){saveError=warnings.join(' ');paintSaveStatus();}
  }catch(error){
    saveError=`파일을 만들지 못했습니다. 이 창을 닫지 말고 다시 시도해 주세요. (${error.message||'내보내기 실패'})`;
    paintSaveStatus();showError(saveError);
  }finally{exporting=false;if(editingForm)editingForm.inert=false;enableSessionButtons();app.querySelectorAll('[data-action=download],[data-action=download-saved]').forEach(button=>{button.disabled=false;});}
}
function enableSessionButtons(){
  app.querySelectorAll('#step-form button[type=submit],button[data-action=home],button[data-action=download],button[data-action=resume]').forEach(button=>{button.disabled=false;});
}
async function goHome(){
  if(busy||exporting)return;
  if(!run){focusMain();return;}
  if(run.status!=='completed'&&!await sessionDialog('pause'))return;
  busy=true;
  try{
    await saveDraftNow();await writeQueue;
    try{await queueSave();}
    catch{showError('응답을 기기에 저장하지 못해 시작 화면으로 이동하지 않았습니다. 현재 기록을 다운로드하거나 저장이 복구된 뒤 다시 시도해 주세요.');return;}
    try{await recorder?.stop();}
    catch(error){
      recorder?.start(run);
      logError='일부 행동 기록을 저장하지 못해 시작 화면으로 이동하지 않았습니다. 현재 기록을 다운로드해 보관하거나 저장이 복구된 뒤 다시 시도해 주세요.';
      paintSaveStatus();showError(logError);return;
    }
    savedRun=run;run=null;recorder=null;unlockSession();clearDraftTimers();app.inert=false;
    document.getElementById('locked-dialog')?.remove();render();focusMain();
  }finally{busy=false;enableSessionButtons();}
}

document.addEventListener('click',async event=>{
  const skip=event.target.closest('.skip-link');
  if(skip){event.preventDefault();document.getElementById('main')?.focus();return;}
  const control=event.target.closest('[data-action]');if(!control)return;
  event.preventDefault();const action=control.dataset.action;
  if(['help','privacy'].includes(action)){await sessionDialog(action);return;}
  if(action==='source-jump'){
    const target=document.getElementById(control.dataset.sourceTarget);if(!target)return;
    const heading=target.querySelector('h2');
    target.scrollIntoView?.({block:'start',behavior:'instant'});heading?.focus({preventScroll:true});
    document.querySelectorAll('[data-action=source-jump]').forEach(button=>button.setAttribute('aria-pressed',String(button===control)));
    recorder?.record('source_jump',{sourceId:control.dataset.sourceTarget,from:'source-shortcuts'});return;
  }
  if(action==='download'){await downloadRun();return;}
  if(action==='download-saved'){await downloadRun(savedRun);return;}
  if(action==='resume'){if(busy||exporting)return;busy=true;try{await enterRun(savedRun);focusMain();}catch(error){showError(error.message);}finally{busy=false;enableSessionButtons();}return;}
  if(action==='retry-lock'){
    if(busy||exporting)return;busy=true;
    try{
      if(await acquireSession(run.id)){
        await enterRun(run);
        document.getElementById('locked-dialog')?.remove();app.inert=false;recorder?.overlay(false,'session-lock');focusMain();
      }else{document.getElementById('lock-feedback').textContent='아직 다른 탭이 사용 중입니다. 그 탭을 닫은 뒤 다시 연결해 주세요.';}
    }catch(error){unlockSession();if(!run){document.getElementById('locked-dialog')?.remove();app.inert=false;}showError(error.message);}
    finally{busy=false;enableSessionButtons();}
    return;
  }
  if(action==='home'||action==='finish-home')await goHome();
});
document.addEventListener('visibilitychange',()=>{
  if(document.visibilityState==='hidden'){saveDraftNow();recorder?.flush().catch(()=>{});}
});
window.addEventListener('beforeunload',()=>{
  if(latestDraft&&!composing)saveDraftNow();
  recorder?.flush().catch(()=>{});
});
window.addEventListener('pagehide',()=>{unlockSession();});
window.addEventListener('pageshow',event=>{if(event.persisted&&run)store.getRun(run.id).then(saved=>enterRun(saved||run)).catch(()=>showLocked());});
window.addEventListener('storage',event=>{
  if(event.key===`hci-workspace.lease.${lockRunId}`&&hasLock){try{const value=JSON.parse(event.newValue||'null');if(value?.tabId!==tabId&&value?.expires>Date.now())loseSession();}catch{}}
});
window.addEventListener('hashchange',()=>{
  if(location.hash!==initialHash){history.replaceState(null,'',location.pathname+location.search+initialHash);}
});

async function boot(){
  try{invitation=parseInvitation(location.hash);}catch(error){invitationError=error.message||'유효하지 않은 참여 링크입니다. 연구팀에 새 링크를 요청해 주세요.';}
  try{await store.init();}catch(error){saveError='브라우저 저장소를 열지 못했습니다. 창을 닫기 전 응답 파일을 보관해 주세요.';}
  try{
    const active=localStorage.getItem(ACTIVE);
    if(active){const previous=await store.getRun(active);if(previous){validateRun(previous);savedRun=previous;}}
  }catch{saveError='이전에 저장된 실행을 자동으로 복원하지 못했습니다. 기존 파일이 있다면 연구자 도구에서 확인해 주세요.';}
  render();
}
boot().catch(error=>{
  app.innerHTML=header()+`<main class="shell blocked-wrap"><section class="card"><h1>작업 공간을 열지 못했습니다.</h1><p class="error">${esc(error.message||'초기화 오류')}</p><p>페이지를 새로고침해 주세요. 같은 문제가 계속되면 연구팀에 알려 주세요.</p>${button('다시 열기','type="button" onclick="location.reload()"')}</section></main>`;
});
