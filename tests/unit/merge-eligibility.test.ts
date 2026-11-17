// T4.2 pure merge gate: unresolved checks, missing branch protection (public vs private Free,
// ADR-0001 D5), merge method, reviews and risk.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeEligibility, type PrFacts, riskOf } from "../../runtime/adapters/github/merge.ts";
import { prBody } from "../../runtime/adapters/github/pr.ts";

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
  assert.equal(
    status(facts({ commits: { nodes: [{ commit: { statusCheckRollup: null } }] } })).ci,
    "warn",
  );
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
