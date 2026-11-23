// Pure queries over the item model for `omi sync` (report), `omi queue` and `omi inbox` (Feature-0039
// #298): what the Coordinator has to do and what waits for the PO. No I/O.
import type { IssueTypeV2, ProjectStatusV2 } from "../../shared/contracts.ts";
import { loadDefaultWorkflow, type Workflow } from "../../shared/workflow.ts";
import type { WorkItem } from "./project-model.ts";
import type { PoDecision } from "./sync-plan.ts";
import { effectiveTransitions } from "./workflow-queries.ts";

export interface QueueEntry {
  issue: number;
  type: IssueTypeV2;
  status: ProjectStatusV2;
  /** Statuses the Coordinator may move it to (`omi move`), never Blocked. */
  moves: ProjectStatusV2[];
}

export interface InboxEntry {
  issue: number;
  type: IssueTypeV2;
  status: "Awaiting PO" | "Acceptance";
}

const isLive = (it: WorkItem, w: Workflow) =>
  it.state === "open" && !w.closed_states.includes(it.status);

/**
 * Items the Coordinator acts on: open, not Blocked, with a `by: coordinator` transition out of their
 * status (moving into Blocked is always possible and is not counted). Ordered by issue number.
 */
export function coordinatorQueue(
  items: readonly WorkItem[],
  w: Workflow = loadDefaultWorkflow(),
): QueueEntry[] {
  const out: QueueEntry[] = [];
  for (const it of items) {
    if (!isLive(it, w) || it.status === "Blocked") continue;
    const moves = new Set<ProjectStatusV2>();
    for (const t of effectiveTransitions(it.type, w)) {
      if (t.by !== "coordinator" || (t.from !== "*" && t.from !== it.status)) continue;
      for (const to of Array.isArray(t.to) ? t.to : [t.to]) {
        if (to !== it.status && to !== "Blocked") moves.add(to);
      }
    }
    if (moves.size)
      out.push({ issue: it.number, type: it.type, status: it.status, moves: [...moves] });
  }
  return out.sort((a, b) => a.issue - b.issue);
}

export type QueueReason = "ready_unassigned" | "rework" | "po_decision";

/** One line of `omi queue`: an Issue with its full title, current status and why it is there. */
export interface QueueRow {
  issue: number;
  title: string;
  type: IssueTypeV2;
  status: ProjectStatusV2;
  /** Every reason that applies (an Issue sent to Rework by the PO has `po_decision` and `rework`). */
  reasons: QueueReason[];
  /** The reasons in words. */
  reason: string;
}

const REASON_ORDER: QueueReason[] = ["ready_unassigned", "rework", "po_decision"];

/**
 * `omi queue`: the Coordinator's work, read from the fetched model, the snapshot of the last sync and
 * the decisions the last sync accepted and the Issues with an open run. Reasons: Ready with no open run
 * (unassigned), Rework, and a PO decision accepted by the last sync (a change the workflow does not
 * allow is reverted by `omi sync`, not work). One row per Issue, ordered by issue number. No I/O, no writes.
 */
export function workQueue(
  input: {
    items: readonly WorkItem[];
    titles: ReadonlyMap<number, string>;
    /** The PO decisions the last non-dry-run `omi sync` accepted (`planSync().poDecisions`). */
    poDecisions: readonly PoDecision[];
    openRunIssues: ReadonlySet<number>;
  },
  w: Workflow = loadDefaultWorkflow(),
): QueueRow[] {
  const byNumber = new Map(input.items.map((i) => [i.number, i]));
  const reasons = new Map<number, Map<QueueReason, string>>();
  const add = (issue: number, r: QueueReason, text: string) => {
    const m = reasons.get(issue) ?? new Map<QueueReason, string>();
    m.set(r, text);
    reasons.set(issue, m);
  };
  for (const e of coordinatorQueue(input.items, w)) {
    if (e.status === "Ready" && !input.openRunIssues.has(e.issue)) {
      add(e.issue, "ready_unassigned", "Ready, no open run");
    } else if (e.status === "Rework") {
      add(e.issue, "rework", "Rework: the PO sent it back");
    }
  }
  for (const d of input.poDecisions) {
    if (!byNumber.has(d.issue)) continue;
    add(d.issue, "po_decision", `PO decision: ${d.from} -> ${d.to} accepted by the last sync`);
  }
  return [...reasons.entries()]
    .sort(([a], [b]) => a - b)
    .map(([issue, m]) => {
      const it = byNumber.get(issue) as WorkItem;
      const kinds = REASON_ORDER.filter((r) => m.has(r));
      return {
        issue,
        title: input.titles.get(issue) ?? "",
        type: it.type,
        status: it.status,
        reasons: kinds,
        reason: kinds.map((r) => m.get(r) as string).join("; "),
      };
    });
}

export interface InboxRow {
  issue: number;
  title: string;
  type: IssueTypeV2;
}

export interface InboxGroup {
  status: InboxEntry["status"];
  items: InboxRow[];
}

/** `omi inbox`: items at a PO gate grouped by status (both groups always present), by issue number. */
export function poInboxGroups(
  items: readonly WorkItem[],
  titles: ReadonlyMap<number, string>,
  w: Workflow = loadDefaultWorkflow(),
): InboxGroup[] {
  const entries = poInbox(items, w);
  return (["Awaiting PO", "Acceptance"] as const).map((status) => ({
    status,
    items: entries
      .filter((e) => e.status === status)
      .map((e) => ({ issue: e.issue, title: titles.get(e.issue) ?? "", type: e.type })),
  }));
}

/** Items at a PO gate: open, in `Awaiting PO` or `Acceptance`. Ordered by issue number. */
export function poInbox(
  items: readonly WorkItem[],
  w: Workflow = loadDefaultWorkflow(),
): InboxEntry[] {
  return items
    .filter((it) => isLive(it, w) && (it.status === "Awaiting PO" || it.status === "Acceptance"))
    .map((it) => ({
      issue: it.number,
      type: it.type,
      status: it.status as InboxEntry["status"],
    }))
    .sort((a, b) => a.issue - b.issue);
}
