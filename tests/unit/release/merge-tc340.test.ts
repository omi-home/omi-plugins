// Regression for Bug #340: `pr merge` merged while CI had not registered any check on the head
// commit. Imports only modules that already exist before the fix (883868d); the fake `gh` answers
// like GitHub does: workflows are returned only when the query asks for them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeEligibility, prFacts } from "../../../runtime/release/adapters/merge.ts";
import { prBody } from "../../../runtime/release/adapters/pr.ts";
import type { OmiConfig } from "../../../runtime/shared/config.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";

const TIP = "b".repeat(40);
const cfg = { github: { owner: "o", repo: "r" } } as OmiConfig;
const PR_WORKFLOW = "name: check\non:\n  pull_request:\n    branches: [develop]\n";

/** A fake gh for a PR whose head commit has no check yet (`statusCheckRollup` null). */
function ghWith(workflowText: string | null): GhRunner {
  return (args) => {
    const query = args.find((a) => a.startsWith("query=")) ?? "";
    const repository: Record<string, unknown> = {
      isPrivate: false,
      viewerPermission: "WRITE",
      squashMergeAllowed: true,
      mergeCommitAllowed: false,
      rebaseMergeAllowed: false,
      ref: { branchProtectionRule: null, rules: { nodes: [] } },
      pullRequests: {
        nodes: [
          {
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
            title: "DevTask-0005-Task 5",
            body: prBody("o/r", 5),
            mergeCommit: null,
            labels: { nodes: [] },
            commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
          },
        ],
      },
    };
    if (query.includes("workflows")) {
      repository.workflows =
        workflowText === null
          ? null
          : { entries: [{ name: "check.yml", object: { text: workflowText } }] };
    }
    return { status: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
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
const ciCheck = (workflowText: string | null) => {
  const f = prFacts(
    cfg,
    { head: "feature/5-x", base: "develop", states: ["OPEN"] },
    ghWith(workflowText),
  );
  return mergeEligibility(f, want).find((c) => c.name === "ci");
};

test("TC-340-01: repo with a pull_request workflow and no check on the head commit fails the ci gate", () => {
  const ci = ciCheck(PR_WORKFLOW);
  assert.equal(ci?.status, "fail");
  assert.equal(ci?.detail, "no checks reported yet: wait and retry");
});

test("TC-340-02: repo without any pull_request workflow still only warns", () => {
  assert.equal(ciCheck(null)?.status, "warn");
  assert.equal(ciCheck("on:\n  push:\n")?.status, "warn");
});
