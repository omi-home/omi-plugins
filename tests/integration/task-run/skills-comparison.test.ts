// TestTask-0001 #200, live (costs tokens: OMI_LIVE=1): one engineer and the Code Reviewer on fixed
// sample tasks; records the startup context (`/context` Tokens), REPORT status, turns and tokens so
// the same file can run on an older commit (baseline before #199) and on `develop` for a before/after
// table. Only APIs that exist on both sides: role defaults come from prepareAgent itself.
// Each run appends one JSON line to $OMI_PROBE_OUT when set.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseContext } from "../../../runtime/context/domain/context-usage.ts";
import {
  acceptStepResult,
  buildTaskPacket,
  packetPrompt,
} from "../../../runtime/handoff/application/packet.ts";
import { claudeCode, spawnAgent } from "../../../runtime/harness/adapters/claude-code/harness.ts";
import { observeRun } from "../../../runtime/harness/adapters/claude-code/launch.ts";
import type { Role } from "../../../runtime/shared/contracts.ts";
import { writeRoleFiles } from "../../../runtime/task-run/adapters/role-files.ts";
import { prepareAgent } from "../../../runtime/task-run/application/slice.ts";

const pluginRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
const live = process.env.OMI_LIVE === "1" && spawnSync("claude", ["--version"]).status === 0;
const skip = !live && "set OMI_LIVE=1 (costs tokens)";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function fixture(change: Record<string, string> = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), "omi-t200-")), "notes");
  mkdirSync(join(dir, "src"), { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  const write = (files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  };
  write({
    "AGENTS.md":
      "# Notes app\n- `src/`: CommonJS backend; tests are `src/*.test.js` with node:test; run `npm test`.\n",
    "package.json": JSON.stringify({
      name: "notes",
      private: true,
      scripts: { test: "node --test" },
    }),
    "src/db.js": "module.exports = { query: (sql, params) => ({ sql, params }) };\n",
  });
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  const base = git(dir, "rev-parse", "HEAD");
  if (Object.keys(change).length) {
    write(change);
    git(dir, "add", ".");
    git(dir, "commit", "-qm", "task work");
  }
  return { dir, base };
}

const ISSUE = { repository: "o/notes", number: 9 };

interface Case {
  role: Role;
  stepId: string;
  edits: boolean;
  scope: string[];
  body: string;
  change?: Record<string, string>;
}

const CASES: Case[] = [
  {
    role: "backend-engineer",
    stepId: "implement",
    edits: true,
    scope: ["src/"],
    body: "## Scope / Acceptance\n- AC-1: `searchNotes(notes, q)` in `src/search.js` returns notes whose title contains `q`, case-insensitive.\n- AC-2: an empty or missing `q` returns all notes.\n- Tests for AC-1 and AC-2 in `src/search.test.js`.\n",
  },
  {
    role: "code-reviewer",
    stepId: "code-review",
    edits: false,
    scope: [],
    body: "## Scope / Acceptance\n- `paginate(items, page, size)` in `src/page.js` returns page `page` (1-based) of `size` items.\n",
    change: {
      // Off-by-one on purpose: page 1 skips the first `size` items.
      "src/page.js":
        "function paginate(items, page, size) {\n  return items.slice(page * size, page * size + size);\n}\nmodule.exports = { paginate };\n",
    },
  },
];

/** Startup context of the agent: the same launch with `/context` instead of the prompt. */
function startupTokens(l: ReturnType<typeof prepareAgent>): number {
  mkdirSync(l.configDir, { recursive: true });
  const args = l.args.filter((a) => !["--output-format", "stream-json", "--verbose"].includes(a));
  const r = spawnSync("claude", args, {
    cwd: l.cwd,
    env: l.env,
    input: "/context",
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(r.status, 0, r.stderr);
  return parseContext(r.stdout ?? "").total;
}

for (const c of CASES) {
  test(`live ${c.role}: startup context, REPORT, turns and tokens on the sample task`, {
    skip,
  }, (t) => {
    const { dir, base } = fixture(c.change);
    const packet = buildTaskPacket({
      workflowRunId: "9-eval",
      issue: ISSUE,
      stepId: c.stepId,
      role: c.role,
      round: 1,
      attempt: 1,
      scope: c.scope,
      worktree: dir,
      baseSha: base,
      issueContext: [
        {
          issue: ISSUE,
          type: "dev-task",
          title: "DevTask-0001-Notes",
          body: c.body,
          truncated: false,
        },
      ],
      openFindings: [],
      carriedFindings: [],
      readOnlyArtifacts: [],
    });
    const l = prepareAgent({
      harness: claudeCode,
      roleFiles: { writeRoleFiles },
      pluginRoot,
      role: c.role,
      category: c.edits ? "implementation" : "review",
      edits: c.edits,
      taskRoot: dirname(dir),
      worktree: dir,
      prompt: packetPrompt(packet),
      checks: c.edits ? ["npm test"] : [],
    });
    const contextTokens = startupTokens(l);
    const stream = spawnAgent(l);
    const o = observeRun(stream);
    // Tool calls by name (Skill shows whether the installed skills were opened).
    const tools: Record<string, number> = {};
    for (const m of stream.matchAll(/"type":"tool_use","id":"[^"]*","name":"([^"]+)"/g)) {
      tools[m[1] as string] = (tools[m[1] as string] ?? 0) + 1;
    }
    const r = acceptStepResult(packet, o.result);
    const u = o.usage;
    const row = {
      commit: git(pluginRoot, "rev-parse", "--short", "HEAD"),
      role: c.role,
      model: o.actualModel,
      contextTokens,
      status: r.status,
      findings: r.findings.map((f) => `${f.id}:${f.severity}`),
      turns: u?.numTurns,
      tools,
      inputTokens: u?.inputTokens,
      outputTokens: u?.outputTokens,
      cacheReadTokens: u?.cacheReadTokens,
      cacheCreationTokens: u?.cacheCreationTokens,
      costUsd: u?.costUsd,
      durationMs: o.durationMs,
    };
    t.diagnostic(JSON.stringify(row));
    if (process.env.OMI_PROBE_OUT)
      appendFileSync(process.env.OMI_PROBE_OUT, `${JSON.stringify(row)}\n`);
    assert.ok(contextTokens > 0, "no /context Tokens");
    assert.notEqual(r.status, "BLOCKED", r.blockerReason);
    if (c.edits) assert.equal(r.status, "PASSED", r.summary);
    // The planted off-by-one is the review's whole point.
    else assert.ok(r.findings.length > 0, JSON.stringify(r));
  });
}
