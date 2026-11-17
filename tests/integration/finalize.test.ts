// T4.4 `omi task finalize` against a fake GitHub and a real local origin: happy path with
// Feature/Milestone roll-up, failure at each step (no merge, report not posted, cleanup failed,
// status write failed) never shows Done, and a rerun resumes to exactly one cleanup comment.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { prBody } from "../../runtime/adapters/github/pr.ts";
import { cleanupApply, cleanupScan } from "../../runtime/cli/cleanup.ts";
import { taskFinalize, taskStatus } from "../../runtime/cli/task.ts";
import { parseConfig } from "../../runtime/core/config.ts";
import { openState, statePath } from "../../runtime/persistence/db.ts";
import {
  acquireLease,
  advanceRun,
  beginAttempt,
  createRun,
  enqueueReport,
  releaseLease,
  startStep,
} from "../../runtime/persistence/repository.ts";
import { ensureWorktree } from "../../runtime/resources/worktree.ts";

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
        body: prBody("o/repo", 5),
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
    if (query.includes("updateProjectV2ItemFieldValue")) {
      if (f.failStatus && f.failStatus-- > 0) return down;
      f.status[Number(vars.i?.slice(5))] = String(vars.o).slice(4);
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.i } } });
    }
    if (query.includes('field(name:"Status")')) {
      const options = ["In Progress", "In Review", "Done", "Blocked"].map((x) => ({
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
            labels: { nodes: (f.labels[n] ?? []).map((name) => ({ name })) },
            subIssuesSummary: {
              total: kids.length,
              completed: kids.filter((k) => !f.open.has(k)).length,
            },
          },
        },
      });
    }
    // project item + parent of one issue
    const parent = f.parents[n];
    return ok({
      repository: {
        issue: {
          number: n,
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
});

/** Task #5 (Feature #3 → Milestone #2) with a pushed commit, PR #9 squash-merged. */
function merged() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-fin-")));
  git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(base, "clone", "-q", "origin.git", "repo");
  const repo = join(base, "repo");
  git(repo, "config", "user.email", "t@example.invalid");
  git(repo, "config", "user.name", "t");
  mkdirSync(join(repo, ".omi"));
  writeFileSync(
    join(repo, ".omi", "config.yaml"),
    "github:\n  owner: o\n  repo: repo\n  projectNumber: 2\n",
  );
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "init");
  git(repo, "push", "-q", "origin", "main", "main:develop");
  const config = parseConfig({ github: { owner: "o", repo: "repo", projectNumber: 2 } });
  const db = openState(statePath(repo));
  const runId = createRun(db, {
    id: "run5",
    issue: { repository: "o/repo", number: 5 },
    workflow: "dev-task",
  }).id;
  advanceRun(db, runId, { type: "TICKET_VALID" });
  const ws = ensureWorktree(db, { repoRoot: repo, config, issue: 5, branch: "feature/5-x", runId });
  advanceRun(db, runId, { type: "WORKSPACE_CREATED" });
  db.close();
  writeFileSync(join(ws.path, "a.txt"), "a\n");
  git(ws.path, "add", "a.txt");
  git(ws.path, "commit", "-q", "-m", "a");
  git(ws.path, "push", "-q", "origin", "feature/5-x");
  const f: Fake = {
    merged: true,
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

test("PR not merged: refused before any change", () => {
  const s = merged();
  s.f.merged = false;
  assert.throws(() => taskFinalize({ cwd: s.repo, gh: s.gh }, 5), { code: "POLICY_VIOLATION" });
  assert.equal(state(s.repo), "WORKSPACE_READY");
  assert.equal(existsSync(s.wt), true);
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

test("crash mid-cleanup (worktree gone, branch left, CLEANUP_PENDING): apply finishes it", () => {
  const s = merged();
  const db = db5(s.repo);
  advanceRun(db, "run5", { type: "MERGE_VERIFIED" });
  advanceRun(db, "run5", { type: "CLEANUP_STARTED" });
  db.close();
  git(s.repo, "worktree", "remove", s.wt);
  const r = cleanupApply({ cwd: s.repo, gh: s.gh, safe: true });
  assert.equal(r.outcomes[0]?.error, null);
  assert.equal(state(s.repo), "COMPLETED");
  assert.equal(git(s.repo, "branch", "--list", "feature/5-x"), "");
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
  const step = startStep(db, { runId: "run5", stepId: "dev", round: 1, role: "backend-engineer" });
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

test("orphan worktree under the OMI root is reported and left alone", () => {
  const s = merged();
  s.f.merged = false;
  const orphan = join(dirname(s.wt), "77");
  git(s.repo, "worktree", "add", "-q", "-b", "feature/77-foreign", orphan, "origin/develop");
  const scan = cleanupScan({ cwd: s.repo, gh: s.gh });
  assert.equal(scan.orphans.length, 1);
  cleanupApply({ cwd: s.repo, gh: s.gh, safe: true });
  assert.equal(existsSync(orphan), true);
});

test("no runtime code passes --force (or -f) to git", () => {
  const root = new URL("../../runtime/", import.meta.url);
  const files = readdirSync(root, { recursive: true }).filter((f) => String(f).endsWith(".ts"));
  for (const f of files) {
    const src = readFileSync(new URL(String(f).replaceAll("\\", "/"), root), "utf8");
    // Every git call goes through git()/tryGit()/gitOut() or execFileSync("git", [...]).
    assert.doesNotMatch(src, /(?:[gG]it\w*\(|"git",\s*)\[[^\]]*"(?:--force|-f|-ff)"/, String(f));
  }
});
