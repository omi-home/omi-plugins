// Regression tests for Bug-0013 #392: open findings were lost when a run resumed after BLOCKED
// (`omi task unblock` + `omi task run` = a new process, so nothing in memory). Observed only through
// the packets the agents receive, with modules that already existed before the fix.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { claudeCode } from "../../../runtime/harness/adapters/claude-code/harness.ts";
import type { AgentLaunch } from "../../../runtime/harness/domain/harness.ts";
import { stepReports } from "../../../runtime/reporting/adapters/step-reports.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import type { TaskPacket } from "../../../runtime/shared/contracts.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import * as repo from "../../../runtime/task-run/adapters/repository.ts";
import { runSlice } from "../../../runtime/task-run/application/slice.ts";
import { taskRunPorts } from "../../../runtime/task-run/cli/ports.ts";
import type { DeliveryPlan } from "../../../runtime/task-run/domain/plan.ts";

const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

function worktree() {
  const dir = mkdtempSync(join(tmpdir(), "omi-tc392-"));
  git(dir, "init", "-q", "-b", "develop");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  writeFileSync(join(dir, "README.md"), "x\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

function fakeGitHub(): GhRunner {
  const comments: { id: number; body: string; html_url: string; author_association: string }[] = [];
  return (args, input) => {
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
}

interface Script {
  /** Code Reviewer verdict by round. */
  review: (round: number) => "PASSED" | "FAILED" | "BLOCKED";
  /** Security Reviewer verdicts, one per run of it (then PASSED). */
  security?: ("PASSED" | "FAILED")[];
  /** While true the Architect answers with garbage, so its step is BLOCKED. */
  architectGarbage?: () => boolean;
}

const finding = (id: string) => ({
  id,
  severity: "high",
  observed: `${id} observed`,
  expected: `${id} expected`,
});

function setup(script: Script, plan: DeliveryPlan) {
  const packets: TaskPacket[] = [];
  const runAgent = (l: AgentLaunch): string => {
    const packet: TaskPacket = JSON.parse(l.stdin.split("\n\n")[1] as string);
    const role = packet.role;
    const base = {
      schemaVersion: 1,
      workflowRunId: packet.workflowRunId,
      issue: packet.issue,
      stepId: packet.stepId,
      round: packet.round,
      attempt: packet.attempt,
      role,
    };
    const wrap = (result: unknown) =>
      JSON.stringify({
        type: "result",
        is_error: false,
        result: typeof result === "string" ? result : JSON.stringify(result),
        usage: {},
      });
    if (role === "solution-architect" && script.architectGarbage?.()) return wrap("no json");
    packets.push(packet);
    let result: Record<string, unknown>;
    if (role.endsWith("-engineer")) {
      mkdirSync(join(packet.worktree, "src"), { recursive: true });
      const file = `src/${packet.stepId}-r${packet.round}.txt`;
      writeFileSync(join(packet.worktree, file), "work\n");
      result = { ...base, status: "PASSED", summary: "implemented", changedFiles: [file] };
    } else if (role === "code-reviewer") {
      const v = script.review(packet.round);
      result = {
        ...base,
        status: v,
        summary: "review",
        findings: v === "FAILED" ? [finding("CR-001")] : [],
        ...(v === "BLOCKED" ? { blockerReason: "cannot review" } : {}),
      };
    } else if (role === "security-reviewer") {
      const v = script.security?.shift() ?? "PASSED";
      result = {
        ...base,
        status: v,
        summary: "security",
        findings: v === "FAILED" ? [finding("SEC-001")] : [],
      };
    } else {
      result = {
        ...base,
        status: "PASSED",
        summary: "diagnosis",
        findings: [finding("ARC-001")],
      };
    }
    return wrap(result);
  };
  const { dir, base } = worktree();
  const db = openState(":memory:");
  const run = repo.createRun(db, {
    id: "run",
    issue: { repository: "o/r", number: 9 },
    workflow: "dev-task",
  });
  repo.advanceRun(db, "run", { type: "TICKET_VALID" });
  repo.advanceRun(db, "run", { type: "WORKSPACE_CREATED" });
  const deps = {
    db,
    config: parseConfig({ github: { owner: "o", repo: "r", projectNumber: 1 } }),
    gh: fakeGitHub(),
    pluginRoot: fileURLToPath(new URL("../../../", import.meta.url)),
    evidenceDir: mkdtempSync(join(tmpdir(), "omi-evidence-")),
    ports: { ...taskRunPorts, reports: stepReports },
    harness: claudeCode,
    runAgent,
  };
  const target = {
    run,
    worktree: dir,
    taskRoot: mkdtempSync(join(tmpdir(), "omi-task-")),
    baseSha: base,
    plan: plan as DeliveryPlan,
  };
  return { db, deps, target, packets };
}

const delivery = (p: Partial<DeliveryPlan> = {}): DeliveryPlan => ({
  kind: "delivery",
  workflow: "Feature Implementation",
  engineer: "software-engineer",
  security: false,
  regressionTest: false,
  manualQa: false,
  ...p,
});

const ids = (p: TaskPacket | undefined) => p?.openFindings.map((f) => f.id);

/** Two FAILED reviews → Architect escalation whose answer is refused → BLOCKED → unblock → run. */
function resumeAfterBlockedArchitect() {
  let unblocked = false;
  const s = setup(
    { review: (round) => (round <= 2 ? "FAILED" : "PASSED"), architectGarbage: () => !unblocked },
    delivery(),
  );
  assert.equal(runSlice(s.deps, s.target).state, "BLOCKED");
  unblocked = true;
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  // A new `task run` process: nothing in memory.
  const state = runSlice(s.deps, s.target).state;
  return { s, state };
}

test("TC-392-01: review finding survives BLOCKED and unblock: the resumed Architect packet carries it", () => {
  const { s } = resumeAfterBlockedArchitect();
  const architect = s.packets.filter((p) => p.role === "solution-architect");
  assert.deepEqual(ids(architect.at(-1)), ["CR-001"]);
});

test("TC-392-02: after resume the next engineer round gets the Architect plan plus the unclosed review finding", () => {
  const { s, state } = resumeAfterBlockedArchitect();
  const dev3 = s.packets.find((p) => p.role === "software-engineer" && p.round === 3);
  assert.deepEqual(ids(dev3), ["ARC-001", "CR-001"]);
  assert.equal(state, "PR_PENDING");
});

test("TC-392-03: a reviewer that FAILED runs again after resume even when no label selects it any more", () => {
  let unblocked = false;
  const s = setup(
    { security: ["FAILED"], review: (round) => (round === 2 && !unblocked ? "BLOCKED" : "PASSED") },
    delivery({ security: true }),
  );
  assert.equal(runSlice(s.deps, s.target).state, "BLOCKED");
  const before = s.packets.length;
  unblocked = true;
  repo.advanceRun(s.db, "run", { type: "UNBLOCK" });
  const noLabel = { ...s.target, plan: delivery({ security: false }) };
  assert.equal(runSlice(s.deps, noLabel).state, "PR_PENDING");
  const after = s.packets.slice(before);
  assert.ok(
    after.some((p) => p.role === "security-reviewer"),
    after.map((p) => `${p.role}:${p.round}`).join(),
  );
});
