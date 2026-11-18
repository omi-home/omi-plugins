// T2.1 `omi doctor` against throwaway git repos. GitHub checks use the real gh session when present.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { agentsMdInContext, type Check, pluginRootCheck } from "../../runtime/cli/doctor.ts";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const omi = (args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(process.execPath, [join(pluginRoot, "bin", "omi"), ...args], {
    cwd,
    encoding: "utf8",
    env,
  });

function fixture(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "omi-doctor-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  return repo;
}

const doctor = (repo: string, env?: NodeJS.ProcessEnv) => {
  const r = omi(["doctor", "--output", "json"], repo, env);
  const checks = JSON.parse(r.stdout).data.checks as Check[];
  return {
    code: r.status,
    stdout: r.stdout,
    check: (n: string) => checks.find((c) => c.name === n),
  };
};

const CONFIG = "github:\n  owner: omi-home\n  repo: omi-plugins\n  projectNumber: 2\n";

test("missing config fails, AGENTS.md absence warns", () => {
  const d = doctor(fixture({}));
  assert.equal(d.code, 1);
  assert.equal(d.check("config")?.status, "fail");
  assert.match(d.check("config")?.detail ?? "", /not found/);
  assert.equal(d.check("instructions")?.status, "warn");
});

test("invalid config lists paths and never echoes values", () => {
  const tok = `ghp_${"s".repeat(36)}`;
  const d = doctor(fixture({ ".omi/config.yaml": `${CONFIG}  token: ${tok}\n`, "AGENTS.md": "x" }));
  assert.equal(d.code, 1);
  assert.equal(d.check("config")?.status, "fail");
  assert.ok(!d.stdout.includes(tok), d.stdout);
  assert.equal(
    doctor(fixture({ ".omi/config.yaml": "github: [" })).check("config")?.status,
    "fail",
  );
});

test("CLAUDE.md shadows AGENTS.md → warn", () => {
  const d = doctor(fixture({ "AGENTS.md": "x", "CLAUDE.md": "y", ".omi/config.yaml": CONFIG }));
  assert.equal(d.check("instructions")?.status, "warn");
  assert.match(d.check("instructions")?.detail ?? "", /CLAUDE\.md/);
  assert.equal(d.check("config")?.status, "pass");
});

test("valid config: public repo with develop default passes GitHub checks when authenticated", () => {
  const d = doctor(fixture({ "AGENTS.md": "x", ".omi/config.yaml": CONFIG }));
  assert.equal(d.check("config")?.status, "pass");
  assert.equal(d.check("instructions")?.status, "pass");
  if (d.check("github-auth")?.status !== "pass") return; // no gh session on this machine
  assert.equal(d.check("github-visibility")?.status, "pass");
  assert.equal(d.check("default-branch")?.status, "pass");
  assert.equal(d.check("github-permission")?.status, "pass");
  assert.equal(d.check("github-project")?.status, "pass");
  assert.equal(d.code, 0, d.stdout);
});

test("network failure reaching GitHub is transient: exit 75, checks kept (CR-001/CR-002)", () => {
  const repo = fixture({ "AGENTS.md": "x", ".omi/config.yaml": CONFIG });
  const d = doctor(repo, { ...process.env, HTTPS_PROXY: "http://127.0.0.1:9", GH_TOKEN: "x" });
  assert.equal(d.check("github-auth")?.status, "fail");
  assert.equal(d.check("github-auth")?.code, "NETWORK");
  assert.equal(d.check("config")?.status, "pass");
  // Transient only when nothing else failed: a machine without claude (CI) is a plain failure.
  assert.equal(d.code, d.check("claude")?.status === "pass" ? 75 : 1, d.stdout);
});

const live = spawnSync("claude", ["--version"]).status === 0 && process.env.OMI_LIVE === "1";

test("live: plugin bin/ puts omi on PATH inside the agent's Bash", {
  skip: !live && "set OMI_LIVE=1 (costs tokens)",
}, () => {
  const r = spawnSync(
    "claude",
    [
      "-p",
      "Run exactly this Bash command and reply with its raw stdout only: omi --output json version",
      "--plugin-dir",
      pluginRoot,
      "--model",
      "haiku",
      "--allowedTools",
      "Bash(omi *)",
      "--setting-sources",
      "project,local",
      "--no-session-persistence",
    ],
    { cwd: mkdtempSync(join(tmpdir(), "omi-path-")), encoding: "utf8", timeout: 300_000 },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /"ok":true,"command":"version"/);
});

test("workflow adapter off: doctor warns, direct dispatch stays the path (#56 fallback)", () => {
  const repo = fixture({ "AGENTS.md": "# x\n", ".omi/config.yaml": CONFIG });
  const conf = mkdtempSync(join(tmpdir(), "omi-claude-conf-"));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: conf };
  assert.equal(doctor(repo, env).check("workflows")?.status, "warn"); // no settings.json
  assert.match(String(doctor(repo, env).check("workflows")?.detail), /direct dispatch unaffected/);
  writeFileSync(join(conf, "settings.json"), JSON.stringify({ enableWorkflows: true }));
  assert.equal(doctor(repo, env).check("workflows")?.status, "pass");
});

test("version table lists node, git, gh and claude; plugin root is checked (#68)", () => {
  const d = doctor(fixture({ "AGENTS.md": "x" }));
  for (const n of ["node", "git", "gh", "claude", "plugin-root"]) {
    assert.ok(d.check(n), `missing check ${n}`);
  }
});

test("plugin root with a space or glob character warns: Read(...) rule not verified (#19 CR-002)", () => {
  assert.equal(pluginRootCheck("C:\Users\Admin\.claude\plugins\cache\omi").status, "pass");
  assert.equal(pluginRootCheck("/home/a/.claude/plugins/cache/omi").status, "pass");
  for (const bad of ["C:\Users\John Doe\omi", "/opt/omi[1]", "/opt/omi*", "/opt/{a}"]) {
    assert.equal(pluginRootCheck(bad).status, "warn", bad);
  }
});

test("Windows: a .cmd shim alone on PATH is named, not reported as missing", {
  skip: process.platform !== "win32" && "Windows only",
}, () => {
  const bin = mkdtempSync(join(tmpdir(), "omi-shim-"));
  writeFileSync(join(bin, "claude.cmd"), "@echo off\r\nexit /b 1\r\n");
  const sys = join(process.env.SystemRoot ?? "C:\Windows", "System32");
  const d = doctor(fixture({ "AGENTS.md": "x" }), { ...process.env, PATH: `${bin};${sys}` });
  assert.equal(d.check("claude")?.status, "fail");
  assert.match(d.check("claude")?.detail ?? "", /script shim.*claude\.cmd.*native claude\.exe/);
});

test("agents-md: /context Memory Files row decides whether AGENTS.md is loaded (#23 CR-003)", () => {
  const ctx = (rows: string) =>
    `### Memory Files\n\n| Type | Path | Tokens |\n|---|---|---|\n${rows}\n`;
  assert.ok(agentsMdInContext(ctx("| Project | E:\repo\AGENTS.md | 2.6k |")));
  assert.ok(agentsMdInContext(ctx("| Project | /home/a/repo/AGENTS.md | 12 |")));
  assert.ok(!agentsMdInContext(ctx("| AutoMem | C:\m\MEMORY.md | 246 |")));
  assert.ok(!agentsMdInContext(ctx("| User | C:\Users\a\.claude\AGENTS.md | 5 |")));
});

test("agents-md: reported only when instructions pass; real claude when installed", () => {
  const d = doctor(fixture({ "AGENTS.md": "# rules\n" }));
  const c = d.check("agents-md");
  assert.ok(c, "agents-md check missing");
  if (c.status === "warn") assert.match(c.detail, /could not run|not in Claude Code's memory/);
  const none = doctor(fixture({}));
  assert.equal(none.check("agents-md"), undefined);
});
