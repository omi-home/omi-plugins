// DevTask-0053 #166: `omi workspace init` builds <name>-workspace/ next to the repo, clones the
// repo into it (origin still GitHub), and a re-run keeps every file; locate works from the
// workspace root and from inside the repo.
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
import { dirname, join } from "node:path";
import { test } from "node:test";
import { coordinatorPluginCheck, memoryDirCheck } from "../../runtime/cli/doctor.ts";
import { memoryDir, workspaceInit } from "../../runtime/cli/workspace.ts";
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

test("#180: settings point auto memory into the workspace; doctor memory-dir checks it", () => {
  const { parent, dir } = checkout();
  const ws = join(parent, "app-workspace");
  assert.equal(memoryDirCheck(ws).status, "warn", "no settings yet");
  workspaceInit({ cwd: dir });
  const settings = join(ws, ".claude", "settings.json");
  const s = JSON.parse(readFileSync(settings, "utf8"));
  assert.equal(s.autoMemoryDirectory, memoryDir(ws));
  assert.equal(s.enabledPlugins["omi-coordinator@omi-plugins"], true, "template kept");
  assert.equal(memoryDirCheck(ws).status, "pass");

  // Index near Claude Code's load limit warns; at the limit passes.
  mkdirSync(memoryDir(ws), { recursive: true });
  const index = join(memoryDir(ws), "MEMORY.md");
  writeFileSync(index, "- [a](a.md) — b\n".repeat(150));
  assert.equal(memoryDirCheck(ws).status, "pass");
  writeFileSync(index, "- [a](a.md) — b\n".repeat(151));
  assert.match(memoryDirCheck(ws).detail, /151 lines/);
  writeFileSync(index, `${"x".repeat(16 * 1024)}\n`);
  assert.equal(memoryDirCheck(ws).status, "warn");

  // Outside the workspace (host ~/.claude) or relative: warn with the expected value.
  writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: join(parent, "elsewhere") }));
  assert.equal(memoryDirCheck(ws).status, "warn");
  writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: ".claude/agent-memory" }));
  assert.match(memoryDirCheck(ws).detail, /autoMemoryDirectory/);

  // Re-run never overwrites an existing settings file.
  workspaceInit({ cwd: dir });
  assert.equal(
    JSON.parse(readFileSync(settings, "utf8")).autoMemoryDirectory,
    ".claude/agent-memory",
  );
});

test("#192: workspace enables omi-coordinator; doctor checks it is installed here, old plugin warns", () => {
  const { parent, dir } = checkout();
  const ws = join(parent, "app-workspace");
  workspaceInit({ cwd: dir });
  const conf = mkdtempSync(join(tmpdir(), "omi-claude-conf-"));
  assert.match(coordinatorPluginCheck(ws, conf).detail, /enabled but not installed/);

  const registry = join(conf, "plugins", "installed_plugins.json");
  mkdirSync(dirname(registry), { recursive: true });
  const write = (installs: unknown[]) =>
    writeFileSync(
      registry,
      JSON.stringify({ version: 2, plugins: { "omi-coordinator@omi-plugins": installs } }),
    );
  write([{ scope: "project", projectPath: join(parent, "other-workspace") }]);
  assert.equal(coordinatorPluginCheck(ws, conf).status, "warn", "installed for another project");
  write([{ scope: "project", projectPath: ws }]);
  assert.equal(coordinatorPluginCheck(ws, conf).status, "pass");

  const settings = join(ws, ".claude", "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({ enabledPlugins: { "omi-engineering@omi-plugins": true } }),
  );
  assert.match(coordinatorPluginCheck(ws, conf).detail, /old plugin/);
  writeFileSync(settings, "{}");
  assert.match(coordinatorPluginCheck(ws, conf).detail, /enable "omi-coordinator@omi-plugins"/);
});
