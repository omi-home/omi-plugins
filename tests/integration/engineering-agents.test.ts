// T5.2 Frontend / Backend / Database Engineers, live (costs tokens: OMI_LIVE=1). Each gets a narrow
// task with a packet scope and an upstream contract in issueContext: edits stay in scope, the
// contract's names are used verbatim, the result is accepted. Backend also runs a round-2 rework
// whose diff is limited to the open finding (delta rework).
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentLaunch, observeRun } from "../../runtime/adapters/claude/launch.ts";
import type { Finding, Role } from "../../runtime/core/contracts.ts";
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

/** Notes app: Node test runner, static UI, SQL migrations. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omi-t52-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  for (const d of ["src", "public", "db/migrations"]) mkdirSync(join(dir, d), { recursive: true });
  const files: Record<string, string> = {
    "AGENTS.md":
      "# Notes app\n- `src/`: backend logic (CommonJS), tests next to code as `*.test.js`, run `npm test`.\n- `public/`: static HTML UI.\n- `db/migrations/`: numbered SQL migrations (`NNN_name.sql`), never edit an applied one.\n",
    "package.json": JSON.stringify({
      name: "notes",
      private: true,
      scripts: { test: "node --test" },
    }),
    "README.md": "Notes app.\n",
    "src/notes.js":
      "const notes = [{ id: 1, title: 'Groceries' }, { id: 2, title: 'Gym plan' }];\nmodule.exports = { notes };\n",
    "public/index.html":
      '<!doctype html>\n<html lang="en"><body>\n<main>\n<h1>Notes</h1>\n<ul id="notes"></ul>\n</main>\n</body></html>\n',
    "db/migrations/001_init.sql":
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, title TEXT NOT NULL);\n",
  };
  for (const [p, c] of Object.entries(files)) writeFileSync(join(dir, p), c);
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

const ISSUE = { repository: "o/notes", number: 8 };
const FEATURE =
  "## Objective\nSearch notes by title (case-insensitive substring); an empty query returns all notes.\n";

function step(
  role: Role,
  dir: string,
  base: string,
  o: { scope: string[]; body: string; round?: number; openFindings?: Finding[] },
) {
  const packet = buildTaskPacket({
    workflowRunId: "8-eval",
    issue: ISSUE,
    stepId: "implement",
    role,
    round: o.round ?? 1,
    attempt: 1,
    scope: o.scope,
    worktree: dir,
    baseSha: base,
    issueContext: [
      {
        issue: ISSUE,
        type: "dev-task",
        title: "DevTask-0001-Search notes",
        body: o.body,
        truncated: false,
      },
      {
        issue: { ...ISSUE, number: 7 },
        type: "feature",
        title: "Feature-0001-Search notes",
        body: FEATURE,
        truncated: false,
      },
    ],
    openFindings: o.openFindings ?? [],
    carriedFindings: [],
    readOnlyArtifacts: [],
  });
  const l = buildAgentLaunch({
    pluginRoot,
    role,
    worktree: dir,
    prompt: packetPrompt(packet),
    fromSource: true,
    acceptEdits: true,
    allowedTools: [
      "Bash(git status*)",
      "Bash(git diff*)",
      "Bash(git log*)",
      "Bash(git add*)",
      "Bash(git commit*)",
      "Bash(npm test)",
    ],
  });
  const r = spawnSync(
    l.command,
    [...l.args, "--setting-sources", "project,local", "--no-session-persistence"],
    {
      cwd: l.cwd,
      input: l.stdin,
      encoding: "utf8",
      timeout: 900_000,
    },
  );
  assert.equal(r.status, 0, r.stderr);
  const result = acceptStepResult(packet, observeRun(r.stdout).result); // throws on out-of-scope claims
  assert.equal(result.status, "PASSED", result.blockerReason ?? result.summary);
  return result;
}

/** Every file changed since `from` (committed or not) lies under one of `scope`. */
function assertInScope(dir: string, from: string, scope: string[]) {
  const changed = [
    ...git(dir, "diff", "--name-only", from).split("\n"),
    ...git(dir, "ls-files", "--others", "--exclude-standard").split("\n"),
  ].filter(Boolean);
  assert.ok(changed.length > 0, "nothing changed");
  for (const f of changed)
    assert.ok(
      scope.some((s) => f.startsWith(s)),
      `${f} outside ${scope}`,
    );
  return changed;
}

const ARCH_BACKEND =
  "## Scope / Acceptance\nBackend part of the search feature.\n\n<!-- omi:section=architecture -->\n### Contracts\n- `src/search.js` exports `searchNotes(notes, query)` → array of notes whose `title` contains `query`, case-insensitive; empty or missing query returns `notes` unchanged.\n### Work split\n- Backend: `src/search.js` + `src/search.test.js`. Frontend and database are separate tasks.\n<!-- /omi:section=architecture -->\n";

test("live backend-engineer: contract names verbatim, stays in scope; round-2 rework is a delta", {
  skip,
}, () => {
  const { dir, base } = fixture();
  const r1 = step("backend-engineer", dir, base, { scope: ["src/"], body: ARCH_BACKEND });
  assertInScope(dir, base, ["src/"]);
  assert.match(readFileSync(join(dir, "src/search.js"), "utf8"), /searchNotes/);
  const tip1 = git(dir, "rev-parse", "HEAD");
  assert.notEqual(tip1, base);

  const finding: Finding = {
    id: "CR-001",
    severity: "medium",
    path: "src/search.js",
    observed: "A query with surrounding spaces (' gym ') matches nothing.",
    expected:
      "Trim the query before matching; a whitespace-only query returns all notes. Add a test.",
  };
  const r2 = step("backend-engineer", dir, base, {
    scope: ["src/"],
    body: ARCH_BACKEND,
    round: 2,
    openFindings: [finding],
  });
  const delta = assertInScope(dir, tip1, ["src/"]);
  assert.ok(
    delta.every((f) => f.startsWith("src/search")),
    `rework touched ${delta}`,
  );
  assert.match(readFileSync(join(dir, "src/search.js"), "utf8"), /trim/);
  assert.ok(r1.commitSha && r2.commitSha && r1.commitSha !== r2.commitSha);
});

test("live frontend-engineer: builds the design contract inside public/ only", { skip }, () => {
  const { dir, base } = fixture();
  const body =
    '## Scope / Acceptance\nFrontend part of the search feature.\n\n<!-- omi:section=design -->\n### Screens and components\n- Above `#notes`: a text input `id="search"` with a visible `<label for="search">Search notes</label>`; typing filters the list client-side by title, case-insensitive.\n### Accessibility\n- The label is visible and tied to the input; the list keeps its semantics.\n<!-- /omi:section=design -->\n';
  step("frontend-engineer", dir, base, { scope: ["public/"], body });
  assertInScope(dir, base, ["public/"]);
  const html = readFileSync(join(dir, "public/index.html"), "utf8");
  assert.match(html, /id="search"/);
  assert.match(html, /Search notes/);
});

test("live database-engineer: new migration for the contract, applied one untouched", {
  skip,
}, () => {
  const { dir, base } = fixture();
  const body =
    "## Scope / Acceptance\nDatabase part of the search feature.\n\n<!-- omi:section=architecture -->\n### Contracts\n- Search filters `notes` by `lower(title)`; add an index named `idx_notes_title_lower` on `lower(title)`.\n<!-- /omi:section=architecture -->\n";
  step("database-engineer", dir, base, { scope: ["db/"], body });
  const changed = assertInScope(dir, base, ["db/"]);
  assert.ok(!changed.includes("db/migrations/001_init.sql"), "edited an applied migration");
  const added = changed.filter((f) => /^db\/migrations\/\d{3}_.+\.sql$/.test(f));
  assert.equal(added.length, 1, `${changed}`);
  assert.match(readFileSync(join(dir, added[0] as string), "utf8"), /idx_notes_title_lower/);
});
