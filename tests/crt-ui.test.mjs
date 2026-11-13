import test from "node:test";
import assert from "node:assert/strict";
import { domEnvironment, until, submit, choose } from "./helpers/dom-env.mjs";
import {
  makeInvitations,
  validateEnvelope,
  stepInfo,
} from "../web/crt/core.mjs";
const value = (d, name, v) => {
  const e = d.querySelector(`[name="${name}"]`);
  assert.ok(e, `field ${name}`);
  e.value = String(v);
  e.dispatchEvent(new window.Event("input", { bubbles: true }));
};
const checked = (d, name) => {
  const e = d.querySelector(`[name="${name}"]`);
  e.checked = true;
  e.dispatchEvent(new window.Event("change", { bubbles: true }));
};
function browserLocks(env) {
  const held = new Set();
  Object.defineProperty(env.window.navigator, "locks", {
    value: {
      async request(name, options, fn) {
        if (held.has(name)) return fn(null);
        held.add(name);
        try {
          return await fn({ name });
        } finally {
          held.delete(name);
        }
      },
    },
    configurable: true,
  });
}
for (const condition of ["control", "assisted"])
  test(`CRT participant ${condition}: complete flow, AI boundaries, required estimates, resume and export`, async (t) => {
    const invite = makeInvitations(6, "https://example.test/hci/").find(
        (i) => i.condition === condition,
      ),
      env = await domEnvironment(
        new URL("../web/index.html", import.meta.url),
        invite.url,
      );
    browserLocks(env);
    t.after(() => env.cleanup());
    await import(`../web/crt/app.mjs?flow=${condition}`);
    const d = env.document;
    await until(() => d.getElementById("start-form"));
    checked(d, "consent");
    checked(d, "noExternal");
    submit(d, "start-form");
    await until(() => d.querySelector('[name="major"]'));
    assert.match(d.querySelector('[aria-current="step"]').textContent, /시작 전/);
    for (const [k, v] of Object.entries({
      age: 23,
      gender: "undisclosed",
      major: "공학",
      aiFrequency: "weekly",
      delivery: "remote",
      device: "laptop",
    }))
      value(d, k, v);
    checked(d, "eligible");
    submit(d, "step-form");
    await until(() => d.querySelector('[name="choice"]'));
    choose(d, "choice", "p4");
    submit(d, "step-form");
    await until(() => d.querySelector('[name="confidence"]'));
    assert.match(d.getElementById("step-form").textContent, /채점 기준/);
    assert.match(d.querySelector('[aria-current="step"]').textContent, /연습/);
    assert.equal(d.querySelector('[name="confidence"]').value, "", "no anchored default estimate");
    assert.equal(d.querySelector('[name="confidence"]').max, "100");
    assert.equal(d.querySelector('[name="predApply"]').max, "6");
    assert.match(d.querySelector('.scale-anchors').textContent, /0 = 전혀 확신하지 않음.*100 = 완전히 확신/);
    submit(d, "step-form");
    const firstError = d.querySelector('#error a');
    assert.ok(firstError);
    firstError.click();
    assert.equal(d.activeElement.name, "confidence", "error summary focuses the relevant field");
    assert.ok(d.activeElement.getAttribute("aria-describedby").split(" ").includes("anchor-confidence"));
    assert.match(d.getElementById("anchor-confidence").textContent, /전혀 확신하지 않음/);
    const originalHash = env.window.location.hash;
    d.querySelector('[data-action="jump-response"]').click();
    assert.equal(d.activeElement.id, "response-title");
    assert.equal(env.window.location.hash, originalHash, "in-page navigation preserves manual invitation");
    value(d, "confidence", 75);
    submit(d, "step-form");
    assert.equal(d.querySelector('[name="confidence"]').getAttribute("aria-describedby"), "anchor-confidence range-confidence");
    value(d, "predApply", 4);
    submit(d, "step-form");
    await until(() => d.querySelector('[name="answer"]'));
    // Preserve Korean draft through a pause/resume, using persisted state rather than internal transitions.
    value(d, "answer", "6km");
    value(d, "work", "편도 12km를 기준으로 계산");
    await new Promise((r) => setTimeout(r, 600));
    d.querySelector('[data-action="pause"]').click();
    await until(() => d.getElementById("start-form"));
    d.querySelector('[data-action="resume"]').click();
    await until(() => d.querySelector('[name="work"]'));
    assert.equal(
      d.querySelector('[name="work"]').value,
      "편도 12km를 기준으로 계산",
    );
    let iterations = 0,
      feedbackSeen = false,
      aiSeen = 0,
      estimateChecks = 0;
    while (!d.querySelector('[data-action="new"]')) {
      assert.ok(iterations++ < 45);
      const form = d.getElementById("step-form");
      assert.ok(form);
      const text = form.textContent;
      if (form.querySelector('[name="choice"]')) {
        const ai = d.querySelector(".ai-card");
        if (ai) aiSeen++;
        assert.equal(Boolean(ai), condition === "assisted");
        const first = form.querySelector('[name="choice"]');
        first.checked = true;
      } else if (form.querySelector('[name="burden"]')) {
        assert.equal(
          Boolean(d.querySelector(".ai-card")),
          condition === "assisted",
        );
        choose(d, "burden", 3);
      } else if (form.querySelector('[name="confidence"]')) {
        assert.equal(d.querySelector(".ai-card"), null);
        value(d, "confidence", 70);
        value(d, "predApply", 4);
        if (form.querySelector('[name="predExplain"]')) {
          submit(d, "step-form");
          assert.ok(d.getElementById("error").textContent);
          value(d, "predExplain", 3);
          estimateChecks++;
        }
      } else if (form.querySelector('[name="acknowledged"]')) {
        feedbackSeen = true;
        assert.match(text, /王|왕복/);
        checked(d, "acknowledged");
      } else if (form.querySelector('[name="unknown"]')) {
        assert.equal(d.querySelector(".ai-card"), null);
        checked(d, "unknown");
      } else if (form.querySelector('[name="exposure"]')) {
        for (const k of ["used", "predictionBasis", "strategy", "transfer"])
          value(d, k, "문제의 관계를 확인했습니다.");
        value(d, "exposure", "no");
        value(d, "externalUsed", "no");
        value(d, "attention", "2");
      } else assert.fail("Unknown screen " + text.slice(0, 80));
      const calculator = d.getElementById("calculator-input");
      if (calculator) {
        assert.equal(calculator.value, "", "previous screen calculator must be cleared");
        assert.equal(d.getElementById("calculator-result").textContent, "");
        calculator.value = "(33000-30000)/2";
        d.querySelector('[data-action="calculate"]').click();
        assert.equal(d.getElementById("calculator-result").textContent, "1500");
      }
      const before = form;
      submit(d, "step-form");
      await until(
        () =>
          d.getElementById("step-form") !== before ||
          d.querySelector('[data-action="new"]'),
      );
    }
    assert.ok(feedbackSeen);
    assert.equal(aiSeen, condition === "assisted" ? 3 : 0);
    assert.equal(estimateChecks, 3);
    d.querySelector('[data-action="download"]').click();
    await until(() => env.blobs.length);
    const e = JSON.parse(await env.blobs.at(-1).text());
    assert.equal(validateEnvelope(e), true);
    assert.equal(e.run.submissions.length, 33);
    assert.equal(e.run.mode, "pilot");
    assert.equal(stepInfo(e.run).phase, "done");
    assert.ok(e.events.some((x) => x.type === "draft_revision"));
    d.querySelector('[data-action="new"]').click();
    await until(() => d.getElementById("start-form"));
    assert.equal(env.window.location.hash, "");
    assert.match(d.body.textContent, /다음 참가자의 새 참여 링크/);
    assert.equal(d.querySelector('#start-form button').disabled, true);
    checked(d, "consent"); checked(d, "noExternal");
    submit(d, "start-form");
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(d.getElementById("step-form"), null);
  });
