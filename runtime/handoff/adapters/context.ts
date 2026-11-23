// Issue context for a task packet (spec §6 "Issue body as living documentation", §11): the
// executable Issue body plus its parent chain, size-bounded, and the findings other tasks
// carried into it. One GraphQL call, read-only.
import { z } from "zod";
import { labelType } from "../../github/application/hierarchy.ts";
import type { OmiConfig } from "../../shared/config.ts";
import {
  AuthorAssociation,
  type CarriedFinding,
  type IssueComments,
  type IssueContextEntry,
  type IssueType,
} from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, graphql, markerAuthor, spawnGh } from "../../shared/github/client.ts";
import { redact } from "../../shared/redact.ts";
import { parseSources } from "../../shared/sources.ts";
import { cutAt } from "../../shared/text.ts";

/** Parent levels fetched above the executable Issue (Task → Feature → Milestone → Epic …). */
const DEPTH = 5;
export const PER_ISSUE_CHARS = 12_000;
export const TOTAL_CHARS = 40_000;
/** Budget of the Issues a task body lists in its `Sources` section (taken out of TOTAL_CHARS). */
export const PER_SOURCE_CHARS = 6_000;
export const SOURCES_TOTAL_CHARS = 16_000;
/** Budget of the trusted Issue comments (taken out of TOTAL_CHARS before the parent chain). */
export const COMMENTS_TOTAL_CHARS = 10_000;
export const PER_COMMENT_CHARS = 4_000;
/** Comments the agent does not need: step/cleanup reports, handoffs, carried findings. */
const OMI_NOISE = /^\s*<!--\s*omi:(?:repo|handoff|carried-findings)=/;

const NODE = "number title body repository{nameWithOwner} labels(first:20){nodes{name}}";
let parents = "";
for (let i = 0; i < DEPTH; i++) parents = `parent{${NODE} ${parents}}`;
const SOURCE_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){issue(number:$number){${NODE}}}
}`;
const QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){issue(number:$number){
    ${NODE} comments(last:100){nodes{body createdAt authorAssociation author{login}}} ${parents}
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
                createdAt: z.string(),
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

const SourceResponse = z.strictObject({
  repository: z.strictObject({ issue: z.strictObject(fields).nullable() }).nullable(),
});

interface Block {
  name: string;
  tier: number; // 0 Objective/Scope/Acceptance/DoD headings, 1 omi:section markers, 2 the rest
  text: string;
}

const OPEN = /^<!--\s*omi:section=([\w.-]+)\s*-->/;
const CLOSE = /^<!--\s*\/omi:section=[\w.-]+\s*-->/;
const KEY_HEADING = /objective|scope|acceptance|definition of done|tiêu chí/i;

/** Splits a body at `omi:section` markers and level 1–2 headings (outside marked sections). */
function blocksOf(body: string): Block[] {
  const blocks: Block[] = [];
  let cur: { name: string; tier: number; lines: string[] } = { name: "body", tier: 2, lines: [] };
  let marked = false;
  const flush = () => {
    const text = cur.lines.join("\n");
    if (text.trim()) blocks.push({ name: cur.name, tier: cur.tier, text });
  };
  for (const line of body.split("\n")) {
    const t = line.trim();
    const open = OPEN.exec(t);
    const heading = /^#{1,2}\s+(.+?)\s*#*$/.exec(t);
    if (open) {
      flush();
      cur = { name: open[1] as string, tier: 1, lines: [line] };
      marked = true;
    } else if (CLOSE.test(t) && marked) {
      cur.lines.push(line);
      flush();
      cur = { name: "body", tier: 2, lines: [] };
      marked = false;
    } else if (heading && !marked) {
      flush();
      const name = heading[1] as string;
      cur = { name, tier: KEY_HEADING.test(name) ? 0 : 2, lines: [line] };
    } else cur.lines.push(line);
  }
  flush();
  return blocks;
}

/**
 * Fits `body` into `max` chars. Over budget: key headings first, then `omi:section` sections, then
 * the rest, each in document order; the block that crosses the budget is head-cut. Kept blocks stay
 * in document order; what was dropped or cut is named with its lost size.
 */
export function fitBody(
  body: string,
  max: number,
): { body: string; omitted: { section: string; chars: number }[] } {
  if (body.length <= max) return { body, omitted: [] };
  const blocks = blocksOf(body);
  const kept = new Map<Block, number>();
  let left = max;
  for (const tier of [0, 1, 2]) {
    for (const b of blocks) {
      if (b.tier !== tier || left <= 0) continue;
      const take = Math.min(b.text.length, left);
      kept.set(b, take);
      left -= take + 1; // + joining newline
    }
  }
  const text = cutAt(
    blocks
      .filter((b) => kept.has(b))
      .map((b) => cutAt(b.text, kept.get(b) ?? 0))
      .join("\n"),
    max,
  );
  const omitted = blocks
    .map((b) => ({ section: b.name, chars: b.text.length - (kept.get(b) ?? 0) }))
    .filter((o) => o.chars > 0);
  return { body: text, omitted };
}

const typeOf = (n: Node): IssueType | null => labelType(n.labels.nodes) ?? null;

const SEPARATOR = /^\|(\s*:?-+:?\s*\|)+\s*$/;
const cut = (s: string, max: number) => (s.length > max ? `${cutAt(s, max - 1)}…` : s);

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
  issueComments: IssueComments;
}

/**
 * Trusted comments of the Issue, newest first, redacted, within COMMENTS_TOTAL_CHARS. Reports,
 * handoffs and carried findings are not comments an agent needs; a comment that does not fit
 * the budget is counted in `omittedCount`.
 */
export function selectComments(
  nodes: {
    body: string;
    createdAt: string;
    authorAssociation: AuthorAssociation;
    author: { login: string } | null;
  }[],
  trusted: (association: AuthorAssociation, login: string | undefined) => boolean,
): IssueComments {
  const kept = nodes
    .filter((c) => trusted(c.authorAssociation, c.author?.login))
    .filter((c) => !OMI_NOISE.test(c.body) && !/omi:carried-findings=/.test(c.body))
    .map((c) => ({ ...c, text: redact(c.body).trim() }))
    .filter((c) => c.text)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const comments: IssueComments["comments"] = [];
  let room = COMMENTS_TOTAL_CHARS;
  let omittedCount = 0;
  for (const c of kept) {
    const body = cutAt(c.text, PER_COMMENT_CHARS);
    if (body.length > room) {
      omittedCount++;
      continue;
    }
    room -= body.length;
    comments.push({
      author: c.author?.login ?? "ghost",
      createdAt: c.createdAt,
      body,
      truncated: body.length < c.text.length,
    });
  }
  return { comments, omittedCount };
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

  const entry = (n: Node | z.infer<z.ZodObject<typeof fields>>, perIssue: number, room: number) => {
    const body = redact(n.body);
    const keep = Math.min(body.length, perIssue, room);
    const fit = fitBody(body, keep);
    return {
      keep: fit.body.length,
      entry: {
        issue: { repository: n.repository.nameWithOwner, number: n.number },
        type: typeOf(n as Node),
        title: cut(redact(n.title), 300),
        body: fit.body,
        truncated: keep < body.length,
        ...(fit.omitted.length ? { omitted: fit.omitted } : {}),
      } satisfies IssueContextEntry,
    };
  };

  // Issues the task body lists in `Sources` (outside the parent chain), read first so their
  // share of the budget is reserved before the chain fills it.
  const chain = new Set<string>();
  for (let n: Node | null | undefined = issue; n; n = n.parent) {
    chain.add(`${n.repository.nameWithOwner.toLowerCase()}#${n.number}`);
  }
  const sources: IssueContextEntry[] = [];
  let sourceRoom = SOURCES_TOTAL_CHARS;
  for (const ref of parseSources(redact(issue.body), issue.repository.nameWithOwner)) {
    if (sourceRoom <= 0) break;
    if (chain.has(`${ref.repository.toLowerCase()}#${ref.number}`)) continue;
    const [o, r] = ref.repository.split("/") as [string, string];
    // The body is untrusted: never read a repository outside the configured owner.
    if (o.toLowerCase() !== owner.toLowerCase()) continue;
    try {
      const found = graphql(
        SOURCE_QUERY,
        { owner: o, repo: r, number: ref.number },
        SourceResponse,
        "source issue",
        run,
      ).repository?.issue;
      if (!found) continue;
      const made = entry(found, PER_SOURCE_CHARS, sourceRoom);
      sourceRoom -= made.keep;
      sources.push(made.entry);
    } catch (e) {
      if (!(e instanceof OmiError)) throw e; // unreadable source: the packet goes without it
    }
  }

  const issueContext: IssueContextEntry[] = [];
  const issueComments = selectComments(issue.comments.nodes, trusted);
  const commentChars = issueComments.comments.reduce((n, c) => n + c.body.length, 0);
  let budget = TOTAL_CHARS - sources.reduce((n, s) => n + s.body.length, 0) - commentChars;
  for (let n: Node | null | undefined = issue; n && budget > 0; n = n.parent) {
    const made = entry(n, PER_ISSUE_CHARS, budget);
    budget -= made.keep;
    issueContext.push(made.entry);
  }
  issueContext.push(...sources);
  return {
    issueContext,
    issueComments,
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
