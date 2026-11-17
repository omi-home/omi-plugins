// `omi ticket validate`, `omi task start`, `omi task status` (spec §7–§8): ticket gates →
// run (FSM CREATED → TICKET_VALIDATED → WORKSPACE_READY) → owned worktree → Project status.
// No LLM call anywhere in setup.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { type GhRunner, spawnGh } from "../adapters/github/client.ts";
import { markStarted, type StatusChange } from "../adapters/github/project.ts";
import { fetchTicket, type Ticket, validateTicket } from "../adapters/github/ticket.ts";
import { loadConfig, type OmiConfig } from "../core/config.ts";
import { type Check, IssueType, type WorkflowEventType } from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";
import { type Db, openState, statePath } from "../persistence/db.ts";
import {
  acquireLease,
  adoptResources,
  advanceRun,
  createRun,
  latestRun,
  liveRun,
  ownedRefs,
  type RunRow,
  releaseLease,
  transitions,
} from "../persistence/repository.ts";
import { branchName, ensureWorktree, type Workspace } from "../resources/worktree.ts";

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
  "bug",
];
const START_LEASE_MS = 10 * 60_000;

function repo(cwd: string): { root: string; config: OmiConfig } {
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

const typeOf = (t: Ticket) => {
  const labels = t.labels.nodes.map((l) => /^type:(.+)$/.exec(l.name)?.[1]).filter(Boolean);
  return labels.length === 1 ? IssueType.safeParse(labels[0]).data : undefined;
};

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
            detail: `${type} issues do not get a task branch/worktree`,
          },
    );
  }
  return checks;
}

export function ticketValidate(deps: TaskDeps, issue: number): Check[] {
  // Read-only: no state database is opened or created.
  const { config } = repo(deps.cwd);
  return startGates(fetchTicket(config, issue, deps.gh ?? spawnGh), config);
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
      const checks = startGates(ticket, config);
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
