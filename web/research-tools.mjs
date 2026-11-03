import { STUDY, TASKS } from './content.mjs';
import { ANSWER_KEY, AI_GRADING_INSTRUCTIONS } from './research-key.mjs';
import { analyseRun, toCSV } from './core.mjs';

export const responseId = (runId, taskId) => `${runId}:${taskId}:memo`;
export function knownResponses(envelopes) {
  return new Set(envelopes.flatMap(({ run }) => TASKS.filter(t => run.responses[t.id]?.memo).map(t => responseId(run.id, t.id))));
}
export function blindPacket(envelopes, ai = false) {
  const items = envelopes.flatMap(({ run }) => TASKS.flatMap(task => {
    const memo = run.responses[task.id]?.memo;
    return memo ? [{ responseId: responseId(run.id, task.id), taskId: task.id, text: memo.unknown ? '모르겠습니다.' : memo.text }] : [];
  }));
  for (let i = items.length - 1; i > 0; i--) {
    const value = crypto.getRandomValues(new Uint32Array(1))[0];
    const j = value % (i + 1); [items[i], items[j]] = [items[j], items[i]];
  }
  return {
    format: ai ? 'hci-ai-grading-packet' : 'hci-blind-grading-packet', schemaVersion: 1,
    studyVersion: STUDY.version, packetId: crypto.randomUUID(), createdAt: new Date().toISOString(),
    ...(ai ? { instructions: AI_GRADING_INSTRUCTIONS, outputFormat: {
      format: 'hci-ratings', schemaVersion: 1, studyVersion: STUDY.version, role: 'ai',
      model: '실제 모델 식별자', promptVersion: '실제 프롬프트 버전',
      ratings: [{ responseId: '입력의 responseId', score: 0, evidence: '답안의 근거', reason: '루브릭 적용 이유' }]
    } } : {}),
    tasks: TASKS.map(t => ({ id: t.id, title: t.title, brief: t.brief, sources: t.sources, plans: t.plans, memo: t.memo, rubric: { criteria: ANSWER_KEY[t.id].criteria, rubric: ANSWER_KEY[t.id].rubric, anchors: ANSWER_KEY[t.id].anchors } })),
    items
  };
}
function text(value, max = 4000) { return typeof value === 'string' && value.length <= max; }
const own = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
function validResponseId(value) {
  if (!text(value, 150)) return false;
  const parts=value.split(':');
  return parts.length===3 && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(parts[0]) && TASKS.some(task=>task.id===parts[1]) && parts[2]==='memo';
}
function bothHumans(record) { return record && own(record,'rater1') && own(record,'rater2') && Number.isInteger(record.rater1?.score) && Number.isInteger(record.rater2?.score); }
export function validateBlindPacket(packet) {
  if (packet?.format !== 'hci-blind-grading-packet' || packet.schemaVersion !== 1 || packet.studyVersion !== STUDY.version || !Array.isArray(packet.items) || packet.items.length > 10000) throw Error('이 버전의 블라인드 채점 파일이 아닙니다.');
  const seen = new Set();
  for (const item of packet.items) {
    if (!validResponseId(item.responseId) || item.responseId.split(':')[1] !== item.taskId || seen.has(item.responseId) || !TASKS.some(t => t.id === item.taskId) || !text(item.text, 2000)) throw Error('채점 답안의 식별자·내용을 확인하세요.');
    seen.add(item.responseId);
  }
  return true;
}
export function validateRatings(file, knownIds) {
  if (file?.format !== 'hci-ratings' || file.schemaVersion !== 1 || file.studyVersion !== STUDY.version || !['rater1', 'rater2', 'consensus', 'ai'].includes(file.role) || !Array.isArray(file.ratings) || file.ratings.length > 10000) throw Error('지원하는 채점 결과 파일이 아닙니다.');
  if (file.role === 'ai' && (!text(file.model, 200) || !file.model.trim() || !text(file.promptVersion, 200) || !file.promptVersion.trim())) throw Error('AI 결과에는 실제 모델과 프롬프트 버전이 필요합니다.');
  const seen = new Set();
  for (const r of file.ratings) {
    if (!validResponseId(r.responseId) || seen.has(r.responseId) || !knownIds.has(r.responseId) || !Number.isInteger(r.score) || r.score < 0 || r.score > 2 || !text(r.reason ?? '', 4000) || !text(r.evidence ?? '', 4000)) throw Error('채점 대상·점수·중복 항목을 확인하세요.');
    if (r.criteriaSatisfied !== undefined && (!Array.isArray(r.criteriaSatisfied) || r.criteriaSatisfied.length > 2 || new Set(r.criteriaSatisfied).size !== r.criteriaSatisfied.length || !r.criteriaSatisfied.every(n => n === 1 || n === 2))) throw Error('충족한 채점 기준 번호는 1·2만 사용할 수 있습니다.');
    seen.add(r.responseId);
  }
  return true;
}
export function applyRatings(current, file, knownIds) {
  validateRatings(file, knownIds);
  const ratings = structuredClone(current), conflicts = [];
  let added = 0, duplicates = 0;
  for (const item of file.ratings) {
    const existing=own(ratings,item.responseId) ? ratings[item.responseId] : null;
    if (file.role === 'consensus' && !bothHumans(existing)) throw Error('합의 점수보다 두 사람의 독립 채점을 먼저 가져오세요.');
    const previous = existing && own(existing,file.role) ? existing[file.role] : null;
    const next = { score: item.score, reason: item.reason || '', evidence: item.evidence || '', at: new Date().toISOString(), ...(item.criteriaSatisfied ? { criteriaSatisfied: [...item.criteriaSatisfied] } : {}), ...(file.role === 'ai' ? { model: file.model, promptVersion: file.promptVersion } : {}) };
    if (previous) {
      if (previous.score === next.score && previous.reason === next.reason && previous.evidence === next.evidence && (previous.model || '') === (next.model || '') && (previous.promptVersion || '') === (next.promptVersion || '')) duplicates++;
      else conflicts.push(item.responseId);
    } else {
      if (!own(ratings,item.responseId)) Object.defineProperty(ratings,item.responseId,{value:{},writable:true,enumerable:true,configurable:true});
      Object.defineProperty(ratings[item.responseId],file.role,{value:next,writable:true,enumerable:true,configurable:true}); added++;
    }
  }
  return { ratings, added, duplicates, conflicts };
}
export function numericRatings(ratings) {
  return Object.fromEntries(Object.entries(ratings).filter(([id])=>validResponseId(id)).map(([id, values]) => [id, Object.fromEntries(Object.entries(values).filter(([role, value]) => ['rater1', 'rater2', 'consensus', 'ai'].includes(role) && value && Number.isInteger(value.score) && (role !== 'consensus' || bothHumans(values))).map(([role, value]) => [role, value.score]))]));
}
export function analysisTables(envelopes, ratings = {}, includeDemo = false) {
  const selected = envelopes.filter(e => includeDemo || e.run.mode === 'pilot');
  const invitations = new Map();
  for (const {run} of selected) if (run.invitationId) invitations.set(run.invitationId, (invitations.get(run.invitationId) || 0) + 1);
  const participants = [], cases = [], items = [], events = [];
  const numeric = numericRatings(ratings);
  for (const envelope of selected) {
    const { run } = envelope, analysis = analyseRun(run, ANSWER_KEY, numeric);
    const base = { study_version: run.studyVersion, run_id: run.id, participant_code: run.participantCode, mode: run.mode, condition: run.condition, invitation_id: run.invitationId || '' };
    const duplicateInvitation = Boolean(run.invitationId && invitations.get(run.invitationId) > 1);
    participants.push({ ...base, status: run.status, started_at: run.startedAt, finished_at: run.finishedAt, complete_cases: analysis.summary.completeCases, duplicate_invitation: duplicateInvitation ? 1 : 0, primary_eligible: run.mode === 'pilot' && run.status === 'completed' && analysis.summary.completeCases === TASKS.length && analysis.summary.meanGap !== null && !duplicateInvitation ? 1 : 0, mean_gap: analysis.summary.meanGap, mean_absolute_error: analysis.summary.meanAbsoluteError, mean_score: analysis.summary.meanScore, mean_prediction: analysis.summary.meanPrediction, mean_burden: analysis.summary.meanBurden });
    for (const c of analysis.cases) {
      const r = run.responses[c.taskId], task = TASKS.find(t => t.id === c.taskId), id = responseId(run.id, c.taskId), grades = ratings[id] || {};
      cases.push({ ...base, task_id: c.taskId, position: c.position, initial_choice: r.initial?.choice, initial_correct: c.initialCorrect, prediction_4: c.prediction, burden_7: c.burden, mc_2: c.mcScore, human_4: c.humanScore, ai_4: c.aiScore, mixed_4: c.mixedScore, human_gap: c.humanGap, ai_gap: c.aiGap, mixed_gap: c.mixedGap, absolute_error: c.absoluteError, rater1: grades.rater1?.score, rater2: grades.rater2?.score, consensus: grades.consensus?.score, ai: grades.ai?.score, ai_model: grades.ai?.model, ai_prompt_version: grades.ai?.promptVersion, memo: r.memo?.text, memo_unknown: r.memo?.unknown === true ? 1 : 0 });
      for (const update of task.updates) {
        const answer = r.updates[update.id];
        items.push({ ...base, task_id: task.id, item_id: update.id, item_type: 'application', response_id: `${run.id}:${task.id}:${update.id}`, choice: answer?.choice, text: '', automatic_score: answer ? Number(answer.choice === ANSWER_KEY[task.id].updates[update.id]) : null, human_consensus: null, ai_score: null });
      }
      items.push({ ...base, task_id: task.id, item_id: 'memo', item_type: 'explanation', response_id: id, choice: '', text: r.memo?.text, automatic_score: null, human_consensus: grades.consensus?.score, ai_score: grades.ai?.score });
    }
    for (const event of envelope.events) events.push({ ...base, event_id: event.id ?? event.eventId, page_id: event.pageId, sequence: event.sequence ?? event.seq, at: event.at ?? event.timestamp, monotonic_ms: event.monotonicMs ?? event.elapsedMs, phase: event.phase, task_id: event.taskId, update_id: event.updateId, type: event.type ?? event.event, data_json: JSON.stringify(event.data ?? event.payload ?? {}) });
  }
  return { participants, cases, items, events };
}
export function tableCSV(table) { return toCSV(table, table[0] ? Object.keys(table[0]) : ['no_records']); }
