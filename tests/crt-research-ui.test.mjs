import test from "node:test";
import assert from "node:assert/strict";
import { domEnvironment, until, submit } from "./helpers/dom-env.mjs";
import {
  createRun,
  submitStep,
  stepInfo,
  makeEnvelope,
  makeInvitations,
  parseInvitation,
} from "../web/crt/core.mjs";
import {
  blindPacket,
  applyRatings,
  knownIds,
  consensusBasis,
} from "../web/crt/research-tools.mjs";
const tick = () => new Promise((r) => setTimeout(r, 30));
const metric = (d, label) => [...d.querySelectorAll(".crt-status-grid dt")].find(e => e.textContent === label)?.nextElementSibling.textContent;

function synthetic(run = createRun()) {
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
  assert.match(d.body.textContent, /아직 가져온 기록이 없습니다/);
  d.querySelector('[data-view="export"]').click();
  await until(() => d.querySelector('[data-action="csv-participants"]'));
  assert.ok(d.querySelector('[data-action="csv-participants"]').disabled);
  assert.ok(d.querySelector('[data-action="pilot-report"]').disabled);
  d.querySelector('[data-view="collect"]').click();
  const envelope = synthetic();
  upload(env, envelope);
  await until(() =>
    d.getElementById("research-message").textContent.includes("추가 1"),
  );
  assert.equal(metric(d, "독립 채점 필요"), "18개");
  upload(env, envelope);
  await until(() =>
    d.getElementById("research-message").textContent.includes("중복 1"),
  );
  d.querySelector('[data-action="packet"]').click();
  await until(() => d.getElementById("grade-form"));
  const packet = JSON.parse(await env.blobs.at(-1).text());
  assert.equal(packet.items.length, 18);
  assert.equal(d.activeElement, d.getElementById("grade-answer-title"), "entering a new grading packet starts at the response heading");
  assert.equal(d.querySelector(".crt-preparation"), null, "preparation overview must not enter blind scoring");
  assert.ok(d.getElementById("research-cloud").hidden);
  assert.ok(!JSON.stringify(packet).includes("participantCode"));
  assert.equal(d.querySelector('[name="score"]').value, "");
  const score = d.querySelector('[name="score"]');
  score.focus();
  score.value = "0";
  const reason = d.querySelector('[name="reason"]');
  reason.value = "모르겠음";
  submit(d, "grade-form");
  await until(() =>
    d.getElementById("research-message").textContent.includes("저장했습니다"),
  );
  assert.equal(d.activeElement, d.getElementById("grade-answer-title"), "saved grades focus the replacement response heading rather than the removed form");
  d.querySelector('[data-action="blind"]').click();
  await tick();
  assert.ok(d.body.classList.contains("crt-blind"));
  const next = d.querySelector('[data-action="next"]');
  next.focus(); next.click();
  await tick();
  assert.equal(d.activeElement, d.getElementById("grade-answer-title"), "next answer retains a meaningful keyboard reading position");
  assert.ok(d.body.classList.contains("crt-blind"), "grading navigation must keep full-blind mode");
  assert.equal(d.querySelector(".crt-preparation"), null);
  const previous = d.querySelector('[data-action="prev"]');
  previous.focus(); previous.click();
  await tick();
  assert.equal(d.activeElement, d.getElementById("grade-answer-title"));
  const role = d.getElementById("role");
  role.focus();
  role.value = "consensus";
  role.dispatchEvent(new env.window.Event("change", { bubbles: true }));
  await tick();
  assert.ok(d.querySelector('[name="score"]').disabled);
  assert.equal(d.activeElement, d.getElementById("role"), "role change restores the replacement selector even when scoring is disabled");
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
  d.querySelector('[data-action="blind"]').click();
  await tick();
  const exportTab = d.querySelector('[data-view="export"]');
  exportTab.focus(); exportTab.click();
  await until(() => d.getElementById("include-demo"));
  assert.equal(d.activeElement, exportTab, "tab selection keeps focus in the navigation tablist");
  assert.equal(metric(d, "독립 채점 필요"), "0개");
  assert.equal(metric(d, "합의 필요"), "0개");
  assert.equal(metric(d, "본 분석 자료 준비"), "0개", "team demo is not a prepared study participant");
  const beforeEmptyExport = env.blobs.length;
  d.querySelector('[data-action="csv-participants"]').click();
  await tick();
  assert.equal(env.blobs.length, beforeEmptyExport, "empty selected range must not download an ordinary CSV");
  assert.match(d.getElementById("research-message").textContent, /선택한 범위에 내보낼 자료가 없습니다/);
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
  assert.equal(metric(d, "합의 필요"), "1개", "a changed independent grade must return to agreement-needed");
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

test("research preparation uses valid consensus and distinguishes complete study eligibility from interrupted records", async t => {
  const {ResearchStore} = await import("../web/research-store.mjs");
  const env = await domEnvironment(new URL("../web/research.html", import.meta.url));
  t.after(() => env.cleanup());
  const entry = makeInvitations(1, "https://example.test/hci/", "between", "study")[0];
  const invitation = parseInvitation(new URL(entry.url).hash);
  const complete = synthetic(createRun({invitation}));
  const interrupted = makeEnvelope(createRun());
  const ratings = {};
  for (const id of knownIds([complete])) {
    const r = {rater1:{score:0,reason:"모르겠음"},rater2:{score:0,reason:"모르겠음"}};
    r.consensus = {score:0,reason:"합의",basis:consensusBasis(r)};
    ratings[id]=r;
  }
  const store = await new ResearchStore({dbName:"hci-crt-research-v4"}).init();
  await store.save({...store.state,envelopes:[complete,interrupted],ratings});
  store.db?.close();
  await import("../web/crt/research.mjs?preparation");
  const d=env.document;
  await until(() => d.querySelector(".crt-preparation"));
  assert.equal(metric(d,"가져온 실행"),"2개");
  assert.equal(metric(d,"응답 완료"),"1개");
  assert.equal(metric(d,"본 분석 자료 준비"),"1개");
  assert.equal(metric(d,"독립 채점 필요"),"0개");
  assert.equal(metric(d,"합의 필요"),"0개");
  assert.match(d.querySelector(".crt-preparation").textContent,/진행 중 1개/);
});
