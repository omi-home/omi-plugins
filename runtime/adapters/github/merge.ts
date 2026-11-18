// Merge eligibility, the authorized merge path and merge receipts (spec §8 gate 6, §14,
// ADR-0001 D5). Facts are read from GitHub; the gate itself is a pure function so every rule is
// testable without a network. Merge evidence is GitHub's receipt, never `git branch --merged`.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import type { Check } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { loadRiskPolicy, riskLevel } from "../../core/repo-config.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";
import { markedPrimaries } from "./pr.ts";

const MergeMethod = z.enum(["SQUASH", "MERGE", "REBASE"]);
type MergeMethod = z.infer<typeof MergeMethod>;

const PrNode = z.strictObject({
  id: z.string(),
  number: z.int().positive(),
  url: z.string(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  merged: z.boolean(),
  mergedAt: z.string().nullable(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  body: z.string(),
  mergeCommit: z.strictObject({ oid: z.string() }).nullable(),
  labels: z.strictObject({ nodes: z.array(z.strictObject({ name: z.string() })) }),
  commits: z.strictObject({
    nodes: z.array(
      z.strictObject({
        commit: z.strictObject({
          statusCheckRollup: z
            .strictObject({
              state: z.enum(["SUCCESS", "PENDING", "EXPECTED", "FAILURE", "ERROR"]),
            })
            .nullable(),
        }),
      }),
    ),
  }),
});
type PrNode = z.infer<typeof PrNode>;

const PR_FIELDS = `id number url state isDraft merged mergedAt mergeable reviewDecision baseRefName
  headRefName headRefOid body mergeCommit{oid} labels(first:30){nodes{name}}
  commits(last:1){nodes{commit{statusCheckRollup{state}}}}`;

const Facts = z.strictObject({
  repository: z
    .strictObject({
      isPrivate: z.boolean(),
      viewerPermission: z.string().nullable(),
      squashMergeAllowed: z.boolean(),
      mergeCommitAllowed: z.boolean(),
      rebaseMergeAllowed: z.boolean(),
      ref: z
        .strictObject({
          branchProtectionRule: z.strictObject({ isAdminEnforced: z.boolean() }).nullable(),
          rules: z.strictObject({ nodes: z.array(z.strictObject({ type: z.string() })) }),
        })
        .nullable(),
      pullRequests: z.strictObject({ nodes: z.array(PrNode) }),
    })
    .nullable(),
});

export interface PrFacts {
  pr: PrNode | undefined;
  /** Every PR from the head in the requested states (more than one is a policy violation). */
  count: number;
  isPrivate: boolean;
  admin: boolean;
  /** Server-side rules on the base branch: classic protection or a ruleset. */
  protected: boolean;
  allowed: Record<MergeMethod, boolean>;
}

/** Reads the PR from `head` in `states` plus the repo/base-branch facts the gate needs. */
export function prFacts(
  config: OmiConfig,
  o: { head: string; base: string; states: ("OPEN" | "MERGED")[] },
  run: GhRunner = spawnGh,
): PrFacts {
  const { owner, repo } = config.github;
  const data = graphql(
    `query($owner:String!,$repo:String!,$head:String!,$base:String!){repository(owner:$owner,name:$repo){
      isPrivate viewerPermission squashMergeAllowed mergeCommitAllowed rebaseMergeAllowed
      ref(qualifiedName:$base){branchProtectionRule{isAdminEnforced} rules(first:20){nodes{type}}}
      pullRequests(headRefName:$head,states:[${o.states.join(",")}],first:5,orderBy:{field:CREATED_AT,direction:DESC}){nodes{${PR_FIELDS}}}}}`,
    { owner, repo, head: o.head, base: `refs/heads/${o.base}` },
    Facts,
    "merge facts",
    run,
  ).repository;
  if (!data) {
    throw new OmiError("CONFIG_INVALID", `repository ${owner}/${repo} not found or not accessible`);
  }
  return {
    pr: data.pullRequests.nodes[0],
    count: data.pullRequests.nodes.length,
    isPrivate: data.isPrivate,
    admin: data.viewerPermission === "ADMIN",
    protected: Boolean(data.ref?.branchProtectionRule || data.ref?.rules.nodes.length),
    allowed: {
      SQUASH: data.squashMergeAllowed,
      MERGE: data.mergeCommitAllowed,
      REBASE: data.rebaseMergeAllowed,
    },
  };
}

/** Highest risk named by `risk:<level>` labels on the Issue or the PR (gov §8.3, risk-policy.yaml). */
export const riskOf = (labels: string[]): string | undefined => riskLevel(labels);

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const warn = (name: string, detail: string): Check => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): Check => ({
  name,
  status: "fail",
  code: "POLICY_VIOLATION",
  detail,
});

/** Name of the check that sends a PR to the PO instead of merging (High risk, gov §8.3). */
export const RISK_CHECK = "risk";

/**
 * Pure merge gate (spec §8 gates 5–6). `fail` blocks the merge; `warn` is a disclosed limit
 * (no server protection, no CI, no required review, admin token). A High risk PR is never
 * merged by OMI: the PO merges it.
 */
export function mergeEligibility(
  f: PrFacts,
  want: {
    primary: string;
    base: string;
    method: MergeMethod;
    issueLabels: string[];
    /** Local tip of the task branch; undefined when no worktree is left to compare. */
    localTip?: string;
    privateRiskAccepted: boolean;
  },
): Check[] {
  const pr = f.pr;
  if (!pr || f.count !== 1) {
    return [fail("pr", pr ? `${f.count} PRs from the task branch` : "no open PR: omi pr create")];
  }
  const checks: Check[] = [];
  checks.push(
    pr.state === "OPEN" && !pr.isDraft
      ? pass("pr", pr.url)
      : fail("pr", `${pr.url} is ${pr.isDraft ? "a draft" : pr.state}`),
  );
  checks.push(
    pr.baseRefName === want.base
      ? pass("pr-base", want.base)
      : fail("pr-base", `targets ${pr.baseRefName}, expected ${want.base}`),
  );
  const marked = markedPrimaries(pr.body);
  checks.push(
    marked.length === 1 && marked[0] === want.primary
      ? pass("pr-primary", want.primary)
      : fail("pr-primary", marked.length ? `body names ${marked.join(", ")}` : "no primary marker"),
  );
  if (want.localTip !== undefined) {
    checks.push(
      pr.headRefOid === want.localTip
        ? pass("pr-tip", want.localTip.slice(0, 12))
        : fail(
            "pr-tip",
            `PR head ${pr.headRefOid.slice(0, 12)} ≠ local ${want.localTip.slice(0, 12)}`,
          ),
    );
  }
  checks.push(
    pr.mergeable === "MERGEABLE"
      ? pass("mergeable", "no conflicts")
      : pr.mergeable === "CONFLICTING"
        ? fail("mergeable", "conflicts with the base: update the branch")
        : {
            name: "mergeable",
            status: "fail",
            code: "GITHUB_UNAVAILABLE",
            detail: "GitHub is still computing mergeability: retry",
          },
  );
  const ci = pr.commits.nodes[0]?.commit.statusCheckRollup?.state;
  checks.push(
    ci === undefined
      ? warn("ci", "no checks reported on the head commit")
      : ci === "SUCCESS"
        ? pass("ci", "all checks passed (run on agent-pushed code: not an independent control)")
        : ci === "PENDING" || ci === "EXPECTED"
          ? fail("ci", `checks unresolved (${ci}): wait and retry`)
          : fail("ci", `checks ${ci}`),
  );
  checks.push(
    pr.reviewDecision === "APPROVED"
      ? pass("review", "approved")
      : pr.reviewDecision === null
        ? warn("review", "no review required by GitHub: approval rests on OMI review and policy")
        : fail(
            "review",
            pr.reviewDecision === "CHANGES_REQUESTED" ? "changes requested" : "review required",
          ),
  );
  checks.push(
    f.allowed[want.method]
      ? pass("merge-method", want.method.toLowerCase())
      : fail("merge-method", `${want.method.toLowerCase()} merge is disabled on the repository`),
  );
  checks.push(
    f.protected
      ? pass("protection", `${want.base} has server-side rules`)
      : f.isPrivate && !want.privateRiskAccepted
        ? fail(
            "protection",
            "private repo without server-side protection: set github.privateRepoRiskAccepted (D5)",
          )
        : warn("protection", `${want.base} has no server-side rules: OMI checks are the only gate`),
  );
  if (f.admin) {
    checks.push(warn("token", "token has admin rights: it can bypass branch protection"));
  }
  const risk = riskOf([...want.issueLabels, ...pr.labels.nodes.map((l) => l.name)]);
  const policy = loadRiskPolicy();
  const level = risk ?? policy.default;
  checks.push(
    policy.poMerge.includes(level)
      ? fail(RISK_CHECK, `risk:${level}: the PO merges this PR (Waiting PO)`)
      : pass(RISK_CHECK, risk ? `risk:${risk}` : `no risk label (treated as ${policy.default})`),
  );
  return checks;
}

const Merged = z.strictObject({
  mergePullRequest: z.strictObject({ pullRequest: z.strictObject({ merged: z.boolean() }) }),
});

/**
 * Merges with `expectedHeadOid`: GitHub refuses when the head moved after the gate ran, so a
 * push between validate and merge can never be merged unchecked.
 */
export function mergePr(
  o: { prId: string; method: MergeMethod; headOid: string },
  run: GhRunner = spawnGh,
): void {
  const r = graphql(
    `mutation($id:ID!,$oid:GitObjectID!){mergePullRequest(input:{pullRequestId:$id,
      mergeMethod:${o.method},expectedHeadOid:$oid}){pullRequest{merged}}}`,
    { id: o.prId, oid: o.headOid },
    Merged,
    "pull request merge",
    run,
  );
  if (!r.mergePullRequest.pullRequest.merged) {
    throw new OmiError("POLICY_VIOLATION", "GitHub accepted the merge but the PR is not merged");
  }
}

export interface MergeReceipt {
  number: number;
  url: string;
  merged: true;
  mergedAt: string;
  baseRef: string;
  headRef: string;
  headSha: string;
  mergeCommit: string | null;
}

/** The PR as merge evidence (ADR-0001): merged, base, head and head SHA, or undefined. */
export const receiptOf = (pr: PrNode | undefined): MergeReceipt | undefined =>
  pr?.merged && pr.mergedAt
    ? {
        number: pr.number,
        url: pr.url,
        merged: true,
        mergedAt: pr.mergedAt,
        baseRef: pr.baseRefName,
        headRef: pr.headRefName,
        headSha: pr.headRefOid,
        mergeCommit: pr.mergeCommit?.oid ?? null,
      }
    : undefined;
