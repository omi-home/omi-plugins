// T3.6 vertical slice with stubbed agents (real git worktree, real checks, in-memory GitHub):
// one report per step and round, delta findings between rounds, no fifth Dev, one Architect,
// transport failures retried as attempts, bad claims blocked, crash-resume without re-running.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type CliIo, main } from "../../../runtime/cli/main.ts";
import { claudeCode } from "../../../runtime/harness/adapters/claude-code/harness.ts";
import type { AgentLaunch } from "../../../runtime/harness/domain/harness.ts";
import {
  loadProfiles,
  profileSecretResolver,
} from "../../../runtime/profile/adapters/profile-config.ts";
import { generateMasterKey } from "../../../runtime/profile/domain/secrets.ts";
import { selectProfile } from "../../../runtime/profile/domain/selection.ts";
import { stepReports } from "../../../runtime/reporting/adapters/step-reports.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import type { TaskPacket } from "../../../runtime/shared/contracts.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import * as repo from "../../../runtime/task-run/adapters/repository.ts";
import { roleSkills } from "../../../runtime/task-run/adapters/role-files.ts";
import {
  lastStepError,
  runAnalysis,
  runSlice,
  zeroWidthIn,
} from "../../../runtime/task-run/application/slice.ts";
import { taskRunPorts } from "../../../runtime/task-run/cli/ports.ts";
import type { DeliveryPlan, WorkflowPlan } from "../../../runtime/task-run/domain/plan.ts";

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
  /** Security Reviewer verdicts, one per run of it (then `security`, then PASSED). */
  securityVerdicts?: Verdict[];
  /** This analyst stops with an open question. */
  analysisBlocks?: string;
  /** QA Engineer verdicts, one per QA run (default PASSED); INVALID cites an absolute path. */
  qa?: (Verdict | "INVALID")[];
  /** QA Engineer leaves a stray file in the worktree (#124). */
  qaDirties?: boolean;
  /** Engineer leaves an uncommitted file after its first step (release validation). */
  leavesDirt?: boolean;
  /** Engineer leaves a `.env` file: the runtime refuses to commit it (#262). */
  writesSecret?: boolean;
  /** Engineer still reports a SHA of its own: the runtime's commit replaces it (#262). */
  claimsSha?: boolean;
  /** From this round the engineer changes nothing (nothing for the runtime to commit). */
  noopFromRound?: number;
  /** Commands the host refused the engineer (permission_denials of its implement step, #252). */
  denies?: string[];
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
  const comments: { id: number; body: string; html_url: string; author_association: string }[] = [];
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
  const launches: AgentLaunch[] = [];
  const runAgent = (l: AgentLaunch): string => {
    const packet: TaskPacket = JSON.parse(l.stdin.split("\n\n")[1] as string);
    packets.push(packet);
    launches.push(l);
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
    } else if (role === "qa-engineer" && /^qa(-|$)/.test(packet.stepId)) {
      const q = script.qa?.shift() ?? "PASSED";
      if (script.qaDirties) writeFileSync(join(packet.worktree, "qa-scratch.txt"), "x");
      const v = q === "INVALID" ? "PASSED" : q;
      result = {
        ...base,
        status: v,
        ...(q === "INVALID" ? { evidencePaths: ["/abs/.git/omi/evidence/test.log"] } : {}),
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
      // `noopFromRound`: from that round on the engineer changes nothing and claims its first file.
      const noop = script.noopFromRound !== undefined && packet.round >= script.noopFromRound;
      const file = noop ? "src/implement-r1.txt" : `src/${packet.stepId}-r${packet.round}.txt`;
      mkdirSync(join(wt, "src"), { recursive: true });
      if (!noop) writeFileSync(join(wt, file), "work\n");
      const files = [file];
      if (script.addsTestFrom && packet.stepId >= script.addsTestFrom) {
        mkdirSync(join(wt, "tests"), { recursive: true });
        writeFileSync(join(wt, "tests", "regression.test.txt"), "t\n");
        files.push("tests/regression.test.txt");
      }
      const breaking = script.breakChecksInRound === packet.round && packet.stepId === "implement";
      if (breaking) writeFileSync(join(wt, "broken"), "");
      else rmSync(join(wt, "broken"), { force: true });
      // The agent never commits (#262): the runtime does after the step.
      if (script.leavesDirt && packet.stepId === "implement") writeFileSync(join(wt, "dirt"), "");
      if (script.writesSecret) writeFileSync(join(wt, ".env"), "TOKEN=abc\n");
      result = {
        ...base,
        status: "PASSED",
        summary: `implemented ${packet.stepId} r${packet.round}`,
        changedFiles: script.fakeClaim ? ["src/never.txt"] : files,
        ...(script.claimsSha ? { commitSha: git(wt, "rev-parse", "HEAD") } : {}),
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
      const v = script.securityVerdicts?.shift() ?? script.security ?? "PASSED";
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
        usage: {
          input_tokens: 100,
          output_tokens: 20,
          cache_read_input_tokens: 5,
          output_tokens_details: { thinking_tokens: 7 },
        },
        total_cost_usd: 0.0123,
        num_turns: 3,
        duration_ms: 4200,
        permission_denials:
          role.endsWith("-engineer") && packet.stepId === "implement"
            ? (script.denies ?? []).map((command) => ({
                tool_name: "Bash",
                tool_input: { command },
              }))
            : [],
      }),
    ].join("\n");
  };
  return { calls, packets, launches, runAgent };
}

function setup(script: Script = {}, plan?: WorkflowPlan, dbPath = ":memory:") {
  const { dir, base } = worktree();
  const db = openState(dbPath);
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
    pluginRoot: fileURLToPath(new URL("../../../", import.meta.url)), // real agents/ for role files
    evidenceDir: mkdtempSync(join(tmpdir(), "omi-evidence-")),
    ports: { ...taskRunPorts, reports: stepReports },
    harness: claudeCode,
    runAgent: agents.runAgent,
  };
  const taskRoot = mkdtempSync(join(tmpdir(), "omi-task-"));
  const target = { run, worktree: dir, taskRoot, baseSha: base, plan };
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
  assert.deepEqual(s.agents.calls, ["software-engineer:1", "code-reviewer:1"]);
  // Each agent runs in the task workspace with its role files and its own config dir (#168).
  const launch = s.agents.launches.at(-1) as AgentLaunch;
  assert.equal(launch.cwd, s.target.taskRoot);
  assert.equal(launch.env.CLAUDE_CONFIG_DIR, join(s.target.taskRoot, ".omi-home", "claude"));
  assert.match(readFileSync(join(s.target.taskRoot, "AGENTS.md"), "utf8"), /^## Code Reviewer$/m);
  // #199: every attempt records the skills installed for it (role defaults without a choice).
  const attempts = s.db
    .prepare("SELECT s.role, a.skills FROM step_attempt a JOIN step_run s ON s.id = a.step_run_id")
    .all();
  assert.deepEqual(
    attempts.map((r) => [r.role, JSON.parse(String(r.skills))]),
    [
      ["software-engineer", roleSkills(s.deps.pluginRoot, "software-engineer").default],
      ["code-reviewer", roleSkills(s.deps.pluginRoot, "code-reviewer").default],
    ],
  );
  assert.ok(s.gh.comments.some((c) => c.body.includes("| Skills | semantic-code-review |")));
  // Checks already passed on this HEAD: release validation reuses them, no QA Engineer planned.
  assert.deepEqual(titles(s.gh.comments.map((c) => c.body)), [
    "implement:1",
    "checks:1",
    "code-review:1",
    "release-validation:1",
  ]);
  assert.match(s.gh.comments[3]?.body ?? "", /1 commit\(s\) over base · checks passed on/);
  // Cost row: host-observed tokens, cache hit, list-price cost and host duration (spec §14).
  assert.match(
    s.gh.comments[0]?.body ?? "",
    /\| Cost \| 100 in \/ 20 out tokens · 7 thinking · 5 cache read \(5% hit\) · 3 turns · ≈ \$0\.0123 \(list-price estimate\) · 4\.2 s wall \|/,
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
      ["architecture", "skipped"],
      ["build", "skipped"],
      ["test", "pass"],
      ["scan", "skipped"],
    ],
  );
  assert.deepEqual(repo.pendingReports(s.db, "run"), []);
  const stored = s.db.prepare("SELECT result FROM step_run WHERE step_id = 'implement'").get();
  const usage = {
    inputTokens: 100,
    outputTokens: 20,
    cacheReadTokens: 5,
    thinkingTokens: 7,
    costUsd: 0.0123,
    numTurns: 3,
  };
  assert.deepEqual(JSON.parse(String(stored?.result)).usage, usage);
  // Every finished agent attempt keeps its usage in step_attempt (migration 4).
  const rows = repo.runUsage(s.db, "run");
  assert.deepEqual(
    rows.map((r) => [r.stepId, r.round, r.attempt, r.role, r.actualModel]),
    [
      ["implement", 1, 1, "software-engineer", "claude-sonnet-5-5"],
      ["code-review", 1, 1, "code-reviewer", "claude-sonnet-5-5"],
    ],
  );
  assert.deepEqual(rows[0]?.usage, usage);
});

test("2 + Architect + 2: every round reported, delta findings, no fifth Dev, one Architect", () => {
  const s = setup({ review: () => "FAILED" });
  const ctx = runSlice(s.deps, s.target);
  assert.deepEqual([ctx.state, ctx.round], ["WAITING_PO", 4]);
  assert.deepEqual(s.agents.calls, [
    "software-engineer:1",
    "code-reviewer:1",
    "software-engineer:2",
    "code-reviewer:2",
    "solution-architect:2",
    "software-engineer:3",
    "code-reviewer:3",
    "software-engineer:4",
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
  const devPackets = s.agents.packets.filter((p) => p.role === "software-engineer");
  assert.deepEqual(devPackets[0]?.openFindings, []);
  assert.deepEqual(
    devPackets[1]?.openFindings.map((f) => f.id),
    ["CR-001"],
  );
  assert.deepEqual(
    devPackets[2]?.openFindings.map((f) => f.id),
    ["ARC-001", "CR-001"],
    "round 3 follows the plan and keeps the review finding the plan does not repeat (Bug-0013)",
  );
  assert.equal(devPackets[0]?.issueContext.map((e) => e.issue.number).join(), "9,8");
  assert.equal(repo.reviewRounds(s.db, "run"), 4);
});

test("Architect scope change stops at WAITING_PO before any third round", () => {
  const s = setup({ review: () => "FAILED", architect: "FAILED" });
  assert.equal(runSlice(s.deps, s.target).state, "WAITING_PO");
  assert.equal(s.agents.calls.filter((c) => c.startsWith("software-engineer")).length, 2);
});

test("failed checks go back to the engineer as CHK findings, not as a review round", () => {
  const s = setup({ breakChecksInRound: 1 });
  const ctx = runSlice(s.deps, s.target);
  assert.equal(ctx.state, "PR_PENDING");
  assert.deepEqual(s.agents.calls, [
    "software-engineer:1",
    "software-engineer:1",
    "code-reviewer:1",
  ]);
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

test("a fake changed-file claim no longer blocks the run: the runtime lists git's files (#272)", () => {
  const s = setup({ fakeClaim: true });
  const ctx = runSlice(s.deps, s.target);
  assert.equal(ctx.state, "PR_PENDING");
  // The step report lists what git saw; the claim survives only as a note in the summary.
  const report = s.gh.comments[0]?.body ?? "";
  assert.match(report, /### Changed files\s+- `src\/implement-r1\.txt`\s+###/);
  assert.match(report, /claimed but not changed since baseSha: src\/never\.txt/);
});

test("agent summary over 2000 chars: cut with evidence file, StepComment warning and Warning: line (#380)", () => {
  const s = setup();
  const real = s.deps.runAgent;
  const secret = `ghp_${"Q".repeat(36)}`;
  // 1925 + 41 chars of secret, then padding: the cut (~1961) falls inside the secret.
  const long = `${"word ".repeat(385)}${secret}${" tail".repeat(20)}`;
  const runAgent = (l: AgentLaunch) =>
    real(l)
      .split("\n")
      .map((line) => {
        if (!line.includes('"type":"result"')) return line;
        const ev = JSON.parse(line) as { result: string };
        const r = JSON.parse(ev.result) as { summary: string };
        r.summary = long;
        ev.result = JSON.stringify(r);
        return JSON.stringify(ev);
      })
      .join("\n");
  const ctx = runSlice({ ...s.deps, runAgent }, s.target);
  assert.equal(ctx.state, "PR_PENDING");
  const out = readFileSync(join(s.deps.evidenceDir, "implement-r1-a1.output.txt"), "utf8");
  assert.match(out, /word word/);
  assert.doesNotMatch(out, /QQQQ/);
  const report = s.gh.comments[0]?.body ?? "";
  assert.match(report, /Warning: .*summary: \d+ chars, cut to 2000/);
  assert.doesNotMatch(report, /QQQQ/);
});

test("unparseable agent output: redacted raw output kept beside the error, path in details (#269)", () => {
  const s = setup();
  const secret = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const runAgent = () =>
    JSON.stringify({
      type: "result",
      is_error: false,
      result: `I could not produce JSON. token=${secret}`,
      usage: { input_tokens: 1, output_tokens: 1 },
    });
  assert.equal(runSlice({ ...s.deps, runAgent }, s.target).state, "BLOCKED");
  const err = lastStepError(s.deps.evidenceDir);
  assert.equal(err?.code, "CONTRACT_INVALID");
  const details = (
    JSON.parse(readFileSync(err?.file ?? "", "utf8")) as {
      details: { rawOutputPath: string };
    }
  ).details;
  assert.match(details.rawOutputPath, /implement-r1-a1\.output\.txt$/);
  const raw = readFileSync(join(s.deps.evidenceDir, "implement-r1-a1.output.txt"), "utf8");
  assert.match(raw, /could not produce JSON/);
  assert.doesNotMatch(raw, new RegExp(secret));
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
  assert.deepEqual(s.agents.calls, ["software-engineer:1"]);
  assert.equal(repo.pendingReports(s.db, "run").length, 1);
  failPublish = false;
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  assert.deepEqual(
    s.agents.calls,
    ["software-engineer:1", "code-reviewer:1"],
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
  engineer: "software-engineer",
  security: false,
  regressionTest: false,
  manualQa: false,
  ...p,
});
const roles = (calls: string[]) => calls.map((c) => c.split(":")[0]);

test("planned engineer runs; no Security Reviewer unless required", () => {
  const s = setup({}, delivery({ engineer: "qa-engineer" }));
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  assert.deepEqual(s.agents.calls, ["qa-engineer:1", "code-reviewer:1"]);
});

test("task run never launches the BA; the SA only as the 'architect' step after 2 FAILED rounds (#382 CR-002)", () => {
  const analysts = ["business-analyst", "solution-architect"];
  // (a) runs whose reviews pass: software engineer, test task (qa-engineer), manualQa plan.
  for (const plan of [
    delivery(),
    delivery({ engineer: "qa-engineer" }),
    delivery({ manualQa: true }),
  ]) {
    const s = setup({}, plan);
    assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
    assert.deepEqual(
      s.agents.packets.filter((p) => analysts.includes(p.role)),
      [],
      `no analyst in a passing ${plan.engineer} run`,
    );
  }
  // (b) 2 FAILED review rounds: exactly one SA launch, step 'architect', never a BA.
  const s = setup({ review: () => "FAILED" });
  runSlice(s.deps, s.target);
  const sa = s.agents.packets.filter((p) => p.role === "solution-architect");
  assert.deepEqual(
    sa.map((p) => p.stepId),
    ["architect"],
  );
  assert.equal(s.agents.packets.filter((p) => p.role === "business-analyst").length, 0);
});

test("security label: Security Reviewer after Code Review; its FAILED is a review round", () => {
  const s = setup({ security: "FAILED" }, delivery({ security: true }));
  const ctx = runSlice(s.deps, s.target);
  assert.equal(ctx.state, "WAITING_PO"); // every round fails security: 2 + Architect + 2
  assert.deepEqual(roles(s.agents.calls).slice(0, 4), [
    "software-engineer",
    "code-reviewer",
    "security-reviewer",
    "software-engineer",
  ]);
  // The engineer's round 2 packet carries the security findings (delta rework).
  const dev2 = s.agents.packets.find((p) => p.role === "software-engineer" && p.round === 2);
  assert.deepEqual(
    dev2?.openFindings.map((f) => f.id),
    ["SEC-001"],
  );
});

test("Code Reviewer routes to security review without a label", () => {
  const s = setup({ reviewNext: "security-review: touches auth" }, delivery());
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  assert.deepEqual(roles(s.agents.calls), [
    "software-engineer",
    "code-reviewer",
    "security-reviewer",
  ]);
});

test("critical security finding escalates to the PO at once", () => {
  const s = setup({ security: "CRITICAL" }, delivery({ security: true }));
  assert.equal(runSlice(s.deps, s.target).state, "WAITING_PO");
  assert.equal(s.agents.calls.length, 3); // no rework round
});

test("PO resume after a critical finding re-runs the Security Reviewer, not its old report (#123)", () => {
  const s = setup({ security: "CRITICAL" }, delivery({ security: true }));
  assert.equal(runSlice(s.deps, s.target).state, "WAITING_PO");
  repo.advanceRun(s.db, "run", { type: "PO_RESUME" });
  assert.equal(runSlice(s.deps, s.target).state, "WAITING_PO");
  const sec = s.agents.packets.filter((p) => p.role === "security-reviewer");
  assert.deepEqual(
    sec.map((p) => p.attempt),
    [1, 2],
  );
  assert.equal(roles(s.agents.calls).filter((r) => r === "code-reviewer").length, 1);
});

// ---- Bug-0013 #392: open findings survive BLOCKED and resume ----

const sec001 = (p: TaskPacket | undefined) => p?.openFindings.map((f) => f.id);

test("FAILED security review → Architect BLOCKED → unblock → run: the Architect and round 3 get SEC-001 (#392)", () => {
  const s = setup({ securityVerdicts: ["FAILED", "FAILED"] }, delivery({ security: true }));
  const real = s.deps.runAgent;
  let garbage = true;
  // First Architect answer is refused (CONTRACT_INVALID): the run is BLOCKED, as in run 382-7407f8b8.
  const runAgent = (l: AgentLaunch) => {
    const out = real(l);
    if (!garbage || !l.stdin.includes('"role": "solution-architect"')) return out;
    garbage = false;
    return JSON.stringify({ type: "result", is_error: false, result: "no json", usage: {} });
  };
  assert.equal(runSlice({ ...s.deps, runAgent }, s.target).state, "BLOCKED");
  assert.deepEqual(repo.runFindings(s.db, "run"), {
    findings: [
      {
        id: "SEC-001",
        severity: "high",
        observed: "SQL built from input",
        expected: "parameterize",
      },
    ],
    failedReviewers: ["security-reviewer"],
  });
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  // A new `task run` process: nothing in memory, everything from state.sqlite.
  assert.equal(runSlice({ ...s.deps, runAgent }, s.target).state, "PR_PENDING");
  const architect = s.agents.packets.filter((p) => p.role === "solution-architect");
  assert.deepEqual(sec001(architect.at(-1)), ["SEC-001"], "the resumed Architect sees the finding");
  const dev3 = s.agents.packets.find((p) => p.role === "software-engineer" && p.round === 3);
  assert.deepEqual(
    sec001(dev3),
    ["ARC-001", "SEC-001"],
    "plan plus the review finding it does not repeat",
  );
  // Round 3 confirms: the Security Reviewer that FAILED ran again and passed.
  assert.deepEqual(repo.runFindings(s.db, "run"), { findings: [], failedReviewers: [] });
});

test("a reviewer that FAILED runs again after resume even when no label selects it any more (#392)", () => {
  let unblocked = false;
  const s = setup(
    {
      securityVerdicts: ["FAILED"],
      review: (round) => (round === 2 && !unblocked ? "BLOCKED" : "PASSED"),
    },
    delivery({ security: true }),
  );
  assert.equal(runSlice(s.deps, s.target).state, "BLOCKED"); // round 2 code review stops
  assert.deepEqual(repo.runFindings(s.db, "run").failedReviewers, ["security-reviewer"]);
  unblocked = true;
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  const noLabel = { ...s.target, plan: delivery({ security: false }) };
  assert.equal(runSlice(s.deps, noLabel).state, "PR_PENDING");
  assert.ok(s.agents.calls.includes("security-reviewer:2"), s.agents.calls.join());
  assert.deepEqual(repo.runFindings(s.db, "run"), { findings: [], failedReviewers: [] });
});

test("a run with a blocking finding no reviewer closed never reaches PR_PENDING (#392)", () => {
  const s = setup({}, delivery());
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  // Tamper like a lost round: back in QA with SEC-001 open and the Security Reviewer unconfirmed.
  const ctx = repo.runContext(s.db, "run");
  s.db
    .prepare("UPDATE workflow_run SET state = 'IN_QA', context = ? WHERE id = 'run'")
    .run(JSON.stringify({ ...ctx, state: "IN_QA" }));
  repo.saveRunFindings(s.db, "run", {
    findings: [
      {
        id: "SEC-001",
        severity: "medium",
        observed: "SQL built from input",
        expected: "parameterize",
      },
    ],
    failedReviewers: ["security-reviewer"],
  });
  const before = s.agents.packets.length;
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const after = s.agents.packets.slice(before);
  // Not straight to PR_PENDING: engineer (with SEC-001 + REL-003), then both reviewers.
  assert.deepEqual(
    after.map((p) => p.role),
    ["software-engineer", "code-reviewer", "security-reviewer"],
  );
  assert.deepEqual(sec001(after[0]), ["REL-003", "SEC-001"]);
  assert.deepEqual(repo.runFindings(s.db, "run"), { findings: [], failedReviewers: [] });
});

test("with the Security Reviewer failing again the same run ends at WAITING_PO, never PR_PENDING (#392)", () => {
  const s = setup({}, delivery());
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const ctx = repo.runContext(s.db, "run");
  s.db
    .prepare("UPDATE workflow_run SET state = 'IN_QA', context = ? WHERE id = 'run'")
    .run(JSON.stringify({ ...ctx, state: "IN_QA" }));
  repo.saveRunFindings(s.db, "run", {
    findings: [
      {
        id: "SEC-001",
        severity: "high",
        observed: "SQL built from input",
        expected: "parameterize",
      },
    ],
    failedReviewers: ["security-reviewer"],
  });
  const failing = stubAgents({ security: "FAILED" });
  const ctx2 = runSlice({ ...s.deps, runAgent: failing.runAgent }, s.target);
  assert.notEqual(ctx2.state, "PR_PENDING");
  assert.equal(ctx2.state, "WAITING_PO");
});

test("Bug Resolution: a fix without a regression test is a failed gate, not a review", () => {
  const s = setup(
    { addsTestFrom: "implement-fix1" },
    delivery({ workflow: "Bug Resolution", regressionTest: true }),
  );
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  assert.deepEqual(roles(s.agents.calls), [
    "software-engineer",
    "software-engineer",
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

test("QA Engineer FAILED: same-round rework under new step ids, then QA passes → PR_PENDING", () => {
  const s = setup({ qa: ["FAILED", "PASSED"] }, delivery({ manualQa: true }));
  const ctx = runSlice(s.deps, s.target);
  assert.equal(ctx.state, "PR_PENDING");
  assert.equal(ctx.round, 1); // a QA rework is not a review round
  assert.equal(ctx.qaReworks, 1);
  assert.deepEqual(roles(s.agents.calls), [
    "software-engineer",
    "code-reviewer",
    "qa-engineer",
    "software-engineer",
    "code-reviewer",
    "qa-engineer",
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

test("runtime commits after implement: deterministic message, SHA from the runtime (#262)", () => {
  const s = setup({ leavesDirt: true, claimsSha: true }, delivery());
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const wt = s.target.worktree;
  assert.equal(git(wt, "status", "--porcelain"), "", "everything committed, dirt included");
  const msg = git(wt, "log", "-1", "--format=%B");
  assert.match(
    msg,
    /^feat\(software\): #9 \(#9\)\n\nOMI step implement, round 1, attempt 1\.\n\nCo-Authored-By: claude-sonnet-5-5 </,
  );
  const dev = s.gh.comments.find((c) => c.body.includes("step=implement;")) ?? { body: "" };
  assert.ok(dev.body.includes(git(wt, "rev-parse", "HEAD").slice(0, 7)), "report shows the SHA");
  assert.equal(git(wt, "rev-list", "--count", `${s.target.baseSha}..HEAD`), "1");
  // The agent has no git write grant.
  const args = s.agents.launches[0]?.args ?? [];
  assert.ok(!args.some((t) => /git -C .+ (add|commit)/.test(t)));
});

test("a file the runtime must not commit blocks the step; nothing is staged (#262)", () => {
  const s = setup({ writesSecret: true }, delivery());
  assert.equal(runSlice(s.deps, s.target).state, "BLOCKED");
  assert.equal(lastStepError(s.deps.evidenceDir)?.code, "POLICY_VIOLATION");
  assert.match(lastStepError(s.deps.evidenceDir)?.message ?? "", /\.env/);
  assert.equal(git(s.target.worktree, "rev-parse", "HEAD"), s.target.baseSha);
  assert.equal(git(s.target.worktree, "diff", "--cached", "--name-only"), "");
});

test("rework round 2: a new commit; a no-change step makes none and the report says so (#262)", () => {
  const s = setup({ review: (r) => (r === 1 ? "FAILED" : "PASSED"), noopFromRound: 2 }, delivery());
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const wt = s.target.worktree;
  assert.equal(git(wt, "rev-list", "--count", `${s.target.baseSha}..HEAD`), "1");
  const dev2 = s.gh.comments.find((c) => /step=implement;round=2/.test(c.body)) ?? { body: "" };
  assert.match(dev2.body, /no changes to commit/);
});

test("rework round 2 with changes: second commit names round 2 (#262)", () => {
  const s = setup({ review: (r) => (r === 1 ? "FAILED" : "PASSED") }, delivery());
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const wt = s.target.worktree;
  assert.equal(git(wt, "rev-list", "--count", `${s.target.baseSha}..HEAD`), "2");
  assert.match(git(wt, "log", "-1", "--format=%B"), /round 2, attempt 1/);
});

test("QA Engineer BLOCKED stops for a person", () => {
  const s = setup({ qa: ["BLOCKED"] }, delivery({ manualQa: true }));
  assert.equal(runSlice(s.deps, s.target).state, "BLOCKED");
});

test("agent BLOCKED → unblock → run: that step runs again, PASSED steps replay (#123)", () => {
  const s = setup({ qa: ["BLOCKED", "PASSED"] }, delivery({ manualQa: true }));
  assert.equal(runSlice(s.deps, s.target).state, "BLOCKED");
  assert.equal(repo.runContext(s.db, "run").resumeFrom, "IN_QA");
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const qa = s.agents.packets.filter((p) => p.role === "qa-engineer");
  assert.deepEqual(
    qa.map((p) => [p.stepId, p.attempt]),
    [
      ["qa", 1],
      ["qa", 2],
    ],
  );
  assert.equal(roles(s.agents.calls).filter((r) => r === "code-reviewer").length, 1);
});

test("QA Engineer technical failure: unblocked run resumes in QA and still gets checks (#121)", () => {
  const s = setup({ qa: ["INVALID", "PASSED"] }, delivery({ manualQa: true }));
  assert.equal(runSlice(s.deps, s.target).state, "BLOCKED");
  assert.equal(lastStepError(s.deps.evidenceDir)?.code, "CONTRACT_INVALID");
  // A new invocation after the unblock has no in-memory checks of the first one.
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const qa = s.agents.packets.filter((p) => p.role === "qa-engineer");
  assert.equal(qa.length, 2);
  assert.equal(qa[1]?.checkResults?.find((c) => c.name === "test")?.outcome, "pass");
});

test("QA Engineer may run the repo's check commands; reviewers may not (PO #124)", () => {
  const s = setup({}, delivery({ manualQa: true }));
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const repoRel = (
    s.agents.launches[0]?.args.find((t) => t.startsWith("Bash(git -C ")) ?? ""
  ).replace(/^Bash\(git -C (.+?) status\)$/, "$1");
  const check = `Bash(cd ${repoRel} && ${s.deps.config.checks.test?.run})`;
  const args = (role: string) =>
    s.agents.launches.find((l) => l.stdin.includes(`"role": "${role}"`))?.args ?? [];
  assert.ok(args("qa-engineer").includes(check));
  const commit = (role: string) =>
    args(role).some((t) => /^Bash\(git -C .+ (commit|add)\*\)$/.test(t));
  assert.ok(!commit("software-engineer"), "the runtime commits, not the engineer (#262)");
  assert.ok(!commit("qa-engineer"));
  assert.ok(!args("code-reviewer").includes(check));
  assert.ok(args("software-engineer").includes(check));
  // #252: a check may take arguments (one test file); reviewers still get none of it.
  const withArgs = `Bash(cd ${repoRel} && ${s.deps.config.checks.test?.run} *)`;
  assert.ok(args("software-engineer").includes(withArgs));
  assert.ok(args("qa-engineer").includes(withArgs));
  assert.ok(!args("code-reviewer").includes(withArgs));
  // #275: bare forms for when a previous `cd` left the shell inside the repo.
  const run = s.deps.config.checks.test?.run;
  for (const bare of [`Bash(${run})`, `Bash(${run} *)`]) {
    assert.ok(args("software-engineer").includes(bare));
    assert.ok(args("qa-engineer").includes(bare));
    assert.ok(!args("code-reviewer").includes(bare));
  }
  // CR-001: read-only git also bare (cwd inside the repo), never a bare write.
  for (const sub of ["status", "diff", "log", "show"]) {
    for (const role of ["software-engineer", "code-reviewer"]) {
      for (const form of [
        `Bash(git -C ${repoRel} ${sub})`,
        `Bash(git -C ${repoRel} ${sub} *)`,
        `Bash(git ${sub})`,
        `Bash(git ${sub} *)`,
      ]) {
        assert.ok(args(role).includes(form), `${role}: ${form}`);
      }
    }
  }
  for (const l of s.agents.launches) {
    assert.ok(
      !l.args.some((t) => /^Bash\(git .*\b(status|diff|log|show)\*\)$/.test(t)),
      "no prefix `*` without a space (git difftool)",
    );
  }
  assert.ok(!args("software-engineer").some((t) => /^Bash\(git (add|commit|push)/.test(t)));
  // DevTask-0131 #382: engineers move files and run the repo's npm scripts; reviewers read through pipes.
  for (const form of [
    `Bash(git -C ${repoRel} mv)`,
    `Bash(git -C ${repoRel} mv *)`,
    `Bash(git mv *)`,
    ...["check", "arch", "test", "format"].flatMap((n) => [
      `Bash(cd ${repoRel} && npm run ${n})`,
      `Bash(cd ${repoRel} && npm run ${n} *)`,
      `Bash(npm run ${n})`,
      `Bash(npm run ${n} *)`,
    ]),
  ]) {
    assert.ok(args("software-engineer").includes(form), form);
    assert.ok(!args("qa-engineer").includes(form), `no ${form} for the read-only QA step`);
    assert.ok(!args("code-reviewer").includes(form), `no ${form} for a reviewer`);
  }
  // DevTask-0138 #395: no shell reader for anyone; reviewers read with Read/Grep/Glob and git.
  for (const role of ["code-reviewer", "security-reviewer", "software-engineer"]) {
    for (const c of ["grep", "cat", "head", "tail", "wc"]) {
      assert.ok(
        !args(role).some((t) => t === `Bash(${c})` || t.startsWith(`Bash(${c} `)),
        `${role}: no ${c}`,
      );
    }
  }
});

test("refused commands are kept in evidence and listed in the step report (#252)", () => {
  const s = setup({ denies: ["cd app && npm run check", "git `status`"] });
  assert.equal(runSlice(s.deps, s.target).state, "PR_PENDING");
  const file = join(s.deps.evidenceDir, "implement-r1-a1.denials.json");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), [
    "Bash:cd app && npm run check",
    "Bash:git `status`",
  ]);
  const dev = s.gh.comments.find((c) => c.body.includes("step=implement;")) ?? { body: "" };
  assert.ok(dev.body.includes("- Permission denied: `Bash:cd app && npm run check`"));
  assert.ok(dev.body.includes("- Permission denied: `Bash:git 'status'`"), "no code-span break");
  const review = s.gh.comments.find((c) => c.body.includes("step=code-review;")) ?? { body: "" };
  assert.ok(!review.body.includes("Permission denied"));
});

test("QA Engineer that leaves the worktree dirty blocks the run, with the reason kept (#124)", () => {
  const s = setup({ qaDirties: true }, delivery({ manualQa: true }));
  assert.equal(runSlice(s.deps, s.target).state, "BLOCKED");
  const err = lastStepError(s.deps.evidenceDir);
  assert.equal(err?.code, "POLICY_VIOLATION");
  assert.match(err?.message ?? "", /qa-scratch\.txt/);
});

const gatewaySelection = () => ({
  profile: {
    name: "cc-gw",
    harness: "claudecode" as const,
    disabled: false,
    auth: {
      type: "gateway" as const,
      baseUrl: "https://gw.example.com",
      scheme: "x-api-key" as const,
      keyEnv: "OMI_GW",
    },
    models: ["claude-opus-5-5"],
    efforts: ["high" as const],
  },
  model: "claude-opus-5-5",
  effort: "high" as const,
  reason: "spread evenly",
  secret: () => "k",
});
const subSelection = () => ({
  profile: {
    name: "cc-sub",
    harness: "claudecode" as const,
    disabled: false,
    auth: { type: "subscription" as const, tokenEnv: "OMI_SUB" },
    models: ["claude-sonnet-5-5"],
    efforts: ["medium" as const],
  },
  model: "claude-sonnet-5-5",
  effort: "medium" as const,
  reason: "spread evenly",
  secret: () => "t",
});
const hostEnv = { PATH: "/bin", OMI_GW: "k", OMI_SUB: "t" };

for (const [name, transcript] of [
  [
    "rate_limit_event rejected",
    [
      {
        type: "rate_limit_event",
        rate_limit_info: { status: "rejected", rateLimitType: "five_hour" },
      },
      { type: "result", is_error: true, api_error_status: 429, result: "limit" },
    ],
  ],
  ["429", [{ type: "result", is_error: true, api_error_status: 429, result: "limit" }]],
  ["402 (gateway)", [{ type: "result", is_error: true, api_error_status: 402, result: "credit" }]],
] as const) {
  test(`quota mid-step (${name}) → BLOCKED with a report; another profile runs a new attempt (#218)`, () => {
    const s = setup();
    const real = s.deps.runAgent;
    let quotaOnce = true;
    const runAgent = (l: AgentLaunch) => {
      if (quotaOnce) {
        // The engineer is cut after a first edit: the next attempt must find it.
        quotaOnce = false;
        s.agents.packets.push(JSON.parse(l.stdin.split("\n\n")[1] as string));
        s.agents.launches.push(l);
        writeFileSync(join(s.target.worktree, "half-done.txt"), "wip\n");
        return transcript.map((e) => JSON.stringify(e)).join("\n");
      }
      return real(l);
    };
    const first = { ...s.deps, runAgent, hostEnv, selection: subSelection() };
    assert.equal(runSlice(first, s.target).state, "BLOCKED");
    const err = lastStepError(s.deps.evidenceDir);
    assert.equal(err?.code, "QUOTA_EXHAUSTED");
    assert.match(err?.message ?? "", /profile cc-sub is out of quota .*"disabled": true/);
    assert.equal(s.gh.comments.length, 1);
    assert.match(s.gh.comments[0]?.body ?? "", /step=implement;round=1;attempt=1/);
    assert.match(s.gh.comments[0]?.body ?? "", /api_error_status|rate_limit_info/);
    assert.equal(repo.runContext(s.db, "run").resumeFrom, "RUNNING");

    repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
    const second = { ...s.deps, runAgent, hostEnv, selection: gatewaySelection() };
    assert.equal(runSlice(second, s.target).state, "PR_PENDING");
    const dev = s.agents.packets.filter((p) => p.role === "software-engineer");
    assert.deepEqual(
      dev.map((p) => [p.stepId, p.attempt, p.priorAttemptCut]),
      [
        ["implement", 1, undefined],
        ["implement", 2, true],
      ],
    );
    assert.doesNotMatch(s.agents.launches[0]?.stdin ?? "", /git diff/);
    assert.match(s.agents.launches[1]?.stdin ?? "", /read `git status` and `git diff`/i);
    assert.equal(s.agents.launches[1]?.env.ANTHROPIC_API_KEY, "k");
    assert.deepEqual(
      s.db
        .prepare("SELECT attempt, profile, error_code FROM step_attempt WHERE step_run_id = 1")
        .all()
        .map((r) => ({ ...r })),
      [
        { attempt: 1, profile: "cc-sub", error_code: "QUOTA_EXHAUSTED" },
        { attempt: 2, profile: "cc-gw", error_code: null },
      ],
    );
  });
}

test("gateway profile: zero-width characters in the diff block the run before any report (#218)", () => {
  const s = setup();
  const real = s.deps.runAgent;
  const runAgent = (l: AgentLaunch) => {
    const out = real(l);
    writeFileSync(join(s.target.worktree, "src", "wm.txt"), "ok\u200B\n");
    git(s.target.worktree, "add", "-A");
    git(s.target.worktree, "commit", "-qm", "wm");
    return out;
  };
  const deps = { ...s.deps, runAgent, hostEnv, selection: gatewaySelection() };
  assert.equal(runSlice(deps, s.target).state, "BLOCKED");
  const err = lastStepError(s.deps.evidenceDir);
  assert.equal(err?.code, "POLICY_VIOLATION");
  assert.match(err?.message ?? "", /zero-width .* in: diff/);
  assert.equal(s.gh.comments.length, 0);
});

test("gateway profile: zero-width characters in the report block it; a subscription is not checked", () => {
  for (const [selection, blocked] of [
    [gatewaySelection(), true],
    [subSelection(), false],
  ] as const) {
    const s = setup();
    const real = s.deps.runAgent;
    const runAgent = (l: AgentLaunch) => real(l).replace("implemented", "implemented\u2060");
    const ctx = runSlice({ ...s.deps, runAgent, hostEnv, selection }, s.target);
    assert.equal(ctx.state, blocked ? "BLOCKED" : "PR_PENDING");
    if (blocked) assert.match(lastStepError(s.deps.evidenceDir)?.message ?? "", /in: report\./);
  }
});

test("zeroWidthIn: untracked files and commit messages of an editing step", () => {
  const s = setup();
  const wt = s.target.worktree;
  writeFileSync(join(wt, "a.txt"), "x");
  git(wt, "add", "-A");
  git(wt, "commit", "-qm", "msg\u200C");
  writeFileSync(join(wt, "new.txt"), "\u200D");
  assert.deepEqual(zeroWidthIn(s.target, true, ["clean"]), ["new.txt", "commit message"]);
  assert.deepEqual(zeroWidthIn(s.target, false, ["clean"]), []);
});

const CANARY_CASES = [
  {
    name: "subscription",
    flags: ["--auth", "subscription", "--token-env", "OMI_T_CANARY"],
    envVar: "CLAUDE_CODE_OAUTH_TOKEN",
    canary: "omi-canary-7f3e9a1b2c4d5e6f",
  },
  {
    name: "gateway bearer",
    flags: [
      "--auth",
      "gateway",
      "--base-url",
      "https://gw.example.com",
      "--scheme",
      "bearer",
      "--key-env",
      "OMI_T_GW",
    ],
    envVar: "ANTHROPIC_AUTH_TOKEN",
    canary: "omi-canary-8a1b2c3d4e5f6071",
  },
  {
    name: "gateway x-api-key",
    flags: [
      "--auth",
      "gateway",
      "--base-url",
      "https://gw.example.com",
      "--scheme",
      "x-api-key",
      "--key-env",
      "OMI_T_GW",
    ],
    envVar: "ANTHROPIC_API_KEY",
    canary: "omi-canary-9b2c3d4e5f607182",
  },
] as const;

for (const tc of CANARY_CASES) {
  test(`token canary (${tc.name}): a decrypted token echoed by the agent reaches no evidence, outbox, comment, state.sqlite, stdout or envelope (AC-8)`, () => {
    const CANARY: string = tc.canary;
    const key = generateMasterKey();
    const ws = mkdtempSync(join(tmpdir(), "omi-canary-ws-"));
    const env = { OMI_SECRET_KEY: key, OMI_PROFILE_DB: join(ws, "profiles.sqlite") };
    mkdirSync(join(ws, ".omi-plugins"));
    mkdirSync(join(ws, "repo", ".git"), { recursive: true });
    const cli = (args: string[], stdin = "") =>
      main([...args, "--output", "json"], ws, { env, stdin: () => stdin } satisfies CliIo);
    const added = cli(
      [
        "profile",
        "add",
        "cc-sub",
        ...tc.flags,
        "--models",
        "claude-sonnet-5-5",
        "--efforts",
        "medium",
        "--token-stdin",
      ],
      CANARY,
    );
    assert.equal(added.code, 0, added.stdout);

    const stateFile = join(ws, ".omi-plugins", "state.sqlite");
    const s = setup({}, undefined, stateFile);
    const selection = selectProfile(
      loadProfiles(ws, env),
      { profile: "cc-sub", reason: "canary" },
      profileSecretResolver(ws, env),
    );
    assert.ok(selection);
    assert.ok(!JSON.stringify(selection).includes(CANARY));

    const real = s.deps.runAgent;
    const runAgent = (l: AgentLaunch) => {
      const token = l.env[tc.envVar] as string;
      assert.equal(token, CANARY);
      const lines = real(l).split("\n");
      const i = lines.findIndex((x) => x.startsWith('{"type":"result"'));
      const result = JSON.parse(lines[i] as string);
      const inner = JSON.parse(result.result);
      inner.summary = `echo ${token}`;
      inner.nextAction = `rotate ${token}`;
      inner.sectionUpdates = [{ section: "scratch", markdown: `leak ${token}` }];
      if (inner.role === "code-reviewer") {
        inner.findings = [{ id: "CR-001", severity: "info", observed: token, expected: token }];
      }
      result.result = JSON.stringify(inner);
      lines[i] = JSON.stringify(result);
      // The raw stream-json stdout carries it too.
      lines.unshift(JSON.stringify({ type: "assistant", message: { text: token } }));
      return lines.join("\n");
    };
    const ctx = runSlice({ ...s.deps, runAgent, hostEnv: { PATH: "/bin" }, selection }, s.target);
    assert.equal(ctx.state, "PR_PENDING");

    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(s.deps.evidenceDir);
    assert.ok(files.length > 0);
    for (const f of files) assert.ok(!readFileSync(f).includes(CANARY), f);
    const rows = JSON.stringify([
      s.db.prepare("SELECT body FROM outbox").all(),
      s.db.prepare("SELECT result FROM step_run").all(),
      s.db.prepare("SELECT context FROM workflow_run").all(),
    ]);
    assert.ok(!rows.includes(CANARY));
    // The success path keeps no raw agent output in evidence; the scrubbed echo lives in the persisted result/report.
    // The canary matches no static rule, so only the registered-secret path can have produced this marker.
    assert.ok(rows.includes("[REDACTED:secret]"), "registered-secret redaction must have fired");
    assert.ok(!JSON.stringify(s.gh.comments).includes(CANARY));
    assert.ok(!JSON.stringify(ctx).includes(CANARY));
    s.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    const disk = readdirSync(join(ws, ".omi-plugins"))
      .filter((f) => f.startsWith("state.sqlite"))
      .map((f) => readFileSync(join(ws, ".omi-plugins", f)).toString("latin1"))
      .join("");
    assert.ok(!disk.includes(CANARY));
    const machine = readdirSync(ws)
      .filter((f) => f.startsWith("profiles.sqlite"))
      .map((f) => readFileSync(join(ws, f)).toString("latin1"))
      .join("");
    assert.ok(machine.length > 0 && !machine.includes(CANARY));
    for (const out of [cli(["profile", "list"]), main(["profile", "list"], ws, { env })]) {
      assert.ok(!out.stdout.includes(CANARY) && !out.stderr.includes(CANARY));
    }
  });
}

test("no profile (#250): each role launches with its agents.routing; state and report match", () => {
  const s = setup();
  const config = parseConfig({
    github: { owner: "o", repo: "r", projectNumber: 1 },
    checks: { test: { run: `node -e "process.exit(0)"` } },
    agents: {
      routing: {
        "software-engineer": { model: "haiku", effort: "low" },
        "code-reviewer": { model: "opus", effort: "high" },
      },
    },
  });
  const ctx = runSlice({ ...s.deps, config }, s.target);
  assert.equal(ctx.state, "PR_PENDING");
  const routes: Record<string, [string, string]> = {
    "software-engineer": ["haiku", "low"],
    "code-reviewer": ["opus", "high"],
  };
  assert.equal(s.agents.launches.length, 2);
  s.agents.launches.forEach((l, i) => {
    const role = i === 0 ? "software-engineer" : "code-reviewer";
    const at = l.args.indexOf("--model");
    assert.deepEqual(l.args.slice(at, at + 4), [
      "--model",
      routes[role]?.[0],
      "--effort",
      routes[role]?.[1],
    ]);
  });
  const rows = s.db
    .prepare(
      "SELECT s.role, a.profile, a.requested_model, a.requested_effort FROM step_attempt a JOIN step_run s ON s.id = a.step_run_id ORDER BY s.id",
    )
    .all()
    .map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    {
      role: "software-engineer",
      profile: null,
      requested_model: "haiku",
      requested_effort: "low",
    },
    { role: "code-reviewer", profile: null, requested_model: "opus", requested_effort: "high" },
  ]);
  const body = (step: string) =>
    s.gh.comments.find((c) => c.body.includes(`step=${step};`))?.body ?? "";
  assert.match(body("implement"), /requested haiku · actual claude-sonnet-5-5 \(observed\)/);
  assert.match(body("implement"), /requested low · actual unknown \(not observable\)/);
  assert.match(body("code-review"), /requested opus · actual claude-sonnet-5-5 \(observed\)/);
  assert.match(body("code-review"), /requested high · actual unknown \(not observable\)/);
});

test("profile chosen (#217): every agent runs on it; state and report record the choice", () => {
  const s = setup();
  const selection = {
    profile: {
      name: "cc-gw",
      harness: "claudecode" as const,
      disabled: false,
      auth: {
        type: "gateway" as const,
        baseUrl: "https://gw.example.com",
        scheme: "x-api-key" as const,
        keyEnv: "OMI_GW",
      },
      models: ["claude-opus-5-5"],
      efforts: ["high" as const],
    },
    model: "claude-opus-5-5",
    effort: "high" as const,
    reason: "hard review",
    secret: () => "k",
  };
  const ctx = runSlice({ ...s.deps, selection, hostEnv: { PATH: "/bin", OMI_GW: "k" } }, s.target);
  assert.equal(ctx.state, "PR_PENDING");
  for (const l of s.agents.launches) {
    assert.deepEqual(l.args.slice(l.args.indexOf("--model"), l.args.indexOf("--model") + 4), [
      "--model",
      "claude-opus-5-5",
      "--effort",
      "high",
    ]);
    assert.equal(l.env.ANTHROPIC_API_KEY, "k");
  }
  assert.match(
    s.gh.comments[0]?.body ?? "",
    /profile cc-gw \(hard review\) · requested claude-opus-5-5 · actual claude-sonnet-5-5 \(observed\)/,
  );
  assert.match(s.gh.comments[0]?.body ?? "", /requested high · actual unknown \(not observable\)/);
  assert.deepEqual(
    repo.runUsage(s.db, "run").map((r) => r.profile),
    ["cc-gw", "cc-gw"],
  );
  const a = s.db
    .prepare("SELECT profile, requested_model, requested_effort, reason FROM step_attempt LIMIT 1")
    .get();
  assert.deepEqual(
    { ...a },
    {
      profile: "cc-gw",
      requested_model: "claude-opus-5-5",
      requested_effort: "high",
      reason: "hard review",
    },
  );
});
