// Typed contracts for issue / workflow / step / comment / cleanup (idea §6, §10–§14).
// Every document is strict (unknown fields rejected) and versioned via `schemaVersion`.
import { z } from "zod";
import { OmiError } from "./errors/errors.ts";

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
  "Backlog",
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

/** Review round verdict (idea §10): only PASSED/FAILED count toward the 2 + Architect + 2 policy. */
export const ReviewOutcome = StepState.extract(["PASSED", "FAILED"]);
export type ReviewOutcome = z.infer<typeof ReviewOutcome>;

/** GitHub comment outbox (idea §12): pending until the comment id is stored. */
export const OutboxState = z.enum(["PENDING", "POSTED"]);
export type OutboxState = z.infer<typeof OutboxState>;

/** Resources a run may own and cleanup may release (idea §14). */
export const ResourceKind = z.enum(["worktree", "branch", "process", "container", "temp-dir"]);
export type ResourceKind = z.infer<typeof ResourceKind>;

/** `omi doctor` check outcome: only `fail` makes the command exit non-zero. */
export const CheckStatus = z.enum(["pass", "warn", "fail"]);
export type CheckStatus = z.infer<typeof CheckStatus>;

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

export const Finding = z.strictObject({
  id: z.string().regex(/^[A-Z]{2,5}-\d{3,}$/, "expected stable id like CR-001"),
  severity: Severity,
  path: relPath.optional(),
  line: z.int().positive().optional(),
  observed: text(1000),
  expected: text(1000),
});
export type Finding = z.infer<typeof Finding>;

// ---- Step result: agent → runtime (idea §11). A recommendation, never a transition. ----

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
  })
  .refine((r) => r.status !== "BLOCKED" || r.blockerReason, {
    message: "BLOCKED requires blockerReason",
    path: ["blockerReason"],
  });
export type StepResult = z.infer<typeof StepResult>;

// ---- Step comment: runtime → GitHub (idea §12) ----

export const StepComment = z
  .strictObject({
    schemaVersion,
    issue: IssueRef,
    workflowRunId: id,
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

/** Stable idempotency marker (repo+issue+run+step+round+attempt), idea §12. */
export const commentMarker = (c: StepComment): string =>
  `<!-- omi:repo=${c.issue.repository};issue=${c.issue.number};run=${c.workflowRunId};step=${c.stepId};round=${c.round};attempt=${c.attempt} -->`;

// ---- Cleanup result (idea §14) ----

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
    pr: z.strictObject({
      number: z.int().positive(),
      merged: z.boolean(),
      baseRef: z.string().min(1),
      headRef: z.string().min(1),
      headSha: sha,
    }),
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
  .refine((r) => r.state !== "COMPLETED" || r.pr.merged, {
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
