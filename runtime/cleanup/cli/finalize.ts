// `omi task finalize <n>` (spec §14 completion flow): merge receipt from GitHub → run PR_MERGED →
// CLEANUP_PENDING → receipt archived + log retention → safe cleanup (T4.3) → cleanup comment
// posted → COMPLETED, Done and parent roll-up. Any failure leaves the run short of COMPLETED, so
// Done is never shown for unverified cleanup; rerunning resumes where it stopped. `dryRun` only
// reports what cleanup would do.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { markFinished, type StatusChange, setStatus } from "../../github/adapters/project.ts";
import { type EngineOutcome, isV2, lifecycleSync } from "../../github/cli/lifecycle.ts";
import { type MergeReceipt, prFacts, receiptOf } from "../../release/adapters/merge.ts";
import { closingIssues, markedPrimaries } from "../../release/adapters/pr.ts";
import { type OmiConfig, repo } from "../../shared/config.ts";
import {
  type CleanupResult,
  parseContract,
  SCHEMA_VERSION,
  StepComment,
} from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "../../shared/github/client.ts";
import { openState, statePath } from "../../shared/sqlite/db.ts";
import {
  acquireLease,
  addArtifact,
  advanceRun,
  claimedRefs,
  latestRun,
  liveRun,
  type RunRow,
  releaseLease,
  runContext,
  upsertReport,
} from "../../task-run/adapters/repository.ts";
import { git } from "../../task-run/adapters/worktree.ts";
import { type ReportDeps, START_LEASE_MS, type TaskDeps } from "../../task-run/cli/common.ts";
import { PRE_MERGE, PROJECT_STATUS } from "../../task-run/domain/fsm.ts";
import { applyRetention, cleanupRun } from "../adapters/cleanup.ts";

export interface FinalizeResult {
  run: RunRow;
  receipt: MergeReceipt | null;
  cleanup: CleanupResult | null;
  report: string | null;
  status: StatusChange[];
  /** Why the nearest parent did not roll up (DevTask-0029 #60), if it did not. */
  held?: string;
  /** github.model v2: the `omi sync` that replaced the direct Status writes. */
  engine?: EngineOutcome;
}

/**
 * Proof that a task without a PR left nothing behind on GitHub: the Issue is closed and the branch
 * was never pushed. Local commits are checked by cleanup (`noCode`), which owns the clone.
 */
function noCodeProof(cwd: string, config: OmiConfig, issue: number, branch: string, gh: GhRunner) {
  const { owner, repo: name } = config.github;
  const state = graphql(
    "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){state}}}",
    { owner, repo: name, number: issue },
    z.strictObject({
      repository: z.strictObject({ issue: z.strictObject({ state: z.string() }).nullable() }),
    }),
    "issue state",
    gh,
  ).repository.issue?.state;
  if (state !== "CLOSED") {
    throw new OmiError("POLICY_VIOLATION", `no PR for ${branch} and #${issue} is still open`);
  }
  if (git(["ls-remote", "--heads", "origin", branch], repo(cwd).root)) {
    throw new OmiError("POLICY_VIOLATION", `no PR, but ${branch} exists on origin`);
  }
  return true;
}

function cleanupComment(
  run: RunRow,
  round: number,
  receipt: MergeReceipt | undefined,
  r: CleanupResult,
  render: ReportDeps["reports"]["render"],
) {
  const failed = r.steps.filter((s) => s.status === "failed");
  const comment: StepComment = {
    schemaVersion: SCHEMA_VERSION,
    issue: { repository: run.repository, number: run.issue },
    workflowRunId: run.id,
    category: "cleanup",
    workflow: run.workflow,
    stepId: "cleanup",
    stepTitle: "Cleanup sau merge",
    round: Math.min(Math.max(round, 1), 4),
    attempt: 1, // one cleanup comment per run: a replay updates it in place
    executor: "omi-cli",
    requestedModel: null,
    actualModel: null,
    requestedEffort: null,
    actualEffort: null,
    status: r.state === "COMPLETED" ? "PASSED" : "FAILED",
    summary: [
      receipt
        ? `PR #${receipt.number} merged ${receipt.mergedAt} (head ${receipt.headSha.slice(0, 12)}).`
        : "No PR: task without code.",
      ...r.steps.map(
        (s) => `- ${s.name}: ${s.status}${s.detail ? ` — ${s.detail.slice(0, 120)}` : ""}`,
      ),
    ].join("\n"),
    changedFiles: [],
    evidencePaths: [],
    findings: failed.map((s, i) => ({
      id: `CLN-${String(i + 1).padStart(3, "0")}`,
      severity: "high" as const,
      observed: `${s.name}: ${s.detail ?? "failed"}`,
      expected: "every owned resource verified and released without --force",
    })),
    nextAction:
      r.state === "COMPLETED"
        ? "None: task Done; parents rolled up."
        : "Fix the failed step, then rerun `omi task finalize`; resources were kept.",
    executionId: `${run.id}-cleanup`,
    createdAt: new Date().toISOString(),
    ...(receipt?.mergeCommit ? { commitSha: receipt.mergeCommit } : {}),
  };
  return render(parseContract(StepComment, comment, "cleanup comment"));
}

export function taskFinalize(
  deps: TaskDeps & ReportDeps & { dryRun?: boolean; sleep?: (ms: number) => void },
  issue: number,
): FinalizeResult {
  const gh = deps.gh ?? spawnGh;
  const { config } = repo(deps.cwd);
  const file = statePath(deps.cwd);
  const db = openState(file);
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const primary = `${ref.repository}#${issue}`;
  const lease = `task:${primary}`;
  const session = deps.session ?? randomUUID();
  try {
    acquireLease(db, { key: lease, holder: session, ttlMs: START_LEASE_MS });
    try {
      let run = liveRun(db, ref) ?? latestRun(db, ref);
      if (!run) throw new OmiError("POLICY_VIOLATION", `no run for ${primary}`);
      const runId = run.id;
      if (run.state === "COMPLETED") {
        // Cleanup and its report are done; only the Project projection may be behind.
        if (isV2(config)) {
          const engine = deps.dryRun ? undefined : lifecycleSync({ ...deps, gh });
          return {
            run,
            receipt: null,
            cleanup: null,
            report: null,
            status: [],
            ...(engine ? { engine } : {}),
          };
        }
        const fin = deps.dryRun ? { changes: [] } : markFinished(config, issue, gh);
        return {
          run,
          receipt: null,
          cleanup: null,
          report: null,
          status: fin.changes,
          held: fin.held,
        };
      }
      const branch = claimedRefs(db, runId, "branch")[0];
      if (!branch) throw new OmiError("OWNERSHIP_MISMATCH", `${primary} never owned a branch`);
      const base = config.git.baseBranch;
      const facts = prFacts(config, { head: branch, base, states: ["OPEN", "MERGED"] }, gh);
      const receipt = receiptOf(facts.pr);
      // No PR at all: a task without code (Spike, Issue-only) may still be finalized.
      const noCode = facts.count === 0 ? noCodeProof(deps.cwd, config, issue, branch, gh) : null;
      if (!noCode && (!receipt || receipt.baseRef !== base)) {
        throw new OmiError("POLICY_VIOLATION", `${branch} has no PR merged into ${base}`);
      }
      if (receipt) {
        const marked = markedPrimaries(facts.pr?.body ?? "");
        // PRs opened before `omi pr create` carry no marker: GitHub's closing link is the proof.
        const named = marked.length
          ? marked.includes(primary)
          : closingIssues(facts.pr?.id ?? "", { run: gh, sleep: deps.sleep }).join() === primary;
        if (!named) {
          throw new OmiError(
            "POLICY_VIOLATION",
            `merged PR #${receipt.number} does not name ${primary}`,
          );
        }
      }
      const cleanOpts = {
        runId,
        receipt,
        tempRoot: dirname(file),
        ...(noCode ? { noCode: { base } } : {}),
      };
      if (deps.dryRun) {
        const cleanup = cleanupRun(db, { ...cleanOpts, dryRun: true });
        return { run, receipt: receipt ?? null, cleanup, report: null, status: [] };
      }

      deps.reports.publish(db, runId, { gh }); // earlier reports first: progress waits for them
      const state = () => runContext(db, runId).state;
      if ([...PRE_MERGE, "BLOCKED", "WAITING_PO"].includes(state())) {
        advanceRun(db, runId, { type: noCode ? "NO_CODE_VERIFIED" : "MERGE_VERIFIED" });
      }
      if (["PR_MERGED", "CLEANUP_FAILED"].includes(state())) {
        advanceRun(db, runId, { type: "CLEANUP_STARTED" });
      }
      if (state() !== "CLEANUP_PENDING") {
        throw new OmiError("INVALID_TRANSITION", `run ${runId} is ${state()}: cannot finalize`);
      }

      const evidence = join(dirname(file), "evidence", runId);
      mkdirSync(evidence, { recursive: true });
      const receiptFile = join(evidence, "merge-receipt.json");
      if (receipt && !existsSync(receiptFile)) {
        writeFileSync(receiptFile, `${JSON.stringify(receipt, null, 2)}\n`);
        addArtifact(db, { runId, kind: "evidence", path: receiptFile });
      }
      applyRetention(db, {
        evidenceRoot: dirname(evidence),
        days: config.cleanup.logRetentionDays,
      });

      const cleanup = cleanupRun(db, cleanOpts);
      writeFileSync(join(evidence, "cleanup-result.json"), `${JSON.stringify(cleanup, null, 2)}\n`);
      const report = cleanupComment(
        run,
        runContext(db, runId).round,
        receipt,
        cleanup,
        deps.reports.render,
      );
      upsertReport(db, { runId, marker: report.split("\n")[0] as string, body: report });
      deps.reports.publish(db, runId, { gh }); // throws: the run stays CLEANUP_PENDING, retry resumes

      if (cleanup.state === "CLEANUP_FAILED") {
        run = advanceRun(db, runId, { type: "CLEANUP_ERROR" }).run;
        // v2 has no Cleanup failed status (Blocked needs a blocker): the run state and the cleanup
        // comment carry it, and the Project Status is left to the engine.
        const blocked = isV2(config)
          ? null
          : setStatus(config, issue, PROJECT_STATUS.CLEANUP_FAILED, gh);
        return { run, receipt: receipt ?? null, cleanup, report, status: blocked ? [blocked] : [] };
      }
      run = advanceRun(db, runId, { type: "CLEANUP_SUCCEEDED" }).run;
      // COMPLETED is recorded first; a failure below is repaired by rerunning finalize.
      if (isV2(config)) {
        // v2: `omi sync` closes/Done the Issue and rolls the parents up (`auto` rules).
        const engine = lifecycleSync({ ...deps, gh });
        return { run, receipt: receipt ?? null, cleanup, report, status: [], engine };
      }
      const fin = markFinished(config, issue, gh);
      return {
        run,
        receipt: receipt ?? null,
        cleanup,
        report,
        status: fin.changes,
        held: fin.held,
      };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}
