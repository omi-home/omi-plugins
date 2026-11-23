// Ports of the delivery workflow (slice.ts): what it needs from the outside, as interfaces. The
// adapters (`../adapters/`, the harness, reporting, handoff) are handed in by the composition root;
// the workflow never imports them (ADR-0006: application → adapter only through a port).
import type { OmiConfig } from "../../shared/config.ts";
import type {
  ArtifactKind,
  IssueRef,
  ReportCategory,
  Role,
  StepComment,
  StepResult,
  TaskPacket,
  WorkflowContext,
} from "../../shared/contracts.ts";
import type { ErrorCode } from "../../shared/errors/errors.ts";
import type { GhRunner } from "../../shared/github/client.ts";
import type { Db } from "../../shared/sqlite/db.ts";
import type { RunFindings } from "../domain/findings.ts";
import type { Policy, WorkflowEvent } from "../domain/fsm.ts";
import type { GateResult, RunRow, SkillChoice, StepRow } from "../domain/run.ts";

/** Persistence of runs, steps, attempts, artifacts and queued reports (repository adapter). */
export interface RunStore {
  runContext(db: Db, runId: string): WorkflowContext;
  advanceRun(
    db: Db,
    runId: string,
    event: WorkflowEvent,
    policy?: Policy,
  ): { run: RunRow; context: WorkflowContext };
  /** Open findings of the run, persisted so a resumed `task run` starts from them (Bug-0013 #392). */
  runFindings(db: Db, runId: string): RunFindings;
  saveRunFindings(db: Db, runId: string, findings: RunFindings): void;
  startStep(db: Db, o: { runId: string; stepId: string; round: number; role: Role }): StepRow;
  stepResult(db: Db, id: number): StepResult;
  beginAttempt(
    db: Db,
    stepRunId: number,
    choice?: {
      profile?: string;
      model?: string;
      effort?: string;
      reason?: string;
      skills?: string[];
    },
  ): number;
  failAttempt(db: Db, o: { stepRunId: number; attempt: number; errorCode: ErrorCode }): void;
  persistStepResult(
    db: Db,
    o: {
      stepRunId: number;
      attempt: number;
      result: StepResult;
      actualModel: string | null;
      report: { marker: string; body: string };
    },
  ): void;
  addArtifact(
    db: Db,
    o: { runId: string; stepRunId?: number; kind: ArtifactKind; path: string; sha256?: string },
  ): void;
  enqueueReport(
    db: Db,
    o: { runId: string; marker: string; body: string; target?: IssueRef },
  ): void;
}

/** Git in a worktree: stdout of `git <args>`, trimmed; throws on failure. */
export type GitPort = (args: string[], cwd: string) => string;

export interface RoleFilesPort {
  stepSkills(
    pluginRoot: string,
    step: { role: Role; stepId: string; round: number },
    choice?: SkillChoice,
  ): string[];
  writeRoleFiles(o: {
    taskRoot: string;
    pluginRoot: string;
    role: Role;
    category: ReportCategory;
    edits: boolean;
    repo: string;
    skills?: string[];
    checks?: string[];
  }): void;
}

export interface ChecksPort {
  runChecks(o: {
    worktree: string;
    checks: OmiConfig["checks"];
    architecture?: OmiConfig["architecture"];
    pluginRoot?: string;
    logDir: string;
    env?: NodeJS.ProcessEnv;
  }): { passed: boolean; results: GateResult[] };
}

export interface CommitInfo {
  /** Issue type label (`dev-task`, `bug`, …). */
  type: string;
  title: string;
  issue: number;
  round: number;
  attempt: number;
  stepId: string;
  /** Short name of the role, used as the commit scope. */
  scope: string;
  /** Model the host observed, for the attribution line. */
  model: string;
}

/** The runtime commits an implementing step's work; the new SHA, or null when nothing changed. */
export type CommitPort = (worktree: string, info: CommitInfo) => string | null;

/** Renders and posts the reports of a run (reporting). */
export interface ReportPort {
  render(comment: StepComment): string;
  /** Posts every pending report of the run; a failure leaves them pending. */
  publish(db: Db, runId: string, o: { gh: GhRunner }): number;
}

/** The Issue and its parents as the task packet carries them (handoff). */
export interface IssueContextPort {
  fetchIssueContext(
    config: OmiConfig,
    number: number,
    run?: GhRunner,
  ): Pick<TaskPacket, "issueContext" | "carriedFindings">;
}

export interface SlicePorts {
  store: RunStore;
  git: GitPort;
  roleFiles: RoleFilesPort;
  checks: ChecksPort;
  commit: CommitPort;
  reports: ReportPort;
  issueContext: IssueContextPort;
}
