// T5.1 BA / Solution Architect / UI/UX: live canary (each agent sees exactly its default skills) and a
// narrow evaluation task (a real task packet → an accepted step result proposing only the role's
// Issue section, no file changes). Costs tokens: opt in with OMI_LIVE=1.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  acceptStepResult,
  buildTaskPacket,
  packetPrompt,
} from "../../../runtime/handoff/application/packet.ts";
import { claudeCode, spawnAgent } from "../../../runtime/harness/adapters/claude-code/harness.ts";
import { observeRun } from "../../../runtime/harness/adapters/claude-code/launch.ts";
import { ROLE_SECTION, type Role } from "../../../runtime/shared/contracts.ts";
import { roleSkills, writeRoleFiles } from "../../../runtime/task-run/adapters/role-files.ts";
import { prepareAgent } from "../../../runtime/task-run/application/slice.ts";

const pluginRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
const live = process.env.OMI_LIVE === "1" && spawnSync("claude", ["--version"]).status === 0;
const skip = !live && "set OMI_LIVE=1 (costs tokens)";

/** Skill canary (#199): an agent sees exactly the skills OMI installed for its step. */
const allIds = readdirSync(join(pluginRoot, "agent-pack", "skill-library"));
const idsOf = (role: Role) => roleSkills(pluginRoot, role).default;

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

/** The agent runs in the task workspace around the clone `cwd` (#168). */
function run(role: Role, prompt: string, cwd: string) {
  const l = prepareAgent({
    harness: claudeCode,
    roleFiles: { writeRoleFiles },
    pluginRoot,
    role,
    category: "analysis",
    edits: false,
    checks: [],
    taskRoot: dirname(cwd),
    worktree: cwd,
    prompt,
  });
  return observeRun(spawnAgent(l));
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
  const dir = join(mkdtempSync(join(tmpdir(), "omi-t51-")), "notes");
  mkdirSync(dir);
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
  test(`live ${r.role}: sees exactly its default skills; model observed, effort unknown`, {
    skip,
  }, () => {
    const o = run(
      r.role,
      "Which skills are available to you? Reply with their names only.",
      fixture().dir,
    );
    for (const id of idsOf(r.role)) assert.ok(o.result.includes(id), `${id} missing: ${o.result}`);
    for (const id of allIds.filter((x) => !idsOf(r.role).includes(x))) {
      assert.ok(!o.result.includes(id), `foreign skill ${id}`);
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
