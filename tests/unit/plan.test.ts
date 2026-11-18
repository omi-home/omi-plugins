// DevTask-0026 #55: workflow composition picks only the roles an Issue needs.
import assert from "node:assert/strict";
import { test } from "node:test";
import { upsertSection } from "../../runtime/adapters/github/context.ts";
import { planWorkflow } from "../../runtime/core/workflow-engine/plan.ts";
import { isTest } from "../../runtime/core/workflow-engine/slice.ts";

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};

test("simple bug: child DevTask runs Bug Resolution with one engineer, no BA/Architect", () => {
  const p = planWorkflow({ type: "dev-task", labels: ["type:dev-task"], parentType: "bug" });
  assert.deepEqual(p, {
    kind: "delivery",
    workflow: "Bug Resolution",
    engineer: "backend-engineer",
    security: false,
    regressionTest: true,
  });
  assert.equal(
    codeOf(() => planWorkflow({ type: "bug", labels: [] })),
    "POLICY_VIOLATION", // the Bug itself is fixed through its child DevTask
  );
});

test("engineer from role:* (default backend), type-bound roles, one role label only", () => {
  const eng = (type: "dev-task" | "devops-task" | "test-task", labels: string[] = []) => {
    const p = planWorkflow({ type, labels });
    return p.kind === "delivery" ? p.engineer : null;
  };
  assert.equal(eng("dev-task"), "backend-engineer");
  assert.equal(eng("dev-task", ["role:frontend"]), "frontend-engineer");
  assert.equal(eng("dev-task", ["role:database"]), "database-engineer");
  assert.equal(eng("devops-task"), "devops-engineer");
  assert.equal(eng("test-task"), "automation-qa-engineer");
  assert.equal(
    codeOf(() => planWorkflow({ type: "dev-task", labels: ["role:frontend", "role:backend"] })),
    "TICKET_INVALID",
  );
});

test("security labels make the Security Reviewer mandatory; refactor keeps Engineer → Reviewer", () => {
  for (const l of ["risk:high", "security"]) {
    const p = planWorkflow({ type: "dev-task", labels: [l] });
    assert.ok(p.kind === "delivery" && p.security, l);
  }
  const r = planWorkflow({ type: "dev-task", labels: ["refactor"] });
  assert.ok(r.kind === "delivery" && r.workflow === "Refactor" && !r.security && !r.regressionTest);
});

test("analysis plans: UX only for UI Features, Architect only where needed", () => {
  const analysts = (type: "feature" | "change-request" | "fr" | "nfr", labels: string[] = []) => {
    const p = planWorkflow({ type, labels });
    return p.kind === "analysis" ? p.analysts : null;
  };
  assert.deepEqual(analysts("feature"), ["business-analyst", "solution-architect"]);
  assert.deepEqual(analysts("feature", ["ui"]), [
    "business-analyst",
    "ui-ux-designer",
    "solution-architect",
  ]);
  assert.deepEqual(analysts("change-request"), ["business-analyst", "solution-architect"]);
  assert.deepEqual(analysts("fr"), ["business-analyst"]);
  assert.deepEqual(analysts("nfr"), ["business-analyst", "solution-architect"]);
  assert.equal(
    codeOf(() => planWorkflow({ type: "milestone", labels: [] })),
    "POLICY_VIOLATION",
  );
});

test("upsertSection replaces an existing section, appends a missing one", () => {
  const body =
    "## Objective\nx\n\n<!-- omi:section=analysis -->\nold\n<!-- /omi:section=analysis -->\n\ntail";
  const replaced = upsertSection(body, "analysis", "new\n");
  assert.equal(
    replaced,
    "## Objective\nx\n\n<!-- omi:section=analysis -->\nnew\n<!-- /omi:section=analysis -->\n\ntail",
  );
  assert.equal(
    upsertSection("## Objective\nx\n", "design", "d"),
    "## Objective\nx\n\n<!-- omi:section=design -->\nd\n<!-- /omi:section=design -->\n",
  );
});

test("isTest recognises common test file conventions only", () => {
  for (const f of [
    "tests/a.ts",
    "src/test/A.java",
    "a.test.js",
    "b_test.go",
    "c.spec.ts",
    "x\\tests\\y.py",
  ]) {
    assert.ok(isTest(f), f);
  }
  for (const f of ["src/latest.ts", "contest/a.ts", "src/testing.ts"]) assert.ok(!isTest(f), f);
});
