// DevTask-0132 #383: planWorkflow and the start gate by native issue type (github.model v2).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../../../runtime/shared/config.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { startGates } from "../../../runtime/task-run/cli/gates.ts";
import { planWorkflow } from "../../../runtime/task-run/domain/plan.ts";
import { fetchTicket } from "../../../runtime/ticket/adapters/ticket.ts";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};

test("DesignTask → read-only ui-ux-designer plan (no delivery, no PR)", () => {
  assert.deepEqual(planWorkflow({ type: "DesignTask", labels: [] }), {
    kind: "design",
    workflow: "Design",
    designer: "ui-ux-designer",
  });
});

test("DevTask → software-engineer delivery; spike label stays a DevTask; Bug parent → Bug Resolution", () => {
  const p = planWorkflow({ type: "DevTask", labels: [] });
  assert.ok(p.kind === "delivery" && p.engineer === "software-engineer");
  assert.equal(p.workflow, "Feature Implementation");
  const s = planWorkflow({ type: "DevTask", labels: ["spike"] });
  assert.ok(s.kind === "delivery" && s.engineer === "software-engineer");
  const b = planWorkflow({ type: "DevTask", labels: [], parentType: "Bug" });
  assert.ok(b.kind === "delivery" && b.workflow === "Bug Resolution" && b.regressionTest);
});

test("QATask → qa-engineer plan: verify, Test design by label, Bug parent is a Retest", () => {
  assert.deepEqual(planWorkflow({ type: "QATask", labels: [] }), {
    kind: "qa",
    workflow: "QA Verify",
    mode: "verify",
    retest: false,
  });
  const d = planWorkflow({ type: "QATask", labels: ["qa:test-design"] });
  assert.ok(d.kind === "qa" && d.mode === "test-design");
  const r = planWorkflow({ type: "QATask", labels: [], parentType: "Bug" });
  assert.ok(r.kind === "qa" && r.retest);
});

test("Bug, UserStory, Epic, Doc, ADR are refused by task run", () => {
  for (const type of ["Bug", "UserStory", "Epic", "Doc", "ADR"] as const) {
    assert.equal(
      codeOf(() => planWorkflow({ type, labels: [] })),
      "POLICY_VIOLATION",
      type,
    );
  }
});

const ticketOf = (issueType: string) =>
  fetchTicket(
    parseConfig({ github: { owner: "o", repo: "r", projectNumber: 2, model: "v2" } }),
    7,
    (() => ({
      status: 0,
      stdout: JSON.stringify({
        data: {
          repository: {
            issue: {
              number: 7,
              title: `${issueType}-0007-t`,
              state: "OPEN",
              body: "## Objective\nx",
              issueType: { name: issueType },
              labels: { totalCount: 0, nodes: [] },
              parent: null,
              subIssuesSummary: { total: 0, completed: 0 },
              blockedBy: { totalCount: 0, nodes: [] },
              projectItems: { totalCount: 0, nodes: [] },
            },
          },
        },
      }),
      stderr: "",
    })) as GhRunner,
  );

const executable = (type: string, forWork = true) =>
  startGates(
    ticketOf(type),
    parseConfig({ github: { owner: "o", repo: "r", projectNumber: 2, model: "v2" } }),
    forWork,
  ).find((c) => c.name === "executable");

test("v2 start gate: DesignTask, DevTask, QATask pass; the others fail POLICY_VIOLATION", () => {
  for (const type of ["DesignTask", "DevTask", "QATask"]) {
    assert.equal(executable(type)?.status, "pass", type);
  }
  for (const type of ["Bug", "UserStory", "Epic", "Doc", "ADR"]) {
    const c = executable(type);
    assert.equal(c?.status, "fail", type);
    assert.equal(c?.code, "POLICY_VIOLATION", type);
  }
  assert.match(executable("Bug")?.detail ?? "", /child DevTask/);
  assert.equal(executable("Bug", false), undefined); // ticket validate has no start rule
});
