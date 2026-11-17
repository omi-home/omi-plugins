// T1.5 routing smoke: /omi-engineering:omi-task runs deterministic work through CLI tools and
// hands implementation off without touching files or role-rules. Costs tokens: OMI_LIVE=1.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const live = spawnSync("claude", ["--version"]).status === 0 && process.env.OMI_LIVE === "1";
const skip = !live && "set OMI_LIVE=1 (costs tokens)";

interface ToolUse {
  name: string;
  input: Record<string, unknown>;
}

function runTask(request: string) {
  const repo = mkdtempSync(join(tmpdir(), "omi-t15-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" });
  git("init", "-q", "-b", "develop");
  writeFileSync(join(repo, "README.md"), "fixture\n");
  git("add", ".");
  git(
    "-c",
    "user.name=omi",
    "-c",
    "user.email=omi@example.invalid",
    "commit",
    "-qm",
    "seed fixture",
  );

  const r = spawnSync(
    "claude",
    [
      "-p",
      `/omi-engineering:omi-task ${request}`,
      "--plugin-dir",
      pluginRoot,
      "--model",
      "sonnet",
      "--allowedTools",
      "Bash(git *)",
      "--output-format",
      "stream-json",
      "--verbose",
      "--setting-sources",
      "project,local",
      "--no-session-persistence",
    ],
    { cwd: repo, encoding: "utf8", timeout: 300_000 },
  );
  assert.equal(r.status, 0, r.stderr);
  const events = r.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .map((l) => JSON.parse(l));
  const tools: ToolUse[] = events
    .filter((e) => e.type === "assistant")
    .flatMap((e) => e.message?.content ?? [])
    .filter((c: { type: string }) => c.type === "tool_use");
  const result = String(events.findLast((e) => e.type === "result")?.result ?? "");
  // Main never touches the specialist packs, by any tool.
  assert.ok(!JSON.stringify(tools).includes("role-rules"), JSON.stringify(tools));
  return { tools, result };
}

test("live: deterministic request is answered with git, no agent", { skip }, () => {
  const { tools, result } = runTask("what is the current branch and the latest commit message?");
  assert.ok(
    tools.some((t) => t.name === "Bash" && /^git\b/.test(String(t.input.command))),
    JSON.stringify(tools),
  );
  assert.ok(!tools.some((t) => t.name === "Agent" || t.name === "Task"));
  assert.match(result, /develop/);
  assert.match(result, /seed fixture/);
});

test("live: implementation request is handed off, no edits", { skip }, () => {
  const { tools, result } = runTask("implement a function add(a, b) in math.js");
  const forbidden = ["Edit", "Write", "NotebookEdit", "Agent", "Task"];
  assert.deepEqual(
    tools.filter((t) => forbidden.includes(t.name)),
    [],
  );
  assert.match(result, /HANDOFF:.*backend-engineer/);
});
