// DevTask-0073 #216: omi.config.json contract, `omi profile list`, static doctor check.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ClaudeRun,
  type HttpGet,
  harnessCheck,
  probeProfiles,
  profilesCheck,
} from "../../../runtime/cli/doctor.ts";
import { main } from "../../../runtime/cli/main.ts";
import { usageByProfile } from "../../../runtime/cli/status.ts";
import { harnessGate } from "../../../runtime/cli/task.ts";
import {
  atLeast,
  HARNESSES,
  versionRefusal,
} from "../../../runtime/harness/adapters/claude-code/launch.ts";
import {
  listProfiles,
  loadProfiles,
  profileSecretResolver,
  readLegacyProfiles,
} from "../../../runtime/profile/adapters/profile-config.ts";
import { addProfile } from "../../../runtime/profile/adapters/profiles.ts";
import {
  encryptSecret,
  generateMasterKey,
  parseMasterKey,
} from "../../../runtime/profile/domain/secrets.ts";
import { selectProfile } from "../../../runtime/profile/domain/selection.ts";
import { Profile, ProfilesFile } from "../../../runtime/shared/contracts.ts";
import { OmiError } from "../../../runtime/shared/errors/errors.ts";
import { redact } from "../../../runtime/shared/redact.ts";
import { openState } from "../../../runtime/shared/sqlite/db.ts";

// Opaque on purpose: matches no static redact rule, so only registerSecret can scrub it.
const SECRET = "omi-canary-profiles-5d4c3b2a1f09";

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

const KEY = generateMasterKey();
/** Host env that holds the master key (ADR-0004 D4). */
const KEYED = { OMI_SECRET_KEY: KEY };

/** A workspace whose state.sqlite already holds these profiles; `sealed` ones carry SECRET (ADR-0004 D3). */
function seeded(profiles: unknown[], sealed: string[] = []) {
  const ws = workspace();
  const db = openState(join(ws, ".omi-plugins", "state.sqlite"));
  try {
    for (const p of profiles) {
      const profile = Profile.parse(p);
      const seal = sealed.includes(profile.name)
        ? encryptSecret(parseMasterKey(KEY, "K"), profile.name, SECRET)
        : null;
      addProfile(db, profile, seal, new Date().toISOString());
    }
  } finally {
    db.close();
  }
  return ws;
}

const invalid = (data: unknown) =>
  assert.throws(
    () => readLegacyProfiles(workspace(data)),
    (e) => e instanceof OmiError && e.code === "CONFIG_INVALID",
  );

test("profiles load from state.sqlite with defaults; no database means none", () => {
  const ps = loadProfiles(seeded([sub, gw]));
  assert.equal(ps.length, 2);
  assert.equal(ps[0]?.disabled, false);
  assert.deepEqual(loadProfiles(workspace()), []);
  assert.deepEqual(loadProfiles(workspace({})), []);
  // An empty legacy file (the workspace template) declares nothing.
  assert.deepEqual(loadProfiles(workspace({ profiles: [] })), []);
});

test("a profile still declared in omi.config.json is CONFIG_INVALID until imported", () => {
  assert.throws(() => loadProfiles(workspace({ profiles: [sub] })), {
    code: "CONFIG_INVALID",
    message: /omi profile import/,
  });
  // Editors on Windows may write a UTF-8 BOM.
  const bom = workspace(`﻿${JSON.stringify({ profiles: [sub] })}`);
  assert.equal(readLegacyProfiles(bom).json?.profiles.length, 1);
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
  assert.throws(
    () =>
      readLegacyProfiles(
        workspace({ profiles: [{ ...sub, auth: { type: "subscription", tokenEnv: SECRET } }] }),
      ),
    (e) => !JSON.stringify((e as OmiError).toJSON()).includes(SECRET),
  );
  // http is fine to this machine (a local proxy).
  const local = { ...gw, auth: { ...gw.auth, baseUrl: "http://localhost:4000" } };
  assert.equal(readLegacyProfiles(workspace({ profiles: [local] })).json?.profiles.length, 1);
});

test("listProfiles hides disabled profiles and never reads out the secret", () => {
  const ws = seeded([sub, { ...gw, disabled: true }]);
  const list = listProfiles(ws, { OMI_T_SUB: SECRET });
  assert.deepEqual(
    list.map((p) => [p.name, p.auth, p.secretEnv, p.secretSet]),
    [["cc-sub", "subscription", "OMI_T_SUB", true]],
  );
  assert.ok(!JSON.stringify(list).includes(SECRET));
  assert.equal(listProfiles(ws, {})[0]?.secretSet, false);
});

test("omi profile list prints active profiles as json and human", () => {
  const ws = seeded([sub, { ...gw, disabled: true }]);
  const r = main(["profile", "list", "--output", "json"], ws);
  assert.equal(r.code, 0, r.stderr);
  const data = JSON.parse(r.stdout).data as { profiles: { name: string }[] };
  assert.deepEqual(
    data.profiles.map((p) => p.name),
    ["cc-sub", "cc-gw"],
  );
  assert.match(
    main(["profile", "list"], ws).stdout,
    /cc-gw\s+claudecode gateway disabled UNSEALED/,
  );
  assert.match(main(["profile", "list"], workspace()).stdout, /none/);
});

test("doctor: secret env must be set for every active profile", () => {
  const ws = seeded([sub, gw, { ...gw, name: "off", disabled: true }], ["cc-sub"]);
  const checks = profilesCheck(ws, KEYED);
  assert.deepEqual(
    checks.map((c) => [c.name, c.status]),
    [
      ["master key", "pass"],
      ["profile cc-sub", "pass"],
      ["profile cc-gw", "fail"],
      ["gateway cc-gw", "warn"],
    ],
  );
  assert.ok(!JSON.stringify(checks).includes(SECRET));
  assert.ok(!JSON.stringify(checks).includes(KEY));
  assert.match(checks[2]?.detail ?? "", /no token/);
  // No master key, then a different one: each profile says why, without echoing a value.
  const none = profilesCheck(ws, {});
  assert.deepEqual([none[0]?.name, none[0]?.status], ["master key", "fail"]);
  assert.match(none[0]?.detail ?? "", /omi secret init-key/);
  const wrong = profilesCheck(ws, { OMI_SECRET_KEY: generateMasterKey() });
  assert.match(wrong[1]?.detail ?? "", /not the one that sealed/);
  // CR-004: the key's fingerprint is compared with the stored one; never a value in the output.
  const otherKey = generateMasterKey();
  assert.deepEqual([wrong[0]?.name, wrong[0]?.status], ["master key", "fail"]);
  assert.match(wrong[0]?.detail ?? "", /wrong key/);
  assert.ok(!JSON.stringify(wrong).includes(otherKey));
  // Reported even with no active profile: a missing key warns, a wrong key still fails.
  const empty = profilesCheck(workspace(), {});
  assert.deepEqual(
    empty.map((c) => [c.name, c.status]),
    [
      ["master key", "warn"],
      ["profiles", "pass"],
    ],
  );
  const offOnly = seeded([{ ...sub, disabled: true }], ["cc-sub"]);
  assert.deepEqual(
    profilesCheck(offOnly, {}).map((c) => [c.name, c.status]),
    [
      ["master key", "fail"],
      ["profiles", "pass"],
    ],
  );
  assert.match(profilesCheck(offOnly, { OMI_SECRET_KEY: otherKey })[0]?.detail ?? "", /wrong key/);
  assert.equal(profilesCheck(workspace({ profiles: [{ ...sub, x: 1 }] }))[0]?.status, "fail");
});

test("workspace template matches the contract", () => {
  const tpl = fileURLToPath(
    new URL("../../../templates/workspace/.omi-plugins/omi.config.json", import.meta.url),
  );
  assert.ok(ProfilesFile.safeParse(JSON.parse(readFileSync(tpl, "utf8"))).success);
});

test("selectProfile (#217): validated choice, defaults to the profile's first model/effort", () => {
  const ws = seeded([sub, { ...gw, disabled: true }], ["cc-sub"]);
  const ps = loadProfiles(ws);
  assert.equal(selectProfile(ps, {}), undefined);
  const env = profileSecretResolver(ws, KEYED);
  const pick = selectProfile(ps, { profile: "cc-sub", reason: "simple docs task" }, env);
  assert.deepEqual(
    [pick?.profile.name, pick?.model, pick?.effort, pick?.reason],
    ["cc-sub", "claude-opus-5-5", "high", "simple docs task"],
  );
  // The token is a function: it never reaches JSON (packet, state, log); calling it registers it with redact.
  assert.equal(typeof pick?.secret, "function");
  assert.ok(!JSON.stringify(pick).includes(SECRET));
  assert.equal(pick?.secret(), SECRET);
  assert.equal(redact(`leak ${SECRET}`), "leak [REDACTED:secret]");
  assert.equal(
    selectProfile(
      ps,
      {
        profile: "cc-sub",
        model: "claude-sonnet-5-5",
        effort: "medium",
        reason: "r",
      },
      env,
    )?.model,
    "claude-sonnet-5-5",
  );
  const usage = (o: Parameters<typeof selectProfile>[1], msg: RegExp) =>
    assert.throws(() => selectProfile(ps, o, env), { code: "USAGE_INVALID", message: msg });
  usage({ model: "claude-opus-5-5" }, /need --profile/);
  usage({ profile: "nope", reason: "r" }, /no profile nope/);
  usage({ profile: "cc-gw", reason: "r" }, /disabled/);
  usage({ profile: "cc-sub", model: "claude-haiku-5-5", reason: "r" }, /offers models/);
  usage({ profile: "cc-sub", effort: "low", reason: "r" }, /offers efforts/);
  usage({ profile: "cc-sub", effort: "bogus", reason: "r" }, /offers efforts/);
  usage({ profile: "cc-sub", reason: "  " }, /--reason is required/);
  // Nothing starts that cannot authenticate; the message names the variable, never a value.
  assert.throws(
    () => selectProfile(ps, { profile: "cc-sub", reason: "r" }, profileSecretResolver(ws, {})),
    { code: "SECRET_KEY_MISSING", message: /OMI_SECRET_KEY is not set/ },
  );
  const bare = seeded([sub]);
  assert.throws(
    () =>
      selectProfile(
        loadProfiles(bare),
        { profile: "cc-sub", reason: "r" },
        profileSecretResolver(bare, KEYED),
      ),
    { code: "CONFIG_INVALID", message: /no token/ },
  );
});

test("usageByProfile (#217): usage summed per profile, no profile = routing", () => {
  const u = (n: number) => ({ inputTokens: n, outputTokens: 1 });
  assert.deepEqual(
    usageByProfile([
      { profile: null, usage: u(1) },
      { profile: "cc-sub", usage: u(10) },
      { profile: "cc-sub", usage: u(5) },
    ]).map((b) => [b.profile, b.usage.inputTokens, b.usage.outputTokens]),
    [
      ["routing", 1, 1],
      ["cc-sub", 15, 2],
    ],
  );
});

test("harness registry (#219): versions inside the verified range run; others are refused", () => {
  const { min, below } = HARNESSES.claudecode;
  assert.ok(atLeast("2.1.325", min) && !atLeast("2.1.325", below));
  assert.equal(versionRefusal("2.1.325"), null);
  assert.match(versionRefusal("2.1.100") ?? "", /outside the verified range >=2\.1\.277 <2\.2\.0/);
  assert.match(versionRefusal("2.2.0") ?? "", /outside the verified range/);
  assert.match(versionRefusal(undefined) ?? "", /claude not found/);
  const tool = (detail: string) => ({ name: "claude", status: "pass" as const, detail });
  assert.equal(harnessCheck(tool("2.1.325")).status, "pass");
  assert.match(harnessCheck(tool("2.1.325")).detail, /verified >=2\.1\.277 <2\.2\.0/);
  assert.equal(harnessCheck(tool("3.0.0")).status, "fail");
  const missing = { name: "claude", status: "fail" as const, detail: "claude not found on PATH" };
  assert.deepEqual(harnessCheck(missing), missing);
  // `omi task run`/`analyze` refuse before anything starts.
  assert.throws(() => harnessGate({ harnessVersion: () => "2.3.1" }, undefined), {
    code: "CONFIG_INVALID",
    message: /claude 2\.3\.1 is outside the verified range.*omi doctor/,
  });
  harnessGate({ harnessVersion: () => "2.1.325" }, undefined);
  harnessGate({ runAgent: () => "" }, undefined); // a fake runner spawns no real CLI
});

test("doctor: a gateway profile warns about the third party; bearer is not verified yet", () => {
  const bearer = { ...gw, name: "gw-b", auth: { ...gw.auth, scheme: "bearer" } };
  const checks = profilesCheck(seeded([gw, bearer], ["cc-gw", "gw-b"]), KEYED);
  const warn = checks.filter((c) => c.status === "warn");
  assert.equal(warn.length, 2);
  assert.match(warn[0]?.detail ?? "", /third party: it sees the code and prompts.*zero-width/);
  assert.doesNotMatch(warn[0]?.detail ?? "", /bearer/);
  assert.match(warn[1]?.detail ?? "", /scheme bearer is not verified yet/);
});

/** A stream-json transcript of a probe run. */
const transcript = (model: string, result: object = { is_error: false, result: "OK" }) =>
  [
    JSON.stringify({ type: "assistant", message: { model, content: [{ type: "text" }] } }),
    JSON.stringify({ type: "result", ...result }),
  ].join("\n");

test("doctor --probe (#219): one short run per active profile; gateway lists models first", () => {
  const ws = seeded([sub, gw, { ...gw, name: "off", disabled: true }], ["cc-sub", "cc-gw"]);
  const env = { PATH: "/bin", ...KEYED, ANTHROPIC_API_KEY: "sk-host" };
  const gets: { url: string; headers: Record<string, string> }[] = [];
  const runs: Parameters<ClaudeRun>[0][] = [];
  const checks = probeProfiles(ws, env, {
    http: (url, headers) => {
      gets.push({ url, headers });
      return { status: 200, body: JSON.stringify({ data: [{ id: "claude-opus-5-5" }] }) };
    },
    claude: (o) => {
      runs.push(o);
      return transcript(o.args[o.args.indexOf("--model") + 1] as string);
    },
  });
  assert.deepEqual(
    checks.map((c) => [c.name, c.status]),
    [
      ["probe cc-sub", "pass"],
      ["probe cc-gw", "pass"],
    ],
  );
  assert.match(checks[0]?.detail ?? "", /auth ok, message\.model claude-opus-5-5, effort high/);
  assert.deepEqual(
    gets.map((g) => [g.url, g.headers["x-api-key"] === SECRET]),
    [["https://gw.example.com/v1/models", true]],
  );
  // Auth only from the profile: the host's API key never reaches the subscription run.
  assert.equal(runs[0]?.env.CLAUDE_CODE_OAUTH_TOKEN, SECRET);
  assert.equal(runs[0]?.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(runs[1]?.env.ANTHROPIC_BASE_URL, "https://gw.example.com");
  assert.ok(!JSON.stringify(checks).includes(SECRET));
});

test("doctor --probe: 402, missing model, auth error, wrong model and quota fail, redacted", () => {
  const ws = seeded([gw], ["cc-gw"]);
  const env = KEYED;
  const never: ClaudeRun = () => assert.fail("no run after a failed model list");
  const probe = (http: HttpGet, claude: ClaudeRun = never) =>
    probeProfiles(ws, env, { http, claude })[0];
  const p402 = probe(() => ({ status: 402, body: `need credit, key ${SECRET}` }));
  assert.equal(p402?.status, "fail");
  assert.match(p402?.detail ?? "", /GET \/v1\/models → 402 \(out of credit\)/);
  assert.ok(!(p402?.detail ?? "").includes(SECRET));
  assert.match(
    probe(() => ({ status: 200, body: '{"data":[{"id":"claude-haiku-5-5"}]}' }))?.detail ?? "",
    /does not list claude-opus-5-5/,
  );
  const listed = () => ({ status: 200, body: '{"data":[{"id":"claude-opus-5-5"}]}' });
  const failed = { is_error: true, api_error_status: 401, result: "Invalid API key" };
  assert.match(
    probe(listed, () => transcript("<synthetic>", failed))?.detail ?? "",
    /run failed: Invalid API key/,
  );
  assert.match(
    probe(listed, () => transcript("claude-haiku-5-5"))?.detail ?? "",
    /asked claude-opus-5-5, the host saw claude-haiku-5-5/,
  );
  const quota = { is_error: true, api_error_status: 402, result: "credit" };
  assert.match(
    probe(listed, () => transcript("<synthetic>", quota))?.detail ?? "",
    /out of quota \(http_402\)/,
  );
  assert.match(probe(listed, () => "")?.detail ?? "", /no result/);
  assert.equal(probeProfiles(workspace(), {})[0]?.status, "pass"); // no profile: nothing to probe
  assert.match(probeProfiles(ws, {})[0]?.detail ?? "", /OMI_SECRET_KEY is not set/);
});
