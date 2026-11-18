// `omi status` (DevTask-0050 #145): one Milestone's native sub-issue tree with each Issue's type,
// Project Status (configured Project only) and open PRs that close it. Read-only.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { labelType } from "../../core/hierarchy.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";

const PAGE = 50;
const MAX_DEPTH = 8; // GitHub's sub-issue nesting limit
/** ponytail: one gh call per container page; batch with aliases if trees grow past this. */
const MAX_ISSUES = 500;

const FIELDS = `number title state labels(first:20){ nodes{ name } }
  projectItems(first:20){ nodes{ project{ number owner{... on Organization{login} ... on User{login}} }
    fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}} } }
  closedByPullRequestsReferences(first:10,includeClosedPrs:false){ nodes{ number url isDraft state } }
  subIssuesSummary{ total }`;

const QUERY = `query($owner:String!,$repo:String!,$number:Int!,$after:String){
  repository(owner:$owner,name:$repo){ issue(number:$number){ ${FIELDS}
    subIssues(first:${PAGE},after:$after){ pageInfo{ hasNextPage endCursor } nodes{ ${FIELDS} } } } } }`;

const Node = z.strictObject({
  number: z.int(),
  title: z.string(),
  state: z.enum(["OPEN", "CLOSED"]),
  labels: z.strictObject({ nodes: z.array(z.strictObject({ name: z.string() })) }),
  projectItems: z.strictObject({
    nodes: z.array(
      z.strictObject({
        project: z.strictObject({
          number: z.int(),
          owner: z.strictObject({ login: z.string().optional() }),
        }),
        fieldValueByName: z.strictObject({ name: z.string().optional() }).nullable(),
      }),
    ),
  }),
  closedByPullRequestsReferences: z.strictObject({
    nodes: z.array(
      z.strictObject({
        number: z.int(),
        url: z.string(),
        isDraft: z.boolean(),
        state: z.enum(["OPEN", "CLOSED", "MERGED"]),
      }),
    ),
  }),
  subIssuesSummary: z.strictObject({ total: z.int() }),
});
type Node = z.infer<typeof Node>;

const Data = z.strictObject({
  repository: z
    .strictObject({
      issue: Node.extend({
        subIssues: z.strictObject({
          pageInfo: z.strictObject({ hasNextPage: z.boolean(), endCursor: z.string().nullable() }),
          nodes: z.array(Node),
        }),
      }).nullable(),
    })
    .nullable(),
});

export interface BoardIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  type: string | null;
  /** Status on the configured Project; null when the Issue is not in it. */
  status: string | null;
  inProject: boolean;
  parent: number | null;
  depth: number;
  prs: { number: number; url: string; draft: boolean }[];
}

/** The Milestone (depth 0) and every sub-issue below it, depth-first in GitHub order. */
export function readTree(config: OmiConfig, root: number, run: GhRunner = spawnGh): BoardIssue[] {
  const { owner, repo, projectNumber } = config.github;
  const toIssue = (n: Node, parent: number | null, depth: number): BoardIssue => {
    const item = n.projectItems.nodes.find(
      (p) =>
        p.project.number === projectNumber &&
        p.project.owner.login?.toLowerCase() === owner.toLowerCase(),
    );
    return {
      number: n.number,
      title: n.title,
      state: n.state,
      type: labelType(n.labels.nodes) ?? null,
      status: item?.fieldValueByName?.name ?? null,
      inProject: Boolean(item),
      parent,
      depth,
      // includeClosedPrs:false still returns merged PRs.
      prs: n.closedByPullRequestsReferences.nodes
        .filter((p) => p.state === "OPEN")
        .map((p) => ({
          number: p.number,
          url: p.url,
          draft: p.isDraft,
        })),
    };
  };
  const page = (number: number, after: string | null) => {
    const vars = { owner, repo, number, ...(after ? { after } : {}) };
    const issue = graphql(QUERY, vars, Data, "milestone tree", run).repository?.issue;
    if (!issue) throw new OmiError("TICKET_INVALID", `issue ${owner}/${repo}#${number} not found`);
    return issue;
  };
  const children = (number: number) => {
    let issue = page(number, null);
    const head: Node = issue;
    const out = [...issue.subIssues.nodes];
    while (issue.subIssues.pageInfo.hasNextPage) {
      issue = page(number, issue.subIssues.pageInfo.endCursor);
      out.push(...issue.subIssues.nodes);
    }
    return { head, out };
  };

  const top = children(root);
  const tree: BoardIssue[] = [toIssue(top.head, null, 0)];
  const walk = (kids: Node[], parent: number, depth: number) => {
    for (const k of kids) {
      tree.push(toIssue(k, parent, depth));
      if (tree.length > MAX_ISSUES) {
        throw new OmiError("POLICY_VIOLATION", `#${root} has more than ${MAX_ISSUES} sub-issues`);
      }
      if (k.subIssuesSummary.total && depth < MAX_DEPTH) {
        walk(children(k.number).out, k.number, depth + 1);
      }
    }
  };
  walk(top.out, root, 1);
  return tree;
}
