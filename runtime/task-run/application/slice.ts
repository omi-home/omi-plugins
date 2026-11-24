// Delivery workflow (spec §10–§12): the planned engineer → deterministic checks → Code Reviewer
// (→ Security Reviewer when required), with the Solution Architect once after two failed review
// rounds, then QA: release validation (→ QA Engineer when planned) up to PR_PENDING; and the
// analysis workflow (analysts write Issue sections, the PO decides). Every step: task packet → named
// agent process (ADR-0001 D1) → verified result → persisted with its report → report posted
// before the next step. The FSM decides every move; agents only recommend.
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { z } from "zod";
import { archShow } from "../../architecture/application/arch.ts";
import type { ArchitectureExcerpt } from "../../architecture/domain/contract.ts";
import {
  acceptStepResultWithWarnings,
  buildTaskPacket,
  packetPrompt,
  repairPrompt,
  resumePrompt,
} from "../../handoff/application/packet.ts";
import type {
  AgentLaunch,
  AgentObservation,
  Harness,
  LaunchRequest,
} from "../../harness/domain/harness.ts";
import type { Selection } from "../../profile/domain/selection.ts";
import type { OmiConfig } from "../../shared/config.ts";
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
} from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import type { GhRunner } from "../../shared/github/client.ts";
import { api, markerAuthor, RestComment } from "../../shared/github/client.ts";
import { redact, redactDeep } from "../../shared/redact.ts";
import type { Db } from "../../shared/sqlite/db.ts";
import { cutAt } from "../../shared/text.ts";
import {
  afterReview,
  carryOpen,
  type ReviewVerdict,
  type RunFindings,
  unconfirmed,
} from "../domain/findings.ts";
import { policyFrom, type WorkflowEvent } from "../domain/fsm.ts";
import { EDITOR_NPM_SCRIPTS } from "../domain/permissions.ts";
import type { AnalysisPlan, DeliveryPlan, QaPlan, WorkflowPlan } from "../domain/plan.ts";
import {
  jsonOf,
  missingAutoTests,
  nextRun,
  parseTestDesign,
  parseTestTable,
  parseVerify,
  proposeBugs,
  reconcile,
  renderRun,
  renderTestDesign,
  renderTestTable,
  verifyPassed,
} from "../domain/qa.ts";
import {
  fillCommand,
  type ProofReport,
  preFixMarker,
  proofFindings,
  renderProof,
  tcFiles,
  unsafePaths,
} from "../domain/regression.ts";
import type { RunRow, SkillChoice } from "../domain/run.ts";
import { sumUsage } from "../domain/usage.ts";
import type { RoleFilesPort, SlicePorts } from "./ports.ts";
import { resumeNotLoaded } from "./session.ts";

export interface SliceDeps {
  db: Db;
  config: OmiConfig;
  gh: GhRunner;
  pluginRoot: string;
  /** Where task packets and check logs of this run are kept. */
  evidenceDir: string;
  /** Everything the workflow needs from adapters, handed in by the composition root. */
  ports: SlicePorts;
  /** The harness that runs the agents (chosen by `Profile.harness`); only the port is seen here. */
  harness: Harness;
  /** Runs one agent process and returns its output stream (default: `harness.run`). */
  runAgent?: (l: AgentLaunch) => string;
  /** Host env the agent env is filtered from (default `process.env`). */
  hostEnv?: NodeJS.ProcessEnv;
  /** Env of the check commands, without the master key and auth variables (ARC-001). */
  commandEnv?: NodeJS.ProcessEnv;
  /** Profile/model/effort the Coordinator chose for every agent step (#217); none = routing. */
  selection?: Selection;
  /** Skills the Coordinator chose per role (#199); every step also gets its role's defaults. */
  skills?: SkillChoice;
  now?: () => Date;
  /** Writes a `<!-- omi:section=… -->` of the Issue body (the QA Engineer test cases). */
  writeSection?: (section: string, markdown: string) => void;
  /** Closes the QATask Issue once its read-only run PASSED (DevTask-0134 #385). */
  closeIssue?: () => void;
}

/**
 * Roles that keep one session per run and resume it when they run again (#407). Reviewers, the
 * Architect and the analysts always start fresh: an independent view.
 */
const SESSION_ROLES: readonly Role[] = ["software-engineer", "qa-engineer"];

/** Suffix of the file that keeps why an agent attempt failed technically (G6-002, #121). */
export const ERROR_SUFFIX = ".error.json";
/** Suffix of the redacted raw agent output kept when its result is refused (Bug #268). */
export const OUTPUT_SUFFIX = ".output.txt";
const MAX_RAW_OUTPUT_CHARS = 64 * 1024;

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
  /** Task workspace (ADR-0002 D2): the agent's cwd; role files are written there. */
  taskRoot: string;
  /** Defaults to the original slice: Software Engineer, Feature Implementation. */
  plan?: WorkflowPlan;
  /** Number of the Issue's parent in this repository (QATask: the Story or Bug under test). */
  parent?: number;
}

interface StepSpec {
  stepId: string;
  role: Role;
  category: ReportCategory;
  title: string;
  edits: boolean;
  /** May run the repo's configured check commands without editing (QA Engineer, PO #124). */
  runsChecks?: boolean;
  /** What the runtime tells the agent about this step (e.g. the QATask mode and result format). */
  notes?: string[];
}

const DEV_BASE: StepSpec = {
  stepId: "implement",
  role: "software-engineer",
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
  role: "qa-engineer",
  category: "qa",
  title: "Acceptance QA",
  edits: false,
  runsChecks: true,
};
const DEFAULT_PLAN: DeliveryPlan = {
  kind: "delivery",
  workflow: "Feature Implementation",
  engineer: "software-engineer",
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

/**
 * The architecture contract's part for the packet (like `omi arch show --scope`). A repo without a
 * contract, or with an invalid one, gets no field: an invalid contract must stay fixable by the
 * engineer, and the architecture gate check reports it.
 */
export function architectureExcerpt(
  worktree: string,
  config: OmiConfig,
  scope: string[],
): ArchitectureExcerpt | undefined {
  try {
    return archShow({
      cwd: worktree,
      contract: config.architecture?.contract,
      scope,
    });
  } catch (e) {
    if (e instanceof OmiError && e.code === "CONTRACT_INVALID") return undefined;
    throw e;
  }
}

/**
 * Writes the role files of the task workspace, then the launch of its agent (ADR-0002 D2/D4).
 * The shell starts in the task workspace, but after a `cd <repo> && <check>` Claude Code keeps it in the
 * repo. So two forms are granted, each as its own command: from the workspace `git -C <repo> …` and
 * `cd <repo> && <check>`; from inside the repo bare `git status|diff|log|show` and bare `<check>`
 * (all with or without arguments). A `cd` before git is refused by Claude Code.
 * Read-only git for everyone (the runtime commits); implementers may also run the repo's checks.
 */
export function prepareAgent(o: {
  /** The harness that will run the agent, and the adapter that writes the role files. */
  harness: Pick<Harness, "launch">;
  roleFiles: Pick<RoleFilesPort, "writeRoleFiles">;
  pluginRoot: string;
  role: Role;
  category: ReportCategory;
  /** Implementing roles may edit files in the clone. */
  edits: boolean;
  /** May run the check commands without editing (QA Engineer, PO #124). */
  runsChecks?: boolean;
  /** The repo's configured check commands. */
  checks: string[];
  taskRoot: string;
  worktree: string;
  prompt: string;
  hostEnv?: NodeJS.ProcessEnv;
  selection?: Selection;
  /** `agents.routing[role]`, passed to claude when there is no profile selection. */
  route?: { model: string; effort: string };
  /** Skills installed into the task workspace for this run (#199). */
  skills?: string[];
  /** The harness session of the run (#407). */
  session?: LaunchRequest["session"];
}): AgentLaunch {
  const rel = relative(o.taskRoot, o.worktree);
  // ponytail: outside the task workspace (analysis) the absolute path must be typed verbatim.
  const repo = rel.startsWith("..") || isAbsolute(rel) ? o.worktree : rel.replaceAll("\\", "/");
  // Word boundary (`<sub>` and `<sub> *`), never a bare prefix `*`: `git diff*` would match `git difftool`.
  // Read-only git also bare, for when a check's `cd <repo>` left the shell inside the repo (#275).
  const read = ["status", "diff", "log", "show"].flatMap((c) => [
    `Bash(git -C ${repo} ${c})`,
    `Bash(git -C ${repo} ${c} *)`,
    `Bash(git ${c})`,
    `Bash(git ${c} *)`,
  ]);
  // Two forms, with or without arguments (`npm test -- <file>`): `cd <repo> && <check>` from the task
  // workspace, and the bare `<check>` once a previous `cd` left the shell inside the repo (#252, #262, #275).
  const checks = o.checks.flatMap((c) => [
    `Bash(cd ${repo} && ${c})`,
    `Bash(cd ${repo} && ${c} *)`,
    `Bash(${c})`,
    `Bash(${c} *)`,
  ]);
  const runsChecks = o.edits || o.runsChecks === true;
  // Implementers also rename files (`git mv`) and run the repo's own npm scripts, with or without
  // arguments (DevTask-0131 #382, carried from #329/#331). The runtime still does the committing.
  const forms = (cmd: string) => [
    `Bash(git -C ${repo} ${cmd})`,
    `Bash(git -C ${repo} ${cmd} *)`,
    `Bash(git ${cmd})`,
    `Bash(git ${cmd} *)`,
  ];
  const npm = EDITOR_NPM_SCRIPTS.flatMap((s) => [
    `Bash(cd ${repo} && npm run ${s})`,
    `Bash(cd ${repo} && npm run ${s} *)`,
    `Bash(npm run ${s})`,
    `Bash(npm run ${s} *)`,
  ]);
  const editing = o.edits ? [...forms("mv"), ...npm] : [];
  // Git stays read-only for everyone else: the runtime commits an implementing step's work (#262).
  // Reviewers get no shell reader: they read with Read/Grep/Glob and read-only git (#395).
  const allowedTools = [...read, ...(runsChecks ? checks : []), ...editing];
  o.roleFiles.writeRoleFiles({ ...o, repo, checks: runsChecks ? o.checks : [] });
  const request: LaunchRequest = { ...o, allowedTools, acceptEdits: o.edits };
  return o.harness.launch(request);
}

/** Redacts first (a secret cut in half escapes its pattern), then cuts without splitting a surrogate pair. */
const cut = (s: string, max: number) => {
  const safe = redact(s);
  return safe.length > max ? `${cutAt(safe, max - 1)}…` : safe;
};

/** Invisible characters a gateway was seen inserting into model output (Spike-0009 Q2). */
const ZERO_WIDTH = /[\u200B-\u200D\u2060]/;

/**
 * Where a gateway step left zero-width characters: its diff over the base (committed or not),
 * untracked files, commit messages (editing steps), and the report it is about to post.
 */
export function zeroWidthIn(t: SliceTarget, edits: boolean, texts: string[]): string[] {
  const out = (args: string[]) =>
    spawnSync("git", args, {
      cwd: t.worktree,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      windowsHide: true,
    }).stdout ?? "";
  const where: string[] = [];
  if (edits) {
    if (ZERO_WIDTH.test(out(["diff", t.baseSha]))) where.push("diff");
    for (const f of out(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) {
      if (f && ZERO_WIDTH.test(readFileSync(join(t.worktree, f), "utf8"))) where.push(f);
    }
    if (ZERO_WIDTH.test(out(["log", "--format=%B", `${t.baseSha}..HEAD`])))
      where.push("commit message");
  }
  if (texts.some((s) => ZERO_WIDTH.test(s))) where.push("report");
  return where;
}

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
  const {
    addArtifact,
    advanceRun,
    beginAttempt,
    enqueueReport,
    failAttempt,
    persistStepResult,
    startStep,
    stepResult,
  } = d.ports.store;
  const { stepSkills } = d.ports.roleFiles;
  const { fetchIssueContext } = d.ports.issueContext;
  const { commit: commitWork } = d.ports;
  const { render: renderStepReport, publish: publishPending } = d.ports.reports;
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
    const sel = d.selection;
    const skills = stepSkills(d.pluginRoot, { ...planned, round: ctx.round }, d.skills);
    const reason = sel?.reason ?? d.skills?.reason;
    const route = config.agents.routing[spec.role];
    const attempt = beginAttempt(db, step.id, {
      ...(sel
        ? { profile: sel.profile.name, model: sel.model, effort: sel.effort }
        : { model: route.model, effort: route.effort }),
      ...(reason ? { reason } : {}),
      skills,
    });
    let report: { result: StepResult; actualModel: string; marker: string; body: string };
    /** The agent's raw answer while it is being accepted: kept for diagnosis when refused. */
    let rawOutput: string | undefined;
    try {
      const fetched = fetchIssueContext(config, t.run.issue, d.gh);
      const architecture = architectureExcerpt(t.worktree, config, []);
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
        ...fetched,
        openFindings,
        readOnlyArtifacts: [],
        checkResults,
        ...(architecture ? { architecture } : {}),
        // Attempts that finish are never re-run: an earlier one was cut and may have left edits.
        ...(attempt > 1 ? { priorAttemptCut: true as const } : {}),
      });
      const file = join(d.evidenceDir, `${spec.stepId}-r${ctx.round}-a${attempt}.packet.json`);
      writeFileSync(file, JSON.stringify(packet, null, 2));
      addArtifact(db, { runId: t.run.id, stepRunId: step.id, kind: "task-packet", path: file });
      const started = Date.now();
      const checkList = Object.values(config.checks).flatMap((c) => (c ? [c.run] : []));
      const runAgent = d.runAgent ?? ((l: AgentLaunch) => d.harness.run(l));
      // Session (#407): Software Engineer and QA Engineer keep one per run and resume it; every
      // other role starts fresh (independent review), but its run still has an id so a contract
      // repair can resume it.
      const persists = SESSION_ROLES.includes(spec.role);
      const contextHash = createHash("sha256")
        .update(JSON.stringify([fetched.issueContext, fetched.issueComments ?? null]))
        .digest("hex");
      const saved = persists ? d.ports.store.agentSession(db, t.run.id, spec.role) : undefined;
      let sessionNote: string | undefined;
      let resumes = false;
      if (saved && saved.tokens > config.agents.sessionMaxTokens) {
        sessionNote = `session used ${saved.tokens} input tokens, over agents.sessionMaxTokens (${config.agents.sessionMaxTokens}): new session with the full packet`;
      } else resumes = saved !== undefined;
      let sessionId = resumes && saved ? saved.sessionId : randomUUID();
      let sessionTokens = resumes && saved ? saved.tokens : 0;
      const runs: AgentObservation[] = [];
      const denials: string[] = [];
      /** One agent process in the session: quota → error; observed, counted and remembered. */
      const runOnce = (prompt: string, mode: "new" | "resume"): AgentObservation => {
        const stdout = runAgent(
          prepareAgent({
            harness: d.harness,
            roleFiles: d.ports.roleFiles,
            pluginRoot: d.pluginRoot,
            role: spec.role,
            category: spec.category,
            edits: spec.edits,
            taskRoot: t.taskRoot,
            worktree: t.worktree,
            runsChecks: spec.runsChecks,
            checks: checkList,
            prompt,
            hostEnv: d.hostEnv,
            selection: sel,
            route,
            skills,
            session: { mode, id: sessionId },
          }),
        );
        const quota = d.harness.detectQuota(stdout);
        if (quota) {
          const name = sel?.profile.name ?? "default";
          const n = t.run.issue;
          throw new OmiError(
            "QUOTA_EXHAUSTED",
            `profile ${name} is out of quota (${quota.signal}): PO sets "disabled": true for it in .omi-plugins/omi.config.json; Coordinator runs \`omi task unblock ${n}\` then \`omi task run ${n} --profile <another>\``,
            { profile: name, signal: quota.signal, event: quota.event },
          );
        }
        const o = d.harness.observe(stdout);
        runs.push(o);
        const u = o.usage;
        sessionTokens +=
          (u?.inputTokens ?? 0) + (u?.cacheReadTokens ?? 0) + (u?.cacheCreationTokens ?? 0);
        if (persists) {
          d.ports.store.saveAgentSession(db, {
            runId: t.run.id,
            role: spec.role,
            sessionId,
            tokens: sessionTokens,
            contextHash,
          });
        }
        // Kept even when the attempt errors: the refused commands explain a BLOCKED step (#252).
        denials.push(...o.permissionDenials.map((s) => cut(s, 300)));
        if (denials.length) {
          const file = join(d.evidenceDir, `${spec.stepId}-r${ctx.round}-a${attempt}.denials.json`);
          writeFileSync(file, JSON.stringify(redactDeep(denials.slice(0, 50)), null, 2));
          addArtifact(db, { runId: t.run.id, stepRunId: step.id, kind: "log", path: file });
        }
        return o;
      };
      let obs: AgentObservation;
      // The unblock reason belongs to the step rerun right after `task unblock`, whoever runs it (#407).
      const unblocked = d.ports.store.takeUnblockReason(db, t.run.id);
      const unblockNotes = [
        ...(spec.notes ?? []),
        ...(unblocked ? [`A person unblocked the run: ${cut(unblocked, 1000)}`] : []),
      ];
      if (resumes) {
        const notes: string[] = [...unblockNotes];
        const issueChanged = saved?.contextHash !== null && saved?.contextHash !== contextHash;
        if (issueChanged) {
          notes.push("The Issue, its parents or its trusted comments changed since your last run.");
        }
        try {
          obs = runOnce(
            resumePrompt(packet, {
              openFindings: packet.openFindings,
              checkResults: packet.checkResults?.map((c) => ({
                ...c,
                summary: cut(c.summary, 1000),
              })),
              notes,
              ...(issueChanged ? { issueContext: packet.issueContext } : {}),
              ...(issueChanged && packet.issueComments
                ? { issueComments: packet.issueComments }
                : {}),
            }),
            "resume",
          );
          // Only a session that could not be loaded starts over; a real agent error is a normal failed attempt.
          if (resumeNotLoaded(obs)) {
            throw new OmiError("INTERNAL", "resumed run ended in an error");
          }
        } catch (e) {
          if (e instanceof OmiError && e.code === "QUOTA_EXHAUSTED") throw e;
          // The session is gone or unusable (e.g. another profile's token): start over with the whole packet.
          sessionNote = cut(
            `resume failed (${(e as Error).message}): new session with the full packet`,
            300,
          );
          resumes = false;
          sessionId = randomUUID();
          sessionTokens = 0;
          obs = runOnce(packetPrompt({ ...packet, priorAttemptCut: true }, unblockNotes), "new");
        }
      } else {
        obs = runOnce(packetPrompt(packet, unblockNotes), "new");
      }
      if (obs.isError) throw new OmiError("INTERNAL", `${spec.role} run ended in an error`);
      // Token usage is what the host observed, never what the agent claims.
      let repairs = 0;
      let accepted: ReturnType<typeof acceptStepResultWithWarnings>;
      for (;;) {
        rawOutput = obs.result;
        try {
          accepted = acceptStepResultWithWarnings(packet, obs.result);
          break;
        } catch (e) {
          // A refused result is repaired in the very session that wrote it, before BLOCKED (#407).
          if (
            !(e instanceof OmiError && e.code === "CONTRACT_INVALID") ||
            repairs >= config.agents.contractRepairs
          ) {
            throw e;
          }
          repairs++;
          const issues = (e.details as { issues?: { path: string; message: string }[] } | undefined)
            ?.issues;
          obs = runOnce(
            repairPrompt(packet, { message: e.message, issues: issues ?? [] }),
            "resume",
          );
          if (obs.isError)
            throw new OmiError("INTERNAL", `${spec.role} repair run ended in an error`);
        }
      }
      const models = [...new Set(runs.flatMap((r) => r.actualModel.split(",")))].filter(
        (m) => m !== "unknown",
      );
      const observed = {
        actualModel: models.length ? models.join(",") : "unknown",
        thinkingObserved: runs.some((r) => r.thinkingObserved),
        usage: sumUsage(runs.flatMap((r) => (r.usage ? [r.usage] : []))),
      };
      const durationMs = runs.every((r) => r.durationMs !== undefined)
        ? runs.reduce((n, r) => n + (r.durationMs ?? 0), 0)
        : Date.now() - started;
      const sessionKind: "new" | "resumed" | "repair" = repairs
        ? "repair"
        : resumes
          ? "resumed"
          : "new";
      const { usage: _claimed, ...claimed } = accepted.result;
      const warnings = accepted.warnings.map((w) => cut(`step result field cut: ${w}`, 300));
      if (warnings.length) {
        // The full output stays in evidence (redacted) when a field was cut.
        mkdirSync(d.evidenceDir, { recursive: true });
        const outFile = join(
          d.evidenceDir,
          `${spec.stepId}-r${ctx.round}-a${attempt}${OUTPUT_SUFFIX}`,
        );
        writeFileSync(outFile, redact(cut(obs.result, MAX_RAW_OUTPUT_CHARS)));
        addArtifact(db, { runId: t.run.id, stepRunId: step.id, kind: "log", path: outFile });
      }
      rawOutput = undefined;
      let result: StepResult = observed.usage ? { ...claimed, usage: observed.usage } : claimed;
      if (spec.edits && result.status === "PASSED") {
        // The runtime commits, not the agent (#262): its own claim of a SHA is dropped.
        const { commitSha: _sha, ...rest } = result;
        const head = fetched.issueContext[0];
        const sha = commitWork(t.worktree, {
          type: head?.type ?? "dev-task",
          title: head?.title ?? `Issue ${t.run.issue}`,
          issue: t.run.issue,
          round: ctx.round,
          attempt,
          stepId: spec.stepId,
          scope: spec.role.replace(/-engineer$/, ""),
          model: observed.actualModel,
        });
        result = sha
          ? { ...rest, commitSha: sha }
          : { ...rest, summary: cut(`${rest.summary}\nRuntime: no changes to commit.`, 2000) };
      }
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
          requestedModel: sel?.model ?? route.model,
          actualModel: observed.actualModel,
          requestedEffort: sel?.effort ?? route.effort,
          actualEffort: "unknown",
          ...(sel ? { profile: sel.profile.name } : {}),
          ...(reason ? { selectionReason: reason } : {}),
          skills,
          thinkingObserved: observed.thinkingObserved,
          session: sessionKind,
          ...(sessionNote ? { sessionNote } : {}),
          contractRepairs: repairs,
          commitSha: result.commitSha,
          status: result.status,
          summary: result.summary,
          changedFiles: result.changedFiles,
          evidencePaths: result.evidencePaths,
          findings: result.findings,
          ...(denials.length ? { permissionDenials: denials.slice(0, 50) } : {}),
          ...(warnings.length ? { warnings } : {}),
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
        actualModel: observed.actualModel,
        marker: commentMarker(comment),
        body: renderStepReport(comment),
      };
      // A gateway may watermark model output: nothing it touched is posted or carried on.
      if (sel?.profile.auth.type === "gateway") {
        const texts = [report.body, ...result.sectionUpdates.map((u) => u.markdown)];
        const where = zeroWidthIn(t, spec.edits, texts);
        if (where.length) {
          throw new OmiError(
            "POLICY_VIOLATION",
            `gateway profile ${sel.profile.name} left zero-width characters (U+200B/C/D, U+2060) in: ${where.join(", ")}. Nothing was posted; strip them or re-run the step on another profile.`,
          );
        }
      }
    } catch (e) {
      const err = e instanceof OmiError ? e : new OmiError("INTERNAL", (e as Error).message);
      // The reason survives the attempt (G6-002, #121): the DB keeps only the code.
      mkdirSync(d.evidenceDir, { recursive: true });
      const file = join(d.evidenceDir, `${spec.stepId}-r${ctx.round}-a${attempt}${ERROR_SUFFIX}`);
      let details: unknown = err.details ?? null;
      if (rawOutput !== undefined) {
        const outFile = join(
          d.evidenceDir,
          `${spec.stepId}-r${ctx.round}-a${attempt}${OUTPUT_SUFFIX}`,
        );
        writeFileSync(outFile, redact(cut(rawOutput, MAX_RAW_OUTPUT_CHARS)));
        addArtifact(db, { runId: t.run.id, stepRunId: step.id, kind: "log", path: outFile });
        const base = details && typeof details === "object" ? details : {};
        details = { ...base, rawOutputPath: outFile };
      }
      const failure = { code: err.code, message: err.message, details };
      writeFileSync(file, JSON.stringify(redactDeep(failure), null, 2));
      addArtifact(db, { runId: t.run.id, stepRunId: step.id, kind: "log", path: file });
      if (err.code === "QUOTA_EXHAUSTED") {
        // The Issue shows why the step stopped, with the host's own signal (#218).
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
            requestedModel: sel?.model ?? route.model,
            actualModel: "unknown",
            requestedEffort: sel?.effort ?? route.effort,
            actualEffort: "unknown",
            ...(sel ? { profile: sel.profile.name } : {}),
            ...(reason ? { selectionReason: reason } : {}),
            skills,
            status: "BLOCKED",
            summary: cut(
              `Quota: ${err.message}\nSignal: ${JSON.stringify((err.details as { event?: unknown }).event)}`,
              2000,
            ),
            nextAction:
              "Coordinator: a new attempt of this step on another profile, in the same task workspace.",
            executionId: `${t.run.id}.${spec.stepId}.r${ctx.round}.a${attempt}`,
            createdAt: (d.now?.() ?? new Date()).toISOString(),
          },
          "quota comment",
        );
        enqueueReport(db, {
          runId: t.run.id,
          marker: commentMarker(comment),
          body: renderStepReport(comment),
        });
        publishPending(db, t.run.id, { gh: d.gh }); // a failure leaves it for the next run
      }
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
    // The agent may echo the decrypted token into its result: nothing unredacted reaches state.sqlite.
    const safeResult = redactDeep(report.result);
    persistStepResult(db, {
      stepRunId: step.id,
      attempt,
      result: safeResult,
      actualModel: report.actualModel,
      report: { marker: report.marker, body: report.body },
    });
    publishPending(db, t.run.id, { gh: d.gh }); // a failure leaves it pending: the FSM holds
    return safeResult;
  }
}

const SKIPPED_PROOF = "skipped: regression.command chưa cấu hình";
const DEFAULT_CHECK_TIMEOUT_SEC = 600;

/**
 * Bug Resolution gate (DevTask-0140 #404): REG-001 the fix changes a test file carrying a
 * `TC-<bug>-<n>` code; REG-003 the commit before the fix cannot be found; REG-002 the proof itself
 * (the test fails before the fix, passes on HEAD). Without `regression.command` the proof is skipped.
 */
function regressionGate(
  d: SliceDeps,
  t: SliceTarget,
  ctx: WorkflowContext,
  bug: number | undefined,
): { findings: Finding[]; notes: string[]; proof?: string } {
  const { git, regression, store } = d.ports;
  const high = (id: string, observed: string, expected: string): Finding => ({
    id,
    severity: "high",
    observed: cut(observed, 1000),
    expected,
  });
  const names = (args: string[]) => git(args, t.worktree).split("\0").filter(Boolean);
  const changed = [
    ...names(["diff", "-z", "--name-only", "--diff-filter=ACMR", t.baseSha]),
    ...names(["ls-files", "-z", "--others", "--exclude-standard"]),
  ].filter(isTest);
  const read = (f: string) => {
    try {
      return readFileSync(join(t.worktree, f), "utf8");
    } catch {
      return "";
    }
  };
  // Without a parent number the code cannot be named: any changed test file satisfies the gate.
  const files = bug === undefined ? changed : tcFiles(changed, read, bug);
  if (!files.length) {
    return {
      findings: [
        high(
          "REG-001", // finding ids are PREFIX-NNN
          bug === undefined
            ? "The bug fix changes no test file."
            : `The bug fix changes no test file carrying a regression test code TC-${bug}-<n>.`,
          bug === undefined
            ? "Add a regression test that fails without the fix and passes with it."
            : `Add a regression test whose name carries TC-${bug}-<n> (e.g. test("TC-${bug}-01: …")) that fails without the fix and passes with it.`,
        ),
      ],
      notes: [],
    };
  }
  const rc = d.config.regression;
  if (bug === undefined || !rc?.command) {
    return { findings: [], notes: [], proof: `### Regression proof\n${SKIPPED_PROOF}` };
  }
  // File names reach a shell command line: only plain characters, before anything runs.
  const unsafe = unsafePaths(files);
  if (unsafe.length) {
    return {
      findings: [
        high(
          "REG-001",
          `Regression test file names contain characters that are not allowed in a shell command: ${unsafe.join(", ")}`,
          "Name TC-<bug>-<n> test files using only letters, digits and . / _ @ + -",
        ),
      ],
      notes: [],
    };
  }
  const base = d.config.git.baseBranch;
  let preFix: string;
  let source: string;
  try {
    const issue = parseContract(
      z.looseObject({ body: z.string().nullable() }),
      api(d.gh, [`repos/${t.run.repository}/issues/${t.run.issue}`], "get issue"),
      "get issue",
    );
    const marker = preFixMarker(issue.body ?? "");
    if (marker) {
      preFix = git(["rev-parse", "--verify", `${marker}^{commit}`], t.worktree);
      try {
        git(["merge-base", "--is-ancestor", preFix, `origin/${base}`], t.worktree);
      } catch {
        return {
          findings: [
            high(
              "REG-003",
              `The omi:pre-fix-commit ${marker} is not a commit of origin/${base}.`,
              `The marker names a commit that is in origin/${base}.`,
            ),
          ],
          notes: [],
        };
      }
      source = "marker omi:pre-fix-commit";
    } else {
      preFix = git(["merge-base", "HEAD", `origin/${base}`], t.worktree);
      source = `merge-base HEAD origin/${base}`;
    }
  } catch (e) {
    return {
      findings: [
        high(
          "REG-003",
          `The commit before the fix cannot be determined: ${(e as Error).message}`,
          `A valid <!-- omi:pre-fix-commit=<sha> --> marker, or origin/${base} reachable for the merge-base.`,
        ),
      ],
      notes: [],
    };
  }
  const run = fillCommand(rc.command, files);
  let r: ReturnType<typeof regression.runProof>;
  try {
    r = regression.runProof({
      worktree: t.worktree,
      preFix,
      run,
      copy: changed,
      share: rc.share,
      timeoutSec:
        rc.timeoutSeconds ?? d.config.checks.test?.timeoutSec ?? DEFAULT_CHECK_TIMEOUT_SEC,
      tmpRoot: join(d.evidenceDir, "tmp"),
      logDir: join(d.evidenceDir, `regression-r${ctx.round}-${ctx.validationFixes + 1}`),
      env: d.commandEnv,
    });
  } catch (e) {
    // Not the engineer's fault (git, disk, host): a technical error, never a finding.
    throw new OmiError(
      "INTERNAL",
      cut(`regression proof could not run: ${(e as Error).message}`, 500),
    );
  }
  for (const x of [r.before, r.after]) {
    if (x.logPath) store.addArtifact(d.db, { runId: t.run.id, kind: "log", path: x.logPath });
  }
  const proof: ProofReport = { preFix, source, command: run, files, ...r };
  return {
    findings: proofFindings(proof).map((f) => high(f.id, f.observed, f.expected)),
    notes: [],
    proof: renderProof(proof),
  };
}

/** Deterministic checks as an omi-cli step with its own report; failures become findings. */
function checksStep(
  d: SliceDeps,
  t: SliceTarget,
  ctx: WorkflowContext,
  /** Gate findings decided by the runtime itself (e.g. a missing regression test). */
  extra: Finding[] = [],
  base: {
    stepId: string;
    title: string;
    next: string;
    notes?: string[];
    /** "Regression proof" section (markdown) of the report. */
    proof?: string;
  } = {
    stepId: "checks",
    title: "Deterministic Checks",
    next: "Code review.",
  },
): { findings: Finding[]; results: CheckRun[] } {
  const { addArtifact, enqueueReport } = d.ports.store;
  const { render: renderStepReport, publish: publishPending } = d.ports.reports;
  const n = ctx.validationFixes + 1;
  const stepId = base.stepId + qaSuffix(ctx);
  const { passed, results } = d.ports.checks.runChecks({
    worktree: t.worktree,
    checks: d.config.checks,
    architecture: d.config.architecture,
    env: d.commandEnv,
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
      summary: cut(
        [results.map((r) => `${r.name}: ${r.outcome}`).join(", "), ...(base.notes ?? [])].join(
          "\n",
        ),
        2000,
      ),
      findings,
      ...(base.proof ? { regressionProof: base.proof } : {}),
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
  const { git } = d.ports;
  const { enqueueReport } = d.ports.store;
  const { render: renderStepReport, publish: publishPending } = d.ports.reports;
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
    checks = gate.results; // e.g. after a resume, the QA Engineer still gets this HEAD's checks (#121)
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
  const { git } = d.ports;
  const { advanceRun, runContext, runFindings, saveRunFindings } = d.ports.store;
  const publishPending = d.ports.reports.publish;
  mkdirSync(d.evidenceDir, { recursive: true });
  publishPending(d.db, t.run.id, { gh: d.gh }); // finish what a crashed invocation persisted
  let ctx = runContext(d.db, t.run.id);
  const advance = (e: WorkflowEvent) => {
    ctx = advanceRun(d.db, t.run.id, e, policy).context;
  };
  const refresh = () => runContext(d.db, t.run.id);
  // Open findings live in state.sqlite: a run resumed after BLOCKED starts from them (Bug-0013 #392).
  let open = runFindings(d.db, t.run.id);
  /** Records the new open findings before the run moves on, so no process boundary can lose them. */
  const setOpen = (next: RunFindings) => {
    open = next;
    saveRunFindings(d.db, t.run.id, next);
  };
  /** Same reviewers as before, new findings (the engineer's checks, QA, the Architect's plan). */
  const setFindings = (findings: Finding[]) => setOpen({ ...open, findings });
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
        if (needDev) {
          const spec = ctx.validationFixes
            ? { ...DEV, stepId: `implement-fix${ctx.validationFixes}` }
            : DEV;
          const dev = agentStep(d, t, spec, ctx, open.findings);
          if (!dev) return refresh();
          if (dev.status !== "PASSED") {
            advance({ type: "BLOCK" }); // engineer could not finish: a person decides
            return ctx;
          }
        }
        // Bug Resolution: reproduction + regression (spec §10 catalogue) is a deterministic gate.
        // DevTask-0140 #404: the test carries `TC-<bug>-<n>` and the runtime proves fail-before / pass-after.
        const regression = plan.regressionTest
          ? regressionGate(d, t, ctx, t.parent)
          : { findings: [], notes: [], proof: undefined };
        // Test design gate (#408): every `Auto = Y` case of the Story's TC table has a test.
        const tc = t.parent ? tcGate(d, t, t.parent) : { findings: [], notes: [] };
        const gate = checksStep(d, t, ctx, [...regression.findings, ...tc.findings], {
          stepId: "checks",
          title: "Deterministic Checks",
          next: "Code review.",
          notes: [...regression.notes, ...tc.notes],
          proof: regression.proof,
        });
        checks = gate.results;
        checkedHead = gate.findings.length ? null : git(["rev-parse", "HEAD"], t.worktree);
        if (gate.findings.length) {
          advance({ type: "CHECKS_FAILED" });
          // The engineer fixes the checks and still owes the review findings that are open.
          setFindings(carryOpen(gate.findings, open.findings));
          needDev = true;
          break;
        }
        const review = agentStep(d, t, REVIEW, ctx, open.findings, checks);
        if (!review) return refresh();
        if (review.status !== "PASSED" && review.status !== "FAILED") {
          advance({ type: "BLOCK" });
          return ctx;
        }
        const verdicts: ReviewVerdict[] = [
          { role: "code-reviewer", status: review.status, findings: review.findings },
        ];
        // Security gate (PO 2026-11-18): label risk:high/security, or the reviewer routes it. A
        // Security Reviewer that FAILED earlier runs again whatever selects it now (Bug-0013 #392).
        const securityDue =
          (review.status === "PASSED" &&
            (plan.security || /^security-review:/.test(review.nextAction ?? ""))) ||
          open.failedReviewers.includes("security-reviewer");
        if (securityDue) {
          const sec = agentStep(d, t, SECURITY, ctx, open.findings, checks);
          if (!sec) return refresh();
          if (sec.status !== "PASSED" && sec.status !== "FAILED") {
            // A critical finding escalates to the PO at once; any other block stops for a person.
            const critical = sec.findings.some((f) => f.severity === "critical");
            advance({ type: critical ? "ESCALATE_TO_PO" : "BLOCK" });
            return ctx;
          }
          verdicts.push({ role: "security-reviewer", status: sec.status, findings: sec.findings });
        }
        setOpen(afterReview(open, verdicts));
        const passed = verdicts.every((v) => v.status === "PASSED");
        advance({ type: passed ? "REVIEW_PASSED" : "REVIEW_FAILED" });
        needDev = false;
        break;
      }
      case "ARCHITECT_ESCALATION": {
        const plan = agentStep(d, t, ARCHITECT, ctx, open.findings, checks);
        if (!plan) return refresh();
        if (plan.status === "PASSED") {
          // The correction plan is what round 3 addresses, plus every blocking review finding it does not repeat.
          setFindings(carryOpen(plan.findings, open.findings));
          advance({ type: "ARCHITECT_PLAN_ACCEPTED" });
        } else {
          advance({ type: "ARCHITECT_SCOPE_CHANGE" });
        }
        break;
      }
      case "IN_QA": {
        // Gate (Bug-0013 #392): no PR_PENDING while a blocking finding is open or a reviewer that
        // FAILED has not passed since. Normally the review loop leaves none; a resumed or
        // inconsistent run goes back to the engineer and the reviewers instead.
        const unconfirmedNow = unconfirmed(open);
        if (unconfirmedNow.length) {
          setFindings(
            carryOpen(
              [
                {
                  id: "REL-003",
                  severity: "high",
                  observed: cut(
                    `Not confirmed closed by a reviewer: ${unconfirmedNow.join("; ")}.`,
                    1000,
                  ),
                  expected:
                    "Resolve the open findings; the reviewers that FAILED run again and confirm they are closed.",
                },
              ],
              open.findings,
            ),
          );
          advance({ type: "QA_FAILED" });
          break;
        }
        const release = releaseStep(d, t, ctx, checkedHead);
        checks = release.checks ?? checks;
        if (release.findings.length) {
          setFindings(carryOpen(release.findings, open.findings));
          advance({ type: "QA_FAILED" });
          break;
        }
        if (plan.manualQa) {
          const qa = agentStep(d, t, QA, ctx, open.findings, checks);
          if (!qa) return refresh();
          // QA may run check commands: the clean worktree release validation saw must stay clean.
          const dirty = git(["status", "--porcelain", "--untracked-files=all"], t.worktree);
          if (dirty) {
            const file = join(
              d.evidenceDir,
              `${QA.stepId}${qaSuffix(ctx)}-r${ctx.round}${ERROR_SUFFIX}`,
            );
            const message = `QA Engineer left the worktree dirty:
${dirty}`;
            writeFileSync(
              file,
              JSON.stringify(redactDeep({ code: "POLICY_VIOLATION", message }), null, 2),
            );
            advance({ type: "BLOCK" });
            return ctx;
          }
          for (const u of qa.sectionUpdates) d.writeSection?.(u.section, u.markdown);
          if (qa.status !== "PASSED" && qa.status !== "FAILED") {
            advance({ type: "BLOCK" });
            return ctx;
          }
          if (qa.status === "FAILED") {
            setFindings(qa.findings);
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
 * WAITING_PO / BLOCKED when an analyst could not finish. `t.worktree` is the main checkout, read
 * through `--add-dir`; `t.taskRoot` holds the role files.
 */
export function runAnalysis(
  d: SliceDeps & Required<Pick<SliceDeps, "writeSection">>,
  t: SliceTarget & { plan: AnalysisPlan },
): WorkflowContext {
  const { advanceRun, runContext } = d.ports.store;
  const publishPending = d.ports.reports.publish;
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
    if (t.plan.workflow === "Design") {
      // A design run needs exactly the `design` section; without it the Issue must not move on.
      const design = r.sectionUpdates.find((u) => u.section === "design");
      if (!design) return advanceRun(d.db, t.run.id, { type: "ESCALATE_TO_PO" }).context;
      d.writeSection("design", design.markdown);
    } else {
      for (const u of r.sectionUpdates) d.writeSection(u.section, u.markdown);
    }
    ctx = runContext(d.db, t.run.id);
  }
  return advanceRun(d.db, t.run.id, { type: "ANALYSIS_COMPLETED" }).context;
}

/** What a read-only QATask run decided; the composition root closes and finalizes on PASSED. */
export interface QaOutcome {
  mode: QaPlan["mode"];
  verdict: "PASSED" | "FAILED";
  /** `Run #k` of a Verify. */
  run?: number;
  /** Proposed Bug bodies (§11) of a FAILED Verify. */
  proposals: string[];
}

const QA_FORMAT = {
  "test-design": (story: number) =>
    `QATask mode: TEST DESIGN (read-only, no commit, no PR). Reply status PASSED with sectionUpdates [{"section":"qa","markdown":"<JSON>"}] where the JSON is {"acCoverage": string, "cases": [{"id":"TC-${story}-01","ac":string,"steps":string,"expected":string,"auto":boolean,"regression":boolean}]}. Case ids are TC-${story}-<n>, unique, each mapped to one Acceptance Criterion of the parent Issue #${story}. No other field.`,
  verify: (story: number) =>
    `QATask mode: VERIFY (read-only, no commit, no PR; changedFiles empty, the worktree stays clean). Reply status PASSED with sectionUpdates [{"section":"qa","markdown":"<JSON>"}] where the JSON is {"cases":[{"id":"TC-${story}-01","result":"pass|fail|blocked","note"?:string}],"defects":[{"title","repro","expected","actual","severity":"critical|high|medium|low","tc":["TC-…"]}],"manualRegression":[string]}. Report every case of the TC table (the Test design QATask of the same Story, found by the runtime) or, for a Bug's Retest, the parent's Steps to reproduce as cases. An Auto = Y case takes its result from the test carrying its TC id in checkResults/logs; a manual case you perform yourself; manualRegression lists the manual Regression = Y cases that apply. A defect is a real failure with steps to reproduce; no other field.`,
} as const;

const trustedComments = (d: SliceDeps, issue: { repository: string; number: number }) => {
  const pages = api(
    d.gh,
    [
      "--paginate",
      "--slurp",
      `repos/${issue.repository}/issues/${issue.number}/comments?per_page=100`,
    ],
    "list comments",
  );
  const trusted = markerAuthor(d.gh);
  return parseContract(z.array(z.array(RestComment)), pages, "list comments")
    .flat()
    .filter((c) => trusted(c.author_association, c.user?.login));
};

const RestSubIssue = z.looseObject({
  number: z.int(),
  body: z.string().nullable(),
  labels: z.array(z.union([z.string(), z.looseObject({ name: z.string() })])),
});

/** TC cases of the Test design QATask(s) among the Story's sub-issues, read in full (not the packet copy). */
const designTable = (
  d: SliceDeps,
  repository: string,
  story: number,
): ReturnType<typeof parseTestTable> => {
  const pages = api(
    d.gh,
    ["--paginate", "--slurp", `repos/${repository}/issues/${story}/sub_issues?per_page=100`],
    "list sub-issues",
  );
  return parseContract(z.array(z.array(RestSubIssue)), pages, "list sub-issues")
    .flat()
    .filter((s) =>
      s.labels.some((l) => (typeof l === "string" ? l : l.name) === d.config.qa.designLabel),
    )
    .flatMap((s) => parseTestTable(s.body ?? ""))
    .filter((c) => c.id.startsWith(`TC-${story}-`));
};

/** Test files of the worktree (tracked and new), at most 1 MiB each: what a TC id may be named in. */
const testSources = (d: SliceDeps, worktree: string): string[] =>
  d.ports
    .git(["ls-files", "--cached", "--others", "--exclude-standard"], worktree)
    .split(/\r?\n/)
    .filter((f) => f && isTest(f))
    .flatMap((f) => {
      const file = join(worktree, f);
      try {
        return statSync(file).size <= 1024 * 1024 ? [readFileSync(file, "utf8")] : [];
      } catch {
        return []; // listed but gone (deleted in the worktree)
      }
    });

/**
 * Gate TCG-001 (DevTask-0143 #408): the DevTask of a Story whose sibling Test design QATask already
 * has a TC table needs a test file naming each `Auto = Y` case (`TC-<story>-<n>`). No Test design
 * QATask, or an empty table, never blocks: the report says the gate was not applied.
 */
function tcGate(
  d: SliceDeps,
  t: SliceTarget,
  story: number,
): { findings: Finding[]; notes: string[] } {
  const table = designTable(d, t.run.repository, story);
  if (!table.length) {
    return {
      findings: [],
      notes: [
        `Test design gate not applied: no TC table under #${story} (label ${d.config.qa.designLabel}).`,
      ],
    };
  }
  const missing = missingAutoTests(table, testSources(d, t.worktree));
  const auto = table.filter((c) => c.auto).length;
  if (!missing.length) {
    return {
      findings: [],
      notes: [`Test design gate passed: ${auto} Auto = Y case(s) of #${story} have a test.`],
    };
  }
  return {
    findings: [
      {
        id: "TCG-001",
        severity: "high",
        observed: cut(
          `${missing.length} of ${auto} Auto = Y case(s) of #${story} have no test naming their id in a test file: ${missing.join(", ")}`,
          1000,
        ),
        expected: `Every Auto = Y case has a test whose file names its id (TC-${story}-<n>), e.g. in the test title.`,
      },
    ],
    notes: [`Test design gate failed: missing ${missing.join(", ")}.`],
  };
}

/**
 * Read-only QATask run (DevTask-0134 #385): one QA Engineer step on a freshly fetched base HEAD, no
 * commit, no PR, no review. Test design writes the TC table into the Issue's `qa` section; Verify
 * runs the repo's checks, reconciles the agent's per-TC results and posts or updates `Run #k`.
 * PASSED leaves the run for `omi task finalize` (noCode); FAILED holds it BLOCKED for the Coordinator.
 * A rerun on the same develop commit keeps `Run #k` (same agent step id): it reuses the stored QA
 * assessment, re-runs the checks and updates the existing comment; a new commit starts `Run #k+1`.
 */
export function runQa(
  d: SliceDeps,
  target: SliceTarget & { plan: QaPlan },
): { ctx: WorkflowContext; qa?: QaOutcome } {
  const { plan } = target;
  const { advanceRun, runContext, upsertReport } = d.ports.store;
  const { git } = d.ports;
  const publishPending = d.ports.reports.publish;
  const policy = policyFrom(d.config);
  const issue = { repository: target.run.repository, number: target.run.issue };
  mkdirSync(d.evidenceDir, { recursive: true });
  publishPending(d.db, target.run.id, { gh: d.gh });
  let ctx = runContext(d.db, target.run.id);
  if (ctx.state === "WORKSPACE_READY") {
    ctx = advanceRun(d.db, target.run.id, { type: "DEV_STARTED" }, policy).context;
  }
  if (ctx.state !== "RUNNING") return { ctx };
  const stop = (code: string, message: string) => {
    const file = join(d.evidenceDir, `qa-r${ctx.round}${ERROR_SUFFIX}`);
    writeFileSync(file, JSON.stringify(redactDeep({ code, message }), null, 2));
    ctx = advanceRun(d.db, target.run.id, { type: "BLOCK" }, policy).context;
    return { ctx };
  };

  // Verify runs on the newest base: a rerun after a fix merged sees the fix.
  const base = d.config.git.baseBranch;
  git(["fetch", "origin", base], target.worktree);
  git(["checkout", "--detach", `origin/${base}`], target.worktree);
  const head = git(["rev-parse", "HEAD"], target.worktree);
  const t = { ...target, baseSha: head };

  const story = target.parent;
  if (!story) return stop("POLICY_VIOLATION", "a QATask needs a parent Issue (the Story or Bug)");
  const spec: StepSpec = { ...QA, title: plan.workflow, notes: [QA_FORMAT[plan.mode](story)] };
  const dirty = () => git(["status", "--porcelain", "--untracked-files=all"], t.worktree);
  const section = (r: StepResult) => r.sectionUpdates.find((u) => u.section === "qa")?.markdown;
  const finish = (qa: QaOutcome) => {
    if (qa.verdict === "PASSED") d.closeIssue?.();
    return { ctx, qa };
  };
  const hold = () => {
    ctx = advanceRun(d.db, t.run.id, { type: "BLOCK" }, policy).context;
    return { ctx };
  };

  if (plan.mode === "test-design") {
    const r = agentStep(d, t, spec, ctx, []);
    if (!r) return { ctx: runContext(d.db, t.run.id) };
    const left = dirty();
    if (left) return stop("CONTRACT_INVALID", `QA Engineer left the worktree dirty:\n${left}`);
    const md = section(r);
    if (r.status !== "PASSED" || !md) return hold();
    try {
      d.writeSection?.("qa", renderTestDesign(parseTestDesign(jsonOf(md), story)));
    } catch (e) {
      return stop("CONTRACT_INVALID", (e as Error).message);
    }
    return finish({ mode: plan.mode, verdict: "PASSED", proposals: [] });
  }

  // Verify / Retest: Run #k comes from the comments already on the Issue.
  // The TC table is the sibling Test design QATask's, read in full; no table = nothing to verify
  // (a Verify with zero cases must never PASS). A Bug's Retest reports its Steps to reproduce.
  let table: ReturnType<typeof parseTestTable> = [];
  if (!plan.retest) {
    try {
      table = designTable(d, issue.repository, story);
    } catch (e) {
      return stop("CONTRACT_INVALID", (e as Error).message);
    }
    if (!table.length) {
      return stop(
        "POLICY_VIOLATION",
        `no Test design table (label ${d.config.qa.designLabel}) found under #${story}: run the Test design QATask first`,
      );
    }
  }
  const k = nextRun(trustedComments(d, issue), head).k;
  const kctx = { ...ctx, qaReworks: k - 1 }; // distinct step ids per run: `qa`, `qa-qa1`, …
  const gate = checksStep(d, t, kctx, [], {
    stepId: "checks",
    title: "Deterministic Checks",
    next: "QA Verify.",
  });
  const checksPassed = gate.findings.length === 0;
  const vspec: StepSpec = table.length
    ? {
        ...spec,
        notes: [
          ...(spec.notes ?? []),
          `TC table (from the Test design QATask under #${story}; report every ID):\n${renderTestTable(table)}`,
        ],
      }
    : spec;
  const r = agentStep(d, t, vspec, kctx, [], gate.results);
  if (!r) return { ctx: runContext(d.db, t.run.id) };
  const left = dirty();
  if (left) return stop("CONTRACT_INVALID", `QA Engineer left the worktree dirty:\n${left}`);
  const md = section(r);
  if (r.status !== "PASSED" || !md) return hold();
  let result: ReturnType<typeof parseVerify>;
  try {
    const output = gate.results
      .map(
        (c) =>
          `${c.summary}\n${c.logPath && existsSync(c.logPath) ? readFileSync(c.logPath, "utf8") : ""}`,
      )
      .join("\n");
    result = reconcile(table, parseVerify(jsonOf(md)), output);
    if (!result.cases.length) {
      throw new OmiError("CONTRACT_INVALID", "verify result: no case reported", {
        issues: [{ path: "cases", message: "at least one case is required" }],
      });
    }
  } catch (e) {
    return stop("CONTRACT_INVALID", (e as Error).message);
  }
  const passed = verifyPassed(result, checksPassed);
  const proposals = passed ? [] : proposeBugs(result, t.run.issue, head);
  if (!passed && !proposals.length) {
    proposals.push(
      `## Automated suite failed on ${head.slice(0, 8)}\n**Found in:** QATask #${t.run.issue}`,
    );
  }
  const body = renderRun({
    k,
    commit: head,
    result,
    checksPassed,
    qaTaskNumber: t.run.issue,
    proposals,
  });
  upsertReport(d.db, { runId: t.run.id, marker: body.split("\n")[0] as string, body });
  publishPending(d.db, t.run.id, { gh: d.gh });
  if (!passed) hold();
  return finish({ mode: plan.mode, verdict: passed ? "PASSED" : "FAILED", run: k, proposals });
}
