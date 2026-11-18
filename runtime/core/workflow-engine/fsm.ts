// Workflow FSM (spec §10): pure (context, event, facts) → next context. No I/O; the caller
// persists the result with a compare-and-set transition (runtime/persistence/repository.ts).
// Review policy: 2 rounds → Architect once → 2 rounds → WAITING_PO. Never a fifth round.
import type { OmiConfig } from "../config.ts";
import type {
  ProjectStatus,
  WorkflowContext,
  WorkflowEventType,
  WorkflowState,
} from "../contracts.ts";
import { ERROR_CODES, type ErrorCode, OmiError } from "../errors/errors.ts";

export type WorkflowEvent =
  | { type: "TECHNICAL_FAILURE"; errorCode: ErrorCode }
  | { type: Exclude<WorkflowEventType, "TECHNICAL_FAILURE"> };

/** Observed facts the caller reads from state before asking for a transition. */
export interface Facts {
  /** Outbox reports not yet confirmed on GitHub: forward progress waits for them (spec §5). */
  pendingReports: number;
}

export interface Policy {
  maxRounds: number;
  architectAfterFailedRounds: number;
  maxAttempts: number;
  maxValidationFixes: number;
  maxQaReworks: number;
}

export const POLICY: Policy = {
  maxRounds: 4,
  architectAfterFailedRounds: 2,
  /** Technical retries per step before the run is BLOCKED. */
  maxAttempts: 3,
  /** Deterministic check failures fixed by the engineer within one round (not review failures). */
  maxValidationFixes: 2,
  /** QA rework budget, separate from review rounds. */
  maxQaReworks: 2,
};

/** The run policy a repo configured (`review` in `.omi/config.yaml`). */
export const policyFrom = (c: OmiConfig): Policy => ({ ...c.review });

/** Project Status shown for an executable Issue in each workflow state (DocumentationTask-0007 #99). */
export const PROJECT_STATUS: Record<WorkflowState, ProjectStatus> = {
  CREATED: "Ready",
  TICKET_VALIDATED: "Ready",
  WORKSPACE_READY: "In Progress",
  RUNNING: "In Progress",
  REWORK: "Rework",
  ARCHITECT_ESCALATION: "Rework",
  PR_PENDING: "In Review",
  IN_QA: "In QA",
  WAITING_PO: "Waiting PO",
  BLOCKED: "Blocked",
  RECOVERY_REQUIRED: "Blocked",
  CLEANUP_FAILED: "Blocked",
  FAILED: "Blocked",
  PR_MERGED: "In Review", // not Done until cleanup finished
  CLEANUP_PENDING: "In Review",
  COMPLETED: "Done",
  CANCELLED: "Cancelled",
};

export const PRE_MERGE: readonly WorkflowState[] = [
  "CREATED",
  "TICKET_VALIDATED",
  "WORKSPACE_READY",
  "RUNNING",
  "REWORK",
  "ARCHITECT_ESCALATION",
  "IN_QA",
  "PR_PENDING",
];
const HOLD: readonly WorkflowState[] = ["BLOCKED", "WAITING_PO", "RECOVERY_REQUIRED"];
const POST_MERGE: readonly WorkflowState[] = ["PR_MERGED", "CLEANUP_PENDING", "CLEANUP_FAILED"];

/** Events that are not forward progress, so they may happen while a report is pending. */
const NON_PROGRESS = new Set<WorkflowEventType>([
  "TECHNICAL_FAILURE",
  "BLOCK",
  "ESCALATE_TO_PO",
  "CANCEL",
  "FAIL",
  "INCONSISTENCY_DETECTED",
]);

export const initialContext = (): WorkflowContext => ({
  state: "CREATED",
  round: 0,
  failedRounds: 0,
  architectUsed: false,
  qaReworks: 0,
  reworkFor: null,
  attempt: 1,
  validationFixes: 0,
  resumeFrom: null,
});

const invalid = (ctx: WorkflowContext, e: WorkflowEvent) =>
  new OmiError("INVALID_TRANSITION", `${e.type} is not allowed in ${ctx.state}`);
const policy = (msg: string) => new OmiError("POLICY_VIOLATION", msg);

export function transition(
  ctx: WorkflowContext,
  e: WorkflowEvent,
  facts: Facts = { pendingReports: 0 },
  p: Policy = POLICY,
): WorkflowContext {
  const to = (state: WorkflowState, patch: Partial<WorkflowContext> = {}): WorkflowContext => ({
    ...ctx,
    attempt: 1,
    ...patch,
    state,
  });
  const hold = (state: WorkflowState, resumeFrom: WorkflowState | null) =>
    to(state, { resumeFrom });
  const is = (...states: readonly WorkflowState[]) => states.includes(ctx.state);

  if (!NON_PROGRESS.has(e.type) && facts.pendingReports > 0 && !is(...HOLD)) {
    throw policy(`${facts.pendingReports} report(s) not posted: no dispatch until REPORT_POSTED`);
  }

  switch (e.type) {
    case "TICKET_VALID":
      if (is("CREATED")) return to("TICKET_VALIDATED");
      break;
    case "WORKSPACE_CREATED":
      if (is("TICKET_VALIDATED")) return to("WORKSPACE_READY");
      break;
    case "DEV_STARTED":
      if (is("WORKSPACE_READY")) return to("RUNNING", { round: 1, validationFixes: 0 });
      if (is("REWORK")) {
        const round = ctx.reworkFor === "review" ? ctx.round + 1 : ctx.round;
        if (round > p.maxRounds)
          throw policy(`no review round ${round}: maximum is ${p.maxRounds}`);
        return to("RUNNING", { round, reworkFor: null, validationFixes: 0 });
      }
      break;
    case "CHECKS_FAILED":
      if (is("RUNNING")) {
        const validationFixes = ctx.validationFixes + 1;
        return validationFixes > p.maxValidationFixes
          ? hold("BLOCKED", "RUNNING")
          : to("RUNNING", { validationFixes });
      }
      break;
    case "REVIEW_PASSED":
      if (is("RUNNING")) return to("IN_QA", { failedRounds: 0 });
      break;
    case "REVIEW_FAILED":
      if (is("RUNNING")) {
        const failedRounds = ctx.failedRounds + 1;
        if (ctx.round >= p.maxRounds) return to("WAITING_PO", { failedRounds, resumeFrom: null });
        if (failedRounds >= p.architectAfterFailedRounds && !ctx.architectUsed) {
          return to("ARCHITECT_ESCALATION", { failedRounds });
        }
        return to("REWORK", { failedRounds, reworkFor: "review" });
      }
      break;
    case "ARCHITECT_PLAN_ACCEPTED":
      if (is("ARCHITECT_ESCALATION")) {
        return to("REWORK", { architectUsed: true, reworkFor: "review" });
      }
      break;
    case "ARCHITECT_SCOPE_CHANGE":
      // Scope changes need a new PO-authorized work item: no automatic resume.
      if (is("ARCHITECT_ESCALATION")) {
        return to("WAITING_PO", { architectUsed: true, resumeFrom: null });
      }
      break;
    case "QA_PASSED":
      if (is("IN_QA")) return to("PR_PENDING");
      break;
    case "QA_FAILED":
      if (is("IN_QA")) {
        const qaReworks = ctx.qaReworks + 1;
        return qaReworks > p.maxQaReworks
          ? to("WAITING_PO", { qaReworks, resumeFrom: null })
          : to("REWORK", { qaReworks, reworkFor: "qa" });
      }
      break;
    case "MERGE_VERIFIED":
      // GitHub's merge receipt is a fact, whoever merged (OMI, or the PO for a High risk PR):
      // record it from any pre-merge or held state rather than orphan the merged work.
      if (is(...PRE_MERGE, "BLOCKED", "WAITING_PO")) return to("PR_MERGED", { resumeFrom: null });
      break;
    case "CLEANUP_STARTED":
      if (is("PR_MERGED", "CLEANUP_FAILED")) return to("CLEANUP_PENDING");
      break;
    case "CLEANUP_SUCCEEDED":
      if (is("CLEANUP_PENDING")) return to("COMPLETED");
      break;
    case "CLEANUP_ERROR":
      if (is("CLEANUP_PENDING")) return to("CLEANUP_FAILED");
      break;
    case "TECHNICAL_FAILURE":
      if (is(...PRE_MERGE, "CLEANUP_PENDING")) {
        const retry = ERROR_CODES[e.errorCode].transient && ctx.attempt < p.maxAttempts;
        if (retry) return { ...ctx, attempt: ctx.attempt + 1 };
        return is("CLEANUP_PENDING") ? to("CLEANUP_FAILED") : hold("BLOCKED", ctx.state);
      }
      break;
    case "BLOCK":
      if (is(...PRE_MERGE)) return hold("BLOCKED", ctx.state);
      break;
    case "ESCALATE_TO_PO":
      if (is(...PRE_MERGE)) return hold("WAITING_PO", ctx.state);
      break;
    case "UNBLOCK":
      // A human cleared the block: the check-fix budget starts over (#25 CR-002).
      if (is("BLOCKED")) return resume(ctx, (s, patch) => to(s, { validationFixes: 0, ...patch }));
      break;
    case "PO_RESUME":
      if (is("WAITING_PO")) return resume(ctx, to);
      break;
    case "RECOVERED":
      if (is("RECOVERY_REQUIRED")) return resume(ctx, to);
      break;
    case "INCONSISTENCY_DETECTED":
      if (is(...PRE_MERGE, ...POST_MERGE)) return hold("RECOVERY_REQUIRED", ctx.state);
      break;
    case "ANALYSIS_COMPLETED":
      if (is("TICKET_VALIDATED")) return to("COMPLETED");
      break;
    case "CANCEL":
    case "FAIL":
      if (is(...PRE_MERGE) || (is(...HOLD) && !POST_MERGE.includes(ctx.resumeFrom as never))) {
        return to(e.type === "CANCEL" ? "CANCELLED" : "FAILED", { resumeFrom: null });
      }
      if (is(...POST_MERGE, ...HOLD))
        throw policy("merged work cannot be cancelled: finish cleanup");
      break;
  }
  throw invalid(ctx, e);
}

function resume(
  ctx: WorkflowContext,
  to: (s: WorkflowState, patch?: Partial<WorkflowContext>) => WorkflowContext,
): WorkflowContext {
  if (!ctx.resumeFrom) {
    throw policy(`${ctx.state} has no resume point: a new PO-authorized work item is required`);
  }
  return to(ctx.resumeFrom, { resumeFrom: null });
}
