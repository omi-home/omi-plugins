// T2.1 `omi doctor` against throwaway git repos. GitHub checks use the real gh session when present.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Check } from "../../runtime/cli/doctor.ts";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const omi = (args: string[], cwd: string) =>
  spawnSync(process.execPath, [join(pluginRoot, "bin", "omi"), ...args], { cwd, encoding: "utf8" });

function fixture(files: Record<string, string>) {
  const repo = mkdtempSync(join(tmpdir(), "omi-doctor-"));
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  return repo;
}

const doctor = (repo: string) => {
  const r = omi(["doctor", "--output", "json"], repo);
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
