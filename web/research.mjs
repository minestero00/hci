import { STUDY, TASKS } from './content.mjs';
import { ANSWER_KEY } from './research-key.mjs';
import { validateEnvelope, mergeEnvelopes, makeInvitations } from './core.mjs';
import { ResearchStore } from './research-store.mjs';
import { responseId, knownResponses, blindPacket, validateBlindPacket, applyRatings, analysisTables, tableCSV } from './research-tools.mjs';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const taskById = id => TASKS.find(t => t.id === id);
const roleNames = { rater1: '채점자 1', rater2: '채점자 2', consensus: '인간 합의', ai: 'AI 독립 채점' };
let repository, state, currentView = 'collect', gradeIndex = 0, saveQueue = Promise.resolve();

function message(text, error = false) {
  $('research-message').innerHTML = text ? `<div class="r-message${error ? ' error' : ''}">${esc(text)}</div>` : '';
}
function savedStatus(error = false) {
  $('research-save').textContent = error ? '저장 실패 · 파일로 보관하세요' : repository.mode === 'indexeddb' ? '이 브라우저에 저장됨' : '현재 탭에 임시 보관 중';
}
async function persist() {
  const snapshot = { ...state, ratings: structuredClone(state.ratings), gradeHistory: [...state.gradeHistory], invitations: [...state.invitations] };
  $('research-save').textContent = '저장 중';
  saveQueue = saveQueue.catch(() => {}).then(() => repository.save(snapshot));
  try { await saveQueue; savedStatus(); }
  catch (error) { savedStatus(true); message(`자동 저장에 실패했습니다. 전체 보관 파일을 내려받아 주세요. ${error.message}`, true); }
}
function download(name, content, type = 'application/json') {
  const blob = new Blob([typeof content === 'string' ? content : JSON.stringify(content, null, 2)], { type });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = name;
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500);
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
function importControl(id = 'research-files', label = '응답 파일 가져오기') {
  return `<label class="r-drop" id="drop-${id}"><strong>${label}</strong><small>JSON 여러 개를 함께 선택하거나 이 영역에 놓으세요.</small><input class="r-file" type="file" id="${id}" accept=".json,application/json" multiple></label>`;
}
function table(headers, rows) {
  return `<div class="r-table"><table><thead><tr>${headers.map(h => `<th scope="col">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('') : `<tr><td colspan="${headers.length}"><div class="r-empty">아직 기록이 없습니다.</div></td></tr>`}</tbody></table></div>`;
}
function renderCollect() {
  const s = stats();
  const inviteCounts = new Map();
  for (const {run} of state.envelopes) if (run.invitationId) inviteCounts.set(run.invitationId, (inviteCounts.get(run.invitationId) || 0) + 1);
  const reused = [...inviteCounts.values()].filter(n => n > 1).length;
  return header('01 / COLLECTION', '흩어진 기록을 한곳에.', '참가자가 내려받은 응답 파일을 가져오세요. 원응답과 행동 로그는 그대로 보존하고, 채점 결과를 연결합니다.') +
    `<div class="research-cards"><div class="research-stat"><span>가져온 실행</span><b>${s.runs}<small> 건</small></b></div><div class="research-stat"><span>완료한 실행</span><b>${s.completed}<small> 건</small></b></div><div class="research-stat"><span>인간 합의 채점</span><b>${s.rated}<small> / ${s.memos}</small></b></div></div>` +
    `<section class="r-panel"><h2>참가자 기록 가져오기</h2><p>완료·중단 파일 모두 가져올 수 있습니다. 같은 실행의 동일 파일은 한 번만 합쳐집니다.</p>${importControl()}<div class="r-note">이 페이지도 파일 기반입니다. 다른 기기로 옮기거나 브라우저 데이터를 지우기 전에 전체 보관 파일을 내려받으세요.</div><div class="r-actions"><button class="r-button secondary" id="archive-download">전체 보관 파일 내려받기</button></div></section>` +
    `<section class="r-panel"><h2>수집 현황</h2><p>팀 체험 기록과 초대 참여 기록은 구분되며, 기본 분석 내보내기는 팀 체험을 제외합니다.</p>${reused ? `<div class="r-note warning">${reused}개의 초대 링크에 여러 실행이 있습니다. 참가자별 CSV에서 duplicate_invitation을 확인하세요. 해당 실행은 주 분석 가능 표지에서 제외됩니다.</div>` : ''}${table(['참가자 코드', '실행 종류', '배정', '진행', '응답', '로그'], state.envelopes.map(e => {
      const run = e.run, count = TASKS.filter(t => run.responses[t.id]?.memo).length;
      return [esc(run.participantCode), pills(run.mode), run.condition === 'assisted' ? 'AI 지원' : '원자료', run.status === 'completed' ? '완료' : '진행 중·중단', `${count} / ${TASKS.length}`, `${e.events.length.toLocaleString()}개`];
    }))}</section>`;
}
function renderInvitations() {
  return header('02 / INVITATIONS', '같은 안내, 균형 있는 초대.', '한 배치 안에서 두 조건과 사례 순서를 나누어 참여 링크를 만듭니다. 참가자는 링크에 배정된 한 조건으로만 진행합니다.') +
    `<section class="r-panel"><h2>참여 링크 만들기</h2><form id="invite-form" class="r-form"><label class="r-label">새 배치 인원<input id="invite-count" class="r-input" type="number" min="1" max="500" value="20" required></label><button class="r-button" type="submit">초대 배치 생성</button></form><div class="r-note">배정은 생성한 배치 안에서 균형을 맞춥니다. 정적 사이트이므로 서로 다른 연구자가 만든 배치나 링크의 중복 사용을 서버에서 조정하지 않습니다.</div><div class="r-actions"><button class="r-button secondary" id="invite-csv" ${state.invitations.length ? '' : 'disabled'}>링크 목록 CSV</button><button class="r-button secondary" id="invite-json" ${state.invitations.length ? '' : 'disabled'}>초대 배치 JSON</button></div></section>` +
    `<section class="r-panel"><h2>현재 초대 배치 <span class="r-help">${state.invitations.length}개</span></h2>${table(['코드', '조건', '사례 순서', '참여 링크'], state.invitations.map(i => [esc(i.participantCode), i.condition === 'assisted' ? 'AI 지원' : '원자료', esc(i.order.map(id => taskById(id)?.title || id).join(' → ')), `<button class="r-button secondary copy-invite" data-id="${esc(i.id)}">링크 복사</button> <a class="quiet-link" href="${esc(i.url)}" target="_blank" rel="noopener">열기 ↗</a>`]))}</section>`;
}
function renderSources(task) {
  return task.sources.map(source => `<section><h3>${esc(source.title)}</h3>${source.blocks.map(b => b.type === 'p' ? `<p>${esc(b.text)}</p>` : b.type === 'list' ? `<ul>${b.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul>` : b.type === 'table' ? `<div class="r-table"><table><thead><tr>${b.columns.map(c => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${b.rows.map(row => `<tr>${row.map(c => `<td>${esc(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>` : '').join('')}</section>`).join('') + `<h3>최초 제안된 실행안</h3><ul>${task.plans.map(p => `<li><b>${esc(p.title)}</b> · ${esc(p.description)}</li>`).join('')}</ul>`;
}
function gradeItems() { return state.packet?.items || []; }
function renderGrading() {
  const items = gradeItems(), role = state.role || 'rater1', item = items[gradeIndex];
  const intro = header('03 / BLIND REVIEW', '답안의 근거만 보고 채점합니다.', '조건·예상 점수·최초 선택·행동 로그·AI 점수는 이 화면에 표시하지 않습니다. 채점자 1과 2는 각자 별도의 브라우저에서 채점 묶음을 사용하세요.');
  const controls = `<section class="r-panel"><div class="r-form"><label class="r-label">현재 채점 역할<select id="grade-role" class="r-select"><option value="rater1" ${role === 'rater1' ? 'selected' : ''}>채점자 1</option><option value="rater2" ${role === 'rater2' ? 'selected' : ''}>채점자 2</option><option value="consensus" ${role === 'consensus' ? 'selected' : ''}>인간 합의</option></select></label><button id="new-packet" class="r-button secondary" ${state.envelopes.length ? '' : 'disabled'}>현재 기록으로 묶음 생성</button><button id="grade-export" class="r-button secondary" ${items.length ? '' : 'disabled'}>내 채점 결과 내려받기</button></div><p class="r-help">다른 채점자의 파일도 아래에서 가져올 수 있습니다. 독립 채점 중에는 해당 점수를 보여주지 않습니다.</p><input type="file" id="grading-files" class="r-file" accept=".json,application/json" multiple></section>`;
  if (!item) return intro + controls + `<div class="r-panel r-empty">원응답으로 채점 묶음을 생성하거나, 전달받은 블라인드 채점 JSON을 가져오세요.</div>`;
  const task = taskById(item.taskId), key = ANSWER_KEY[task.id], grades = state.ratings[item.responseId] || {}, current = grades[role];
  const hasBoth = grades.rater1 && grades.rater2;
  const consensusNote = role === 'consensus' ? `<div class="r-note${hasBoth ? '' : ' warning'}">${hasBoth ? `채점자 1: ${grades.rater1.score}점 · 채점자 2: ${grades.rater2.score}점. AI 점수는 표시하지 않습니다.` : '두 채점자의 독립 점수를 먼저 가져오세요. 합의 입력은 그 뒤 가능합니다.'}</div>` : '';
  const disabled = role === 'consensus' && !hasBoth;
  return intro + controls + `<div class="r-grading-header"><span class="r-help">답안 ${gradeIndex + 1} / ${items.length} · ${esc(task.title)}</span><button class="quiet-link" id="blind-toggle" type="button">${document.body.classList.contains('blind-active') ? '관리 메뉴 보이기' : '채점 화면에 집중'}</button></div><section class="r-panel"><p class="r-prompt">${esc(task.memo.prompt)}</p><div class="r-answer">${esc(item.text)}</div>${consensusNote}<h2>판단할 관계</h2><ol class="r-criteria">${key.criteria.map(c => `<li>${esc(c)}</li>`).join('')}</ol><form id="grade-form"><fieldset style="border:0;padding:0;margin:0"><legend class="r-help">${esc(roleNames[role])} 점수</legend><div class="r-score">${[0,1,2].map(n => `<label><input type="radio" name="score" value="${n}" ${current?.score === n ? 'checked' : ''} ${disabled ? 'disabled' : ''} required>${n}점</label>`).join('')}</div></fieldset><label class="r-label">판단 근거<textarea class="r-textarea" id="grade-reason" maxlength="4000" ${disabled ? 'disabled' : ''} placeholder="어느 관계를 설명했는지 짧게 남겨 주세요.">${esc(current?.reason || '')}</textarea></label><div class="r-actions"><button class="r-button" ${disabled ? 'disabled' : ''}>${current ? '점수·근거 저장' : '채점 저장'}</button><button class="r-button secondary" type="button" id="grade-prev" ${gradeIndex === 0 ? 'disabled' : ''}>이전 답안</button><button class="r-button secondary" type="button" id="grade-next" ${gradeIndex === items.length - 1 ? 'disabled' : ''}>다음 답안</button></div></form></section><details class="r-panel"><summary>공통 기준과 경계 답안</summary><div class="r-anchors">${[2,1,0].map(n => `<p><b>${n}점</b> · ${esc(key.rubric[n])}</p>`).join('')}${key.anchors.map(a => `<p><b>${a.score}점 예시</b> · ${esc(a.text)}<br>${esc(a.reason)}</p>`).join('')}</div></details><details class="r-panel"><summary>이 업무의 원자료 보기</summary><div class="r-source">${renderSources(task)}</div></details>`;
}
function renderExport() {
  return header('04 / ANALYSIS FILES', '원기록에서 분석 자료까지.', '미채점은 빈칸으로 남깁니다. 인간 합의 점수가 모두 있어야 참가자별 주 분석값을 계산합니다.') +
    `<section class="r-panel"><h2>분석용 CSV</h2><p>사례·문항·이벤트를 독립 참가자로 세지 마세요. 세 사례 평균이 참가자 한 명의 주 분석값입니다.</p><label class="r-inline"><input type="checkbox" id="include-demo"> 팀 체험 기록도 포함 <span class="r-help">기본은 초대 참여만</span></label><div class="r-actions">${[['participants','참가자별'],['cases','사례별'],['items','문항별'],['events','행동 로그']].map(([id,label]) => `<button class="r-button secondary" data-export="${id}">${label} CSV</button>`).join('')}</div><div class="r-note">실제 점수 = 선택형 합계 + 인간 합의 점수. AI 단독·인간/AI 평균은 별도 열로 출력합니다. 점수 0과 미채점은 구분합니다.</div></section>` +
    `<div class="r-grid-two"><section class="r-panel"><h2>독립 채점 파일</h2><p>조건과 예상 점수를 제외한 답안·원자료·기준을 전달합니다.</p><div class="r-actions"><button class="r-button" id="blind-export" ${state.envelopes.length ? '' : 'disabled'}>인간 채점 묶음</button><button class="r-button secondary" id="ai-export" ${state.envelopes.length ? '' : 'disabled'}>AI 채점 입력 묶음</button></div><p class="r-help">AI를 자동 호출하지 않습니다. 입력 묶음의 형식에 맞춘 결과 JSON을 가져오면 연결됩니다.</p></section><section class="r-panel"><h2>채점 결과 가져오기</h2><p>인간 1·2·합의 또는 모델·프롬프트 버전이 포함된 AI 결과를 가져옵니다.</p><input class="r-file" id="rating-files" type="file" accept=".json,application/json" multiple><p class="r-help">같은 답안·역할의 서로 다른 점수는 자동으로 덮어쓰지 않습니다.</p></section></div>` +
    `<section class="r-panel"><h2>전체 보관</h2><p>원응답·로그·채점·초대 배치를 하나의 파일로 보관합니다. 보관 파일도 ‘기록 모으기’에서 복원할 수 있습니다.</p><button class="r-button secondary" id="archive-download">전체 보관 파일 내려받기</button></section>`;
}
function render(view = currentView, focus = false) {
  currentView = view;
  document.querySelectorAll('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false'); });
  $('research-view').innerHTML = ({ collect: renderCollect, invite: renderInvitations, grade: renderGrading, export: renderExport })[view]();
  bind(); if (focus) $('research-main').focus({ preventScroll: true });
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
  if (files.length > 100) { message('한 번에 100개 이하의 파일을 선택해 주세요.', true); return; }
  const notices = [];
  let problems = 0;
  for (const file of files) {
    try {
      if (file.size > 30 * 1024 * 1024) throw Error('파일 하나는 30MB 이하로 나누어 주세요.');
      const value = JSON.parse(await file.text());
      if (value.format === 'hci-workspace-export') {
        validateEnvelope(value); const merged = mergeEnvelopes(state.envelopes, [value]);
        state.envelopes = merged.items;
        notices.push(`${file.name}: 추가 ${merged.added}, 중복 ${merged.duplicates}${merged.conflicts.length ? `, 충돌 ${merged.conflicts.length}건(기존 기록 유지)` : ''}`);
      } else if (value.format === 'hci-blind-grading-packet') {
        validateBlindPacket(value); state.packet = value; gradeIndex = 0;
        notices.push(`${file.name}: 블라인드 답안 ${value.items.length}개`);
      } else if (value.format === 'hci-ratings') {
        const ids = new Set([...knownResponses(state.envelopes), ...(state.packet?.items.map(i => i.responseId) || [])]);
        const result = applyRatings(state.ratings, value, ids); state.ratings = result.ratings;
        notices.push(`${file.name}: 채점 추가 ${result.added}, 중복 ${result.duplicates}${result.conflicts.length ? `, 충돌 ${result.conflicts.length}건(기존 점수 유지)` : ''}`);
      } else if (value.format === 'hci-research-archive') {
        if (value.schemaVersion !== 1 || value.studyVersion !== STUDY.version || !Array.isArray(value.envelopes) || value.envelopes.length > 1000) throw Error('현재 버전의 보관 파일이 아닙니다.');
        value.envelopes.forEach(validateEnvelope);
        if (value.packet !== null && value.packet !== undefined) validateBlindPacket(value.packet);
        const merged = mergeEnvelopes(state.envelopes, value.envelopes);
        const packet = state.packet || value.packet || null;
        const ids = new Set([...knownResponses(merged.items), ...(packet?.items.map(i => i.responseId) || [])]);
        let nextRatings = state.ratings;
        for (const role of ['rater1','rater2','consensus','ai']) {
          const entries = Object.entries(value.ratings || {}).filter(([,r]) => r?.[role]);
          for (const [id, r] of entries) {
            const rating = r[role];
            const file = { format:'hci-ratings',schemaVersion:1,studyVersion:STUDY.version,role,model:rating.model,promptVersion:rating.promptVersion,ratings:[{responseId:id,...rating}] };
            const result = applyRatings(nextRatings, file, ids); nextRatings = result.ratings;
          }
        }
        const restoredInvites = Array.isArray(value.invitations) ? value.invitations : [];
        if (restoredInvites.length > 5000) throw Error('초대 배치가 너무 큽니다.');
        for (const invitation of restoredInvites) {
          const parsed = new URL(invitation.url);
          if (!['https:','http:'].includes(parsed.protocol) || typeof invitation.id !== 'string' || !Array.isArray(invitation.order) || !invitation.order.every(id => TASKS.some(t => t.id === id))) throw Error('보관 파일의 초대 링크 형식이 올바르지 않습니다.');
        }
        state.envelopes = merged.items; state.ratings = nextRatings; state.packet = packet;
        state.invitations = [...new Map([...state.invitations,...restoredInvites].map(i => [i.id,i])).values()];
        if (['rater1','rater2','consensus'].includes(value.role)) state.role = value.role;
        notices.push(`${file.name}: 보관 자료 추가 ${merged.added}, 중복 ${merged.duplicates}, 충돌 ${merged.conflicts.length}`);
      } else throw Error('응답·채점·블라인드 묶음·보관 JSON 중 하나를 선택해 주세요.');
    } catch (error) { problems++; notices.push(`${file.name}: ${error.message}`); }
  }
  await persist(); render(); message(notices.join('\n'), problems > 0);
}
function bind() {
  ['research-files','grading-files','rating-files'].forEach(bindFiles);
  if ($('archive-download')) $('archive-download').onclick = () => jsonDownload('hci-research-archive', archive());
  if ($('invite-form')) $('invite-form').onsubmit = async event => {
    event.preventDefault();
    try {
      const count = Number($('invite-count').value);
      if (!Number.isInteger(count) || count < 1 || count > 500) throw Error('1~500명 사이로 입력해 주세요.');
      const generated = makeInvitations(count, new URL('./index.html', location.href).href);
      state.invitations = [...state.invitations, ...generated]; await persist(); render();
      message(`${generated.length}개의 링크를 새 배치로 만들었습니다. 목록을 내려받아 전달하세요.`);
    } catch (error) { message(error.message, true); }
  };
  if ($('invite-csv')) $('invite-csv').onclick = () => csvDownload('hci-invitations', state.invitations.map(i => ({ invitation_id:i.id,participant_code:i.participantCode,condition:i.condition,order:i.order.join('>'),url:i.url })));
  if ($('invite-json')) $('invite-json').onclick = () => jsonDownload('hci-invitations', { format:'hci-invitations',studyVersion:STUDY.version,invitations:state.invitations });
  document.querySelectorAll('.copy-invite').forEach(button => button.onclick = async () => {
    const url = state.invitations.find(i => i.id === button.dataset.id)?.url;
    try { await navigator.clipboard.writeText(url); button.textContent = '복사됨'; }
    catch { message(`링크를 복사해 주세요:\n${url}`); }
  });
  if ($('new-packet')) $('new-packet').onclick = async () => { state.packet = blindPacket(state.envelopes); gradeIndex = 0; await persist(); render(); };
  if ($('grade-role')) $('grade-role').onchange = async event => { state.role = event.target.value; await persist(); render(); };
  if ($('grade-prev')) $('grade-prev').onclick = () => { gradeIndex--; render(); };
  if ($('grade-next')) $('grade-next').onclick = () => { gradeIndex++; render(); };
  if ($('blind-toggle')) $('blind-toggle').onclick = () => { document.body.classList.toggle('blind-active'); render(); };
  if ($('grade-form')) $('grade-form').onsubmit = async event => {
    event.preventDefault(); const item = gradeItems()[gradeIndex], role = state.role;
    const raw = new FormData(event.target).get('score');
    if (raw === null || !['0','1','2'].includes(raw)) { message('0~2점 중 하나를 선택해 주세요.', true); return; }
    const previous = state.ratings[item.responseId]?.[role] || null;
    if (role === 'consensus' && !(state.ratings[item.responseId]?.rater1 && state.ratings[item.responseId]?.rater2)) { message('두 사람의 독립 채점을 먼저 가져오세요.', true); return; }
    state.gradeHistory.push({ responseId:item.responseId,role,previous,at:new Date().toISOString() });
    state.ratings[item.responseId] ??= {};
    state.ratings[item.responseId][role] = { score:Number(raw),reason:$('grade-reason').value.trim(),evidence:'',at:new Date().toISOString() };
    await persist(); render(); message(`${gradeIndex + 1}번 답안의 ${roleNames[role]} 점수를 저장했습니다.`);
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
  if ($('blind-export')) $('blind-export').onclick = () => jsonDownload('hci-blind-grading-packet', blindPacket(state.envelopes));
  if ($('ai-export')) $('ai-export').onclick = () => jsonDownload('hci-ai-grading-packet', blindPacket(state.envelopes, true));
}

try {
  repository = await new ResearchStore().init(); state = repository.state;
  document.querySelectorAll('[data-view]').forEach(button => button.onclick = () => { message(''); render(button.dataset.view, true); });
  savedStatus(); render();
  if (repository.mode === 'memory') message('이 환경에서는 연구자 기록을 자동 보관할 수 없습니다. 작업 중 전체 보관 파일을 자주 내려받으세요.', true);
} catch (error) { $('research-view').textContent = `작업실을 열지 못했습니다. 새로고침 후 다시 시도해 주세요. ${error.message}`; }
