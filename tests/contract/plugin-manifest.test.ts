// Plugin/marketplace manifests must pass the host validator in strict mode (unknown fields fail).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { PLUGIN_NAME } from "../../runtime/adapters/claude/launch.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (p: string) => JSON.parse(readFileSync(root + p, "utf8"));

const plugin = readJson(".claude-plugin/plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");
const agentPack = readJson("agent-pack/.claude-plugin/plugin.json");

test("plugin identity is consistent across manifests and package.json", () => {
  assert.equal(plugin.name, "omi-coordinator");
  assert.equal(plugin.version, readJson("package.json").version);
  assert.deepEqual(
    marketplace.plugins.map((p: { name: string; source: string }) => [p.name, p.source]),
    [["omi-coordinator", "./"]],
  );
});

test("ADR-0003 D3: role agents live only in agent-pack (omi-engineering), skills only at the root", () => {
  assert.equal(agentPack.name, PLUGIN_NAME);
  assert.equal(agentPack.version, plugin.version, "bump agent-pack with the plugin");
  assert.equal(existsSync(root + "agents"), false);
  assert.ok(readdirSync(root + "agent-pack/agents").length >= 11);
  assert.equal(existsSync(root + "agent-pack/skills"), false);
  assert.ok(readdirSync(root + "skills").every((s) => s.startsWith("omi-")));
});

const hasClaude = spawnSync("claude", ["--version"]).status === 0;

for (const target of [
  ".claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
  "agent-pack/.claude-plugin/plugin.json",
]) {
  test(`claude plugin validate --strict ${target}`, {
    skip: !hasClaude && "claude CLI not on PATH",
  }, () => {
    // Throws (non-zero exit) on any error or warning.
    execFileSync("claude", ["plugin", "validate", target, "--strict"], {
      cwd: root,
      stdio: "pipe",
    });
  });
}
