// DevTask-0119 #358 (Feature-0044 #337): where the machine profile DB lives, and the guarantee
// that no test touches the real one.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { test } from "node:test";
import {
  existingProfileDb,
  openProfileDb,
  PROFILE_DB_MIGRATIONS,
  profileDbLocation,
  profileDbStatus,
  withProfileDb,
} from "../../../runtime/profile/adapters/profile-store.ts";
import { PROFILE_DB_ENV, resolveProfileDbPath } from "../../../runtime/profile/domain/location.ts";
import { openDb, openState } from "../../../runtime/shared/sqlite/db.ts";
import { MIGRATIONS } from "../../../runtime/shared/sqlite/migrations.ts";

test("resolveProfileDbPath: OMI_PROFILE_DB wins, must be absolute", () => {
  assert.deepEqual(
    resolveProfileDbPath({
      env: { OMI_PROFILE_DB: "C:\\data\\p.sqlite", LOCALAPPDATA: "C:\\L" },
      platform: "win32",
      home: "C:\\Users\\u",
    }),
    { path: "C:\\data\\p.sqlite", source: "env" },
  );
  assert.deepEqual(
    resolveProfileDbPath({
      env: { OMI_PROFILE_DB: "/data/p.sqlite" },
      platform: "linux",
      home: "/h",
    }),
    { path: "/data/p.sqlite", source: "env" },
  );
  for (const [platform, value] of [
    ["linux", "rel/p.sqlite"],
    ["win32", "rel\\p.sqlite"],
    ["linux", "./p.sqlite"],
  ] as const) {
    assert.throws(
      () => resolveProfileDbPath({ env: { OMI_PROFILE_DB: value }, platform, home: "/h" }),
      { code: "CONFIG_INVALID", message: new RegExp(PROFILE_DB_ENV) },
    );
  }
});

test("resolveProfileDbPath: per-platform defaults", () => {
  assert.deepEqual(
    resolveProfileDbPath({
      env: { LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" },
      platform: "win32",
      home: "C:\\Users\\u",
    }),
    { path: "C:\\Users\\u\\AppData\\Local\\omi\\profiles.sqlite", source: "default" },
  );
  assert.equal(
    resolveProfileDbPath({ env: {}, platform: "win32", home: "C:\\Users\\u" }).path,
    "C:\\Users\\u\\AppData\\Local\\omi\\profiles.sqlite",
  );
  assert.equal(
    resolveProfileDbPath({ env: {}, platform: "darwin", home: "/Users/u" }).path,
    "/Users/u/Library/Application Support/omi/profiles.sqlite",
  );
  assert.equal(
    resolveProfileDbPath({ env: {}, platform: "linux", home: "/home/u" }).path,
    "/home/u/.config/omi/profiles.sqlite",
  );
  assert.equal(
    resolveProfileDbPath({ env: { XDG_CONFIG_HOME: "/x/cfg" }, platform: "linux", home: "/home/u" })
      .path,
    "/x/cfg/omi/profiles.sqlite",
  );
  // A relative XDG_CONFIG_HOME is ignored (the XDG spec says so).
  assert.equal(
    resolveProfileDbPath({ env: { XDG_CONFIG_HOME: "rel" }, platform: "linux", home: "/home/u" })
      .path,
    "/home/u/.config/omi/profiles.sqlite",
  );
  assert.throws(() => resolveProfileDbPath({ env: {}, platform: "linux", home: "" }), {
    code: "CONFIG_INVALID",
  });
});

test("isolation: the machine DB of the test process is under os.tmpdir(), never the real one", () => {
  const { path, source } = profileDbLocation(process.env);
  assert.equal(source, "env");
  assert.ok(isAbsolute(path));
  const rel = relative(realpathSync(tmpdir()), realpathSync(join(path, "..")));
  assert.ok(!rel.startsWith("..") && !isAbsolute(rel), `${path} is outside ${tmpdir()}`);
  const real = resolveProfileDbPath({ env: {}, platform: process.platform, home: homedir() }).path;
  assert.notEqual(path, real);
});

test("openDb runs the migrations it is given; openState keeps the workspace schema", () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-opendb-"));
  const db = openDb(join(dir, "x.sqlite"), [
    "CREATE TABLE t (a TEXT);",
    "ALTER TABLE t ADD b TEXT;",
  ]);
  assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, 2);
  assert.equal(db.prepare("PRAGMA synchronous").get()?.synchronous, 2); // FULL
  assert.equal(db.prepare("PRAGMA journal_mode").get()?.journal_mode, "wal");
  db.close();
  const state = openState(join(dir, "state.sqlite"));
  assert.equal(state.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
  state.close();
  // A newer schema than this OMI knows is refused.
  assert.throws(() => openDb(join(dir, "x.sqlite"), ["CREATE TABLE t (a TEXT);"]), {
    code: "SCHEMA_VERSION_UNSUPPORTED",
  });
});

test("machine DB: readers never create it, writers do; schema v1 is the profile table", () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-store-"));
  const file = join(dir, "sub", "profiles.sqlite");
  const env = { [PROFILE_DB_ENV]: file };
  assert.equal(existingProfileDb(env), undefined);
  assert.deepEqual(profileDbStatus(env), {
    path: file,
    source: "env",
    exists: false,
    supportedVersion: PROFILE_DB_MIGRATIONS.length,
  });
  assert.equal(statSyncOrNull(join(dir, "sub")), null);
  const cols = withProfileDb(env, (db) =>
    (db.prepare("PRAGMA table_info(profile)").all() as { name: string }[]).map((c) => c.name),
  );
  assert.deepEqual(cols, [
    "name",
    "harness",
    "disabled",
    "auth",
    "models",
    "efforts",
    "secret_ciphertext",
    "secret_iv",
    "secret_tag",
    "key_fingerprint",
    "updated_at",
  ]);
  assert.equal(existingProfileDb(env), file);
  assert.equal(profileDbStatus(env).schemaVersion, 1);
});

test("a newer machine schema is SCHEMA_VERSION_UNSUPPORTED", () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-store-"));
  const file = join(dir, "profiles.sqlite");
  const db = openProfileDb(file);
  db.exec("PRAGMA user_version = 99");
  db.close();
  assert.throws(() => openProfileDb(file), { code: "SCHEMA_VERSION_UNSUPPORTED" });
});

test("POSIX: directory 0700, DB and WAL side files 0600", {
  skip: process.platform === "win32",
}, () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-perm-"));
  const sub = join(dir, "omi");
  const file = join(sub, "profiles.sqlite");
  const env = { [PROFILE_DB_ENV]: file };
  withProfileDb(env, (db) => {
    assert.equal(statSync(sub).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    db.exec("CREATE TABLE x (a)");
    db.exec("INSERT INTO x VALUES (1)"); // creates the -wal / -shm side files
  });
  // A second open restricts whatever side files are still around.
  const db = openProfileDb(file);
  db.exec("INSERT INTO x VALUES (2)");
  for (const f of [file, `${file}-wal`, `${file}-shm`]) {
    const m = statSyncOrNull(f);
    if (m !== null) assert.equal(m & 0o777, 0o600, f);
  }
  db.close();
  assert.equal(profileDbStatus(env).mode, 0o600);
});

function statSyncOrNull(p: string): number | null {
  try {
    return statSync(p).mode;
  } catch {
    return null;
  }
}
