// T5.1 BA / Solution Architect / UI/UX: live canary (each agent loads exactly its own packs) and a
// narrow evaluation task (a real task packet → an accepted step result proposing only the role's
// Issue section, no file changes). Costs tokens: opt in with OMI_LIVE=1.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildAgentLaunch, observeRun } from "../../runtime/adapters/claude/launch.ts";
import { ROLE_SECTION, type Role } from "../../runtime/core/contracts.ts";
import {
  acceptStepResult,
  buildTaskPacket,
  packetPrompt,
} from "../../runtime/core/handoff/packet.ts";

const pluginRoot = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const live = process.env.OMI_LIVE === "1" && spawnSync("claude", ["--version"]).status === 0;
const skip = !live && "set OMI_LIVE=1 (costs tokens)";

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

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

function run(role: Role, prompt: string, cwd: string) {
  const l = buildAgentLaunch({ pluginRoot, role, worktree: cwd, prompt, fromSource: true });
  const r = spawnSync(
    l.command,
    [...l.args, "--setting-sources", "project,local", "--no-session-persistence"],
    {
      cwd: l.cwd,
      input: l.stdin,
      encoding: "utf8",
      timeout: 600_000,
    },
  );
  assert.equal(r.status, 0, r.stderr);
  return observeRun(r.stdout);
}

const ROLES: { role: Role; model: RegExp; stepId: string; heading: string }[] = [
  {
    role: "business-analyst",
    model: /^claude-sonnet-/,
    stepId: "analysis",
    heading: "### Acceptance criteria",
  },
  {
    role: "ui-ux-designer",
    model: /^claude-sonnet-/,
    stepId: "design",
    heading: "### Accessibility",
  },
  {
    role: "solution-architect",
    model: /^claude-opus-/,
    stepId: "design",
    heading: "### Work split",
  },
];

/** A tiny web app repo and a UI feature Issue every role has something to say about. */
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "omi-t51-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  writeFileSync(
    join(dir, "AGENTS.md"),
    "# Notes app\nExpress backend in server.js, static HTML UI in public/.\n",
  );
  writeFileSync(join(dir, "server.js"), "// GET /notes returns [{id,title}]\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  return { dir, base: git(dir, "rev-parse", "HEAD") };
}

for (const r of ROLES) {
  test(`live ${r.role}: loads exactly its own packs; model observed, effort unknown`, {
    skip,
  }, () => {
    const o = run(
      r.role,
      "Which rule packs did you load? Reply with their Pack-IDs only.",
      fixture().dir,
    );
    for (const id of idsOf(r.role)) assert.ok(o.result.includes(id), `${id} missing: ${o.result}`);
    for (const id of allIds.filter((x) => !idsOf(r.role).includes(x))) {
      assert.ok(!o.result.includes(id), `foreign pack ${id}`);
    }
    assert.match(o.actualModel, r.model);
    assert.equal(o.actualEffort, "unknown");
    assert.deepEqual(o.permissionDenials, []);
  });

  test(`live ${r.role}: narrow task → accepted result, own section only, no file changes`, {
    skip,
  }, () => {
    const { dir, base } = fixture();
    const issue = { repository: "o/notes", number: 7 };
    const packet = buildTaskPacket({
      workflowRunId: "7-eval",
      issue,
      stepId: r.stepId,
      role: r.role,
      round: 1,
      attempt: 1,
      scope: [],
      worktree: dir,
      baseSha: base,
      issueContext: [
        {
          issue,
          type: "feature",
          title: "Feature-0001-Search notes by title",
          body: "## Objective\nUsers can type in a search box above the notes list and see only notes whose title contains the text (case-insensitive). Empty box shows all notes.\n",
          truncated: false,
        },
      ],
      openFindings: [],
      carriedFindings: [],
      readOnlyArtifacts: [],
    });
    const o = run(r.role, packetPrompt(packet), dir);
    const result = acceptStepResult(packet, o.result);
    assert.notEqual(result.status, "FAILED", result.summary);
    if (result.status === "PASSED") {
      assert.equal(result.sectionUpdates.length, 1);
      assert.equal(result.sectionUpdates[0]?.section, ROLE_SECTION[r.role]);
      assert.ok(
        result.sectionUpdates[0]?.markdown.includes(r.heading),
        result.sectionUpdates[0]?.markdown,
      );
    }
    assert.deepEqual(result.changedFiles, []);
    assert.equal(git(dir, "status", "--porcelain"), "");
  });
}
