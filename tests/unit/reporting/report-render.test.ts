// T3.2 report templates: golden Markdown per category, sanitization, CLI null model/effort,
// missing model recorded as unknown. `UPDATE_GOLDEN=1 npm test` rewrites the fixtures.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import {
  formatUsage,
  renderStepReport,
  sumUsage,
} from "../../../runtime/reporting/application/render.ts";
import { parseContract, ReportCategory, StepComment } from "../../../runtime/shared/contracts.ts";

const FIXTURES = new URL("../../fixtures/reports/", import.meta.url);

const base = {
  schemaVersion: 1,
  issue: { repository: "omi-home/omi-plugins", number: 102 },
  workflowRunId: "run-1",
  workflow: "Feature Implementation",
  stepId: "step-1",
  stepTitle: "Step",
  round: 2,
  attempt: 1,
  executor: "software-engineer",
  requestedModel: "opus",
  actualModel: "claude-opus-5-5",
  requestedEffort: "medium",
  actualEffort: "unknown",
  usage: { inputTokens: 1200, outputTokens: 340, cacheReadTokens: 800 },
  durationMs: 42_300,
  commitSha: "abcdef1234567890",
  status: "FAILED",
  summary: "Two findings remain.",
  changedFiles: ["src/a.ts"],
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
      usage: undefined,
      durationMs: undefined,
    }),
  );
  assert.match(cli, /\| Model \| n\/a \(omi-cli\) \|/);
  assert.match(cli, /\| Cost \| no tokens \(omi-cli\) · wall time not_available \|/);
  assert.match(cli, /\| Effort \| n\/a \(omi-cli\) \|/);
  const unknown = renderStepReport(
    comment({ category: "review", actualModel: "unknown", usage: undefined }),
  );
  assert.match(unknown, /\| Cost \| tokens not_available · 42\.3 s wall \|/); // never invented
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

test("usage (#203): summed per run; cache hit and list-price cost shown only when known", () => {
  const total = sumUsage([
    { inputTokens: 10, outputTokens: 5, cacheReadTokens: 30, costUsd: 0.01, numTurns: 2 },
    { inputTokens: 20, outputTokens: 5, cacheCreationTokens: 40, costUsd: 0.02 },
  ]);
  assert.deepEqual(total, {
    inputTokens: 30,
    outputTokens: 10,
    cacheReadTokens: 30,
    cacheCreationTokens: 40,
    thinkingTokens: undefined,
    costUsd: 0.03,
    numTurns: 2,
  });
  assert.equal(
    formatUsage(total as NonNullable<typeof total>),
    "30 in / 10 out tokens · 30 cache read (30% hit) · 2 turns · ≈ $0.0300 (list-price estimate)",
  );
  assert.equal(formatUsage({ inputTokens: 1, outputTokens: 2 }), "1 in / 2 out tokens");
  assert.equal(sumUsage([]), undefined);
});

test("skills row: the installed skills; the reason shows there when no profile carries it (#199)", () => {
  const out = renderStepReport(
    comment({
      category: "implementation",
      skills: ["backend-implementation", "minimal-change"],
      selectionReason: "small diff",
    }),
  );
  assert.match(out, /\| Skills \| backend-implementation, minimal-change \(small diff\) \|/);
  const withProfile = renderStepReport(
    comment({
      category: "review",
      skills: ["minimal-change"],
      profile: "sub-a",
      selectionReason: "spread",
    }),
  );
  assert.match(withProfile, /\| Skills \| minimal-change \|/);
});
