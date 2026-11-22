// Run model types shared by the task-run ports (application/) and their adapters (adapters/).
import type {
  CheckOutcome,
  GateCheck,
  IssueType,
  Role,
  StepState,
  WorkflowState,
} from "../../shared/contracts.ts";

export interface RunRow {
  id: string;
  repository: string;
  issue: number;
  /** ponytail: the run's workflow is its OMI Issue type until the workflow catalogue (spec §10) composes stages. */
  workflow: IssueType;
  state: WorkflowState;
}

export interface StepRow {
  id: number;
  runId: string;
  stepId: string;
  round: number;
  state: StepState;
}

/** Skills chosen per role (`--skills <role>=<a>,<b>`) and the one-line reason (DevTask-0065 #199). */
export interface SkillChoice {
  byRole: Partial<Record<Role, string[]>>;
  reason: string;
}

export interface GateResult {
  name: GateCheck;
  outcome: CheckOutcome;
  exitCode: number | null;
  durationMs: number;
  /** Last lines of output, redacted and bounded by SUMMARY_CHARS. */
  summary: string;
  /** Full output, kept for the run's evidence; null when skipped. */
  logPath: string | null;
}
