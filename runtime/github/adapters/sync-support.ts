// GitHub reads and writes only `omi sync` needs: the PO's latest comment on an Issue (for Rework) and
// GitHub Milestones (Feature-0039 #298). Failures are classified OmiErrors; text goes through redact.
import { z } from "zod";
import type { OmiConfig } from "../../shared/config.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { api, type GhRunner, graphql, markerAuthor, spawnGh } from "../../shared/github/client.ts";
import { redact } from "../../shared/redact.ts";

const COMMENTS = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ issue(number:$number){
    comments(last:30){ nodes{ body createdAt authorAssociation author{login} } } } } }`;
const Comments = z.strictObject({
  repository: z
    .strictObject({
      issue: z
        .strictObject({
          comments: z.strictObject({
            nodes: z.array(
              z.strictObject({
                body: z.string(),
                createdAt: z.string(),
                authorAssociation: z.string(),
                author: z.strictObject({ login: z.string().optional() }).nullable(),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

const MAX_COMMENT = 2000;
/** Comments written by omi itself (reports, warnings, markers) are never the PO's words. */
const OMI_TEXT = /^\s*omi (sync|move)\b|<!--\s*omi:/i;

/**
 * The newest comment of a trusted author (owner, member, collaborator, or the identity `gh` runs
 * as) that omi did not write; null without one. Cut to 2000 characters and redacted.
 */
export function latestPoComment(
  config: OmiConfig,
  issue: number,
  run: GhRunner = spawnGh,
): { body: string; at: string } | null {
  const { owner, repo } = config.github;
  const data = graphql(COMMENTS, { owner, repo, number: issue }, Comments, "issue comments", run);
  const trusted = markerAuthor(run);
  const nodes = data.repository?.issue?.comments.nodes ?? [];
  const mine = nodes
    .filter((n) => trusted(n.authorAssociation, n.author?.login) && !OMI_TEXT.test(n.body))
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  const last = mine.at(-1);
  return last ? { body: redact(last.body).slice(0, MAX_COMMENT), at: last.createdAt } : null;
}

const Milestone = z.looseObject({ number: z.int().positive(), state: z.enum(["open", "closed"]) });
const path = (c: OmiConfig, n: number) =>
  `repos/${c.github.owner}/${c.github.repo}/milestones/${n}`;

/** Whether GitHub Milestone `n` is open (a missing Milestone is an error, never assumed). */
export function milestoneIsOpen(config: OmiConfig, n: number, run: GhRunner = spawnGh): boolean {
  const parsed = Milestone.safeParse(api(run, [path(config, n)], `milestone ${n}`));
  if (!parsed.success) {
    throw new OmiError("CONTRACT_INVALID", `milestone ${n}: unexpected response`);
  }
  return parsed.data.state === "open";
}

/** Closes GitHub Milestone `n`. */
export function closeMilestone(config: OmiConfig, n: number, run: GhRunner = spawnGh): void {
  api(run, [path(config, n), "-X", "PATCH", "-f", "state=closed"], `close milestone ${n}`);
}
