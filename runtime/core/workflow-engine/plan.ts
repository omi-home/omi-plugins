// Workflow composition (spec §10 workflow catalogue, DevTask-0026 #55): the CLI picks a small set
// of reusable stages from the Issue type and labels, never all eleven agents. Pure: no I/O.
import type { IssueType, Role } from "../contracts.ts";
import { OmiError } from "../errors/errors.ts";

export interface PlanInput {
  type: IssueType;
  labels: string[];
  /** OMI type of the parent Issue, when it has one in this repository. */
  parentType?: IssueType | null;
}

/** Executable Issue: engineer → checks → Code Review (→ Security) with the 2+2 review loop. */
export interface DeliveryPlan {
  kind: "delivery";
  workflow: "Feature Implementation" | "Bug Resolution" | "Refactor";
  engineer: Role;
  /** Security Reviewer runs after Code Review even if the reviewer does not ask for it. */
  security: boolean;
  /** Bug fix: the engineer's change must include a regression test. */
  regressionTest: boolean;
  /** Manual QA agent checks the acceptance criteria after release validation (PO, #56). */
  manualQa: boolean;
}

/** Requirement/container Issue without a worktree: analysts write their sections, PO decides. */
export interface AnalysisPlan {
  kind: "analysis";
  workflow: "Requirement Analysis" | "Change Request Analysis" | "Feature Analysis";
  analysts: Role[];
}

export type WorkflowPlan = DeliveryPlan | AnalysisPlan;

const ROLE_LABEL: Record<string, Role> = {
  "role:frontend": "frontend-engineer",
  "role:backend": "backend-engineer",
  "role:database": "database-engineer",
  "role:devops": "devops-engineer",
};

/** Labels that make the Security Reviewer mandatory (PO 2026-11-18). */
export const SECURITY_LABELS = ["risk:high", "security"];
/** Labels that add the Manual QA agent; Bug Resolution always has it (PO 2026-11-18, #56). */
export const MANUAL_QA_LABELS = ["ui", "qa:manual"];

export function planWorkflow(i: PlanInput): WorkflowPlan {
  const has = (l: string) => i.labels.includes(l);
  switch (i.type) {
    case "feature":
      return {
        kind: "analysis",
        workflow: "Feature Analysis",
        // UX only when the Feature touches a user interface.
        analysts: [
          "business-analyst",
          ...(has("ui") ? (["ui-ux-designer"] as Role[]) : []),
          "solution-architect",
        ],
      };
    case "change-request":
      return {
        kind: "analysis",
        workflow: "Change Request Analysis",
        analysts: ["business-analyst", "solution-architect"],
      };
    case "fr":
      return { kind: "analysis", workflow: "Requirement Analysis", analysts: ["business-analyst"] };
    case "nfr": // NFRs need an architecture answer (thresholds, design impact)
      return {
        kind: "analysis",
        workflow: "Requirement Analysis",
        analysts: ["business-analyst", "solution-architect"],
      };
    case "dev-task":
    case "test-task":
    case "devops-task":
    case "documentation-task": {
      const roles = i.labels.flatMap((l) => (ROLE_LABEL[l] ? [ROLE_LABEL[l]] : []));
      if (roles.length > 1) {
        throw new OmiError("TICKET_INVALID", `one role:* label expected, found ${roles.length}`);
      }
      const engineer: Role =
        i.type === "devops-task"
          ? "devops-engineer"
          : i.type === "test-task"
            ? "automation-qa-engineer"
            : (roles[0] ?? "backend-engineer");
      const bug = i.parentType === "bug";
      return {
        kind: "delivery",
        workflow: bug ? "Bug Resolution" : has("refactor") ? "Refactor" : "Feature Implementation",
        engineer,
        security: SECURITY_LABELS.some(has),
        regressionTest: bug,
        manualQa: bug || MANUAL_QA_LABELS.some(has),
      };
    }
    default:
      throw new OmiError(
        "POLICY_VIOLATION",
        i.type === "bug"
          ? "a Bug is fixed through a child DevTask: run that task"
          : `no OMI workflow runs ${i.type} issues`,
      );
  }
}
