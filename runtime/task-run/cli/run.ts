// `omi task run <n>`: start (idempotent) then drive review and QA until PR_PENDING or a person is
// needed (WAITING_PO, BLOCKED); the Project Status then mirrors the workflow state (#99).
// Spawns agent processes: this command spends tokens.
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { type StatusChange, setStatus } from "../../github/adapters/project.ts";
import { closeIssueAs } from "../../github/adapters/project-write.ts";
import { type EngineOutcome, isV2, lifecycleSync } from "../../github/cli/lifecycle.ts";
import { writeSection } from "../../handoff/adapters/context.ts";
import { loadProfiles, profileSecretResolver } from "../../profile/adapters/profile-config.ts";
import { type Selection, selectProfile } from "../../profile/domain/selection.ts";
import { type OmiConfig, repo } from "../../shared/config.ts";
import type { WorkflowContext } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, spawnGh } from "../../shared/github/client.ts";
import { PLUGIN_ROOT } from "../../shared/plugin-paths.ts";
import { openState, statePath } from "../../shared/sqlite/db.ts";
import { fetchTicket, type Ticket } from "../../ticket/adapters/ticket.ts";
import { acquireLease, getRun, releaseLease } from "../adapters/repository.ts";
import { parseSkillChoice } from "../adapters/role-files.ts";
import {
  lastStepError,
  type QaOutcome,
  runQa,
  runSlice,
  type SliceDeps,
} from "../application/slice.ts";
import { PROJECT_STATUS } from "../domain/fsm.ts";
import { planWorkflow, type WorkflowPlan } from "../domain/plan.ts";
import type { RunRow } from "../domain/run.ts";
import { commandEnvFor, type ReportDeps, RUN_LEASE_MS, type TaskDeps } from "./common.ts";
import { typeOf } from "./gates.ts";
import { harnessOf, taskRunPorts } from "./ports.ts";
import { taskStart } from "./start.ts";

export interface RunResult {
  run: RunRow;
  state: WorkflowContext["state"];
  round: number;
  status: StatusChange | null;
  /** github.model v2: the `omi sync` that replaced the direct Status write. */
  engine?: EngineOutcome;
  /** github.model v2, `task analyze`: the `omi move <n> "In progress"` made before the agents ran. */
  move?: EngineOutcome;
  /** A read-only QATask run: the verdict; on PASSED the Issue is closed and `task finalize` follows. */
  qa?: QaOutcome;
  /** Why the last agent attempt failed technically, when the run ended BLOCKED (#121). */
  error?: { code: string; message: string; file: string };
}

/** `--profile/--model/--effort/--reason` of `task run`/`task analyze` (#217). */
export interface PickFlags {
  profile?: string;
  model?: string;
  effort?: string;
  reason?: string;
  /** `--skills <role>=<a>,<b>` (#199). */
  skills?: string[];
}

export type AgentRunDeps = TaskDeps &
  ReportDeps &
  Pick<SliceDeps, "runAgent" | "hostEnv"> & {
    pick?: PickFlags;
    harnessVersion?: () => string | undefined;
  };

export function taskRun(deps: AgentRunDeps, issue: number): RunResult {
  const gh = deps.gh ?? spawnGh;
  const { workspace, config } = repo(deps.cwd);
  // A bad choice is refused before anything starts.
  const selection = selectProfile(
    loadProfiles(workspace, deps.hostEnv ?? process.env),
    deps.pick ?? {},
    profileSecretResolver(workspace, deps.hostEnv ?? process.env),
  );
  const skills = parseSkillChoice(PLUGIN_ROOT, deps.pick?.skills, deps.pick?.reason);
  // Plan first: a bad role label or a non-delivery type fails before any worktree exists.
  const ticket = fetchTicket(config, issue, gh);
  const plan = planFor(config, ticket, gh);
  const repoName = `${config.github.owner}/${config.github.repo}`.toLowerCase();
  const parent =
    ticket.parent && ticket.parent.repository.nameWithOwner.toLowerCase() === repoName
      ? ticket.parent.number
      : undefined;
  if (plan.kind !== "delivery" && plan.kind !== "qa") {
    throw new OmiError("POLICY_VIOLATION", `${plan.workflow}: use \`omi task analyze ${issue}\``);
  }
  harnessGate(deps, selection);
  const start = taskStart(deps, issue);
  const file = statePath(deps.cwd);
  const db = openState(file);
  const lease = `task:${start.run.repository}#${issue}`;
  const session = deps.session ?? randomUUID();
  try {
    acquireLease(db, { key: lease, holder: session, ttlMs: RUN_LEASE_MS });
    const evidenceDir = join(dirname(file), "evidence", start.run.id);
    try {
      const sliceDeps: SliceDeps = {
        db,
        config,
        gh,
        pluginRoot: PLUGIN_ROOT,
        evidenceDir,
        ports: { ...taskRunPorts, reports: deps.reports },
        harness: harnessOf(selection),
        runAgent: deps.runAgent,
        hostEnv: deps.hostEnv,
        commandEnv: commandEnvFor(workspace, deps.hostEnv ?? process.env),
        selection,
        skills,
        writeSection: (section, md) => writeSection(config, issue, section, md, gh),
        closeIssue: () => closeIssueAs(config, issue, "completed", gh),
      };
      const target = {
        run: start.run,
        worktree: start.workspace.path,
        taskRoot: dirname(start.workspace.path),
        baseSha: start.workspace.baseSha,
      };
      // A QATask is read-only: no commit, no PR; PASSED closes the Issue and finalize cleans up.
      const done =
        plan.kind === "qa"
          ? runQa(sliceDeps, { ...target, plan, parent })
          : { ctx: runSlice(sliceDeps, { ...target, plan }) };
      const ctx = done.ctx;
      const closed = done.qa?.verdict === "PASSED";
      // v2: `omi sync` after the agent's result (In review / Done are `auto` rules); legacy: mirror.
      const v2 = isV2(config);
      const engine = v2 ? lifecycleSync({ cwd: deps.cwd, gh, state: deps.state }) : undefined;
      const status = v2 || closed ? null : setStatus(config, issue, PROJECT_STATUS[ctx.state], gh);
      return {
        run: getRun(db, start.run.id) as RunRow,
        state: ctx.state,
        round: ctx.round,
        status,
        ...(done.qa ? { qa: done.qa } : {}),
        ...(engine ? { engine } : {}),
        ...blockedBy(ctx.state, evidenceDir),
      };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}

/**
 * The harness must be in the verified range before any agent runs (#219). An injected runner
 * (tests) or a harness passed in `deps` decides without spawning the real CLI.
 */
export function harnessGate(
  deps: Pick<SliceDeps, "runAgent"> & { harnessVersion?: () => string | undefined },
  selection: Selection | undefined,
): void {
  if (deps.runAgent && !deps.harnessVersion) return;
  const h = harnessOf(selection);
  const why = h.versionRefusal((deps.harnessVersion ?? (() => h.version()))());
  if (why) throw new OmiError("CONFIG_INVALID", `${why}: see \`omi doctor\``);
}

export const blockedBy = (state: WorkflowContext["state"], evidenceDir: string) => {
  const error = state === "BLOCKED" ? lastStepError(evidenceDir) : undefined;
  return error ? { error } : {};
};

/** Workflow plan from the Issue's type and labels, plus its parent's type (Bug → Bug Resolution). */
export function planFor(config: OmiConfig, ticket: Ticket, gh: GhRunner): WorkflowPlan {
  const type = typeOf(ticket);
  if (!type) throw new OmiError("TICKET_INVALID", `#${ticket.number} has no single type:* label`);
  const repoName = `${config.github.owner}/${config.github.repo}`;
  const parent = ticket.parent;
  const parentType =
    parent && parent.repository.nameWithOwner.toLowerCase() === repoName.toLowerCase()
      ? (typeOf(fetchTicket(config, parent.number, gh)) ?? null)
      : null;
  return planWorkflow({
    type,
    labels: ticket.labels.nodes.map((l) => l.name),
    parentType,
    qaDesignLabel: config.qa.designLabel,
  });
}
