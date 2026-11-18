// `omi ticket validate`, `omi task start`, `omi task status` (spec §7–§8): ticket gates →
// run (FSM CREATED → TICKET_VALIDATED → WORKSPACE_READY) → owned worktree → Project status.
// No LLM call anywhere in setup.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type GhRunner, graphql, spawnGh } from "../adapters/github/client.ts";
import { writeSection } from "../adapters/github/context.ts";
import {
  type MergeReceipt,
  mergeEligibility,
  mergePr,
  prFacts,
  RISK_CHECK,
  receiptOf,
} from "../adapters/github/merge.ts";
import {
  closingIssues,
  createPr,
  markedPrimaries,
  type PullRequest,
  prBody,
  repoFacts,
  sleepSync,
  validatePr,
} from "../adapters/github/pr.ts";
import {
  markFinished,
  markStarted,
  type StatusChange,
  setStatus,
} from "../adapters/github/project.ts";
import { fetchTicket, type Ticket, validateTicket } from "../adapters/github/ticket.ts";
import { loadConfig, type OmiConfig } from "../core/config.ts";
import {
  type Check,
  type CleanupResult,
  commentMarker,
  type IssueRef,
  type IssueType,
  parseContract,
  SCHEMA_VERSION,
  StepComment,
  type WorkflowContext,
  type WorkflowEventType,
} from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";
import {
  hierarchyChecks,
  type Link,
  labelType,
  loadHierarchy,
  titleCheck,
} from "../core/hierarchy.ts";
import { sectionsCheck } from "../core/issue-forms.ts";
import { PRE_MERGE, PROJECT_STATUS, transition } from "../core/workflow-engine/fsm.ts";
import { planWorkflow, type WorkflowPlan } from "../core/workflow-engine/plan.ts";
import {
  lastStepError,
  runAnalysis,
  runSlice,
  type SliceDeps,
} from "../core/workflow-engine/slice.ts";
import { type Db, openState, statePath } from "../persistence/db.ts";
import {
  acquireLease,
  addArtifact,
  adoptResources,
  advanceRun,
  claimedRefs,
  createRun,
  enqueueReport,
  getRun,
  latestRun,
  liveRun,
  ownedRefs,
  type RunRow,
  releaseLease,
  runContext,
  transitions,
  upsertReport,
} from "../persistence/repository.ts";
import { publishPending } from "../reporting/outbox.ts";
import { renderStepReport } from "../reporting/render.ts";
import { applyRetention, cleanupRun } from "../resources/cleanup.ts";
import { branchName, ensureWorktree, git, type Workspace } from "../resources/worktree.ts";

export interface TaskDeps {
  cwd: string;
  gh?: GhRunner;
  /** Identifies this CLI invocation for the per-Issue start lease. */
  session?: string;
}

/** Types that own a branch + worktree. Containers and Release (develop → main) do not. */
const EXECUTABLE: readonly IssueType[] = [
  "dev-task",
  "test-task",
  "devops-task",
  "documentation-task",
  "spike",
];
const START_LEASE_MS = 10 * 60_000;
/** A whole review loop may run several agents back to back. */
const RUN_LEASE_MS = 6 * 60 * 60_000;
const PLUGIN_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");

export function repo(cwd: string): { root: string; config: OmiConfig } {
  let common: string;
  try {
    common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new OmiError("CONFIG_INVALID", "not inside a git repository");
  }
  // Main checkout, even when called from inside a task worktree.
  const root = dirname(resolve(common));
  return { root, config: loadConfig(root) };
}

const typeOf = (t: Ticket) => labelType(t.labels.nodes);

/**
 * Parent chain of `t` inside the configured repository, nearest first. Stops at a repeated
 * Issue (a cycle, kept so the check reports it) or one level past the maximum depth.
 * ponytail: one GraphQL call per ancestor; one nested query if deep trees get slow.
 */
function ancestors(config: OmiConfig, t: Ticket, gh: GhRunner, maxDepth: number): Link[] {
  const repoName = `${config.github.owner}/${config.github.repo}`.toLowerCase();
  const out: Link[] = [];
  let p = t.parent;
  while (p && p.repository.nameWithOwner.toLowerCase() === repoName && out.length < maxDepth) {
    const n = p.number;
    const seen = n === t.number || out.some((l) => l.number === n);
    const parent = seen ? undefined : fetchTicket(config, n, gh);
    out.push({ number: n, type: parent && typeOf(parent) });
    p = parent?.parent ?? null;
  }
  return out;
}

/**
 * Definition of Ready (#128): Objective section, title ↔ `type:*`, required sections of the type's Issue Form (#130), hierarchy. Checked when work
 * starts (`task start`, `ticket validate`), not again at PR time: a run already under way keeps
 * the rules it started with.
 */
function readyGates(t: Ticket, config: OmiConfig, gh: GhRunner): Check[] {
  const checks: Check[] = [
    /^#{1,6}\s+\W*(objectives?|mục tiêu)/imu.test(t.body.normalize("NFC"))
      ? { name: "objective", status: "pass", detail: "objective present" }
      : {
          name: "objective",
          status: "fail",
          code: "TICKET_INVALID",
          detail: "no Objective section",
        },
  ];
  const type = typeOf(t);
  if (!type) return checks; // the type gate reports it
  const h = loadHierarchy();
  checks.push(titleCheck(t.title, type), sectionsCheck(t.body, type));
  try {
    checks.push(
      ...hierarchyChecks({ number: t.number, type }, ancestors(config, t, gh, h.maxDepth), h),
    );
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", (e as Error).message);
    checks.push({
      name: "hierarchy",
      status: "fail",
      code: err.code,
      detail: `cannot read the parent chain: ${err.message}`,
    });
  }
  return checks;
}

/** Ticket gates plus "may this Issue own a worktree" (spec §6: work happens on terminal tasks). */
export function startGates(t: Ticket, config: OmiConfig): Check[] {
  const checks = validateTicket(t, config);
  const type = typeOf(t);
  if (type) {
    checks.push(
      EXECUTABLE.includes(type)
        ? { name: "executable", status: "pass", detail: type }
        : {
            name: "executable",
            status: "fail",
            code: "POLICY_VIOLATION",
            detail:
              type === "bug"
                ? "a Bug is fixed through a child DevTask or TestTask: create one and start it"
                : `${type} issues do not get a task branch/worktree`,
          },
    );
  }
  return checks;
}

export function ticketValidate(deps: TaskDeps, issue: number): Check[] {
  // Read-only: no state database is opened or created.
  const { config } = repo(deps.cwd);
  const gh = deps.gh ?? spawnGh;
  const t = fetchTicket(config, issue, gh);
  return [...startGates(t, config), ...readyGates(t, config, gh)];
}

function step(db: Db, r: RunRow, type: Exclude<WorkflowEventType, "TECHNICAL_FAILURE">): RunRow {
  return advanceRun(db, r.id, { type }).run;
}

export interface StartResult {
  run: RunRow;
  workspace: Workspace;
  checks: Check[];
  status: StatusChange[];
}

export function taskStart(deps: TaskDeps, issue: number): StartResult {
  const gh = deps.gh ?? spawnGh;
  const { root, config } = repo(deps.cwd);
  const db = openState(statePath(deps.cwd));
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const lease = `task:${ref.repository}#${issue}`;
  const session = deps.session ?? randomUUID();
  try {
    // Two sessions starting the same Issue: the second waits for (or reports) this one.
    acquireLease(db, { key: lease, holder: session, ttlMs: START_LEASE_MS });
    try {
      const ticket = fetchTicket(config, issue, gh);
      const checks = [...startGates(ticket, config), ...readyGates(ticket, config, gh)];
      const bad = checks.find((c) => c.status === "fail");
      if (bad) {
        throw new OmiError(bad.code ?? "TICKET_INVALID", `${bad.name}: ${bad.detail}`, {
          checks,
        });
      }
      const type = typeOf(ticket) as IssueType; // gates passed: exactly one valid type
      let run =
        liveRun(db, ref) ??
        createRun(db, { id: `${issue}-${randomUUID().slice(0, 8)}`, issue: ref, workflow: type });
      adoptResources(db, { runId: run.id, issue: ref });
      if (run.state === "CREATED") run = step(db, run, "TICKET_VALID");

      // A resumed task keeps its branch even if the Issue title changed since.
      const branch = ownedRefs(db, run.id, "branch")[0] ?? branchName(type, issue, ticket.title);
      const workspace = ensureWorktree(db, {
        repoRoot: root,
        config,
        issue,
        branch,
        runId: run.id,
      });
      if (run.state === "TICKET_VALIDATED") run = step(db, run, "WORKSPACE_CREATED");

      // Last, and idempotent: a failure here leaves a ready workspace and a retry finishes it.
      const status = markStarted(config, issue, gh);
      return { run, workspace, checks, status };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}

export interface TaskStatus {
  run: RunRow | null;
  worktree: { path: string; exists: boolean } | null;
  branch: string | null;
  transitions: ReturnType<typeof transitions>;
}

/** Local state only: no GitHub call. */
export function taskStatus(deps: TaskDeps, issue: number): TaskStatus {
  const { config } = repo(deps.cwd);
  const db = openState(statePath(deps.cwd));
  try {
    const run = latestRun(db, {
      repository: `${config.github.owner}/${config.github.repo}`,
      number: issue,
    });
    if (!run) return { run: null, worktree: null, branch: null, transitions: [] };
    const path = ownedRefs(db, run.id, "worktree")[0];
    return {
      run,
      worktree: path ? { path, exists: existsSync(path) } : null,
      branch: ownedRefs(db, run.id, "branch")[0] ?? null,
      transitions: transitions(db, run.id),
    };
  } finally {
    db.close();
  }
}

export interface UnblockResult {
  run: RunRow;
  state: WorkflowContext["state"];
  by: string;
  status: StatusChange | null;
}

/**
 * `omi task unblock <n> [--reason]` (G6-003, #123): a person clears a BLOCKED run through the
 * FSM (UNBLOCK → its resume point); the step an agent reported BLOCKED runs again on the next
 * `omi task run`. One report comment names who unblocked it and why. No agent is run.
 */
export function taskUnblock(deps: TaskDeps & { reason?: string }, issue: number): UnblockResult {
  const gh = deps.gh ?? spawnGh;
  const { config } = repo(deps.cwd);
  const db = openState(statePath(deps.cwd));
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const lease = `task:${ref.repository}#${issue}`;
  const session = deps.session ?? randomUUID();
  try {
    acquireLease(db, { key: lease, holder: session, ttlMs: START_LEASE_MS });
    try {
      const found = liveRun(db, ref);
      if (found?.state !== "BLOCKED") {
        throw new OmiError(
          "INVALID_TRANSITION",
          `#${issue} is ${found?.state ?? "not running"}: only a BLOCKED run can be unblocked`,
        );
      }
      // Everything that can fail runs before the run moves: a refused unblock changes nothing.
      // Earlier reports first, so the blocking step is REPORT_POSTED when UNBLOCK reopens it.
      publishPending(db, found.id, { gh });
      const by = graphql(
        "{viewer{login}}",
        {},
        z.strictObject({ viewer: z.strictObject({ login: z.string() }) }),
        "github-auth",
        gh,
      ).viewer.login;
      const next = transition(runContext(db, found.id), { type: "UNBLOCK" }); // pure: may throw
      const n = transitions(db, found.id).filter((t) => t.event === "UNBLOCK").length + 1;
      const comment = parseContract(
        StepComment,
        {
          schemaVersion: SCHEMA_VERSION,
          issue: ref,
          workflowRunId: found.id,
          category: "unblock",
          workflow: found.workflow,
          stepId: "unblock",
          stepTitle: "Gỡ block",
          round: Math.min(Math.max(next.round, 1), 4),
          attempt: n, // one comment per unblock
          executor: "omi-cli",
          requestedModel: null,
          actualModel: null,
          requestedEffort: null,
          actualEffort: null,
          status: "PASSED",
          summary: [
            `Unblocked by GitHub user ${by}; resumes in ${next.state}.`,
            `Reason: ${deps.reason?.trim() || "(none given)"}`,
          ].join("\n"),
          nextAction: `\`omi task run ${issue}\` re-runs the step that blocked the run.`,
          executionId: `${found.id}-unblock-${n}`,
          createdAt: new Date().toISOString(),
        },
        "unblock comment",
      );
      const body = renderStepReport(comment);
      const { run, context } = advanceRun(db, found.id, { type: "UNBLOCK" });
      enqueueReport(db, { runId: run.id, marker: commentMarker(comment), body });
      publishPending(db, run.id, { gh }); // a failure leaves it pending: `task run` posts it
      // A failure here leaves the board behind; `omi task run` sets it from the run state.
      const status = setStatus(config, issue, PROJECT_STATUS[context.state], gh);
      return { run, state: context.state, by, status };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}

export interface RunResult {
  run: RunRow;
  state: WorkflowContext["state"];
  round: number;
  status: StatusChange | null;
  /** Why the last agent attempt failed technically, when the run ended BLOCKED (#121). */
  error?: { code: string; message: string; file: string };
}

/**
 * `omi task run <n>`: start (idempotent) then drive review and QA until PR_PENDING or a person is
 * needed (WAITING_PO, BLOCKED); the Project Status then mirrors the workflow state (#99).
 * Spawns agent processes: this command spends tokens.
 */
export function taskRun(
  deps: TaskDeps & Pick<SliceDeps, "runAgent" | "fromSource">,
  issue: number,
): RunResult {
  const gh = deps.gh ?? spawnGh;
  const { config } = repo(deps.cwd);
  // Plan first: a bad role label or a non-delivery type fails before any worktree exists.
  const plan = planFor(config, fetchTicket(config, issue, gh), gh);
  if (plan.kind !== "delivery") {
    throw new OmiError("POLICY_VIOLATION", `${plan.workflow}: use \`omi task analyze ${issue}\``);
  }
  const start = taskStart(deps, issue);
  const file = statePath(deps.cwd);
  const db = openState(file);
  const lease = `task:${start.run.repository}#${issue}`;
  const session = deps.session ?? randomUUID();
  try {
    acquireLease(db, { key: lease, holder: session, ttlMs: RUN_LEASE_MS });
    const evidenceDir = join(dirname(file), "evidence", start.run.id);
    try {
      const ctx = runSlice(
        {
          db,
          config,
          gh,
          pluginRoot: PLUGIN_ROOT,
          evidenceDir,
          runAgent: deps.runAgent,
          fromSource: deps.fromSource,
          writeSection: (section, md) => writeSection(config, issue, section, md, gh),
        },
        {
          run: start.run,
          worktree: start.workspace.path,
          baseSha: start.workspace.baseSha,
          plan,
        },
      );
      const status = setStatus(config, issue, PROJECT_STATUS[ctx.state], gh);
      return {
        run: getRun(db, start.run.id) as RunRow,
        state: ctx.state,
        round: ctx.round,
        status,
        ...blockedBy(ctx.state, evidenceDir),
      };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}

const blockedBy = (state: WorkflowContext["state"], evidenceDir: string) => {
  const error = state === "BLOCKED" ? lastStepError(evidenceDir) : undefined;
  return error ? { error } : {};
};

/** Workflow plan from the Issue's type and labels, plus its parent's type (Bug → Bug Resolution). */
function planFor(config: OmiConfig, ticket: Ticket, gh: GhRunner): WorkflowPlan {
  const type = typeOf(ticket);
  if (!type) throw new OmiError("TICKET_INVALID", `#${ticket.number} has no single type:* label`);
  const repoName = `${config.github.owner}/${config.github.repo}`;
  const parent = ticket.parent;
  const parentType =
    parent && parent.repository.nameWithOwner.toLowerCase() === repoName.toLowerCase()
      ? (typeOf(fetchTicket(config, parent.number, gh)) ?? null)
      : null;
  return planWorkflow({ type, labels: ticket.labels.nodes.map((l) => l.name), parentType });
}

/**
 * `omi task analyze <n>` (PO 2026-11-18): run the analysis workflow of a Feature, Change Request
 * or requirement without a worktree. Analysts read the main checkout; their sections are written
 * into the Issue body; the Issue then waits for the PO (Waiting PO). A held earlier analysis is
 * superseded (cancelled) by the new run. Spends tokens.
 */
export function taskAnalyze(
  deps: TaskDeps & Pick<SliceDeps, "runAgent" | "fromSource">,
  issue: number,
): RunResult {
  const gh = deps.gh ?? spawnGh;
  const { root, config } = repo(deps.cwd);
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const ticket = fetchTicket(config, issue, gh);
  const bad = validateTicket(ticket, config).find((c) => c.status === "fail");
  if (bad) throw new OmiError(bad.code ?? "TICKET_INVALID", `${bad.name}: ${bad.detail}`);
  const plan = planFor(config, ticket, gh);
  if (plan.kind !== "analysis") {
    throw new OmiError("POLICY_VIOLATION", `${plan.workflow}: use \`omi task run ${issue}\``);
  }
  const file = statePath(deps.cwd);
  const db = openState(file);
  const lease = `task:${ref.repository}#${issue}`;
  const session = deps.session ?? randomUUID();
  try {
    acquireLease(db, { key: lease, holder: session, ttlMs: RUN_LEASE_MS });
    try {
      let run = liveRun(db, ref);
      if (run && run.state !== "TICKET_VALIDATED") {
        advanceRun(db, run.id, { type: "CANCEL" }); // superseded by this new analysis
        run = undefined;
      }
      run ??= createRun(db, {
        id: `${issue}-${randomUUID().slice(0, 8)}`,
        issue: ref,
        workflow: typeOf(ticket) as IssueType,
      });
      if (run.state === "CREATED") run = step(db, run, "TICKET_VALID");
      setStatus(config, issue, "Analysis", gh);
      const evidenceOf = (id: string) => join(dirname(file), "evidence", id);
      const ctx = runAnalysis(
        {
          db,
          config,
          gh,
          pluginRoot: PLUGIN_ROOT,
          evidenceDir: evidenceOf(run.id),
          runAgent: deps.runAgent,
          fromSource: deps.fromSource,
          writeSection: (section, md) => writeSection(config, issue, section, md, gh),
        },
        { run, worktree: root, baseSha: git(["rev-parse", "HEAD"], root), plan },
      );
      // Analysis done or an open question: either way the PO decides next.
      const status = setStatus(
        config,
        issue,
        ctx.state === "BLOCKED" ? "Blocked" : "Waiting PO",
        gh,
      );
      return {
        run: getRun(db, run.id) as RunRow,
        state: ctx.state,
        round: ctx.round,
        status,
        ...blockedBy(ctx.state, evidenceOf(run.id)),
      };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}

export interface PrResult {
  pr: PullRequest;
  created: boolean;
  checks: Check[];
  status: StatusChange | null;
}

/**
 * `omi pr create <n>` (spec §8 gate 5): push the task branch from its owned, clean worktree,
 * create or reuse its one PR → `develop`, and verify base, head and exactly one primary Issue.
 * A Release Issue takes the separate `develop → main` path and owns no worktree. No workflow
 * transition here: `omi task run` reaches PR_PENDING through QA.
 */
export function prCreate(
  deps: TaskDeps & { title?: string; body?: string; sleep?: (ms: number) => void },
  issue: number,
): PrResult {
  const gh = deps.gh ?? spawnGh;
  const { config } = repo(deps.cwd);
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const primary = `${ref.repository}#${issue}`;
  const ticket = fetchTicket(config, issue, gh);
  const release = typeOf(ticket) === "release";
  let head = config.git.baseBranch;
  let base = config.git.releaseBranch;
  let tip: string | undefined;
  if (release) {
    if (ticket.state !== "OPEN") throw new OmiError("TICKET_INVALID", `${primary} is closed`);
  } else {
    const bad = startGates(ticket, config).find((c) => c.status === "fail");
    if (bad) throw new OmiError(bad.code ?? "TICKET_INVALID", `${bad.name}: ${bad.detail}`);
    const db = openState(statePath(deps.cwd));
    let worktree: string | undefined;
    try {
      const run = liveRun(db, ref);
      if (!run) throw new OmiError("POLICY_VIOLATION", `no active run for ${primary}: task start`);
      head = ownedRefs(db, run.id, "branch")[0] ?? "";
      worktree = ownedRefs(db, run.id, "worktree")[0];
    } finally {
      db.close();
    }
    if (!head || !worktree || !existsSync(worktree)) {
      throw new OmiError("OWNERSHIP_MISMATCH", `${primary} has no owned branch and worktree`);
    }
    base = config.git.baseBranch;
    if (git(["rev-parse", "--abbrev-ref", "HEAD"], worktree) !== head) {
      throw new OmiError("OWNERSHIP_MISMATCH", `worktree is not on ${head}`, { path: worktree });
    }
    if (git(["status", "--porcelain"], worktree)) {
      throw new OmiError("WORKTREE_DIRTY", "commit or discard changes first", { path: worktree });
    }
    git(["fetch", "--quiet", "origin", base], worktree);
    if (git(["rev-list", "--count", `origin/${base}..HEAD`], worktree) === "0") {
      throw new OmiError("POLICY_VIOLATION", `${head} has no commits ahead of origin/${base}`);
    }
    tip = git(["rev-parse", "HEAD"], worktree);
    git(["push", "--quiet", "-u", "origin", head], worktree);
  }

  let facts = repoFacts(config, head, gh);
  // GitHub moves an existing PR's head to a fresh push asynchronously: re-read briefly.
  const sleep = deps.sleep ?? sleepSync;
  for (
    let delay = 1000;
    tip && facts.open[0] && facts.open[0].headRefOid !== tip && delay <= 8000;
    delay *= 2
  ) {
    sleep(delay);
    facts = repoFacts(config, head, gh);
  }
  if (facts.open.length > 1) {
    throw new OmiError("POLICY_VIOLATION", `${facts.open.length} open PRs from ${head}`);
  }
  const existing = facts.open[0];
  const pr =
    existing ??
    createPr(
      {
        repositoryId: facts.id,
        base,
        head,
        title: deps.title ?? ticket.title,
        body: prBody(ref.repository, issue, deps.body),
      },
      gh,
    );
  const closing =
    base === facts.defaultBranch ? closingIssues(pr.id, { run: gh, sleep: deps.sleep }) : null;
  const checks = validatePr(pr, { primary, base, head, closing });
  if (tip) {
    checks.push(
      pr.headRefOid === tip
        ? { name: "pr-tip", status: "pass", detail: tip.slice(0, 12) }
        : {
            name: "pr-tip",
            status: "fail",
            code: "POLICY_VIOLATION",
            detail: `PR head ${pr.headRefOid.slice(0, 12)} ≠ local ${tip.slice(0, 12)}`,
          },
    );
  }
  const bad = checks.find((c) => c.status === "fail");
  if (bad) {
    throw new OmiError("POLICY_VIOLATION", `${pr.url}: ${bad.name}: ${bad.detail}`, { checks });
  }
  const status = release ? null : setStatus(config, issue, "In Review", gh);
  return { pr, created: !existing, checks, status };
}

export interface TaskPr {
  config: OmiConfig;
  ref: IssueRef;
  primary: string;
  ticket: Ticket;
  head: string;
  base: string;
  /** Local tip of the task branch when its worktree still exists. */
  localTip?: string;
}

/** The task branch of a gated executable Issue, from its live run's owned resources. */
function taskPr(deps: TaskDeps, issue: number): TaskPr {
  const gh = deps.gh ?? spawnGh;
  const { config } = repo(deps.cwd);
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const primary = `${ref.repository}#${issue}`;
  const ticket = fetchTicket(config, issue, gh);
  if (typeOf(ticket) === "release") {
    throw new OmiError("POLICY_VIOLATION", "release PRs (develop → main) are merged by the PO");
  }
  const bad = startGates(ticket, config).find((c) => c.status === "fail");
  if (bad) throw new OmiError(bad.code ?? "TICKET_INVALID", `${bad.name}: ${bad.detail}`);
  const db = openState(statePath(deps.cwd));
  let head: string | undefined;
  let worktree: string | undefined;
  try {
    const run = liveRun(db, ref);
    if (!run) throw new OmiError("POLICY_VIOLATION", `no active run for ${primary}: task start`);
    head = ownedRefs(db, run.id, "branch")[0];
    worktree = ownedRefs(db, run.id, "worktree")[0];
  } finally {
    db.close();
  }
  if (!head) throw new OmiError("OWNERSHIP_MISMATCH", `${primary} has no owned branch`);
  const localTip =
    worktree && existsSync(worktree) ? git(["rev-parse", head], worktree) : undefined;
  return { config, ref, primary, ticket, head, base: config.git.baseBranch, localTip };
}

export interface MergeCheckResult {
  pr: string | null;
  checks: Check[];
}

const METHOD = { squash: "SQUASH", merge: "MERGE", rebase: "REBASE" } as const;

function eligibility(deps: TaskDeps, issue: number) {
  const t = taskPr(deps, issue);
  const facts = prFacts(t.config, { head: t.head, base: t.base, states: ["OPEN"] }, deps.gh);
  const checks = mergeEligibility(facts, {
    primary: t.primary,
    base: t.base,
    method: METHOD[t.config.git.mergeMethod],
    issueLabels: t.ticket.labels.nodes.map((l) => l.name),
    localTip: t.localTip,
    privateRiskAccepted: t.config.github.privateRepoRiskAccepted,
  });
  return { t, facts, checks };
}

/** `omi pr validate <n>`: read-only merge eligibility of the task PR. */
export function prValidate(deps: TaskDeps, issue: number): MergeCheckResult {
  const { facts, checks } = eligibility(deps, issue);
  return { pr: facts.pr?.url ?? null, checks };
}

export interface MergeResult {
  checks: Check[];
  receipt: MergeReceipt;
}

/**
 * `omi pr merge <n>`: the authorized merge path for task PRs. Merges only when every gate
 * passes, with the configured method, pinned to the validated head SHA. A High risk PR goes to
 * the PO instead (run → WAITING_PO, Status Waiting PO) and is never merged here.
 */
export function prMerge(deps: TaskDeps, issue: number): MergeResult {
  const gh = deps.gh ?? spawnGh;
  const { t, facts, checks } = eligibility(deps, issue);
  const failed = checks.filter((c) => c.status === "fail");
  if (failed.some((c) => c.name === RISK_CHECK)) {
    const db = openState(statePath(deps.cwd));
    try {
      const run = liveRun(db, t.ref);
      if (run && PRE_MERGE.includes(run.state)) advanceRun(db, run.id, { type: "ESCALATE_TO_PO" });
    } finally {
      db.close();
    }
    setStatus(t.config, issue, "Waiting PO", gh);
  }
  const bad = failed[0];
  if (bad || !facts.pr) {
    throw new OmiError(
      bad?.code ?? "POLICY_VIOLATION",
      `merge refused: ${bad?.name}: ${bad?.detail}`,
      {
        checks,
      },
    );
  }
  mergePr(
    { prId: facts.pr.id, method: METHOD[t.config.git.mergeMethod], headOid: facts.pr.headRefOid },
    gh,
  );
  const after = prFacts(t.config, { head: t.head, base: t.base, states: ["MERGED"] }, gh);
  const receipt = receiptOf(after.pr);
  if (!receipt || receipt.headSha !== facts.pr.headRefOid) {
    throw new OmiError("GITHUB_UNAVAILABLE", "merge sent but no matching merge receipt yet: retry");
  }
  return { checks, receipt };
}

export interface FinalizeResult {
  run: RunRow;
  receipt: MergeReceipt | null;
  cleanup: CleanupResult | null;
  report: string | null;
  status: StatusChange[];
}

function cleanupComment(run: RunRow, round: number, receipt: MergeReceipt, r: CleanupResult) {
  const failed = r.steps.filter((s) => s.status === "failed");
  const comment: StepComment = {
    schemaVersion: SCHEMA_VERSION,
    issue: { repository: run.repository, number: run.issue },
    workflowRunId: run.id,
    category: "cleanup",
    workflow: run.workflow,
    stepId: "cleanup",
    stepTitle: "Cleanup sau merge",
    round: Math.min(Math.max(round, 1), 4),
    attempt: 1, // one cleanup comment per run: a replay updates it in place
    executor: "omi-cli",
    requestedModel: null,
    actualModel: null,
    requestedEffort: null,
    actualEffort: null,
    status: r.state === "COMPLETED" ? "PASSED" : "FAILED",
    summary: [
      `PR #${receipt.number} merged ${receipt.mergedAt} (head ${receipt.headSha.slice(0, 12)}).`,
      ...r.steps.map(
        (s) => `- ${s.name}: ${s.status}${s.detail ? ` — ${s.detail.slice(0, 120)}` : ""}`,
      ),
    ].join("\n"),
    changedFiles: [],
    evidencePaths: [],
    findings: failed.map((s, i) => ({
      id: `CLN-${String(i + 1).padStart(3, "0")}`,
      severity: "high" as const,
      observed: `${s.name}: ${s.detail ?? "failed"}`,
      expected: "every owned resource verified and released without --force",
    })),
    nextAction:
      r.state === "COMPLETED"
        ? "None: task Done; parents rolled up."
        : "Fix the failed step, then rerun `omi task finalize`; resources were kept.",
    executionId: `${run.id}-cleanup`,
    createdAt: new Date().toISOString(),
    ...(receipt.mergeCommit ? { commitSha: receipt.mergeCommit } : {}),
  };
  return renderStepReport(parseContract(StepComment, comment, "cleanup comment"));
}

/**
 * `omi task finalize <n>` (spec §14 completion flow): merge receipt from GitHub → run PR_MERGED →
 * CLEANUP_PENDING → receipt archived + log retention → safe cleanup (T4.3) → cleanup comment
 * posted → COMPLETED, Done and parent roll-up. Any failure leaves the run short of COMPLETED, so
 * Done is never shown for unverified cleanup; rerunning resumes where it stopped. `dryRun` only
 * reports what cleanup would do.
 */
export function taskFinalize(
  deps: TaskDeps & { dryRun?: boolean; sleep?: (ms: number) => void },
  issue: number,
): FinalizeResult {
  const gh = deps.gh ?? spawnGh;
  const { root, config } = repo(deps.cwd);
  const file = statePath(deps.cwd);
  const db = openState(file);
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const primary = `${ref.repository}#${issue}`;
  const lease = `task:${primary}`;
  const session = deps.session ?? randomUUID();
  try {
    acquireLease(db, { key: lease, holder: session, ttlMs: START_LEASE_MS });
    try {
      let run = liveRun(db, ref) ?? latestRun(db, ref);
      if (!run) throw new OmiError("POLICY_VIOLATION", `no run for ${primary}`);
      const runId = run.id;
      if (run.state === "COMPLETED") {
        // Cleanup and its report are done; only the Project projection may be behind.
        const status = deps.dryRun ? [] : markFinished(config, issue, gh);
        return { run, receipt: null, cleanup: null, report: null, status };
      }
      const branch = claimedRefs(db, runId, "branch")[0];
      if (!branch) throw new OmiError("OWNERSHIP_MISMATCH", `${primary} never owned a branch`);
      const base = config.git.baseBranch;
      const facts = prFacts(config, { head: branch, base, states: ["MERGED"] }, gh);
      const receipt = receiptOf(facts.pr);
      if (!receipt || receipt.baseRef !== base) {
        throw new OmiError("POLICY_VIOLATION", `${branch} has no PR merged into ${base}`);
      }
      const marked = markedPrimaries(facts.pr?.body ?? "");
      // PRs opened before `omi pr create` carry no marker: GitHub's closing link is the proof.
      const named = marked.length
        ? marked.includes(primary)
        : closingIssues(facts.pr?.id ?? "", { run: gh, sleep: deps.sleep }).join() === primary;
      if (!named) {
        throw new OmiError(
          "POLICY_VIOLATION",
          `merged PR #${receipt.number} does not name ${primary}`,
        );
      }
      const cleanOpts = { repoRoot: root, runId, receipt, tempRoot: dirname(file) };
      if (deps.dryRun) {
        const cleanup = cleanupRun(db, { ...cleanOpts, dryRun: true });
        return { run, receipt, cleanup, report: null, status: [] };
      }

      publishPending(db, runId, { gh }); // earlier reports first: progress waits for them
      const state = () => runContext(db, runId).state;
      if ([...PRE_MERGE, "BLOCKED", "WAITING_PO"].includes(state())) {
        advanceRun(db, runId, { type: "MERGE_VERIFIED" });
      }
      if (["PR_MERGED", "CLEANUP_FAILED"].includes(state())) {
        advanceRun(db, runId, { type: "CLEANUP_STARTED" });
      }
      if (state() !== "CLEANUP_PENDING") {
        throw new OmiError("INVALID_TRANSITION", `run ${runId} is ${state()}: cannot finalize`);
      }

      const evidence = join(dirname(file), "evidence", runId);
      mkdirSync(evidence, { recursive: true });
      const receiptFile = join(evidence, "merge-receipt.json");
      if (!existsSync(receiptFile)) {
        writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
        addArtifact(db, { runId, kind: "evidence", path: receiptFile });
      }
      applyRetention(db, {
        evidenceRoot: dirname(evidence),
        days: config.cleanup.logRetentionDays,
      });

      const cleanup = cleanupRun(db, cleanOpts);
      writeFileSync(join(evidence, "cleanup-result.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
      const report = cleanupComment(run, runContext(db, runId).round, receipt, cleanup);
      upsertReport(db, { runId, marker: report.split("\n")[0] as string, body: report });
      publishPending(db, runId, { gh }); // throws: the run stays CLEANUP_PENDING, retry resumes

      if (cleanup.state === "CLEANUP_FAILED") {
        run = advanceRun(db, runId, { type: "CLEANUP_ERROR" }).run;
        const blocked = setStatus(config, issue, PROJECT_STATUS.CLEANUP_FAILED, gh);
        return { run, receipt, cleanup, report, status: blocked ? [blocked] : [] };
      }
      run = advanceRun(db, runId, { type: "CLEANUP_SUCCEEDED" }).run;
      // COMPLETED is recorded first; a failure below is repaired by rerunning finalize.
      const status = markFinished(config, issue, gh);
      return { run, receipt, cleanup, report, status };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}
