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
import type { DeliveryPlan, WorkflowPlan } from "../../runtime/core/workflow-engine/plan.ts";
import { runAnalysis, runSlice } from "../../runtime/core/workflow-engine/slice.ts";
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
  /** Engineer also adds a test file from this step id on (regression test). */
  addsTestFrom?: "implement" | "implement-fix1";
  /** Code Reviewer's nextAction. */
  reviewNext?: string;
  /** Security Reviewer verdict; CRITICAL = BLOCKED with a critical finding. */
  security?: Verdict | "CRITICAL";
  /** This analyst stops with an open question. */
  analysisBlocks?: string;
  /** Manual QA verdicts, one per QA run (default PASSED). */
  qa?: Verdict[];
  /** Engineer leaves an uncommitted file after its first step (release validation). */
  leavesDirt?: boolean;
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
    const section = (
      { analysis: "analysis", design: "design", architecture: "architecture" } as Record<
        string,
        string
      >
    )[packet.stepId];
    if (section) {
      const blocks = script.analysisBlocks === role;
      result = {
        ...base,
        status: blocks ? "BLOCKED" : "PASSED",
        summary: `${section} done`,
        ...(blocks
          ? { blockerReason: "PO must decide the scope" }
          : { sectionUpdates: [{ section, markdown: `### ${section} by ${role}` }] }),
      };
    } else if (role === "manual-qa-engineer") {
      const v = script.qa?.shift() ?? "PASSED";
      result = {
        ...base,
        status: v,
        summary: `qa ${packet.stepId}`,
        ...(v === "PASSED"
          ? { sectionUpdates: [{ section: "qa", markdown: "### Test cases" }] }
          : {}),
        findings:
          v === "FAILED"
            ? [{ id: "QA-001", severity: "high", observed: "AC-1 fails", expected: "AC-1 holds" }]
            : [],
        ...(v === "BLOCKED" ? { blockerReason: "cannot verify" } : {}),
      };
    } else if (role.endsWith("-engineer")) {
      const wt = packet.worktree;
      const file = `src/${packet.stepId}-r${packet.round}.txt`;
      mkdirSync(join(wt, "src"), { recursive: true });
      writeFileSync(join(wt, file), "work\n");
      const files = [file];
      if (script.addsTestFrom && packet.stepId >= script.addsTestFrom) {
        mkdirSync(join(wt, "tests"), { recursive: true });
        writeFileSync(join(wt, "tests", "regression.test.txt"), "t\n");
        files.push("tests/regression.test.txt");
      }
      const breaking = script.breakChecksInRound === packet.round && packet.stepId === "implement";
      if (breaking) writeFileSync(join(wt, "broken"), "");
      else rmSync(join(wt, "broken"), { force: true });
      git(wt, "add", "-A");
      git(wt, "commit", "-qm", file);
      if (script.leavesDirt && packet.stepId === "implement") writeFileSync(join(wt, "dirt"), "");
      result = {
        ...base,
        status: "PASSED",
        summary: `implemented ${packet.stepId} r${packet.round}`,
        changedFiles: script.fakeClaim ? ["src/never.txt"] : files,
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
        ...(script.reviewNext ? { nextAction: script.reviewNext } : {}),
      };
    } else if (role === "security-reviewer") {
      const v = script.security ?? "PASSED";
      const critical = v === "CRITICAL";
      result = {
        ...base,
        status: critical ? "BLOCKED" : v,
        summary: "security",
        findings:
          v === "PASSED"
            ? []
            : [
                {
                  id: "SEC-001",
                  severity: critical ? "critical" : "high",
                  observed: "SQL built from input",
                  expected: "parameterize",
                },
              ],
        ...(critical || v === "BLOCKED" ? { blockerReason: "security decision" } : {}),
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

function setup(script: Script = {}, plan?: WorkflowPlan) {
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
  const target = { run, worktree: dir, baseSha: base, plan };
  return { db, gh, agents, deps, target };
}

const titles = (bodies: string[]) =>
  bodies.map((b) => {
    const step = /step=([\w-]+);round=(\d)/.exec(b);
    return `${step?.[1]}:${step?.[2]}`;
  });

test("happy path: Dev → checks → Review → release validation → PR_PENDING, usage observed", () => {
  const s = setup();
  const ctx = runSlice(s.deps, s.target);
  assert.equal(ctx.state, "PR_PENDING");
  assert.deepEqual(s.agents.calls, ["backend-engineer:1", "code-reviewer:1"]);
  // Checks already passed on this HEAD: release validation reuses them, no Manual QA planned.
  assert.deepEqual(titles(s.gh.comments.map((c) => c.body)), [
    "implement:1",
    "checks:1",
    "code-review:1",
    "release-validation:1",
  ]);
  assert.match(s.gh.comments[3]?.body ?? "", /1 commit\(s\) over base · checks passed on/);
  // Cost row: host-observed tokens and wall time, never estimated (spec §14).
  assert.match(
    s.gh.comments[0]?.body ?? "",
    /\| Cost \| 100 in \/ 20 out tokens \(5 cache read\) · \d+\.\d s wall \|/,
  );
  assert.match(
    s.gh.comments[1]?.body ?? "",
    /\| Cost \| no tokens \(omi-cli\) · \d+\.\d s wall \|/,
  );
  assert.match(
    s.gh.comments[0]?.body ?? "",
    /requested sonnet · actual claude-sonnet-5-5 \(observed\)/,
  );
  assert.match(s.gh.comments[1]?.body ?? "", /\| Model \| n\/a \(omi-cli\) \|/);
  // G3-001: the implementation report lists the files the engineer changed.
  assert.match(s.gh.comments[0]?.body ?? "", /### Changed files\n- `src\/implement-r1\.txt`/);
  // G3-002: the reviewer gets the checks that already ran, the engineer gets none.
  const [dev, review] = s.agents.packets;
  assert.equal(dev?.checkResults, undefined);
  assert.deepEqual(
    review?.checkResults?.map((c) => [c.name, c.outcome]),
    [
      ["format", "skipped"],
      ["lint", "skipped"],
      ["build", "skipped"],
      ["test", "pass"],
      ["scan", "skipped"],
    ],
  );
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
  assert.equal(ctx.state, "PR_PENDING");
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
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
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
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  assert.deepEqual(
    s.agents.calls,
    ["backend-engineer:1", "code-reviewer:1"],
    "engineer not re-run",
  );
  assert.deepEqual(titles(s.gh.comments.map((c) => c.body)), [
    "implement:1",
    "checks:1",
    "code-review:1",
    "release-validation:1",
  ]);
});

// ---- DevTask-0026 #55: composed workflows ----

const delivery = (p: Partial<DeliveryPlan> = {}): DeliveryPlan => ({
  kind: "delivery",
  workflow: "Feature Implementation",
  engineer: "backend-engineer",
  security: false,
  regressionTest: false,
  manualQa: false,
  ...p,
});
const roles = (calls: string[]) => calls.map((c) => c.split(":")[0]);

test("planned engineer runs; no Security Reviewer unless required", () => {
  const s = setup({}, delivery({ engineer: "frontend-engineer" }));
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  assert.deepEqual(s.agents.calls, ["frontend-engineer:1", "code-reviewer:1"]);
});

test("security label: Security Reviewer after Code Review; its FAILED is a review round", () => {
  const s = setup({ security: "FAILED" }, delivery({ security: true }));
  const ctx = runSlice(s.deps, s.target);
  assert.equal(ctx.state, "WAITING_PO"); // every round fails security: 2 + Architect + 2
  assert.deepEqual(roles(s.agents.calls).slice(0, 4), [
    "backend-engineer",
    "code-reviewer",
    "security-reviewer",
    "backend-engineer",
  ]);
  // The engineer's round 2 packet carries the security findings (delta rework).
  const dev2 = s.agents.packets.find((p) => p.role === "backend-engineer" && p.round === 2);
  assert.deepEqual(
    dev2?.openFindings.map((f) => f.id),
    ["SEC-001"],
  );
});

test("Code Reviewer routes to security review without a label", () => {
  const s = setup({ reviewNext: "security-review: touches auth" }, delivery());
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  assert.deepEqual(roles(s.agents.calls), [
    "backend-engineer",
    "code-reviewer",
    "security-reviewer",
  ]);
});

test("critical security finding escalates to the PO at once", () => {
  const s = setup({ security: "CRITICAL" }, delivery({ security: true }));
  assert.equal(runSlice(s.deps, s.target).state, "WAITING_PO");
  assert.equal(s.agents.calls.length, 3); // no rework round
});

test("Bug Resolution: a fix without a regression test is a failed gate, not a review", () => {
  const s = setup(
    { addsTestFrom: "implement-fix1" },
    delivery({ workflow: "Bug Resolution", regressionTest: true }),
  );
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  assert.deepEqual(roles(s.agents.calls), [
    "backend-engineer",
    "backend-engineer",
    "code-reviewer",
  ]);
  const checks = s.gh.comments.map((c) => c.body).filter((b) => /step=checks/.test(b));
  assert.match(checks[0] ?? "", /\| Status \| FAILED \|[\s\S]*REG-001/);
  assert.match(checks[1] ?? "", /\| Status \| PASSED \|/);
  assert.equal(s.agents.packets[1]?.openFindings[0]?.id, "REG-001");
});

/** Analysis run: TICKET_VALIDATED, the main checkout as cwd, sections captured. */
function analysisSetup(script: Script, analysts: WorkflowPlan & { kind: "analysis" }) {
  const s = setup(script);
  const db = openState(":memory:");
  const run = repo.createRun(db, {
    id: "an",
    issue: { repository: "o/r", number: 9 },
    workflow: "feature",
  });
  repo.advanceRun(db, "an", { type: "TICKET_VALID" });
  const written: string[] = [];
  const deps = {
    ...s.deps,
    db,
    writeSection: (sec: string, md: string) => written.push(`${sec}:${md}`),
  };
  return { ...s, db, written, deps, target: { ...s.target, run, plan: analysts } };
}

test("analysis: BA → Architect write their sections in order, run COMPLETED, no engineer", () => {
  const a = analysisSetup(
    {},
    {
      kind: "analysis",
      workflow: "Feature Analysis",
      analysts: ["business-analyst", "solution-architect"],
    },
  );
  assert.equal(runAnalysis(a.deps, a.target).state, "COMPLETED");
  assert.deepEqual(a.agents.calls, ["business-analyst:1", "solution-architect:1"]);
  assert.deepEqual(a.written, [
    "analysis:### analysis by business-analyst",
    "architecture:### architecture by solution-architect",
  ]);
  assert.deepEqual(titles(a.gh.comments.map((c) => c.body)), ["analysis:1", "architecture:1"]);
});

test("analysis: an open question stops before the next analyst and waits for the PO", () => {
  const a = analysisSetup(
    { analysisBlocks: "business-analyst" },
    {
      kind: "analysis",
      workflow: "Feature Analysis",
      analysts: ["business-analyst", "solution-architect"],
    },
  );
  assert.equal(runAnalysis(a.deps, a.target).state, "WAITING_PO");
  assert.deepEqual(a.agents.calls, ["business-analyst:1"]);
  assert.deepEqual(a.written, []);
});

// ---- DevTask-0027 #56: QA stage ----

test("Manual QA FAILED: same-round rework under new step ids, then QA passes → PR_PENDING", () => {
  const s = setup({ qa: ["FAILED", "PASSED"] }, delivery({ manualQa: true }));
  const ctx = runSlice(s.deps, s.target);
  assert.equal(ctx.state, "PR_PENDING");
  assert.equal(ctx.round, 1); // a QA rework is not a review round
  assert.equal(ctx.qaReworks, 1);
  assert.deepEqual(roles(s.agents.calls), [
    "backend-engineer",
    "code-reviewer",
    "manual-qa-engineer",
    "backend-engineer",
    "code-reviewer",
    "manual-qa-engineer",
  ]);
  assert.deepEqual(titles(s.gh.comments.map((c) => c.body)), [
    "implement:1",
    "checks:1",
    "code-review:1",
    "release-validation:1",
    "qa:1",
    "implement-qa1:1",
    "checks-qa1:1",
    "code-review-qa1:1",
    "release-validation-qa1:1",
    "qa-qa1:1",
  ]);
  const rework = s.agents.packets.find((p) => p.stepId === "implement-qa1");
  assert.deepEqual(
    rework?.openFindings.map((f) => f.id),
    ["QA-001"],
  );
});

test("release validation: uncommitted work is a QA failure the engineer fixes", () => {
  const s = setup({ leavesDirt: true }, delivery());
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const rel = s.gh.comments.map((c) => c.body).filter((b) => /step=release-validation/.test(b));
  assert.match(rel[0] ?? "", /\| Status \| FAILED \|[\s\S]*REL-001/);
  assert.match(rel[1] ?? "", /\| Status \| PASSED \|/);
  assert.equal(
    s.agents.packets.find((p) => p.stepId === "implement-qa1")?.openFindings[0]?.id,
    "REL-001",
  );
});

test("Manual QA BLOCKED stops for a person", () => {
  const s = setup({ qa: ["BLOCKED"] }, delivery({ manualQa: true }));
  assert.equal(runSlice(s.deps, s.target).state, "BLOCKED");
});
