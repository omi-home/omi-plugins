// DevTask-0056 #169: `omi workspace migrate` moves a repo on the old layout (.omi/config.yaml,
// state in the git dir) into `<name>-workspace/`; `omi doctor`'s layout checks pass or warn.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { layout } from "../../runtime/cli/doctor.ts";
import { workspaceMigrate } from "../../runtime/cli/workspace.ts";
import type { OmiError } from "../../runtime/shared/errors/errors.ts";
import { openState } from "../../runtime/shared/sqlite/db.ts";
import { advanceRun, createRun, openRuns } from "../../runtime/task-run/adapters/repository.ts";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
const CONFIG = "github:\n  owner: acme\n  repo: app\n  projectNumber: 7\n";

/** `<parent>/app` on the old layout, with one run in the old state (open unless `done`). */
function oldRepo(done = true) {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-mig-")));
  const repo = join(parent, "app");
  execFileSync("git", ["init", "-q", repo]);
  git(repo, "remote", "add", "origin", "git@github.com:acme/app.git");
  mkdirSync(join(repo, ".omi"));
  writeFileSync(join(repo, ".omi", "config.yaml"), CONFIG);
  writeFileSync(join(repo, "AGENTS.md"), "old\n");
  git(repo, "add", ".");
  git(repo, "-c", "user.name=o", "-c", "user.email=o@example.invalid", "commit", "-q", "-m", "s");
  const db = openState(join(repo, ".git", "omi", "state.sqlite"));
  const run = createRun(db, {
    id: "5-a",
    issue: { repository: "acme/app", number: 5 },
    workflow: "dev-task",
  });
  if (done) advanceRun(db, run.id, { type: "CANCEL" });
  db.close();
  return { parent, repo };
}

test("dry run changes nothing; migrate builds the workspace, copies config and state; re-run keeps", () => {
  const { parent, repo } = oldRepo();
  const ws = join(parent, "app-workspace");
  const dry = workspaceMigrate({ cwd: repo, dryRun: true });
  assert.equal(dry.workspace, ws);
  assert.equal(existsSync(ws), false);
  assert.deepEqual(dry.remove, [".omi", "AGENTS.md"]);

  const r = workspaceMigrate({ cwd: repo });
  assert.equal(readFileSync(join(ws, ".omi-plugins", "omi.config.yaml"), "utf8"), CONFIG);
  assert.equal(git(join(ws, "app"), "remote", "get-url", "origin"), "git@github.com:acme/app.git");
  const db = openState(join(ws, ".omi-plugins", "state.sqlite"));
  assert.equal(db.prepare("SELECT count(*) AS n FROM workflow_run").get()?.n, 1);
  db.close();
  assert.deepEqual(r.remove, [".omi", "AGENTS.md"]);
  // Nothing deleted in the repo.
  assert.ok(existsSync(join(repo, ".omi", "config.yaml")) && existsSync(join(repo, "AGENTS.md")));

  const again = workspaceMigrate({ cwd: repo });
  assert.ok(
    again.actions.slice(1).every((a) => a.startsWith("keep")),
    JSON.stringify(again),
  );
});

test("refused while a run is open or a task worktree is left", () => {
  const open = oldRepo(false);
  assert.throws(
    () => workspaceMigrate({ cwd: open.repo }),
    (e: OmiError) => e.code === "POLICY_VIOLATION" && /#5/.test(e.message),
  );
  assert.equal(existsSync(join(open.parent, "app-workspace")), false);

  const wt = oldRepo();
  git(wt.repo, "worktree", "add", "-q", "-b", "feature/5-x", join(wt.parent, "wt5"));
  assert.throws(
    () => workspaceMigrate({ cwd: wt.repo }),
    (e: OmiError) => e.code === "POLICY_VIOLATION" && /worktree/.test(e.message),
  );
});

test("doctor layout: warns while the repo keeps old files or holds .omi-plugins/, passes once clean", () => {
  const { parent, repo } = oldRepo();
  workspaceMigrate({ cwd: repo });
  const ws = join(parent, "app-workspace");
  const clone = join(ws, "app");
  const status = (w: string, r: string) =>
    Object.fromEntries(layout(w, r).map((c) => [c.name, c.status]));
  assert.deepEqual(status(ws, clone), {
    layout: "warn",
    "profiles-file": "pass",
    "legacy-runs": "pass",
  });
  git(clone, "rm", "-q", "-r", ".omi", "AGENTS.md");
  assert.equal(status(ws, clone).layout, "pass");

  // The old checkout as its own workspace: config inside the repo, old state still in .git.
  mkdirSync(join(repo, ".omi-plugins"));
  writeFileSync(join(repo, ".omi-plugins", "omi.config.json"), "{}");
  assert.deepEqual(status(repo, repo), {
    layout: "warn",
    "profiles-file": "fail",
    "legacy-runs": "warn",
  });
  assert.equal(openRuns(openState(join(ws, ".omi-plugins", "state.sqlite"))).length, 0);
});
