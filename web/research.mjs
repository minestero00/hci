import { STUDY, TASKS } from './content.mjs';
import { ANSWER_KEY } from './research-key.mjs';
import { validateEnvelope, mergeEnvelopes, makeInvitations, makeEnvelope } from './core.mjs';
import { ResearchStore } from './research-store.mjs';
import { summarizeBehavior } from './telemetry.mjs';
import { responseId, knownResponses, blindPacket, validateBlindPacket, applyRatings, analysisTables, tableCSV } from './research-tools.mjs';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const taskById = id => TASKS.find(t => t.id === id);
const roleNames = { rater1: '채점자 1', rater2: '채점자 2', consensus: '인간 합의', ai: 'AI 독립 채점' };
let repository, state, currentView = 'collect', gradeIndex = 0, saveQueue = Promise.resolve();
let collectionQuery = '', collectionMode = 'all', collectionStatus = 'all', selectedRunId = null, collectionPage=0;
const COLLECTION_PAGE_SIZE=20;
let timelineType = 'all', timelineTask = 'all', timelinePage = 0, readingFiles = false, gradingBusy = false, invitationBusy = false;
let persistenceFailed=false;
let cloudSdk,cloudAuth,cloudDb,cloudBusy=false;
const RESEARCH_EMAILS=['superriaco@gmail.com','tigers0214@gmail.com','slightsmille@gmail.com'];
export const isResearcher=user=>Boolean(user?.emailVerified&&RESEARCH_EMAILS.includes(user.email?.toLowerCase()));
const phaseNames = { practice:'조작 연습', decision:'실행안 판단', estimate:'자기평가', update:'새 요청', memo:'인계 메모', done:'완료' };
const duration = value => value === null || value === undefined ? '기록 없음' : value < 1000 ? `${Math.round(value)}ms` : value < 60000 ? `${(value/1000).toFixed(1)}초` : `${Math.floor(value/60000)}분 ${Math.round(value%60000/1000)}초`;
const eventNames={click:'클릭',double_click:'두 번 클릭',context_menu:'우클릭 메뉴',pointer_move:'포인터 표본',pointer_down:'포인터 누름',hover_end:'포인터 머문 구간',scroll:'스크롤 표본',scroll_end:'스크롤 구간',control_change:'선택 변경',field_session:'입력 구간',input_started:'입력 시작',input_action:'입력 유형',composition_start:'조합 입력 시작',composition_end:'조합 입력 종료',paste:'붙여넣기',copy:'복사',cut:'잘라내기',selection:'텍스트 선택',focus_in:'요소 포커스 진입',focus_out:'요소 포커스 이탈',key_navigation:'키보드 탐색',key_action:'키보드 조작',visibility:'탭 표시 상태',window_focus:'창 포커스 진입',window_blur:'창 포커스 이탈',source_viewport:'자료 교차 비율',source_exposure_start:'자료 노출 시작',source_exposure_end:'자료 노출 종료',engagement_segment:'관찰 시간 구간',step_submitted:'응답 확정',step_entered:'단계 진입',draft_revision:'초안 수정',session_opened:'진행 시작·재개',recorder_started:'기록 시작',recorder_stopped:'기록 종료',heartbeat:'주기 상태',overlay_state:'대화상자 가림',dialog_opened:'안내 열기',dialog_closed:'안내 닫기',export_requested:'파일 요청',export_warning:'파일 복구 경고',export_failed:'파일 생성 실패',storage_failure:'행동 저장 실패',storage_recovered:'저장 복구',response_storage_error:'응답 저장 실패',source_jump:'자료 바로가기',answer_jump:'응답 바로가기',pane_focus_requested:'작업 영역 이동',workspace_presented:'작업 화면 표시',workspace_layout:'작업 영역 배치',validation_error:'응답 확인 필요',validation_invalid:'필수 입력 오류'};
const eventLabel=type=>eventNames[type]||type;
function sourceLabel(id){
 const task=TASKS.find(task=>id.startsWith(`${task.id}:`));if(!task)return id;
 if(id===`${task.id}:brief`)return `${task.title} · 업무 요청`;
 if(id.startsWith(`${task.id}:ai:`))return `${task.title} · AI 지원`;
 const source=task.sources.find(source=>id.startsWith(`${task.id}:${source.id}:`));
 return source?`${source.label} · ${source.title}`:id;
}
const eventType = event => event.type ?? event.event ?? 'unknown';
const safeDate = value => { const date = new Date(value); return Number.isFinite(date.getTime()) ? date.toISOString().replace('T',' ').replace('Z',' UTC') : '시각 없음'; };


function message(text, error = false) {
  $('research-message').setAttribute('role', error ? 'alert' : 'status');
  $('research-message').innerHTML = text ? `<div class="r-message${error ? ' error' : ''}">${esc(text)}</div>` : '';
}
function savedStatus(error = false) {
  $('research-save').textContent = error ? '저장 실패 · 파일로 보관하세요' : repository.mode === 'indexeddb' ? '이 브라우저에 저장됨' : '현재 탭에 임시 보관 중';
}
async function persist() {
  const snapshot = { ...state, ratings: structuredClone(state.ratings), gradeHistory: [...state.gradeHistory], invitations: [...state.invitations] };
  $('research-save').textContent = '저장 중';
  saveQueue = saveQueue.catch(() => {}).then(() => repository.save(snapshot));
  try { await saveQueue; persistenceFailed=false;savedStatus(); return true; }
  catch (error) { persistenceFailed=true;savedStatus(true); message(`자동 저장에 실패했습니다. 전체 보관 파일을 내려받아 주세요. ${error.message}`, true); return false; }
}
function download(name, content, type = 'application/json') {
  try {
    const blob = new Blob([typeof content === 'string' ? content : JSON.stringify(content, null, 2)], { type });
    const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
    $('research-download-status').textContent = `${name} 다운로드를 요청했습니다. 브라우저의 다운로드 목록에서 파일을 확인해 주세요.`;
  } catch { message('파일을 만들지 못했습니다. 이 창을 닫지 말고 다시 시도해 주세요.', true); }
}
function jsonDownload(name, content) { download(`${name}.json`, content); }
function csvDownload(name, table) { download(`${name}.csv`, tableCSV(table), 'text/csv;charset=utf-8'); }
function archive() { return { format: 'hci-research-archive', schemaVersion: 1, studyVersion: STUDY.version, exportedAt: new Date().toISOString(), envelopes: state.envelopes, ratings: state.ratings, invitations: state.invitations, gradeHistory: state.gradeHistory, packet: state.packet, role: state.role }; }
function stats() {
  const ids = knownResponses(state.envelopes);
  return { runs: state.envelopes.length, completed: state.envelopes.filter(e => e.run.status === 'completed').length, rated: [...ids].filter(id => state.ratings[id]?.consensus).length, memos: ids.size };
}
function header(kicker, title, description) { return `<p class="research-kicker">${esc(kicker)}</p><h1>${esc(title)}</h1><p class="research-intro">${esc(description)}</p>`; }
function pills(mode) { return `<span class="r-pill${mode === 'demo' ? ' demo' : ''}">${mode === 'demo' ? '팀 체험' : '초대 참여'}</span>`; }
function importControl(id = 'research-files', label = 'JSON 파일 가져오기') {
  return `<label class="r-drop" id="drop-${id}"><strong>${label}</strong><small>JSON 여러 개를 함께 선택하거나 이 영역에 놓으세요.</small><input class="r-file" type="file" id="${id}" accept=".json,application/json" multiple></label>`;
}
function table(headers, rows) {
  return `<div class="r-table"><table><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}"><div class="r-empty">아직 기록이 없습니다.</div></td></tr>`}</tbody></table></div>`;
}
function workflow() {
  const s = stats();
  return `<ol class="r-workflow" aria-label="연구 운영 순서">${[
    ['invite','01','링크 배정',`${state.invitations.length}개 생성`],
    ['collect','02','응답 수집',`${s.runs}개 실행`],
    ['grade','03','독립 채점',`합의 ${s.rated} / ${s.memos}`],
    ['export','04','분석 내보내기','CSV · 원본 보관']
  ].map(([view,n,title,sub])=>`<li><button type="button" data-go-view="${view}"><span>${n}</span><div><b>${title}</b><small>${sub}</small></div><span aria-hidden="true">→</span></button></li>`).join('')}</ol>`;
}
function collectionRows() {
  const query = collectionQuery.trim().toLocaleLowerCase();
  const selected = state.envelopes.filter(({run}) => (!query || `${run.participantCode} ${run.id}`.toLocaleLowerCase().includes(query)) && (collectionMode === 'all' || run.mode === collectionMode) && (collectionStatus === 'all' || run.status === collectionStatus));
  const pages=Math.max(1,Math.ceil(selected.length/COLLECTION_PAGE_SIZE));collectionPage=Math.min(collectionPage,pages-1);
  const visible=selected.slice(collectionPage*COLLECTION_PAGE_SIZE,(collectionPage+1)*COLLECTION_PAGE_SIZE);
  const pagination=selected.length>COLLECTION_PAGE_SIZE?`<nav class="r-pagination" aria-label="수집 기록 페이지"><button type="button" id="collection-prev" class="r-button secondary small" ${collectionPage===0?'disabled':''}>이전 20개</button><span>${collectionPage+1} / ${pages}</span><button type="button" id="collection-next" class="r-button secondary small" ${collectionPage===pages-1?'disabled':''}>다음 20개</button></nav>`:'';
  return `<p class="r-help" id="collection-count" role="status" tabindex="-1">${selected.length} / ${state.envelopes.length}개 실행 표시</p>` + (selected.length ? table(['참가자 / 실행', '종류 · 배정', '진행', '메모', '행동 로그', '살펴보기'], visible.map(e => {
    const run=e.run,count=TASKS.filter(t=>run.responses[t.id]?.memo).length;
    return [`<b>${esc(run.participantCode)}</b><small class="r-id">${esc(run.id.slice(0,8))}</small>`,`${pills(run.mode)} <span class="r-condition">${run.condition === 'assisted' ? 'AI 지원' : '원자료'}</span>`, `<span class="r-pill ${run.status==='completed'?'complete':'neutral'}">${run.status==='completed'?'완료':'진행 중·중단'}</span>`,`${count} / ${TASKS.length}`,`${e.events.length.toLocaleString()}개`,`<button class="r-button secondary small inspect-run" data-run-id="${esc(run.id)}" aria-expanded="${selectedRunId===run.id}" aria-controls="record-detail">기록 보기</button>`];
  })) : `<div class="r-empty"><strong>${state.envelopes.length ? '조건에 맞는 기록이 없습니다.' : '첫 번째 응답 파일을 기다리고 있습니다.'}</strong><p>${state.envelopes.length ? '검색어나 필터를 바꿔 주세요.' : '위에서 참가자가 전달한 JSON을 선택하세요. 완료하지 않은 기록도 확인할 수 있습니다.'}</p>${state.envelopes.length?'<button type="button" class="r-button secondary" id="reset-collection">필터 초기화</button>':'<button type="button" class="r-button secondary" id="open-collection-files">JSON 파일 선택</button>'}</div>`)+pagination;
}
function renderCollect() {
  const s=stats(),inviteCounts=new Map();
  for(const {run} of state.envelopes)if(run.invitationId)inviteCounts.set(run.invitationId,(inviteCounts.get(run.invitationId)||0)+1);
  const reused=[...inviteCounts.values()].filter(n=>n>1).length;
  return header('RESEARCH OPERATIONS','수집부터 분석까지, 한 작업실에서.','참가자 파일을 가져오고, 행동의 흐름을 확인하고, 독립 채점 결과를 연결하세요.') + workflow() +
    `<div class="research-cards"><div class="research-stat"><span>가져온 실행</span><b>${s.runs}<small> 건</small></b><small>팀 체험과 초대 참여 포함</small></div><div class="research-stat"><span>완료한 실행</span><b>${s.completed}<small> / ${s.runs}</small></b><small>세 가지 업무 완료</small></div><div class="research-stat"><span>인간 합의 채점</span><b>${s.rated}<small> / ${s.memos}</small></b><small>서술형 답안 기준</small></div></div>` +
    `<section class="r-panel"><div class="r-section-heading"><div><h2>참가자 기록 가져오기</h2><p>응답·채점·블라인드 묶음·보관 파일을 같은 곳에서 가져옵니다.</p></div><button class="r-button secondary" id="archive-download">전체 보관 JSON</button></div>${importControl()}<p class="r-help">같은 파일은 중복 제거합니다. 같은 실행의 내용이 다르면 기존 기록을 유지하고 충돌을 알립니다.</p></section>`+
    `<section class="r-panel"><div class="r-section-heading"><div><h2>수집 기록</h2><p>‘기록 보기’에서 단계별 시간, 자료 노출, 선택 변경과 타임라인을 살펴보세요.</p></div><span class="r-pill neutral">이 브라우저에만 보관</span></div>${reused?`<div class="r-note warning">${reused}개의 초대 링크에 여러 실행이 있습니다. 참가자별 CSV의 duplicate_invitation을 확인하세요. 해당 실행은 주 분석 가능 표지에서 제외됩니다.</div>`:''}<div class="r-filters"><label class="r-label r-search">참가자·실행 검색<input class="r-input" id="collection-search" type="search" value="${esc(collectionQuery)}" placeholder="익명 코드 또는 실행 번호" autocomplete="off"></label><label class="r-label">실행 종류<select class="r-select" id="collection-mode">${[['all','전체 종류'],['pilot','초대 참여'],['demo','팀 체험']].map(([id,label])=>`<option value="${id}" ${collectionMode===id?'selected':''}>${label}</option>`).join('')}</select></label><label class="r-label">진행 상태<select class="r-select" id="collection-status">${[['all','전체 상태'],['completed','완료'],['in_progress','진행 중·중단']].map(([id,label])=>`<option value="${id}" ${collectionStatus===id?'selected':''}>${label}</option>`).join('')}</select></label></div><div id="collection-list">${collectionRows()}</div></section><section id="record-detail" class="r-detail" aria-label="선택한 실행의 행동 기록">${renderRecordDetail()}</section><div class="r-note">브라우저 데이터를 지우거나 다른 기기로 옮기기 전에 전체 보관 JSON을 내려받으세요. 파일은 외부 서버로 자동 전송되지 않습니다.</div>`;
}
function renderRecordDetail() {
  const envelope=state.envelopes.find(e=>e.run.id===selectedRunId);if(!envelope)return '';
  const {run,events}=envelope,summary=summarizeBehavior(events),totals=summary.totals;
  const stageRows=summary.stages.map(s=>[esc(taskById(s.taskId)?.title||'공통'),`${esc(phaseNames[s.phase]||s.phase)}${s.updateId?`<small class="r-id">${esc(s.updateId)}</small>`:''}`,duration(s.durationMs),duration(s.foregroundMs),duration(s.activeMs),duration(s.idleMs),String(s.choiceChanges??0)]);
  const sourceRows=summary.sources.map(s=>[`${esc(sourceLabel(s.sourceId))}<small class="r-id">${esc(s.sourceId)}</small>`,duration(s.exposureMs),String(s.exposureCount),duration(s.hoverMs)]);
  return `<div class="r-panel r-inspector"><div class="r-section-heading"><div><p class="research-kicker">BEHAVIOR EXPLORER</p><h2 id="record-title" tabindex="-1">${esc(run.participantCode)}의 행동 기록</h2><p class="r-help">${esc(run.id)} · 시작 ${esc(safeDate(run.startedAt))}</p></div><button class="r-button secondary small" id="close-record">닫기</button></div><div class="r-actions"><button class="r-button secondary" id="record-download">이 실행 원본 JSON</button><button class="r-button secondary" id="behavior-download">행동 요약 JSON</button></div><div class="r-metrics">${[['이벤트',`${totals.events.toLocaleString()}개`],['기록 구간',duration(totals.durationMs)],['전경 창',duration(totals.foregroundMs)],['최근 상호작용',duration(totals.activeMs)],['선택 수정',`${totals.choiceChanges}회`],['붙여넣기',`${totals.pasteCount}회`]].map(([label,value])=>`<div><span>${label}</span><strong>${value}</strong></div>`).join('')}</div><p class="r-help">‘최근 상호작용’은 전경 창에서 최근 30초 안에 페이지 입력이 있었던 구간입니다. 전경·자료 노출·포인터는 읽기, 주의 집중, 이해를 의미하지 않습니다. 시간은 수집된 구간만 합산합니다.</p>${summary.quality.warnings.length?`<div class="r-note warning"><b>기록 품질 확인</b><ul>${summary.quality.warnings.map(w=>`<li>${esc(w)}</li>`).join('')}</ul></div>`:''}<details open><summary>단계별 행동 요약</summary>${stageRows.length?table(['업무','단계','기록 시간','전경 창','최근 상호작용','무입력 구간','선택 수정'],stageRows):'<p class="r-empty">단계별 구간 기록이 없습니다.</p>'}</details><details><summary>자료별 화면 노출</summary><p class="r-help">창이 전경에 있고 자료 영역이 화면에 노출된 시간입니다. 여러 자료의 시간은 겹칠 수 있습니다.</p>${sourceRows.length?table(['자료 식별자','노출 합계','노출 구간','포인터 머문 시간'],sourceRows):'<p class="r-empty">자료 노출 기록이 없습니다.</p>'}</details><div class="r-section-heading"><h3>이벤트 타임라인</h3><span class="r-pill neutral">원기록 ${events.length.toLocaleString()}개 보존</span></div><div class="r-filters"><label class="r-label">이벤트 종류<select id="timeline-type" class="r-select"><option value="all">전체 이벤트</option>${[...new Set(events.map(eventType))].sort().map(type=>`<option value="${esc(type)}" ${type===timelineType?'selected':''}>${esc(eventLabel(type))}</option>`).join('')}</select></label><label class="r-label">업무<select id="timeline-task" class="r-select"><option value="all">전체 업무</option>${TASKS.map(task=>`<option value="${task.id}" ${task.id===timelineTask?'selected':''}>${esc(task.title)}</option>`).join('')}</select></label></div><div id="timeline-list" tabindex="-1">${renderTimeline(events)}</div></div>`;
}
function renderTimeline(events) {
  const selected=events.filter(event=>(timelineType==='all'||eventType(event)===timelineType)&&(timelineTask==='all'||event.taskId===timelineTask));
  const pageSize=60,pages=Math.max(1,Math.ceil(selected.length/pageSize));timelinePage=Math.min(timelinePage,pages-1);
  const rows=selected.slice(timelinePage*pageSize,(timelinePage+1)*pageSize).map(event=>[esc(safeDate(event.at??event.timestamp)),`<strong>${esc(eventLabel(eventType(event)))}</strong><small class="r-id">${esc(eventType(event))}</small>`,`<span>${esc(phaseNames[event.phase]||event.phase||'—')}</span><small class="r-id">${esc(taskById(event.taskId)?.title||'공통')}</small>`,`<details class="r-event-data"><summary>기록 내용</summary><pre>${esc(JSON.stringify(event.data??event.payload??{},null,2).slice(0,5000))}</pre></details>`]);
  return `<p class="r-help" role="status">${selected.length.toLocaleString()}개 중 ${selected.length?timelinePage*pageSize+1:0}–${Math.min((timelinePage+1)*pageSize,selected.length)}개 표시 · 원본 시간은 UTC</p>${rows.length?table(['시각','이벤트','단계 · 업무','상세'],rows):'<div class="r-empty">해당 조건의 이벤트가 없습니다.</div>'}<div class="r-pagination"><button class="r-button secondary small" id="timeline-prev" ${timelinePage===0?'disabled':''}>이전 60개</button><span>${timelinePage+1} / ${pages}</span><button class="r-button secondary small" id="timeline-next" ${timelinePage>=pages-1?'disabled':''}>다음 60개</button></div>`;
}
function renderInvitations() {
  return header('02 / INVITATIONS', '같은 안내, 균형 있는 초대.', '한 배치 안에서 두 조건과 사례 순서를 나누어 참여 링크를 만듭니다. 참가자는 링크에 배정된 한 조건으로만 진행합니다.') +
    `<section class="r-panel"><h2>참여 링크 만들기</h2><form id="invite-form" class="r-form"><label class="r-label">새 배치 인원<input id="invite-count" class="r-input" type="number" min="1" max="500" value="20" required></label><button class="r-button" type="submit">초대 배치 생성</button></form><div class="r-note">배정은 생성한 배치 안에서 균형을 맞춥니다. 정적 사이트이므로 서로 다른 연구자가 만든 배치나 링크의 중복 사용을 서버에서 조정하지 않습니다.</div><div class="r-actions"><button class="r-button secondary" id="invite-csv" ${state.invitations.length ? '' : 'disabled'}>링크 목록 CSV</button><button class="r-button secondary" id="invite-json" ${state.invitations.length ? '' : 'disabled'}>링크 목록 JSON</button></div><p class="r-help">링크 목록 JSON은 전달용입니다. 작업실 복원에는 전체 보관 JSON을 사용하세요.</p></section>` +
    `<section class="r-panel"><h2>생성한 참여 링크 <span class="r-help">${state.invitations.length}개</span></h2>${table(['코드', '조건', '사례 순서', '참여 링크'], state.invitations.map(i => [esc(i.participantCode), i.condition === 'assisted' ? 'AI 지원' : '원자료', esc(i.order.map(id => taskById(id)?.title || id).join(' → ')), `<button class="r-button secondary copy-invite" data-id="${esc(i.id)}">링크 복사</button> <a class="quiet-link" href="${esc(i.url)}" target="_blank" rel="noopener">열기 ↗</a>`]))}</section>`;
}
function renderSources(task) {
  return task.sources.map(source => `<section><h3>${esc(source.title)}</h3>${source.blocks.map(b => b.type === 'p' ? `<p>${esc(b.text)}</p>` : b.type === 'list' ? `<ul>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : b.type === 'table' ? `<div class="r-table"><table><thead><tr>${b.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '').join('')}</section>`).join('') + `<h3>최초 제안된 실행안</h3><ul>${task.plans.map(p => `<li><b>${esc(p.title)}</b> · ${esc(p.description)}</li>`).join('')}</ul>`;
}
function gradeItems() { return state.packet?.items || []; }
function renderGrading() {
  const items = gradeItems(), role = state.role || 'rater1', item = items[gradeIndex];
  const intro = header('03 / BLIND REVIEW', role==='consensus'?'두 독립 채점을 확인하고 합의합니다.':'답안의 근거만 보고 채점합니다.', (role === 'consensus' ? '두 사람의 독립 채점 결과를 확인하고 합의 점수와 근거를 기록하세요. 조건·예상 점수·행동 로그·AI 점수는 이 답안 영역에 표시하지 않습니다.' : '조건·예상 점수·최초 선택·행동 로그·다른 사람과 AI 점수는 이 답안 영역에 표시하지 않습니다. 채점자 1과 2는 각자 별도의 브라우저에서 채점 묶음을 사용하세요.'));
  const controls = `<section class="r-panel"><div class="r-form"><label class="r-label">현재 채점 역할<select id="grade-role" class="r-select"><option value="rater1" ${role === 'rater1' ? 'selected' : ''}>채점자 1</option><option value="rater2" ${role === 'rater2' ? 'selected' : ''}>채점자 2</option><option value="consensus" ${role === 'consensus' ? 'selected' : ''}>인간 합의</option></select></label><button id="new-packet" class="r-button secondary" ${knownResponses(state.envelopes).size ? '' : 'disabled'}>현재 기록으로 묶음 생성</button><button id="grade-export" class="r-button secondary" ${items.length ? '' : 'disabled'}>내 채점 결과 내려받기</button></div><p class="r-help">다른 채점자의 파일도 아래에서 가져올 수 있습니다. 독립 채점 중에는 해당 점수를 보여주지 않습니다.</p><label class="r-label">채점 묶음·결과 JSON 가져오기<input type="file" id="grading-files" class="r-file" accept=".json,application/json" multiple></label></section>`;
  if (!item) return intro + controls + `<div class="r-panel r-empty">채점할 메모가 없습니다. 메모가 포함된 응답 파일이나 전달받은 채점 묶음을 가져오세요.</div>`;
  const task = taskById(item.taskId), key = ANSWER_KEY[task.id], grades = state.ratings[item.responseId] || {}, current = grades[role];
  const hasBoth = grades.rater1 && grades.rater2;
  const consensusNote = role === 'consensus' ? `<div class="r-note${hasBoth ? '' : ' warning'}">${hasBoth ? `채점자 1: ${grades.rater1.score}점 · 채점자 2: ${grades.rater2.score}점. AI 점수는 표시하지 않습니다.` : '두 채점자의 독립 점수를 먼저 가져오세요. 합의 입력은 그 뒤 가능합니다.'}</div>` : '';
  const disabled = role === 'consensus' && !hasBoth;
  const rated = items.filter(i => state.ratings[i.responseId]?.[role]).length;
  const gradeProgress = `<div class="r-grade-progress"><div><b>${esc(roleNames[role])} 진행</b><span>${rated} / ${items.length}개 저장</span></div><progress max="${items.length}" value="${rated}" aria-label="채점 완료">${rated} / ${items.length}</progress><button class="r-button secondary small" type="button" id="grade-unrated" ${rated===items.length?'disabled':''}>미채점 답안으로 이동</button></div>`;
  return intro + controls + gradeProgress + `<div class="r-grading-header" tabindex="-1"><span class="r-help">답안 ${gradeIndex + 1} / ${items.length} · ${esc(task.title)}</span><button class="quiet-link" id="blind-toggle" type="button">${document.body.classList.contains('blind-active') ? '관리 메뉴 보이기' : '채점 화면에 집중'}</button></div><section class="r-panel"><p class="r-prompt">${esc(task.memo.prompt)}</p><div class="r-answer">${esc(item.text)}</div>${consensusNote}<h2>판단할 관계</h2><ol class="r-criteria">${key.criteria.map(c => `<li>${esc(c)}</li>`).join('')}</ol><form id="grade-form"><fieldset style="border:0;padding:0;margin:0"><legend class="r-help">${esc(roleNames[role])} 점수</legend><div class="r-score">${[0,1,2].map(n => `<label><input type="radio" name="score" value="${n}" ${current?.score === n ? 'checked' : ''} ${disabled ? 'disabled' : ''} required>${n}점</label>`).join('')}</div></fieldset><label class="r-label">판단 근거<textarea class="r-textarea" id="grade-reason" maxlength="4000" ${disabled ? 'disabled' : ''} placeholder="어느 관계를 설명했는지 짧게 남겨 주세요.">${esc(current?.reason || '')}</textarea></label><p id="grade-edit-status" class="r-help" role="status" tabindex="-1">${persistenceFailed?'자동 저장을 확인하지 못했습니다. 채점 결과 파일을 내려받아 보관해 주세요.':current?'저장된 채점입니다. 수정 후 다시 저장할 수 있습니다.':'점수와 근거를 확인한 뒤 저장해 주세요.'}</p><div class="r-actions"><button class="r-button" type="submit" name="action" value="save-next" ${disabled ? 'disabled' : ''}>저장하고 다음 미채점으로 →</button><button class="r-button secondary" type="submit" name="action" value="save" ${disabled ? 'disabled' : ''}>${current ? '점수·근거 저장' : '채점 저장'}</button><button class="r-button secondary" type="button" id="grade-prev" ${gradeIndex === 0 ? 'disabled' : ''}>이전 답안</button><button class="r-button secondary" type="button" id="grade-next" ${gradeIndex === items.length - 1 ? 'disabled' : ''}>다음 답안</button></div></form></section><details class="r-panel"><summary>공통 기준과 경계 답안</summary><div class="r-anchors">${[2,1,0].map(n => `<p><b>${n}점</b> · ${esc(key.rubric[n])}</p>`).join('')}${key.anchors.map(a => `<p><b>${a.score}점 예시</b> · ${esc(a.text)}<br>${esc(a.reason)}</p>`).join('')}</div></details><details class="r-panel"><summary>이 업무의 원자료 보기</summary><div class="r-source">${renderSources(task)}</div></details>`;
}
function behaviorTables(includeDemo = false) {
  const runs=[],stages=[],sources=[];
  const snake=object=>Object.fromEntries(Object.entries(object).map(([key,value])=>[key==='events'?'event_count':key.replace(/[A-Z]/g,char=>`_${char.toLowerCase()}`),value]));
  for(const {run,events} of state.envelopes){
    if(!includeDemo&&run.mode!=='pilot')continue;
    const summary=summarizeBehavior(events),base={study_version:run.studyVersion,run_id:run.id,participant_code:run.participantCode,mode:run.mode,condition:run.condition};
    runs.push({...base,...snake(summary.totals),telemetry_versions:JSON.stringify(summary.quality.telemetryVersions),ui_versions:JSON.stringify(summary.quality.uiVersions),legacy_events:summary.quality.legacyEvents,storage_failures:summary.quality.storageFailures,export_warnings:summary.quality.exportWarnings,has_segments:summary.quality.hasSegments?1:0,quality_warnings:JSON.stringify(summary.quality.warnings)});
    for(const stage of summary.stages)stages.push({...base,...snake(stage)});
    for(const source of summary.sources)sources.push({...base,...snake(source)});
  }
  return {runs,stages,sources};
}
function renderExport() {
  const s=stats(),completedPilot=state.envelopes.filter(e=>e.run.mode==='pilot'&&e.run.status==='completed').length;
  return header('04 / ANALYSIS FILES', '원기록에서 분석 자료까지.', '미채점은 빈칸으로 남깁니다. 인간 합의 점수가 모두 있어야 참가자별 주 분석값을 계산합니다.') +
    `<div class="research-cards"><div class="research-stat"><span>완료한 초대 참여</span><b>${completedPilot}<small> 건</small></b></div><div class="research-stat"><span>인간 합의 완료 · 전체</span><b>${s.rated}<small> / ${s.memos}</small></b><small>팀 체험 포함</small></div><div class="research-stat"><span>작업실 원기록 · 전체</span><b>${state.envelopes.reduce((n,e)=>n+e.events.length,0).toLocaleString()}<small> 개</small></b><small>팀 체험 포함</small></div></div><section class="r-panel"><h2>분석용 CSV</h2><p>사례·문항·이벤트를 독립 참가자로 세지 마세요. 세 사례 평균이 참가자 한 명의 주 분석값입니다.</p><label class="r-inline"><input type="checkbox" id="include-demo"> 팀 체험 기록도 포함 <span class="r-help">기본은 초대 참여만</span></label><p id="export-scope" class="r-help" role="status">현재 내보내기 범위: ${state.envelopes.filter(e=>e.run.mode==='pilot').length}개 실행 · ${state.envelopes.filter(e=>e.run.mode==='pilot').reduce((n,e)=>n+e.events.length,0).toLocaleString()}개 이벤트</p><div class="r-actions">${[['participants','참가자별'],['cases','사례별'],['items','문항별'],['events','행동 로그']].map(([id,label]) => `<button class="r-button secondary" data-export="${id}">${label} CSV</button>`).join('')}</div><div class="r-note">실제 점수 = 선택형 합계 + 인간 합의 점수. AI 단독·인간/AI 평균은 별도 열로 출력합니다. 점수 0과 미채점은 구분합니다.</div></section>` +
    `<section class="r-panel"><h2>행동 요약 CSV</h2><p>위의 팀 체험 포함 설정을 똑같이 적용합니다. 원본 이벤트와 실행 번호로 연결할 수 있습니다.</p><div class="r-actions">${[['runs','실행별 행동 요약'],['stages','단계별 행동 요약'],['sources','자료별 화면 노출']].map(([id,label])=>`<button class="r-button secondary" data-behavior-export="${id}" ${state.envelopes.length?'':'disabled'}>${label} CSV</button>`).join('')}</div><p class="r-help">전경·최근 상호작용·자료 노출 시간은 관찰 지표입니다. 읽기나 이해를 뜻하지 않으며, 이전 형식에 없는 시간은 빈칸입니다.</p></section>` +
    `<div class="r-grid-two"><section class="r-panel"><h2>독립 채점 파일</h2><p>조건과 예상 점수를 제외한 답안·원자료·기준을 전달합니다.</p><div class="r-actions"><button class="r-button" id="blind-export" ${knownResponses(state.envelopes).size ? '' : 'disabled'}>인간 채점 묶음</button><button class="r-button secondary" id="ai-export" ${knownResponses(state.envelopes).size ? '' : 'disabled'}>AI 채점 입력 묶음</button></div><p class="r-help">AI를 자동 호출하지 않습니다. 입력 묶음의 형식에 맞춘 결과 JSON을 가져오면 연결됩니다.</p></section><section class="r-panel"><h2>채점 결과 가져오기</h2><p>인간 1·2·합의 또는 모델·프롬프트 버전이 포함된 AI 결과를 가져옵니다.</p><label class="r-label">채점 결과 JSON 선택<input class="r-file" id="rating-files" type="file" accept=".json,application/json" multiple></label><p class="r-help">같은 답안·역할의 서로 다른 점수는 자동으로 덮어쓰지 않습니다.</p></section></div>` +
    `<section class="r-panel"><h2>전체 보관</h2><p>원응답·로그·채점·초대 배치를 하나의 파일로 보관합니다. 보관 파일도 ‘기록 모으기’에서 복원할 수 있습니다.</p><button class="r-button secondary" id="archive-download">전체 보관 파일 내려받기</button></section>`;
}
function render(view = currentView, focus = false) {
  currentView = view;
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-selected',String(b.dataset.view===view)); b.tabIndex=b.dataset.view===view?0:-1; });
  $('research-view').setAttribute('aria-labelledby',`nav-${view}`);
  $('research-view').innerHTML = ({ collect: renderCollect, invite: renderInvitations, grade: renderGrading, export: renderExport })[view]();
  bind(); if (focus) { $('research-main').focus({ preventScroll: true });$('research-main').scrollIntoView({block:'start',behavior:'instant'}); }
}
function bindFiles(id) {
  const input = $(id); if (!input) return;
  input.onchange = () => readFiles([...input.files]);
  const drop = $(`drop-${id}`);
  if (drop) {
    drop.ondragover = event => { event.preventDefault(); drop.classList.add('dragging'); };
    drop.ondragleave = () => drop.classList.remove('dragging');
    drop.ondrop = event => { event.preventDefault(); drop.classList.remove('dragging'); readFiles([...event.dataTransfer.files]); };
  }
}
async function readFiles(files) {
  if(readingFiles || gradingBusy || invitationBusy || cloudBusy || !files.length || !leaveGrade())return;
  if (files.length > 100) { message('한 번에 100개 이하의 파일을 선택해 주세요.', true); return; }
  readingFiles=true;$('research-view').setAttribute('aria-busy','true');
  document.querySelectorAll('input[type=file]').forEach(input=>input.disabled=true);
  message(`${files.length}개 파일을 확인하고 있습니다…`);
  const notices = [];
  let problems = 0, conflicts = 0;
  for (const file of files) {
    try {
      if (file.size > 30 * 1024 * 1024) throw Error('파일 하나는 30MB 이하로 나누어 주세요.');
      const value = JSON.parse(await file.text());
      if (value.format === 'hci-workspace-export') {
        validateEnvelope(value); const merged = mergeEnvelopes(state.envelopes, [value]);
        state.envelopes = merged.items;conflicts+=merged.conflicts.length;
        notices.push(`${file.name}: 추가 ${merged.added}, 중복 ${merged.duplicates}${merged.conflicts.length ? `, 충돌 ${merged.conflicts.length}건(기존 기록 유지)` : ''}`);
      } else if (value.format === 'hci-blind-grading-packet') {
        validateBlindPacket(value);
        if(state.packet && state.packet.packetId!==value.packetId && !confirm('현재 채점 묶음을 가져온 묶음으로 교체할까요? 저장한 점수는 유지됩니다.')){notices.push(`${file.name}: 채점 묶음 교체 취소`);continue;}
        state.packet = value; gradeIndex = 0;
        notices.push(`${file.name}: 블라인드 답안 ${value.items.length}개`);
      } else if (value.format === 'hci-ratings') {
        const ids = new Set([...knownResponses(state.envelopes), ...(state.packet?.items.map(i => i.responseId) || [])]);
        const result = applyRatings(state.ratings, value, ids); state.ratings = result.ratings;conflicts+=result.conflicts.length;
        notices.push(`${file.name}: 채점 추가 ${result.added}, 중복 ${result.duplicates}${result.conflicts.length ? `, 충돌 ${result.conflicts.length}건(기존 점수 유지)` : ''}`);
      } else if (value.format === 'hci-research-archive') {
        if (value.schemaVersion !== 1 || value.studyVersion !== STUDY.version || !Array.isArray(value.envelopes) || value.envelopes.length > 1000) throw Error('현재 버전의 보관 파일이 아닙니다.');
        value.envelopes.forEach(validateEnvelope);
        if (value.packet !== null && value.packet !== undefined) validateBlindPacket(value.packet);
        const merged = mergeEnvelopes(state.envelopes, value.envelopes);
        const packet = state.packet || value.packet || null;
        const ids = new Set([...knownResponses(merged.items), ...(packet?.items.map(i => i.responseId) || [])]);
        let nextRatings = state.ratings, ratingConflicts = 0, ratingDuplicates = 0;
        for (const role of ['rater1','rater2','consensus','ai']) {
          const entries = Object.entries(value.ratings || {}).filter(([,r]) => r?.[role]);
          for (const [id, r] of entries) {
            const rating = r[role];
            const file = { format:'hci-ratings',schemaVersion:1,studyVersion:STUDY.version,role,model:rating.model,promptVersion:rating.promptVersion,ratings:[{responseId:id,...rating}] };
            const result = applyRatings(nextRatings, file, ids); nextRatings = result.ratings;ratingConflicts+=result.conflicts.length;ratingDuplicates+=result.duplicates;
          }
        }
        const restoredInvites = Array.isArray(value.invitations) ? value.invitations : [];
        if (restoredInvites.length > 5000) throw Error('초대 배치가 너무 큽니다.');
        for (const invitation of restoredInvites) {
          const parsed = new URL(invitation.url);
          if (!['https:','http:'].includes(parsed.protocol) || typeof invitation.id !== 'string' || !Array.isArray(invitation.order) || !invitation.order.every(id => TASKS.some(t => t.id === id))) throw Error('보관 파일의 초대 링크 형식이 올바르지 않습니다.');
        }
        conflicts+=merged.conflicts.length+ratingConflicts;
        const restoredHistory=validateGradeHistory(value.gradeHistory??[],ids);
        const history=[...new Map([...state.gradeHistory,...restoredHistory].map(entry=>[canonical(entry),entry])).values()];
        state.envelopes = merged.items; state.ratings = nextRatings; state.packet = packet;state.gradeHistory=history;
        state.invitations = [...new Map([...state.invitations,...restoredInvites].map(i => [i.id,i])).values()];
        if (['rater1','rater2','consensus'].includes(value.role)) state.role = value.role;
        notices.push(`${file.name}: 보관 자료 추가 ${merged.added}, 응답 중복 ${merged.duplicates}, 응답 충돌 ${merged.conflicts.length}, 채점 중복 ${ratingDuplicates}, 채점 충돌 ${ratingConflicts}건(기존 점수 유지), 채점 이력 ${restoredHistory.length}개 복원`);
      } else throw Error('응답·채점·블라인드 묶음·보관 JSON 중 하나를 선택해 주세요.');
    } catch (error) { problems++; notices.push(`${file.name}: ${error.message}`); }
  }
  const stored=await persist(); readingFiles=false;$('research-view').removeAttribute('aria-busy'); render(); message(`가져오기 완료 · ${files.length}개 확인, ${problems}개 오류, ${conflicts}건 충돌${stored?'':' · 자동 저장 실패: 전체 보관 JSON을 내려받으세요.'}\n${notices.join('\n')}`, problems > 0 || conflicts > 0 || !stored);
}
function bind() {
  document.querySelectorAll('[data-go-view]').forEach(button=>button.onclick=()=>navigateView(button.dataset.goView));
  const refreshCollection=()=>{ $('collection-list').innerHTML=collectionRows();bindInspect();bindCollectionPages(); };
  function bindCollectionPages(){
    if($('collection-prev'))$('collection-prev').onclick=()=>{collectionPage--;refreshCollection();$('collection-count').focus();};
    if($('collection-next'))$('collection-next').onclick=()=>{collectionPage++;refreshCollection();$('collection-count').focus();};
    if($('reset-collection'))$('reset-collection').onclick=()=>{collectionQuery='';collectionMode=collectionStatus='all';collectionPage=0;render();$('collection-search').focus();};
    if($('open-collection-files'))$('open-collection-files').onclick=()=>$('research-files').click();
  }
  bindCollectionPages();
  if($('collection-search'))$('collection-search').oninput=event=>{collectionQuery=event.target.value;collectionPage=0;refreshCollection();};
  if($('collection-mode'))$('collection-mode').onchange=event=>{collectionMode=event.target.value;collectionPage=0;refreshCollection();};
  if($('collection-status'))$('collection-status').onchange=event=>{collectionStatus=event.target.value;collectionPage=0;refreshCollection();};
  bindInspect();bindRecordDetail();
  ['research-files','grading-files','rating-files'].forEach(bindFiles);
  if ($('archive-download')) $('archive-download').onclick = () => jsonDownload('hci-research-archive', archive());
  if ($('invite-form')) $('invite-form').onsubmit = async event => {
    event.preventDefault();if(invitationBusy||cloudBusy)return;
    try {
      const count = Number($('invite-count').value);
      if (!Number.isInteger(count) || count < 1 || count > 500) throw Error('1~500명 사이로 입력해 주세요.');
      invitationBusy=true;event.target.querySelector('button[type=submit]').disabled=true;
      const generated = makeInvitations(count, new URL('./index.html', location.href).href);
      state.invitations = [...state.invitations, ...generated]; const stored=await persist(); render();
      message(stored?`${generated.length}개의 링크를 새 배치로 만들었습니다. 목록을 내려받아 전달하세요.`:`${generated.length}개의 링크를 만들었지만 자동 저장에 실패했습니다. 이 창을 닫기 전에 링크 전달용 목록과 복원용 전체 보관 JSON을 내려받으세요.`,!stored);
    } catch (error) { message(error.message, true); }
    finally{invitationBusy=false;const button=$('invite-form')?.querySelector('button[type=submit]');if(button)button.disabled=false;}
  };
  if ($('invite-csv')) $('invite-csv').onclick = () => csvDownload('hci-invitations', state.invitations.map(i => ({ invitation_id:i.id,participant_code:i.participantCode,condition:i.condition,order:i.order.join('>'),url:i.url })));
  if ($('invite-json')) $('invite-json').onclick = () => jsonDownload('hci-invitations', { format:'hci-invitations',studyVersion:STUDY.version,invitations:state.invitations });
  document.querySelectorAll('.copy-invite').forEach(button => button.onclick = async () => {
    const url = state.invitations.find(i => i.id === button.dataset.id)?.url;
    try { await navigator.clipboard.writeText(url); button.textContent = '복사됨'; }
    catch { message(`링크를 복사해 주세요:\n${url}`); }
  });
  if ($('new-packet')) $('new-packet').onclick = async () => { if(gradingBusy||cloudBusy||!leaveGrade())return; state.packet = blindPacket(state.envelopes); gradeIndex = 0; await persist(); render();document.querySelector('.r-grading-header')?.focus(); };
  if ($('grade-role')) $('grade-role').onchange = async event => { if(gradingBusy||cloudBusy||!leaveGrade()){event.target.value=state.role;return;} state.role = event.target.value; await persist(); render();$('grade-role').focus(); };
  if ($('grade-prev')) $('grade-prev').onclick = () => moveGrade(gradeIndex-1);
  if ($('grade-next')) $('grade-next').onclick = () => moveGrade(gradeIndex+1);
  if ($('grade-unrated')) $('grade-unrated').onclick=()=>moveGrade(nextUnrated());
  if ($('blind-toggle')) $('blind-toggle').onclick = () => { if(gradingBusy||cloudBusy||!leaveGrade())return; document.body.classList.toggle('blind-active'); render(); };
  if ($('grade-form')){
    const markDirty=()=>{$('grade-edit-status').textContent=gradeDirty()?'저장하지 않은 변경이 있습니다.': persistenceFailed?'자동 저장을 확인하지 못했습니다. 파일로 보관해 주세요.':'현재 저장된 채점과 같습니다.';};
    $('grade-form').oninput=markDirty;$('grade-form').onchange=markDirty;
  }
  if ($('grade-form')) $('grade-form').onsubmit = async event => {
    event.preventDefault();if(gradingBusy||cloudBusy)return; const item = gradeItems()[gradeIndex], role = state.role;
    const savedIndex=gradeIndex,advance=event.submitter?.value==='save-next';
    const raw = new FormData(event.target).get('score');
    if (raw === null || !['0','1','2'].includes(raw)) { message('0~2점 중 하나를 선택해 주세요.', true); return; }
    const previous = state.ratings[item.responseId]?.[role] || null;
    if (role === 'consensus' && !(state.ratings[item.responseId]?.rater1 && state.ratings[item.responseId]?.rater2)) { message('두 사람의 독립 채점을 먼저 가져오세요.', true); return; }
    gradingBusy=true;event.target.inert=true;event.target.setAttribute('aria-busy','true');event.target.querySelectorAll('button[type=submit]').forEach(button=>{button.disabled=true;button.textContent='채점 저장 중…';});
    state.gradeHistory.push({ responseId:item.responseId,role,previous,at:new Date().toISOString() });
    state.ratings[item.responseId] ??= {};
    state.ratings[item.responseId][role] = { score:Number(raw),reason:$('grade-reason').value.trim(),evidence:'',at:new Date().toISOString() };
    const stored=await persist();gradingBusy=false;
    if(!stored){render();$('grade-edit-status')?.focus();return;}
    const next=advance?nextUnrated():gradeIndex;if(next>=0)gradeIndex=next;
    render(); message(`${savedIndex + 1}번 답안의 ${roleNames[role]} 점수를 저장했습니다.${advance&&next<0?' 모든 답안의 채점을 마쳤습니다. 결과 파일을 내려받으세요.':''}`);
    if(advance)document.querySelector('.r-grading-header')?.focus();
    else $('grade-form')?.querySelector('button[value=save]')?.focus();
  };
  if ($('grade-export')) $('grade-export').onclick = () => {
    const role = state.role, ids = new Set(gradeItems().map(i => i.responseId));
    const ratings = Object.entries(state.ratings).filter(([id,r]) => ids.has(id) && r[role]).map(([id,r]) => ({ responseId:id,...r[role] }));
    jsonDownload(`hci-${role}-ratings`, { format:'hci-ratings',schemaVersion:1,studyVersion:STUDY.version,role,ratings });
  };
  document.querySelectorAll('[data-export]').forEach(button => button.onclick = () => {
    const all = analysisTables(state.envelopes, state.ratings, $('include-demo')?.checked || false);
    csvDownload(`hci-${button.dataset.export}`, all[button.dataset.export]);
    if (!all[button.dataset.export].length) message('해당 자료가 없습니다. 팀 체험 기록만 있다면 포함 옵션을 선택하세요.');
  });
  document.querySelectorAll('[data-behavior-export]').forEach(button=>button.onclick=()=>{
    const tables=behaviorTables($('include-demo')?.checked||false),rows=tables[button.dataset.behaviorExport];
    csvDownload(`hci-behavior-${button.dataset.behaviorExport}`,rows);
    if(!rows.length)message('해당 행동 요약이 없습니다. 팀 체험 포함 설정과 원기록을 확인하세요.');
  });
  if ($('include-demo'))$('include-demo').onchange=()=>{const selected=state.envelopes.filter(e=>$('include-demo').checked||e.run.mode==='pilot');$('export-scope').textContent=`현재 내보내기 범위: ${selected.length}개 실행 · ${selected.reduce((n,e)=>n+e.events.length,0).toLocaleString()}개 이벤트`;};
  if ($('blind-export')) $('blind-export').onclick = () => jsonDownload('hci-blind-grading-packet', blindPacket(state.envelopes));
  if ($('ai-export')) $('ai-export').onclick = () => jsonDownload('hci-ai-grading-packet', blindPacket(state.envelopes, true));
}

function canonical(value){
  if(Array.isArray(value))return `[${value.map(canonical).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function validateGradeHistory(value,knownIds){
  if(!Array.isArray(value)||value.length>100000)throw Error('채점 이력의 형식을 확인하세요.');
  for(const entry of value){
    if(!entry||typeof entry!=='object'||!knownIds.has(entry.responseId)||!['rater1','rater2','consensus'].includes(entry.role)||typeof entry.at!=='string'||!Number.isFinite(Date.parse(entry.at))||JSON.stringify(entry).length>20000)throw Error('채점 이력의 대상·시각을 확인하세요.');
    const previous=entry.previous;
    if(previous!==null&&previous!==undefined&&(!previous||typeof previous!=='object'||!Number.isInteger(previous.score)||previous.score<0||previous.score>2))throw Error('채점 이력의 이전 점수를 확인하세요.');
  }
  return structuredClone(value);
}
function gradeDirty() {
  const form=$('grade-form'),item=gradeItems()[gradeIndex];if(!form||!item)return false;
  const grade=state.ratings[item.responseId]?.[state.role];
  const raw=new FormData(form).get('score'),reason=$('grade-reason').value.trim();
  return (raw===null?null:Number(raw))!==(grade?.score??null)||reason!==(grade?.reason||'');
}
function leaveGrade(){return !gradeDirty()||confirm('아직 저장하지 않은 채점이 있습니다. 저장하지 않고 이동할까요?');}
function nextUnrated(){
 const items=gradeItems();for(let i=1;i<=items.length;i++){const index=(gradeIndex+i)%items.length;if(!state.ratings[items[index].responseId]?.[state.role])return index;}return -1;
}
function moveGrade(index){if(gradingBusy||cloudBusy||index<0||index>=gradeItems().length||!leaveGrade())return;gradeIndex=index;message('');render();document.querySelector('.r-grading-header')?.focus();}
function navigateView(view,focus=true){if(readingFiles||gradingBusy||invitationBusy||cloudBusy||!leaveGrade())return;message('');render(view,focus);}
function bindInspect(){document.querySelectorAll('.inspect-run').forEach(button=>button.onclick=()=>{selectedRunId=button.dataset.runId;timelinePage=0;timelineTask=timelineType='all';$('record-detail').innerHTML=renderRecordDetail();bindRecordDetail();document.querySelectorAll('.inspect-run').forEach(b=>b.setAttribute('aria-expanded',String(b.dataset.runId===selectedRunId)));$('record-title')?.focus({preventScroll:true});$('record-detail').scrollIntoView({block:'start',behavior:'auto'});});}
function bindRecordDetail(){
 const envelope=state.envelopes.find(e=>e.run.id===selectedRunId);if(!envelope)return;
 if($('close-record'))$('close-record').onclick=()=>{const previous=selectedRunId;selectedRunId=null;$('record-detail').innerHTML='';const trigger=[...document.querySelectorAll('.inspect-run')].find(b=>b.dataset.runId===previous);trigger?.setAttribute('aria-expanded','false');trigger?.focus();};
 if($('record-download'))$('record-download').onclick=()=>jsonDownload(`hci-run-${envelope.run.id}`,envelope);
 if($('behavior-download'))$('behavior-download').onclick=()=>jsonDownload(`hci-behavior-${envelope.run.id}`,{format:'hci-behavior-summary',studyVersion:STUDY.version,runId:envelope.run.id,summary:summarizeBehavior(envelope.events)});
 const refresh=()=>{$('timeline-list').innerHTML=renderTimeline(envelope.events);bindTimelinePages();};
 if($('timeline-type'))$('timeline-type').onchange=event=>{timelineType=event.target.value;timelinePage=0;refresh();};
 if($('timeline-task'))$('timeline-task').onchange=event=>{timelineTask=event.target.value;timelinePage=0;refresh();};
 bindTimelinePages();
 function bindTimelinePages(){if($('timeline-prev'))$('timeline-prev').onclick=()=>{timelinePage--;refresh();$('timeline-list').focus();};if($('timeline-next'))$('timeline-next').onclick=()=>{timelinePage++;refresh();$('timeline-list').focus();};}
}

async function connectCloud(){
  if(cloudSdk)return;
  const [sdk,config]=await Promise.all([import('./firebase-sdk.mjs'),import('./cloud-config.mjs')]);
  const app=sdk.initializeApp(config.firebaseConfig,'hci-research');cloudAuth=sdk.getAuth(app);cloudDb=sdk.getFirestore(app);cloudSdk=sdk;
  sdk.onAuthStateChanged(cloudAuth,user=>{
    const allowed=isResearcher(user);
    $('cloud-status').textContent=user?(allowed?'연구자 로그인됨 · 서버 자료를 가져올 수 있습니다.':'이 계정은 연구자 조회 권한이 없습니다.'):'연구자 로그인이 필요합니다.';
    $('cloud-load').disabled=!allowed||cloudBusy;$('cloud-login').hidden=Boolean(user);$('cloud-logout').hidden=!user;
  });
}
async function cloudAction(operation){
 if(cloudBusy||readingFiles||gradingBusy||invitationBusy||!leaveGrade())return;
 cloudBusy=true;$('cloud-login').disabled=true;$('cloud-load').disabled=true;$('cloud-logout').disabled=true;
 try{await connectCloud();await operation();}
 catch(error){$('cloud-status').textContent='서버 연결을 완료하지 못했습니다. 로그인 계정·인터넷 연결을 확인하고 다시 시도해 주세요.';message(`서버 조회 실패: ${error.code||error.message}`,true);}
 finally{cloudBusy=false;$('cloud-login').disabled=false;$('cloud-logout').disabled=false;const user=cloudAuth?.currentUser;$('cloud-load').disabled=!(isResearcher(user));}
}
function bindCloud(){
 $('cloud-login').onclick=()=>cloudAction(()=>cloudSdk.signInWithPopup(cloudAuth,new cloudSdk.GoogleAuthProvider()));
 $('cloud-logout').onclick=()=>cloudAction(()=>cloudSdk.signOut(cloudAuth));
 $('cloud-load').onclick=()=>cloudAction(loadCloudRecords);
}
async function loadCloudRecords(){
 if(!isResearcher(cloudAuth.currentUser))throw Error('연구자 계정으로 로그인해 주세요.');
 $('cloud-status').textContent='서버 응답과 행동 기록을 확인하고 있습니다…';
 const runs=await cloudSdk.getDocs(cloudSdk.collection(cloudDb,'runs'));
 const notices=[];let added=0,duplicates=0,conflicts=0,incomplete=0;
 for(const runDoc of runs.docs){
  try{
   const run=JSON.parse(runDoc.data().payload);
   if(run.id!==runDoc.id)throw Error('실행 식별자 불일치');
   const chunks=await cloudSdk.getDocs(cloudSdk.collection(cloudDb,'runs',run.id,'chunks'));
   const receipt=await cloudSdk.getDocFromServer(cloudSdk.doc(cloudDb,'runs',run.id,'receipts','final'));
   if(!receipt.exists()||receipt.data().ownerUid!==runDoc.data().ownerUid)throw Error('최종 수신 확인 없음');
   const receiptData=JSON.parse(receipt.data().payload);
   if(!Array.isArray(receiptData.chunkIds)||new Set(receiptData.chunkIds).size!==receiptData.chunkIds.length||receiptData.chunkIds.length>20000)throw Error('수신 확인 묶음 목록 오류');
   const manifest=new Set(receiptData.chunkIds),eventsById=new Map();let foundChunks=0;
   for(const chunk of chunks.docs){
    if(!manifest.has(chunk.id))continue;
    if(chunk.data().ownerUid!==runDoc.data().ownerUid)throw Error('기록 소유자 불일치');foundChunks++;
    for(const event of JSON.parse(chunk.data().payload)){
     const previous=eventsById.get(event.id);if(previous&&JSON.stringify(previous)!==JSON.stringify(event))throw Error('충돌하는 행동 이벤트');eventsById.set(event.id,event);
    }
   }
   if(foundChunks!==manifest.size)throw Error('수신 확인의 일부 기록 묶음 없음');
   const events=[...eventsById.values()].sort((a,b)=>a.at.localeCompare(b.at)||a.pageId.localeCompare(b.pageId)||a.sequence-b.sequence);
   const validReceipt=await verifyCloudReceipt(run,events,receipt.data());
   if(!validReceipt){incomplete++;notices.push(`${run.participantCode}: 최종 수신 확인과 응답·기록이 일치하지 않아 가져오지 않았습니다.`);continue;}
   const envelope=makeEnvelope(run,events);validateEnvelope(envelope);
   const merged=mergeEnvelopes(state.envelopes,[envelope]);state.envelopes=merged.items;added+=merged.added;duplicates+=merged.duplicates;conflicts+=merged.conflicts.length;
  }catch(error){incomplete++;notices.push(`${runDoc.id}: ${error.message}`);}
 }
 const saved=await persist();render();$('cloud-status').textContent=`서버 조회 완료 · 추가 ${added}, 중복 ${duplicates}, 충돌 ${conflicts}, 미완료·확인 필요 ${incomplete}`;
 message(`서버 자료: 추가 ${added}, 중복 ${duplicates}, 충돌 ${conflicts}, 미완료·확인 필요 ${incomplete}${saved?'':' · 로컬 저장 실패: 전체 보관 JSON을 내려받으세요.'}\n${notices.join('\n')}`,conflicts>0||incomplete>0||!saved);
}
export async function verifyCloudReceipt(run,events,receipt){
 if(!receipt||run.status!=='completed')return false;
 const value=typeof receipt.payload==='string'?JSON.parse(receipt.payload):receipt;
 if(value.runId!==run.id||value.submissionCount!==run.submissions.length||value.completedAt!==run.finishedAt||value.eventCount!==events.length)return false;
 const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(events.map(e=>e.id).sort().join('\n'))))].map(v=>v.toString(16).padStart(2,'0')).join('');
 return value.eventIdsHash===hash;
}

try {
  repository = await new ResearchStore().init(); state = repository.state;
  const navigation=[...document.querySelectorAll('[data-view]')];
  navigation.forEach((button,index)=>{
    button.onclick=()=>navigateView(button.dataset.view);
    button.onkeydown=event=>{
      if(!['ArrowDown','ArrowUp','ArrowRight','ArrowLeft','Home','End'].includes(event.key))return;
      event.preventDefault();const next=event.key==='Home'?0:event.key==='End'?navigation.length-1:(index+(['ArrowDown','ArrowRight'].includes(event.key)?1:-1)+navigation.length)%navigation.length;
      navigation[next].focus();navigateView(navigation[next].dataset.view,false);
    };
  });
  window.addEventListener('beforeunload',event=>{if(gradeDirty()||persistenceFailed||gradingBusy||readingFiles||invitationBusy||cloudBusy){event.preventDefault();event.returnValue='';}});
  savedStatus(); render();bindCloud();
  if(location.hostname==='minestero00.github.io'||new URLSearchParams(location.search).get('cloud')==='1')void cloudAction(async()=>{});
  if (repository.mode === 'memory') message('이 환경에서는 연구자 기록을 자동 보관할 수 없습니다. 작업 중 전체 보관 파일을 자주 내려받으세요.', true);
} catch (error) { $('research-view').textContent = `작업실을 열지 못했습니다. 새로고침 후 다시 시도해 주세요. ${error.message}`; }
