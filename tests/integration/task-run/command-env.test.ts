// DevTask-0094 #283 (ARC-001): the repo's check/setup commands never see the master key or auth
// variables; the agent gets the decrypted token in its child env only. Real processes.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../../../runtime/cli/main.ts";
import { buildAgentLaunch } from "../../../runtime/harness/adapters/claude-code/launch.ts";
import { generateMasterKey } from "../../../runtime/profile/domain/secrets.ts";
import type { Selection } from "../../../runtime/profile/domain/selection.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import { Profile } from "../../../runtime/shared/contracts.ts";
import { commandEnv } from "../../../runtime/shared/process/command-env.ts";
import { runChecks } from "../../../runtime/task-run/adapters/checks.ts";
import { runSetup } from "../../../runtime/task-run/adapters/setup.ts";
import { commandEnvFor } from "../../../runtime/task-run/cli/common.ts";

const CANARY = "canary-token-value-0123456789";
const dir = () => mkdtempSync(join(tmpdir(), "omi-cmdenv-"));
const PRINT_ENV = `node -e "console.log(JSON.stringify(Object.keys(process.env)))"`;
const VARS = {
  OMI_SECRET_KEY: CANARY,
  OMI_SECRET_KEY_NEXT: CANARY,
  CLAUDE_CODE_OAUTH_TOKEN: CANARY,
  ANTHROPIC_API_KEY: CANARY,
  ANTHROPIC_AUTH_TOKEN: CANARY,
  OMI_T_SUB: CANARY,
  KEEP_ME: "visible",
};

test("commandEnv drops the master key, its _NEXT, auth variables and profile token variables", () => {
  const env = commandEnv(
    { ...VARS, my_key: CANARY, PATH: "/bin" },
    { keyEnv: "MY_KEY", tokenEnvs: ["OMI_T_SUB"] },
  );
  assert.deepEqual(
    Object.keys(env).sort(),
    ["KEEP_ME", "OMI_SECRET_KEY", "OMI_SECRET_KEY_NEXT", "PATH"].sort(),
  );
  // Default key name when none is configured; matching is case-insensitive (Windows).
  const dflt = commandEnv({ omi_secret_key: CANARY, KEEP_ME: "x" });
  assert.deepEqual(Object.keys(dflt), ["KEEP_ME"]);
});

test("commandEnvFor: a custom secrets.keyEnv and the DB profiles' token variables are dropped (CR-003)", () => {
  const ws = dir();
  mkdirSync(join(ws, ".omi-plugins"));
  mkdirSync(join(ws, "repo", ".git"), { recursive: true });
  writeFileSync(join(ws, ".omi-plugins", "omi.config.yaml"), "secrets:\n  keyEnv: MY_KEY\n");
  const key = generateMasterKey();
  const added = main(
    [
      "profile",
      "add",
      "p1",
      "--auth",
      "subscription",
      "--token-env",
      "OMI_T_SUB",
      "--models",
      "m1",
      "--efforts",
      "high",
      "--output",
      "json",
    ],
    ws,
    { env: { MY_KEY: key, OMI_PROFILE_DB: join(ws, "profiles.sqlite") } },
  );
  assert.equal(added.code, 0, added.stdout);
  const env = commandEnvFor(ws, {
    MY_KEY: key,
    OMI_PROFILE_DB: join(ws, "profiles.sqlite"),
    OMI_T_SUB: CANARY,
    ANTHROPIC_API_KEY: CANARY,
    KEEP_ME: "visible",
    PATH: "/bin",
  });
  // The profiles come from the machine DB the host env points at; OMI_PROFILE_DB itself is dropped.
  assert.deepEqual(Object.keys(env).sort(), ["KEEP_ME", "PATH"]);
});

test("checks run by default without the master key and auth variables of the host", () => {
  const saved = Object.fromEntries(Object.keys(VARS).map((k) => [k, process.env[k]]));
  Object.assign(process.env, VARS);
  try {
    const r = runChecks({
      worktree: dir(),
      logDir: join(dir(), "logs"),
      checks: parseConfig({
        github: { owner: "o", repo: "r", projectNumber: 1 },
        checks: { lint: { run: PRINT_ENV } },
      }).checks,
    });
    const log = readFileSync(r.results.find((x) => x.name === "lint")?.logPath ?? "", "utf8");
    assert.ok(!log.includes(CANARY));
    const names = JSON.parse(log) as string[];
    for (const k of ["OMI_SECRET_KEY", "OMI_SECRET_KEY_NEXT", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      assert.ok(!names.some((n) => n.toUpperCase() === k), k);
    }
    assert.ok(names.includes("KEEP_ME"));
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("setup runs with the env it is given, a filtered one by caller", () => {
  const wt = dir();
  const gitDir = dir();
  const logDir = join(dir(), "logs");
  const r = runSetup({
    worktree: wt,
    gitDir,
    logDir,
    setup: { run: PRINT_ENV, timeoutSec: 60 },
    env: commandEnv({ ...process.env, ...VARS }, { tokenEnvs: ["OMI_T_SUB"] }),
  });
  const names = JSON.parse(readFileSync(r.logPath ?? "", "utf8")) as string[];
  assert.ok(names.includes("KEEP_ME"));
  for (const k of ["OMI_SECRET_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OMI_T_SUB"]) {
    assert.ok(!names.includes(k), k);
  }
});

test("buildAgentLaunch: the token reaches the child env only, never argv; redact knows it", () => {
  const profile = Profile.parse({
    name: "cc-sub",
    harness: "claudecode",
    auth: { type: "subscription", tokenEnv: "OMI_T_SUB" },
    models: ["m1"],
    efforts: ["high"],
  });
  const sel: Selection = {
    profile,
    model: "m1",
    effort: "high",
    reason: "r",
    secret: () => CANARY,
  };
  const root = dir();
  const launch = buildAgentLaunch({
    pluginRoot: root,
    role: "backend-engineer",
    taskRoot: root,
    worktree: join(root, "repo"),
    prompt: "do it",
    hostEnv: { PATH: "/bin", ...VARS },
    selection: sel,
  });
  assert.equal(launch.env.CLAUDE_CODE_OAUTH_TOKEN, CANARY);
  assert.equal(launch.env.OMI_SECRET_KEY, undefined);
  assert.ok(!launch.args.join(" ").includes(CANARY));
  assert.ok(!launch.stdin.includes(CANARY));
  assert.ok(!JSON.stringify({ ...launch, env: undefined }).includes(CANARY));
  assert.ok(!JSON.stringify(sel).includes(CANARY));
  // A gateway profile gets its own variable; the bearer scheme uses the auth-token name.
  const gw = Profile.parse({
    name: "gw",
    harness: "claudecode",
    auth: {
      type: "gateway",
      baseUrl: "https://gw.example.com",
      scheme: "bearer",
      keyEnv: "OMI_T_GW",
    },
    models: ["m1"],
    efforts: ["high"],
  });
  const g = buildAgentLaunch({
    pluginRoot: root,
    role: "backend-engineer",
    taskRoot: root,
    worktree: join(root, "repo"),
    prompt: "do it",
    hostEnv: {},
    selection: { ...sel, profile: gw },
  });
  assert.equal(g.env.ANTHROPIC_AUTH_TOKEN, CANARY);
  assert.equal(g.env.ANTHROPIC_BASE_URL, "https://gw.example.com");
});
