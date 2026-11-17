// T2.5 worktree manager against a local bare origin (no GitHub): repeated starts, collisions,
// base SHA, crash recovery, symlink/junction normalization, Windows-style paths.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../../runtime/core/config.ts";
import { openState } from "../../runtime/persistence/db.ts";
import { acquireLease, createRun, resourceOwner } from "../../runtime/persistence/repository.ts";
import { branchName, ensureWorktree, OwnerMarker } from "../../runtime/resources/worktree.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** `<base>/origin.git` (main + develop) and a clone at `<base>/repo`. Base has a space in it. */
function fixture(withDevelop = true) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omi wt-")));
  git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(base, "clone", "-q", "origin.git", "repo");
  const repo = join(base, "repo");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "README.md"), "x\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main");
  if (withDevelop) git(repo, "push", "-q", "origin", "main:develop");
  const db = openState(":memory:");
  const run = (id: string, issue: number) =>
    createRun(db, { id, issue: { repository: "o/repo", number: issue }, workflow: "dev" }).id;
  return { base, repo, db, run };
}

const config = parseConfig({ github: { owner: "o", repo: "repo", projectNumber: 1 } });
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};

test("branchName: prefix by type, ASCII slug", () => {
  assert.equal(
    branchName("dev-task", 7, "Fix  Login — Đăng nhập!"),
    "feature/7-fix-login-ang-nhap",
  );
  assert.equal(branchName("bug", 8, "x"), "bugfix/8-x");
  assert.equal(branchName("documentation-task", 9, "!!!"), "docs/9");
  assert.ok(branchName("spike", 1, "a".repeat(80)).length <= "feature/1-".length + 40);
});

test("create from fresh origin/develop, then reuse with the original base SHA", () => {
  const { base, repo, db, run } = fixture();
  const runId = run("r1", 101);
  const devSha = git(repo, "rev-parse", "origin/develop");
  const o = { repoRoot: repo, config, issue: 101, branch: "feature/101-a", runId };

  const ws = ensureWorktree(db, o);
  assert.equal(ws.path, join(base, ".omi-worktrees", "repo", "101"));
  assert.equal(ws.baseSha, devSha);
  assert.deepEqual([ws.reused, ws.dirty], [false, false]);
  assert.equal(git(ws.path, "branch", "--show-current"), "feature/101-a");
  assert.equal(git(ws.path, "rev-parse", "HEAD"), devSha);
  // Marker lives in the worktree's git dir: working tree stays clean, removal needs no --force.
  assert.equal(git(ws.path, "status", "--porcelain", "--untracked-files=all"), "");
  const marker = OwnerMarker.parse(
    JSON.parse(
      readFileSync(join(git(ws.path, "rev-parse", "--absolute-git-dir"), "omi-owner.json"), "utf8"),
    ),
  );
  assert.deepEqual([marker.issue, marker.branch, marker.baseSha], [101, "feature/101-a", devSha]);
  assert.equal(resourceOwner(db, "worktree", ws.path), runId);
  assert.equal(resourceOwner(db, "branch", "feature/101-a"), runId);
  // Main checkout untouched.
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "");

  // origin/develop moves on; a repeated start still reports the base the task was cut from.
  const other = join(base, "other");
  git(base, "clone", "-q", "-b", "develop", "origin.git", "other");
  git(
    other,
    "-c",
    "user.email=t@example.invalid",
    "-c",
    "user.name=t",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "later",
  );
  git(other, "push", "-q", "origin", "develop");
  writeFileSync(join(ws.path, "wip.txt"), "wip\n");
  const again = ensureWorktree(db, o);
  assert.deepEqual(again, { ...ws, reused: true, dirty: true });

  // Same path spelled differently (case on Windows, trailing segments) is still the same worktree.
  const spelled = process.platform === "win32" ? repo.toUpperCase() : `${repo}/./`;
  assert.equal(ensureWorktree(db, { ...o, repoRoot: spelled }).reused, true);
  assert.equal(git(repo, "worktree", "list").split("\n").length, 2);
});

test("collisions: foreign branch, branch checked out elsewhere, foreign directory", () => {
  const { base, repo, db, run } = fixture();
  const runId = run("r1", 102);
  const o = { repoRoot: repo, config, issue: 102, branch: "feature/102-a", runId };

  git(repo, "branch", "feature/102-a");
  assert.equal(
    code(() => ensureWorktree(db, o)),
    "OWNERSHIP_MISMATCH",
  );
  git(repo, "branch", "-D", "feature/102-a");

  git(repo, "checkout", "-q", "-b", "feature/102-a");
  assert.equal(
    code(() => ensureWorktree(db, o)),
    "OWNERSHIP_MISMATCH",
  );
  git(repo, "checkout", "-q", "main");
  git(repo, "branch", "-D", "feature/102-a");

  mkdirSync(join(base, ".omi-worktrees", "repo", "102"), { recursive: true });
  assert.equal(
    code(() => ensureWorktree(db, o)),
    "OWNERSHIP_MISMATCH",
  );
});

test("existing worktree of another task or branch is never adopted", () => {
  const { repo, db, run } = fixture();
  const runId = run("r1", 104);
  const o = { repoRoot: repo, config, issue: 104, branch: "feature/104-a", runId };
  const ws = ensureWorktree(db, o);
  assert.equal(
    code(() => ensureWorktree(db, { ...o, branch: "feature/104-b" })),
    "OWNERSHIP_MISMATCH",
  );

  const file = join(git(ws.path, "rev-parse", "--absolute-git-dir"), "omi-owner.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...m, issue: 999 }));
  assert.equal(
    code(() => ensureWorktree(db, o)),
    "OWNERSHIP_MISMATCH",
  );
  writeFileSync(file, "{not json");
  assert.equal(
    code(() => ensureWorktree(db, o)),
    "OWNERSHIP_MISMATCH",
  );
});

test("crash before the marker write: only the claiming run may adopt the worktree", () => {
  const { repo, db, run } = fixture();
  const runId = run("r1", 105);
  const o = { repoRoot: repo, config, issue: 105, branch: "feature/105-a", runId };
  const ws = ensureWorktree(db, o);
  const file = join(git(ws.path, "rev-parse", "--absolute-git-dir"), "omi-owner.json");
  rmSync(file);

  assert.equal(
    code(() => ensureWorktree(db, { ...o, runId: run("r2", 999) })),
    "OWNERSHIP_MISMATCH",
  );
  const again = ensureWorktree(db, o);
  assert.deepEqual([again.reused, again.baseSha], [true, ws.baseSha]);
  assert.ok(existsSync(file));
});

test("crash after branch creation, worktree gone: claiming run re-attaches its branch", () => {
  const { repo, db, run } = fixture();
  const runId = run("r1", 106);
  const o = { repoRoot: repo, config, issue: 106, branch: "feature/106-a", runId };
  const ws = ensureWorktree(db, o);
  git(repo, "worktree", "remove", ws.path);
  const again = ensureWorktree(db, o);
  assert.deepEqual([again.reused, again.path, again.baseSha], [false, ws.path, ws.baseSha]);
});

test("guards: base/release branch, bad name, root inside checkout, missing develop, lease", () => {
  const { repo, db, run } = fixture();
  const runId = run("r1", 107);
  const o = { repoRoot: repo, config, issue: 107, branch: "feature/107-a", runId };
  assert.equal(
    code(() => ensureWorktree(db, { ...o, branch: "develop" })),
    "POLICY_VIOLATION",
  );
  assert.equal(
    code(() => ensureWorktree(db, { ...o, branch: "main" })),
    "POLICY_VIOLATION",
  );
  assert.equal(
    code(() => ensureWorktree(db, { ...o, branch: "bad..name" })),
    "USAGE_INVALID",
  );
  const inside = parseConfig({ ...config, git: { ...config.git, worktreeRoot: "./wt" } });
  assert.equal(
    code(() => ensureWorktree(db, { ...o, config: inside })),
    "CONFIG_INVALID",
  );

  acquireLease(db, { key: "worktree:o/repo#107", holder: "someone", ttlMs: 60_000 });
  assert.equal(
    code(() => ensureWorktree(db, o)),
    "LOCK_HELD",
  );

  const bare = fixture(false);
  const id = bare.run("r1", 108);
  assert.equal(
    code(() =>
      ensureWorktree(bare.db, {
        repoRoot: bare.repo,
        config,
        issue: 108,
        branch: "feature/108-a",
        runId: id,
      }),
    ),
    "CONFIG_INVALID",
  );
});

test("symlinked/junction worktree root is normalized; a linked target is refused", () => {
  const { base, repo, db, run } = fixture();
  const real = join(base, "real-root");
  mkdirSync(real);
  symlinkSync(real, join(base, ".omi-worktrees"), "junction");
  const runId = run("r1", 109);
  const ws = ensureWorktree(db, {
    repoRoot: repo,
    config,
    issue: 109,
    branch: "feature/109-a",
    runId,
  });
  assert.equal(ws.path, join(real, "repo", "109"));

  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, join(real, "repo", "110"), "junction");
  const id = run("r2", 110);
  assert.equal(
    code(() =>
      ensureWorktree(db, {
        repoRoot: repo,
        config,
        issue: 110,
        branch: "feature/110-a",
        runId: id,
      }),
    ),
    "OWNERSHIP_MISMATCH",
  );
});
