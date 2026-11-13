import test from "node:test";
import assert from "node:assert/strict";
import {
  createRun,
  steps,
  stepInfo,
  submitStep,
  validateRun,
  makeSchedule,
  makeInvitations,
  parseInvitation,
  makeEnvelope,
  mergeEnvelopes,
  LATIN,
  stableStringify,
} from "../web/crt/core.mjs";
import { TASKS, PRACTICE } from "../web/crt/content.mjs";
import { KEY, numericCheck } from "../web/crt/key.mjs";
import {
  blindPacket,
  applyRatings,
  knownIds,
  analysisTables,
  agreement,
  consensusBasis,
} from "../web/crt/research-tools.mjs";
import { calculate } from "../web/crt/calculator.mjs";
import { BrowserStore } from "../web/storage.mjs";
export const pre = {
  gender: "undisclosed",
  major: "공학",
  aiFrequency: "weekly",
  age: 23,
  eligible: true,
  delivery: "remote",
  device: "laptop",
  consent: true,
  noExternal: true,
};
export const post = {
  used: "원문",
  predictionBasis: "연습 기준",
  strategy: "식을 세움",
  transfer: "관계를 확인함",
  exposure: "no",
  externalUsed: "no",
  attention: "2",
};
export function answerFor(s) {
  return s.phase === "pre"
    ? pre
    : s.phase === "post"
      ? post
      : s.phase === "decision"
        ? { choice: "unknown" }
        : s.phase === "burden"
          ? { burden: 3 }
          : s.phase === "estimate"
            ? {
                confidence: 70,
                predApply: 4,
                ...(s.taskId === "practice" ? {} : { predExplain: 3 }),
              }
            : s.phase === "feedback"
              ? { acknowledged: true }
              : { answer: "모름", work: "", unknown: false };
}
export function complete(run = createRun()) {
  while (run.status !== "completed") {
    const s = stepInfo(run),
      v = answerFor(s);
    if (s.phase === "item")
      Object.assign(v, {
        answer: "1",
        work: "식에 근거한 답변",
        unknown: false,
      });
    run = submitStep(run, v);
  }
  return run;
}
function graded(e) {
  let r = {};
  const ids = knownIds([e]);
  for (const role of ["rater1", "rater2", "consensus"])
    r = applyRatings(
      r,
      {
        format: "hci-crt-ratings",
        studyVersion: "4.0.0",
        role,
        ratings: [...ids].map((responseId) => ({
          responseId,
          score: 1,
          reason: "부분 근거",
          ...(role === "consensus" ? { basis: consensusBasis(r[responseId]) } : {}),
        })),
      },
      ids,
    ).ratings;
  return r;
}
test("CRT schedule balances exactly six cells per block and persists display orders", () => {
  for (let attempt = 0; attempt < 20; attempt++) {
    const schedule = makeSchedule(30);
    for (let i = 0; i < 30; i += 6) {
      const cells = new Set(
        schedule.slice(i, i + 6).map((s) => s.condition + s.latin),
      );
      assert.equal(cells.size, 6);
    }
    for (const s of schedule) {
      assert.ok(
        LATIN.some(
          (o) => stableStringify(o) === stableStringify(s.assignment.order),
        ),
      );
      for (const t of [PRACTICE, ...TASKS])
        assert.equal(new Set(s.assignment.optionOrders[t.id]).size, 4);
    }
  }
  const inv = makeInvitations(6, "https://example.test/hci/");
  assert.deepEqual(
    parseInvitation(new URL(inv[0].url).hash),
    Object.fromEntries(Object.entries(inv[0]).filter(([k]) => k !== "url")),
  );
  assert.equal(
    createRun({ invitation: parseInvitation(new URL(inv[0].url).hash) }).mode,
    "pilot",
  );
  const within = makeSchedule(3, "within");
  assert.equal(new Set(within.map((s) => s.latin)).size, 3);
  within.forEach((s) =>
    assert.deepEqual(
      s.assignment.order.map((t) => s.assignment.support[t]),
      [false, true, true],
    ),
  );
});
test("CRT replay rejects tampering, fractional predictions, skipped answers and changed histories", async () => {
  let r = createRun();
  r = submitStep(r, pre);
  r = submitStep(r, { choice: "p4" });
  assert.throws(() => submitStep(r, { confidence: 80, predApply: 2.5 }));
  assert.throws(() => submitStep(r, { confidence: 101, predApply: 2 }));
  r = submitStep(r, { confidence: 80, predApply: 4 });
  assert.throws(() => submitStep(r, { answer: "", work: "", unknown: false }));
  assert.throws(() => submitStep(r, { answer: "6", work: "", unknown: true }));
  const original = structuredClone(r);
  const changed = structuredClone(r);
  changed.submissions[1].values.choice = "invalid";
  assert.throws(() => validateRun(changed));
  const store = await new BrowserStore({
    dbName: "crt-test",
    validate: validateRun,
    envelope: makeEnvelope,
  }).init();
  await store.saveRun(r);
  changed.submissions[1].values.choice = "p3";
  assert.throws(() => validateRun({ ...changed, status: "completed" }));
  await assert.rejects(store.saveRun(changed), /이전 상태|다른 답안/);
  assert.deepEqual(await store.getRun(r.id), original);
  await store.close();
});
test("CRT blind grading covers 18 answers, protects concealment and computes separate signed errors", () => {
  const run = complete(),
    e = makeEnvelope(run),
    p = blindPacket([e]);
  assert.equal(p.items.length, 18);
  const text = JSON.stringify(p);
  for (const name of [
    "participantCode",
    "condition",
    "confidence",
    "predApply",
    "predExplain",
    "startedAt",
  ])
    assert.ok(!text.includes('"' + name + '"'));
  assert.equal(p.items.filter((i) => i.taskId === "practice").length, 3);
  assert.equal(
    analysisTables([e], {}, true).participants[0].mean_d_apply,
    null,
  );
  const r = graded(e),
    a = analysisTables([e], r, true),
    participant = a.participants[0];
  assert.equal(a.items.length, 19);
  assert.equal(participant.d_baseline, 1);
  assert.equal(participant.mean_d_apply, 1);
  assert.equal(participant.mean_d_explain, 1);
  assert.equal(participant.mean_actual_apply, 3);
  assert.equal(a.cases[0].actual_explain_4, null);
  assert.equal(agreement(r).exact, 1);
  assert.equal(analysisTables([e], r).participants.length, 0);
  const id = p.items[0].responseId;
  assert.throws(
    () =>
      applyRatings(
        {},
        {
          format: "hci-crt-ratings",
          studyVersion: "4.0.0",
          role: "consensus",
          ratings: [{ responseId: id, score: 2, reason: "합의" }],
        },
        knownIds([e]),
      ),
    /먼저/,
  );
  const merge = mergeEnvelopes([e], [e]);
  assert.equal(merge.duplicates, 1);
  const other = structuredClone(e);
  other.run.draft.values = { x: "다른 기록" };
  assert.equal(mergeEnvelopes([e], [other]).conflicts.length, 1);
});
test("CRT numeric checks remain advisory and calculator never evaluates code", () => {
  assert.equal(numericCheck("1,500원", KEY.difference.a), "숫자 일치");
  assert.equal(numericCheck("20만원", KEY.trade.a), "숫자 일치");
  assert.equal(numericCheck("1분 30초", KEY.rate.e), "숫자 일치");
  assert.equal(
    numericCheck("식으로 구하면 9분입니다", KEY.rate.b),
    "수동 확인",
  );
  assert.equal(calculate("2 / (1 / 6 + 1 / 3)"), 4);
  assert.equal(calculate("-(2 + 3) * 4"), -20);
  assert.throws(() => calculate("1/0"));
  assert.throws(() => calculate("globalThis.process.exit()"));
  assert.throws(() => calculate("1 +"));
});
test("CRT keys match independently recomputed arithmetic from the proposal", () => {
  const expected = {
    practice: {
      p1: 2 / (1 / 12 + 1 / 4),
      p2: 2 / (1 / 5 + 1 / 5),
      p3: (6 + 3) / 2,
    },
    difference: {
      a: (34000 - 31000) / 2,
      b: (33000 - 3000) / 3,
      c: 33000 - 30000,
      e: (33000 - 31000) / 2,
    },
    rate: {
      a: 12 / (12 / 3),
      b: 36 / ((6 * 2) / 3),
      c: 6 / (3 / 3),
      e: 3 / (6 / 3),
    },
    trade: {
      a: (-70 + 80 - 90 + 100) * 10000,
      b: (-60 + 70 - 80 + 75) * 10000,
      c: (-60 + 70 - 70 + 80) * 10000,
      e: (-60 + 70 - 85 + 90) * 10000,
    },
  };
  for (const [task, items] of Object.entries(expected))
    for (const [id, value] of Object.entries(items))
      assert.equal(KEY[task][id].answer, value, task + ":" + id);
});
test("CRT cloud receipt roundtrip covers the new schema and detects incomplete readback", async () => {
  const { CloudSync } = await import("../web/cloud-sync.mjs"),
    { verifyReceipt } = await import("../web/crt/cloud.mjs");
  const run = complete(),
    records = new Map(),
    event = {
      id: crypto.randomUUID(),
      runId: run.id,
      pageId: crypto.randomUUID(),
      sequence: 1,
      at: new Date().toISOString(),
      monotonicMs: 1,
      phase: "done",
      taskId: null,
      updateId: null,
      type: "synthetic",
      data: {},
    };
  const sync = new CloudSync({
    store: { eventsForRun: async () => [event] },
    adapterFactory: async () => ({
      uid: "synthetic",
      put: async (p, d) => records.set(p, structuredClone(d)),
      get: async (p) => records.get(p),
    }),
    storage: null,
  });
  try {
    sync.start(run);
    const receipt = await sync.sync({ final: true });
    assert.equal(receipt.submissionCount, 33);
    assert.equal(await verifyReceipt(run, [event], receipt), true);
    assert.equal(await verifyReceipt(run, [], receipt), false);
  } finally {
    sync.stop();
  }
});

test("first-bundle export follows every Latin order and keeps incomplete runs in the flow roster", () => {
  for (const invitation of makeInvitations(6, new URL("https://example.com/"), "between", "study")) {
    const { url, ...entry } = invitation;
    const run = complete(createRun({ invitation: entry }));
    const e = makeEnvelope(run), ratings = graded(e);
    for (const [taskId, value] of [["difference", 0], ["rate", 1], ["trade", 2]]) {
      for (const itemId of ["a", "b", "c"])
        ratings[`${run.id}:${taskId}:${itemId}`].consensus.score = value;
    }
    const tables = analysisTables([e], ratings);
    const first = tables.cases.find((c) => c.position === 1);
    assert.equal(tables.participants[0].first_d_apply, first.d_apply);
    assert.equal(first.task_id, run.assignment.order[0]);
    const partial = createRun({ invitation: entry });
    const roster = analysisTables([makeEnvelope(partial)]);
    assert.equal(roster.participants[0].primary_ready, 0);
    assert.match(roster.participants[0].exclusion_reasons, /incomplete/);
    assert.equal(roster.participants[0].next_phase, "pre");
    assert.equal(roster.flow.find((r) => r.stage === "incomplete").n, 1);
  }
});

test("partial imported snapshots advance only along the identical submitted history", () => {
  const start = createRun(), middle = submitStep(start, pre), end = complete(middle);
  const merged = mergeEnvelopes([makeEnvelope(middle)], [makeEnvelope(end)]);
  assert.equal(merged.updated, 1);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.items[0].run.status, "completed");
  const divergent = submitStep(start, { ...pre, major: "다른 전공" });
  assert.equal(mergeEnvelopes([makeEnvelope(divergent)], [makeEnvelope(end)]).conflicts.length, 1);
});

test("cloud import retains partial participant snapshots without claiming a final receipt", async () => {
  const { loadRecords } = await import("../web/crt/cloud.mjs");
  const { url, ...invitation } = makeInvitations(1, new URL("https://example.com/"), "between", "study")[0];
  const run = submitStep(createRun({ invitation }), pre);
  const result = await loadRecords({
    auth: { currentUser: { email: "superriaco@gmail.com", emailVerified: true } },
    db: {},
    sdk: {
      collection: () => ({}),
      getDocs: async () => ({ docs: [{ id: run.id, data: () => ({ payload: JSON.stringify(run) }) }] }),
    },
  });
  assert.equal(result.envelopes.length, 1);
  assert.equal(result.envelopes[0].run.status, "in_progress");
  assert.deepEqual(result.envelopes[0].events, []);
  assert.match(result.notices[0], /미완료/);
});

test("consensus is bound to both independent ratings and stale or legacy agreement cannot re-enter analysis", () => {
  const e = makeEnvelope(complete()), r = graded(e), ids = knownIds([e]);
  const id = [...ids].find((value) => value.endsWith(":difference:a"));
  const old = structuredClone(r[id].consensus);
  r[id].rater1 = { score: 2, reason: "새 독립 채점" };
  assert.equal(analysisTables([e], r, true).items.find((i) => i.response_id === id).consensus, null);
  const file = (entry) => ({ format: "hci-crt-ratings", studyVersion: "4.0.0", role: "consensus", ratings: [{ responseId: id, ...entry }] });
  delete r[id].consensus;
  assert.throws(() => applyRatings(r, file(old), ids), /다시 합의/);
  assert.throws(() => applyRatings(r, file({ score: 1, reason: "이전 형식" }), ids), /다시 합의/);
  const next = applyRatings(r, file({ score: 2, reason: "재합의", basis: consensusBasis(r[id]) }), ids).ratings;
  assert.equal(analysisTables([e], next, true).items.find((i) => i.response_id === id).consensus, 2);
});
