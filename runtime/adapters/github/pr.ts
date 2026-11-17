// Pull request lookup/creation and primary-Issue validation (spec §8 gate 5, ADR-0001 D4/T0.6).
// One PR per head branch; exactly one primary executable Issue, proven by GitHub's closing
// references when the base is the default branch, else by the OMI marker in the PR body.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import type { Check } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";

export const PullRequest = z.strictObject({
  id: z.string(),
  number: z.int().positive(),
  url: z.string(),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  body: z.string(),
});
export type PullRequest = z.infer<typeof PullRequest>;

/** Blocking wait for the synchronous CLI (backoff between GitHub reads). */
export const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
};

const PR_FIELDS = "id number url baseRefName headRefName headRefOid body";

/** Marker naming the primary Issue in the PR body: the fallback link when base ≠ default. */
export const primaryMarker = (repository: string, issue: number) =>
  `<!-- omi:pr-primary=${repository}#${issue} -->`;

export function prBody(repository: string, issue: number, extra = ""): string {
  return [primaryMarker(repository, issue), extra.trim(), `Closes #${issue}`]
    .filter(Boolean)
    .join("\n\n");
}

/** Every primary Issue the body names; more than one is a dual-primary PR. */
export const markedPrimaries = (body: string): string[] =>
  [...body.matchAll(/<!-- omi:pr-primary=([\w.-]+\/[\w.-]+#\d+) -->/g)].map((m) => m[1] as string);

export interface RepoFacts {
  id: string;
  defaultBranch: string;
  /** Open PRs whose head is the branch asked for. */
  open: PullRequest[];
}

const Repo = z.strictObject({
  repository: z
    .strictObject({
      id: z.string(),
      defaultBranchRef: z.strictObject({ name: z.string() }).nullable(),
      pullRequests: z.strictObject({ nodes: z.array(PullRequest) }),
    })
    .nullable(),
});

export function repoFacts(config: OmiConfig, head: string, run: GhRunner = spawnGh): RepoFacts {
  const { owner, repo } = config.github;
  const data = graphql(
    `query($owner:String!,$repo:String!,$head:String!){repository(owner:$owner,name:$repo){id
      defaultBranchRef{name}
      pullRequests(headRefName:$head,states:OPEN,first:5){nodes{${PR_FIELDS}}}}}`,
    { owner, repo, head },
    Repo,
    "pull request lookup",
    run,
  );
  if (!data.repository) {
    throw new OmiError("CONFIG_INVALID", `repository ${owner}/${repo} not found or not accessible`);
  }
  return {
    id: data.repository.id,
    defaultBranch: data.repository.defaultBranchRef?.name ?? "",
    open: data.repository.pullRequests.nodes,
  };
}

const Created = z.strictObject({
  createPullRequest: z.strictObject({ pullRequest: PullRequest }),
});

export function createPr(
  o: { repositoryId: string; base: string; head: string; title: string; body: string },
  run: GhRunner = spawnGh,
): PullRequest {
  return graphql(
    `mutation($r:ID!,$b:String!,$h:String!,$t:String!,$body:String!){createPullRequest(input:{
      repositoryId:$r,baseRefName:$b,headRefName:$h,title:$t,body:$body}){pullRequest{${PR_FIELDS}}}}`,
    { r: o.repositoryId, b: o.base, h: o.head, t: o.title, body: o.body },
    Created,
    "pull request create",
    run,
  ).createPullRequest.pullRequest;
}

const Closing = z.strictObject({
  node: z
    .strictObject({
      closingIssuesReferences: z.strictObject({
        nodes: z.array(
          z.strictObject({
            number: z.int(),
            repository: z.strictObject({ nameWithOwner: z.string() }),
          }),
        ),
      }),
    })
    .nullable(),
});

/**
 * Issues the PR will close. GitHub fills this asynchronously (≤ ~15 s in T0.6), so an empty
 * answer is retried with backoff until `timeoutMs`.
 */
export function closingIssues(
  prId: string,
  o: { run?: GhRunner; sleep?: (ms: number) => void; timeoutMs?: number } = {},
): string[] {
  const sleep = o.sleep ?? sleepSync;
  let waited = 0;
  for (let delay = 1000; ; delay *= 2) {
    const data = graphql(
      `query($id:ID!){node(id:$id){... on PullRequest{closingIssuesReferences(first:10){nodes{
        number repository{nameWithOwner}}}}}}`,
      { id: prId },
      Closing,
      "pull request closing issues",
      o.run ?? spawnGh,
    );
    const refs = (data.node?.closingIssuesReferences.nodes ?? []).map(
      (n) => `${n.repository.nameWithOwner}#${n.number}`,
    );
    if (refs.length || waited >= (o.timeoutMs ?? 30_000)) return refs;
    sleep(delay);
    waited += delay;
  }
}

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({
  name,
  status: "fail",
  code: "POLICY_VIOLATION",
  detail,
});

/**
 * Pure gate (spec §8.5): target base, head branch, exactly one primary Issue. `closing` is
 * null when the base is not the default branch: GitHub records no closing link there (T0.6),
 * so the body marker is the only evidence.
 */
export function validatePr(
  pr: Pick<PullRequest, "baseRefName" | "headRefName" | "body">,
  want: { primary: string; base: string; head: string; closing: string[] | null },
): Check[] {
  const marked = markedPrimaries(pr.body);
  const checks = [
    pr.baseRefName === want.base
      ? pass("pr-base", want.base)
      : fail("pr-base", `targets ${pr.baseRefName}, expected ${want.base}`),
    pr.headRefName === want.head
      ? pass("pr-head", want.head)
      : fail("pr-head", `head ${pr.headRefName}, expected ${want.head}`),
    marked.length === 1 && marked[0] === want.primary
      ? pass("pr-primary", want.primary)
      : fail(
          "pr-primary",
          marked.length ? `body names ${marked.join(", ")}` : "body has no omi:pr-primary marker",
        ),
  ];
  if (want.closing) {
    checks.push(
      want.closing.length === 1 && want.closing[0] === want.primary
        ? pass("pr-closes", want.primary)
        : fail(
            "pr-closes",
            want.closing.length
              ? `closes ${want.closing.join(", ")}: exactly one primary Issue allowed`
              : "GitHub links no closing Issue",
          ),
    );
  }
  return checks;
}
