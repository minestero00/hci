import { STUDY, TASKS } from './content.mjs';

const PHASES = ['practice', 'decision', 'estimate', 'update', 'memo', 'done'];
const CONDITIONS = ['control', 'assisted'];
const MODES = ['demo', 'pilot'];
const MAX_EVENTS = 200000;
const MAX_SUBMISSIONS = 1 + TASKS.length * 5;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const copy = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));

function fail(message, code = 'INVALID_DATA') {
  const error = new Error(message);
  error.code = code;
  throw error;
}
function requireThat(condition, message, code) { if (!condition) fail(message, code); }
function keys(value, allowed, required = allowed, label = '자료') {
  requireThat(isObject(value), `${label} 형식이 올바르지 않습니다.`);
  const found = Object.keys(value);
  requireThat(found.every(key => allowed.includes(key)) && required.every(key => own(value, key)), `${label}의 항목이 올바르지 않습니다.`);
}
function text(value, max = 128, label = '문자열', empty = false) {
  requireThat(typeof value === 'string' && value.length <= max && (empty || value.trim().length > 0), `${label}을 확인해 주세요.`);
  return value;
}
function id(value, label = '식별자') {
  text(value, 160, label);
  requireThat(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(value), `${label} 형식이 올바르지 않습니다.`);
  return value;
}
function iso(value, label = '시각') {
  requireThat(typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value), `${label} 형식이 올바르지 않습니다.`);
  const parsed = new Date(value);
  requireThat(Number.isFinite(parsed.getTime()) && parsed.toISOString() === value, `${label}이 올바르지 않습니다.`);
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export function stableStringify(value) { return canonical(value); }
function jsonValue(value, depth = 0, budget = { nodes: 0 }) {
  requireThat(depth <= 8 && ++budget.nodes < 10000, '자료의 중첩 또는 항목 수가 너무 많습니다.');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') { requireThat(Number.isFinite(value), '유효하지 않은 숫자가 있습니다.'); return; }
  if (typeof value === 'string') { requireThat(value.length <= 24000, '자료의 문자열이 너무 깁니다.'); return; }
  if (Array.isArray(value)) { requireThat(value.length <= 1000, '자료 배열이 너무 깁니다.'); value.forEach(item => jsonValue(item, depth + 1, budget)); return; }
  requireThat(isObject(value), 'JSON 자료만 저장할 수 있습니다.');
  for (const [key, item] of Object.entries(value)) {
    requireThat(!['__proto__', 'prototype', 'constructor'].includes(key) && key.length <= 160, '자료에 허용되지 않는 항목이 있습니다.');
    jsonValue(item, depth + 1, budget);
  }
}
export function newId() {
  requireThat(globalThis.crypto?.getRandomValues, '이 브라우저에서는 안전한 실행 번호를 만들 수 없습니다. HTTPS 또는 localhost에서 열어 주세요.', 'CRYPTO_UNAVAILABLE');
  if (crypto.randomUUID) return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const s = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`;
}
function randomIndex(length) {
  requireThat(globalThis.crypto?.getRandomValues, 'HTTPS 또는 localhost에서 열어 주세요.', 'CRYPTO_UNAVAILABLE');
  const limit = Math.floor(0x100000000 / length) * length;
  const array = new Uint32Array(1);
  let number;
  do { crypto.getRandomValues(array); number = array[0]; } while (number >= limit);
  return number % length;
}
function shuffled(values) {
  const result = [...values];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomIndex(i + 1);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}
function taskFor(taskId) { return TASKS.find(task => task.id === taskId); }
function permutation(values, expected, label) {
  requireThat(Array.isArray(values) && values.length === expected.length && new Set(values).size === values.length && values.every(value => expected.includes(value)), `${label}가 올바르지 않습니다.`);
}
function checkAssignment(assignment) {
  keys(assignment, ['order', 'updateOrders'], undefined, '배정');
  permutation(assignment.order, TASKS.map(task => task.id), '업무 순서');
  keys(assignment.updateOrders, TASKS.map(task => task.id), undefined, '후속 요청 순서');
  for (const task of TASKS) permutation(assignment.updateOrders[task.id], task.updates.map(update => update.id), '후속 요청 순서');
}
function emptyResponses() {
  return Object.fromEntries(TASKS.map(task => [task.id, {initial: null, estimate: null, updates: {}, memo: null}]));
}
function baseState(startedAt) {
  return { status: 'in_progress', finishedAt: null, stage: {phase: 'practice', taskIndex: 0, updateIndex: 0}, responses: emptyResponses(), practice: {completedAt: null}, updatedAt: startedAt };
}
function infoUnchecked(run) {
  const phase = run.stage.phase;
  const taskId = ['practice', 'done'].includes(phase) ? null : run.assignment.order[run.stage.taskIndex];
  const updateId = phase === 'update' ? run.assignment.updateOrders[taskId][run.stage.updateIndex] : null;
  return {phase, taskId, taskIndex: run.stage.taskIndex, updateId, updateIndex: phase === 'update' ? run.stage.updateIndex : 0, step: Math.min(run.submissions.length + 1, MAX_SUBMISSIONS), totalSteps: MAX_SUBMISSIONS, progress: run.submissions.length / MAX_SUBMISSIONS};
}
function normalizedValues(run, values) {
  requireThat(isObject(values), '응답 형식을 확인해 주세요.', 'INVALID_RESPONSE');
  const { phase, taskId, updateId } = infoUnchecked(run);
  const task = taskFor(taskId);
  if (phase === 'practice') {
    keys(values, ['complete'], undefined, '연습 응답');
    requireThat(values.complete === true, '연습을 마친 뒤 계속해 주세요.', 'INVALID_RESPONSE');
    return {complete: true};
  }
  if (phase === 'decision' || phase === 'update') {
    keys(values, ['choice'], undefined, '선택 응답');
    const allowed = phase === 'decision' ? task.plans.map(plan => plan.id) : task.updates.find(update => update.id === updateId).options.map(option => option.id);
    requireThat(typeof values.choice === 'string' && [...allowed, 'unknown'].includes(values.choice), '실행안을 선택하거나 잘 모르겠습니다를 골라 주세요.', 'INVALID_RESPONSE');
    return {choice: values.choice};
  }
  if (phase === 'estimate') {
    keys(values, ['burden', 'prediction'], undefined, '예상 응답');
    requireThat(Number.isInteger(values.burden) && values.burden >= 1 && values.burden <= 7, '결정 부담을 1~7 중에서 선택해 주세요.', 'INVALID_RESPONSE');
    requireThat(typeof values.prediction === 'number' && Number.isFinite(values.prediction) && values.prediction >= 0 && values.prediction <= 4 && Number.isInteger(values.prediction * 2), '예상 점수를 0~4점에서 0.5점 간격으로 선택해 주세요.', 'INVALID_RESPONSE');
    return {burden: values.burden, prediction: values.prediction};
  }
  if (phase === 'memo') {
    keys(values, ['text', 'unknown'], [], '메모 응답');
    if (own(values, 'unknown')) requireThat(typeof values.unknown === 'boolean', '모르겠음 응답을 확인해 주세요.', 'INVALID_RESPONSE');
    if (values.unknown === true) {
      requireThat(!own(values, 'text') || values.text === '', '모르겠음과 메모를 동시에 제출할 수 없습니다.', 'INVALID_RESPONSE');
      return {text: '', unknown: true};
    }
    text(values.text, 2000, '인계 메모');
    return {text: values.text.trim(), unknown: false};
  }
  fail('이미 완료한 실행입니다.', 'RUN_COMPLETED');
}
function applySubmission(run, values, at, submissionId) {
  const { phase, taskId, updateId } = infoUnchecked(run);
  const clean = normalizedValues(run, values);
  const record = { id: submissionId, phase, taskId, updateId, at, values: clean };
  run.submissions.push(record);
  run.updatedAt = at;
  run.draft = {key: '', values: {}};
  if (phase === 'practice') {
    run.practice.completedAt = at;
    run.stage = {phase: 'decision', taskIndex: 0, updateIndex: 0};
  } else if (phase === 'decision') {
    run.responses[taskId].initial = {choice: clean.choice, at};
    run.stage = {phase: 'estimate', taskIndex: run.stage.taskIndex, updateIndex: 0};
  } else if (phase === 'estimate') {
    run.responses[taskId].estimate = {...clean, at};
    run.stage = {phase: 'update', taskIndex: run.stage.taskIndex, updateIndex: 0};
  } else if (phase === 'update') {
    run.responses[taskId].updates[updateId] = {choice: clean.choice, at};
    run.stage = run.stage.updateIndex === 0 ? {phase: 'update', taskIndex: run.stage.taskIndex, updateIndex: 1} : {phase: 'memo', taskIndex: run.stage.taskIndex, updateIndex: 0};
  } else if (phase === 'memo') {
    run.responses[taskId].memo = {...clean, at};
    if (run.stage.taskIndex < run.assignment.order.length - 1) run.stage = {phase: 'decision', taskIndex: run.stage.taskIndex + 1, updateIndex: 0};
    else {
      run.stage = {phase: 'done', taskIndex: run.assignment.order.length, updateIndex: 0};
      run.status = 'completed';
      run.finishedAt = at;
    }
  }
  return run;
}

export function createRun({participantCode, condition, mode = 'demo', order, updateOrders, invitationId = null} = {}) {
  text(participantCode, 40, '익명 참가자 코드');
  condition ??= shuffled(CONDITIONS)[0];
  requireThat(CONDITIONS.includes(condition), '실험 조건을 확인해 주세요.');
  requireThat(MODES.includes(mode), '실행 모드를 확인해 주세요.');
  if (invitationId !== null) id(invitationId, '초대 번호');
  const assignment = {order: order ? [...order] : shuffled(TASKS.map(task => task.id)), updateOrders: updateOrders ? copy(updateOrders) : Object.fromEntries(TASKS.map(task => [task.id, shuffled(task.updates.map(update => update.id))]))};
  checkAssignment(assignment);
  const startedAt = new Date().toISOString();
  const run = {schemaVersion: 1, studyVersion: STUDY.version, id: newId(), participantCode: participantCode.trim(), condition, mode, invitationId, assignment, ...baseState(startedAt), startedAt, submissions: [], draft: {key: '', values: {}}};
  validateRun(run);
  return run;
}

export function validateRun(run) {
  try {
    keys(run, ['schemaVersion','studyVersion','id','participantCode','condition','mode','invitationId','assignment','status','startedAt','updatedAt','finishedAt','stage','responses','submissions','draft','practice'], undefined, '실행 자료');
    requireThat(run.schemaVersion === 1 && run.studyVersion === STUDY.version, '이 파일럿 버전과 호환되지 않는 응답입니다.', 'VERSION_MISMATCH');
    id(run.id, '실행 번호'); text(run.participantCode, 40, '익명 참가자 코드');
    requireThat(CONDITIONS.includes(run.condition) && MODES.includes(run.mode), '실험 조건 또는 실행 모드가 올바르지 않습니다.');
    if (run.invitationId !== null) id(run.invitationId, '초대 번호');
    checkAssignment(run.assignment);
    iso(run.startedAt); iso(run.updatedAt);
    requireThat(run.updatedAt >= run.startedAt, '실행 시각의 순서가 올바르지 않습니다.');
    keys(run.stage, ['phase','taskIndex','updateIndex'], undefined, '진행 단계');
    requireThat(PHASES.includes(run.stage.phase) && Number.isInteger(run.stage.taskIndex) && Number.isInteger(run.stage.updateIndex), '진행 단계가 올바르지 않습니다.');
    keys(run.practice, ['completedAt'], undefined, '연습 상태');
    keys(run.responses, TASKS.map(task => task.id), undefined, '사례 응답');
    requireThat(Array.isArray(run.submissions) && run.submissions.length <= MAX_SUBMISSIONS, '제출 기록이 올바르지 않습니다.');
    keys(run.draft, ['key','values'], undefined, '임시 응답');
    text(run.draft.key, 256, '임시 응답 번호', true);
    requireThat(isObject(run.draft.values), '임시 응답 형식이 올바르지 않습니다.');
    jsonValue(run.draft.values);
    requireThat(JSON.stringify(run.draft.values).length <= 16000, '임시 응답이 너무 큽니다.');
    const replay = {assignment: copy(run.assignment), ...baseState(run.startedAt), submissions: [], draft: {key:'',values:{}}};
    let lastAt = run.startedAt;
    const submissionIds = new Set();
    for (const record of run.submissions) {
      keys(record, ['id','phase','taskId','updateId','at','values'], undefined, '제출 기록');
      id(record.id, '제출 번호');
      requireThat(!submissionIds.has(record.id), '중복 제출 번호가 있습니다.'); submissionIds.add(record.id);
      iso(record.at); requireThat(record.at >= lastAt && record.at <= run.updatedAt, '제출 시각의 순서가 올바르지 않습니다.'); lastAt = record.at;
      const expected = infoUnchecked(replay);
      requireThat(record.phase === expected.phase && record.taskId === expected.taskId && record.updateId === expected.updateId && expected.phase !== 'done', '제출 순서와 진행 단계가 일치하지 않습니다.');
      applySubmission(replay, record.values, record.at, record.id);
      requireThat(canonical(replay.submissions.at(-1)) === canonical(record), '제출 값과 정규화된 응답이 일치하지 않습니다.');
    }
    for (const key of ['status','finishedAt','stage','responses','practice']) requireThat(canonical(run[key]) === canonical(replay[key]), '응답과 제출 기록 또는 진행 상태가 일치하지 않습니다.');
    return true;
  } catch (error) {
    error.code ??= 'INVALID_RUN';
    throw error;
  }
}
export function stepInfo(run) { validateRun(run); return infoUnchecked(run); }
export function submitStep(run, values, now = new Date().toISOString()) {
  validateRun(run); iso(now);
  requireThat(now >= run.updatedAt, '기기 시각이 이전 저장 시각보다 이릅니다. 시각을 확인하고 다시 시도해 주세요.', 'CLOCK_REVERSED');
  const next = copy(run);
  applySubmission(next, values, now, newId());
  validateRun(next);
  return next;
}

function validateEvent(event, runId) {
  keys(event, ['id','runId','pageId','sequence','at','monotonicMs','phase','taskId','updateId','type','data'], undefined, '행동 기록');
  id(event.id, '행동 번호');
  requireThat(event.runId === runId, '다른 실행의 행동 기록이 섞여 있습니다.');
  id(event.pageId, '페이지 번호');
  requireThat(Number.isInteger(event.sequence) && event.sequence >= 1 && event.sequence <= 100000000, '행동 순번이 올바르지 않습니다.');
  iso(event.at, '행동 시각');
  requireThat(typeof event.monotonicMs === 'number' && Number.isFinite(event.monotonicMs) && event.monotonicMs >= 0, '행동 경과 시간이 올바르지 않습니다.');
  requireThat(PHASES.includes(event.phase), '행동 단계가 올바르지 않습니다.');
  text(event.type, 80, '행동 종류');
  if (event.taskId !== null) requireThat(Boolean(taskFor(event.taskId)), '행동의 업무 번호가 올바르지 않습니다.');
  if (event.updateId !== null) requireThat(Boolean(taskFor(event.taskId)?.updates.some(update => update.id === event.updateId)), '행동의 요청 번호가 올바르지 않습니다.');
  requireThat(isObject(event.data), '행동 부가 자료가 올바르지 않습니다.');
  jsonValue(event.data);
  requireThat(JSON.stringify(event.data).length <= 24000, '한 행동의 부가 자료가 너무 큽니다.');
}
export function validateEnvelope(envelope) {
  try {
    keys(envelope, ['format','schemaVersion','studyVersion','exportedAt','run','events'], undefined, '응답 파일');
    requireThat(envelope.format === 'hci-workspace-export' && envelope.schemaVersion === 1 && envelope.studyVersion === STUDY.version, '호환되는 파일럿 JSON 응답 파일이 아닙니다.', 'VERSION_MISMATCH');
    iso(envelope.exportedAt, '내보내기 시각'); validateRun(envelope.run);
    requireThat(Array.isArray(envelope.events) && envelope.events.length <= MAX_EVENTS, `행동 기록은 실행별 ${MAX_EVENTS.toLocaleString()}개까지 가져올 수 있습니다. 더 큰 파일은 연구자에게 원본을 보관해 전달해 주세요.`, 'EVENT_LIMIT');
    const ids = new Set();
    for (const event of envelope.events) {
      validateEvent(event, envelope.run.id);
      requireThat(!ids.has(event.id), '응답 파일에 중복 행동 번호가 있습니다.'); ids.add(event.id);
    }
    return true;
  } catch (error) { error.code ??= 'INVALID_ENVELOPE'; throw error; }
}
export function makeEnvelope(run, events) {
  const envelope = {format:'hci-workspace-export', schemaVersion:1, studyVersion:STUDY.version, exportedAt:new Date().toISOString(), run:copy(run), events:copy(events)};
  validateEnvelope(envelope);
  return envelope;
}
function comparableEnvelope(envelope) {
  // Re-export timestamps do not change research data. Event order is canonicalized by ID.
  return canonical({run:envelope.run,events:[...envelope.events].sort((a,b)=>a.id.localeCompare(b.id))});
}
export function mergeEnvelopes(existingArray, incomingArray) {
  requireThat(Array.isArray(existingArray) && Array.isArray(incomingArray), '응답 파일 목록이 올바르지 않습니다.');
  requireThat(existingArray.length + incomingArray.length <= 10000, '한 번에 처리할 실행 수가 너무 많습니다.');
  const items = [], byId = new Map(), fingerprints = new Map(), conflicts=[];
  let added=0, duplicates=0;
  for (const [isIncoming, entries] of [[false,existingArray],[true,incomingArray]]) {
    for (const envelope of entries) {
      validateEnvelope(envelope);
      const runId=envelope.run.id, fingerprint=comparableEnvelope(envelope);
      if (byId.has(runId)) {
        if (fingerprints.get(runId) === fingerprint) { if (isIncoming) duplicates++; }
        else conflicts.push({runId,reason:'같은 실행 번호에 서로 다른 응답 또는 로그가 있습니다. 기존 자료를 보존했으며 자동으로 덮어쓰지 않았습니다.'});
        continue;
      }
      const saved=copy(envelope); items.push(saved); byId.set(runId,saved); fingerprints.set(runId,fingerprint);
      if (isIncoming) added++;
    }
  }
  return {items,added,duplicates,conflicts};
}

export function toCSV(rows, columns) {
  requireThat(Array.isArray(rows), 'CSV 행 목록이 올바르지 않습니다.');
  if (!columns) columns = [...new Set(rows.flatMap(row => isObject(row) ? Object.keys(row) : []))];
  requireThat(Array.isArray(columns) && columns.every(column=>typeof column==='string'), 'CSV 열 목록이 올바르지 않습니다.');
  const cell=value=> {
    if (value === null || value === undefined) return '""';
    let string=typeof value==='object' ? JSON.stringify(value) : String(value);
    if (typeof value==='string' && /^[\s\uFEFF]*[=+\-@]/.test(string)) string="'"+string;
    return '"'+string.replace(/"/g,'""')+'"';
  };
  const lines=[columns.map(cell).join(',')];
  for (const row of rows) {
    requireThat(isObject(row) || Array.isArray(row), 'CSV 행 형식이 올바르지 않습니다.');
    lines.push(columns.map((column,index)=>cell(Array.isArray(row)?row[index]:row[column])).join(','));
  }
  return '\uFEFF'+lines.join('\r\n')+'\r\n';
}

function mean(values) { return values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null; }
function rating(value, name) {
  if (value === undefined || value === null) return null;
  requireThat(Number.isInteger(value) && value >= 0 && value <= 2, `${name}은 0·1·2점이어야 합니다.`, 'INVALID_RATING');
  return value;
}
export function analyseRun(run, answerKey, ratings = {}) {
  validateRun(run); requireThat(isObject(answerKey) && isObject(ratings), '채점 자료 형식이 올바르지 않습니다.');
  const cases=run.assignment.order.map((taskId,index)=> {
    const task=taskFor(taskId), key=answerKey[taskId], response=run.responses[taskId];
    requireThat(isObject(key) && task.plans.some(plan=>plan.id===key.initial) && isObject(key.updates) && task.updates.every(update=>update.options.some(option=>option.id===key.updates[update.id])), '이 과제 버전의 정답표가 아닙니다.', 'INVALID_ANSWER_KEY');
    const record=ratings[`${run.id}:${taskId}:memo`] ?? {};
    requireThat(isObject(record), '채점 기록 형식이 올바르지 않습니다.');
    rating(record.rater1,'채점자 1 점수'); rating(record.rater2,'채점자 2 점수');
    const human=rating(record.consensus,'인간 합의 점수'), ai=rating(record.ai,'AI 점수');
    const allMC=task.updates.every(update=>own(response.updates,update.id));
    const mcScore=allMC ? task.updates.reduce((sum,update)=>sum+(response.updates[update.id].choice===key.updates[update.id]?1:0),0) : null;
    const prediction=response.estimate?.prediction ?? null;
    const canScore=mcScore!==null && response.memo!==null;
    const humanScore=canScore && human!==null ? mcScore+human : null;
    const aiScore=canScore && ai!==null ? mcScore+ai : null;
    const mixedScore=canScore && human!==null && ai!==null ? mcScore+(human+ai)/2 : null;
    const humanGap=prediction!==null && humanScore!==null ? prediction-humanScore : null;
    const aiGap=prediction!==null && aiScore!==null ? prediction-aiScore : null;
    const mixedGap=prediction!==null && mixedScore!==null ? prediction-mixedScore : null;
    return {taskId,position:index+1,initialCorrect:response.initial===null?null:(response.initial.choice===key.initial?1:0),mcScore,prediction,humanScore,aiScore,mixedScore,humanGap,aiGap,mixedGap,absoluteError:humanGap===null?null:Math.abs(humanGap),burden:response.estimate?.burden ?? null,complete:Boolean(response.initial && response.estimate && allMC && response.memo)};
  });
  const allComplete=cases.every(row=>row.complete), allGraded=allComplete && cases.every(row=>row.humanScore!==null);
  return {cases,summary:{completeCases:cases.filter(row=>row.complete).length,meanGap:allGraded?mean(cases.map(row=>row.humanGap)):null,meanAbsoluteError:allGraded?mean(cases.map(row=>row.absoluteError)):null,meanScore:allGraded?mean(cases.map(row=>row.humanScore)):null,meanPrediction:cases.every(row=>row.prediction!==null)?mean(cases.map(row=>row.prediction)):null,meanBurden:cases.every(row=>row.burden!==null)?mean(cases.map(row=>row.burden)):null}};
}

function permutations(values) {
  if (values.length<=1) return [[...values]];
  return values.flatMap((value,index)=>permutations(values.filter((_,i)=>i!==index)).map(rest=>[value,...rest]));
}
function encodePayload(value) {
  const bytes=new TextEncoder().encode(JSON.stringify(value));
  let binary=''; for (const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function validateInvitation(value) {
  keys(value,['id','participantCode','condition','order','updateOrders','studyVersion'],undefined,'초대');
  id(value.id,'초대 번호'); text(value.participantCode,40,'익명 참가자 코드');
  requireThat(value.studyVersion===STUDY.version,'다른 버전의 초대 링크입니다. 연구자에게 새 링크를 요청해 주세요.','VERSION_MISMATCH');
  requireThat(CONDITIONS.includes(value.condition),'초대 조건이 올바르지 않습니다.');
  checkAssignment({order:value.order,updateOrders:value.updateOrders});
  return true;
}
export function makeInvitations(count, baseURL) {
  requireThat(Number.isInteger(count) && count>=1 && count<=5000,'초대 인원은 1~5,000명 사이의 정수로 입력해 주세요.');
  let base; try {base=new URL(baseURL);} catch {fail('올바른 참여 페이지 주소를 입력해 주세요.');}
  requireThat(['https:','http:'].includes(base.protocol),'참여 주소는 HTTP 또는 HTTPS여야 합니다.');
  base.hash='';
  const orders=permutations(TASKS.map(task=>task.id)), bags={control:[],assisted:[]};
  const result=[]; let block=[];
  const batchPrefix=`B${newId().slice(0,8).toUpperCase()}`;
  for (let i=0;i<count;i++) {
    if (!block.length) block=shuffled(['control','control','assisted','assisted']);
    const condition=block.pop();
    if (!bags[condition].length) bags[condition]=shuffled(orders);
    const value={id:newId(),participantCode:`${batchPrefix}-P${String(i+1).padStart(3,'0')}`,condition,order:[...bags[condition].pop()],updateOrders:Object.fromEntries(TASKS.map(task=>[task.id,shuffled(task.updates.map(update=>update.id))])),studyVersion:STUDY.version};
    validateInvitation(value);
    const url=new URL(base); url.hash=`invite=${encodePayload(value)}`;
    result.push({...value,url:url.href});
  }
  return result;
}
export function parseInvitation(hash = '') {
  if (hash==='' || hash==='#') return null;
  try {
    requireThat(typeof hash==='string' && hash.length<=10000 && /^#invite=[A-Za-z0-9_-]+$/.test(hash),'초대 링크가 올바르지 않습니다. 연구자에게 받은 링크 전체로 다시 열어 주세요.','INVALID_INVITATION');
    const encoded=hash.slice(8).replace(/-/g,'+').replace(/_/g,'/');
    const binary=atob(encoded+'='.repeat((4-encoded.length%4)%4));
    const bytes=Uint8Array.from(binary,char=>char.charCodeAt(0));
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));
    validateInvitation(value);
    return value;
  } catch (error) {error.code ??= 'INVALID_INVITATION';throw error;}
}
