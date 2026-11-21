// AC-7 (Feature-0043 #321): every path the outside world uses to reach the plugin still exists after
// a refactor moved files: .claude-plugin/*.json, hooks/hooks.json, agent-pack/hooks/hooks.json, the
// scripts of package.json and the launcher bin/omi.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel)) as unknown;

/** Every string value of a JSON document. */
function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

const missing = (paths: Iterable<[from: string, path: string]>) =>
  [...paths].filter(([, p]) => !existsSync(p)).map(([from, p]) => `${from}: ${p}`);

test("paths in .claude-plugin/*.json exist", () => {
  const found: [string, string][] = [];
  for (const file of [
    ".claude-plugin/plugin.json",
    ".claude-plugin/marketplace.json",
    "agent-pack/.claude-plugin/plugin.json",
  ]) {
    for (const s of strings(readJson(file))) {
      // Path values are explicit relative paths (`./`, `../`); URLs and prose are not.
      if (/^\.\.?\//.test(s)) found.push([file, resolve(root, s)]);
    }
  }
  assert.ok(found.length > 0, "the marketplace names the plugin source");
  assert.deepEqual(missing(found), []);
});

for (const [file, pluginRoot] of [
  ["hooks/hooks.json", root],
  ["agent-pack/hooks/hooks.json", join(root, "agent-pack")],
] as const) {
  test(`hook commands of ${file} point at existing files`, () => {
    const found: [string, string][] = [];
    for (const s of strings(readJson(file))) {
      for (const m of s.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/g)) {
        found.push([file, resolve(pluginRoot, m[1] as string)]);
      }
    }
    assert.ok(found.length > 0, "the hooks run the omi launcher");
    assert.deepEqual(missing(found), []);
  });
}

test("scripts of package.json point at existing files", () => {
  const { scripts } = readJson("package.json") as { scripts: Record<string, string> };
  const found: [string, string][] = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    for (const m of cmd.matchAll(/\bnode\s+(?:--[\w-]+\s+)*"?([\w./-]+)"?/g)) {
      const target = m[1] as string;
      // A glob (`tests/**`) is a pattern; its static directory must exist instead.
      if (!target.includes("*")) found.push([`scripts.${name}`, resolve(root, target)]);
    }
  }
  assert.ok(found.length > 0, "package.json runs node on repo files");
  assert.deepEqual(missing(found), []);
});

test("bin/omi imports files that exist", () => {
  const found: [string, string][] = [];
  for (const m of read("bin/omi").matchAll(/import\(\s*["'](\.[^"']+)["']\s*\)/g)) {
    found.push(["bin/omi", resolve(dirname(join(root, "bin", "omi")), m[1] as string)]);
  }
  assert.ok(found.length > 0, "bin/omi loads the runtime");
  assert.deepEqual(missing(found), []);
});
