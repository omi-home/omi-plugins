// #261 task clone setup: no setup, success, failure/timeout (redacted evidence log), reuse by lockfile.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runSetup } from "../../runtime/core/workflow-engine/setup.ts";
import { parseConfig } from "../../runtime/shared/config.ts";
import { OmiError } from "../../runtime/shared/errors/errors.ts";

const dirs = () => {
  const base = mkdtempSync(join(tmpdir(), "omi-setup-"));
  const worktree = join(base, "clone");
  const gitDir = join(base, "gitdir");
  mkdirSync(worktree);
  mkdirSync(gitDir);
  return { worktree, gitDir, logDir: join(base, "evidence", "setup") };
};
// Appends a line to ran.txt per run: portable across cmd.exe and sh.
const COUNT = 'node -e "require(\\"fs\\").appendFileSync(\\"ran.txt\\",\\"x\\")"';
const runs = (wt: string) =>
  existsSync(join(wt, "ran.txt")) ? readFileSync(join(wt, "ran.txt"), "utf8").length : 0;
const setupOf = (run: string, timeoutSec = 60) => ({ run, timeoutSec });

test("config: setup is optional, shaped like a check, unknown keys rejected", () => {
  const gh = { github: { owner: "o", repo: "r", projectNumber: 1 } };
  assert.equal(parseConfig(gh).setup, undefined);
  assert.deepEqual(parseConfig({ ...gh, setup: { run: "npm ci" } }).setup, {
    run: "npm ci",
    timeoutSec: 600,
  });
  assert.throws(() => parseConfig({ ...gh, setup: { run: "npm ci", extra: 1 } }), OmiError);
  assert.throws(() => parseConfig({ ...gh, setups: { run: "x" } }), OmiError);
});

test("no setup configured: skipped, nothing runs", () => {
  const d = dirs();
  const r = runSetup({ ...d, setup: undefined });
  assert.equal(r.status, "skipped");
  assert.equal(existsSync(d.logDir), false);
});

test("setup succeeds in the clone and is recorded", () => {
  const d = dirs();
  const r = runSetup({ ...d, setup: setupOf(COUNT) });
  assert.equal(r.status, "done");
  assert.equal(runs(d.worktree), 1);
  assert.ok(r.logPath && existsSync(r.logPath));
});

test("reuse: unchanged lockfile skips, changed lockfile reruns", () => {
  const d = dirs();
  writeFileSync(join(d.worktree, "package-lock.json"), '{"v":1}');
  assert.equal(runSetup({ ...d, setup: setupOf(COUNT) }).status, "done");
  assert.equal(runSetup({ ...d, setup: setupOf(COUNT) }).status, "unchanged");
  assert.equal(runs(d.worktree), 1);
  writeFileSync(join(d.worktree, "package-lock.json"), '{"v":2}');
  assert.equal(runSetup({ ...d, setup: setupOf(COUNT) }).status, "done");
  assert.equal(runs(d.worktree), 2);
});

test("failure: SETUP_FAILED, redacted log kept, nothing recorded so a retry reruns", () => {
  const d = dirs();
  const secret = `ghp_${"a".repeat(36)}`;
  const failing = setupOf(`node -e "console.log(\\"token ${secret}\\");process.exit(3)"`);
  let err: unknown;
  try {
    runSetup({ ...d, setup: failing });
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof OmiError);
  assert.equal(err.code, "SETUP_FAILED");
  const log = readFileSync(join(d.logDir, "setup.log"), "utf8");
  assert.ok(log.includes("token"));
  assert.ok(!log.includes(secret));
  assert.ok(!JSON.stringify(err.toJSON()).includes(secret));
  assert.equal(runSetup({ ...d, setup: setupOf(COUNT) }).status, "done");
});

test("timeout: SETUP_FAILED", () => {
  const d = dirs();
  assert.throws(
    () => runSetup({ ...d, setup: setupOf('node -e "setTimeout(()=>{},30000)"', 1) }),
    (e: unknown) =>
      e instanceof OmiError && e.code === "SETUP_FAILED" && /timed out/.test(e.message),
  );
});
