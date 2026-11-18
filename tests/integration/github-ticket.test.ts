// T2.4 disposable integration: read-only ticket lookups against the Phase 0 fixture
// (omi-home/omi-spike-p0-20261117 + org Project #1, ADR-0001). Skipped without a gh session.
// Fixture: #1 A ← #2 B ← #3 C (sub-issues), #2 blocked by #4 D, #5 closed and not in the Project.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fetchTicket, validateTicket } from "../../runtime/adapters/github/ticket.ts";
import { parseConfig } from "../../runtime/core/config.ts";

const authed = spawnSync("gh", ["auth", "status", "--hostname", "github.com"]).status === 0;
const skip = !authed && "no gh session on this machine";
const fixture = parseConfig({
  github: { owner: "omi-home", repo: "omi-spike-p0-20261117", projectNumber: 1 },
});
const gates = (n: number) =>
  Object.fromEntries(
    validateTicket(fetchTicket(fixture, n), fixture).map((c) => [c.name, c.code ?? c.status]),
  );

test("live: parent with open blocker and sub-issue is rejected", { skip }, () => {
  const t = fetchTicket(fixture, 2);
  assert.equal(t.parent?.number, 1);
  assert.deepEqual(
    t.blockedBy.nodes.map((b) => b.number),
    [4],
  );
  assert.deepEqual(gates(2), {
    state: "pass",
    project: "pass",
    type: "TICKET_INVALID", // fixture has no type:<OMI type> label
    terminal: "TICKET_INVALID",
    parent: "pass",
    acceptance: "warn",
    dependencies: "DEPENDENCY_BLOCKED",
  });
});

test("live: terminal grandchild passes structure gates", { skip }, () => {
  const g = gates(3);
  assert.equal(g.terminal, "pass");
  assert.equal(g.dependencies, "pass");
  assert.equal(g.project, "pass");
});

test("live: closed issue outside the Project", { skip }, () => {
  const g = gates(5);
  assert.equal(g.state, "TICKET_INVALID");
  assert.equal(g.project, "TICKET_NOT_IN_PROJECT");
});

test("live: unknown issue and repository → TICKET_INVALID", { skip }, () => {
  assert.throws(() => fetchTicket(fixture, 99_999), { code: "TICKET_INVALID" });
  const nope = parseConfig({
    github: { owner: "omi-home", repo: "omi-no-such-repo-x", projectNumber: 1 },
  });
  assert.throws(() => fetchTicket(nope, 1), { code: "TICKET_INVALID" });
});
