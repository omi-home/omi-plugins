// DevTask-0063 #197: agent-pack/skill-library holds the role skills approved in Spike-0011 #196;
// each role agent declares its default and allowed skills; adapted skills name their source.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { Role } from "../../runtime/shared/contracts.ts";
import { roleSkills } from "../../runtime/task-run/adapters/role-files.ts";

const root = new URL("../../agent-pack/", import.meta.url);
const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const library = readdirSync(new URL("skill-library/", root)).sort();
const roles = readdirSync(new URL("agents/", root)).map((f) => f.replace(/\.md$/, ""));
const notices = readFileSync(new URL("../THIRD_PARTY_NOTICES", root), "utf8");

/** Skills adapted from an outside repository (Spike-0011 §2) → the repositories they cite. */
const ADAPTED: Record<string, string[]> = {
  "test-driven-development": ["obra/superpowers"],
  "systematic-debugging": ["obra/superpowers"],
  "verification-before-completion": ["obra/superpowers"],
  "receiving-review-findings": ["obra/superpowers"],
  "minimal-change": ["DietrichGebert/ponytail"],
  "over-engineering-review": ["DietrichGebert/ponytail"],
  "visual-direction": ["Leonxlnx/taste-skill", "Nutlope/hallmark"],
  "anti-slop-review": ["Nutlope/hallmark", "Leonxlnx/taste-skill"],
  "ux-guidelines-check": ["nextlevelbuilder/ui-ux-pro-max-skill"],
};

test("the library holds the 33 approved skills", () => {
  assert.equal(library.length, 33);
});

for (const name of library) {
  test(`skill-library/${name}: frontmatter, short description, size, no rule-pack leftovers`, () => {
    const text = read(`skill-library/${name}/SKILL.md`);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
    assert.match(front, new RegExp(`^name: ${name}$`, "m"));
    assert.match(front, /^description: Use (when|before|on) .{20,110}$/m, "short, says when");
    assert.equal(front.split("\n").length, 2, "only name and description");
    assert.ok(Buffer.byteLength(text) <= 6000, `${name}: ${Buffer.byteLength(text)} bytes`);
    assert.doesNotMatch(text, /Pack-ID|rule pack|human partner|git push|gh pr /i);
  });
}

test("adapted skills cite repo, path and commit listed in THIRD_PARTY_NOTICES", () => {
  for (const name of library) {
    const text = read(`skill-library/${name}/SKILL.md`);
    const cited = [...text.matchAll(/^Source: ([\w.-]+\/[\w.-]+) \S+.* @ ([0-9a-f]{7})\b.*MIT/gm)];
    assert.deepEqual(
      cited.map((m) => m[1]).sort(),
      [...(ADAPTED[name] ?? [])].sort(),
      `${name}: Source lines`,
    );
    for (const [, repo, sha] of cited) {
      assert.match(
        notices,
        new RegExp(`^${repo} @ ${sha}[0-9a-f]{33}\\n[\\s\\S]*?MIT License`, "m"),
      );
    }
  }
});

test("no skill-library or agent file names a removed role (DevTask-0131 #382)", () => {
  const removed = /(frontend|backend|database|devops)[ -]engineer|(manual|automation)[ -]qa/i;
  const files: string[] = [];
  for (const dir of ["skill-library", "agents", "agents-md"]) {
    const base = join(pluginRoot, "agent-pack", dir);
    for (const e of readdirSync(base, { recursive: true, withFileTypes: true })) {
      if (e.isFile()) files.push(join(e.parentPath, e.name));
    }
  }
  assert.ok(files.length > 40);
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), removed, f);
});

test("every role declares default and allowed skills that exist; each skill has a role", () => {
  const used = new Set<string>();
  assert.equal(roles.length, 7);
  for (const role of roles) {
    const s = roleSkills(pluginRoot, role as Role);
    assert.ok(s.default.length >= 1 && s.default.length <= 3, `${role}: default ≤ 3`);
    for (const k of [...s.default, ...s.allowed]) {
      assert.ok(library.includes(k), `${role}: unknown skill ${k}`);
      used.add(k);
    }
    assert.equal(new Set([...s.default, ...s.allowed]).size, s.default.length + s.allowed.length);
  }
  assert.deepEqual([...used].sort(), library);
});
