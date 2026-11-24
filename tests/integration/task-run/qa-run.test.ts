// DevTask-0134 #385: the read-only QATask run (stubbed QA agent, real git clone, real checks,
// in-memory GitHub): Test design table, Verify `Run #k`, dirty worktree, no edit rights.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { cleanupRun } from "../../../runtime/cleanup/adapters/cleanup.ts";
import { claudeCode } from "../../../runtime/harness/adapters/claude-code/harness.ts";
import type { AgentLaunch } from "../../../runtime/harness/domain/harness.ts";
import { stepReports } from "../../../runtime/reporting/adapters/step-reports.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import type { TaskPacket } from "../../../runtime/shared/contracts.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import * as repo from "../../../runtime/task-run/adapters/repository.ts";
import { runQa } from "../../../runtime/task-run/application/slice.ts";
import { taskRunPorts } from "../../../runtime/task-run/cli/ports.ts";
import type { QaPlan } from "../../../runtime/task-run/domain/plan.ts";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

const TABLE =
  "| ID | AC | Steps | Expected | Auto (Y/N) | Regression (Y/N) |\n|---|---|---|---|---|---|\n" +
  "| TC-8-01 | AC1 | a | b | Y | N |\n| TC-8-02 | AC2 | c | d | N | Y |\n";

function fakeGitHub() {
  const comments: { id: number; body: string; html_url: string; author_association: string }[] = [];
  // sub-issues of the Story (#8): by default the sibling Test design QATask with the table
  const siblings: unknown[] = [{ number: 10, body: TABLE, labels: [{ name: "qa:test-design" }] }];
  const run: GhRunner = (args, input) => {
    const ok = (v: unknown) => ({ status: 0, stdout: JSON.stringify(v), stderr: "" });
    if (args.some((a) => a.includes("/sub_issues"))) return ok([siblings]);
    if (args.includes("graphql")) {
      const node = (n: number, body: string, type: string, parent: unknown) => ({
        number: n,
        title: `#${n}`,
        body,
        repository: { nameWithOwner: "o/r" },
        labels: { nodes: [{ name: `type:${type}` }] },
        parent,
      });
      const issue = {
        ...node(9, "QA", "test-task", node(8, "## Story\nAC1, AC2", "fr", null)),
        comments: { nodes: [] },
      };
      return ok({ data: { repository: { issue } } });
    }
    const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
    if (method === "GET") return ok([comments]);
    const { body } = JSON.parse(input as string);
    if (method === "POST") {
      const c = {
        id: comments.length + 1,
        body,
        html_url: `https://x/${comments.length + 1}`,
        author_association: "MEMBER",
      };
      comments.push(c);
      return ok(c);
    }
    const url = args.find((a) => a.startsWith("repos/")) as string;
    const c = comments.find((x) => x.id === Number(/(\d+)$/.exec(url)?.[1]));
    if (c) c.body = body;
    return ok(c);
  };
  return { comments, run, siblings };
}

interface Reply {
  status?: "PASSED" | "BLOCKED";
  qa?: unknown;
  dirty?: boolean;
}

function setup(replies: Reply[], plan: QaPlan, checkScript = "console.log('TC-8-01 ok')") {
  const upstream = mkdtempSync(join(tmpdir(), "omi-qa-up-"));
  git(upstream, "init", "-q", "-b", "develop");
  git(upstream, "config", "user.email", "t@example.invalid");
  git(upstream, "config", "user.name", "t");
  writeFileSync(join(upstream, "README.md"), "x\n");
  git(upstream, "add", ".");
  git(upstream, "commit", "-qm", "base");
  // the clone sits alone in its task workspace root, as cleanup expects
  const root = mkdtempSync(join(tmpdir(), "omi-qa-wt-"));
  const dir = join(root, "clone");
  mkdirSync(dir);
  git(dir, "clone", "-q", upstream, ".");
  const base = git(dir, "rev-parse", "HEAD");
  const db = openState(":memory:");
  const run = repo.createRun(db, {
    id: "run",
    issue: { repository: "o/r", number: 9 },
    workflow: "test-task",
  });
  repo.advanceRun(db, "run", { type: "TICKET_VALID" });
  repo.advanceRun(db, "run", { type: "WORKSPACE_CREATED" });
  const gh = fakeGitHub();
  const launches: AgentLaunch[] = [];
  const packets: TaskPacket[] = [];
  const written: [string, string][] = [];
  let closed = 0;
  const runAgent = (l: AgentLaunch): string => {
    launches.push(l);
    const packet: TaskPacket = JSON.parse(l.stdin.split("\n\n")[1] as string);
    packets.push(packet);
    const reply = replies.shift() as Reply;
    if (reply.dirty) writeFileSync(join(packet.worktree, "scratch.txt"), "x");
    const result = {
      schemaVersion: 1,
      workflowRunId: packet.workflowRunId,
      issue: packet.issue,
      stepId: packet.stepId,
      round: packet.round,
      attempt: packet.attempt,
      role: packet.role,
      status: reply.status ?? "PASSED",
      summary: "qa",
      ...(reply.status === "BLOCKED" ? { blockerReason: "cannot assess" } : {}),
      ...(reply.qa
        ? { sectionUpdates: [{ section: "qa", markdown: JSON.stringify(reply.qa) }] }
        : {}),
    };
    return JSON.stringify({
      type: "result",
      is_error: false,
      result: JSON.stringify(result),
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  };
  const deps = {
    db,
    config: parseConfig({
      github: { owner: "o", repo: "r", projectNumber: 1 },
      checks: { test: { run: `node -e "${checkScript}"` } },
    }),
    gh: gh.run,
    pluginRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    evidenceDir: mkdtempSync(join(tmpdir(), "omi-evidence-")),
    ports: { ...taskRunPorts, reports: stepReports },
    harness: claudeCode,
    runAgent,
    writeSection: (s: string, md: string) => written.push([s, md]),
    closeIssue: () => closed++,
  };
  const target = {
    run,
    worktree: dir,
    taskRoot: mkdtempSync(join(tmpdir(), "omi-task-")),
    baseSha: base,
    plan,
    parent: 8,
  };
  return { db, gh, deps, target, launches, packets, written, closed: () => closed, upstream, dir };
}

const DESIGN: QaPlan = {
  kind: "qa",
  workflow: "QA Test Design",
  mode: "test-design",
  retest: false,
};
const VERIFY: QaPlan = { kind: "qa", workflow: "QA Verify", mode: "verify", retest: false };

const design = {
  acCoverage: "AC1-AC2",
  cases: [
    { id: "TC-8-01", ac: "AC1", steps: "a", expected: "b", auto: true, regression: false },
    { id: "TC-8-02", ac: "AC2", steps: "c", expected: "d", auto: false, regression: true },
  ],
};
const verify = (r1: string, r2: string, defects: unknown[] = []) => ({
  cases: [
    { id: "TC-8-01", result: r1 },
    { id: "TC-8-02", result: r2 },
  ],
  defects,
  manualRegression: ["login page"],
});

test("TC-385-08: Test design writes the §11 table into section qa, closes the Issue, edits nothing", () => {
  const s = setup([{ qa: design }], DESIGN);
  const r = runQa(s.deps, s.target);
  assert.equal(r.qa?.verdict, "PASSED");
  assert.equal(s.closed(), 1);
  assert.equal(s.written.length, 1);
  assert.equal(s.written[0]?.[0], "qa");
  assert.match(s.written[0]?.[1] ?? "", /\| TC-8-01 \| AC1 \| a \| b \| Y \| N \|/);
  // read-only launch: no acceptEdits, no git mv / npm scripts, check commands only
  const launch = s.launches[0] as AgentLaunch;
  assert.ok(!launch.args.includes("acceptEdits"));
  const allowed = launch.args.join(" ");
  assert.ok(!/git (-C \S+ )?mv/.test(allowed) && !/npm run (format|check)/.test(allowed));
  assert.match(s.packets[0]?.stepId ?? "", /^qa$/);
  assert.match(launch.stdin, /QATask mode: TEST DESIGN/);
  assert.equal(git(s.dir, "status", "--porcelain"), "");
});

test("TC-385-09: Test design refuses ids of another Story and a dirty worktree (CONTRACT_INVALID)", () => {
  const bad = { ...design, cases: [{ ...design.cases[0], id: "TC-7-01" }] };
  const s = setup([{ qa: bad }], DESIGN);
  const r = runQa(s.deps, s.target);
  assert.equal(r.ctx.state, "BLOCKED");
  assert.equal(s.closed(), 0);
  assert.equal(s.written.length, 0);
  const d = setup([{ qa: design, dirty: true }], DESIGN);
  assert.equal(runQa(d.deps, d.target).ctx.state, "BLOCKED");
  assert.equal(d.closed(), 0);
});

test("TC-385-10: Verify PASSED posts Run #1 for the fetched develop HEAD and closes the Issue", () => {
  const s = setup([{ qa: verify("pass", "pass") }], VERIFY);
  const r = runQa(s.deps, s.target);
  assert.equal(r.qa?.verdict, "PASSED");
  assert.equal(r.qa?.run, 1);
  assert.equal(s.closed(), 1);
  const head = git(s.upstream, "rev-parse", "HEAD");
  const run = s.gh.comments.find((c) => c.body.startsWith("<!-- omi:qa-run=1"));
  assert.ok(run);
  assert.match(run.body, new RegExp(`Run #1\\*\\* · \`${head.slice(0, 8)}\` · PASSED`));
  assert.match(run.body, /- TC-8-01: pass/);
  assert.match(s.launches[0]?.stdin ?? "", /QATask mode: VERIFY/);
});

test("TC-385-11: Verify FAILED stops Blocked with a Bug proposal; the rerun on a new commit is Run #2", () => {
  const defect = {
    title: "greeting missing",
    repro: "open /",
    expected: "hello",
    actual: "nothing",
    severity: "high",
    tc: ["TC-8-02"],
  };
  const s = setup(
    [{ qa: verify("pass", "fail", [defect]) }, { qa: verify("pass", "pass") }],
    VERIFY,
  );
  const first = runQa(s.deps, s.target);
  assert.equal(first.qa?.verdict, "FAILED");
  assert.equal(first.ctx.state, "BLOCKED");
  assert.equal(s.closed(), 0);
  assert.match(first.qa?.proposals[0] ?? "", /Found in:\*\* QATask #9 · TC-8-02/);
  const run1 = s.gh.comments.find((c) => c.body.startsWith("<!-- omi:qa-run=1"));
  assert.match(run1?.body ?? "", /FAILED/);
  assert.match(run1?.body ?? "", /Proposed Bugs/);

  // the fix merged: a new commit on develop, the person unblocks, the same QATask runs again
  writeFileSync(join(s.upstream, "fix.txt"), "fix\n");
  git(s.upstream, "add", ".");
  git(s.upstream, "commit", "-qm", "fix");
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  const second = runQa(s.deps, s.target);
  assert.equal(second.qa?.verdict, "PASSED");
  assert.equal(second.qa?.run, 2);
  assert.equal(s.gh.comments.filter((c) => c.body.startsWith("<!-- omi:qa-run=")).length, 2);
});

test("TC-385-12: an Auto = Y case without a test carrying its TC id is blocked, never a silent pass", () => {
  const s = setup([{ qa: verify("pass", "pass") }], VERIFY, "console.log('no ids here')");
  const r = runQa(s.deps, s.target);
  assert.equal(r.qa?.verdict, "FAILED");
  const run = s.gh.comments.find((c) => c.body.startsWith("<!-- omi:qa-run=1"));
  assert.match(run?.body ?? "", /- TC-8-01: blocked — no automated test carries this id/);
});

test("TC-385-19: Verify: the agent receives the sibling Test design table without Sources", () => {
  const s = setup([{ qa: verify("pass", "pass") }], VERIFY);
  runQa(s.deps, s.target);
  const stdin = s.launches[0]?.stdin ?? "";
  assert.match(stdin, /TC table \(from the Test design QATask under #8/);
  assert.ok(stdin.includes("| TC-8-01 | AC1 | a | b | Y | N |"));
  assert.ok(stdin.includes("| TC-8-02 | AC2 | c | d | N | Y |"));
});

test("TC-385-14: a Verify without a Test design table is refused, never PASSED", () => {
  const s = setup([{ qa: verify("pass", "pass") }], VERIFY);
  s.gh.siblings.length = 0;
  const none = runQa(s.deps, s.target);
  assert.equal(none.ctx.state, "BLOCKED");
  assert.equal(none.qa, undefined);
  assert.equal(s.closed(), 0);
  assert.equal(s.launches.length, 0);
  // a sibling without the design label, or a table of another Story, is no table either
  s.gh.siblings.push(
    { number: 11, body: TABLE, labels: [{ name: "qa:manual" }] },
    {
      number: 12,
      body: TABLE.replaceAll("TC-8-", "TC-7-"),
      labels: [{ name: "qa:test-design" }],
    },
  );
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  assert.equal(runQa(s.deps, s.target).ctx.state, "BLOCKED");
  assert.equal(s.closed(), 0);
});

test("TC-385-15: a Verify reporting zero cases is not PASSED (Retest included)", () => {
  const s = setup([{ qa: { cases: [], defects: [], manualRegression: [] } }], {
    ...VERIFY,
    retest: true,
  });
  const r = runQa(s.deps, s.target);
  assert.equal(r.ctx.state, "BLOCKED");
  assert.equal(r.qa, undefined);
  assert.equal(s.closed(), 0);
});

test("TC-385-16: a QATask without a parent Issue is refused (POLICY_VIOLATION)", () => {
  const s = setup([{ qa: verify("pass", "pass") }], VERIFY);
  const r = runQa(s.deps, { ...s.target, parent: undefined });
  assert.equal(r.ctx.state, "BLOCKED");
  assert.equal(s.launches.length, 0);
  assert.equal(s.closed(), 0);
});

const writeMarker = (dir: string, branch: string) =>
  writeFileSync(
    join(dir, ".git", "omi-owner.json"),
    JSON.stringify({
      schemaVersion: 1,
      repository: "o/r",
      issue: 9,
      branch,
      baseSha: "0".repeat(40),
      runId: "run",
      createdAt: new Date().toISOString(),
    }),
  );

const lowDefect = {
  title: "t",
  repro: "r",
  expected: "e",
  actual: "a",
  severity: "low",
  tc: ["TC-8-02"],
};

test("TC-420-01: Verify leaves the clone on the task branch, so a rerun after unblock is not refused", () => {
  const s = setup(
    [{ qa: verify("pass", "fail", [lowDefect]) }, { qa: verify("pass", "pass") }],
    VERIFY,
  );
  git(s.dir, "switch", "-q", "-c", "test/9-qa");
  const first = runQa(s.deps, s.target);
  assert.equal(first.ctx.state, "BLOCKED");
  assert.equal(git(s.dir, "symbolic-ref", "--short", "HEAD"), "test/9-qa");
  // a clone an older run left detached is put back on the task branch (named by the marker)
  git(s.dir, "checkout", "-q", "--detach");
  writeMarker(s.dir, "test/9-qa");
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  const second = runQa(s.deps, s.target);
  assert.equal(second.qa?.verdict, "PASSED");
  assert.equal(git(s.dir, "symbolic-ref", "--short", "HEAD"), "test/9-qa");
});

test("TC-420-02: after Verify PASSED the clone is on the task branch at origin/develop, clean", () => {
  const s = setup([{ qa: verify("pass", "pass") }], VERIFY);
  git(s.dir, "switch", "-q", "-c", "test/9-qa");
  assert.equal(runQa(s.deps, s.target).qa?.verdict, "PASSED");
  assert.equal(git(s.dir, "symbolic-ref", "--short", "HEAD"), "test/9-qa");
  assert.equal(git(s.dir, "rev-parse", "HEAD"), git(s.upstream, "rev-parse", "HEAD"));
  assert.equal(git(s.dir, "status", "--porcelain"), "");
  // finalize's cleanup accepts the clone: no "detached HEAD" failure of verify-clean-worktree
  writeMarker(s.dir, "test/9-qa");
  repo.claimResource(s.db, { runId: "run", kind: "branch", ref: "test/9-qa" });
  repo.claimResource(s.db, { runId: "run", kind: "worktree", ref: s.dir });
  const cleaned = cleanupRun(s.db, {
    runId: "run",
    receipt: undefined,
    noCode: { base: "develop" },
    tempRoot: tmpdir(),
  });
  const verifyStep = cleaned.steps.find((x) => x.name === "verify-clean-worktree");
  assert.equal(verifyStep?.status, "done", verifyStep?.detail);
  assert.equal(cleaned.state, "COMPLETED");
});

test("TC-420-03: a rerun after unblock on the same commit calls the agent again (new step id)", () => {
  const s = setup(
    [{ qa: verify("pass", "fail", [lowDefect]) }, { qa: verify("pass", "pass") }],
    VERIFY,
  );
  assert.equal(runQa(s.deps, s.target).qa?.verdict, "FAILED");
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  const again = runQa(s.deps, s.target);
  assert.equal(s.launches.length, 2);
  assert.notEqual(s.packets[0]?.stepId, s.packets[1]?.stepId);
  assert.equal(again.qa?.verdict, "PASSED");
  assert.equal(again.qa?.run, 1);
});

test("TC-385-17: a rerun on the same commit updates Run #k, it does not post a second comment", () => {
  const s = setup(
    [{ qa: verify("pass", "fail", [lowDefect]) }, { qa: verify("pass", "fail", [lowDefect]) }],
    VERIFY,
  );
  const first = runQa(s.deps, s.target);
  assert.equal(first.qa?.verdict, "FAILED");
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  const again = runQa(s.deps, s.target);
  assert.equal(again.qa?.run, 1);
  assert.equal(s.gh.comments.filter((c) => c.body.startsWith("<!-- omi:qa-run=")).length, 1);
});

test("TC-385-13: a QA Engineer that cannot assess BLOCKs the run without a Run comment", () => {
  const s = setup([{ status: "BLOCKED" }], VERIFY);
  const r = runQa(s.deps, s.target);
  assert.equal(r.ctx.state, "BLOCKED");
  assert.equal(r.qa, undefined);
  assert.equal(s.gh.comments.filter((c) => c.body.startsWith("<!-- omi:qa-run=")).length, 0);
});
