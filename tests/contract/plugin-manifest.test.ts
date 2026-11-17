// Plugin/marketplace manifests must pass the host validator in strict mode (unknown fields fail).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const readJson = (p: string) => JSON.parse(readFileSync(root + p, "utf8"));

const plugin = readJson(".claude-plugin/plugin.json");
const marketplace = readJson(".claude-plugin/marketplace.json");

test("plugin identity is consistent across manifests and package.json", () => {
  assert.equal(plugin.name, "omi-engineering");
  assert.equal(plugin.version, readJson("package.json").version);
  assert.deepEqual(
    marketplace.plugins.map((p: { name: string; source: string }) => [p.name, p.source]),
    [["omi-engineering", "./"]],
  );
});

const hasClaude = spawnSync("claude", ["--version"]).status === 0;

for (const target of [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"]) {
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
