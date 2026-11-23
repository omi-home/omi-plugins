// DevTask-0128 #373: `omi task analyze` under both github.model values. v2: `omi move <n> "In progress"`
// before the agents and `omi sync` after, both reported, no direct Status write. legacy: Analysis then
// Waiting PO/Blocked written directly, the engine never called. The analysis agent is a stub that
// fails technically, which ends the run BLOCKED: enough to reach the Project writes on both sides.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stepReports } from "../../../runtime/reporting/adapters/step-reports.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { taskAnalyze as analyze } from "../../../runtime/task-run/cli/analyze.ts";
import { engineDeps, fakeGithub, queryOf, routeGh } from "../../unit/github/lifecycle-fake.ts";

const taskAnalyze = (deps: Omit<Parameters<typeof analyze>[0], "reports">, issue: number) =>
  analyze({ ...deps, reports: stepReports }, issue);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(model: string) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-ana-")));
  git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(base, "clone", "-q", "origin.git", "repo");
  const root = join(base, "repo");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  mkdirSync(join(root, ".omi-plugins"));
  writeFileSync(
    join(root, ".omi-plugins", "omi.config.yaml"),
    `github:\n  owner: o\n  repo: repo\n  projectNumber: 2\n  model: ${model}\n`,
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  git(root, "push", "-q", "origin", "main");
  return root;
}

/** The Issue #3 (a Feature) and the legacy Project writes of the command, recorded in `statuses`. */
function ticketGh(model: string) {
  const statuses: string[] = [];
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const item = { id: "ITEM_3", project: { number: 2, owner: { login: "o" } } };
  const run: GhRunner = (args, input) => {
    const q = queryOf(args, input);
    if (q.includes("{viewer{login}}")) return ok({ viewer: { login: "po" } });
    if (q.includes("updateProjectV2ItemFieldValue")) {
      statuses.push(args.find((a) => a.startsWith("o=")) ?? "");
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "ITEM_3" } } });
    }
    if (q.includes('field(name:"Status")')) {
      const options = ["Analysis", "Waiting PO", "Blocked", "In Progress"].map((n) => ({
        id: `OPT_${n}`,
        name: n,
      }));
      return ok({ repositoryOwner: { projectV2: { id: "P", field: { id: "F", options } } } });
    }
    if (q.includes("blockedBy")) {
      return ok({
        repository: {
          issue: {
            number: 3,
            title: "Feature-0003-F",
            state: "OPEN",
            body: "## Objective\nx\n\n## Scope / Acceptance\n- [ ] done",
            issueType: { name: model === "v2" ? "UserStory" : "Feature" },
            labels: { totalCount: 1, nodes: [{ name: "type:feature" }] },
            parent: null,
            subIssuesSummary: { total: 0, completed: 0 },
            blockedBy: { totalCount: 0, nodes: [] },
            projectItems: {
              totalCount: 1,
              nodes: [{ ...item, isArchived: false, fieldValueByName: { name: "Ready" } }],
            },
          },
        },
      });
    }
    if (args[1] !== "graphql") return { status: 0, stdout: "[[]]", stderr: "" };
    return ok({
      repository: {
        issue: {
          number: 3,
          parent: null,
          projectItems: { nodes: [{ ...item, fieldValueByName: { name: "Ready" } }] },
        },
      },
    });
  };
  return { run, statuses };
}

const failingAgent = () => {
  throw new Error("agent unavailable");
};

test("analyze legacy: Analysis then Blocked/Waiting PO are written directly; engine never called", () => {
  const root = repo("legacy");
  const gh = ticketGh("legacy");
  const r = taskAnalyze({ cwd: root, gh: gh.run, runAgent: failingAgent }, 3);
  assert.equal(r.engine, undefined);
  assert.equal(r.move, undefined);
  assert.ok(r.status);
  assert.equal(gh.statuses[0], "o=OPT_Analysis");
  assert.equal(gh.statuses.length, 2);
});

test("analyze v2: move In progress before the agents, sync after, both reported; no direct Status write", () => {
  const root = repo("v2");
  const gh = ticketGh("v2");
  // The engine's view of #3: a type whose Ready → In progress is a coordinator move (a UserStory's is
  // `auto`, so the engine refuses to `move` it: see the hand-off note of DevTask-0128).
  const project = fakeGithub([{ number: 3, type: "DevTask", status: "Ready" }]);
  const routed = routeGh(project.run, gh.run, /blockedBy|viewer\{login\}/);
  const r = taskAnalyze(
    { cwd: root, gh: routed.run, runAgent: failingAgent, state: engineDeps() },
    3,
  );
  assert.equal(r.move?.command, "move");
  assert.equal(r.engine?.command, "sync");
  assert.equal(r.status, null);
  assert.deepEqual(gh.statuses, []); // setStatus was never taken
  assert.equal(project.byNumber(3).status, "In progress");
});
