// T5.3 Code/Security Reviewer, Manual/Automation QA, DevOps, live (costs tokens: OMI_LIVE=1):
// each loads exactly its own packs; on a diff with an injection + hard-coded secret the Security
// Reviewer owns the finding and the Code Reviewer only routes it; Automation QA authors tests (not
// just runs them); Manual QA reports through its section; DevOps stays in its scope.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentLaunch, observeRun } from "../../runtime/adapters/claude/launch.ts";
import type { Role } from "../../runtime/core/contracts.ts";
import {
  acceptStepResult,
  buildTaskPacket,
  packetPrompt,
} from "../../runtime/core/handoff/packet.ts";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const live = process.env.OMI_LIVE === "1" && spawnSync("claude", ["--version"]).status === 0;
const skip = !live && "set OMI_LIVE=1 (costs tokens)";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const packId = (rel: string) =>
  /^Pack-ID: (\S+)$/m.exec(readFileSync(join(pluginRoot, rel), "utf8"))?.[1] as string;
const allIds = (readdirSync(join(pluginRoot, "resources"), { recursive: true }) as string[])
  .filter((f) => f.endsWith(".md"))
  .map((f) => packId(join("resources", f)));
const idsOf = (role: Role) =>
  [
    ...readFileSync(join(pluginRoot, "agents", `${role}.md`), "utf8").matchAll(
      /\$\{CLAUDE_PLUGIN_ROOT\}\/(resources\/\S+\.md)/g,
    ),
  ].map((m) => packId(m[1] as string));

const READ = ["Bash(git status*)", "Bash(git diff*)", "Bash(git log*)", "Bash(git show*)"];
const EDIT = [...READ, "Bash(git add*)", "Bash(git commit*)", "Bash(npm test)"];

function launch(role: Role, prompt: string, cwd: string, edits: boolean) {
  const l = buildAgentLaunch({
    pluginRoot,
    role,
    worktree: cwd,
    prompt,
    fromSource: true,
    acceptEdits: edits,
    allowedTools: edits ? EDIT : READ,
  });
  const r = spawnSync(
    l.command,
    [...l.args, "--setting-sources", "project,local", "--no-session-persistence"],
    // Without this, `npm test` inside the agent thinks it is nested in this test run and skips.
    {
      cwd: l.cwd,
      input: l.stdin,
      encoding: "utf8",
      timeout: 900_000,
      env: { ...process.env, NODE_TEST_CONTEXT: undefined },
    },
  );
  assert.equal(r.status, 0, r.stderr);
  return observeRun(r.stdout);
}

/** Notes app at `base`; `change` (if any) is committed on top as the task's work. */
function fixture(change: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "omi-t53-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  mkdirSync(join(dir, "src"));
  const write = (files: Record<string, string>) => {
    for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  };
  write({
    "AGENTS.md":
      "# Notes app\n- `src/`: CommonJS backend; tests are `src/*.test.js` with node:test; run `npm test`.\n- CI: GitHub Actions under `.github/workflows/`.\n",
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
function packet(
  role: Role,
  dir: string,
  base: string,
  stepId: string,
  body: string,
  scope: string[] = [],
) {
  return buildTaskPacket({
    workflowRunId: "9-eval",
    issue: ISSUE,
    stepId,
    role,
    round: 1,
    attempt: 1,
    scope,
    worktree: dir,
    baseSha: base,
    issueContext: [
      { issue: ISSUE, type: "dev-task", title: "DevTask-0001-Notes", body, truncated: false },
    ],
    openFindings: [],
    carriedFindings: [],
    readOnlyArtifacts: [],
  });
}

const LOGIN = {
  "src/login.js":
    // Fake key assembled at runtime so secret scanners do not flag this repository.
    `const db = require('./db');\nconst API_KEY = '${["sk", "live", "51HxYzFAKEkey0123456789"].join("_")}';\n` +
    '// POST /login {user, password}\nfunction login(user, password) {\n  return db.query("SELECT * FROM users WHERE name = \'" + user + "\' AND password = \'" + password + "\'");\n}\nmodule.exports = { login, API_KEY };\n',
};
const LOGIN_ISSUE =
  "## Scope / Acceptance\n- `login(user, password)` in `src/login.js` returns the matching user row for valid credentials.\n";

const ROLES: Role[] = [
  "code-reviewer",
  "security-reviewer",
  "manual-qa-engineer",
  "automation-qa-engineer",
  "devops-engineer",
];
for (const role of ROLES) {
  test(`live ${role}: loads exactly its own packs; model observed, effort unknown`, {
    skip,
  }, () => {
    const o = launch(
      role,
      "Which rule packs did you load? Reply with their Pack-IDs only.",
      fixture().dir,
      false,
    );
    for (const id of idsOf(role)) assert.ok(o.result.includes(id), `${id} missing: ${o.result}`);
    for (const id of allIds.filter((x) => !idsOf(role).includes(x))) {
      assert.ok(!o.result.includes(id), `foreign pack ${id}`);
    }
    assert.match(o.actualModel, role.endsWith("reviewer") ? /^claude-opus-/ : /^claude-sonnet-/);
    assert.equal(o.actualEffort, "unknown");
  });
}

test("live security-reviewer: injection + hard-coded secret → SEC findings, never PASSED", {
  skip,
}, () => {
  const { dir, base } = fixture(LOGIN);
  const p = packet("security-reviewer", dir, base, "security-review", LOGIN_ISSUE);
  const r = acceptStepResult(p, launch("security-reviewer", packetPrompt(p), dir, false).result);
  assert.notEqual(r.status, "PASSED");
  assert.ok(
    r.findings.some((f) => ["critical", "high"].includes(f.severity)),
    JSON.stringify(r.findings),
  );
  assert.ok(r.findings.every((f) => f.id.startsWith("SEC-")));
});

test("live code-reviewer: same diff → no security findings of its own, routes to security review", {
  skip,
}, () => {
  const { dir, base } = fixture(LOGIN);
  const p = packet("code-reviewer", dir, base, "code-review", LOGIN_ISSUE);
  const r = acceptStepResult(p, launch("code-reviewer", packetPrompt(p), dir, false).result);
  assert.ok(r.findings.every((f) => f.id.startsWith("CR-")));
  assert.match(r.nextAction ?? "", /^security-review:/);
});

const SEARCH = {
  "src/search.js":
    "function searchNotes(notes, q) {\n  if (!q) return notes;\n  const n = q.toLowerCase();\n  return notes.filter((x) => x.title.toLowerCase().includes(n));\n}\nmodule.exports = { searchNotes };\n",
};
const SEARCH_ISSUE =
  "## Scope / Acceptance\n- AC-1: `searchNotes(notes, q)` returns notes whose title contains `q`, case-insensitive.\n- AC-2: an empty or missing `q` returns all notes.\n";

test("live automation-qa-engineer: authors tests for the criteria, production code untouched", {
  skip,
}, () => {
  const { dir, base } = fixture(SEARCH);
  const tip = git(dir, "rev-parse", "HEAD");
  const p = packet(
    "automation-qa-engineer",
    dir,
    base,
    "qa-automation",
    `${SEARCH_ISSUE}\nAutomated coverage for AC-1 and AC-2 is missing.\n`,
    ["src/"],
  );
  const r = acceptStepResult(
    p,
    launch("automation-qa-engineer", packetPrompt(p), dir, true).result,
  );
  assert.equal(r.status, "PASSED", r.summary);
  const changed = git(dir, "diff", "--name-only", tip).split("\n").filter(Boolean);
  assert.ok(changed.length && changed.every((f) => /\.test\.js$/.test(f)), `${changed}`);
});

test("live manual-qa-engineer: test cases per criterion in its qa section, no edits", {
  skip,
}, () => {
  const { dir, base } = fixture(SEARCH);
  const p = packet("manual-qa-engineer", dir, base, "qa-manual", SEARCH_ISSUE);
  const r = acceptStepResult(p, launch("manual-qa-engineer", packetPrompt(p), dir, false).result);
  assert.notEqual(r.status, "BLOCKED", r.blockerReason);
  const qa = r.sectionUpdates.find((u) => u.section === "qa")?.markdown ?? "";
  if (r.status === "PASSED")
    assert.match(qa, /### Test cases[\s\S]*AC-1[\s\S]*AC-2|### Test cases[\s\S]*AC-2[\s\S]*AC-1/);
  assert.equal(git(dir, "status", "--porcelain"), "");
});

test("live devops-engineer: CI workflow running the repo's own test command, inside .github/", {
  skip,
}, () => {
  const { dir, base } = fixture();
  const p = packet(
    "devops-engineer",
    dir,
    base,
    "implement",
    "## Scope / Acceptance\n- A GitHub Actions workflow runs `npm test` on every pull request (Node 22).\n",
    [".github/"],
  );
  const r = acceptStepResult(p, launch("devops-engineer", packetPrompt(p), dir, true).result);
  assert.equal(r.status, "PASSED", r.summary);
  const changed = git(dir, "diff", "--name-only", base).split("\n").filter(Boolean);
  assert.ok(
    changed.length && changed.every((f) => f.startsWith(".github/workflows/")),
    `${changed}`,
  );
  assert.match(readFileSync(join(dir, changed[0] as string), "utf8"), /npm test/);
});
