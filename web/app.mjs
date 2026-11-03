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
const initialHash = location.hash;

const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clone = value => structuredClone(value);
const taskFor = id => TASKS.find(task=>task.id===id);
const draftKey = info => [info.phase,info.taskId||'',info.updateId||''].join(':');
const valuesFor = info => run?.draft?.key===draftKey(info) ? run.draft.values : {};
const button = (label,attrs='',secondary=false) => `<button class="button${secondary?' secondary':''}" ${attrs}>${label}</button>`;
const footer = () => `<footer class="site-footer"><div class="shell"><span>판단 워크스페이스 · 팀 파일럿 ${esc(STUDY.version)}</span><span>응답은 이 브라우저에 저장됩니다. <a href="./research.html">연구자 도구</a></span></div></footer>`;
const mobile = () => `<section class="mobile-gate shell"><div class="card desktop-notice">${icons.screen}<div><div class="eyebrow">PC BROWSER REQUIRED</div><h1>PC에서 이어서 참여해 주세요.</h1><p class="muted">자료를 나란히 비교하는 과제입니다. 창 너비가 900px 이상인 PC 브라우저에서 이 주소를 열어 주세요.</p><p class="muted">이미 작성한 응답은 현재 기기의 브라우저에 저장됩니다. 다른 기기로 자동 이동되지는 않습니다.</p></div></div></section>`;

function header(){
  return `<header class="site-header"><div class="shell"><a class="brand" href="./index.html" data-action="home"> <span class="brand-mark">${icons.brand}</span><span>판단 워크스페이스</span></a><div class="header-meta"><span>자료를 살펴보고, 다음 행동을 정합니다.</span><span id="save-status" role="status" aria-live="polite">${statusText()}</span>${run?button('기록 다운로드','type="button" data-action="download"',true).replace('class="button secondary"','class="button secondary small"'):''}</div></div></header>`;
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
  const warning=document.getElementById('storage-warning');
  if(warning){
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
  const operation=writeQueue.then(()=>store.saveRun(data));
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
  lastDraftJSON=json;
  recorder?.record('draft_revision',{field:draft.key,value:draft.values});
  try{await queueSave();}catch{}
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
  if(document.getElementById('locked-dialog'))return;
  const container=document.createElement('div');container.className='locked-overlay';container.id='locked-dialog';
  container.innerHTML=`<section class="card" role="alertdialog" aria-modal="true" aria-labelledby="locked-title"><div class="eyebrow">SESSION IN USE</div><h2 id="locked-title">다른 탭에서 진행 중입니다.</h2><p class="muted">같은 실행을 두 탭에서 함께 수정할 수 없습니다. 진행 중인 탭을 닫고 여기에서 다시 연결해 주세요.</p><div class="actions">${button('다시 연결','type="button" data-action="retry-lock"')}${button('현재 기록 다운로드','type="button" data-action="download"',true)}</div></section>`;
  document.body.append(container);
  container.querySelector('button').focus();
  const workspace=document.querySelector('.workspace')||document.querySelector('.practice-wrap');if(workspace)workspace.inert=true;
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
  try{localStorage.setItem(ACTIVE,run.id);}catch{}
  recorder=new Recorder({store,onStatus:state=>{if(state?.state==='error')logError=state.message||'행동 기록의 저장이 지연되고 있습니다. 현재 기록을 다운로드해 보관해 주세요.';else if(state?.state==='saved'||state?.state==='memory')logError='';paintSaveStatus();}});
  recorder.start(run);recorder.record('session_opened',{resumed:run.submissions.length>0});
  try{await queueSave();}catch{}
  render();
}

function welcome(){
  const matching=savedRun&&(!invitation||savedRun.invitationId===invitation.id);
  const resume=savedRun?`<section class="card resume-card"><h3>${matching?'이 기기에 저장된 실행이 있습니다.':'다른 참여 링크의 기록이 남아 있습니다.'}</h3><p>참가자 코드 <strong class="saved-code">${esc(savedRun.participantCode)}</strong> · ${savedRun.status==='completed'?'완료한 기록':'진행 중인 기록'}</p><div class="actions">${matching?button(savedRun.status==='completed'?'완료 기록 열기':'이어서 진행','type="button" data-action="resume"'):''}${button('이전 기록 다운로드','type="button" data-action="download-saved"',true)}</div>${!matching?'<p class="muted" style="margin-top:12px">새 링크를 시작해도 이전 기록은 덮어쓰지 않습니다. 기기를 공유한다면 먼저 이전 기록을 보관해 주세요.</p>':''}</section>`:'';
  return `<main id="main" tabindex="-1" class="shell welcome desktop-content"><section class="welcome-top"><div><div class="eyebrow">DECISION WORKSPACE / TEAM PILOT</div><h1>자료를 연결하고,<br>다음 행동을 정해 보세요.</h1><p class="welcome-lead">행사 예약, 문서 공유, 팀 과제 제출.<br>세 가지 가상의 업무에서 자료를 살펴보고 실행안을 정합니다. 이후 도착하는 새 요청에도 대응합니다.</p><div class="intro-tags"><span class="intro-tag">PC 브라우저</span><span class="intro-tag">세 가지 업무</span><span class="intro-tag">${esc(STUDY.duration)}</span></div></div><div class="welcome-visual" aria-hidden="true"><div class="visual-title"><span>Your workspace</span><span>3 tasks</span></div><div class="mini-document"><div class="mini-document-title">${icons.document}팀에서 도착한 요청</div><div class="mini-line"></div><div class="mini-line short"></div></div><div class="mini-document"><div class="mini-document-title">${icons.document}정책과 현재 상태</div><div class="mini-line"></div><div class="mini-line short"></div></div><div class="mini-selection"><span>자료를 바탕으로 실행안 선택</span><span class="mini-check">✓</span></div></div></section><section class="welcome-bottom"><div class="stack"><div class="card"><div class="eyebrow">BEFORE YOU BEGIN</div><h2>이렇게 진행합니다.</h2><ol class="process-list"><li><span class="step-number">01</span><div><strong>원자료를 살펴보고 실행안을 선택합니다.</strong><p>모든 판단에 필요한 자료는 화면에 있습니다. 일부 실행에는 미리 작성하고 검토한 AI 지원문이 제공됩니다.</p></div></li><li><span class="step-number">02</span><div><strong>스스로 예상한 수행을 기록합니다.</strong><p>결정 부담과 이후 평가의 예상 점수를 묻습니다. 사례당 선택형 2점, 설명 2점으로 총 4점입니다.</p></div></li><li><span class="step-number">03</span><div><strong>새 요청에 대응하고 인계 메모를 남깁니다.</strong><p>원자료는 계속 볼 수 있고 AI 지원은 제공되지 않습니다. 속도 경쟁이 아니며 모르면 그대로 응답할 수 있습니다.</p></div></li></ol></div>${resume}</div><section class="card"><div class="eyebrow">START A SESSION</div><h2>${invitation?'초대받은 파일럿 시작':'팀 체험 시작'}</h2><p class="muted" style="font-size:13px">${invitation?'배정된 참여 링크로 진행합니다. 이름 대신 제공받은 참가자 코드를 사용해 주세요.':'자유 체험 실행입니다. 본 실험 자료와 구분해 저장됩니다.'}</p>${invitationError?`<div class="error" role="alert">${esc(invitationError)}</div>`:''}<form id="start-form" class="start-form"><label class="field"><span>익명 참가자 코드</span><input type="text" name="participantCode" maxlength="40" autocomplete="off" spellcheck="false" value="${esc(invitation?.participantCode||'')}" placeholder="예: TEAM01" ${invitation?'readonly':''} required><span class="hint">이름·학번·연락처는 입력하지 마세요.</span></label><label class="check-line"><input type="checkbox" name="consent" required><span>진행 방식과 아래 기록 안내를 확인했으며, 파일럿 참여에 동의합니다.</span></label><div id="form-error" class="error" role="alert" tabindex="-1"></div>${button('안내 및 연습 시작 →','type="submit"'+(invitationError?' disabled':''))}<div class="privacy-note"><strong>기록 안내</strong><br>응답, 답안 수정본, 클릭·스크롤·화면 노출·탭 전환 등 이 웹 안의 행동을 수집합니다. 모든 장소와 도구 규칙은 연구용 가상 설정입니다.<br><br>기록은 이 기기의 브라우저에 저장되며 외부 서버로 자동 전송되지 않습니다. 완료 후 JSON 파일을 다운로드해 연구자에게 전달해야 합니다. 브라우저 데이터를 지우면 기록이 사라질 수 있습니다. 언제든 현재 기록을 보관하고 참여를 중단할 수 있습니다.</div></form></section></section></main>`;
}
function practice(){
  const info=stepInfo(run),values=valuesFor(info);
  return `<main id="main" tabindex="-1" class="practice-wrap desktop-content">${storageWarning()}<div class="section-top"><div><div class="eyebrow">QUICK PRACTICE</div><h1>먼저 화면을 익혀볼게요.</h1></div><span class="badge">분석에서 제외되는 연습</span></div><section class="card"><div class="practice-layout"><div class="practice-sample"><span class="sample-label">연습용 자료</span><span class="sample-word">안내</span><p class="muted" style="font-size:13px">오른쪽에서 같은 단어를 선택하고 짧은 메모를 입력해 보세요. 이 연습은 본 업무의 판단 규칙과 관계없습니다.</p></div><form id="step-form" class="practice-question"><fieldset><legend>자료에 표시된 단어는 무엇인가요?</legend>${['기록','안내','설정'].map(text=>`<label class="choice"><input type="radio" name="practiceChoice" value="${text}" ${values.practiceChoice===text?'checked':''} required><span class="choice-text">${text}</span></label>`).join('')}</fieldset><label class="field" style="margin-top:20px"><span>연습 메모</span><textarea name="practiceMemo" maxlength="200" rows="2" style="min-height:70px" placeholder="예: 자료를 확인했습니다." required>${esc(values.practiceMemo||'')}</textarea></label><div id="form-error" class="error" role="alert" tabindex="-1"></div><div class="response-submit">${button('연습 확인 · 업무 시작 →','type="submit"')}</div></form></div></section><section class="card" style="margin-top:20px"><h2>사례당 평가 점수는 4점입니다.</h2><div class="score-guide"><div><strong>1점</strong>첫 후속 요청</div><div><strong>1점</strong>두 번째 후속 요청</div><div><strong>2점</strong>판단 근거 메모</div></div><p class="muted" style="font-size:13px">근거 메모는 필요한 관계를 정확히 연결하면 2점, 일부 근거만 맞으면 1점, 유효한 근거가 없거나 모르겠으면 0점입니다. 긴 글이나 특별한 표현은 필요하지 않습니다. 예상 점수는 0~4점에서 0.5점 간격으로 고릅니다.</p><p class="notice info" style="margin-top:16px">제출한 응답은 수정할 수 없습니다. 후속 요청은 매번 원래 상황에서 새로 출발하며, 앞 요청의 변경을 이어 붙이지 않습니다. 진행 중에는 정답과 점수를 알려드리지 않습니다.</p></section></main>`;
}
function renderBlock(block,sourceId,index){
  const attrs=`data-source-id="${esc(sourceId)}:${index}"`;
  if(block.type==='list')return `<ul ${attrs}>${block.items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`;
  if(block.type==='table')return `<div class="table-wrap"><table><thead><tr>${block.columns.map(column=>`<th scope="col">${esc(column)}</th>`).join('')}</tr></thead><tbody>${block.rows.map((row,r)=>`<tr data-source-id="${esc(sourceId)}:row:${r}">${row.map((cell,c)=>c===0?`<th scope="row">${esc(cell)}</th>`:`<td>${esc(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
  return `<p ${attrs}>${esc(block.text)}</p>`;
}
function sourceDocuments(task){
  return `<section class="card brief-card" data-source-id="${esc(task.id)}:brief"><div class="eyebrow">YOUR BRIEF</div><h2>${esc(task.role)}</h2><p>${esc(task.brief)}</p></section>${task.sources.map(source=>`<section class="card source-document" aria-labelledby="source-${esc(source.id)}"><div class="document-heading"><div><span class="document-label">${esc(source.label)}</span><h2 id="source-${esc(source.id)}">${esc(source.title)}</h2></div><span class="document-icon">${icons.document}</span></div><div class="document-body">${source.blocks.map((block,index)=>renderBlock(block,`${task.id}:${source.id}`,index)).join('')}</div></section>`).join('')}`;
}
function aiSupport(task,info){
  if(run.condition==='assisted'&&['decision','estimate'].includes(info.phase))return `<aside class="card ai-card" data-log-id="${esc(task.id)}:ai"><span class="ai-label">${icons.ai}AI 판단 지원</span><h2>${esc(task.ai.title)}</h2>${task.ai.paragraphs.map((paragraph,i)=>`<p data-source-id="${esc(task.id)}:ai:${i}">${esc(paragraph)}</p>`).join('')}<p class="muted" style="font-size:10px;margin-top:16px">연구팀이 미리 작성하고 정확성을 검토한 고정 지원문입니다.</p></aside>`;
  return `<aside class="card support-neutral"><strong>${['decision','estimate'].includes(info.phase)?'원자료를 자유롭게 참고하세요.':'지금은 원자료만 참고하는 단계입니다.'}</strong>${['decision','estimate'].includes(info.phase)?'필요한 조건은 왼쪽 자료 안에 있습니다. 충분히 살펴본 뒤 실행안을 정해 주세요.':'이전의 추천·설명은 제공되지 않습니다. 왼쪽 원래 자료와 현재 요청을 함께 확인해 주세요.'}</aside>`;
}
function optionChoices(options,selected,name='choice'){
  return options.map(option=>`<label class="choice" data-log-id="option:${esc(option.id)}"><input type="radio" name="${name}" value="${esc(option.id)}" ${selected===option.id?'checked':''} required><span class="choice-text"><strong>${esc(option.title)}</strong>${option.description||option.detail?`<small>${esc(option.description||option.detail)}</small>`:''}</span></label>`).join('')+`<label class="choice unknown" data-log-id="option:unknown"><input type="radio" name="${name}" value="unknown" ${selected==='unknown'?'checked':''} required><span class="choice-text">잘 모르겠습니다</span></label>`;
}
function scale(name,values,selected,prediction=false){
  return `<div class="rating-grid${prediction?' prediction':''}">${values.map(value=>`<label class="rating-choice"><input type="radio" name="${name}" value="${value}" ${Number(selected)===value&&selected!==undefined?'checked':''} required><span>${value}</span></label>`).join('')}</div>`;
}
function responseForm(task,info){
  const values=valuesFor(info);
  let body='',submit='응답 확정 →';
  if(info.phase==='decision'){
    body=`<div class="eyebrow">MAKE A DECISION</div><fieldset><legend>어떤 실행안을 선택하겠습니까?</legend>${optionChoices(task.plans,values.choice)}</fieldset>`;
    submit='실행안 선택 확정 →';
  }else if(info.phase==='estimate'){
    body=`<div class="eyebrow">BEFORE THE NEXT REQUEST</div><h2>지금의 판단을 돌아보세요.</h2><fieldset class="rating-section"><legend class="rating-label">실행안을 결정하는 데 정신적인 노력이 많이 필요했다.</legend>${scale('burden',[1,2,3,4,5,6,7],values.burden)}<div class="rating-ends"><span>1 · 전혀 그렇지 않다</span><span>7 · 매우 그렇다</span></div></fieldset><fieldset class="rating-section"><legend class="rating-label">이후 평가에서 몇 점을 받을 것으로 예상하나요?</legend><p class="prediction-hint">AI 지원 없이 원자료만 보고 후속 요청 2개와 근거 메모에 응답합니다. 선택형 각 1점, 메모 2점으로 총 4점입니다.</p>${scale('prediction',Array.from({length:9},(_,i)=>i/2),values.prediction,true)}<div class="rating-ends"><span>0점</span><span>4점 만점</span></div></fieldset>`;
    submit='예상 점수 확정 · 다음 요청 →';
  }else if(info.phase==='update'){
    const update=task.updates.find(item=>item.id===info.updateId);
    body=`<div class="update-callout" data-source-id="${esc(task.id)}:request:${esc(update.id)}"><div class="eyebrow">NEW REQUEST ${info.updateIndex+1} / 2</div><p>${esc(update.notice)}</p></div><fieldset><legend>${esc(update.question)}</legend>${optionChoices(update.options,values.choice)}</fieldset><p class="update-caption">원래 상황에 이번 요청만 적용합니다. 다른 요청의 변경은 누적하지 않습니다.</p>`;
    submit='이번 요청 응답 확정 →';
  }else if(info.phase==='memo'){
    body=`<div class="eyebrow">HANDOVER NOTE</div><h2>다음 담당자에게 메모를 남겨 주세요.</h2><p class="memo-instructions">후속 요청의 변경은 적용하지 않습니다. 원래 업무 상황을 기준으로 적어 주세요.</p><label class="field"><span>${esc(task.memo.prompt)}</span><textarea class="memo-field" name="text" maxlength="2000" ${values.unknown?'disabled':''} placeholder="${esc(task.memo.placeholder||'핵심 이유를 항목으로 짧게 적어도 됩니다.')}" ${values.unknown?'':'required'}>${esc(values.text||'')}</textarea></label><div class="memo-meta"><span>분량보다 조건의 연결을 봅니다.</span><span id="character-count">${String(values.text||'').length} / 2,000</span></div><label class="check-line"><input type="checkbox" name="unknown" ${values.unknown?'checked':''}><span>잘 모르겠습니다.</span></label>`;
    submit=info.taskIndex===run.assignment.order.length-1?'메모 제출 · 전체 완료 →':'메모 제출 · 다음 업무 →';
  }
  return `<form id="step-form" class="card response-card">${body}<div id="form-error" class="error" role="alert" tabindex="-1"></div><div class="response-submit">${button(submit,'type="submit"')}<p class="submit-note">확정 후에는 이 응답을 수정할 수 없습니다.</p></div></form>`;
}
function workspace(){
  const info=stepInfo(run),task=taskFor(info.taskId);
  const phaseLabels={decision:'자료 검토와 실행안 선택',estimate:'결정 부담과 예상 점수',update:'새 요청에 대응',memo:'원래 업무의 인계 메모'};
  const progress=info.progress<=1?Math.round(info.progress*100):Math.round(info.progress);
  return `<main id="main" tabindex="-1" class="workspace desktop-content"><nav class="workspace-nav" aria-label="업무 진행"><div class="nav-heading">Your workspace</div><div class="task-nav">${run.assignment.order.map((id,index)=>{const item=taskFor(id);return `<div class="task-nav-item ${index===info.taskIndex?'active':index<info.taskIndex?'complete':''}" ${index===info.taskIndex?'aria-current="step"':''}><span class="nav-index">${index<info.taskIndex?'✓':String(index+1).padStart(2,'0')}</span><div><strong>${esc(item.title)}</strong><span>${index===info.taskIndex?'진행 중':index<info.taskIndex?'응답 완료':'다음 업무'}</span></div></div>`;}).join('')}</div><div class="nav-note">세 가지 가상 업무입니다.<br>모든 판단에 필요한 정보는 원자료에 있습니다.<br><br>각 후속 요청은 원래 상황에서 독립적으로 적용합니다.</div></nav><section class="workspace-main">${storageWarning()}<div class="workspace-top"><div class="workspace-title"><div class="workspace-eyebrow">WORKSPACE ${info.taskIndex+1} / 3 <span class="badge teal">${esc(phaseLabels[info.phase])}</span></div><h1>${esc(task.title)}</h1><p>${esc(task.subtitle||'자료를 연결해 다음 행동을 정해 주세요.')}</p></div><div class="progress-wrap"><div class="progress-label"><span>전체 진행</span><strong>${Math.max(0,Math.min(100,progress))}%</strong></div><div class="progress-track" role="progressbar" aria-label="전체 진행" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.max(0,Math.min(100,progress))}"><span style="width:${Math.max(0,Math.min(100,progress))}%"></span></div></div></div><div class="workspace-grid"><div class="source-column">${sourceDocuments(task)}</div><div class="decision-column" data-log-id="response-pane">${aiSupport(task,info)}${responseForm(task,info)}</div></div></section></main>`;
}
function completed(){
  const finished=run.finishedAt?new Date(run.finishedAt).toLocaleTimeString('ko-KR',{hour:'2-digit',minute:'2-digit'}):'';
  return `<main id="main" tabindex="-1" class="completed-wrap desktop-content">${storageWarning()}<section class="card completion-card"><div class="done-emblem">${icons.check}</div><div class="eyebrow">SESSION COMPLETE</div><h1>세 가지 업무를 모두 마쳤습니다.</h1><p class="muted">이제 응답 파일을 보관해 주세요. 서술형 메모는 연구자가 별도로 채점하므로 이 화면에서는 수행 점수를 표시하지 않습니다.</p><div class="completion-summary"><div><span>익명 참가자 코드</span><strong>${esc(run.participantCode)}</strong></div><div><span>완료한 업무</span><strong>3개</strong></div><div><span>완료 시각</span><strong>${esc(finished)}</strong></div></div><div class="notice info">외부 서버로 자동 전송되지 않습니다. 아래 JSON 파일을 다운로드한 뒤 연구팀이 안내한 방법으로 전달해 주세요.</div><div class="completion-next"><div class="actions">${button('전체 응답 JSON 다운로드','type="button" data-action="download"')}${button('시작 화면으로','type="button" data-action="finish-home"',true)}</div><p id="download-status" class="download-status" aria-live="polite">${exportCount?'다운로드를 요청했습니다. 브라우저의 다운로드 목록에서 파일을 확인해 주세요.':'응답·수정 이력·행동 로그가 하나의 파일에 포함됩니다.'}</p></div>${run.mode==='demo'?'<p class="muted" style="font-size:12px;margin-top:25px">이 실행은 팀 자유 체험으로 표시됩니다. 배정 링크로 진행한 파일럿 자료와 구분됩니다.</p>':''}</section></main>`;
}
function render(){
  const info=run?stepInfo(run):null;
  app.innerHTML=header()+mobile()+(run?(info.phase==='practice'?practice():info.phase==='done'?completed():workspace()):welcome())+footer();
  bindForms();
  if(run){recorder?.context(run);recorder?.observe(app);if(!hasLock)showLocked();}
}
function showError(message){
  const error=document.getElementById('form-error');
  if(error){error.textContent=message;error.focus();}
}
function focusMain(){
  window.scrollTo({top:0,behavior:'instant'});
  document.getElementById('main')?.focus({preventScroll:true});
}
function bindForms(){
  const start=document.getElementById('start-form');
  if(start)start.addEventListener('submit',async event=>{
    event.preventDefault();if(busy||invitationError)return;
    if(window.innerWidth<900){showError('PC 브라우저에서 참여해 주세요.');return;}
    const data=new FormData(start),code=String(data.get('participantCode')||'').trim();
    if(!code){showError('익명 참가자 코드를 입력해 주세요.');return;}
    if(!data.get('consent')){showError('진행 방식과 기록 안내를 확인해 주세요.');return;}
    if(savedRun&&!confirm('이 기기에 이전 실행 기록이 남아 있습니다. 이전 기록은 유지되며 새 실행을 시작합니다. 필요한 파일은 다운로드했나요?'))return;
    busy=true;start.querySelector('button[type=submit]').disabled=true;
    try{
      const candidate=createRun({participantCode:code,condition:invitation?.condition||(crypto.getRandomValues(new Uint32Array(1))[0]%2?'assisted':'control'),mode:invitation?'pilot':'demo',order:invitation?.order,updateOrders:invitation?.updateOrders,invitationId:invitation?.id||null});
      await enterRun(candidate);focusMain();
    }catch(error){showError(error.message||'실행을 시작하지 못했습니다.');}
    finally{busy=false;const submit=document.querySelector('#start-form button[type=submit]');if(submit)submit.disabled=false;}
  });
  const form=document.getElementById('step-form');
  if(!form)return;
  form.addEventListener('input',()=>{
    scheduleDraft(form);
    const area=form.elements.namedItem('text');
    if(area){const count=document.getElementById('character-count');if(count)count.textContent=`${area.value.length} / 2,000`;}
  });
  form.addEventListener('change',event=>{
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
    event.preventDefault();if(busy||!hasLock||composing)return;
    const data=new FormData(form),info=stepInfo(run);
    let values;
    if(info.phase==='practice'){
      if(data.get('practiceChoice')!=='안내'){showError('자료에 표시된 단어를 다시 확인해 주세요.');return;}
      if(!String(data.get('practiceMemo')||'').trim()){showError('연습 메모를 짧게 입력해 주세요.');return;}
      values={complete:true};
    }else if(info.phase==='decision'||info.phase==='update') values={choice:String(data.get('choice')||'')};
    else if(info.phase==='estimate'){
      if(data.get('burden')===null||data.get('prediction')===null){showError('정신적 노력과 예상 점수를 모두 선택해 주세요.');return;}
      values={burden:Number(data.get('burden')),prediction:Number(data.get('prediction'))};
    }else values=data.get('unknown')?{unknown:true}:{text:String(data.get('text')||'').trim()};
    busy=true;form.querySelector('button[type=submit]').disabled=true;
    try{
      await saveDraftNow();
      const next=submitStep(run,values);
      recorder?.record('step_submitted',{phase:info.phase,taskId:info.taskId,updateId:info.updateId});
      clearDraftTimers();
      await queueSave(next);
      run=next;recorder?.context(run);
      recorder?.record('step_entered',{phase:stepInfo(run).phase});
      try{await recorder?.flush();}catch{logError='응답은 저장됐지만 일부 행동 기록은 저장 대기 중입니다. 창을 닫기 전 기록을 다운로드해 주세요.';}
      render();focusMain();
    }catch(error){showError(error.message||'응답을 확정하지 못했습니다. 다시 시도해 주세요.');}
    finally{busy=false;const submit=document.querySelector('#step-form button[type=submit]');if(submit)submit.disabled=false;}
  });
}
async function downloadRun(target=run||savedRun){
  if(!target)return;
  try{
    const warnings=[];
    if(target===run){
      await saveDraftNow();await writeQueue;
      try{await recorder?.flush();}catch{warnings.push('일부 행동 기록이 아직 기기 저장소에 저장되지 않아 전송 대기열에서 포함했습니다.');}
      target=run;
    }
    try{await store.saveRun(target);}catch{warnings.push('최신 응답의 기기 저장에 실패해 현재 탭의 응답을 직접 포함했습니다.');}
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
  }
}
async function goHome(){
  if(busy)return;
  if(!run){focusMain();return;}
  if(run&&run.status!=='completed'){
    if(!confirm('진행 기록은 이 기기에 유지됩니다. 시작 화면으로 이동할까요?'))return;
  }
  await saveDraftNow();await writeQueue;
  try{await recorder?.stop();}
  catch(error){
    recorder?.start(run);
    logError='일부 행동 기록을 저장하지 못해 시작 화면으로 이동하지 않았습니다. 현재 기록을 다운로드해 보관하거나 저장이 복구된 뒤 다시 시도해 주세요.';
    paintSaveStatus();showError(logError);return;
  }
  savedRun=run;run=null;recorder=null;unlockSession();clearDraftTimers();
  document.getElementById('locked-dialog')?.remove();render();focusMain();
}

document.addEventListener('click',async event=>{
  const skip=event.target.closest('.skip-link');
  if(skip){event.preventDefault();document.getElementById('main')?.focus();return;}
  const control=event.target.closest('[data-action]');if(!control)return;
  event.preventDefault();const action=control.dataset.action;
  if(action==='download'){await downloadRun();return;}
  if(action==='download-saved'){await downloadRun(savedRun);return;}
  if(action==='resume'){try{await enterRun(savedRun);focusMain();}catch(error){showError(error.message);}return;}
  if(action==='retry-lock'){
    if(await acquireSession(run.id)){
      document.getElementById('locked-dialog')?.remove();
      await enterRun(await store.getRun(run.id)||run);
      focusMain();
    }
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
