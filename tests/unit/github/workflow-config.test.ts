// DevTask-0099 #308: workflow.yaml state machine, zod loader, override merge, derived queries.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { loadWorkflow } from "../../../runtime/github/application/load-workflow.ts";
import {
  canTransition,
  closesIssue,
  initialStatus,
  statusesOf,
  transitionsBetween,
} from "../../../runtime/github/domain/workflow-queries.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import { IssueTypeV2, ProjectStatusV2 } from "../../../runtime/shared/contracts.ts";
import {
  loadDefaultWorkflow,
  PREDICATES,
  parseWorkflow,
  resolveWorkflow,
} from "../../../runtime/shared/workflow.ts";

// biome-ignore lint/suspicious/noExplicitAny: tests mutate the parsed YAML freely
type Raw = Record<string, any>;
const raw = () =>
  parse(
    readFileSync(new URL("../../../config/github/workflow.yaml", import.meta.url), "utf8"),
  ) as Raw;
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};
const invalid = (mutate: (w: Raw) => void) => {
  const w = raw();
  mutate(w);
  return codeOf(() => parseWorkflow(w));
};

test("the default workflow.yaml is valid and covers all 8 types and 10 statuses", () => {
  const w = loadDefaultWorkflow();
  assert.deepEqual([...w.statuses].sort(), [...ProjectStatusV2.options].sort());
  assert.deepEqual(Object.keys(w.types).sort(), [...IssueTypeV2.options].sort());
  assert.deepEqual(w.closed_states, ["Done"]);
  assert.deepEqual(w.never_close, ["Doc"]);
});

test("initialStatus and blocked_returns_to follow §9.3", () => {
  const initial: Record<IssueTypeV2, string> = {
    Epic: "Draft",
    UserStory: "Draft",
    DesignTask: "Ready",
    DevTask: "Ready",
    QATask: "Ready",
    Bug: "Draft",
    ADR: "Draft",
    Doc: "Draft",
  };
  for (const t of IssueTypeV2.options) assert.equal(initialStatus(t), initial[t], t);
  const w = loadDefaultWorkflow();
  const back = {
    UserStory: "In progress",
    DesignTask: "Ready",
    DevTask: "Ready",
    QATask: "Testing",
  };
  for (const t of IssueTypeV2.options)
    assert.equal(w.types[t].blocked_returns_to, back[t as keyof typeof back], t);
});

// Status matrix per type: ChangeRequest-0013 §5.2 + quyết định PO Bug Rework 2026-11-21 (hand-copied, not derived from the YAML).
const MATRIX: Record<IssueTypeV2, string[]> = {
  Doc: ["Draft", "Awaiting PO", "Ready", "Rework"],
  ADR: ["Draft", "Awaiting PO", "Rework", "Done"],
  Epic: ["Draft", "Awaiting PO", "Ready", "In progress", "Rework", "Done"],
  UserStory: [
    "Draft",
    "Awaiting PO",
    "Ready",
    "In progress",
    "Testing",
    "Acceptance",
    "Rework",
    "Blocked",
    "Done",
  ],
  DesignTask: ["Awaiting PO", "Ready", "In progress", "In review", "Rework", "Blocked", "Done"],
  DevTask: ["Ready", "In progress", "In review", "Blocked", "Done"],
  QATask: ["Ready", "In progress", "Testing", "Blocked", "Done"],
  Bug: ["Draft", "Awaiting PO", "Ready", "In progress", "Testing", "Rework", "Done"],
};

test("statusesOf matches the status matrix of every type", () => {
  for (const t of IssueTypeV2.options) {
    const order = ProjectStatusV2.options as readonly string[];
    const want = [...MATRIX[t]].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    assert.deepEqual(statusesOf(t), want, t);
  }
});

test("canTransition answers (type, from, to, by)", () => {
  assert.ok(canTransition("DevTask", "Ready", "In progress", "coordinator"));
  assert.ok(!canTransition("DevTask", "Ready", "In progress", "po"));
  assert.ok(canTransition("DevTask", "In progress", "In review", "auto"));
  assert.ok(!canTransition("DevTask", "In progress", "In review", "coordinator"));
  assert.ok(!canTransition("DevTask", "Ready", "Done", "po"));
  assert.ok(!canTransition("Doc", "Ready", "Done", "po"));
  // "*" matches any from; a status never moves to itself
  assert.ok(canTransition("QATask", "Testing", "Blocked", "coordinator"));
  assert.ok(!canTransition("QATask", "Blocked", "Blocked", "coordinator"));
  // typical transitions of §9.3
  const only = (type: IssueTypeV2, from: string, to: string) =>
    transitionsBetween(type, from as never, to as never);
  assert.deepEqual(only("DevTask", "In review", "Done"), [
    { from: "In review", to: "Done", by: "auto", when: [{ issue_closed_by_pr: true }] },
  ]);
  assert.deepEqual(only("UserStory", "Testing", "Acceptance"), [
    {
      from: "Testing",
      to: "Acceptance",
      by: "auto",
      when: [{ children_done: ["QATask"] }, { no_open_child: ["Bug"] }],
    },
  ]);
  assert.ok(canTransition("Bug", "Awaiting PO", "Rework", "po"));
  assert.ok(canTransition("Bug", "Rework", "Awaiting PO", "coordinator"));
  assert.ok(!canTransition("Bug", "Rework", "Awaiting PO", "po"));
  assert.ok(canTransition("DevTask", "In review", "In progress", "auto"));
  // `to` as a list
  const w = raw();
  w.types.DevTask.transitions.push({ from: "Draft", to: ["Ready", "Rework"], by: "po" });
  const parsed = parseWorkflow(w);
  assert.ok(canTransition("DevTask", "Draft", "Rework", "po", parsed));
  assert.ok(canTransition("DevTask", "Draft", "Ready", "po", parsed));
});

test("closesIssue honours closed_states and never_close", () => {
  assert.ok(closesIssue("DevTask", "Done"));
  assert.ok(!closesIssue("DevTask", "Testing"));
  assert.ok(closesIssue("Epic", "Done"));
  for (const s of ProjectStatusV2.options)
    assert.ok(!closesIssue("Doc", s), `Doc never closes: ${s}`);
});

test("Blocked: implicit entry and exit, explicit exit wins, types without it have none", () => {
  // implicit: every open status of the type enters Blocked; exit goes to blocked_returns_to
  assert.ok(canTransition("DesignTask", "In review", "Blocked", "coordinator"));
  assert.ok(!canTransition("DesignTask", "Done", "Blocked", "coordinator"));
  assert.ok(canTransition("DesignTask", "Blocked", "Ready", "auto"));
  assert.ok(!canTransition("DesignTask", "Blocked", "In progress", "auto"));
  assert.ok(canTransition("UserStory", "Blocked", "In progress", "auto"));
  assert.ok(canTransition("DevTask", "In progress", "Blocked", "coordinator"));
  // explicit exit wins: QATask has one with two predicates, no implicit second one
  assert.equal(transitionsBetween("QATask", "Blocked", "Testing").length, 1);
  assert.equal(transitionsBetween("DevTask", "Blocked", "Ready").length, 1);
  // no blocked_returns_to: no Blocked
  for (const t of ["Doc", "ADR", "Epic", "Bug"] as const) {
    assert.ok(!statusesOf(t).includes("Blocked"), t);
    assert.ok(!canTransition(t, "Draft", "Blocked", "coordinator"), t);
  }
});

test("validator rejects a transition from Blocked that is not blocked_returns_to, and Blocked without it", () => {
  assert.equal(
    invalid((w) => {
      w.types.QATask.transitions.find((t: Raw) => t.from === "Blocked").to = "Ready";
    }),
    "CONFIG_INVALID",
  );
  assert.equal(
    invalid((w) => {
      w.types.DevTask.transitions[0].to = ["Ready", "In progress"];
    }),
    "CONFIG_INVALID",
  );
  assert.equal(
    invalid((w) => {
      w.types.Bug.transitions.push({ from: "Blocked", to: "Ready", by: "coordinator" });
    }),
    "CONFIG_INVALID",
    "Bug has no Blocked",
  );
  assert.equal(
    invalid((w) => {
      w.types.Epic.transitions.push({ from: "*", to: "Blocked", by: "coordinator" });
    }),
    "CONFIG_INVALID",
    "Epic has no Blocked",
  );
});

test("config errors are rejected with CONFIG_INVALID", () => {
  assert.equal(
    invalid((w) => {
      w.extra = 1;
    }),
    "CONFIG_INVALID",
    "unknown top-level field",
  );
  assert.equal(
    invalid((w) => {
      w.types.DevTask.extra = 1;
    }),
    "CONFIG_INVALID",
    "unknown type field",
  );
  assert.equal(
    invalid((w) => {
      w.types.Task = w.types.DevTask;
    }),
    "CONFIG_INVALID",
    "unknown type",
  );
  assert.equal(
    invalid((w) => {
      delete w.types.Bug;
    }),
    "CONFIG_INVALID",
    "missing type",
  );
  assert.equal(
    invalid((w) => {
      w.types.DevTask.initial = "Started";
    }),
    "CONFIG_INVALID",
    "unknown status",
  );
  assert.equal(
    invalid((w) => {
      w.statuses = w.statuses.slice(1);
    }),
    "CONFIG_INVALID",
    "statuses not the 10",
  );
  assert.equal(
    invalid((w) => {
      w.types.DevTask.transitions[0].by = "robot";
    }),
    "CONFIG_INVALID",
    "unknown by",
  );
  assert.equal(
    invalid((w) => {
      w.types.DevTask.transitions[0].extra = true;
    }),
    "CONFIG_INVALID",
    "unknown transition field",
  );
  assert.equal(
    invalid((w) => {
      w.types.DevTask.transitions.push({ from: "Draft", to: "Draft", by: "po" });
    }),
    "CONFIG_INVALID",
    "self transition",
  );
  assert.equal(
    invalid((w) => {
      w.types.DevTask.initial = "Done";
    }),
    "CONFIG_INVALID",
    "initial Done",
  );
});

test("auto needs `when`; po/coordinator must not have it", () => {
  assert.equal(
    invalid((w) => {
      w.types.DevTask.transitions.push({ from: "Ready", to: "Rework", by: "auto" });
    }),
    "CONFIG_INVALID",
  );
  assert.equal(
    invalid((w) => {
      w.types.DevTask.transitions.push({
        from: "Ready",
        to: "Rework",
        by: "po",
        when: [{ blockers_done: true }],
      });
    }),
    "CONFIG_INVALID",
  );
});

test("`when` is a closed list of typed predicates", () => {
  const withWhen = (when: unknown) =>
    invalid((w) => {
      w.types.DevTask.transitions.push({ from: "Ready", to: "Rework", by: "auto", when });
    });
  const ok = (when: unknown) => assert.equal(withWhen(when), "no-throw", JSON.stringify(when));
  const bad = (when: unknown) =>
    assert.equal(withWhen(when), "CONFIG_INVALID", JSON.stringify(when));
  ok([{ any_child_in: ["Done"] }]);
  ok([{ parent_status_in: ["In progress", "Rework"] }, { linked_pr: "open_ready" }]);
  ok([{ linked_pr: "changes_requested" }]);
  for (const p of ["all_children_done", "blockers_done", "issue_closed_by_pr"]) {
    ok([{ [p]: true }]);
    bad([{ [p]: false }]);
  }
  for (const p of ["children_done", "no_open_child", "siblings_done", "no_open_sibling"]) {
    ok([{ [p]: ["DevTask", "Bug"] }]);
    bad([{ [p]: true }]);
    bad([{ [p]: [] }]);
    bad([{ [p]: ["Task"] }]);
  }
  assert.equal(PREDICATES.length, 10);
  bad([{ unknown_predicate: true }]);
  bad([{ any_child_in: "Done" }]); // wrong type
  bad([{ any_child_in: ["Nope"] }]); // wrong status
  bad([{ any_child_in: [] }]);
  bad([{ linked_pr: "draft" }]);
  bad([{ linked_pr: "merged" }]);
  bad([{ blockers_done: true, siblings_done: true }]); // one predicate per entry
  bad([]);
});

test("override replaces by key, is merged and validated again", () => {
  const w = resolveWorkflow({
    never_close: [],
    types: {
      DevTask: {
        initial: "Ready",
        transitions: [{ from: "Ready", to: "Done", by: "coordinator" }],
      },
    },
  });
  assert.equal(initialStatus("DevTask", w), "Ready");
  assert.ok(closesIssue("Doc", "Done", w));
  assert.ok(canTransition("DevTask", "Ready", "Done", "coordinator", w));
  assert.ok(!canTransition("DevTask", "Draft", "Awaiting PO", "coordinator", w), "list replaced");
  // other types untouched
  assert.deepEqual(statusesOf("Bug", w), statusesOf("Bug"));
  assert.equal(resolveWorkflow(undefined), loadDefaultWorkflow());
});

test("an invalid override is rejected after the merge", () => {
  const bad = (o: unknown) => codeOf(() => resolveWorkflow(o));
  assert.equal(bad({ types: { DevTask: { initial: "Nope" } } }), "CONFIG_INVALID");
  assert.equal(bad({ types: { Task: {} } }), "CONFIG_INVALID");
  assert.equal(
    bad({ types: { DevTask: { transitions: [{ from: "Ready", to: "Done", by: "auto" }] } } }),
    "CONFIG_INVALID",
  );
  assert.equal(bad({ nonsense: 1 }), "CONFIG_INVALID");
  assert.equal(bad("text"), "CONFIG_INVALID");
  assert.equal(bad({ types: [] }), "CONFIG_INVALID");
  assert.equal(bad({ types: { DevTask: 3 } }), "CONFIG_INVALID");
});

test("github.workflow is validated when the config is parsed (CR-003)", () => {
  const gh = { owner: "o", repo: "r", projectNumber: 2 };
  assert.equal(
    codeOf(() => parseConfig({ github: { ...gh, workflow: { never_close: [] } } })),
    "no-throw",
  );
  assert.equal(
    codeOf(() => parseConfig({ github: { ...gh, workflow: { never_close: ["Task"] } } })),
    "CONFIG_INVALID",
  );
  assert.equal(
    codeOf(() =>
      parseConfig({ github: { ...gh, workflow: { types: { DevTask: { initial: "Nope" } } } } }),
    ),
    "CONFIG_INVALID",
  );
});

test("github.workflow in omi.config.yaml is read from the workspace", () => {
  const gh = { owner: "o", repo: "r", projectNumber: 2 };
  assert.equal(
    parseConfig({ github: { ...gh, workflow: { never_close: [] } } }).github.model,
    "legacy",
  );
  const dir = mkdtempSync(join(tmpdir(), "omi-wf-"));
  try {
    assert.equal(closesIssue("Doc", "Done", loadWorkflow(dir)), false, "no config: default");
    mkdirSync(join(dir, ".omi-plugins"));
    writeFileSync(
      join(dir, ".omi-plugins", "omi.config.yaml"),
      "github:\n  owner: o\n  repo: r\n  projectNumber: 2\n  workflow:\n    never_close: []\n",
    );
    assert.equal(closesIssue("Doc", "Done", loadWorkflow(dir)), true);
    writeFileSync(
      join(dir, ".omi-plugins", "omi.config.yaml"),
      "github:\n  owner: o\n  repo: r\n  projectNumber: 2\n  workflow:\n    never_close: [Task]\n",
    );
    assert.equal(
      codeOf(() => loadWorkflow(dir)),
      "CONFIG_INVALID",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
