// Delivery workflow (spec §10–§12): the planned engineer → deterministic checks → Code Reviewer
// (→ Security Reviewer when required), with the Solution Architect once after two failed review
// rounds, then QA: release validation (→ Manual QA when planned) up to PR_PENDING; and the
// analysis workflow (analysts write Issue sections, the PO decides). Every step: task packet → named
// agent process (ADR-0001 D1) → verified result → persisted with its report → report posted
// before the next step. The FSM decides every move; agents only recommend.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
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
import { redactDeep } from "../../reporting/redact.ts";
import { renderStepReport } from "../../reporting/render.ts";
import { git } from "../../resources/worktree.ts";
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
import type { AnalysisPlan, DeliveryPlan, WorkflowPlan } from "./plan.ts";

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
  /** Writes a `<!-- omi:section=… -->` of the Issue body (the Manual QA test cases). */
  writeSection?: (section: string, markdown: string) => void;
}

/** Suffix of the file that keeps why an agent attempt failed technically (G6-002, #121). */
export const ERROR_SUFFIX = ".error.json";

/** The newest technical failure recorded in `evidenceDir`, for the CLI to show on BLOCKED. */
export function lastStepError(
  evidenceDir: string,
): { code: string; message: string; file: string } | undefined {
  if (!existsSync(evidenceDir)) return undefined;
  const file = readdirSync(evidenceDir)
    .filter((f) => f.endsWith(ERROR_SUFFIX))
    .map((f) => join(evidenceDir, f))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!file) return undefined;
  const { code, message } = JSON.parse(readFileSync(file, "utf8")) as {
    code: string;
    message: string;
  };
  return { code, message, file };
}

export interface SliceTarget {
  run: RunRow;
  worktree: string;
  baseSha: string;
  /** Defaults to the original slice: Backend Engineer, Feature Implementation. */
  plan?: WorkflowPlan;
}

interface StepSpec {
  stepId: string;
  role: Role;
  category: ReportCategory;
  title: string;
  edits: boolean;
}

const DEV_BASE: StepSpec = {
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
const SECURITY: StepSpec = {
  stepId: "security-review",
  role: "security-reviewer",
  category: "review",
  title: "Security Review",
  edits: false,
};
const QA: StepSpec = {
  stepId: "qa",
  role: "manual-qa-engineer",
  category: "qa",
  title: "Acceptance QA",
  edits: false,
};
const DEFAULT_PLAN: DeliveryPlan = {
  kind: "delivery",
  workflow: "Feature Implementation",
  engineer: "backend-engineer",
  security: false,
  regressionTest: false,
  manualQa: false,
};
/** A QA rework re-runs a round's steps without a new round number: give them new step ids. */
const qaSuffix = (ctx: WorkflowContext) => (ctx.qaReworks ? `-qa${ctx.qaReworks}` : "");
const workflowOf = (t: SliceTarget) => t.plan?.workflow ?? DEFAULT_PLAN.workflow;
/** A test file by the usual conventions (`test/`, `tests/`, `*.test.*`, `*_test.*`, `*.spec.*`). */
export const isTest = (f: string) =>
  /(^|[\\/])(tests?|__tests__)[\\/]|[._-](test|spec)\.[^\\/]+$/i.test(f);
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
  planned: StepSpec,
  ctx: WorkflowContext,
  openFindings: Finding[],
  checkResults?: CheckRun[],
): StepResult | null {
  const { db, config } = d;
  const issue = { repository: t.run.repository, number: t.run.issue };
  const spec = { ...planned, stepId: planned.stepId + qaSuffix(ctx) };
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
      const started = Date.now();
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
      const durationMs = Date.now() - started;
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
          workflow: workflowOf(t),
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
          usage: result.usage,
          durationMs,
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
      // The reason survives the attempt (G6-002, #121): the DB keeps only the code.
      mkdirSync(d.evidenceDir, { recursive: true });
      const file = join(d.evidenceDir, `${spec.stepId}-r${ctx.round}-a${attempt}${ERROR_SUFFIX}`);
      const failure = { code: err.code, message: err.message, details: err.details ?? null };
      writeFileSync(file, JSON.stringify(redactDeep(failure), null, 2));
      addArtifact(db, { runId: t.run.id, stepRunId: step.id, kind: "log", path: file });
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
  /** Gate findings decided by the runtime itself (e.g. a missing regression test). */
  extra: Finding[] = [],
  base = { stepId: "checks", title: "Deterministic Checks", next: "Code review." },
): { findings: Finding[]; results: CheckRun[] } {
  const n = ctx.validationFixes + 1;
  const stepId = base.stepId + qaSuffix(ctx);
  const { passed, results } = runChecks({
    worktree: t.worktree,
    checks: d.config.checks,
    logDir: join(d.evidenceDir, `${stepId}-r${ctx.round}-${n}`),
  });
  for (const r of results) {
    if (r.logPath) addArtifact(d.db, { runId: t.run.id, kind: "log", path: r.logPath });
  }
  const findings: Finding[] = results
    .filter((r) => r.outcome !== "pass" && r.outcome !== "skipped")
    .map(
      (r, i): Finding => ({
        id: `CHK-${String(i + 1).padStart(3, "0")}`,
        severity: "high",
        observed: cut(
          `${r.name}: ${r.outcome}${r.exitCode === null ? "" : ` (exit ${r.exitCode})`}\n${r.summary}`,
          1000,
        ),
        expected: `\`${r.name}\` passes`,
      }),
    )
    .concat(extra);
  const ok = passed && !findings.length;
  const comment = parseContract(
    StepComment,
    {
      schemaVersion: 1,
      issue: { repository: t.run.repository, number: t.run.issue },
      workflowRunId: t.run.id,
      category: "checks",
      workflow: workflowOf(t),
      stepId,
      stepTitle: base.title,
      round: ctx.round,
      attempt: n,
      executor: "omi-cli",
      requestedModel: null,
      actualModel: null,
      requestedEffort: null,
      actualEffort: null,
      status: ok ? "PASSED" : "FAILED",
      summary: results.map((r) => `${r.name}: ${r.outcome}`).join(", "),
      findings,
      durationMs: results.reduce((sum, r) => sum + r.durationMs, 0),
      nextAction: ok ? base.next : "The engineer fixes the failed checks.",
      executionId: `${t.run.id}.${stepId}.r${ctx.round}.${n}`,
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
 * Release validation (PO 2026-11-18, #56), an omi-cli step: the branch is ready for a PR when
 * the worktree is clean, it has commits over the base, and the checks passed on this very HEAD.
 * Checks re-run only when HEAD differs from the one they passed on (or after a resume).
 */
function releaseStep(
  d: SliceDeps,
  t: SliceTarget,
  ctx: WorkflowContext,
  checkedHead: string | null,
): { findings: Finding[]; checks?: CheckRun[] } {
  const started = Date.now();
  const head = git(["rev-parse", "HEAD"], t.worktree);
  const findings: Finding[] = [];
  if (git(["status", "--porcelain", "--untracked-files=all"], t.worktree)) {
    findings.push({
      id: "REL-001",
      severity: "high",
      observed: "The task worktree has uncommitted changes.",
      expected: "Every change of the task is committed on its branch.",
    });
  }
  const commits = Number(git(["rev-list", "--count", `${t.baseSha}..HEAD`], t.worktree));
  if (!commits) {
    findings.push({
      id: "REL-002",
      severity: "high",
      observed: "The task branch has no commit over its base.",
      expected: "The change is committed on the task branch.",
    });
  }
  const recheck = head !== checkedHead;
  let checks: CheckRun[] | undefined;
  if (recheck) {
    const gate = checksStep(d, t, ctx, [], {
      stepId: "release-checks",
      title: "Release Checks",
      next: "Release validation.",
    });
    findings.push(...gate.findings);
    checks = gate.results; // e.g. after a resume, Manual QA still gets this HEAD's checks (#121)
  }
  const stepId = `release-validation${qaSuffix(ctx)}`;
  const comment = parseContract(
    StepComment,
    {
      schemaVersion: 1,
      issue: { repository: t.run.repository, number: t.run.issue },
      workflowRunId: t.run.id,
      category: "qa",
      workflow: workflowOf(t),
      stepId,
      stepTitle: "Release Validation",
      round: ctx.round,
      attempt: 1,
      executor: "omi-cli",
      requestedModel: null,
      actualModel: null,
      requestedEffort: null,
      actualEffort: null,
      commitSha: head,
      status: findings.length ? "FAILED" : "PASSED",
      summary: `${commits} commit(s) over base · checks ${recheck ? "re-run" : "passed"} on ${head.slice(0, 8)}`,
      findings,
      durationMs: Date.now() - started,
      nextAction: findings.length ? "The engineer fixes the release findings." : "QA verdict.",
      executionId: `${t.run.id}.${stepId}.r${ctx.round}`,
      createdAt: (d.now?.() ?? new Date()).toISOString(),
    },
    "release validation comment",
  );
  enqueueReport(d.db, {
    runId: t.run.id,
    marker: commentMarker(comment),
    body: renderStepReport(comment),
  });
  publishPending(d.db, t.run.id, { gh: d.gh });
  return { findings, checks };
}

/**
 * Drives the run from WORKSPACE_READY (or wherever a previous invocation stopped) until it
 * needs someone else: PR_PENDING, WAITING_PO or BLOCKED. Returns the final FSM context.
 */
export function runSlice(d: SliceDeps, t: SliceTarget): WorkflowContext {
  const plan = t.plan?.kind === "delivery" ? t.plan : DEFAULT_PLAN;
  const DEV: StepSpec = { ...DEV_BASE, role: plan.engineer };
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
  let checkedHead: string | null = null; // HEAD the last passing checks ran on
  let needDev = true;
  if (ctx.state === "WORKSPACE_READY") advance({ type: "DEV_STARTED" });
  for (;;) {
    switch (ctx.state) {
      case "REWORK":
        advance({ type: "DEV_STARTED" });
        needDev = true;
        break;
      case "RUNNING": {
        let devFiles: string[] | null = null;
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
          devFiles = dev.changedFiles;
        }
        // Bug Resolution: reproduction + regression (spec §10 catalogue) is a deterministic gate.
        const regression: Finding[] =
          plan.regressionTest && devFiles && !devFiles.some(isTest)
            ? [
                {
                  id: "REG-001", // finding ids are PREFIX-NNN
                  severity: "high",
                  observed: "The bug fix changes no test file.",
                  expected: "Add a regression test that fails without the fix and passes with it.",
                },
              ]
            : [];
        const gate = checksStep(d, t, ctx, regression);
        checks = gate.results;
        checkedHead = gate.findings.length ? null : git(["rev-parse", "HEAD"], t.worktree);
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
        let verdict = review;
        // Security gate (PO 2026-11-18): label risk:high/security, or the reviewer routes it.
        if (
          review.status === "PASSED" &&
          (plan.security || /^security-review:/.test(review.nextAction ?? ""))
        ) {
          const sec = agentStep(d, t, SECURITY, ctx, findings, checks);
          if (!sec) return refresh();
          if (sec.status === "BLOCKED") {
            // A critical finding escalates to the PO at once; any other block stops for a person.
            const critical = sec.findings.some((f) => f.severity === "critical");
            advance({ type: critical ? "ESCALATE_TO_PO" : "BLOCK" });
            return ctx;
          }
          verdict = sec;
        }
        findings = verdict.findings;
        advance({ type: verdict.status === "PASSED" ? "REVIEW_PASSED" : "REVIEW_FAILED" });
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
      case "IN_QA": {
        const release = releaseStep(d, t, ctx, checkedHead);
        checks = release.checks ?? checks;
        if (release.findings.length) {
          findings = release.findings;
          advance({ type: "QA_FAILED" });
          break;
        }
        if (plan.manualQa) {
          const qa = agentStep(d, t, QA, ctx, findings, checks);
          if (!qa) return refresh();
          for (const u of qa.sectionUpdates) d.writeSection?.(u.section, u.markdown);
          if (qa.status !== "PASSED" && qa.status !== "FAILED") {
            advance({ type: "BLOCK" });
            return ctx;
          }
          if (qa.status === "FAILED") {
            findings = qa.findings;
            advance({ type: "QA_FAILED" });
            break;
          }
        }
        advance({ type: "QA_PASSED" });
        break;
      }
      default:
        return ctx;
    }
  }
}

const ANALYST_STEP: Partial<Record<Role, Omit<StepSpec, "role" | "edits">>> = {
  "business-analyst": { stepId: "analysis", category: "analysis", title: "Requirement Analysis" },
  "ui-ux-designer": { stepId: "design", category: "design", title: "UX Design" },
  // Not "architect": that step id is the review-escalation diagnosis.
  "solution-architect": {
    stepId: "architecture",
    category: "architecture",
    title: "Technical Design",
  },
};

/**
 * Analysis workflow for an Issue without a worktree (PO 2026-11-18): each analyst in turn reads
 * the Issue chain (with the sections written so far) and proposes its own section; the CLI writes
 * it into the Issue body before the next analyst runs. Ends COMPLETED (handed to the PO) or
 * WAITING_PO / BLOCKED when an analyst could not finish. `t.worktree` is the main checkout.
 */
export function runAnalysis(
  d: SliceDeps & Required<Pick<SliceDeps, "writeSection">>,
  t: SliceTarget & { plan: AnalysisPlan },
): WorkflowContext {
  mkdirSync(d.evidenceDir, { recursive: true });
  publishPending(d.db, t.run.id, { gh: d.gh });
  let ctx = runContext(d.db, t.run.id);
  for (const role of t.plan.analysts) {
    if (ctx.state !== "TICKET_VALIDATED") return ctx;
    const spec = {
      ...(ANALYST_STEP[role] as Omit<StepSpec, "role" | "edits">),
      role,
      edits: false,
    };
    const r = agentStep(d, t, spec, { ...ctx, round: 1 }, []);
    if (!r) return runContext(d.db, t.run.id);
    if (r.status !== "PASSED") {
      // An open question (BLOCKED) or a failed analysis: the PO decides before anyone continues.
      return advanceRun(d.db, t.run.id, { type: "ESCALATE_TO_PO" }).context;
    }
    for (const u of r.sectionUpdates) d.writeSection(u.section, u.markdown);
    ctx = runContext(d.db, t.run.id);
  }
  return advanceRun(d.db, t.run.id, { type: "ANALYSIS_COMPLETED" }).context;
}
