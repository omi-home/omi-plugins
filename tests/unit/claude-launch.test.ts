// DevTask-0055 #168: the agent runs as a full Claude Code session in its task workspace.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { agentEnv, buildAgentLaunch, observeRun } from "../../runtime/adapters/claude/launch.ts";
import { spawnAgent } from "../../runtime/core/workflow-engine/slice.ts";

const win = process.platform === "win32";
const root = win ? "E:/plug" : "/plug";
const task = win ? "E:/ws-task-19" : "/ws-task-19";
const repo = join(task, "omi-plugins");
const host = {
  PATH: "/bin",
  HOME: "/home/u",
  CLAUDE_CODE_OAUTH_TOKEN: "tok",
  ANTHROPIC_API_KEY: "sk-host",
  GH_TOKEN: "ghp_host",
  CLAUDECODE: "1",
  NODE_TEST_CONTEXT: "child",
};

test("launch: named agent, cwd = task workspace, plugin dir, project settings, prompt via stdin", () => {
  const l = buildAgentLaunch({
    pluginRoot: root,
    role: "backend-engineer",
    taskRoot: task,
    worktree: repo,
    prompt: "do x",
    hostEnv: host,
  });
  assert.equal(l.cwd, task);
  assert.equal(l.stdin, "do x");
  assert.ok(!l.args.includes("do x"));
  const at = (flag: string) => l.args[l.args.indexOf(flag) + 1];
  assert.equal(at("--agent"), "omi-engineering:backend-engineer");
  assert.equal(at("--plugin-dir"), join(root, "agent-pack"));
  assert.equal(at("--setting-sources"), "project,local");
  assert.ok(!l.args.includes("--add-dir"), "the clone is inside the task workspace");
  assert.ok(!l.args.includes("--allowedTools"), "no grant on plugin resources any more");
  assert.ok(!l.args.includes("--permission-mode"), "read-only by default");
  assert.equal(l.configDir, join(task, ".omi-home", "claude"));
  const dev = buildAgentLaunch({
    pluginRoot: root,
    role: "backend-engineer",
    taskRoot: task,
    worktree: repo,
    prompt: "",
    allowedTools: ["Bash(npm test)"],
    acceptEdits: true,
    hostEnv: host,
  });
  assert.equal(dev.args[dev.args.indexOf("--allowedTools") + 1], "Bash(npm test)");
  assert.equal(dev.args[dev.args.indexOf("--permission-mode") + 1], "acceptEdits");
  const analysis = buildAgentLaunch({
    pluginRoot: root,
    role: "business-analyst",
    taskRoot: task,
    worktree: root,
    prompt: "",
    hostEnv: host,
  });
  assert.equal(analysis.args[analysis.args.indexOf("--add-dir") + 1], root);
});

test("env: built from the allowlist with its own CLAUDE_CONFIG_DIR; host secrets stay out", () => {
  const l = buildAgentLaunch({
    pluginRoot: root,
    role: "code-reviewer",
    taskRoot: task,
    worktree: repo,
    prompt: "",
    hostEnv: host,
  });
  assert.deepEqual(l.env, {
    PATH: "/bin",
    HOME: "/home/u",
    CLAUDE_CODE_OAUTH_TOKEN: "tok",
    CLAUDE_CONFIG_DIR: join(task, ".omi-home", "claude"),
  });
  assert.deepEqual(agentEnv({ Path: "C:/bin", SystemRoot: "C:/Windows" }), {
    Path: "C:/bin",
    SystemRoot: "C:/Windows",
  });
});

test("spawnAgent: no token → CONFIG_INVALID before anything runs; config dir fresh per run", () => {
  const taskRoot = mkdtempSync(join(tmpdir(), "omi-launch-"));
  const base = { pluginRoot: root, role: "code-reviewer" as const, taskRoot, prompt: "" };
  const noToken = buildAgentLaunch({ ...base, worktree: taskRoot, hostEnv: { PATH: "/bin" } });
  assert.throws(() => spawnAgent(noToken), { code: "CONFIG_INVALID", message: /setup-token/ });
  assert.ok(!existsSync(noToken.configDir));
  const l = buildAgentLaunch({
    ...base,
    worktree: taskRoot,
    hostEnv: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
  });
  const stale = join(l.configDir, "stale.json");
  mkdirSync(l.configDir, { recursive: true });
  writeFileSync(stale, "{}");
  // A command that does not exist: the config dir is prepared, then the spawn fails.
  assert.throws(() => spawnAgent({ ...l, command: "omi-no-such-cli" as "claude" }), {
    code: "INTERNAL",
  });
  assert.ok(existsSync(l.configDir));
  assert.ok(!existsSync(stale));
});

test("observeRun: cut transcript lines skipped (#19 CR-001); host usage read; no result → OmiError", () => {
  const out = observeRun(
    [
      '{"type":"assistant","message":{"model":"claude-opus-5-5"}}',
      '{"type":"assistant","message":{"mod',
      JSON.stringify({
        type: "result",
        result: "ok",
        usage: { input_tokens: 3, output_tokens: 4, cache_creation_input_tokens: 9 },
      }),
    ].join("\n"),
  );
  assert.deepEqual(out.usage, {
    inputTokens: 3,
    outputTokens: 4,
    cacheReadTokens: undefined,
    cacheCreationTokens: 9,
    thinkingTokens: undefined,
    costUsd: undefined,
    numTurns: undefined,
  });
  assert.throws(() => observeRun('{"type":"assistant"}\n{"type":"res'), { code: "INTERNAL" });
});

test("launch: relative paths rejected", () => {
  assert.throws(
    () =>
      buildAgentLaunch({
        pluginRoot: "plug",
        role: "backend-engineer",
        taskRoot: "/t",
        worktree: "/wt",
        prompt: "",
      }),
    /pluginRoot must be an absolute path/,
  );
});

const line = (o: object) => JSON.stringify(o);

test("observeRun: model from assistant messages, not modelUsage; effort unknown; denials", () => {
  const transcript = [
    "not json",
    line({ type: "system", subtype: "init", model: "claude-sonnet-5-5" }),
    line({ type: "assistant", message: { model: "claude-sonnet-5-5", content: [] } }),
    line({
      type: "result",
      is_error: false,
      result: "BLOCKED: rule pack unreadable",
      modelUsage: { "claude-haiku-5-5": {}, "claude-sonnet-5-5": {} },
      permission_denials: [{ tool_name: "Read", tool_input: { file_path: "E:\\p\\r.md" } }],
    }),
  ].join("\n");
  assert.deepEqual(observeRun(transcript), {
    actualModel: "claude-sonnet-5-5",
    actualEffort: "unknown",
    isError: false,
    result: "BLOCKED: rule pack unreadable",
    permissionDenials: ["Read:E:\\p\\r.md"],
  });
  assert.equal(observeRun(line({ type: "result", result: "" })).actualModel, "unknown");
  assert.throws(() => observeRun(""), /no result event/);
});

test("observeRun: thinking tokens from usage.output_tokens_details (Spike-0010), flat field as fallback (#214)", () => {
  const think = (usage: object) =>
    observeRun(
      JSON.stringify({
        type: "result",
        result: "ok",
        usage: { input_tokens: 1, output_tokens: 2, ...usage },
      }),
    ).usage?.thinkingTokens;
  assert.equal(think({ output_tokens_details: { thinking_tokens: 9 } }), 9);
  assert.equal(think({ thinking_tokens: 4 }), 4);
  assert.equal(think({}), undefined);
});
