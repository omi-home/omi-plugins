// Planning of `omi move` and checks of `omi validate` for model v2 (Feature-0039 #298, ADR-0005 D2).
// Pure: reads the item model and the workflow, never GitHub.
import { IssueTypeV2, ProjectStatusV2 } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { loadDefaultWorkflow, type Workflow } from "../../shared/workflow.ts";
import type { FetchedIssue } from "./build-model.ts";
import type { ProjectModel, WorkItem } from "./project-model.ts";
import { type AppliedTransition, computeFixpoint, desiredIssueState } from "./workflow-engine.ts";
import { effectiveTransitions, statusesOf, transitionsBetween } from "./workflow-queries.ts";

/** One Project item to bring to `status` and to the open/closed state its status needs. */
export interface ItemWrite {
  issue: number;
  from: ProjectStatusV2;
  to: ProjectStatusV2;
  /** `close` (completed) or `reopen` when the Issue state must change; absent = keep. */
  stateChange?: "close" | "reopen";
}

export interface MovePlan {
  issue: number;
  from: ProjectStatusV2;
  to: ProjectStatusV2;
  /** Items to write, the moved item first, then the cascade leaves to root. */
  writes: ItemWrite[];
  /** `auto` transitions the move set off (for the report). */
  cascade: AppliedTransition[];
}

/** Statuses the Coordinator may move `type` from `from` to (including the implicit `* → Blocked`). */
export function coordinatorTargets(
  type: IssueTypeV2,
  from: ProjectStatusV2,
  w: Workflow = loadDefaultWorkflow(),
): ProjectStatusV2[] {
  const seen = new Set<ProjectStatusV2>();
  for (const t of effectiveTransitions(type, w)) {
    if (t.by !== "coordinator" || (t.from !== "*" && t.from !== from)) continue;
    for (const to of Array.isArray(t.to) ? t.to : [t.to]) if (to !== from) seen.add(to);
  }
  return ProjectStatusV2.options.filter((s) => seen.has(s));
}

const stateChangeOf = (
  it: WorkItem,
  status: ProjectStatusV2,
  w: Workflow,
): ItemWrite["stateChange"] => {
  // Closed as not planned stays closed whatever the status shows.
  if (it.state === "closed" && it.closeReason === "not_planned") return undefined;
  const want = desiredIssueState(it.type, status, w).state;
  return want === it.state ? undefined : want === "closed" ? "close" : "reopen";
};

/**
 * Validates `omi move <issue> <to>` and computes what to write. Only a `by: coordinator` transition is
 * moved: `by: po` is refused (INVALID_TRANSITION, reason PO_DECISION), as is `by: auto` (AUTO_ONLY, `sync`
 * applies it) and a transition that does not exist (TRANSITION_UNKNOWN); the details list the valid
 * targets. Moving to the status the item already has is a valid no-op. Then the `auto` rules run to a
 * fixpoint on the changed model; only items whose final status differs from what a sync of the
 * current model would give anyway are written, so a move never applies unrelated pending rules.
 */
export function planMove(
  model: ProjectModel,
  issue: number,
  to: ProjectStatusV2,
  w: Workflow = loadDefaultWorkflow(),
): MovePlan {
  const it = model.find((i) => i.number === issue);
  if (!it)
    throw new OmiError("TICKET_NOT_IN_PROJECT", `#${issue} is not an item of the Project model`);
  const valid = coordinatorTargets(it.type, it.status, w);
  const refuse = (reason: string, message: string): never => {
    throw new OmiError("INVALID_TRANSITION", message, {
      reason,
      issue,
      type: it.type,
      from: it.status,
      to,
      validTargets: valid,
    });
  };
  if (it.state === "closed" && it.closeReason === "not_planned") {
    refuse("CLOSED_NOT_PLANNED", `#${issue} is closed as not planned; reopen it on GitHub first`);
  }
  if (to !== it.status) {
    const found = transitionsBetween(it.type, it.status, to, w);
    if (!found.length) {
      refuse(
        "TRANSITION_UNKNOWN",
        `${it.type} #${issue}: ${it.status} -> ${to} is not a transition (valid: ${valid.join(", ") || "none"})`,
      );
    }
    if (!found.some((t) => t.by === "coordinator")) {
      if (found.some((t) => t.by === "po")) {
        refuse(
          "PO_DECISION",
          `${it.type} #${issue}: ${it.status} -> ${to} is a PO decision; omi does not fake PO decisions (valid: ${valid.join(", ") || "none"})`,
        );
      }
      refuse(
        "AUTO_ONLY",
        `${it.type} #${issue}: ${it.status} -> ${to} is applied by omi sync when its conditions hold (valid: ${valid.join(", ") || "none"})`,
      );
    }
  }
  const baseline = new Map(computeFixpoint(model, w).items.map((i) => [i.number, i.status]));
  const moved = model.map((i) => (i.number === issue ? { ...i, status: to } : i));
  const fx = computeFixpoint(moved, w);
  const byNumber = new Map(model.map((i) => [i.number, i]));
  const writes: ItemWrite[] = [];
  const touched = new Set<number>();
  for (const f of fx.items) {
    const orig = byNumber.get(f.number) as WorkItem;
    const wanted = f.number === issue || f.status !== baseline.get(f.number);
    if (!wanted || f.status === orig.status) continue;
    touched.add(f.number);
    const stateChange = stateChangeOf(orig, f.status, w);
    writes.push({
      issue: f.number,
      from: orig.status,
      to: f.status,
      ...(stateChange ? { stateChange } : {}),
    });
  }
  // The moved item first, the rest leaves to root (by their order in the fixpoint's applied list).
  const order = new Map<number, number>();
  fx.applied.forEach((a, i) => {
    if (!order.has(a.item)) order.set(a.item, i);
  });
  writes.sort(
    (a, b) =>
      Number(b.issue === issue) - Number(a.issue === issue) ||
      (order.get(a.issue) ?? 0) - (order.get(b.issue) ?? 0) ||
      a.issue - b.issue,
  );
  // A no-op move can still have to fix the open/closed state of the item itself.
  if (!touched.has(issue)) {
    const stateChange = stateChangeOf(it, it.status, w);
    if (stateChange && to === it.status) {
      writes.unshift({ issue, from: it.status, to, stateChange });
    }
  }
  return {
    issue,
    from: it.status,
    to,
    writes,
    cascade: fx.applied.filter((a) => touched.has(a.item) && a.item !== issue),
  };
}

export type FindingKind =
  | "invalid_type"
  | "invalid_status"
  | "status_not_allowed"
  | "state_mismatch"
  | "auto_pending";

export interface Finding {
  kind: FindingKind;
  issue: number;
  message: string;
  details?: Record<string, unknown>;
}

export interface ValidateReport {
  findings: Finding[];
  /** Issues left out of the model (no issue type): reported, not an error. */
  skipped: { number: number; reason: string }[];
}

/**
 * `omi validate` checks over what the fetch read (ChangeRequest-0013 #302 §5.2, §9.4): a status that
 * is not valid for the Issue's type, an open/closed state that disagrees with the status, and `auto`
 * transitions waiting to be applied. A closed-as-not-planned Issue may show any status.
 * `build` turns the sanitized fetched issues into the model (bad type/status never reach it).
 */
export function validateFetched(
  fetched: readonly FetchedIssue[],
  build: (items: FetchedIssue[]) => { items: ProjectModel; skipped: ValidateReport["skipped"] },
  w: Workflow = loadDefaultWorkflow(),
): ValidateReport {
  const findings: Finding[] = [];
  const clean: FetchedIssue[] = [];
  // Items with an unknown status get the type's initial status in the model: not judged further.
  const unjudged = new Set<number>();
  for (const f of fetched) {
    if (f.type !== null && !IssueTypeV2.safeParse(f.type).success) {
      findings.push({
        kind: "invalid_type",
        issue: f.number,
        message: `#${f.number}: issue type '${f.type}' is not one of ${IssueTypeV2.options.join(", ")}`,
      });
      continue;
    }
    if (f.type !== null && f.status !== null) {
      const type = IssueTypeV2.parse(f.type);
      const status = ProjectStatusV2.safeParse(f.status);
      if (!status.success) {
        findings.push({
          kind: "invalid_status",
          issue: f.number,
          message: `#${f.number}: status '${f.status}' is not one of ${ProjectStatusV2.options.join(", ")}`,
        });
        unjudged.add(f.number);
        clean.push({ ...f, status: null });
        continue;
      }
      const allowed = statusesOf(type, w);
      if (!allowed.includes(status.data)) {
        findings.push({
          kind: "status_not_allowed",
          issue: f.number,
          message: `${type} #${f.number}: status '${status.data}' is not valid for ${type} (valid: ${allowed.join(", ")})`,
          details: { type, status: status.data, allowed },
        });
      }
    }
    clean.push(f);
  }
  const { items, skipped } = build(clean);
  for (const it of items) {
    if (unjudged.has(it.number)) continue;
    if (it.state === "closed" && it.closeReason === "not_planned") continue;
    const want = desiredIssueState(it.type, it.status, w).state;
    if (want !== it.state) {
      findings.push({
        kind: "state_mismatch",
        issue: it.number,
        message: `${it.type} #${it.number}: status '${it.status}' needs the Issue ${want}, it is ${it.state}`,
        details: { status: it.status, state: it.state, expected: want },
      });
    }
  }
  for (const a of computeFixpoint(items, w).applied) {
    if (unjudged.has(a.item)) continue;
    findings.push({
      kind: "auto_pending",
      issue: a.item,
      message: `${a.type} #${a.item}: auto transition ${a.from} -> ${a.to} is waiting to be applied (omi sync)`,
      details: { from: a.from, to: a.to },
    });
  }
  findings.sort((a, b) => a.issue - b.issue);
  return { findings, skipped };
}
