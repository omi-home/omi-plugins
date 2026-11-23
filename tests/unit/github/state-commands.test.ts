// DevTask-0125 #370: omi move, omi close --not-planned and omi validate against a stateful fake GitHub.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readSnapshot, writeSnapshot } from "../../../runtime/github/adapters/snapshot-store.ts";
import {
  issueClose,
  issueMove,
  issueValidate,
  type StateDeps,
} from "../../../runtime/github/cli/state.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";
import { ProjectStatusV2 } from "../../../runtime/shared/contracts.ts";
import { OmiError } from "../../../runtime/shared/errors/errors.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { MIGRATIONS, migrate } from "../../../runtime/shared/sqlite/migrations.ts";
import { loadDefaultWorkflow } from "../../../runtime/shared/workflow.ts";

const config = (model: "v2" | "legacy" = "v2") =>
  ({ github: { owner: "o", repo: "r", projectNumber: 2, model } }) as OmiConfig;
const code = (c: string, reason?: string) => (e: unknown) =>
  e instanceof OmiError &&
  e.code === c &&
  (reason === undefined || (e.details as { reason?: string }).reason === reason);

interface Item {
  number: number;
  type: string;
  status: string | null;
  state?: "OPEN" | "CLOSED";
  stateReason?: string | null;
  parent?: number;
  blockedBy?: number[];
}

/** A fake GitHub: every query reads `items`, every mutation changes it and is logged. */
function fakeGithub(items: Item[]) {
  const mutations: string[] = [];
  const comments: { id: string; body: string }[] = [];
  const byNumber = (n: number) => items.find((i) => i.number === n) as Item;
  const num = (id: string) => Number(id.replace(/^\D+/, ""));
  const repo = { nameWithOwner: "o/r" };
  const content = (i: Item) => ({
    __typename: "Issue",
    number: i.number,
    state: i.state ?? "OPEN",
    stateReason: i.stateReason ?? null,
    repository: repo,
    issueType: { name: i.type },
    milestone: null,
    labels: { pageInfo: { hasNextPage: false }, nodes: [] },
    parent: i.parent ? { number: i.parent, repository: repo } : null,
    subIssues: {
      pageInfo: { hasNextPage: false },
      nodes: items
        .filter((c) => c.parent === i.number)
        .map((c) => ({ number: c.number, repository: repo })),
    },
    blockedBy: {
      pageInfo: { hasNextPage: false },
      nodes: (i.blockedBy ?? []).map((b) => ({
        number: b,
        state: byNumber(b).state ?? "OPEN",
        stateReason: byNumber(b).stateReason ?? null,
        repository: repo,
      })),
    },
    closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [] },
  });
  const run: GhRunner = (args, input) => {
    const vars: Record<string, string> = {};
    let query = "";
    if (args.includes("--input")) {
      const body = JSON.parse(input ?? "{}") as {
        query: string;
        variables: Record<string, string>;
      };
      query = body.query;
      Object.assign(vars, body.variables);
    } else {
      args.forEach((a, k) => {
        if (/^-[fF]$/.test(args[k - 1] ?? "")) {
          const [key, ...v] = a.split("=");
          if (key === "query") query = v.join("=");
          else vars[key as string] = v.join("=");
        }
      });
    }
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
    if (query.includes('field(name:"Status")')) {
      return data({
        repositoryOwner: {
          projectV2: {
            id: "P",
            field: {
              id: "F",
              options: ProjectStatusV2.options.map((n) => ({ id: `opt:${n}`, name: n })),
            },
          },
        },
      });
    }
    if (query.includes("projectItems(first:50")) {
      const i = byNumber(Number(vars.number));
      return data({
        repository: {
          issue: {
            number: i.number,
            parent: null,
            projectItems: {
              nodes: [
                {
                  id: `item${i.number}`,
                  project: { number: 2, owner: { login: "o" } },
                  fieldValueByName: i.status === null ? null : { name: i.status },
                },
              ],
            },
          },
        },
      });
    }
    if (query.includes("totalCount")) {
      const i = byNumber(Number(vars.number));
      return data({
        repository: {
          issue: {
            id: `ID${i.number}`,
            number: i.number,
            repository: repo,
            state: i.state ?? "OPEN",
            stateReason: i.stateReason ?? null,
            blockedBy: {
              totalCount: (i.blockedBy ?? []).length,
              nodes: (i.blockedBy ?? []).map((b) => ({ number: b, repository: repo })),
            },
          },
        },
      });
    }
    if (query.includes("issue(number:$number){ id }")) {
      return data({ repository: { issue: { id: `ID${vars.number}` } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      byNumber(num(vars.i as string)).status = (vars.o as string).replace("opt:", "");
      mutations.push(`status ${num(vars.i as string)} ${vars.o}`);
    } else if (query.includes("closeIssue")) {
      const i = byNumber(num(vars.id as string));
      i.state = "CLOSED";
      i.stateReason = query.includes("NOT_PLANNED") ? "NOT_PLANNED" : "COMPLETED";
      mutations.push(`close ${i.number} ${i.stateReason}`);
    } else if (query.includes("reopenIssue")) {
      const i = byNumber(num(vars.id as string));
      i.state = "OPEN";
      i.stateReason = "REOPENED";
      mutations.push(`reopen ${i.number}`);
    } else if (query.includes("addComment")) {
      comments.push({ id: vars.id as string, body: vars.body as string });
      mutations.push(`comment ${vars.id}`);
    } else if (query.includes("addBlockedBy")) {
      const i = byNumber(num(vars.i as string));
      i.blockedBy = [...(i.blockedBy ?? []), num(vars.b as string)];
      mutations.push(`blocked ${i.number} by ${num(vars.b as string)}`);
    } else {
      return { status: 1, stdout: "", stderr: `unexpected query: ${query.slice(0, 80)}` };
    }
    return data({});
  };
  return { run, mutations, comments, items, byNumber };
}

function deps(gh: { run: GhRunner }, model: "v2" | "legacy" = "v2", snapshot = true) {
  const db = new DatabaseSync(":memory:");
  migrate(db, MIGRATIONS);
  if (snapshot) {
    writeSnapshot(db, "o/r", 2, [
      { number: 1, status: "In progress", state: "open" },
      { number: 2, status: "Testing", state: "open" },
      { number: 3, status: "Testing", state: "open" },
      { number: 10, status: "Ready", state: "open" },
    ]);
  }
  const d: StateDeps = {
    config: config(model),
    workflow: loadDefaultWorkflow(),
    db: () => db,
    run: gh.run,
  };
  return { d, db };
}

/** Epic 1 > Bug 2 > QATask 3 (the cascade chain) and an unrelated Epic 10 with a pending auto rule. */
const tree = (): Item[] => [
  { number: 1, type: "Epic", status: "In progress" },
  { number: 2, type: "Bug", status: "Testing", parent: 1 },
  { number: 3, type: "QATask", status: "Testing", parent: 2 },
  { number: 10, type: "Epic", status: "Ready" },
  { number: 11, type: "DevTask", status: "In progress", parent: 10 },
];

test("move: valid transition cascades several levels, closes Done, comments, updates the snapshot", () => {
  const gh = fakeGithub(tree());
  const { d, db } = deps(gh);
  const r = issueMove(3, "Done", { reason: "QA passed" }, d);
  assert.deepEqual(
    gh.items.slice(0, 3).map((i) => [i.number, i.status, i.state]),
    [
      [1, "Done", "CLOSED"],
      [2, "Done", "CLOSED"],
      [3, "Done", "CLOSED"],
    ],
  );
  const data = r.data as { writes: { issue: number }[]; cascade: { item: number }[] };
  assert.deepEqual(
    data.writes.map((w) => w.issue),
    [3, 2, 1],
  );
  assert.deepEqual(
    data.cascade.map((c) => c.item),
    [2, 1],
  );
  // The unrelated pending rule (Epic 10 Ready -> In progress) is sync's, not this move's.
  assert.equal(gh.byNumber(10).status, "Ready");
  assert.equal(gh.comments.length, 1);
  assert.match(gh.comments[0]?.body ?? "", /QA passed/);
  const snap = readSnapshot(db, "o/r", 2) ?? [];
  assert.deepEqual(
    snap.filter((s) => s.status === "Done").map((s) => [s.number, s.state, s.closeReason]),
    [
      [1, "closed", "completed"],
      [2, "closed", "completed"],
      [3, "closed", "completed"],
    ],
  );
  assert.equal(snap.find((s) => s.number === 10)?.status, "Ready"); // untouched items stay as they were
});

test("move: running it again writes nothing and posts no second comment", () => {
  const gh = fakeGithub(tree());
  const { d } = deps(gh);
  issueMove(3, "Done", { reason: "QA passed" }, d);
  const before = gh.mutations.length;
  const again = issueMove(3, "Done", { reason: "QA passed" }, d);
  assert.equal(gh.mutations.length, before);
  assert.deepEqual((again.data as { writes: unknown[] }).writes, []);
});

test("move: a by: po transition is refused with the valid targets, nothing is written", () => {
  const gh = fakeGithub([{ number: 1, type: "Epic", status: "Awaiting PO" }]);
  const { d } = deps(gh);
  assert.throws(
    () => issueMove(1, "Ready", {}, d),
    (e) => {
      assert.ok(code("INVALID_TRANSITION", "PO_DECISION")(e));
      assert.match((e as OmiError).message, /PO decision/);
      return true;
    },
  );
  assert.deepEqual(gh.mutations, []);
});

test("move: a transition that does not exist is refused and lists the valid targets", () => {
  const gh = fakeGithub([{ number: 5, type: "DevTask", status: "Ready" }]);
  const { d } = deps(gh);
  assert.throws(
    () => issueMove(5, "Done", {}, d),
    (e) => {
      assert.ok(code("INVALID_TRANSITION", "TRANSITION_UNKNOWN")(e));
      assert.deepEqual(((e as OmiError).details as { validTargets: string[] }).validTargets, [
        "In progress",
        "Blocked",
      ]);
      return true;
    },
  );
  assert.throws(() => issueMove(5, "Nowhere", {}, d), code("USAGE_INVALID"));
  assert.throws(() => issueMove(99, "Done", {}, d), code("TICKET_NOT_IN_PROJECT"));
  assert.deepEqual(gh.mutations, []);
});

test("move: a by: auto transition is refused (sync applies it)", () => {
  const gh = fakeGithub([
    { number: 1, type: "Epic", status: "Ready" },
    { number: 2, type: "Epic", status: "In progress" },
  ]);
  const { d } = deps(gh);
  assert.throws(() => issueMove(1, "In progress", {}, d), code("INVALID_TRANSITION", "AUTO_ONLY"));
});

test("move to Blocked needs --on; the dependency is recorded and holds the Issue (CR-001 of #368)", () => {
  const gh = fakeGithub([
    { number: 4, type: "DevTask", status: "In progress" },
    { number: 12, type: "DevTask", status: "Ready" },
  ]);
  const { d } = deps(gh);
  assert.throws(() => issueMove(4, "Blocked", { reason: "wait" }, d), code("USAGE_INVALID"));
  assert.throws(() => issueMove(4, "In review", { on: "12" }, d), code("USAGE_INVALID"));
  assert.deepEqual(gh.mutations, []);
  issueMove(4, "Blocked", { on: "12" }, d);
  assert.equal(gh.byNumber(4).status, "Blocked"); // the open blocker keeps it Blocked
  assert.deepEqual(gh.byNumber(4).blockedBy, [12]);
  // Once the blocker is done, the next move/sync releases it (auto, blockers_done).
  const again = issueMove(4, "Blocked", { on: "12" }, d);
  assert.deepEqual((again.data as { writes: unknown[] }).writes, []);
});

test("move to Blocked --on a Done Issue is refused and writes nothing (CR-001)", () => {
  const gh = fakeGithub([
    { number: 4, type: "DevTask", status: "In progress" },
    { number: 12, type: "DevTask", status: "Done", state: "CLOSED", stateReason: "COMPLETED" },
  ]);
  const { d } = deps(gh);
  assert.throws(
    () => issueMove(4, "Blocked", { on: "12" }, d),
    code("USAGE_INVALID", "BLOCKER_DONE"),
  );
  assert.deepEqual(gh.mutations, []);
  assert.equal(gh.byNumber(4).status, "In progress");
});

test("close --not-planned: closes as not planned, updates the snapshot, is idempotent", () => {
  const gh = fakeGithub([{ number: 7, type: "ADR", status: "Awaiting PO" }]);
  const { d, db } = deps(gh);
  writeSnapshot(db, "o/r", 2, [{ number: 7, status: "Awaiting PO", state: "open" }]);
  assert.throws(() => issueClose(7, false, d), code("USAGE_INVALID"));
  issueClose(7, true, d);
  assert.deepEqual(gh.mutations, ["close 7 NOT_PLANNED"]);
  assert.deepEqual(readSnapshot(db, "o/r", 2), [
    { number: 7, status: "Awaiting PO", state: "closed", closeReason: "not_planned" },
  ]);
  const again = issueClose(7, true, d);
  assert.equal((again.data as { closed: boolean }).closed, false);
  assert.equal(gh.mutations.length, 1);
  assert.throws(() => issueClose(8, true, d), code("TICKET_NOT_IN_PROJECT"));
});

test("close --not-planned refuses an Issue already closed as completed", () => {
  const gh = fakeGithub([
    { number: 7, type: "ADR", status: "Done", state: "CLOSED", stateReason: "COMPLETED" },
  ]);
  assert.throws(() => issueClose(7, true, deps(gh).d), code("INVALID_TRANSITION"));
});

test("validate: reports wrong status for the type, open/closed drift and pending auto rules", () => {
  const gh = fakeGithub([
    { number: 1, type: "Epic", status: "Ready" }, // auto pending: child In progress
    { number: 2, type: "DevTask", status: "In progress", parent: 1 },
    { number: 3, type: "DevTask", status: "Acceptance" }, // not a DevTask status
    { number: 4, type: "DevTask", status: "Done" }, // Done but open
    { number: 5, type: "DevTask", status: "Ready", state: "CLOSED", stateReason: "COMPLETED" },
    { number: 6, type: "ADR", status: "Draft", state: "CLOSED", stateReason: "NOT_PLANNED" }, // fine
    { number: 7, type: "DevTask", status: "Bogus" },
    { number: 8, type: "DevTask", status: "Bogus", state: "CLOSED", stateReason: "COMPLETED" }, // only invalid_status (CR-002)
  ]);
  const before = JSON.stringify(gh.items);
  const r = issueValidate(deps(gh).d);
  assert.equal(r.failed, true);
  const found = (r.data as { findings: { kind: string; issue: number }[] }).findings.map(
    (f) => `${f.kind}:${f.issue}`,
  );
  assert.deepEqual(found.sort(), [
    "auto_pending:1",
    "invalid_status:7",
    "invalid_status:8",
    "state_mismatch:4",
    "state_mismatch:5",
    "status_not_allowed:3",
  ]);
  assert.deepEqual(gh.mutations, []); // read-only
  assert.equal(JSON.stringify(gh.items), before);
});

test("validate: clean data exits ok", () => {
  const gh = fakeGithub([
    { number: 1, type: "Epic", status: "In progress" },
    { number: 2, type: "DevTask", status: "In progress", parent: 1 },
  ]);
  const r = issueValidate(deps(gh).d);
  assert.equal(r.failed, false);
  assert.equal((r.data as { ok: boolean }).ok, true);
});

test("github.model legacy is refused by every command and nothing is read or written", () => {
  const gh = fakeGithub(tree());
  let calls = 0;
  const counting: GhRunner = (a, i) => {
    calls++;
    return gh.run(a, i);
  };
  const { d } = deps({ run: counting }, "legacy");
  assert.throws(() => issueMove(3, "Done", {}, d), code("CONFIG_INVALID"));
  assert.throws(() => issueClose(3, true, d), code("CONFIG_INVALID"));
  assert.throws(() => issueValidate(d), code("CONFIG_INVALID"));
  assert.equal(calls, 0);
  assert.deepEqual(gh.mutations, []);
});
