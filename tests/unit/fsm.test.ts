// T2.3 FSM: exhaustive state × event table, invalid transitions, 2 + Architect + 2 policy,
// attempt vs round, report gating, holds and resume.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type WorkflowContext,
  WorkflowEventType,
  WorkflowState,
} from "../../runtime/core/contracts.ts";
import { OmiError } from "../../runtime/core/errors/errors.ts";
import {
  initialContext,
  transition,
  type WorkflowEvent,
} from "../../runtime/core/workflow-engine/fsm.ts";

const ev = (type: WorkflowEventType): WorkflowEvent =>
  type === "TECHNICAL_FAILURE" ? { type, errorCode: "NETWORK" } : { type };
const code = (c: string) => (e: unknown) => e instanceof OmiError && e.code === c;

/** Neutral context per state: round 1, nothing exhausted, holds resume to RUNNING. */
const at = (state: WorkflowState, patch: Partial<WorkflowContext> = {}): WorkflowContext => ({
  ...initialContext(),
  state,
  round: 1,
  reworkFor: state === "REWORK" ? "review" : null,
  resumeFrom: ["BLOCKED", "WAITING_PO", "RECOVERY_REQUIRED"].includes(state) ? "RUNNING" : null,
  ...patch,
});

// Every legal (state, event) pair with the neutral context, and where it lands.
// Anything absent must throw INVALID_TRANSITION (or POLICY_VIOLATION where marked).
const PRE = [
  "CREATED",
  "TICKET_VALIDATED",
  "WORKSPACE_READY",
  "RUNNING",
  "REWORK",
  "ARCHITECT_ESCALATION",
  "IN_QA",
  "PR_PENDING",
] as const;
const TABLE: [WorkflowState, WorkflowEventType, WorkflowState][] = [
  ["CREATED", "TICKET_VALID", "TICKET_VALIDATED"],
  ["TICKET_VALIDATED", "WORKSPACE_CREATED", "WORKSPACE_READY"],
  ["WORKSPACE_READY", "DEV_STARTED", "RUNNING"],
  ["REWORK", "DEV_STARTED", "RUNNING"],
  ["RUNNING", "CHECKS_FAILED", "RUNNING"],
  ["RUNNING", "REVIEW_PASSED", "IN_QA"],
  ["RUNNING", "REVIEW_FAILED", "REWORK"],
  ["ARCHITECT_ESCALATION", "ARCHITECT_PLAN_ACCEPTED", "REWORK"],
  ["ARCHITECT_ESCALATION", "ARCHITECT_SCOPE_CHANGE", "WAITING_PO"],
  ["IN_QA", "QA_PASSED", "PR_PENDING"],
  ["IN_QA", "QA_FAILED", "REWORK"],
  ["PR_PENDING", "MERGE_VERIFIED", "PR_MERGED"],
  ["PR_MERGED", "CLEANUP_STARTED", "CLEANUP_PENDING"],
  ["CLEANUP_FAILED", "CLEANUP_STARTED", "CLEANUP_PENDING"],
  ["CLEANUP_PENDING", "CLEANUP_SUCCEEDED", "COMPLETED"],
  ["CLEANUP_PENDING", "CLEANUP_ERROR", "CLEANUP_FAILED"],
  ["CLEANUP_PENDING", "TECHNICAL_FAILURE", "CLEANUP_PENDING"],
  ["BLOCKED", "UNBLOCK", "RUNNING"],
  ["WAITING_PO", "PO_RESUME", "RUNNING"],
  ["RECOVERY_REQUIRED", "RECOVERED", "RUNNING"],
  ...PRE.flatMap((s): [WorkflowState, WorkflowEventType, WorkflowState][] => [
    [s, "TECHNICAL_FAILURE", s],
    [s, "BLOCK", "BLOCKED"],
    [s, "ESCALATE_TO_PO", "WAITING_PO"],
    [s, "CANCEL", "CANCELLED"],
    [s, "FAIL", "FAILED"],
    [s, "INCONSISTENCY_DETECTED", "RECOVERY_REQUIRED"],
  ]),
  ...(["BLOCKED", "WAITING_PO", "RECOVERY_REQUIRED"] as const).flatMap(
    (s): [WorkflowState, WorkflowEventType, WorkflowState][] => [
      [s, "CANCEL", "CANCELLED"],
      [s, "FAIL", "FAILED"],
    ],
  ),
  ...(["PR_MERGED", "CLEANUP_PENDING", "CLEANUP_FAILED"] as const).map(
    (s): [WorkflowState, WorkflowEventType, WorkflowState] => [
      s,
      "INCONSISTENCY_DETECTED",
      "RECOVERY_REQUIRED",
    ],
  ),
];
/** Recognised but refused by policy: merged work cannot be cancelled. */
const POLICY_REFUSED = new Set(
  ["PR_MERGED", "CLEANUP_PENDING", "CLEANUP_FAILED"].flatMap((s) => [`${s}/CANCEL`, `${s}/FAIL`]),
);

test("exhaustive table: every state × event is either listed or refused", () => {
  const legal = new Map(TABLE.map(([s, e, to]) => [`${s}/${e}`, to]));
  assert.equal(legal.size, TABLE.length, "duplicate rows in TABLE");
  let checked = 0;
  for (const s of WorkflowState.options) {
    for (const e of WorkflowEventType.options) {
      const key = `${s}/${e}`;
      const expected = legal.get(key);
      if (expected) {
        assert.equal(transition(at(s), ev(e)).state, expected, key);
      } else {
        const c = POLICY_REFUSED.has(key) ? "POLICY_VIOLATION" : "INVALID_TRANSITION";
        assert.throws(() => transition(at(s), ev(e)), code(c), key);
      }
      checked++;
    }
  }
  assert.equal(checked, WorkflowState.options.length * WorkflowEventType.options.length);
});

test("terminal states accept nothing", () => {
  for (const s of ["COMPLETED", "FAILED", "CANCELLED"] as const) {
    for (const e of WorkflowEventType.options) {
      assert.throws(() => transition(at(s), ev(e)), code("INVALID_TRANSITION"), `${s}/${e}`);
    }
  }
});

/** Drives a sequence from a context and returns the visited states. */
function drive(ctx: WorkflowContext, events: WorkflowEventType[]) {
  const states: WorkflowState[] = [];
  for (const e of events) {
    ctx = transition(ctx, ev(e));
    states.push(ctx.state);
  }
  return { ctx, states };
}

const toReview = ["TICKET_VALID", "WORKSPACE_CREATED", "DEV_STARTED"] as const;

test("policy 2 + Architect + 2: four failed rounds end in WAITING_PO without a fifth round", () => {
  const { ctx, states } = drive(initialContext(), [
    ...toReview,
    "REVIEW_FAILED", // R1
    "DEV_STARTED",
    "REVIEW_FAILED", // R2 → architect
    "ARCHITECT_PLAN_ACCEPTED",
    "DEV_STARTED",
    "REVIEW_FAILED", // R3 → rework, architect already used
    "DEV_STARTED",
    "REVIEW_FAILED", // R4 → PO
  ]);
  assert.deepEqual(states.slice(3), [
    "REWORK",
    "RUNNING",
    "ARCHITECT_ESCALATION",
    "REWORK",
    "RUNNING",
    "REWORK",
    "RUNNING",
    "WAITING_PO",
  ]);
  assert.equal(ctx.round, 4);
  assert.equal(ctx.resumeFrom, null);
  assert.throws(() => transition(ctx, ev("PO_RESUME")), code("POLICY_VIOLATION"));
  assert.equal(transition(ctx, ev("CANCEL")).state, "CANCELLED");
});

test("architect scope change goes straight to WAITING_PO with no automatic resume", () => {
  const { ctx } = drive(initialContext(), [
    ...toReview,
    "REVIEW_FAILED",
    "DEV_STARTED",
    "REVIEW_FAILED",
    "ARCHITECT_SCOPE_CHANGE",
  ]);
  assert.equal(ctx.state, "WAITING_PO");
  assert.throws(() => transition(ctx, ev("PO_RESUME")), code("POLICY_VIOLATION"));
});

test("a pass resets consecutive failures; R1 fail + R2 pass reaches QA without architect", () => {
  const { ctx, states } = drive(initialContext(), [
    ...toReview,
    "REVIEW_FAILED",
    "DEV_STARTED",
    "REVIEW_PASSED",
    "QA_PASSED",
    "MERGE_VERIFIED",
    "CLEANUP_STARTED",
    "CLEANUP_SUCCEEDED",
  ]);
  assert.ok(!states.includes("ARCHITECT_ESCALATION"));
  assert.equal(ctx.state, "COMPLETED");
  assert.equal(ctx.round, 2);
  assert.equal(ctx.failedRounds, 0);
});

test("technical failures retry the step without consuming a review round", () => {
  let ctx = drive(initialContext(), [...toReview]).ctx;
  const net: WorkflowEvent = { type: "TECHNICAL_FAILURE", errorCode: "NETWORK" };
  ctx = transition(ctx, net);
  ctx = transition(ctx, net);
  assert.deepEqual([ctx.state, ctx.attempt, ctx.round], ["RUNNING", 3, 1]);
  ctx = transition(ctx, net); // attempts exhausted
  assert.deepEqual([ctx.state, ctx.resumeFrom, ctx.round], ["BLOCKED", "RUNNING", 1]);
  ctx = transition(ctx, ev("UNBLOCK"));
  assert.deepEqual([ctx.state, ctx.attempt, ctx.round], ["RUNNING", 1, 1]);
  // A non-transient error blocks at once.
  const blocked = transition(ctx, { type: "TECHNICAL_FAILURE", errorCode: "WORKTREE_DIRTY" });
  assert.equal(blocked.state, "BLOCKED");
  // Any progress resets the attempt counter.
  assert.equal(transition(transition(ctx, net), ev("REVIEW_PASSED")).attempt, 1);
});

test("deterministic check failures are bounded fixes, not review failures", () => {
  let { ctx } = drive(initialContext(), [...toReview, "CHECKS_FAILED", "CHECKS_FAILED"]);
  assert.deepEqual([ctx.state, ctx.validationFixes, ctx.failedRounds], ["RUNNING", 2, 0]);
  ctx = transition(ctx, ev("CHECKS_FAILED"));
  assert.deepEqual([ctx.state, ctx.resumeFrom], ["BLOCKED", "RUNNING"]);
  // A new round starts with a fresh fix budget.
  const next = drive(initialContext(), [
    ...toReview,
    "CHECKS_FAILED",
    "REVIEW_FAILED",
    "DEV_STARTED",
  ]);
  assert.equal(next.ctx.validationFixes, 0);
});

test("QA rework has its own budget and keeps review history", () => {
  const { ctx } = drive(initialContext(), [
    ...toReview,
    "REVIEW_FAILED",
    "DEV_STARTED",
    "REVIEW_PASSED",
    "QA_FAILED",
    "DEV_STARTED",
  ]);
  assert.deepEqual([ctx.state, ctx.round, ctx.qaReworks], ["RUNNING", 2, 1]);
  const exhausted = transition(at("IN_QA", { qaReworks: 2 }), ev("QA_FAILED"));
  assert.deepEqual([exhausted.state, exhausted.resumeFrom], ["WAITING_PO", null]);
  // A review failure after QA rework still counts toward the round cap.
  assert.equal(transition(at("RUNNING", { round: 4 }), ev("REVIEW_FAILED")).state, "WAITING_PO");
});

test("no dispatch while a report is pending; holds and escapes still work", () => {
  const pending = { pendingReports: 1 };
  assert.throws(
    () => transition(at("RUNNING"), ev("REVIEW_PASSED"), pending),
    code("POLICY_VIOLATION"),
  );
  assert.throws(
    () => transition(at("REWORK"), ev("DEV_STARTED"), pending),
    code("POLICY_VIOLATION"),
  );
  for (const e of ["BLOCK", "ESCALATE_TO_PO", "CANCEL", "INCONSISTENCY_DETECTED"] as const) {
    assert.doesNotThrow(() => transition(at("RUNNING"), ev(e), pending), e);
  }
  assert.equal(transition(at("RUNNING"), ev("TECHNICAL_FAILURE"), pending).attempt, 2);
});

test("recovery returns to the interrupted state; merged runs cannot be cancelled", () => {
  const r = transition(at("CLEANUP_PENDING"), ev("INCONSISTENCY_DETECTED"));
  assert.deepEqual([r.state, r.resumeFrom], ["RECOVERY_REQUIRED", "CLEANUP_PENDING"]);
  assert.throws(() => transition(r, ev("CANCEL")), code("POLICY_VIOLATION"));
  assert.equal(transition(r, ev("RECOVERED")).state, "CLEANUP_PENDING");
  assert.equal(
    transition(at("CLEANUP_PENDING", { attempt: 3 }), ev("TECHNICAL_FAILURE")).state,
    "CLEANUP_FAILED",
  );
});

test("transition is pure: input context is never mutated", () => {
  const ctx = Object.freeze(at("RUNNING"));
  transition(ctx, ev("REVIEW_FAILED"));
  transition(ctx, ev("TECHNICAL_FAILURE"));
  assert.equal(ctx.state, "RUNNING");
});
