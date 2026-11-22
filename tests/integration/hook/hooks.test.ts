// DevTask-0061 #194 (ADR-0003 D6): Coordinator hooks. pre-tool-use blocks editing the main repo,
// commit/push on develop/main and --force, lets everything else through; both hooks fail open.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupScan } from "../../../runtime/cleanup/cli/cleanup.ts";
import { type HookInput, preToolUse, sessionStart } from "../../../runtime/hook/cli/hook.ts";

const bin = fileURLToPath(new URL("../../../bin/omi", import.meta.url));
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: "pipe" }).trim();

/** A checkout that is its own OMI workspace, on `develop`. */
function workspace() {
  const repo = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-hook-")));
  git(repo, "init", "-q", "-b", "develop");
  mkdirSync(join(repo, ".omi-plugins"));
  writeFileSync(
    join(repo, ".omi-plugins", "omi.config.yaml"),
    "github:\n  owner: o\n  repo: repo\n  projectNumber: 2\n",
  );
  return repo;
}

const bash = (cwd: string, command: string): HookInput => ({
  cwd,
  tool_name: "Bash",
  tool_input: { command },
});

test("edits: main repo blocked, outside it (task workspace) allowed", () => {
  const repo = workspace();
  const edit = (file_path: string) =>
    preToolUse({ cwd: repo, tool_name: "Edit", tool_input: { file_path } });
  assert.match(edit(join(repo, "src", "a.ts")) ?? "", /does not edit the main repository/);
  assert.match(edit("src/a.ts") ?? "", /main repository/, "relative to cwd");
  assert.equal(edit(join(tmpdir(), "elsewhere", "a.ts")), null);
  assert.equal(
    preToolUse({ cwd: repo, tool_name: "Read", tool_input: { file_path: join(repo, "a") } }),
    null,
  );
});

test("git/gh: commit on develop/main, push to them and --force blocked; task work passes", () => {
  const repo = workspace();
  const other = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-hook-cwd-")));
  const blocked = [
    "git commit -m x",
    `cd ${repo} && git commit -am x`,
    "git push --force origin feature/1-x",
    "git push -f",
    "git push origin develop",
    "git push origin HEAD:main",
    "gh pr merge 1 --force",
  ];
  for (const c of blocked) assert.ok(preToolUse(bash(repo, c)), c);
  assert.ok(preToolUse(bash(repo, `cd ${other} && git -C ${repo} commit -m x`)), "git -C <repo>");
  const allowed = [
    "npm test",
    "git status && git log --oneline -3",
    "git push -u origin feature/1-x",
    "gh api graphql -f query=x -F n=1",
    `cd ${other} && git commit -m x`,
  ];
  for (const c of allowed) assert.equal(preToolUse(bash(repo, c)), null, c);
  git(repo, "checkout", "-q", "-b", "feature/1-x");
  assert.equal(preToolUse(bash(repo, "git commit -m x")), null, "task branch");
});

test("outside an OMI workspace nothing is enforced; session-start says nothing", () => {
  const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-hook-none-")));
  assert.equal(preToolUse(bash(dir, "git push --force")), null);
  assert.equal(sessionStart({ cwd: dir }, { cleanupScan }), "");
});

test("session-start: GitHub down → short summary with 'unavailable', never throws", () => {
  const repo = workspace();
  const down = () => ({ status: 1, stdout: "", stderr: "HTTP 503" });
  const out = sessionStart({ cwd: repo, source: "startup" }, { cleanupScan, gh: down });
  assert.match(out, /^OMI Coordinator session/);
  assert.match(out, /Latest handoff: unavailable/);
  assert.match(out, /Milestone status: unavailable/);
});

test("bin/omi hook pre-tool-use: exit 2 + reason on stderr; bad stdin passes (exit 0)", () => {
  const repo = workspace();
  const run = (input: string) =>
    spawnSync(process.execPath, [bin, "hook", "pre-tool-use"], { input, encoding: "utf8" });
  const r = run(JSON.stringify(bash(repo, "git push --force")));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--force is never used/);
  assert.equal(run("not json").status, 0);
  assert.equal(run(JSON.stringify(bash(repo, "git status"))).status, 0);
});
