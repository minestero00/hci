import test from "node:test";
import assert from "node:assert/strict";
import { domEnvironment, until } from "./helpers/dom-env.mjs";
import { createRun, validateRun, makeEnvelope } from "../web/crt/core.mjs";
import { BrowserStore } from "../web/storage.mjs";
test("CRT local-only saved run requires explicit additional consent before cloud resume", async (t) => {
  const env = await domEnvironment(
    new URL("../web/index.html", import.meta.url),
    "http://127.0.0.1:4173/hci/?cloud=1",
  );
  t.after(() => env.cleanup());
  const run = createRun(),
    store = await new BrowserStore({
      dbName: "hci-crt-v4",
      validate: validateRun,
      envelope: makeEnvelope,
    }).init();
  await store.saveRun(run);
  env.window.localStorage.setItem("hci-crt-v4-active", run.id);
  await store.close();
  await import("../web/crt/app.mjs?consent-check");
  await until(() => env.document.getElementById("resume-cloud-consent"));
  assert.equal(
    env.document.getElementById("resume-cloud-consent").checked,
    false,
  );
  env.document.querySelector('[data-action="resume"]').click();
  await until(() =>
    env.document.getElementById("save-state").textContent.includes("추가 동의"),
  );
  assert.equal(env.document.getElementById("step-form"), null);
  assert.equal(
    env.window.localStorage.getItem(
      "hci.cloud.consent.hci-judgment-20261107." + run.id,
    ),
    null,
  );
});
