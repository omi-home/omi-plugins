// T4.2 pure merge gate: unresolved checks, missing branch protection (public vs private Free,
// ADR-0001 D5), merge method, reviews and risk.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mergeEligibility,
  type PrFacts,
  prFacts,
  riskOf,
  triggersOnPullRequest,
} from "../../../runtime/release/adapters/merge.ts";
import { prBody } from "../../../runtime/release/adapters/pr.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";

const TIP = "a".repeat(40);

function facts(pr: Record<string, unknown> = {}, repo: Partial<PrFacts> = {}): PrFacts {
  return {
    pr: {
      id: "PR",
      number: 1,
      url: "u",
      state: "OPEN",
      isDraft: false,
      merged: false,
      mergedAt: null,
      mergeable: "MERGEABLE",
      reviewDecision: "APPROVED",
      baseRefName: "develop",
      headRefName: "feature/5-x",
      headRefOid: TIP,
      body: prBody("o/r", 5),
      mergeCommit: null,
      labels: { nodes: [] },
      commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
      ...pr,
    } as PrFacts["pr"],
    prs: [],
    count: 1,
    isPrivate: false,
    admin: false,
    protected: true,
    allowed: { SQUASH: true, MERGE: false, REBASE: false },
    ...repo,
  };
}
const want = {
  primary: "o/r#5",
  base: "develop",
  method: "SQUASH" as const,
  issueLabels: [] as string[],
  localTip: TIP,
  privateRiskAccepted: false,
};
const status = (f: PrFacts, w = want) =>
  Object.fromEntries(mergeEligibility(f, w).map((c) => [c.name, c.status]));

test("all gates pass for an approved, green, protected squash PR", () => {
  assert.ok(Object.values(status(facts())).every((s) => s === "pass"));
});

test("unresolved or failed checks block; no checks at all is a disclosed warning", () => {
  for (const state of ["PENDING", "EXPECTED", "FAILURE", "ERROR"]) {
    const ci = { commits: { nodes: [{ commit: { statusCheckRollup: { state } } }] } };
    assert.equal(status(facts(ci)).ci, "fail", state);
  }
  const none = { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } };
  assert.equal(status(facts(none)).ci, "warn");
  assert.equal(status(facts(none, { hasCi: false })).ci, "warn");
});

test("repo with a pull_request workflow and no checks yet fails with a wait message", () => {
  const none = { commits: { nodes: [{ commit: { statusCheckRollup: null } }] } };
  const ci = mergeEligibility(facts(none, { hasCi: true }), want).find((c) => c.name === "ci");
  assert.equal(ci?.status, "fail");
  assert.equal(ci?.detail, "no checks reported yet: wait and retry");
  assert.equal(status(facts({}, { hasCi: true })).ci, "pass");
});

test("triggersOnPullRequest detects pull_request triggers only", () => {
  assert.ok(triggersOnPullRequest("on:\n  pull_request:\n    branches: [develop]\n"));
  assert.ok(triggersOnPullRequest("on: [push, pull_request]\n"));
  assert.ok(!triggersOnPullRequest("on:\n  push:\n"));
  assert.ok(!triggersOnPullRequest("on:\n  pull_request_review:\n"));
  assert.ok(!triggersOnPullRequest("# pull_request\non: push\n"));
});

test("triggersOnPullRequest is structural: only `on:` keys, trailing comments ignored", () => {
  assert.ok(
    !triggersOnPullRequest("on: push\njobs:\n  a:\n    if: github.event_name == 'pull_request'\n"),
  );
  assert.ok(!triggersOnPullRequest("on:\n  push: # pull_request\n"));
  assert.ok(!triggersOnPullRequest("on: push # pull_request\n"));
  assert.ok(triggersOnPullRequest("on:\n  pull_request_target:\n"));
  assert.ok(triggersOnPullRequest("on: pull_request\n"));
  assert.ok(!triggersOnPullRequest(": : not yaml ["));
});

test("triggersOnPullRequest honours branches / branches-ignore against the base", () => {
  const only = "on:\n  pull_request:\n    branches: [main, 'release/**']\n";
  assert.ok(!triggersOnPullRequest(only, "develop"));
  assert.ok(triggersOnPullRequest(only, "main"));
  assert.ok(triggersOnPullRequest(only, "release/1.0"));
  assert.ok(triggersOnPullRequest(only));
  const ignore = "on:\n  pull_request:\n    branches-ignore: [develop]\n";
  assert.ok(!triggersOnPullRequest(ignore, "develop"));
  assert.ok(triggersOnPullRequest(ignore, "main"));
  assert.ok(
    !triggersOnPullRequest("on:\n  pull_request:\n    branches: ['**', '!develop']\n", "develop"),
  );
});

function factsRun(workflows: unknown): GhRunner {
  const data = {
    repository: {
      isPrivate: false,
      viewerPermission: "WRITE",
      squashMergeAllowed: true,
      mergeCommitAllowed: false,
      rebaseMergeAllowed: false,
      ref: null,
      pullRequests: { nodes: [] },
      workflows,
    },
  };
  return () => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
}
const cfg = { github: { owner: "o", repo: "r" } } as OmiConfig;
const ciOf = (workflows: unknown, base = "develop") =>
  prFacts(cfg, { head: "h", base, states: ["OPEN"] }, factsRun(workflows)).hasCi;
const file = (name: string, text: string | null) => ({ name, object: { text } });

test("prFacts hasCi: pull_request workflow yml true; null tree, non-YAML, filtered false", () => {
  assert.equal(ciOf({ entries: [file("check.yml", "on:\n  pull_request:\n")] }), true);
  assert.equal(ciOf({ entries: [file("a.yaml", "on: [pull_request]\n")] }), true);
  assert.equal(ciOf(null), false);
  assert.equal(ciOf({ entries: [file("README.md", "on: pull_request\n")] }), false);
  assert.equal(ciOf({ entries: [file("x.yml", null)] }), false);
  const filtered = "on:\n  pull_request:\n    branches: [main]\n";
  assert.equal(ciOf({ entries: [file("f.yml", filtered)] }), false);
  assert.equal(ciOf({ entries: [file("f.yml", filtered)] }, "main"), true);
});

test("no branch protection: warn on public, fail on private unless risk accepted (D5)", () => {
  assert.equal(status(facts({}, { protected: false })).protection, "warn");
  assert.equal(status(facts({}, { protected: false, isPrivate: true })).protection, "fail");
  assert.equal(
    status(facts({}, { protected: false, isPrivate: true }), { ...want, privateRiskAccepted: true })
      .protection,
    "warn",
  );
});

test("squash disabled on the repo, conflicts, drafts and changes requested block", () => {
  assert.equal(
    status(facts({}, { allowed: { SQUASH: false, MERGE: true, REBASE: true } }))["merge-method"],
    "fail",
  );
  assert.equal(status(facts({ mergeable: "CONFLICTING" })).mergeable, "fail");
  assert.equal(
    mergeEligibility(facts({ mergeable: "UNKNOWN" }), want).find((c) => c.name === "mergeable")
      ?.code,
    "GITHUB_UNAVAILABLE",
  );
  assert.equal(status(facts({ isDraft: true })).pr, "fail");
  assert.equal(status(facts({ reviewDecision: "CHANGES_REQUESTED" })).review, "fail");
  assert.equal(status(facts({ reviewDecision: null })).review, "warn");
});

test("risk:high on the Issue or the PR blocks; admin token is disclosed", () => {
  assert.equal(status(facts(), { ...want, issueLabels: ["risk:high"] }).risk, "fail");
  assert.equal(status(facts({ labels: { nodes: [{ name: "risk:HIGH" }] } })).risk, "fail");
  assert.equal(status(facts({}, { admin: true })).token, "warn");
  assert.equal(riskOf(["risk:low", "risk:high"]), "high");
  assert.equal(riskOf(["type:dev-task"]), undefined);
});

test("no PR, two PRs, or wrong primary block", () => {
  assert.equal(status(facts({}, { pr: undefined, count: 0 })).pr, "fail");
  assert.equal(status(facts({}, { count: 2 })).pr, "fail");
  assert.equal(status(facts({ body: prBody("o/r", 6) }))["pr-primary"], "fail");
});
