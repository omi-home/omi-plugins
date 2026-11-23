// Issue hierarchy policy (DevTask-0045 #128): allowed parent → child OMI types, maximum depth,
// no cycles, and the title rule `<IssueType>-<NNNN>-<Tiêu đề>` matching the `type:*` label.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import {
  type Check,
  IssueType,
  IssueTypeV2,
  type ProjectStatus,
  parseContract,
} from "../../shared/contracts.ts";
import { CONFIG_DIR } from "../../shared/plugin-paths.ts";

export const Hierarchy = z.strictObject({
  maxDepth: z.int().min(1),
  children: z.partialRecord(IssueType, z.array(IssueType)),
});
export type Hierarchy = z.infer<typeof Hierarchy>;

let cached: Hierarchy | undefined;
export const loadHierarchy = (): Hierarchy =>
  (cached ??= parseContract(
    Hierarchy,
    parse(readFileSync(join(CONFIG_DIR, "github", "issue-hierarchy.yaml"), "utf8")),
    "issue hierarchy",
  ));

/** Model v2 tree (`issue-hierarchy-v2.yaml`): `roots` have no parent, every other type needs one. */
export const HierarchyV2 = z.strictObject({
  maxDepth: z.int().min(1),
  roots: z.array(IssueTypeV2).min(1),
  children: z.partialRecord(IssueTypeV2, z.array(IssueTypeV2)),
});
export type HierarchyV2 = z.infer<typeof HierarchyV2>;

let cachedV2: HierarchyV2 | undefined;
export const loadHierarchyV2 = (): HierarchyV2 =>
  (cachedV2 ??= parseContract(
    HierarchyV2,
    parse(readFileSync(join(CONFIG_DIR, "github", "issue-hierarchy-v2.yaml"), "utf8")),
    "issue hierarchy v2",
  ));

/** One issue of a parent chain, nearest first; `type` undefined when its type is invalid. */
export interface Link<T extends string = IssueType> {
  number: number;
  type: T | undefined;
  /** `owner/repo` when the chain crosses repositories; numbers alone collide there. */
  repo?: string;
}

/** `self` (number 0: not created yet) and its ancestors (nearest parent first) against the matrix, depth and cycles. */
export function hierarchyChecks<T extends string = IssueType>(
  self: Link<T>,
  ancestors: Link<T>[],
  h: { maxDepth: number; children: Partial<Record<T, readonly T[]>>; roots?: readonly T[] },
  /** Whether the Issue really has a parent; `ancestors` is cut at the repository boundary. */
  hasParent: boolean = ancestors.length > 0,
): Check[] {
  const chain = [self, ...ancestors];
  const seen = new Set<string>();
  for (const l of chain) {
    const key = `${l.repo?.toLowerCase() ?? ""}#${l.number}`;
    if (seen.has(key)) {
      return [fail("hierarchy", `cycle: #${l.number} is its own ancestor`)];
    }
    seen.add(key);
  }
  for (let i = 1; i < chain.length; i++) {
    const [child, parent] = [chain[i - 1] as Link<T>, chain[i] as Link<T>];
    if (!child.type || !parent.type) continue; // the type gate reports bad labels
    if (!(h.children[parent.type] ?? []).includes(child.type)) {
      return [
        fail(
          "hierarchy",
          `${child.number ? `#${child.number}` : "the new Issue"} (${child.type}) cannot be a child of #${parent.number} (${parent.type})`,
        ),
      ];
    }
  }
  if (h.roots && self.type && !h.roots.includes(self.type) && !hasParent) {
    return [
      fail(
        "hierarchy",
        `${self.number ? `#${self.number}` : "the new Issue"} (${self.type}) needs a parent: only ${h.roots.join(", ")} have none`,
      ),
    ];
  }
  return chain.length > h.maxDepth
    ? [fail("hierarchy", `depth ${chain.length} exceeds ${h.maxDepth} levels`)]
    : [{ name: "hierarchy", status: "pass", detail: `depth ${chain.length}` }];
}

const PASCAL: Partial<Record<IssueType, string>> = {
  fr: "FunctionalRequirement",
  nfr: "NonFunctionalRequirement",
  "devops-task": "DevOpsTask",
};
/** Title prefix of an OMI type: `dev-task` → `DevTask`. */
export const titleType = (t: IssueType): string =>
  PASCAL[t] ?? t.replace(/(^|-)([a-z])/g, (_, _d, c: string) => c.toUpperCase());

export const TITLE_PREFIX = /^([A-Za-z]+)-(\d{4})-/;

/** The `<x>` of every `type:<x>` label: the one place that reads the legacy type label. */
export const typeLabels = (labels: { name: string }[]): string[] =>
  labels.map((l) => /^type:(.+)$/.exec(l.name)?.[1]).filter((s): s is string => s !== undefined);

/** The one valid `type:*` label of an Issue; undefined when missing, several or unknown. */
export function labelType(labels: { name: string }[]): IssueType | undefined {
  const t = typeLabels(labels);
  return t.length === 1 ? IssueType.safeParse(t[0]).data : undefined;
}

/** Title check of model v2: the prefix is the native type name (`UserStory-0001-…`). */
export function titleCheckV2(title: string, type: IssueTypeV2): Check {
  const m = TITLE_PREFIX.exec(title);
  if (m?.[1] === type) return { name: "title", status: "pass", detail: `${type}-${m[2]}` };
  return fail("title", `title must start with ${type}-<NNNN>- (issue type ${type})`);
}

/** `TITLE_PREFIX` match of `title` when its prefix is `type`'s. */
export function numberedAs(title: string, type: IssueType): RegExpExecArray | null {
  const m = TITLE_PREFIX.exec(title);
  return m?.[1] === titleType(type) ? m : null;
}

export function titleCheck(title: string, type: IssueType): Check {
  const m = numberedAs(title, type);
  const want = titleType(type);
  if (m) return { name: "title", status: "pass", detail: `${want}-${m[2]}` };
  return fail("title", `title must start with ${want}-<NNNN>- (label type:${type})`);
}

const fail = (name: string, detail: string): Check => ({
  name,
  status: "fail",
  code: "TICKET_INVALID",
  detail,
});

// --- completion roll-up policy (DevTask-0029 #60) ---------------------------------------------

/**
 * A sub-issue as roll-up sees it. `status`: its Status in the configured Project; null when it is
 * not on it (or has none); "unknown" when it cannot be told (unread item, option OMI does not know).
 */
export interface Child {
  ref: string;
  state: "OPEN" | "CLOSED";
  /** GitHub close reason: COMPLETED, NOT_PLANNED, DUPLICATE, REOPENED or null. */
  stateReason: string | null;
  status: ProjectStatus | "unknown" | null;
}

export type RollUp = { ready: true } | { ready: false; reason: string };

/**
 * Whether a parent may roll up (close / move on): every child closed AND accepted — Status Done or
 * Cancelled in the Project; a child outside the Project is judged by its close reason — and at
 * least one child really done (all cancelled: a person decides). Children GitHub did not return
 * (`total` above the page) are unverified, so no roll-up. The parent's own scope counts too: an
 * unticked box under its `## Scope / Acceptance` means work not split into tasks yet (Bug-0001
 * #162). Never closes anything itself.
 */
export function rollUp(
  children: Child[],
  total: number,
  body = "",
  /**
   * A Story or Bug parent (DevTask-0143 #408): its Scope boxes are checked against its children
   * (the DevTasks and the QATask Verify/Retest, all Done), not ticked by hand, so an unticked box
   * never holds the roll-up.
   */
  scopeByChildren = false,
): RollUp {
  const no = (reason: string): RollUp => ({ ready: false, reason });
  if (children.length < total) return no(`${total - children.length} child(ren) not verified`);
  if (!children.length) return no("no children");
  const open = children.filter((c) => c.state === "OPEN");
  if (open.length) return no(`open: ${open.map((c) => c.ref).join(", ")}`);
  const cancelled = (c: Child) =>
    c.status === "Cancelled" ||
    (c.status === null && (c.stateReason === "NOT_PLANNED" || c.stateReason === "DUPLICATE"));
  const done = (c: Child) =>
    c.status === "Done" || (c.status === null && c.stateReason === "COMPLETED");
  const pending = children.filter((c) => !done(c) && !cancelled(c));
  if (pending.length) {
    return no(
      `closed but not accepted: ${pending.map((c) => `${c.ref} (${c.status ?? c.stateReason ?? "no reason"})`).join(", ")}`,
    );
  }
  if (!children.some(done)) return no("every child is cancelled: a person decides");
  const unticked = scopeByChildren ? 0 : uncheckedScope(body);
  if (unticked) return no(`scope not done: ${unticked} unchecked box(es) under Scope / Acceptance`);
  return { ready: true };
}

/** Unticked `- [ ]` boxes in the `## Scope / Acceptance` section (up to the next `## `). */
export function uncheckedScope(body: string): number {
  const section = /^## Scope \/ Acceptance.*$([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(body)?.[1];
  return section?.match(/^\s*[-*] \[ \]/gm)?.length ?? 0;
}
