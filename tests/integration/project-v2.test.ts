// DevTask-0102 #311: `omi github project plan|apply|validate` under github.model v2 against an
// in-memory Project: fields, 7 views (filter + layout through updateProjectV2View), manual guides,
// enabled built-in workflows, Status drift by native issue type; legacy stays untouched.
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
import { ProjectStatusV2 } from "../../runtime/core/contracts.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";
import { loadIssueTypesConfig } from "../../runtime/core/issue-type-config.ts";
import {
  type GhOption,
  initialStatuses,
  loadProjectConfigV2,
  loadViewsConfigV2,
} from "../../runtime/core/project-config.ts";

const config = {
  github: { owner: "o", repo: "repo", projectNumber: 2, model: "v2" },
} as OmiConfig;
const fields = loadProjectConfigV2();
const views = loadViewsConfigV2();

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
interface FakeItem {
  number: number;
  issueType?: string;
  status?: string;
}

const BUILTIN: FakeField[] = ["Title", "Type", "Parent issue", "Sub-issues progress"].map(
  (name) => ({
    id: `B-${name}`,
    name,
    dataType: name === "Title" ? "TITLE" : "OTHER",
  }),
);
const DATA_TYPE = { single_select: "SINGLE_SELECT", date: "DATE" } as Record<string, string>;
/** The custom fields once applied. */
const customFields = (): FakeField[] =>
  fields.fields.map((f, i) => ({
    id: `F${i}`,
    name: f.name,
    dataType: DATA_TYPE[f.type] ?? f.type.toUpperCase(),
    options:
      f.type === "single_select"
        ? f.options.map((o, j) => ({ ...o, id: `O${i}-${j}` }))
        : undefined,
  }));
/** GitHub's views once every desired setting was done (filter, layout, group, sort, columns). */
const configuredViews = (): FakeView[] =>
  views.views.map((v) => ({ ...v, layout: `${v.layout.toUpperCase()}_LAYOUT` }));

function fakeProject(
  opts: {
    fields?: FakeField[];
    views?: FakeView[];
    canUpdate?: boolean;
    workflows?: { name: string; enabled: boolean }[];
    items?: FakeItem[];
  } = {},
) {
  const fieldList = structuredClone(opts.fields ?? [...BUILTIN, ...customFields()]);
  const viewList = structuredClone(opts.views ?? configuredViews());
  const writes: string[] = [];
  let seq = 0;
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const project = (body: unknown) => ok({ repositoryOwner: { projectV2: body } });
  const run: GhRunner = (args, input) => {
    if (args[0] === "api" && args[1] === "--include") return { status: 0, stdout: "", stderr: "" };
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
    if (query.includes("issueTypes(first:25)")) {
      return ok({
        repositoryOwner: {
          __typename: "Organization",
          id: "ORG",
          issueTypes: {
            nodes: loadIssueTypesConfig().types.map((t, i) => ({
              id: `IT${i}`,
              name: t.name,
              description: t.description,
              color: t.color,
              isEnabled: true,
            })),
          },
        },
      });
    }
    if (query.includes("createProjectV2View")) {
      viewList.push({ name: v.n, layout: v.l, columns: v.l === "BOARD_LAYOUT" ? "Status" : "" });
      writes.push(`create-view:${v.n}`);
      return ok({});
    }
    if (query.includes("updateProjectV2View")) {
      const w = viewList[Number(String(v.v).slice(1))] as FakeView;
      if (v.f !== undefined) w.filter = v.f;
      if (v.l !== undefined) w.layout = v.l;
      writes.push(
        `update-view:${w.name}${v.f !== undefined ? ":filter" : ""}${v.l ? ":layout" : ""}`,
      );
      return ok({});
    }
    if (query.includes("createProjectV2Field")) {
      const options = (v.o as GhOption[] | undefined)?.map((o) => ({ ...o, id: `n${++seq}` }));
      fieldList.push({ id: `N${++seq}`, name: v.n, dataType: v.t, options });
      writes.push(`create-field:${v.n}`);
      return ok({});
    }
    if (query.includes("updateProjectV2Field")) {
      const f = fieldList.find((x) => x.id === v.f) as FakeField;
      f.options = (v.o as GhOption[]).map((o) => ({ ...o, id: o.id ?? `n${++seq}` }));
      writes.push(`options:${f.name}`);
      return ok({});
    }
    if (query.includes("viewerCanUpdate")) {
      return project({
        id: "P",
        viewerCanUpdate: opts.canUpdate ?? true,
        fields: {
          nodes: fieldList.map((f) => ({
            __typename: f.options ? "ProjectV2SingleSelectField" : "ProjectV2Field",
            ...f,
          })),
        },
        views: {
          nodes: viewList.map((w, i) => ({
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
        workflows: { nodes: opts.workflows ?? [{ name: "Item closed", enabled: false }] },
      });
    }
    if (query.includes("items(first:100")) {
      assert.match(query, /issueType\{ name \}/, "model v2 reads the native issue type");
      assert.doesNotMatch(query, /labels\(first/, "…and no type:* label");
      return project({
        items: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: (opts.items ?? []).map((i) => ({
            content: {
              __typename: "Issue",
              number: i.number,
              repository: { nameWithOwner: "o/repo" },
              issueType: i.issueType ? { name: i.issueType } : null,
            },
            fieldValueByName: i.status ? { name: i.status } : null,
          })),
        },
      });
    }
    throw new Error(`unexpected gh call: ${query.slice(0, 60)}`);
  };
  return { run, writes, views: viewList, fields: fieldList };
}

const kinds = (p: { actions: { kind: string }[] }) => p.actions.map((a) => a.kind);

test("the shipped v2 desired state: 10 Status options in enum order, Priority, Story Type, Severity, dates", () => {
  const status = fields.fields.find((f) => f.name === "Status");
  assert.ok(status?.type === "single_select");
  assert.deepEqual(
    status.options.map((o) => o.name),
    [...ProjectStatusV2.options],
  );
  assert.ok(status.options.every((o) => o.description.length > 0));
  const options = (n: string) => {
    const f = fields.fields.find((x) => x.name === n);
    return f?.type === "single_select" ? f.options.map((o) => o.name) : [];
  };
  assert.deepEqual(options("Priority"), ["P0", "P1", "P2"]);
  assert.deepEqual(options("Story Type"), ["FR", "NFR", "CR"]);
  assert.deepEqual(options("Severity"), ["S1", "S2", "S3"]);
  assert.deepEqual(
    fields.fields.filter((f) => f.type === "date").map((f) => f.name),
    ["Start", "Target"],
  );
  assert.equal(views.views.length, 7);
  // The initial status comes from workflow.yaml, per type.
  const initial = initialStatuses();
  assert.equal(initial.Epic, "Draft");
  assert.equal(initial.DevTask, "Ready");
  assert.ok(Object.values(initial).every((s) => status.options.some((o) => o.name === s)));
});

test("empty Project: plan lists every field and view; manual guides, never a write", () => {
  const gh = fakeProject({ fields: [...BUILTIN.slice(0, 1)], views: [] });
  const plan = projectPlan(config, gh.run);
  assert.equal(plan.actions.filter((a) => a.kind === "create").length, 6);
  assert.equal(plan.views.actions.filter((a) => a.kind === "create-view").length, 7);
  const manual = plan.views.actions.filter((a) => a.kind === "manual").map((a) => `${a.name}`);
  assert.ok(
    manual.some((n) => n.includes("Roadmap")),
    "group by Milestone is manual",
  );
  assert.ok(
    manual.some((n) => n.includes("Bugs")),
    "sort is manual",
  );
  assert.ok(
    plan.views.unsupported.some((u) => /field Type: add it/.test(u)),
    "Type field guide",
  );
  assert.ok(plan.views.unsupported.some((u) => /Stories.*show Story Type/.test(u)));
  assert.deepEqual(gh.writes, [], "plan is read-only");
});

test("apply is idempotent: creates fields + views, sets filter and layout once; rerun writes nothing", () => {
  const gh = fakeProject({ fields: [...BUILTIN.slice(0, 1)], views: [] });
  const first = projectApply(config, gh.run);
  assert.equal(gh.writes.filter((w) => w.startsWith("create-field:")).length, 6);
  assert.equal(gh.writes.filter((w) => w.startsWith("create-view:")).length, 7);
  const filters = gh.writes.filter((w) => w.startsWith("update-view:") && w.endsWith(":filter"));
  assert.equal(filters.length, 7, "every new view gets its filter");
  const status = gh.fields.find((f) => f.name === "Status");
  assert.deepEqual(
    status?.options?.map((o) => o.name),
    [...ProjectStatusV2.options],
  );
  assert.equal(
    gh.views.find((v) => v.name.includes("Bugs"))?.filter,
    "type:Bug is:open",
    "filter read back from GitHub",
  );
  assert.ok(first.applied.some((a) => a.kind === "update-view"));
  // Left: only what has no API (group/sort/columns of the fake are not set by apply).
  assert.ok(kinds(first.plan.views).every((k) => k === "manual"));
  assert.deepEqual(first.plan.actions, []);

  const before = gh.writes.length;
  const second = projectApply(config, gh.run);
  assert.equal(gh.writes.length, before, "second run writes nothing");
  assert.deepEqual(second.applied, []);
});

test("an existing view with a wrong filter or layout is updated, not duplicated", () => {
  const seeded = configuredViews().map((v) => ({ ...v }));
  const roadmap = seeded.find((v) => v.name.includes("Roadmap")) as FakeView;
  roadmap.filter = "type:Feature";
  const inbox = seeded.find((v) => v.name.includes("Inbox")) as FakeView;
  inbox.layout = "BOARD_LAYOUT";
  const gh = fakeProject({ views: seeded });
  const plan = projectPlan(config, gh.run);
  assert.deepEqual(kinds(plan.views).sort(), ["update-view", "update-view"]);
  projectApply(config, gh.run);
  assert.deepEqual(gh.writes.sort(), [
    "update-view:📥 PO Inbox:layout",
    "update-view:🗺 Roadmap:filter",
  ]);
  assert.equal(gh.views.length, 7);
  assert.equal(gh.views.find((v) => v.name.includes("Roadmap"))?.filter, "type:Epic");
  assert.equal(gh.views.find((v) => v.name.includes("Inbox"))?.layout, "TABLE_LAYOUT");
  const again = projectApply(config, gh.run);
  assert.deepEqual(again.applied, []);
});

test("every enabled built-in workflow is reported with the manual step; validate fails on it", () => {
  const enabled = [
    { name: "Auto-add to project", enabled: true },
    { name: "Item closed", enabled: false },
    { name: "Pull request merged", enabled: true },
  ];
  const gh = fakeProject({ workflows: enabled });
  const plan = projectPlan(config, gh.run);
  const flows = plan.views.actions.filter((a) => a.kind === "workflow");
  assert.deepEqual(
    flows.map((a) => a.name),
    ["workflow Auto-add to project", "workflow Pull request merged"],
  );
  assert.ok(flows.every((a) => /disable it in Project settings → Workflows/.test(a.reason)));
  const checks = projectValidate(config, gh.run);
  const wf = checks.find((c) => c.name === "workflows");
  assert.equal(wf?.status, "fail");
  assert.match(wf?.detail ?? "", /Auto-add to project/);
  // Once they are off: pass; the guides that need a person stay a warning.
  const clean = projectValidate(config, fakeProject().run);
  assert.equal(clean.find((c) => c.name === "workflows")?.status, "pass");
  assert.equal(clean.find((c) => c.name === "views")?.status, "pass");
  assert.equal(clean.find((c) => c.name === "manual-steps")?.status, "warn");
  assert.ok(
    clean.every((c) => c.status !== "fail"),
    JSON.stringify(clean),
  );
});

test("no write access: refused before any write", () => {
  const gh = fakeProject({ fields: [...BUILTIN.slice(0, 1)], views: [], canUpdate: false });
  assert.throws(
    () => projectApply(config, gh.run),
    (e: OmiError) => e.code === "GITHUB_AUTH",
  );
  assert.deepEqual(gh.writes, []);
});

test("Status drift follows the native issue type and workflow.yaml, not type:* labels", () => {
  const gh = fakeProject({
    items: [
      { number: 1, issueType: "Epic", status: "Draft" },
      { number: 2, issueType: "Epic", status: "Testing" },
      { number: 3, issueType: "DevTask" },
      { number: 4, status: "Ready" },
      { number: 5, issueType: "Bug", status: "Triage" },
    ],
  });
  const drift = statusDrift(config, gh.run);
  assert.deepEqual(
    drift.map((d) => [d.issue, d.reason]),
    [
      ["o/repo#2", "Epic does not use 'Testing'"],
      ["o/repo#3", "Status unset"],
      ["o/repo#4", "no native issue type of model v2"],
      ["o/repo#5", "'Triage' is not a ProjectStatusV2"],
    ],
  );
});

test("legacy keeps its desired state: project.yaml fields, no v2 reads", () => {
  const legacy = { github: { owner: "o", repo: "repo", projectNumber: 2 } } as OmiConfig;
  const gh = fakeProject({ fields: [...BUILTIN.slice(0, 1)], views: [] });
  const run: GhRunner = (args, input) => {
    assert.doesNotMatch(String(input ?? args.join(" ")), /issueTypes\(first/);
    return gh.run(args, input);
  };
  const plan = projectPlan(legacy, (a, i) =>
    /items\(first:100/.test(`${a}${i}`)
      ? {
          status: 0,
          stdout: JSON.stringify({
            data: {
              repositoryOwner: {
                projectV2: {
                  items: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                },
              },
            },
          }),
          stderr: "",
        }
      : run(a, i),
  );
  assert.ok(plan.actions.some((a) => a.kind === "create" && a.field.name === "Status"));
  assert.equal(plan.issueTypes, undefined);
  assert.ok(!plan.actions.some((a) => a.kind === "create" && a.field.name === "Story Type"));
});
