import { firebaseConfig } from "../cloud-config.mjs";
import { STUDY } from "./content.mjs";
import {
  makeSchedule,
  validateInvitation,
  newId,
  validateRun,
  makeEnvelope,
  validateEnvelope,
} from "./core.mjs";
import { eventHash } from "../cloud-sync.mjs";
export const RESEARCH_EMAILS = [
  "superriaco@gmail.com",
  "tigers0214@gmail.com",
  "slightsmille@gmail.com",
];
export const isResearcher = (user) =>
  Boolean(
    user?.emailVerified && RESEARCH_EMAILS.includes(user.email?.toLowerCase()),
  );
let sdk;
export async function connect(role = "participant") {
  sdk ??= await import("../firebase-sdk.mjs");
  const app = sdk.initializeApp(
      firebaseConfig,
      role === "participant" ? "hci-participant" : "hci-crt-researcher",
    ),
    auth = sdk.getAuth(app),
    db = sdk.getFirestore(app);
  await auth.authStateReady();
  if (role === "participant" && !auth.currentUser)
    await sdk.signInAnonymously(auth);
  return { sdk, auth, db };
}
/** Prepare all slots before making a batch available. One central link, no client-side condition. */
export async function publishBatch(
  connection,
  { count = 30, design = "between", cohort = "pilot" } = {},
) {
  const { sdk: s, auth, db } = connection;
  if (!isResearcher(auth.currentUser))
    throw Error("배정표 관리 계정으로 로그인하세요.");
  if (!["pilot", "study"].includes(cohort))
    throw Error("수집 종류를 확인하세요.");
  const batchId = newId(),
    slots = makeSchedule(count, design);
  const write = s.writeBatch(db);
  write.set(s.doc(db, "crtBatches", batchId), {
    studyVersion: STUDY.version,
    count,
    design,
    cohort,
    open: false,
  });
  write.set(s.doc(db, "crtBatches", batchId, "state", "counter"), { next: 1 });
  for (const slot of slots)
    write.set(
      s.doc(db, "crtBatches", batchId, "slots", String(slot.sequence)),
      {
        ...slot,
        studyVersion: STUDY.version,
        participantCode: `CRT-${batchId.slice(0, 8)}-${String(slot.sequence).padStart(3, "0")}`,
        source: "central",
        batchId,
        cohort,
      },
    );
  await write.commit();
  await s.setDoc(s.doc(db, "crtBatches", batchId), {
    studyVersion: STUDY.version,
    count,
    design,
    cohort,
    open: true,
  });
  return { batchId, count, design, cohort };
}
export async function allocate(connection, batchId) {
  if (!/^[a-f0-9-]{36}$/.test(batchId)) throw Error("배정 링크를 확인하세요.");
  const { sdk: s, auth, db } = connection,
    uid = auth.currentUser.uid;
  // A competing claim may cause rules to reject a stale optimistic transaction before
  // the SDK reports an aborted precondition. Restart the entire transaction; never bypass rules.
  for (let attempt = 0; attempt < 8; attempt++) {
    try {
      return await s.runTransaction(db, async (tx) => {
        const batchRef = s.doc(db, "crtBatches", batchId),
          claimRef = s.doc(db, "crtBatches", batchId, "claims", uid),
          counterRef = s.doc(db, "crtBatches", batchId, "state", "counter");
        const [batch, claim] = await Promise.all([
          tx.get(batchRef),
          tx.get(claimRef),
        ]);
        if (!batch.exists() || batch.data().studyVersion !== STUDY.version)
          throw Error("이 연구 배정표가 없습니다.");
        const config = batch.data();
        if (claim.exists()) {
          validateInvitation(claim.data());
          return { ...claim.data(), cohort: config.cohort };
        }
        if (!config.open) throw Error("현재 참여를 받고 있지 않습니다.");
        const counter = await tx.get(counterRef),
          n = counter.data()?.next;
        if (!Number.isInteger(n) || n > config.count)
          throw Error("준비된 참여 순번이 모두 사용되었습니다.");
        const slot = await tx.get(
          s.doc(db, "crtBatches", batchId, "slots", String(n)),
        );
        if (!slot.exists()) throw Error("배정표를 확인하지 못했습니다.");
        const invitation = slot.data();
        validateInvitation(invitation);
        tx.set(claimRef, invitation);
        tx.set(counterRef, { next: n + 1 });
        return { ...invitation, cohort: config.cohort };
      });
    } catch (error) {
      if (
        attempt === 7 ||
        !["permission-denied", "aborted"].includes(error.code)
      )
        throw error;
      await new Promise((resolve) =>
        setTimeout(resolve, 40 * (attempt + 1) + Math.random() * 120),
      );
    }
  }
}
export async function loadRecords({ sdk: s, auth, db }) {
  if (!isResearcher(auth.currentUser))
    throw Error("자료 조회 권한이 없습니다.");
  const docs = await s.getDocs(s.collection(db, "runs")),
    envelopes = [],
    notices = [];
  for (const doc of docs.docs) {
    try {
      const run = JSON.parse(doc.data().payload);
      if (run.studyVersion !== STUDY.version) continue;
      validateRun(run);
      if (run.id !== doc.id) throw Error("실행 번호 불일치");
      if (run.status !== "completed") {
        notices.push(`${run.participantCode}: 미완료`);
        envelopes.push(makeEnvelope(run));
        continue;
      }
      const receiptDoc = await s.getDocFromServer(
        s.doc(db, "runs", run.id, "receipts", "final"),
      );
      if (
        !receiptDoc.exists() ||
        receiptDoc.data().ownerUid !== doc.data().ownerUid
      )
        throw Error("최종 수신 확인 없음");
      const receipt = JSON.parse(receiptDoc.data().payload);
      if (
        !Array.isArray(receipt.chunkIds) ||
        new Set(receipt.chunkIds).size !== receipt.chunkIds.length
      )
        throw Error("수신 목록 오류");
      const events = new Map();
      for (const chunkId of receipt.chunkIds) {
        const chunk = await s.getDocFromServer(
          s.doc(db, "runs", run.id, "chunks", chunkId),
        );
        if (!chunk.exists() || chunk.data().ownerUid !== doc.data().ownerUid)
          throw Error("행동 묶음 없음");
        const rows = JSON.parse(chunk.data().payload);
        if ((await eventHash(rows.map((e) => e.id))) !== chunkId)
          throw Error("행동 묶음 해시 오류");
        for (const e of rows) {
          if (events.has(e.id)) throw Error("중복 행동 번호");
          events.set(e.id, e);
        }
      }
      const rows = [...events.values()];
      if (!(await verifyReceipt(run, rows, receipt)))
        throw Error("서버 응답과 수신 확인 불일치");
      const e = makeEnvelope(run, rows);
      validateEnvelope(e);
      envelopes.push(e);
    } catch (error) {
      notices.push(`${doc.id}: ${error.message}`);
    }
  }
  return { envelopes, notices };
}
export async function verifyReceipt(run, events, receipt) {
  return (
    run.status === "completed" &&
    receipt.runId === run.id &&
    receipt.submissionCount === run.submissions.length &&
    receipt.completedAt === run.finishedAt &&
    receipt.eventCount === events.length &&
    receipt.eventIdsHash === (await eventHash(events.map((e) => e.id)))
  );
}
