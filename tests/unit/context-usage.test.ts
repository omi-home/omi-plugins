// DevTask-0066 #201: `/context` parsing, classification and `omi context plan` with a fake claude.
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  type ContextRunner,
  humanContextPlan,
  measureRole,
  measureWorkspace,
} from "../../runtime/cli/context.ts";
import { contextSummary } from "../../runtime/cli/doctor.ts";
import { classify, parseContext, tokenCount } from "../../runtime/core/context-usage.ts";

const WS = process.platform === "win32" ? "C:\\ws" : "/ws";
const SAMPLE = `## Context Usage

**Model:** claude-opus-5-5
**Tokens:** 38.7k / 1m (4%)

### Estimated usage by category

| Category | Tokens | Percentage |
|----------|--------|------------|
| System prompt | 2.9k | 0.3% |
| System tools | 17.7k | 1.8% |
| Skills | 10k | 1.0% |

### MCP Tools

| Tool | Server | Tokens |
|------|--------|--------|
| mcp__claude_ai_Google_Drive__copy_file | claude_ai_Google_Drive | 554 |
| mcp__claude_ai_Google_Drive__create_file | claude_ai_Google_Drive | 1.3k |

### Memory Files

| Type | Path | Tokens |
|------|------|--------|
| Project | ${join(WS, "AGENTS.md")} | 3.5k |
| User | ${join(WS, "..", "home", "CLAUDE.md")} | 120 |

### Skills

| Skill | Source | Tokens |
|-------|--------|--------|
| brand | User | ~60 |
| superpowers:brainstorming | Plugin (superpowers) | ~80 |
| superpowers:writing-plans | Plugin (superpowers) | ~40 |
| omi-task | Project | ~30 |
| pdf | Built-in | ~150 |

### Custom Agents

| Agent Type | Source | Tokens |
|------------|--------|--------|
| omi-engineering:backend-engineer | Plugin | 51 |
| helper | User | 40 |
`;

test("tokenCount: k, m, ~ and plain numbers", () => {
  assert.deepEqual(
    ["7.1k", "~170", "661", "1m", "junk"].map(tokenCount),
    [7100, 170, 661, 1_000_000, 0],
  );
});

test("parseContext: total, categories, items rolled up per server and plugin", () => {
  const u = parseContext(SAMPLE);
  assert.equal(u.total, 38_700);
  assert.deepEqual(
    u.categories.map((c) => [c.name, c.tokens]),
    [
      ["System prompt", 2900],
      ["System tools", 17_700],
      ["Skills", 10_000],
    ],
  );
  assert.deepEqual(
    u.items.map((i) => [i.kind, i.id, i.tokens]),
    [
      ["mcp", "claude_ai_Google_Drive", 1854],
      ["memory", join(WS, "AGENTS.md"), 3500],
      ["memory", join(WS, "..", "home", "CLAUDE.md"), 120],
      ["skill", "brand", 60],
      ["plugin", "superpowers", 120],
      ["skill", "omi-task", 30],
      ["skill", "pdf", 150],
      ["plugin", "omi-engineering", 51],
      ["agent", "helper", 40],
    ],
  );
  assert.deepEqual(parseContext("no tables").items, []);
});

test("classify: keep list and OMI's own are needed, user-level extras unneeded, rest unknown", () => {
  const o = { keep: ["brand"], workspace: WS };
  const cls = Object.fromEntries(parseContext(SAMPLE).items.map((i) => [i.id, classify(i, o)]));
  assert.deepEqual(cls, {
    claude_ai_Google_Drive: "unneeded",
    [join(WS, "AGENTS.md")]: "needed",
    [join(WS, "..", "home", "CLAUDE.md")]: "unknown",
    brand: "needed",
    superpowers: "unneeded",
    "omi-task": "needed",
    pdf: "unknown",
    "omi-engineering": "needed",
    helper: "unknown",
  });
});

test("plan: workspace runs plain claude -p; a role runs as omi task run would, fixed categories reported only", () => {
  const calls: Parameters<ContextRunner>[0][] = [];
  const run: ContextRunner = (o) => {
    calls.push(o);
    return SAMPLE;
  };
  const ws = measureWorkspace({ workspace: WS, keep: [], run });
  const pluginRoot = fileURLToPath(new URL("../../", import.meta.url));
  const role = measureRole({ role: "backend-engineer", keep: [], run, pluginRoot, hostEnv: {} });
  assert.deepEqual(calls[0], { cwd: WS, args: ["-p"] });
  assert.deepEqual(calls[1]?.args.slice(0, 3), [
    "-p",
    "--agent",
    "omi-engineering:backend-engineer",
  ]);
  assert.ok(calls[1]?.env?.CLAUDE_CONFIG_DIR, "fresh config dir");
  assert.equal(role.target, "backend-engineer");
  const lines = humanContextPlan({ keep: [], targets: [ws] });
  assert.match(lines[0] ?? "", /^workspace\s+38\.7k tokens at start \(2\.0k in unneeded items\)$/);
  assert.ok(lines.includes("  fixed     System tools 17.7k (no switch: reported only)"));
  assert.ok(!lines.some((l) => l.includes("Skills 10.0k")), "categories with a switch are items");
});

test("doctor context check: total and a pointer to omi context plan", () => {
  assert.deepEqual(contextSummary(SAMPLE), {
    name: "context",
    status: "pass",
    detail: "38.7k tokens at session start: `omi context plan` classifies them",
  });
});
