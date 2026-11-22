// DevTask-0119 #358 (Feature-0044 #337): profiles live in one machine DB shared by every workspace
// (AC-2, AC-3), concurrent writers lose nothing (AC-6), the monitor protocol still round-trips (AC-7).
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../../../runtime/cli/main.ts";
import { loadProfiles } from "../../../runtime/profile/adapters/profile-config.ts";
import { withExistingProfileDb } from "../../../runtime/profile/adapters/profile-store.ts";
import { listProfileRecords } from "../../../runtime/profile/adapters/profiles.ts";
import { generateMasterKey } from "../../../runtime/profile/domain/secrets.ts";
import { ProfileView } from "../../../runtime/shared/contracts.ts";
import { commandEnvFor } from "../../../runtime/task-run/cli/common.ts";

const CANARY = "sk-ant-oat01-CANARY-machine-0123456789abcdef";
const KEY = generateMasterKey();
const SUB = [
  "--auth",
  "subscription",
  "--token-env",
  "OMI_T_SUB",
  "--models",
  "m1",
  "--efforts",
  "high",
];

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "omi-machine-ws-"));
  mkdirSync(join(ws, ".omi-plugins"));
  mkdirSync(join(ws, "repo", ".git"), { recursive: true });
  return ws;
}

const machine = () => ({
  OMI_PROFILE_DB: join(mkdtempSync(join(tmpdir(), "omi-machine-db-")), "profiles.sqlite"),
});

const omi = (ws: string, env: NodeJS.ProcessEnv, args: string[], stdin = "") => {
  const r = main([...args, "--output", "json"], ws, { env, stdin: () => stdin });
  assert.ok(!r.stdout.includes(CANARY) && !r.stderr.includes(CANARY));
  type Body = {
    data: { profiles: ProfileView[]; profile: ProfileView; removed?: string };
    error?: { code: string };
  };
  return { code: r.code, body: JSON.parse(r.stdout) as Body };
};

test("two workspaces on one machine DB: a change in A is visible in B at once (AC-2, AC-3)", () => {
  const env = { ...machine(), OMI_SECRET_KEY: KEY };
  const [a, b] = [workspace(), workspace()];
  // A fresh workspace with no machine DB has no profile and creates nothing.
  assert.deepEqual(omi(b, env, ["profile", "list"]).body.data.profiles, []);
  assert.equal(existsSync(env.OMI_PROFILE_DB), false);
  // Editing or removing what does not exist creates nothing either.
  assert.equal(omi(b, env, ["profile", "remove", "p1"]).body.error?.code, "USAGE_INVALID");
  assert.equal(
    omi(b, env, ["profile", "set-token", "p1"], CANARY).body.error?.code,
    "USAGE_INVALID",
  );
  assert.equal(existsSync(env.OMI_PROFILE_DB), false);

  assert.equal(omi(a, env, ["profile", "add", "p1", ...SUB, "--token-stdin"], CANARY).code, 0);
  assert.deepEqual(
    omi(b, env, ["profile", "list"]).body.data.profiles.map((p: ProfileView) => [
      p.name,
      p.hasToken,
    ]),
    [["p1", true]],
  );
  assert.deepEqual(
    loadProfiles(b, env).map((p) => p.name),
    ["p1"],
  );

  omi(a, env, ["profile", "edit", "p1", "--models", "m2"]);
  assert.deepEqual(omi(b, env, ["profile", "list"]).body.data.profiles[0]?.models, ["m2"]);
  omi(b, env, ["profile", "set-token", "p1"], `${CANARY}-2`);
  assert.equal(omi(a, env, ["profile", "list"]).body.data.profiles[0]?.hasToken, true);
  omi(b, env, ["profile", "remove", "p1"]);
  assert.deepEqual(omi(a, env, ["profile", "list"]).body.data.profiles, []);
  // Nothing was written to either workspace's state database.
  assert.equal(existsSync(join(a, ".omi-plugins", "state.sqlite")), false);
  assert.equal(existsSync(join(b, ".omi-plugins", "state.sqlite")), false);
});

test("a relative OMI_PROFILE_DB is CONFIG_INVALID for every profile command", () => {
  const ws = workspace();
  const env = { OMI_PROFILE_DB: "profiles.sqlite" };
  assert.equal(omi(ws, env, ["profile", "list"]).body.error?.code, "CONFIG_INVALID");
  assert.equal(omi(ws, env, ["profile", "add", "p1", ...SUB]).body.error?.code, "CONFIG_INVALID");
});

test("check/setup env drops OMI_PROFILE_DB along with the secrets (ARC-001)", () => {
  const ws = workspace();
  const host = { ...machine(), OMI_SECRET_KEY: KEY, KEEP_ME: "visible" };
  const env = commandEnvFor(ws, host);
  assert.equal("OMI_PROFILE_DB" in env, false);
  assert.equal("OMI_SECRET_KEY" in env, false);
  assert.equal(env.KEEP_ME, "visible");
});

test("two processes writing at once lose no row (AC-6)", async () => {
  const env = machine();
  const writer = fileURLToPath(new URL("../../support/profile-writer.ts", import.meta.url));
  const run = (prefix: string) =>
    new Promise<number | null>((resolve, reject) => {
      const child = spawn(process.execPath, [writer, prefix, "25"], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      child.stderr.on("data", (d) => {
        err += String(d);
      });
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve(code) : reject(new Error(err))));
    });
  assert.deepEqual(await Promise.all([run("a"), run("b"), run("c")]), [0, 0, 0]);
  const names = withExistingProfileDb(
    env,
    (db) => listProfileRecords(db).map((r) => r.profile.name),
    [],
  );
  assert.equal(names.length, 75);
  assert.equal(new Set(names).size, 75);
});

test("monitor protocol round trip: list/add/edit/set-token/remove keep the ProfileView shape (AC-7)", () => {
  const env = { ...machine(), OMI_SECRET_KEY: KEY };
  const ws = workspace();
  const view = (p: unknown) => ProfileView.parse(p); // strict: a new field would throw
  const added = omi(ws, env, ["profile", "add", "p1", ...SUB]);
  assert.equal(view(added.body.data.profile).hasToken, false);
  const edited = omi(ws, env, ["profile", "edit", "p1", "--disabled"]);
  assert.equal(view(edited.body.data.profile).disabled, true);
  const sealed = omi(ws, env, ["profile", "set-token", "p1"], CANARY);
  const v = view(sealed.body.data.profile);
  assert.equal(v.hasToken, true);
  assert.ok(v.keyFingerprint);
  const listed = omi(ws, env, ["profile", "list"]).body.data.profiles.map(view);
  assert.deepEqual(
    listed.map((p: ProfileView) => p.name),
    ["p1"],
  );
  assert.deepEqual(omi(ws, env, ["profile", "remove", "p1"]).body.data, { removed: "p1" });
});
