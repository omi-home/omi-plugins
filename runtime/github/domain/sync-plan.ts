// Plan of `omi sync` (ChangeRequest-0013 #302 §9.5 steps 2-5 and 7, ADR-0005 D2/D5). Pure: takes the
// fetched item model and the previous snapshot, returns what to accept, revert and write. The CLI does
// the I/O. Idempotent: planning again on the model after the writes yields an empty plan.
import type { IssueTypeV2, ProjectStatusV2 } from "../../shared/contracts.ts";
import { loadDefaultWorkflow, type Workflow } from "../../shared/workflow.ts";
import { type ItemWrite, stateChangeOf } from "./move-plan.ts";
import type { ProjectModel, WorkItem } from "./project-model.ts";
import {
  diffSnapshot,
  type ExternalChange,
  type SnapshotItem,
  toSnapshot,
} from "./project-snapshot.ts";
import { coordinatorQueue, type InboxEntry, poInbox, type QueueEntry } from "./work-queues.ts";
import {
  type AppliedTransition,
  checkExternalChange,
  computeFixpoint,
  milestonesWithAllEpicsDone,
} from "./workflow-engine.ts";

export interface PoDecision {
  issue: number;
  type: IssueTypeV2;
  from: ProjectStatusV2;
  to: ProjectStatusV2;
}

export interface Reverted {
  issue: number;
  type: IssueTypeV2;
  /** The status the PO (or anyone) set, which the workflow does not allow. */
  from: ProjectStatusV2;
  /** The status restored. */
  to: ProjectStatusV2;
  reason: string;
}

export interface SyncPlan {
  firstSync: boolean;
  changes: ExternalChange[];
  poDecisions: PoDecision[];
  reverted: Reverted[];
  applied: AppliedTransition[];
  /** Issues closed by a merged PR (event `issue_closed_by_pr`). */
  closedByPr: number[];
  /** Status and open/closed writes, reverts first, then leaves to root. */
  writes: ItemWrite[];
  /** Milestones whose Epics are all Done in the final model. */
  milestones: number[];
  /** The model after every write. */
  items: WorkItem[];
  queue: QueueEntry[];
  inbox: InboxEntry[];
}

const applyState = (it: WorkItem, change: ItemWrite["stateChange"]): WorkItem => {
  if (!change) return it;
  const { closeReason: _drop, ...rest } = it;
  return change === "close"
    ? { ...rest, state: "closed", closeReason: "completed" }
    : { ...rest, state: "open" };
};

export function planSync(
  model: ProjectModel,
  previous: readonly SnapshotItem[] | null,
  w: Workflow = loadDefaultWorkflow(),
): SyncPlan {
  // Steps 2-3: what changed outside omi, accepted or reverted.
  const changes = diffSnapshot(previous, toSnapshot(model));
  const before = new Map((previous ?? []).map((p) => [p.number, p]));
  const poDecisions: PoDecision[] = [];
  const reverted: Reverted[] = [];
  const restored = new Map<number, ProjectStatusV2>();
  for (const c of changes) {
    if (c.kind !== "status_changed") continue;
    const it = model.find((i) => i.number === c.issue);
    if (!it) continue;
    const verdict = checkExternalChange(it.type, c.from, c.to, w);
    if (verdict.valid) {
      poDecisions.push({ issue: c.issue, type: it.type, from: c.from, to: c.to });
    } else {
      reverted.push({
        issue: c.issue,
        type: it.type,
        from: c.to,
        to: before.get(c.issue)?.status ?? c.from,
        reason: verdict.reason ?? "not a transition the PO may make",
      });
      restored.set(c.issue, c.from);
    }
  }
  const afterReverts = model.map((i) =>
    restored.has(i.number) ? { ...i, status: restored.get(i.number) as ProjectStatusV2 } : i,
  );

  // Steps 4-5: auto rules to a fixpoint (leaves to root), then open/closed from the final status.
  // A merged PR that closed the Issue is not drift: the fixpoint moves it to Done.
  const fx = computeFixpoint(afterReverts, w);
  const original = new Map(model.map((i) => [i.number, i]));
  const order = new Map<number, number>();
  fx.applied.forEach((a, i) => {
    if (!order.has(a.item)) order.set(a.item, i);
  });
  const writes: ItemWrite[] = [];
  const items: WorkItem[] = [];
  for (const f of fx.items) {
    const orig = original.get(f.number) as WorkItem;
    const stateChange = stateChangeOf(orig, f.status, w);
    if (f.status !== orig.status || stateChange) {
      writes.push({
        issue: f.number,
        from: orig.status,
        to: f.status,
        ...(stateChange ? { stateChange } : {}),
      });
    }
    items.push(applyState(f, stateChange));
  }
  const revertedSet = new Set(reverted.map((r) => r.issue));
  writes.sort(
    (a, b) =>
      Number(revertedSet.has(b.issue)) - Number(revertedSet.has(a.issue)) ||
      (order.get(a.issue) ?? Number.MAX_SAFE_INTEGER) -
        (order.get(b.issue) ?? Number.MAX_SAFE_INTEGER) ||
      a.issue - b.issue,
  );

  const closedByPr = new Set<number>(
    fx.applied.filter((a) => a.predicate.some((p) => "issue_closed_by_pr" in p)).map((a) => a.item),
  );
  for (const c of changes) {
    if (c.kind === "closed" && original.get(c.issue)?.closedByMergedPr) closedByPr.add(c.issue);
  }

  return {
    firstSync: previous === null,
    changes,
    poDecisions,
    reverted,
    applied: fx.applied,
    closedByPr: [...closedByPr].sort((a, b) => a - b),
    writes,
    milestones: milestonesWithAllEpicsDone(items),
    items,
    queue: coordinatorQueue(items, w),
    inbox: poInbox(items, w),
  };
}
