// DevTask-0055 #168: the agent runs as a full Claude Code session in its task workspace.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claudeCode, spawnAgent } from "../../../runtime/harness/adapters/claude-code/harness.ts";
import {
  agentEnv,
  buildAgentLaunch,
  detectQuota,
  observeRun,
} from "../../../runtime/harness/adapters/claude-code/launch.ts";
import { harnessFor } from "../../../runtime/harness/adapters/registry.ts";
import type { Selection } from "../../../runtime/profile/domain/selection.ts";
import { OmiError } from "../../../runtime/shared/errors/errors.ts";

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

test("port: the registry picks the adapter by Profile.harness and it declares its capabilities", () => {
  assert.equal(harnessFor("claudecode"), claudeCode);
  assert.equal(harnessFor(), claudeCode, "no profile selected → the default harness");
  assert.equal(claudeCode.name, "claudecode");
  assert.equal(claudeCode.agentPack, "agent-pack");
  assert.deepEqual([...claudeCode.capabilities].sort(), ["effort", "hooks", "skills", "subagent"]);
  assert.match(String(claudeCode.versionRefusal(undefined)), /not found on PATH/);
  assert.equal(claudeCode.versionRefusal("2.1.325"), null);
  assert.match(String(claudeCode.versionRefusal("2.2.0")), /outside the verified range/);
  const l = claudeCode.launch({
    pluginRoot: root,
    role: "code-reviewer",
    taskRoot: task,
    worktree: repo,
    prompt: "p",
    hostEnv: host,
  });
  assert.equal(l.command, "claude");
  assert.equal(claudeCode.observe('{"type":"result","result":"ok"}').result, "ok");
  assert.equal(
    claudeCode.detectQuota('{"type":"result","is_error":true,"api_error_status":429}')?.signal,
    "http_429",
  );
});

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
  assert.throws(() => spawnAgent({ ...l, command: "omi-no-such-cli" }), {
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
      permission_denials: [
        { tool_name: "Read", tool_input: { file_path: "E:\\p\\r.md" } },
        { tool_name: "Bash", tool_input: { command: "cd app && npm run check" } },
        { tool_name: "WebFetch", tool_input: {} },
      ],
    }),
  ].join("\n");
  assert.deepEqual(observeRun(transcript), {
    actualModel: "claude-sonnet-5-5",
    actualEffort: "unknown",
    thinkingObserved: false,
    isError: false,
    result: "BLOCKED: rule pack unreadable",
    // #252: a Bash denial names its command.
    permissionDenials: ["Read:E:\\p\\r.md", "Bash:cd app && npm run check", "WebFetch:"],
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

const profile = (auth: Selection["profile"]["auth"], secret?: string): Selection => ({
  profile: {
    name: "p1",
    harness: "claudecode",
    disabled: false,
    auth,
    models: ["claude-opus-5-5"],
    efforts: ["high"],
  },
  model: "claude-opus-5-5",
  effort: "high",
  reason: "complex task",
  secret: () => {
    if (secret === undefined) throw new OmiError("CONFIG_INVALID", "no token");
    return secret;
  },
});

test("profile (#217): model/effort passed; auth env from the profile only, host auth stays out", () => {
  const base = {
    pluginRoot: root,
    role: "code-reviewer" as const,
    taskRoot: task,
    worktree: repo,
    prompt: "",
    hostEnv: { ...host, OMI_SUB: "sub-tok", OMI_GW: "gw-key" },
  };
  const sub = buildAgentLaunch({
    ...base,
    selection: profile({ type: "subscription", tokenEnv: "OMI_SUB" }, "sub-tok"),
  });
  assert.deepEqual(sub.args.slice(sub.args.indexOf("--model"), sub.args.indexOf("--model") + 4), [
    "--model",
    "claude-opus-5-5",
    "--effort",
    "high",
  ]);
  assert.deepEqual(sub.env, {
    PATH: "/bin",
    HOME: "/home/u",
    CLAUDE_CODE_OAUTH_TOKEN: "sub-tok",
    CLAUDE_CONFIG_DIR: join(task, ".omi-home", "claude"),
  });
  const gw = { type: "gateway", baseUrl: "https://gw.example.com", keyEnv: "OMI_GW" } as const;
  const key = buildAgentLaunch({
    ...base,
    selection: profile({ ...gw, scheme: "x-api-key" }, "gw-key"),
  });
  assert.equal(key.env.ANTHROPIC_API_KEY, "gw-key");
  assert.equal(key.env.ANTHROPIC_BASE_URL, "https://gw.example.com");
  assert.equal(key.env.CLAUDE_CODE_OAUTH_TOKEN, undefined); // the host token would not win, but stays out
  const bearer = buildAgentLaunch({
    ...base,
    selection: profile({ ...gw, scheme: "bearer" }, "gw-key"),
  });
  assert.equal(bearer.env.ANTHROPIC_AUTH_TOKEN, "gw-key");
  assert.equal(bearer.env.ANTHROPIC_API_KEY, undefined); // host sk-host never passes
  assert.throws(
    () =>
      buildAgentLaunch({
        ...base,
        selection: profile({ type: "subscription", tokenEnv: "OMI_SUB" }),
      }),
    { code: "CONFIG_INVALID", message: /no token/ },
  );
  // The host's own copy of the token variable is not the source any more.
  assert.ok(!("OMI_SUB" in sub.env));
  // No selection: unchanged (no --model, host token inherited).
  assert.ok(!buildAgentLaunch(base).args.includes("--model"));
});

test("routing (#250): no profile → --model/--effort from agents.routing[role]", () => {
  const base = {
    pluginRoot: root,
    role: "backend-engineer" as const,
    taskRoot: task,
    worktree: repo,
    prompt: "",
    hostEnv: host,
  };
  const l = buildAgentLaunch({ ...base, route: { model: "haiku", effort: "low" } });
  const i = l.args.indexOf("--model");
  assert.deepEqual(l.args.slice(i, i + 4), ["--model", "haiku", "--effort", "low"]);
  const r = buildAgentLaunch({
    ...base,
    role: "code-reviewer",
    route: { model: "opus", effort: "high" },
  });
  assert.equal(r.args[r.args.indexOf("--model") + 1], "opus");
});

test("observeRun: a thinking block is the observable trace of effort", () => {
  const think = (type: string) =>
    observeRun(
      [
        line({ type: "assistant", message: { model: "m", content: [{ type }] } }),
        line({ type: "result", result: "" }),
      ].join("\n"),
    ).thinkingObserved;
  assert.equal(think("thinking"), true);
  assert.equal(think("redacted_thinking"), true);
  assert.equal(think("text"), false);
});

test("detectQuota (#218): rejected / 429 / 402 are quota; a warning or an auth error is not", () => {
  const t = (...e: unknown[]) =>
    e.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join("\n");
  const warn = { type: "rate_limit_event", rate_limit_info: { status: "allowed_warning" } };
  const rejected = { type: "rate_limit_event", rate_limit_info: { status: "rejected" } };
  const fail = (s: number) => ({ type: "result", is_error: true, api_error_status: s });
  assert.equal(detectQuota(t(warn, { type: "result", is_error: false })), null);
  assert.equal(detectQuota(t(fail(401))), null);
  assert.equal(detectQuota(t(warn, rejected, "{cut"))?.signal, "rate_limit_rejected");
  assert.equal(detectQuota(t(fail(429)))?.signal, "http_429");
  assert.deepEqual(detectQuota(t(fail(402))), { signal: "http_402", event: fail(402) });
});
