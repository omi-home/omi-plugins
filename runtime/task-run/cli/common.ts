// Shared by the `omi task` / `omi ticket` subcommands of this module: the deps every one takes,
// lease lengths, the Issue type reads and the env of the repo's check/setup commands.
import {
  keyEnvName,
  loadProfiles,
  readLegacyProfiles,
} from "../../profile/adapters/profile-config.ts";
import { secretEnv } from "../../profile/domain/selection.ts";
import type { WorkflowEventType } from "../../shared/contracts.ts";
import type { GhRunner } from "../../shared/github/client.ts";
import { commandEnv } from "../../shared/process/command-env.ts";
import type { Db } from "../../shared/sqlite/db.ts";
import { advanceRun } from "../adapters/repository.ts";
import type { ReportPort } from "../application/ports.ts";
import type { RunRow } from "../domain/run.ts";

/**
 * Env of the repo's check/setup commands: the host's without the master key and any auth variable,
 * including the token variables the machine's profiles name (ARC-001).
 */
export function commandEnvFor(workspace: string, host: NodeJS.ProcessEnv): Record<string, string> {
  const tokenEnvs: string[] = [];
  try {
    tokenEnvs.push(...loadProfiles(workspace).map(secretEnv));
  } catch {
    // a legacy file is still declared: its variables are dropped below
  }
  try {
    const legacy = readLegacyProfiles(workspace);
    for (const p of [...(legacy.json?.profiles ?? []), ...(legacy.yaml?.profiles ?? [])]) {
      tokenEnvs.push(secretEnv(p));
    }
  } catch {
    // an unreadable legacy file declares nothing usable
  }
  return commandEnv(host, { keyEnv: keyEnvName(workspace), tokenEnvs });
}

export interface TaskDeps {
  cwd: string;
  gh?: GhRunner;
  /** Identifies this CLI invocation for the per-Issue start lease. */
  session?: string;
  /** Host env (tests); default `process.env`. */
  hostEnv?: NodeJS.ProcessEnv;
}

/** Commands that render and post reports take the reporting adapter from the composition root. */
export interface ReportDeps {
  reports: ReportPort;
}

export const START_LEASE_MS = 10 * 60_000;
/** A whole review loop may run several agents back to back. */
export const RUN_LEASE_MS = 6 * 60 * 60_000;

export function step(
  db: Db,
  r: RunRow,
  type: Exclude<WorkflowEventType, "TECHNICAL_FAILURE">,
): RunRow {
  return advanceRun(db, r.id, { type }).run;
}
