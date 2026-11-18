// Project desired state (DevTask-0030 #62): custom fields in config/github/project.yaml, Status
// lifecycle per type in config/github/status-transitions.yaml. Pure: load, validate, diff.
// GitHub reads and writes live in adapters/github/project.ts.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { IssueType, ProjectStatus, parseContract } from "./contracts.ts";

const Color = z.enum(["GRAY", "BLUE", "GREEN", "YELLOW", "ORANGE", "RED", "PINK", "PURPLE"]);
const Option = z.strictObject({
  name: z.string().min(1),
  color: Color,
  description: z.string().default(""),
});
export type Option = z.infer<typeof Option>;

const Field = z.discriminatedUnion("type", [
  z.strictObject({
    name: z.string().min(1),
    type: z.literal("single_select"),
    options: z.array(Option).min(1),
  }),
  z.strictObject({ name: z.string().min(1), type: z.enum(["date", "text", "number"]) }),
  z.strictObject({
    name: z.string().min(1),
    type: z.literal("iteration"),
    duration: z.int().min(1).max(56),
  }),
]);
export type Field = z.infer<typeof Field>;

const unique = (names: string[]) =>
  new Set(names.map((n) => n.toLowerCase())).size === names.length;

export const ProjectConfig = z
  .strictObject({ initialStatus: ProjectStatus, fields: z.array(Field) })
  .refine((c) => unique(c.fields.map((f) => f.name)), "duplicate field name")
  .refine(
    (c) =>
      c.fields.every((f) => f.type !== "single_select" || unique(f.options.map((o) => o.name))),
    "duplicate option name",
  )
  .refine((c) => {
    const status = c.fields.find((f) => f.name === "Status");
    const names = status?.type === "single_select" ? status.options.map((o) => o.name) : [];
    return (
      names.length === ProjectStatus.options.length &&
      ProjectStatus.options.every((s) => names.includes(s))
    );
  }, "Status must be a single_select whose options are exactly the ProjectStatus enum");
export type ProjectConfig = z.infer<typeof ProjectConfig>;

const Moves = z.partialRecord(ProjectStatus, z.array(ProjectStatus));
export const StatusTransitions = z.strictObject({
  /** YAML anchor holder; read through `types`. */
  executable: Moves.optional(),
  types: z.strictObject(
    Object.fromEntries(IssueType.options.map((t) => [t, Moves])) as Record<IssueType, typeof Moves>,
  ),
});
export type StatusTransitions = z.infer<typeof StatusTransitions>;

const read = (file: string) =>
  parse(readFileSync(new URL(`../../config/github/${file}`, import.meta.url), "utf8"));

let project: ProjectConfig | undefined;
let transitions: StatusTransitions | undefined;
export const loadProjectConfig = (): ProjectConfig =>
  (project ??= parseContract(
    ProjectConfig,
    read("project.yaml"),
    "project config",
    "CONFIG_INVALID",
  ));
export const loadTransitions = (): StatusTransitions =>
  (transitions ??= parseContract(
    StatusTransitions,
    read("status-transitions.yaml"),
    "status transitions",
    "CONFIG_INVALID",
  ));

const TERMINAL: readonly ProjectStatus[] = ["Done", "Cancelled"];

/** Every status `type` may show: the ones its map names plus Blocked and Cancelled. */
export function allowedStatuses(type: IssueType, t = loadTransitions()): Set<ProjectStatus> {
  const moves = t.types[type];
  return new Set<ProjectStatus>([
    ...(Object.keys(moves) as ProjectStatus[]),
    ...Object.values(moves).flat(),
    "Blocked",
    "Cancelled",
  ]);
}

/** Whether `type` may move `from` (null: unset) → `to` under the matrix and the common rules. */
export function canMove(
  type: IssueType,
  from: ProjectStatus | null,
  to: ProjectStatus,
  t = loadTransitions(),
): boolean {
  const allowed = allowedStatuses(type, t);
  if (!allowed.has(to)) return false;
  if (from === null || from === to) return true;
  if (!allowed.has(from)) return false;
  if (to === "Blocked") return !TERMINAL.includes(from);
  if (from === "Blocked") return true;
  if (to === "Cancelled") return from !== "Done";
  if (from === "Done") return to === "In Progress";
  return t.types[type][from]?.includes(to) ?? false;
}

// --- field diff -------------------------------------------------------------------------------

/** An option as GitHub reports or takes it; `id` absent for a new option. */
export interface GhOption {
  id?: string;
  name: string;
  color: string;
  description: string;
}

/** A field as GitHub reports it. `dataType` is GitHub's (SINGLE_SELECT, DATE, ITERATION, TITLE…). */
export interface ActualField {
  id: string;
  name: string;
  dataType: string;
  options?: GhOption[];
  duration?: number;
}

export type FieldAction =
  /** Create a missing field (never an iteration field). */
  | { kind: "create"; field: Field }
  /** Write the full option list of a single-select: existing options keep their IDs. */
  | {
      kind: "update-options";
      fieldId: string;
      name: string;
      options: GhOption[];
      add: string[];
      change: string[];
    }
  /** Needs a person (unverified API or a conflict apply must not resolve). */
  | { kind: "manual"; name: string; reason: string };

export interface FieldPlan {
  actions: FieldAction[];
  /** On GitHub, not in the desired state: reported, never deleted. */
  extra: string[];
}

const DATA_TYPE: Record<Field["type"], string> = {
  single_select: "SINGLE_SELECT",
  date: "DATE",
  text: "TEXT",
  number: "NUMBER",
  iteration: "ITERATION",
};
/** Custom data types; the rest are GitHub's built-in fields. */
const CUSTOM = new Set(Object.values(DATA_TYPE).concat("MULTI_SELECT"));

export function planFields(desired: ProjectConfig, actual: ActualField[]): FieldPlan {
  const actions: FieldAction[] = [];
  const key = (n: string) => n.toLowerCase();
  for (const want of desired.fields) {
    const found = actual.filter((a) => key(a.name) === key(want.name));
    const have = found[0];
    if (found.length > 1) {
      actions.push({
        kind: "manual",
        name: want.name,
        reason: `${found.length} fields share this name`,
      });
    } else if (!have) {
      actions.push(
        want.type === "iteration"
          ? {
              kind: "manual",
              name: want.name,
              reason: "create the iteration field in the Project UI",
            }
          : { kind: "create", field: want },
      );
    } else if (have.dataType !== DATA_TYPE[want.type]) {
      actions.push({
        kind: "manual",
        name: want.name,
        reason: `is ${have.dataType} on GitHub, desired ${DATA_TYPE[want.type]}`,
      });
    } else if (
      want.type === "iteration" &&
      have.duration !== undefined &&
      have.duration !== want.duration
    ) {
      actions.push({
        kind: "manual",
        name: want.name,
        reason: `iteration duration ${have.duration} on GitHub, desired ${want.duration}`,
      });
    } else if (want.type === "single_select") {
      const current = have.options ?? [];
      const add: string[] = [];
      const change: string[] = [];
      const options: GhOption[] = current.map((o) => {
        const w = want.options.find((x) => x.name === o.name);
        if (!w || (w.color === o.color && w.description === o.description)) return o;
        change.push(o.name);
        return { ...o, color: w.color, description: w.description };
      });
      for (const w of want.options) {
        if (!current.some((o) => o.name === w.name)) {
          add.push(w.name);
          options.push(w);
        }
      }
      if (add.length || change.length) {
        actions.push({
          kind: "update-options",
          fieldId: have.id,
          name: have.name,
          options,
          add,
          change,
        });
      }
    }
  }
  const extra = actual
    .filter(
      (a) => CUSTOM.has(a.dataType) && !desired.fields.some((f) => key(f.name) === key(a.name)),
    )
    .map((a) => a.name);
  for (const a of actual) {
    const want = desired.fields.find((f) => key(f.name) === key(a.name));
    if (want?.type !== "single_select") continue;
    for (const o of a.options ?? []) {
      if (!want.options.some((w) => w.name === o.name)) extra.push(`${a.name}: ${o.name}`);
    }
  }
  return { actions, extra };
}

// --- views, built-in workflows, Insights (DevTask-0031 #63) ------------------------------------

export const ViewLayout = z.enum(["table", "board", "roadmap"]);
export type ViewLayout = z.infer<typeof ViewLayout>;
/** Settings the API reads but cannot write; absent = not managed. */
const VIEW_SETTINGS = ["filter", "groupBy", "columns", "sort"] as const;
type ViewSetting = (typeof VIEW_SETTINGS)[number];

const View = z.strictObject({
  name: z.string().min(1),
  layout: ViewLayout,
  filter: z.string().optional(),
  groupBy: z.string().min(1).optional(),
  /** Board column field. */
  columns: z.string().min(1).optional(),
  /** `<Field> asc|desc`, several joined with `, `. */
  sort: z
    .string()
    .regex(/^[^,]+ (asc|desc)(, [^,]+ (asc|desc))*$/)
    .optional(),
});
export type View = z.infer<typeof View>;

export const ViewsConfig = z
  .strictObject({
    views: z.array(View),
    workflows: z.record(z.string().min(1), z.boolean()).default({}),
    insights: z.array(z.string().min(1)).default([]),
  })
  .refine((c) => unique(c.views.map((v) => v.name)), "duplicate view name")
  .refine((c) => c.views.every((v) => !v.columns || v.layout === "board"), "columns needs board");
export type ViewsConfig = z.infer<typeof ViewsConfig>;

let views: ViewsConfig | undefined;
export const loadViewsConfig = (): ViewsConfig =>
  (views ??= parseContract(ViewsConfig, read("views.yaml"), "views config", "CONFIG_INVALID"));

/** A view as GitHub reports it, settings already flattened to the View shape. */
export type ActualView = { id: string } & Required<Omit<View, "layout">> & { layout: string };

export type ViewAction =
  | { kind: "create-view"; view: View }
  /** UI-only change: a setting, a layout, a name or a duplicate. */
  | { kind: "manual"; name: string; reason: string }
  /** A built-in workflow to toggle in Project settings (no API). */
  | { kind: "workflow"; name: string; reason: string };

export interface ViewPlan {
  actions: ViewAction[];
  /** Views on GitHub not in the desired state: reported, never deleted. */
  extraViews: string[];
  /** No API: Insights charts to create by hand. */
  unsupported: string[];
}

const LABEL: Record<ViewSetting, string> = {
  filter: "filter",
  groupBy: "group by",
  columns: "column field",
  sort: "sort",
};
const shown = (v: string) => (v === "" ? "(none)" : `'${v}'`);

/** Settings of `want` that `have` (absent: a view about to be created) does not match. */
function settingsToSet(want: View, have?: ActualView): ViewAction[] {
  return VIEW_SETTINGS.flatMap((s): ViewAction[] => {
    const w = want[s];
    if (w === undefined || (have && have[s].trim() === w.trim())) return [];
    // A new view has no filter, and a new board already uses Status columns (verified 2026-11-18).
    if (!have && (w === "" || (s === "columns" && w === "Status"))) return [];
    return [
      {
        kind: "manual",
        name: want.name,
        reason: `set ${LABEL[s]} to ${shown(w)} in the Project UI${have ? ` (now ${shown(have[s])})` : ""}`,
      },
    ];
  });
}

export function planViews(
  desired: ViewsConfig,
  actual: ActualView[],
  workflows: { name: string; enabled: boolean }[],
): ViewPlan {
  const actions: ViewAction[] = [];
  const key = (n: string) => n.toLowerCase();
  for (const want of desired.views) {
    const found = actual.filter((a) => key(a.name) === key(want.name));
    const have = found[0];
    if (found.length > 1) {
      actions.push({
        kind: "manual",
        name: want.name,
        reason: `${found.length} views share this name: delete the extra ones in the Project UI`,
      });
    } else if (!have) {
      actions.push({ kind: "create-view", view: want }, ...settingsToSet(want));
    } else if (have.name !== want.name) {
      actions.push({
        kind: "manual",
        name: want.name,
        reason: `rename view '${have.name}' to '${want.name}' in the Project UI`,
      });
    } else if (have.layout !== want.layout) {
      actions.push({
        kind: "manual",
        name: want.name,
        reason: `layout is ${have.layout}, desired ${want.layout}: change it in the Project UI`,
      });
    } else {
      actions.push(...settingsToSet(want, have));
    }
  }
  for (const [name, enabled] of Object.entries(desired.workflows)) {
    const have = workflows.find((w) => key(w.name) === key(name));
    if (!have) {
      actions.push({
        kind: "workflow",
        name: `workflow ${name}`,
        reason: "not found on the Project",
      });
    } else if (have.enabled !== enabled) {
      actions.push({
        kind: "workflow",
        name: `workflow ${name}`,
        reason: `${enabled ? "enable" : "disable"} it in Project settings → Workflows (no API)`,
      });
    }
  }
  return {
    actions,
    extraViews: actual
      .filter((a) => !desired.views.some((v) => key(v.name) === key(a.name)))
      .map((a) => a.name),
    unsupported: desired.insights.map((i) => `Insights chart: ${i} (no API: create it by hand)`),
  };
}
