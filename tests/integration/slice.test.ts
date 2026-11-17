// T3.6 vertical slice with stubbed agents (real git worktree, real checks, in-memory GitHub):
// one report per step and round, delta findings between rounds, no fifth Dev, one Architect,
// transport failures retried as attempts, bad claims blocked, crash-resume without re-running.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AgentLaunch } from "../../runtime/adapters/claude/launch.ts";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { parseConfig } from "../../runtime/core/config.ts";
import type { TaskPacket } from "../../runtime/core/contracts.ts";
import { runSlice } from "../../runtime/core/workflow-engine/slice.ts";
import { openState } from "../../runtime/persistence/db.ts";
import * as repo from "../../runtime/persistence/repository.ts";

type Verdict = "PASSED" | "FAILED" | "BLOCKED";
interface Script {
  review?: (round: number) => Verdict;
  architect?: Verdict;
  /** Engineer leaves a file the `test` check rejects in these rounds (first attempt only). */
  breakChecksInRound?: number;
  /** Engineer claims a file it never touched. */
  fakeClaim?: boolean;
}

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function worktree() {
  const dir = mkdtempSync(join(tmpdir(), "omi-slice-"));
  git(dir, "init", "-q", "-b", "develop");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

/** Comments REST API + the issue-context GraphQL query. `faults` fail the next calls. */
function fakeGitHub() {
  const comments: { id: number; body: string; html_url: string }[] = [];
  const faults: string[] = [];
  const run: GhRunner = (args, input) => {
    const fault = faults.shift();
    if (fault) return { status: 1, stdout: "", stderr: fault };
    const ok = (v: unknown) => ({ status: 0, stdout: JSON.stringify(v), stderr: "" });
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
        ...node(9, "## Scope\nAdd a greeting.", "dev-task", node(8, "feature", "feature", null)),
        comments: { nodes: [] },
      };
      return ok({ data: { repository: { issue } } });
    }
    const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
    if (method === "GET") return ok([comments]);
    const { body } = JSON.parse(input as string);
    if (method === "POST") {
      const c = { id: comments.length + 1, body, html_url: `https://x/${comments.length + 1}` };
      comments.push(c);
      return ok(c);
    }
    const url = args.find((a) => a.startsWith("repos/")) as string;
    const c = comments.find(
      (x) => x.id === Number(/(\d+)$/.exec(url)?.[1]),
    ) as (typeof comments)[0];
    c.body = body;
    return ok(c);
  };
  return { comments, faults, run };
}

function stubAgents(script: Script) {
  const calls: string[] = [];
  const packets: TaskPacket[] = [];
  const runAgent = (l: AgentLaunch): string => {
    const packet: TaskPacket = JSON.parse(l.stdin.split("\n\n")[1] as string);
    packets.push(packet);
    const role = packet.role;
    calls.push(`${role}:${packet.round}`);
    const base = {
      schemaVersion: 1,
      workflowRunId: packet.workflowRunId,
      issue: packet.issue,
      stepId: packet.stepId,
      round: packet.round,
      attempt: packet.attempt,
      role,
    };
    let result: Record<string, unknown>;
    if (role === "backend-engineer") {
      const wt = packet.worktree;
      const file = `src/${packet.stepId}-r${packet.round}.txt`;
      mkdirSync(join(wt, "src"), { recursive: true });
      writeFileSync(join(wt, file), "work\n");
      const breaking = script.breakChecksInRound === packet.round && packet.stepId === "implement";
      if (breaking) writeFileSync(join(wt, "broken"), "");
      else rmSync(join(wt, "broken"), { force: true });
      git(wt, "add", "-A");
      git(wt, "commit", "-qm", file);
      result = {
        ...base,
        status: "PASSED",
        summary: `implemented ${packet.stepId} r${packet.round}`,
        changedFiles: script.fakeClaim ? ["src/never.txt"] : [file],
        commitSha: git(wt, "rev-parse", "HEAD"),
      };
    } else if (role === "code-reviewer") {
      const v = script.review?.(packet.round) ?? "PASSED";
      result = {
        ...base,
        status: v,
        summary: `review r${packet.round}`,
        findings:
          v === "FAILED"
            ? [{ id: "CR-001", severity: "high", observed: "no greeting", expected: "greeting" }]
            : [],
        ...(v === "BLOCKED" ? { blockerReason: "cannot review" } : {}),
      };
    } else {
      const v = script.architect ?? "PASSED";
      result = {
        ...base,
        status: v,
        summary: "diagnosis",
        findings:
          v === "PASSED"
            ? [
                {
                  id: "ARC-001",
                  severity: "high",
                  observed: "wrong module",
                  expected: "use greet.ts",
                },
              ]
            : [],
        ...(v === "FAILED" ? { blockerReason: "needs scope change" } : {}),
      };
    }
    return [
      JSON.stringify({ type: "assistant", message: { model: "claude-sonnet-5-5" } }),
      "{broken line from a cut transcript",
      JSON.stringify({
        type: "result",
        is_error: false,
        result: JSON.stringify(result),
        usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 5 },
        permission_denials: [],
      }),
    ].join("\n");
  };
  return { calls, packets, runAgent };
}

function setup(script: Script = {}) {
  const { dir, base } = worktree();
  const db = openState(":memory:");
  const run = repo.createRun(db, {
    id: "run",
    issue: { repository: "o/r", number: 9 },
    workflow: "dev-task",
  });
  repo.advanceRun(db, "run", { type: "TICKET_VALID" });
  repo.advanceRun(db, "run", { type: "WORKSPACE_CREATED" });
  const config = parseConfig({
    github: { owner: "o", repo: "r", projectNumber: 1 },
    checks: { test: { run: `node -e "process.exit(require('fs').existsSync('broken')?1:0)"` } },
  });
  const gh = fakeGitHub();
  const agents = stubAgents(script);
  const deps = {
    db,
    config,
    gh: gh.run,
    pluginRoot: dir, // unused by stubs; must be absolute
    evidenceDir: mkdtempSync(join(tmpdir(), "omi-evidence-")),
    runAgent: agents.runAgent,
  };
  const target = { run, worktree: dir, baseSha: base };
  return { db, gh, agents, deps, target };
}

const titles = (bodies: string[]) =>
  bodies.map((b) => {
    const step = /step=([\w-]+);round=(\d)/.exec(b);
    return `${step?.[1]}:${step?.[2]}`;
  });

test("happy path: Dev → checks → Review PASSED → IN_QA, one report each, usage observed", () => {
  const s = setup();
  const ctx = runSlice(s.deps, s.target);
  assert.equal(ctx.state, "IN_QA");
  assert.deepEqual(s.agents.calls, ["backend-engineer:1", "code-reviewer:1"]);
  assert.deepEqual(titles(s.gh.comments.map((c) => c.body)), [
    "implement:1",
    "checks:1",
    "code-review:1",
  ]);
  assert.match(
    s.gh.comments[0]?.body ?? "",
    /requested sonnet · actual claude-sonnet-5-5 \(observed\)/,
  );
  assert.match(s.gh.comments[1]?.body ?? "", /\| Model \| n\/a \(omi-cli\) \|/);
  assert.deepEqual(repo.pendingReports(s.db, "run"), []);
  const stored = s.db.prepare("SELECT result FROM step_run WHERE step_id = 'implement'").get();
  assert.deepEqual(JSON.parse(String(stored?.result)).usage, {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
  });
});

test("2 + Architect + 2: every round reported, delta findings, no fifth Dev, one Architect", () => {
  const s = setup({ review: () => "FAILED" });
  const ctx = runSlice(s.deps, s.target);
  assert.deepEqual([ctx.state, ctx.round], ["WAITING_PO", 4]);
  assert.deepEqual(s.agents.calls, [
    "backend-engineer:1",
    "code-reviewer:1",
    "backend-engineer:2",
    "code-reviewer:2",
    "solution-architect:2",
    "backend-engineer:3",
    "code-reviewer:3",
    "backend-engineer:4",
    "code-reviewer:4",
  ]);
  const t = titles(s.gh.comments.map((c) => c.body));
  assert.deepEqual(
    t.filter((x) => !x.startsWith("checks")),
    [
      "implement:1",
      "code-review:1",
      "implement:2",
      "code-review:2",
      "architect:2",
      "implement:3",
      "code-review:3",
      "implement:4",
      "code-review:4",
    ],
  );
  assert.equal(new Set(t).size, t.length, "markers unique");
  const devPackets = s.agents.packets.filter((p) => p.role === "backend-engineer");
  assert.deepEqual(devPackets[0]?.openFindings, []);
  assert.deepEqual(
    devPackets[1]?.openFindings.map((f) => f.id),
    ["CR-001"],
  );
  assert.deepEqual(
    devPackets[2]?.openFindings.map((f) => f.id),
    ["ARC-001"],
    "round 3 follows the plan",
  );
  assert.equal(devPackets[0]?.issueContext.map((e) => e.issue.number).join(), "9,8");
  assert.equal(repo.reviewRounds(s.db, "run"), 4);
});

test("Architect scope change stops at WAITING_PO before any third round", () => {
  const s = setup({ review: () => "FAILED", architect: "FAILED" });
  assert.equal(runSlice(s.deps, s.target).state, "WAITING_PO");
  assert.equal(s.agents.calls.filter((c) => c.startsWith("backend-engineer")).length, 2);
});

test("failed checks go back to the engineer as CHK findings, not as a review round", () => {
  const s = setup({ breakChecksInRound: 1 });
  const ctx = runSlice(s.deps, s.target);
  assert.equal(ctx.state, "IN_QA");
  assert.deepEqual(s.agents.calls, ["backend-engineer:1", "backend-engineer:1", "code-reviewer:1"]);
  const fix = s.agents.packets[1];
  assert.equal(fix?.stepId, "implement-fix1");
  assert.deepEqual(
    fix?.openFindings.map((f) => f.id),
    ["CHK-001"],
  );
  assert.equal(repo.reviewRounds(s.db, "run"), 1);
  assert.deepEqual(
    titles(s.gh.comments.map((c) => c.body)).filter((x) => x.startsWith("checks")),
    ["checks:1", "checks:1"],
  );
});

test("transient GitHub error is a new attempt of the same step, not a round", () => {
  const s = setup();
  s.gh.faults.push("gh: Server Error (HTTP 502)");
  assert.equal(runSlice(s.deps, s.target).state, "IN_QA");
  const attempts = s.db
    .prepare(
      "SELECT a.attempt, a.error_code FROM step_attempt a JOIN step_run s ON s.id = a.step_run_id WHERE s.step_id = 'implement' ORDER BY a.attempt",
    )
    .all()
    .map((r) => `${r.attempt}:${r.error_code}`);
  assert.deepEqual(attempts, ["1:GITHUB_UNAVAILABLE", "2:null"]);
  assert.equal(repo.reviewRounds(s.db, "run"), 1);
});

test("a fake changed-file claim blocks the run; nothing is reported for it", () => {
  const s = setup({ fakeClaim: true });
  const ctx = runSlice(s.deps, s.target);
  assert.deepEqual([ctx.state, ctx.resumeFrom], ["BLOCKED", "RUNNING"]);
  assert.equal(s.gh.comments.length, 0);
});

test("crash before the report is posted: rerun posts it without re-running the agent", () => {
  const s = setup();
  // Context read OK, then listing comments fails with a non-transient error.
  const real = s.deps.gh;
  let failPublish = true;
  s.deps.gh = (args, input) =>
    failPublish && !args.includes("graphql")
      ? { status: 1, stdout: "", stderr: "gh: Bad credentials (HTTP 401)" }
      : real(args, input);
  assert.throws(() => runSlice(s.deps, s.target), { code: "GITHUB_AUTH" });
  assert.deepEqual(s.agents.calls, ["backend-engineer:1"]);
  assert.equal(repo.pendingReports(s.db, "run").length, 1);
  failPublish = false;
  assert.equal(runSlice(s.deps, s.target).state, "IN_QA");
  assert.deepEqual(
    s.agents.calls,
    ["backend-engineer:1", "code-reviewer:1"],
    "engineer not re-run",
  );
  assert.deepEqual(titles(s.gh.comments.map((c) => c.body)), [
    "implement:1",
    "checks:1",
    "code-review:1",
  ]);
});
