// DevTask-0102 #311: model v2 labels (flags only) chosen by github.model; protection unchanged.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type ActualRepo,
  loadRepoConfig,
  loadRepoConfigFor,
  loadRepoConfigV2,
  planRepo,
} from "../../../runtime/github/application/repo-config.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";

const legacy = loadRepoConfig();
const v2 = loadRepoConfigV2();
const branches = { release: "main", base: "develop" };

test("v2 labels: ui, security, needs-po, superseded, spike; no type:* label", () => {
  assert.deepEqual(
    v2.labels.map((l) => l.name),
    ["ui", "security", "needs-po", "superseded", "spike"],
  );
  assert.ok(!v2.labels.some((l) => l.name.startsWith("type:")));
  assert.deepEqual(v2.protection, legacy.protection);
  assert.deepEqual(v2.merge, legacy.merge);
});

test("the model picks the desired state; legacy is unchanged", () => {
  const cfg = (model?: "v2") =>
    ({ github: { owner: "o", repo: "r", projectNumber: 1, model } }) as OmiConfig;
  assert.equal(loadRepoConfigFor(cfg("v2")), v2);
  assert.equal(loadRepoConfigFor(cfg()), legacy);
  assert.ok(legacy.labels.some((l) => l.name === "type:dev-task"));
});

test("plan: missing flags are created, ui/security already there are kept; foreign never deleted", () => {
  const actual: ActualRepo = {
    labels: [
      { name: "ui", color: "c5def5", description: "Cần DesignTask + UIUX review trên PR" },
      { name: "type:bug", color: "d73a4a", description: "OMI type: Bug" },
    ],
    branches: [
      { name: "main", exists: true, rules: [...v2.protection.release] },
      { name: "develop", exists: true, rules: [...v2.protection.base] },
    ],
    merge: { ...v2.merge },
  };
  const plan = planRepo(v2, actual, branches);
  assert.deepEqual(
    plan.actions.map((a) => (a.kind === "create-label" ? a.name : a.kind)),
    ["security", "needs-po", "superseded", "spike"],
  );
  assert.deepEqual(plan.foreign, ["type:bug"]);
  assert.deepEqual(planRepo(v2, { ...actual, labels: v2.labels }, branches).actions, []);
});
