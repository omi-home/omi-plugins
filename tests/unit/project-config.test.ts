// DevTask-0030 #62: Project desired state (fields), field diff, and the Status lifecycle matrix
// checked against every move the CLI itself makes (workflow projection + roll-up).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IssueType,
  ProjectStatus,
  WorkflowEventType,
  WorkflowState,
} from "../../runtime/core/contracts.ts";
import {
  type ActualField,
  allowedStatuses,
  canMove,
  loadProjectConfig,
  loadTransitions,
  ProjectConfig,
  planFields,
} from "../../runtime/core/project-config.ts";
import {
  initialContext,
  PROJECT_STATUS,
  transition,
} from "../../runtime/core/workflow-engine/fsm.ts";

const desired = loadProjectConfig();
const STATUS = desired.fields.find((f) => f.name === "Status");
const options = STATUS?.type === "single_select" ? STATUS.options : [];
const EXECUTABLE: IssueType[] = [
  "dev-task",
  "test-task",
  "devops-task",
  "documentation-task",
  "spike",
  "release",
];

test("shipped desired state: Status options are the ProjectStatus enum; initial Status allowed", () => {
  assert.deepEqual(options.map((o) => o.name).sort(), [...ProjectStatus.options].sort());
  for (const t of IssueType.options) {
    assert.ok(allowedStatuses(t).has(desired.initialStatus), `${t} uses ${desired.initialStatus}`);
  }
});

test("desired state rejects duplicate fields/options, unknown keys and unknown types", () => {
  const ok = {
    initialStatus: "Backlog",
    fields: [{ name: "Status", type: "single_select", options }],
  };
  assert.ok(ProjectConfig.safeParse(ok).success);
  const bad = [
    { ...ok, fields: [...ok.fields, { name: "status", type: "date" }] },
    {
      ...ok,
      fields: [
        ...ok.fields,
        { name: "Size", type: "single_select", options: [options[0], options[0]] },
      ],
    },
    { ...ok, fields: [...ok.fields, { name: "Effort", type: "story_points" }] },
    { ...ok, fields: [...ok.fields, { name: "Target", type: "date", id: "PVTF_x" }] },
    { ...ok, extra: true },
    { ...ok, fields: [{ name: "Status", type: "single_select", options: options.slice(1) }] },
  ];
  for (const b of bad)
    assert.equal(ProjectConfig.safeParse(b).success, false, JSON.stringify(b).slice(0, 80));
});

// --- field diff -------------------------------------------------------------------------------

const ghOptions = (names: string[]) =>
  names.map((name, i) => {
    const o = options.find((x) => x.name === name);
    return { id: `o${i}`, name, color: o?.color ?? "GRAY", description: o?.description ?? "" };
  });
const inSync = (): ActualField[] => [
  { id: "T", name: "Title", dataType: "TITLE" },
  { id: "S", name: "Status", dataType: "SINGLE_SELECT", options: ghOptions(ProjectStatus.options) },
  {
    id: "P",
    name: "Priority",
    dataType: "SINGLE_SELECT",
    options: [
      { id: "p0", name: "P0", color: "RED", description: "blocked foundation" },
      { id: "p1", name: "P1", color: "ORANGE", description: "MVP critical" },
      { id: "p2", name: "P2", color: "YELLOW", description: "production hardening" },
      { id: "p3", name: "P3", color: "GRAY", description: "optional" },
    ],
  },
  {
    id: "Z",
    name: "Size",
    dataType: "SINGLE_SELECT",
    options: [
      { id: "s", name: "S", color: "GREEN", description: "" },
      { id: "m", name: "M", color: "YELLOW", description: "" },
      { id: "l", name: "L", color: "ORANGE", description: "" },
    ],
  },
  {
    id: "R",
    name: "Risk",
    dataType: "SINGLE_SELECT",
    options: ["Low", "Medium", "High"].map((name) => ({
      id: name,
      name,
      color: "GRAY",
      description: "",
    })),
  },
  { id: "D", name: "Target Date", dataType: "DATE" },
  { id: "I", name: "Sprint", dataType: "ITERATION", duration: 14 },
];

test("in sync: no action; extra custom fields and options are reported, built-ins ignored", () => {
  assert.deepEqual(planFields(desired, inSync()), { actions: [], extra: [] });
  const more = inSync();
  more.push({ id: "X", name: "Phase", dataType: "SINGLE_SELECT", options: [] });
  more[2]?.options?.push({ id: "p4", name: "P4", color: "GRAY", description: "" });
  assert.deepEqual(planFields(desired, more).extra, ["Phase", "Priority: P4"]);
});

test("missing field → create; missing iteration, type conflict, duplicate name → manual", () => {
  const actual = inSync().filter((f) => !["Risk", "Sprint", "Target Date"].includes(f.name));
  actual.push({ id: "D1", name: "target date", dataType: "TEXT" });
  actual.push({ id: "Z2", name: "Size", dataType: "SINGLE_SELECT", options: [] });
  const { actions } = planFields(desired, actual);
  const brief = actions.map((a) =>
    a.kind === "create" ? `create ${a.field.name}` : `${a.kind} ${"name" in a ? a.name : ""}`,
  );
  assert.deepEqual(brief, ["manual Size", "create Risk", "manual Target Date", "manual Sprint"]);
});

test("missing option is added and changed color updated; existing option IDs are kept", () => {
  const actual = inSync();
  actual[1] = {
    id: "S",
    name: "Status",
    dataType: "SINGLE_SELECT",
    options: ghOptions(
      ProjectStatus.options.filter((s) => !["Triage", "Analysis", "Approved"].includes(s)),
    ),
  };
  const ready = actual[1].options?.find((o) => o.name === "Ready");
  if (ready) ready.color = "RED";
  const [a, ...rest] = planFields(desired, actual).actions;
  assert.equal(rest.length, 0);
  assert.equal(a?.kind, "update-options");
  if (a?.kind !== "update-options") return;
  assert.deepEqual(a.add, ["Triage", "Analysis", "Approved"]);
  assert.deepEqual(a.change, ["Ready"]);
  // Every existing option is sent back with its ID: item values survive the write.
  for (const o of actual[1].options ?? []) {
    assert.equal(a.options.find((x) => x.name === o.name)?.id, o.id);
  }
  assert.equal(a.options.find((x) => x.name === "Ready")?.color, "BLUE");
});

// --- Status lifecycle -------------------------------------------------------------------------

test("every type has a lifecycle; common rules: Blocked, Cancelled, reopen", () => {
  const t = loadTransitions();
  for (const type of IssueType.options) assert.ok(Object.keys(t.types[type]).length, type);
  assert.ok(canMove("feature", "Analysis", "Blocked"));
  assert.ok(canMove("feature", "Blocked", "Approved"));
  assert.ok(canMove("bug", "Triage", "Cancelled"));
  assert.ok(!canMove("bug", "Done", "Cancelled"));
  assert.ok(!canMove("bug", "Done", "Blocked"));
  assert.ok(canMove("epic", "Done", "In Progress"));
  assert.ok(!canMove("epic", "Done", "Backlog"));
  assert.ok(canMove("dev-task", null, "Backlog"));
  // Outside a type's set.
  assert.ok(!canMove("milestone", "Backlog", "Analysis"));
  assert.ok(!allowedStatuses("dev-task").has("Triage"));
  assert.ok(!canMove("fr", "Backlog", "Done"));
});

/** Every Project Status move the workflow FSM can cause for an executable Issue. */
function fsmMoves(): [ProjectStatus, ProjectStatus][] {
  const seen = new Map<string, [ProjectStatus, ProjectStatus]>();
  for (const state of WorkflowState.options)
    for (const round of [1, 4])
      for (const failedRounds of [0, 1])
        for (const architectUsed of [false, true])
          for (const qaReworks of [0, 2])
            for (const reworkFor of [null, "review", "qa"] as const)
              for (const resumeFrom of [null, ...WorkflowState.options])
                for (const attempt of [1, 3]) {
                  const ctx = {
                    ...initialContext(),
                    state,
                    round,
                    failedRounds,
                    architectUsed,
                    qaReworks,
                    reworkFor,
                    resumeFrom,
                    attempt,
                  };
                  for (const type of WorkflowEventType.options)
                    for (const errorCode of ["NETWORK", "INTERNAL"] as const) {
                      try {
                        const next = transition(ctx, { type, errorCode } as never);
                        const move: [ProjectStatus, ProjectStatus] = [
                          PROJECT_STATUS[state],
                          PROJECT_STATUS[next.state],
                        ];
                        if (move[0] !== move[1]) seen.set(move.join("→"), move);
                      } catch {}
                    }
                }
  return [...seen.values()];
}

test("the matrix allows every Status move the workflow engine makes for executable types", () => {
  const moves = fsmMoves();
  assert.ok(moves.length > 20);
  const denied = EXECUTABLE.flatMap((type) =>
    moves.filter(([from, to]) => !canMove(type, from, to)).map(([f, t]) => `${type}: ${f} → ${t}`),
  );
  assert.deepEqual(denied, []);
});

test("the matrix allows the CLI roll-up moves (start, finish)", () => {
  // markStarted: Backlog/Ready/unset → In Progress, up the parent chain.
  for (const type of IssueType.options)
    for (const from of ["Backlog", "Ready", "Approved", null] as const)
      if (from === null || allowedStatuses(type).has(from))
        assert.ok(canMove(type, from, "In Progress"), `${type}: ${from} → In Progress`);
  // markFinished: task → Done; Milestone → In Review; Bug/requirement → In QA; others closed Done.
  for (const type of EXECUTABLE) assert.ok(canMove(type, "In Review", "Done"));
  assert.ok(canMove("milestone", "In Progress", "In Review"));
  for (const type of ["bug", "fr", "nfr", "change-request"] as const)
    assert.ok(canMove(type, "In Progress", "In QA"), type);
  for (const type of ["epic", "feature", "dev-task"] as const)
    assert.ok(canMove(type, "In Progress", "Done"), type);
});
