// DevTask-0120 #359 (Feature-0044 #337): `omi profile import` moves the unmigrated rows of the
// workspace `profile_legacy` onto the machine DB, sealed columns verbatim, with `--resolve`.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type CliIo, main } from "../../../runtime/cli/main.ts";
import { loadProfiles } from "../../../runtime/profile/adapters/profile-config.ts";
import { openProfileDb, withProfileDb } from "../../../runtime/profile/adapters/profile-store.ts";
import { addProfile } from "../../../runtime/profile/adapters/profiles.ts";
import { secretRotateKey } from "../../../runtime/profile/cli/secret.ts";
import {
  type ProfileEntry,
  planProfileImport,
  type TokensEqual,
} from "../../../runtime/profile/domain/migration.ts";
import {
  encryptSecret,
  generateMasterKey,
  parseMasterKey,
  type SealedSecret,
} from "../../../runtime/profile/domain/secrets.ts";
import { Profile } from "../../../runtime/shared/contracts.ts";
import { MIGRATIONS } from "../../../runtime/shared/sqlite/migrations.ts";

const CANARY = "sk-ant-oat01-CANARY-migration-0123456789abcdef";
const OTHER = "sk-ant-oat01-OTHER-migration-0123456789abcdef";
const KEY = generateMasterKey();
const KEY2 = generateMasterKey();
const env = (ws: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  OMI_PROFILE_DB: join(ws, "profiles.sqlite"),
  ...extra,
});

const seal = (key: string, name: string, token: string): SealedSecret =>
  encryptSecret(parseMasterKey(key, "K"), name, token);

interface LegacyRow {
  name: string;
  models?: string[];
  sealed?: SealedSecret | null;
}

/** A workspace whose state.sqlite is at the previous schema (v8) with `rows` in the old `profile` table. */
function legacyWorkspace(rows: LegacyRow[]) {
  const ws = mkdtempSync(join(tmpdir(), "omi-migrate-"));
  mkdirSync(join(ws, ".omi-plugins"));
  mkdirSync(join(ws, "repo", ".git"), { recursive: true });
  const old = new DatabaseSync(join(ws, ".omi-plugins", "state.sqlite"));
  for (const [i, sql] of MIGRATIONS.slice(0, 8).entries()) {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${i + 1}`);
  }
  for (const r of rows) {
    old
      .prepare(
        `INSERT INTO profile (name, harness, disabled, auth, models, efforts,
           secret_ciphertext, secret_iv, secret_tag, key_fingerprint, updated_at)
         VALUES (?, 'claudecode', 0, ?, ?, '["high"]', ?, ?, ?, ?, '2026-01-01T00:00:00.000Z')`,
      )
      .run(
        r.name,
        '{"type":"subscription","tokenEnv":"OMI_T_SUB"}',
        JSON.stringify(r.models ?? ["m1"]),
        r.sealed?.ciphertext ?? null,
        r.sealed?.iv ?? null,
        r.sealed?.tag ?? null,
        r.sealed?.keyFingerprint ?? null,
      );
  }
  old.close();
  return ws;
}

const machineProfile = (name: string, models = ["m1"]) =>
  Profile.parse({
    name,
    harness: "claudecode",
    auth: { type: "subscription", tokenEnv: "OMI_T_SUB" },
    models,
    efforts: ["high"],
  });

const putMachine = (ws: string, name: string, sealed: SealedSecret | null, models = ["m1"]) =>
  withProfileDb(env(ws), (db) =>
    addProfile(db, machineProfile(name, models), sealed, "2026-02-02T00:00:00.000Z"),
  );

const run = (ws: string, args: string[], extra: NodeJS.ProcessEnv = {}) =>
  main([...args, "--output", "json"], ws, { env: env(ws, extra), stdin: () => "" } satisfies CliIo);
const okData = (r: ReturnType<typeof main>) => {
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout).data;
};
const errorOf = (r: ReturnType<typeof main>) => JSON.parse(r.stdout).error;

const machineRows = (ws: string) => {
  const db = new DatabaseSync(join(ws, "profiles.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT * FROM profile ORDER BY name")
      .all()
      .map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const legacyStamps = (ws: string) => {
  const db = new DatabaseSync(join(ws, ".omi-plugins", "state.sqlite"), { readOnly: true });
  try {
    return db
      .prepare("SELECT name, migrated_at AS m FROM profile_legacy ORDER BY name")
      .all()
      .map((r) => ({ ...r }));
  } finally {
    db.close();
  }
};
const diskBytes = (ws: string) =>
  readdirSync(ws)
    .filter((f) => f.startsWith("profiles.sqlite"))
    .map((f) => readFileSync(join(ws, f)).toString("latin1"))
    .join("");

test("first import moves every row with its token, ciphertext byte-equal; the second changes nothing", () => {
  const a = seal(KEY, "a", CANARY);
  const ws = legacyWorkspace([
    { name: "a", sealed: a },
    { name: "b", sealed: null },
  ]);
  // No key in the env: nothing is decrypted, so none is needed.
  const first = okData(run(ws, ["profile", "import"]));
  assert.deepEqual(first.imported, ["a", "b"]);
  assert.deepEqual(first.legacyMigrated, ["a", "b"]);
  assert.deepEqual([first.conflicts, first.resolved, first.identical], [[], [], []]);
  const rows = machineRows(ws);
  assert.deepEqual(
    rows.map((r) => [r.name, r.secret_ciphertext, r.secret_iv, r.secret_tag, r.key_fingerprint]),
    [
      ["a", a.ciphertext, a.iv, a.tag, a.keyFingerprint],
      ["b", null, null, null, null],
    ],
  );
  assert.ok(legacyStamps(ws).every((s) => s.m !== null));
  assert.ok(!diskBytes(ws).includes(CANARY));

  const before = JSON.stringify(machineRows(ws));
  const second = okData(run(ws, ["profile", "import"]));
  for (const k of [
    "imported",
    "identical",
    "tokenFilled",
    "conflicts",
    "resolved",
    "legacyMigrated",
  ])
    assert.deepEqual(second[k], [], k);
  assert.equal(JSON.stringify(machineRows(ws)), before);
  assert.deepEqual(
    okData(run(ws, ["profile", "list"])).profiles.map((p: { name: string }) => p.name),
    ["a", "b"],
  );
});

test("unmigrated rows block every reader and writer until import ran (AC-4)", () => {
  const ws = legacyWorkspace([{ name: "a", sealed: seal(KEY, "a", CANARY) }]);
  for (const args of [
    ["profile", "list"],
    ["profile", "remove", "a"],
    ["profile", "set-token", "a"],
  ]) {
    const e = errorOf(run(ws, args, { OMI_SECRET_KEY: KEY }));
    assert.equal(e.code, "CONFIG_INVALID", args.join(" "));
    assert.match(e.message, /omi profile import/);
    assert.match(e.message, /\ba\b/);
  }
  assert.throws(() => loadProfiles(ws, env(ws)), { code: "CONFIG_INVALID" });
  assert.throws(() => secretRotateKey({ workspace: ws, env: env(ws) }), {
    code: "CONFIG_INVALID",
  });
  okData(run(ws, ["profile", "import"]));
  assert.deepEqual(
    loadProfiles(ws, env(ws)).map((p) => p.name),
    ["a"],
  );
});

test("a conflict stops the import: CONFIG_CONFLICT, nothing written, no secret in the report", () => {
  const ws = legacyWorkspace([
    { name: "clash", models: ["m1", "m2"], sealed: seal(KEY, "clash", CANARY) },
    { name: "fresh", sealed: null },
  ]);
  putMachine(ws, "clash", seal(KEY2, "clash", OTHER));
  const before = JSON.stringify(machineRows(ws));

  const r = run(ws, ["profile", "import"], { OMI_SECRET_KEY: KEY });
  assert.equal(r.code === 0, false);
  const e = errorOf(r);
  assert.equal(e.code, "CONFIG_CONFLICT");
  assert.deepEqual(e.details.conflicts, [
    { name: "clash", fields: ["models"], token: "unverifiable" },
  ]);
  for (const text of [r.stdout, r.stderr, diskBytes(ws)]) {
    assert.ok(!text.includes(CANARY) && !text.includes(OTHER) && !text.includes(KEY));
  }
  assert.equal(JSON.stringify(machineRows(ws)), before); // `fresh` was not copied either
  assert.ok(legacyStamps(ws).every((s) => s.m === null));

  const dry = okData(run(ws, ["profile", "import", "--dry-run"], { OMI_SECRET_KEY: KEY }));
  assert.equal(dry.dryRun, true);
  assert.deepEqual(dry.conflicts, e.details.conflicts);
  assert.deepEqual(dry.imported, ["fresh"]);
  assert.equal(JSON.stringify(machineRows(ws)), before);
});

test("a differing token under the same key is `differs`, equal plaintext under another IV is identical", () => {
  const ws = legacyWorkspace([
    { name: "same", sealed: seal(KEY, "same", CANARY) },
    { name: "diff", sealed: seal(KEY, "diff", CANARY) },
  ]);
  putMachine(ws, "same", seal(KEY, "same", CANARY)); // other IV, same plaintext
  putMachine(ws, "diff", seal(KEY, "diff", OTHER));
  const x = errorOf(run(ws, ["profile", "import"], { OMI_SECRET_KEY: KEY }));
  assert.deepEqual(x.details.conflicts, [{ name: "diff", fields: [], token: "differs" }]);
  const done = okData(
    run(ws, ["profile", "import", "--resolve", "diff=machine"], { OMI_SECRET_KEY: KEY }),
  );
  assert.deepEqual(
    [done.identical, done.resolved],
    [["same"], [{ name: "diff", choice: "machine" }]],
  );
});

test("--resolve machine keeps the machine row, --resolve workspace overwrites it; both mark migrated", () => {
  const mk = () => {
    const w = seal(KEY, "p", CANARY);
    const ws = legacyWorkspace([{ name: "p", models: ["m1", "m2"], sealed: w }]);
    putMachine(ws, "p", seal(KEY2, "p", OTHER));
    return { ws, w };
  };
  const m = mk();
  const keep = okData(run(m.ws, ["profile", "import", "--resolve", "p=machine"]));
  assert.deepEqual(keep.resolved, [{ name: "p", choice: "machine" }]);
  assert.deepEqual(machineRows(m.ws)[0]?.models, '["m1"]');
  assert.notEqual(machineRows(m.ws)[0]?.secret_ciphertext, m.w.ciphertext);
  assert.ok(legacyStamps(m.ws).every((s) => s.m !== null));

  const w = mk();
  const over = okData(run(w.ws, ["profile", "import", "--resolve", "p=workspace"]));
  assert.deepEqual(over.resolved, [{ name: "p", choice: "workspace" }]);
  const row = machineRows(w.ws)[0];
  assert.deepEqual(
    [row?.models, row?.secret_ciphertext, row?.secret_tag, row?.key_fingerprint],
    ['["m1","m2"]', w.w.ciphertext, w.w.tag, w.w.keyFingerprint],
  );
  assert.ok(legacyStamps(w.ws).every((s) => s.m !== null));
  assert.ok(!diskBytes(w.ws).includes(CANARY) && !diskBytes(w.ws).includes(OTHER));
});

test("--resolve: bad syntax and unknown names are USAGE_INVALID", () => {
  const ws = legacyWorkspace([{ name: "p" }]);
  for (const bad of ["p", "p=", "=machine", "p=both", "nope=machine"]) {
    const r = run(ws, ["profile", "import", "--resolve", bad]);
    assert.equal(errorOf(r).code, "USAGE_INVALID", bad);
  }
  assert.equal(
    errorOf(run(ws, ["profile", "import", "--resolve", "p=machine", "--resolve", "p=workspace"]))
      .code,
    "USAGE_INVALID",
  );
  assert.ok(legacyStamps(ws).every((s) => s.m === null));
});

test("a machine profile without a token gets the workspace token copied sealed (tokenFilled)", () => {
  const sealed = seal(KEY, "p", CANARY);
  const ws = legacyWorkspace([{ name: "p", sealed }]);
  putMachine(ws, "p", null);
  const r = okData(run(ws, ["profile", "import"]));
  assert.deepEqual([r.tokenFilled, r.identical, r.imported], [["p"], [], []]);
  assert.equal(machineRows(ws)[0]?.secret_ciphertext, sealed.ciphertext);
});

test("crash between the machine and the workspace transaction: the re-run is clean", () => {
  const ws = legacyWorkspace([{ name: "a", sealed: seal(KEY, "a", CANARY) }]);
  okData(run(ws, ["profile", "import"]));
  // Undo the second transaction only, as if the process died before it.
  const state = new DatabaseSync(join(ws, ".omi-plugins", "state.sqlite"));
  state.exec("UPDATE profile_legacy SET migrated_at = NULL");
  state.close();
  const before = JSON.stringify(machineRows(ws));
  const again = okData(run(ws, ["profile", "import"]));
  assert.deepEqual([again.identical, again.legacyMigrated, again.imported], [["a"], ["a"], []]);
  assert.equal(JSON.stringify(machineRows(ws)), before);
  assert.ok(legacyStamps(ws).every((s) => s.m !== null));
});

test("a newer profile database names itself in the error (CR-001)", () => {
  const ws = legacyWorkspace([]);
  const db = openProfileDb(join(ws, "profiles.sqlite"));
  db.exec("PRAGMA user_version = 99");
  db.close();
  const e = errorOf(run(ws, ["profile", "list"]));
  assert.equal(e.code, "SCHEMA_VERSION_UNSUPPORTED");
  assert.match(e.message, /profile database is version 99/);
});

test("planProfileImport is pure: classifies per name and never writes while a conflict is open", () => {
  const entry = (name: string, models: string[], sealed: SealedSecret | null): ProfileEntry => ({
    profile: machineProfile(name, models),
    sealed,
    updatedAt: "t",
  });
  const s1 = seal(KEY, "x", CANARY);
  const tokens: TokensEqual = () => "differs";
  const machine = [entry("x", ["m1"], s1), entry("y", ["m1"], null)];
  const sources = [entry("x", ["m1"], s1), entry("y", ["m2"], null), entry("z", ["m1"], null)];
  const open = planProfileImport(machine, sources, new Map(), tokens);
  assert.deepEqual(open.identical, ["x"]);
  assert.deepEqual(
    open.copy.map((e) => e.profile.name),
    ["z"],
  );
  assert.deepEqual(open.conflicts, [{ name: "y", fields: ["models"], token: "absent" }]);
  assert.deepEqual(open.migrate, []);
  const done = planProfileImport(machine, sources, new Map([["y", "workspace" as const]]), tokens);
  assert.deepEqual(done.conflicts, []);
  assert.deepEqual(
    done.overwrite.map((e) => e.profile.name),
    ["y"],
  );
  assert.deepEqual(done.migrate, ["x", "y", "z"]);
  assert.throws(
    () => planProfileImport(machine, sources, new Map([["q", "machine" as const]]), tokens),
    {
      code: "USAGE_INVALID",
    },
  );
});
