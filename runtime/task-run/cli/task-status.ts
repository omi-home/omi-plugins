// `omi task status`: local state of one task run. No GitHub call.
import { existsSync } from "node:fs";
import { repo } from "../../shared/config.ts";
import { openState, statePath } from "../../shared/sqlite/db.ts";
import {
  type AttemptUsage,
  latestRun,
  ownedRefs,
  runUsage,
  transitions,
} from "../adapters/repository.ts";
import type { RunRow } from "../domain/run.ts";
import type { TaskDeps } from "./common.ts";

export interface TaskStatus {
  run: RunRow | null;
  worktree: { path: string; exists: boolean } | null;
  branch: string | null;
  transitions: ReturnType<typeof transitions>;
  /** Host-observed usage of each finished agent attempt (DevTask-0068 #203). */
  usage: AttemptUsage[];
}

/** Local state only: no GitHub call. */
export function taskStatus(deps: TaskDeps, issue: number): TaskStatus {
  const { config } = repo(deps.cwd);
  const db = openState(statePath(deps.cwd));
  try {
    const run = latestRun(db, {
      repository: `${config.github.owner}/${config.github.repo}`,
      number: issue,
    });
    if (!run) return { run: null, worktree: null, branch: null, transitions: [], usage: [] };
    const path = ownedRefs(db, run.id, "worktree")[0];
    return {
      run,
      worktree: path ? { path, exists: existsSync(path) } : null,
      branch: ownedRefs(db, run.id, "branch")[0] ?? null,
      transitions: transitions(db, run.id),
      usage: runUsage(db, run.id),
    };
  } finally {
    db.close();
  }
}
