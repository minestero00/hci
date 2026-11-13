import test from "node:test";
import assert from "node:assert/strict";
import { createRun, stepInfo, submitStep, makeEnvelope } from "../web/crt/core.mjs";
import { blindPacket, validatePacket } from "../web/crt/research-tools.mjs";
import { ITEM_RUBRICS } from "../web/crt/key.mjs";

function completedEnvelope() {
  let run = createRun();
  while (run.status !== "completed") {
    const step = stepInfo(run);
    const values = {
      pre: {
        age: 23, gender: "undisclosed", major: "공학", aiFrequency: "weekly",
        delivery: "remote", device: "laptop", eligible: true, consent: true, noExternal: true,
      },
      decision: { choice: "unknown" },
      burden: { burden: 3 },
      estimate: { confidence: 70, predApply: 4, ...(step.taskId === "practice" ? {} : { predExplain: 3 }) },
      item: { answer: "답", work: "풀이", unknown: false },
      feedback: { acknowledged: true },
      post: { used: "원문", predictionBasis: "연습", strategy: "계산", transfer: "없음", exposure: "no", externalUsed: "no", attention: "2" },
    }[step.phase];
    run = submitStep(run, values);
  }
  return makeEnvelope(run);
}

test("blind scoring retains distinct proposal boundaries for every scored item", () => {
  const packet = blindPacket([completedEnvelope()]);
  assert.equal(packet.items.length, 18);
  assert.equal(validatePacket(packet), true);
  for (const item of packet.items) {
    assert.deepEqual(item.rubric, ITEM_RUBRICS[item.taskId][item.itemId]);
    assert.deepEqual(Object.keys(item.rubric), ["0", "1", "2"]);
  }
  const find = (task, item) => packet.items.find(i => i.taskId === task && i.itemId === item);
  // The trap-free subtraction item does not inherit the broader arithmetic-error
  // allowance of the structural-change item. Changing these would alter D.
  assert.match(find("difference", "a").rubric[1], /계산 실수/);
  assert.equal(find("difference", "c").rubric[1], "3,000원만 쓴 답.");
  assert.match(find("trade", "b").rubric[1], /부호 실수/);
  assert.match(find("trade", "b").rubric[0], /근거 없는 15만 원/);
  assert.match(find("rate", "d").rubric[2], /단위 인쇄량/);
  assert.match(find("difference", "e").rubric[2], /1,000원/);
  const tampered = structuredClone(packet);
  tampered.items[0].rubric = structuredClone(find("difference", "a").rubric);
  // Choose a known other item so this is a different but otherwise valid rubric.
  tampered.items[0] = { ...find("rate", "b"), rubric: structuredClone(find("difference", "a").rubric) };
  tampered.items = [tampered.items[0]];
  assert.throws(() => validatePacket(tampered), /채점 기준/);
});

// Numeric summaries must not silently classify incompatible explicit units.
test("numeric advisory leaves mismatched units for human review", async () => {
  const { numericCheck, KEY } = await import("../web/crt/key.mjs");
  assert.equal(numericCheck("3원", KEY.rate.a), "수동 확인");
  assert.equal(numericCheck("3000분", KEY.difference.c), "수동 확인");
  assert.equal(numericCheck("3분", KEY.rate.a), "숫자 일치");
  assert.equal(numericCheck("20만원", KEY.trade.a), "숫자 일치");
});
