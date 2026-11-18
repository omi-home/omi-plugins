// DevTask-0030 #62: `omi project plan|apply` against an in-memory Project: reconcile twice writes
// once, option IDs survive, no write without permission, Status drift across pages.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import {
  projectApply,
  projectPlan,
  projectValidate,
  statusDrift,
} from "../../runtime/adapters/github/project-fields.ts";
import type { OmiConfig } from "../../runtime/core/config.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";
import {
  type GhOption,
  loadProjectConfig,
  loadViewsConfig,
} from "../../runtime/core/project-config.ts";

const config = { github: { owner: "o", repo: "repo", projectNumber: 2 } } as OmiConfig;
const desired = loadProjectConfig();
const desiredViews = loadViewsConfig();

interface FakeField {
  id: string;
  name: string;
  dataType: string;
  options?: GhOption[];
}
interface FakeView {
  name: string;
  layout: string;
  filter?: string;
  columns?: string;
  groupBy?: string;
  sort?: string;
}
/** GitHub's views once every desired setting was done by hand. */
const configuredViews = (): FakeView[] =>
  desiredViews.views.map((v) => ({ ...v, layout: `${v.layout.toUpperCase()}_LAYOUT` }));

interface FakeItem {
  issue?: { number: number; type?: string };
  status?: string;
}

function fakeProject(
  seed: FakeField[],
  opts: {
    canUpdate?: boolean;
    forbidden?: boolean;
    items?: FakeItem[];
    pageSize?: number;
    views?: FakeView[];
    workflows?: { name: string; enabled: boolean }[];
  } = {},
) {
  const fields = structuredClone(seed);
  const views = structuredClone(opts.views ?? configuredViews());
  const workflows =
    opts.workflows ??
    Object.entries(desiredViews.workflows).map(([name, enabled]) => ({ name, enabled }));
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
    if (query.includes("createProjectV2View")) {
      views.push({ name: v.n, layout: v.l, columns: v.l === "BOARD_LAYOUT" ? "Status" : "" });
      writes.push(`view:${v.n}`);
      return ok({});
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
        views: {
          nodes: views.map((w, i) => ({
            id: `V${i}`,
            name: w.name,
            layout: w.layout,
            filter: w.filter ?? "",
            groupByFields: { nodes: w.groupBy ? [{ name: w.groupBy }] : [] },
            verticalGroupByFields: { nodes: w.columns ? [{ name: w.columns }] : [] },
            sortByFields: {
              nodes: w.sort
                ? w.sort.split(", ").map((x) => {
                    const [name, dir] = x.split(" ");
                    return { direction: dir?.toUpperCase(), field: { name } };
                  })
                : [],
            },
          })),
        },
        workflows: { nodes: workflows },
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
  return { run, fields, views, writes };
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

test("views: apply creates missing ones by name + layout once; settings stay manual", () => {
  const seed = configuredViews().filter((v) => v.name !== "Blockers/Risks" && v.name !== "Kanban");
  seed.push({ name: "Spike", layout: "TABLE_LAYOUT" });
  const gh = fakeProject(before(), {
    views: seed,
    workflows: [
      { name: "Auto-add sub-issues to project", enabled: true },
      { name: "Item closed", enabled: true },
      { name: "Pull request merged", enabled: false },
    ],
  });
  const plan = projectPlan(config, gh.run);
  assert.deepEqual(
    plan.views.actions.map((a) => (a.kind === "create-view" ? `create ${a.view.name}` : a.name)),
    [
      "create Blockers/Risks",
      "Blockers/Risks",
      "Blockers/Risks",
      "create Kanban",
      "Kanban",
      "workflow Item closed",
    ],
  );
  assert.deepEqual(plan.views.extraViews, ["Spike"]);

  const r = projectApply(config, gh.run);
  assert.deepEqual(
    gh.writes.filter((w) => w.startsWith("view:")),
    ["view:Blockers/Risks", "view:Kanban"],
  );
  assert.equal(gh.views.find((v) => v.name === "Kanban")?.layout, "BOARD_LAYOUT");
  assert.ok(
    gh.views.some((v) => v.name === "Spike"),
    "extra view never deleted",
  );
  assert.deepEqual(
    r.plan.views.actions.map((a) => ("reason" in a ? a.reason : a.kind)),
    [
      "set filter to 'status:Blocked,\"Waiting PO\"' in the Project UI (now (none))",
      "set group by to 'Status' in the Project UI (now (none))",
      "set filter to '-status:Cancelled' in the Project UI (now (none))",
      "disable it in Project settings → Workflows (no API)",
    ],
    "verify read-back: a new board already has Status columns",
  );
  const writes = gh.writes.length;
  assert.deepEqual(projectApply(config, gh.run).applied, []);
  assert.equal(gh.writes.length, writes, "second apply: no duplicate view");
});

test("validate: checks per area; Insights and extras warn, missing view fails", () => {
  const synced = fakeProject(before());
  projectApply(config, synced.run);
  const ok = projectValidate(config, fakeProject(synced.fields).run);
  assert.deepEqual(
    ok.map((c) => `${c.name}:${c.status}`),
    [
      "fields:pass",
      "views:pass",
      "workflows:pass",
      "status-drift:pass",
      "extra:warn",
      "insights:warn",
    ],
  );
  const missing = projectValidate(
    config,
    fakeProject(synced.fields, { views: configuredViews().slice(1) }).run,
  );
  assert.match(missing.find((c) => c.name === "views")?.detail ?? "", /missing view WBS/);
});
