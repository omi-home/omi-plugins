// T3.5 review loop through the persisted FSM: every 2 + Architect + 2 path, no fifth Dev
// round, one Architect call, scope change stops at PO, transport ≠ quality failure, and no
// verdict without the reviewer's posted report. Plus policy from config, #99 status mapping.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { setStatus } from "../../runtime/adapters/github/project.ts";
import { parseConfig } from "../../runtime/core/config.ts";
import { parseContract, StepResult, WorkflowState } from "../../runtime/core/contracts.ts";
import {
  PROJECT_STATUS,
  policyFrom,
  type WorkflowEvent,
} from "../../runtime/core/workflow-engine/fsm.ts";
import { openState } from "../../runtime/persistence/db.ts";
import * as repo from "../../runtime/persistence/repository.ts";

const issue = { repository: "o/r", number: 5 };
type Db = ReturnType<typeof openState>;

function ready(): Db {
  const db = openState(":memory:");
  repo.createRun(db, { id: "run", issue, workflow: "dev-task" });
  repo.advanceRun(db, "run", { type: "TICKET_VALID" });
  repo.advanceRun(db, "run", { type: "WORKSPACE_CREATED" });
  return db;
}

const ev = (db: Db, type: Exclude<WorkflowEvent["type"], "TECHNICAL_FAILURE">) =>
  repo.advanceRun(db, "run", { type }).context;

/** Reviewer step for the current round: result persisted and its comment confirmed posted. */
function postReview(db: Db, verdict: "PASSED" | "FAILED") {
  const { round } = repo.runContext(db, "run");
  const step = repo.startStep(db, {
    runId: "run",
    stepId: "code-review",
    round,
    role: "code-reviewer",
  });
  const attempt = repo.beginAttempt(db, step.id);
  const result = parseContract(
    StepResult,
    {
      schemaVersion: 1,
      workflowRunId: "run",
      issue,
      stepId: "code-review",
      round,
      attempt,
      role: "code-reviewer",
      status: verdict,
      summary: `round ${round}`,
    },
    "result",
  );
  const marker = `<!-- review ${round} -->`;
  repo.persistStepResult(db, {
    stepRunId: step.id,
    attempt,
    result,
    actualModel: "claude-opus-5-5",
    report: { marker, body: `${marker}\nreview` },
  });
  repo.markReported(db, { marker, commentId: String(round), commentUrl: `https://x/${round}` });
  return ev(db, verdict === "PASSED" ? "REVIEW_PASSED" : "REVIEW_FAILED");
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};
const events = (db: Db) => repo.transitions(db, "run").map((t) => t.event);

test("round 1 pass → QA", () => {
  const db = ready();
  ev(db, "DEV_STARTED");
  assert.equal(postReview(db, "PASSED").state, "IN_QA");
  assert.equal(repo.reviewRounds(db, "run"), 1);
});

test("round 1 fail → Dev round 2 → pass", () => {
  const db = ready();
  ev(db, "DEV_STARTED");
  assert.equal(postReview(db, "FAILED").state, "REWORK");
  assert.equal(ev(db, "DEV_STARTED").round, 2);
  assert.equal(postReview(db, "PASSED").state, "IN_QA");
});

test("2 fails → Architect once → round 3 fail → round 4 fail → WAITING_PO, no fifth Dev", () => {
  const db = ready();
  ev(db, "DEV_STARTED");
  postReview(db, "FAILED");
  ev(db, "DEV_STARTED");
  assert.equal(postReview(db, "FAILED").state, "ARCHITECT_ESCALATION");
  assert.equal(ev(db, "ARCHITECT_PLAN_ACCEPTED").state, "REWORK");
  assert.equal(ev(db, "DEV_STARTED").round, 3);
  assert.equal(postReview(db, "FAILED").state, "REWORK", "no second Architect");
  assert.equal(ev(db, "DEV_STARTED").round, 4);
  const end = postReview(db, "FAILED");
  assert.deepEqual([end.state, end.resumeFrom], ["WAITING_PO", null]);
  assert.equal(
    code(() => ev(db, "DEV_STARTED")),
    "INVALID_TRANSITION",
  );
  assert.equal(
    code(() => ev(db, "PO_RESUME")),
    "POLICY_VIOLATION",
    "needs a new work item",
  );
  assert.equal(events(db).filter((e) => e === "ARCHITECT_PLAN_ACCEPTED").length, 1);
  assert.equal(
    repo.transitions(db, "run").filter((t) => t.to === "ARCHITECT_ESCALATION").length,
    1,
  );
  assert.equal(repo.reviewRounds(db, "run"), 4);
});

test("Architect correction then round 3 pass → QA", () => {
  const db = ready();
  ev(db, "DEV_STARTED");
  postReview(db, "FAILED");
  ev(db, "DEV_STARTED");
  postReview(db, "FAILED");
  ev(db, "ARCHITECT_PLAN_ACCEPTED");
  ev(db, "DEV_STARTED");
  assert.equal(postReview(db, "PASSED").state, "IN_QA");
});

test("Architect scope change stops at PO immediately", () => {
  const db = ready();
  ev(db, "DEV_STARTED");
  postReview(db, "FAILED");
  ev(db, "DEV_STARTED");
  postReview(db, "FAILED");
  const ctx = ev(db, "ARCHITECT_SCOPE_CHANGE");
  assert.deepEqual([ctx.state, ctx.resumeFrom], ["WAITING_PO", null]);
  assert.equal(
    code(() => ev(db, "DEV_STARTED")),
    "INVALID_TRANSITION",
  );
});

test("transport failure is an attempt, never a round; persisted context survives reopen", () => {
  const db = ready();
  ev(db, "DEV_STARTED");
  const net = repo.advanceRun(db, "run", {
    type: "TECHNICAL_FAILURE",
    errorCode: "NETWORK",
  }).context;
  assert.deepEqual([net.state, net.round, net.attempt], ["RUNNING", 1, 2]);
  assert.equal(repo.reviewRounds(db, "run"), 0);
  assert.equal(repo.runContext(db, "run").attempt, 2);
  assert.ok(events(db).includes("TECHNICAL_FAILURE"));
});

test("no verdict without the reviewer's posted report; a pending report also blocks", () => {
  const db = ready();
  ev(db, "DEV_STARTED");
  assert.equal(
    code(() => ev(db, "REVIEW_FAILED")),
    "POLICY_VIOLATION",
  );
  const step = repo.startStep(db, {
    runId: "run",
    stepId: "code-review",
    round: 1,
    role: "code-reviewer",
  });
  const attempt = repo.beginAttempt(db, step.id);
  repo.persistStepResult(db, {
    stepRunId: step.id,
    attempt,
    result: parseContract(
      StepResult,
      {
        schemaVersion: 1,
        workflowRunId: "run",
        issue,
        stepId: "code-review",
        round: 1,
        attempt,
        role: "code-reviewer",
        status: "FAILED",
        summary: "x",
      },
      "r",
    ),
    actualModel: null,
    report: { marker: "<!-- r1 -->", body: "<!-- r1 -->" },
  });
  assert.equal(
    code(() => ev(db, "REVIEW_FAILED")),
    "POLICY_VIOLATION",
    "report still pending",
  );
  assert.equal(repo.runContext(db, "run").state, "RUNNING", "nothing moved");
  assert.equal(repo.reviewRounds(db, "run"), 0);
  repo.markReported(db, { marker: "<!-- r1 -->", commentId: "1", commentUrl: "https://x/1" });
  assert.equal(
    code(() => ev(db, "REVIEW_PASSED")),
    "POLICY_VIOLATION",
    "reviewer said FAILED",
  );
  assert.equal(ev(db, "REVIEW_FAILED").state, "REWORK");
  assert.equal(repo.reviewRounds(db, "run"), 1);
});

test("UNBLOCK after exhausted check fixes restores the fix budget (#25 CR-002)", () => {
  const db = ready();
  ev(db, "DEV_STARTED");
  ev(db, "CHECKS_FAILED");
  ev(db, "CHECKS_FAILED");
  assert.equal(ev(db, "CHECKS_FAILED").state, "BLOCKED");
  const ctx = ev(db, "UNBLOCK");
  assert.deepEqual([ctx.state, ctx.validationFixes], ["RUNNING", 0]);
  assert.equal(ev(db, "CHECKS_FAILED").state, "RUNNING");
});

test("policy comes from config (#25 CR-003)", () => {
  const base = { github: { owner: "o", repo: "r", projectNumber: 1 } };
  assert.deepEqual(policyFrom(parseConfig(base)), {
    maxRounds: 4,
    architectAfterFailedRounds: 2,
    maxAttempts: 3,
    maxValidationFixes: 2,
    maxQaReworks: 2,
  });
  const strict = policyFrom(parseConfig({ ...base, review: { maxValidationFixes: 0 } }));
  const db = ready();
  repo.advanceRun(db, "run", { type: "DEV_STARTED" }, strict);
  assert.equal(
    repo.advanceRun(db, "run", { type: "CHECKS_FAILED" }, strict).context.state,
    "BLOCKED",
  );
  assert.throws(() => parseConfig({ ...base, review: { maxRounds: 5 } }), {
    code: "CONFIG_INVALID",
  });
});

test("PROJECT_STATUS covers every workflow state as DocumentationTask-0007 #99 says", () => {
  assert.deepEqual(Object.keys(PROJECT_STATUS).sort(), [...WorkflowState.options].sort());
  assert.equal(PROJECT_STATUS.ARCHITECT_ESCALATION, "Rework");
  assert.equal(PROJECT_STATUS.PR_MERGED, "In Review");
  assert.equal(PROJECT_STATUS.CLEANUP_FAILED, "Blocked");
  assert.equal(PROJECT_STATUS.COMPLETED, "Done");
});

test("setStatus: read → diff → write, no-op when equal, missing option refused", () => {
  const config = parseConfig({ github: { owner: "o", repo: "r", projectNumber: 2 } });
  let current = "In Progress";
  const writes: string[] = [];
  const options = [
    { id: "p", name: "In Progress" },
    { id: "w", name: "Rework" },
  ];
  const gh: GhRunner = (args) => {
    const q = args.find((a) => a.startsWith("query=") || a.startsWith("query=mutation")) ?? "";
    const data = q.includes("updateProjectV2ItemFieldValue")
      ? (writes.push(args.find((a) => a.startsWith("o="))?.slice(2) ?? ""),
        { updateProjectV2ItemFieldValue: {} })
      : q.includes("field(name")
        ? { repositoryOwner: { projectV2: { id: "P", field: { id: "F", options } } } }
        : {
            repository: {
              issue: {
                number: 5,
                parent: null,
                projectItems: {
                  nodes: [
                    {
                      id: "I",
                      project: { number: 2, owner: { login: "o" } },
                      fieldValueByName: { name: current },
                    },
                  ],
                },
              },
            },
          };
    return { status: 0, stderr: "", stdout: JSON.stringify({ data }) };
  };
  assert.equal(setStatus(config, 5, "In Progress", gh), null);
  assert.deepEqual(setStatus(config, 5, "Rework", gh), {
    issue: "o/r#5",
    from: "In Progress",
    to: "Rework",
  });
  assert.deepEqual(writes, ["w"]);
  current = "Rework";
  assert.equal(
    code(() => setStatus(config, 5, "Waiting PO", gh)),
    "CONFIG_INVALID",
  );
});
