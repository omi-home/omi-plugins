// Writes of `omi move` / `omi close` under model v2: Project Status (option IDs read from GitHub),
// Issue open/closed and Issue comments (Feature-0039 #298). `omi` is the only writer of the Project.
import { z } from "zod";
import type { OmiConfig } from "../../shared/config.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "../../shared/github/client.ts";
import { redact } from "../../shared/redact.ts";
import type { ItemWrite } from "../domain/move-plan.ts";
import { type At, projectItem, setItemStatus, statusField } from "./project.ts";

const ID_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ issue(number:$number){ id } } }`;
const IdData = z.strictObject({
  repository: z.strictObject({ issue: z.strictObject({ id: z.string() }).nullable() }).nullable(),
});

const CLOSE = (reason: "COMPLETED" | "NOT_PLANNED") =>
  `mutation($id:ID!){ closeIssue(input:{issueId:$id,stateReason:${reason}}){ issue{ id } } }`;
const REOPEN = "mutation($id:ID!){ reopenIssue(input:{issueId:$id}){ issue{ id } } }";
const COMMENT =
  "mutation($id:ID!,$body:String!){ addComment(input:{subjectId:$id,body:$body}){ clientMutationId } }";

const issueId = (config: OmiConfig, number: number, run: GhRunner): string => {
  const { owner, repo } = config.github;
  const id = graphql(ID_QUERY, { owner, repo, number }, IdData, "issue id", run).repository?.issue
    ?.id;
  if (!id) throw new OmiError("TICKET_INVALID", `Issue #${number} not found in ${owner}/${repo}`);
  return id;
};

const here = (config: OmiConfig, number: number): At => ({
  owner: config.github.owner,
  repo: config.github.repo,
  number,
});

/** Closes Issue `n` (completed or not planned). */
export function closeIssueAs(
  config: OmiConfig,
  n: number,
  reason: "completed" | "not_planned",
  run: GhRunner = spawnGh,
): void {
  const id = issueId(config, n, run);
  graphql(
    CLOSE(reason === "completed" ? "COMPLETED" : "NOT_PLANNED"),
    { id },
    z.unknown(),
    "close issue",
    run,
  );
}

/** Comments on Issue `n`; the text goes through redact. */
export function commentOn(config: OmiConfig, n: number, body: string, run: GhRunner = spawnGh) {
  const id = issueId(config, n, run);
  graphql(COMMENT, { id, body: redact(body) }, z.unknown(), "issue comment", run, true);
}

/**
 * Brings each item to its status (read → diff → write: a status already shown is not written) and
 * open/closed state, in order. Every Status option is resolved before the first write. `done` is called
 * after each item is written, so the caller can record exactly what changed even when a later one fails.
 */
export function applyWrites(
  config: OmiConfig,
  writes: readonly ItemWrite[],
  done: (w: ItemWrite) => void,
  run: GhRunner = spawnGh,
): void {
  if (!writes.length) return;
  const field = statusField(config, run);
  for (const w of writes) field.option(w.to);
  for (const w of writes) {
    const { item, from } = projectItem(config, here(config, w.issue), run);
    if (!item) {
      throw new OmiError(
        "TICKET_NOT_IN_PROJECT",
        `#${w.issue} is not in Project #${config.github.projectNumber}`,
      );
    }
    if (from !== w.to) setItemStatus(field, item.id, w.to, run);
    if (w.stateChange) {
      const id = issueId(config, w.issue, run);
      graphql(
        w.stateChange === "close" ? CLOSE("COMPLETED") : REOPEN,
        { id },
        z.unknown(),
        w.stateChange === "close" ? "close issue" : "reopen issue",
        run,
      );
    }
    done(w);
  }
}
