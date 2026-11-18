// `omi project plan|apply` (DevTask-0030 #62): diff the Project's custom fields against
// config/github/project.yaml and report items whose Status breaks their type's lifecycle
// (config/github/status-transitions.yaml). Apply only adds; IDs are read, never configured.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import { ProjectStatus } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { labelType } from "../../core/hierarchy.ts";
import {
  type ActualField,
  allowedStatuses,
  type FieldAction,
  type FieldPlan,
  type GhOption,
  loadProjectConfig,
  type ProjectConfig,
  planFields,
} from "../../core/project-config.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";
import { OWNER_PROJECT } from "./project.ts";

const FIELDS = `query($owner:String!,$number:Int!){ ${OWNER_PROJECT(`id viewerCanUpdate
  fields(first:50){ nodes{ __typename
    ... on ProjectV2FieldCommon{ id name dataType }
    ... on ProjectV2SingleSelectField{ options{ id name color description } }
    ... on ProjectV2IterationField{ configuration{ duration } } } }`)} }`;

const ProjectFields = z.strictObject({
  repositoryOwner: z
    .strictObject({
      projectV2: z
        .strictObject({
          id: z.string(),
          viewerCanUpdate: z.boolean(),
          fields: z.strictObject({
            nodes: z.array(
              z.strictObject({
                __typename: z.string(),
                id: z.string(),
                name: z.string(),
                dataType: z.string(),
                options: z
                  .array(
                    z.strictObject({
                      id: z.string(),
                      name: z.string(),
                      color: z.string(),
                      description: z.string(),
                    }),
                  )
                  .optional(),
                configuration: z.strictObject({ duration: z.int() }).optional(),
              }),
            ),
          }),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
});

const ITEMS = `query($owner:String!,$number:Int!,$after:String){ ${OWNER_PROJECT(`items(first:100,after:$after){
  pageInfo{ hasNextPage endCursor }
  nodes{ content{ __typename ... on Issue{ number repository{ nameWithOwner } labels(first:30){ nodes{ name } } } }
    fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } }`)} }`;

const ProjectItems = z.strictObject({
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
                content: z
                  .strictObject({
                    __typename: z.string(),
                    number: z.int().optional(),
                    repository: z.strictObject({ nameWithOwner: z.string() }).optional(),
                    labels: z
                      .strictObject({ nodes: z.array(z.strictObject({ name: z.string() })) })
                      .optional(),
                  })
                  .nullable(),
                fieldValueByName: z.strictObject({ name: z.string().optional() }).nullable(),
              }),
            ),
          }),
        })
        .nullable()
        .optional(),
    })
    .nullable(),
});

const CREATE_FIELD = `mutation($p:ID!,$t:ProjectV2CustomFieldType!,$n:String!,$o:[ProjectV2SingleSelectFieldOptionInput!]){
  createProjectV2Field(input:{projectId:$p,dataType:$t,name:$n,singleSelectOptions:$o}){ projectV2Field{ ... on ProjectV2FieldCommon{ id } } } }`;
const UPDATE_OPTIONS = `mutation($f:ID!,$o:[ProjectV2SingleSelectFieldOptionInput!]!){
  updateProjectV2Field(input:{fieldId:$f,singleSelectOptions:$o}){ projectV2Field{ ... on ProjectV2FieldCommon{ id } } } }`;

/** An item whose Status its type may not show (or that has none). */
export interface StatusDrift {
  issue: string;
  type: string | null;
  status: string | null;
  reason: string;
}

export interface ProjectPlan extends FieldPlan {
  drift: StatusDrift[];
}

function readFields(c: OmiConfig, run: GhRunner) {
  const { owner, projectNumber } = c.github;
  const p = graphql(FIELDS, { owner, number: projectNumber }, ProjectFields, "project fields", run)
    .repositoryOwner?.projectV2;
  if (!p) throw new OmiError("CONFIG_INVALID", `Project #${projectNumber} not found for ${owner}`);
  const fields: ActualField[] = p.fields.nodes.map((f) => ({
    id: f.id,
    name: f.name,
    dataType: f.dataType,
    options: f.options,
    duration: f.configuration?.duration,
  }));
  return { projectId: p.id, canUpdate: p.viewerCanUpdate, fields };
}

/** Items of the Project whose Status is unset, unknown, or outside their type's lifecycle. */
export function statusDrift(c: OmiConfig, run: GhRunner = spawnGh): StatusDrift[] {
  const { owner, projectNumber } = c.github;
  const drift: StatusDrift[] = [];
  let after: string | null = null;
  do {
    const vars: Record<string, unknown> = { owner, number: projectNumber };
    if (after) vars.after = after;
    const page = graphql(ITEMS, vars, ProjectItems, "project items", run).repositoryOwner?.projectV2
      ?.items;
    if (!page) break;
    for (const n of page.nodes) {
      const i = n.content;
      if (i?.__typename !== "Issue" || !i.number || !i.repository) continue;
      const issue = `${i.repository.nameWithOwner}#${i.number}`;
      const type = labelType(i.labels?.nodes ?? []) ?? null;
      const raw = n.fieldValueByName?.name ?? null;
      const status = ProjectStatus.safeParse(raw).data;
      const add = (reason: string) => drift.push({ issue, type, status: raw, reason });
      if (!type) add("no single valid type:* label");
      else if (raw === null) add("Status unset");
      else if (!status) add(`'${raw}' is not a ProjectStatus`);
      else if (!allowedStatuses(type).has(status)) add(`${type} does not use '${status}'`);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return drift;
}

/** Field diff + Status drift. Read-only. */
export function projectPlan(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: ProjectConfig = loadProjectConfig(),
): ProjectPlan {
  return { ...planFields(desired, readFields(c, run).fields), drift: statusDrift(c, run) };
}

const writable = (a: FieldAction) => a.kind !== "manual";

/**
 * Writes the field diff: creates missing fields, writes option lists (existing options keep
 * their IDs, so item values survive). Never deletes. Refuses before any write when the viewer
 * cannot update the Project. Returns what it wrote; a second run writes nothing.
 */
export function projectApply(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: ProjectConfig = loadProjectConfig(),
): { applied: FieldAction[]; plan: FieldPlan } {
  const { projectId, canUpdate, fields } = readFields(c, run);
  const plan = planFields(desired, fields);
  const todo = plan.actions.filter(writable);
  if (todo.length && !canUpdate) {
    throw new OmiError(
      "GITHUB_AUTH",
      `no write access to Project #${c.github.projectNumber} (needs the project scope and Project admin/write)`,
    );
  }
  const option = (o: GhOption) => ({
    ...(o.id ? { id: o.id } : {}),
    name: o.name,
    color: o.color,
    description: o.description,
  });
  for (const a of todo) {
    if (a.kind === "create") {
      const vars: Record<string, unknown> = {
        p: projectId,
        t: a.field.type.toUpperCase(),
        n: a.field.name,
      };
      if (a.field.type === "single_select") vars.o = a.field.options.map(option);
      graphql(CREATE_FIELD, vars, z.unknown(), `create field ${a.field.name}`, run, true);
    } else if (a.kind === "update-options") {
      graphql(
        UPDATE_OPTIONS,
        { f: a.fieldId, o: a.options.map(option) },
        z.unknown(),
        `update field ${a.name}`,
        run,
        true,
      );
    }
  }
  return {
    applied: todo,
    plan: todo.length ? planFields(desired, readFields(c, run).fields) : plan,
  };
}
