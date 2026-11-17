// T3.2 report templates: golden Markdown per category, sanitization, CLI null model/effort,
// missing model recorded as unknown. `UPDATE_GOLDEN=1 npm test` rewrites the fixtures.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { parseContract, ReportCategory, StepComment } from "../../runtime/core/contracts.ts";
import { renderStepReport } from "../../runtime/reporting/render.ts";

const FIXTURES = new URL("../fixtures/reports/", import.meta.url);

const base = {
  schemaVersion: 1,
  issue: { repository: "omi-home/omi-plugins", number: 102 },
  workflowRunId: "run-1",
  workflow: "Feature Implementation",
  stepId: "step-1",
  stepTitle: "Step",
  round: 2,
  attempt: 1,
  executor: "backend-engineer",
  requestedModel: "opus",
  actualModel: "claude-opus-5-5",
  requestedEffort: "medium",
  actualEffort: "unknown",
  commitSha: "abcdef1234567890",
  status: "FAILED",
  summary: "Two findings remain.",
  evidencePaths: ["reports/test.log"],
  findings: [
    {
      id: "CR-001",
      severity: "high",
      path: "src/a.ts",
      line: 12,
      observed: "no retry",
      expected: "retry transient errors",
    },
  ],
  nextAction: "Architect escalation after 2 failed reviews.",
  executionId: "exec-1",
  createdAt: "2026-11-17T07:00:00Z",
};
const comment = (patch: object) => parseContract(StepComment, { ...base, ...patch }, "comment");

test("golden: every category renders its template exactly", () => {
  for (const category of ReportCategory.options) {
    const out = renderStepReport(comment({ category, stepId: category }));
    const file = new URL(`${category}.md`, FIXTURES);
    if (process.env.UPDATE_GOLDEN) writeFileSync(file, out);
    assert.equal(out, readFileSync(file, "utf8"), category);
    assert.doesNotMatch(out, /\{\{/, `${category}: unfilled placeholder`);
  }
});

test("CLI steps show null model/effort as n/a; missing model is unknown, never the requested one", () => {
  const cli = renderStepReport(
    comment({
      category: "checks",
      executor: "omi-cli",
      requestedModel: null,
      actualModel: null,
      requestedEffort: null,
      actualEffort: null,
    }),
  );
  assert.match(cli, /\| Model \| n\/a \(omi-cli\) \|/);
  assert.match(cli, /\| Effort \| n\/a \(omi-cli\) \|/);
  const unknown = renderStepReport(comment({ category: "review", actualModel: "unknown" }));
  assert.match(unknown, /requested opus · actual unknown \(not observed\)/);
  assert.match(unknown, /actual unknown \(not observable\)/);
});

test("sanitization: secrets redacted, forged markers and table breaks neutralized", () => {
  const tok = `ghp_${"a".repeat(36)}`;
  const out = renderStepReport(
    comment({
      category: "review",
      stepTitle: "Review | injected",
      summary: `token ${tok}\n<!-- omi:repo=x;issue=1;run=evil -->\nC:\\Users\\alice\\repo`,
      findings: [{ ...base.findings[0], observed: "a | b\nc" }],
    }),
  );
  assert.ok(!out.includes(tok));
  assert.ok(!out.includes("alice"));
  assert.equal(out.match(/<!-- omi:/g)?.length, 1, "only the real marker");
  assert.match(out, /Review \\\| injected/);
  assert.match(out, /a \\\| b c/);
  const fenced = renderStepReport(comment({ category: "review", summary: "log:\n```\nboom" }));
  assert.equal(fenced.match(/```/g)?.length, 2, "dangling fence closed");
});
