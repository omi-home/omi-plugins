// Specialist agents and their resource packs (spec §3–§4, ADR-0001 D3): every agent is a known
// Role, never loads skills, reads only existing packs by explicit path, each pack file carries a
// unique Pack-ID canary, and the runtime's read-only role list matches what the agents may do.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { READ_ONLY_ROLES, Role } from "../../runtime/core/contracts.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

const agents = readdirSync(join(root, "agents"))
  .filter((f) => f.endsWith(".md"))
  .map((file) => {
    const src = read(`agents/${file}`);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(src.replaceAll("\r\n", "\n"))?.[1] ?? "";
    const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(front)?.[1]?.trim();
    const list = (k: string) =>
      (field(k) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return {
      file,
      front,
      name: field("name"),
      tools: list("tools"),
      disallowed: list("disallowedTools"),
      packs: [...src.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/(resources\/\S+\.md)/g)].map(
        (m) => m[1] as string,
      ),
    };
  });

const resourceFiles = (readdirSync(join(root, "resources"), { recursive: true }) as string[])
  .map((f) => `resources/${f.replaceAll("\\", "/")}`)
  .filter((f) => f.endsWith(".md"));
const packId = (p: string) => /^Pack-ID: (\S+)$/m.exec(read(p))?.[1];

test("every agent is a Role named after its file, blocks Skill, has no skills:/isolation:", () => {
  assert.ok(agents.length >= 5);
  for (const a of agents) {
    assert.equal(`${a.name}.md`, a.file);
    assert.ok(Role.safeParse(a.name).success, `${a.name} is not a Role`);
    assert.ok(a.disallowed.includes("Skill"), `${a.file} must disallow Skill`);
    assert.doesNotMatch(a.front, /^(skills|isolation):/m, a.file);
    assert.ok(a.packs.length > 0, `${a.file} loads no rule pack`);
  }
});

test("agents load only existing pack files; each file has a unique Pack-ID and an owner", () => {
  const ids = resourceFiles.map(packId);
  assert.ok(ids.every(Boolean), "a resource file lacks a Pack-ID line");
  assert.equal(new Set(ids).size, ids.length, "duplicate Pack-ID");
  const loaded = new Set(agents.flatMap((a) => a.packs));
  for (const p of loaded) assert.ok(resourceFiles.includes(p), `${p} does not exist`);
  for (const f of resourceFiles) assert.ok(loaded.has(f), `${f} is loaded by no agent`);
});

test("role → resource pack map follows the spec baseline; shared knowledge is not copied", () => {
  const packs = (name: string) => agents.find((a) => a.name === name)?.packs ?? [];
  assert.deepEqual(packs("business-analyst"), [
    "resources/role-rules/analysis/requirement-analysis.md",
    "resources/role-rules/analysis/acceptance-criteria.md",
  ]);
  assert.deepEqual(packs("ui-ux-designer"), [
    "resources/role-rules/design/ux-flows.md",
    "resources/role-rules/design/ui-design.md",
    "resources/role-rules/design/accessibility.md",
  ]);
  assert.deepEqual(packs("solution-architect"), [
    "resources/role-rules/architecture/system-design.md",
    "resources/shared/api-contracts.md",
    "resources/role-rules/architecture/adr-management.md",
    "resources/role-rules/architecture/root-cause-analysis.md",
  ]);
  // A role loads only its own pack folder plus shared/.
  for (const a of agents) {
    const folders = new Set(a.packs.map((p) => p.split("/").slice(0, -1).join("/")));
    const own = [...folders].filter((f) => f !== "resources/shared");
    assert.equal(own.length, 1, `${a.file} reads several role packs: ${own}`);
  }
  assert.ok(
    !resourceFiles.some(
      (f) => f.startsWith("resources/role-rules/") && f.endsWith("/api-contracts.md"),
    ),
  );
});

test("READ_ONLY_ROLES is exactly the agents that cannot Edit/Write", () => {
  const readOnly = agents
    .filter((a) => a.disallowed.includes("Edit") && a.disallowed.includes("Write"))
    .map((a) => a.name)
    .sort();
  assert.deepEqual(readOnly, [...READ_ONLY_ROLES].sort());
  for (const a of agents) {
    if (READ_ONLY_ROLES.includes(a.name as Role)) {
      assert.ok(!a.tools.some((t) => ["Edit", "Write", "NotebookEdit"].includes(t)), a.file);
    }
  }
});
