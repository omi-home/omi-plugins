// Regression tests for Bug #351 (flaky "timeout kills the whole process tree (#36)"): a check that
// times out must be reported as a timeout and none of its descendants may outlive the call.
// Imports only modules that already exist at the pre-fix commit 33e7ddd.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mock, test } from "node:test";
import { parseConfig } from "../../../runtime/shared/config.ts";
import { runChecks } from "../../../runtime/task-run/adapters/checks.ts";

const dir = () => mkdtempSync(join(tmpdir(), "omi-tc351-"));
const checks = (c: Record<string, unknown>) =>
  parseConfig({ github: { owner: "o", repo: "r", projectNumber: 1 }, checks: c }).checks;

/** A check that spawns a long-lived grandchild, records its pid, then hangs itself. */
function hangingTree(): { run: string; pid: () => number } {
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
  return { run: `node "${script}"`, pid: () => Number(readFileSync(pidFile, "utf8")) };
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"; // zombie = dead
  } catch {
    return true;
  }
}

test("TC-351-01: a timed-out check is classified as timeout even when the wall clock steps back", () => {
  const tree = hangingTree();
  // Wall clock jumps back 1 minute after the first read (VM/CI clock adjustment): the duration
  // must come from a monotonic clock, else status 124 looks like a plain failure (#351).
  const base = Date.now();
  let calls = 0;
  const spy = mock.method(Date, "now", () => (calls++ === 0 ? base : base - 60_000));
  let t: ReturnType<typeof runChecks>["results"][number] | undefined;
  try {
    const r = runChecks({
      worktree: dir(),
      logDir: dir(),
      checks: checks({ test: { run: tree.run, timeoutSec: 1 } }),
    });
    t = r.results.find((x) => x.name === "test");
  } finally {
    spy.mock.restore();
  }
  try {
    assert.equal(
      t?.outcome,
      "timeout",
      JSON.stringify({ exitCode: t?.exitCode, durationMs: t?.durationMs }),
    );
  } finally {
    try {
      process.kill(tree.pid());
    } catch {
      // already dead
    }
  }
});

test("TC-351-02: when a check times out, its grandchild is dead before runChecks returns", () => {
  const tree = hangingTree();
  const r = runChecks({
    worktree: dir(),
    logDir: dir(),
    checks: checks({ test: { run: tree.run, timeoutSec: 1 } }),
  });
  assert.equal(r.results.find((x) => x.name === "test")?.outcome, "timeout");
  const pid = tree.pid();
  // Grace only for the kernel to finish tearing down a SIGKILLed process, not for a late kill.
  const deadline = Date.now() + 500;
  while (alive(pid) && Date.now() < deadline)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  const survived = alive(pid);
  if (survived) process.kill(pid);
  assert.equal(survived, false, `grandchild ${pid} survived the timeout`);
});
