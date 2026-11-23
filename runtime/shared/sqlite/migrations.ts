// Forward-only migrations tracked in PRAGMA user_version. Each runs in its own transaction:
// a failing migration leaves the database at the previous version. Never edit a released entry.
// Enum columns carry no CHECK: the typed repository is the single writer (contracts.ts enums).
import type { DatabaseSync } from "node:sqlite";
import { OmiError } from "../errors/errors.ts";

export const MIGRATIONS: readonly string[] = [
  // 1 — initial state model (spec §10, §12, §13, §14)
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
  // 2 — outbox target when a report goes to another Issue (carried findings, spec §12); null = run's Issue
  `
  ALTER TABLE outbox ADD COLUMN repository TEXT;
  ALTER TABLE outbox ADD COLUMN issue INTEGER;
  `,
  // 3 — durable FSM context (rounds, budgets, resume point) next to the state (T3.5, #25 CR-001)
  `
  ALTER TABLE workflow_run ADD COLUMN context TEXT;
  `,
  // 4 — host-observed usage (TokenUsage JSON) of each finished attempt (DevTask-0068 #203)
  `
  ALTER TABLE step_attempt ADD COLUMN usage TEXT;
  `,
  // 5 — execution choice of each attempt (profile/model/effort/reason, DevTask-0074 #217); null = routing
  `
  ALTER TABLE step_attempt ADD COLUMN profile TEXT;
  ALTER TABLE step_attempt ADD COLUMN requested_model TEXT;
  ALTER TABLE step_attempt ADD COLUMN requested_effort TEXT;
  ALTER TABLE step_attempt ADD COLUMN reason TEXT;
  `,
  // 6 — skills installed for each attempt (JSON array, DevTask-0065 #199)
  `
  ALTER TABLE step_attempt ADD COLUMN skills TEXT;
  `,
  // 7 — PID of the omi process that runs the attempt (DevTask-0086 #264); null = attempt predates it
  `
  ALTER TABLE step_attempt ADD COLUMN pid INTEGER;
  `,
  // 8 — execution profiles with AES-256-GCM sealed tokens (ADR-0004 D3/D4, DevTask-0093 #282).
  // JSON columns hold the Profile contract fields; the secret_* columns are all base64 or null.
  `
  CREATE TABLE profile (
    name               TEXT PRIMARY KEY,
    harness            TEXT NOT NULL,
    disabled           INTEGER NOT NULL DEFAULT 0,
    auth               TEXT NOT NULL,
    models             TEXT NOT NULL,
    efforts            TEXT NOT NULL,
    secret_ciphertext  TEXT,
    secret_iv          TEXT,
    secret_tag         TEXT,
    key_fingerprint    TEXT,
    updated_at         TEXT NOT NULL
  );
  `,
  // 9 — profiles moved to the machine profile DB (Feature-0044 #337): the old table stays only as a
  // read-only migration source; `omi profile import` marks its rows migrated.
  `
  ALTER TABLE profile RENAME TO profile_legacy;
  ALTER TABLE profile_legacy ADD COLUMN migrated_at TEXT;
  `,
  // 10 — snapshot of the previous `omi sync` per Project (ADR-0005 D5, DevTask-0124 #369): status and
  // open/closed of each item, to diff external changes. No token or Issue text is stored.
  `
  CREATE TABLE project_snapshot (
    repository  TEXT NOT NULL,
    project     INTEGER NOT NULL,
    synced_at   TEXT NOT NULL,
    PRIMARY KEY (repository, project)
  );
  CREATE TABLE project_snapshot_item (
    repository    TEXT NOT NULL,
    project       INTEGER NOT NULL,
    issue         INTEGER NOT NULL,
    status        TEXT NOT NULL,
    state         TEXT NOT NULL,
    close_reason  TEXT,
    PRIMARY KEY (repository, project, issue),
    FOREIGN KEY (repository, project) REFERENCES project_snapshot (repository, project)
      ON DELETE CASCADE
  );
  `,
];

/** `label` names the database in errors ("state", "profile"). */
export function migrate(
  db: DatabaseSync,
  migrations: readonly string[] = MIGRATIONS,
  label = "state",
): number {
  const version = () => Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
  if (version() > migrations.length) {
    throw new OmiError(
      "SCHEMA_VERSION_UNSUPPORTED",
      `${label} database is version ${version()}, this OMI supports ${migrations.length}: upgrade OMI`,
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
      throw new OmiError("INTERNAL", `${label} migration ${next} failed`, {
        sqlite: (e as Error).message,
      });
    }
  }
  return version();
}
