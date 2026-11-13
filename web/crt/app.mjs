import { STUDY, TASKS, PRACTICE, taskFor } from "./content.mjs";
import {
  createRun,
  submitStep,
  stepInfo,
  responses,
  validateRun,
  makeEnvelope,
  parseInvitation,
  shuffle,
  stableStringify,
} from "./core.mjs";
import { BrowserStore } from "../storage.mjs";
import { Recorder } from "../recorder.mjs";
import {
  CloudSync,
  cloudEnabled,
  markCloudConsent,
  hasCloudConsent,
} from "../cloud-sync.mjs";
import { allocate, connect } from "./cloud.mjs";
import { calculate } from "./calculator.mjs";
const app = document.getElementById("app"),
  esc = (x) =>
    String(x ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
const ACTIVE = "hci-crt-v4-active",
  lockName = (id) => `hci-crt-v4:${id}`;
let store,
  run = null,
  saved = null,
  recorder = null,
  cloud = null,
  cloudState = "idle",
  busy = false,
  persistenceError = "",
  releaseLock = null,
  owned = false,
  writeQueue = Promise.resolve(),
  draftTimer = null,
  composing = false,
  invitation = null,
  entryError = "",
  feedback = null,
  calcValue = "",
  calcResult = "";
const cloudOn = cloudEnabled(),
  batch = new URLSearchParams(location.search).get("batch");
try {
  invitation = parseInvitation(location.hash);
} catch (e) {
  entryError = e.message;
}
const input = (name, label, type = "text", attrs = "") =>
  `<label class="field"><span>${label}</span><input name="${name}" type="${type}" ${attrs}></label>`;
const select = (name, label, choices) =>
  `<label class="field"><span>${label}</span><select name="${name}" required><option value="">선택해 주세요</option>${choices.map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></label>`;
const textarea = (name, label, max = 2000) =>
  `<label class="field"><span>${label}</span><textarea name="${name}" maxlength="${max}" rows="4" required></textarea></label>`;
const check = (name, label) =>
  `<label class="check-line"><input name="${name}" type="checkbox" required><span>${label}</span></label>`;
const btn = (text, action) =>
  `<button class="button" type="button" data-action="${action}">${text}</button>`;
function error(message) {
  const el = document.getElementById("error");
  if (el) {
    el.textContent = message;
    el.focus();
  } else {
    persistenceError = message;
    status();
  }
}
function header() {
  return `<header class="crt-header"><strong>판단 워크스페이스</strong><span>문제와 응답</span>${run ? `<div class="actions">${btn("현재 기록 다운로드", "download")}${btn("잠시 나가기", "pause")}</div>` : ""}</header><div id="save-state" role="status" class="save-note">${esc(persistenceError || "응답은 이 브라우저에 보관됩니다.")}</div>`;
}
function status() {
  const e = document.getElementById("save-state");
  if (e)
    e.textContent =
      persistenceError ||
      (busy
        ? "저장 중…"
        : store.mode === "memory"
          ? "현재 탭에만 임시 보관 · 닫기 전에 파일로 보관하세요."
          : `이 브라우저에 저장됨${cloudOn ? " · " + ({ idle: "서버 연결 대기", sending: "서버 전송 중", synced: "서버에 중간 기록 전송됨", complete: "최종 응답 서버 수신 확인", error: "서버 전송 실패 · 재시도 또는 파일 보관" }[cloudState] ?? cloudState) : ""}`);
}
async function save(candidate = run) {
  const snapshot = structuredClone(candidate);
  writeQueue = writeQueue.catch(() => {}).then(() => store.saveRun(snapshot));
  try {
    await writeQueue;
    persistenceError = "";
  } catch (e) {
    persistenceError = "기기 저장 실패 · 현재 기록을 다운로드해 주세요.";
    throw e;
  } finally {
    status();
  }
}
function formValues(form) {
  const d = new FormData(form),
    v = Object.fromEntries(d.entries());
  for (const e of form.querySelectorAll('[type="checkbox"]'))
    v[e.name] = e.checked;
  return v;
}
async function saveDraft() {
  clearTimeout(draftTimer);
  draftTimer = null;
  if (!run || busy || !owned || composing || run.status === "completed") return;
  const form = document.getElementById("step-form");
  if (!form) return;
  const values = formValues(form),
    key = String(stepInfo(run).index);
  if (
    run.draft.key === key &&
    stableStringify(run.draft.values) === stableStringify(values)
  )
    return;
  run = { ...run, draft: { key, values }, updatedAt: new Date().toISOString() };
  recorder?.record("draft_revision", { field: key, value: values });
  cloud?.update(run);
  try {
    await save();
  } catch {}
}
async function lock(id) {
  if (!navigator.locks?.request)
    throw Error(
      "이 브라우저에서는 안전한 이어하기를 사용할 수 없습니다. 최신 Chrome·Edge에서 열어 주세요.",
    );
  return new Promise((resolve, reject) => {
    navigator.locks
      .request(lockName(id), { ifAvailable: true }, async (value) => {
        if (!value) {
          resolve(false);
          return;
        }
        owned = true;
        resolve(true);
        await new Promise((r) => (releaseLock = r));
        owned = false;
      })
      .catch(reject);
  });
}
async function openRun(candidate, { cloudConsent = false } = {}) {
  validateRun(candidate);
  if (cloudOn && !hasCloudConsent(candidate.id) && !cloudConsent)
    throw Error(
      "기존 기록을 서버에 전송하려면 추가 동의를 선택해 주세요. 동의하지 않아도 파일로 보관할 수 있습니다.",
    );
  if (!(await lock(candidate.id)))
    throw Error(
      "다른 탭에서 진행 중입니다. 해당 탭을 닫고 다시 이어가 주세요.",
    );
  try {
    const latest = await store.getRun(candidate.id);
    run = latest ?? candidate;
    localStorage.setItem(ACTIVE, run.id);
    saved = run;
    recorder = new Recorder({
      store,
      step: stepInfo,
      onStatus: (s) => {
        if (s.state === "error") {
          persistenceError = s.message;
          status();
        }
      },
    });
    recorder.start(run);
    if (cloudOn) {
      markCloudConsent(run.id);
      cloud = new CloudSync({
        store,
        onStatus: (s) => {
          cloudState = s.state;
          status();
        },
      });
      cloud.start(run);
      void cloud.sync().catch(() => {});
    }
    await save();
    await render();
    if (run.status === "completed") void finalSync();
  } catch (e) {
    saved = run ?? candidate;
    try { await recorder?.stop(); } catch {}
    cloud?.stop();
    cloud = null;
    run = null;
    releaseLock?.();
    releaseLock = null;
    owned = false;
    resetCalculator();
    throw e;
  }
}
function welcome() {
  return `<section class="card intro"><p class="eyebrow">참여 안내</p><h1>세 묶음의 문제에 답해 주세요.</h1><p>먼저 연습을 진행하고, 문제를 읽고 답을 고른 뒤 다음 수행을 예상합니다. 이후 바뀐 조건의 문제에 답과 풀이를 적습니다.</p><p>약 20~30분 · 시간 제한 없음 · PC 또는 넓은 화면의 태블릿</p><p>일부 참가자에게는 미리 작성하고 연구자가 검수한 정확한 AI 추천과 설명이 제공됩니다. 실시간 AI 대화는 사용하지 않습니다.</p><p>문제 원문과 화면의 계산기를 참고할 수 있습니다. 외부 AI·검색·별도 메모는 사용하지 마세요. 짧은 식과 계산이면 충분하며, 모르면 ‘모르겠음’을 선택할 수 있습니다.</p><p>응답·수정 이력, 클릭·스크롤·자료 노출·탭과 창 상태 등을 기록합니다. 모든 키의 문자나 클립보드 원문, 다른 앱의 내용은 별도로 수집하지 않습니다. ${cloudOn ? "동의 후 연구팀 Firebase 서버(서울)로 자동 전송합니다." : "로컬 체험에서는 브라우저에 보관하며 JSON을 연구팀에 전달합니다."} 언제든 중단할 수 있습니다.</p>${entryError ? `<p class="error">${esc(entryError)}</p>` : ""}
 ${saved ? `<section class="notice"><p>${esc(saved.participantCode)} · ${saved.status === "completed" ? "완료 기록" : "진행 중인 기록"}</p><div class="actions">${cloudOn && !hasCloudConsent(saved.id) ? '<label class="check-line"><input id="resume-cloud-consent" type="checkbox"><span>기존 응답·수정 이력·행동 기록과 이후 기록을 연구팀 Firebase 서버(서울)로 전송하는 데 동의합니다.</span></label>' : ""}${btn("이어서 열기", "resume")}${btn("보관된 기록 다운로드", "download-saved")}</div></section>` : ""}
 <form id="start-form">${invitation || batch ? "<p>연구자가 전달한 참여 링크로 진행합니다.</p>" : '<p class="notice">팀 체험입니다. 본 실험과 구분해 저장합니다.</p>'}${check("consent", "참여 방식과 기록·전송 안내를 확인했으며 참여에 동의합니다.")}${check("noExternal", "외부 AI·검색·별도 메모를 사용하지 않겠습니다.")}<div class="actions"><button class="button" ${entryError ? "disabled" : ""}>동의하고 시작</button></div></form><p class="small">이전 업무형 자료는 <a href="./legacy-v3.html">v3 복구 화면</a>에서 열 수 있습니다.</p></section>`;
}
function preForm() {
  return `<h1>시작 전 질문</h1><p>이름·학번·연락처는 입력하지 마세요.</p>${input("age", "만 나이", "number", 'min="19" max="29" step="1" required')}${select(
    "gender",
    "성별",
    [
      ["female", "여성"],
      ["male", "남성"],
      ["other", "그 외"],
      ["undisclosed", "응답하지 않음"],
    ],
  )}${input("major", "전공", "text", 'maxlength="100" required')}${select(
    "aiFrequency",
    "평소 생성형 AI 이용 빈도",
    [
      ["never", "사용하지 않음"],
      ["monthly", "월 단위 또는 그보다 드물게"],
      ["weekly", "주 단위"],
      ["daily", "거의 매일"],
    ],
  )}${select("delivery", "진행 방식", [
    ["in_person", "연구자와 대면"],
    ["remote", "비대면"],
  ])}${select("device", "사용 기기", [
    ["laptop", "노트북"],
    ["desktop", "데스크톱"],
    ["tablet", "태블릿"],
  ])}${check("eligible", "19~29세 대학생이며, 이 과제 제작에 참여하거나 정답을 미리 보거나 이전 사람 파일럿에 참여하지 않았습니다.")}`;
}
function estimates(practice) {
  return `<h1>다음 수행을 예상해 주세요.</h1><p>채점 기준: 적용 문항은 정답과 풀이가 모두 맞으면 2점, 정답만 있으면 1점입니다. 올바른 풀이의 단순 계산 실수는 문항별 기준에 따라 부분점수를 받을 수 있습니다. 틀린 풀이·무응답·모르겠음은 0점입니다. 설명 문항은 핵심 관계와 이유를 모두 설명하면 2점, 일부만 설명하면 1점, 틀리거나 모르겠음은 0점입니다. 길이와 문체는 채점하지 않습니다.</p><p>다음 단계에서는 AI 추천과 설명 없이 문제 원문과 계산기만 참고할 수 있습니다. ${practice ? "본 과제에서는 설명 예상 점수 칸이 하나 더 있습니다." : "연습에서 본 방식으로 채점합니다."}</p><div class="estimate-fields">${input("confidence", "1. 이와 같은 유형의 문제를, 조건이 바뀌어도 AI 없이 혼자 맞게 풀 수 있다고 얼마나 확신합니까? (0 = 전혀 확신하지 않음, 100 = 완전히 확신)", "number", 'min="0" max="100" step="1" required')}${input("predApply", "2. 조건이 바뀐 문제 3문항(6점 만점)에서 몇 점을 받을 것으로 예상합니까?", "number", 'min="0" max="6" step="1" required')}${practice ? "" : input("predExplain", "3. 원래 문제의 풀이를 설명하는 2문항(4점 만점)에서 몇 점을 받을 것으로 예상합니까?", "number", 'min="0" max="4" step="1" required')}</div><p>모든 칸에 정수를 입력해 주세요. 제출 후에는 수정하거나 AI 설명을 다시 볼 수 없습니다.</p>`;
}
function postForm() {
  const pre = responses(run).pre;
  return `<h1>마지막 질문</h1>${textarea("used", "답을 고를 때 어떤 자료나 설명을 주로 이용했나요?")}${textarea("predictionBasis", "예상 점수를 정할 때 무엇을 기준으로 했나요?")}${textarea("strategy", "기억한 설명과 문제 원문을 각각 어떻게 활용했나요?")}${textarea("transfer", "뒤 묶음으로 갈수록 문제를 푸는 방식이 달라졌나요?")}${select(
    "exposure",
    "공과 방망이 문제 등 이 실험과 비슷한 문제를 전에 본 적이 있나요?",
    [
      ["yes", "예"],
      ["no", "아니오"],
      ["unsure", "잘 모르겠음"],
    ],
  )}${select("externalUsed", "진행 중 외부 AI·검색·별도 메모를 사용했나요?", [
    ["no", "아니오"],
    ["yes", "예"],
  ])}${
    pre.delivery === "remote"
      ? select(
          "attention",
          "진행 확인: 이 문항에서는 숫자 2를 선택해 주세요.",
          [
            ["other", "1"],
            ["2", "2"],
          ],
        )
      : '<input name="attention" type="hidden" value="not_applicable">'
  }`;
}
function source(task, step) {
  const ai =
    ["decision", "burden"].includes(step.phase) &&
    task.id !== "practice" &&
    run.assignment.support[task.id];
  return `<aside class="crt-source"><section class="card" data-source-id="${task.id}:problem"><p class="eyebrow">${task.id === "practice" ? "공통 연습" : "원래 문제"}</p><h2>${esc(task.title)}</h2><p>${esc(task.problem)}</p></section>${ai ? `<section class="card ai-card" data-source-id="${task.id}:ai"><p class="eyebrow">AI 판단 지원</p><h2>${esc(task.options.find((o) => o.id === task.ai.choice).label)}을 추천합니다.</h2>${task.ai.paragraphs.map((p) => `<p>${esc(p)}</p>`).join("")}</section>` : ""}${calculator()}</aside>`;
}
// Each submitted screen starts fresh, including AI removal and independent items.
function resetCalculator() {
  calcValue = "";
  calcResult = "";
}
function calculator() {
  return `<section class="card calculator"><h2>계산기</h2><label class="field"><span>사칙연산 식</span><input id="calculator-input" autocomplete="off" inputmode="text" maxlength="120" placeholder="예: (12 + 6) / 3" value="${esc(calcValue)}"></label><button type="button" class="button secondary" data-action="calculate">계산</button><output id="calculator-result" aria-live="polite">${esc(calcResult)}</output></section>`;
}
function stepBody(step) {
  const task = taskFor(step.taskId);
  if (step.phase === "pre") return preForm();
  if (step.phase === "post") return postForm();
  if (step.phase === "decision")
    return `<p class="eyebrow">${task.id === "practice" ? "연습 · " : ""}답 선택</p><h1>답을 골라 주세요.</h1><fieldset><legend>${esc(task.problem)}</legend>${run.assignment.optionOrders[
      task.id
    ]
      .map((id, index) => {
        const o = task.options.find((o) => o.id === id);
        return `<label class="choice"><input type="radio" name="choice" value="${o.id}" required><span>${index + 1}. ${esc(o.label)}</span></label>`;
      })
      .join(
        "",
      )}<label class="choice"><input type="radio" name="choice" value="unknown" required><span>모르겠음</span></label></fieldset>`;
  if (step.phase === "burden")
    return `<h1>방금 선택을 돌아봐 주세요.</h1><fieldset><legend>답을 결정하는 데 정신적인 노력이 많이 필요했다.</legend><div class="burden-grid">${Array.from({ length: 7 }, (_, i) => `<label><input name="burden" type="radio" value="${i + 1}" required> ${i + 1}</label>`).join("")}</div><p>1 = 전혀 그렇지 않다 · 7 = 매우 그렇다</p></fieldset>`;
  if (step.phase === "estimate") return estimates(task.id === "practice");
  if (step.phase === "feedback")
    return `<h1>연습 풀이와 채점 예시</h1><p>${esc(feedback?.FEEDBACK ?? "풀이를 불러오는 중입니다.")}</p>${PRACTICE.items.map((i) => `<p><strong>${esc(i.prompt)}</strong><br>${esc(feedback?.PRACTICE_KEY[i.id].reason)}</p>`).join("")}<h2>답과 풀이의 채점 예시</h2>${(feedback?.ANCHORS ?? []).map((a) => `<p>${a.score}점 · ${esc(a.text)}</p>`).join("")}<p>정답과 풀이가 모두 맞으면 2점, 정답만 있거나 올바른 풀이에서 단순 계산 실수 하나가 있으면 1점입니다. 모르겠음은 0점이며, 길이·문체는 채점하지 않습니다.</p>${check("acknowledged", "풀이와 채점 예시를 확인했습니다.")}`;
  const item = task.items.find((i) => i.id === step.itemId);
  return `<p class="eyebrow">${task.id === "practice" ? "연습" : `묶음 ${run.assignment.order.indexOf(task.id) + 1} / 3`} · ${item.type === "apply" ? "적용" : "설명"}</p><h1>${esc(item.prompt)}</h1>${item.type === "apply" ? `<div class="notice"><p>이 문항은 원래 문제에서 출발합니다. 앞 문항의 변경 사항은 이어지지 않습니다.</p><strong>이번 문항의 조건</strong><p>${esc(item.change)}</p></div>${input("answer", "답 (단위를 함께 적어도 됩니다)", "text", 'maxlength="200" required')}` : '<input name="answer" type="hidden" value="">'}${textarea("work", item.type === "apply" ? "풀이 (짧은 식이나 계산이면 충분합니다. 풀이가 없으면 정답이어도 1점입니다.)" : "이유와 설명")}${item.type === "apply" ? '<p class="small">답만 제출할 수도 있습니다. 풀이 칸은 비워도 됩니다.</p>' : ""}<label class="check-line"><input name="unknown" type="checkbox"><span>모르겠음</span></label>`;
}
function completed() {
  return `<section class="card intro"><p class="eyebrow">응답 완료</p><h1>모든 응답을 마쳤습니다.</h1><p>참가자 코드: ${esc(run.participantCode)}</p><p>참여해 주셔서 감사합니다. 연구는 제공된 지원과 이후 독립 수행에 대한 예상의 관계를 살펴봅니다.</p>${cloudOn ? `<p id="cloud-complete" role="status">${cloudState === "complete" ? "최종 응답 서버 수신 확인" : "서버 수신 확인을 기다리고 있습니다."}</p>${btn("최종 전송·수신 확인 다시 시도", "sync")}` : "<p>응답 파일을 내려받아 연구 담당자에게 전달해 주세요.</p>"}<div class="actions">${btn("응답 파일 다운로드", "download")}${btn("새 참여 준비", "new")}</div></section>`;
}
async function render() {
  const step = run ? stepInfo(run) : null;
  if (step?.phase === "feedback" && !feedback)
    feedback = await import("./feedback.mjs");
  app.innerHTML =
    header() +
    `<main id="main" tabindex="-1" class="crt-shell">${!run ? welcome() : step.phase === "done" ? completed() : `<div class="step-heading"><span>진행 ${step.index} / ${step.totalSteps}</span><progress max="${step.totalSteps}" value="${step.index}" aria-label="전체 진행"></progress></div><div class="${step.taskId ? "crt-grid" : ""}">${step.taskId ? source(taskFor(step.taskId), step) : ""}<section class="card crt-response"><form id="step-form" novalidate><div id="error" role="alert" tabindex="-1"></div>${stepBody(step)}<div class="actions"><button class="button" type="submit">${step.phase === "post" ? "응답 확정 · 완료" : "응답 확정 · 다음"}</button></div><p class="small">확정한 응답은 수정할 수 없습니다.</p></form></section></div>`}<div id="error-global" role="status"></div></main>`;
  const form = document.getElementById("step-form");
  if (form) {
    if (run.draft.key === String(step.index)) {
      for (const [key, value] of Object.entries(run.draft.values)) {
        const field = form.elements.namedItem(key);
        if (!field) continue;
        if (field instanceof window.RadioNodeList) {
          for (const e of form.querySelectorAll(`[name="${key}"]`))
            e.checked = e.value === String(value);
        } else if (field.type === "checkbox") field.checked = value === true;
        else field.value = String(value);
      }
    }
    const work = form.elements.namedItem("work");
    if (
      step.phase === "item" &&
      taskFor(step.taskId).items.find((i) => i.id === step.itemId).type ===
        "apply" &&
      work
    )
      work.required = false;
    unknownState(form);
    form.onsubmit = submit;
    form.oninput = () => {
      unknownState(form);
      clearTimeout(draftTimer);
      if (!composing) draftTimer = setTimeout(() => saveDraft(), 500);
    };
    form.addEventListener("change", () => {
      unknownState(form);
      void saveDraft();
    });
    form.addEventListener("compositionstart", () => {
      composing = true;
      clearTimeout(draftTimer);
    });
    form.addEventListener("compositionend", () => {
      composing = false;
      void saveDraft();
    });
    form.addEventListener("focusout", () => {
      void saveDraft();
    });
  }
  document.getElementById("start-form")?.addEventListener("submit", start);
  app
    .querySelectorAll("[data-action]")
    .forEach((b) => (b.onclick = () => action(b.dataset.action)));
  if (busy) app.querySelectorAll("button").forEach((b) => (b.disabled = true));
  status();
  if (run && recorder) {
    recorder.context(run);
    recorder.observe(app);
  }
  document.getElementById("main")?.focus({ preventScroll: true });
}
function unknownState(form) {
  const u = form.elements.namedItem("unknown");
  if (!u) return;
  for (const name of ["answer", "work"]) {
    const e = form.elements.namedItem(name);
    if (e) {
      e.disabled = u.checked;
      if (u.checked) e.required = false;
      else if (name === "answer" && e.type !== "hidden") e.required = true;
      else if (name === "work")
        e.required =
          taskFor(stepInfo(run).taskId).items.find(
            (i) => i.id === stepInfo(run).itemId,
          ).type === "explain";
    }
  }
}
function validateForm(form) {
  const invalid = [...form.elements].filter(
    (e) => e.willValidate && !e.validity.valid,
  );
  form.querySelectorAll(".field-error").forEach((e) => e.remove());
  form.querySelectorAll("[aria-invalid]").forEach((e) => {
    e.removeAttribute("aria-invalid");
    e.removeAttribute("aria-describedby");
  });
  if (!invalid.length) return true;
  for (const [i, e] of invalid.entries()) {
    const m = document.createElement("span");
    m.className = "field-error";
    m.id = `field-error-${i}`;
    m.textContent = "이 항목의 응답 또는 입력 범위를 확인해 주세요.";
    e.setAttribute("aria-invalid", "true");
    e.setAttribute("aria-describedby", m.id);
    (e.closest("label") ?? e.parentElement).append(m);
  }
  error("아직 제출하지 않았습니다. 표시된 필수 항목을 확인해 주세요.");
  return false;
}
async function start(event) {
  event.preventDefault();
  if (busy || !validateForm(event.currentTarget)) return;
  busy = true;
  try {
    if (entryError) throw Error(entryError);
    if (saved)
      throw Error(
        "보관된 기록을 먼저 열어 주세요. 완료 기록에서 ‘새 참여 준비’를 선택하면 다음 참가자를 받을 수 있습니다.",
      );
    let entry = invitation,
      cohort = invitation?.cohort ?? "pilot";
    if (batch) {
      if (!cloudOn)
        throw Error(
          "중앙 배정은 서버 연결이 가능한 연구 주소에서 시작해 주세요.",
        );
      const connection = await connect();
      const allocated = await allocate(connection, batch);
      entry = allocated;
      cohort = allocated.cohort;
    }
    const candidate = createRun({
      participantCode: "TEAM-" + crypto.randomUUID().slice(0, 8),
      condition: shuffle(["control", "assisted"])[0],
      invitation: entry,
    });
    if (entry) candidate.mode = cohort;
    await openRun(candidate, { cloudConsent: true });
  } catch (e) {
    if (owned && !run) {
      releaseLock?.();
      releaseLock = null;
    }
    error(e.message);
  } finally {
    busy = false;
    await render();
  }
}
async function submit(event) {
  event.preventDefault();
  if (busy || !owned || !validateForm(event.currentTarget)) return;
  busy = true;
  clearTimeout(draftTimer);
  const form = event.currentTarget,
    step = stepInfo(run),
    v = formValues(form);
  try {
    if (step.phase === "pre") {
      v.age = Number(v.age);
      v.consent = true;
      v.noExternal = true;
    }
    if (step.phase === "estimate")
      for (const k of ["confidence", "predApply", "predExplain"])
        if (k in v) v[k] = Number(v[k]);
    if (step.phase === "burden") v.burden = Number(v.burden);
    if (step.phase === "item") {
      v.unknown = Boolean(v.unknown);
      v.answer = v.unknown ? "" : String(v.answer ?? "").trim();
      v.work = v.unknown ? "" : String(v.work ?? "").trim();
    }
    const next = submitStep(run, v);
    await save(next);
    run = next;
    resetCalculator();
    saved = run;
    recorder.record("step_submitted", {
      phase: step.phase,
      itemId: step.itemId,
    });
    recorder.context(run);
    cloud?.update(run);
    await render();
    if (run.status === "completed") await finalSync();
  } catch (e) {
    error(e.message);
  } finally {
    busy = false;
    app.querySelectorAll("button").forEach((b) => (b.disabled = false));
    status();
  }
}
async function finalSync() {
  if (!cloud) return;
  try {
    await recorder.flush();
    cloud.update(run);
    await cloud.sync({ final: true });
    const e = document.getElementById("cloud-complete");
    if (e) e.textContent = "최종 응답 서버 수신 확인";
  } catch {
    error(
      "서버 전송을 확인하지 못했습니다. 다시 시도하거나 파일을 보관해 주세요.",
    );
  }
}
function download(data, name) {
  const url = URL.createObjectURL(
      new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}
async function exportRun(candidate) {
  await saveDraft();
  recorder?.checkpoint("export");
  try {
    await recorder?.flush();
  } catch {}
  let stored = [], readError = null;
  try { stored = await store.eventsForRun(candidate.id); }
  catch (e) { readError = e.message; }
  const events = [
      ...new Map(
        [...stored, ...(recorder?.pendingEvents() ?? [])].filter((e) => e.runId === candidate.id).map((e) => [e.id, e]),
      ).values(),
    ];
  const envelope = makeEnvelope(candidate.id === run?.id ? run : candidate, events);
  if (readError) {
    download({
      format: "hci-crt-recovery",
      exportedAt: new Date().toISOString(),
      incomplete: true,
      warning: "저장된 행동 기록을 읽지 못했습니다. 현재 응답과 메모리의 대기 기록만 보관합니다. 정상 분석 파일로 가져오지 마세요.",
      storageError: readError,
      available: envelope,
    }, `hci-crt-recovery-${candidate.participantCode}`);
    error("불완전 복구 파일을 보관했습니다. 저장된 행동 기록은 확인하지 못했으므로 연구 담당자에게 알려 주세요.");
  } else download(envelope, `hci-crt-${candidate.participantCode}`);
}
async function action(name) {
  if (busy && name !== "download") return;
  try {
    if (name === "calculate") {
      calcValue = document.getElementById("calculator-input").value;
      try {
        calcResult = String(calculate(calcValue));
      } catch (e) {
        calcResult = e.message;
      }
      document.getElementById("calculator-result").textContent = calcResult;
      return;
    }
    if (name === "download") return await exportRun(run);
    if (name === "download-saved") return await exportRun(saved);
    if (name === "resume") {
      if (batch && saved.allocation?.batchId !== batch)
        throw Error("이 링크와 보관 기록의 배정표가 다릅니다.");
      if (invitation && saved.invitationId !== invitation.id)
        throw Error("이 링크와 보관 기록의 초대가 다릅니다.");
      await openRun(saved, {
        cloudConsent: Boolean(
          document.getElementById("resume-cloud-consent")?.checked,
        ),
      });
    }
    if (name === "pause") {
      await saveDraft();
      await recorder?.stop();
      cloud?.stop();
      saved = run;
      run = null;
      releaseLock?.();
      releaseLock = null;
      await render();
    }
    if (name === "sync") await finalSync();
    if (name === "new") {
      if (cloudOn && cloudState !== "complete")
        throw Error(
          "다음 참가자를 받기 전에 최종 응답의 서버 수신을 확인해 주세요. 전송이 어려우면 현재 기록을 파일로 보관하고 담당자에게 알려 주세요.",
        );
      if (cloudOn && run?.allocation?.source === "central") {
        const connection = await connect();
        await connection.sdk.signOut(connection.auth);
        await connection.sdk.signInAnonymously(connection.auth);
      }
      await recorder?.stop();
      cloud?.stop();
      releaseLock?.();
      releaseLock = null;
      run = null;
      saved = null;
      recorder = null;
      cloud = null;
      cloudState = "idle";
      persistenceError = "";
      owned = false;
      resetCalculator();
      if (invitation) {
        invitation = null;
        history.replaceState(null, "", location.pathname + location.search);
        entryError = "이 초대는 사용을 마쳤습니다. 다음 참가자의 새 참여 링크를 열어 주세요.";
      }
      localStorage.removeItem(ACTIVE);
      await render();
    }
  } catch (e) {
    error(e.message);
  }
}
window.addEventListener("pagehide", () => {
  void saveDraft();
  void recorder?.stop();
  cloud?.stop();
  releaseLock?.();
});
window.addEventListener("beforeunload", (e) => {
  if (busy || persistenceError) {
    e.preventDefault();
    e.returnValue = "";
  }
});
try {
  store = await new BrowserStore({
    dbName: "hci-crt-v4",
    validate: validateRun,
    envelope: makeEnvelope,
  }).init();
  const active = localStorage.getItem(ACTIVE);
  if (active) saved = await store.getRun(active);
  if (store.mode === "memory") persistenceError = store.initError;
  await render();
} catch (e) {
  app.textContent =
    "실험을 열지 못했습니다. 기존 기록은 보존됩니다. " + e.message;
}
