// `omi github project plan|apply|validate` (DevTask-0030 #62, DevTask-0031 #63): diff the Project's fields, views and built-in workflows against
// config/github/project.yaml and report items whose Status breaks their type's lifecycle
// (config/github/status-transitions.yaml). Apply only adds; IDs are read, never configured.
import { z } from "zod";
import type { OmiConfig } from "../../core/config.ts";
import { type Check, ProjectStatus } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { labelType } from "../../core/hierarchy.ts";
import {
  type ActualField,
  type ActualView,
  allowedStatuses,
  type FieldAction,
  type FieldPlan,
  type GhOption,
  loadProjectConfig,
  loadViewsConfig,
  type ProjectConfig,
  planFields,
  planViews,
  type ViewAction,
  type ViewPlan,
  type ViewsConfig,
} from "../../core/project-config.ts";
import { type GhRunner, graphql, spawnGh } from "./client.ts";
import { OWNER_PROJECT } from "./project.ts";

const FIELDS = `query($owner:String!,$number:Int!){ ${OWNER_PROJECT(`id viewerCanUpdate
  fields(first:50){ nodes{ __typename
    ... on ProjectV2FieldCommon{ id name dataType }
    ... on ProjectV2SingleSelectField{ options{ id name color description } }
    ... on ProjectV2IterationField{ configuration{ duration } } } }
  views(first:50){ nodes{ id name layout filter
    groupByFields(first:5){ nodes{ ... on ProjectV2FieldCommon{ name } } }
    verticalGroupByFields(first:5){ nodes{ ... on ProjectV2FieldCommon{ name } } }
    sortByFields(first:5){ nodes{ direction field{ ... on ProjectV2FieldCommon{ name } } } } } }
  workflows(first:50){ nodes{ name enabled } }`)} }`;

const Names = z.strictObject({ nodes: z.array(z.strictObject({ name: z.string() })) });

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
          views: z.strictObject({
            nodes: z.array(
              z.strictObject({
                id: z.string(),
                name: z.string(),
                layout: z.string(),
                filter: z.string().nullable(),
                groupByFields: Names.nullable(),
                verticalGroupByFields: Names.nullable(),
                sortByFields: z
                  .strictObject({
                    nodes: z.array(
                      z.strictObject({
                        direction: z.string(),
                        field: z.strictObject({ name: z.string() }),
                      }),
                    ),
                  })
                  .nullable(),
              }),
            ),
          }),
          workflows: z.strictObject({
            nodes: z.array(z.strictObject({ name: z.string(), enabled: z.boolean() })),
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

const CREATE_VIEW = `mutation($p:ID!,$n:String!,$l:ProjectV2ViewLayout!){
  createProjectV2View(input:{projectId:$p,name:$n,layout:$l}){ projectV2View{ id } } }`;

export interface ProjectPlan extends FieldPlan {
  views: ViewPlan;
  drift: StatusDrift[];
}

const names = (n: { nodes: { name: string }[] } | null) =>
  n?.nodes.map((x) => x.name).join(", ") ?? "";

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
  const views: ActualView[] = p.views.nodes.map((v) => ({
    id: v.id,
    name: v.name,
    // TABLE_LAYOUT → table
    layout: v.layout.replace(/_LAYOUT$/, "").toLowerCase(),
    filter: v.filter ?? "",
    groupBy: names(v.groupByFields),
    columns: names(v.verticalGroupByFields),
    sort: (v.sortByFields?.nodes ?? [])
      .map((s) => `${s.field.name} ${s.direction.toLowerCase()}`)
      .join(", "),
  }));
  return {
    projectId: p.id,
    canUpdate: p.viewerCanUpdate,
    fields,
    views,
    workflows: p.workflows.nodes,
  };
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

/** The desired state: custom fields (project.yaml) and views, workflows, Insights (views.yaml). */
export interface ProjectDesired {
  fields: ProjectConfig;
  views: ViewsConfig;
}
const loadDesired = (): ProjectDesired => ({
  fields: loadProjectConfig(),
  views: loadViewsConfig(),
});

const diff = (d: ProjectDesired, actual: ReturnType<typeof readFields>) => ({
  ...planFields(d.fields, actual.fields),
  views: planViews(d.views, actual.views, actual.workflows),
});

/** Field and view diff + Status drift. Read-only. */
export function projectPlan(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: ProjectDesired = loadDesired(),
): ProjectPlan {
  return { ...diff(desired, readFields(c, run)), drift: statusDrift(c, run) };
}

export type ProjectAction = FieldAction | ViewAction;
const writable = (a: ProjectAction) =>
  a.kind === "create" || a.kind === "update-options" || a.kind === "create-view";

/**
 * Writes the field and view diff: creates missing fields and views (by name + layout), writes
 * option lists (existing options keep their IDs, so item values survive). Never deletes; view
 * settings, workflows and Insights stay manual. Refuses before any write when the viewer cannot
 * update the Project, then reads back (verify). A second run writes nothing.
 */
export function projectApply(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: ProjectDesired = loadDesired(),
): { applied: ProjectAction[]; plan: Omit<ProjectPlan, "drift"> } {
  const actual = readFields(c, run);
  const plan = diff(desired, actual);
  const todo: ProjectAction[] = [...plan.actions, ...plan.views.actions].filter(writable);
  if (todo.length && !actual.canUpdate) {
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
  const { projectId } = actual;
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
    } else if (a.kind === "create-view") {
      graphql(
        CREATE_VIEW,
        { p: projectId, n: a.view.name, l: `${a.view.layout.toUpperCase()}_LAYOUT` },
        z.unknown(),
        `create view ${a.view.name}`,
        run,
      );
    }
  }
  return { applied: todo, plan: todo.length ? diff(desired, readFields(c, run)) : plan };
}

/** `github project validate`: the plan as checks. Insights (no API) is a warning, not a failure. */
export function projectValidate(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: ProjectDesired = loadDesired(),
): Check[] {
  const plan = projectPlan(c, run, desired);
  const check = (name: string, todo: string[], okDetail: string): Check =>
    todo.length
      ? { name, status: "fail", code: "POLICY_VIOLATION", detail: todo.join("; ") }
      : { name, status: "pass", detail: okDetail };
  const say = (a: ProjectAction) =>
    a.kind === "create"
      ? `missing field ${a.field.name}`
      : a.kind === "update-options"
        ? `${a.name} options ${[...a.add, ...a.change].join(", ")}`
        : a.kind === "create-view"
          ? `missing view ${a.view.name}`
          : `${a.name}: ${a.reason}`;
  const isWorkflow = (a: ViewAction) => a.kind === "workflow";
  const checks: Check[] = [
    check("fields", plan.actions.map(say), `${desired.fields.fields.length} in the desired state`),
    check(
      "views",
      plan.views.actions.filter((a) => !isWorkflow(a)).map(say),
      `${desired.views.views.length} in the desired state`,
    ),
    check(
      "workflows",
      plan.views.actions.filter(isWorkflow).map(say),
      `${Object.keys(desired.views.workflows).length} built-in as desired`,
    ),
    check(
      "status-drift",
      plan.drift.map((d) => `${d.issue} ${d.status ?? "unset"}: ${d.reason}`),
      "every item's Status fits its type",
    ),
  ];
  const extra = [...plan.extra, ...plan.views.extraViews.map((v) => `view ${v}`)];
  if (extra.length)
    checks.push({ name: "extra", status: "warn", detail: `kept: ${extra.join(", ")}` });
  if (plan.views.unsupported.length) {
    checks.push({
      name: "insights",
      status: "warn",
      detail: `unsupported (no API): ${desired.views.insights.length} chart(s) to create by hand`,
    });
  }
  return checks;
}
