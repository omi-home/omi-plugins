// Issue context for a task packet (spec §6 "Issue body as living documentation", §11): the
// executable Issue body plus its parent chain, size-bounded, and the findings other tasks
// carried into it. One GraphQL call, read-only.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import { type CarriedFinding, type IssueContextEntry, IssueType } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { redact } from "../../reporting/redact.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";

/** Parent levels fetched above the executable Issue (Task → Feature → Milestone → Epic …). */
const DEPTH = 5;
// ponytail: plain head truncation, nearest Issue first; pick `<!-- omi:section=… -->` sections
// when ancestor specs crowd out the useful parts.
export const PER_ISSUE_CHARS = 12_000;
export const TOTAL_CHARS = 40_000;

const NODE = "number title body repository{nameWithOwner} labels(first:20){nodes{name}}";
let parents = "";
for (let i = 0; i < DEPTH; i++) parents = `parent{${NODE} ${parents}}`;
const QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){issue(number:$number){
    ${NODE} comments(last:100){nodes{body}} ${parents}
  }}
}`;

const fields = {
  number: z.int().positive(),
  title: z.string(),
  body: z.string(),
  repository: z.strictObject({ nameWithOwner: z.string() }),
  labels: z.strictObject({ nodes: z.array(z.strictObject({ name: z.string() })) }),
};
interface Node extends z.infer<z.ZodObject<typeof fields>> {
  parent?: Node | null;
}
const Node: z.ZodType<Node> = z.strictObject({
  ...fields,
  get parent() {
    return Node.nullable().optional(); // absent on the deepest level queried
  },
});
const Response = z.strictObject({
  repository: z
    .strictObject({
      issue: z
        .strictObject({
          ...fields,
          comments: z.strictObject({ nodes: z.array(z.strictObject({ body: z.string() })) }),
          parent: Node.nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

const typeOf = (n: Node): IssueType | null => {
  const types = n.labels.nodes.map((l) => /^type:(.+)$/.exec(l.name)?.[1]).filter(Boolean);
  return (types.length === 1 && IssueType.safeParse(types[0]).data) || null;
};

const SEPARATOR = /^\|(\s*:?-+:?\s*\|)+\s*$/;
const cut = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Rows of the `source | finding | action` tables in `omi:carried-findings` comments. */
export function parseCarriedFindings(comments: string[]): CarriedFinding[] {
  const out: CarriedFinding[] = [];
  for (const body of comments) {
    if (!/<!--\s*omi:carried-findings=/.test(body)) continue;
    const rows = body
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("|"));
    rows.forEach((line, i) => {
      if (SEPARATOR.test(line) || SEPARATOR.test(rows[i + 1] ?? "")) return; // separator / header
      // ponytail: escaped `\|` inside a cell splits it; nobody writes one in these tables yet.
      const cells = line
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim());
      const [source, finding, ...action] = cells;
      if (!source || !finding || !action.join("")) return;
      out.push({
        source: cut(redact(source), 500),
        finding: cut(redact(finding), 2000),
        action: cut(redact(action.join(" | ")), 2000),
      });
    });
  }
  return out;
}

export interface IssueContext {
  issueContext: IssueContextEntry[];
  carriedFindings: CarriedFinding[];
}

export function fetchIssueContext(
  config: OmiConfig,
  number: number,
  run: GhRunner = spawnGh,
): IssueContext {
  const { owner, repo } = config.github;
  const data = graphql(QUERY, { owner, repo, number }, Response, "issue context", run);
  const issue = data.repository?.issue;
  if (!issue) throw new OmiError("TICKET_INVALID", `issue ${owner}/${repo}#${number} not found`);

  const issueContext: IssueContextEntry[] = [];
  let budget = TOTAL_CHARS;
  for (let n: Node | null | undefined = issue; n && budget > 0; n = n.parent) {
    const body = redact(n.body);
    const keep = Math.min(body.length, PER_ISSUE_CHARS, budget);
    budget -= keep;
    issueContext.push({
      issue: { repository: n.repository.nameWithOwner, number: n.number },
      type: typeOf(n),
      title: cut(redact(n.title), 300),
      body: body.slice(0, keep),
      truncated: keep < body.length,
    });
  }
  return {
    issueContext,
    carriedFindings: parseCarriedFindings(issue.comments.nodes.map((c) => c.body)),
  };
}
