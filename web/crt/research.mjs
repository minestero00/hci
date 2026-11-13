import { STUDY, taskFor } from "./content.mjs";
import {
  validateEnvelope,
  validateInvitation,
  mergeEnvelopes,
  makeInvitations,
  newId,
} from "./core.mjs";
import { cloudEnabled } from "../cloud-sync.mjs";
import { ResearchStore } from "../research-store.mjs";
import {
  blindPacket,
  validatePacket,
  knownIds,
  applyRatings,
  analysisTables,
  tableCSV,
  agreement,
  consensusBasis,
  pilotReport,
} from "./research-tools.mjs";
import { connect, publishBatch, loadRecords, isResearcher } from "./cloud.mjs";
const $ = (id) => document.getElementById(id),
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
let repository,
  state,
  view = "collect",
  gradeIndex = 0,
  connection = null,
  busy = false,
  queue = Promise.resolve(),
  saveFailed = false;
const button = (text, action, extra = "") =>
  `<button class="r-button secondary" type="button" data-action="${action}" ${extra}>${text}</button>`;
function message(text, error = false) {
  $("research-message").textContent = text;
  $("research-message").setAttribute("role", error ? "alert" : "status");
}
function download(name, value, csv = false) {
  const url = URL.createObjectURL(
      new Blob([csv ? value : JSON.stringify(value, null, 2)], {
        type: csv ? "text/csv;charset=utf-8" : "application/json",
      }),
    ),
    a = document.createElement("a");
  a.href = url;
  a.download = name + (csv ? ".csv" : ".json");
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
  $("research-download-status").textContent = "다운로드 요청: " + a.download;
}
async function persist() {
  const snapshot = structuredClone(state);
  queue = queue.catch(() => {}).then(() => repository.save(snapshot));
  try {
    await queue;
    saveFailed = false;
    $("research-save").textContent =
      repository.mode === "memory"
        ? "현재 탭 임시 보관"
        : "CRT v4 · 이 브라우저에 저장됨";
  } catch (e) {
    saveFailed = true;
    $("research-save").textContent = "저장 실패 · 전체 보관 JSON 필요";
    throw e;
  }
}
function archive() {
  return { format: "hci-crt-archive", studyVersion: STUDY.version, ...state };
}
function table(rows, columns) {
  return `<div class="crt-table-wrap" tabindex="0" role="region" aria-label="자료 표"><table class="crt-table"><thead><tr>${columns.map(([k, label]) => `<th scope="col">${label}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${columns.map(([k]) => `<td>${esc(row[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
}
function preparation() {
  const tables = analysisTables(state.envelopes, state.ratings, true);
  const scored = tables.items.filter((i) => i.response_state !== "missing" && !(i.task_id === "practice" && i.item_type === "explain"));
  return {
    total: state.envelopes.length,
    answered: scored.length,
    completed: tables.participants.filter((p) => p.status === "completed").length,
    incomplete: tables.participants.filter((p) => p.status !== "completed").length,
    independent: scored.filter((i) => i.rater1 == null || i.rater2 == null).length,
    consensus: scored.filter((i) => i.rater1 != null && i.rater2 != null && i.consensus == null).length,
    ready: tables.participants.filter((p) => p.primary_ready === 1).length,
    otherStudy: tables.participants.filter((p) => p.mode === "study" && p.status === "completed" && p.primary_ready !== 1 && !p.exclusion_reasons.split(";").includes("ungraded")).length,
  };
}
function preparationView(p = preparation()) {
  const next = !p.total ? "먼저 서버 자료나 응답 JSON을 가져오세요."
    : p.independent ? "제출된 답변의 독립 채점 두 개를 먼저 모아 주세요."
    : p.consensus ? "두 독립 채점이 모인 답변을 확인하고 현재 채점에 대해 합의해 주세요."
    : "채점이 모인 기록의 중단·제외 사유를 확인한 뒤 분석 자료를 내보내세요.";
  return `<section class="crt-preparation" aria-labelledby="preparation-title"><div class="crt-section-title"><div><p class="research-kicker">작업 현황</p><h2 id="preparation-title">수집에서 분석 준비까지</h2></div><span class="crt-state-label">현재 브라우저의 기록 기준</span></div><dl class="crt-status-grid">${[
    ["가져온 실행", p.total, "명부와 중단 기록 포함"], ["응답 완료", p.completed, `진행 중 ${p.incomplete}개`],
    ["독립 채점 필요", p.independent, "두 채점 중 하나 이상 없는 답변"], ["합의 필요", p.consensus, "두 채점은 있고 유효 합의가 없는 답변"],
    ["본 분석 자료 준비", p.ready, "완료·채점·자료 조건을 충족한 실행"],
  ].map(([label,count,hint]) => `<div><dt>${label}</dt><dd>${count}<small>개</small></dd><p>${hint}</p></div>`).join("")}</dl><p class="crt-next-step"><strong>다음 할 일</strong> ${next}</p>${p.otherStudy ? `<p class="r-help">채점 외 자료 조건 확인이 필요한 완료 본 실험 기록 ${p.otherStudy}개가 있습니다. 진행·제외 CSV에서 사유를 확인하세요.</p>` : ""}<p class="r-help">자료 준비 수는 연구 적격 승인이나 본 실험 시작 승인이 아닙니다. 사람 파일럿과 사전 제외 기준은 별도로 확인하세요.</p></section>`;
}
function collectView() {
  const p = preparation();
  return `<p class="research-kicker">기록 모으기</p><h1>CRT v4 수집 기록</h1>${preparationView(p)}<p>업무형 v3 자료는 <a href="./legacy-v3-research.html">이전 작업실</a>에서 관리합니다. 새 자료와 자동으로 합치지 않습니다.</p><section class="crt-research-card"><label>응답·보관 JSON 가져오기<input id="files" type="file" accept=".json" multiple></label><div class="crt-research-tools">${button("전체 보관 JSON", "archive")}${button("블라인드 채점 묶음 생성", "packet", !p.answered ? "disabled" : "")}</div><p>${state.envelopes.length}개 실행 · 완료 ${state.envelopes.filter((e) => e.run.status === "completed").length}개 · 팀 체험 ${state.envelopes.filter((e) => e.run.mode === "demo").length}개</p>${!state.envelopes.length ? '<div class="crt-empty"><h2>아직 가져온 기록이 없습니다.</h2><p>온라인 수집은 Google 로그인 후 서버 자료를 가져오세요. 파일로 받은 응답은 위의 JSON 가져오기를 사용하세요.</p><p>자료를 가져온 뒤 블라인드 채점 묶음을 만들 수 있습니다.</p></div>' : ""}${table(
    state.envelopes.map((e) => ({
      code: e.run.participantCode,
      status: e.run.status === "completed" ? "완료" : "진행 중",
      mode: {study:"본 실험",pilot:"사람 파일럿",demo:"팀 체험"}[e.run.mode],
      condition: {control:"무지원",assisted:"AI 지원",within:"집단 내 대안"}[e.run.condition],
      steps: e.run.submissions.length,
      id: e.run.id,
    })),
    [
      ["code", "익명 코드"],
      ["status", "상태"],
      ["mode", "종류"],
      ["condition", "배정"],
      ["steps", "제출 수"],
      ["id", "실행 번호"],
    ],
  )}<label class="crt-detail-select">상세 기록<select id="detail-run" ${!state.envelopes.length ? "disabled" : ""}><option value="">실행 선택</option>${state.envelopes.map((e) => `<option value="${e.run.id}">${esc(e.run.participantCode)}</option>`).join("")}</select></label><div id="detail"></div></section>`;
}
function inviteView() {
  return `<h1>참여 배정</h1><p>집단 간 설계: 두 집단 × 라틴 방진 세 순서를 6개 블록으로 섞습니다. 중도 이탈자의 자리는 재사용하지 않습니다. 배정표 관리자는 참가자 진행 담당자와 분리하세요.</p><section class="crt-research-card"><div class="crt-research-tools"><label>준비 인원<input id="count" type="number" min="1" max="300" value="30"></label><label>설계<select id="design"><option value="between">집단 간 (기본)</option><option value="within">집단 내 대안: 첫 묶음 무지원</option></select></label><label>수집 종류<select id="cohort"><option value="pilot">사람 파일럿</option><option value="study">본 실험</option></select></label>${button("서버 중앙 배정표 생성", "central")}${button("로컬·오프라인 초대 생성", "manual")}</div><p>중앙 링크는 접속 후 동의한 참가자에게 순번을 자동 배정합니다. 최초 시작은 온라인이어야 합니다. 기기·브라우저마다 익명 계정을 분리하며, 진행 중에는 같은 브라우저를 유지하세요.</p><p>로컬 초대는 담당자가 순번대로 전달하는 대체 경로입니다. 서버의 접속 순서 자동 배정과 구분해 CSV에 기록합니다. 본 실험 시작 뒤 설계를 바꾸거나 두 설계의 자료를 섞지 마세요.</p><div id="invitation-result"></div><div class="crt-research-tools">${button("초대·배정 보관 JSON", "allocation-export")}</div></section>`;
}
function gradeView() {
  const packet = state.packet,
    items = packet?.items ?? [],
    item = items[gradeIndex],
    role = state.role ?? "rater1";
  return `<h1>독립 블라인드 채점</h1><section class="crt-research-card"><label>채점 묶음·결과 JSON<input id="files" type="file" accept=".json" multiple></label><div class="crt-research-tools"><label>역할<select id="role">${["rater1", "rater2", "consensus"].map((r) => `<option value="${r}" ${role === r ? "selected" : ""}>${{ rater1: "채점자 1", rater2: "채점자 2", consensus: "인간 합의" }[r]}</option>`).join("")}</select></label>${button("수집 기록에서 묶음 생성", "packet")}${button("내 채점 결과 다운로드", "ratings-export")}${button("관리 메뉴 숨기기·보이기", "blind")}</div><p>채점자 1과 2는 각각 별도 브라우저에서 같은 묶음을 채점하고 결과를 전달합니다. 조건·예상·확신도·시간은 묶음에 포함되지 않습니다.</p></section>${!item ? "<p>먼저 채점 묶음을 가져오세요.</p>" : gradeItem(item, items, role)}`;
}
function gradeItem(item, items, role) {
  const grades = state.ratings[item.responseId] ?? {},
    value = grades[role],
    both = grades.rater1 && grades.rater2;
  return `<section class="crt-research-card"><p>답변 ${gradeIndex + 1} / ${items.length} · ${items.filter((i) => state.ratings[i.responseId]?.[role]).length}개 채점됨</p><h2 id="grade-answer-title" tabindex="-1">원래 문제</h2><p>${esc(item.problem)}</p><h2>평가 문항</h2><p>${esc(item.prompt)}</p><h2>참가자 응답</h2><p>답: ${esc(item.unknown ? "모르겠음" : item.answer)}</p><p style="white-space:pre-wrap">풀이·설명: ${esc(item.work)}</p><p>숫자 확인: ${esc(item.numericCheck)} (채점 확정이 아닌 보조 표시)</p><h2>채점 기준</h2><p>정답·핵심 관계: ${esc(item.key.reason)}</p>${Object.entries(
    item.rubric,
  )
    .map(([s, r]) => `<p>${s}점: ${esc(r)}</p>`)
    .join(
      "",
    )}${role === "consensus" ? `<p>${both ? `채점자 1: ${grades.rater1.score}점 (${esc(grades.rater1.reason)}) / 채점자 2: ${grades.rater2.score}점 (${esc(grades.rater2.reason)})` : "두 채점자의 독립 점수를 먼저 가져오세요."}</p>` : ""}<form id="grade-form"><label>점수<select name="score" required ${role === "consensus" && !both ? "disabled" : ""}><option value="">선택</option>${[0, 1, 2].map((s) => `<option value="${s}" ${value?.score === s ? "selected" : ""}>${s}점</option>`).join("")}</select></label><label>채점 근거·합의 사유<textarea name="reason" maxlength="2000" required>${esc(value?.reason ?? "")}</textarea></label><div class="crt-research-tools"><button class="r-button" ${role === "consensus" && !both ? "disabled" : ""}>점수 저장 · 다음</button>${button("이전 답변", "prev")}${button("다음 답변", "next")}${button("미채점 답변으로", "unrated")}</div></form></section>`;
}
function exportView() {
  const a = agreement(state.ratings), empty = !state.envelopes.length;
  const exportGroup = (title, description, entries) => `<section class="crt-export-group"><h2>${title}</h2><p>${description}</p><div class="crt-research-tools">${entries.map(([label,action]) => button(label,action,empty ? "disabled" : "")).join("")}</div></section>`;
  return `<p class="research-kicker">분석과 보관</p><h1>분석 자료</h1>${preparationView()}${empty ? '<p class="crt-empty">내보낼 응답이 없습니다. 먼저 ‘기록 모으기’에서 서버 자료나 응답 JSON을 가져오세요.</p>' : ""}<section class="crt-research-card"><h2>내보내기 범위</h2><label class="crt-demo-option"><input type="checkbox" id="include-demo"> 팀 체험 자료도 포함</label><p class="r-help">기본 내보내기는 사람 파일럿과 본 실험 기록을 포함합니다. 본 분석 대상과 중단·제외 사유는 CSV에서 확인하세요. 미채점·미제출은 빈칸으로 유지합니다.</p></section>
  <div class="crt-export-grid">${exportGroup("1. 분석용 응답", "R 분석에는 참가자 CSV와 묶음·연습 CSV를 함께 사용하세요.", [["참가자 CSV","csv-participants"],["묶음·연습 CSV","csv-cases"],["문항·채점 CSV","csv-items"]])}${exportGroup("2. 진행·제외와 행동", "중단·제외 흐름과 기록 범위를 함께 확인하세요. 시간과 노출 기록은 실제 이해를 보증하지 않습니다.", [["집단별 진행·제외 CSV","csv-flow"],["행동 원본 CSV","csv-events"],["단계별 시간 CSV","csv-stages"],["자료 노출 CSV","csv-sources"]])}</div>
  <section class="crt-research-card"><h2>3. 파일럿 점검과 전체 보관</h2><p>난이도 점검은 무지원 사람 파일럿만 사용합니다. 전체 보관 JSON에는 응답·채점·합의 이력이 포함됩니다.</p><div class="crt-research-tools">${button("무지원 파일럿 난이도 점검 CSV","pilot-report", !state.envelopes.some(e=>e.run.mode==="pilot" && e.run.condition==="control") ? "disabled" : "")}${button("전체 보관 JSON","archive")}</div></section>
  <details class="crt-research-card"><summary>지표와 해석 주의사항</summary><p>주 지표는 적용 예상(0~6)−적용 실제(0~6)의 세 묶음 평균입니다. D_기준과 SE_기준은 연습에서 계산합니다.</p><p>독립 채점 ${a.n}쌍 · 합의 전 완전 일치 ${a.exact === null ? "결측" : (a.exact * 100).toFixed(1) + "%"} · 선형 가중 카파 ${a.weightedKappa === null ? "계산 불가" : a.weightedKappa.toFixed(3)}</p><p>자료 준비 표지는 최종 연구 적격 판정이 아닙니다. 파일럿은 본 실험 분석에서 제외합니다. R 스크립트와 사전 분석 계획에 따라 제외 사유·수를 보존하세요.</p></details>`;
}

function render({ focus = null } = {}) {
  const selected = {
    collect: collectView,
    invite: inviteView,
    grade: gradeView,
    export: exportView,
  }[view];
  $("research-cloud").hidden = view !== "collect" && view !== "invite";
  $("research-view").innerHTML = selected();
  $("research-view").setAttribute("aria-labelledby", "nav-" + view);
  document.querySelectorAll("[data-view]").forEach((b) => {
    const active = b.dataset.view === view;
    b.setAttribute("aria-selected", String(active));
    b.tabIndex = active ? 0 : -1;
    b.classList.toggle("active", active);
  });
  $("files")?.addEventListener("change", (event) =>
    perform(() => importFiles([...event.target.files])),
  );
  document
    .querySelectorAll("[data-action]")
    .forEach(
      (b) => (b.onclick = () => perform(() => action(b.dataset.action))),
    );
  $("role")?.addEventListener("change", (event) =>
    perform(async () => {
      state.role = event.target.value;
      await persist();
      render({ focus: "role" });
    }),
  );
  $("grade-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    const data = Object.fromEntries(new FormData(event.currentTarget));
    void perform(() => saveGrade(Number(data.score), data.reason));
  });
  $("detail-run")?.addEventListener("change", (event) =>
    showDetail(event.target.value),
  );
  if (focus) {
    const target = focus === "role" ? $("role")
      : focus === "grade" ? $("grade-answer-title")
      : $("research-view").querySelector("h1");
    if (target) {
      if (!target.matches("input, select, button, textarea, a")) target.tabIndex = -1;
      target.focus();
    }
  }
}
function dirty() {
  const form = $("grade-form");
  if (!form) return false;
  const item = state.packet?.items[gradeIndex],
    old = state.ratings[item?.responseId]?.[state.role];
  const d = new FormData(form);
  return (
    String(d.get("score") ?? "") !== String(old?.score ?? "") ||
    String(d.get("reason") ?? "") !== (old?.reason ?? "")
  );
}
function mayLeave() {
  return (
    !dirty() ||
    confirm("저장하지 않은 채점이 있습니다. 현재 입력을 버리고 이동할까요?")
  );
}
async function perform(operation) {
  if (busy) return;
  busy = true;
  try {
    await operation();
  } catch (e) {
    message(e.message, true);
  } finally {
    busy = false;
  }
}
async function saveGrade(score, reason) {
  const item = state.packet.items[gradeIndex],
    role = state.role;
  if (![0, 1, 2].includes(score) || !reason.trim())
    throw Error("점수와 근거를 입력하세요.");
  if (item.unknown && score !== 0) throw Error("모르겠음 답변은 0점입니다.");
  const previous = state.ratings[item.responseId]?.[role];
  if (
    role === "consensus" &&
    (!state.ratings[item.responseId]?.rater1 ||
      !state.ratings[item.responseId]?.rater2)
  )
    throw Error("독립 채점 두 개가 필요합니다.");
  state.gradeHistory.push({
    id: newId(),
    responseId: item.responseId,
    role,
    previous: previous ?? null,
    next: { score, reason },
    at: new Date().toISOString(),
  });
  state.ratings[item.responseId] ??= {};
  const record = state.ratings[item.responseId];
  if (role !== "consensus" && record.consensus &&
      (previous?.score !== score || previous?.reason !== reason)) {
    state.gradeHistory.push({
      id: newId(), responseId: item.responseId, role: "consensus",
      previous: record.consensus, next: null,
      cause: "independent_rating_changed", at: new Date().toISOString(),
    });
    delete record.consensus;
  }
  record[role] = { score, reason, ...(role === "consensus" ? { basis: consensusBasis(record) } : {}) };
  await persist();
  gradeIndex = Math.min(gradeIndex + 1, state.packet.items.length - 1);
  render({ focus: "grade" });
  message("채점을 저장했습니다.");
}
async function importFiles(files) {
  if (!mayLeave()) return;
  const notices = [];
  for (const file of files) {
    try {
      if (file.size > 100 * 1024 * 1024) throw Error("파일이 너무 큽니다.");
      const data = JSON.parse(await file.text());
      if (data.format === "hci-crt-export") {
        validateEnvelope(data);
        const m = mergeEnvelopes(state.envelopes, [data]);
        state.envelopes = m.items;
        notices.push(
          `${file.name}: 추가 ${m.added}, 갱신 ${m.updated}, 중복 ${m.duplicates}, 충돌 ${m.conflicts.length}`,
        );
      } else if (data.format === "hci-crt-blind") {
        validatePacket(data);
        state.packet = data;
        gradeIndex = 0;
        view = "grade";
        notices.push("채점 묶음 가져옴");
      } else if (data.format === "hci-crt-ratings") {
        const m = applyRatings(
          state.ratings,
          data,
          knownIds(state.envelopes, state.packet),
        );
        state.ratings = m.ratings;
        notices.push(
          `채점 추가 ${m.added}, 갱신 ${m.updated}, 중복 ${m.duplicates}, 충돌 ${m.conflicts.length}`,
        );
      } else if (data.format === "hci-crt-archive") {
        if (
          data.studyVersion !== STUDY.version ||
          !Array.isArray(data.envelopes) ||
          data.envelopes.length > 1000 ||
          !data.ratings ||
          typeof data.ratings !== "object"
        )
          throw Error("CRT 보관 파일 형식이 아닙니다.");
        if (data.packet) validatePacket(data.packet);
        const merged = mergeEnvelopes(state.envelopes, data.envelopes),
          ids = knownIds(merged.items, data.packet ?? state.packet);
        let combined = structuredClone(state.ratings),
          conflicts = merged.conflicts.length;
        for (const role of ["rater1", "rater2", "consensus"]) {
          const ratings = Object.entries(data.ratings)
            .filter(([, r]) => r[role])
            .map(([responseId, r]) => ({ responseId, ...r[role] }));
          const m = applyRatings(
            combined,
            {
              format: "hci-crt-ratings",
              studyVersion: STUDY.version,
              role,
              ratings,
            },
            ids,
          );
          combined = m.ratings;
          conflicts += m.conflicts.length;
        }
        state.envelopes = merged.items;
        state.ratings = combined;
        state.packet ??= data.packet ?? null;
        // Restore metadata without creating or reusing any server allocation.
        if (Array.isArray(data.invitations)) {
          const existing = new Map(
            state.invitations.map((i) => [i.id ?? i.batchId, i]),
          );
          for (const entry of data.invitations) {
            if (entry.source === "manual") {
              const { url, ...value } = entry;
              validateInvitation(value);
            } else if (
              !/^[a-f0-9-]{36}$/.test(entry.batchId ?? "") ||
              !Number.isInteger(entry.count) ||
              !["between", "within"].includes(entry.design) ||
              !["pilot", "study"].includes(entry.cohort)
            )
              throw Error("배정 보관 정보 오류");
            const id = entry.id ?? entry.batchId;
            if (!existing.has(id)) {
              state.invitations.push(entry);
              existing.set(id, entry);
            }
          }
        }
        if (Array.isArray(data.gradeHistory)) {
          const ids = new Set(state.gradeHistory.map((h) => h.id));
          for (const h of data.gradeHistory) {
            if (typeof h.id === "string" && !ids.has(h.id)) {
              state.gradeHistory.push(h);
              ids.add(h.id);
            }
          }
        }
        notices.push(
          `보관 응답 추가 ${merged.added}, 중복 ${merged.duplicates}, 충돌 ${conflicts}`,
        );
      } else
        throw Error(
          "CRT v4 응답·채점 파일이 아닙니다. v3 자료는 이전 작업실을 사용하세요.",
        );
    } catch (e) {
      notices.push(`${file.name}: ${e.message}`);
    }
  }
  await persist();
  render({ focus: view === "grade" ? "grade" : "heading" });
  message(notices.join("\n"));
}
function showDetail(id) {
  const e = state.envelopes.find((e) => e.run.id === id);
  if (!e) {
    $("detail").innerHTML = "";
    return;
  }
  $("detail").innerHTML =
    `<h2>제출 이력</h2><pre>${esc(JSON.stringify(e.run.submissions, null, 2))}</pre><h2>행동 타임라인 (최근 200개)</h2><pre>${esc(JSON.stringify(e.events.slice(-200), null, 2))}</pre>`;
}
async function action(name) {
  if (name === "pilot-report") {
    if (!state.envelopes.some(e => e.run.mode === "pilot" && e.run.condition === "control"))
      throw Error("무지원 사람 파일럿 기록을 먼저 가져오세요.");
    return download(
      "hci-crt-pilot-gates",
      tableCSV(pilotReport(state.envelopes, state.ratings)),
      true,
    );
  }
  if (name === "archive") return download("hci-crt-archive", archive());
  if (name === "allocation-export")
    return download("hci-crt-allocation", {
      studyVersion: STUDY.version,
      invitations: state.invitations,
    });
  if (name === "packet") {
    if (!mayLeave()) return;
    const packet = blindPacket(state.envelopes);
    if (!packet.items.length) throw Error("채점할 제출 답변이 없습니다. 먼저 응답 기록을 가져오세요.");
    state.packet = packet;
    gradeIndex = 0;
    await persist();
    download("hci-crt-blind", state.packet);
    view = "grade";
    render({ focus: "grade" });
    return;
  }
  if (name === "manual" || name === "central") {
    const count = Number($("count").value),
      design = $("design").value,
      cohort = $("cohort").value;
    if (name === "manual") {
      const entries = makeInvitations(
        count,
        new URL("./index.html", location.href),
        design,
        cohort,
      );
      state.invitations.push(...entries);
      await persist();
      download("hci-crt-manual-invitations", entries);
      $("invitation-result").textContent =
        `로컬 초대 ${entries.length}개를 만들었습니다. 선택한 수집 종류로 저장됩니다. 순번대로 전달하고 중도 이탈 순번은 재사용하지 마세요.`;
    } else {
      connection ??= await connect("researcher");
      const batch = await publishBatch(connection, { count, design, cohort });
      state.invitations.push(batch);
      await persist();
      const url = new URL("./index.html", location.href);
      url.searchParams.set("batch", batch.batchId);
      $("invitation-result").innerHTML =
        `<p>참가자 진행 담당자에게는 이 링크만 전달하세요.</p><a href="${esc(url.href)}">${esc(url.href)}</a>`;
      download("hci-crt-central-batch", { ...batch, url: url.href });
    }
    return;
  }
  if (name === "ratings-export") {
    if (dirty()) throw Error("현재 채점을 저장한 뒤 내보내세요.");
    const role = state.role;
    download("hci-crt-" + role, {
      format: "hci-crt-ratings",
      studyVersion: STUDY.version,
      role,
      ratings: Object.entries(state.ratings)
        .filter(([, r]) => r[role])
        .map(([responseId, r]) => ({ responseId, ...r[role] })),
    });
    return;
  }
  if (name === "blind") {
    document.body.classList.toggle("crt-blind");
    return;
  }
  if (["prev", "next", "unrated"].includes(name)) {
    if (!mayLeave()) return;
    const items = state.packet?.items ?? [];
    gradeIndex =
      name === "unrated"
        ? Math.max(
            0,
            items.findIndex((i) => !state.ratings[i.responseId]?.[state.role]),
          )
        : Math.max(
            0,
            Math.min(items.length - 1, gradeIndex + (name === "next" ? 1 : -1)),
          );
    render({ focus: "grade" });
    return;
  }
  if (name.startsWith("csv-")) {
    const tables = analysisTables(
      state.envelopes,
      state.ratings,
      $("include-demo")?.checked,
    );
    const rows = tables[name.slice(4)];
    if (!rows?.length) throw Error("선택한 범위에 내보낼 자료가 없습니다. 팀 체험만 있다면 ‘팀 체험 자료도 포함’을 선택하세요.");
    download("hci-crt-" + name.slice(4), tableCSV(rows), true);
  }
}
async function cloudAction(kind) {
  await perform(async () => {
    if (!mayLeave()) return;
    connection ??= await connect("researcher");
    if (kind === "login")
      await connection.sdk.signInWithPopup(
        connection.auth,
        new connection.sdk.GoogleAuthProvider(),
      );
    if (kind === "logout") await connection.sdk.signOut(connection.auth);
    if (kind === "load") {
      const data = await loadRecords(connection),
        m = mergeEnvelopes(state.envelopes, data.envelopes);
      state.envelopes = m.items;
      await persist();
      render();
      message(
        `추가 ${m.added} · 갱신 ${m.updated} · 중복 ${m.duplicates} · 충돌 ${m.conflicts.length}\n${data.notices.join("\n")}`,
      );
    }
    $("cloud-status").textContent = isResearcher(connection.auth.currentUser)
      ? "CRT 연구자 로그인됨"
      : "자료 조회 권한이 있는 Google 계정으로 로그인하세요.";
    $("cloud-load").disabled = !isResearcher(connection.auth.currentUser);
    $("cloud-logout").hidden = !connection.auth.currentUser;
  });
}
window.addEventListener("beforeunload", (e) => {
  if (dirty() || saveFailed || busy) {
    e.preventDefault();
    e.returnValue = "";
  }
});
try {
  repository = await new ResearchStore({
    dbName: "hci-crt-research-v4",
  }).init();
  state = repository.state;
  state.role ??= "rater1";
  document.querySelectorAll("[data-view]").forEach((b, i, buttons) => {
    b.onclick = () => {
      if (busy || !mayLeave()) return;
      view = b.dataset.view;
      document.body.classList.remove("crt-blind");
      render();
    };
    b.onkeydown = (e) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const n =
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (i + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length;
      buttons[n].focus();
      buttons[n].click();
    };
  });
  $("cloud-login").onclick = () => cloudAction("login");
  $("cloud-load").onclick = () => cloudAction("load");
  $("cloud-logout").onclick = () => cloudAction("logout");
  $("research-save").textContent =
    repository.mode === "memory"
      ? "임시 보관 · 파일 백업 필요"
      : "CRT v4 · 이 브라우저에 저장됨";
  render();
  if (cloudEnabled()) void cloudAction("restore");
} catch (e) {
  $("research-view").textContent = "작업실을 열지 못했습니다. " + e.message;
}
