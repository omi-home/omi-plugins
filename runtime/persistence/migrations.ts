// Forward-only migrations tracked in PRAGMA user_version. Each runs in its own transaction:
// a failing migration leaves the database at the previous version. Never edit a released entry.
// Enum columns carry no CHECK: the typed repository is the single writer (contracts.ts enums).
import type { DatabaseSync } from "node:sqlite";
import { OmiError } from "../core/errors/errors.ts";

export const MIGRATIONS: readonly string[] = [
  // 1 — initial state model (idea §10, §12, §13, §14)
  `
  CREATE TABLE workflow_run (
    id          TEXT PRIMARY KEY,
    repository  TEXT NOT NULL,
    issue       INTEGER NOT NULL,
    workflow    TEXT NOT NULL,
    state       TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL
  );
  -- One live run per Issue: two sessions cannot drive the same ticket.
  CREATE UNIQUE INDEX workflow_run_one_live_per_issue ON workflow_run (repository, issue)
    WHERE state NOT IN ('COMPLETED', 'FAILED', 'CANCELLED');

  CREATE TABLE transition (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES workflow_run (id),
    from_state  TEXT,
    to_state    TEXT NOT NULL,
    event       TEXT NOT NULL,
    at          TEXT NOT NULL
  );
  CREATE INDEX transition_by_run ON transition (run_id, id);

  CREATE TABLE review_round (
    run_id      TEXT NOT NULL REFERENCES workflow_run (id),
    round       INTEGER NOT NULL CHECK (round BETWEEN 1 AND 4),
    outcome     TEXT,
    created_at  TEXT NOT NULL,
    PRIMARY KEY (run_id, round)
  );

  CREATE TABLE step_run (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES workflow_run (id),
    step_id     TEXT NOT NULL,
    round       INTEGER NOT NULL CHECK (round BETWEEN 1 AND 4),
    role        TEXT NOT NULL,
    state       TEXT NOT NULL,
    result      TEXT,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    UNIQUE (run_id, step_id, round)
  );

  -- Technical retries of one step in one round; never a review round.
  CREATE TABLE step_attempt (
    step_run_id   INTEGER NOT NULL REFERENCES step_run (id),
    attempt       INTEGER NOT NULL CHECK (attempt >= 1),
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    error_code    TEXT,
    actual_model  TEXT,
    PRIMARY KEY (step_run_id, attempt)
  );

  CREATE TABLE artifact (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES workflow_run (id),
    step_run_id INTEGER REFERENCES step_run (id),
    kind        TEXT NOT NULL,
    path        TEXT NOT NULL,
    sha256      TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE resource_owner (
    id          INTEGER PRIMARY KEY,
    run_id      TEXT NOT NULL REFERENCES workflow_run (id),
    kind        TEXT NOT NULL,
    ref         TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    released_at TEXT
  );
  -- A live resource (worktree, branch, process...) has exactly one owner.
  CREATE UNIQUE INDEX resource_owner_one_live ON resource_owner (kind, ref)
    WHERE released_at IS NULL;

  CREATE TABLE outbox (
    id           INTEGER PRIMARY KEY,
    run_id       TEXT NOT NULL REFERENCES workflow_run (id),
    step_run_id  INTEGER REFERENCES step_run (id),
    marker       TEXT NOT NULL UNIQUE,
    body         TEXT NOT NULL,
    state        TEXT NOT NULL,
    comment_id   TEXT,
    comment_url  TEXT,
    created_at   TEXT NOT NULL,
    posted_at    TEXT
  );

  CREATE TABLE lease (
    key         TEXT PRIMARY KEY,
    holder      TEXT NOT NULL,
    expires_at  INTEGER NOT NULL
  );
  `,
];

export function migrate(db: DatabaseSync, migrations: readonly string[] = MIGRATIONS): number {
  const version = () => Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version() > migrations.length) {
    throw new OmiError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `state database is version ${version()}, this OMI supports ${migrations.length}: upgrade OMI`,
    );
  }
  while (version() < migrations.length) {
    const next = version() + 1;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check under the write lock: another process may have migrated meanwhile.
      if (version() < next) {
        db.exec(migrations[next - 1] as string);
        db.exec(`PRAGMA user_version = ${next}`);
      }
      db.exec("COMMIT");
    } catch (e) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw new OmiError("INTERNAL", `state migration ${next} failed`, {
        sqlite: (e as Error).message,
      });
    }
  }
  return version();
}
