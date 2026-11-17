// Vertical slice (spec §10–§12): Backend Engineer → deterministic checks → Code Reviewer, with
// the Solution Architect once after two failed review rounds. Every step: task packet → named
// agent process (ADR-0001 D1) → verified result → persisted with its report → report posted
// before the next step. The FSM decides every move; agents only recommend.
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentLaunch, buildAgentLaunch, observeRun } from "../../adapters/claude/launch.ts";
import type { GhRunner } from "../../adapters/github/client.ts";
import { fetchIssueContext } from "../../adapters/github/context.ts";
import type { Db } from "../../persistence/db.ts";
import {
  addArtifact,
  advanceRun,
  beginAttempt,
  enqueueReport,
  failAttempt,
  persistStepResult,
  type RunRow,
  runContext,
  startStep,
  stepResult,
} from "../../persistence/repository.ts";
import { publishPending } from "../../reporting/outbox.ts";
import { renderStepReport } from "../../reporting/render.ts";
import type { OmiConfig } from "../config.ts";
import {
  type CheckRun,
  commentMarker,
  type Finding,
  parseContract,
  type ReportCategory,
  type Role,
  StepComment,
  type StepResult,
  type WorkflowContext,
} from "../contracts.ts";
import { OmiError } from "../errors/errors.ts";
import { acceptStepResult, buildTaskPacket, packetPrompt } from "../handoff/packet.ts";
import { runChecks } from "./checks.ts";
import { policyFrom, type WorkflowEvent } from "./fsm.ts";

export interface SliceDeps {
  db: Db;
  config: OmiConfig;
  gh: GhRunner;
  pluginRoot: string;
  /** Where task packets and check logs of this run are kept. */
  evidenceDir: string;
  /** Runs one agent process and returns its stream-json stdout. */
  runAgent?: (l: AgentLaunch) => string;
  /** Load agents from `pluginRoot` (`--plugin-dir`) instead of the installed plugin. */
  fromSource?: boolean;
  now?: () => Date;
}

export interface SliceTarget {
  run: RunRow;
  worktree: string;
  baseSha: string;
}

interface StepSpec {
  stepId: string;
  role: Role;
  category: ReportCategory;
  title: string;
  edits: boolean;
}

const DEV: StepSpec = {
  stepId: "implement",
  role: "backend-engineer",
  category: "implementation",
  title: "Implementation",
  edits: true,
};
const REVIEW: StepSpec = {
  stepId: "code-review",
  role: "code-reviewer",
  category: "review",
  title: "Code Review",
  edits: false,
};
const ARCHITECT: StepSpec = {
  stepId: "architect",
  role: "solution-architect",
  category: "architecture",
  title: "Architect Diagnosis",
  edits: false,
};
const WORKFLOW = "Feature Implementation";
const AGENT_TIMEOUT_MS = 30 * 60_000;

export const spawnAgent = (l: AgentLaunch): string => {
  const r = spawnSync(l.command, l.args, {
    cwd: l.cwd,
    input: l.stdin,
    encoding: "utf8",
    timeout: AGENT_TIMEOUT_MS,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new OmiError("INTERNAL", "claude CLI not found on PATH");
  }
  return r.stdout ?? ""; // a cut or failed run has no result event: observeRun reports it
};

/** Read-only git for everyone; implementers may also commit and run the repo's own checks. */
function tools(config: OmiConfig, spec: StepSpec): string[] {
  const read = ["Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)"];
  if (!spec.edits) return read;
  const checks = Object.values(config.checks).flatMap((c) => (c ? [`Bash(${c.run})`] : []));
  return [...read, "Bash(git add*)", "Bash(git commit*)", ...checks];
}

const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * One agent step of the current round. Technical failures close the attempt and go through the
 * FSM (retry or BLOCKED); a step already reported (resume after a crash) is replayed, not re-run.
 * Returns null when the run left the step (BLOCKED).
 */
function agentStep(
  d: SliceDeps,
  t: SliceTarget,
  spec: StepSpec,
  ctx: WorkflowContext,
  openFindings: Finding[],
  checkResults?: CheckRun[],
): StepResult | null {
  const { db, config } = d;
  const issue = { repository: t.run.repository, number: t.run.issue };
  const step = startStep(db, {
    runId: t.run.id,
    stepId: spec.stepId,
    round: ctx.round,
    role: spec.role,
  });
  if (step.state === "REPORT_POSTED") return stepResult(db, step.id);
  for (;;) {
    const attempt = beginAttempt(db, step.id);
    let report: { result: StepResult; actualModel: string; marker: string; body: string };
    try {
      const packet = buildTaskPacket({
        workflowRunId: t.run.id,
        issue,
        stepId: spec.stepId,
        role: spec.role,
        round: ctx.round,
        attempt,
        scope: [],
        worktree: t.worktree,
        baseSha: t.baseSha,
        ...fetchIssueContext(config, t.run.issue, d.gh),
        openFindings,
        readOnlyArtifacts: [],
        checkResults,
      });
      const file = join(d.evidenceDir, `${spec.stepId}-r${ctx.round}-a${attempt}.packet.json`);
      writeFileSync(file, JSON.stringify(packet, null, 2));
      addArtifact(db, { runId: t.run.id, stepRunId: step.id, kind: "task-packet", path: file });
      const stdout = (d.runAgent ?? spawnAgent)(
        buildAgentLaunch({
          pluginRoot: d.pluginRoot,
          role: spec.role,
          worktree: t.worktree,
          prompt: packetPrompt(packet),
          fromSource: d.fromSource,
          allowedTools: tools(config, spec),
          acceptEdits: spec.edits,
        }),
      );
      const obs = observeRun(stdout);
      if (obs.isError) throw new OmiError("INTERNAL", `${spec.role} run ended in an error`);
      // Token usage is what the host observed, never what the agent claims.
      const { usage: _claimed, ...claimed } = acceptStepResult(packet, obs.result);
      const result: StepResult = obs.usage ? { ...claimed, usage: obs.usage } : claimed;
      const route = config.agents.routing[spec.role];
      const comment = parseContract(
        StepComment,
        {
          schemaVersion: 1,
          issue,
          workflowRunId: t.run.id,
          category: spec.category,
          workflow: WORKFLOW,
          stepId: spec.stepId,
          stepTitle: spec.title,
          round: ctx.round,
          attempt,
          executor: spec.role,
          requestedModel: route.model,
          actualModel: obs.actualModel,
          requestedEffort: route.effort,
          actualEffort: "unknown",
          commitSha: result.commitSha,
          status: result.status,
          summary: result.summary,
          changedFiles: result.changedFiles,
          evidencePaths: result.evidencePaths,
          findings: result.findings,
          nextAction: result.nextAction ?? "The OMI runtime decides the next step.",
          executionId: `${t.run.id}.${spec.stepId}.r${ctx.round}.a${attempt}`,
          createdAt: (d.now?.() ?? new Date()).toISOString(),
        },
        "step comment",
      );
      report = {
        result,
        actualModel: obs.actualModel,
        marker: commentMarker(comment),
        body: renderStepReport(comment),
      };
    } catch (e) {
      const err = e instanceof OmiError ? e : new OmiError("INTERNAL", (e as Error).message);
      failAttempt(db, { stepRunId: step.id, attempt, errorCode: err.code });
      const next = advanceRun(
        db,
        t.run.id,
        { type: "TECHNICAL_FAILURE", errorCode: err.code },
        policyFrom(config),
      );
      if (next.context.state !== ctx.state) return null; // BLOCKED: attempts spent or not transient
      continue;
    }
    persistStepResult(db, {
      stepRunId: step.id,
      attempt,
      result: report.result,
      actualModel: report.actualModel,
      report: { marker: report.marker, body: report.body },
    });
    publishPending(db, t.run.id, { gh: d.gh }); // a failure leaves it pending: the FSM holds
    return report.result;
  }
}

/** Deterministic checks as an omi-cli step with its own report; failures become findings. */
function checksStep(
  d: SliceDeps,
  t: SliceTarget,
  ctx: WorkflowContext,
): { findings: Finding[]; results: CheckRun[] } {
  const n = ctx.validationFixes + 1;
  const { passed, results } = runChecks({
    worktree: t.worktree,
    checks: d.config.checks,
    logDir: join(d.evidenceDir, `checks-r${ctx.round}-${n}`),
  });
  for (const r of results) {
    if (r.logPath) addArtifact(d.db, { runId: t.run.id, kind: "log", path: r.logPath });
  }
  const findings: Finding[] = results
    .filter((r) => r.outcome !== "pass" && r.outcome !== "skipped")
    .map((r, i) => ({
      id: `CHK-${String(i + 1).padStart(3, "0")}`,
      severity: "high",
      observed: cut(
        `${r.name}: ${r.outcome}${r.exitCode === null ? "" : ` (exit ${r.exitCode})`}\n${r.summary}`,
        1000,
      ),
      expected: `\`${r.name}\` passes`,
    }));
  const comment = parseContract(
    StepComment,
    {
      schemaVersion: 1,
      issue: { repository: t.run.repository, number: t.run.issue },
      workflowRunId: t.run.id,
      category: "checks",
      workflow: WORKFLOW,
      stepId: "checks",
      stepTitle: "Deterministic Checks",
      round: ctx.round,
      attempt: n,
      executor: "omi-cli",
      requestedModel: null,
      actualModel: null,
      requestedEffort: null,
      actualEffort: null,
      status: passed ? "PASSED" : "FAILED",
      summary: results.map((r) => `${r.name}: ${r.outcome}`).join(", "),
      findings,
      nextAction: passed ? "Code review." : "The engineer fixes the failed checks.",
      executionId: `${t.run.id}.checks.r${ctx.round}.${n}`,
      createdAt: (d.now?.() ?? new Date()).toISOString(),
    },
    "checks comment",
  );
  enqueueReport(d.db, {
    runId: t.run.id,
    marker: commentMarker(comment),
    body: renderStepReport(comment),
  });
  publishPending(d.db, t.run.id, { gh: d.gh });
  // Reviewers read-only: they get what already ran instead of re-running it (gate M3 G3-002).
  return { findings, results: results.map(({ durationMs: _, ...r }) => r) };
}

/**
 * Drives the run from WORKSPACE_READY (or wherever a previous invocation stopped) until it
 * needs someone else: IN_QA, WAITING_PO or BLOCKED. Returns the final FSM context.
 */
export function runSlice(d: SliceDeps, t: SliceTarget): WorkflowContext {
  const policy = policyFrom(d.config);
  mkdirSync(d.evidenceDir, { recursive: true });
  publishPending(d.db, t.run.id, { gh: d.gh }); // finish what a crashed invocation persisted
  let ctx = runContext(d.db, t.run.id);
  const advance = (e: WorkflowEvent) => {
    ctx = advanceRun(d.db, t.run.id, e, policy).context;
  };
  const refresh = () => runContext(d.db, t.run.id);
  let findings: Finding[] = [];
  let checks: CheckRun[] | undefined; // last checks of this run, for review and architect
  let needDev = true;
  if (ctx.state === "WORKSPACE_READY") advance({ type: "DEV_STARTED" });
  for (;;) {
    switch (ctx.state) {
      case "REWORK":
        advance({ type: "DEV_STARTED" });
        needDev = true;
        break;
      case "RUNNING": {
        if (needDev) {
          const spec = ctx.validationFixes
            ? { ...DEV, stepId: `implement-fix${ctx.validationFixes}` }
            : DEV;
          const dev = agentStep(d, t, spec, ctx, findings);
          if (!dev) return refresh();
          if (dev.status !== "PASSED") {
            advance({ type: "BLOCK" }); // engineer could not finish: a person decides
            return ctx;
          }
        }
        const gate = checksStep(d, t, ctx);
        checks = gate.results;
        if (gate.findings.length) {
          advance({ type: "CHECKS_FAILED" });
          findings = gate.findings;
          needDev = true;
          break;
        }
        const review = agentStep(d, t, REVIEW, ctx, findings, checks);
        if (!review) return refresh();
        if (review.status !== "PASSED" && review.status !== "FAILED") {
          advance({ type: "BLOCK" });
          return ctx;
        }
        findings = review.findings;
        advance({ type: review.status === "PASSED" ? "REVIEW_PASSED" : "REVIEW_FAILED" });
        needDev = false;
        break;
      }
      case "ARCHITECT_ESCALATION": {
        const plan = agentStep(d, t, ARCHITECT, ctx, findings, checks);
        if (!plan) return refresh();
        if (plan.status === "PASSED") {
          findings = plan.findings; // the correction plan is what round 3 addresses
          advance({ type: "ARCHITECT_PLAN_ACCEPTED" });
        } else {
          advance({ type: "ARCHITECT_SCOPE_CHANGE" });
        }
        break;
      }
      default:
        return ctx;
    }
  }
}
