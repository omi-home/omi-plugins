// Workflow composition (spec §10 workflow catalogue, DevTask-0026 #55): the CLI picks a small set
// of reusable stages from the Issue type and labels, never every agent. A delivery plan never picks the Business Analyst or Solution Architect: only the analysis plan of `omi task analyze` does. Pure: no I/O.
import type { IssueType, IssueTypeV2, Role } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";

/** Model v2 types that own a run (DevTask-0132 #383); every other native type is refused. */
export const EXECUTABLE_V2 = ["DesignTask", "DevTask", "QATask"] as const;
export type ExecutableV2 = (typeof EXECUTABLE_V2)[number];
export const isExecutableV2 = (t: string | undefined): t is ExecutableV2 =>
  EXECUTABLE_V2.includes(t as ExecutableV2);

/**
 * The legacy type a v2 run is recorded under (the run table stores a legacy `IssueType`; a
 * DesignTask has no legacy peer and reuses `dev-task`). `spike` stays a DevTask with a label.
 */
export const RUN_TYPE_OF_V2: Record<ExecutableV2, IssueType> = {
  DesignTask: "dev-task",
  DevTask: "dev-task",
  QATask: "test-task",
};

export interface PlanInput {
  type: IssueType | IssueTypeV2;
  labels: string[];
  /** OMI type of the parent Issue, when it has one in this repository (`bug` / `Bug` for a Bug). */
  parentType?: IssueType | IssueTypeV2 | null;
  /** Label of a Test design QATask (`qa.designLabel` of the config). */
  qaDesignLabel?: string;
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
  /** QA Engineer agent checks the acceptance criteria after release validation (PO, #56). */
  manualQa: boolean;
}

/** Requirement/container Issue without a worktree: analysts write their sections, PO decides. */
export interface AnalysisPlan {
  kind: "analysis";
  workflow: "Requirement Analysis" | "Change Request Analysis" | "Feature Analysis" | "Design";
  analysts: Role[];
}

/**
 * DesignTask (DevTask-0132 #383): one read-only UI/UX Designer step; its `design` section goes into
 * the Issue body, then `omi move <n> "In review"`. No commit, no PR; the Coordinator approves.
 */
export interface DesignPlan {
  kind: "design";
  workflow: "Design";
  designer: Role;
}

/**
 * QATask (DevTask-0134 #385): one read-only QA Engineer step, no commit, no PR, no review.
 * `test-design` writes the TC table; `verify` (also a Bug's Retest) reports `Run #k`.
 */
export interface QaPlan {
  kind: "qa";
  workflow: "QA Test Design" | "QA Verify";
  mode: "test-design" | "verify";
  /** Verify of a Bug (Retest): the parent's `Steps to reproduce` replace the TC table. */
  retest: boolean;
}

export type WorkflowPlan = DeliveryPlan | AnalysisPlan | QaPlan | DesignPlan;

/** The read-only analysis form of a design plan, run by the shared analyst loop. */
export const designAsAnalysis = (p: DesignPlan): AnalysisPlan => ({
  kind: "analysis",
  workflow: "Design",
  analysts: [p.designer],
});

const ROLE_LABEL: Record<string, Role> = {
  "role:frontend": "software-engineer",
  "role:backend": "software-engineer",
  "role:database": "software-engineer",
  "role:devops": "software-engineer",
};

export const DEFAULT_QA_DESIGN_LABEL = "qa:test-design";

/** Labels that make the Security Reviewer mandatory (PO 2026-11-18). */
export const SECURITY_LABELS = ["risk:high", "security"];
/** Labels that add the QA Engineer agent; Bug Resolution always has it (PO 2026-11-18, #56). */
export const MANUAL_QA_LABELS = ["ui", "qa:manual"];

export function planWorkflow(i: PlanInput): WorkflowPlan {
  const has = (l: string) => i.labels.includes(l);
  const parentIsBug = i.parentType === "bug" || i.parentType === "Bug";
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
    case "DesignTask":
      return { kind: "design", workflow: "Design", designer: "ui-ux-designer" };
    case "test-task":
    case "QATask": {
      const design = i.labels.includes(i.qaDesignLabel ?? DEFAULT_QA_DESIGN_LABEL);
      return design
        ? { kind: "qa", workflow: "QA Test Design", mode: "test-design", retest: false }
        : { kind: "qa", workflow: "QA Verify", mode: "verify", retest: parentIsBug };
    }
    case "dev-task":
    case "DevTask": // a `spike` label keeps it a DevTask (ADR-0005 D7)
    case "devops-task":
    case "documentation-task": {
      const roles = i.labels.flatMap((l) => (ROLE_LABEL[l] ? [ROLE_LABEL[l]] : []));
      if (roles.length > 1) {
        throw new OmiError("TICKET_INVALID", `one role:* label expected, found ${roles.length}`);
      }
      // PO 2026-11-23: role:* labels stay accepted; every executable type maps to one of two roles.
      const engineer: Role = "software-engineer";
      const bug = parentIsBug;
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
        i.type === "bug" || i.type === "Bug"
          ? "a Bug is fixed through a child DevTask and a child QATask: run one of those"
          : `no OMI workflow runs ${i.type} issues`,
      );
  }
}
