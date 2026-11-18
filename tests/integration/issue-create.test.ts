// DevTask-0046 #129: `omi issue create` / `issue section` against an in-memory GitHub: numbering
// per type, idempotent re-run, wrong parent, cycle, cross-repo parent, numbering race, paging.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { readSection, sectionOf } from "../../runtime/adapters/github/context.ts";
import { createIssue } from "../../runtime/adapters/github/issue.ts";
import type { OmiConfig } from "../../runtime/core/config.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";

const config = { github: { owner: "o", repo: "repo", projectNumber: 2 } } as OmiConfig;

interface FakeIssue {
  title: string;
  type: string;
  repo?: string; // default o/repo
  parent?: string; // key "o/repo#n"
  state?: "OPEN" | "CLOSED";
  inProject?: boolean;
  body?: string;
  status?: string;
  itemId?: string;
}

function fakeGh(
  seed: Record<string, FakeIssue>,
  opts: { pageSize?: number; onTitle?: () => void; statusOptions?: string[] } = {},
) {
  const issues = new Map(Object.entries(seed));
  const writes: string[] = [];
  const key = (repo: string, n: number) => `${repo}#${n}`;
  const num = (k: string) => Number(k.split("#")[1]);
  const repoOf = (k: string) => k.split("#")[0] as string;
  const byId = (id: string) => id.replace(/^I_/, "");
  const labels = (i: FakeIssue) => ({ nodes: [{ name: `type:${i.type}` }] });
  let itemSeq = 0;
  const items = (i: FakeIssue) => {
    if (!i.inProject) return { nodes: [] };
    if (!i.itemId) i.itemId = `PVTI_${++itemSeq}`;
    const project = { number: 2, owner: { login: "o" } };
    return {
      nodes: [{ id: i.itemId, project, fieldValueByName: i.status ? { name: i.status } : null }],
    };
  };
  const up = (k: string | undefined, depth: number): unknown => {
    if (!k) return null;
    const i = issues.get(k) as FakeIssue;
    const base = { number: num(k), repository: { nameWithOwner: repoOf(k) } };
    return depth <= 0 ? base : { ...base, labels: labels(i), parent: up(i.parent, depth - 1) };
  };
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });

  const run: GhRunner = (args, input) => {
    let query: string;
    let vars: Record<string, string>;
    if (input) ({ query, variables: vars } = JSON.parse(input));
    else {
      query = (args[3] ?? "").slice("query=".length);
      vars = Object.fromEntries(
        args
          .slice(4)
          .filter((_, i) => i % 2 === 1)
          .map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
      );
    }
    if (query.includes("createIssue")) {
      const n =
        Math.max(0, ...[...issues.keys()].filter((k) => repoOf(k) === "o/repo").map(num)) + 1;
      assert.equal(vars.label, "LABEL");
      issues.set(key("o/repo", n), {
        title: vars.title as string,
        type: "dev-task",
        body: vars.body,
      });
      writes.push(`create:${vars.type ?? "-"}`);
      return ok({ createIssue: { issue: { id: `I_o/repo#${n}`, number: n } } });
    }
    if (query.includes("updateIssue")) {
      (issues.get(byId(vars.id as string)) as FakeIssue).title = vars.title as string;
      writes.push(`title:${vars.title}`);
      opts.onTitle?.();
      return ok({ updateIssue: { issue: { id: vars.id } } });
    }
    if (query.includes("addSubIssue")) {
      (issues.get(byId(vars.c as string)) as FakeIssue).parent = byId(vars.p as string);
      writes.push(`parent:${byId(vars.p as string)}`);
      return ok({});
    }
    if (query.includes("addProjectV2ItemById")) {
      const i = issues.get(byId(vars.c as string)) as FakeIssue;
      i.inProject = true;
      writes.push("project");
      return ok({ addProjectV2ItemById: { item: { id: items(i).nodes[0]?.id } } });
    }
    if (query.includes('field(name:"Status")')) {
      const options = (opts.statusOptions ?? ["Backlog", "Ready"]).map((name) => ({
        id: `OPT_${name}`,
        name,
      }));
      return ok({ repositoryOwner: { projectV2: { id: "P", field: { id: "F", options } } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      const i = [...issues.values()].find((x) => x.itemId === vars.i) as FakeIssue;
      i.status = (vars.o as string).replace("OPT_", "");
      writes.push(`status:${i.status}`);
      return ok({});
    }
    if (query.includes("issueTypes")) {
      return ok({
        repository: {
          id: "R",
          url: "https://github.com/o/repo",
          issueTypes: { nodes: [{ id: "IT_TASK", name: "Task" }] },
          label: vars.label === "type:bogus" ? null : { id: "LABEL" },
        },
        repositoryOwner: { projectV2: { id: "P" } },
      });
    }
    if (query.includes("issues(first:100")) {
      const all = [...issues.entries()].filter(([k]) => repoOf(k) === "o/repo");
      const size = opts.pageSize ?? 100;
      const start = vars.after ? Number(vars.after) : 0;
      const page = all.slice(start, start + size);
      return ok({
        repository: {
          issues: {
            pageInfo: {
              hasNextPage: start + size < all.length,
              endCursor: start + size < all.length ? String(start + size) : null,
            },
            nodes: page.map(([k, i]) => ({
              id: `I_${k}`,
              number: num(k),
              title: i.title,
              state: i.state ?? "OPEN",
              labels: labels(i),
              parent: i.parent
                ? { number: num(i.parent), repository: { nameWithOwner: repoOf(i.parent) } }
                : null,
              projectItems: items(i),
            })),
          },
        },
      });
    }
    if (query.includes("issue(number") && query.includes("state")) {
      const k = key(`${vars.owner}/${vars.repo}`, Number(vars.number));
      const i = issues.get(k);
      if (!i) return ok({ repository: { issue: null } });
      return ok({
        repository: {
          issue: {
            id: `I_${k}`,
            state: i.state ?? "OPEN",
            number: num(k),
            repository: { nameWithOwner: repoOf(k) },
            labels: labels(i),
            projectItems: items(i),
            parent: up(i.parent, 6),
          },
        },
      });
    }
    if (query.includes("issue(number") && query.includes("body")) {
      const i = issues.get(key(`${vars.owner}/${vars.repo}`, Number(vars.number)));
      return ok({ repository: { issue: i ? { id: "I", body: i.body ?? "" } : null } });
    }
    throw new Error(`unexpected query ${query.slice(0, 80)}`);
  };
  return { run, issues, writes };
}

const tree = (): Record<string, FakeIssue> => ({
  "o/repo#1": { title: "Epic-0001-Gốc", type: "epic", inProject: true },
  "o/repo#2": { title: "Milestone-0001-M", type: "milestone", parent: "o/repo#1", inProject: true },
  "o/repo#3": { title: "Feature-0009-F", type: "feature", parent: "o/repo#2", inProject: true },
  "o/repo#4": { title: "DevTask-0003-Cũ", type: "dev-task", parent: "o/repo#3", inProject: true },
  "o/repo#5": {
    title: "DevTask-0007-Cũ hơn",
    type: "dev-task",
    parent: "o/repo#3",
    inProject: true,
  },
});
const at = (number: number, repo = "repo") => ({ owner: "o", repo, number });
const BODY = "## Objective\nx\n\n## Scope / Acceptance\n- [ ] y";
const input = (parent = at(3), title = "Việc mới") => ({
  type: "dev-task" as const,
  title,
  body: BODY,
  parent,
});

test("numbers per type (max + 1), native type, sub-issue and Project", () => {
  const gh = fakeGh(tree());
  const r = createIssue(config, input(), gh.run);
  assert.equal(r.number, 6);
  assert.equal(r.title, "DevTask-0008-Việc mới");
  assert.equal(r.url, "https://github.com/o/repo/issues/6");
  assert.ok(r.created);
  assert.deepEqual(r.changes, ["create", "parent", "project", "status", "title"]);
  assert.deepEqual(gh.writes, [
    "create:IT_TASK",
    "parent:o/repo#3",
    "project",
    "status:Backlog",
    "title:DevTask-0008-Việc mới",
  ]);
  assert.equal(gh.issues.get("o/repo#6")?.body, BODY);
});

test("re-run is a no-op; a half-done Issue is completed, not duplicated", () => {
  const gh = fakeGh(tree());
  createIssue(config, input(), gh.run);
  const writes = gh.writes.length;
  const again = createIssue(config, input(at(3), "DevTask-0008-Việc mới"), gh.run);
  assert.equal(again.number, 6);
  assert.equal(again.created, false);
  assert.deepEqual(again.changes, []);
  assert.equal(gh.writes.length, writes);

  // Crash after create: bare title, no parent, not in the Project.
  const half = fakeGh({ ...tree(), "o/repo#6": { title: "Việc mới", type: "dev-task" } });
  const r = createIssue(config, input(), half.run);
  assert.equal(r.number, 6);
  assert.deepEqual(r.changes, ["parent", "project", "status", "title"]);
  assert.equal(half.issues.size, 6);

  // Crash after adding to the Project (DevTask-0030 #62): Status still unset → set once.
  const unset = fakeGh({
    ...tree(),
    "o/repo#6": {
      title: "DevTask-0008-Việc mới",
      type: "dev-task",
      parent: "o/repo#3",
      inProject: true,
    },
  });
  assert.deepEqual(createIssue(config, input(), unset.run).changes, ["status"]);
  assert.deepEqual(createIssue(config, input(), unset.run).changes, []);
  // A Status someone already set is never overwritten.
  const set = fakeGh({
    ...tree(),
    "o/repo#6": {
      title: "DevTask-0008-Việc mới",
      type: "dev-task",
      parent: "o/repo#3",
      inProject: true,
      status: "Ready",
    },
  });
  assert.deepEqual(createIssue(config, input(), set.run).changes, []);
  assert.equal(set.issues.get("o/repo#6")?.status, "Ready");
  // A Project without the initial option (no `omi project apply` yet): Issue still completed.
  const bare = fakeGh(tree(), { statusOptions: ["Todo", "Done"] });
  const made = createIssue(config, input(), bare.run);
  assert.deepEqual(made.changes, ["create", "parent", "project", "title"]);
  assert.equal(made.title, "DevTask-0008-Việc mới");
});

test("a closed Issue with the same title is not reused, but still counts for numbering", () => {
  const gh = fakeGh({
    ...tree(),
    "o/repo#6": { title: "DevTask-0011-Việc mới", type: "dev-task", state: "CLOSED" },
  });
  const r = createIssue(config, input(), gh.run);
  assert.equal(r.number, 7);
  assert.equal(r.title, "DevTask-0012-Việc mới");
});

test("wrong parent type, closed parent and a different existing parent are refused before writing", () => {
  const gh = fakeGh({
    ...tree(),
    "o/repo#9": { title: "Feature-0010-Đóng", type: "feature", state: "CLOSED" },
  });
  assert.throws(
    () => createIssue(config, input(at(1)), gh.run),
    (e: OmiError) => {
      assert.equal(e.code, "POLICY_VIOLATION");
      assert.match(e.message, /cannot be a child of #1 \(epic\)/);
      return true;
    },
  );
  assert.throws(() => createIssue(config, input(at(9)), gh.run), /closed/);
  assert.throws(() => createIssue(config, input(at(42)), gh.run), /not found/);
  // #4 exists under #3: asking for it under #5 is not silently re-parented.
  assert.throws(
    () => createIssue(config, input(at(5), "Cũ"), gh.run),
    /already has parent o\/repo#3/,
  );
  assert.deepEqual(gh.writes, []);
});

test("a cycle is refused before writing", () => {
  // #6 (existing, no parent yet) would become a child of #7, which is a child of #6.
  const gh = fakeGh({
    ...tree(),
    "o/repo#6": { title: "DevTask-0008-Vòng", type: "dev-task", inProject: true },
    "o/repo#7": {
      title: "DevTask-0009-Con",
      type: "dev-task",
      parent: "o/repo#6",
      inProject: true,
    },
  });
  assert.throws(() => createIssue(config, input(at(7), "Vòng"), gh.run), /cycle: #6/);
  assert.deepEqual(gh.writes, []);
});

test("a parent in another repository must be in the Project", () => {
  const outside = fakeGh({ ...tree(), "o/other#3": { title: "Feature-0001-X", type: "feature" } });
  assert.throws(
    () => createIssue(config, input(at(3, "other")), outside.run),
    (e: OmiError) => e.code === "TICKET_NOT_IN_PROJECT",
  );
  assert.deepEqual(outside.writes, []);

  // Same number as a local Issue (#3), different repository: not a false cycle.
  const inside = fakeGh({
    ...tree(),
    "o/other#3": { title: "Feature-0001-X", type: "feature", inProject: true },
  });
  const r = createIssue(config, input(at(3, "other")), inside.run);
  assert.ok(inside.writes.includes("parent:o/other#3"));
  assert.equal(r.title, "DevTask-0008-Việc mới");
});

test("numbering that keeps clashing stops with an error instead of a duplicate", () => {
  const gh = fakeGh(tree(), {
    onTitle: () => {
      const mine = gh.issues.get("o/repo#6") as FakeIssue;
      (gh.issues.get("o/repo#4") as FakeIssue).title = mine.title.replace("Việc mới", "Khác");
    },
  });
  assert.throws(() => createIssue(config, input(), gh.run), /still taken .* after 3 renumbers/);
});

test("numbering race: the later Issue moves to the next number; pages are all read", () => {
  let raced = false;
  const gh = fakeGh(tree(), {
    pageSize: 2,
    onTitle: () => {
      if (raced) return;
      raced = true; // another creator took 0008 on a lower Issue number meanwhile
      const four = gh.issues.get("o/repo#4") as FakeIssue;
      four.title = "DevTask-0008-Khác";
    },
  });
  const r = createIssue(config, input(), gh.run);
  assert.equal(r.title, "DevTask-0009-Việc mới");
  assert.deepEqual(
    gh.writes.filter((w) => w.startsWith("title")),
    ["title:DevTask-0008-Việc mới", "title:DevTask-0009-Việc mới"],
  );
});

test("a body without the form's required sections is refused before any write", () => {
  const gh = fakeGh(tree());
  assert.throws(
    () => createIssue(config, { ...input(), body: "## Objective\nx" }, gh.run),
    /missing required sections .*: Scope \/ Acceptance/,
  );
  assert.deepEqual(gh.writes, []);
});

test("missing type label is a config error; empty title is a usage error", () => {
  const gh = fakeGh(tree());
  assert.throws(
    () => createIssue(config, { ...input(), type: "bogus" as "dev-task" }, gh.run),
    (e: OmiError) => e.code === "CONFIG_INVALID",
  );
  assert.throws(
    () => createIssue(config, input(at(3), "DevTask-0001- "), gh.run),
    (e: OmiError) => e.code === "USAGE_INVALID",
  );
});

test("issue section get reads one omi:section", () => {
  const body = "a\n<!-- omi:section=test-cases -->\n- [ ] one\n<!-- /omi:section=test-cases -->\nb";
  assert.equal(sectionOf(body, "test-cases"), "- [ ] one");
  assert.equal(sectionOf(body, "other"), null);
  const gh = fakeGh({ "o/repo#1": { title: "DevTask-0001-x", type: "dev-task", body } });
  assert.equal(readSection(config, 1, "test-cases", gh.run), "- [ ] one");
  assert.throws(() => readSection(config, 1, "other", gh.run), /no section other/);
});
