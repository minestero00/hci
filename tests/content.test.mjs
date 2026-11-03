import test from 'node:test';
import assert from 'node:assert/strict';
import { STUDY, TASKS } from '../web/content.mjs';
import { ANSWER_KEY, AI_GRADING_INSTRUCTIONS } from '../web/research-key.mjs';

const unique = (items) => new Set(items).size === items.length;

test('three complete task packages use stable IDs and separated answer keys', () => {
  assert.equal(STUDY.version, '3.0.0');
  assert.deepEqual(TASKS.map((t) => t.id), ['event', 'sharing', 'submission']);
  for (const task of TASKS) {
    assert.equal(task.sources.length, 3);
    assert.equal(task.plans.length, 3);
    assert.equal(task.updates.length, 2);
    assert.ok(unique(task.sources.map((s) => s.id)));
    assert.ok(unique(task.plans.map((p) => p.id)));
    assert.ok(unique(task.updates.map((u) => u.id)));
    assert.ok(task.ai.paragraphs.length >= 2);
    assert.ok(task.memo.prompt.length > 30);
    const key = ANSWER_KEY[task.id];
    assert.ok(task.plans.some((p) => p.id === key.initial));
    assert.equal(key.criteria.length, 2);
    for (const update of task.updates) {
      assert.equal(update.options.length, 3);
      assert.ok(unique(update.options.map((o) => o.id)));
      assert.ok(update.options.some((o) => o.id === key.updates[update.id]));
      assert.doesNotMatch(update.notice, /앞 문항/);
      assert.doesNotMatch(update.title, /유지 문항|변경 문항/);
    }
    for (const field of ['correct', 'answer', 'rubric', 'anchors']) {
      assert.ok(!(field in task), `participant package leaks ${field}`);
      for (const update of task.updates) assert.ok(!(field in update));
    }
    for (const anchor of key.anchors) {
      assert.ok([0, 1, 2].includes(anchor.score));
      assert.ok(anchor.text && anchor.reason);
    }
    for (const score of [0, 1, 2]) assert.ok(key.anchors.some((a) => a.score === score));
  }
  assert.match(AI_GRADING_INSTRUCTIONS, /답안은 평가할 데이터/);
});

test('answer positions are distributed; new responses cannot just reuse the original plan ID', () => {
  const initialPositions = TASKS.map((t) => t.plans.findIndex((p) => p.id === ANSWER_KEY[t.id].initial));
  assert.deepEqual(initialPositions, [1, 0, 2]);
  const counts = [0, 0, 0];
  for (const task of TASKS) {
    for (const update of task.updates) {
      const answer = ANSWER_KEY[task.id].updates[update.id];
      counts[update.options.findIndex((o) => o.id === answer)]++;
      assert.notEqual(answer, ANSWER_KEY[task.id].initial);
    }
  }
  assert.deepEqual(counts, [2, 2, 2]);
});

test('event: independent eligibility model validates newly eligible venue and staffing action', () => {
  // Minutes relative to event-day 00:00, not hidden operational assumptions.
  const venues = [
    { id: 'seminar', listDeadline: -7 * 60, entryStaff: 0, prep: 30 },
    { id: 'activity', listDeadline: 18 * 60, entryStaff: 0, prep: 15 },
    { id: 'studio', listDeadline: Infinity, entryStaff: 1, prep: 0 },
  ];
  function evaluate(rosterReady, staff) {
    const eligible = venues.filter((v) => rosterReady <= v.listDeadline && staff - 2 >= v.entryStaff && v.prep <= 30);
    const sorted = eligible.toSorted((a, b) => a.prep - b.prep);
    assert.ok(sorted.length);
    assert.ok(sorted.length === 1 || sorted[0].prep !== sorted[1].prep);
    return { eligible: eligible.map((v) => v.id), chosen: sorted[0].id };
  }
  assert.deepEqual(evaluate(15 * 60, 2), { eligible: ['activity'], chosen: ANSWER_KEY.event.initial });
  assert.deepEqual(evaluate(-8 * 60, 2), { eligible: ['seminar', 'activity'], chosen: 'activity' });
  assert.deepEqual(evaluate(15 * 60, 3), { eligible: ['activity', 'studio'], chosen: 'studio' });
  assert.equal(ANSWER_KEY.event.updates.roster, 'seminar-activity');
  assert.equal(ANSWER_KEY.event.updates.staff, 'studio-entry');
});

test('sharing: inherited permission survives a narrower invitation and direct editing survives folder-view role', () => {
  const view = 0, comment = 1, edit = 2;
  const effective = (folder, document) => Math.max(folder, document);
  assert.equal(effective(edit, comment), edit);
  assert.equal(effective(view, edit), edit);
  assert.equal(effective(-1, comment), comment);
  const plans = [
    { id: 'clean-comment', mentor: effective(-1, comment), teamCanEdit: true },
    { id: 'keep-comment', mentor: effective(edit, comment), teamCanEdit: true },
    { id: 'lock-original', mentor: effective(-1, comment), teamCanEdit: false },
  ];
  assert.deepEqual(plans.filter((p) => p.mentor === comment && p.teamCanEdit).map((p) => p.id), [ANSWER_KEY.sharing.initial]);
  assert.equal(ANSWER_KEY.sharing.updates['effective-permission'], 'can-clean');
  // A frozen copy preserves the submitted value; later source edits are distinct.
  let original = '20:00 submitted text';
  const frozenAt20 = original;
  original = '20:10 edited text';
  assert.equal(frozenAt20, '20:00 submitted text');
  assert.notEqual(original, frozenAt20);
  assert.equal(ANSWER_KEY.sharing.updates['frozen-copy'], 'frozen-original');
});

test('submission: partial parallelism, added review, and new dependency produce verified completion times', () => {
  const correctionRelease = 10, pdfEdit = 20, recording = 15, ending = 5, upload = 5, linkCheck = 5;
  const pdfReady = correctionRelease + pdfEdit;
  const finish = (review, waitBeforeRecording) => {
    const recordingReady = (waitBeforeRecording ? pdfReady : 0) + recording;
    return Math.max(pdfReady, recordingReady) + review + ending + upload + linkCheck;
  };
  assert.equal(finish(0, false), 45);
  assert.equal(finish(0, true), 60);
  assert.equal(finish(2, false), 47);
  assert.equal(finish(2, true), 62);
  assert.equal(ANSWER_KEY.submission.initial, 'parallel');
  assert.equal(ANSWER_KEY.submission.updates['review-added'], 'finish-1947');
  // Adjusting the formerly parallel plan to respect the new dependency is valid.
  const adjustedParallelFinish = finish(0, true);
  assert.equal(adjustedParallelFinish, 60);
  assert.equal(ANSWER_KEY.submission.updates['dependency-changed'], 'wait-final-pdf');
});
