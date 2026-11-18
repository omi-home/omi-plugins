// DevTask-0053 #166: `omi workspace init` builds <name>-workspace/ next to the repo, clones the
// repo into it (origin still GitHub), and a re-run keeps every file; locate works from the
// workspace root and from inside the repo.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { workspaceInit } from "../../runtime/cli/workspace.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";
import { locate } from "../../runtime/core/workspace.ts";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

function checkout() {
  const parent = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-ws-")));
  const dir = join(parent, "app");
  execFileSync("git", ["init", "-q", dir]);
  git(dir, "remote", "add", "origin", "git@github.com:acme/app.git");
  git(
    dir,
    "-c",
    "user.name=o",
    "-c",
    "user.email=o@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "s",
  );
  return { parent, dir };
}

const results = (r: { items: { path: string; result: string }[] }) =>
  Object.fromEntries(r.items.map((i) => [i.path, i.result]));

test("init next to the repo: layout, clone with GitHub origin; re-run keeps everything", () => {
  const { parent, dir } = checkout();
  const r = workspaceInit({ cwd: dir });
  const ws = join(parent, "app-workspace");
  assert.equal(r.workspace, ws);
  assert.deepEqual(results(r), {
    app: "created",
    ".claude/settings.json": "created",
    ".omi-plugins/omi.config.json": "created",
    ".omi-plugins/omi.config.yaml": "created",
    "AGENTS.md": "created",
  });
  assert.equal(git(join(ws, "app"), "remote", "get-url", "origin"), "git@github.com:acme/app.git");
  assert.equal(
    JSON.parse(readFileSync(join(ws, ".omi-plugins", "omi.config.json"), "utf8")).profiles.length,
    0,
  );

  // From the workspace root and from inside the cloned repo: same workspace, same repo.
  assert.deepEqual(locate(ws), { workspace: ws, root: join(ws, "app") });
  assert.deepEqual(locate(join(ws, "app")), { workspace: ws, root: join(ws, "app") });

  writeFileSync(join(ws, "AGENTS.md"), "edited\n");
  const again = workspaceInit({ cwd: join(ws, "app") });
  assert.equal(again.workspace, ws);
  assert.ok(
    Object.values(results(again)).every((v) => v === "kept"),
    JSON.stringify(again),
  );
  assert.equal(readFileSync(join(ws, "AGENTS.md"), "utf8"), "edited\n");
  assert.ok(existsSync(dir), "the original checkout is left alone");
});

test("--repo and --name from another directory; outside git without --repo is refused", () => {
  const { dir } = checkout();
  const elsewhere = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-ws-")));
  assert.throws(
    () => workspaceInit({ cwd: elsewhere }),
    (e: OmiError) => e.code === "USAGE_INVALID",
  );
  const r = workspaceInit({ cwd: elsewhere, repo: dir, name: "team" });
  assert.equal(r.workspace, join(elsewhere, "team-workspace"));
  assert.equal(r.repo, join(elsewhere, "team-workspace", "app"));
  assert.throws(
    () => workspaceInit({ cwd: elsewhere, repo: dir, name: "a b" }),
    (e: OmiError) => e.code === "USAGE_INVALID",
  );
});
