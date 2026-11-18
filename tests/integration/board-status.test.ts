// DevTask-0050 #145: `omi status` tree reader against an in-memory GitHub: paged sub-issues,
// nesting, Issue outside the Project, missing Milestone, no permission to read the Project.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readTree } from "../../runtime/adapters/github/board.ts";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import type { OmiConfig } from "../../runtime/core/config.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";

const config = { github: { owner: "o", repo: "r", projectNumber: 2 } } as OmiConfig;

interface I {
  type: string;
  status?: string; // undefined: not in the Project
  kids?: number[];
  pr?: number;
}

function fakeGh(issues: Record<number, I>, page = 2) {
  const calls: string[] = [];
  const node = (n: number) => {
    const i = issues[n] as I;
    return {
      number: n,
      title: `T${n}`,
      state: "OPEN",
      labels: { nodes: [{ name: `type:${i.type}` }] },
      projectItems: {
        nodes:
          i.status === undefined
            ? [{ project: { number: 9, owner: { login: "o" } }, fieldValueByName: null }]
            : [
                {
                  project: { number: 2, owner: { login: "O" } },
                  fieldValueByName: { name: i.status },
                },
              ],
      },
      closedByPullRequestsReferences: {
        nodes: i.pr
          ? [
              { number: i.pr, url: `https://x/pull/${i.pr}`, isDraft: false, state: "OPEN" },
              { number: i.pr + 1, url: "merged", isDraft: false, state: "MERGED" },
            ]
          : [],
      },
      subIssuesSummary: { total: i.kids?.length ?? 0 },
    };
  };
  const run: GhRunner = (args) => {
    const vars = Object.fromEntries(
      args
        .slice(4)
        .filter((_, i) => i % 2 === 1)
        .map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
    );
    const n = Number(vars.number);
    const from = vars.after ? Number(vars.after) : 0;
    calls.push(`${n}@${from}`);
    if (!issues[n])
      return {
        status: 0,
        stdout: JSON.stringify({ data: { repository: { issue: null } } }),
        stderr: "",
      };
    const kids = issues[n].kids ?? [];
    const slice = kids.slice(from, from + page);
    const more = from + page < kids.length;
    const issue = {
      ...node(n),
      subIssues: {
        pageInfo: { hasNextPage: more, endCursor: more ? String(from + page) : null },
        nodes: slice.map(node),
      },
    };
    return { status: 0, stdout: JSON.stringify({ data: { repository: { issue } } }), stderr: "" };
  };
  return { run, calls };
}

test("tree: paged and nested sub-issues, depth-first, Status from the configured Project only", () => {
  const gh = fakeGh({
    64: { type: "milestone", status: "In Progress", kids: [65, 69, 143] },
    65: { type: "feature", status: "Backlog", kids: [66, 67, 68] },
    66: { type: "dev-task", status: "Backlog" },
    67: { type: "dev-task", status: "In Review", pr: 150 },
    68: { type: "dev-task" }, // outside the Project
    69: { type: "feature", status: "Done" },
    143: { type: "feature", status: "In Progress" },
  });
  const tree = readTree(config, 64, gh.run);
  assert.deepEqual(
    tree.map((i) => [i.number, i.depth, i.parent, i.status, i.inProject]),
    [
      [64, 0, null, "In Progress", true],
      [65, 1, 64, "Backlog", true],
      [66, 2, 65, "Backlog", true],
      [67, 2, 65, "In Review", true],
      [68, 2, 65, null, false],
      [69, 1, 64, "Done", true],
      [143, 1, 64, "In Progress", true],
    ],
  );
  assert.deepEqual(tree[3]?.prs, [{ number: 150, url: "https://x/pull/150", draft: false }]);
  assert.equal(tree[2]?.type, "dev-task");
  // Two pages for #64 and #65; leaves are never queried.
  assert.deepEqual(gh.calls, ["64@0", "64@2", "65@0", "65@2"]);
});

test("tree: a missing Milestone is a ticket error", () => {
  assert.throws(
    () => readTree(config, 999, fakeGh({}).run),
    (e: OmiError) => e.code === "TICKET_INVALID" && /#999/.test(e.message),
  );
});

test("tree: no permission to read the Project is an auth error", () => {
  const run: GhRunner = () => ({
    status: 1,
    stdout: JSON.stringify({
      errors: [{ type: "INSUFFICIENT_SCOPES", message: "needs read:project" }],
    }),
    stderr: "",
  });
  assert.throws(
    () => readTree(config, 64, run),
    (e: OmiError) => e.code === "GITHUB_AUTH",
  );
});

test("status groups: unknown and unset Status are labelled, never a raw group", async () => {
  const { statusKey } = await import("../../runtime/cli/status.ts");
  const base = {
    number: 1,
    title: "",
    state: "OPEN" as const,
    type: null,
    parent: null,
    depth: 1,
    prs: [],
  };
  assert.equal(statusKey({ ...base, status: "In Review", inProject: true }), "In Review");
  assert.equal(statusKey({ ...base, status: "Todo", inProject: true }), "unknown Status 'Todo'");
  assert.equal(statusKey({ ...base, status: null, inProject: true }), "no Status");
  assert.equal(statusKey({ ...base, status: null, inProject: false }), "not in Project");
});
