// T4.4 log retention: only evidence of COMPLETED runs older than logRetentionDays is removed.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { openState } from "../../runtime/persistence/db.ts";
import { createRun, transitionRun } from "../../runtime/persistence/repository.ts";
import { applyRetention } from "../../runtime/resources/cleanup.ts";

test("retention removes old evidence of completed runs only", () => {
  const db = openState(":memory:");
  const root = mkdtempSync(join(tmpdir(), "omi-ret-"));
  const old = new Date(Date.now() - 30 * 86_400_000);
  for (const [id, n] of [
    ["done", 1],
    ["live", 2],
    ["fresh", 3],
  ] as const) {
    createRun(db, { id, issue: { repository: "o/r", number: n }, workflow: "dev-task" });
    mkdirSync(join(root, id));
    if (id !== "fresh") utimesSync(join(root, id), old, old);
  }
  transitionRun(db, {
    runId: "done",
    from: "CREATED",
    to: "COMPLETED",
    event: "CLEANUP_SUCCEEDED",
  });
  transitionRun(db, {
    runId: "fresh",
    from: "CREATED",
    to: "COMPLETED",
    event: "CLEANUP_SUCCEEDED",
  });
  mkdirSync(join(root, "unknown"));
  utimesSync(join(root, "unknown"), old, old);
  assert.deepEqual(applyRetention(db, { evidenceRoot: root, days: 14 }), [join(root, "done")]);
  for (const id of ["live", "fresh", "unknown"]) assert.ok(existsSync(join(root, id)), id);
});
