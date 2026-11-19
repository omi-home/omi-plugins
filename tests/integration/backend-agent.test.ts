// T1.4 canary, task workspace since #168: the backend rule pack reaches the named agent through
// the generated AGENTS.md and never the main session.
// /context check runs whenever `claude` is on PATH (no model call). Live agent runs cost tokens:
// opt in with OMI_LIVE=1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentLaunch, observeRun } from "../../runtime/adapters/claude/launch.ts";
import { prepareAgent, spawnAgent } from "../../runtime/core/workflow-engine/slice.ts";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const PACK_ID = /^Pack-ID: (.+)$/m.exec(
  readFileSync(join(pluginRoot, "resources/role-rules/backend/backend-implementation.md"), "utf8"),
)?.[1] as string;
/** Every pack's canary: none may reach the main session. */
const ALL_PACK_IDS = (readdirSync(join(pluginRoot, "resources"), { recursive: true }) as string[])
  .filter((f) => f.endsWith(".md"))
  .map((f) => /^Pack-ID: (.+)$/m.exec(readFileSync(join(pluginRoot, "resources", f), "utf8"))?.[1])
  .filter((id): id is string => Boolean(id));
const AGENTS = readdirSync(join(pluginRoot, "agent-pack", "agents")).map((f) =>
  f.replace(/\.md$/, ""),
);
const hasClaude = spawnSync("claude", ["--version"]).status === 0;
const live = hasClaude && process.env.OMI_LIVE === "1";
const worktree = () => mkdtempSync(join(tmpdir(), "omi-t14-"));

test("rule pack declares a Pack-ID canary", () =>
  assert.match(PACK_ID, /^omi-backend-rules\/v\d+$/));

/** `/context` of a fresh session with `--plugin-dir <dir>` (no tokens spent). */
const context = (dir: string) => {
  const r = spawnSync(
    "claude",
    [
      "-p",
      "/context",
      "--plugin-dir",
      dir,
      "--setting-sources",
      "project,local",
      "--no-session-persistence",
    ],
    { cwd: worktree(), encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("ADR-0003 D3: Coordinator session sees only omi-coordinator entry skills, no agents or rule pack", {
  skip: !hasClaude && "claude CLI not on PATH",
}, () => {
  const out = context(pluginRoot);
  for (const a of AGENTS) assert.ok(!out.includes(`omi-engineering:${a}`), `${a} leaked into main`);
  for (const id of ALL_PACK_IDS) assert.ok(!out.includes(id), `${id} leaked into main context`);
  assert.ok(!out.includes("role-rules"));
  const skills = out.split("### Skills")[1] ?? "";
  assert.deepEqual(skills.match(/omi-coordinator:[\w-]+/g)?.sort(), [
    "omi-coordinator:omi-release",
    "omi-coordinator:omi-resume",
    "omi-coordinator:omi-start",
    "omi-coordinator:omi-status",
    "omi-coordinator:omi-task",
  ]);
});

test("agent run (--plugin-dir agent-pack): every role agent by name, no Coordinator skill", {
  skip: !hasClaude && "claude CLI not on PATH",
}, () => {
  const out = context(join(pluginRoot, "agent-pack"));
  for (const a of AGENTS) assert.ok(out.includes(`omi-engineering:${a} | Plugin`), a);
  assert.ok(!out.includes("omi-coordinator:"));
  for (const id of ALL_PACK_IDS) assert.ok(!out.includes(id), `${id} leaked into agent context`);
});

/** Backend Engineer in a fresh task workspace; `roleFiles: false` leaves AGENTS.md out. */
const runAgent = (roleFiles: boolean) => {
  const taskRoot = worktree();
  const repo = join(taskRoot, "repo");
  mkdirSync(repo);
  const o = {
    pluginRoot,
    role: "backend-engineer" as const,
    taskRoot,
    worktree: repo,
    prompt: "Which rule pack did you load? Reply with its Pack-ID only.",
  };
  const l = roleFiles
    ? prepareAgent({ ...o, category: "implementation", edits: false, checks: [] })
    : buildAgentLaunch(o);
  return observeRun(spawnAgent(l));
};

test("live: the pack arrives through the task workspace AGENTS.md; model observed, effort unknown", {
  skip: !live && "set OMI_LIVE=1 (costs tokens)",
}, () => {
  const o = runAgent(true);
  assert.ok(o.result.includes(PACK_ID), o.result);
  assert.match(o.actualModel, /^claude-sonnet-/);
  assert.equal(o.actualEffort, "unknown");
  assert.deepEqual(o.permissionDenials, []);
});

test("live: without the role files the agent has no rules and blocks", {
  skip: !live && "set OMI_LIVE=1 (costs tokens)",
}, () => {
  const o = runAgent(false);
  assert.ok(!o.result.includes(PACK_ID), o.result);
  assert.match(o.result, /BLOCKED/);
});
