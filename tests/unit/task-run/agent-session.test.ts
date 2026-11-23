// DevTask-0142 #407: the session a role keeps per run (migration 13), the unblock reason read once,
// the new config keys, and the resume/repair prompts.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { repairPrompt, resumePrompt } from "../../../runtime/handoff/application/packet.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import type { TaskPacket } from "../../../runtime/shared/contracts.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import { MIGRATIONS, migrate } from "../../../runtime/shared/sqlite/migrations.ts";
import * as repo from "../../../runtime/task-run/adapters/repository.ts";

const run = (db: ReturnType<typeof openState>) =>
  repo.createRun(db, { id: "r1", issue: { repository: "o/r", number: 1 }, workflow: "dev-task" });

test("migration 13 upgrades a version-12 database in place: rows kept, no session recorded", () => {
  const old = new DatabaseSync(":memory:");
  MIGRATIONS.slice(0, 12).forEach((sql, i) => {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${i + 1}`);
  });
  old.exec(
    "INSERT INTO workflow_run (id, repository, issue, workflow, state, created_at, updated_at) VALUES ('r1','o/r',1,'dev-task','BLOCKED','t','t')",
  );
  assert.equal(migrate(old), 13);
  assert.equal(old.prepare("SELECT state FROM workflow_run").get()?.state, "BLOCKED");
  assert.equal(old.prepare("SELECT count(*) AS n FROM agent_session").get()?.n, 0);
  assert.equal(repo.agentSession(old, "r1", "software-engineer"), undefined);
  assert.equal(repo.takeUnblockReason(old, "r1"), undefined);
});

test("a session is kept per (run, role) and replaced as a whole", () => {
  const db = openState(":memory:");
  run(db);
  repo.saveAgentSession(db, { runId: "r1", role: "software-engineer", sessionId: "a", tokens: 5 });
  repo.saveAgentSession(db, { runId: "r1", role: "qa-engineer", sessionId: "q", tokens: 1 });
  repo.saveAgentSession(db, {
    runId: "r1",
    role: "software-engineer",
    sessionId: "a",
    tokens: 90,
    contextHash: "h",
  });
  assert.deepEqual(repo.agentSession(db, "r1", "software-engineer"), {
    sessionId: "a",
    tokens: 90,
    contextHash: "h",
  });
  assert.equal(repo.agentSession(db, "r1", "qa-engineer")?.sessionId, "q");
  assert.equal(repo.agentSession(db, "r1", "code-reviewer"), undefined);
});

test("the unblock reason is read once", () => {
  const db = openState(":memory:");
  run(db);
  repo.saveUnblockReason(db, "r1", "use greet.ts");
  assert.equal(repo.takeUnblockReason(db, "r1"), "use greet.ts");
  assert.equal(repo.takeUnblockReason(db, "r1"), undefined);
});

test("config: agents.contractRepairs defaults to 2, sessionMaxTokens to 3000000; both validated", () => {
  const base = { github: { owner: "o", repo: "r", projectNumber: 1 } };
  const c = parseConfig(base).agents;
  assert.equal(c.contractRepairs, 2);
  assert.equal(c.sessionMaxTokens, 3_000_000);
  assert.equal(parseConfig({ ...base, agents: { contractRepairs: 0 } }).agents.contractRepairs, 0);
  assert.throws(() => parseConfig({ ...base, agents: { contractRepairs: 6 } }), {
    code: "CONFIG_INVALID",
  });
  assert.throws(() => parseConfig({ ...base, agents: { sessionMaxTokens: 5 } }), {
    code: "CONFIG_INVALID",
  });
});

const packet = {
  workflowRunId: "r1",
  issue: { repository: "o/r", number: 1 },
  stepId: "implement",
  role: "software-engineer",
  round: 2,
  attempt: 1,
  scope: [],
  worktree: "/wt",
  baseSha: "abc1234",
  issueContext: [{ title: "BIG ISSUE BODY" }],
} as unknown as TaskPacket;

test("resume prompt: identifiers and delta only, the Issue only when it changed", () => {
  const finding = { id: "CR-001", severity: "high", observed: "o", expected: "e" } as const;
  const p = resumePrompt(packet, { openFindings: [finding], notes: ["n1"] });
  assert.match(p, /"stepId": "implement"/);
  assert.match(p, /"round": 2/);
  assert.match(p, /CR-001/);
  assert.match(p, /n1/);
  assert.ok(!p.includes("BIG ISSUE BODY"));
  assert.equal(JSON.parse(p.split("\n\n")[1] as string).resumed, true);
  const changed = resumePrompt(packet, {
    openFindings: [],
    notes: [],
    issueContext: packet.issueContext,
  });
  assert.match(changed, /BIG ISSUE BODY/);
});

test("repair prompt: lists the contract issues, redacted, and keeps the identifiers", () => {
  const p = repairPrompt(packet, {
    message: "step result: invalid",
    issues: [{ path: "sectionUpdates", message: "qa-engineer PASSED without its section" }],
  });
  assert.match(p, /qa-engineer PASSED without its section/);
  assert.match(p, /"attempt": 1/);
  assert.equal(JSON.parse(p.split("\n\n")[1] as string).repair, true);
});
