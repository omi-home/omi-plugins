// Enforces the root layout contract (spec §5, docs/architecture/overview.md) on tracked files.
// New root folders require an ADR first; update ALLOWED_ROOT_DIRS in the same PR.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";

const ALLOWED_ROOT_DIRS = new Set([
  ".claude-plugin",
  ".github",
  ".omi", // per-repo OMI config contract (runtime/core/config.ts); this repo runs OMI on itself
  "agents",
  "bin",
  "config",
  "docs",
  "evals",
  "hooks",
  "resources",
  "runtime",
  "schemas",
  "skills",
  "templates",
  "tests",
  "workflows",
]);

const repoRoot = new URL("../../", import.meta.url);
const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: repoRoot, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

test("tracked root folders stay within the directory contract", () => {
  const rootDirs = new Set(tracked.filter((p) => p.includes("/")).map((p) => p.split("/")[0]));
  const unapproved = [...rootDirs].filter((d) => d !== undefined && !ALLOWED_ROOT_DIRS.has(d));
  assert.deepEqual(unapproved, [], `unapproved root folders (ADR required): ${unapproved}`);
});

test("canonical instructions file is AGENTS.md, no CLAUDE.md shim", () => {
  assert.ok(tracked.includes("AGENTS.md"));
  assert.ok(!tracked.includes("CLAUDE.md"), "CLAUDE.md needs an approved compatibility decision");
});

test("skills/ holds only Coordinator entry skills (ADR-0001 D3)", () => {
  const skills = tracked.filter((p) => p.startsWith("skills/"));
  assert.ok(skills.length > 0);
  for (const p of skills) assert.match(p, /^skills\/omi-[a-z-]+\/SKILL\.md$/);
});
