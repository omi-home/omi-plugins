// Queries derived from a resolved workflow (ADR-0005 D2/D5, DevTask-0099 #308). The schema, merge and
// loader live in shared/workflow.ts. Pure: no GitHub reads, no predicate evaluation (Feature-0039 #298).
import { type IssueTypeV2, ProjectStatusV2 } from "../../shared/contracts.ts";
import {
  loadDefaultWorkflow,
  type Transition,
  type TransitionBy,
  type Workflow,
} from "../../shared/workflow.ts";

const targets = (t: Transition): ProjectStatusV2[] => (Array.isArray(t.to) ? t.to : [t.to]);

/** Statuses `type` may show: its initial status, `blocked_returns_to` and every one a transition names. */
export function statusesOf(
  type: IssueTypeV2,
  w: Workflow = loadDefaultWorkflow(),
): ProjectStatusV2[] {
  const flow = w.types[type];
  const seen = new Set<ProjectStatusV2>([flow.initial]);
  if (flow.blocked_returns_to) seen.add("Blocked");
  for (const t of flow.transitions) {
    if (t.from !== "*") seen.add(t.from);
    for (const to of targets(t)) seen.add(to);
  }
  return ProjectStatusV2.options.filter((s) => seen.has(s));
}

/** The status a new Issue of `type` starts in. */
export const initialStatus = (type: IssueTypeV2, w: Workflow = loadDefaultWorkflow()) =>
  w.types[type].initial;

const matching = (list: Transition[], from: ProjectStatusV2, to: ProjectStatusV2) =>
  list.filter((t) => (t.from === "*" || t.from === from) && targets(t).includes(to));

/**
 * Explicit transitions plus the implicit Blocked ones: into Blocked from every status that does not
 * close the Issue (coordinator), and out of it to `blocked_returns_to` (auto, blockers_done) unless
 * the type declares a transition from Blocked (the explicit one wins).
 */
export function effectiveTransitions(
  type: IssueTypeV2,
  w: Workflow = loadDefaultWorkflow(),
): Transition[] {
  const flow = w.types[type];
  const out = [...flow.transitions];
  const back = flow.blocked_returns_to;
  if (!back) return out;
  const open = statusesOf(type, w).filter((s) => s !== "Blocked" && !w.closed_states.includes(s));
  for (const from of open) {
    if (!matching(out, from, "Blocked").length) {
      out.push({ from, to: "Blocked", by: "coordinator" });
    }
  }
  if (!out.some((t) => t.from === "Blocked")) {
    out.push({ from: "Blocked", to: back, by: "auto", when: [{ blockers_done: true }] });
  }
  return out;
}

/** Transitions of `type` that take `from` to `to` (`from: "*"` matches every status). */
export function transitionsBetween(
  type: IssueTypeV2,
  from: ProjectStatusV2,
  to: ProjectStatusV2,
  w: Workflow = loadDefaultWorkflow(),
): Transition[] {
  if (from === to) return [];
  return matching(effectiveTransitions(type, w), from, to);
}

/** Whether `by` may move an Issue of `type` from `from` to `to`. */
export const canTransition = (
  type: IssueTypeV2,
  from: ProjectStatusV2,
  to: ProjectStatusV2,
  by: TransitionBy,
  w: Workflow = loadDefaultWorkflow(),
): boolean => transitionsBetween(type, from, to, w).some((t) => t.by === by);

/** Whether `status` closes the Issue on GitHub, unless `type` is in `never_close`. */
export const closesIssue = (
  type: IssueTypeV2,
  status: ProjectStatusV2,
  w: Workflow = loadDefaultWorkflow(),
): boolean => w.closed_states.includes(status) && !w.never_close.includes(type);
