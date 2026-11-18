// T1.4 canary: the backend rule pack reaches the named agent and never the main session.
// /context check runs whenever `claude` is on PATH (no model call). Live agent runs cost tokens:
// opt in with OMI_LIVE=1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentLaunch, observeRun } from "../../runtime/adapters/claude/launch.ts";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const PACK_ID = /^Pack-ID: (.+)$/m.exec(
  readFileSync(join(pluginRoot, "resources/role-rules/backend/backend-implementation.md"), "utf8"),
)?.[1] as string;
/** Every pack's canary: none may reach the main session. */
const ALL_PACK_IDS = (readdirSync(join(pluginRoot, "resources"), { recursive: true }) as string[])
  .filter((f) => f.endsWith(".md"))
  .map((f) => /^Pack-ID: (.+)$/m.exec(readFileSync(join(pluginRoot, "resources", f), "utf8"))?.[1])
  .filter((id): id is string => Boolean(id));
const AGENTS = readdirSync(join(pluginRoot, "agents")).map((f) => f.replace(/\.md$/, ""));
const hasClaude = spawnSync("claude", ["--version"]).status === 0;
const live = hasClaude && process.env.OMI_LIVE === "1";
const worktree = () => mkdtempSync(join(tmpdir(), "omi-t14-"));

test("rule pack declares a Pack-ID canary", () =>
  assert.match(PACK_ID, /^omi-backend-rules\/v\d+$/));

test("main /context: agent listed by name/description only, no rule pack, only entry skills", {
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
  for (const a of AGENTS) assert.ok(r.stdout.includes(`omi-engineering:${a} | Plugin`), a);
  for (const id of ALL_PACK_IDS)
    assert.ok(!r.stdout.includes(id), `${id} leaked into main context`);
  assert.ok(!r.stdout.includes("role-rules"));
  // D3: the only plugin skills are Coordinator entry points.
  const skills = r.stdout.split("### Skills")[1] ?? "";
  assert.deepEqual(skills.match(/omi-engineering:[\w-]+/g), ["omi-engineering:omi-task"]);
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
    o.permissionDenials.some((d) => d.startsWith("Read:") && /[\\/]resources[\\/]/.test(d)),
  );
  assert.ok(!o.result.includes(PACK_ID), o.result);
  assert.match(o.result, /BLOCKED/);
});
