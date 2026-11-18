// T4.3 safe cleanup against a local bare origin: squash-merged happy path + replay, dry run,
// dirty worktree, locked worktree, cleanup lease, live owned process, unowned container,
// temp dir symlink / outside the state dir, tip that does not match the merge receipt.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { MergeReceipt } from "../../runtime/adapters/github/merge.ts";
import { parseConfig } from "../../runtime/core/config.ts";
import { openState } from "../../runtime/persistence/db.ts";
import {
  acquireLease,
  claimResource,
  createRun,
  ownedRefs,
} from "../../runtime/persistence/repository.ts";
import { type CleanupOptions, cleanupRun } from "../../runtime/resources/cleanup.ts";
import { ensureWorktree } from "../../runtime/resources/worktree.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const config = parseConfig({ github: { owner: "o", repo: "repo", projectNumber: 1 } });

/** A task #5 with one pushed commit, squash-merged into develop by "GitHub". */
function merged() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-clean-")));
  git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(base, "clone", "-q", "origin.git", "repo");
  const repo = join(base, "repo");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main", "main:develop");
  const db = openState(":memory:");
  const runId = createRun(db, {
    id: "run5",
    issue: { repository: "o/repo", number: 5 },
    workflow: "dev-task",
  }).id;
  const ws = ensureWorktree(db, { repoRoot: repo, config, issue: 5, branch: "feature/5-x", runId });
  writeFileSync(join(ws.path, "a.txt"), "a\n");
  git(ws.path, "add", "a.txt");
  git(ws.path, "commit", "-q", "-m", "a");
  git(ws.path, "push", "-q", "origin", "feature/5-x");
  const tip = git(ws.path, "rev-parse", "HEAD");
  // Squash on the server: develop gets the change as a new commit; the branch is not an ancestor.
  git(repo, "fetch", "-q", "origin");
  const receipt: MergeReceipt = {
    number: 9,
    url: "https://github.com/o/repo/pull/9",
    merged: true,
    mergedAt: "2026-11-18T00:00:00Z",
    baseRef: "develop",
    headRef: "feature/5-x",
    headSha: tip,
    mergeCommit: null,
  };
  const stateDir = join(base, "state");
  mkdirSync(stateDir);
  const opts = (o: Partial<CleanupOptions> = {}): CleanupOptions => ({
    repoRoot: repo,
    runId,
    receipt,
    tempRoot: stateDir,
    alive: () => false,
    docker: () => ({ status: 1, stdout: "" }),
    ...o,
  });
  return { base, repo, db, runId, wt: ws.path, receipt, stateDir, opts };
}

const summary = (r: ReturnType<typeof cleanupRun>) => r.steps.map((s) => `${s.name}:${s.status}`);
const failedStep = (r: ReturnType<typeof cleanupRun>) =>
  r.steps.find((s) => s.status === "failed")?.name;

test("squash merge: worktree, branch and temp dir removed without --force; replay is a no-op", () => {
  const s = merged();
  assert.equal(git(s.repo, "branch", "--merged", "origin/develop").includes("feature/5-x"), false);
  const tmp = join(s.stateDir, "tmp-run5");
  mkdirSync(tmp);
  claimResource(s.db, { runId: s.runId, kind: "temp-dir", ref: tmp });
  const r = cleanupRun(s.db, s.opts());
  assert.equal(r.state, "COMPLETED", JSON.stringify(r.steps));
  assert.equal(existsSync(s.wt), false);
  assert.equal(existsSync(tmp), false);
  assert.equal(git(s.repo, "branch", "--list", "feature/5-x"), "");
  assert.equal(git(s.repo, "ls-remote", "origin", "feature/5-x") !== "", true); // remote kept
  assert.deepEqual(ownedRefs(s.db, s.runId, "worktree"), []);
  const again = cleanupRun(s.db, s.opts());
  assert.equal(again.state, "COMPLETED");
  assert.ok(
    again.steps.filter((x) => x.name.startsWith("remove")).every((x) => x.status === "skipped"),
  );
});

test("dry run touches nothing and reports what it would do", () => {
  const s = merged();
  const r = cleanupRun(s.db, s.opts({ dryRun: true }));
  assert.equal(r.state, "COMPLETED");
  assert.match(r.steps.find((x) => x.name === "remove-worktree")?.detail ?? "", /^dry-run: would/);
  assert.equal(existsSync(s.wt), true);
  assert.equal(ownedRefs(s.db, s.runId, "worktree").length, 1);
});

test("no receipt or a tip that differs from the merged head: CLEANUP_FAILED, nothing removed", () => {
  const s = merged();
  const none = cleanupRun(s.db, s.opts({ receipt: undefined }));
  assert.equal(none.state, "CLEANUP_FAILED");
  assert.equal(none.pr, null);
  assert.equal(failedStep(none), "verify-merge");
  writeFileSync(join(s.wt, "b.txt"), "b\n");
  git(s.wt, "add", "b.txt");
  git(s.wt, "commit", "-q", "-m", "b (after merge)");
  assert.equal(failedStep(cleanupRun(s.db, s.opts())), "verify-merge");
  assert.equal(existsSync(s.wt), true);
});

test("dirty or locked worktree: CLEANUP_FAILED, worktree and branch kept", () => {
  const s = merged();
  writeFileSync(join(s.wt, "scratch.txt"), "x\n");
  const dirty = cleanupRun(s.db, s.opts());
  assert.deepEqual([dirty.state, failedStep(dirty)], ["CLEANUP_FAILED", "verify-clean-worktree"]);
  assert.ok(summary(dirty).includes("remove-worktree:skipped"));
  execFileSync("git", ["clean", "-fq"], { cwd: s.wt });
  git(s.repo, "worktree", "lock", s.wt);
  assert.match(
    cleanupRun(s.db, s.opts()).steps.find((x) => x.status === "failed")?.detail ?? "",
    /locked/,
  );
  assert.equal(existsSync(s.wt), true);
  assert.match(git(s.repo, "branch", "--list", "feature/5-x"), /feature\/5-x/);
});

test("a held cleanup lease refuses a concurrent cleanup", () => {
  const s = merged();
  acquireLease(s.db, { key: `cleanup:${s.runId}`, holder: "other", ttlMs: 60_000 });
  assert.throws(() => cleanupRun(s.db, s.opts()), { code: "LOCK_HELD" });
});

test("live owned process stops cleanup; it is never killed by PID", () => {
  const s = merged();
  claimResource(s.db, { runId: s.runId, kind: "process", ref: "4242" });
  const r = cleanupRun(s.db, s.opts({ alive: (pid) => pid === 4242 }));
  assert.equal(failedStep(r), "stop-processes");
  assert.equal(existsSync(s.wt), true);
});

test("container without our omi.run label is not touched", () => {
  const s = merged();
  claimResource(s.db, { runId: s.runId, kind: "container", ref: "c1" });
  const calls: string[][] = [];
  const docker = (args: string[]) => {
    calls.push(args);
    return { status: 0, stdout: "someone-else\n" };
  };
  assert.equal(failedStep(cleanupRun(s.db, s.opts({ docker }))), "stop-processes");
  assert.ok(!calls.some((a) => a[0] === "rm"));
});

test("temp dir that is a symlink or outside the state dir is refused", () => {
  const s = merged();
  const target = join(s.base, "precious");
  mkdirSync(target);
  const link = join(s.stateDir, "link");
  symlinkSync(target, link, "junction");
  claimResource(s.db, { runId: s.runId, kind: "temp-dir", ref: link });
  assert.equal(failedStep(cleanupRun(s.db, s.opts())), "clean-temp");
  assert.equal(existsSync(target), true);
  const s2 = merged();
  claimResource(s2.db, { runId: s2.runId, kind: "temp-dir", ref: s2.base });
  assert.equal(failedStep(cleanupRun(s2.db, s2.opts())), "clean-temp");
  assert.equal(existsSync(s2.repo), true);
});
