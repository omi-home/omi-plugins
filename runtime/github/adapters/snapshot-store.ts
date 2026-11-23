// Reads and writes the previous-sync snapshot of a Project in state.sqlite (ADR-0005 D5).

import { parseContract } from "../../shared/contracts.ts";
import { type Db, sqliteError, tx } from "../../shared/sqlite/db.ts";
import {
  type SnapshotItem,
  SnapshotItem as SnapshotItemSchema,
} from "../domain/project-snapshot.ts";

interface Row {
  issue: number;
  status: string;
  state: string;
  close_reason: string | null;
}

/** The snapshot of the last sync of `repository` Project `project`, or null when none was written. */
export function readSnapshot(db: Db, repository: string, project: number): SnapshotItem[] | null {
  try {
    const meta = db
      .prepare("SELECT 1 AS x FROM project_snapshot WHERE repository = ? AND project = ?")
      .get(repository, project);
    if (!meta) return null;
    const rows = db
      .prepare(
        "SELECT issue, status, state, close_reason FROM project_snapshot_item WHERE repository = ? AND project = ? ORDER BY issue",
      )
      .all(repository, project) as unknown as Row[];
    return rows.map((r) =>
      parseContract(
        SnapshotItemSchema,
        {
          number: r.issue,
          status: r.status,
          state: r.state,
          ...(r.close_reason ? { closeReason: r.close_reason } : {}),
        },
        "stored snapshot",
      ),
    );
  } catch (e) {
    throw sqliteError(e, "read snapshot");
  }
}

/** Replaces the snapshot of the Project atomically (all items, or nothing). */
export function writeSnapshot(
  db: Db,
  repository: string,
  project: number,
  items: readonly SnapshotItem[],
  now: Date = new Date(),
): void {
  const valid = items.map((i) => parseContract(SnapshotItemSchema, i, "snapshot item"));
  tx(db, "write snapshot", () => {
    db.prepare("DELETE FROM project_snapshot WHERE repository = ? AND project = ?").run(
      repository,
      project,
    );
    db.prepare(
      "INSERT INTO project_snapshot (repository, project, synced_at) VALUES (?, ?, ?)",
    ).run(repository, project, now.toISOString());
    const ins = db.prepare(
      "INSERT INTO project_snapshot_item (repository, project, issue, status, state, close_reason) VALUES (?, ?, ?, ?, ?, ?)",
    );
    for (const i of valid) {
      ins.run(repository, project, i.number, i.status, i.state, i.closeReason ?? null);
    }
  });
}
