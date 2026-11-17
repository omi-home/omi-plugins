// Local transactional state (idea §13) on the built-in node:sqlite driver.
// One database per repository, inside the git common dir: shared by every worktree, never committed.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { OmiError } from "../core/errors/errors.ts";
import { migrate } from "./migrations.ts";

export type Db = DatabaseSync;

const SQLITE_BUSY = 5;
const SQLITE_CONSTRAINT = 19;

/** `<git-common-dir>/omi/state.sqlite` for the repository containing `cwd`. */
export function statePath(cwd: string): string {
  let common: string;
  try {
    common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new OmiError("CONFIG_INVALID", "not inside a git repository");
  }
  return join(resolve(cwd, common), "omi", "state.sqlite");
}

/** Opens (creating if needed) and migrates the state database. */
export function openState(file: string): Db {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  try {
    // WAL: readers never block the writer. FULL: a committed transaction survives power loss.
    db.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
    `);
    migrate(db);
    return db;
  } catch (e) {
    db.close();
    throw sqliteError(e, "open state");
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
