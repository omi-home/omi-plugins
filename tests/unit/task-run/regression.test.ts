// DevTask-0140 #404: pure rules of the regression proof, its config block and its report section.
import assert from "node:assert/strict";
import { test } from "node:test";
import { renderStepReport } from "../../../runtime/reporting/application/render.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import {
  fillCommand,
  hasTcCode,
  type ProofReport,
  preFixMarker,
  proofFindings,
  renderProof,
  tcFiles,
} from "../../../runtime/task-run/domain/regression.ts";

const BASE = { github: { owner: "o", repo: "r", projectNumber: 1 } };

test("config: regression block is optional, parsed, and rejects unknown fields", () => {
  assert.equal(parseConfig(BASE).regression, undefined);
  const c = parseConfig({
    ...BASE,
    regression: { command: "node --test --test-reporter=tap {files}", share: ["node_modules"] },
  });
  assert.deepEqual(c.regression?.share, ["node_modules"]);
  assert.equal(c.regression?.timeoutSeconds, undefined);
  assert.equal(parseConfig({ ...BASE, regression: {} }).regression?.command, undefined);
  assert.throws(() => parseConfig({ ...BASE, regression: { cmd: "x" } }));
  assert.throws(() => parseConfig({ ...BASE, regression: { command: "node --test" } }));
  assert.throws(() => parseConfig({ ...BASE, regression: { share: ["../x"] } }));
  assert.throws(() => parseConfig({ ...BASE, regression: { timeoutSeconds: 0 } }));
});

test("TC code: TC-<bug>-<n> only for that bug", () => {
  assert.ok(hasTcCode('test("TC-42-03: x")', 42));
  assert.ok(!hasTcCode('test("TC-142-03: x")', 42));
  assert.ok(!hasTcCode('test("TC-42-x")', 42));
  assert.ok(!hasTcCode("TC-420-1", 42));
  const content: Record<string, string> = { "a.test.ts": "TC-7-01", "b.test.ts": "nothing" };
  assert.deepEqual(
    tcFiles(["a.test.ts", "b.test.ts"], (f) => content[f] ?? "", 7),
    ["a.test.ts"],
  );
});

test("pre-fix marker: sha in the Issue body", () => {
  assert.equal(preFixMarker("x\n<!-- omi:pre-fix-commit=ABCDEF1234 -->"), "abcdef1234");
  assert.equal(preFixMarker("<!-- omi:pre-fix-commit=zz -->"), undefined);
  assert.equal(preFixMarker("no marker"), undefined);
});

test("command: each file quoted on its own", () => {
  assert.equal(
    fillCommand("node --test {files}", ["a b.test.ts", "tests\\c.test.ts"]),
    'node --test "a b.test.ts" "tests/c.test.ts"',
  );
});

const run = (commit: string, outcome: string, exit: number | null, tail = "") => ({
  commit,
  outcome,
  exit,
  tail,
  logPath: null,
});
const proof = (before: ReturnType<typeof run>, after: ReturnType<typeof run>): ProofReport => ({
  preFix: "a".repeat(40),
  source: "merge-base HEAD origin/develop",
  command: 'node --test "t.test.ts"',
  files: ["t.test.ts"],
  before,
  after,
});

test("proof findings: fail before and pass after is clean; anything else is REG-002", () => {
  const good = proof(run("a".repeat(40), "fail", 1), run("b".repeat(40), "pass", 0));
  assert.deepEqual(proofFindings(good), []);
  const same = proofFindings(
    proof(run("a".repeat(40), "pass", 0, "ok"), run("b".repeat(40), "pass", 0)),
  );
  assert.equal(same[0]?.id, "REG-002");
  assert.match(same[0]?.observed ?? "", /does not reproduce the bug/);
  const broken = proofFindings(
    proof(run("a".repeat(40), "fail", 1), run("b".repeat(40), "fail", 1, "boom")),
  );
  assert.match(broken[0]?.observed ?? "", /does not pass after the fix[\s\S]*boom/);
});

test("report: the checks comment renders a Regression proof section", () => {
  const md = renderProof(
    proof(run("a".repeat(40), "fail", 1, "not ok 1"), run("b".repeat(40), "pass", 0)),
  );
  assert.match(md, /\| before fix `aaaaaaaa` \| 1 \| fail \(expected\) \|/);
  assert.match(md, /merge-base HEAD origin\/develop/);
  const out = renderStepReport({
    schemaVersion: 1,
    issue: { repository: "o/r", number: 9 },
    workflowRunId: "run",
    category: "checks",
    workflow: "Bug Resolution",
    stepId: "checks",
    stepTitle: "Deterministic Checks",
    round: 1,
    attempt: 1,
    executor: "omi-cli",
    requestedModel: null,
    actualModel: null,
    requestedEffort: null,
    actualEffort: null,
    status: "PASSED",
    summary: "ok",
    changedFiles: [],
    evidencePaths: [],
    findings: [],
    regressionProof: md,
    nextAction: "Code review.",
    executionId: "run.checks.r1.1",
    createdAt: "2026-11-23T00:00:00.000Z",
  });
  assert.match(out, /### Regression proof/);
  assert.match(out, /not ok 1/);
});

test("CR-003: the rendered proof always fits the StepComment limit, however many files", () => {
  const files = Array.from(
    { length: 400 },
    (_, i) => `tests/deep/dir/${"x".repeat(60)}-${i}.test.ts`,
  );
  const big = "y".repeat(5000);
  const md = renderProof({
    ...proof(run("a".repeat(40), "fail", 1, big), run("b".repeat(40), "fail", 1, big)),
    command: `node --test ${"z".repeat(3000)}`,
    files,
  });
  assert.ok(md.length <= 8000, `length ${md.length}`);
  assert.match(md, /and \d+ more/);
});
