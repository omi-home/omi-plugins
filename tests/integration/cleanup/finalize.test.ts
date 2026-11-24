// T4.4 `omi task finalize` against a fake GitHub and a real local origin: happy path with
// Feature/Milestone roll-up, failure at each step (no merge, report not posted, cleanup failed,
// status write failed) never shows Done, and a rerun resumes to exactly one cleanup comment.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { cleanupApply, cleanupScan } from "../../../runtime/cleanup/cli/cleanup.ts";
import { taskFinalize as finalize } from "../../../runtime/cleanup/cli/finalize.ts";
import { prBody } from "../../../runtime/release/adapters/pr.ts";
import { stepReports } from "../../../runtime/reporting/adapters/step-reports.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { openState, statePath } from "../../../runtime/shared/sqlite/db.ts";
import {
  acquireLease,
  advanceRun,
  beginAttempt,
  createRun,
  enqueueReport,
  releaseLease,
  startStep,
} from "../../../runtime/task-run/adapters/repository.ts";
import { ensureTaskWorkspace } from "../../../runtime/task-run/adapters/worktree.ts";
import { taskStatus } from "../../../runtime/task-run/cli/task-status.ts";
import { engineDeps, fakeGithub, routeGh } from "../../unit/github/lifecycle-fake.ts";

/** `omi task finalize` with the reporting adapter the composition root hands it. */
const taskFinalize = (deps: Omit<Parameters<typeof finalize>[0], "reports">, issue: number) =>
  finalize({ ...deps, reports: stepReports }, issue);

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

interface Fake {
  /** PR #9 from the task branch is merged on GitHub. */
  merged: boolean;
  tip: string;
  branch: string;
  /** Project Status by issue number. */
  status: Record<number, string>;
  parents: Record<number, number>;
  labels: Record<number, string[]>;
  open: Set<number>;
  children: Record<number, number[]>;
  comments: { id: number; body: string }[];
  failComments?: number;
  failStatus?: number;
  /** Close reason by issue number (default COMPLETED). */
  reason?: Record<number, string>;
  /** Legacy PR: no omi:pr-primary marker, only GitHub's closing link to these issues. */
  closing?: string[];
  /** Issue body by number (parent scope, Bug-0001 #162). */
  bodies?: Record<number, string>;
}

function fakeGh(f: Fake): GhRunner {
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const down = { status: 1, stdout: "", stderr: "HTTP 503: Service Unavailable" };
  return (args, input) => {
    if (args[1] !== "graphql") {
      if (f.failComments && f.failComments-- > 0) return down;
      const url = args.find((a) => a.startsWith("repos/")) ?? "";
      if (args.includes("--paginate")) {
        return { status: 0, stdout: JSON.stringify([f.comments.map(rest)]), stderr: "" };
      }
      const body = JSON.parse(input ?? "{}").body as string;
      const id = Number(/comments\/(\d+)$/.exec(url)?.[1] ?? 0);
      const c = id ? f.comments.find((x) => x.id === id) : undefined;
      if (c) c.body = body;
      else f.comments.push({ id: 100 + f.comments.length, body });
      return {
        status: 0,
        stdout: JSON.stringify(rest(c ?? (f.comments.at(-1) as never))),
        stderr: "",
      };
    }
    const query = (args[3] ?? "").slice("query=".length);
    const vars: Record<string, string> = Object.fromEntries(
      args
        .slice(4)
        .filter((_, i) => i % 2 === 1)
        .map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
    );
    const n = Number(vars.number);
    if (query.includes("viewerPermission")) {
      const pr = {
        id: "PR9",
        number: 9,
        url: "https://github.com/o/repo/pull/9",
        state: "MERGED",
        isDraft: false,
        merged: true,
        mergedAt: "2026-11-18T00:00:00Z",
        mergeable: "UNKNOWN",
        reviewDecision: null,
        baseRefName: "develop",
        headRefName: f.branch,
        headRefOid: f.tip,
        title: "DevTask-0005-Task 5",
        body: f.closing ? "Closes #5" : prBody("o/repo", 5),
        mergeCommit: { oid: "c".repeat(40) },
        labels: { nodes: [] },
        commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
      };
      return ok({
        repository: {
          isPrivate: false,
          viewerPermission: "WRITE",
          squashMergeAllowed: true,
          mergeCommitAllowed: false,
          rebaseMergeAllowed: false,
          ref: null,
          pullRequests: { nodes: f.merged && vars.head === f.branch ? [pr] : [] },
        },
      });
    }
    if (query.includes("closingIssuesReferences")) {
      const nodes = (f.closing ?? []).map((r) => {
        const [nameWithOwner, num] = r.split("#");
        return { number: Number(num), repository: { nameWithOwner } };
      });
      return ok({ node: { closingIssuesReferences: { nodes } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      if (f.failStatus && f.failStatus-- > 0) return down;
      f.status[Number(vars.i?.slice(5))] = String(vars.o).slice(4);
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.i } } });
    }
    if (query.includes('field(name:"Status")')) {
      const options = ["In Progress", "In Review", "In QA", "Done", "Blocked"].map((x) => ({
        id: `OPT_${x}`,
        name: x,
      }));
      return ok({ repositoryOwner: { projectV2: { id: "P", field: { id: "F", options } } } });
    }
    if (query.includes("closeIssue")) {
      f.open.delete(Number(vars.id?.slice(6)));
      return ok({ closeIssue: { issue: { id: vars.id } } });
    }
    if (query.includes("id state labels")) {
      const kids = f.children[n] ?? [];
      return ok({
        repository: {
          issue: {
            id: `ISSUE_${n}`,
            state: f.open.has(n) ? "OPEN" : "CLOSED",
            body: f.bodies?.[n] ?? "",
            labels: { nodes: (f.labels[n] ?? []).map((name) => ({ name })) },
            subIssuesSummary: {
              total: kids.length,
              completed: kids.filter((k) => !f.open.has(k)).length,
            },
            subIssues: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: kids.map((k) => ({
                number: k,
                state: f.open.has(k) ? "OPEN" : "CLOSED",
                stateReason: f.open.has(k) ? null : (f.reason?.[k] ?? "COMPLETED"),
                repository: { nameWithOwner: "o/repo" },
                projectItems: {
                  totalCount: f.status[k] ? 1 : 0,
                  nodes: f.status[k]
                    ? [
                        {
                          project: { number: 2, owner: { login: "o" } },
                          fieldValueByName: { name: f.status[k] },
                        },
                      ]
                    : [],
                },
              })),
            },
          },
        },
      });
    }
    if (query.includes("{state}")) {
      return ok({ repository: { issue: { state: f.open.has(n) ? "OPEN" : "CLOSED" } } });
    }
    // project item + parent of one issue
    const parent = f.parents[n];
    return ok({
      repository: {
        issue: {
          number: n,
          state: f.open.has(n) ? "OPEN" : "CLOSED",
          stateReason: f.open.has(n) ? null : (f.reason?.[n] ?? "COMPLETED"),
          parent: parent
            ? { number: parent, repository: { name: "repo", owner: { login: "o" } } }
            : null,
          projectItems: {
            nodes: [
              {
                id: `ITEM_${n}`,
                project: { number: 2, owner: { login: "o" } },
                fieldValueByName: { name: f.status[n] ?? "Backlog" },
              },
            ],
          },
        },
      },
    });
  };
}
const rest = (c: { id: number; body: string }) => ({
  id: c.id,
  html_url: `u#${c.id}`,
  body: c.body,
  author_association: "MEMBER",
});

/**
 * Task #5 (Feature #3 → Milestone #2) with a pushed commit, PR #9 squash-merged; `code: false`
 * is a closed task that never committed (Spike): no PR, no remote branch.
 */
function merged({ code = true, model = "legacy" } = {}) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-fin-")));
  git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(base, "clone", "-q", "origin.git", "repo");
  const repo = join(base, "repo");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  mkdirSync(join(repo, ".omi-plugins"));
  writeFileSync(
    join(repo, ".omi-plugins", "omi.config.yaml"),
    `github:\n  owner: o\n  repo: repo\n  projectNumber: 2\n  model: ${model}\n`,
  );
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main", "main:develop");
  const config = parseConfig({ github: { owner: "o", repo: "repo", projectNumber: 2, model } });
  const db = openState(statePath(repo));
  const runId = createRun(db, {
    id: "run5",
    issue: { repository: "o/repo", number: 5 },
    workflow: "dev-task",
  }).id;
  advanceRun(db, runId, { type: "TICKET_VALID" });
  const ws = ensureTaskWorkspace(db, {
    repoRoot: repo,
    workspace: repo, // the checkout holds .omi-plugins/: it is its own workspace here
    config,
    issue: 5,
    branch: "feature/5-x",
    runId,
  });
  advanceRun(db, runId, { type: "WORKSPACE_CREATED" });
  db.close();
  if (code) {
    writeFileSync(join(ws.path, "a.txt"), "a\n");
    git(ws.path, "add", "a.txt");
    git(ws.path, "commit", "-q", "-m", "a");
    git(ws.path, "push", "-q", "origin", "feature/5-x");
  }
  const f: Fake = {
    merged: code,
    tip: git(ws.path, "rev-parse", "HEAD"),
    branch: "feature/5-x",
    status: { 5: "In Review", 3: "In Progress", 2: "In Progress" },
    parents: { 5: 3, 3: 2 },
    labels: { 3: ["type:feature"], 2: ["type:milestone"] },
    open: new Set([3, 2, 4]),
    children: { 3: [5], 2: [3, 4] },
    comments: [],
  };
  return { repo, wt: ws.path, f, gh: fakeGh(f) };
}

const state = (repo: string) => taskStatus({ cwd: repo }, 5).run?.state;

test("finalize: cleanup, one report, Done; Feature closed + Done, Milestone with open child untouched", () => {
  const s = merged();
  const r = taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(r.run.state, "COMPLETED");
  assert.equal(r.cleanup?.state, "COMPLETED");
  assert.equal(existsSync(s.wt), false);
  assert.equal(s.f.comments.length, 1);
  assert.match(s.f.comments[0]?.body ?? "", /step=cleanup[\s\S]*\| Status \| PASSED \|/);
  assert.equal(s.f.status[5], "Done");
  assert.equal(s.f.status[3], "Done");
  assert.equal(s.f.open.has(3), false);
  assert.equal(s.f.status[2], "In Progress"); // #4 still open
  const evidence = join(dirname(statePath(s.repo)), "evidence", "run5", "merge-receipt.json");
  assert.equal(existsSync(evidence), true);
  // Replay: nothing changes, still one comment.
  assert.deepEqual(taskFinalize({ cwd: s.repo, gh: s.gh }, 5).status, []);
  assert.equal(s.f.comments.length, 1);
});

test("Milestone goes to In Review (never Done) once every child is closed", () => {
  const s = merged();
  s.f.open.delete(4);
  taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(s.f.status[2], "In Review");
  assert.equal(s.f.open.has(2), true);
});

test("Bug parent goes to In QA (verify the fix), stays open, nothing above it rolls up", () => {
  const s = merged();
  s.f.labels[3] = ["type:bug"];
  taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(s.f.status[5], "Done");
  assert.equal(s.f.status[3], "In QA");
  assert.equal(s.f.open.has(3), true);
  assert.equal(s.f.status[2], "In Progress");
});

test("closed but unaccepted sibling holds the Feature open; a cancelled one does not", () => {
  const held = merged();
  held.f.children[3] = [5, 6];
  held.f.status[6] = "In QA"; // closed by hand before QA accepted it
  const r = taskFinalize({ cwd: held.repo, gh: held.gh }, 5);
  assert.equal(r.held, "o/repo#3: closed but not accepted: o/repo#6 (In QA)");
  assert.equal(held.f.status[5], "Done");
  assert.equal(held.f.status[3], "In Progress");
  assert.equal(held.f.open.has(3), true);

  const cancelled = merged();
  cancelled.f.children[3] = [5, 6];
  cancelled.f.reason = { 6: "NOT_PLANNED" }; // not on the Project: judged by close reason
  taskFinalize({ cwd: cancelled.repo, gh: cancelled.gh }, 5);
  assert.equal(cancelled.f.status[3], "Done");
  assert.equal(cancelled.f.open.has(3), false);
});

test("Feature with unticked Scope / Acceptance stays open In Progress, held with the reason", () => {
  const s = merged();
  s.f.bodies = { 3: "## Scope / Acceptance\n- [x] prep\n- [ ] implement\n## Definition of Done\n" };
  const r = taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(r.held, "o/repo#3: scope not done: 1 unchecked box(es) under Scope / Acceptance");
  assert.equal(s.f.status[5], "Done");
  assert.equal(s.f.status[3], "In Progress");
  assert.equal(s.f.open.has(3), true);
});

test("PR not merged: refused before any change", () => {
  const s = merged();
  s.f.merged = false;
  assert.throws(() => taskFinalize({ cwd: s.repo, gh: s.gh }, 5), { code: "POLICY_VIOLATION" });
  assert.equal(state(s.repo), "WORKSPACE_READY");
  assert.equal(existsSync(s.wt), true);
});

test("no code (Spike): closed Issue, no PR, no remote branch → cleaned, report, Done", () => {
  const s = merged({ code: false });
  const dry = taskFinalize({ cwd: s.repo, gh: s.gh, dryRun: true }, 5);
  assert.equal(dry.cleanup?.steps[0]?.status, "done");
  assert.equal(existsSync(s.wt), true);
  const r = taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(r.run.state, "COMPLETED");
  assert.equal(r.receipt, null);
  assert.equal(existsSync(s.wt), false);
  assert.match(
    s.f.comments[0]?.body ?? "",
    /No PR: task without code[\s\S]*verify-merge: done — no code/,
  );
  assert.equal(s.f.status[5], "Done");
  const events = taskStatus({ cwd: s.repo }, 5).transitions.map((t) => t.event);
  assert.ok(events.includes("NO_CODE_VERIFIED"));
});

test("no code, task workspace already removed by hand: run closed", () => {
  const s = merged({ code: false });
  rmSync(dirname(s.wt), { recursive: true, force: true });
  assert.equal(taskFinalize({ cwd: s.repo, gh: s.gh }, 5).run.state, "COMPLETED");
});

test("no PR refused: Issue open, branch on origin, or a local commit", () => {
  const open = merged({ code: false });
  open.f.open.add(5);
  assert.throws(() => taskFinalize({ cwd: open.repo, gh: open.gh }, 5), /still open/);
  assert.equal(state(open.repo), "WORKSPACE_READY");

  const pushed = merged({ code: false });
  git(pushed.wt, "push", "-q", "origin", "feature/5-x");
  assert.throws(() => taskFinalize({ cwd: pushed.repo, gh: pushed.gh }, 5), /exists on origin/);

  const local = merged({ code: false });
  writeFileSync(join(local.wt, "a.txt"), "a\n");
  git(local.wt, "add", "a.txt");
  git(local.wt, "commit", "-q", "-m", "a");
  const r = taskFinalize({ cwd: local.repo, gh: local.gh }, 5);
  assert.equal(r.cleanup?.state, "CLEANUP_FAILED");
  assert.match(r.cleanup?.steps[0]?.detail ?? "", /holds 1 commit/);
  assert.equal(existsSync(local.wt), true);
});

test("legacy PR without marker: GitHub closing link to the task is accepted, any other is refused", () => {
  const s = merged();
  s.f.closing = ["o/repo#6"];
  const noSleep = { sleep: () => {} };
  assert.throws(() => taskFinalize({ cwd: s.repo, gh: s.gh, ...noSleep }, 5), {
    code: "POLICY_VIOLATION",
  });
  assert.equal(state(s.repo), "WORKSPACE_READY");
  s.f.closing = ["o/repo#5"];
  assert.equal(taskFinalize({ cwd: s.repo, gh: s.gh, ...noSleep }, 5).run.state, "COMPLETED");
});

test("report not posted: run stays CLEANUP_PENDING, no Done; rerun posts one comment and finishes", () => {
  const s = merged();
  s.f.failComments = 10;
  assert.throws(() => taskFinalize({ cwd: s.repo, gh: s.gh }, 5), { code: "GITHUB_UNAVAILABLE" });
  assert.equal(state(s.repo), "CLEANUP_PENDING");
  assert.equal(s.f.status[5], "In Review");
  s.f.failComments = 0;
  assert.equal(taskFinalize({ cwd: s.repo, gh: s.gh }, 5).run.state, "COMPLETED");
  assert.equal(s.f.comments.length, 1);
  assert.equal(s.f.status[5], "Done");
});

test("cleanup fails (dirty worktree): CLEANUP_FAILED, Blocked, FAILED report; fixed rerun updates the same comment", () => {
  const s = merged();
  writeFileSync(join(s.wt, "scratch.txt"), "x\n");
  const r = taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(r.run.state, "CLEANUP_FAILED");
  assert.equal(s.f.status[5], "Blocked");
  assert.match(s.f.comments[0]?.body ?? "", /\| Status \| FAILED \|[\s\S]*CLN-001/);
  assert.equal(existsSync(s.wt), true);
  execFileSync("git", ["clean", "-fq"], { cwd: s.wt });
  assert.equal(taskFinalize({ cwd: s.repo, gh: s.gh }, 5).run.state, "COMPLETED");
  assert.equal(s.f.comments.length, 1);
  assert.match(s.f.comments[0]?.body ?? "", /\| Status \| PASSED \|/);
  assert.equal(s.f.status[5], "Done");
});

test("TC-415-01: cleanup succeeds on an Issue closed not planned: Status stays Cancelled, no roll-up", () => {
  const s = merged();
  s.f.status[5] = "Cancelled";
  s.f.reason = { 5: "NOT_PLANNED" };
  const before = { ...s.f.status };
  const r = taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(r.run.state, "COMPLETED");
  assert.deepEqual(r.status, []);
  assert.match(r.held ?? "", /giữ Cancelled/);
  assert.deepEqual(s.f.status, before);
  assert.deepEqual(s.f.open, new Set([3, 2, 4]));
});

test("TC-415-02: cleanup fails on an Issue closed not planned: Status stays Cancelled, not Blocked", () => {
  const s = merged();
  s.f.status[5] = "Cancelled";
  s.f.reason = { 5: "NOT_PLANNED" };
  writeFileSync(join(s.wt, "scratch.txt"), "x\n");
  const r = taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(r.run.state, "CLEANUP_FAILED");
  assert.deepEqual(r.status, []);
  assert.match(r.held ?? "", /giữ Cancelled/);
  assert.equal(s.f.status[5], "Cancelled");
  assert.match(s.f.comments[0]?.body ?? "", /\| Status \| FAILED \|[\s\S]*CLN-001/);
});

// ---- DevTask-0128 #373: github.model v2 goes through the state engine, legacy never does ----

/** v2: the command's PR/REST calls hit the finalize fake, the Project hits the engine's fake. */
function v2Finalize(opts: { code?: boolean } = {}) {
  const s = merged({ ...opts, model: "v2" });
  const project = fakeGithub([{ number: 5, type: "DevTask", status: "In review" }]);
  const routed = routeGh(
    project.run,
    s.gh,
    /viewerPermission|closingIssuesReferences|id state labels|\{state\}/,
  );
  return { ...s, project, routed, state: engineDeps() };
}

test("finalize v2: CLEANUP_SUCCEEDED → omi sync; no direct Status write, no markFinished", () => {
  const s = v2Finalize();
  const r = taskFinalize({ cwd: s.repo, gh: s.routed.run, state: s.state }, 5);
  assert.equal(r.run.state, "COMPLETED");
  assert.equal(r.engine?.command, "sync");
  assert.deepEqual(r.status, []);
  assert.equal(r.held, undefined);
  assert.ok(s.routed.seen.some((q) => q.includes("items(first:"))); // the engine read the Project
  assert.deepEqual(s.f.status, { 5: "In Review", 3: "In Progress", 2: "In Progress" }); // legacy fake untouched
  assert.deepEqual(s.f.open, new Set([3, 2, 4])); // markFinished closed nothing
});

test("finalize v2: a COMPLETED run replays as sync only", () => {
  const s = v2Finalize();
  taskFinalize({ cwd: s.repo, gh: s.routed.run, state: s.state }, 5);
  const again = taskFinalize({ cwd: s.repo, gh: s.routed.run, state: s.state }, 5);
  assert.equal(again.engine?.command, "sync");
  assert.deepEqual(again.status, []);
  assert.equal(again.cleanup, null);
});

test("finalize v2: CLEANUP_FAILED writes no Status and does not call the engine", () => {
  const s = v2Finalize();
  writeFileSync(join(s.wt, "scratch.txt"), "x\n");
  const r = taskFinalize({ cwd: s.repo, gh: s.routed.run, state: s.state }, 5);
  assert.equal(r.run.state, "CLEANUP_FAILED");
  assert.deepEqual(r.status, []);
  assert.equal(r.engine, undefined);
  assert.deepEqual(s.project.mutations, []);
  assert.equal(s.f.status[5], "In Review");
});

test("finalize legacy: writes Status directly and never calls the engine", () => {
  const s = merged();
  const r = taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(r.engine, undefined);
  assert.equal(s.f.status[5], "Done");
  const failed = merged();
  writeFileSync(join(failed.wt, "scratch.txt"), "x\n");
  const f = taskFinalize({ cwd: failed.repo, gh: failed.gh }, 5);
  assert.equal(f.engine, undefined);
  assert.equal(failed.f.status[5], "Blocked");
});

test("status write fails after cleanup: COMPLETED kept, rerun only repairs the Project", () => {
  const s = merged();
  s.f.failStatus = 10;
  assert.throws(() => taskFinalize({ cwd: s.repo, gh: s.gh }, 5), { code: "GITHUB_UNAVAILABLE" });
  assert.equal(state(s.repo), "COMPLETED");
  assert.equal(s.f.status[5], "In Review");
  s.f.failStatus = 0;
  const again = taskFinalize({ cwd: s.repo, gh: s.gh }, 5);
  assert.equal(again.cleanup, null);
  assert.equal(s.f.status[5], "Done");
  assert.equal(s.f.comments.length, 1);
});

test("dry run changes nothing", () => {
  const s = merged();
  const r = taskFinalize({ cwd: s.repo, gh: s.gh, dryRun: true }, 5);
  assert.match(r.cleanup?.steps.find((x) => x.name === "remove-worktree")?.detail ?? "", /would/);
  assert.equal(state(s.repo), "WORKSPACE_READY");
  assert.equal(existsSync(s.wt), true);
  assert.equal(s.f.comments.length, 0);
});

// ---- T4.5 crash recovery: `omi cleanup scan` / `apply --safe` ----

const db5 = (repo: string) => openState(statePath(repo));

test("apply --safe: merged-but-uncleaned run is finalized once; a second apply has nothing to do", () => {
  const s = merged();
  const scan = cleanupScan({ cwd: s.repo, gh: s.gh });
  assert.equal(scan.runs[0]?.mergedPr, 9);
  const r = cleanupApply({ cwd: s.repo, gh: s.gh, safe: true });
  assert.match(r.outcomes[0]?.actions.join() ?? "", /finalized after PR #9: COMPLETED/);
  assert.equal(existsSync(s.wt), false);
  assert.equal(s.f.comments.length, 1);
  assert.deepEqual(cleanupApply({ cwd: s.repo, gh: s.gh, safe: true }).outcomes, []);
  assert.throws(() => cleanupApply({ cwd: s.repo, gh: s.gh }), { code: "USAGE_INVALID" });
});

test("crash mid-cleanup (task workspace gone, CLEANUP_PENDING): apply finishes it", () => {
  const s = merged();
  const db = db5(s.repo);
  advanceRun(db, "run5", { type: "MERGE_VERIFIED" });
  advanceRun(db, "run5", { type: "CLEANUP_STARTED" });
  db.close();
  rmSync(dirname(s.wt), { recursive: true });
  const r = cleanupApply({ cwd: s.repo, gh: s.gh, safe: true });
  assert.equal(r.outcomes[0]?.error, null);
  assert.equal(state(s.repo), "COMPLETED");
});

test("report persisted but crash before/after POST: replay leaves exactly one comment", () => {
  const s = merged();
  s.f.merged = false;
  const marker = "<!-- omi:test-report -->";
  const db = db5(s.repo);
  enqueueReport(db, { runId: "run5", marker, body: `${marker}\nhello` });
  db.close();
  s.f.comments.push({ id: 7, body: `${marker}\nhello` }); // the POST landed, the id was lost
  const r = cleanupApply({ cwd: s.repo, gh: s.gh, safe: true });
  assert.match(r.outcomes[0]?.actions.join() ?? "", /posted 1 pending report/);
  assert.equal(s.f.comments.length, 1);
  assert.equal(cleanupScan({ cwd: s.repo, gh: s.gh }).runs[0]?.pendingReports, 0);
});

test("attempt left open by a crash: closed as CRASH_RECOVERED and retryable; a live lease is never cut off", () => {
  const s = merged();
  s.f.merged = false;
  const db = db5(s.repo);
  const step = startStep(db, { runId: "run5", stepId: "dev", round: 1, role: "software-engineer" });
  beginAttempt(db, step.id);
  acquireLease(db, { key: "task:o/repo#5", holder: "live-session", ttlMs: 60_000 });
  db.close();
  const busy = cleanupApply({ cwd: s.repo, gh: s.gh, safe: true });
  assert.deepEqual(busy.outcomes, []); // leased: someone is driving it, hands off
  assert.equal(cleanupScan({ cwd: s.repo, gh: s.gh }).runs[0]?.leased, true);
  const db2 = db5(s.repo);
  releaseLease(db2, { key: "task:o/repo#5", holder: "live-session" });
  db2.close();
  const r = cleanupApply({ cwd: s.repo, gh: s.gh, safe: true });
  assert.match(r.outcomes[0]?.actions.join() ?? "", /recovered 1 open attempt/);
  const db3 = db5(s.repo);
  assert.equal(beginAttempt(db3, step.id), 2);
  db3.close();
});

/** A PID that belonged to a process which has exited. */
const deadPid = (): number => {
  const r = spawnSync(process.execPath, ["-e", ""]);
  assert.ok(r.pid);
  return r.pid;
};

const setPid = (repo: string, step: number, attempt: number, pid: number | null) => {
  const db = db5(repo);
  db.prepare("UPDATE step_attempt SET pid = ? WHERE step_run_id = ? AND attempt = ?").run(
    pid,
    step,
    attempt,
  );
  db.close();
};

test("scan: dead PID is crashed with a hint, NULL pid is unknown, a mixed run keeps its lease", () => {
  const s = merged();
  s.f.merged = false;
  const db = db5(s.repo);
  const a = startStep(db, { runId: "run5", stepId: "dev", round: 1, role: "software-engineer" });
  beginAttempt(db, a.id);
  const b = startStep(db, { runId: "run5", stepId: "old", round: 1, role: "software-engineer" });
  beginAttempt(db, b.id);
  acquireLease(db, { key: "task:o/repo#5", holder: "dead-session", ttlMs: 60_000 });
  db.close();
  setPid(s.repo, a.id, 1, deadPid());
  setPid(s.repo, b.id, 1, null);
  const run = cleanupScan({ cwd: s.repo, gh: s.gh }).runs[0];
  assert.equal(run?.crashedAttempts, 1);
  assert.equal(run?.unknownAttempts, 1);
  assert.equal(run?.hint, "omi cleanup apply --safe");
  assert.equal(run?.leased, true); // one attempt is not judged: keep the lease
  assert.deepEqual(cleanupApply({ cwd: s.repo, gh: s.gh, safe: true }).outcomes, []);
});

test("crashed-only run with an unexpired lease is not leased; apply --safe recovers it at once", () => {
  const s = merged();
  s.f.merged = false;
  const db = db5(s.repo);
  const step = startStep(db, { runId: "run5", stepId: "dev", round: 1, role: "software-engineer" });
  beginAttempt(db, step.id);
  acquireLease(db, { key: "task:o/repo#5", holder: "dead-session", ttlMs: 60_000 });
  db.close();
  setPid(s.repo, step.id, 1, deadPid());
  const run = cleanupScan({ cwd: s.repo, gh: s.gh }).runs[0];
  assert.equal(run?.crashedAttempts, 1);
  assert.equal(run?.unknownAttempts, 0);
  assert.equal(run?.leased, false);
  const r = cleanupApply({ cwd: s.repo, gh: s.gh, safe: true });
  assert.match(r.outcomes[0]?.actions.join() ?? "", /recovered 1 open attempt/);
  const db2 = db5(s.repo);
  assert.equal(beginAttempt(db2, step.id), 2);
  db2.close();
});

test("orphan task workspace next to the workspace is reported and left alone", () => {
  const s = merged();
  s.f.merged = false;
  const orphan = `${s.repo}-task-77-dead`;
  mkdirSync(orphan);
  const scan = cleanupScan({ cwd: s.repo, gh: s.gh });
  assert.equal(scan.orphans.length, 1);
  cleanupApply({ cwd: s.repo, gh: s.gh, safe: true });
  assert.equal(existsSync(orphan), true);
});

test("no runtime code passes --force (or -f) to git", () => {
  const root = new URL("../../../runtime/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith(".ts"));
  for (const f of files) {
    const src = readFileSync(new URL(String(f).replaceAll("\\", "/"), root), "utf8");
    // Every git call goes through git()/tryGit()/gitOut() or execFileSync("git", [...]).
    assert.doesNotMatch(src, /(?:[gG]it\w*\(|"git",\s*)\[[^\]]*"(?:--force|-f|-ff)"/, String(f));
  }
});
