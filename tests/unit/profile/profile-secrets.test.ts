// DevTask-0093 #282 (ADR-0004): profile table, token encryption, `omi secret`, `omi profile`.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { type CliIo, main } from "../../../runtime/cli/main.ts";
import { loadProfiles } from "../../../runtime/profile/adapters/profile-config.ts";
import { openProfileDb } from "../../../runtime/profile/adapters/profile-store.ts";
import { getProfileRecord } from "../../../runtime/profile/adapters/profiles.ts";
import { secretInitKey, secretRotateKey } from "../../../runtime/profile/cli/secret.ts";
import {
  decryptSecret,
  encryptSecret,
  generateMasterKey,
  keyFingerprint,
  loadMasterKey,
  parseMasterKey,
} from "../../../runtime/profile/domain/secrets.ts";
import type { OmiError } from "../../../runtime/shared/errors/errors.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";
import { MIGRATIONS } from "../../../runtime/shared/sqlite/migrations.ts";

const CANARY = "sk-ant-oat01-CANARY-token-0123456789abcdef";
const KEY = generateMasterKey();
const KEY2 = generateMasterKey();

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "omi-secret-"));
  mkdirSync(join(ws, ".omi-plugins"));
  mkdirSync(join(ws, "repo", ".git"), { recursive: true });
  return ws;
}
const stateFile = (ws: string) => join(ws, ".omi-plugins", "state.sqlite");
/** The machine profile DB of this test workspace: never the real one (Feature-0044 #337). */
const machineDb = (ws: string) => join(ws, "profiles.sqlite");
const penv = (ws: string, env: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  OMI_PROFILE_DB: machineDb(ws),
  ...env,
});

const run = (ws: string, args: string[], env: NodeJS.ProcessEnv = {}, stdin = "") =>
  main([...args, "--output", "json"], ws, {
    env: penv(ws, env),
    stdin: () => stdin,
  } satisfies CliIo);
const okData = (r: ReturnType<typeof main>) => {
  assert.equal(r.code, 0, r.stdout + r.stderr);
  return JSON.parse(r.stdout).data;
};
const errorCode = (r: ReturnType<typeof main>) => JSON.parse(r.stdout).error?.code;

const SUB = [
  "--auth",
  "subscription",
  "--token-env",
  "OMI_T_SUB",
  "--models",
  "m1,m2",
  "--efforts",
  "high",
];

/** Every byte of the database and its WAL, to prove no plaintext reached disk. */
const diskBytes = (ws: string) =>
  readdirSync(ws)
    .filter((f) => f.startsWith("profiles.sqlite"))
    .map((f) => readFileSync(join(ws, f)).toString("latin1"))
    .join("");

test("migration 9: a database from the previous release opens, keeps its data and profile rows, re-runs cleanly", () => {
  const ws = workspace();
  const old = new DatabaseSync(stateFile(ws));
  for (const [i, sql] of MIGRATIONS.slice(0, 8).entries()) {
    old.exec(sql);
    old.exec(`PRAGMA user_version = ${i + 1}`);
  }
  old.exec(
    "INSERT INTO profile (name, harness, auth, models, efforts, updated_at) VALUES ('p','claudecode','{}','[]','[]','t')",
  );
  old.exec(
    "INSERT INTO workflow_run (id, repository, issue, workflow, state, created_at, updated_at) VALUES ('r1','o/r',1,'w','RUNNING','t','t')",
  );
  old.close();
  for (let i = 0; i < 2; i++) {
    const db = openState(stateFile(ws));
    assert.equal(db.prepare("SELECT id FROM workflow_run").get()?.id, "r1");
    const row = db.prepare("SELECT name, migrated_at FROM profile_legacy").get();
    assert.deepEqual({ ...row }, { name: "p", migrated_at: null });
    assert.throws(() => db.prepare("SELECT 1 FROM profile").get(), /no such table/);
    assert.equal(db.prepare("PRAGMA user_version").get()?.user_version, MIGRATIONS.length);
    db.close();
  }
  assert.equal(MIGRATIONS.length, 9);
});

test("crypto: random IV, round trip, tamper, AAD and key are all enforced", () => {
  const key = parseMasterKey(KEY, "K");
  const a = encryptSecret(key, "p1", CANARY);
  const b = encryptSecret(key, "p1", CANARY);
  assert.notEqual(a.iv, b.iv);
  assert.notEqual(a.ciphertext, b.ciphertext);
  assert.equal(Buffer.from(a.iv, "base64").length, 12);
  assert.ok(!JSON.stringify(a).includes(CANARY));
  assert.equal(decryptSecret(key, "p1", a), CANARY);

  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as OmiError).code;
    }
    return "none";
  };
  const flip = (s: string) => {
    const b = Buffer.from(s, "base64");
    b[0] = (b[0] ?? 0) ^ 1;
    return b.toString("base64");
  };
  assert.equal(
    code(() => decryptSecret(key, "p1", { ...a, ciphertext: flip(a.ciphertext) })),
    "SECRET_DECRYPT_FAILED",
  );
  assert.equal(
    code(() => decryptSecret(key, "p1", { ...a, tag: flip(a.tag) })),
    "SECRET_DECRYPT_FAILED",
  );
  assert.equal(
    code(() => decryptSecret(key, "p1", { ...a, iv: flip(a.iv) })),
    "SECRET_DECRYPT_FAILED",
  );
  assert.equal(
    code(() => decryptSecret(key, "p2", a)),
    "SECRET_DECRYPT_FAILED",
  ); // other profile: AAD
  const other = parseMasterKey(KEY2, "K");
  assert.equal(
    code(() => decryptSecret(other, "p1", a)),
    "SECRET_KEY_MISMATCH",
  );
  assert.notEqual(keyFingerprint(key), keyFingerprint(other));
  assert.ok(!keyFingerprint(key).includes(KEY));
});

test("master key: base64 of exactly 32 bytes, from the named variable", () => {
  const bad = (v: string | undefined, c: string) =>
    assert.throws(() => loadMasterKey({ K: v }, "K"), { code: c });
  bad(undefined, "SECRET_KEY_MISSING");
  bad("", "SECRET_KEY_MISSING");
  bad("not base64!", "SECRET_KEY_INVALID");
  bad(Buffer.alloc(31).toString("base64"), "SECRET_KEY_INVALID");
  bad(Buffer.alloc(33).toString("base64"), "SECRET_KEY_INVALID");
  assert.equal(loadMasterKey({ K: KEY }, "K").length, 32);
  try {
    loadMasterKey({ K: "short-secret-value" }, "K");
  } catch (e) {
    assert.ok(!JSON.stringify((e as OmiError).toJSON()).includes("short-secret-value"));
  }
});

test("secret init-key: writes the user env without printing the key; refuses when a key or secret exists", () => {
  const ws = workspace();
  const writes: [string, string][] = [];
  const deps = {
    workspace: ws,
    platform: "win32" as const,
    writeUserEnv: (n: string, v: string) => void writes.push([n, v]),
    readUserEnv: () => undefined,
  };
  const r = secretInitKey({ ...deps, env: penv(ws) });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.[0], "OMI_SECRET_KEY");
  assert.equal(parseMasterKey(writes[0]?.[1] as string, "K").length, 32);
  assert.ok(!JSON.stringify(r).includes(writes[0]?.[1] as string));
  // The CLI output carries no key either.
  const cli = main(["secret", "init-key", "--output", "json"], ws, {
    env: penv(ws, { OMI_SECRET_KEY: KEY }),
  });
  assert.equal(errorCode(cli), "SECRET_KEY_EXISTS");
  assert.ok(!cli.stdout.includes(KEY));
  // A custom variable name comes from the config.
  writeFileSync(join(ws, ".omi-plugins", "omi.config.yaml"), "secrets:\n  keyEnv: MY_KEY\n");
  secretInitKey({ ...deps, env: penv(ws) });
  assert.equal(writes[1]?.[0], "MY_KEY");
  // Sealed tokens in the database: a fresh key would orphan them.
  const ws2 = workspace();
  okData(
    run(ws2, ["profile", "add", "p1", ...SUB, "--token-stdin"], { OMI_SECRET_KEY: KEY }, CANARY),
  );
  assert.throws(() => secretInitKey({ ...deps, workspace: ws2, env: penv(ws2) }), {
    code: "SECRET_KEY_EXISTS",
  });
  const ws3 = workspace();
  assert.throws(() => secretInitKey({ workspace: ws3, env: penv(ws3), platform: "linux" }), {
    code: "USAGE_INVALID",
  });
  // CR-001: a terminal opened before an earlier init does not see the User variable, but it exists.
  const before = writes.length;
  const ws4 = workspace();
  assert.throws(
    () => secretInitKey({ ...deps, workspace: ws4, env: penv(ws4), readUserEnv: () => KEY }),
    { code: "SECRET_KEY_EXISTS" },
  );
  assert.equal(writes.length, before);
});

test("profile add/edit/import refuse the master key variable as a token variable (SEC-001)", () => {
  const ws = workspace();
  const env = { OMI_SECRET_KEY: KEY };
  for (const v of ["OMI_SECRET_KEY", "OMI_SECRET_KEY_NEXT"]) {
    const flags = SUB.map((f) => (f === "OMI_T_SUB" ? v : f));
    assert.equal(errorCode(run(ws, ["profile", "add", "bad", ...flags], env)), "CONFIG_INVALID");
  }
  // A legacy file naming the master key variable is refused by import, nothing is changed.
  const legacy = workspace();
  writeFileSync(
    join(legacy, ".omi-plugins", "omi.config.json"),
    JSON.stringify({
      profiles: [
        {
          name: "bad",
          harness: "claudecode",
          auth: { type: "subscription", tokenEnv: "OMI_SECRET_KEY" },
          models: ["m1"],
          efforts: ["high"],
        },
      ],
    }),
  );
  assert.equal(errorCode(run(legacy, ["profile", "import"], env)), "CONFIG_INVALID");
  assert.ok(existsSync(join(legacy, ".omi-plugins", "omi.config.json")));
  okData(run(ws, ["profile", "add", "ok", ...SUB], env));
  assert.equal(
    errorCode(run(ws, ["profile", "edit", "ok", "--token-env", "OMI_SECRET_KEY"], env)),
    "CONFIG_INVALID",
  );
});

test("secret rotate-key: one transaction; a failure keeps the old key valid", () => {
  const ws = workspace();
  const env = { OMI_SECRET_KEY: KEY, OMI_SECRET_KEY_NEXT: KEY2 };
  for (const n of ["a", "b", "c"]) okData(run(ws, ["profile", "add", n, ...SUB], env));
  for (const n of ["a", "b", "c"])
    okData(run(ws, ["profile", "set-token", n], env, `${CANARY}-${n}`));

  // Corrupt the last one: the rotation must fail and leave a and b untouched.
  const raw = new DatabaseSync(machineDb(ws));
  const before = raw
    .prepare("SELECT name, secret_ciphertext AS c, key_fingerprint AS f FROM profile ORDER BY name")
    .all();
  raw
    .prepare("UPDATE profile SET secret_tag = ? WHERE name = 'c'")
    .run(Buffer.alloc(16).toString("base64"));
  raw.close();
  assert.throws(() => secretRotateKey({ workspace: ws, env: penv(ws, env) }), {
    code: "SECRET_DECRYPT_FAILED",
  });
  const check = new DatabaseSync(machineDb(ws));
  const after = check
    .prepare("SELECT name, secret_ciphertext AS c, key_fingerprint AS f FROM profile ORDER BY name")
    .all();
  assert.deepEqual(after, before);
  // Repair c, rotate for real.
  check
    .prepare("UPDATE profile SET secret_tag = ? WHERE name = 'c'")
    .run(
      (check.prepare("SELECT secret_tag AS t FROM profile WHERE name='a'").get() as { t: string })
        .t,
    );
  check.close();
  okData(run(ws, ["profile", "set-token", "c"], env, `${CANARY}-c`));
  const r = secretRotateKey({ workspace: ws, env: penv(ws, env) });
  assert.equal(r.rotated, 3);
  assert.match(r.next, /every workspace on this machine/);
  const db = openProfileDb(machineDb(ws));
  const rec = getProfileRecord(db, "a");
  db.close();
  assert.equal(rec?.sealed?.keyFingerprint, keyFingerprint(parseMasterKey(KEY2, "K")));
  assert.equal(decryptSecret(parseMasterKey(KEY2, "K"), "a", rec?.sealed as never), `${CANARY}-a`);
  assert.throws(() => secretRotateKey({ workspace: ws, env: penv(ws, { OMI_SECRET_KEY: KEY }) }), {
    code: "SECRET_KEY_MISSING",
  });
  assert.throws(
    () =>
      secretRotateKey({
        workspace: ws,
        env: penv(ws, { OMI_SECRET_KEY: KEY, OMI_SECRET_KEY_NEXT: KEY }),
      }),
    { code: "USAGE_INVALID" },
  );
});

test("profile CRUD: token only via stdin, never in the database, stdout or envelope", () => {
  const ws = workspace();
  const env = { OMI_SECRET_KEY: KEY };
  const added = okData(
    run(ws, ["profile", "add", "p1", ...SUB, "--token-stdin"], env, `${CANARY}\n`),
  );
  assert.equal(added.profile.hasToken, true);
  assert.equal(added.profile.name, "p1");

  const outputs = [
    run(ws, ["profile", "list"], env),
    main(["profile", "list"], ws, { env: penv(ws, env) }),
    run(ws, ["profile", "edit", "p1", "--disabled"], env),
    run(ws, ["profile", "add", "p2", ...SUB, "--token-stdin"], {}, CANARY), // no key
    run(ws, ["profile", "set-token", "p1"], env, `${CANARY}-2`),
  ];
  for (const o of outputs) assert.ok(!o.stdout.includes(CANARY) && !o.stderr.includes(CANARY));
  assert.equal(errorCode(outputs[3] as never), "SECRET_KEY_MISSING");
  const listed = okData(outputs[0] as never).profiles[0];
  assert.equal(listed.disabled, false); // listed before the edit ran
  assert.deepEqual(Object.keys(listed).sort(), [
    "auth",
    "disabled",
    "efforts",
    "harness",
    "hasToken",
    "keyFingerprint",
    "models",
    "name",
    "updatedAt",
  ]);
  assert.ok(!diskBytes(ws).includes(CANARY));

  const edited = okData(
    run(
      ws,
      ["profile", "edit", "p1", "--enabled", "--models", "m3", "--token-env", "OMI_OTHER"],
      env,
    ),
  );
  assert.deepEqual(
    [
      edited.profile.disabled,
      edited.profile.models,
      edited.profile.auth.tokenEnv,
      edited.profile.hasToken,
    ],
    [false, ["m3"], "OMI_OTHER", true],
  );
  // The name is immutable (ARC-006); nothing to change is a usage error.
  assert.equal(errorCode(run(ws, ["profile", "edit", "p1", "--name", "p9"], env)), "USAGE_INVALID");
  assert.equal(errorCode(run(ws, ["profile", "edit", "p1"], env)), "USAGE_INVALID");
  assert.equal(errorCode(run(ws, ["profile", "edit", "nope", "--disabled"], env)), "USAGE_INVALID");
  // Add: duplicate, invalid contract, empty stdin.
  assert.equal(errorCode(run(ws, ["profile", "add", "p1", ...SUB], env)), "CONTRACT_INVALID");
  assert.equal(errorCode(run(ws, ["profile", "add", "Bad Name", ...SUB], env)), "CONTRACT_INVALID");
  assert.equal(errorCode(run(ws, ["profile", "set-token", "p1"], env, "  \n")), "USAGE_INVALID");
  assert.equal(errorCode(run(ws, ["profile", "set-token", "nope"], env, CANARY)), "USAGE_INVALID");
  // Gateway auth built from flags.
  const gw = okData(
    run(
      ws,
      [
        "profile",
        "add",
        "gw",
        "--auth",
        "gateway",
        "--base-url",
        "https://gw.example.com",
        "--scheme",
        "bearer",
        "--key-env",
        "GW_K",
        "--models",
        "m1",
        "--efforts",
        "high,max",
      ],
      env,
    ),
  );
  assert.equal(gw.profile.auth.scheme, "bearer");

  // Sealed token decrypts with the right key only, bound to the name.
  const db = openProfileDb(machineDb(ws));
  const rec = getProfileRecord(db, "p1");
  db.close();
  assert.equal(decryptSecret(parseMasterKey(KEY, "K"), "p1", rec?.sealed as never), `${CANARY}-2`);
  assert.ok(!diskBytes(ws).includes(CANARY));

  okData(run(ws, ["profile", "remove", "p1"], env));
  assert.equal(errorCode(run(ws, ["profile", "remove", "p1"], env)), "USAGE_INVALID");
  assert.equal(okData(run(ws, ["profile", "list"], env)).profiles.length, 1);
});

test("profile import: seals tokens from the declared env, backs the file up, safe to run twice", () => {
  const ws = workspace();
  const legacy = join(ws, ".omi-plugins", "omi.config.json");
  const sub = {
    name: "cc-sub",
    harness: "claudecode",
    auth: { type: "subscription", tokenEnv: "OMI_T_SUB" },
    models: ["m1"],
    efforts: ["high"],
  };
  const noenv = {
    ...sub,
    name: "cc-none",
    auth: { type: "subscription", tokenEnv: "OMI_T_UNSET" },
  };
  writeFileSync(legacy, JSON.stringify({ profiles: [sub, noenv] }));
  const env = { OMI_SECRET_KEY: KEY, OMI_T_SUB: CANARY };

  // Until imported, the file is ambiguous with the database.
  assert.equal(errorCode(run(ws, ["profile", "list"], env)), "CONFIG_INVALID");
  assert.throws(() => loadProfiles(ws, penv(ws)), {
    code: "CONFIG_INVALID",
    message: /omi profile import/,
  });

  const dry = okData(run(ws, ["profile", "import", "--dry-run"], env));
  assert.equal(dry.dryRun, true);
  assert.ok(existsSync(legacy));
  assert.equal(existsSync(machineDb(ws)), false); // a dry run creates nothing

  // Without the key nothing changes at all.
  assert.equal(
    errorCode(run(ws, ["profile", "import"], { OMI_T_SUB: CANARY })),
    "SECRET_KEY_MISSING",
  );
  assert.ok(existsSync(legacy));

  const first = okData(run(ws, ["profile", "import"], env));
  assert.deepEqual(
    [first.imported, first.tokensStored, first.tokensMissing],
    [["cc-sub", "cc-none"], ["cc-sub"], ["cc-none"]],
  );
  assert.equal(existsSync(legacy), false);
  const baks = readdirSync(join(ws, ".omi-plugins")).filter((f) =>
    /^omi\.config\.json\.\d{8}T\d{6}Z\.bak$/.test(f),
  );
  assert.equal(baks.length, 1);
  assert.equal(env.OMI_T_SUB, CANARY); // env variables are never removed (ARC-004)

  const second = okData(run(ws, ["profile", "import"], env));
  assert.deepEqual([second.imported, second.kept, second.backups], [[], [], []]);
  const listed = okData(run(ws, ["profile", "list"], env)).profiles;
  assert.deepEqual(
    listed.map((p: { name: string; hasToken: boolean }) => [p.name, p.hasToken]),
    [
      ["cc-sub", true],
      ["cc-none", false],
    ],
  );
  assert.ok(!diskBytes(ws).includes(CANARY));
  assert.deepEqual(
    loadProfiles(ws, penv(ws)).map((p) => p.name),
    ["cc-sub", "cc-none"],
  );

  // Crash between commit and rename: the file is back, the re-run keeps rows and fills missing tokens.
  writeFileSync(legacy, JSON.stringify({ profiles: [sub, noenv] }));
  const again = okData(run(ws, ["profile", "import"], { ...env, OMI_T_UNSET: `${CANARY}-b` }));
  assert.deepEqual(
    [again.imported, again.kept, again.tokensStored],
    [[], ["cc-sub", "cc-none"], ["cc-none"]],
  );
  assert.equal(
    okData(run(ws, ["profile", "list"], env)).profiles.every(
      (p: { hasToken: boolean }) => p.hasToken,
    ),
    true,
  );
});

test("profile import: kept profiles whose declaration differs are reported, identical ones are not (CR-005)", () => {
  const ws = workspace();
  const legacy = join(ws, ".omi-plugins", "omi.config.json");
  const env = { OMI_SECRET_KEY: KEY, OMI_T_SUB: CANARY };
  const decl = {
    name: "cc-sub",
    harness: "claudecode",
    auth: { type: "subscription", tokenEnv: "OMI_T_SUB" },
    models: ["m1"],
    efforts: ["high"],
  };
  writeFileSync(legacy, JSON.stringify({ profiles: [decl] }));
  okData(run(ws, ["profile", "import"], env));
  // Same declaration, other key order: no difference.
  writeFileSync(
    legacy,
    JSON.stringify({
      profiles: [
        {
          efforts: ["high"],
          models: ["m1"],
          auth: { tokenEnv: "OMI_T_SUB", type: "subscription" },
          harness: "claudecode",
          name: "cc-sub",
        },
      ],
    }),
  );
  const same = okData(run(ws, ["profile", "import"], env));
  assert.deepEqual([same.kept, same.differing], [["cc-sub"], []]);
  // One field changed in the old file: reported, the database row is untouched.
  writeFileSync(legacy, JSON.stringify({ profiles: [{ ...decl, models: ["m1", "m2"] }] }));
  const diff = okData(run(ws, ["profile", "import"], env));
  assert.deepEqual([diff.kept, diff.differing], [["cc-sub"], ["cc-sub"]]);
  assert.deepEqual(okData(run(ws, ["profile", "list"], env)).profiles[0].models, ["m1"]);
});

test("profile import: a YAML profiles section moves too; the policy keys stay", () => {
  const ws = workspace();
  const yaml = join(ws, ".omi-plugins", "omi.config.yaml");
  writeFileSync(
    yaml,
    "# policy\ngithub:\n  owner: o\n  repo: r\n  projectNumber: 1\nprofiles:\n  - name: y1\n    harness: claudecode\n    auth: { type: subscription, tokenEnv: OMI_T_Y }\n    models: [m1]\n    efforts: [high]\n",
  );
  assert.equal(errorCode(run(ws, ["profile", "list"])), "CONFIG_INVALID");
  const r = okData(run(ws, ["profile", "import"], { OMI_SECRET_KEY: KEY, OMI_T_Y: CANARY }));
  assert.deepEqual(r.tokensStored, ["y1"]);
  const text = readFileSync(yaml, "utf8");
  assert.ok(
    text.includes("# policy") && text.includes("projectNumber: 1") && !text.includes("profiles"),
  );
  assert.equal(okData(run(ws, ["profile", "list"])).profiles[0].name, "y1");
});
