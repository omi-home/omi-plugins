// DevTask-0134 #385: QATask plan (Test design / Verify / Retest) and its contracts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { OmiConfig } from "../../../runtime/shared/config.ts";
import { planWorkflow } from "../../../runtime/task-run/domain/plan.ts";
import {
  missingAuto,
  nextRun,
  parseTestDesign,
  parseVerify,
  proposeBugs,
  renderRun,
  renderTestDesign,
  renderTestTable,
  verifyPassed,
} from "../../../runtime/task-run/domain/qa.ts";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};

test("TC-385-01: a test-task is a qa plan: Test design by label, otherwise Verify, Retest for a Bug", () => {
  const p = (labels: string[], parentType?: "bug" | "fr", qaDesignLabel?: string) =>
    planWorkflow({ type: "test-task", labels, parentType, qaDesignLabel });
  assert.deepEqual(p(["qa:test-design"]), {
    kind: "qa",
    workflow: "QA Test Design",
    mode: "test-design",
    retest: false,
  });
  assert.deepEqual(p([], "fr"), {
    kind: "qa",
    workflow: "QA Verify",
    mode: "verify",
    retest: false,
  });
  assert.deepEqual(p([], "bug"), {
    kind: "qa",
    workflow: "QA Verify",
    mode: "verify",
    retest: true,
  });
  // the label comes from the config
  assert.equal(p(["qa:test-design"], "fr", "qa:design").kind === "qa" && true, true);
  assert.equal((p(["qa:design"], "fr", "qa:design") as { mode: string }).mode, "test-design");
  assert.equal((p(["qa:test-design"], "fr", "qa:design") as { mode: string }).mode, "verify");
});

test("TC-385-02: config qa.designLabel defaults to qa:test-design", () => {
  const base = { github: { owner: "o", repo: "r", projectNumber: 1 } };
  assert.equal(OmiConfig.parse(base).qa.designLabel, "qa:test-design");
  assert.equal(OmiConfig.parse({ ...base, qa: { designLabel: "x:y" } }).qa.designLabel, "x:y");
});

const design = {
  acCoverage: "AC1, AC2",
  cases: [
    { id: "TC-42-01", ac: "AC1", steps: "do | it", expected: "ok", auto: true, regression: false },
    { id: "TC-42-02", ac: "AC2", steps: "x", expected: "y", auto: false, regression: true },
  ],
};

test("TC-385-03: Test design: ids must be TC-<parent>-<n>, unique; unknown fields refused", () => {
  assert.equal(parseTestDesign(design, 42).cases.length, 2);
  assert.equal(
    codeOf(() => parseTestDesign(design, 43)),
    "CONTRACT_INVALID",
  );
  const dup = { ...design, cases: [design.cases[0], design.cases[0]] };
  assert.equal(
    codeOf(() => parseTestDesign(dup, 42)),
    "CONTRACT_INVALID",
  );
  assert.equal(
    codeOf(() => parseTestDesign({ ...design, extra: 1 }, 42)),
    "CONTRACT_INVALID",
  );
  const lax = { ...design, cases: [{ ...design.cases[0], extra: 1 }] };
  assert.equal(
    codeOf(() => parseTestDesign(lax, 42)),
    "CONTRACT_INVALID",
  );
});

test("TC-385-04: Test design renders the §11 columns and escapes pipes", () => {
  const md = renderTestDesign(parseTestDesign(design, 42));
  assert.match(md, /\| ID \| AC \| Steps \| Expected \| Auto \(Y\/N\) \| Regression \(Y\/N\) \|/);
  assert.match(md, /\| TC-42-01 \| AC1 \| do \\\| it \| ok \| Y \| N \|/);
  assert.match(md, /\| TC-42-02 \| AC2 \| x \| y \| N \| Y \|/);
});

test("TC-385-18: renderTestTable prints the header and one row per case; renderTestDesign embeds it", () => {
  const r = parseTestDesign(design, 42);
  const table = renderTestTable(r.cases);
  const lines = table.split("\n");
  assert.equal(lines[0], "| ID | AC | Steps | Expected | Auto (Y/N) | Regression (Y/N) |");
  assert.equal(lines.length, 2 + r.cases.length);
  assert.ok(lines.includes("| TC-42-02 | AC2 | x | y | N | Y |"));
  assert.ok(renderTestDesign(r).includes(`\n\n${table}\n`));
});

test("TC-385-05: Verify result: strict, pass only without failures, defects or failed checks", () => {
  const ok = parseVerify({
    cases: [{ id: "TC-42-01", result: "pass" }],
    defects: [],
    manualRegression: [],
  });
  assert.ok(verifyPassed(ok, true));
  assert.ok(!verifyPassed(ok, false));
  const bad = parseVerify({
    cases: [{ id: "TC-42-01", result: "blocked" }],
    defects: [],
    manualRegression: [],
  });
  assert.ok(!verifyPassed(bad, true));
  assert.equal(
    codeOf(() => parseVerify({ cases: [], defects: [], manualRegression: [], x: 1 })),
    "CONTRACT_INVALID",
  );
  assert.equal(
    codeOf(() =>
      parseVerify({ cases: [{ id: "bad", result: "pass" }], defects: [], manualRegression: [] }),
    ),
    "CONTRACT_INVALID",
  );
});

test("TC-385-06: Auto cases without a test naming their id in the output are missing", () => {
  const table = parseTestDesign(design, 42).cases;
  assert.deepEqual(missingAuto(table, "ok TC-42-02: manual"), ["TC-42-01"]);
  assert.deepEqual(missingAuto(table, "ok TC-42-01: lock"), []);
});

test("TC-385-07: Run #k increments, and the same commit updates its comment", () => {
  const sha = "a".repeat(40);
  const other = "b".repeat(40);
  const v = parseVerify({
    cases: [{ id: "TC-42-01", result: "fail" }],
    defects: [
      { title: "t", repro: "r", expected: "e", actual: "a", severity: "high", tc: ["TC-42-01"] },
    ],
    manualRegression: ["login"],
  });
  assert.deepEqual(nextRun([], sha), { k: 1 });
  const first = renderRun({ k: 1, commit: sha, result: v, checksPassed: true, qaTaskNumber: 9 });
  assert.match(first, /\*\*Run #1\*\* · `aaaaaaaa` · FAILED/);
  assert.match(first, /- TC-42-01: fail/);
  assert.deepEqual(nextRun([{ id: 7, body: first }], sha), { k: 1, updateId: 7 });
  assert.deepEqual(nextRun([{ id: 7, body: first }], other), { k: 2 });
  assert.match(proposeBugs(v, 9, sha)[0] as string, /Found in:\*\* QATask #9 · TC-42-01/);
});
