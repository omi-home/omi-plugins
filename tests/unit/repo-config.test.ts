// DevTask-0038 #90: repository desired state, diff (never loosen, never delete) and risk policy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { IssueType } from "../../runtime/core/contracts.ts";
import {
  type ActualRepo,
  loadRepoConfig,
  loadRiskPolicy,
  planRepo,
  RepoConfig,
  riskLevel,
} from "../../runtime/core/repo-config.ts";
import { MANUAL_QA_LABELS, SECURITY_LABELS } from "../../runtime/core/workflow-engine/plan.ts";

const desired = loadRepoConfig();
const policy = loadRiskPolicy();
const branches = { release: "main", base: "develop" };
const ALL = desired.protection.base;

const synced = (): ActualRepo => ({
  labels: desired.labels.map((l) => ({ ...l })),
  branches: [
    { name: "main", exists: true, rules: [...desired.protection.release] },
    { name: "develop", exists: true, rules: [...ALL] },
  ],
  merge: { ...desired.merge },
});

test("shipped config: a label for every type, risk level and engine flag", () => {
  const names = desired.labels.map((l) => l.name);
  for (const t of IssueType.options) assert.ok(names.includes(`type:${t}`), t);
  for (const l of policy.levels) assert.ok(names.includes(`risk:${l}`), l);
  for (const l of [...SECURITY_LABELS, ...MANUAL_QA_LABELS, "refactor"])
    assert.ok(names.includes(l), l);
  assert.ok(
    !desired.protection.release.includes("linear-history"),
    "PO: linear history only on develop",
  );
});

test("config rejects unknown keys, unknown rules, duplicate labels, missing type labels", () => {
  const raw = structuredClone(desired) as Record<string, unknown>;
  assert.ok(RepoConfig.safeParse(raw).success);
  const bad: unknown[] = [
    { ...raw, views: [] },
    { ...raw, protection: { release: ["require-signatures"], base: [] } },
    { ...raw, labels: [...desired.labels, { ...desired.labels[0], name: "TYPE:EPIC" }] },
    { ...raw, labels: desired.labels.filter((l) => l.name !== "type:bug") },
    { ...raw, labels: [{ name: "x", color: "#fff" }] },
    { ...raw, merge: { squash: false, mergeCommit: false, rebase: false } },
  ];
  for (const b of bad) assert.equal(RepoConfig.safeParse(b).success, false);
});

test("in sync: no action; foreign labels reported, never deleted", () => {
  const actual = synced();
  actual.labels.push({ name: "good first issue", color: "7057ff", description: "" });
  actual.labels[0] = { ...actual.labels[0], color: actual.labels[0]?.color.toUpperCase() } as never;
  assert.deepEqual(planRepo(desired, actual, branches), {
    actions: [],
    foreign: ["good first issue"],
  });
});

test("stricter existing protection is kept: only missing rules are enabled", () => {
  const actual = synced();
  // main already has linear history (not required there): left as is.
  actual.branches[0] = { name: "main", exists: true, rules: [...ALL] };
  actual.branches[1] = { name: "develop", exists: true, rules: ["pull-request", "no-deletion"] };
  assert.deepEqual(planRepo(desired, actual, branches).actions, [
    {
      kind: "protect",
      branch: "develop",
      enable: ["enforce-admins", "no-force-push", "conversation-resolution", "linear-history"],
    },
  ]);
});

test("labels, merge methods, missing branch, private Free and blockers", () => {
  const actual = synced();
  actual.labels = actual.labels.filter((l) => l.name !== "risk:high");
  const ui = actual.labels.find((l) => l.name === "ui");
  if (ui) ui.description = "old";
  actual.merge.rebase = false;
  actual.branches[0] = { name: "main", exists: true, rules: null };
  actual.branches[1] = { name: "develop", exists: false, rules: [] };
  const kinds = planRepo(desired, actual, branches).actions.map((a) =>
    a.kind === "manual" || a.kind === "unsupported" ? `${a.kind} ${a.what}` : a.kind,
  );
  assert.deepEqual(kinds, [
    "create-label",
    "update-label",
    "unsupported protection of main",
    "manual branch develop",
    "merge-methods",
  ]);
  const blocked = synced();
  blocked.branches[1] = {
    name: "develop",
    exists: true,
    rules: [],
    blocker: "push restrictions are set",
  };
  const [a] = planRepo(desired, blocked, branches).actions;
  assert.equal(a?.kind, "manual");
});

test("risk: highest known level wins, unknown levels ignored", () => {
  assert.equal(riskLevel(["risk:low", "risk:high", "risk:medium"]), "high");
  assert.equal(riskLevel(["risk:critical", "type:bug"]), undefined);
  assert.equal(riskLevel(["RISK:Low".toLowerCase()]), "low");
  assert.deepEqual(policy.poMerge, ["high"]);
});
