// DevTask-0030 #62: `omi project plan|apply` against an in-memory Project: reconcile twice writes
// once, option IDs survive, no write without permission, Status drift across pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import {
  projectApply,
  projectPlan,
  statusDrift,
} from "../../runtime/adapters/github/project-fields.ts";
import type { OmiConfig } from "../../runtime/core/config.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";
import { type GhOption, loadProjectConfig } from "../../runtime/core/project-config.ts";

const config = { github: { owner: "o", repo: "repo", projectNumber: 2 } } as OmiConfig;
const desired = loadProjectConfig();

interface FakeField {
  id: string;
  name: string;
  dataType: string;
  options?: GhOption[];
}
interface FakeItem {
  issue?: { number: number; type?: string };
  status?: string;
}

function fakeProject(
  seed: FakeField[],
  opts: { canUpdate?: boolean; forbidden?: boolean; items?: FakeItem[]; pageSize?: number } = {},
) {
  const fields = structuredClone(seed);
  const writes: string[] = [];
  let seq = 0;
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const project = (body: unknown) => ok({ repositoryOwner: { projectV2: body } });
  const run: GhRunner = (args, input) => {
    const { query, variables: v } = input
      ? JSON.parse(input)
      : {
          query: (args[3] ?? "").slice("query=".length),
          variables: Object.fromEntries(
            args
              .slice(4)
              .filter((_, i) => i % 2 === 1)
              .map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
          ),
        };
    if (/createProjectV2Field|updateProjectV2Field/.test(query) && opts.forbidden) {
      return {
        status: 1,
        stdout: JSON.stringify({ errors: [{ type: "FORBIDDEN", message: "no access" }] }),
        stderr: "",
      };
    }
    if (query.includes("createProjectV2Field")) {
      const options = (v.o as GhOption[] | undefined)?.map((o) => ({ ...o, id: `new${++seq}` }));
      fields.push({ id: `F${++seq}`, name: v.n, dataType: v.t, options });
      writes.push(`create:${v.n}`);
      return ok({});
    }
    if (query.includes("updateProjectV2Field")) {
      const f = fields.find((x) => x.id === v.f) as FakeField;
      f.options = (v.o as GhOption[]).map((o) => ({ ...o, id: o.id ?? `new${++seq}` }));
      writes.push(`options:${f.name}`);
      return ok({});
    }
    if (query.includes("viewerCanUpdate")) {
      return project({
        id: "P",
        viewerCanUpdate: opts.canUpdate ?? true,
        fields: {
          nodes: fields.map((f) => ({
            __typename: f.options ? "ProjectV2SingleSelectField" : "ProjectV2Field",
            ...f,
          })),
        },
      });
    }
    if (query.includes("items(first:100")) {
      const all = opts.items ?? [];
      const size = opts.pageSize ?? 100;
      const start = v.after ? Number(v.after) : 0;
      const more = start + size < all.length;
      return project({
        items: {
          pageInfo: { hasNextPage: more, endCursor: more ? String(start + size) : null },
          nodes: all.slice(start, start + size).map((i) => ({
            content: i.issue
              ? {
                  __typename: "Issue",
                  number: i.issue.number,
                  repository: { nameWithOwner: "o/repo" },
                  labels: { nodes: i.issue.type ? [{ name: `type:${i.issue.type}` }] : [] },
                }
              : { __typename: "PullRequest" },
            fieldValueByName: i.status ? { name: i.status } : null,
          })),
        },
      });
    }
    throw new Error(`unexpected query ${query.slice(0, 80)}`);
  };
  return { run, fields, writes };
}

const want = (name: string): GhOption[] => {
  const f = desired.fields.find((x) => x.name === name);
  return f?.type === "single_select" ? f.options.map((o, i) => ({ ...o, id: `${name}${i}` })) : [];
};
/** Project #2 before PO's 2026-11-18 change: 10 Status options, no Risk / Target Date. */
const before = (): FakeField[] => [
  { id: "T", name: "Title", dataType: "TITLE" },
  {
    id: "S",
    name: "Status",
    dataType: "SINGLE_SELECT",
    options: want("Status").filter((o) => !["Triage", "Analysis", "Approved"].includes(o.name)),
  },
  { id: "PR", name: "Priority", dataType: "SINGLE_SELECT", options: want("Priority") },
  { id: "Z", name: "Size", dataType: "SINGLE_SELECT", options: want("Size") },
  { id: "PH", name: "Phase", dataType: "SINGLE_SELECT", options: [] },
  { id: "I", name: "Sprint", dataType: "ITERATION" },
];

test("apply creates what is missing, keeps option IDs; a second apply writes nothing", () => {
  const gh = fakeProject(before());
  const ids = Object.fromEntries((gh.fields[1]?.options ?? []).map((o) => [o.name, o.id]));
  const plan = projectPlan(config, gh.run);
  assert.deepEqual(
    plan.actions.map((a) => a.kind),
    ["update-options", "create", "create"],
  );
  assert.deepEqual(plan.extra, ["Phase"]);
  assert.deepEqual(gh.writes, [], "plan is read-only");

  const r = projectApply(config, gh.run);
  assert.deepEqual(gh.writes, ["options:Status", "create:Risk", "create:Target Date"]);
  assert.deepEqual(r.plan.actions, []);
  const status = gh.fields.find((f) => f.name === "Status")?.options ?? [];
  assert.equal(status.length, 13);
  for (const [name, id] of Object.entries(ids)) {
    assert.equal(status.find((o) => o.name === name)?.id, id, `${name} keeps its ID`);
  }
  assert.ok(
    gh.fields.some((f) => f.name === "Phase"),
    "extra field is never deleted",
  );

  const again = projectApply(config, gh.run);
  assert.deepEqual(again.applied, []);
  assert.equal(gh.writes.length, 3);
});

test("a field of the wrong type or duplicated is manual: apply does not touch it", () => {
  const seed = before();
  seed.push({ id: "D", name: "Target Date", dataType: "TEXT" });
  seed.push({ id: "Z2", name: "size", dataType: "SINGLE_SELECT", options: [] });
  const gh = fakeProject(seed);
  const r = projectApply(config, gh.run);
  assert.deepEqual(gh.writes, ["options:Status", "create:Risk"]);
  assert.deepEqual(
    r.plan.actions.map((a) => (a.kind === "manual" ? a.name : a.kind)),
    ["Size", "Target Date"],
  );
});

test("no permission: refused before any write; a FORBIDDEN write is an auth error", () => {
  const ro = fakeProject(before(), { canUpdate: false });
  assert.equal(projectPlan(config, ro.run).actions.length, 3, "plan still works read-only");
  assert.throws(
    () => projectApply(config, ro.run),
    (e: OmiError) => e.code === "GITHUB_AUTH" && /no write access/.test(e.message),
  );
  assert.deepEqual(ro.writes, []);

  const denied = fakeProject(before(), { forbidden: true });
  assert.throws(
    () => projectApply(config, denied.run),
    (e: OmiError) => e.code === "GITHUB_AUTH",
  );
  // In the desired state already: no write is attempted, so no permission is needed.
  const synced = fakeProject(before());
  projectApply(config, synced.run);
  const quiet = fakeProject(synced.fields, { canUpdate: false });
  assert.deepEqual(projectApply(config, quiet.run).applied, []);
});

test("Status drift: outside the type's lifecycle, unset, unknown, no type — across pages", () => {
  const gh = fakeProject(before(), {
    pageSize: 2,
    items: [
      { issue: { number: 1, type: "dev-task" }, status: "In Progress" },
      { issue: { number: 2, type: "dev-task" }, status: "Triage" },
      { issue: { number: 3, type: "bug" }, status: "Triage" },
      { issue: { number: 4, type: "feature" } },
      { issue: { number: 5, type: "epic" }, status: "Someday" },
      { issue: { number: 6 }, status: "Backlog" },
      {},
    ],
  });
  assert.deepEqual(
    statusDrift(config, gh.run).map((d) => `#${d.issue.split("#")[1]} ${d.reason}`),
    [
      "#2 dev-task does not use 'Triage'",
      "#4 Status unset",
      "#5 'Someday' is not a ProjectStatus",
      "#6 no single valid type:* label",
    ],
  );
});
