// `omi task unblock <n> [--reason]` (G6-003, #123): a person clears a BLOCKED run through the
// FSM (UNBLOCK → its resume point); the step an agent reported BLOCKED runs again on the next
// `omi task run`. One report comment names who unblocked it and why. No agent is run.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { type StatusChange, setStatus } from "../../github/adapters/project.ts";
import { type EngineOutcome, isV2, lifecycleSync } from "../../github/cli/lifecycle.ts";
import { repo } from "../../shared/config.ts";
import {
  commentMarker,
  parseContract,
  SCHEMA_VERSION,
  StepComment,
  type WorkflowContext,
} from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { graphql, spawnGh } from "../../shared/github/client.ts";
import { openState, statePath } from "../../shared/sqlite/db.ts";
import {
  acquireLease,
  advanceRun,
  enqueueReport,
  liveRun,
  releaseLease,
  runContext,
  transitions,
} from "../adapters/repository.ts";
import { PROJECT_STATUS, transition } from "../domain/fsm.ts";
import type { RunRow } from "../domain/run.ts";
import { type ReportDeps, START_LEASE_MS, type TaskDeps } from "./common.ts";

export interface UnblockResult {
  run: RunRow;
  state: WorkflowContext["state"];
  by: string;
  status: StatusChange | null;
  /** github.model v2: the `omi sync` that replaced the direct Status write. */
  engine?: EngineOutcome;
}

export function taskUnblock(
  deps: TaskDeps & ReportDeps & { reason?: string },
  issue: number,
): UnblockResult {
  const gh = deps.gh ?? spawnGh;
  const { config } = repo(deps.cwd);
  const db = openState(statePath(deps.cwd));
  const ref = { repository: `${config.github.owner}/${config.github.repo}`, number: issue };
  const lease = `task:${ref.repository}#${issue}`;
  const session = deps.session ?? randomUUID();
  try {
    acquireLease(db, { key: lease, holder: session, ttlMs: START_LEASE_MS });
    try {
      const found = liveRun(db, ref);
      if (found?.state !== "BLOCKED") {
        throw new OmiError(
          "INVALID_TRANSITION",
          `#${issue} is ${found?.state ?? "not running"}: only a BLOCKED run can be unblocked`,
        );
      }
      // Everything that can fail runs before the run moves: a refused unblock changes nothing.
      // Earlier reports first, so the blocking step is REPORT_POSTED when UNBLOCK reopens it.
      deps.reports.publish(db, found.id, { gh });
      const by = graphql(
        "{viewer{login}}",
        {},
        z.strictObject({ viewer: z.strictObject({ login: z.string() }) }),
        "github-auth",
        gh,
      ).viewer.login;
      const next = transition(runContext(db, found.id), { type: "UNBLOCK" }); // pure: may throw
      const n = transitions(db, found.id).filter((t) => t.event === "UNBLOCK").length + 1;
      const comment = parseContract(
        StepComment,
        {
          schemaVersion: SCHEMA_VERSION,
          issue: ref,
          workflowRunId: found.id,
          category: "unblock",
          workflow: found.workflow,
          stepId: "unblock",
          stepTitle: "Gỡ block",
          round: Math.min(Math.max(next.round, 1), 4),
          attempt: n, // one comment per unblock
          executor: "omi-cli",
          requestedModel: null,
          actualModel: null,
          requestedEffort: null,
          actualEffort: null,
          status: "PASSED",
          summary: [
            `Unblocked by GitHub user ${by}; resumes in ${next.state}.`,
            `Reason: ${deps.reason?.trim() || "(none given)"}`,
          ].join("\n"),
          nextAction: `\`omi task run ${issue}\` re-runs the step that blocked the run.`,
          executionId: `${found.id}-unblock-${n}`,
          createdAt: new Date().toISOString(),
        },
        "unblock comment",
      );
      const body = deps.reports.render(comment);
      const { run, context } = advanceRun(db, found.id, { type: "UNBLOCK" });
      enqueueReport(db, { runId: run.id, marker: commentMarker(comment), body });
      deps.reports.publish(db, run.id, { gh }); // a failure leaves it pending: `task run` posts it
      // A failure here leaves the board behind; `omi task run` sets it from the run state.
      // v2: `omi sync` (Blocked leaves through the blockers_done rule); legacy mirrors the state.
      if (isV2(config)) {
        const engine = lifecycleSync({ cwd: deps.cwd, gh, state: deps.state });
        return { run, state: context.state, by, status: null, engine };
      }
      const status = setStatus(config, issue, PROJECT_STATUS[context.state], gh);
      return { run, state: context.state, by, status };
    } finally {
      releaseLease(db, { key: lease, holder: session });
    }
  } finally {
    db.close();
  }
}
