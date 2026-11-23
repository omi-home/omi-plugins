// Builds the item model of model v2 from what the fetch read (DevTask-0124 #369, ADR-0005 D2/D4).
// Pure: the adapter reads GitHub into `FetchedIssue`; this turns it into a validated `ProjectModel`.
import { IssueTypeV2, ProjectStatusV2, parseContract } from "../../shared/contracts.ts";
import { loadDefaultWorkflow, type Workflow } from "../../shared/workflow.ts";
import { type LinkedPr, type ProjectModel, parseProjectModel } from "./project-model.ts";

export interface FetchedBlocker {
  /** `owner/repo#n`. */
  ref: string;
  /** Issue number when the blocker is in the repository of the Project's items, else null. */
  number: number | null;
  closed: boolean;
  completed: boolean;
}

/** One Project Issue as the fetch read it; names are raw GitHub strings, validated here. */
export interface FetchedIssue {
  number: number;
  /** Full Issue title (read by `omi queue` / `omi inbox`; not part of the item model). */
  title?: string;
  /** Native issue type name; null when the Issue has none. */
  type: string | null;
  /** Project Status option name; null when the item has no Status value. */
  status: string | null;
  state: "open" | "closed";
  stateReason: "completed" | "not_planned" | "reopened" | null;
  parent: number | null;
  children: number[];
  blockedBy: FetchedBlocker[];
  labels: string[];
  milestone: number | null;
  prs: LinkedPr[];
}

export interface SkippedItem {
  number: number;
  reason: string;
}

export interface BuiltModel {
  items: ProjectModel;
  /** Issues left out of the model, with the reason (reported, never silent). */
  skipped: SkippedItem[];
}

/**
 * Rules: an Issue without a native type is skipped (`no issue type`); an Issue without a Status value
 * gets its type's `initial` status; an unknown type or Status name is CONTRACT_INVALID. A blocker that
 * is not an item of the model (another repository, or not in the Project) becomes an
 * `externalBlockers` entry, done when it is closed as completed. `closedByMergedPr` holds when the
 * Issue is closed and a linked PR is merged.
 */
export function buildProjectModel(
  fetched: readonly FetchedIssue[],
  w: Workflow = loadDefaultWorkflow(),
): BuiltModel {
  const skipped: SkippedItem[] = [];
  const kept = fetched.filter((f) => {
    if (f.type !== null) return true;
    skipped.push({ number: f.number, reason: "no issue type" });
    return false;
  });
  const inModel = new Set(kept.map((f) => f.number));
  const raw = kept.map((f) => {
    const type = parseContract(
      IssueTypeV2,
      f.type,
      `issue type of #${f.number}`,
      "CONTRACT_INVALID",
    );
    const status =
      f.status === null
        ? w.types[type].initial
        : parseContract(ProjectStatusV2, f.status, `status of #${f.number}`, "CONTRACT_INVALID");
    const local = f.blockedBy.filter((b) => b.number !== null && inModel.has(b.number));
    const external = f.blockedBy.filter((b) => !local.includes(b));
    return {
      number: f.number,
      type,
      status,
      state: f.state,
      ...(f.state === "closed" && f.stateReason !== null && f.stateReason !== "reopened"
        ? { closeReason: f.stateReason }
        : {}),
      closedByMergedPr: f.state === "closed" && f.prs.some((p) => p.state === "merged"),
      parent: f.parent,
      children: f.children,
      blockedBy: local.map((b) => b.number as number),
      externalBlockers: external.map((b) => ({ ref: b.ref, done: b.closed && b.completed })),
      labels: f.labels,
      linkedPrs: f.prs,
      milestone: f.milestone,
    };
  });
  return { items: parseProjectModel(raw), skipped };
}
