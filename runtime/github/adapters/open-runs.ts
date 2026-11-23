// Read-only: the Issues of a repository that have an open run in state.sqlite (a run not COMPLETED,
// FAILED or CANCELLED). `omi queue` uses it to tell a Ready Issue nobody has taken from one in work.
import { type Db, sqliteError } from "../../shared/sqlite/db.ts";

export function openRunIssues(db: Db, repository: string): Set<number> {
  try {
    const rows = db
      .prepare(
        "SELECT DISTINCT issue FROM workflow_run WHERE repository = ? AND state NOT IN ('COMPLETED', 'CANCELLED', 'FAILED')",
      )
      .all(repository) as unknown as { issue: number }[];
    return new Set(rows.map((r) => Number(r.issue)));
  } catch (e) {
    throw sqliteError(e, "read open runs");
  }
}
