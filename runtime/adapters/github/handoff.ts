// `omi handoff show|post` (DevTask-0049 #144): the session handoff is a GitHub comment that opens
// with `<!-- omi:handoff=<date>-s<N> -->` on the active Milestone (ADR-0001 D7), so a new session
// resumes from GitHub instead of local memory.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import { type ProjectStatus, parseContract } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { api } from "../../reporting/outbox.ts";
import { redact } from "../../reporting/redact.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";

const MARKER = /^<!-- omi:handoff=([\w.-]+) -->/;
/** Handoff-holding Issues read per `show`; comments read per Issue. */
const ISSUES = 10;

export interface Handoff {
  marker: string;
  issue: number;
  title: string;
  url: string;
  createdAt: string;
  body: string;
}

const SEARCH = `query($q:String!){ search(query:$q,type:ISSUE,first:${ISSUES}){ nodes{ ... on Issue{
  number title comments(last:100){ nodes{ url body createdAt } } } } } }`;

const SearchData = z.strictObject({
  search: z.strictObject({
    nodes: z.array(
      z.union([
        z.strictObject({
          number: z.int(),
          title: z.string(),
          comments: z.strictObject({
            nodes: z.array(
              z.strictObject({ url: z.string(), body: z.string(), createdAt: z.string() }),
            ),
          }),
        }),
        z.strictObject({}), // a pull request matched: no Issue fields
      ]),
    ),
  }),
});

/**
 * Every handoff comment GitHub search finds in the repository, newest first.
 * ponytail: search indexes new comments with a short lag; `post` checks its target directly, but a
 * handoff posted on another Milestone minutes earlier can be missed (same session number twice).
 */
export function listHandoffs(config: OmiConfig, run: GhRunner = spawnGh): Handoff[] {
  const { owner, repo } = config.github;
  // Handoffs live on Milestones; the label keeps task Issues that quote the marker out of the slots.
  const q = `repo:${owner}/${repo} label:type:milestone "omi:handoff" in:comments sort:updated-desc`;
  const found: Handoff[] = [];
  for (const n of graphql(SEARCH, { q }, SearchData, "search handoffs", run).search.nodes) {
    if (!("number" in n)) continue;
    for (const c of n.comments.nodes) {
      const m = MARKER.exec(c.body);
      if (m) found.push({ marker: m[1] as string, issue: n.number, title: n.title, ...c });
    }
  }
  return found.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const ACTIVE = `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){
  issues(first:50,states:OPEN,labels:["type:milestone"]){ nodes{ number
    projectItems(first:20){ nodes{ project{ number owner{... on Organization{login} ... on User{login}} }
      fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}} } } } } } }`;

const ActiveData = z.strictObject({
  repository: z.strictObject({
    issues: z.strictObject({
      nodes: z.array(
        z.strictObject({
          number: z.int(),
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
        }),
      ),
    }),
  }),
});

const ACTIVE_STATUSES: readonly string[] = ["In Progress", "In Review"] satisfies ProjectStatus[];

/** The one open Milestone whose Project Status is In Progress or In Review. */
export function activeMilestone(config: OmiConfig, run: GhRunner = spawnGh): number {
  const { owner, repo, projectNumber } = config.github;
  const nodes = graphql(ACTIVE, { owner, repo }, ActiveData, "active milestone", run).repository
    .issues.nodes;
  const active = nodes.filter((i) =>
    i.projectItems.nodes.some(
      (p) =>
        p.project.number === projectNumber &&
        p.project.owner.login?.toLowerCase() === owner.toLowerCase() &&
        ACTIVE_STATUSES.includes(p.fieldValueByName?.name ?? ""),
    ),
  );
  if (active.length !== 1) {
    throw new OmiError(
      "USAGE_INVALID",
      `${active.length ? `several active Milestones (${active.map((i) => `#${i.number}`).join(", ")})` : "no Milestone is In Progress or In Review"}: pass --milestone <n>`,
    );
  }
  return (active[0] as { number: number }).number;
}

const Comment = z.looseObject({
  id: z.int().positive(),
  html_url: z.string(),
  body: z.string(),
});

export interface PostResult {
  marker: string;
  issue: number;
  url: string;
  /** created, updated (same marker, new text) or unchanged (no write). */
  action: "created" | "updated" | "unchanged";
}

/** The handoff text without its marker line. */
export const strip = (body: string) => body.replace(MARKER, "").trim();

/**
 * Posts `text` as the handoff on `issue` (default: the active Milestone). A text that opens with
 * its own marker updates that comment; otherwise the marker is `<today>-s<last session + 1>`, and
 * a handoff with the same text already on the Issue is returned unchanged (re-run safe).
 */
export function postHandoff(
  config: OmiConfig,
  raw: string,
  o: { issue?: number; now?: Date; run?: GhRunner } = {},
): PostResult {
  const run = o.run ?? spawnGh;
  const text = raw.replace(/^\uFEFF/, "").trimStart(); // BOM / blank lines before the marker
  const { owner, repo } = config.github;
  const issue = o.issue ?? activeMilestone(config, run);
  const base = `repos/${owner}/${repo}/issues`;
  const pages = api(
    run,
    ["--paginate", "--slurp", `${base}/${issue}/comments?per_page=100`],
    "list comments",
  );
  const mine = parseContract(z.array(z.array(Comment)), pages, "list comments")
    .flat()
    .filter((c) => MARKER.test(c.body));
  const content = redact(strip(text));
  if (!content) throw new OmiError("USAGE_INVALID", "the handoff text is empty");

  let marker = MARKER.exec(text)?.[1];
  const existing = marker
    ? mine.find((c) => MARKER.exec(c.body)?.[1] === marker)
    : mine.find((c) => strip(c.body) === content);
  if (marker && !existing) {
    const elsewhere = listHandoffs(config, run).find(
      (h) => h.marker === marker && h.issue !== issue,
    );
    if (elsewhere) {
      throw new OmiError(
        "USAGE_INVALID",
        `handoff ${marker} is on #${elsewhere.issue}: pass --milestone ${elsewhere.issue} to update it`,
      );
    }
  }
  if (!marker) {
    if (existing) {
      const m = MARKER.exec(existing.body)?.[1] as string;
      return { marker: m, issue, url: existing.html_url, action: "unchanged" };
    }
    const seen = [
      ...mine.map((c) => MARKER.exec(c.body)?.[1] ?? ""),
      ...listHandoffs(config, run).map((h) => h.marker),
    ];
    const last = Math.max(0, ...seen.map((m) => Number(/-s(\d+)/.exec(m)?.[1] ?? 0)));
    marker = `${(o.now ?? new Date()).toLocaleDateString("sv-SE")}-s${last + 1}`;
  }
  const body = `<!-- omi:handoff=${marker} -->\n${content}\n`;
  if (existing && existing.body === body) {
    return { marker, issue, url: existing.html_url, action: "unchanged" };
  }
  const [method, url] = existing
    ? ["PATCH", `${base}/comments/${existing.id}`]
    : ["POST", `${base}/${issue}/comments`];
  const out = api(
    run,
    ["-X", method, url, "--input", "-"],
    `${method} handoff`,
    JSON.stringify({ body }),
  );
  const c = parseContract(Comment, out, `${method} handoff`);
  return { marker, issue, url: c.html_url, action: existing ? "updated" : "created" };
}
