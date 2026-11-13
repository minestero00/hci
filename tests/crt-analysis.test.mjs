import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toCSV } from "../web/crt/core.mjs";
const available =
  spawnSync("Rscript", ["--version"], { encoding: "utf8" }).status === 0;
test(
  "R analysis enforces sample-size reporting and estimates assisted-control contrast on synthetic data",
  { skip: !available },
  () => {
    const root = mkdtempSync(join(tmpdir(), "hci-crt-r-"));
    try {
      for (const n of [10, 12, 30]) {
        const participants = Array.from({ length: n }, (_, i) => {
          const group = i % 2,
            actual = 2 + (i % 5) / 2,
            baseline = (i % 7) - 3,
            d = 0.6 * group + 0.25 * baseline + Math.sin(i);
          return {
            study_version: "4.0.0",
            run_id: "s" + i,
            mode: "study",
            primary_ready: 1,
            status: "completed",
            ai_frequency: i % 3 ? "weekly" : "daily",
            exclusion_reasons: "",
            condition: group ? "assisted" : "control",
            mean_d_apply: d,
            mean_d_explain: d / 2,
            mean_pred_apply: actual + d,
            mean_actual_apply: actual,
            mean_pred_explain: 2 + d / 2,
            mean_actual_explain: 2,
            mean_absolute_error_apply: Math.abs(d),
            mean_confidence: 30 + i,
            mean_burden: (i % 7) + 1,
            d_baseline: baseline,
            se_baseline: 50 + i,
            first_d_apply: d + 0.1,
            latin_order: ["a", "b", "c"][i % 3],
            exposure: i % 8 ? "no" : "yes",
            delivery: i % 4 ? "in_person" : "remote",
          };
        });
        const cases = participants.flatMap((p, j) =>
          ["difference", "rate", "trade"].map((task_id, i) => ({
            run_id: p.run_id,
            task_id,
            condition: p.condition,
            position: i + 1,
            apply_a: 1,
            apply_b: j % 3,
            apply_c: 2,
            initial_correct: j % 2,
            trap_selected: 1 - (j % 2),
            burden_7: p.mean_burden,
            d_apply: p.mean_d_apply + Math.sin(i + j) / 10,
            no_trap_numeric_correct: i === 0 ? null : i === 1 ? 0 : 1,
            retention_numeric_correct: 1,
            retention_work_present: i === 0 ? 0 : 1,
          })),
        );
        const p = join(root, "p.csv"),
          c = join(root, "c.csv"),
          out = join(root, "out" + n);
        writeFileSync(p, toCSV([...participants, {
          ...participants[0], run_id: "withdrawn", status: "in_progress", primary_ready: 0,
          exclusion_reasons: "incomplete;ungraded",
        }]));
        writeFileSync(c, toCSV(cases));
        const result = spawnSync(
          "Rscript",
          ["analysis/crt-analysis.R", p, c, out],
          { encoding: "utf8", timeout: 60000 },
        );
        assert.equal(result.status, 0, result.stderr);
        const files = readdirSync(out);
        for (const name of ["participant-flow.csv", "exclusion-reasons.csv", "allocation-balance.csv", "advisory-numeric-outcomes.csv", "signed-error-distribution.pdf"]) assert.ok(files.includes(name), name);
        assert.match(readFileSync(join(out, "advisory-numeric-outcomes.csv"), "utf8"), /no_trap_unresolved/);
        assert.match(readFileSync(join(out, "participant-flow.csv"), "utf8"), /in_progress/);
        assert.match(readFileSync(join(out, "exclusion-reasons.csv"), "utf8"), /incomplete/);
        if (n < 12) {
          assert.ok(!files.includes("HC3-models.csv"));
          continue;
        }
        const hc = readFileSync(join(out, "HC3-models.csv"), "utf8");
        assert.match(hc, /primary_HC3/);
        assert.match(hc, /first_bundle_HC3/);
        assert.ok(files.includes("welch.csv"));
        const welch = readFileSync(join(out, "welch.csv"), "utf8")
          .trim()
          .split("\n")[1]
          .split(",");
        const ai = participants.filter((p) => p.condition === "assisted"),
          control = participants.filter((p) => p.condition === "control"),
          avg = (a) => a.reduce((s, p) => s + p.mean_d_apply, 0) / a.length;
        assert.ok(
          Math.abs(Number(welch[1]) - (avg(ai) - avg(control))) < 1e-10,
        );
        if (n < 24) {
          for (const line of hc.trim().split("\n").slice(1)) {
            const cols = line.split(",");
            assert.equal(cols[6], "NA");
          }
          assert.equal(welch.at(-1), "NA");
        } else assert.notEqual(welch.at(-1), "NA");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
