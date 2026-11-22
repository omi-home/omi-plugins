// The machine profile database `profiles.sqlite` (Feature-0044 #337): profiles and their sealed
// tokens shared by every workspace of this OS user. A connection is opened per operation and closed
// at once. Readers never create the file; writers do.
import { chmodSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Db, openDb } from "../../shared/sqlite/db.ts";
import { type ProfileDbLocation, resolveProfileDbPath } from "../domain/location.ts";

/** Forward-only schema of the machine DB, tracked in its own `PRAGMA user_version`. */
export const PROFILE_DB_MIGRATIONS: readonly string[] = [
  // 1 — same columns as state migration 8 (Profile contract + AES-256-GCM sealed token)
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
];

const isPosix = () => process.platform !== "win32";

/** Where the machine DB is for `env` (CONFIG_INVALID for a relative `OMI_PROFILE_DB`). */
export const profileDbLocation = (
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): ProfileDbLocation => resolveProfileDbPath({ env, platform, home });

/** POSIX: only the owner reads the DB and its WAL side files. Windows relies on the profile ACL. */
function restrict(file: string): void {
  if (!isPosix()) return;
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    if (existsSync(f)) chmodSync(f, 0o600);
  }
}

/** Creates the parent directory (POSIX 0700), opens and migrates the machine DB. */
export function openProfileDb(file: string): Db {
  // openDb would create the directory with the default mode: make it private first (POSIX)
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const db = openDb(file, PROFILE_DB_MIGRATIONS, "open profile store", "profile");
  restrict(file);
  return db;
}

/** The machine DB file when it exists, else undefined (reading creates nothing). */
export function existingProfileDb(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const { path } = profileDbLocation(env);
  return existsSync(path) ? path : undefined;
}

/** Writers: creates the DB when missing, runs `fn` on a short-lived connection. */
export function withProfileDb<T>(env: NodeJS.ProcessEnv, fn: (db: Db) => T): T {
  const file = profileDbLocation(env).path;
  const db = openProfileDb(file);
  try {
    return fn(db);
  } finally {
    db.close();
    restrict(file);
  }
}

/** Readers: `fn` on the machine DB, or `whenMissing` when there is none (nothing is created). */
export function withExistingProfileDb<T>(
  env: NodeJS.ProcessEnv,
  fn: (db: Db) => T,
  whenMissing: T,
): T {
  const file = existingProfileDb(env);
  if (!file) return whenMissing;
  const db = openProfileDb(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

export interface ProfileDbStatus {
  path: string;
  source: "env" | "default";
  exists: boolean;
  /** POSIX permission bits (e.g. 0o600) of the file; undefined when absent or on Windows. */
  mode?: number;
  /** `PRAGMA user_version` of the file, read without migrating; undefined when absent or unreadable. */
  schemaVersion?: number;
  /** Highest schema version this OMI supports. */
  supportedVersion: number;
}

/** For `omi doctor`: what the machine DB looks like, without creating or changing anything. */
export function profileDbStatus(env: NodeJS.ProcessEnv = process.env): ProfileDbStatus {
  const { path, source } = profileDbLocation(env);
  const status: ProfileDbStatus = {
    path,
    source,
    exists: existsSync(path),
    supportedVersion: PROFILE_DB_MIGRATIONS.length,
  };
  if (!status.exists) return status;
  if (isPosix()) status.mode = statSync(path).mode & 0o777;
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      status.schemaVersion = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    } finally {
      db.close();
    }
  } catch {
    // unreadable: reported as an unknown schema version
  }
  return status;
}
