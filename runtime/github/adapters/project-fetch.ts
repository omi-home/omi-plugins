// Reads every item of a model v2 Project through paginated GraphQL (`gh api graphql` via the shared
// `graphql` helper, so a fake GhRunner tests it) — ChangeRequest-0013 #302 §9.5 step 1, ADR-0005 D2/D4.
// Output is `FetchedIssue[]`; domain/build-model.ts turns it into the item model. All external data goes
// through zod (`parseContract`), API failures are classified OmiErrors, nothing secret is read or kept.
import { z } from "zod";
import type { OmiConfig } from "../../shared/config.ts";
import { parseContract } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, graphql, markerAuthor, spawnGh } from "../../shared/github/client.ts";
import {
  type BuiltModel,
  buildProjectModel,
  type FetchedBlocker,
  type FetchedIssue,
} from "../domain/build-model.ts";
import type { LinkedPr, ReviewVerdict } from "../domain/project-model.ts";
import { OWNER_PROJECT } from "./project.ts";

const PAGE_SIZE = 30;
/** Nested lists are read in one page; more than this is an error, never a silent cut. */
const NESTED = 50;
const PRS = 20;
const LATEST = 30;

const ISSUE = `number state stateReason
  repository{nameWithOwner}
  issueType{name}
  milestone{number}
  labels(first:${NESTED}){ pageInfo{hasNextPage} nodes{name} }
  parent{ number repository{nameWithOwner} }
  subIssues(first:${NESTED}){ pageInfo{hasNextPage} nodes{ number repository{nameWithOwner} } }
  blockedBy(first:${NESTED}){ pageInfo{hasNextPage} nodes{ number state stateReason repository{nameWithOwner} } }
  closedByPullRequestsReferences(first:${PRS},includeClosedPrs:true){ pageInfo{hasNextPage} nodes{
    number state isDraft
    comments(last:${LATEST}){ nodes{ body createdAt authorAssociation author{login} } }
    reviews(last:${LATEST}){ nodes{ body submittedAt authorAssociation author{login} } } } }`;

const QUERY = `query($owner:String!,$number:Int!,$after:String){ ${OWNER_PROJECT(
  `items(first:${PAGE_SIZE},after:$after){ pageInfo{hasNextPage endCursor} nodes{
    fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } }
    content{ __typename ... on Issue{ ${ISSUE} } } } }`,
)} }`;

const Repo = z.strictObject({ nameWithOwner: z.string() });
const More = z.strictObject({ hasNextPage: z.boolean() });
const list = <T extends z.ZodType>(node: T) =>
  z.strictObject({ pageInfo: More, nodes: z.array(node) });
const Author = z.strictObject({ login: z.string().optional() }).nullable();
const Marked = {
  body: z.string(),
  authorAssociation: z.string(),
  author: Author,
};

const Pr = z.strictObject({
  number: z.int().positive(),
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  isDraft: z.boolean(),
  comments: z.strictObject({
    nodes: z.array(z.strictObject({ ...Marked, createdAt: z.string() })),
  }),
  reviews: z.strictObject({
    nodes: z.array(z.strictObject({ ...Marked, submittedAt: z.string().nullable() })),
  }),
});

const Blocker = z.strictObject({
  number: z.int().positive(),
  state: z.enum(["OPEN", "CLOSED"]),
  stateReason: z.string().nullable(),
  repository: Repo,
});

const IssueContent = z.strictObject({
  __typename: z.literal("Issue"),
  number: z.int().positive(),
  state: z.enum(["OPEN", "CLOSED"]),
  stateReason: z.string().nullable(),
  repository: Repo,
  issueType: z.strictObject({ name: z.string() }).nullable(),
  milestone: z.strictObject({ number: z.int().positive() }).nullable(),
  labels: list(z.strictObject({ name: z.string() })),
  parent: z.strictObject({ number: z.int().positive(), repository: Repo }).nullable(),
  subIssues: list(z.strictObject({ number: z.int().positive(), repository: Repo })),
  blockedBy: list(Blocker),
  closedByPullRequestsReferences: list(Pr),
});

const Page = z.strictObject({
  repositoryOwner: z
    .strictObject({
      projectV2: z
        .strictObject({
          items: z.strictObject({
            pageInfo: z.strictObject({
              hasNextPage: z.boolean(),
              endCursor: z.string().nullable(),
            }),
            nodes: z.array(
              z.strictObject({
                fieldValueByName: z.strictObject({ name: z.string().optional() }).nullable(),
                // Drafts, PRs and redacted items arrive without Issue fields: told apart by __typename.
                content: z.looseObject({ __typename: z.string() }).nullable(),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

/** `<!-- omi:review=<id> verdict=approved|changes_requested -->`; the last marker of a body wins. */
const MARKER = /<!--\s*omi:review=\S+\s+verdict=(approved|changes_requested)\s*-->/g;
export function reviewMarker(body: string): ReviewVerdict | null {
  const all = [...body.matchAll(MARKER)];
  return (all.at(-1)?.[1] as ReviewVerdict | undefined) ?? null;
}

const reason = (r: string | null): FetchedIssue["stateReason"] =>
  r === "COMPLETED"
    ? "completed"
    : r === "NOT_PLANNED" || r === "DUPLICATE"
      ? "not_planned"
      : r === "REOPENED"
        ? "reopened"
        : null;

export interface FetchedProject {
  issues: FetchedIssue[];
  /** Project items that are Issues of another repository: left out (numbers would collide). */
  foreign: string[];
}

function tooMany(what: string, number: number): never {
  throw new OmiError(
    "CONTRACT_INVALID",
    `#${number}: more than the supported number of ${what}; the model would be incomplete`,
  );
}

/** Latest verdict of a PR from trusted marker comments and reviews; `none` without any. */
function verdictOf(
  pr: z.infer<typeof Pr>,
  trusted: ReturnType<typeof markerAuthor>,
): ReviewVerdict {
  const found: { at: string; verdict: ReviewVerdict }[] = [];
  const consider = (
    n: { body: string; authorAssociation: string; author: { login?: string | undefined } | null },
    at: string | null,
  ) => {
    const verdict = reviewMarker(n.body);
    if (verdict && at && trusted(n.authorAssociation, n.author?.login)) found.push({ at, verdict });
  };
  for (const c of pr.comments.nodes) consider(c, c.createdAt);
  for (const r of pr.reviews.nodes) consider(r, r.submittedAt);
  // ISO timestamps sort as text; the sort is stable, so on a tie the later-listed entry wins.
  found.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  return found.at(-1)?.verdict ?? "none";
}

/**
 * Reads all Project items (every page). Items that are not Issues are ignored. A missing Project is
 * CONFIG_INVALID; GraphQL and transport errors are classified by `graphql`.
 */
export function fetchProjectIssues(config: OmiConfig, run: GhRunner = spawnGh): FetchedProject {
  const { owner, repo, projectNumber } = config.github;
  const trusted = markerAuthor(run);
  const home = `${owner}/${repo}`.toLowerCase();
  const same = (r: z.infer<typeof Repo>) => r.nameWithOwner.toLowerCase() === home;
  const issues: FetchedIssue[] = [];
  const foreign: string[] = [];
  const seen = new Set<number>();
  let after: string | null = null;
  do {
    const vars: Record<string, unknown> = { owner, number: projectNumber };
    if (after) vars.after = after;
    const data = graphql(QUERY, vars, Page, "project items", run);
    const project = data.repositoryOwner?.projectV2;
    if (!project) {
      throw new OmiError("CONFIG_INVALID", `Project #${projectNumber} of ${owner} not found`);
    }
    for (const node of project.items.nodes) {
      if (node.content?.__typename !== "Issue") continue;
      const c = parseContract(IssueContent, node.content, "project issue");
      if (!same(c.repository)) {
        foreign.push(`${c.repository.nameWithOwner}#${c.number}`);
        continue;
      }
      if (seen.has(c.number)) continue; // the same Issue added twice to one Project
      seen.add(c.number);
      if (c.labels.pageInfo.hasNextPage) tooMany("labels", c.number);
      if (c.subIssues.pageInfo.hasNextPage) tooMany("sub-issues", c.number);
      if (c.blockedBy.pageInfo.hasNextPage) tooMany("blockers", c.number);
      if (c.closedByPullRequestsReferences.pageInfo.hasNextPage) tooMany("linked PRs", c.number);
      const prs: LinkedPr[] = c.closedByPullRequestsReferences.nodes.map((p) => ({
        number: p.number,
        state:
          p.state === "MERGED"
            ? "merged"
            : p.state === "CLOSED"
              ? "closed"
              : p.isDraft
                ? "draft"
                : "open",
        verdict: verdictOf(p, trusted),
      }));
      const blockedBy: FetchedBlocker[] = c.blockedBy.nodes.map((b) => ({
        ref: `${b.repository.nameWithOwner}#${b.number}`,
        number: same(b.repository) ? b.number : null,
        closed: b.state === "CLOSED",
        completed: reason(b.stateReason) === "completed",
      }));
      issues.push({
        number: c.number,
        type: c.issueType?.name ?? null,
        status: node.fieldValueByName?.name ?? null,
        state: c.state === "OPEN" ? "open" : "closed",
        stateReason: reason(c.stateReason),
        parent: c.parent && same(c.parent.repository) ? c.parent.number : null,
        children: c.subIssues.nodes.filter((s) => same(s.repository)).map((s) => s.number),
        blockedBy,
        labels: c.labels.nodes.map((l) => l.name),
        milestone: c.milestone?.number ?? null,
        prs,
      });
    }
    after = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null;
  } while (after);
  return { issues, foreign };
}

/** Fetch, then build the validated model: the input of sync, move, validate, queue and inbox. */
export function fetchProjectModel(
  config: OmiConfig,
  run: GhRunner = spawnGh,
): BuiltModel & { foreign: string[] } {
  const { issues, foreign } = fetchProjectIssues(config, run);
  return { ...buildProjectModel(issues), foreign };
}
