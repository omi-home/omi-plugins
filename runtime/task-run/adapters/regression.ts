// Regression proof runner (DevTask-0140 #404): the same test command on the commit before the fix
// (a temporary detached worktree) and on HEAD. Reuses the checks' supervisor, timeout, redaction and
// log files. The temporary worktree is always removed, links first and without following them.
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  rmdirSync,
  symlinkSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { commandEnv } from "../../shared/process/command-env.ts";
import type { ProofRun } from "../domain/regression.ts";
import { type CommandResult, runCommand } from "./checks.ts";

export interface RegressionRunInput {
  /** The task worktree (HEAD of the fix). */
  worktree: string;
  /** Commit before the fix. */
  preFix: string;
  /** Command with `{files}` already filled. */
  run: string;
  /** Every changed test file (helpers, fixtures too), copied onto the old commit. */
  copy: string[];
  /** Repo-relative paths linked from `worktree` into the temporary one. */
  share: string[];
  timeoutSec: number;
  /** Directory of the run that `omi task finalize` already cleans; the temporary worktree lives here. */
  tmpRoot: string;
  logDir: string;
  env?: NodeJS.ProcessEnv;
}

const gitIn = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

/** Removes a link without following it; a real directory or file is left alone. */
function unlink(path: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch {
    return; // not there
  }
  if (!isLink) return;
  try {
    unlinkSync(path);
  } catch {
    rmdirSync(path); // Windows junction
  }
}

function proofRun(commit: string, r: CommandResult, logPath: string): ProofRun {
  return { commit, exit: r.exitCode, outcome: r.outcome, tail: r.summary, logPath };
}

/** Runs the proof; throws only on a setup failure (the worktree is removed in every case). */
export function runRegressionProof(o: RegressionRunInput): { before: ProofRun; after: ProofRun } {
  mkdirSync(o.logDir, { recursive: true });
  mkdirSync(o.tmpRoot, { recursive: true });
  const env = o.env ?? commandEnv(process.env);
  const tmp = join(o.tmpRoot, "regression-prefix");
  const links: string[] = [];
  let before: ProofRun;
  gitIn(o.worktree, ["worktree", "add", "--detach", tmp, o.preFix]);
  try {
    for (const f of o.copy) {
      mkdirSync(dirname(join(tmp, f)), { recursive: true });
      copyFileSync(join(o.worktree, f), join(tmp, f));
    }
    for (const p of o.share) {
      const src = join(o.worktree, p);
      const dest = join(tmp, p);
      if (!existsSync(src) || existsSync(dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      symlinkSync(src, dest, "junction");
      links.push(dest);
    }
    const logPath = join(o.logDir, "regression-before.log");
    before = proofRun(
      o.preFix,
      runCommand({ run: o.run, timeoutSec: o.timeoutSec }, tmp, logPath, env),
      logPath,
    );
  } finally {
    for (const l of links) unlink(l);
    try {
      gitIn(o.worktree, ["worktree", "remove", "--force", tmp]);
    } finally {
      gitIn(o.worktree, ["worktree", "prune"]);
    }
  }
  const head = gitIn(o.worktree, ["rev-parse", "HEAD"]).toString().trim();
  const logPath = join(o.logDir, "regression-after.log");
  const after = proofRun(
    head,
    runCommand({ run: o.run, timeoutSec: o.timeoutSec }, o.worktree, logPath, env),
    logPath,
  );
  return { before, after };
}
