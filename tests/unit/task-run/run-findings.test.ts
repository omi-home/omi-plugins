// Bug-0013 #392: the rules for open findings, their storage (migration 12) and the upgrade of a
// shared state.sqlite that has runs from before it.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import type { Finding } from "../../../runtime/shared/contracts.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import { MIGRATIONS, migrate } from "../../../runtime/shared/sqlite/migrations.ts";
import * as repo from "../../../runtime/task-run/adapters/repository.ts";
import {
  afterReview,
  carryOpen,
  mergeFindings,
  NO_FINDINGS,
  unconfirmed,
} from "../../../runtime/task-run/domain/findings.ts";

const f = (id: string, severity: Finding["severity"] = "high"): Finding => ({
  id,
  severity,
  observed: `${id} observed`,
  expected: `${id} expected`,
});
const ids = (l: Finding[]) => l.map((x) => x.id);

test("carryOpen: the plan first, then blocking open findings it does not repeat; no duplicates", () => {
  const open = [f("CR-001"), f("SEC-001", "medium"), f("CR-002", "low"), f("CHK-001")];
  assert.deepEqual(ids(carryOpen([f("ARC-001"), f("CR-001")], open)), [
    "ARC-001",
    "CR-001",
    "SEC-001",
  ]); // low advice and runtime-owned CHK findings are not carried
  assert.deepEqual(ids(carryOpen([], open)), ["CR-001", "SEC-001"]);
  assert.deepEqual(ids(mergeFindings([f("A-001")], [f("A-001"), f("B-001")])), ["A-001", "B-001"]);
});

test("afterReview: FAILED keeps its findings and the reviewer; PASSED closes what it was shown", () => {
  const failed = afterReview(NO_FINDINGS, [
    { role: "code-reviewer", status: "PASSED", findings: [f("CR-009", "low")] },
    { role: "security-reviewer", status: "FAILED", findings: [f("SEC-001", "medium")] },
  ]);
  assert.deepEqual(ids(failed.findings), ["CR-009", "SEC-001"]);
  assert.deepEqual(failed.failedReviewers, ["security-reviewer"]);
  // A round where only the Code Reviewer ran keeps the Security Reviewer owing its confirmation.
  const next = afterReview(failed, [
    { role: "code-reviewer", status: "FAILED", findings: [f("CR-001")] },
  ]);
  assert.deepEqual(next.failedReviewers, ["code-reviewer", "security-reviewer"]);
  const closed = afterReview(next, [
    { role: "code-reviewer", status: "PASSED", findings: [f("CR-002", "medium")] },
    { role: "security-reviewer", status: "PASSED", findings: [] },
  ]);
  assert.deepEqual(closed, { findings: [], failedReviewers: [] });
});

test("unconfirmed: lists failed reviewers and blocking findings; low advice is fine", () => {
  assert.deepEqual(unconfirmed({ findings: [f("A-001", "low")], failedReviewers: [] }), []);
  assert.equal(
    unconfirmed({ findings: [f("A-001", "critical")], failedReviewers: ["code-reviewer"] }).length,
    2,
  );
});

test("storage: no row value = no findings; save/read round trip; unknown run refused", () => {
  const db = openState(":memory:");
  repo.createRun(db, { id: "run", issue: { repository: "o/r", number: 1 }, workflow: "dev-task" });
  assert.deepEqual(repo.runFindings(db, "run"), NO_FINDINGS);
  const saved = { findings: [f("SEC-001")], failedReviewers: ["security-reviewer" as const] };
  repo.saveRunFindings(db, "run", saved);
  assert.deepEqual(repo.runFindings(db, "run"), saved);
  assert.throws(() => repo.saveRunFindings(db, "nope", saved), { code: "INVALID_TRANSITION" });
  db.exec('UPDATE workflow_run SET open_findings = \'{"findings":[],"x":1}\'');
  assert.throws(() => repo.runFindings(db, "run"), { code: "CONTRACT_INVALID" });
});

test("migration 12 upgrades a version-11 database in place: rows kept, no findings recorded", () => {
  const old = new DatabaseSync(":memory:");
  MIGRATIONS.slice(0, 11).forEach((sql, i) => {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${i + 1}`);
  });
  old.exec(
    "INSERT INTO workflow_run (id, repository, issue, workflow, state, created_at, updated_at) VALUES ('r1','o/r',1,'dev-task','BLOCKED','t','t')",
  );
  assert.equal(migrate(old), 12);
  assert.equal(
    old.prepare("SELECT state FROM workflow_run WHERE id = 'r1'").get()?.state,
    "BLOCKED",
  );
  assert.deepEqual(repo.runFindings(old, "r1"), NO_FINDINGS);
  old.close();
});
