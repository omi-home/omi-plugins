// Predicate evaluation, `auto` fixpoint and external-change checks of the v2 state machine
// (ADR-0005 D2/D4, DevTask-0123 #368). Pure: reads a ProjectModel, never GitHub.
import type { IssueTypeV2, ProjectStatusV2 } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { loadDefaultWorkflow, type Predicate, type Workflow } from "../../shared/workflow.ts";
import { ModelIndex, type WorkItem } from "./project-model.ts";
import { canTransition, closesIssue, effectiveTransitions } from "./workflow-queries.ts";

const isDone = (it: WorkItem) => it.status === "Done";
/** Open = the Issue is open and its status is not a closed state. */
const isOpen = (it: WorkItem, w: Workflow) =>
  it.state === "open" && !w.closed_states.includes(it.status);
const ofTypes = (list: WorkItem[], types: readonly IssueTypeV2[]) =>
  list.filter((i) => types.includes(i.type));

/**
 * Evaluates one predicate for `item` (ChangeRequest-0013 #302 §6). Empty cases:
 * - `all_children_done`, `children_done`, `siblings_done`: false when there is no matching
 *   child/sibling (nothing finished is not "done").
 * - `no_open_child`, `no_open_sibling`: true when there is none (vacuous).
 * - `any_child_in`: false without children. `parent_status_in`: false without a parent.
 * - `blockers_done`: true without blockers (vacuous).
 * - `linked_pr changes_requested`: some open (non-draft) PR has the latest verdict changes_requested.
 * - `linked_pr open_ready`: there is an open PR and none of them has changes_requested (the two
 *   modes exclude each other, so In progress <-> In review cannot oscillate).
 * - `blockers_done` also needs every external blocker done.
 * - `issue_closed_by_pr`: the Issue is closed and the model says a merged PR closed it.
 * "Done" is status Done; "open" is an open Issue not in a closed state.
 */
export function evaluatePredicate(
  p: Predicate,
  item: WorkItem,
  idx: ModelIndex,
  w: Workflow = loadDefaultWorkflow(),
): boolean {
  if ("any_child_in" in p) {
    return idx.childrenOf(item).some((c) => p.any_child_in.includes(c.status));
  }
  if ("all_children_done" in p) {
    const kids = idx.childrenOf(item);
    return kids.length > 0 && kids.every(isDone);
  }
  if ("children_done" in p) {
    const kids = ofTypes(idx.childrenOf(item), p.children_done);
    return kids.length > 0 && kids.every(isDone);
  }
  if ("no_open_child" in p) {
    return !ofTypes(idx.childrenOf(item), p.no_open_child).some((c) => isOpen(c, w));
  }
  if ("parent_status_in" in p) {
    const parent = idx.parentOf(item);
    return parent !== undefined && p.parent_status_in.includes(parent.status);
  }
  if ("blockers_done" in p) {
    return (
      item.blockedBy.every((n) => {
        const b = idx.byNumber.get(n);
        return b !== undefined && isDone(b);
      }) && item.externalBlockers.every((b) => b.done)
    );
  }
  if ("linked_pr" in p) {
    const open = item.linkedPrs.filter((pr) => pr.state === "open");
    const changes = open.some((pr) => pr.verdict === "changes_requested");
    // Mutually exclusive: one open PR asking for changes outweighs the others.
    return p.linked_pr === "changes_requested" ? changes : open.length > 0 && !changes;
  }
  if ("issue_closed_by_pr" in p) {
    return item.state === "closed" && item.closedByMergedPr;
  }
  if ("siblings_done" in p) {
    const sibs = ofTypes(idx.siblingsOf(item), p.siblings_done);
    return sibs.length > 0 && sibs.every(isDone);
  }
  return !ofTypes(idx.siblingsOf(item), p.no_open_sibling).some((s) => isOpen(s, w));
}

/** Every predicate of `when` must hold (an absent or empty list holds). */
export const evaluateWhen = (
  when: Predicate[] | undefined,
  item: WorkItem,
  idx: ModelIndex,
  w: Workflow = loadDefaultWorkflow(),
): boolean => (when ?? []).every((p) => evaluatePredicate(p, item, idx, w));

export interface AppliedTransition {
  item: number;
  type: IssueTypeV2;
  from: ProjectStatusV2;
  to: ProjectStatusV2;
  predicate: Predicate[];
}

export interface FixpointResult {
  applied: AppliedTransition[];
  /** The model after the transitions (inputs are not mutated). */
  items: WorkItem[];
}

export const DEFAULT_MAX_ROUNDS = 20;

// Leaves first: tasks, then Bug, UserStory, Epic, the rest.
const RANK: Record<IssueTypeV2, number> = {
  DesignTask: 0,
  DevTask: 0,
  QATask: 0,
  Bug: 1,
  UserStory: 2,
  Epic: 3,
  ADR: 4,
  Doc: 4,
};

/**
 * Applies every `auto` transition whose `when` holds, leaves to root, until none applies. Each pass
 * walks items by type rank (Task, Bug, Story, Epic) and applies at most one transition per item, so a
 * parent sees the result of its children in the same pass. More than `maxRounds` passes that still
 * change something is INVALID_TRANSITION (details.reason FIXPOINT_LIMIT_EXCEEDED). Idempotent: running
 * again on `items` yields no transitions.
 */
export function computeFixpoint(
  model: readonly WorkItem[],
  w: Workflow = loadDefaultWorkflow(),
  maxRounds = DEFAULT_MAX_ROUNDS,
): FixpointResult {
  const items = model.map((i) => ({ ...i }));
  const idx = new ModelIndex(items);
  const order = [...items].sort((a, b) => RANK[a.type] - RANK[b.type] || a.number - b.number);
  const autos = new Map<IssueTypeV2, ReturnType<typeof effectiveTransitions>>();
  for (const t of Object.keys(RANK) as IssueTypeV2[]) {
    autos.set(
      t,
      effectiveTransitions(t, w).filter((tr) => tr.by === "auto"),
    );
  }
  const applied: AppliedTransition[] = [];
  for (let round = 0; round <= maxRounds; round++) {
    let changed = false;
    for (const it of order) {
      const tr = autos
        .get(it.type)
        ?.find((t) => (t.from === "*" || t.from === it.status) && evaluateWhen(t.when, it, idx, w));
      if (!tr) continue;
      const to = Array.isArray(tr.to) ? tr.to[0] : tr.to;
      if (to === undefined || to === it.status) continue;
      applied.push({
        item: it.number,
        type: it.type,
        from: it.status,
        to,
        predicate: tr.when ?? [],
      });
      it.status = to;
      changed = true;
    }
    if (!changed) return { applied, items };
  }
  throw new OmiError(
    "INVALID_TRANSITION",
    `auto transitions did not reach a fixpoint within ${maxRounds} rounds`,
    { reason: "FIXPOINT_LIMIT_EXCEEDED", maxRounds, applied: applied.length },
  );
}

export interface ExternalChangeVerdict {
  valid: boolean;
  reason?: string;
}

/**
 * Whether a status change made outside `omi` (by the PO in the Project) is allowed by a `by: po`
 * transition of `type`; `sync` accepts it or reverts it. No change is valid.
 */
export function checkExternalChange(
  type: IssueTypeV2,
  from: ProjectStatusV2,
  to: ProjectStatusV2,
  w: Workflow = loadDefaultWorkflow(),
): ExternalChangeVerdict {
  if (from === to || canTransition(type, from, to, "po", w)) return { valid: true };
  return { valid: false, reason: `${type}: ${from} -> ${to} is not a transition the PO may make` };
}

/** Open/closed an Issue must have for its status: closed_states close (completed), Doc never closes. */
export function desiredIssueState(
  type: IssueTypeV2,
  status: ProjectStatusV2,
  w: Workflow = loadDefaultWorkflow(),
): { state: "open" } | { state: "closed"; reason: "completed" } {
  return closesIssue(type, status, w)
    ? { state: "closed", reason: "completed" }
    : { state: "open" };
}

/**
 * GitHub Milestones whose Epics are all Done (to close them in `sync`). A Milestone counts only with
 * at least one Epic; Epics not Done (including closed not-planned ones) keep it open.
 */
export function milestonesWithAllEpicsDone(model: readonly WorkItem[]): number[] {
  const byMilestone = new Map<number, WorkItem[]>();
  for (const it of model) {
    if (it.type !== "Epic" || it.milestone === null) continue;
    byMilestone.set(it.milestone, [...(byMilestone.get(it.milestone) ?? []), it]);
  }
  return [...byMilestone]
    .filter(([, epics]) => epics.every(isDone))
    .map(([m]) => m)
    .sort((a, b) => a - b);
}
