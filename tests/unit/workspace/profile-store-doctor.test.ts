// DevTask-0121 #360 (Feature-0044 #337): doctor `profile store` / `legacy profiles`, 0600 from the
// start, and no test path reaches the real machine DB.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  openProfileDb,
  profileDbLocation,
} from "../../../runtime/profile/adapters/profile-store.ts";
import { addProfile } from "../../../runtime/profile/adapters/profiles.ts";
import { PROFILE_DB_ENV } from "../../../runtime/profile/domain/location.ts";
import { generateMasterKey } from "../../../runtime/profile/domain/secrets.ts";
import { type Check, Profile } from "../../../runtime/shared/contracts.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import { profileStoreChecks } from "../../../runtime/workspace/cli/doctor.ts";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const posix = process.platform !== "win32";

function ws() {
  const dir = mkdtempSync(join(tmpdir(), "omi-store-doctor-"));
  mkdirSync(join(dir, ".omi-plugins"));
  return dir;
}
const byName = (cs: Check[], n: string) => cs.find((c) => c.name === n);

test("profile store: no DB yet passes with the path and source", () => {
  const dir = ws();
  const file = join(dir, "p", "profiles.sqlite");
  const c = byName(profileStoreChecks(dir, { [PROFILE_DB_ENV]: file }), "profile store");
  assert.equal(c?.status, "pass");
  assert.match(c?.detail ?? "", /no profile store yet/);
  assert.ok(c?.detail.includes(file) && c.detail.includes(PROFILE_DB_ENV));
  assert.equal(existsSync(file), false); // doctor creates nothing
});

test("profile store: opens, schema supported; a newer file fails", () => {
  const dir = ws();
  const file = join(dir, "profiles.sqlite");
  const env = { [PROFILE_DB_ENV]: file };
  openProfileDb(file).close();
  assert.equal(byName(profileStoreChecks(dir, env), "profile store")?.status, "pass");
  const db = openProfileDb(file);
  db.exec("PRAGMA user_version = 99");
  db.close();
  const newer = byName(profileStoreChecks(dir, env), "profile store");
  assert.equal(newer?.status, "fail");
  assert.match(newer?.detail ?? "", /newer/);
});

test("profile store: group/other bits of file or directory fail with a chmod hint (POSIX)", {
  skip: !posix,
}, () => {
  const dir = ws();
  const sub = join(dir, "omi");
  const file = join(sub, "profiles.sqlite");
  const env = { [PROFILE_DB_ENV]: file };
  openProfileDb(file).close();
  assert.equal(byName(profileStoreChecks(dir, env), "profile store")?.status, "pass");
  chmodSync(file, 0o644);
  const f = byName(profileStoreChecks(dir, env), "profile store");
  assert.equal(f?.status, "fail");
  assert.match(f?.detail ?? "", /chmod 600/);
  chmodSync(file, 0o600);
  chmodSync(sub, 0o755);
  const d = byName(profileStoreChecks(dir, env), "profile store");
  assert.equal(d?.status, "fail");
  assert.match(d?.detail ?? "", /directory is 755/);
});

test("profile store: Windows relies on the user-profile ACL", { skip: posix }, () => {
  const dir = ws();
  const file = join(dir, "profiles.sqlite");
  openProfileDb(file).close();
  const c = byName(profileStoreChecks(dir, { [PROFILE_DB_ENV]: file }), "profile store");
  assert.equal(c?.status, "pass");
  assert.match(c?.detail ?? "", /ACL of the user profile, not checked/);
});

test("profile store: a new DB is 0600 and an OMI-created directory 0700 (POSIX)", {
  skip: !posix,
}, () => {
  const base = mkdtempSync(join(tmpdir(), "omi-umask-"));
  const prev = process.umask(0o022);
  try {
    const file = join(base, "omi", "profiles.sqlite");
    openProfileDb(file).close();
    assert.equal(statSync(join(base, "omi")).mode & 0o777, 0o700);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    process.umask(prev);
  }
});

test("legacy profiles: unmigrated rows fail with names only; none passes", () => {
  const dir = ws();
  const env = { [PROFILE_DB_ENV]: join(dir, "profiles.sqlite") };
  assert.equal(byName(profileStoreChecks(dir, env), "legacy profiles")?.status, "pass");
  const state = openState(join(dir, ".omi-plugins", "state.sqlite"));
  state.exec(
    `INSERT INTO profile_legacy (name, harness, disabled, auth, models, efforts, updated_at)
     VALUES ('old-one', 'claudecode', 0, '{}', '[]', '[]', 'x')`,
  );
  state.close();
  const c = byName(profileStoreChecks(dir, env), "legacy profiles");
  assert.equal(c?.status, "fail");
  assert.match(c?.detail ?? "", /old-one/);
  assert.match(c?.detail ?? "", /omi profile import/);
});

test("doctor output of the store never holds the key", () => {
  const dir = ws();
  const file = join(dir, "profiles.sqlite");
  const key = generateMasterKey();
  const db = openProfileDb(file);
  addProfile(
    db,
    Profile.parse({
      name: "p",
      harness: "claudecode",
      auth: { type: "subscription", tokenEnv: "OMI_T" },
      models: ["m"],
      efforts: ["high"],
    }),
    null,
    new Date().toISOString(),
  );
  db.close();
  const out = JSON.stringify(
    profileStoreChecks(dir, { [PROFILE_DB_ENV]: file, OMI_SECRET_KEY: key }),
  );
  assert.ok(!out.includes(key));
});

test("the test runner refuses the default machine DB when OMI_PROFILE_DB is unset", () => {
  assert.throws(() => profileDbLocation({}), { code: "CONFIG_INVALID", message: /test runner/ });
  assert.equal(profileDbLocation({ [PROFILE_DB_ENV]: join(tmpdir(), "x.sqlite") }).source, "env");
});

test("running one test file directly never creates the default machine DB", () => {
  const fake = mkdtempSync(join(tmpdir(), "omi-fakehome-"));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: fake,
    USERPROFILE: fake,
    LOCALAPPDATA: join(fake, "Local"),
    XDG_CONFIG_HOME: join(fake, "xdg"),
  };
  delete env[PROFILE_DB_ENV];
  delete env.OMI_TEST_PROFILE_DB_AUTO;
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  const r = spawnSync(process.execPath, ["--test", "tests/unit/profile/profiles.test.ts"], {
    cwd: root,
    env,
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`.slice(-2000));
  assert.deepEqual(readdirSync(fake), []); // no omi/ directory, no profiles.sqlite anywhere
});
