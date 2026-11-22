// `omi github project plan|apply|validate` (DevTask-0030 #62, DevTask-0031 #63): diff the Project's fields, views and built-in workflows against
// config/github/project.yaml and report items whose Status breaks their type's lifecycle
// (config/github/status-transitions.yaml). Apply only adds; IDs are read, never configured.
import { z } from "zod";
import { type OmiConfig, workflowModel } from "../../shared/config.ts";
import { type Check, IssueTypeV2, ProjectStatus, ProjectStatusV2 } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "../../shared/github/client.ts";
import { resolveWorkflow } from "../../shared/workflow.ts";
import { labelType } from "../application/hierarchy.ts";
import {
  type IssueTypeAction,
  type IssueTypePlan,
  type IssueTypesConfig,
  loadIssueTypesConfig,
} from "../application/issue-type-config.ts";
import {
  type ActualField,
  type ActualView,
  allowedStatuses,
  type FieldAction,
  type FieldPlan,
  type GhOption,
  loadProjectConfig,
  loadProjectConfigV2,
  loadViewsConfig,
  loadViewsConfigV2,
  type ProjectConfig,
  planFields,
  planViews,
  planViewsV2,
  type ViewAction,
  type ViewPlan,
  type ViewsConfig,
} from "../application/project-config.ts";
import { statusesOf } from "../domain/workflow-queries.ts";
import { issueTypeApply, issueTypePlan } from "./issue-types.ts";
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

// Legacy reads the type from `type:*` labels, model v2 from the native issue type.
const items = (typeSelection: string) =>
  `query($owner:String!,$number:Int!,$after:String){ ${OWNER_PROJECT(`items(first:100,after:$after){
  pageInfo{ hasNextPage endCursor }
  nodes{ content{ __typename ... on Issue{ number repository{ nameWithOwner } ${typeSelection} } }
    fieldValueByName(name:"Status"){ ... on ProjectV2ItemFieldSingleSelectValue{ name } } } }`)} }`;
const ITEMS = items("labels(first:30){ nodes{ name } }");
const ITEMS_V2 = items("issueType{ name }");

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
                    issueType: z.strictObject({ name: z.string() }).nullable().optional(),
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

// Spike-0012 #304: updateProjectV2View sets filter and layout; an unset variable leaves it alone.
const UPDATE_VIEW = `mutation($v:ID!,$f:String,$l:ProjectV2ViewLayout){
  updateProjectV2View(input:{viewId:$v,filter:$f,layout:$l}){ projectV2View{ id } } }`;

const CREATE_VIEW = `mutation($p:ID!,$n:String!,$l:ProjectV2ViewLayout!){
  createProjectV2View(input:{projectId:$p,name:$n,layout:$l}){ projectV2View{ id } } }`;

export interface ProjectPlan extends FieldPlan {
  views: ViewPlan;
  drift: StatusDrift[];
  /** Organization issue types; only under `github.model: v2`. */
  issueTypes?: IssueTypePlan;
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
  const v2 = workflowModel(c) === "v2";
  const workflow = v2 ? resolveWorkflow(c.github.workflow) : undefined;
  let after: string | null = null;
  do {
    const vars: Record<string, unknown> = { owner, number: projectNumber };
    if (after) vars.after = after;
    const page = graphql(v2 ? ITEMS_V2 : ITEMS, vars, ProjectItems, "project items", run)
      .repositoryOwner?.projectV2?.items;
    if (!page) break;
    for (const n of page.nodes) {
      const i = n.content;
      if (i?.__typename !== "Issue" || !i.number || !i.repository) continue;
      const issue = `${i.repository.nameWithOwner}#${i.number}`;
      const raw = n.fieldValueByName?.name ?? null;
      const add = (type: string | null, reason: string) =>
        drift.push({ issue, type, status: raw, reason });
      if (workflow) {
        const type = IssueTypeV2.safeParse(i.issueType?.name).data;
        const status = ProjectStatusV2.safeParse(raw).data;
        if (!type) add(null, "no native issue type of model v2");
        else if (raw === null) add(type, "Status unset");
        else if (!status) add(type, `'${raw}' is not a ProjectStatusV2`);
        else if (!statusesOf(type, workflow).includes(status)) {
          add(type, `${type} does not use '${status}'`);
        }
        continue;
      }
      const type = labelType(i.labels?.nodes ?? []) ?? null;
      const status = ProjectStatus.safeParse(raw).data;
      if (!type) add(type, "no single valid type:* label");
      else if (raw === null) add(type, "Status unset");
      else if (!status) add(type, `'${raw}' is not a ProjectStatus`);
      else if (!allowedStatuses(type).has(status)) add(type, `${type} does not use '${status}'`);
    }
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
  return drift;
}

/** The desired state: custom fields (project.yaml) and views, workflows, Insights (views.yaml). */
export interface ProjectDesired {
  fields: Pick<ProjectConfig, "fields"> & { builtinFields?: string[] };
  views: ViewsConfig;
  /** Model v2 only; the plugin's issue-types.yaml when absent. */
  issueTypes?: IssueTypesConfig;
}
/** The desired state of the configured model: project-v2.yaml + views-v2.yaml, or the legacy pair. */
const loadDesired = (c: OmiConfig): ProjectDesired =>
  workflowModel(c) === "v2"
    ? { fields: loadProjectConfigV2(), views: loadViewsConfigV2() }
    : { fields: loadProjectConfig(), views: loadViewsConfig() };

const diff = (c: OmiConfig, d: ProjectDesired, actual: ReturnType<typeof readFields>) => ({
  ...planFields(d.fields, actual.fields),
  views:
    workflowModel(c) === "v2"
      ? planViewsV2(d.views, actual.views, actual.workflows, actual.fields, d.fields.builtinFields)
      : planViews(d.views, actual.views, actual.workflows),
});

/** Field, view and (model v2) issue type diff + Status drift. Read-only. */
export function projectPlan(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: ProjectDesired = loadDesired(c),
): ProjectPlan {
  const plan = { ...diff(c, desired, readFields(c, run)), drift: statusDrift(c, run) };
  return workflowModel(c) === "v2"
    ? { ...plan, issueTypes: issueTypePlan(c, run, desired.issueTypes ?? loadIssueTypesConfig()) }
    : plan;
}

export type ProjectAction = FieldAction | ViewAction | IssueTypeAction;
const writable = (a: ProjectAction) =>
  a.kind === "create" ||
  a.kind === "update-options" ||
  a.kind === "create-view" ||
  a.kind === "update-view";

/**
 * Writes the field and view diff: creates missing fields and views (by name + layout), writes
 * option lists (existing options keep their IDs, so item values survive). Never deletes; view
 * settings, workflows and Insights stay manual. Refuses before any write when the viewer cannot
 * update the Project, then reads back (verify). A second run writes nothing.
 */
export function projectApply(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: ProjectDesired = loadDesired(c),
): { applied: ProjectAction[]; plan: Omit<ProjectPlan, "drift"> } {
  let actual = readFields(c, run);
  const v2 = workflowModel(c) === "v2";
  const types = desired.issueTypes ?? loadIssueTypesConfig();
  // Issue types first: a personal account or a missing admin:org scope is refused before any write.
  const typed = v2 ? issueTypeApply(c, run, types) : undefined;
  const plan: Omit<ProjectPlan, "drift"> = {
    ...diff(c, desired, actual),
    ...(typed ? { issueTypes: typed.plan } : {}),
  };
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
  const write = (a: ProjectAction) => {
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
    } else if (a.kind === "update-view") {
      const vars: Record<string, unknown> = { v: a.id };
      if (a.set.filter !== undefined) vars.f = a.set.filter;
      if (a.set.layout) vars.l = `${a.set.layout.toUpperCase()}_LAYOUT`;
      graphql(UPDATE_VIEW, vars, z.unknown(), `update view ${a.name}`, run, true);
    }
  };
  for (const a of todo) write(a);
  // Model v2: a view just created has an ID only now: read it back, then set its filter (the
  // filter of an existing view was already planned above).
  const made = todo.some((a) => a.kind === "create-view");
  if (v2 && made) {
    actual = readFields(c, run);
    for (const a of diff(c, desired, actual).views.actions) {
      if (a.kind === "update-view") {
        write(a);
        todo.push(a);
      }
    }
  }
  return {
    applied: [...(typed?.applied ?? []), ...todo],
    plan: todo.length
      ? { ...diff(c, desired, readFields(c, run)), ...(typed ? { issueTypes: typed.plan } : {}) }
      : plan,
  };
}

/** One issue type action as a sentence (validate, plan). */
export const sayIssueType = (a: IssueTypeAction) =>
  a.kind === "create-issue-type"
    ? `missing issue type ${a.type.name}`
    : a.kind === "update-issue-type"
      ? `issue type ${a.name}: ${a.changes.join(", ")}`
      : `issue type ${a.name}: ${a.reason}`;

/** `github project validate`: the plan as checks. Insights (no API) is a warning, not a failure. */
export function projectValidate(
  c: OmiConfig,
  run: GhRunner = spawnGh,
  desired: ProjectDesired = loadDesired(c),
): Check[] {
  const v2 = workflowModel(c) === "v2";
  const plan = projectPlan(c, run, desired);
  const check = (name: string, todo: string[], okDetail: string): Check =>
    todo.length
      ? { name, status: "fail", code: "POLICY_VIOLATION", detail: todo.join("; ") }
      : { name, status: "pass", detail: okDetail };
  const say = (a: FieldAction | ViewAction) =>
    a.kind === "create"
      ? `missing field ${a.field.name}`
      : a.kind === "update-options"
        ? `${a.name} options ${[...a.add, ...a.change].join(", ")}`
        : a.kind === "create-view"
          ? `missing view ${a.view.name}`
          : a.kind === "update-view"
            ? `view ${a.name}: ${a.changes.join(", ")}`
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
      v2
        ? "every built-in workflow is off"
        : `${Object.keys(desired.views.workflows).length} built-in as desired`,
    ),
    check(
      "status-drift",
      plan.drift.map((d) => `${d.issue} ${d.status ?? "unset"}: ${d.reason}`),
      "every item's Status fits its type",
    ),
  ];
  if (plan.issueTypes) {
    checks.splice(
      1,
      0,
      check(
        "issue-types",
        plan.issueTypes.actions.map(sayIssueType),
        `${(desired.issueTypes ?? loadIssueTypesConfig()).types.length} in the desired state`,
      ),
    );
  }
  const extra = [
    ...plan.extra,
    ...(plan.issueTypes?.extra.map((t) => `issue type ${t}`) ?? []),
    ...plan.views.extraViews.map((v) => `view ${v}`),
  ];
  if (extra.length)
    checks.push({ name: "extra", status: "warn", detail: `kept: ${extra.join(", ")}` });
  if (plan.views.unsupported.length) {
    checks.push({
      name: v2 ? "manual-steps" : "insights",
      status: "warn",
      detail: v2
        ? `no API, do by hand: ${plan.views.unsupported.join("; ")}`
        : `unsupported (no API): ${desired.views.insights.length} chart(s) to create by hand`,
    });
  }
  return checks;
}
