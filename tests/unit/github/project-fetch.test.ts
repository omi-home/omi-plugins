// DevTask-0124 #369: paginated Project fetch, model build, snapshot store and diff, migration 10.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  fetchProjectIssues,
  fetchProjectModel,
  reviewMarker,
} from "../../../runtime/github/adapters/project-fetch.ts";
import { readSnapshot, writeSnapshot } from "../../../runtime/github/adapters/snapshot-store.ts";
import {
  buildProjectModel,
  type FetchedIssue,
} from "../../../runtime/github/domain/build-model.ts";
import { diffSnapshot, toSnapshot } from "../../../runtime/github/domain/project-snapshot.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";
import { OmiError } from "../../../runtime/shared/errors/errors.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import { MIGRATIONS, migrate } from "../../../runtime/shared/sqlite/migrations.ts";
import { loadDefaultWorkflow } from "../../../runtime/shared/workflow.ts";

const config = { github: { owner: "o", repo: "r", projectNumber: 2 } } as OmiConfig;
const code = (c: string) => (e: unknown) => e instanceof OmiError && e.code === c;

const issue = (n: number, o: Record<string, unknown> = {}) => ({
  number: n,
  state: "OPEN",
  stateReason: null,
  repository: { nameWithOwner: "o/r" },
  issueType: { name: "DevTask" },
  milestone: null,
  labels: { pageInfo: { hasNextPage: false }, nodes: [] },
  parent: null,
  subIssues: { pageInfo: { hasNextPage: false }, nodes: [] },
  blockedBy: { pageInfo: { hasNextPage: false }, nodes: [] },
  closedByPullRequestsReferences: { pageInfo: { hasNextPage: false }, nodes: [] },
  ...o,
});
const item = (content: unknown, status: string | null = "Ready") => ({
  fieldValueByName: status === null ? null : { name: status },
  content: content === null ? null : { __typename: "Issue", ...(content as object) },
});
const page = (nodes: unknown[], next: string | null) => ({
  repositoryOwner: {
    projectV2: { items: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } },
  },
});

/** Fake gh: answers each project-items page by its `after` variable; the viewer query by login. */
function fake(pages: Record<string, unknown>, calls: string[] = []): GhRunner {
  return (args) => {
    const vars = Object.fromEntries(
      args.flatMap((a, i) =>
        a.includes("=") && /^-[fF]$/.test(args[i - 1] ?? "")
          ? [a.split(/=(.*)/s).slice(0, 2) as [string, string]]
          : [],
      ),
    );
    if (vars.query?.includes("viewer")) {
      return {
        status: 0,
        stdout: JSON.stringify({ data: { viewer: { login: "bot" } } }),
        stderr: "",
      };
    }
    calls.push(vars.after ?? "");
    const data = pages[vars.after ?? ""];
    return { status: 0, stdout: JSON.stringify({ data }), stderr: "" };
  };
}

const pr = (o: Record<string, unknown>) => ({
  number: 50,
  state: "OPEN",
  isDraft: false,
  comments: { nodes: [] },
  reviews: { nodes: [] },
  ...o,
});
const marked = (verdict: string, at: string, assoc = "OWNER", login = "po") => ({
  body: `<!-- omi:review=r1 verdict=${verdict} -->`,
  createdAt: at,
  authorAssociation: assoc,
  author: { login },
});

test("fetch follows every page and keeps all items", () => {
  const calls: string[] = [];
  const run = fake(
    {
      "": page([item(issue(1)), item(issue(2))], "c1"),
      c1: page([item(issue(3))], "c2"),
      c2: page([item(issue(4), "Done")], null),
    },
    calls,
  );
  const r = fetchProjectIssues(config, run);
  assert.deepEqual(
    r.issues.map((i) => i.number),
    [1, 2, 3, 4],
  );
  assert.deepEqual(calls, ["", "c1", "c2"]);
  assert.equal(r.issues[3]?.status, "Done");
});

test("fetch reads type, state reason, parent, sub-issues, blockers, labels, milestone", () => {
  const run = fake({
    "": page(
      [
        item(
          issue(5, {
            state: "CLOSED",
            stateReason: "NOT_PLANNED",
            issueType: { name: "Bug" },
            milestone: { number: 3 },
            labels: { pageInfo: { hasNextPage: false }, nodes: [{ name: "x" }] },
            parent: { number: 1, repository: { nameWithOwner: "o/r" } },
            subIssues: {
              pageInfo: { hasNextPage: false },
              nodes: [
                { number: 6, repository: { nameWithOwner: "o/r" } },
                { number: 7, repository: { nameWithOwner: "x/other" } },
              ],
            },
            blockedBy: {
              pageInfo: { hasNextPage: false },
              nodes: [
                {
                  number: 2,
                  state: "CLOSED",
                  stateReason: "COMPLETED",
                  repository: { nameWithOwner: "o/r" },
                },
                {
                  number: 9,
                  state: "CLOSED",
                  stateReason: "COMPLETED",
                  repository: { nameWithOwner: "x/other" },
                },
              ],
            },
          }),
          "Blocked",
        ),
      ],
      null,
    ),
  });
  const [i] = fetchProjectIssues(config, run).issues;
  assert.deepEqual(i, {
    number: 5,
    type: "Bug",
    status: "Blocked",
    state: "closed",
    stateReason: "not_planned",
    parent: 1,
    children: [6],
    blockedBy: [
      { ref: "o/r#2", number: 2, closed: true, completed: true },
      { ref: "x/other#9", number: null, closed: true, completed: true },
    ],
    labels: ["x"],
    milestone: 3,
    prs: [],
  });
});

test("fetch: another page announced without a cursor is CONTRACT_INVALID, never a silent stop", () => {
  const broken = {
    repositoryOwner: {
      projectV2: {
        items: { pageInfo: { hasNextPage: true, endCursor: null }, nodes: [item(issue(1))] },
      },
    },
  };
  assert.throws(() => fetchProjectIssues(config, fake({ "": broken })), code("CONTRACT_INVALID"));
});

test("fetch ignores non-Issue items, lists foreign-repo Issues, dedupes", () => {
  const run = fake({
    "": page(
      [
        { fieldValueByName: null, content: { __typename: "PullRequest" } },
        { fieldValueByName: null, content: null },
        item(issue(1, { repository: { nameWithOwner: "x/other" } })),
        item(issue(2)),
        item(issue(2)),
      ],
      null,
    ),
  });
  const r = fetchProjectIssues(config, run);
  assert.deepEqual(
    r.issues.map((i) => i.number),
    [2],
  );
  assert.deepEqual(r.foreign, ["x/other#1"]);
});

test("fetch maps PR draft, merged, closed and the latest trusted review marker", () => {
  const run = fake({
    "": page(
      [
        item(
          issue(1, {
            closedByPullRequestsReferences: {
              pageInfo: { hasNextPage: false },
              nodes: [
                pr({ number: 10, isDraft: true }),
                pr({ number: 11, state: "MERGED" }),
                pr({ number: 12, state: "CLOSED" }),
                pr({
                  number: 13,
                  comments: {
                    nodes: [
                      marked("approved", "2026-11-01T00:00:00Z"),
                      marked("changes_requested", "2026-11-03T00:00:00Z"),
                      // untrusted author: ignored although newest
                      marked("approved", "2026-11-04T00:00:00Z", "NONE", "stranger"),
                    ],
                  },
                  reviews: {
                    nodes: [
                      {
                        body: "<!-- omi:review=r2 verdict=approved -->",
                        submittedAt: "2026-11-02T00:00:00Z",
                        authorAssociation: "NONE",
                        author: { login: "bot" }, // the identity gh runs as is trusted
                      },
                      { body: "lgtm", submittedAt: null, authorAssociation: "OWNER", author: null },
                    ],
                  },
                }),
              ],
            },
          }),
        ),
      ],
      null,
    ),
  });
  const prs = fetchProjectIssues(config, run).issues[0]?.prs;
  assert.deepEqual(prs, [
    { number: 10, state: "draft", verdict: "none" },
    { number: 11, state: "merged", verdict: "none" },
    { number: 12, state: "closed", verdict: "none" },
    { number: 13, state: "open", verdict: "changes_requested" },
  ]);
});

test("reviewMarker parses the marker, the last one wins", () => {
  assert.equal(reviewMarker("x <!-- omi:review=a1 verdict=approved --> y"), "approved");
  assert.equal(
    reviewMarker(
      "<!-- omi:review=a verdict=approved -->\n<!--omi:review=b verdict=changes_requested-->",
    ),
    "changes_requested",
  );
  assert.equal(reviewMarker("<!-- omi:review=a verdict=maybe -->"), null);
  assert.equal(reviewMarker("no marker"), null);
});

test("fetch errors: bad shape, too many nested items, missing Project, API failure", () => {
  assert.throws(
    () => fetchProjectIssues(config, fake({ "": page([item({ number: "x" })], null) })),
    code("CONTRACT_INVALID"),
  );
  const many = issue(1, { labels: { pageInfo: { hasNextPage: true }, nodes: [] } });
  assert.throws(
    () => fetchProjectIssues(config, fake({ "": page([item(many)], null) })),
    code("CONTRACT_INVALID"),
  );
  assert.throws(
    () => fetchProjectIssues(config, fake({ "": { repositoryOwner: { projectV2: null } } })),
    code("CONFIG_INVALID"),
  );
  const down: GhRunner = () => ({ status: 1, stdout: "", stderr: "HTTP 502 Bad Gateway" });
  assert.throws(() => fetchProjectIssues(config, down), code("GITHUB_UNAVAILABLE"));
  const rate: GhRunner = () => ({ status: 1, stdout: "", stderr: "API rate limit exceeded" });
  assert.throws(() => fetchProjectIssues(config, rate), code("GITHUB_RATE_LIMITED"));
  const auth: GhRunner = () => ({
    status: 1,
    stdout: "",
    stderr: "HTTP 401: Bad credentials ghp_abcdefghijklmnopqrstuvwxyz0123456789",
  });
  try {
    fetchProjectIssues(config, auth);
    assert.fail("should throw");
  } catch (e) {
    assert.equal((e as OmiError).code, "GITHUB_AUTH");
    assert.doesNotMatch((e as OmiError).message, /ghp_abc/);
  }
});

const fx = (n: number, o: Partial<FetchedIssue> = {}): FetchedIssue => ({
  number: n,
  type: "DevTask",
  status: "Ready",
  state: "open",
  stateReason: null,
  parent: null,
  children: [],
  blockedBy: [],
  labels: [],
  milestone: null,
  prs: [],
  ...o,
});

test("buildProjectModel: missing type skipped, missing status gets initial, external blockers", () => {
  const { items, skipped } = buildProjectModel([
    fx(1, { type: null }),
    fx(2, { status: null }),
    fx(3, {
      blockedBy: [
        { ref: "o/r#2", number: 2, closed: false, completed: false },
        { ref: "o/r#40", number: 40, closed: true, completed: true }, // same repo, not in Project
        { ref: "x/y#1", number: null, closed: true, completed: false }, // closed not planned
      ],
    }),
    fx(4, {
      state: "closed",
      stateReason: "completed",
      prs: [{ number: 9, state: "merged", verdict: "none" }],
    }),
    fx(5, { state: "closed", stateReason: "completed" }),
  ]);
  assert.deepEqual(skipped, [{ number: 1, reason: "no issue type" }]);
  const by = (n: number) => items.find((i) => i.number === n);
  assert.equal(by(2)?.status, loadDefaultWorkflow().types.DevTask.initial);
  assert.deepEqual(by(3)?.blockedBy, [2]);
  assert.deepEqual(by(3)?.externalBlockers, [
    { ref: "o/r#40", done: true },
    { ref: "x/y#1", done: false },
  ]);
  assert.equal(by(4)?.closedByMergedPr, true);
  assert.equal(by(4)?.closeReason, "completed");
  assert.equal(by(5)?.closedByMergedPr, false);
  assert.throws(() => buildProjectModel([fx(1, { type: "Epicc" })]), code("CONTRACT_INVALID"));
  assert.throws(() => buildProjectModel([fx(1, { status: "Nope" })]), code("CONTRACT_INVALID"));
});

test("fetchProjectModel: fetch + build in one call", () => {
  const run = fake({
    "": page([item(issue(1, { issueType: null })), item(issue(2), null)], null),
  });
  const m = fetchProjectModel(config, run);
  assert.deepEqual(
    m.items.map((i) => i.number),
    [2],
  );
  assert.equal(m.skipped[0]?.number, 1);
});

test("migrations 10-11 add the snapshot and PO decision tables at the latest version", () => {
  assert.equal(MIGRATIONS.length, 12);
  const db = openState(":memory:");
  assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), MIGRATIONS.length);
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => r.name);
  assert.ok(tables.includes("project_snapshot") && tables.includes("project_snapshot_item"));
  db.close();
});

test("migration 10 upgrades a version-9 database in place and keeps its rows", () => {
  const old = new DatabaseSync(":memory:");
  MIGRATIONS.slice(0, 9).forEach((sql, i) => {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${i + 1}`);
  });
  old.exec(
    "INSERT INTO workflow_run (id, repository, issue, workflow, state, created_at, updated_at) VALUES ('r1','o/r',1,'w','RUNNING','t','t')",
  );
  assert.equal(migrate(old), 12);
  assert.equal(old.prepare("SELECT id FROM workflow_run").get()?.id, "r1");
  assert.equal(old.prepare("SELECT count(*) AS n FROM project_snapshot").get()?.n, 0);
  assert.equal(old.prepare("SELECT count(*) AS n FROM project_po_decision").get()?.n, 0);
  old.exec("PRAGMA user_version = 13");
  assert.throws(() => migrate(old), code("SCHEMA_VERSION_UNSUPPORTED"));
});

test("snapshot: none, write, read back, replace per Project, no cross-talk", () => {
  const db = openState(":memory:");
  assert.equal(readSnapshot(db, "o/r", 2), null);
  const items = toSnapshot(
    buildProjectModel([fx(1, { status: "Done", state: "closed", stateReason: "completed" }), fx(2)])
      .items,
  );
  writeSnapshot(db, "o/r", 2, items, new Date("2026-11-23T00:00:00Z"));
  writeSnapshot(db, "o/r", 3, [{ number: 9, status: "Ready", state: "open" }]);
  assert.deepEqual(readSnapshot(db, "o/r", 2), items);
  writeSnapshot(db, "o/r", 2, [{ number: 2, status: "Testing", state: "open" }]);
  assert.deepEqual(readSnapshot(db, "o/r", 2), [{ number: 2, status: "Testing", state: "open" }]);
  assert.equal(readSnapshot(db, "o/r", 3)?.length, 1);
  writeSnapshot(db, "o/r", 4, []); // an empty Project is a snapshot, not "none"
  assert.deepEqual(readSnapshot(db, "o/r", 4), []);
  // an invalid item rolls the whole write back
  assert.throws(
    () => writeSnapshot(db, "o/r", 2, [{ number: 1, status: "Bogus" } as never]),
    code("CONTRACT_INVALID"),
  );
  assert.equal(readSnapshot(db, "o/r", 2)?.length, 1);
  db.close();
});

test("diffSnapshot lists status, closed/reopened, added, removed; first sync has none", () => {
  const s = (number: number, status: string, state = "open", closeReason?: string) =>
    ({ number, status, state, ...(closeReason ? { closeReason } : {}) }) as never;
  const prev = [s(1, "Ready"), s(2, "Testing"), s(3, "Done", "closed", "completed"), s(4, "Ready")];
  const cur = [
    s(1, "In progress"),
    s(2, "Testing", "closed", "completed"),
    s(3, "Done", "open"),
    s(5, "Draft"),
  ];
  assert.deepEqual(diffSnapshot(prev, cur), [
    { kind: "status_changed", issue: 1, from: "Ready", to: "In progress" },
    { kind: "closed", issue: 2, reason: "completed" },
    { kind: "reopened", issue: 3 },
    { kind: "removed", issue: 4 },
    { kind: "added", issue: 5, status: "Draft" },
  ]);
  assert.deepEqual(diffSnapshot(null, cur), []);
  assert.deepEqual(diffSnapshot(cur, cur), []);
});
