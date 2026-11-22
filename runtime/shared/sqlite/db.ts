// Local transactional state (spec §13) on the built-in node:sqlite driver.
// One database per workspace, in .omi-plugins/: shared by every worktree, outside the repo.
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OmiError } from "../errors/errors.ts";
import { locate, STATE_FILE } from "../workspace.ts";
import { MIGRATIONS, migrate } from "./migrations.ts";

export type Db = DatabaseSync;

const SQLITE_BUSY = 5;
const SQLITE_CONSTRAINT = 19;

/** `<workspace>/.omi-plugins/state.sqlite` for the workspace containing `cwd` (ADR-0002 D1). */
export function statePath(cwd: string): string {
  return join(locate(cwd).workspace, STATE_FILE);
}

/** Opens (creating if needed) and migrates the state database. */
export const openState = (file: string): Db => openDb(file, MIGRATIONS, "open state");

/**
 * Opens (creating if needed) a database with the pragmas every OMI database shares, then runs its
 * own forward-only `migrations` (tracked in that file's `PRAGMA user_version`).
 */
export function openDb(
  file: string,
  migrations: readonly string[],
  what = "open database",
  label = "state",
): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // WAL: readers never block the writer. FULL: a committed transaction survives power loss.
    db.exec("PRAGMA busy_timeout = 5000");
    setWal(db);
    db.exec(`
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
    `);
    migrate(db, migrations, label);
    return db;
  } catch (e) {
    db.close();
    throw sqliteError(e, what);
  }
}

/**
 * Switching to WAL holds a read lock while asking for the write lock; when another connection
 * races it SQLite returns BUSY at once (waiting could deadlock), bypassing busy_timeout.
 * Retry briefly; the last BUSY still surfaces as LOCK_HELD.
 */
function setWal(db: Db): void {
  for (let attempt = 1; ; attempt++) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (e) {
      const code = (e as { errcode?: number }).errcode;
      if (attempt >= 50 || code === undefined || (code & 0xff) !== SQLITE_BUSY) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}

/** Maps driver errors to the OMI taxonomy; busy is transient (a retry, not a round). */
export function sqliteError(e: unknown, what: string): OmiError {
  if (e instanceof OmiError) return e;
  const code = (e as { errcode?: number }).errcode;
  if (code !== undefined && (code & 0xff) === SQLITE_BUSY) {
    return new OmiError("LOCK_HELD", `${what}: database is busy`);
  }
  if (code !== undefined && (code & 0xff) === SQLITE_CONSTRAINT) {
    return new OmiError("CONTRACT_INVALID", `${what}: constraint violated`, {
      sqlite: (e as Error).message,
    });
  }
  return new OmiError("INTERNAL", `${what}: storage error`, { sqlite: (e as Error).message });
}

/**
 * Runs `fn` in one write transaction (BEGIN IMMEDIATE: the write lock is taken up front,
 * so concurrent writers queue on busy_timeout instead of failing mid-transaction).
 * Any throw rolls everything back.
 */
export function tx<T>(db: Db, what: string, fn: () => T): T {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (e) {
    throw sqliteError(e, what);
  }
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    rollback(db);
    throw sqliteError(e, what);
  }
}

/** SQLite may already have rolled back (e.g. on SQLITE_FULL); never mask the original error. */
export function rollback(db: Db): void {
  if (db.isTransaction) db.exec("ROLLBACK");
}
