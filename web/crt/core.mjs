import { STUDY, TASKS, PRACTICE, taskFor } from "./content.mjs";
import { newId, stableStringify, toCSV } from "../core.mjs";
export { newId, stableStringify, toCSV };
const copy = (x) => structuredClone(x),
  assert = (ok, message = "자료 형식이 올바르지 않습니다.") => {
    if (!ok) throw Error(message);
  };
const object = (x) =>
  x &&
  typeof x === "object" &&
  !Array.isArray(x) &&
  Object.getPrototypeOf(x) === Object.prototype;
const exact = (x, keys) =>
  assert(
    object(x) &&
      Object.keys(x).length === keys.length &&
      keys.every((k) => Object.hasOwn(x, k)),
  );
const str = (x, max = 2000) =>
  assert(
    typeof x === "string" && x.trim().length > 0 && x.length <= max,
    "필수 응답을 입력해 주세요.",
  );
const integer = (x, max) =>
  assert(
    Number.isInteger(x) && x >= 0 && x <= max,
    "허용된 범위의 정수를 입력해 주세요.",
  );
const iso = (x) =>
  assert(
    typeof x === "string" &&
      /^\d{4}-\d\d-\d\dT/.test(x) &&
      new Date(x).toISOString() === x,
  );
const uuid = (x) =>
  assert(
    typeof x === "string" &&
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
        x,
      ),
  );
export function shuffle(values) {
  const a = [...values];
  for (let i = a.length - 1; i > 0; i--) {
    const n = new Uint32Array(1),
      limit = Math.floor(2 ** 32 / (i + 1)) * (i + 1);
    do {
      crypto.getRandomValues(n);
    } while (n[0] >= limit);
    const j = n[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export const LATIN = [
  ["difference", "rate", "trade"],
  ["rate", "trade", "difference"],
  ["trade", "difference", "rate"],
];
export function assignment(condition = "control", order = LATIN[0]) {
  assert(["control", "assisted", "within"].includes(condition));
  return {
    order: [...order],
    optionOrders: Object.fromEntries(
      [PRACTICE, ...TASKS].map((t) => [
        t.id,
        shuffle(t.options.map((o) => o.id)),
      ]),
    ),
    applyOrders: Object.fromEntries(
      TASKS.map((t) => [t.id, shuffle(["a", "b", "c"])]),
    ),
    support: Object.fromEntries(
      order.map((id, i) => [
        id,
        condition === "assisted" || (condition === "within" && i > 0),
      ]),
    ),
  };
}
export function validateAssignment(a, condition) {
  exact(a, ["order", "optionOrders", "applyOrders", "support"]);
  assert(
    LATIN.some((order) => stableStringify(order) === stableStringify(a.order)),
    "라틴 방진 순서가 아닙니다.",
  );
  const permutation = (arr, expected) =>
    assert(
      Array.isArray(arr) &&
        arr.length === expected.length &&
        new Set(arr).size === arr.length &&
        arr.every((x) => expected.includes(x)),
    );
  exact(a.optionOrders, ["practice", ...TASKS.map((t) => t.id)]);
  exact(
    a.applyOrders,
    TASKS.map((t) => t.id),
  );
  exact(
    a.support,
    TASKS.map((t) => t.id),
  );
  for (const t of [PRACTICE, ...TASKS])
    permutation(
      a.optionOrders[t.id],
      t.options.map((o) => o.id),
    );
  for (const t of TASKS) permutation(a.applyOrders[t.id], ["a", "b", "c"]);
  assert(["control", "assisted", "within"].includes(condition));
  a.order.forEach((id, i) =>
    assert(
      a.support[id] ===
        (condition === "assisted" || (condition === "within" && i > 0)),
      "지원 조건이 설계와 다릅니다.",
    ),
  );
  return true;
}
export function makeSchedule(count = 30, design = "between") {
  assert(
    Number.isInteger(count) && count >= 1 && count <= 300,
    "배정 인원은 1~300명입니다.",
  );
  assert(["between", "within"].includes(design));
  let block = [];
  return Array.from({ length: count }, (_, i) => {
    if (!block.length)
      block = shuffle(
        (design === "within" ? ["within"] : ["control", "assisted"]).flatMap(
          (condition) =>
            LATIN.map((order, index) => ({
              condition,
              order,
              latin: index + 1,
            })),
        ),
      );
    const c = block.pop();
    return {
      id: newId(),
      sequence: i + 1,
      condition: c.condition,
      latin: c.latin,
      assignment: assignment(c.condition, c.order),
    };
  });
}
export function makeInvitations(
  count,
  baseURL,
  design = "between",
  cohort = "pilot",
) {
  assert(["pilot", "study"].includes(cohort));
  const batch = newId();
  return makeSchedule(count, design).map((slot) => {
    const value = {
      ...slot,
      studyVersion: STUDY.version,
      participantCode: `CRT-${batch.slice(0, 8)}-${String(slot.sequence).padStart(3, "0")}`,
      source: "manual",
      batchId: batch,
      cohort,
    };
    const u = new URL(baseURL);
    assert(["http:", "https:"].includes(u.protocol));
    u.hash = "invite=" + btoa(JSON.stringify(value));
    return { ...value, url: u.href };
  });
}
export function parseInvitation(hash) {
  if (!hash || hash === "#") return null;
  assert(
    hash.length < 16000 && hash.startsWith("#invite="),
    "참여 링크를 확인해 주세요.",
  );
  const v = JSON.parse(atob(hash.slice(8)));
  validateInvitation(v);
  return v;
}
export function validateInvitation(v) {
  exact(v, [
    "id",
    "sequence",
    "condition",
    "latin",
    "assignment",
    "studyVersion",
    "participantCode",
    "source",
    "batchId",
    "cohort",
  ]);
  assert(["pilot", "study"].includes(v.cohort));
  uuid(v.id);
  uuid(v.batchId);
  str(v.participantCode, 60);
  integer(v.sequence, 300);
  assert(v.sequence >= 1);
  integer(v.latin, 3);
  assert(
    v.latin >= 1 &&
      v.studyVersion === STUDY.version &&
      ["manual", "central"].includes(v.source),
    "다른 연구 버전의 링크입니다.",
  );
  validateAssignment(v.assignment, v.condition);
  assert(
    stableStringify(v.assignment.order) === stableStringify(LATIN[v.latin - 1]),
  );
  return true;
}
export function steps(run) {
  const list = [
    { phase: "pre" },
    { phase: "decision", taskId: "practice" },
    { phase: "estimate", taskId: "practice" },
    ...PRACTICE.items.map((item) => ({
      phase: "item",
      taskId: "practice",
      itemId: item.id,
    })),
    { phase: "feedback", taskId: "practice" },
  ];
  for (const taskId of run.assignment.order)
    list.push(
      { phase: "decision", taskId },
      { phase: "burden", taskId },
      { phase: "estimate", taskId },
      ...[...run.assignment.applyOrders[taskId], "d", "e"].map((itemId) => ({
        phase: "item",
        taskId,
        itemId,
      })),
    );
  list.push({ phase: "post" });
  return list;
}
function cleanValues(step, v) {
  assert(object(v));
  if (step.phase === "pre") {
    exact(v, [
      "gender",
      "major",
      "aiFrequency",
      "age",
      "eligible",
      "delivery",
      "device",
      "consent",
      "noExternal",
    ]);
    for (const k of ["gender", "major", "device"]) str(v[k], 100);
    assert(["never", "monthly", "weekly", "daily"].includes(v.aiFrequency));
    assert(
      Number.isInteger(v.age) && v.age >= 19 && v.age <= 29,
      "참여 대상은 19~29세입니다.",
    );
    assert(
      v.eligible === true,
      "과제 제작·정답 사전 열람·이전 파일럿 참여자는 본 실험에 참여할 수 없습니다.",
    );
    assert(["in_person", "remote"].includes(v.delivery));
    assert(
      v.consent === true && v.noExternal === true,
      "참여 동의와 외부 도구 미사용 확인이 필요합니다.",
    );
  } else if (step.phase === "decision") {
    exact(v, ["choice"]);
    assert(
      [...taskFor(step.taskId).options.map((o) => o.id), "unknown"].includes(
        v.choice,
      ),
      "답을 선택해 주세요.",
    );
  } else if (step.phase === "burden") {
    exact(v, ["burden"]);
    integer(v.burden, 7);
    assert(v.burden >= 1);
  } else if (step.phase === "estimate") {
    exact(
      v,
      step.taskId === "practice"
        ? ["confidence", "predApply"]
        : ["confidence", "predApply", "predExplain"],
    );
    integer(v.confidence, 100);
    integer(v.predApply, 6);
    if (step.taskId !== "practice") integer(v.predExplain, 4);
  } else if (step.phase === "item") {
    exact(v, ["answer", "work", "unknown"]);
    assert(typeof v.unknown === "boolean");
    assert(
      typeof v.answer === "string" &&
        v.answer.length <= 200 &&
        typeof v.work === "string" &&
        v.work.length <= 2000,
    );
    if (v.unknown) assert(v.answer === "" && v.work === "");
    else if (
      taskFor(step.taskId).items.find((i) => i.id === step.itemId).type ===
      "apply"
    )
      str(v.answer, 200);
    else str(v.work);
  } else if (step.phase === "feedback") {
    exact(v, ["acknowledged"]);
    assert(v.acknowledged === true);
  } else if (step.phase === "post") {
    exact(v, [
      "used",
      "predictionBasis",
      "strategy",
      "transfer",
      "exposure",
      "externalUsed",
      "attention",
    ]);
    for (const k of ["used", "predictionBasis", "strategy", "transfer"])
      str(v[k]);
    assert(
      ["yes", "no", "unsure"].includes(v.exposure) &&
        ["yes", "no"].includes(v.externalUsed) &&
        ["2", "other", "not_applicable"].includes(v.attention),
    );
  } else throw Error("완료된 실행입니다.");
  return copy(v);
}
export function createRun({
  participantCode = "TEAM",
  condition = "control",
  mode = "demo",
  invitation = null,
} = {}) {
  if (invitation) {
    validateInvitation(invitation);
    condition = invitation.condition;
    participantCode = invitation.participantCode;
    mode = invitation.cohort;
  }
  const at = new Date().toISOString();
  const run = {
    schemaVersion: 4,
    studyVersion: STUDY.version,
    id: newId(),
    participantCode,
    condition,
    mode,
    invitationId: invitation?.id ?? null,
    allocation: invitation
      ? {
          source: invitation.source,
          batchId: invitation.batchId,
          sequence: invitation.sequence,
        }
      : null,
    assignment: invitation
      ? copy(invitation.assignment)
      : assignment(condition, LATIN[shuffle([0, 1, 2])[0]]),
    startedAt: at,
    updatedAt: at,
    finishedAt: null,
    status: "in_progress",
    submissions: [],
    draft: { key: "", values: {} },
  };
  validateRun(run);
  return run;
}
export function validateRun(run) {
  exact(run, [
    "schemaVersion",
    "studyVersion",
    "id",
    "participantCode",
    "condition",
    "mode",
    "invitationId",
    "allocation",
    "assignment",
    "startedAt",
    "updatedAt",
    "finishedAt",
    "status",
    "submissions",
    "draft",
  ]);
  assert(
    run.schemaVersion === 4 && run.studyVersion === STUDY.version,
    "CRT v4 자료만 열 수 있습니다. 이전 자료는 v3 복구 화면에서 여세요.",
  );
  uuid(run.id);
  str(run.participantCode, 60);
  assert(["demo", "pilot", "study"].includes(run.mode));
  if (run.invitationId !== null) {
    uuid(run.invitationId);
    exact(run.allocation, ["source", "batchId", "sequence"]);
    uuid(run.allocation.batchId);
    integer(run.allocation.sequence, 300);
    assert(
      run.allocation.sequence >= 1 &&
        ["manual", "central"].includes(run.allocation.source),
    );
  } else assert(run.allocation === null && run.mode === "demo");
  validateAssignment(run.assignment, run.condition);
  iso(run.startedAt);
  iso(run.updatedAt);
  assert(run.updatedAt >= run.startedAt);
  const route = steps(run);
  assert(
    Array.isArray(run.submissions) && run.submissions.length <= route.length,
  );
  let last = run.startedAt;
  const ids = new Set();
  run.submissions.forEach((record, i) => {
    exact(record, ["id", "step", "at", "values"]);
    uuid(record.id);
    assert(!ids.has(record.id));
    ids.add(record.id);
    assert(record.step === i);
    iso(record.at);
    assert(record.at >= last && record.at <= run.updatedAt);
    last = record.at;
    cleanValues(route[i], record.values);
  });
  const done = run.submissions.length === route.length;
  assert(run.status === (done ? "completed" : "in_progress"));
  assert(run.finishedAt === (done ? last : null));
  exact(run.draft, ["key", "values"]);
  assert(
    typeof run.draft.key === "string" &&
      run.draft.key.length < 100 &&
      object(run.draft.values) &&
      JSON.stringify(run.draft.values).length < 16000,
  );
  return true;
}
export function stepInfo(run) {
  validateRun(run);
  const route = steps(run),
    i = run.submissions.length,
    s = route[i] ?? { phase: "done" };
  return {
    ...s,
    taskId: s.taskId ?? null,
    itemId: s.itemId ?? null,
    updateId: s.itemId ?? null,
    index: i,
    step: i + 1,
    totalSteps: route.length,
    progress: i / route.length,
  };
}
export function submitStep(run, values, at = new Date().toISOString()) {
  validateRun(run);
  iso(at);
  assert(at >= run.updatedAt, "기기 시각을 확인해 주세요.");
  const next = copy(run),
    route = steps(run),
    i = next.submissions.length;
  assert(i < route.length, "이미 완료한 실행입니다.");
  next.submissions.push({
    id: newId(),
    step: i,
    at,
    values: cleanValues(route[i], values),
  });
  next.updatedAt = at;
  next.draft = { key: "", values: {} };
  if (next.submissions.length === route.length) {
    next.status = "completed";
    next.finishedAt = at;
  }
  validateRun(next);
  return next;
}
export function responses(run) {
  validateRun(run);
  const result = { pre: null, post: null, tasks: {} };
  const route = steps(run);
  run.submissions.forEach((r, i) => {
    const s = route[i];
    if (["pre", "post"].includes(s.phase)) result[s.phase] = r.values;
    else {
      const t = (result.tasks[s.taskId] ??= { items: {} });
      if (s.phase === "item") t.items[s.itemId] = r.values;
      else t[s.phase] = r.values;
    }
  });
  return result;
}
export function makeEnvelope(run, events = []) {
  const e = {
    format: "hci-crt-export",
    schemaVersion: 4,
    studyVersion: STUDY.version,
    exportedAt: new Date().toISOString(),
    run: copy(run),
    events: copy(events),
  };
  validateEnvelope(e);
  return e;
}
export function validateEnvelope(e) {
  exact(e, [
    "format",
    "schemaVersion",
    "studyVersion",
    "exportedAt",
    "run",
    "events",
  ]);
  assert(
    e.format === "hci-crt-export" &&
      e.schemaVersion === 4 &&
      e.studyVersion === STUDY.version,
    "CRT v4 응답 파일이 아닙니다.",
  );
  iso(e.exportedAt);
  validateRun(e.run);
  assert(Array.isArray(e.events) && e.events.length <= 200000);
  const seen = new Set();
  for (const event of e.events) {
    uuid(event.id);
    assert(event.runId === e.run.id && !seen.has(event.id));
    seen.add(event.id);
    iso(event.at);
    assert(
      typeof event.type === "string" &&
        event.type.length <= 80 &&
        object(event.data) &&
        JSON.stringify(event.data).length <= 24000,
    );
    assert(
      typeof event.monotonicMs === "number" &&
        Number.isFinite(event.monotonicMs) &&
        event.monotonicMs >= 0 &&
        Number.isInteger(event.sequence) &&
        event.sequence > 0,
    );
    str(event.pageId, 160);
  }
  return true;
}
export function mergeEnvelopes(existing, incoming) {
  const items = copy(existing),
    byId = new Map(items.map((e) => [e.run.id, e])),
    conflicts = [];
  let added = 0,
    duplicates = 0,
    updated = 0;
  const fingerprint = (e) =>
    stableStringify({
      run: e.run,
      events: [...e.events].sort((a, b) => a.id.localeCompare(b.id)),
    });
  for (const e of [...existing, ...incoming]) validateEnvelope(e);
  for (const e of incoming) {
    const old = byId.get(e.run.id);
    if (old) {
      if (fingerprint(old) === fingerprint(e)) duplicates++;
      else {
        const identity = (run) => {
          const { updatedAt, finishedAt, status, submissions, draft, ...fixed } = run;
          return stableStringify(fixed);
        };
        const a = old.run, b = e.run;
        const extendsRun = a.status !== "completed" &&
          b.submissions.length > a.submissions.length &&
          identity(a) === identity(b) && b.updatedAt >= a.updatedAt &&
          stableStringify(a.submissions) === stableStringify(b.submissions.slice(0, a.submissions.length)) &&
          old.events.every((event) => e.events.some((next) => next.id === event.id && stableStringify(next) === stableStringify(event)));
        if (extendsRun) {
          const saved = copy(e);
          items[items.findIndex((item) => item.run.id === b.id)] = saved;
          byId.set(b.id, saved);
          updated++;
        } else conflicts.push(e.run.id);
      }
    } else {
      const saved = copy(e);
      items.push(saved);
      byId.set(e.run.id, saved);
      added++;
    }
  }
  return { items, added, updated, duplicates, conflicts };
}
