// Safe cleanup of one run's owned resources (spec §14, T0.8, ADR-0002 D3). Only what
// `resource_owner` says the run owns is ever touched; each step is check-then-act on observable
// state, so a replay after a crash skips what is already done. Nothing is forced: a dirty,
// symlinked or foreign task workspace, a live process or a missing merge receipt for the clone's
// tip (nothing unpushed is ever deleted) stops the cleanup (CLEANUP_FAILED) and every remaining
// resource is kept for reconciliation.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, rmSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { MergeReceipt } from "../adapters/github/merge.ts";
import {
  type CleanupResult,
  type IssueRef,
  parseContract,
  type ResourceKind,
  CleanupResult as Result,
  SCHEMA_VERSION,
} from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";
import type { Db } from "../persistence/db.ts";
import {
  acquireLease,
  getRun,
  ownedRefs,
  releaseLease,
  releaseResource,
} from "../persistence/repository.ts";
import { git, readMarker, same, tryGit } from "./worktree.ts";

type StepName = CleanupResult["steps"][number]["name"];
type Step = CleanupResult["steps"][number];

export interface CleanupOptions {
  runId: string;
  /** GitHub merge receipt of the task PR; without it nothing destructive happens. */
  receipt: MergeReceipt | undefined;
  /** Directory owned temp dirs must live under (OMI state dir); anything else is refused. */
  tempRoot: string;
  /** Report what would happen; touch nothing. */
  dryRun?: boolean;
  /** Is this PID alive? Injectable for tests. */
  alive?: (pid: number) => boolean;
  /** Runs `docker …`; injectable for tests. */
  docker?: (args: string[]) => { status: number | null; stdout: string };
}

const LEASE_MS = 10 * 60_000;
/** What OMI writes into a task workspace root next to the clone (role files, config dir). */
export const GENERATED = [".claude", ".omi-home", "AGENTS.md", "REPORT.md"];

export const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, not ours to signal
  }
};

const spawnDocker = (args: string[]) => {
  const r = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 60_000 });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "" };
};

class Stop extends Error {}

/**
 * Runs the spec §14 cleanup steps for one run. Returns a CleanupResult whose state is
 * COMPLETED only when every step is done or skipped; the first failure skips everything after
 * it. Concurrent cleanups of the same run are refused (LOCK_HELD).
 */
export function cleanupRun(db: Db, o: CleanupOptions): CleanupResult {
  const run = getRun(db, o.runId);
  if (!run) throw new OmiError("INVALID_TRANSITION", `run ${o.runId} does not exist`);
  const holder = `cleanup-${process.pid}-${Date.now()}`;
  const key = `cleanup:${o.runId}`;
  acquireLease(db, { key, holder, ttlMs: LEASE_MS });
  try {
    return steps(db, o, { repository: run.repository, number: run.issue });
  } finally {
    releaseLease(db, { key, holder });
  }
}

function steps(db: Db, o: CleanupOptions, issue: IssueRef): CleanupResult {
  const alive = o.alive ?? pidAlive;
  const docker = o.docker ?? spawnDocker;
  const owned = (k: ResourceKind) => ownedRefs(db, o.runId, k);
  const release = (kind: ResourceKind, ref: string) => {
    if (!o.dryRun) releaseResource(db, { runId: o.runId, kind, ref });
  };
  const out: Step[] = [];
  const done = (name: StepName, detail?: string) => out.push({ name, status: "done", detail });
  const skip = (name: StepName, detail?: string) => out.push({ name, status: "skipped", detail });
  const failed = (name: StepName, detail: string): never => {
    out.push({ name, status: "failed", detail: detail.slice(0, 500) });
    throw new Stop();
  };
  /** `act` runs only for real; the step reads "would …" on a dry run. */
  const act = (name: StepName, what: string, fn: () => void) => {
    if (o.dryRun) return skip(name, `dry-run: would ${what}`);
    fn();
    done(name, what);
  };

  const branch = owned("branch")[0];
  const worktree = owned("worktree")[0];
  const order: StepName[] = [
    "verify-merge",
    "archive-evidence",
    "stop-processes",
    "clean-temp",
    "verify-clean-worktree",
    "remove-worktree",
    "remove-local-branch",
    "prune-worktrees",
    "verify-freed",
  ];
  // The branch lives only in the run's clone (the task workspace), never in the main checkout.
  const clone = worktree && existsSync(worktree) ? worktree : undefined;
  const tip =
    branch && clone
      ? tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}^{commit}`], clone)
      : undefined;

  try {
    // verify-merge: GitHub receipt for this branch and this tip, never `git branch --merged`.
    const r = o.receipt;
    if (!r) failed("verify-merge", "no merge receipt: the PR is not verified as merged");
    else if (branch && r.headRef !== branch) {
      failed("verify-merge", `receipt is for ${r.headRef}, run owns ${branch}`);
    } else if (tip && tip !== r.headSha) {
      failed(
        "verify-merge",
        `local ${branch} at ${tip.slice(0, 12)} ≠ merged head ${r.headSha.slice(0, 12)}`,
      );
    } else done("verify-merge", `${r.url} merged at ${r.mergedAt}`);

    // archive-evidence: evidence lives in the state dir, outside the worktree; nothing to move.
    skip("archive-evidence", "evidence is kept in the OMI state dir (retention applies)");

    // stop-processes: never kill by PID (it may have been reused); a live one stops cleanup.
    const procs = owned("process");
    for (const ref of procs) {
      const pid = Number(ref);
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) {
        failed("stop-processes", `owned process ${pid} is still running: stop it first`);
      }
    }
    const containers = owned("container");
    for (const id of containers) {
      const label = docker(["inspect", "-f", '{{index .Config.Labels "omi.run"}}', id]);
      if (label.status !== 0) continue; // gone (or no docker): nothing left to stop
      if (label.stdout.trim() !== o.runId) {
        failed("stop-processes", `container ${id} is not labelled omi.run=${o.runId}: not touched`);
      }
    }
    if (!procs.length && !containers.length) skip("stop-processes", "no owned processes");
    else {
      act("stop-processes", `remove ${containers.length} container(s)`, () => {
        for (const id of containers) {
          if (docker(["inspect", id]).status === 0 && docker(["rm", "-f", id]).status !== 0) {
            failed("stop-processes", `docker rm ${id} failed`);
          }
        }
      });
    }
    for (const ref of procs) release("process", ref);
    for (const ref of containers) release("container", ref);

    // clean-temp: only real directories under the OMI state dir; a symlink is never followed.
    const temps = owned("temp-dir");
    for (const dir of temps) {
      const rel = relative(resolve(o.tempRoot), resolve(dir));
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
        failed("clean-temp", `${dir} is outside the OMI state dir: not touched`);
      }
      if (existsSync(dir) && lstatSync(dir).isSymbolicLink()) {
        failed("clean-temp", `${dir} is a symlink: not touched`);
      }
    }
    if (!temps.length) skip("clean-temp", "no owned temp dirs");
    else {
      act("clean-temp", `remove ${temps.length} temp dir(s)`, () => {
        for (const dir of temps) rmSync(dir, { recursive: true, force: true });
      });
    }
    for (const dir of temps) release("temp-dir", dir);

    // verify-clean-worktree: our clone, on our branch, clean, and nothing but OMI's own files
    // around it in the task workspace root.
    const root = worktree ? dirname(worktree) : undefined;
    if (!worktree || !root) skip("verify-clean-worktree", "no owned task workspace");
    else if (!clone) skip("verify-clean-worktree", "task workspace already removed");
    else {
      if (lstatSync(clone).isSymbolicLink() || lstatSync(root).isSymbolicLink()) {
        failed("verify-clean-worktree", "task workspace path is a symlink");
      }
      const top = tryGit(["rev-parse", "--show-toplevel"], clone);
      if (!top || !same(top, clone)) {
        failed("verify-clean-worktree", `${clone} is not a clone`);
      }
      const on = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], clone);
      if (on !== branch) {
        failed("verify-clean-worktree", `clone is on ${on ?? "a detached HEAD"}, not ${branch}`);
      }
      const marker = readMarker(clone);
      if (!marker || marker.repository !== issue.repository || marker.issue !== issue.number) {
        failed("verify-clean-worktree", "ownership marker missing or for another task");
      }
      if (git(["status", "--porcelain", "--untracked-files=all"], clone)) {
        failed("verify-clean-worktree", "clone has uncommitted or untracked files");
      }
      const extra = readdirSync(root).filter(
        (f) => f !== basename(clone) && !GENERATED.includes(f),
      );
      if (extra.length) {
        failed("verify-clean-worktree", `task workspace holds unknown files: ${extra.join(", ")}`);
      }
      done("verify-clean-worktree", clone);
    }

    // remove-worktree: the whole task workspace; its branch goes with the clone.
    if (clone && root) {
      act("remove-worktree", `remove task workspace ${root}`, () => {
        try {
          rmSync(root, { recursive: true, maxRetries: 3 });
        } catch {
          failed("remove-worktree", `could not remove ${root} (files in use?)`);
        }
      });
    } else skip("remove-worktree", "nothing to remove");

    // remove-local-branch: only in the clone, removed with it.
    if (branch && tip)
      done("remove-local-branch", `${branch} (${tip.slice(0, 12)}) went with the clone`);
    else skip("remove-local-branch", branch ? "branch already deleted" : "no owned branch");

    skip("prune-worktrees", "task workspaces are clones: no worktree to prune");

    // verify-freed: observable state, then release ownership.
    if (!o.dryRun) {
      if (root && existsSync(root)) failed("verify-freed", `${root} still exists`);
      if (worktree) release("worktree", worktree);
      if (branch) release("branch", branch);
      done("verify-freed", "task workspace and branch gone; ownership released");
    } else skip("verify-freed", "dry-run");
  } catch (e) {
    if (!(e instanceof Stop)) throw e;
    for (const name of order.slice(out.length)) skip(name, "not run: an earlier step failed");
  }

  return parseContract(
    Result,
    {
      schemaVersion: SCHEMA_VERSION,
      issue,
      pr: o.receipt
        ? {
            number: o.receipt.number,
            merged: true,
            baseRef: o.receipt.baseRef,
            headRef: o.receipt.headRef,
            headSha: o.receipt.headSha,
          }
        : null,
      steps: out,
      state: out.some((s) => s.status === "failed") ? "CLEANUP_FAILED" : "COMPLETED",
    },
    "cleanup result",
  );
}

/**
 * Log retention (spec §14, `cleanup.logRetentionDays`): removes `<evidenceRoot>/<runId>` of
 * COMPLETED runs whose directory is older than `days`. Evidence of any other run, and anything
 * that is not a plain directory named after a known run, is kept. Returns what was removed.
 */
export function applyRetention(
  db: Db,
  o: { evidenceRoot: string; days: number; now?: number },
): string[] {
  if (!existsSync(o.evidenceRoot)) return [];
  const cutoff = (o.now ?? Date.now()) - o.days * 86_400_000;
  const removed: string[] = [];
  for (const name of readdirSync(o.evidenceRoot)) {
    const dir = join(o.evidenceRoot, name);
    const st = lstatSync(dir);
    if (!st.isDirectory() || st.mtimeMs >= cutoff || getRun(db, name)?.state !== "COMPLETED") {
      continue;
    }
    rmSync(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}
