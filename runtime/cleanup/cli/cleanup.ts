// `omi cleanup scan` / `omi cleanup apply --safe` (spec §14, T4.5): startup reconciliation after
// a crash. Scan only reads. Apply acts only on what is positively verified: attempts left open
// by a dead session (no live run lease), reports persisted but not posted, and runs whose PR
// GitHub reports merged (finalized through the same safe path as `omi task finalize`).
// Orphan task workspaces are reported, never removed; nothing is ever forced.

import { existsSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { prFacts, receiptOf } from "../../release/adapters/merge.ts";
import { publishPending } from "../../reporting/adapters/outbox.ts";
import { stepReports } from "../../reporting/adapters/step-reports.ts";
import { repo } from "../../shared/config.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, spawnGh } from "../../shared/github/client.ts";
import { openState, statePath } from "../../shared/sqlite/db.ts";
import {
  claimedRefs,
  leaseActive,
  liveRefs,
  openAttempts,
  openRuns,
  ownedRefs,
  pendingCount,
  recoverAttempts,
} from "../../task-run/adapters/repository.ts";
import { git, listWorktrees, same } from "../../task-run/adapters/worktree.ts";
import { attemptLiveness, CRASHED_HINT } from "../../task-run/domain/attempt-liveness.ts";
import { taskFinalize } from "./finalize.ts";

export interface ScanRun {
  repository: string;
  issue: number;
  runId: string;
  state: string;
  branch: string | null;
  worktree: { path: string; exists: boolean } | null;
  /** Number of the merged PR from the run's branch; null when none is merged. */
  mergedPr: number | null;
  pendingReports: number;
  openAttempts: number;
  /** Open attempts whose omi process is gone (PID dead): crashed, no need to wait for the lease. */
  crashedAttempts: number;
  /** Open attempts without a usable PID (older state): not judged. */
  unknownAttempts: number;
  /** `omi cleanup apply --safe` when crashedAttempts > 0. */
  hint: string | null;
  /** A live `omi task run` holds the run lease: hands off. */
  leased: boolean;
}

export interface ScanResult {
  runs: ScanRun[];
  /** Worktrees under the OMI root that no live run owns: reported, never removed. */
  orphans: string[];
  /** Registered worktrees whose directory is gone (`git worktree prune` drops them). */
  prunable: string[];
}

const runLease = (r: { repository: string; issue: number }) => `task:${r.repository}#${r.issue}`;

export function cleanupScan(deps: { cwd: string; gh?: GhRunner }): ScanResult {
  const gh = deps.gh ?? spawnGh;
  const { root, workspace, config } = repo(deps.cwd);
  const db = openState(statePath(deps.cwd));
  try {
    const runs = openRuns(db).map((run): ScanRun => {
      const open = openAttempts(db, run.id);
      const live = open.map((a) => attemptLiveness(a));
      const crashed = live.filter((l) => l === "crashed").length;
      const branch = claimedRefs(db, run.id, "branch")[0] ?? null;
      const path = ownedRefs(db, run.id, "worktree")[0];
      const pr = branch
        ? receiptOf(
            prFacts(config, { head: branch, base: config.git.baseBranch, states: ["MERGED"] }, gh)
              .pr,
          )
        : undefined;
      return {
        repository: run.repository,
        issue: run.issue,
        runId: run.id,
        state: run.state,
        branch,
        worktree: path ? { path, exists: existsSync(path) } : null,
        mergedPr: pr && pr.baseRef === config.git.baseBranch ? pr.number : null,
        pendingReports: pendingCount(db, run.id),
        openAttempts: open.length,
        crashedAttempts: crashed,
        unknownAttempts: live.filter((l) => l === "unknown").length,
        hint: crashed ? CRASHED_HINT : null,
        // A run whose open attempts all have a dead process is not driven by anyone, whatever
        // the (6 h) lease still says.
        leased: leaseActive(db, runLease(run)) && !(open.length > 0 && crashed === open.length),
      };
    });
    // Task workspaces are `<workspace>-task-<runId>/` siblings of the workspace.
    const owned = liveRefs(db, "worktree").map((p) => dirname(p));
    const prefix = `${basename(workspace)}-task-`;
    const orphans = readdirSync(dirname(workspace))
      .filter((f) => f.startsWith(prefix))
      .map((f) => join(dirname(workspace), f))
      .filter((p) => !owned.some((o) => same(o, p)));
    // Worktrees of the old layout (before ADR-0002) that git can prune.
    const prunable = listWorktrees(root)
      .filter((w) => w.prunable)
      .map((w) => w.path);
    return { runs, orphans, prunable };
  } finally {
    db.close();
  }
}

export interface ApplyOutcome {
  issue: number;
  runId: string;
  actions: string[];
  error: { code: string; message: string } | null;
}

export interface ApplyResult {
  scan: ScanResult;
  outcomes: ApplyOutcome[];
  pruned: boolean;
}

/**
 * Applies the safe subset of a scan, run by run; one failing run never stops the others.
 * Leased runs are skipped entirely (someone is driving them right now).
 */
export function cleanupApply(deps: { cwd: string; gh?: GhRunner; safe?: boolean }): ApplyResult {
  if (!deps.safe) {
    throw new OmiError("USAGE_INVALID", "cleanup apply only runs with --safe");
  }
  const gh = deps.gh ?? spawnGh;
  const { root } = repo(deps.cwd);
  const scan = cleanupScan(deps);
  const outcomes: ApplyOutcome[] = [];
  for (const r of scan.runs) {
    if (r.leased) continue;
    const out: ApplyOutcome = { issue: r.issue, runId: r.runId, actions: [], error: null };
    try {
      if (r.openAttempts) {
        const db = openState(statePath(deps.cwd));
        try {
          const n = recoverAttempts(db, {
            runId: r.runId,
            leaseKey: runLease(r),
            isDead: (a) => attemptLiveness({ pid: a.pid }) === "crashed",
          });
          if (n) out.actions.push(`recovered ${n} open attempt(s)`);
        } finally {
          db.close();
        }
      }
      if (r.pendingReports) {
        const db = openState(statePath(deps.cwd));
        try {
          out.actions.push(`posted ${publishPending(db, r.runId, { gh })} pending report(s)`);
        } finally {
          db.close();
        }
      }
      if (r.mergedPr) {
        const f = taskFinalize({ cwd: deps.cwd, gh, reports: stepReports }, r.issue);
        out.actions.push(`finalized after PR #${r.mergedPr}: ${f.run.state}`);
      }
    } catch (e) {
      const err = e instanceof OmiError ? e : new OmiError("INTERNAL", "unexpected error");
      out.error = { code: err.code, message: err.message };
    }
    if (out.actions.length || out.error) outcomes.push(out);
  }
  let pruned = false;
  if (scan.prunable.length) {
    git(["worktree", "prune"], root);
    pruned = true;
  }
  return { scan, outcomes, pruned };
}
