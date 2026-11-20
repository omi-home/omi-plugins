// DevTask-0064 #198 (ADR-0003 D5/D6): the generated AGENTS.md of a role holds only rules, fixed
// part first; the agent-pack hook blocks git push, gh and writes outside the task workspace.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { AGENT_PACK } from "../../runtime/adapters/claude/launch.ts";
import { agentPreToolUse, type HookInput } from "../../runtime/cli/hook.ts";
import { READ_ONLY_ROLES, Role } from "../../runtime/core/contracts.ts";
import { writeRoleFiles } from "../../runtime/resources/role-files.ts";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const bin = join(pluginRoot, "bin", "omi");
const part = (name: string) =>
  readFileSync(join(pluginRoot, AGENT_PACK, "agents-md", `${name}.md`), "utf8").trim();

const agentsMd = (role: Role) => {
  const taskRoot = mkdtempSync(join(tmpdir(), "omi-rules-"));
  writeRoleFiles({
    taskRoot,
    pluginRoot,
    role,
    category: "implementation",
    edits: false,
    repo: "app",
  });
  return readFileSync(join(taskRoot, "AGENTS.md"), "utf8");
};

test("AGENTS.md per role: fixed core first, then edit/read-only DoD, repo line, the role's part", () => {
  const first: string[] = [];
  for (const role of Role.options) {
    const md = agentsMd(role);
    const readOnly = READ_ONLY_ROLES.includes(role);
    const order = [
      part("core"),
      part(readOnly ? "read-only" : "editing"),
      "The product repository is `app/`",
      part(role),
    ].map((s) => md.indexOf(s));
    assert.ok(
      order.every((i) => i > 0),
      `${role}: every part present`,
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      `${role}: order`,
    );
    assert.ok(!md.includes(part(readOnly ? "editing" : "read-only")), `${role}: one DoD only`);
    first.push(md.slice(0, md.indexOf(part(readOnly ? "read-only" : "editing"))));
  }
  assert.equal(new Set(first).size, 1, "the fixed prefix is the same for every role");
});

test("role parts name their section headings, finding prefix and verdict", () => {
  assert.match(
    part("business-analyst"),
    /`analysis`[\s\S]*`### Acceptance criteria`[\s\S]*`BA-001`/,
  );
  assert.match(part("ui-ux-designer"), /`design`[\s\S]*`UX-001`/);
  assert.match(part("solution-architect"), /`architecture`[\s\S]*`ARC-001`/);
  assert.match(part("code-reviewer"), /`CR-001`[\s\S]*security-review:/);
  assert.match(part("security-reviewer"), /`SEC-001`[\s\S]*`critical`/);
  assert.match(part("manual-qa-engineer"), /`qa`[\s\S]*`QA-001`/);
  assert.match(part("automation-qa-engineer"), /`AQA-001`/);
  for (const name of ["core", "editing", "read-only", ...Role.options]) {
    assert.doesNotMatch(part(name), /Pack-ID|rule pack/, name);
  }
});

const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-agent-ws-")));
const call = (tool_name: string, tool_input: HookInput["tool_input"]) =>
  agentPreToolUse({ cwd: ws, tool_name, tool_input }, ws);

test("agent hook: git push and gh blocked in any form; local git and checks pass", () => {
  for (const c of [
    "git push",
    "git -C app push origin feature/1-x",
    'git -C "my app" push',
    "cd app && git push -u origin HEAD",
    "FOO=1 gh pr create",
    "gh issue comment 1 --body x",
    "npm test; gh api user",
  ]) {
    assert.ok(call("Bash", { command: c }), c);
  }
  assert.ok(call("PowerShell", { command: "git -C app push" }));
  for (const c of [
    "git -C app commit -m x",
    "git -C app status",
    "cd app && npm test",
    "echo gh",
  ]) {
    assert.equal(call("Bash", { command: c }), null, c);
  }
});

test("agent hook: git stays read-only (no difftool, --ext-diff, --extcmd, --output)", () => {
  for (const c of [
    "git difftool -x sh",
    "git -C omi-plugins difftool",
    "git diff --ext-diff",
    "git log --output=x",
    "git show --output x",
    "git diff --extcmd=y",
  ]) {
    assert.match(call("Bash", { command: c }) ?? "", /read-only/, c);
  }
  for (const c of ["git diff", "git -C omi-plugins log -5", "git diff -- src/a.ts"]) {
    assert.equal(call("Bash", { command: c }), null, c);
  }
});

test("agent hook: file tools write only inside the task workspace", () => {
  assert.equal(call("Write", { file_path: join(ws, "app", "src", "a.ts") }), null);
  assert.equal(call("Edit", { file_path: "app/src/a.ts" }), null, "relative to cwd");
  assert.match(
    call("Write", { file_path: join(tmpdir(), "x.ts") }) ?? "",
    /inside its task workspace/,
  );
  assert.ok(call("Edit", { file_path: "../outside.ts" }));
  assert.ok(call("NotebookEdit", { notebook_path: join(tmpdir(), "n.ipynb") }));
  assert.equal(call("Read", { file_path: join(tmpdir(), "x.ts") }), null, "reads are not hooked");
});

test("bin/omi hook agent-pre-tool-use: exit 2 + reason; CLAUDE_PROJECT_DIR is the workspace", () => {
  const run = (input: HookInput) =>
    spawnSync(process.execPath, [bin, "hook", "agent-pre-tool-use"], {
      input: JSON.stringify(input),
      encoding: "utf8",
      env: { ...process.env, CLAUDE_PROJECT_DIR: ws },
    });
  const r = run({ cwd: ws, tool_name: "Bash", tool_input: { command: "git -C app push" } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /agents never push/);
  const out = run({
    cwd: join(ws, "app"),
    tool_name: "Write",
    tool_input: { file_path: join(tmpdir(), "y") },
  });
  assert.equal(out.status, 2, "cwd inside the workspace does not widen it");
  assert.equal(
    run({ cwd: ws, tool_name: "Bash", tool_input: { command: "git status" } }).status,
    0,
  );
});

test("agent-pack/hooks/hooks.json runs the agent hook through the plugin's own bin/omi", () => {
  const hooks = JSON.parse(
    readFileSync(join(pluginRoot, AGENT_PACK, "hooks", "hooks.json"), "utf8"),
  );
  const [entry] = hooks.hooks.PreToolUse;
  assert.equal(entry.matcher, "Edit|Write|MultiEdit|NotebookEdit|Bash|PowerShell");
  const command: string = entry.hooks[0].command;
  assert.match(command, /hook agent-pre-tool-use$/);
  const target = command.replace(/^node "\$\{CLAUDE_PLUGIN_ROOT\}\/(.*)" hook .*$/, "$1");
  assert.equal(realpathSync.native(join(pluginRoot, AGENT_PACK, target)), realpathSync.native(bin));
});

const hasClaude = spawnSync("claude", ["--version"]).status === 0;

test("/context of an agent run: the role AGENTS.md loads; path-scoped repo rules wait for a match", {
  skip: !hasClaude && "claude CLI not on PATH",
}, () => {
  // Verified on 2.1.325: `<repo>/.claude/rules/*.md` (with or without `paths`) load only once the
  // agent reads a matching file in the repo, so OMI never copies a repository's rules.
  const taskRoot = mkdtempSync(join(tmpdir(), "omi-rules-ctx-"));
  mkdirSync(join(taskRoot, "app", ".claude", "rules"), { recursive: true });
  writeFileSync(
    join(taskRoot, "app", ".claude", "rules", "api.md"),
    '---\npaths:\n  - "src/api/**"\n---\nAPI-RULE-CANARY\n',
  );
  const role = "backend-engineer";
  writeRoleFiles({
    taskRoot,
    pluginRoot,
    role,
    category: "implementation",
    edits: true,
    repo: "app",
  });
  const r = spawnSync(
    "claude",
    [
      "-p",
      "/context",
      "--agent",
      `omi-engineering:${role}`,
      "--plugin-dir",
      join(pluginRoot, AGENT_PACK),
      "--setting-sources",
      "project,local",
      "--no-session-persistence",
    ],
    { cwd: taskRoot, encoding: "utf8", timeout: 120_000 },
  );
  assert.equal(r.status, 0, r.stderr);
  const memory = r.stdout.split("### Memory Files")[1] ?? "";
  assert.match(memory, /AGENTS\.md/);
  assert.doesNotMatch(memory, /api\.md/);
});
