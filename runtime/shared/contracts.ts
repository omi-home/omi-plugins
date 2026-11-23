// Typed contracts for issue / workflow / step / comment / cleanup (spec §6, §10–§14).
// Every document is strict (unknown fields rejected) and versioned via `schemaVersion`.
import { isAbsolute } from "node:path";
import { z } from "zod";
import { type ErrorCode, OmiError } from "./errors/errors.ts";

export const SCHEMA_VERSION = 1;
const schemaVersion = z.literal(SCHEMA_VERSION);

// ---- Architecture contract building blocks (ADR-0006) ----
// Here, not in runtime/architecture/: the task packet carries an excerpt of the contract and shared
// imports no module. runtime/architecture/domain/contract.ts re-exports them.

const MAX_PATH = 200;

/** True when `p` is a safe repo-relative posix path (globs may also use `*` and `?`). */
function safePath(p: string, glob: boolean): boolean {
  if (p.length === 0 || p.length > MAX_PATH) return false;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.includes("\\")) return false;
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are rejected on purpose
  if (/[\u0000-\u001f]/.test(p)) return false;
  if (!glob && /[*?]/.test(p)) return false;
  return p.split("/").every((s) => s !== "" && s !== "." && s !== "..");
}

export const RelPath = z.string().refine((p) => safePath(p, false), {
  message:
    "must be a posix path relative to the repo (no '..', '.', absolute, drive, '\\', '*', '?')",
});
export const Glob = z.string().refine((p) => safePath(p, true), {
  message: "must be a posix glob relative to the repo (no '..', '.', absolute, drive, '\\')",
});
export const ModuleId = z.string().regex(/^[a-z][a-z0-9-]{1,40}$/);
const Segment = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .max(80);
const archText = (max: number) => z.string().min(1).max(max);

export const Layer = z.strictObject({
  name: ModuleId,
  dir: Segment,
  mayImport: z.array(ModuleId),
  forbidPackages: z.array(archText(200)).default([]),
});

export const ArchModule = z.strictObject({
  id: ModuleId,
  path: RelPath,
  description: archText(200),
  shared: z.boolean().default(false),
  dependsOn: z.array(ModuleId).default([]),
});

export const Placement = z.strictObject({
  pattern: Glob,
  allowedIn: z.array(Glob).min(1),
  message: archText(300),
});

/** The part of the contract an agent needs for a scope (TaskPacket.architecture). */
export const ArchitectureExcerpt = z.strictObject({
  contractPath: RelPath,
  layers: z.array(Layer),
  modules: z.array(ArchModule).max(30),
  placement: z.array(Placement),
});
export type ArchitectureExcerpt = z.infer<typeof ArchitectureExcerpt>;

// ---- Enums (single source for every state name; no raw strings elsewhere) ----

export const Role = z.enum([
  "business-analyst",
  "solution-architect",
  "ui-ux-designer",
  "software-engineer",
  "code-reviewer",
  "security-reviewer",
  "qa-engineer",
]);
export type Role = z.infer<typeof Role>;

/** Roles only `omi task analyze` selects into a plan (ADR-0005 D3); `omi task run` plans never do. */
export const ANALYSIS_ONLY_ROLES: readonly Role[] = ["business-analyst", "solution-architect"];

/** Roles whose agent cannot edit (agents/*.md disallow Edit/Write): no files, no commit. */
export const READ_ONLY_ROLES: readonly Role[] = [
  "business-analyst",
  "ui-ux-designer",
  "solution-architect",
  "code-reviewer",
  "security-reviewer",
];

/** Issue body sections (`<!-- omi:section=… -->`) only their owner role may propose. */
export const ROLE_SECTION: Partial<Record<Role, string>> = {
  "business-analyst": "analysis",
  "ui-ux-designer": "design",
  "solution-architect": "architecture",
  "qa-engineer": "qa",
};

/** Finding id prefix per role: one owner per kind of finding, no duplicated review lenses. */
export const FINDING_PREFIX: Partial<Record<Role, string>> = {
  "business-analyst": "BA",
  "ui-ux-designer": "UX",
  "solution-architect": "ARC",
  "code-reviewer": "CR",
  "security-reviewer": "SEC",
  "qa-engineer": "QA",
};

/** Roles whose PASSED means "no medium+ finding left". */
export const VERDICT_ROLES: readonly Role[] = ["code-reviewer", "security-reviewer", "qa-engineer"];

/**
 * What a PASSED result must carry: the role's own section, or changed files. `by-step`: the QA
 * Engineer authors tests (files; never called just to run them) and gives the acceptance verdict
 * (its `qa` section in the acceptance step).
 */
export const PASSED_REQUIRES: Partial<Record<Role, "section" | "files" | "by-step">> = {
  "business-analyst": "section",
  "ui-ux-designer": "section",
  "qa-engineer": "by-step",
};

/** Step id of the acceptance QA step (also with a rework suffix, `qa-qa1`). */
export const isAcceptanceQaStep = (stepId: string) => /^qa(-|$)/.test(stepId);

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

// ---- Model v2 (ADR-0005 D1/D2/D4): lives beside the legacy enums until Feature-0042 #301 ----

/** Which workflow model a workspace uses (`github.model`); `legacy` until the Project migrates. */
export const WorkflowModel = z.enum(["legacy", "v2"]);
export type WorkflowModel = z.infer<typeof WorkflowModel>;

/** The native GitHub issue type names of model v2. */
export const IssueTypeV2 = z.enum([
  "Doc",
  "ADR",
  "Epic",
  "UserStory",
  "DesignTask",
  "DevTask",
  "QATask",
  "Bug",
]);
export type IssueTypeV2 = z.infer<typeof IssueTypeV2>;

export const ProjectStatusV2 = z.enum([
  "Draft",
  "Awaiting PO",
  "Ready",
  "In progress",
  "In review",
  "Testing",
  "Acceptance",
  "Rework",
  "Blocked",
  "Done",
]);
export type ProjectStatusV2 = z.infer<typeof ProjectStatusV2>;

export const RoleV2 = z.enum([
  "software-engineer",
  "qa-engineer",
  "uiux-designer",
  "code-reviewer",
  "security-reviewer",
]);
export type RoleV2 = z.infer<typeof RoleV2>;

/** GitHub's relation of a comment author to the repository (GraphQL authorAssociation). */
export const AuthorAssociation = z.enum([
  "OWNER",
  "MEMBER",
  "COLLABORATOR",
  "CONTRIBUTOR",
  "FIRST_TIME_CONTRIBUTOR",
  "FIRST_TIMER",
  "MANNEQUIN",
  "NONE",
]);
export type AuthorAssociation = z.infer<typeof AuthorAssociation>;

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

/** Events the workflow FSM accepts (runtime/task-run/domain/fsm.ts). */
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
  /** No PR to merge (Spike, Issue-only task): no commit, no remote branch, Issue closed. */
  "NO_CODE_VERIFIED",
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
export const GateCheck = z.enum(["format", "lint", "architecture", "build", "test", "scan"]);
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

// ---- Execution profiles: <workspace>/.omi-plugins/omi.config.json (ADR-0002, Feature-0021 #137) ----

/** Harnesses an execution profile can run on (v1: Claude Code only). */
export const Harness = z.enum(["claudecode"]);
export type Harness = z.infer<typeof Harness>;

/** `claude --effort` levels a profile may offer. */
export const ProfileEffort = z.enum(["low", "medium", "high", "xhigh", "max"]);
export type ProfileEffort = z.infer<typeof ProfileEffort>;

/** Name of an environment variable holding a secret: profiles never hold the value itself. */
const envName = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "expected an environment variable name");

/** A gateway sees code and prompts: https only, plain http only to this machine. */
const gatewayUrl = z.url({ protocol: /^https?$/ }).refine((u) => {
  const { protocol, hostname } = new URL(u);
  return protocol === "https:" || ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}, "expected https (http only for localhost)");

export const ProfileAuth = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("subscription"), tokenEnv: envName }),
  z.strictObject({
    type: z.literal("gateway"),
    baseUrl: gatewayUrl,
    scheme: z.enum(["x-api-key", "bearer"]),
    keyEnv: envName,
  }),
]);
export type ProfileAuth = z.infer<typeof ProfileAuth>;

const unique = <T>(a: T[]) => new Set(a).size === a.length;

export const Profile = z.discriminatedUnion("harness", [
  z.strictObject({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "expected lowercase letters, digits, -"),
    harness: z.literal(Harness.enum.claudecode),
    disabled: z.boolean().default(false),
    auth: ProfileAuth,
    models: z
      .array(z.string().regex(/^[\w.:[\]-]{1,100}$/, "expected a model id"))
      .min(1)
      .max(20)
      .refine(unique, "duplicate model"),
    efforts: z.array(ProfileEffort).min(1).refine(unique, "duplicate effort"),
  }),
]);
export type Profile = z.infer<typeof Profile>;

export const ProfilesFile = z.strictObject({
  profiles: z
    .array(Profile)
    .max(20)
    .default([])
    .refine((ps) => unique(ps.map((p) => p.name)), "duplicate profile name"),
});
export type ProfilesFile = z.infer<typeof ProfilesFile>;

/** The pre-ADR-0004 `omi.config.json` (and a YAML `profiles` section): read once by `omi profile import`. */
export const LegacyProfilesFile = ProfilesFile;
export type LegacyProfilesFile = ProfilesFile;

/** A profile row of `state.sqlite`: the contract fields plus the metadata of its sealed token. */
export const StoredProfile = z.strictObject({
  profile: Profile,
  /** The sealed token exists; its ciphertext never leaves the persistence layer's callers. */
  hasToken: z.boolean(),
  keyFingerprint: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type StoredProfile = z.infer<typeof StoredProfile>;

/** What `omi profile list --output json` and the web show: no token, no ciphertext, no key. */
export const ProfileView = z.strictObject({
  name: z.string(),
  harness: Harness,
  disabled: z.boolean(),
  auth: ProfileAuth,
  models: z.array(z.string()),
  efforts: z.array(ProfileEffort),
  hasToken: z.boolean(),
  keyFingerprint: z.string().nullable(),
  updatedAt: z.iso.datetime(),
});
export type ProfileView = z.infer<typeof ProfileView>;

/** `omi profile add`: a whole profile; the token only ever arrives on stdin. */
export const ProfileWrite = Profile;
export type ProfileWrite = z.infer<typeof ProfileWrite>;

/** `omi profile edit`: any subset of the mutable fields. The name is immutable (ARC-006). */
export const ProfileEdit = z.strictObject({
  disabled: z.boolean().optional(),
  auth: ProfileAuth.optional(),
  models: z
    .array(z.string().regex(/^[\w.:[\]-]{1,100}$/, "expected a model id"))
    .min(1)
    .max(20)
    .refine(unique, "duplicate model")
    .optional(),
  efforts: z.array(ProfileEffort).min(1).refine(unique, "duplicate effort").optional(),
});
export type ProfileEdit = z.infer<typeof ProfileEdit>;

/**
 * How a harness run said its profile is out of quota (#218, Spike-0009 Q4): a subscription sends
 * `rate_limit_event` with `status=rejected` and/or fails with 429; a gateway only fails with 402.
 */
export const QuotaSignal = z.enum(["rate_limit_rejected", "http_429", "http_402"]);
export type QuotaSignal = z.infer<typeof QuotaSignal>;

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

/** Default name of the env variable holding the profile master key (ADR-0004 D4). */
export const DEFAULT_KEY_ENV = "OMI_SECRET_KEY";

/** Repo-relative path from untrusted agent output: no absolute paths, no traversal. */
export const relPath = z
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
  /** Sections (or the whole body, `body`) dropped or cut by the budget, with their lost size. */
  omitted: z
    .array(z.strictObject({ section: z.string().max(200), chars: z.int().positive() }))
    .optional(),
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
  /** The architecture contract's part for this scope (ADR-0006); absent when the repo has none. */
  architecture: ArchitectureExcerpt.optional(),
  /** An earlier attempt of this step was cut (quota, crash): its edits may be in the worktree. */
  priorAttemptCut: z.literal(true).optional(),
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
  thinkingTokens: z.int().min(0).optional(),
  /** Host `total_cost_usd`: computed from list prices, an estimate behind a gateway. */
  costUsd: z.number().min(0).optional(),
  numTurns: z.int().min(0).optional(),
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
  "unblock",
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
    /** Execution profile the Coordinator chose and why (Feature-0021 #137); absent = routing. */
    profile: z.string().max(40).optional(),
    selectionReason: text(500).optional(),
    /** Skills installed for the step (DevTask-0065 #199): role defaults + chosen + rework. */
    skills: z
      .array(z.string().regex(/^[a-z0-9-]{1,60}$/))
      .max(30)
      .optional(),
    /** A thinking block was seen in the transcript: the observable trace of effort. */
    thinkingObserved: z.boolean().optional(),
    commitSha: sha.optional(),
    status: StepOutcome,
    summary: text(2000),
    changedFiles: z.array(relPath).max(500).default([]),
    evidencePaths: z.array(relPath).max(100).default([]),
    findings: z.array(Finding).max(100).default([]),
    /** Host-observed `<tool>:<command|path>` the agent was refused (#252); shown under Evidence. */
    permissionDenials: z.array(text(300)).max(50).optional(),
    /** Runtime notes, e.g. a text field cut to its limit; shown under Evidence. */
    warnings: z.array(text(300)).max(20).optional(),
    /** Host-observed tokens and wall time of the step (spec §14 cost measurement). */
    usage: TokenUsage.optional(),
    durationMs: z.int().min(0).optional(),
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
    /** Task without code: no PR, no remote branch, no commit (stands in for the merge). */
    noCode: z.literal(true).optional(),
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
  .refine((r) => r.state !== "COMPLETED" || r.pr?.merged || r.noCode, {
    message: "COMPLETED requires a verified merge (or a verified task without code)",
    path: ["pr", "merged"],
  })
  .refine((r) => (r.state === "COMPLETED") === r.steps.every((s) => s.status !== "failed"), {
    message: "state must be CLEANUP_FAILED exactly when a step failed",
    path: ["state"],
  });
export type CleanupResult = z.infer<typeof CleanupResult>;

// ---- Context at session start (`omi context plan`, DevTask-0066 #201) ----

/** What a `/context` row belongs to; `apply` (#202) has a setting per kind except agent. */
export const ContextItemKind = z.enum(["plugin", "skill", "mcp", "memory", "agent"]);
export type ContextItemKind = z.infer<typeof ContextItemKind>;

/** OMI needs it, does not need it, or the PO decides. */
export const ContextClass = z.enum(["needed", "unneeded", "unknown"]);
export type ContextClass = z.infer<typeof ContextClass>;

const tokens = z.int().min(0);

/** Parsed `/context` output of `claude -p` (markdown tables, no model call). */
export const ContextUsage = z.strictObject({
  total: tokens,
  /** Category rows ("System tools", "Skills", ...): reported, not switchable as such. */
  categories: z.array(z.strictObject({ name: text(100), tokens })).max(50),
  items: z
    .array(
      z.strictObject({
        kind: ContextItemKind,
        id: text(500),
        source: z.string().max(200),
        tokens,
      }),
    )
    .max(1000),
});
export type ContextUsage = z.infer<typeof ContextUsage>;

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
