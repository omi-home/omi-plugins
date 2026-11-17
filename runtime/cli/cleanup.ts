// `omi cleanup scan` / `omi cleanup apply --safe` (spec §14, T4.5): startup reconciliation after
// a crash. Scan only reads. Apply acts only on what is positively verified: attempts left open
// by a dead session (no live run lease), reports persisted but not posted, and runs whose PR
// GitHub reports merged (finalized through the same safe path as `omi task finalize`).
// Orphan worktrees are reported, never removed; nothing is ever forced.

import { existsSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { type GhRunner, spawnGh } from "../adapters/github/client.ts";
import { prFacts, receiptOf } from "../adapters/github/merge.ts";
import { OmiError } from "../core/errors/errors.ts";
import { openState, statePath } from "../persistence/db.ts";
import {
  claimedRefs,
  leaseActive,
  liveRefs,
  openAttempts,
  openRuns,
  ownedRefs,
  pendingCount,
  recoverAttempts,
} from "../persistence/repository.ts";
import { publishPending } from "../reporting/outbox.ts";
import { git, listWorktrees, same } from "../resources/worktree.ts";
import { repo, taskFinalize } from "./task.ts";

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
  const { root, config } = repo(deps.cwd);
  const db = openState(statePath(deps.cwd));
  try {
    const runs = openRuns(db).map((run): ScanRun => {
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
        openAttempts: openAttempts(db, run.id).length,
        leased: leaseActive(db, runLease(run)),
      };
    });
    const omiRoot = resolve(root, config.git.worktreeRoot, config.github.repo);
    const owned = liveRefs(db, "worktree");
    const listed = listWorktrees(root);
    const orphans = listed
      .filter((w) => {
        const rel = relative(omiRoot, w.path);
        return (
          rel && !rel.startsWith("..") && !isAbsolute(rel) && !owned.some((p) => same(p, w.path))
        );
      })
      .map((w) => w.path);
    return { runs, orphans, prunable: listed.filter((w) => w.prunable).map((w) => w.path) };
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
        const f = taskFinalize({ cwd: deps.cwd, gh }, r.issue);
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
