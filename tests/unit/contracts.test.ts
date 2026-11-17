import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../../runtime/core/config.ts";
import {
  CleanupResult,
  commentMarker,
  parseContract,
  StepComment,
  StepResult,
} from "../../runtime/core/contracts.ts";
import { OmiError } from "../../runtime/core/errors/errors.ts";

const issue = { repository: "omi-home/omi-plugins", number: 17 };
const step = {
  schemaVersion: 1,
  workflowRunId: "run-1",
  issue,
  stepId: "implement-backend",
  round: 1,
  attempt: 1,
  role: "backend-engineer",
  status: "PASSED",
  summary: "done",
};

const fails = (fn: () => unknown, code: string, path?: string) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof OmiError);
    assert.equal(e.code, code);
    if (path) {
      const { issues } = e.details as { issues: { path: string }[] };
      assert.ok(
        issues.some((i) => i.path === path),
        JSON.stringify(issues),
      );
    }
    return true;
  });

const step_ = (patch: object) => () => parseContract(StepResult, { ...step, ...patch }, "step");

test("step result: valid input gets array defaults", () => {
  const r = parseContract(StepResult, step, "step");
  assert.deepEqual([r.changedFiles, r.findings], [[], []]);
});

test("unknown fields are rejected, not silently dropped", () => {
  fails(step_({ status_override: "PASSED" }), "CONTRACT_INVALID");
  fails(step_({ issue: { ...issue, x: 1 } }), "CONTRACT_INVALID");
});

test("unsupported or missing schemaVersion has its own code", () => {
  fails(step_({ schemaVersion: 2 }), "SCHEMA_VERSION_UNSUPPORTED");
  fails(step_({ schemaVersion: undefined }), "SCHEMA_VERSION_UNSUPPORTED");
});

test("enums: invalid status / role / fifth round rejected", () => {
  fails(step_({ status: "passed" }), "CONTRACT_INVALID", "status");
  fails(step_({ role: "coordinator" }), "CONTRACT_INVALID", "role");
  fails(step_({ round: 5 }), "CONTRACT_INVALID", "round");
});

test("agent paths: absolute and traversal rejected", () => {
  for (const p of ["/etc/passwd", "C:\\x", "..\\x", "a/../../b"]) {
    fails(step_({ changedFiles: [p] }), "CONTRACT_INVALID", "changedFiles.0");
  }
  step_({ changedFiles: ["src/a..b.ts"] })();
});

test("BLOCKED requires blockerReason; oversized summary rejected", () => {
  fails(step_({ status: "BLOCKED" }), "CONTRACT_INVALID", "blockerReason");
  fails(step_({ summary: "x".repeat(2001) }), "CONTRACT_INVALID", "summary");
});

const comment = {
  schemaVersion: 1,
  issue,
  workflowRunId: "run-1",
  workflow: "Feature Delivery",
  stepId: "code-review",
  stepTitle: "Code Review",
  round: 2,
  attempt: 1,
  executor: "code-reviewer",
  requestedModel: "opus",
  actualModel: "claude-opus-5-5",
  requestedEffort: "medium",
  actualEffort: "unknown",
  status: "FAILED",
  summary: "two findings",
  nextAction: "rework",
  executionId: "exec-1",
  createdAt: "2026-11-17T07:00:00Z",
};
const comment_ = (patch: object) => () =>
  parseContract(StepComment, { ...comment, ...patch }, "comment");

test("comment: model/effort null exactly for omi-cli; marker is stable", () => {
  assert.equal(
    commentMarker(comment_({})()),
    "<!-- omi:repo=omi-home/omi-plugins;issue=17;run=run-1;step=code-review;round=2;attempt=1 -->",
  );
  const cli = {
    executor: "omi-cli",
    requestedModel: null,
    actualModel: null,
    requestedEffort: null,
    actualEffort: null,
  };
  comment_(cli)();
  fails(comment_({ ...cli, actualModel: "sonnet" }), "CONTRACT_INVALID", "executor");
  fails(comment_({ actualModel: null, actualEffort: null }), "CONTRACT_INVALID", "executor");
  fails(comment_({ actualEffort: "medium" }), "CONTRACT_INVALID", "actualEffort");
});

const cleanup = {
  schemaVersion: 1,
  issue,
  pr: { number: 78, merged: true, baseRef: "develop", headRef: "chore/17-x", headSha: "abcdef1" },
  steps: [{ name: "remove-worktree", status: "done" }],
  state: "COMPLETED",
};
const cleanup_ = (patch: object) => () =>
  parseContract(CleanupResult, { ...cleanup, ...patch }, "cleanup");

test("cleanup: COMPLETED needs verified merge and no failed step", () => {
  cleanup_({})();
  fails(cleanup_({ pr: { ...cleanup.pr, merged: false } }), "CONTRACT_INVALID", "pr.merged");
  const failed = { steps: [{ name: "remove-worktree", status: "failed" }] };
  fails(cleanup_(failed), "CONTRACT_INVALID", "state");
  cleanup_({ ...failed, state: "CLEANUP_FAILED" })();
});

test("config: safe defaults and fixed review policy", () => {
  const gh = { owner: "omi-home", repo: "omi-plugins", projectNumber: 2 };
  const c = parseConfig({ github: gh });
  assert.equal(c.git.baseBranch, "develop");
  assert.equal(c.git.mergeMethod, "squash");
  assert.equal(c.cleanup.deleteRemoteBranch, false);
  assert.equal(c.github.privateRepoRiskAccepted, false);
  assert.deepEqual([c.review.maxRounds, c.review.architectAfterFailedRounds], [4, 2]);
  assert.equal(c.agents.maxConcurrent, 3);
  assert.deepEqual(c.agents.routing["code-reviewer"], { model: "opus", effort: "medium" });
  assert.deepEqual(c.agents.routing["backend-engineer"], { model: "sonnet", effort: "medium" });
  fails(
    () => parseConfig({ github: gh, review: { maxRounds: 5 } }),
    "CONFIG_INVALID",
    "review.maxRounds",
  );
  fails(() => parseConfig({ github: gh, agents: { maxConcurrent: 4 } }), "CONFIG_INVALID");
  fails(() => parseConfig({ github: gh, cleanup: { force: true } }), "CONFIG_INVALID");
  fails(() => parseConfig({}), "CONFIG_INVALID", "github");
});
