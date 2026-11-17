// T2.2 state store: migrations, rollback, restart, transaction failure, CAS, ownership, leases.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseContract, StepResult } from "../../runtime/core/contracts.ts";
import { OmiError } from "../../runtime/core/errors/errors.ts";
import { openState, statePath } from "../../runtime/persistence/db.ts";
import { MIGRATIONS, migrate } from "../../runtime/persistence/migrations.ts";
import * as repo from "../../runtime/persistence/repository.ts";

const issue = { repository: "omi-home/omi-plugins", number: 24 };
const dbFile = () => join(mkdtempSync(join(tmpdir(), "omi-state-")), "state.sqlite");
const code = (c: string) => (e: unknown) => e instanceof OmiError && e.code === c;
const version = (db: ReturnType<typeof openState>) =>
  db.prepare("PRAGMA user_version").get()?.user_version;

const result = (runId: string) =>
  parseContract(
    StepResult,
    {
      schemaVersion: 1,
      workflowRunId: runId,
      issue,
      stepId: "implementation",
      round: 1,
      attempt: 1,
      role: "backend-engineer",
      status: "PASSED",
      summary: "done",
    },
    "step",
  );

/** A run with one step whose first attempt is open. */
function running(db: ReturnType<typeof openState>, runId = "run-1") {
  repo.createRun(db, { id: runId, issue, workflow: "dev-task" });
  const step = repo.startStep(db, {
    runId,
    stepId: "implementation",
    round: 1,
    role: "backend-engineer",
  });
  const attempt = repo.beginAttempt(db, step.id);
  return { step, attempt };
}

test("migrate: fresh database reaches latest version; re-run is a no-op", () => {
  const db = openState(":memory:");
  assert.equal(version(db), MIGRATIONS.length);
  assert.equal(migrate(db), MIGRATIONS.length);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name);
  assert.deepEqual(tables, [
    "artifact",
    "lease",
    "outbox",
    "resource_owner",
    "review_round",
    "step_attempt",
    "step_run",
    "transition",
    "workflow_run",
  ]);
});

test("migrate: a failing migration rolls back completely and keeps the previous version", () => {
  const db = openState(":memory:");
  const broken = [...MIGRATIONS, "CREATE TABLE half_done (a); INSERT INTO missing VALUES (1);"];
  assert.throws(() => migrate(db, broken), code("INTERNAL"));
  assert.equal(version(db), MIGRATIONS.length);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE name = 'half_done'").get(),
    undefined,
  );
});

test("migrate: database from a newer OMI is refused", () => {
  const file = dbFile();
  openState(file).exec("PRAGMA user_version = 99");
  assert.throws(() => openState(file), code("SCHEMA_VERSION_UNSUPPORTED"));
});

test("restart: committed state survives close/reopen; pending report is replayable once", () => {
  const file = dbFile();
  let db = openState(file);
  const { step, attempt } = running(db);
  repo.persistStepResult(db, {
    stepRunId: step.id,
    attempt,
    result: result("run-1"),
    actualModel: "claude-sonnet-5-5",
    report: { marker: "<!-- m1 -->", body: "report" },
  });
  db.close(); // crash before the GitHub comment was confirmed

  db = openState(file);
  assert.equal(repo.getStep(db, step.id)?.state, "REPORT_PENDING");
  assert.deepEqual(repo.pendingReports(db, "run-1"), [{ marker: "<!-- m1 -->", body: "report" }]);
  const posted = { marker: "<!-- m1 -->", commentId: "1", commentUrl: "https://x/1" };
  repo.markReported(db, posted);
  repo.markReported(db, posted); // replay: no-op
  assert.equal(repo.getStep(db, step.id)?.state, "REPORT_POSTED");
  assert.deepEqual(repo.pendingReports(db, "run-1"), []);
});

test("transaction failure: result and outbox commit together or not at all", () => {
  const db = openState(":memory:");
  const { step, attempt } = running(db);
  // Another step already holds this marker: the outbox insert fails after the result update.
  repo.createRun(db, { id: "run-2", issue: { ...issue, number: 99 }, workflow: "dev-task" });
  const other = repo.startStep(db, {
    runId: "run-2",
    stepId: "x",
    round: 1,
    role: "backend-engineer",
  });
  repo.persistStepResult(db, {
    stepRunId: other.id,
    attempt: repo.beginAttempt(db, other.id),
    result: result("run-2"),
    actualModel: null,
    report: { marker: "dup", body: "b" },
  });
  const persist = (marker: string) =>
    repo.persistStepResult(db, {
      stepRunId: step.id,
      attempt,
      result: result("run-1"),
      actualModel: null,
      report: { marker, body: "b" },
    });
  assert.throws(() => persist("dup"), code("CONTRACT_INVALID"));
  assert.equal(repo.getStep(db, step.id)?.state, "RUNNING");
  assert.equal(db.prepare("SELECT result FROM step_run WHERE id = ?").get(step.id)?.result, null);
  assert.equal(
    db.prepare("SELECT finished_at FROM step_attempt WHERE step_run_id = ?").get(step.id)
      ?.finished_at,
    null,
  );
  persist("unique"); // the same attempt can still complete
  assert.equal(repo.getStep(db, step.id)?.state, "REPORT_PENDING");
});

test("transitions are compare-and-set and audited", () => {
  const db = openState(":memory:");
  repo.createRun(db, { id: "r", issue, workflow: "dev-task" });
  repo.transitionRun(db, {
    runId: "r",
    from: "CREATED",
    to: "TICKET_VALIDATED",
    event: "validate",
  });
  assert.throws(
    () => repo.transitionRun(db, { runId: "r", from: "CREATED", to: "RUNNING", event: "stale" }),
    code("INVALID_TRANSITION"),
  );
  assert.deepEqual(repo.transitions(db, "r"), [
    { from: null, to: "CREATED", event: "create" },
    { from: "CREATED", to: "TICKET_VALIDATED", event: "validate" },
  ]);
});

test("one live run per issue; a finished run frees the issue", () => {
  const db = openState(":memory:");
  repo.createRun(db, { id: "a", issue, workflow: "dev-task" });
  assert.throws(
    () => repo.createRun(db, { id: "b", issue, workflow: "dev-task" }),
    code("OWNERSHIP_MISMATCH"),
  );
  repo.transitionRun(db, { runId: "a", from: "CREATED", to: "CANCELLED", event: "cancel" });
  repo.createRun(db, { id: "b", issue, workflow: "dev-task" });
  assert.equal(repo.liveRun(db, issue)?.id, "b");
});

test("technical attempts do not create review rounds or new step rows", () => {
  const db = openState(":memory:");
  const { step, attempt } = running(db);
  assert.throws(() => repo.beginAttempt(db, step.id), code("INVALID_TRANSITION"));
  repo.failAttempt(db, { stepRunId: step.id, attempt, errorCode: "NETWORK" });
  assert.equal(repo.beginAttempt(db, step.id), 2);
  assert.equal(
    repo.startStep(db, {
      runId: "run-1",
      stepId: "implementation",
      round: 1,
      role: "backend-engineer",
    }).id,
    step.id,
  );
  assert.equal(repo.reviewRounds(db, "run-1"), 0);
  repo.recordReviewRound(db, { runId: "run-1", round: 1, outcome: "FAILED" });
  assert.equal(repo.reviewRounds(db, "run-1"), 1);
});

test("resource ownership: idempotent for the owner, refused for others until released", () => {
  const db = openState(":memory:");
  repo.createRun(db, { id: "a", issue, workflow: "dev-task" });
  repo.createRun(db, { id: "b", issue: { ...issue, number: 25 }, workflow: "dev-task" });
  const wt = { kind: "worktree" as const, ref: "/w/24" };
  repo.claimResource(db, { runId: "a", ...wt });
  repo.claimResource(db, { runId: "a", ...wt });
  assert.throws(() => repo.claimResource(db, { runId: "b", ...wt }), code("OWNERSHIP_MISMATCH"));
  repo.releaseResource(db, { runId: "a", ...wt });
  repo.claimResource(db, { runId: "b", ...wt });
  assert.equal(repo.resourceOwner(db, "worktree", "/w/24"), "b");
});

test("lease: exclusive until expiry, renewable by its holder", () => {
  const db = openState(":memory:");
  const key = "issue:omi-home/omi-plugins#24";
  repo.acquireLease(db, { key, holder: "A", ttlMs: 1000, now: 0 });
  repo.acquireLease(db, { key, holder: "A", ttlMs: 1000, now: 500 }); // renew → expires 1500
  assert.throws(
    () => repo.acquireLease(db, { key, holder: "B", ttlMs: 1000, now: 1200 }),
    code("LOCK_HELD"),
  );
  repo.acquireLease(db, { key, holder: "B", ttlMs: 1000, now: 1500 }); // A crashed, lease expired
  assert.throws(
    () => repo.acquireLease(db, { key, holder: "A", ttlMs: 1000, now: 1600 }),
    code("LOCK_HELD"),
  );
  repo.releaseLease(db, { key, holder: "A" }); // not the holder: no effect
  assert.throws(() => repo.acquireLease(db, { key, holder: "C", ttlMs: 1, now: 1700 }));
  repo.releaseLease(db, { key, holder: "B" });
  repo.acquireLease(db, { key, holder: "C", ttlMs: 1, now: 1700 });
});

test("statePath: every worktree of a repo shares one database inside .git", () => {
  const main = realpathSync(mkdtempSync(join(tmpdir(), "omi-sp-")));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: main, stdio: "pipe" });
  git("init", "-q");
  git(
    "-c",
    "user.name=o",
    "-c",
    "user.email=o@example.invalid",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "s",
  );
  git("worktree", "add", "-q", "-b", "t", `${main}-wt`);
  const expected = join(main, ".git", "omi", "state.sqlite");
  assert.equal(statePath(main), expected);
  assert.equal(statePath(`${main}-wt`), expected);
  assert.throws(() => statePath(tmpdir()), code("CONFIG_INVALID"));
});
