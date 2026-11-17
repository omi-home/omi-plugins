// Project Status sync (spec §6, §16): read → diff → write; only ever moves an item forward
// from Backlog/Ready, and rolls the same move up the native parent chain so a parent never
// shows less progress than its children. Built-in Project automation does not do this.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import type { ProjectStatus } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";

const OWNER_PROJECT = (body: string) =>
  `repositoryOwner(login:$owner){ ... on Organization{projectV2(number:$number){${body}}} ... on User{projectV2(number:$number){${body}}} }`;

const FIELD_QUERY = `query($owner:String!,$number:Int!){ ${OWNER_PROJECT(
  'id field(name:"Status"){ ... on ProjectV2SingleSelectField{id options{id name}} }',
)} }`;

const FieldData = z.strictObject({
  repositoryOwner: z
    .strictObject({
      projectV2: z
        .strictObject({
          id: z.string(),
          field: z
            .strictObject({
              id: z.string().optional(),
              options: z.array(z.strictObject({ id: z.string(), name: z.string() })).optional(),
            })
            .nullable(),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
});

const ITEM_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ issue(number:$number){
    number
    parent{ number repository{ name owner{login} } }
    projectItems(first:50,includeArchived:false){ nodes{ id
      project{ number owner{... on Organization{login} ... on User{login}} }
      fieldValueByName(name:"Status"){... on ProjectV2ItemFieldSingleSelectValue{name}} } }
  } }
}`;

const ItemData = z.strictObject({
  repository: z
    .strictObject({
      issue: z
        .strictObject({
          number: z.int(),
          parent: z
            .strictObject({
              number: z.int(),
              repository: z.strictObject({
                name: z.string(),
                owner: z.strictObject({ login: z.string() }),
              }),
            })
            .nullable(),
          projectItems: z.strictObject({
            nodes: z.array(
              z.strictObject({
                id: z.string(),
                project: z.strictObject({
                  number: z.int(),
                  owner: z.strictObject({ login: z.string().optional() }),
                }),
                fieldValueByName: z.strictObject({ name: z.string().optional() }).nullable(),
              }),
            ),
          }),
        })
        .nullable(),
    })
    .nullable(),
});

const MUTATION = `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){
  updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){ projectV2Item{id} }
}`;

export interface StatusChange {
  issue: string;
  from: string | null;
  to: ProjectStatus;
}

/** Statuses a start may advance from; anything later is never regressed. */
const BEFORE_START: readonly string[] = ["Backlog", "Ready"] satisfies ProjectStatus[];
const MAX_DEPTH = 8; // GitHub's sub-issue nesting limit

interface StatusField {
  projectId: string;
  fieldId: string;
  option: (name: ProjectStatus) => string;
}

function statusField(config: OmiConfig, run: GhRunner): StatusField {
  const { owner, projectNumber } = config.github;
  const proj = graphql(
    FIELD_QUERY,
    { owner, number: projectNumber },
    FieldData,
    "project fields",
    run,
  ).repositoryOwner?.projectV2;
  const fieldId = proj?.field?.id;
  if (!proj || !fieldId) {
    throw new OmiError("CONFIG_INVALID", `Project #${projectNumber} has no single-select Status`);
  }
  return {
    projectId: proj.id,
    fieldId,
    option: (name) => {
      const o = proj.field?.options?.find((x) => x.name === name);
      if (!o) {
        throw new OmiError(
          "CONFIG_INVALID",
          `Project #${projectNumber} has no Status option '${name}'`,
        );
      }
      return o.id;
    },
  };
}

type At = { owner: string; repo: string; number: number };

function projectItem(config: OmiConfig, at: At, run: GhRunner) {
  const { owner, projectNumber } = config.github;
  const found = graphql(ITEM_QUERY, at, ItemData, "project item", run).repository?.issue;
  const item = found?.projectItems.nodes.find(
    (n) => n.project.number === projectNumber && n.project.owner.login === owner,
  );
  const parent: At | null = found?.parent
    ? {
        owner: found.parent.repository.owner.login,
        repo: found.parent.repository.name,
        number: found.parent.number,
      }
    : null;
  return { item, from: item?.fieldValueByName?.name ?? null, parent };
}

const write = (f: StatusField, itemId: string, to: ProjectStatus, run: GhRunner) =>
  graphql(
    MUTATION,
    { p: f.projectId, i: itemId, f: f.fieldId, o: f.option(to) },
    z.unknown(),
    "status update",
    run,
  );

/**
 * Moves `issue` and every ancestor in the configured Project from Backlog/Ready (or unset) to
 * `In Progress`. Returns the changes made; a second call is a no-op.
 */
export function markStarted(
  config: OmiConfig,
  issue: number,
  run: GhRunner = spawnGh,
): StatusChange[] {
  const field = statusField(config, run);
  const target: ProjectStatus = "In Progress";
  field.option(target); // fail before any write when the option is missing
  const changes: StatusChange[] = [];
  let at: At | null = { owner: config.github.owner, repo: config.github.repo, number: issue };
  for (let depth = 0; at && depth < MAX_DEPTH; depth++) {
    const { item, from, parent } = projectItem(config, at, run);
    if (item && (from === null || BEFORE_START.includes(from))) {
      write(field, item.id, target, run);
      changes.push({ issue: `${at.owner}/${at.repo}#${at.number}`, from, to: target });
    }
    at = parent;
  }
  return changes;
}

/**
 * Sets one executable Issue's Status to the projection of its workflow state (PROJECT_STATUS).
 * Read → diff → write: returns null when it already shows `to`.
 */
export function setStatus(
  config: OmiConfig,
  issue: number,
  to: ProjectStatus,
  run: GhRunner = spawnGh,
): StatusChange | null {
  const field = statusField(config, run);
  const at: At = { owner: config.github.owner, repo: config.github.repo, number: issue };
  const { item, from } = projectItem(config, at, run);
  if (!item) {
    throw new OmiError(
      "TICKET_NOT_IN_PROJECT",
      `${at.owner}/${at.repo}#${issue} is not in Project #${config.github.projectNumber}`,
    );
  }
  if (from === to) return null;
  write(field, item.id, to, run);
  return { issue: `${at.owner}/${at.repo}#${issue}`, from, to };
}

const PARENT_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  repository(owner:$owner,name:$repo){ issue(number:$number){
    id state labels(first:30){nodes{name}} subIssuesSummary{total completed}
  } }
}`;

const ParentData = z.strictObject({
  repository: z
    .strictObject({
      issue: z
        .strictObject({
          id: z.string(),
          state: z.enum(["OPEN", "CLOSED"]),
          labels: z.strictObject({ nodes: z.array(z.strictObject({ name: z.string() })) }),
          subIssuesSummary: z.strictObject({ total: z.int(), completed: z.int() }),
        })
        .nullable(),
    })
    .nullable(),
});

const CLOSE = `mutation($id:ID!){closeIssue(input:{issueId:$id,stateReason:COMPLETED}){issue{id}}}`;

export interface FinishChange extends StatusChange {
  closed: boolean;
}

/**
 * After merge + verified cleanup (spec §8 gate 7, AGENTS.md rule 6): the task → Done, then up
 * the native parent chain while every sub-issue of a parent is closed: a Feature (or any
 * non-Milestone container) is closed and set Done; a Milestone only goes to In Review, since
 * Done needs the PO's acceptance of its gate. Stops at the first parent with open children.
 * Read → diff → write: a second call changes nothing.
 */
export function markFinished(
  config: OmiConfig,
  issue: number,
  run: GhRunner = spawnGh,
): FinishChange[] {
  const field = statusField(config, run);
  field.option("Done");
  field.option("In Review");
  const changes: FinishChange[] = [];
  const done = setStatus(config, issue, "Done", run);
  if (done) changes.push({ ...done, closed: false });
  let at = projectItem(
    config,
    { owner: config.github.owner, repo: config.github.repo, number: issue },
    run,
  ).parent;
  for (let depth = 0; at && depth < MAX_DEPTH; depth++) {
    const info = graphql(PARENT_QUERY, at, ParentData, "parent issue", run).repository?.issue;
    if (!info || info.subIssuesSummary.completed < info.subIssuesSummary.total) break;
    const milestone = info.labels.nodes.some((l) => l.name === "type:milestone");
    const to: ProjectStatus = milestone ? "In Review" : "Done";
    const { item, from, parent } = projectItem(config, at, run);
    const close = !milestone && info.state === "OPEN";
    if (close) graphql(CLOSE, { id: info.id }, z.unknown(), "close issue", run);
    const move = item && from !== to && from !== "Done";
    if (move) write(field, item.id, to, run);
    if (close || move) {
      changes.push({ issue: `${at.owner}/${at.repo}#${at.number}`, from, to, closed: close });
    }
    if (milestone) break; // the PO accepts a Milestone; nothing above rolls up automatically
    at = parent;
  }
  return changes;
}
