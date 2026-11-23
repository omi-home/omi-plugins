// DevTask-0086 #264: PID of the attempt, migration from the old schema, alive/dead/missing PID.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import { MIGRATIONS, migrate } from "../../../runtime/shared/sqlite/migrations.ts";
import * as repo from "../../../runtime/task-run/adapters/repository.ts";
import { attemptLiveness, pidAlive } from "../../../runtime/task-run/domain/attempt-liveness.ts";

const errno = (code: string) => () => {
  throw Object.assign(new Error(code), { code });
};

test("pidAlive: live process, ESRCH = dead, EPERM = alive, other errors = unknown", () => {
  assert.equal(pidAlive(process.pid), true);
  assert.equal(
    pidAlive(1, () => true),
    true,
  );
  assert.equal(pidAlive(99999, errno("ESRCH")), false);
  assert.equal(pidAlive(99999, errno("EPERM")), true);
  assert.equal(pidAlive(99999, errno("EINVAL")), null);
  assert.equal(pidAlive(0), null);
  assert.equal(pidAlive(-5), null);
  assert.equal(pidAlive(1.5), null);
});

test("attemptLiveness: open+dead PID is crashed, no PID is unknown, live PID is running", () => {
  assert.equal(attemptLiveness({ pid: 4242 }, errno("ESRCH")), "crashed");
  assert.equal(
    attemptLiveness({ pid: 4242 }, () => true),
    "running",
  );
  assert.equal(attemptLiveness({ pid: null }, errno("ESRCH")), "unknown");
  assert.equal(attemptLiveness({ pid: 4242 }, errno("EINVAL")), "unknown");
  assert.equal(
    attemptLiveness({ pid: 4242, finishedAt: "2026-01-01" }, errno("ESRCH")),
    "finished",
  );
});

test("migration 7: old schema upgrades in place, keeps data, old attempt has null PID", () => {
  const db = new DatabaseSync(":memory:");
  migrate(db, MIGRATIONS.slice(0, 6));
  db.exec(
    "INSERT INTO workflow_run VALUES ('r1','o/r',1,'dev-task','RUNNING','t','t', NULL);" +
      "INSERT INTO step_run VALUES (1,'r1','implement',1,'software-engineer','RUNNING',NULL,'t','t');" +
      "INSERT INTO step_attempt (step_run_id, attempt, started_at) VALUES (1,1,'t');",
  );
  assert.equal(migrate(db), MIGRATIONS.length);
  const row = db.prepare("SELECT attempt, pid FROM step_attempt").get();
  assert.equal(row?.attempt, 1);
  assert.equal(row?.pid, null);
  assert.deepEqual(repo.openAttempts(db as never, "r1"), [{ stepRunId: 1, attempt: 1, pid: null }]);
});

test("beginAttempt stores the PID of this process", () => {
  const db = openState(":memory:");
  repo.createRun(db, { id: "r", issue: { repository: "o/r", number: 1 }, workflow: "dev-task" });
  const step = repo.startStep(db, {
    runId: "r",
    stepId: "implement",
    round: 1,
    role: "software-engineer",
  });
  const attempt = repo.beginAttempt(db, step.id);
  assert.deepEqual(repo.openAttempts(db, "r"), [{ stepRunId: step.id, attempt, pid: process.pid }]);
});
