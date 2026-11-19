// DevTask-0073 #216: omi.config.json contract, `omi profile list`, static doctor check.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { profilesCheck } from "../../runtime/cli/doctor.ts";
import { main } from "../../runtime/cli/main.ts";
import { listProfiles, loadProfiles } from "../../runtime/core/config.ts";
import { ProfilesFile } from "../../runtime/core/contracts.ts";
import { OmiError } from "../../runtime/core/errors/errors.ts";

const SECRET = "sk-very-secret-value";

const sub = {
  name: "cc-sub",
  harness: "claudecode",
  auth: { type: "subscription", tokenEnv: "OMI_T_SUB" },
  models: ["claude-opus-5-5", "claude-sonnet-5-5"],
  efforts: ["high", "medium"],
};
const gw = {
  name: "cc-gw",
  harness: "claudecode",
  disabled: false,
  auth: {
    type: "gateway",
    baseUrl: "https://gw.example.com",
    scheme: "x-api-key",
    keyEnv: "OMI_T_GW",
  },
  models: ["claude-opus-5-5"],
  efforts: ["high"],
};

function workspace(profiles?: unknown) {
  const ws = mkdtempSync(join(tmpdir(), "omi-profiles-"));
  mkdirSync(join(ws, ".omi-plugins"));
  mkdirSync(join(ws, "repo", ".git"), { recursive: true }); // locate(): one repo per workspace
  if (profiles !== undefined) {
    writeFileSync(
      join(ws, ".omi-plugins", "omi.config.json"),
      typeof profiles === "string" ? profiles : JSON.stringify(profiles),
    );
  }
  return ws;
}

const invalid = (data: unknown) =>
  assert.throws(
    () => loadProfiles(workspace(data)),
    (e) => e instanceof OmiError && e.code === "CONFIG_INVALID",
  );

test("valid profiles parse with defaults; missing file means none", () => {
  const ps = loadProfiles(workspace({ profiles: [sub, gw] }));
  assert.equal(ps.length, 2);
  assert.equal(ps[0]?.disabled, false);
  assert.deepEqual(loadProfiles(workspace()), []);
  assert.deepEqual(loadProfiles(workspace({})), []);
  // Editors on Windows may write a UTF-8 BOM.
  assert.equal(loadProfiles(workspace(`﻿${JSON.stringify({ profiles: [sub] })}`)).length, 1);
});

test("invalid files are rejected without echoing values", () => {
  invalid("{ not json");
  invalid({ profiles: [{ ...sub, token: SECRET }] }); // unknown field
  invalid({ profiles: [sub, { ...gw, name: "cc-sub" }] }); // duplicate name
  invalid({ profiles: [{ ...sub, harness: "codex" }] });
  invalid({ profiles: [{ ...sub, models: [] }] });
  invalid({ profiles: [{ ...sub, efforts: ["high", "high"] }] });
  invalid({ profiles: [{ ...sub, efforts: ["turbo"] }] });
  invalid({ profiles: [{ ...sub, auth: { type: "subscription", tokenEnv: SECRET } }] }); // not an env name
  invalid({ profiles: [{ ...gw, auth: { ...gw.auth, baseUrl: "http://gw.example.com" } }] });
  invalid({ profiles: [{ ...gw, auth: { ...gw.auth, scheme: "basic" } }] });
  try {
    loadProfiles(
      workspace({ profiles: [{ ...sub, auth: { type: "subscription", tokenEnv: SECRET } }] }),
    );
  } catch (e) {
    assert.ok(!JSON.stringify((e as OmiError).toJSON()).includes(SECRET));
  }
  // http is fine to this machine (a local proxy).
  const local = { ...gw, auth: { ...gw.auth, baseUrl: "http://localhost:4000" } };
  assert.equal(loadProfiles(workspace({ profiles: [local] })).length, 1);
});

test("listProfiles hides disabled profiles and never reads out the secret", () => {
  const ws = workspace({ profiles: [sub, { ...gw, disabled: true }] });
  const list = listProfiles(ws, { OMI_T_SUB: SECRET });
  assert.deepEqual(
    list.map((p) => [p.name, p.auth, p.secretEnv, p.secretSet]),
    [["cc-sub", "subscription", "OMI_T_SUB", true]],
  );
  assert.ok(!JSON.stringify(list).includes(SECRET));
  assert.equal(listProfiles(ws, {})[0]?.secretSet, false);
});

test("omi profile list prints active profiles as json and human", () => {
  const ws = workspace({ profiles: [sub, gw] });
  const r = main(["profile", "list", "--output", "json"], ws);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout).data as { profiles: { name: string }[] };
  assert.deepEqual(
    data.profiles.map((p) => p.name),
    ["cc-sub", "cc-gw"],
  );
  assert.match(main(["profile", "list"], ws).stdout, /cc-gw\s+claudecode gateway OMI_T_GW=/);
  assert.match(main(["profile", "list"], workspace()).stdout, /none active/);
});

test("doctor: secret env must be set for every active profile", () => {
  const ws = workspace({ profiles: [sub, gw, { ...gw, name: "off", disabled: true }] });
  const checks = profilesCheck(ws, { OMI_T_SUB: SECRET });
  assert.deepEqual(
    checks.map((c) => [c.name, c.status]),
    [
      ["profile cc-sub", "pass"],
      ["profile cc-gw", "fail"],
    ],
  );
  assert.ok(!JSON.stringify(checks).includes(SECRET));
  assert.equal(profilesCheck(workspace())[0]?.status, "pass");
  assert.equal(profilesCheck(workspace({ profiles: [{ ...sub, x: 1 }] }))[0]?.status, "fail");
});

test("workspace template matches the contract", () => {
  const tpl = fileURLToPath(
    new URL("../../templates/workspace/.omi-plugins/omi.config.json", import.meta.url),
  );
  assert.ok(ProfilesFile.safeParse(JSON.parse(readFileSync(tpl, "utf8"))).success);
});
