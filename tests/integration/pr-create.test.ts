// T4.1 `omi pr create` against a fake GitHub and a real local git origin: create, existing PR
// reused, wrong base, missing issue, dual-primary, dirty worktree, async closing references,
// release develop → main.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { type PullRequest, prBody, validatePr } from "../../runtime/adapters/github/pr.ts";
import type { Ticket } from "../../runtime/adapters/github/ticket.ts";
import { prCreate, prMerge, prValidate, taskStart, taskStatus } from "../../runtime/cli/task.ts";
import type { IssueType } from "../../runtime/core/contracts.ts";
import { titleType } from "../../runtime/core/hierarchy.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-pr-")));
  git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(base, "clone", "-q", "origin.git", "repo");
  const root = join(base, "repo");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  mkdirSync(join(root, ".omi"));
  writeFileSync(
    join(root, ".omi", "config.yaml"),
    "github:\n  owner: o\n  repo: repo\n  projectNumber: 2\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  git(root, "push", "-q", "origin", "main", "main:develop");
  return root;
}

interface Fake {
  /** Issue number → OMI type label. */
  issues: Record<number, string>;
  open?: PullRequest[];
  /** Closing references returned per call; the last one repeats. */
  closing?: string[][];
  defaultBranch?: string;
  /** PR lookups that still show the previous head (GitHub lags behind a push). */
  staleLookups?: number;
  /** Merge-gate view of the task PR (T4.2); merged by `mergePullRequest`. */
  merge?: Record<string, unknown>;
  mergeSent?: { id: string; oid: string; method: string }[];
}

function fakeGh(f: Fake) {
  const created: { base: string; head: string; title: string; body: string }[] = [];
  const statuses: string[] = [];
  let closingCalls = 0;
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const item = (n: number) => ({
    id: `ITEM_${n}`,
    project: { number: 2, owner: { login: "o" } },
    fieldValueByName: { name: "In Progress" },
  });
  const run: GhRunner = (args) => {
    const query = (args[3] ?? "").slice("query=".length);
    const vars: Record<string, string> = Object.fromEntries(
      args
        .slice(4)
        .filter((_, i) => i % 2 === 1)
        .map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
    );
    if (query.includes("viewerPermission")) {
      const pr = f.merge;
      const states = /states:\[([A-Z,]+)\]/.exec(query)?.[1]?.split(",") ?? [];
      return ok({
        repository: {
          isPrivate: false,
          viewerPermission: "WRITE",
          squashMergeAllowed: true,
          mergeCommitAllowed: false,
          rebaseMergeAllowed: false,
          ref: { branchProtectionRule: { isAdminEnforced: true }, rules: { nodes: [] } },
          pullRequests: { nodes: pr && states.includes(String(pr.state)) ? [pr] : [] },
        },
      });
    }
    if (query.includes("mergePullRequest")) {
      f.mergeSent ??= [];
      f.mergeSent.push({
        id: vars.id ?? "",
        oid: vars.oid ?? "",
        method: /mergeMethod:(\w+)/.exec(query)?.[1] ?? "",
      });
      Object.assign(f.merge ?? {}, {
        state: "MERGED",
        merged: true,
        mergedAt: "2026-11-17T00:00:00Z",
        mergeCommit: { oid: "c".repeat(40) },
      });
      return ok({ mergePullRequest: { pullRequest: { merged: true } } });
    }
    if (query.includes("createPullRequest")) {
      created.push({
        base: vars.b ?? "",
        head: vars.h ?? "",
        title: vars.t ?? "",
        body: vars.body ?? "",
      });
      const pr: PullRequest = {
        id: "PR_new",
        number: 50,
        url: "https://github.com/o/repo/pull/50",
        baseRefName: vars.b ?? "",
        headRefName: vars.h ?? "",
        headRefOid: git(join(root, "..", "origin.git"), "rev-parse", `refs/heads/${vars.h}`),
        body: vars.body ?? "",
      };
      f.open = [pr];
      return ok({ createPullRequest: { pullRequest: pr } });
    }
    if (query.includes("pullRequests(headRefName")) {
      const answer = ok({
        repository: {
          id: "R",
          defaultBranchRef: { name: f.defaultBranch ?? "develop" },
          pullRequests: {
            nodes: (f.open ?? [])
              .filter((p) => p.headRefName === vars.head)
              .map((p) => ((f.staleLookups ?? 0) > 0 ? { ...p, headRefOid: "0".repeat(40) } : p)),
          },
        },
      });
      if (f.staleLookups) f.staleLookups--;
      return answer;
    }
    if (query.includes("closingIssuesReferences")) {
      const list = f.closing ?? [["o/repo#5"]];
      const refs = list[Math.min(closingCalls++, list.length - 1)] ?? [];
      const nodes = refs.map((r) => {
        const [nwo, n] = r.split("#");
        return { number: Number(n), repository: { nameWithOwner: nwo } };
      });
      return ok({ node: { closingIssuesReferences: { nodes } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      statuses.push(`${vars.i}:${vars.o}`);
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.i } } });
    }
    if (query.includes('field(name:"Status")')) {
      const options = [
        { id: "OPT_IP", name: "In Progress" },
        { id: "OPT_IR", name: "In Review" },
        { id: "OPT_WPO", name: "Waiting PO" },
      ];
      return ok({ repositoryOwner: { projectV2: { id: "P", field: { id: "F", options } } } });
    }
    const n = Number(vars.number);
    const type = f.issues[n];
    if (query.includes("blockedBy")) {
      if (!type) {
        return {
          status: 1,
          stdout: JSON.stringify({
            data: { repository: { issue: null } },
            errors: [{ type: "NOT_FOUND", message: "x" }],
          }),
          stderr: "",
        };
      }
      const ticket: Ticket = {
        number: n,
        title: `${titleType(type as IssueType)}-${String(n).padStart(4, "0")}-Task ${n}`,
        state: "OPEN",
        body: "## Objective\nx\n\n## Acceptance\n- [ ] done",
        issueType: { name: "Task" },
        labels: { totalCount: 1, nodes: [{ name: `type:${type}` }] },
        parent: null,
        subIssuesSummary: { total: 0, completed: 0 },
        blockedBy: { totalCount: 0, nodes: [] },
        projectItems: { totalCount: 1, nodes: [{ ...item(n), isArchived: false }] },
      };
      return ok({ repository: { issue: ticket } });
    }
    return ok({
      repository: {
        issue: type ? { number: n, parent: null, projectItems: { nodes: [item(n)] } } : null,
      },
    });
  };
  let root = "";
  return { run, created, statuses, setRoot: (r: string) => (root = r) };
}

/** A started task #5 with one commit in its worktree. */
function started(f: Fake) {
  const root = repo();
  const gh = fakeGh(f);
  gh.setRoot(root);
  const s = taskStart({ cwd: root, gh: gh.run }, 5);
  writeFileSync(join(s.workspace.path, "a.txt"), "a\n");
  git(s.workspace.path, "add", "a.txt");
  git(s.workspace.path, "commit", "-q", "-m", "a");
  return { root, gh, wt: s.workspace.path, branch: s.workspace.branch };
}

const noSleep = () => {};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};

test("create: pushes the owned branch, opens one PR → develop with marker + Closes, In Review", () => {
  const s = started({ issues: { 5: "dev-task" } });
  const r = prCreate({ cwd: s.root, gh: s.gh.run, sleep: noSleep }, 5);
  assert.equal(r.created, true);
  assert.deepEqual(
    r.checks.map((c) => `${c.name}:${c.status}`),
    ["pr-base:pass", "pr-head:pass", "pr-primary:pass", "pr-closes:pass", "pr-tip:pass"],
  );
  const [c] = s.gh.created;
  assert.equal(c?.base, "develop");
  assert.equal(c?.head, s.branch);
  assert.equal(c?.title, "DevTask-0005-Task 5");
  assert.match(c?.body ?? "", /<!-- omi:pr-primary=o\/repo#5 -->[\s\S]*Closes #5/);
  assert.equal(
    git(s.root, "ls-remote", "origin", s.branch).split("\t")[0],
    git(s.wt, "rev-parse", "HEAD"),
  );
  assert.deepEqual(s.gh.statuses, ["ITEM_5:OPT_IR"]);
});

test("existing PR from the branch is reused, never duplicated", () => {
  const s = started({ issues: { 5: "dev-task" } });
  prCreate({ cwd: s.root, gh: s.gh.run, sleep: noSleep }, 5);
  const again = prCreate({ cwd: s.root, gh: s.gh.run, sleep: noSleep }, 5);
  assert.equal(again.created, false);
  assert.equal(s.gh.created.length, 1);
});

test("an existing PR with the wrong base is refused", () => {
  const s = started({ issues: { 5: "dev-task" } });
  // Someone opened (or retargeted) the branch's PR against main.
  const f2: Fake = { issues: { 5: "dev-task" } };
  const gh2 = fakeGh(f2);
  gh2.setRoot(s.root);
  f2.open = [
    {
      id: "PR_x",
      number: 51,
      url: "u",
      baseRefName: "main",
      headRefName: s.branch,
      headRefOid: git(s.wt, "rev-parse", "HEAD"),
      body: prBody("o/repo", 5),
    },
  ];
  assert.equal(
    code(() => prCreate({ cwd: s.root, gh: gh2.run, sleep: noSleep }, 5)),
    "POLICY_VIOLATION",
  );
  assert.equal(gh2.created.length, 0);
});

test("missing issue: TICKET_INVALID before any push", () => {
  const root = repo();
  const gh = fakeGh({ issues: {} });
  assert.equal(
    code(() => prCreate({ cwd: root, gh: gh.run }, 404)),
    "TICKET_INVALID",
  );
});

test("dual primary: GitHub closing two Issues fails the gate", () => {
  const s = started({ issues: { 5: "dev-task" }, closing: [["o/repo#5", "o/repo#6"]] });
  assert.equal(
    code(() => prCreate({ cwd: s.root, gh: s.gh.run, sleep: noSleep }, 5)),
    "POLICY_VIOLATION",
  );
  assert.deepEqual(s.gh.statuses, []);
});

test("closing references filled asynchronously are polled with backoff", () => {
  const waits: number[] = [];
  const s = started({ issues: { 5: "dev-task" }, closing: [[], [], ["o/repo#5"]] });
  const r = prCreate({ cwd: s.root, gh: s.gh.run, sleep: (ms) => waits.push(ms) }, 5);
  assert.equal(r.checks.find((c) => c.name === "pr-closes")?.status, "pass");
  assert.deepEqual(waits, [1000, 2000]);
});

test("dirty worktree or no commits: refused before push", () => {
  const s = started({ issues: { 5: "dev-task" } });
  writeFileSync(join(s.wt, "b.txt"), "b\n");
  assert.equal(
    code(() => prCreate({ cwd: s.root, gh: s.gh.run }, 5)),
    "WORKTREE_DIRTY",
  );
  git(s.wt, "add", "b.txt");
  git(s.wt, "commit", "-q", "-m", "b");
  git(s.wt, "reset", "-q", "--hard", "origin/develop");
  assert.equal(
    code(() => prCreate({ cwd: s.root, gh: s.gh.run }, 5)),
    "POLICY_VIOLATION",
  );
  assert.equal(s.gh.created.length, 0);
});

test("release: develop → main, primary proven by the body marker (no closing link off-default)", () => {
  const root = repo();
  const gh = fakeGh({ issues: { 7: "release" } });
  gh.setRoot(root);
  const r = prCreate({ cwd: root, gh: gh.run }, 7);
  assert.deepEqual([gh.created[0]?.base, gh.created[0]?.head], ["main", "develop"]);
  assert.deepEqual(
    r.checks.map((c) => c.name),
    ["pr-base", "pr-head", "pr-primary"],
  );
  assert.equal(r.status, null);
});

test("validatePr: body naming two primaries is dual-primary", () => {
  const body = `${prBody("o/repo", 5)}\n<!-- omi:pr-primary=o/repo#6 -->`;
  const checks = validatePr(
    { baseRefName: "develop", headRefName: "h", body },
    { primary: "o/repo#5", base: "develop", head: "h", closing: null },
  );
  assert.equal(checks.find((c) => c.name === "pr-primary")?.status, "fail");
});

test("a new push to an existing PR: head re-read with backoff until GitHub catches up", () => {
  const f: Fake = { issues: { 5: "dev-task" } };
  const s = started(f);
  prCreate({ cwd: s.root, gh: s.gh.run, sleep: noSleep }, 5);
  writeFileSync(join(s.wt, "c.txt"), "c\n");
  git(s.wt, "add", "c.txt");
  git(s.wt, "commit", "-q", "-m", "c");
  const pr = f.open?.[0] as PullRequest;
  pr.headRefOid = git(s.wt, "rev-parse", "HEAD"); // what GitHub shows once it caught up
  f.staleLookups = 2;
  const waits: number[] = [];
  const r = prCreate({ cwd: s.root, gh: s.gh.run, sleep: (ms) => waits.push(ms) }, 5);
  assert.equal(r.checks.find((c) => c.name === "pr-tip")?.status, "pass");
  assert.deepEqual(waits, [1000, 2000]);
});

// ---- T4.2 merge eligibility + authorized merge ----

function mergeable(s: ReturnType<typeof started>, f: Fake, patch: Record<string, unknown> = {}) {
  f.merge = {
    id: "PR_m",
    number: 60,
    url: "https://github.com/o/repo/pull/60",
    state: "OPEN",
    isDraft: false,
    merged: false,
    mergedAt: null,
    mergeable: "MERGEABLE",
    reviewDecision: null,
    baseRefName: "develop",
    headRefName: s.branch,
    headRefOid: git(s.wt, "rev-parse", "HEAD"),
    body: prBody("o/repo", 5),
    mergeCommit: null,
    labels: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
    ...patch,
  };
}

test("pr merge: squash pinned to the validated head, receipt returned", () => {
  const f: Fake = { issues: { 5: "dev-task" } };
  const s = started(f);
  mergeable(s, f);
  const v = prValidate({ cwd: s.root, gh: s.gh.run }, 5);
  assert.ok(
    v.checks.every((c) => c.status !== "fail"),
    JSON.stringify(v.checks),
  );
  const r = prMerge({ cwd: s.root, gh: s.gh.run }, 5);
  const tip = git(s.wt, "rev-parse", "HEAD");
  assert.deepEqual(f.mergeSent, [{ id: "PR_m", oid: tip, method: "SQUASH" }]);
  assert.equal(r.receipt.headSha, tip);
  assert.equal(r.receipt.mergeCommit, "c".repeat(40));
});

test("pr merge: unresolved check or local tip ahead of the PR refuses without merging", () => {
  const f: Fake = { issues: { 5: "dev-task" } };
  const s = started(f);
  mergeable(s, f, {
    commits: { nodes: [{ commit: { statusCheckRollup: { state: "PENDING" } } }] },
  });
  assert.equal(
    code(() => prMerge({ cwd: s.root, gh: s.gh.run }, 5)),
    "POLICY_VIOLATION",
  );
  mergeable(s, f, { headRefOid: "1".repeat(40) });
  assert.equal(
    code(() => prMerge({ cwd: s.root, gh: s.gh.run }, 5)),
    "POLICY_VIOLATION",
  );
  assert.equal(f.mergeSent, undefined);
});

test("pr merge: risk:high is never merged; run → WAITING_PO, Status Waiting PO", () => {
  const f: Fake = { issues: { 5: "dev-task" } };
  const s = started(f);
  mergeable(s, f, { labels: { nodes: [{ name: "risk:high" }] } });
  assert.equal(
    code(() => prMerge({ cwd: s.root, gh: s.gh.run }, 5)),
    "POLICY_VIOLATION",
  );
  assert.equal(f.mergeSent, undefined);
  assert.equal(taskStatus({ cwd: s.root }, 5).run?.state, "WAITING_PO");
  assert.deepEqual(s.gh.statuses.slice(-1), ["ITEM_5:OPT_WPO"]);
});

test("pr merge: release PRs are left to the PO", () => {
  const root = repo();
  const gh = fakeGh({ issues: { 7: "release" } });
  assert.equal(
    code(() => prMerge({ cwd: root, gh: gh.run }, 7)),
    "POLICY_VIOLATION",
  );
});

test("push rejected by the remote: POLICY_VIOLATION with git's reason, redacted; no PR (#119)", () => {
  const s = started({ issues: { 5: "dev-task" } });
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const hook = join(s.root, "..", "origin.git", "hooks", "pre-receive");
  writeFileSync(
    hook,
    `#!/bin/sh\necho "error: GH013: Repository rule violations found. Push cannot contain secrets: ${token}" >&2\nexit 1\n`,
    { mode: 0o755 },
  );
  let err: { code?: string; message?: string } = {};
  try {
    prCreate({ cwd: s.root, gh: s.gh.run, sleep: noSleep }, 5);
  } catch (e) {
    err = e as typeof err;
  }
  assert.equal(err.code, "POLICY_VIOLATION");
  assert.match(err.message ?? "", /GH013[\s\S]*Push cannot contain secrets/);
  assert.ok(!(err.message ?? "").includes(token));
  assert.equal(s.gh.created.length, 0);
  assert.deepEqual(s.gh.statuses, []);
});
