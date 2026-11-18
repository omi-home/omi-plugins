// DevTask-0031 #63: views/workflows/Insights desired state and its pure diff; origin URL parsing.
import assert from "node:assert/strict";
import { test } from "node:test";
import { originRepo } from "../../runtime/cli/init.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";
import {
  type ActualView,
  loadViewsConfig,
  planViews,
  ViewsConfig,
} from "../../runtime/core/project-config.ts";

const desired = loadViewsConfig();
/** GitHub's view as `want` would look once fully configured. */
const actualOf = (v: ViewsConfig["views"][number], i: number): ActualView => ({
  id: `V${i}`,
  name: v.name,
  layout: v.layout,
  filter: v.filter ?? "",
  groupBy: v.groupBy ?? "",
  columns: v.columns ?? "",
  sort: v.sort ?? "",
});
const workflows = Object.entries(desired.workflows).map(([name, enabled]) => ({ name, enabled }));

test("shipped views.yaml: governance views present, Insights listed as unsupported", () => {
  const names = desired.views.map((v) => v.name);
  for (const n of ["WBS", "Backlog", "Review & QA", "Blockers/Risks", "Release Roadmap"]) {
    assert.ok(names.includes(n), n);
  }
  assert.ok(desired.views.some((v) => v.layout === "board"));
  assert.equal(desired.workflows["Item closed"], false);
  const plan = planViews(desired, desired.views.map(actualOf), workflows);
  assert.deepEqual(plan.actions, [], "fully configured Project: nothing to do");
  assert.equal(plan.unsupported.length, desired.insights.length);
});

test("missing view: create + manual steps for its settings (not for defaults)", () => {
  const cfg = ViewsConfig.parse({
    views: [
      { name: "Board", layout: "board", filter: "", columns: "Status" },
      { name: "Q", layout: "table", filter: "is:open", sort: "Priority asc, Size desc" },
    ],
  });
  const plan = planViews(cfg, [], []);
  assert.deepEqual(
    plan.actions.map((a) => (a.kind === "manual" ? `manual ${a.name}: ${a.reason}` : a.kind)),
    [
      "create-view",
      "create-view",
      "manual Q: set filter to 'is:open' in the Project UI",
      "manual Q: set sort to 'Priority asc, Size desc' in the Project UI",
    ],
  );
});

test("existing view: wrong layout, duplicate name and setting drift are manual; extras kept", () => {
  const cfg = ViewsConfig.parse({
    views: [
      { name: "A", layout: "board" },
      { name: "B", layout: "table" },
      { name: "C", layout: "table", filter: "is:open", groupBy: "Status" },
      { name: "D", layout: "roadmap" },
      { name: "WBS", layout: "table" },
    ],
    workflows: { "Item closed": false, Missing: true },
  });
  const base = { filter: "", groupBy: "", columns: "", sort: "" };
  const plan = planViews(
    cfg,
    [
      { id: "1", name: "A", layout: "table", ...base },
      { id: "2", name: "B", layout: "table", ...base },
      { id: "3", name: "b", layout: "table", ...base },
      { id: "4", name: "C", layout: "table", ...base, filter: " is:open " },
      { id: "5", name: "D", layout: "roadmap", ...base, groupBy: "Phase" },
      { id: "6", name: "Old", layout: "table", ...base },
      { id: "7", name: "wbs", layout: "table", ...base },
    ],
    [{ name: "Item closed", enabled: true }],
  );
  assert.deepEqual(
    plan.actions.map((a) => ("reason" in a ? `${a.name}: ${a.reason}` : a.kind)),
    [
      "A: layout is table, desired board: change it in the Project UI",
      "B: 2 views share this name: delete the extra ones in the Project UI",
      "C: set group by to 'Status' in the Project UI (now (none))",
      "WBS: rename view 'wbs' to 'WBS' in the Project UI",
      "workflow Item closed: disable it in Project settings → Workflows (no API)",
      "workflow Missing: not found on the Project",
    ],
    "unmanaged groupBy of D is ignored; filter compared trimmed",
  );
  assert.deepEqual(plan.extraViews, ["Old"]);
});

test("ViewsConfig rejects duplicates, columns off a board, bad sort and unknown keys", () => {
  for (const bad of [
    {
      views: [
        { name: "X", layout: "table" },
        { name: "x", layout: "board" },
      ],
    },
    { views: [{ name: "X", layout: "table", columns: "Status" }] },
    { views: [{ name: "X", layout: "table", sort: "Priority up" }] },
    { views: [{ name: "X", layout: "table", color: "red" }] },
    { views: [], extra: 1 },
  ]) {
    assert.equal(ViewsConfig.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("originRepo: https and ssh GitHub remotes; anything else refused", () => {
  assert.deepEqual(originRepo("https://github.com/omi-home/omi-plugins.git"), {
    owner: "omi-home",
    repo: "omi-plugins",
  });
  assert.deepEqual(originRepo("git@github.com:o/r.js"), { owner: "o", repo: "r.js" });
  assert.throws(
    () => originRepo("https://gitlab.com/o/r.git"),
    (e: OmiError) => e.code === "CONFIG_INVALID",
  );
});
