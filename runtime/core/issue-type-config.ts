// Native issue types of model v2 (DevTask-0101 #310): desired state in config/github/issue-types.yaml
// and the pure diff against what the organization has. GitHub reads and writes live in
// adapters/github/issue-types.ts. Nothing here deletes or disables a type.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { IssueTypeV2, parseContract } from "./contracts.ts";

export const IssueTypeColor = z.enum([
  "GRAY",
  "BLUE",
  "GREEN",
  "YELLOW",
  "ORANGE",
  "RED",
  "PINK",
  "PURPLE",
]);
export type IssueTypeColor = z.infer<typeof IssueTypeColor>;

const DesiredType = z.strictObject({
  name: IssueTypeV2,
  description: z.string().min(1),
  color: IssueTypeColor,
});
export type DesiredType = z.infer<typeof DesiredType>;

export const IssueTypesConfig = z
  .strictObject({ types: z.array(DesiredType) })
  .refine(
    (c) =>
      c.types.length === IssueTypeV2.options.length &&
      IssueTypeV2.options.every((n) => c.types.some((t) => t.name === n)),
    "types must be exactly the 8 IssueTypeV2 names, once each",
  );
export type IssueTypesConfig = z.infer<typeof IssueTypesConfig>;

let cached: IssueTypesConfig | undefined;
export const loadIssueTypesConfig = (): IssueTypesConfig =>
  (cached ??= parseContract(
    IssueTypesConfig,
    parse(readFileSync(new URL("../../config/github/issue-types.yaml", import.meta.url), "utf8")),
    "issue types config",
    "CONFIG_INVALID",
  ));

/** An issue type as the organization reports it. */
export interface ActualIssueType {
  id: string;
  name: string;
  description: string | null;
  color: string | null;
  isEnabled: boolean;
}

export type IssueTypeAction =
  | { kind: "create-issue-type"; type: DesiredType }
  /** `set` holds only what differs; `changes` names it for humans. */
  | {
      kind: "update-issue-type";
      id: string;
      name: string;
      set: Partial<DesiredType> & { isEnabled?: true };
      changes: string[];
    }
  /** Needs a person: GitHub holds several types with this name. */
  | { kind: "manual"; name: string; reason: string };

export interface IssueTypePlan {
  actions: IssueTypeAction[];
  /** On GitHub, not in the desired state: reported, never deleted or disabled. */
  extra: string[];
}

const key = (n: string) => n.toLowerCase();

export function planIssueTypes(
  desired: IssueTypesConfig,
  actual: ActualIssueType[],
): IssueTypePlan {
  const actions: IssueTypeAction[] = [];
  for (const want of desired.types) {
    const found = actual.filter((a) => key(a.name) === key(want.name));
    const have = found[0];
    if (found.length > 1) {
      actions.push({
        kind: "manual",
        name: want.name,
        reason: `${found.length} issue types share this name`,
      });
    } else if (!have) {
      actions.push({ kind: "create-issue-type", type: want });
    } else {
      const set: Extract<IssueTypeAction, { kind: "update-issue-type" }>["set"] = {};
      const changes: string[] = [];
      if (have.name !== want.name) {
        set.name = want.name;
        changes.push(`name ${have.name} → ${want.name}`);
      }
      if ((have.description ?? "").trim() !== want.description) {
        set.description = want.description;
        changes.push("description");
      }
      if ((have.color ?? "").toUpperCase() !== want.color) {
        set.color = want.color;
        changes.push(`color ${have.color ?? "(none)"} → ${want.color}`);
      }
      if (!have.isEnabled) {
        set.isEnabled = true;
        changes.push("enable");
      }
      if (changes.length) {
        actions.push({ kind: "update-issue-type", id: have.id, name: have.name, set, changes });
      }
    }
  }
  const extra = actual
    .filter((a) => !desired.types.some((t) => key(t.name) === key(a.name)))
    .map((a) => a.name);
  return { actions, extra };
}

/** Whether the plan holds a write (the rest is manual). */
export const issueTypeWrites = (p: IssueTypePlan) => p.actions.filter((a) => a.kind !== "manual");
