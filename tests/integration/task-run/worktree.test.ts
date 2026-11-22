// T2.5 / DevTask-0054 #167 task workspace manager against a local bare origin (no GitHub): a clone
// per run cut from a freshly fetched origin/develop, repeated starts, collisions, crash recovery.
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
import { parseConfig } from "../../../runtime/shared/config.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import {
  acquireLease,
  createRun,
  resourceOwner,
} from "../../../runtime/task-run/adapters/repository.ts";
import {
  branchName,
  ensureTaskWorkspace,
  OwnerMarker,
  taskWorkspaceRoot,
} from "../../../runtime/task-run/adapters/worktree.ts";

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
  const workspace = join(base, "ws");
  mkdirSync(workspace);
  const db = openState(":memory:");
  const run = (id: string, issue: number) =>
    createRun(db, { id, issue: { repository: "o/repo", number: issue }, workflow: "dev-task" }).id;
  return { base, repo, workspace, db, run };
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
    "feature/7-fix-login-dang-nhap",
  );
  // The title's <IssueType>-<NNNN>- prefix is not repeated in the slug (#128).
  assert.equal(branchName("dev-task", 8, "DevTask-0045-Ma trận đầu"), "feature/8-ma-tran-dau");
  assert.equal(branchName("dev-task", 8, "Roadmap-2026-cleanup"), "feature/8-roadmap-2026-cleanup");
  assert.equal(branchName("documentation-task", 9, "!!!"), "docs/9");
  // Under a Bug: bugfix/ for any task type; any other parent keeps the type's prefix.
  assert.equal(branchName("dev-task", 10, "DevTask-0050-Sửa lỗi", "bug"), "bugfix/10-sua-loi");
  assert.equal(branchName("test-task", 11, "Repro", "bug"), "bugfix/11-repro");
  assert.equal(branchName("dev-task", 12, "Việc", "feature"), "feature/12-viec");
  assert.equal(branchName("test-task", 13, "Thử", "feature"), "test/13-thu");
  assert.ok(branchName("spike", 1, "a".repeat(80)).length <= "feature/1-".length + 40);
});

/** One more commit on origin/develop, pushed from another clone. */
function advance(base: string, msg: string) {
  const other = join(base, `other-${msg}`);
  git(base, "clone", "-q", "-b", "develop", "origin.git", other);
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
    msg,
  );
  git(other, "push", "-q", "origin", "develop");
  return git(other, "rev-parse", "HEAD");
}

test("clone from a freshly fetched origin/develop, origin kept, then reuse with the original base", () => {
  const { base, repo, workspace, db, run } = fixture();
  const runId = run("r1", 101);
  // The main checkout's origin/develop is stale: the clone must still start from the new tip.
  const devSha = advance(base, "fresh");
  assert.notEqual(git(repo, "rev-parse", "origin/develop"), devSha);
  const o = { repoRoot: repo, workspace, config, issue: 101, branch: "feature/101-a", runId };

  const ws = ensureTaskWorkspace(db, o);
  assert.equal(ws.path, join(taskWorkspaceRoot(workspace, "r1"), "repo"));
  assert.equal(ws.baseSha, devSha);
  assert.deepEqual([ws.reused, ws.dirty], [false, false]);
  assert.equal(git(ws.path, "branch", "--show-current"), "feature/101-a");
  assert.equal(git(ws.path, "rev-parse", "HEAD"), devSha);
  assert.equal(git(ws.path, "rev-parse", "origin/develop"), devSha);
  assert.equal(
    git(ws.path, "remote", "get-url", "origin"),
    git(repo, "remote", "get-url", "origin"),
  );
  assert.equal(git(ws.path, "rev-parse", "--is-shallow-repository"), "false");
  // Marker lives in the clone's git dir: the working tree stays clean.
  assert.equal(git(ws.path, "status", "--porcelain", "--untracked-files=all"), "");
  const marker = OwnerMarker.parse(
    JSON.parse(
      readFileSync(join(git(ws.path, "rev-parse", "--absolute-git-dir"), "omi-owner.json"), "utf8"),
    ),
  );
  assert.deepEqual([marker.issue, marker.branch, marker.baseSha], [101, "feature/101-a", devSha]);
  assert.equal(resourceOwner(db, "worktree", ws.path), runId);
  assert.equal(resourceOwner(db, "branch", "feature/101-a"), runId);
  // Main checkout: clean, no task branch, no worktree.
  assert.equal(git(repo, "status", "--porcelain", "--untracked-files=all"), "");
  assert.equal(git(repo, "branch", "--list", "feature/101-a"), "");
  assert.equal(git(repo, "worktree", "list").split("\n").length, 1);

  // origin/develop moves on; a repeated start still reports the base the task was cut from.
  advance(base, "later");
  writeFileSync(join(ws.path, "wip.txt"), "wip\n");
  const again = ensureTaskWorkspace(db, o);
  assert.deepEqual(again, { ...ws, reused: true, dirty: true });
});

test("never adopted: a plain directory, another task's marker, another branch, broken marker", () => {
  const { repo, workspace, db, run } = fixture();
  const runId = run("r1", 102);
  mkdirSync(join(taskWorkspaceRoot(workspace, "r1"), "repo"), { recursive: true });
  const o = { repoRoot: repo, workspace, config, issue: 102, branch: "feature/102-a", runId };
  assert.equal(
    code(() => ensureTaskWorkspace(db, o)),
    "OWNERSHIP_MISMATCH",
  );

  const f = fixture();
  const p = {
    repoRoot: f.repo,
    workspace: f.workspace,
    config,
    issue: 104,
    branch: "feature/104-a",
    runId: f.run("r1", 104),
  };
  const ws = ensureTaskWorkspace(f.db, p);
  assert.equal(
    code(() => ensureTaskWorkspace(f.db, { ...p, branch: "feature/104-b" })),
    "OWNERSHIP_MISMATCH",
  );
  const file = join(git(ws.path, "rev-parse", "--absolute-git-dir"), "omi-owner.json");
  const m = JSON.parse(readFileSync(file, "utf8"));
  writeFileSync(file, JSON.stringify({ ...m, issue: 999 }));
  assert.equal(
    code(() => ensureTaskWorkspace(f.db, p)),
    "OWNERSHIP_MISMATCH",
  );
  writeFileSync(file, "{not json");
  assert.equal(
    code(() => ensureTaskWorkspace(f.db, p)),
    "OWNERSHIP_MISMATCH",
  );
});

test("crash before the marker write: the claiming run adopts its clone", () => {
  const { repo, workspace, db, run } = fixture();
  const runId = run("r1", 105);
  const o = { repoRoot: repo, workspace, config, issue: 105, branch: "feature/105-a", runId };
  const ws = ensureTaskWorkspace(db, o);
  const file = join(git(ws.path, "rev-parse", "--absolute-git-dir"), "omi-owner.json");
  rmSync(file);
  const again = ensureTaskWorkspace(db, o);
  assert.deepEqual([again.reused, again.baseSha], [true, ws.baseSha]);
  assert.ok(existsSync(file));
});

test("guards: base/release branch, bad name, missing develop, lease, symlinked task root", () => {
  const { base, repo, workspace, db, run } = fixture();
  const runId = run("r1", 107);
  const o = { repoRoot: repo, workspace, config, issue: 107, branch: "feature/107-a", runId };
  assert.equal(
    code(() => ensureTaskWorkspace(db, { ...o, branch: "develop" })),
    "POLICY_VIOLATION",
  );
  assert.equal(
    code(() => ensureTaskWorkspace(db, { ...o, branch: "main" })),
    "POLICY_VIOLATION",
  );
  assert.equal(
    code(() => ensureTaskWorkspace(db, { ...o, branch: "bad..name" })),
    "USAGE_INVALID",
  );
  acquireLease(db, { key: "worktree:o/repo#107", holder: "someone", ttlMs: 60_000 });
  assert.equal(
    code(() => ensureTaskWorkspace(db, o)),
    "LOCK_HELD",
  );

  const elsewhere = join(base, "elsewhere");
  mkdirSync(elsewhere);
  symlinkSync(elsewhere, taskWorkspaceRoot(workspace, "r2"), "junction");
  const id = run("r2", 110);
  assert.equal(
    code(() => ensureTaskWorkspace(db, { ...o, issue: 110, branch: "feature/110-a", runId: id })),
    "OWNERSHIP_MISMATCH",
  );

  const bare = fixture(false);
  assert.equal(
    code(() =>
      ensureTaskWorkspace(bare.db, {
        repoRoot: bare.repo,
        workspace: bare.workspace,
        config,
        issue: 108,
        branch: "feature/108-a",
        runId: bare.run("r1", 108),
      }),
    ),
    "CONFIG_INVALID",
  );
});
