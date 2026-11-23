// DevTask-0127 #372: omi queue and omi inbox over a fake GitHub (read-only, stable order, JSON data).
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { writeSnapshot } from "../../../runtime/github/adapters/snapshot-store.ts";
import { projectInbox, projectQueue } from "../../../runtime/github/cli/queue.ts";
import type { StateDeps } from "../../../runtime/github/cli/state.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";
import { OmiError } from "../../../runtime/shared/errors/errors.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { MIGRATIONS, migrate } from "../../../runtime/shared/sqlite/migrations.ts";
import { loadDefaultWorkflow } from "../../../runtime/shared/workflow.ts";

interface Item {
  number: number;
  title: string;
  type: string;
  status: string | null;
  state?: "OPEN" | "CLOSED";
  parent?: number;
}

function fake(items: Item[]) {
  const calls: string[] = [];
  const repo = { nameWithOwner: "o/r" };
  const content = (i: Item) => ({
    __typename: "Issue",
    number: i.number,
    title: i.title,
    state: i.state ?? "OPEN",
    stateReason: null,
    repository: repo,
    issueType: { name: i.type },
    milestone: null,
    labels: { pageInfo: { hasNextPage: false }, nodes: [] },
    parent: i.parent ? { number: i.parent, repository: repo } : null,
    subIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
    blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
    closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [] },
  });
  const run: GhRunner = (args, input) => {
    let query = "";
    if (args.includes("--input")) query = (JSON.parse(input ?? "{}") as { query: string }).query;
    else {
      const k = args.findIndex(
        (a, n) => /^-[fF]$/.test(args[n - 1] ?? "") && a.startsWith("query="),
      );
      query = k < 0 ? "" : (args[k] ?? "").slice(6);
    }
    calls.push(query.slice(0, 40));
    const data = (d: unknown) => ({ status: 0, stdout: JSON.stringify({ data: d }), stderr: "" });
    if (query.includes("viewer")) return data({ viewer: { login: "bot" } });
    if (query.includes("items(first:")) {
      return data({
        repositoryOwner: {
          projectV2: {
            items: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: items.map((i) => ({
                fieldValueByName: i.status === null ? null : { name: i.status },
                content: content(i),
              })),
            },
          },
        },
      });
    }
    return { status: 1, stdout: "", stderr: `unexpected (read-only) query: ${query.slice(0, 60)}` };
  };
  return { run, calls };
}

function deps(
  run: GhRunner,
  opts: {
    snapshot?: { number: number; status: string; state: "open" | "closed" }[];
    runs?: number[];
    model?: "v2" | "legacy";
  } = {},
) {
  const db = new DatabaseSync(":memory:");
  migrate(db, MIGRATIONS);
  if (opts.snapshot) writeSnapshot(db, "o/r", 2, opts.snapshot as never);
  for (const n of opts.runs ?? []) {
    db.prepare(
      "INSERT INTO workflow_run (id, repository, issue, workflow, state, created_at, updated_at) VALUES (?, 'o/r', ?, 'DevTask', 'RUNNING', 't', 't')",
    ).run(`r${n}`, n);
  }
  const d: StateDeps = {
    config: {
      github: { owner: "o", repo: "r", projectNumber: 2, model: opts.model ?? "v2" },
    } as OmiConfig,
    workflow: loadDefaultWorkflow(),
    db: () => db,
    run,
  };
  return { d, db };
}

const dump = (db: DatabaseSync) =>
  JSON.stringify([
    db.prepare("SELECT * FROM workflow_run").all(),
    db.prepare("SELECT * FROM project_snapshot_item").all(),
    db.prepare("SELECT * FROM project_snapshot").all(),
  ]);

test("empty Project: empty queue and an inbox with empty groups", () => {
  const { d } = deps(fake([]).run);
  assert.deepEqual((projectQueue(d).data as { queue: unknown[] }).queue, []);
  assert.match(projectQueue(d).human, /nothing for the Coordinator/);
  const inbox = projectInbox(d);
  assert.deepEqual(inbox.data, {
    inbox: [
      { status: "Awaiting PO", items: [] },
      { status: "Acceptance", items: [] },
    ],
    skipped: [],
    foreign: [],
  });
  assert.match(inbox.human, /nothing waiting for the PO/);
});

test("queue: Ready with and without an open run, Rework, several types, ordered by number", () => {
  const { d } = deps(
    fake([
      { number: 30, title: "QATask-0030-Check", type: "QATask", status: "Ready" },
      { number: 12, title: "DevTask-0012-Taken", type: "DevTask", status: "Ready" },
      {
        number: 11,
        title: "DevTask-0011-Free, with a long title that is never cut",
        type: "DevTask",
        status: "Ready",
      },
      { number: 20, title: "DesignTask-0020-Redo", type: "DesignTask", status: "Rework" },
      { number: 21, title: "UserStory-0021-Auto", type: "UserStory", status: "Ready" },
      { number: 22, title: "DevTask-0022-Busy", type: "DevTask", status: "In progress" },
      { number: 23, title: "DevTask-0023-Done", type: "DevTask", status: "Done", state: "CLOSED" },
    ]).run,
    { runs: [12] },
  );
  const q = (projectQueue(d).data as { queue: Record<string, unknown>[] }).queue;
  assert.deepEqual(
    q.map((r) => [r.issue, r.status, r.reasons]),
    [
      [11, "Ready", ["ready_unassigned"]],
      [20, "Rework", ["rework"]],
      [30, "Ready", ["ready_unassigned"]],
    ],
  );
  assert.equal(q[0]?.title, "DevTask-0011-Free, with a long title that is never cut");
  assert.equal(q[0]?.type, "DevTask");
  assert.match(String(q[0]?.reason), /no open run/);
  assert.match(projectQueue(d).human, /#11 DevTask \[Ready\] DevTask-0011-Free, with a long title/);
});

test("a finished run does not hold a Ready Issue", () => {
  const { d, db } = deps(
    fake([{ number: 5, title: "DevTask-0005-A", type: "DevTask", status: "Ready" }]).run,
    {
      runs: [5],
    },
  );
  db.prepare("UPDATE workflow_run SET state = 'COMPLETED'").run();
  assert.deepEqual(
    (projectQueue(d).data as { queue: { issue: number }[] }).queue.map((r) => r.issue),
    [5],
  );
});

test("queue: a PO decision since the last sync is listed, an invalid change is not", () => {
  const { d } = deps(
    fake([
      { number: 1, title: "Epic-0001-One", type: "Epic", status: "Ready" },
      { number: 2, title: "UserStory-0002-Back", type: "UserStory", status: "Rework", parent: 1 },
      {
        number: 3,
        title: "UserStory-0003-Bad",
        type: "UserStory",
        status: "Done",
        state: "CLOSED",
        parent: 1,
      },
      { number: 4, title: "DevTask-0004-Same", type: "DevTask", status: "In progress", parent: 2 },
    ]).run,
    {
      snapshot: [
        { number: 1, status: "Awaiting PO", state: "open" },
        { number: 2, status: "Awaiting PO", state: "open" },
        { number: 3, status: "Draft", state: "open" },
        { number: 4, status: "In progress", state: "open" },
      ],
    },
  );
  const q = (projectQueue(d).data as { queue: Record<string, unknown>[] }).queue;
  assert.deepEqual(
    q.map((r) => [r.issue, r.reasons]),
    [
      [1, ["po_decision"]],
      [2, ["rework", "po_decision"]],
    ],
  );
  assert.match(String(q[0]?.reason), /Awaiting PO -> Ready/);
});

test("queue without a snapshot reports no PO decision", () => {
  const { d } = deps(
    fake([{ number: 1, title: "Epic-0001-One", type: "Epic", status: "Ready" }]).run,
  );
  assert.deepEqual((projectQueue(d).data as { queue: unknown[] }).queue, []);
});

test("inbox: Awaiting PO and Acceptance grouped by status, several types, closed left out", () => {
  const { d } = deps(
    fake([
      { number: 9, title: "UserStory-0009-Accept", type: "UserStory", status: "Acceptance" },
      { number: 8, title: "ADR-0008-Decide", type: "ADR", status: "Awaiting PO" },
      { number: 3, title: "Epic-0003-Plan", type: "Epic", status: "Awaiting PO" },
      { number: 4, title: "DevTask-0004-Not mine", type: "DevTask", status: "Ready" },
      { number: 5, title: "Doc-0005-Closed", type: "Doc", status: "Awaiting PO", state: "CLOSED" },
    ]).run,
  );
  const r = projectInbox(d);
  assert.deepEqual((r.data as { inbox: unknown }).inbox, [
    {
      status: "Awaiting PO",
      items: [
        { issue: 3, title: "Epic-0003-Plan", type: "Epic" },
        { issue: 8, title: "ADR-0008-Decide", type: "ADR" },
      ],
    },
    {
      status: "Acceptance",
      items: [{ issue: 9, title: "UserStory-0009-Accept", type: "UserStory" }],
    },
  ]);
  assert.match(r.human, /Awaiting PO \(2\)\n {2}#3 Epic Epic-0003-Plan\n {2}#8 ADR/);
  assert.doesNotMatch(r.human, /#5 /);
});

test("both commands are stable, JSON-serializable and write nothing", () => {
  const gh = fake([
    { number: 1, title: "DevTask-0001-A", type: "DevTask", status: "Ready" },
    { number: 2, title: "Epic-0002-B", type: "Epic", status: "Awaiting PO" },
  ]);
  const { d, db } = deps(gh.run, { snapshot: [{ number: 1, status: "Ready", state: "open" }] });
  const before = dump(db);
  const q1 = JSON.stringify(projectQueue(d).data);
  const i1 = JSON.stringify(projectInbox(d).data);
  assert.equal(JSON.stringify(projectQueue(d).data), q1);
  assert.equal(JSON.stringify(projectInbox(d).data), i1);
  assert.equal(dump(db), before);
  // Only reads: the project items query and the viewer lookup, never a mutation.
  assert.ok(gh.calls.every((c) => !/mutation/.test(c)));
});

test("legacy model: both commands refuse and read nothing", () => {
  const gh = fake([]);
  const { d } = deps(gh.run, { model: "legacy" });
  for (const f of [projectQueue, projectInbox]) {
    assert.throws(
      () => f(d),
      (e: unknown) => e instanceof OmiError && e.code === "CONFIG_INVALID",
    );
  }
  assert.deepEqual(gh.calls, []);
});
