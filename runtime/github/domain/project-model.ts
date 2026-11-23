// Pure item model of a Project under model v2 (ADR-0005 D2/D4, DevTask-0123 #368). The fetch task of
// Feature-0039 #298 builds it; the predicate evaluator and the fixpoint read it. No I/O.
import { z } from "zod";
import { IssueTypeV2, ProjectStatusV2, parseContract } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";

/** Latest review verdict read from the `<!-- omi:review=… verdict=… -->` marker (ADR-0005 D4). */
export const ReviewVerdict = z.enum(["none", "approved", "changes_requested"]);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

export const LinkedPr = z.strictObject({
  number: z.number().int().positive(),
  state: z.enum(["open", "draft", "merged", "closed"]),
  verdict: ReviewVerdict.default("none"),
});
export type LinkedPr = z.infer<typeof LinkedPr>;

export const WorkItem = z.strictObject({
  number: z.number().int().positive(),
  type: IssueTypeV2,
  status: ProjectStatusV2,
  state: z.enum(["open", "closed"]),
  /** Why the Issue was closed; only meaningful when `state` is `closed`. */
  closeReason: z.enum(["completed", "not_planned"]).optional(),
  /** The Issue was closed by the merge of a PR that closes it. */
  closedByMergedPr: z.boolean().default(false),
  parent: z.number().int().positive().nullable().default(null),
  children: z.array(z.number().int().positive()).default([]),
  blockedBy: z.array(z.number().int().positive()).default([]),
  /**
   * Blockers outside the model (another repository, or an Issue not in the Project): fetch reads
   * whether each is done (closed as completed). They hold the item until done. In-model blockers
   * use `blockedBy`.
   */
  externalBlockers: z
    .array(z.strictObject({ ref: z.string().min(1), done: z.boolean() }))
    .default([]),
  labels: z.array(z.string()).default([]),
  linkedPrs: z.array(LinkedPr).default([]),
  /** GitHub Milestone number the Issue belongs to, if any. */
  milestone: z.number().int().positive().nullable().default(null),
});
export type WorkItem = z.infer<typeof WorkItem>;

export const ProjectModel = z.array(WorkItem).superRefine((items, ctx) => {
  const numbers = new Set<number>();
  items.forEach((it, i) => {
    if (numbers.has(it.number)) {
      ctx.addIssue({ code: "custom", path: [i, "number"], message: `duplicate #${it.number}` });
    }
    numbers.add(it.number);
  });
  // Only `blockedBy` must resolve inside the model (an outside blocker goes to `externalBlockers`).
  // A parent or child outside the Project is allowed: ModelIndex skips it, so it takes no part in
  // roll-up.
  items.forEach((it, i) => {
    for (const n of it.blockedBy) {
      if (!numbers.has(n)) {
        ctx.addIssue({
          code: "custom",
          path: [i, "blockedBy"],
          message: `#${n} is not in the model`,
        });
      }
    }
  });
});
export type ProjectModel = z.infer<typeof ProjectModel>;

export const parseProjectModel = (input: unknown): ProjectModel =>
  parseContract(ProjectModel, input, "project model", "CONTRACT_INVALID");

/** Number -> item lookup over a model. */
export class ModelIndex {
  readonly byNumber: Map<number, WorkItem>;
  readonly items: readonly WorkItem[];

  constructor(items: readonly WorkItem[]) {
    this.items = items;
    this.byNumber = new Map(items.map((i) => [i.number, i]));
  }

  get(n: number): WorkItem {
    const it = this.byNumber.get(n);
    if (!it) throw new OmiError("CONTRACT_INVALID", `#${n} is not in the project model`);
    return it;
  }

  parentOf(it: WorkItem): WorkItem | undefined {
    return it.parent === null ? undefined : this.byNumber.get(it.parent);
  }

  childrenOf(it: WorkItem): WorkItem[] {
    return it.children.flatMap((n) => this.byNumber.get(n) ?? []);
  }

  /** Other children of the same parent; none when `it` has no parent. */
  siblingsOf(it: WorkItem): WorkItem[] {
    const p = this.parentOf(it);
    return p ? this.childrenOf(p).filter((s) => s.number !== it.number) : [];
  }
}
