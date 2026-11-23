// DevTask-0123 #368: predicate evaluation, auto fixpoint, external changes, open/closed, Milestone.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ModelIndex,
  parseProjectModel,
  type WorkItem,
} from "../../../runtime/github/domain/project-model.ts";
import {
  checkExternalChange,
  computeFixpoint,
  desiredIssueState,
  evaluatePredicate,
  evaluateWhen,
  milestonesWithAllEpicsDone,
} from "../../../runtime/github/domain/workflow-engine.ts";
import { effectiveTransitions } from "../../../runtime/github/domain/workflow-queries.ts";
import { IssueTypeV2, ProjectStatusV2 } from "../../../runtime/shared/contracts.ts";
import { OmiError } from "../../../runtime/shared/errors/errors.ts";
import {
  loadDefaultWorkflow,
  type Predicate,
  resolveWorkflow,
} from "../../../runtime/shared/workflow.ts";

const mk = (
  n: number,
  type: IssueTypeV2,
  status: ProjectStatusV2,
  o: Partial<WorkItem> = {},
): WorkItem => ({
  number: n,
  type,
  status,
  state: status === "Done" ? "closed" : "open",
  closedByMergedPr: false,
  parent: null,
  children: [],
  blockedBy: [],
  externalBlockers: [],
  labels: [],
  linkedPrs: [],
  milestone: null,
  ...o,
});

const ev = (p: Parameters<typeof evaluatePredicate>[0], n: number, items: WorkItem[]) => {
  const idx = new ModelIndex(items);
  return evaluatePredicate(p, idx.get(n), idx);
};

// Story 1 with children 2 (DevTask), 3 (DesignTask), 4 (QATask), 5 (Bug)
const tree = (s: Record<number, ProjectStatusV2>, bug = true): WorkItem[] => [
  mk(1, "UserStory", s[1] ?? "In progress", { children: bug ? [2, 3, 4, 5] : [2, 3, 4] }),
  mk(2, "DevTask", s[2] ?? "Ready", { parent: 1 }),
  mk(3, "DesignTask", s[3] ?? "Ready", { parent: 1 }),
  mk(4, "QATask", s[4] ?? "Ready", { parent: 1 }),
  ...(bug ? [mk(5, "Bug", s[5] ?? "Ready", { parent: 1 })] : []),
];

test("any_child_in", () => {
  assert.equal(ev({ any_child_in: ["In progress"] }, 1, tree({ 2: "In progress" })), true);
  assert.equal(ev({ any_child_in: ["In progress"] }, 1, tree({})), false);
  assert.equal(ev({ any_child_in: ["In progress"] }, 2, tree({})), false); // no children
});

test("all_children_done", () => {
  assert.equal(
    ev({ all_children_done: true }, 1, tree({ 2: "Done", 3: "Done", 4: "Done", 5: "Done" })),
    true,
  );
  assert.equal(
    ev({ all_children_done: true }, 1, tree({ 2: "Done", 3: "Done", 4: "Done" })),
    false,
  );
  assert.equal(ev({ all_children_done: true }, 2, tree({})), false); // empty
});

test("children_done", () => {
  const p: Predicate = { children_done: ["DesignTask", "DevTask"] };
  assert.equal(ev(p, 1, tree({ 2: "Done", 3: "Done" })), true);
  assert.equal(ev(p, 1, tree({ 2: "Done" })), false);
  assert.equal(ev({ children_done: ["QATask"] }, 1, tree({}, false)), false);
  assert.equal(ev({ children_done: ["Bug"] }, 1, tree({}, false)), false); // none of the type
});

test("no_open_child", () => {
  assert.equal(ev({ no_open_child: ["Bug"] }, 1, tree({ 5: "Done" })), true);
  assert.equal(ev({ no_open_child: ["Bug"] }, 1, tree({})), false);
  assert.equal(ev({ no_open_child: ["Bug"] }, 1, tree({}, false)), true); // empty
  const closedNotPlanned = tree({}).map((i) =>
    i.number === 5 ? { ...i, state: "closed" as const, closeReason: "not_planned" as const } : i,
  );
  assert.equal(ev({ no_open_child: ["Bug"] }, 1, closedNotPlanned), true);
});

test("parent_status_in", () => {
  assert.equal(ev({ parent_status_in: ["In progress"] }, 2, tree({})), true);
  assert.equal(ev({ parent_status_in: ["Ready"] }, 2, tree({})), false);
  assert.equal(ev({ parent_status_in: ["Ready"] }, 1, tree({})), false); // no parent
});

test("blockers_done", () => {
  const items = [
    mk(1, "DevTask", "Blocked", { blockedBy: [2, 3] }),
    mk(2, "DesignTask", "Done"),
    mk(3, "DevTask", "In progress"),
    mk(4, "DevTask", "Blocked"),
  ];
  assert.equal(ev({ blockers_done: true }, 1, items), false);
  items[2] = mk(3, "DevTask", "Done");
  assert.equal(ev({ blockers_done: true }, 1, items), true);
  assert.equal(ev({ blockers_done: true }, 4, items), true); // empty: vacuous
});

test("linked_pr", () => {
  const pr = (
    state: "open" | "draft" | "merged" | "closed",
    verdict: "none" | "approved" | "changes_requested",
  ) => ({
    number: 9,
    state,
    verdict,
  });
  const dev = (prs: WorkItem["linkedPrs"]) => [mk(1, "DevTask", "In review", { linkedPrs: prs })];
  assert.equal(ev({ linked_pr: "open_ready" }, 1, dev([pr("open", "none")])), true);
  assert.equal(ev({ linked_pr: "open_ready" }, 1, dev([pr("open", "approved")])), true);
  assert.equal(ev({ linked_pr: "open_ready" }, 1, dev([pr("draft", "none")])), false);
  assert.equal(ev({ linked_pr: "open_ready" }, 1, dev([pr("merged", "none")])), false);
  assert.equal(ev({ linked_pr: "open_ready" }, 1, dev([pr("open", "changes_requested")])), false);
  assert.equal(ev({ linked_pr: "open_ready" }, 1, dev([])), false);
  assert.equal(
    ev({ linked_pr: "changes_requested" }, 1, dev([pr("open", "changes_requested")])),
    true,
  );
  assert.equal(
    ev({ linked_pr: "changes_requested" }, 1, dev([pr("draft", "changes_requested")])),
    false,
  );
  assert.equal(ev({ linked_pr: "changes_requested" }, 1, dev([pr("open", "none")])), false);
  assert.equal(ev({ linked_pr: "changes_requested" }, 1, dev([])), false);
});

test("linked_pr modes exclude each other with two open PRs (#368 CR-002)", () => {
  const prs: WorkItem["linkedPrs"] = [
    { number: 7, state: "open", verdict: "none" },
    { number: 8, state: "open", verdict: "changes_requested" },
  ];
  const items = [mk(1, "DevTask", "In review", { linkedPrs: prs })];
  assert.equal(ev({ linked_pr: "open_ready" }, 1, items), false);
  assert.equal(ev({ linked_pr: "changes_requested" }, 1, items), true);
  // Both transitions of the default workflow cannot hold together: the fixpoint terminates.
  const r = computeFixpoint([mk(1, "DevTask", "In progress", { linkedPrs: prs })]);
  assert.equal(r.applied.length <= 1, true);
});

test("blockers_done: external blockers hold until done (#368 CR-003)", () => {
  const ext = (done: boolean) => [
    mk(1, "DevTask", "Blocked", { externalBlockers: [{ ref: "o/other#5", done }] }),
  ];
  assert.equal(ev({ blockers_done: true }, 1, ext(false)), false);
  assert.equal(ev({ blockers_done: true }, 1, ext(true)), true);
});

test("issue_closed_by_pr", () => {
  const p = { issue_closed_by_pr: true } as const;
  assert.equal(
    ev(p, 1, [mk(1, "DevTask", "In review", { state: "closed", closedByMergedPr: true })]),
    true,
  );
  assert.equal(ev(p, 1, [mk(1, "DevTask", "In review", { state: "closed" })]), false);
  assert.equal(ev(p, 1, [mk(1, "DevTask", "In review", { closedByMergedPr: true })]), false);
});

test("siblings_done", () => {
  const p: Predicate = { siblings_done: ["DesignTask", "DevTask"] };
  assert.equal(ev(p, 4, tree({ 2: "Done", 3: "Done" })), true);
  assert.equal(ev(p, 4, tree({ 2: "Done" })), false);
  assert.equal(ev(p, 1, tree({})), false); // no parent: no siblings
  assert.equal(ev({ siblings_done: ["Bug"] }, 4, tree({}, false)), false); // none of the type
});

test("no_open_sibling", () => {
  assert.equal(ev({ no_open_sibling: ["Bug"] }, 4, tree({ 5: "Done" })), true);
  assert.equal(ev({ no_open_sibling: ["Bug"] }, 4, tree({})), false);
  assert.equal(ev({ no_open_sibling: ["Bug"] }, 4, tree({}, false)), true); // empty
  assert.equal(ev({ no_open_sibling: ["Bug"] }, 1, tree({})), true); // no parent
});

test("when: every element must hold; empty/absent holds", () => {
  const items = tree({ 4: "Done" });
  const idx = new ModelIndex(items);
  const it = idx.get(1);
  assert.equal(
    evaluateWhen([{ children_done: ["QATask"] }, { no_open_child: ["Bug"] }], it, idx),
    false,
  );
  assert.equal(evaluateWhen([{ children_done: ["QATask"] }], it, idx), true);
  assert.equal(evaluateWhen(undefined, it, idx), true);
});

// Every auto transition of the default workflow, one scenario each.
const scenarios: Record<string, { items: WorkItem[]; n: number }> = {
  "Epic Ready>In progress": {
    n: 1,
    items: [
      mk(1, "Epic", "Ready", { children: [2] }),
      mk(2, "UserStory", "In progress", { parent: 1 }),
    ],
  },
  "Epic In progress>Done": {
    n: 1,
    items: [
      mk(1, "Epic", "In progress", { children: [2] }),
      mk(2, "UserStory", "Done", { parent: 1 }),
    ],
  },
  "UserStory Draft>Ready": {
    n: 2,
    items: [mk(1, "Epic", "Ready", { children: [2] }), mk(2, "UserStory", "Draft", { parent: 1 })],
  },
  "UserStory Ready>In progress": {
    n: 1,
    items: [
      mk(1, "UserStory", "Ready", { children: [2] }),
      mk(2, "DevTask", "In progress", { parent: 1 }),
    ],
  },
  "UserStory In progress>Testing": { n: 1, items: tree({ 2: "Done", 3: "Done" }, false) },
  "UserStory Testing>Acceptance": { n: 1, items: tree({ 1: "Testing", 4: "Done", 5: "Done" }) },
  "UserStory Blocked>In progress": {
    n: 1,
    items: [mk(1, "UserStory", "Blocked", { blockedBy: [2] }), mk(2, "DevTask", "Done")],
  },
  "DesignTask Blocked>Ready": {
    n: 1,
    items: [mk(1, "DesignTask", "Blocked", { blockedBy: [2] }), mk(2, "DevTask", "Done")],
  },
  "DevTask Blocked>Ready": {
    n: 1,
    items: [mk(1, "DevTask", "Blocked", { blockedBy: [2] }), mk(2, "DevTask", "Done")],
  },
  "DevTask In progress>In review": {
    n: 1,
    items: [
      mk(1, "DevTask", "In progress", {
        linkedPrs: [{ number: 5, state: "open", verdict: "none" }],
      }),
    ],
  },
  "DevTask In review>In progress": {
    n: 1,
    items: [
      mk(1, "DevTask", "In review", {
        linkedPrs: [{ number: 5, state: "open", verdict: "changes_requested" }],
      }),
    ],
  },
  "DevTask In review>Done": {
    n: 1,
    items: [mk(1, "DevTask", "In review", { state: "closed", closedByMergedPr: true })],
  },
  "QATask In progress>Testing": {
    n: 4,
    items: tree({ 2: "Done", 3: "Done", 4: "In progress" }, false),
  },
  "QATask Blocked>Testing": {
    n: 4,
    items: tree({ 2: "Done", 3: "Done", 4: "Blocked", 5: "Done" }),
  },
  "Bug Ready>In progress": {
    n: 1,
    items: [
      mk(1, "Bug", "Ready", { children: [2] }),
      mk(2, "DevTask", "In progress", { parent: 1 }),
    ],
  },
  "Bug In progress>Testing": {
    n: 1,
    items: [
      mk(1, "Bug", "In progress", { children: [2] }),
      mk(2, "DevTask", "Done", { parent: 1 }),
    ],
  },
  "Bug Testing>Done": {
    n: 1,
    items: [mk(1, "Bug", "Testing", { children: [2] }), mk(2, "QATask", "Done", { parent: 1 })],
  },
};

test("every auto transition of workflow.yaml has a scenario that applies exactly it", () => {
  const w = loadDefaultWorkflow();
  const autoCount = IssueTypeV2.options.flatMap((t) =>
    effectiveTransitions(t, w).filter((tr) => tr.by === "auto"),
  ).length;
  assert.equal(Object.keys(scenarios).length, autoCount);
  for (const [name, { items, n }] of Object.entries(scenarios)) {
    const { applied } = computeFixpoint(items, w, 1);
    const mine = applied.filter((a) => a.item === n);
    const type = name.split(" ")[0] as string;
    const [from, to] = name.slice(type.length + 1).split(">") as [string, string];
    assert.ok(
      mine.some((a) => a.type === type && a.from === from && a.to === to && a.predicate.length > 0),
      `${name}: ${JSON.stringify(applied)}`,
    );
  }
});

test("a non-matching model applies nothing", () => {
  assert.deepEqual(computeFixpoint(tree({})).applied, []);
});

test("cascade: DevTask merged -> Story Testing, and up to Epic Done", () => {
  const items = [
    mk(1, "Epic", "In progress", { children: [2] }),
    mk(2, "UserStory", "In progress", { parent: 1, children: [3, 4] }),
    mk(3, "DevTask", "In review", { parent: 2, state: "closed", closedByMergedPr: true }),
    mk(4, "QATask", "In progress", { parent: 2 }),
  ];
  const r = computeFixpoint(items);
  assert.deepEqual(
    r.applied.map((a) => [a.item, a.from, a.to]),
    [
      [3, "In review", "Done"],
      [4, "In progress", "Testing"],
      [2, "In progress", "Testing"],
    ],
  );
  // QATask Testing is coordinator-owned, so the Story waits at Testing and the Epic stays.
  assert.equal(r.items.find((i) => i.number === 1)?.status, "In progress");
  // the input is not mutated
  assert.equal(items[2]?.status, "In review");
});

test("cascade: multi-level up to Epic Done, one pass per level", () => {
  const items = [
    mk(1, "Epic", "In progress", { children: [2] }),
    mk(2, "UserStory", "Acceptance", { parent: 1, children: [3] }),
    mk(3, "DevTask", "In review", { parent: 2, state: "closed", closedByMergedPr: true }),
  ];
  // Story Acceptance->Done is PO-only, so only the DevTask moves.
  assert.deepEqual(
    computeFixpoint(items).applied.map((a) => a.item),
    [3],
  );
  const done = items.map((i) =>
    i.number === 2 ? { ...i, status: "Done" as const, state: "closed" as const } : i,
  );
  assert.deepEqual(
    computeFixpoint(done).applied.map((a) => [a.item, a.to]),
    [
      [3, "Done"],
      [1, "Done"],
    ],
  );
});

test("idempotent", () => {
  const first = computeFixpoint(tree({ 2: "Done", 3: "Done" }, false));
  assert.ok(first.applied.length > 0);
  assert.deepEqual(computeFixpoint(first.items).applied, []);
});

test("round limit throws a clear OmiError", () => {
  const w = resolveWorkflow({
    types: {
      DevTask: {
        transitions: [
          { from: "Ready", to: "In progress", by: "auto", when: [{ blockers_done: true }] },
          { from: "In progress", to: "Ready", by: "auto", when: [{ blockers_done: true }] },
        ],
      },
    },
  });
  assert.throws(
    () => computeFixpoint([mk(1, "DevTask", "Ready")], w, 5),
    (e: unknown) =>
      e instanceof OmiError &&
      e.code === "INVALID_TRANSITION" &&
      (e.details as { reason: string }).reason === "FIXPOINT_LIMIT_EXCEEDED",
  );
});

test("checkExternalChange accepts only by: po transitions", () => {
  assert.deepEqual(checkExternalChange("Epic", "Awaiting PO", "Ready"), { valid: true });
  assert.deepEqual(checkExternalChange("Epic", "Ready", "Ready"), { valid: true });
  assert.equal(checkExternalChange("UserStory", "Acceptance", "Done").valid, true);
  assert.equal(checkExternalChange("UserStory", "Acceptance", "Rework").valid, true);
  const bad = checkExternalChange("Epic", "Draft", "Done");
  assert.equal(bad.valid, false);
  assert.ok(bad.reason);
  assert.equal(checkExternalChange("Epic", "Draft", "Awaiting PO").valid, false); // coordinator
  assert.equal(checkExternalChange("DevTask", "In review", "Done").valid, false); // auto
});

test("desiredIssueState: Done closes completed, others open, Doc never closes", () => {
  assert.deepEqual(desiredIssueState("DevTask", "Done"), { state: "closed", reason: "completed" });
  assert.deepEqual(desiredIssueState("Doc", "Done"), { state: "open" });
  for (const s of ProjectStatusV2.options.filter((x) => x !== "Done")) {
    assert.deepEqual(desiredIssueState("Epic", s), { state: "open" });
  }
});

test("milestonesWithAllEpicsDone", () => {
  const items = [
    mk(1, "Epic", "Done", { milestone: 10 }),
    mk(2, "Epic", "Done", { milestone: 10 }),
    mk(3, "Epic", "Done", { milestone: 11 }),
    mk(4, "Epic", "In progress", { milestone: 11 }),
    mk(5, "UserStory", "Ready", { milestone: 12 }),
    mk(6, "Epic", "Done"),
  ];
  assert.deepEqual(milestonesWithAllEpicsDone(items), [10]);
  assert.deepEqual(milestonesWithAllEpicsDone([]), []);
});

test("parseProjectModel validates and applies defaults", () => {
  const m = parseProjectModel([{ number: 1, type: "Epic", status: "Draft", state: "open" }]);
  assert.deepEqual(m[0]?.children, []);
  assert.equal(m[0]?.parent, null);
  assert.throws(() =>
    parseProjectModel([
      { number: 1, type: "Epic", status: "Draft", state: "open", blockedBy: [9] },
    ]),
  );
  // A parent or child outside the Project does not invalidate the model (#368 CR-003).
  const out = parseProjectModel([
    { number: 1, type: "Epic", status: "Draft", state: "open", parent: 9, children: [8] },
  ]);
  assert.equal(out[0]?.parent, 9);
  assert.throws(() =>
    parseProjectModel([
      { number: 1, type: "Epic", status: "Draft", state: "open" },
      { number: 1, type: "Epic", status: "Draft", state: "open" },
    ]),
  );
});
