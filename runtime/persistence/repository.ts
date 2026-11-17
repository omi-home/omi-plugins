// Run/step repository. Every write is one transaction; state changes are compare-and-set so a
// stale writer fails instead of overwriting. Which transitions are legal is the FSM's job (T2.3).
import {
  type ArtifactKind,
  type IssueRef,
  IssueType,
  parseContract,
  type ResourceKind,
  type ReviewOutcome,
  type Role,
  StepResult,
  StepState,
  WorkflowContext,
  WorkflowEventType,
  WorkflowState,
} from "../core/contracts.ts";
import { type ErrorCode, OmiError } from "../core/errors/errors.ts";
import {
  initialContext,
  POLICY,
  type Policy,
  transition,
  type WorkflowEvent,
} from "../core/workflow-engine/fsm.ts";
import { type Db, tx } from "./db.ts";

const iso = () => new Date().toISOString();
const LIVE_EXCLUDED = ["COMPLETED", "FAILED", "CANCELLED"] satisfies WorkflowState[];

export interface RunRow {
  id: string;
  repository: string;
  issue: number;
  /** ponytail: the run's workflow is its OMI Issue type until the workflow catalogue (spec §10) composes stages. */
  workflow: IssueType;
  state: WorkflowState;
}

const toRun = (r: Record<string, unknown> | undefined): RunRow | undefined =>
  r && {
    id: String(r.id),
    repository: String(r.repository),
    issue: Number(r.issue),
    workflow: IssueType.parse(r.workflow),
    state: WorkflowState.parse(r.state),
  };

export function createRun(db: Db, o: { id: string; issue: IssueRef; workflow: IssueType }): RunRow {
  return tx(db, "create run", () => {
    const now = iso();
    try {
      db.prepare(
        "INSERT INTO workflow_run (id, repository, issue, workflow, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'CREATED', ?, ?)",
      ).run(o.id, o.issue.repository, o.issue.number, o.workflow, now, now);
    } catch (e) {
      if ((e as { errcode?: number }).errcode === 2067) {
        throw new OmiError("OWNERSHIP_MISMATCH", `issue #${o.issue.number} already has a live run`);
      }
      throw e;
    }
    db.prepare(
      "INSERT INTO transition (run_id, from_state, to_state, event, at) VALUES (?, NULL, 'CREATED', 'create', ?)",
    ).run(o.id, now);
    return getRun(db, o.id) as RunRow;
  });
}

export const getRun = (db: Db, id: string): RunRow | undefined =>
  toRun(db.prepare("SELECT * FROM workflow_run WHERE id = ?").get(id));

export const liveRun = (db: Db, issue: IssueRef): RunRow | undefined =>
  toRun(
    db
      .prepare(
        `SELECT * FROM workflow_run WHERE repository = ? AND issue = ? AND state NOT IN (${LIVE_EXCLUDED.map(() => "?").join(", ")})`,
      )
      .get(issue.repository, issue.number, ...LIVE_EXCLUDED),
  );

/** Compare-and-set state change plus its audit row. Throws if the run is no longer in `from`. */
export function transitionRun(
  db: Db,
  o: { runId: string; from: WorkflowState; to: WorkflowState; event: WorkflowEventType },
): RunRow {
  return tx(db, "transition run", () => {
    const now = iso();
    const r = db
      .prepare("UPDATE workflow_run SET state = ?, updated_at = ? WHERE id = ? AND state = ?")
      .run(o.to, now, o.runId, o.from);
    if (r.changes !== 1) {
      throw new OmiError("INVALID_TRANSITION", `run ${o.runId} is not in ${o.from}`, {
        actual: getRun(db, o.runId)?.state ?? null,
      });
    }
    db.prepare(
      "INSERT INTO transition (run_id, from_state, to_state, event, at) VALUES (?, ?, ?, ?, ?)",
    ).run(o.runId, o.from, o.to, o.event, now);
    return getRun(db, o.runId) as RunRow;
  });
}

export const transitions = (db: Db, runId: string) =>
  db
    .prepare("SELECT from_state, to_state, event FROM transition WHERE run_id = ? ORDER BY id")
    .all(runId)
    .map((r) => ({
      from: r.from_state === null ? null : WorkflowState.parse(r.from_state),
      to: WorkflowState.parse(r.to_state),
      event: r.event === "create" ? ("create" as const) : WorkflowEventType.parse(r.event),
    }));

// ---- FSM-backed transitions (spec §10) ----

const REVIEWERS: readonly Role[] = ["code-reviewer", "security-reviewer"];
const REVIEW_REPORTED = ["REPORT_POSTED", "PASSED", "FAILED"] satisfies StepState[];

/** Stored FSM context; runs created before migration 3 start from their state. */
export function runContext(db: Db, runId: string): WorkflowContext {
  const r = db.prepare("SELECT state, context FROM workflow_run WHERE id = ?").get(runId);
  if (!r) throw new OmiError("INVALID_TRANSITION", `run ${runId} does not exist`);
  const state = WorkflowState.parse(r.state);
  if (r.context === null) return { ...initialContext(), state };
  const ctx = parseContract(WorkflowContext, JSON.parse(String(r.context)), "workflow context");
  if (ctx.state !== state) {
    throw new OmiError("INVALID_TRANSITION", `run ${runId}: context ${ctx.state} ≠ state ${state}`);
  }
  return ctx;
}

/**
 * The only way a run moves: FSM decides (with facts read in the same transaction), then state,
 * context and audit row commit together, compare-and-set on the state read. A review verdict
 * needs the reviewer's report for that round posted first (spec §12); it records the round.
 */
export function advanceRun(
  db: Db,
  runId: string,
  event: WorkflowEvent,
  policy: Policy = POLICY,
): { run: RunRow; context: WorkflowContext } {
  return tx(db, "advance run", () => {
    const ctx = runContext(db, runId);
    const pending = Number(
      db
        .prepare("SELECT count(*) AS n FROM outbox WHERE run_id = ? AND state = 'PENDING'")
        .get(runId)?.n,
    );
    const verdict =
      event.type === "REVIEW_PASSED" ? "PASSED" : event.type === "REVIEW_FAILED" ? "FAILED" : null;
    if (verdict && ctx.state === "RUNNING") {
      const reported = db
        .prepare(
          `SELECT 1 FROM step_run WHERE run_id = ? AND round = ? AND role IN (${REVIEWERS.map(() => "?").join(", ")}) AND state IN (${REVIEW_REPORTED.map(() => "?").join(", ")}) AND json_extract(result, '$.status') = ?`,
        )
        .get(runId, ctx.round, ...REVIEWERS, ...REVIEW_REPORTED, verdict);
      if (!reported) {
        throw new OmiError(
          "POLICY_VIOLATION",
          `review round ${ctx.round} has no posted reviewer report saying ${verdict}: verdict refused`,
        );
      }
    }
    const next = transition(ctx, event, { pendingReports: pending }, policy);
    const now = iso();
    const r = db
      .prepare(
        "UPDATE workflow_run SET state = ?, context = ?, updated_at = ? WHERE id = ? AND state = ?",
      )
      .run(next.state, JSON.stringify(next), now, runId, ctx.state);
    if (r.changes !== 1) {
      throw new OmiError("INVALID_TRANSITION", `run ${runId} is not in ${ctx.state}`);
    }
    db.prepare(
      "INSERT INTO transition (run_id, from_state, to_state, event, at) VALUES (?, ?, ?, ?, ?)",
    ).run(runId, ctx.state, next.state, event.type, now);
    if (verdict && ctx.state === "RUNNING") {
      db.prepare(
        "INSERT INTO review_round (run_id, round, outcome, created_at) VALUES (?, ?, ?, ?)",
      ).run(runId, ctx.round, verdict, now);
    }
    return { run: getRun(db, runId) as RunRow, context: next };
  });
}

export function recordReviewRound(
  db: Db,
  o: { runId: string; round: number; outcome: ReviewOutcome },
): void {
  tx(db, "record review round", () => {
    db.prepare(
      "INSERT INTO review_round (run_id, round, outcome, created_at) VALUES (?, ?, ?, ?)",
    ).run(o.runId, o.round, o.outcome, iso());
  });
}

export const reviewRounds = (db: Db, runId: string): number =>
  Number(db.prepare("SELECT count(*) AS n FROM review_round WHERE run_id = ?").get(runId)?.n);

// ---- Steps and attempts ----

export interface StepRow {
  id: number;
  runId: string;
  stepId: string;
  round: number;
  state: StepState;
}

const toStep = (r: Record<string, unknown> | undefined): StepRow | undefined =>
  r && {
    id: Number(r.id),
    runId: String(r.run_id),
    stepId: String(r.step_id),
    round: Number(r.round),
    state: StepState.parse(r.state),
  };

export const getStep = (db: Db, id: number): StepRow | undefined =>
  toStep(db.prepare("SELECT * FROM step_run WHERE id = ?").get(id));

/** The persisted (already verified) result of a step, re-validated on read. */
export function stepResult(db: Db, id: number): StepResult {
  const r = db.prepare("SELECT result FROM step_run WHERE id = ?").get(id);
  if (!r || r.result === null) throw new OmiError("INVALID_TRANSITION", `step ${id} has no result`);
  return parseContract(StepResult, JSON.parse(String(r.result)), "stored step result");
}

/** Idempotent: the same (run, step, round) always maps to one row. */
export function startStep(
  db: Db,
  o: { runId: string; stepId: string; round: number; role: Role },
): StepRow {
  return tx(db, "start step", () => {
    const now = iso();
    db.prepare(
      "INSERT INTO step_run (run_id, step_id, round, role, state, created_at, updated_at) VALUES (?, ?, ?, ?, 'PENDING', ?, ?) ON CONFLICT (run_id, step_id, round) DO NOTHING",
    ).run(o.runId, o.stepId, o.round, o.role, now, now);
    return toStep(
      db
        .prepare("SELECT * FROM step_run WHERE run_id = ? AND step_id = ? AND round = ?")
        .get(o.runId, o.stepId, o.round),
    ) as StepRow;
  });
}

/** Opens the next technical attempt and marks the step RUNNING. Returns the attempt number. */
export function beginAttempt(db: Db, stepRunId: number): number {
  return tx(db, "begin attempt", () => {
    const open = db
      .prepare("SELECT attempt FROM step_attempt WHERE step_run_id = ? AND finished_at IS NULL")
      .get(stepRunId);
    if (open) {
      throw new OmiError(
        "INVALID_TRANSITION",
        `step ${stepRunId} attempt ${open.attempt} is still open: fail or finish it first`,
      );
    }
    const next =
      Number(
        db
          .prepare("SELECT max(attempt) AS n FROM step_attempt WHERE step_run_id = ?")
          .get(stepRunId)?.n ?? 0,
      ) + 1;
    const now = iso();
    db.prepare("INSERT INTO step_attempt (step_run_id, attempt, started_at) VALUES (?, ?, ?)").run(
      stepRunId,
      next,
      now,
    );
    setStepState(db, stepRunId, ["PENDING", "RUNNING"], "RUNNING", now);
    return next;
  });
}

function setStepState(db: Db, id: number, from: StepState[], to: StepState, now: string) {
  const r = db
    .prepare(
      `UPDATE step_run SET state = ?, updated_at = ? WHERE id = ? AND state IN (${from.map(() => "?").join(", ")})`,
    )
    .run(to, now, id, ...from);
  if (r.changes !== 1) {
    throw new OmiError("INVALID_TRANSITION", `step ${id} is not in ${from.join("/")}`, {
      actual: getStep(db, id)?.state ?? null,
    });
  }
}

/** Closes an attempt that failed technically: the step stays in its round (spec §10). */
export function failAttempt(
  db: Db,
  o: { stepRunId: number; attempt: number; errorCode: ErrorCode },
): void {
  tx(db, "fail attempt", () => {
    const now = iso();
    const r = db
      .prepare(
        "UPDATE step_attempt SET finished_at = ?, error_code = ? WHERE step_run_id = ? AND attempt = ? AND finished_at IS NULL",
      )
      .run(now, o.errorCode, o.stepRunId, o.attempt);
    if (r.changes !== 1) {
      throw new OmiError("INVALID_TRANSITION", `attempt ${o.attempt} is not open`);
    }
    setStepState(db, o.stepRunId, ["RUNNING"], "PENDING", now);
  });
}

/**
 * Dispatch invariant, first half (spec §5): the result and its pending report commit together.
 * Either both exist afterwards or neither does.
 */
export function persistStepResult(
  db: Db,
  o: {
    stepRunId: number;
    attempt: number;
    result: StepResult;
    actualModel: string | null;
    report: { marker: string; body: string };
  },
): void {
  tx(db, "persist step result", () => {
    const now = iso();
    const step = getStep(db, o.stepRunId);
    const a = db
      .prepare(
        "UPDATE step_attempt SET finished_at = ?, actual_model = ? WHERE step_run_id = ? AND attempt = ? AND finished_at IS NULL",
      )
      .run(now, o.actualModel, o.stepRunId, o.attempt);
    if (!step || a.changes !== 1) {
      throw new OmiError(
        "INVALID_TRANSITION",
        `attempt ${o.attempt} of step ${o.stepRunId} is not open`,
      );
    }
    setStepState(db, o.stepRunId, ["RUNNING"], "REPORT_PENDING", now);
    db.prepare("UPDATE step_run SET result = ? WHERE id = ?").run(
      JSON.stringify(o.result),
      o.stepRunId,
    );
    db.prepare(
      "INSERT INTO outbox (run_id, step_run_id, marker, body, state, created_at) VALUES (?, ?, ?, ?, 'PENDING', ?)",
    ).run(step.runId, o.stepRunId, o.report.marker, o.report.body, now);
  });
}

export interface PendingReport {
  marker: string;
  body: string;
  /** Issue the comment goes on: the run's own Issue unless the report targets another one. */
  target: IssueRef;
}

export const pendingReports = (db: Db, runId: string): PendingReport[] =>
  db
    .prepare(
      "SELECT o.marker, o.body, coalesce(o.repository, r.repository) AS repository, coalesce(o.issue, r.issue) AS issue FROM outbox o JOIN workflow_run r ON r.id = o.run_id WHERE o.run_id = ? AND o.state = 'PENDING' ORDER BY o.id",
    )
    .all(runId)
    .map((r) => ({
      marker: String(r.marker),
      body: String(r.body),
      target: { repository: String(r.repository), number: Number(r.issue) },
    }));

/**
 * Queues a report that is not a step result (e.g. carried findings on another Issue).
 * Idempotent per marker: re-queueing an existing marker keeps the first record.
 */
export function enqueueReport(
  db: Db,
  o: { runId: string; marker: string; body: string; target?: IssueRef },
): void {
  tx(db, "enqueue report", () => {
    db.prepare(
      "INSERT INTO outbox (run_id, marker, body, state, repository, issue, created_at) VALUES (?, ?, ?, 'PENDING', ?, ?, ?) ON CONFLICT (marker) DO NOTHING",
    ).run(o.runId, o.marker, o.body, o.target?.repository ?? null, o.target?.number ?? null, iso());
  });
}

/** Dispatch invariant, second half: the comment exists on GitHub; the step may move on. */
export function markReported(
  db: Db,
  o: { marker: string; commentId: string; commentUrl: string },
): void {
  tx(db, "mark reported", () => {
    const now = iso();
    const row = db
      .prepare("SELECT step_run_id FROM outbox WHERE marker = ? AND state = 'PENDING'")
      .get(o.marker);
    if (!row) return; // already POSTED: replay is a no-op
    db.prepare(
      "UPDATE outbox SET state = 'POSTED', comment_id = ?, comment_url = ?, posted_at = ? WHERE marker = ?",
    ).run(o.commentId, o.commentUrl, now, o.marker);
    if (row.step_run_id !== null) {
      setStepState(db, Number(row.step_run_id), ["REPORT_PENDING"], "REPORT_POSTED", now);
    }
  });
}

export function addArtifact(
  db: Db,
  o: { runId: string; stepRunId?: number; kind: ArtifactKind; path: string; sha256?: string },
): void {
  tx(db, "add artifact", () => {
    db.prepare(
      "INSERT INTO artifact (run_id, step_run_id, kind, path, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(o.runId, o.stepRunId ?? null, o.kind, o.path, o.sha256 ?? null, iso());
  });
}

// ---- Ownership and leases ----

/** Idempotent for the owning run; another run claiming a live resource gets OWNERSHIP_MISMATCH. */
export function claimResource(db: Db, o: { runId: string; kind: ResourceKind; ref: string }): void {
  tx(db, "claim resource", () => {
    const owner = db
      .prepare(
        "SELECT run_id FROM resource_owner WHERE kind = ? AND ref = ? AND released_at IS NULL",
      )
      .get(o.kind, o.ref);
    if (owner?.run_id === o.runId) return;
    if (owner) {
      throw new OmiError("OWNERSHIP_MISMATCH", `${o.kind} is owned by run ${owner.run_id}`, {
        ref: o.ref,
      });
    }
    db.prepare(
      "INSERT INTO resource_owner (run_id, kind, ref, created_at) VALUES (?, ?, ?, ?)",
    ).run(o.runId, o.kind, o.ref, iso());
  });
}

export function releaseResource(
  db: Db,
  o: { runId: string; kind: ResourceKind; ref: string },
): void {
  tx(db, "release resource", () => {
    db.prepare(
      "UPDATE resource_owner SET released_at = ? WHERE run_id = ? AND kind = ? AND ref = ? AND released_at IS NULL",
    ).run(iso(), o.runId, o.kind, o.ref);
  });
}

export const resourceOwner = (db: Db, kind: ResourceKind, ref: string): string | undefined => {
  const r = db
    .prepare("SELECT run_id FROM resource_owner WHERE kind = ? AND ref = ? AND released_at IS NULL")
    .get(kind, ref);
  return r ? String(r.run_id) : undefined;
};

/**
 * Exclusive lease with expiry (spec §13). Acquire succeeds when free, expired, or already ours
 * (which renews it). A crashed holder stops blocking once its lease expires.
 */
export function acquireLease(
  db: Db,
  o: { key: string; holder: string; ttlMs: number; now?: number },
): void {
  const now = o.now ?? Date.now();
  tx(db, "acquire lease", () => {
    const r = db
      .prepare(
        "INSERT INTO lease (key, holder, expires_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET holder = excluded.holder, expires_at = excluded.expires_at WHERE lease.holder = excluded.holder OR lease.expires_at <= ?",
      )
      .run(o.key, o.holder, now + o.ttlMs, now);
    if (r.changes !== 1) {
      const held = db.prepare("SELECT expires_at FROM lease WHERE key = ?").get(o.key);
      throw new OmiError("LOCK_HELD", `${o.key} is leased by another session`, {
        expiresAt: new Date(Number(held?.expires_at)).toISOString(),
      });
    }
  });
}

export function releaseLease(db: Db, o: { key: string; holder: string }): void {
  tx(db, "release lease", () => {
    db.prepare("DELETE FROM lease WHERE key = ? AND holder = ?").run(o.key, o.holder);
  });
}

/**
 * Hands live resources of finished runs (COMPLETED/FAILED/CANCELLED) of the same Issue to `runId`,
 * so a new run can resume the preserved workspace (#28 CR-001). Returns the number moved.
 */
export function adoptResources(db: Db, o: { runId: string; issue: IssueRef }): number {
  return tx(db, "adopt resources", () =>
    Number(
      db
        .prepare(
          `UPDATE resource_owner SET run_id = ? WHERE released_at IS NULL AND run_id IN (SELECT id FROM workflow_run WHERE repository = ? AND issue = ? AND state IN (${LIVE_EXCLUDED.map(() => "?").join(", ")}))`,
        )
        .run(o.runId, o.issue.repository, o.issue.number, ...LIVE_EXCLUDED).changes,
    ),
  );
}

/** Live refs of one kind owned by a run, oldest first. */
export const ownedRefs = (db: Db, runId: string, kind: ResourceKind): string[] =>
  db
    .prepare(
      "SELECT ref FROM resource_owner WHERE run_id = ? AND kind = ? AND released_at IS NULL ORDER BY id",
    )
    .all(runId, kind)
    .map((r) => String(r.ref));

/** Most recent run of an Issue, live or not. */
export const latestRun = (db: Db, issue: IssueRef): RunRow | undefined =>
  toRun(
    db
      .prepare(
        "SELECT * FROM workflow_run WHERE repository = ? AND issue = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(issue.repository, issue.number),
  );

/**
 * Queues a report whose content may change on replay (the one cleanup comment of a run): a new
 * body re-opens the outbox row, and the publisher PATCHes the comment found by its marker.
 */
export function upsertReport(db: Db, o: { runId: string; marker: string; body: string }): void {
  tx(db, "upsert report", () => {
    db.prepare(
      "INSERT INTO outbox (run_id, marker, body, state, created_at) VALUES (?, ?, ?, 'PENDING', ?) ON CONFLICT (marker) DO UPDATE SET body = excluded.body, state = 'PENDING' WHERE outbox.body <> excluded.body",
    ).run(o.runId, o.marker, o.body, iso());
  });
}

/** Every ref of one kind a run ever claimed, released or not, oldest first. */
export const claimedRefs = (db: Db, runId: string, kind: ResourceKind): string[] =>
  db
    .prepare("SELECT ref FROM resource_owner WHERE run_id = ? AND kind = ? ORDER BY id")
    .all(runId, kind)
    .map((r) => String(r.ref));

/** Runs that are not finished for good: candidates for startup reconciliation. */
export const openRuns = (db: Db): RunRow[] =>
  db
    .prepare(
      "SELECT * FROM workflow_run WHERE state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED') ORDER BY created_at, rowid",
    )
    .all()
    .map((r) => toRun(r) as RunRow);

export const pendingCount = (db: Db, runId: string): number =>
  Number(
    db.prepare("SELECT count(*) AS n FROM outbox WHERE run_id = ? AND state = 'PENDING'").get(runId)
      ?.n,
  );

/** True while someone holds an unexpired lease on `key`. */
export const leaseActive = (db: Db, key: string, now = Date.now()): boolean =>
  db.prepare("SELECT 1 FROM lease WHERE key = ? AND expires_at > ?").get(key, now) !== undefined;

/** Open attempts of a run's steps (a crash leaves them open). */
export const openAttempts = (db: Db, runId: string): { stepRunId: number; attempt: number }[] =>
  db
    .prepare(
      "SELECT a.step_run_id, a.attempt FROM step_attempt a JOIN step_run s ON s.id = a.step_run_id WHERE s.run_id = ? AND a.finished_at IS NULL",
    )
    .all(runId)
    .map((r) => ({ stepRunId: Number(r.step_run_id), attempt: Number(r.attempt) }));

/**
 * Crash recovery (#24 CR-003): closes the run's open attempts with CRASH_RECOVERED and puts their
 * steps back to PENDING so `beginAttempt` can retry, but only while nobody holds `leaseKey`
 * (the run lease of a live `omi task run`). Checked and written in one transaction, so a
 * session that starts meanwhile is never cut off. Returns the number of attempts closed.
 */
export function recoverAttempts(
  db: Db,
  o: { runId: string; leaseKey: string; now?: number },
): number {
  return tx(db, "recover attempts", () => {
    if (leaseActive(db, o.leaseKey, o.now)) return 0;
    const open = openAttempts(db, o.runId);
    const at = iso();
    for (const a of open) {
      db.prepare(
        "UPDATE step_attempt SET finished_at = ?, error_code = 'CRASH_RECOVERED' WHERE step_run_id = ? AND attempt = ? AND finished_at IS NULL",
      ).run(at, a.stepRunId, a.attempt);
      db.prepare(
        "UPDATE step_run SET state = 'PENDING', updated_at = ? WHERE id = ? AND state = 'RUNNING'",
      ).run(at, a.stepRunId);
    }
    return open.length;
  });
}

/** Every live ref of one kind, whoever owns it. */
export const liveRefs = (db: Db, kind: ResourceKind): string[] =>
  db
    .prepare("SELECT ref FROM resource_owner WHERE kind = ? AND released_at IS NULL")
    .all(kind)
    .map((r) => String(r.ref));
