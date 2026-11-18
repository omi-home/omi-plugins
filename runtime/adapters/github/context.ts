// Issue context for a task packet (spec §6 "Issue body as living documentation", §11): the
// executable Issue body plus its parent chain, size-bounded, and the findings other tasks
// carried into it. One GraphQL call, read-only.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import {
  AuthorAssociation,
  type CarriedFinding,
  type IssueContextEntry,
  type IssueType,
} from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { labelType } from "../../core/hierarchy.ts";
import { redact } from "../../reporting/redact.ts";
import { type GhRunner, graphql, markerAuthor, spawnGh } from "./client.ts";

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
    ${NODE} comments(last:100){nodes{body authorAssociation author{login}}} ${parents}
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
          comments: z.strictObject({
            nodes: z.array(
              z.strictObject({
                body: z.string(),
                authorAssociation: AuthorAssociation,
                author: z.strictObject({ login: z.string() }).nullable(),
              }),
            ),
          }),
          parent: Node.nullable(),
        })
        .nullable(),
    })
    .nullable(),
});

const typeOf = (n: Node): IssueType | null => labelType(n.labels.nodes) ?? null;

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
      // `\|` is a literal pipe inside a cell (renderCarriedFindings escapes them).
      const cells = line
        .replace(/^\||(?<!\\)\|$/g, "")
        .split(/(?<!\\)\|/)
        .map((c) => c.trim().replaceAll("\\|", "|"));
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
  const trusted = markerAuthor(run);
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
    carriedFindings: parseCarriedFindings(
      issue.comments.nodes
        .filter((c) => /omi:carried-findings=/.test(c.body))
        .filter((c) => trusted(c.authorAssociation, c.author?.login))
        .map((c) => c.body),
    ),
  };
}

/**
 * Replaces the body of `<!-- omi:section=<name> -->…<!-- /omi:section=<name> -->`, or appends the
 * section when the body has none. Pure; the markers are the only structure it relies on.
 */
const markers = (name: string): [string, string] => [
  `<!-- omi:section=${name} -->`,
  `<!-- /omi:section=${name} -->`,
];

/** Text of `<!-- omi:section=<name> -->…<!-- /omi:section=<name> -->`; null when absent. */
export function sectionOf(body: string, name: string): string | null {
  const [open, close] = markers(name);
  const start = body.indexOf(open);
  const end = start < 0 ? -1 : body.indexOf(close, start);
  return end < 0 ? null : body.slice(start + open.length, end).trim();
}

export function upsertSection(body: string, name: string, markdown: string): string {
  const [open, close] = markers(name);
  const block = `${open}\n${markdown.trim()}\n${close}`;
  const start = body.indexOf(open);
  const end = start < 0 ? -1 : body.indexOf(close, start);
  if (start >= 0 && end >= 0) return body.slice(0, start) + block + body.slice(end + close.length);
  return `${body.trimEnd()}\n\n${block}\n`;
}

const BodyData = z.strictObject({
  repository: z.strictObject({
    issue: z.strictObject({ id: z.string(), body: z.string() }).nullable(),
  }),
});

function readBody(config: OmiConfig, issue: number, run: GhRunner) {
  const { owner, repo } = config.github;
  const found = graphql(
    "query($owner:String!,$repo:String!,$number:Int!){repository(owner:$owner,name:$repo){issue(number:$number){id body}}}",
    { owner, repo, number: issue },
    BodyData,
    "issue body",
    run,
  ).repository.issue;
  if (!found) throw new OmiError("TICKET_INVALID", `issue ${owner}/${repo}#${issue} not found`);
  return found;
}

/** `omi issue section get`: one section of the Issue body. */
export function readSection(
  config: OmiConfig,
  issue: number,
  name: string,
  run: GhRunner = spawnGh,
): string {
  const s = sectionOf(readBody(config, issue, run).body, name);
  if (s === null) throw new OmiError("TICKET_INVALID", `#${issue} has no section ${name}`);
  return s;
}

/** Writes one agent-proposed section into the Issue body (spec §6); the text is redacted first. */
export function writeSection(
  config: OmiConfig,
  issue: number,
  section: string,
  markdown: string,
  run: GhRunner = spawnGh,
): void {
  const found = readBody(config, issue, run);
  graphql(
    "mutation($id:ID!,$body:String!){updateIssue(input:{id:$id,body:$body}){issue{id}}}",
    { id: found.id, body: upsertSection(found.body, section, redact(markdown)) },
    z.unknown(),
    "update issue body",
    run,
    true,
  );
}
