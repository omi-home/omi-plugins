// DevTask-0099 #308: workflow.yaml state machine, zod loader, override merge, derived queries.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import { parseConfig } from "../../runtime/core/config.ts";
import { IssueTypeV2, ProjectStatusV2 } from "../../runtime/core/contracts.ts";
import {
  canTransition,
  closesIssue,
  initialStatus,
  loadDefaultWorkflow,
  loadWorkflow,
  PREDICATES,
  parseWorkflow,
  resolveWorkflow,
  statusesOf,
} from "../../runtime/core/workflow-config.ts";

// biome-ignore lint/suspicious/noExplicitAny: tests mutate the parsed YAML freely
type Raw = Record<string, any>;
const raw = () =>
  parse(readFileSync(new URL("../../config/github/workflow.yaml", import.meta.url), "utf8")) as Raw;
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
  for (const t of IssueTypeV2.options) assert.equal(initialStatus(t), "Draft");
});

// Status matrix per type (ChangeRequest-0013 §5.2 as encoded in the default workflow).
const MATRIX: Record<IssueTypeV2, string[]> = {
  Doc: ["Draft", "Awaiting PO", "Blocked", "Done"],
  ADR: ["Draft", "Awaiting PO", "Blocked", "Done"],
  Epic: ["Draft", "Awaiting PO", "Ready", "In progress", "Acceptance", "Blocked", "Done"],
  UserStory: [
    "Draft",
    "Awaiting PO",
    "Ready",
    "In progress",
    "Acceptance",
    "Rework",
    "Blocked",
    "Done",
  ],
  DesignTask: [
    "Draft",
    "Awaiting PO",
    "Ready",
    "In progress",
    "In review",
    "Rework",
    "Blocked",
    "Done",
  ],
  DevTask: [
    "Draft",
    "Awaiting PO",
    "Ready",
    "In progress",
    "In review",
    "Rework",
    "Blocked",
    "Done",
  ],
  QATask: ["Draft", "Awaiting PO", "Ready", "In progress", "Testing", "Rework", "Blocked", "Done"],
  Bug: [
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
};

test("statusesOf matches the status matrix of every type", () => {
  for (const t of IssueTypeV2.options) {
    const order = ProjectStatusV2.options as readonly string[];
    const want = [...MATRIX[t]].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    assert.deepEqual(statusesOf(t), want, t);
  }
});

test("canTransition answers (type, from, to, by)", () => {
  assert.ok(canTransition("DevTask", "Draft", "Awaiting PO", "coordinator"));
  assert.ok(!canTransition("DevTask", "Draft", "Awaiting PO", "po"));
  assert.ok(canTransition("DevTask", "Awaiting PO", "Ready", "po"));
  assert.ok(canTransition("DevTask", "In progress", "In review", "auto"));
  assert.ok(!canTransition("DevTask", "In progress", "In review", "coordinator"));
  assert.ok(canTransition("DevTask", "In review", "Done", "auto"));
  assert.ok(canTransition("Bug", "Acceptance", "Done", "po"));
  assert.ok(!canTransition("DevTask", "Draft", "Done", "po"));
  assert.ok(!canTransition("Doc", "Ready", "Done", "po"));
  // "*" matches any from; a status never moves to itself
  assert.ok(canTransition("QATask", "Testing", "Blocked", "coordinator"));
  assert.ok(!canTransition("QATask", "Blocked", "Blocked", "coordinator"));
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
  assert.ok(!closesIssue("Epic", "Done"));
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
  ok([{ parent_status_in: ["In progress", "Rework"] }, { linked_pr: "merged" }]);
  for (const p of [
    "all_children_done",
    "children_done",
    "no_open_child",
    "blockers_done",
    "issue_closed_by_pr",
    "siblings_done",
    "no_open_sibling",
  ]) {
    ok([{ [p]: true }]);
    bad([{ [p]: false }]);
  }
  assert.equal(PREDICATES.length, 10);
  bad([{ unknown_predicate: true }]);
  bad([{ any_child_in: "Done" }]); // wrong type
  bad([{ any_child_in: ["Nope"] }]); // wrong status
  bad([{ any_child_in: [] }]);
  bad([{ linked_pr: "draft" }]);
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
  assert.ok(closesIssue("Epic", "Done", w));
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

test("github.workflow in omi.config.yaml is read from the workspace", () => {
  const gh = { owner: "o", repo: "r", projectNumber: 2 };
  assert.equal(
    parseConfig({ github: { ...gh, workflow: { never_close: [] } } }).github.model,
    "legacy",
  );
  const dir = mkdtempSync(join(tmpdir(), "omi-wf-"));
  try {
    assert.equal(closesIssue("Epic", "Done", loadWorkflow(dir)), false, "no config: default");
    mkdirSync(join(dir, ".omi-plugins"));
    writeFileSync(
      join(dir, ".omi-plugins", "omi.config.yaml"),
      "github:\n  owner: o\n  repo: r\n  projectNumber: 2\n  workflow:\n    never_close: []\n",
    );
    assert.equal(closesIssue("Epic", "Done", loadWorkflow(dir)), true);
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
