// The Issues of a repository that have an open run (not COMPLETED, FAILED or CANCELLED): task-run's own
// definition of "open", exposed so `omi queue` (github module) can be handed the set by the entrypoint.
import type { Db } from "../../shared/sqlite/db.ts";
import { openRuns } from "../adapters/repository.ts";

export function openRunIssues(repository: string, db: Db): Set<number> {
  return new Set(
    openRuns(db)
      .filter((r) => r.repository === repository)
      .map((r) => r.issue),
  );
}
