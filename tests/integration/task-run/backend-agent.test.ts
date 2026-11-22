// T1.4 canary, skills since #199: the Backend Engineer's skills reach the named agent through the
// task workspace `.claude/skills/` and never the main session.
// /context check runs whenever `claude` is on PATH (no model call). Live agent runs cost tokens:
// opt in with OMI_LIVE=1.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeCode, spawnAgent } from "../../../runtime/harness/adapters/claude-code/harness.ts";
import {
  buildAgentLaunch,
  observeRun,
} from "../../../runtime/harness/adapters/claude-code/launch.ts";
import { roleSkills, writeRoleFiles } from "../../../runtime/task-run/adapters/role-files.ts";
import { prepareAgent } from "../../../runtime/task-run/application/slice.ts";

const pluginRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
/** Every library skill: none may reach the main session; an agent sees only what OMI installed. */
const LIBRARY = readdirSync(join(pluginRoot, "agent-pack", "skill-library"));
/** Skill canary (#199): a default skill of the Backend Engineer. */
const CANARY = "backend-implementation";
const AGENTS = readdirSync(join(pluginRoot, "agent-pack", "agents")).map((f) =>
  f.replace(/\.md$/, ""),
);
const hasClaude = spawnSync("claude", ["--version"]).status === 0;
const live = hasClaude && process.env.OMI_LIVE === "1";
const worktree = () => mkdtempSync(join(tmpdir(), "omi-t14-"));

test("the canary is a default skill of the Backend Engineer", () =>
  assert.ok(roleSkills(pluginRoot, "backend-engineer").default.includes(CANARY)));

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

test("ADR-0003 D3: Coordinator session sees only omi-coordinator entry skills, no agents or role skills", {
  skip: !hasClaude && "claude CLI not on PATH",
}, () => {
  const out = context(pluginRoot);
  for (const a of AGENTS) assert.ok(!out.includes(`omi-engineering:${a}`), `${a} leaked into main`);
  for (const s of LIBRARY) assert.ok(!out.includes(`| ${s} |`), `${s} leaked into main context`);
  const skills = out.split("### Skills")[1] ?? "";
  assert.deepEqual(skills.match(/omi-coordinator:[\w-]+/g)?.sort(), [
    "omi-coordinator:omi-plan",
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
  // DevTask-0063 #197: skill-library/ is not discovered; only skills the CLI copies are seen.
  for (const s of LIBRARY) assert.ok(!out.includes(`| ${s} |`), `skill-library/${s} discovered`);
  // No library skill shares a name with a Claude Code built-in (security-review did, #199).
  const builtIn = [...out.matchAll(/^\| ([\w-]+) \| Built-in \|/gm)].map((m) => m[1]);
  assert.ok(builtIn.length > 0, "built-in skills listed");
  assert.deepEqual(
    LIBRARY.filter((s) => builtIn.includes(s)),
    [],
  );
});

test("agent run in a task workspace: exactly the installed skills are listed (#199)", {
  skip: !hasClaude && "claude CLI not on PATH",
}, () => {
  const taskRoot = worktree();
  const role = "backend-engineer";
  const skills = [...roleSkills(pluginRoot, role).default, "minimal-change"];
  writeRoleFiles({
    taskRoot,
    pluginRoot,
    role,
    category: "implementation",
    edits: true,
    repo: "repo",
    skills,
  });
  const r = spawnSync(
    "claude",
    [
      "-p",
      "/context",
      "--agent",
      `omi-engineering:${role}`,
      "--plugin-dir",
      join(pluginRoot, "agent-pack"),
      "--setting-sources",
      "project,local",
      "--no-session-persistence",
    ],
    { cwd: taskRoot, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(r.status, 0, r.stderr);
  const listed = LIBRARY.filter((s) => r.stdout.includes(`| ${s} | Project |`));
  assert.deepEqual(listed.sort(), skills.sort());
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
    prompt: "Which skills are available to you? Reply with their names only.",
  };
  const l = roleFiles
    ? prepareAgent({
        ...o,
        harness: claudeCode,
        roleFiles: { writeRoleFiles },
        category: "implementation",
        edits: false,
        checks: [],
      })
    : buildAgentLaunch(o);
  return observeRun(spawnAgent(l));
};

test("live: skills arrive through the task workspace; model observed, effort unknown", {
  skip: !live && "set OMI_LIVE=1 (costs tokens)",
}, () => {
  const o = runAgent(true);
  assert.ok(o.result.includes(CANARY), o.result);
  assert.match(o.actualModel, /^claude-sonnet-/);
  assert.equal(o.actualEffort, "unknown");
  assert.deepEqual(o.permissionDenials, []);
});

test("live: without the role files the agent has no rules and blocks", {
  skip: !live && "set OMI_LIVE=1 (costs tokens)",
}, () => {
  const o = runAgent(false);
  assert.ok(!o.result.includes(CANARY), o.result);
  assert.match(o.result, /BLOCKED/);
});
