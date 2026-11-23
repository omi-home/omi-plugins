// Specialist agents (spec §3–§4, ADR-0003 D4): every agent is a known Role with the Skill tool
// (skills come from the task workspace, DevTask-0065 #199), no rule pack any more, and the runtime's
// read-only role list matches what the agents may do.
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  NON_DELIVERY_ROLES,
  READ_ONLY_ROLES,
  Role,
  VERDICT_ROLES,
} from "../../runtime/shared/contracts.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string) => readFileSync(join(root, p), "utf8");

const agents = readdirSync(join(root, "agent-pack", "agents"))
  .filter((f) => f.endsWith(".md"))
  .map((file) => {
    const src = read(`agent-pack/agents/${file}`);
    const front = /^---\n([\s\S]*?)\n---\n/.exec(src.replaceAll("\r\n", "\n"))?.[1] ?? "";
    const field = (k: string) => new RegExp(`^${k}: (.*)$`, "m").exec(front)?.[1]?.trim();
    const list = (k: string) =>
      (field(k) ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    return {
      file,
      src,
      front,
      name: field("name"),
      tools: list("tools"),
      disallowed: list("disallowedTools"),
    };
  });

test("every agent is a Role named after its file and may use skills; no rule pack is left", () => {
  assert.deepEqual(agents.map((a) => a.name).sort(), [...Role.options].sort(), "all seven roles");
  for (const a of agents) {
    assert.equal(`${a.name}.md`, a.file);
    assert.ok(a.tools.includes("Skill"), `${a.file}: Skill tool (verified: needed to see skills)`);
    assert.ok(!a.disallowed.includes("Skill"), `${a.file} must not disallow Skill`);
    assert.doesNotMatch(a.front, /^(skills|isolation):/m, a.file);
    assert.doesNotMatch(a.src, /CLAUDE_PLUGIN_ROOT|Read tool|omi:rule-pack|resources\//, a.file);
    assert.match(a.src, /BLOCKED: OMI rules missing/, a.file);
  }
  assert.equal(existsSync(join(root, "resources")), false, "role-rules and shared are gone");
});

test("code review leaves security to the Security Reviewer (no duplicated lens)", () => {
  const cr = read("agent-pack/skill-library/semantic-code-review/SKILL.md");
  assert.match(cr, /Security is the Security Reviewer's job/);
  assert.match(read("agent-pack/agents-md/code-reviewer.md"), /security-review:/);
  assert.match(read("agent-pack/agents-md/qa-engineer.md"), /never called just to run/);
});

test("DevTask-0131 #382: seven roles, the six merged ones are gone from agents and agents-md", () => {
  assert.deepEqual([...Role.options].sort(), [
    "business-analyst",
    "code-reviewer",
    "qa-engineer",
    "security-reviewer",
    "software-engineer",
    "solution-architect",
    "ui-ux-designer",
  ]);
  const parts = readdirSync(join(root, "agent-pack", "agents-md")).sort();
  for (const old of ["frontend", "backend", "database", "devops", "manual-qa", "automation-qa"]) {
    assert.ok(!existsSync(join(root, "agent-pack", "agents", `${old}-engineer.md`)), old);
    assert.ok(!parts.includes(`${old}-engineer.md`), old);
  }
  // Both QA duties in one role: it writes test files (not read-only) and has a verdict.
  assert.ok(!READ_ONLY_ROLES.includes("qa-engineer"));
  assert.ok(VERDICT_ROLES.includes("qa-engineer"));
  // The analysts are never in a delivery plan (the SA only runs as the escalation step).
  for (const r of NON_DELIVERY_ROLES) assert.ok(Role.options.includes(r));
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
