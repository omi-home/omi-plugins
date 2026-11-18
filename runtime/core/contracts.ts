// Typed contracts for issue / workflow / step / comment / cleanup (spec §6, §10–§14).
// Every document is strict (unknown fields rejected) and versioned via `schemaVersion`.
import { isAbsolute } from "node:path";
import { z } from "zod";
import { type ErrorCode, OmiError } from "./errors/errors.ts";

export const SCHEMA_VERSION = 1;
const schemaVersion = z.literal(SCHEMA_VERSION);

// ---- Enums (single source for every state name; no raw strings elsewhere) ----

export const Role = z.enum([
  "business-analyst",
  "solution-architect",
  "ui-ux-designer",
  "frontend-engineer",
  "backend-engineer",
  "database-engineer",
  "code-reviewer",
  "security-reviewer",
  "manual-qa-engineer",
  "automation-qa-engineer",
  "devops-engineer",
]);
export type Role = z.infer<typeof Role>;

/** Roles whose agent cannot edit (agents/*.md disallow Edit/Write): no files, no commit. */
export const READ_ONLY_ROLES: readonly Role[] = [
  "business-analyst",
  "ui-ux-designer",
  "solution-architect",
  "code-reviewer",
  "security-reviewer",
  "manual-qa-engineer",
];

/** Issue body sections (`<!-- omi:section=… -->`) only their owner role may propose. */
export const ROLE_SECTION: Partial<Record<Role, string>> = {
  "business-analyst": "analysis",
  "ui-ux-designer": "design",
  "solution-architect": "architecture",
  "manual-qa-engineer": "qa",
};

/** Finding id prefix per role: one owner per kind of finding, no duplicated review lenses. */
export const FINDING_PREFIX: Partial<Record<Role, string>> = {
  "business-analyst": "BA",
  "ui-ux-designer": "UX",
  "solution-architect": "ARC",
  "code-reviewer": "CR",
  "security-reviewer": "SEC",
  "manual-qa-engineer": "QA",
  "automation-qa-engineer": "AQA",
};

/** Roles whose PASSED means "no medium+ finding left". */
export const VERDICT_ROLES: readonly Role[] = [
  "code-reviewer",
  "security-reviewer",
  "manual-qa-engineer",
];

/** What a PASSED result must carry: the role's own section, or changed files. */
export const PASSED_REQUIRES: Partial<Record<Role, "section" | "files">> = {
  "business-analyst": "section",
  "ui-ux-designer": "section",
  "manual-qa-engineer": "section",
  "automation-qa-engineer": "files", // authors tests; never called just to run them
};

/** Who executed a step: a specialist, the main session, or the deterministic CLI. */
export const Executor = z.union([Role, z.enum(["coordinator", "omi-cli"])]);
export type Executor = z.infer<typeof Executor>;

/** Authoritative OMI type, carried as label `type:<slug>` (ADR-0001 D6). */
export const IssueType = z.enum([
  "milestone",
  "epic",
  "feature",
  "fr",
  "nfr",
  "change-request",
  "bug",
  "dev-task",
  "test-task",
  "devops-task",
  "documentation-task",
  "spike",
  "release",
]);
export type IssueType = z.infer<typeof IssueType>;

export const ProjectStatus = z.enum([
  "Triage",
  "Backlog",
  "Analysis",
  "Approved",
  "Ready",
  "In Progress",
  "In Review",
  "In QA",
  "Done",
  "Blocked",
  "Rework",
  "Waiting PO",
  "Cancelled",
]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

export const WorkflowState = z.enum([
  "CREATED",
  "TICKET_VALIDATED",
  "WORKSPACE_READY",
  "RUNNING",
  "REWORK",
  "ARCHITECT_ESCALATION",
  "WAITING_PO",
  "BLOCKED",
  "IN_QA",
  "PR_PENDING",
  "PR_MERGED",
  "CLEANUP_PENDING",
  "CLEANUP_FAILED",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "RECOVERY_REQUIRED",
]);
export type WorkflowState = z.infer<typeof WorkflowState>;

/** Events the workflow FSM accepts (runtime/core/workflow-engine/fsm.ts). */
export const WorkflowEventType = z.enum([
  "TICKET_VALID",
  "WORKSPACE_CREATED",
  "DEV_STARTED",
  "CHECKS_FAILED",
  "REVIEW_PASSED",
  "REVIEW_FAILED",
  "ARCHITECT_PLAN_ACCEPTED",
  "ARCHITECT_SCOPE_CHANGE",
  "QA_PASSED",
  "QA_FAILED",
  "MERGE_VERIFIED",
  "CLEANUP_STARTED",
  "CLEANUP_SUCCEEDED",
  "CLEANUP_ERROR",
  "TECHNICAL_FAILURE",
  "BLOCK",
  "UNBLOCK",
  "ESCALATE_TO_PO",
  "PO_RESUME",
  "CANCEL",
  "FAIL",
  "INCONSISTENCY_DETECTED",
  "RECOVERED",
  /** An analysis run (no worktree, no PR) posted every report: the PO decides on GitHub. */
  "ANALYSIS_COMPLETED",
]);
export type WorkflowEventType = z.infer<typeof WorkflowEventType>;

/**
 * Durable FSM context. `round` = review round (domain), `attempt` = technical retry of the
 * current step: transport/tool errors only ever move `attempt` (spec §10).
 */
export const WorkflowContext = z.strictObject({
  state: WorkflowState,
  round: z.int().min(0).max(4),
  /** Consecutive counted review failures since the last pass. */
  failedRounds: z.int().min(0).max(4),
  architectUsed: z.boolean(),
  /** QA rework is a separate budget; it never resets review history. */
  qaReworks: z.int().min(0),
  reworkFor: z.enum(["review", "qa"]).nullable(),
  attempt: z.int().min(1),
  validationFixes: z.int().min(0),
  /** Where BLOCKED/WAITING_PO/RECOVERY_REQUIRED return to; null = needs a new authorized work item. */
  resumeFrom: WorkflowState.nullable(),
});
export type WorkflowContext = z.infer<typeof WorkflowContext>;

export const StepState = z.enum([
  "PENDING",
  "RUNNING",
  "RESULT_PERSISTED",
  "REPORT_PENDING",
  "REPORT_POSTED",
  "PASSED",
  "FAILED",
  "BLOCKED",
  "SKIPPED",
]);
export type StepState = z.infer<typeof StepState>;

/** Terminal outcome a step result may carry. */
export const StepOutcome = StepState.extract(["PASSED", "FAILED", "BLOCKED", "SKIPPED"]);
export type StepOutcome = z.infer<typeof StepOutcome>;

/** Review round verdict (spec §10): only PASSED/FAILED count toward the 2 + Architect + 2 policy. */
export const ReviewOutcome = StepState.extract(["PASSED", "FAILED"]);
export type ReviewOutcome = z.infer<typeof ReviewOutcome>;

/** GitHub comment outbox (spec §12): pending until the comment id is stored. */
export const OutboxState = z.enum(["PENDING", "POSTED"]);
export type OutboxState = z.infer<typeof OutboxState>;

/** Resources a run may own and cleanup may release (spec §14). */
export const ResourceKind = z.enum(["worktree", "branch", "process", "container", "temp-dir"]);
export type ResourceKind = z.infer<typeof ResourceKind>;

/** What a run stores under `artifact.kind` (CR-002 from T2.2). */
export const ArtifactKind = z.enum(["task-packet", "step-result", "evidence", "log"]);
export type ArtifactKind = z.infer<typeof ArtifactKind>;

/** Deterministic gate commands run before each cognitive review (spec §10), in this order. */
export const GateCheck = z.enum(["format", "lint", "build", "test", "scan"]);
export type GateCheck = z.infer<typeof GateCheck>;

/** `omi doctor` check outcome: only `fail` makes the command exit non-zero. */
export const CheckStatus = z.enum(["pass", "warn", "fail"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

/** One diagnostic/gate result (`omi doctor`, ticket validation). `code` classifies a failure. */
export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
  code?: ErrorCode;
}

export const Severity = z.enum(["critical", "high", "medium", "low", "info"]);

// ---- Shared primitives ----

export const IssueRef = z.strictObject({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/, "expected owner/repo"),
  number: z.int().positive(),
});
export type IssueRef = z.infer<typeof IssueRef>;

const sha = z.string().regex(/^[0-9a-f]{7,40}$/, "expected git SHA");
const id = z.string().regex(/^[\w.-]{1,100}$/, "expected identifier");
const round = z.int().min(1).max(4); // 2 + Architect + 2: never a fifth round
const attempt = z.int().min(1);
const text = (max: number) => z.string().trim().min(1).max(max);

/** Repo-relative path from untrusted agent output: no absolute paths, no traversal. */
const relPath = z
  .string()
  .min(1)
  .max(500)
  .refine((p) => !/^([A-Za-z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes(".."), {
    message: "expected repo-relative path without '..'",
  });

const findingId = z.string().regex(/^[A-Z]{2,5}-\d{3,}$/, "expected stable id like CR-001");

export const Finding = z.strictObject({
  id: findingId,
  severity: Severity,
  path: relPath.optional(),
  line: z.int().positive().optional(),
  observed: text(1000),
  expected: text(1000),
});
export type Finding = z.infer<typeof Finding>;

// ---- Task packet: runtime → agent (spec §11). Built by the CLI, never by an LLM. ----

/** Identifies the step-result contract the agent must answer with. */
export const STEP_RESULT_SCHEMA = `step-result@${SCHEMA_VERSION}`;

/** One Issue body of the context chain, nearest (the executable Issue) first. */
export const IssueContextEntry = z.strictObject({
  issue: IssueRef,
  type: IssueType.nullable(),
  title: z.string().max(300),
  body: z.string(),
  /** Body was cut to fit the packet budget. */
  truncated: z.boolean(),
});
export type IssueContextEntry = z.infer<typeof IssueContextEntry>;

/** A finding another task deferred to this one (`<!-- omi:carried-findings=… -->`, AGENTS.md rule 7). */
export const CarriedFinding = z.strictObject({
  source: text(500),
  finding: text(2000),
  action: text(2000),
});
export type CarriedFinding = z.infer<typeof CarriedFinding>;

export const CheckOutcome = z.enum(["pass", "fail", "timeout", "missing-tool", "skipped"]);
export type CheckOutcome = z.infer<typeof CheckOutcome>;

/** One deterministic check outcome as handed to an agent; `logPath` is the full local log. */
export const CheckRun = z.strictObject({
  name: GateCheck,
  outcome: CheckOutcome,
  exitCode: z.int().nullable(),
  summary: z.string().max(4000),
  logPath: z.string().nullable(),
});
export type CheckRun = z.infer<typeof CheckRun>;

export const TaskPacket = z.strictObject({
  schemaVersion,
  workflowRunId: id,
  issue: IssueRef,
  stepId: id,
  role: Role,
  round,
  attempt,
  /** Repo-relative paths the step may change; empty = whole worktree. */
  scope: z.array(relPath).max(50),
  worktree: z.string().refine((p) => isAbsolute(p), { message: "expected absolute path" }),
  baseSha: sha,
  issueContext: z.array(IssueContextEntry).min(1).max(10),
  /** Delta findings this step must address (spec §10: rework consumes findings, not the chat). */
  openFindings: z.array(Finding).max(100),
  carriedFindings: z.array(CarriedFinding).max(50),
  readOnlyArtifacts: z.array(relPath).max(50),
  /** Deterministic checks the runtime already ran on this worktree this round (review steps). */
  checkResults: z.array(CheckRun).max(10).optional(),
  outputSchema: z.literal(STEP_RESULT_SCHEMA),
});
export type TaskPacket = z.infer<typeof TaskPacket>;

// ---- Step result: agent → runtime (spec §11). A recommendation, never a transition. ----

/** Token usage as reported by the agent host, when it reports any. */
export type TokenUsage = z.infer<typeof TokenUsage>;
export const TokenUsage = z.strictObject({
  inputTokens: z.int().min(0),
  outputTokens: z.int().min(0),
  cacheReadTokens: z.int().min(0).optional(),
  cacheCreationTokens: z.int().min(0).optional(),
});

/** Proposed rewrite of one `<!-- omi:section=… -->` of the Issue body; only the CLI writes it. */
export const SectionUpdate = z.strictObject({ section: id, markdown: text(20_000) });

export const StepResult = z
  .strictObject({
    schemaVersion,
    workflowRunId: id,
    issue: IssueRef,
    stepId: id,
    round,
    attempt,
    role: Role,
    status: StepOutcome,
    summary: text(2000),
    changedFiles: z.array(relPath).max(500).default([]),
    commitSha: sha.optional(),
    evidencePaths: z.array(relPath).max(100).default([]),
    findings: z.array(Finding).max(100).default([]),
    blockerReason: text(1000).optional(),
    nextAction: text(500).optional(),
    sectionUpdates: z.array(SectionUpdate).max(10).default([]),
    usage: TokenUsage.optional(),
  })
  .refine((r) => r.status !== "BLOCKED" || r.blockerReason, {
    message: "BLOCKED requires blockerReason",
    path: ["blockerReason"],
  });
export type StepResult = z.infer<typeof StepResult>;

// ---- Step comment: runtime → GitHub (spec §12) ----

/** Report template family; one file per category in `templates/reports/`. */
export const ReportCategory = z.enum([
  "analysis",
  "architecture",
  "design",
  "implementation",
  "review",
  "qa",
  "checks",
  "cleanup",
]);
export type ReportCategory = z.infer<typeof ReportCategory>;

export const StepComment = z
  .strictObject({
    schemaVersion,
    issue: IssueRef,
    workflowRunId: id,
    category: ReportCategory,
    workflow: text(100),
    stepId: id,
    stepTitle: text(100),
    round,
    attempt,
    executor: Executor,
    requestedModel: z.string().nullable(),
    actualModel: z.string().nullable(), // observed, or "unknown"; null only for omi-cli
    requestedEffort: z.string().nullable(),
    actualEffort: z.literal("unknown").nullable(), // not observable (ADR-0001 D2)
    commitSha: sha.optional(),
    status: StepOutcome,
    summary: text(2000),
    changedFiles: z.array(relPath).max(500).default([]),
    evidencePaths: z.array(relPath).max(100).default([]),
    findings: z.array(Finding).max(100).default([]),
    nextAction: text(500),
    executionId: id,
    createdAt: z.iso.datetime(),
  })
  .refine(
    (c) => {
      const fields = [c.requestedModel, c.actualModel, c.requestedEffort, c.actualEffort];
      return c.executor === "omi-cli"
        ? fields.every((f) => f === null)
        : fields.every((f) => f !== null);
    },
    {
      message: "model/effort are null for omi-cli and required (observed or 'unknown') otherwise",
      path: ["executor"],
    },
  );
export type StepComment = z.infer<typeof StepComment>;

/** Stable idempotency marker (repo+issue+run+step+round+attempt), spec §12. */
export const commentMarker = (c: StepComment): string =>
  `<!-- omi:repo=${c.issue.repository};issue=${c.issue.number};run=${c.workflowRunId};step=${c.stepId};round=${c.round};attempt=${c.attempt} -->`;

// ---- Cleanup result (spec §14) ----

export const CleanupStepName = z.enum([
  "verify-merge",
  "archive-evidence",
  "stop-processes",
  "clean-temp",
  "verify-clean-worktree",
  "remove-worktree",
  "remove-local-branch",
  "prune-worktrees",
  "verify-freed",
]);

export const CleanupResult = z
  .strictObject({
    schemaVersion,
    issue: IssueRef,
    /** Merge receipt; null when no merged PR was found (nothing destructive ran). */
    pr: z
      .strictObject({
        number: z.int().positive(),
        merged: z.boolean(),
        baseRef: z.string().min(1),
        headRef: z.string().min(1),
        headSha: sha,
      })
      .nullable(),
    steps: z
      .array(
        z.strictObject({
          name: CleanupStepName,
          status: z.enum(["done", "skipped", "failed"]),
          detail: text(500).optional(),
        }),
      )
      .min(1),
    state: WorkflowState.extract(["COMPLETED", "CLEANUP_FAILED"]),
  })
  .refine((r) => r.state !== "COMPLETED" || r.pr?.merged, {
    message: "COMPLETED requires a verified merge",
    path: ["pr", "merged"],
  })
  .refine((r) => (r.state === "COMPLETED") === r.steps.every((s) => s.status !== "failed"), {
    message: "state must be CLEANUP_FAILED exactly when a step failed",
    path: ["state"],
  });
export type CleanupResult = z.infer<typeof CleanupResult>;

// ---- Validation entry point ----

/** Parses untrusted input; throws OmiError with path-level issues (input values never echoed). */
export function parseContract<S extends z.ZodType>(
  schema: S,
  input: unknown,
  name: string,
  code: "CONTRACT_INVALID" | "CONFIG_INVALID" = "CONTRACT_INVALID",
): z.infer<S> {
  const r = schema.safeParse(input);
  if (r.success) return r.data;
  const issues = r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
  const badVersion = issues.some((i) => i.path === "schemaVersion");
  throw new OmiError(
    badVersion ? "SCHEMA_VERSION_UNSUPPORTED" : code,
    `${name}: ${badVersion ? `unsupported schemaVersion (supported: ${SCHEMA_VERSION})` : "invalid"}`,
    { issues },
  );
}
