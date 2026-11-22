// DevTask-0067 #202: `omi context apply` writes only the workspace .claude/settings.json, keeps
// foreign keys, re-runs unchanged, and `--remove` takes back exactly what OMI added.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  APPLIED_FILE,
  type ContextRunner,
  contextApply,
} from "../../../runtime/context/cli/context.ts";
import {
  addContext,
  desiredContext,
  removeContext,
} from "../../../runtime/context/domain/context-settings.ts";

const CONTEXT = `**Tokens:** 20k / 1m (2%)

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__claude_ai_Drive__x | claude_ai_Drive | 900 |
| mcp__local__y | local | 100 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| brand | User | ~60 |
| keepme | User | ~60 |
| superpowers:x | Plugin (superpowers) | ~80 |
| omi-coordinator:omi-task | Plugin (omi-coordinator) | ~30 |
`;

function workspace(settings: object) {
  const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-ctx-")));
  execFileSync("git", ["init", "-q", "-b", "develop"], { cwd: ws });
  mkdirSync(join(ws, ".omi-plugins"));
  mkdirSync(join(ws, ".claude"));
  writeFileSync(
    join(ws, ".omi-plugins", "omi.config.yaml"),
    "github:\n  owner: o\n  repo: repo\n  projectNumber: 2\ncontext:\n  keep: [keepme]\n",
  );
  writeFileSync(join(ws, ".claude", "settings.json"), JSON.stringify(settings));
  const user = mkdtempSync(join(tmpdir(), "omi-ctx-user-"));
  writeFileSync(
    join(user, "settings.json"),
    JSON.stringify({ enabledPlugins: { "superpowers@market": true, "other@m": true } }),
  );
  const userBefore = readFileSync(join(user, "settings.json"), "utf8");
  return { ws, user, userBefore };
}

test("apply: dry-run diff, write, re-run unchanged, remove restores; foreign keys and ~/.claude kept", () => {
  const original = {
    autoMemoryDirectory: "x",
    enabledPlugins: { "omi-coordinator@omi-plugins": true },
    skillOverrides: { brand: "name-only" },
  };
  const { ws, user, userBefore } = workspace(original);
  // After apply the switched-off items vanish from /context: the record keeps them wanted.
  let ctx = CONTEXT;
  const run: ContextRunner = () => ctx;
  const deps = { cwd: ws, run, userConfigDir: user };
  const file = join(ws, ".claude", "settings.json");

  const dry = contextApply({ ...deps, dryRun: true });
  assert.deepEqual(dry.diff, [
    "+ enabledPlugins.superpowers@market = false",
    "+ enabledPlugins.superpowers@synced = false",
    '+ deniedMcpServers[local] = {"serverName":"local"}',
    "+ disableClaudeAiConnectors = true",
  ]);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), original, "dry-run writes nothing");

  const first = contextApply(deps);
  assert.ok(first.changed);
  const applied = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(applied.autoMemoryDirectory, "x");
  assert.equal(applied.skillOverrides.brand, "name-only", "a key the PO set stays theirs");
  assert.equal(applied.skillOverrides.keepme, undefined, "context.keep is never switched off");
  assert.equal(applied.enabledPlugins["omi-coordinator@omi-plugins"], true);
  assert.equal(applied.enabledPlugins["other@m"], undefined, "only unneeded plugins");

  ctx = "**Tokens:** 15k / 1m (1%)\n";
  const again = contextApply(deps);
  assert.equal(again.changed, false);
  assert.deepEqual(again.diff, []);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), applied);

  const removed = contextApply({ ...deps, remove: true });
  assert.ok(removed.changed);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), original);
  assert.ok(!existsSync(join(ws, ".omi-plugins", APPLIED_FILE)));
  assert.equal(
    readFileSync(join(user, "settings.json"), "utf8"),
    userBefore,
    "~/.claude untouched",
  );
});

test("desired/add/remove: bundled only on request, PO values never claimed", () => {
  const want = desiredContext({
    unneeded: [{ kind: "skill", id: "s", source: "User", tokens: 1 }],
    userPluginIds: [],
    bundled: true,
  });
  assert.equal(want.disableBundledSkills, true);
  assert.equal(
    desiredContext({ unneeded: [], userPluginIds: [], bundled: false }).disableBundledSkills,
    false,
  );
  const { settings, applied } = addContext(
    { disableBundledSkills: false, skillOverrides: { s: "on" } },
    want,
  );
  assert.deepEqual(applied.skillOverrides, []);
  assert.equal(applied.disableBundledSkills, false);
  assert.deepEqual(removeContext(settings, applied), settings);
});
