// Pure queries over the item model for `omi sync` (report), `omi queue` and `omi inbox` (Feature-0039
// #298): what the Coordinator has to do and what waits for the PO. No I/O.
import type { IssueTypeV2, ProjectStatusV2 } from "../../shared/contracts.ts";
import { loadDefaultWorkflow, type Workflow } from "../../shared/workflow.ts";
import type { WorkItem } from "./project-model.ts";
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
