// T3.4 deterministic gate: pass/skip, failed command, timeout, missing tool, huge output
// bounded, redacted summary, full log retained. Real processes, no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../../../runtime/shared/config.ts";
import { runChecks, SUMMARY_CHARS } from "../../../runtime/task-run/adapters/checks.ts";

import { makeRepo } from "../../unit/architecture/helpers.ts";

const dir = () => mkdtempSync(join(tmpdir(), "omi-checks-"));
const node = (code: string) => `node -e "${code}"`;
const checks = (c: Record<string, unknown>) =>
  parseConfig({ github: { owner: "o", repo: "r", projectNumber: 1 }, checks: c }).checks;

test("config: checks default to none; unknown check names and empty commands rejected", () => {
  assert.deepEqual(checks({}), {});
  assert.equal(checks({ test: { run: "npm test" } }).test?.timeoutSec, 600);
  assert.throws(() => checks({ deploy: { run: "x" } }), { code: "CONFIG_INVALID" });
  assert.throws(() => checks({ lint: { run: " " } }), { code: "CONFIG_INVALID" });
});

test("all configured checks pass, unset ones are skipped, nothing summarized on pass", () => {
  const logDir = join(dir(), "logs");
  const r = runChecks({
    worktree: dir(),
    logDir,
    checks: checks({ lint: { run: node("console.log(1)") } }),
  });
  assert.equal(r.passed, true);
  const lint = r.results.find((x) => x.name === "lint");
  assert.equal(lint?.outcome, "pass");
  assert.equal(lint?.summary, "");
  assert.equal(readFileSync(lint?.logPath ?? "", "utf8").trim(), "1");
  assert.deepEqual(
    r.results.filter((x) => x.outcome === "skipped").map((x) => x.name),
    ["format", "architecture", "build", "test", "scan"],
  );
});

const GOOD_REPO = {
  "src/kernel/k.ts": "export const k = 1;\n",
  "src/billing/domain/a.ts": 'import { k } from "../../kernel/k.ts";\nexport const a = k;\n',
};

test("architecture gate: no contract is skipped; valid passes; violation fails (AC-4)", () => {
  const none = runChecks({ worktree: dir(), logDir: dir(), checks: checks({}) });
  assert.equal(none.results.find((x) => x.name === "architecture")?.outcome, "skipped");
  assert.equal(none.passed, true);

  const ok = makeRepo(GOOD_REPO);
  const bad = makeRepo({
    ...GOOD_REPO,
    "src/billing/domain/bad.ts": 'import "node:fs";\n',
    "src/mystery/m.ts": "export {};\n",
  });
  try {
    const pass = runChecks({ worktree: ok.dir, logDir: dir(), checks: checks({}) });
    const a = pass.results.find((x) => x.name === "architecture");
    assert.equal(a?.outcome, "pass");
    assert.equal(pass.passed, true);
    assert.ok(a?.logPath);

    const fail = runChecks({ worktree: bad.dir, logDir: dir(), checks: checks({}) });
    const b = fail.results.find((x) => x.name === "architecture");
    assert.equal(b?.outcome, "fail");
    assert.equal(fail.passed, false);
    assert.match(b?.summary ?? "", /\[forbidden-package\]/);
    assert.match(b?.summary ?? "", /\[undeclared-module\]/);
  } finally {
    ok.cleanup();
    bad.cleanup();
  }
});

test("architecture gate: configured checks.architecture wins; config.architecture.contract is honored", () => {
  const bad = makeRepo({ "src/mystery/m.ts": "export {};\n" });
  try {
    const own = runChecks({
      worktree: bad.dir,
      logDir: dir(),
      checks: checks({ architecture: { run: node("console.log('mine')") } }),
    });
    assert.equal(own.results.find((x) => x.name === "architecture")?.outcome, "pass");
    // A contract at another path: the default file is absent there, so nothing runs.
    const elsewhere = runChecks({
      worktree: bad.dir,
      logDir: dir(),
      checks: checks({}),
      architecture: { contract: "docs/arch.yaml" },
    });
    assert.equal(elsewhere.results.find((x) => x.name === "architecture")?.outcome, "skipped");
  } finally {
    bad.cleanup();
  }
});

test("config: architecture.contract defaults, rejects '..' and unknown fields", () => {
  const cfg = (a: unknown) =>
    parseConfig({ github: { owner: "o", repo: "r", projectNumber: 1 }, architecture: a });
  assert.equal(cfg({}).architecture?.contract, "omi-architecture.yaml");
  assert.equal(cfg({ contract: "docs/a.yaml" }).architecture?.contract, "docs/a.yaml");
  assert.throws(() => cfg({ contract: "../x.yaml" }), { code: "CONFIG_INVALID" });
  assert.throws(() => cfg({ other: 1 }), { code: "CONFIG_INVALID" });
});

test("failed command fails the gate but later checks still run; summary is redacted", () => {
  const tok = `ghp_${"a".repeat(36)}`;
  const r = runChecks({
    worktree: dir(),
    logDir: dir(),
    checks: checks({
      build: { run: node(`console.error('boom ${tok}');process.exit(2)`) },
      test: { run: node("console.log('ok')") },
    }),
  });
  assert.equal(r.passed, false);
  const build = r.results.find((x) => x.name === "build");
  assert.equal(build?.outcome, "fail");
  assert.equal(build?.exitCode, 2);
  assert.match(build?.summary ?? "", /boom \[REDACTED/);
  assert.ok(!build?.summary.includes(tok));
  assert.equal(r.results.find((x) => x.name === "test")?.outcome, "pass");
});

test("timeout is its own outcome", () => {
  const r = runChecks({
    worktree: dir(),
    logDir: dir(),
    checks: checks({ test: { run: node("setTimeout(()=>{},4000)"), timeoutSec: 1 } }),
  });
  const t = r.results.find((x) => x.name === "test");
  assert.equal(t?.outcome, "timeout");
  assert.equal(r.passed, false);
  assert.ok((t?.durationMs ?? 0) < 3500);
});

test("timeout kills the whole process tree: no grandchild outlives its check (#36)", () => {
  const work = dir();
  const pidFile = join(work, "pid");
  const script = join(work, "spawn.cjs");
  writeFileSync(
    script,
    [
      'const c = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(()=>{},60000)"], { stdio: "ignore" });',
      `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));`,
      "setTimeout(() => {}, 60000);",
    ].join("\n"),
  );
  const r = runChecks({
    worktree: work,
    logDir: dir(),
    checks: checks({ test: { run: `node "${script}"`, timeoutSec: 2 } }),
  });
  assert.equal(r.results.find((x) => x.name === "test")?.outcome, "timeout");
  const pid = Number(readFileSync(pidFile, "utf8"));
  const alive = () => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  if (alive())
    process.kill(pid); // never leak the sleeper, even when the assertion fails
  else return;
  assert.fail(`grandchild ${pid} survived the timeout`);
});

test("missing tool is reported as such", () => {
  const r = runChecks({
    worktree: dir(),
    logDir: dir(),
    checks: checks({ scan: { run: "omi-no-such-tool-4242 --version" } }),
  });
  assert.equal(r.results.find((x) => x.name === "scan")?.outcome, "missing-tool");
});

test("huge output: summary bounded, full log kept on disk", () => {
  const r = runChecks({
    worktree: dir(),
    logDir: dir(),
    checks: checks({
      test: { run: node("for(let i=0;i<200000;i++)console.log('line '+i);process.exitCode=1") },
    }),
  });
  const t = r.results.find((x) => x.name === "test");
  assert.equal(t?.outcome, "fail");
  assert.ok((t?.summary.length ?? Infinity) <= SUMMARY_CHARS);
  assert.match(t?.summary ?? "", /line 199999$/);
  assert.ok(readFileSync(t?.logPath ?? "", "utf8").includes("line 0\n"));
});
