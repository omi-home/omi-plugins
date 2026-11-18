import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildAgentLaunch,
  observeRun,
  permissionPath,
} from "../../runtime/adapters/claude/launch.ts";

const win = process.platform === "win32";

test("permissionPath uses the //drive/... rule form", () => {
  if (win) assert.equal(permissionPath("E:\\Repo\\x\\resources"), "//e/Repo/x/resources");
  else assert.equal(permissionPath("/home/u/p/resources"), "//home/u/p/resources");
});

test("launch: named agent, resources-only Read grant, prompt via stdin, cwd = worktree", () => {
  const root = win ? "E:\\plug" : "/plug";
  const wt = win ? "E:\\wt\\19" : "/wt/19";
  const l = buildAgentLaunch({
    pluginRoot: root,
    role: "backend-engineer",
    worktree: wt,
    prompt: "do x",
  });
  assert.equal(l.cwd, wt);
  assert.equal(l.stdin, "do x");
  assert.ok(!l.args.includes("do x"));
  const at = (flag: string) => l.args[l.args.indexOf(flag) + 1];
  assert.equal(at("--agent"), "omi-engineering:backend-engineer");
  assert.equal(at("--allowedTools"), `Read(${win ? "//e/plug" : "//plug"}/resources/**)`);
  assert.ok(!l.args.includes("--add-dir"), "--add-dir would grant more than Read");
  assert.ok(!l.args.includes("--plugin-dir"));
  const src = buildAgentLaunch({
    pluginRoot: root,
    role: "backend-engineer",
    worktree: wt,
    prompt: "",
    fromSource: true,
  });
  assert.equal(src.args[src.args.indexOf("--plugin-dir") + 1], root);
  assert.ok(!l.args.includes("--permission-mode"), "read-only by default");
  const dev = buildAgentLaunch({
    pluginRoot: root,
    role: "backend-engineer",
    worktree: wt,
    prompt: "",
    allowedTools: ["Bash(npm test)"],
    acceptEdits: true,
  });
  assert.ok(dev.args.includes("Bash(npm test)"));
  assert.equal(dev.args[dev.args.indexOf("--permission-mode") + 1], "acceptEdits");
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
  });
  assert.throws(() => observeRun('{"type":"assistant"}\n{"type":"res'), { code: "INTERNAL" });
});

test("launch: relative paths rejected", () => {
  assert.throws(
    () =>
      buildAgentLaunch({
        pluginRoot: "plug",
        role: "backend-engineer",
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
