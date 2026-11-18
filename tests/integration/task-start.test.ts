// T2.6 `task start` / `task status` / `ticket validate` against a fake GitHub (mocked gh runner)
// and a real local git origin: blocked dependency, API failure mid-setup, missing develop,
// two sessions, resume after a finished run, parent status roll-up.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import type { Ticket } from "../../runtime/adapters/github/ticket.ts";
import { taskStart, taskStatus, taskUnblock, ticketValidate } from "../../runtime/cli/task.ts";
import { openState, statePath } from "../../runtime/persistence/db.ts";
import {
  acquireLease,
  advanceRun,
  getRun,
  transitionRun,
} from "../../runtime/persistence/repository.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(withDevelop = true) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-task-")));
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
  git(root, "push", "-q", "origin", "main");
  if (withDevelop) git(root, "push", "-q", "origin", "main:develop");
  return { base, root };
}

interface FakeIssue {
  status: string | null;
  parent?: number;
  ticket?: Partial<Ticket>;
}

/** In-memory GitHub: issues of o/repo in o Project #2. */
function fakeGh(issues: Record<number, FakeIssue>, opts: { failMutations?: number } = {}) {
  let failures = opts.failMutations ?? 0;
  const mutations: number[] = [];
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const item = (n: number) => ({
    id: `ITEM_${n}`,
    project: { number: 2, owner: { login: "o" } },
    fieldValueByName: issues[n]?.status === null ? null : { name: issues[n]?.status },
  });
  const run: GhRunner = (args) => {
    const query = (args[3] ?? "").slice("query=".length);
    const vars = Object.fromEntries(
      args
        .slice(4)
        .filter((_, i) => i % 2 === 1)
        .map((kv) => kv.split(/=(.*)/s).slice(0, 2)),
    );
    if (query.includes("updateProjectV2ItemFieldValue")) {
      if (failures-- > 0) return { status: 1, stdout: "", stderr: "dial tcp: i/o timeout" };
      const n = Number(String(vars.i).replace("ITEM_", ""));
      (issues[n] as FakeIssue).status = "In Progress";
      mutations.push(n);
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: vars.i } } });
    }
    if (query.includes('field(name:"Status")')) {
      const field = { id: "F", options: [{ id: "OPT_IP", name: "In Progress" }] };
      return ok({ repositoryOwner: { projectV2: { id: "P", field } } });
    }
    const n = Number(vars.number);
    const i = issues[n];
    const parent = i?.parent
      ? { number: i.parent, repository: { name: "repo", owner: { login: "o" } } }
      : null;
    if (query.includes("blockedBy")) {
      if (!i)
        return {
          status: 1,
          stdout: JSON.stringify({
            data: { repository: { issue: null } },
            errors: [{ type: "NOT_FOUND", message: "x" }],
          }),
          stderr: "",
        };
      const ticket: Ticket = {
        number: n,
        title: `DevTask-${String(n).padStart(4, "0")}-Task ${n}`,
        state: "OPEN",
        body: "## Objective\nx\n\n## Scope / Acceptance\n- [ ] done",
        issueType: { name: "Task" },
        labels: { totalCount: 1, nodes: [{ name: "type:dev-task" }] },
        parent: parent && {
          number: parent.number,
          state: "OPEN",
          repository: { nameWithOwner: "o/repo" },
        },
        subIssuesSummary: { total: 0, completed: 0 },
        blockedBy: { totalCount: 0, nodes: [] },
        projectItems: { totalCount: 1, nodes: [{ ...item(n), isArchived: false }] },
        ...i.ticket,
      };
      return ok({ repository: { issue: ticket } });
    }
    return ok({
      repository: { issue: i ? { number: n, parent, projectItems: { nodes: [item(n)] } } : null },
    });
  };
  return { run, mutations };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code: string }).code;
  }
  return "no-throw";
};

const tree = (): Record<number, FakeIssue> => ({
  1: { status: "Ready" }, // Milestone
  3: { status: "Backlog", parent: 1 }, // Feature
  5: { status: "Ready", parent: 3 }, // Dev Task
});

test("start: run + worktree + In Progress rolled up the parent chain; repeat is a no-op", () => {
  const { base, root } = repo();
  const gh = fakeGh(tree());
  const first = taskStart({ cwd: root, gh: gh.run }, 5);
  assert.equal(first.run.state, "WORKSPACE_READY");
  assert.equal(first.workspace.path, join(base, ".omi-worktrees", "repo", "5"));
  assert.equal(first.workspace.branch, "feature/5-task-5");
  assert.equal(git(first.workspace.path, "branch", "--show-current"), "feature/5-task-5");
  assert.deepEqual(
    first.status.map((c) => `${c.issue}:${c.from}`),
    ["o/repo#5:Ready", "o/repo#3:Backlog", "o/repo#1:Ready"],
  );

  const again = taskStart({ cwd: root, gh: gh.run }, 5);
  assert.equal(again.run.id, first.run.id);
  assert.equal(again.workspace.reused, true);
  assert.deepEqual(again.status, []);
  assert.deepEqual(gh.mutations, [5, 3, 1]);

  // Status works from inside the task worktree too (state DB is shared via the common dir).
  const st = taskStatus({ cwd: first.workspace.path }, 5);
  assert.equal(st.run?.id, first.run.id);
  assert.equal(st.branch, "feature/5-task-5");
  assert.deepEqual(st.worktree, { path: first.workspace.path, exists: true });
  assert.deepEqual(
    st.transitions.map((t) => t.to),
    ["CREATED", "TICKET_VALIDATED", "WORKSPACE_READY"],
  );
  assert.equal(taskStatus({ cwd: root }, 99).run, null);
});

test("parents already past Backlog/Ready are never regressed", () => {
  const { root } = repo();
  const issues = tree();
  (issues[3] as FakeIssue).status = "In Review";
  const gh = fakeGh(issues);
  const r = taskStart({ cwd: root, gh: gh.run }, 5);
  assert.deepEqual(gh.mutations, [5, 1]);
  assert.equal(issues[3]?.status, "In Review");
  assert.equal(r.status.length, 2);
});

test("blocked dependency or non-executable type: nothing is created", () => {
  const { base, root } = repo();
  const open = { number: 9, state: "OPEN" as const, repository: { nameWithOwner: "o/repo" } };
  const gh = fakeGh({
    5: { status: "Ready", ticket: { blockedBy: { totalCount: 1, nodes: [open] } } },
    6: {
      status: "Ready",
      ticket: {
        title: "Feature-0006-Task 6",
        labels: { totalCount: 1, nodes: [{ name: "type:feature" }] },
        issueType: { name: "Feature" },
      },
    },
  });
  assert.equal(
    code(() => taskStart({ cwd: root, gh: gh.run }, 5)),
    "DEPENDENCY_BLOCKED",
  );
  assert.equal(
    code(() => taskStart({ cwd: root, gh: gh.run }, 6)),
    "POLICY_VIOLATION",
  );
  assert.equal(
    code(() => taskStart({ cwd: root, gh: gh.run }, 7)),
    "TICKET_INVALID",
  );
  assert.equal(taskStatus({ cwd: root }, 5).run, null);
  assert.equal(existsSync(join(base, ".omi-worktrees")), false);
  assert.deepEqual(gh.mutations, []);

  const fresh = repo();
  const checks = ticketValidate({ cwd: fresh.root, gh: gh.run }, 6);
  // Read-only command: no state database appears.
  assert.equal(existsSync(statePath(fresh.root)), false);
  assert.equal(checks.find((c) => c.name === "executable")?.code, "POLICY_VIOLATION");
});

test("API failure mid-setup: transient error, workspace kept, retry finishes on the same run", () => {
  const { root } = repo();
  const gh = fakeGh(tree(), { failMutations: 1 });
  assert.equal(
    code(() => taskStart({ cwd: root, gh: gh.run }, 5)),
    "NETWORK",
  );
  const mid = taskStatus({ cwd: root }, 5);
  assert.equal(mid.run?.state, "WORKSPACE_READY");
  const done = taskStart({ cwd: root, gh: gh.run }, 5);
  assert.equal(done.run.id, mid.run?.id);
  assert.equal(done.workspace.reused, true);
  assert.deepEqual(gh.mutations, [5, 3, 1]);
});

test("missing origin/develop: CONFIG_INVALID; once it exists the same run completes", () => {
  const { root } = repo(false);
  const gh = fakeGh(tree());
  assert.equal(
    code(() => taskStart({ cwd: root, gh: gh.run }, 5)),
    "CONFIG_INVALID",
  );
  const mid = taskStatus({ cwd: root }, 5);
  assert.equal(mid.run?.state, "TICKET_VALIDATED");
  git(root, "push", "-q", "origin", "main:develop");
  const done = taskStart({ cwd: root, gh: gh.run }, 5);
  assert.equal(done.run.id, mid.run?.id);
  assert.equal(done.run.state, "WORKSPACE_READY");
});

test("two sessions: the second start is refused while the first holds the lease", () => {
  const { root } = repo();
  const db = openState(statePath(root));
  acquireLease(db, { key: "task:o/repo#5", holder: "session-a", ttlMs: 60_000 });
  db.close();
  const gh = fakeGh(tree());
  assert.equal(
    code(() => taskStart({ cwd: root, gh: gh.run, session: "session-b" }, 5)),
    "LOCK_HELD",
  );
  assert.equal(taskStatus({ cwd: root }, 5).run, null);
});

test("new run after a finished one adopts the preserved branch and worktree (#28 CR-001)", () => {
  const { root } = repo();
  const gh = fakeGh(tree());
  const first = taskStart({ cwd: root, gh: gh.run }, 5);
  const db = openState(statePath(root));
  transitionRun(db, { runId: first.run.id, from: "WORKSPACE_READY", to: "FAILED", event: "FAIL" });
  db.close();

  const second = taskStart({ cwd: root, gh: gh.run }, 5);
  assert.notEqual(second.run.id, first.run.id);
  assert.equal(second.workspace.path, first.workspace.path);
  assert.equal(second.workspace.reused, true);
  const marker = JSON.parse(
    readFileSync(
      join(git(second.workspace.path, "rev-parse", "--absolute-git-dir"), "omi-owner.json"),
      "utf8",
    ),
  );
  assert.equal(marker.runId, second.run.id);
  const check = openState(statePath(root));
  assert.equal(getRun(check, first.run.id)?.state, "FAILED");
  check.close();
});

test("unblock: only a BLOCKED run; FSM resumes it, one report names who and why (#123)", () => {
  const { root } = repo();
  const issues = tree();
  const gh = fakeGh(issues);
  const posted: string[] = [];
  const run: GhRunner = (args, input) => {
    if ((args[3] ?? "").includes("viewer{login}")) {
      return {
        status: 0,
        stdout: JSON.stringify({ data: { viewer: { login: "po" } } }),
        stderr: "",
      };
    }
    if (args.includes("--paginate")) return { status: 0, stdout: "[[]]", stderr: "" };
    if (args.includes("POST")) {
      posted.push(JSON.parse(input ?? "{}").body);
      return {
        status: 0,
        stdout: JSON.stringify({ id: posted.length, html_url: "u", body: posted.at(-1) }),
        stderr: "",
      };
    }
    return gh.run(args, input);
  };
  const started = taskStart({ cwd: root, gh: run }, 5);
  assert.equal(
    code(() => taskUnblock({ cwd: root, gh: run }, 5)),
    "INVALID_TRANSITION",
  );
  assert.equal(taskStatus({ cwd: root }, 5).run?.state, "WORKSPACE_READY");
  assert.equal(posted.length, 0);

  const db = openState(statePath(root));
  advanceRun(db, started.run.id, { type: "BLOCK" });
  db.close();
  (issues[5] as FakeIssue).status = "Blocked";
  const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
  const r = taskUnblock({ cwd: root, gh: run, reason: `PO decided; ${token}` }, 5);
  assert.equal(r.state, "WORKSPACE_READY");
  assert.equal(r.by, "po");
  assert.deepEqual(r.status, { issue: "o/repo#5", from: "Blocked", to: "In Progress" });
  assert.equal(posted.length, 1);
  assert.match(posted[0] as string, /step=unblock;round=1;attempt=1/);
  assert.match(posted[0] as string, /Unblocked by GitHub user po; resumes in WORKSPACE_READY/);
  assert.match(posted[0] as string, /PO decided/);
  assert.ok(!(posted[0] as string).includes(token));
  assert.equal(
    code(() => taskUnblock({ cwd: root, gh: run }, 5)),
    "INVALID_TRANSITION",
  );
});

test("Definition of Ready: real parent chain checked, wrong pair / title / Objective refused (#128)", () => {
  const { root } = repo();
  const typed = (type: string, title: string, parent?: number): FakeIssue => ({
    status: "Ready",
    parent,
    ticket: {
      title,
      labels: { totalCount: 1, nodes: [{ name: `type:${type}` }] },
      ...(title.includes("No objective") ? { body: "## Scope / Acceptance\n- [ ] done" } : {}),
    },
  });
  const gh = fakeGh({
    1: typed("milestone", "Milestone-0001-M"),
    3: typed("feature", "Feature-0003-F", 1),
    5: typed("dev-task", "DevTask-0005-T", 3),
    6: typed("feature", "Feature-0006-Wrong", 5), // a Feature under a DevTask
    7: typed("dev-task", "Feature-0007-Mislabelled", 3),
    8: typed("dev-task", "DevTask-0008-No objective", 3),
    9: typed("bug", "Bug-0009-B", 3),
  });
  const status = (n: number, name: string) =>
    ticketValidate({ cwd: root, gh: gh.run }, n).find((c) => c.name === name)?.status;
  assert.equal(status(5, "hierarchy"), "pass");
  assert.equal(status(6, "hierarchy"), "fail");
  assert.equal(status(7, "title"), "fail");
  assert.equal(status(9, "executable"), "fail");
  assert.equal(status(5, "objective"), "pass");
  assert.equal(status(8, "objective"), "fail");
  assert.equal(
    code(() => taskStart({ cwd: root, gh: gh.run }, 7)),
    "TICKET_INVALID",
  );
});
