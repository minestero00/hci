import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  initializeTestEnvironment,
  assertFails,
  assertSucceeds,
} from "@firebase/rules-unit-testing";
import {
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  runTransaction,
  writeBatch,
} from "firebase/firestore";
import { allocate, publishBatch } from "../web/crt/cloud.mjs";
import { STUDY } from "../web/crt/content.mjs";
const sdk = {
  doc,
  setDoc,
  getDoc,
  getDocs,
  collection,
  runTransaction,
  writeBatch,
};
test("central allocation Firestore policy: concurrency, atomicity, immutable claims, concealment and exhaustion", async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST)
    throw Error("Run with the Firestore emulator, never the live project.");
  const env = await initializeTestEnvironment({
    projectId: "demo-hci-crt",
    firestore: {
      rules: await readFile(
        new URL("../firestore.rules", import.meta.url),
        "utf8",
      ),
    },
  });
  try {
    const researcher = {
        uid: "manager",
        emailVerified: true,
        email: "superriaco@gmail.com",
      },
      manager = env
        .authenticatedContext("manager", {
          email_verified: true,
          email: researcher.email,
        })
        .firestore();
    const batch = await publishBatch(
        { sdk, db: manager, auth: { currentUser: researcher } },
        { count: 6, cohort: "pilot" },
      ),
      root = doc(manager, "crtBatches", batch.batchId);
    const users = Array.from({ length: 7 }, (_, i) => ({
      sdk,
      db: env.authenticatedContext("p" + i).firestore(),
      auth: { currentUser: { uid: "p" + i } },
    }));
    await assertFails(
      getDocs(collection(users[0].db, "crtBatches", batch.batchId, "slots")),
    );
    await assertFails(
      getDoc(doc(users[0].db, "crtBatches", batch.batchId, "slots", "4")),
    );
    await assertFails(
      setDoc(
        doc(users[0].db, "crtBatches", batch.batchId, "state", "counter"),
        { next: 2 },
      ),
    );
    const allocated = await Promise.all(
      users.slice(0, 6).map((u) => allocate(u, batch.batchId)),
    );
    const retried = await Promise.all([
      allocate(users[0], batch.batchId),
      allocate(users[0], batch.batchId),
    ]);
    assert.equal(retried[0].id, retried[1].id);
    assert.deepEqual(
      allocated.map((a) => a.sequence).sort((a, b) => a - b),
      [1, 2, 3, 4, 5, 6],
    );
    assert.equal(new Set(allocated.map((a) => a.condition + a.latin)).size, 6);
    assert.ok(
      allocated.every(
        (a) => a.studyVersion === STUDY.version && a.cohort === "pilot",
      ),
    );
    const again = await allocate(users[0], batch.batchId);
    assert.equal(again.id, allocated[0].id);
    await assert.rejects(allocate(users[6], batch.batchId), /모두 사용/);
    await assertFails(
      getDoc(doc(users[1].db, "crtBatches", batch.batchId, "claims", "p0")),
    );
    await assertFails(
      setDoc(doc(users[0].db, "crtBatches", batch.batchId, "claims", "p0"), {
        ...allocated[0],
        condition: "forged",
      }),
    );
    await assertFails(
      setDoc(
        doc(users[0].db, "crtBatches", batch.batchId, "slots", "1"),
        allocated[0],
      ),
    );
    const data = (await getDoc(root)).data();
    await setDoc(root, { ...data, open: false });
    assert.equal(
      (await allocate(users[0], batch.batchId)).id,
      again.id,
      "existing claim resumes after recruitment closes",
    );
    await assert.rejects(allocate(users[6], batch.batchId), /받고 있지/);
    await assertSucceeds(
      getDocs(collection(manager, "crtBatches", batch.batchId, "claims")),
    );
  } finally {
    await env.cleanup();
  }
});
