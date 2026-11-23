// DevTask-0126 #371: omi sync [--dry-run] against a stateful fake GitHub.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { readSnapshot, writeSnapshot } from "../../../runtime/github/adapters/snapshot-store.ts";
import type { StateDeps } from "../../../runtime/github/cli/state.ts";
import { projectSync } from "../../../runtime/github/cli/sync.ts";
import type { SnapshotItem } from "../../../runtime/github/domain/project-snapshot.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";
import { ProjectStatusV2 } from "../../../runtime/shared/contracts.ts";
import { OmiError } from "../../../runtime/shared/errors/errors.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { MIGRATIONS, migrate } from "../../../runtime/shared/sqlite/migrations.ts";
import { loadDefaultWorkflow } from "../../../runtime/shared/workflow.ts";

const config = (model: "v2" | "legacy" = "v2") =>
  ({ github: { owner: "o", repo: "r", projectNumber: 2, model } }) as OmiConfig;
const code = (c: string) => (e: unknown) => e instanceof OmiError && e.code === c;

interface Item {
  number: number;
  type: string;
  status: string | null;
  state?: "OPEN" | "CLOSED";
  stateReason?: string | null;
  parent?: number;
  milestone?: number;
  mergedPr?: boolean;
}
interface Comment {
  issue: number;
  body: string;
  createdAt: string;
  assoc: string;
  login: string;
}

function fakeGithub(
  items: Item[],
  existing: Comment[] = [],
  milestones: Record<number, string> = {},
) {
  const mutations: string[] = [];
  const posted: { issue: number; body: string }[] = [];
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
    milestone: i.milestone ? { number: i.milestone } : null,
    labels: { pageInfo: { hasNextPage: false }, nodes: [] },
    parent: i.parent ? { number: i.parent, repository: repo } : null,
    subIssues: {
      pageInfo: { hasNextPage: false },
      nodes: items
        .filter((c) => c.parent === i.number)
        .map((c) => ({ number: c.number, repository: repo })),
    },
    blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
    closedByPullRequestsReferences: {
      pageInfo: { hasNextPage: false },
      nodes: i.mergedPr
        ? [
            {
              number: 900 + i.number,
              state: "MERGED",
              isDraft: false,
              comments: { nodes: [] },
              reviews: { nodes: [] },
            },
          ]
        : [],
    },
  });
  const run: GhRunner = (args, input) => {
    const vars: Record<string, string> = {};
    let query = "";
    if (args[1]?.startsWith("repos/")) {
      const n = Number(/milestones\/(\d+)/.exec(args[1])?.[1]);
      if (args.includes("PATCH")) {
        milestones[n] = "closed";
        mutations.push(`milestone ${n} closed`);
      }
      return {
        status: 0,
        stdout: JSON.stringify({ number: n, state: milestones[n] ?? "open" }),
        stderr: "",
      };
    }
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
    if (query.includes("$repo") && query.includes("comments(last:30)")) {
      return data({
        repository: {
          issue: {
            comments: {
              nodes: existing
                .filter((c) => c.issue === Number(vars.number))
                .map((c) => ({
                  body: c.body,
                  createdAt: c.createdAt,
                  authorAssociation: c.assoc,
                  author: { login: c.login },
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
    if (query.includes("issue(number:$number){ id }")) {
      return data({ repository: { issue: { id: `ID${vars.number}` } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      byNumber(num(vars.i as string)).status = (vars.o as string).replace("opt:", "");
      mutations.push(`status ${num(vars.i as string)} ${vars.o}`);
    } else if (query.includes("closeIssue")) {
      const i = byNumber(num(vars.id as string));
      i.state = "CLOSED";
      i.stateReason = "COMPLETED";
      mutations.push(`close ${i.number}`);
    } else if (query.includes("reopenIssue")) {
      const i = byNumber(num(vars.id as string));
      i.state = "OPEN";
      i.stateReason = "REOPENED";
      mutations.push(`reopen ${i.number}`);
    } else if (query.includes("addComment")) {
      posted.push({ issue: num(vars.id as string), body: vars.body as string });
      mutations.push(`comment ${num(vars.id as string)}`);
    } else {
      return { status: 1, stdout: "", stderr: `unexpected query: ${query.slice(0, 80)}` };
    }
    return data({});
  };
  return { run, mutations, posted, items, byNumber, milestones };
}

function setup(
  gh: { run: GhRunner },
  snapshot: SnapshotItem[] | null,
  model: "v2" | "legacy" = "v2",
) {
  const db = new DatabaseSync(":memory:");
  migrate(db, MIGRATIONS);
  if (snapshot) writeSnapshot(db, "o/r", 2, snapshot);
  const d: StateDeps = {
    config: config(model),
    workflow: loadDefaultWorkflow(),
    db: () => db,
    run: gh.run,
  };
  return { d, db };
}

const snap = (number: number, status: string, state: "open" | "closed" = "open"): SnapshotItem =>
  ({
    number,
    status,
    state,
    ...(state === "closed" ? { closeReason: "completed" } : {}),
  }) as SnapshotItem;

type Report = {
  transitions_applied: { issue: number; from: string; to: string }[];
  po_decisions: { issue: number; from: string; to: string; comment?: string }[];
  reverted: { issue: number; from: string; to: string }[];
  issue_closed_by_pr: number[];
  state_changes: { issue: number; change: string }[];
  writes: unknown[];
  milestones_closed: number[];
  queue: { issue: number; moves: string[] }[];
  inbox: { issue: number; status: string }[];
  first_sync: boolean;
  dry_run: boolean;
};
const sync = (d: StateDeps, dryRun = false) => projectSync({ dryRun }, d).data as Report;

test("a valid PO decision is accepted into po_decisions and the snapshot, nothing is reverted", () => {
  const gh = fakeGithub([
    { number: 1, type: "Epic", status: "Ready" },
    { number: 2, type: "Epic", status: "Awaiting PO" },
  ]);
  const { d, db } = setup(gh, [snap(1, "Awaiting PO"), snap(2, "Awaiting PO")]);
  const r = sync(d);
  assert.deepEqual(r.po_decisions, [{ issue: 1, type: "Epic", from: "Awaiting PO", to: "Ready" }]);
  assert.deepEqual(r.reverted, []);
  assert.deepEqual(gh.mutations, []);
  assert.deepEqual(
    r.inbox.map((i) => i.issue),
    [2],
  );
  assert.equal(readSnapshot(db, "o/r", 2)?.find((s) => s.number === 1)?.status, "Ready");
});

test("Rework: the PO's newest comment goes in the report (omi text and strangers ignored)", () => {
  const gh = fakeGithub(
    [{ number: 3, type: "UserStory", status: "Rework" }],
    [
      {
        issue: 3,
        body: "old note",
        createdAt: "2026-11-01T00:00:00Z",
        assoc: "OWNER",
        login: "po",
      },
      {
        issue: 3,
        body: "Cần sửa phần đăng nhập",
        createdAt: "2026-11-02T00:00:00Z",
        assoc: "OWNER",
        login: "po",
      },
      {
        issue: 3,
        body: "omi sync: restored",
        createdAt: "2026-11-03T00:00:00Z",
        assoc: "OWNER",
        login: "po",
      },
      { issue: 3, body: "spam", createdAt: "2026-11-04T00:00:00Z", assoc: "NONE", login: "x" },
    ],
  );
  const { d } = setup(gh, [snap(3, "Awaiting PO")]);
  const r = sync(d);
  assert.equal(r.po_decisions[0]?.to, "Rework");
  assert.equal(r.po_decisions[0]?.comment, "Cần sửa phần đăng nhập");
  assert.deepEqual(gh.mutations, []);
});

test("an invalid status change is reverted with a warning comment; the second run changes nothing", () => {
  const gh = fakeGithub([{ number: 5, type: "DevTask", status: "Done" }]);
  const { d, db } = setup(gh, [snap(5, "In progress")]);
  const r = sync(d);
  assert.deepEqual(
    r.reverted.map((x) => [x.issue, x.from, x.to]),
    [[5, "Done", "In progress"]],
  );
  assert.equal(gh.byNumber(5).status, "In progress");
  assert.equal(gh.byNumber(5).state ?? "OPEN", "OPEN");
  assert.equal(gh.posted.length, 1);
  assert.match(gh.posted[0]?.body ?? "", /^omi sync: DevTask #5 was moved to Done/);
  assert.equal(readSnapshot(db, "o/r", 2)?.[0]?.status, "In progress");
  const before = gh.mutations.length;
  const again = sync(d);
  assert.equal(gh.mutations.length, before);
  assert.deepEqual(again.reverted, []);
  assert.deepEqual(again.writes, []);
});

test("a merged PR closing a DevTask: In review -> Done, then the Story cascades to Testing", () => {
  const gh = fakeGithub([
    { number: 4, type: "UserStory", status: "In progress" },
    {
      number: 5,
      type: "DevTask",
      status: "In review",
      parent: 4,
      state: "CLOSED",
      stateReason: "COMPLETED",
      mergedPr: true,
    },
  ]);
  const { d } = setup(gh, [snap(4, "In progress"), snap(5, "In review")]);
  const r = sync(d);
  assert.deepEqual(r.issue_closed_by_pr, [5]);
  assert.deepEqual(
    r.transitions_applied.map((t) => [t.issue, t.from, t.to]),
    [
      [5, "In review", "Done"],
      [4, "In progress", "Testing"],
    ],
  );
  assert.equal(gh.byNumber(5).status, "Done");
  assert.equal(gh.byNumber(4).status, "Testing");
  assert.equal(gh.byNumber(5).state, "CLOSED");
  assert.ok(!gh.mutations.includes("reopen 5")); // PR-closed is not drift
  const before = gh.mutations.length;
  sync(d);
  assert.equal(gh.mutations.length, before);
});

test("open/closed drift is restored from the Status; a PO Done on an open Issue closes it", () => {
  const gh = fakeGithub([
    {
      number: 6,
      type: "DevTask",
      status: "In progress",
      state: "CLOSED",
      stateReason: "COMPLETED",
    },
    { number: 7, type: "DesignTask", status: "Done" },
  ]);
  const { d } = setup(gh, [snap(6, "In progress"), snap(7, "Awaiting PO")]);
  const r = sync(d);
  assert.deepEqual(
    r.state_changes.map((s) => [s.issue, s.change]),
    [
      [6, "reopen"],
      [7, "close"],
    ],
  );
  assert.equal(gh.byNumber(6).state, "OPEN");
  assert.equal(gh.byNumber(7).state, "CLOSED");
  assert.deepEqual(
    r.po_decisions.map((p) => p.issue),
    [7],
  );
});

test("a Milestone is closed when all its Epics are Done (once)", () => {
  const gh = fakeGithub(
    [
      { number: 20, type: "Epic", status: "In progress", milestone: 3 },
      {
        number: 21,
        type: "DevTask",
        status: "Done",
        parent: 20,
        state: "CLOSED",
        stateReason: "COMPLETED",
      },
    ],
    [],
    { 3: "open" },
  );
  const { d } = setup(gh, [snap(20, "In progress"), snap(21, "Done", "closed")]);
  const r = sync(d);
  assert.equal(gh.byNumber(20).status, "Done");
  assert.equal(gh.byNumber(20).state, "CLOSED");
  assert.deepEqual(r.milestones_closed, [3]);
  assert.equal(gh.milestones[3], "closed");
  const again = sync(d);
  assert.deepEqual(again.milestones_closed, []);
  assert.equal(gh.mutations.filter((m) => m.startsWith("milestone")).length, 1);
});

test("--dry-run reports the same plan but writes neither GitHub nor the snapshot", () => {
  const items = (): Item[] => [
    { number: 5, type: "DevTask", status: "Done" },
    {
      number: 6,
      type: "DevTask",
      status: "In progress",
      state: "CLOSED",
      stateReason: "COMPLETED",
    },
  ];
  const real = fakeGithub(items());
  const a = setup(real, [snap(5, "In progress"), snap(6, "In progress")]);
  const wet = sync(a.d);
  const gh = fakeGithub(items());
  const { d, db } = setup(gh, [snap(5, "In progress"), snap(6, "In progress")]);
  const dry = sync(d, true);
  assert.equal(dry.dry_run, true);
  assert.deepEqual(gh.mutations, []);
  assert.deepEqual(gh.posted, []);
  assert.deepEqual(readSnapshot(db, "o/r", 2), [snap(5, "In progress"), snap(6, "In progress")]);
  assert.deepEqual({ ...dry, dry_run: false }, wet);
  assert.ok(wet.writes.length > 0);
});

test("first sync without a snapshot: baseline, nothing reverted, snapshot written (not on dry-run)", () => {
  const gh = fakeGithub([{ number: 5, type: "DevTask", status: "Done" }]);
  const { d, db } = setup(gh, null);
  const dry = sync(d, true);
  assert.equal(dry.first_sync, true);
  assert.equal(readSnapshot(db, "o/r", 2), null);
  const r = sync(d);
  assert.deepEqual(r.reverted, []);
  assert.deepEqual(r.po_decisions, []);
  assert.equal(gh.posted.length, 0);
  assert.equal(gh.byNumber(5).status, "Done"); // not reverted
  assert.equal(gh.byNumber(5).state, "CLOSED"); // open/closed follows the Status
  assert.deepEqual(readSnapshot(db, "o/r", 2), [snap(5, "Done", "closed")]);
  assert.equal(sync(d).first_sync, false);
});

test("queue lists the Coordinator's moves; legacy model is refused without any call", () => {
  const gh = fakeGithub([
    { number: 8, type: "DevTask", status: "Ready" },
    { number: 9, type: "Epic", status: "Draft" },
  ]);
  const { d } = setup(gh, [snap(8, "Ready"), snap(9, "Draft")]);
  const r = sync(d);
  assert.deepEqual(r.queue, [
    { issue: 8, type: "DevTask", status: "Ready", moves: ["In progress"] },
    { issue: 9, type: "Epic", status: "Draft", moves: ["Awaiting PO"] },
  ]);
  let calls = 0;
  const counting: GhRunner = (a, i) => {
    calls++;
    return gh.run(a, i);
  };
  const legacy = setup({ run: counting }, null, "legacy");
  assert.throws(() => projectSync({}, legacy.d), code("CONFIG_INVALID"));
  assert.equal(calls, 0);
});
