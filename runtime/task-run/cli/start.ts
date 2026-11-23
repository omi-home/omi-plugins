// `omi task start` (spec §7–§8): ticket gates → run (FSM CREATED → TICKET_VALIDATED →
// WORKSPACE_READY) → owned worktree → Project status. No LLM call anywhere in setup.
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { markStarted, type StatusChange } from "../../github/adapters/project.ts";
import { type EngineOutcome, isV2, lifecycleStart } from "../../github/cli/lifecycle.ts";
import { repo } from "../../shared/config.ts";
import type { Check, IssueType } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { spawnGh } from "../../shared/github/client.ts";
import { openState, statePath } from "../../shared/sqlite/db.ts";
import { fetchTicket } from "../../ticket/adapters/ticket.ts";
import {
  acquireLease,
  adoptResources,
  createRun,
  liveRun,
  ownedRefs,
  releaseLease,
} from "../adapters/repository.ts";
import { runSetup } from "../adapters/setup.ts";
import { branchName, ensureTaskWorkspace, git, type Workspace } from "../adapters/worktree.ts";
import type { RunRow } from "../domain/run.ts";
import { commandEnvFor, START_LEASE_MS, step, type TaskDeps } from "./common.ts";
import { readyGates, startGates, typeOf } from "./gates.ts";

export interface StartResult {
  run: RunRow;
  workspace: Workspace;
  checks: Check[];
  status: StatusChange[];
  /** github.model v2: the `omi move` that replaced the direct Status writes. */
  engine?: EngineOutcome;
}

export function taskStart(deps: TaskDeps, issue: number): StartResult {
  const gh = deps.gh ?? spawnGh;
  const { root, workspace: omiWorkspace, config } = repo(deps.cwd);
  const db = openState(statePath(deps.cwd));
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const lease = `task:${ref.repository}#${issue}`;
  const session = deps.session ?? randomUUID();
  try {
    // Two sessions starting the same Issue: the second waits for (or reports) this one.
    acquireLease(db, { key: lease, holder: session, ttlMs: START_LEASE_MS });
    try {
      const ticket = fetchTicket(config, issue, gh);
      const ready = readyGates(ticket, config, gh);
      const checks = [...startGates(ticket, config), ...ready.checks];
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
      const branch =
        ownedRefs(db, run.id, "branch")[0] ?? branchName(type, issue, ticket.title, ready.parent);
      const workspace = ensureTaskWorkspace(db, {
        repoRoot: root,
        workspace: omiWorkspace,
        config,
        issue,
        branch,
        runId: run.id,
      });
      // Dependencies before anything runs in the clone; a failure stops here (no agent, no checks)
      // and the next start retries, since nothing is recorded as done.
      runSetup({
        worktree: workspace.path,
        gitDir: git(["rev-parse", "--absolute-git-dir"], workspace.path),
        setup: config.setup,
        logDir: join(dirname(statePath(deps.cwd)), "evidence", run.id, "setup"),
        env: commandEnvFor(omiWorkspace, deps.hostEnv ?? process.env),
      });
      if (run.state === "TICKET_VALIDATED") run = step(db, run, "WORKSPACE_CREATED");

      // Last, and idempotent: a failure here leaves a ready workspace and a retry finishes it.
      // v2: `omi move <n> "In progress"` (the engine is the only Project writer; parents are `auto`).
      if (isV2(config)) {
        const engine = lifecycleStart({ cwd: deps.cwd, gh, state: deps.state }, issue);
        return { run, workspace, checks, status: [], engine };
      }
      const status = markStarted(config, issue, gh);
      return { run, workspace, checks, status };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}
