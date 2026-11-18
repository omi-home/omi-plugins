// DevTask-0027 #56: role-selection matrix (Milestone-0006 gate evidence). Each use case runs only
// the agents it needs on its happy path; the readable copy of this table is in Issue #56's body.
import assert from "node:assert/strict";
import { test } from "node:test";
import { type IssueType, Role } from "../../runtime/core/contracts.ts";
import { planWorkflow, type WorkflowPlan } from "../../runtime/core/workflow-engine/plan.ts";

/** Agent calls of a plan's happy path, in order (Architect diagnosis only after 2 failed rounds). */
const agentsOf = (p: WorkflowPlan): Role[] =>
  p.kind === "analysis"
    ? p.analysts
    : [
        p.engineer,
        "code-reviewer",
        ...(p.security ? (["security-reviewer"] as Role[]) : []),
        ...(p.manualQa ? (["manual-qa-engineer"] as Role[]) : []),
      ];

const MATRIX: [string, IssueType, string[], IssueType | null, string, Role[]][] = [
  [
    "simple bug fix",
    "dev-task",
    [],
    "bug",
    "Bug Resolution",
    ["backend-engineer", "code-reviewer", "manual-qa-engineer"],
  ],
  [
    "backend task",
    "dev-task",
    [],
    null,
    "Feature Implementation",
    ["backend-engineer", "code-reviewer"],
  ],
  [
    "UI task",
    "dev-task",
    ["role:frontend", "ui"],
    null,
    "Feature Implementation",
    ["frontend-engineer", "code-reviewer", "manual-qa-engineer"],
  ],
  [
    "schema migration",
    "dev-task",
    ["role:database"],
    null,
    "Feature Implementation",
    ["database-engineer", "code-reviewer"],
  ],
  [
    "auth change",
    "dev-task",
    ["security"],
    null,
    "Feature Implementation",
    ["backend-engineer", "code-reviewer", "security-reviewer"],
  ],
  ["refactor", "dev-task", ["refactor"], null, "Refactor", ["backend-engineer", "code-reviewer"]],
  [
    "pipeline change",
    "devops-task",
    [],
    null,
    "Feature Implementation",
    ["devops-engineer", "code-reviewer"],
  ],
  [
    "test suite",
    "test-task",
    [],
    null,
    "Feature Implementation",
    ["automation-qa-engineer", "code-reviewer"],
  ],
  [
    "UI feature",
    "feature",
    ["ui"],
    null,
    "Feature Analysis",
    ["business-analyst", "ui-ux-designer", "solution-architect"],
  ],
  [
    "service feature",
    "feature",
    [],
    null,
    "Feature Analysis",
    ["business-analyst", "solution-architect"],
  ],
  [
    "change request",
    "change-request",
    [],
    null,
    "Change Request Analysis",
    ["business-analyst", "solution-architect"],
  ],
  ["functional requirement", "fr", [], null, "Requirement Analysis", ["business-analyst"]],
  [
    "non-functional requirement",
    "nfr",
    [],
    null,
    "Requirement Analysis",
    ["business-analyst", "solution-architect"],
  ],
];

test("role-selection matrix: each use case runs exactly its minimum agents", () => {
  for (const [name, type, labels, parentType, workflow, agents] of MATRIX) {
    const p = planWorkflow({ type, labels, parentType });
    assert.equal(p.workflow, workflow, name);
    assert.deepEqual(agentsOf(p), agents, name);
    assert.equal(new Set(agents).size, agents.length, `${name}: an agent repeats`);
  }
});

test("no analysis in delivery; every role reachable; far fewer calls than the full squad", () => {
  const plans = MATRIX.map(([, type, labels, parentType]) =>
    planWorkflow({ type, labels, parentType }),
  );
  for (const p of plans.filter((x) => x.kind === "delivery")) {
    const a = agentsOf(p);
    assert.ok(!a.includes("business-analyst") && !a.includes("solution-architect"), p.workflow);
  }
  assert.deepEqual(new Set(plans.flatMap(agentsOf)), new Set(Role.options));
  // Cost comparison: 29 agent calls across 13 use cases vs 143 if all 11 ran every time.
  const calls = plans.reduce((n, p) => n + agentsOf(p).length, 0);
  assert.equal(calls, 29);
  assert.ok(calls * 4 < MATRIX.length * Role.options.length);
});
