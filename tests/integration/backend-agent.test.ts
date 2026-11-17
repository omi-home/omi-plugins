// T1.4 canary: the backend rule pack reaches the named agent and never the main session.
// /context check runs whenever `claude` is on PATH (no model call). Live agent runs cost tokens:
// opt in with OMI_LIVE=1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentLaunch, observeRun } from "../../runtime/adapters/claude/launch.ts";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const PACK_ID = /^Pack-ID: (.+)$/m.exec(
  readFileSync(join(pluginRoot, "resources/role-rules/backend/backend-implementation.md"), "utf8"),
)?.[1] as string;
const hasClaude = spawnSync("claude", ["--version"]).status === 0;
const live = hasClaude && process.env.OMI_LIVE === "1";
const worktree = () => mkdtempSync(join(tmpdir(), "omi-t14-"));

test("rule pack declares a Pack-ID canary", () =>
  assert.match(PACK_ID, /^omi-backend-rules\/v\d+$/));

test("main /context: agent listed by name/description only, no rule pack, no plugin skill", {
  skip: !hasClaude && "claude CLI not on PATH",
}, () => {
  const r = spawnSync(
    "claude",
    [
      "-p",
      "/context",
      "--plugin-dir",
      pluginRoot,
      "--setting-sources",
      "project,local",
      "--no-session-persistence",
    ],
    { cwd: worktree(), encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /omi-engineering:backend-engineer \| Plugin/);
  assert.ok(!r.stdout.includes(PACK_ID), "rule pack leaked into main context");
  assert.ok(!r.stdout.includes("role-rules"));
  const skills = r.stdout.split("### Skills")[1] ?? "";
  assert.ok(!skills.includes("omi-engineering:"), "plugin registers a skill");
});

const runAgent = (grant: boolean) => {
  const l = buildAgentLaunch({
    pluginRoot,
    role: "backend-engineer",
    worktree: worktree(),
    prompt: "Which rule pack did you load? Reply with its Pack-ID only.",
    fromSource: true,
  });
  const args = grant
    ? l.args
    : l.args.filter((_, i, a) => a[i] !== "--allowedTools" && a[i - 1] !== "--allowedTools");
  const r = spawnSync(
    l.command,
    [...args, "--setting-sources", "project,local", "--no-session-persistence"],
    {
      cwd: l.cwd,
      input: l.stdin,
      encoding: "utf8",
      timeout: 300_000,
    },
  );
  assert.equal(r.status, 0, r.stderr);
  return observeRun(r.stdout);
};

test("live: agent with resources grant loads the pack; model observed, effort unknown", {
  skip: !live && "set OMI_LIVE=1 (costs tokens)",
}, () => {
  const o = runAgent(true);
  assert.ok(o.result.includes(PACK_ID), o.result);
  assert.match(o.actualModel, /^claude-sonnet-/);
  assert.equal(o.actualEffort, "unknown");
  assert.deepEqual(o.permissionDenials, []);
});

test("live: without the grant the Read is denied and the agent blocks", {
  skip: !live && "set OMI_LIVE=1 (costs tokens)",
}, () => {
  const o = runAgent(false);
  assert.ok(
    o.permissionDenials.some(
      (d) => d.startsWith("Read:") && d.includes("backend-implementation.md"),
    ),
  );
  assert.ok(!o.result.includes(PACK_ID), o.result);
  assert.match(o.result, /BLOCKED/);
});
