// Issue hierarchy policy (DevTask-0045 #128): allowed parent → child OMI types, maximum depth,
// no cycles, and the title rule `<IssueType>-<NNNN>-<Tiêu đề>` matching the `type:*` label.
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";
import { type Check, IssueType, parseContract } from "./contracts.ts";

export const Hierarchy = z.strictObject({
  maxDepth: z.int().min(1),
  children: z.partialRecord(IssueType, z.array(IssueType)),
});
export type Hierarchy = z.infer<typeof Hierarchy>;

let cached: Hierarchy | undefined;
export const loadHierarchy = (): Hierarchy =>
  (cached ??= parseContract(
    Hierarchy,
    parse(
      readFileSync(new URL("../../config/github/issue-hierarchy.yaml", import.meta.url), "utf8"),
    ),
    "issue hierarchy",
  ));

/** One issue of a parent chain, nearest first; `type` undefined when its label is invalid. */
export interface Link {
  number: number;
  type: IssueType | undefined;
  /** `owner/repo` when the chain crosses repositories; numbers alone collide there. */
  repo?: string;
}

/** `self` (number 0: not created yet) and its ancestors (nearest parent first) against the matrix, depth and cycles. */
export function hierarchyChecks(self: Link, ancestors: Link[], h: Hierarchy): Check[] {
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
    const [child, parent] = [chain[i - 1] as Link, chain[i] as Link];
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

/** The one valid `type:*` label of an Issue; undefined when missing, several or unknown. */
export function labelType(labels: { name: string }[]): IssueType | undefined {
  const t = labels.map((l) => /^type:(.+)$/.exec(l.name)?.[1]).filter(Boolean);
  return t.length === 1 ? IssueType.safeParse(t[0]).data : undefined;
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
