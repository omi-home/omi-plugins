// State machine of model v2 (ADR-0005 D2/D5, DevTask-0099 #308): the schema of
// config/github/workflow.yaml, its zod loader and the merge of the workspace override
// (`github.workflow` in omi.config.yaml). Shared because shared/config.ts validates that override
// (ADR-0006); the derived queries live in github/domain/workflow-queries.ts.
// Pure: no GitHub reads, no predicate evaluation (Feature-0039 #298).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { IssueTypeV2, ProjectStatusV2, parseContract } from "./contracts.ts";
import { OmiError } from "./errors/errors.ts";
import { CONFIG_DIR } from "./plugin-paths.ts";

export const TransitionBy = z.enum(["po", "coordinator", "auto"]);
export type TransitionBy = z.infer<typeof TransitionBy>;

const Statuses = z.array(ProjectStatusV2).min(1);
const Types = z.array(IssueTypeV2).min(1);

/** The closed set of `when` predicates; each entry holds exactly one, with its typed parameter. */
export const Predicate = z.union([
  z.strictObject({ any_child_in: Statuses }),
  z.strictObject({ all_children_done: z.literal(true) }),
  z.strictObject({ children_done: Types }),
  z.strictObject({ no_open_child: Types }),
  z.strictObject({ parent_status_in: Statuses }),
  z.strictObject({ blockers_done: z.literal(true) }),
  z.strictObject({ linked_pr: z.enum(["open_ready", "changes_requested"]) }),
  z.strictObject({ issue_closed_by_pr: z.literal(true) }),
  z.strictObject({ siblings_done: Types }),
  z.strictObject({ no_open_sibling: Types }),
]);
export type Predicate = z.infer<typeof Predicate>;

export const PREDICATES = [
  "any_child_in",
  "all_children_done",
  "children_done",
  "no_open_child",
  "parent_status_in",
  "blockers_done",
  "linked_pr",
  "issue_closed_by_pr",
  "siblings_done",
  "no_open_sibling",
] as const;

export const Transition = z
  .strictObject({
    from: z.union([ProjectStatusV2, z.literal("*")]),
    to: z.union([ProjectStatusV2, z.array(ProjectStatusV2).min(1)]),
    by: TransitionBy,
    when: z.array(Predicate).min(1).optional(),
  })
  .superRefine((t, ctx) => {
    if (t.by === "auto" && !t.when) {
      ctx.addIssue({ code: "custom", path: ["when"], message: "an auto transition needs `when`" });
    }
    if (t.by !== "auto" && t.when) {
      ctx.addIssue({
        code: "custom",
        path: ["when"],
        message: `a ${t.by} transition must not have \`when\``,
      });
    }
  });
export type Transition = z.infer<typeof Transition>;

const TypeFlow = z.strictObject({
  initial: ProjectStatusV2,
  /** Only for types that can be Blocked; absent means the type has no Blocked status. */
  blocked_returns_to: ProjectStatusV2.optional(),
  transitions: z.array(Transition),
});
export type TypeFlow = z.infer<typeof TypeFlow>;

const sameSet = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && b.every((x) => a.includes(x));

export const Workflow = z
  .strictObject({
    statuses: z.array(ProjectStatusV2),
    closed_states: z.array(ProjectStatusV2),
    never_close: z.array(IssueTypeV2),
    types: z.strictObject(
      Object.fromEntries(IssueTypeV2.options.map((t) => [t, TypeFlow])) as Record<
        IssueTypeV2,
        typeof TypeFlow
      >,
    ),
  })
  .superRefine((w, ctx) => {
    if (!sameSet(w.statuses, ProjectStatusV2.options)) {
      ctx.addIssue({
        code: "custom",
        path: ["statuses"],
        message: "statuses must be exactly the ProjectStatusV2 enum, each once",
      });
    }
    for (const t of IssueTypeV2.options) {
      const flow = w.types[t];
      if (flow.initial === "Done") {
        ctx.addIssue({
          code: "custom",
          path: ["types", t, "initial"],
          message: "initial cannot be Done",
        });
      }
      const back = flow.blocked_returns_to;
      if (back === "Blocked" || back === "Done") {
        ctx.addIssue({
          code: "custom",
          path: ["types", t, "blocked_returns_to"],
          message: "blocked_returns_to cannot be Blocked or Done",
        });
      }
      flow.transitions.forEach((tr, i) => {
        const targets = Array.isArray(tr.to) ? tr.to : [tr.to];
        const path = ["types", t, "transitions", i];
        if (targets.includes(tr.from as ProjectStatusV2)) {
          ctx.addIssue({
            code: "custom",
            path,
            message: "a transition cannot target its own `from`",
          });
        }
        if (back === undefined && (tr.from === "Blocked" || targets.includes("Blocked"))) {
          ctx.addIssue({
            code: "custom",
            path,
            message: "a type without blocked_returns_to has no Blocked status",
          });
        }
        if (
          back !== undefined &&
          tr.from === "Blocked" &&
          (targets.length !== 1 || targets[0] !== back)
        ) {
          ctx.addIssue({
            code: "custom",
            path,
            message: `a transition from Blocked must go to blocked_returns_to (${back})`,
          });
        }
      });
    }
  });
export type Workflow = z.infer<typeof Workflow>;

export const parseWorkflow = (input: unknown, name = "workflow"): Workflow =>
  parseContract(Workflow, input, name, "CONFIG_INVALID");

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Merge rule: the override replaces by key. At the top level each key it names (`statuses`,
 * `closed_states`, `never_close`) replaces the default whole; under `types.<Type>` each key it
 * names (`initial`, `blocked_returns_to`, `transitions`) replaces that one, and `transitions` is
 * replaced as a whole list, never concatenated. Types it does not name stay as they are. The caller
 * validates the result.
 */
export function mergeWorkflow(base: unknown, override: unknown): unknown {
  if (override === undefined || override === null) return base;
  if (!isRecord(override) || !isRecord(base)) {
    throw new OmiError("CONFIG_INVALID", "workflow override: expected a mapping");
  }
  const { types, ...top } = override;
  const merged: Record<string, unknown> = { ...base, ...top };
  if (types !== undefined) {
    if (!isRecord(types)) {
      throw new OmiError("CONFIG_INVALID", "workflow override: `types` must be a mapping");
    }
    const baseTypes = isRecord(base.types) ? base.types : {};
    const out: Record<string, unknown> = { ...baseTypes };
    for (const [name, flow] of Object.entries(types)) {
      if (!isRecord(flow)) {
        throw new OmiError("CONFIG_INVALID", `workflow override: types.${name} must be a mapping`);
      }
      const current = baseTypes[name];
      out[name] = { ...(isRecord(current) ? current : {}), ...flow };
    }
    merged.types = out;
  }
  return merged;
}

function readDefault(): unknown {
  return parse(readFileSync(join(CONFIG_DIR, "github", "workflow.yaml"), "utf8"));
}

let defaults: Workflow | undefined;
/** The plugin's default `config/github/workflow.yaml`, validated. */
export const loadDefaultWorkflow = (): Workflow =>
  (defaults ??= parseWorkflow(readDefault(), "workflow.yaml"));

/** Default merged with an override, validated again after the merge. */
export function resolveWorkflow(override?: unknown): Workflow {
  const base = loadDefaultWorkflow();
  if (override === undefined || override === null) return base;
  return parseWorkflow(mergeWorkflow(base, override), "workflow (with override)");
}
