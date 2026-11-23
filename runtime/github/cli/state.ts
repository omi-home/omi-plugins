// `omi move`, `omi close --not-planned` and `omi validate` under model v2 (Feature-0039 #298, ADR-0005 D2):
// argument checks and human output. The dispatcher (runtime/cli/main.ts) routes the command and wraps
// the result in its envelope. `omi` is the only writer of the Project; nothing is written under `legacy`.
import { type OmiConfig, repo, workflowModel } from "../../shared/config.ts";
import { ProjectStatusV2 } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, spawnGh } from "../../shared/github/client.ts";
import { type Db, openState, statePath } from "../../shared/sqlite/db.ts";
import type { Workflow } from "../../shared/workflow.ts";
import { addDependency } from "../adapters/dependency.ts";
import { fetchProjectIssues, fetchProjectModel } from "../adapters/project-fetch.ts";
import { applyWrites, closeIssueAs, commentOn } from "../adapters/project-write.ts";
import { readSnapshot, writeSnapshot } from "../adapters/snapshot-store.ts";
import { loadWorkflow } from "../application/load-workflow.ts";
import { buildProjectModel } from "../domain/build-model.ts";
import { type ItemWrite, planMove, validateFetched } from "../domain/move-plan.ts";
import type { ProjectModel } from "../domain/project-model.ts";
import type { SnapshotItem } from "../domain/project-snapshot.ts";
import type { GithubCliResult } from "./github.ts";
import { parentArg } from "./github.ts";

export interface StateDeps {
  config: OmiConfig;
  workflow: Workflow;
  /** Opens state.sqlite (called only when the snapshot is touched). */
  db: () => Db;
  run?: GhRunner;
  now?: Date;
}

/** The deps of the workspace containing `cwd`: its config, workflow and state.sqlite. */
export function stateDeps(cwd: string): StateDeps {
  const r = repo(cwd);
  return {
    config: r.config,
    workflow: loadWorkflow(r.workspace),
    db: () => openState(statePath(cwd)),
  };
}

const lines = (l: string[]) => l.map((s) => `${s}\n`).join("");

/** The state commands exist only under `github.model: v2`; under `legacy` nothing is read or written. */
function requireV2(config: OmiConfig, command: string): void {
  if (workflowModel(config) !== "v2") {
    throw new OmiError(
      "CONFIG_INVALID",
      `omi ${command} needs github.model: v2 (this workspace uses ${workflowModel(config)}); nothing was changed`,
    );
  }
}

/**
 * Records `patches` in the snapshot of the last sync, leaving every other item as it was so that
 * changes the PO made since are still seen by the next sync. With no snapshot yet there is nothing to
 * keep consistent: it stays absent (the first sync writes it).
 */
function recordSnapshot(deps: StateDeps, patches: readonly SnapshotItem[]): boolean {
  if (!patches.length) return false;
  const { owner, repo, projectNumber } = deps.config.github;
  const key = `${owner}/${repo}`;
  const db = deps.db();
  const current = readSnapshot(db, key, projectNumber);
  if (current === null) return false;
  const merged = new Map(current.map((i) => [i.number, i]));
  for (const p of patches) merged.set(p.number, p);
  writeSnapshot(db, key, projectNumber, [...merged.values()], deps.now);
  return true;
}

const snapshotOf = (model: ProjectModel, w: ItemWrite): SnapshotItem => {
  const it = model.find((i) => i.number === w.issue);
  const state = w.stateChange
    ? w.stateChange === "close"
      ? "closed"
      : "open"
    : (it?.state ?? "open");
  const closeReason = w.stateChange
    ? w.stateChange === "close"
      ? ("completed" as const)
      : undefined
    : it?.closeReason;
  return {
    number: w.issue,
    status: w.to,
    state,
    ...(state === "closed" && closeReason ? { closeReason } : {}),
  };
};

/**
 * `omi move <n> <status> [--reason <text>] [--on <m>]`. Only a `by: coordinator` transition is made;
 * then the `auto` rules cascade (fixpoint), Statuses and open/closed states are written and the snapshot
 * updated. Moving to Blocked needs `--on <m>`: the blocked-by dependency it records is what lets the
 * Issue leave Blocked (`blockers_done`) — without a blocker the next fixpoint would release it at once.
 * Running it again changes nothing.
 */
export function issueMove(
  issue: number,
  statusArg: string | undefined,
  opts: { reason?: string | undefined; on?: string | undefined },
  deps: StateDeps,
): GithubCliResult {
  requireV2(deps.config, "move");
  const to = ProjectStatusV2.safeParse(statusArg);
  if (!to.success) {
    throw new OmiError("USAGE_INVALID", `expected a status: ${ProjectStatusV2.options.join(", ")}`);
  }
  const { config, workflow, run = spawnGh } = deps;
  if (opts.on !== undefined && to.data !== "Blocked") {
    throw new OmiError("USAGE_INVALID", "--on <m> applies only when moving to Blocked");
  }
  if (to.data === "Blocked" && opts.on === undefined) {
    throw new OmiError(
      "USAGE_INVALID",
      "moving to Blocked needs --on <m|owner/repo#m>: the Issue it is blocked by",
    );
  }
  const blocker = opts.on === undefined ? undefined : parentArg(opts.on, config.github, "--on");
  let model = fetchProjectModel(config, run).items;
  planMove(model, issue, to.data, workflow); // refuses before anything is written
  let dependency: ReturnType<typeof addDependency> | undefined;
  if (blocker) {
    dependency = addDependency(
      { owner: config.github.owner, repo: config.github.repo, number: issue },
      blocker,
      run,
    );
    model = fetchProjectModel(config, run).items;
  }
  const plan = planMove(model, issue, to.data, workflow);
  const patches: SnapshotItem[] = [];
  try {
    applyWrites(config, plan.writes, (w) => patches.push(snapshotOf(model, w)), run);
  } finally {
    if (patches.length) recordSnapshot(deps, patches);
  }
  const moved = plan.writes.some((w) => w.issue === issue);
  if (opts.reason && moved) {
    commentOn(config, issue, `omi move: ${plan.from} -> ${plan.to}\n\n${opts.reason}`, run);
  }
  const human = [
    ...plan.writes.map(
      (w) =>
        `status    #${w.issue}: ${w.from} -> ${w.to}${w.stateChange ? ` (${w.stateChange === "close" ? "closed" : "reopened"})` : ""}`,
    ),
    ...(plan.writes.length ? [] : [`status    #${issue}: already ${plan.to}, nothing to change`]),
    ...(dependency
      ? [
          `depend    ${dependency.issue} blocked by ${dependency.blockedBy}${dependency.added ? "" : " (existing)"}`,
        ]
      : []),
    ...(opts.reason && moved ? ["comment   reason posted"] : []),
  ];
  return {
    data: { ...plan, dependency, commented: Boolean(opts.reason && moved) },
    human: lines(human),
  };
}

/** `omi close <n> --not-planned`: closes as not planned (rejected ADR, Bug not fixed, duplicate). */
export function issueClose(
  issue: number,
  notPlanned: boolean | undefined,
  deps: StateDeps,
): GithubCliResult {
  requireV2(deps.config, "close");
  if (!notPlanned) {
    throw new OmiError(
      "USAGE_INVALID",
      "omi close needs --not-planned (completed closes come from omi move)",
    );
  }
  const { config, run = spawnGh } = deps;
  const it = fetchProjectModel(config, run).items.find((i) => i.number === issue);
  if (!it) {
    throw new OmiError("TICKET_NOT_IN_PROJECT", `#${issue} is not an item of the Project model`);
  }
  if (it.state === "closed") {
    if (it.closeReason === "not_planned") {
      return {
        data: { issue, closed: false, reason: "not_planned" },
        human: `close     #${issue}: already closed as not planned\n`,
      };
    }
    throw new OmiError("INVALID_TRANSITION", `#${issue} is already closed as completed`, {
      reason: "ALREADY_CLOSED",
      issue,
    });
  }
  closeIssueAs(config, issue, "not_planned", run);
  recordSnapshot(deps, [
    { number: issue, status: it.status, state: "closed", closeReason: "not_planned" },
  ]);
  return {
    data: { issue, closed: true, reason: "not_planned" },
    human: `close     #${issue}: closed as not planned\n`,
  };
}

/** `omi validate`: read-only; exit 1 (failed) with any finding. */
export function issueValidate(deps: StateDeps): GithubCliResult {
  requireV2(deps.config, "validate");
  const { issues, foreign } = fetchProjectIssues(deps.config, deps.run ?? spawnGh);
  const report = validateFetched(
    issues,
    (items) => buildProjectModel(items, deps.workflow),
    deps.workflow,
  );
  const human = [
    ...report.findings.map((f) => `${f.kind.padEnd(18)} ${f.message}`),
    ...report.skipped.map((s) => `skipped            #${s.number}: ${s.reason}`),
    ...foreign.map((f) => `foreign            ${f} (other repository: left out)`),
    ...(report.findings.length ? [] : ["valid              no findings"]),
  ];
  return {
    data: { ok: report.findings.length === 0, ...report, foreign },
    human: lines(human),
    failed: report.findings.length > 0,
  };
}
