import test from "node:test";
import assert from "node:assert/strict";
import { domEnvironment, until, submit } from "./helpers/dom-env.mjs";
import {
  createRun,
  submitStep,
  stepInfo,
  makeEnvelope,
} from "../web/crt/core.mjs";
import {
  blindPacket,
  applyRatings,
  knownIds,
} from "../web/crt/research-tools.mjs";
const tick = () => new Promise((r) => setTimeout(r, 30));
function synthetic() {
  let run = createRun();
  while (run.status !== "completed") {
    const s = stepInfo(run);
    let v;
    if (s.phase === "pre")
      v = {
        age: 22,
        gender: "undisclosed",
        major: "공학",
        aiFrequency: "weekly",
        delivery: "in_person",
        device: "laptop",
        eligible: true,
        consent: true,
        noExternal: true,
      };
    else if (s.phase === "post")
      v = {
        used: "원문",
        predictionBasis: "연습",
        strategy: "관계 확인",
        transfer: "동일",
        exposure: "no",
        externalUsed: "no",
        attention: "not_applicable",
      };
    else if (s.phase === "decision") v = { choice: "unknown" };
    else if (s.phase === "estimate")
      v = {
        confidence: 50,
        predApply: 3,
        ...(s.taskId === "practice" ? {} : { predExplain: 2 }),
      };
    else if (s.phase === "burden") v = { burden: 2 };
    else if (s.phase === "feedback") v = { acknowledged: true };
    else v = { answer: "", work: "", unknown: true };
    run = submitStep(run, v);
  }
  return makeEnvelope(run);
}
function upload(env, value) {
  const input = env.document.getElementById("files"),
    file = new env.window.File([JSON.stringify(value)], "synthetic.json", {
      type: "application/json",
    });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  input.dispatchEvent(new env.window.Event("change", { bubbles: true }));
}
test("CRT researcher imports a full run, roundtrips blind grades, requires human agreement and exports CSV", async (t) => {
  const env = await domEnvironment(
    new URL("../web/research.html", import.meta.url),
  );
  t.after(() => env.cleanup());
  await import("../web/crt/research.mjs?roundtrip");
  const d = env.document;
  await until(() => d.getElementById("files"));
  const envelope = synthetic();
  upload(env, envelope);
  await until(() =>
    d.getElementById("research-message").textContent.includes("추가 1"),
  );
  upload(env, envelope);
  await until(() =>
    d.getElementById("research-message").textContent.includes("중복 1"),
  );
  d.querySelector('[data-action="packet"]').click();
  await until(() => d.getElementById("grade-form"));
  const packet = JSON.parse(await env.blobs.at(-1).text());
  assert.equal(packet.items.length, 18);
  assert.ok(!JSON.stringify(packet).includes("participantCode"));
  assert.equal(d.querySelector('[name="score"]').value, "");
  const score = d.querySelector('[name="score"]');
  score.value = "0";
  const reason = d.querySelector('[name="reason"]');
  reason.value = "모르겠음";
  submit(d, "grade-form");
  await until(() =>
    d.getElementById("research-message").textContent.includes("저장했습니다"),
  );
  const role = d.getElementById("role");
  role.value = "consensus";
  role.dispatchEvent(new env.window.Event("change", { bubbles: true }));
  await tick();
  assert.ok(d.querySelector('[name="score"]').disabled);
  for (const r of ["rater1", "rater2"]) {
    upload(env, {
      format: "hci-crt-ratings",
      studyVersion: "4.0.0",
      role: r,
      ratings: packet.items.map((i) => ({
        responseId: i.responseId,
        score: 0,
        reason: "모르겠음",
      })),
    });
    await tick();
  }
  await until(() => !d.querySelector('[name="score"]').disabled);
  upload(env, {
    format: "hci-crt-ratings",
    studyVersion: "4.0.0",
    role: "consensus",
    ratings: packet.items.map((i) => ({
      responseId: i.responseId,
      score: 0,
      reason: "두 채점자 일치",
      basis: { rater1: { score: 0, reason: "모르겠음" }, rater2: { score: 0, reason: "모르겠음" } },
    })),
  });
  await tick();
  d.querySelector('[data-view="export"]').click();
  await until(() => d.getElementById("include-demo"));
  d.getElementById("include-demo").checked = true;
  d.querySelector('[data-action="csv-participants"]').click();
  await tick();
  const csv = await env.blobs.at(-1).text();
  assert.match(csv, /d_baseline/);
  assert.match(csv, /mean_d_apply/);
  assert.match(csv, /mean_d_explain/);
  assert.match(csv, /se_baseline/);
  d.querySelector('[data-view="grade"]').click();
  await until(() => d.getElementById("role"));
  const changedRole = d.getElementById("role");
  changedRole.value = "rater1";
  changedRole.dispatchEvent(new env.window.Event("change", { bubbles: true }));
  await tick();
  d.querySelector('[name="score"]').value = "0";
  d.querySelector('[name="reason"]').value = "모르겠음 재확인";
  submit(d, "grade-form");
  await tick();
  d.querySelector('[data-view="export"]').click();
  await until(() => d.querySelector('[data-action="archive"]'));
  d.querySelector('[data-action="archive"]').click();
  await tick();
  const archive = JSON.parse(await env.blobs.at(-1).text());
  const changed = archive.gradeHistory.find((h) => h.cause === "independent_rating_changed");
  assert.ok(changed, "invalidated consensus remains in audit history");
  assert.equal(changed.previous.score, 0);
  assert.equal(changed.next, null);
  assert.equal(archive.ratings[changed.responseId].consensus, undefined);
  d.getElementById("include-demo").checked = true;
  d.querySelector('[data-action="csv-items"]').click();
  await tick();
  const itemCSV = await env.blobs.at(-1).text();
  const changedRow = itemCSV.split("\n").find((line) => line.includes(changed.responseId));
  assert.ok(changedRow);

});
