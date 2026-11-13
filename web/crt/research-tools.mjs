import { STUDY, TASKS, PRACTICE, taskFor } from "./content.mjs";
import { KEY, ITEM_RUBRICS, INITIAL, TRAPS, numericCheck } from "./key.mjs";
import {
  responses,
  validateEnvelope,
  newId,
  stableStringify,
  toCSV,
  stepInfo,
} from "./core.mjs";
import { summarizeBehavior } from "../telemetry.mjs";
export const responseId = (runId, taskId, itemId) =>
  `${runId}:${taskId}:${itemId}`;
export function blindPacket(envelopes) {
  const items = [];
  for (const e of envelopes) {
    validateEnvelope(e);
    const r = responses(e.run);
    for (const t of [PRACTICE, ...TASKS])
      for (const item of t.items) {
        const a = r.tasks[t.id]?.items[item.id];
        if (!a || (t.id === "practice" && item.type !== "apply")) continue;
        const key = KEY[t.id][item.id];
        items.push({
          responseId: responseId(e.run.id, t.id, item.id),
          taskId: t.id,
          itemId: item.id,
          type: item.type,
          problem: t.problem,
          prompt: item.prompt,
          answer: a.answer,
          work: a.work,
          unknown: a.unknown,
          numericCheck: a.unknown ? "모르겠음" : numericCheck(a.answer, key),
          key: structuredClone(key),
          rubric: structuredClone(ITEM_RUBRICS[t.id][item.id]),
        });
      }
  }
  // Opaque response IDs link scores; no participant code, condition, prediction, confidence or times.
  for (let i = items.length - 1; i > 0; i--) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    const j = a[0] % (i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return {
    format: "hci-crt-blind",
    studyVersion: STUDY.version,
    packetId: newId(),
    items,
  };
}
export function validatePacket(p) {
  if (
    p?.format !== "hci-crt-blind" ||
    p.studyVersion !== STUDY.version ||
    !Array.isArray(p.items) ||
    p.items.length > 10000
  )
    throw Error("CRT 채점 묶음이 아닙니다.");
  const ids = new Set();
  for (const i of p.items) {
    if (
      !validId(i.responseId) ||
      ids.has(i.responseId) ||
      i.responseId.split(":")[1] !== i.taskId ||
      i.responseId.split(":")[2] !== i.itemId ||
      !taskFor(i.taskId)?.items.some(
        (x) => x.id === i.itemId && x.type === i.type,
      ) ||
      typeof i.answer !== "string" ||
      typeof i.work !== "string" ||
      typeof i.unknown !== "boolean"
    )
      throw Error("채점 문항을 확인해 주세요.");
    const task = taskFor(i.taskId),
      item = task.items.find((x) => x.id === i.itemId);
    const allowed = [
      "responseId",
      "taskId",
      "itemId",
      "type",
      "problem",
      "prompt",
      "answer",
      "work",
      "unknown",
      "numericCheck",
      "key",
      "rubric",
    ];
    if (
      Object.keys(i).length !== allowed.length ||
      !allowed.every((k) => Object.hasOwn(i, k)) ||
      i.problem !== task.problem ||
      i.prompt !== item.prompt ||
      stableStringify(i.key) !== stableStringify(KEY[i.taskId][i.itemId]) ||
      stableStringify(i.rubric) !== stableStringify(ITEM_RUBRICS[i.taskId][i.itemId]) ||
      i.numericCheck !==
        (i.unknown
          ? "모르겠음"
          : numericCheck(i.answer, KEY[i.taskId][i.itemId])) ||
      (i.taskId === "practice" && i.type !== "apply")
    )
      throw Error("문항·채점 기준이 현재 버전과 다릅니다.");
    ids.add(i.responseId);
  }
  return true;
}
function validId(id) {
  return (
    typeof id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}:(practice|difference|rate|trade):(?:[a-e]|p[1-4])$/.test(
      id,
    ) &&
    Boolean(
      taskFor(id.split(":")[1])?.items.some((i) => i.id === id.split(":")[2]),
    )
  );
}
export function knownIds(envelopes, packet = null) {
  const items = [...blindPacket(envelopes).items, ...(packet?.items ?? [])],
    ids = new Set(items.map((i) => i.responseId));
  ids.unknownIds = new Set(
    items.filter((i) => i.unknown).map((i) => i.responseId),
  );
  return ids;
}
export function applyRatings(current, file, ids) {
  if (
    file?.format !== "hci-crt-ratings" ||
    file.studyVersion !== STUDY.version ||
    !["rater1", "rater2", "consensus"].includes(file.role) ||
    !Array.isArray(file.ratings) ||
    file.ratings.length > 10000
  )
    throw Error("CRT 채점 결과 형식을 확인하세요.");
  const next = structuredClone(current),
    seen = new Set(),
    conflicts = [];
  let added = 0,
    duplicates = 0;
  for (const item of file.ratings) {
    if (
      !validId(item.responseId) ||
      !ids.has(item.responseId) ||
      seen.has(item.responseId) ||
      !Number.isInteger(item.score) ||
      item.score < 0 ||
      item.score > 2 ||
      typeof item.reason !== "string" ||
      item.reason.length > 2000
    )
      throw Error("채점 대상·점수·근거를 확인하세요.");
    if (ids.unknownIds?.has(item.responseId) && item.score !== 0)
      throw Error("모르겠음 답변은 0점이어야 합니다.");
    seen.add(item.responseId);
    const record = (next[item.responseId] ??= {});
    if (file.role === "consensus" && (!record.rater1 || !record.rater2))
      throw Error("두 독립 채점을 먼저 가져오세요.");
    const value = { score: item.score, reason: item.reason };
    if (file.role === "consensus") {
      const basis = consensusBasis(record);
      if (stableStringify(item.basis) !== stableStringify(basis))
        throw Error("합의의 독립 채점 버전이 다릅니다. 현재 두 채점을 확인하고 다시 합의하세요.");
      value.basis = basis;
    }
    if (record[file.role]) {
      if (stableStringify(record[file.role]) === stableStringify(value))
        duplicates++;
      else conflicts.push(item.responseId);
    } else {
      record[file.role] = value;
      added++;
    }
  }
  return { ratings: next, added, duplicates, conflicts };
}
const mean = (a) =>
  a.length && a.every((x) => x !== null && x !== undefined)
    ? a.reduce((s, x) => s + x, 0) / a.length
    : null;
const sum = (a) =>
  a.every((x) => x !== null && x !== undefined)
    ? a.reduce((s, x) => s + x, 0)
    : null;
const gap = (a, b) => (a != null && b != null ? a - b : null);
export function consensusBasis(record) {
  return structuredClone({ rater1: record.rater1, rater2: record.rater2 });
}
function score(ratings, id, unknown) {
  const r = ratings[id];
  return r?.rater1 && r?.rater2 && Number.isInteger(r?.consensus?.score) &&
    stableStringify(r.consensus.basis) === stableStringify(consensusBasis(r))
    ? r.consensus.score
    : null;
}
function numericOutcome(answer, key) {
  if (!answer) return null;
  if (answer.unknown) return 0;
  const result = numericCheck(answer.answer, key);
  return result === "숫자 일치" ? 1 : result === "숫자 불일치" ? 0 : null;
}
export function analysisTables(envelopes, ratings = {}, includeDemo = false) {
  const selected = envelopes.filter(
      (e) => includeDemo || e.run.mode !== "demo",
    ),
    counts = new Map();
  for (const { run } of selected)
    if (run.invitationId)
      counts.set(run.invitationId, (counts.get(run.invitationId) || 0) + 1);
  const participants = [],
    cases = [],
    items = [],
    events = [],
    stages = [],
    sources = [];
  for (const e of selected) {
    validateEnvelope(e);
    const run = e.run,
      r = responses(run),
      pre = r.pre ?? {},
      post = r.post ?? {},
      base = {
        study_version: STUDY.version,
        run_id: run.id,
        participant_code: run.participantCode,
        mode: run.mode,
        condition: run.condition,
        allocation_source: run.allocation?.source ?? "demo",
        batch_id: run.allocation?.batchId,
        sequence: run.allocation?.sequence,
        latin_order: run.assignment.order.join(">"),
      },
      local = [];
    for (const t of [PRACTICE, ...TASKS]) {
      const response = r.tasks[t.id] ?? { items: {} },
        estimated = response.estimate ?? {},
        scores = { apply: [], explain: [] };
      for (const item of t.items) {
        const a = response.items[item.id],
          id = responseId(run.id, t.id, item.id),
          grade = ratings[id] ?? {},
          s =
            !a || (t.id === "practice" && item.type === "explain")
              ? null
              : score(ratings, id, a?.unknown);
        scores[item.type].push(s);
        items.push({
          ...base,
          task_id: t.id,
          item_id: item.id,
          item_type: item.type,
          apply_type:
            item.type === "apply"
              ? t.id === "practice"
                ? { p1: "numeric", p2: "no_trap", p3: "structural" }[item.id]
                : { a: "numeric", b: "structural", c: "no_trap" }[item.id]
              : "",
          response_id: id,
          presented_position:
            t.id === "practice"
              ? t.items.indexOf(item) + 1
              : [...run.assignment.applyOrders[t.id], "d", "e"].indexOf(
                  item.id,
                ) + 1,
          answer: a?.answer,
          work: a?.work,
          response_state: a ? (a.unknown ? "unknown" : "answered") : "missing",
          numeric_check: a
            ? a.unknown
              ? "모르겠음"
              : numericCheck(a.answer, KEY[t.id][item.id])
            : "결측",
          rater1: grade.rater1?.score,
          rater2: grade.rater2?.score,
          consensus: s,
          rater1_reason: grade.rater1?.reason,
          rater2_reason: grade.rater2?.reason,
          consensus_reason: grade.consensus?.reason,
        });
      }
      const apply = sum(scores.apply),
        explain = t.id === "practice" ? null : sum(scores.explain),
        dApply = gap(estimated.predApply, apply),
        dExplain = gap(estimated.predExplain, explain);
      const row = {
        ...base,
        task_id: t.id,
        position:
          t.id === "practice" ? 0 : run.assignment.order.indexOf(t.id) + 1,
        ai_provided:
          t.id === "practice" ? 0 : Number(run.assignment.support[t.id]),
        option_order: run.assignment.optionOrders[t.id].join(">"),
        apply_order:
          t.id === "practice"
            ? "p1>p2>p3"
            : run.assignment.applyOrders[t.id].join(">"),
        initial_choice: response.decision?.choice,
        initial_correct: response.decision
          ? Number(response.decision.choice === INITIAL[t.id])
          : null,
        trap_selected: response.decision
          ? Number(response.decision.choice === TRAPS[t.id])
          : null,
        burden_7: response.burden?.burden,
        confidence_100: estimated.confidence,
        pred_apply_6: estimated.predApply,
        pred_explain_4: estimated.predExplain,
        actual_apply_6: apply,
        actual_explain_4: explain,
        d_apply: dApply,
        d_explain: dExplain,
        absolute_error_apply: dApply === null ? null : Math.abs(dApply),
        apply_a: scores.apply[0],
        apply_b: scores.apply[1],
        apply_c: scores.apply[2],
        // Numeric checks are advisory; unresolved prose remains missing, never an error.
        no_trap_numeric_correct: numericOutcome(response.items[t.id === "practice" ? "p2" : "c"], KEY[t.id][t.id === "practice" ? "p2" : "c"]),
        retention_numeric_correct: numericOutcome(response.items[t.id === "practice" ? "p1" : "a"], KEY[t.id][t.id === "practice" ? "p1" : "a"]),
        retention_work_present: response.items[t.id === "practice" ? "p1" : "a"]
          ? Number(Boolean(response.items[t.id === "practice" ? "p1" : "a"].work.trim())) : null,
      };
      cases.push(row);
      local.push(row);
    }
    const baseline = local[0],
      main = local.slice(1),
      duplicate = Boolean(run.invitationId && counts.get(run.invitationId) > 1),
      complete = run.status === "completed",
      graded =
        baseline.actual_apply_6 !== null &&
        main.every(
          (c) => c.actual_apply_6 !== null && c.actual_explain_4 !== null,
        ),
      attentionPassed =
        pre.delivery === "remote"
          ? post.attention === "2"
          : post.attention === "not_applicable";
    participants.push({
      ...base,
      status: run.status,
      submitted_steps: run.submissions.length,
      next_phase: stepInfo(run).phase,
      next_task: stepInfo(run).taskId,
      started_at: run.startedAt,
      finished_at: run.finishedAt,
      gender: pre.gender,
      major: pre.major,
      age: pre.age,
      ai_frequency: pre.aiFrequency,
      delivery: pre.delivery,
      device: pre.device,
      exposure: post.exposure,
      external_used: post.externalUsed,
      attention_response: post.attention,
      attention_passed: attentionPassed ? 1 : 0,
      duplicate_invitation: duplicate ? 1 : 0,
      primary_ready:
        run.mode === "study" &&
        complete &&
        graded &&
        !duplicate &&
        post.externalUsed === "no" &&
        attentionPassed
          ? 1
          : 0,
      exclusion_reasons: [
        run.mode !== "study" && "not_study",
        !complete && "incomplete",
        !graded && "ungraded",
        duplicate && "duplicate_invitation",
        post.externalUsed !== "no" && "external_use_unconfirmed",
        !attentionPassed && "attention_unconfirmed_or_failed",
      ].filter(Boolean).join(";"),
      d_baseline: baseline.d_apply,
      se_baseline: baseline.confidence_100,
      mean_d_apply: mean(main.map((c) => c.d_apply)),
      mean_d_explain: mean(main.map((c) => c.d_explain)),
      mean_pred_apply: mean(main.map((c) => c.pred_apply_6)),
      mean_actual_apply: mean(main.map((c) => c.actual_apply_6)),
      mean_pred_explain: mean(main.map((c) => c.pred_explain_4)),
      mean_actual_explain: mean(main.map((c) => c.actual_explain_4)),
      mean_absolute_error_apply: mean(main.map((c) => c.absolute_error_apply)),
      mean_confidence: mean(main.map((c) => c.confidence_100)),
      mean_burden: mean(main.map((c) => c.burden_7)),
      first_d_apply: main.find((c) => c.position === 1).d_apply,
      within_ai_d: mean(
        main.filter((c) => c.ai_provided).map((c) => c.d_apply),
      ),
      within_control_d: mean(
        main.filter((c) => !c.ai_provided).map((c) => c.d_apply),
      ),
      post_used: post.used,
      post_prediction_basis: post.predictionBasis,
      post_strategy: post.strategy,
      post_transfer: post.transfer,
    });
    for (const event of e.events)
      events.push({ ...base, ...event, data: JSON.stringify(event.data) });
    const behavior = summarizeBehavior(e.events);
    stages.push(...behavior.stages.map((s) => ({ ...base, ...s })));
    sources.push(...behavior.sources.map((s) => ({ ...base, ...s })));
  }
  const flow = [];
  const groups = new Map();
  for (const p of participants) {
    const key = `${p.mode}:${p.condition}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  for (const group of groups.values()) {
    for (const [stage, n] of [
      ["imported_runs", group.length],
      ["incomplete", group.filter((p) => p.status !== "completed").length],
      ["completed", group.filter((p) => p.status === "completed").length],
      ["primary_ready", group.filter((p) => p.primary_ready === 1).length],
      ...[...new Set(group.flatMap((p) => p.exclusion_reasons.split(";").filter(Boolean)))].map((reason) =>
        ["exclusion_" + reason, group.filter((p) => p.exclusion_reasons.split(";").includes(reason)).length]),
    ]) flow.push({ mode: group[0].mode, condition: group[0].condition, stage, n });
  }
  return { participants, cases, items, events, stages, sources, flow };
}
export function agreement(ratings) {
  const pairs = Object.values(ratings)
    .filter((r) => r.rater1 && r.rater2)
    .map((r) => [r.rater1.score, r.rater2.score]);
  if (!pairs.length) return { n: 0, exact: null, weightedKappa: null };
  const n = pairs.length,
    a = [0, 0, 0],
    b = [0, 0, 0];
  let observed = 0;
  for (const [x, y] of pairs) {
    a[x]++;
    b[y]++;
    observed += Math.abs(x - y) / 2;
  }
  observed /= n;
  let expected = 0;
  for (let x = 0; x < 3; x++)
    for (let y = 0; y < 3; y++)
      expected += ((Math.abs(x - y) / 2) * a[x] * b[y]) / n ** 2;
  return {
    n,
    exact: pairs.filter(([x, y]) => x === y).length / n,
    weightedKappa: expected === 0 ? null : 1 - observed / expected,
  };
}
export const tableCSV = (rows) =>
  toCSV(rows, rows[0] ? Object.keys(rows[0]) : ["no_records"]);
/** Pilot thresholds use only the no-support pilot group, never treatment effects. */
export function pilotReport(envelopes, ratings = {}) {
  const a = analysisTables(
      envelopes.filter(
        (e) => e.run.mode === "pilot" && e.run.condition === "control",
      ),
      ratings,
    ),
    people = a.participants;
  return TASKS.map((task) => {
    const rows = a.cases.filter(
        (c) => c.task_id === task.id && c.actual_apply_6 !== null,
      ),
      initial = a.cases.filter(
        (c) => c.task_id === task.id && c.initial_correct !== null,
      ),
      c = a.items.filter(
        (i) =>
          i.task_id === task.id &&
          i.item_id === "c" &&
          i.response_state !== "missing",
      );
    const verified = c.filter((i) =>
      ["숫자 일치", "숫자 불일치", "모르겠음"].includes(i.numeric_check),
    );
    const avg = rows.length
        ? rows.reduce((s, r) => s + r.actual_apply_6, 0) / rows.length
        : null,
      full = rows.length
        ? rows.filter((r) => r.actual_apply_6 === 6).length / rows.length
        : null,
      correct = initial.length
        ? initial.filter((r) => r.initial_correct === 1).length / initial.length
        : null,
      noTrap = verified.length
        ? verified.filter((r) => r.numeric_check === "숫자 일치").length /
          verified.length
        : null,
      exposure = people.length
        ? people.filter((p) => p.exposure === "yes").length / people.length
        : null;
    return {
      task_id: task.id,
      control_pilot_n: people.length,
      graded_n: rows.length,
      apply_mean: avg,
      apply_mean_pass:
        avg === null ? "미채점" : avg >= 2.5 && avg <= 4.5 ? "통과" : "검토",
      full_score_proportion: full,
      full_score_pass: full === null ? "미채점" : full <= 0.5 ? "통과" : "검토",
      initial_correct_rate: correct,
      initial_pass:
        correct === null
          ? "결측"
          : correct >= 0.2 && correct <= 0.8
            ? "통과"
            : "검토",
      no_trap_numeric_correct_rate: noTrap,
      no_trap_manual_review: c.length - verified.length,
      no_trap_pass: !c.length
        ? "결측"
        : verified.length !== c.length
          ? "수동 확인 필요"
          : noTrap >= 0.8
            ? "통과"
            : "검토",
      prior_exposure_rate: exposure,
      prior_exposure_pass:
        exposure === null ? "결측" : exposure < 0.5 ? "통과" : "검토",
    };
  });
}
