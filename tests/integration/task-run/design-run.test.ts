// DevTask-0132 #383 (CR-001..003): the v2 `omi task run` entry by native type. A DesignTask runs
// the read-only designer (section `design` written, then a single `move "In review"`, never Done,
// no worktree, no commit); `task start` refuses it; DevTask/QATask reach taskRun.
import "../../support/isolate-profile-db.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { stepReports } from "../../../runtime/reporting/adapters/step-reports.ts";
import { parseConfig } from "../../../runtime/shared/config.ts";
import type { TaskPacket } from "../../../runtime/shared/contracts.ts";
import type { GhRunner } from "../../../runtime/shared/github/client.ts";
import { taskRunByType } from "../../../runtime/task-run/cli/analyze.ts";
import { runTypeOf, typeOfV2 } from "../../../runtime/task-run/cli/gates.ts";
import { planFor } from "../../../runtime/task-run/cli/run.ts";
import { taskStart } from "../../../runtime/task-run/cli/start.ts";
import { fetchTicket } from "../../../runtime/ticket/adapters/ticket.ts";
import { engineDeps, fakeGithub, queryOf, routeGh } from "../../unit/github/lifecycle-fake.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo() {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-des-")));
  git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(base, "clone", "-q", "origin.git", "repo");
  const root = join(base, "repo");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  mkdirSync(join(root, ".omi-plugins"));
  writeFileSync(
    join(root, ".omi-plugins", "omi.config.yaml"),
    "github:\n  owner: o\n  repo: r\n  projectNumber: 2\n  model: v2\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  git(root, "push", "-q", "origin", "main");
  return { base, root };
}

const DESIGN_BODY =
  "## Objective\nx\n\n## Screens & flow\nflow\n\n## States\nall\n\n## Responsive & a11y\nok\n";

interface Issue {
  number: number;
  title: string;
  type: string | null;
  body: string;
  labels?: string[];
  parent?: number;
}

const varsOf = (args: string[], input?: string): Record<string, unknown> => {
  if (args.includes("--input")) {
    return (JSON.parse(input ?? "{}") as { variables: Record<string, unknown> }).variables ?? {};
  }
  const out: Record<string, unknown> = {};
  args.forEach((a, k) => {
    if (/^-[fF]$/.test(args[k - 1] ?? "")) {
      const [key, ...v] = a.split("=");
      out[key as string] = v.join("=");
    }
  });
  return out;
};

/** In-memory Issues behind the ticket/body queries; the Project side is `fakeGithub`. */
function world(issues: Issue[]) {
  const comments: { id: number; body: string; html_url: string; author_association: string }[] = [];
  const bodies = new Map(issues.map((i) => [i.number, i.body]));
  const find = (n: number) => issues.find((i) => i.number === n) as Issue;
  const ref = { nameWithOwner: "o/r" };
  const node = (i: Issue) => ({
    number: i.number,
    title: i.title,
    state: "OPEN",
    body: bodies.get(i.number),
    issueType: i.type ? { name: i.type } : null,
    labels: { totalCount: 0, nodes: (i.labels ?? []).map((name) => ({ name })) },
    parent: i.parent ? { number: i.parent, state: "OPEN", repository: ref } : null,
    subIssuesSummary: { total: 0, completed: 0 },
    blockedBy: { totalCount: 0, nodes: [] },
    projectItems: {
      totalCount: 1,
      nodes: [
        {
          id: `item${i.number}`,
          isArchived: false,
          project: { number: 2, owner: { login: "o" } },
          fieldValueByName: { name: "Ready" },
        },
      ],
    },
  });
  const ok = (v: unknown) => ({ status: 0, stdout: JSON.stringify(v), stderr: "" });
  const run: GhRunner = (args, input) => {
    if (args[1] !== "graphql") {
      const method = args.includes("-X") ? args[args.indexOf("-X") + 1] : "GET";
      if (method === "GET") return ok([comments]);
      const c = {
        id: comments.length + 1,
        body: JSON.parse(input as string).body,
        html_url: `https://x/${comments.length + 1}`,
        author_association: "MEMBER",
      };
      comments.push(c);
      return ok(c);
    }
    const q = queryOf(args, input);
    const v = varsOf(args, input);
    const data = (d: unknown) => ok({ data: d });
    if (q.includes("updateIssue")) {
      bodies.set(Number(String(v.id).replace(/^\D+/, "")), v.body as string);
      return data({ updateIssue: { issue: { id: v.id } } });
    }
    const n = Number(v.number);
    if (q.includes("id body")) {
      return data({ repository: { issue: { id: `I${n}`, body: bodies.get(n) } } });
    }
    if (q.includes("blockedBy")) return data({ repository: { issue: node(find(n)) } });
    // The agent's context query: the Issue and its parent chain with labels, plus comments.
    const ctx = (i: Issue): Record<string, unknown> => ({
      number: i.number,
      title: i.title,
      body: bodies.get(i.number),
      repository: ref,
      labels: { nodes: (i.labels ?? []).map((name) => ({ name })) },
      parent: i.parent ? ctx(find(i.parent)) : null,
    });
    return data({ repository: { issue: { ...ctx(find(n)), comments: { nodes: [] } } } });
  };
  return { run, bodies, comments };
}

// The ticket lookup, the body read/write and the agent's context query are ours; the Project is the engine's.
const ENGINE_MARKERS = /blockedBy|id body|updateIssue|comments/;

const PARENT: Issue = {
  number: 2,
  title: "UserStory-0002-s",
  type: "UserStory",
  body: "## Objective\nx",
};

function designSetup(issue: Issue = ticketOf("DesignTask", DESIGN_BODY)) {
  const r = repo();
  const w = world([PARENT, issue]);
  const project = fakeGithub([
    { number: 2, type: "UserStory", status: "In progress" },
    { number: issue.number, type: issue.type ?? "DesignTask", status: "Ready", parent: 2 },
  ]);
  const routed = routeGh(project.run, w.run, ENGINE_MARKERS);
  return { ...r, w, project, gh: routed.run };
}

function ticketOf(type: string, body: string, extra: Partial<Issue> = {}): Issue {
  return { number: 3, title: `${type}-0003-t`, type, body, parent: 2, ...extra };
}

const designer =
  (replies: { design?: string; other?: string }[], packets: TaskPacket[] = []) =>
  (l: { stdin: string }): string => {
    const packet: TaskPacket = JSON.parse(l.stdin.split("\n\n")[1] as string);
    packets.push(packet);
    const reply = replies.shift() ?? {};
    const sectionUpdates = [
      ...(reply.design ? [{ section: "design", markdown: reply.design }] : []),
      ...(reply.other ? [{ section: "notes", markdown: reply.other }] : []),
    ];
    return JSON.stringify({
      type: "result",
      is_error: false,
      result: JSON.stringify({
        schemaVersion: 1,
        workflowRunId: packet.workflowRunId,
        issue: packet.issue,
        stepId: packet.stepId,
        round: packet.round,
        attempt: packet.attempt,
        role: packet.role,
        status: "PASSED",
        summary: "design",
        sectionUpdates,
      }),
      usage: { input_tokens: 10, output_tokens: 2 },
    });
  };

test("TC-383-20: a v2 DesignTask writes the design section, moves In review once, never Done, no worktree", () => {
  const s = designSetup();
  const packets: TaskPacket[] = [];
  const r = taskRunByType(
    {
      cwd: s.root,
      gh: s.gh,
      reports: stepReports,
      state: engineDeps(),
      runAgent: designer([{ design: "## Screens & flow\nnew", other: "ignored" }], packets),
    },
    3,
  );
  assert.equal(r.state, "COMPLETED", JSON.stringify(r.error));
  assert.equal(packets[0]?.role, "ui-ux-designer");
  const body = s.w.bodies.get(3) ?? "";
  assert.match(body, /omi:section=design/);
  assert.match(body, /new/);
  assert.ok(!body.includes("omi:section=notes")); // other sections of the design step are ignored
  assert.equal(r.review?.command, "move");
  assert.equal(s.project.byNumber(3).status, "In review");
  assert.ok(!s.project.mutations.some((m) => m.startsWith("close 3")));
  assert.equal(s.project.byNumber(3).state ?? "OPEN", "OPEN");
  assert.equal(r.run.workflow, "dev-task");
  assert.ok(!existsSync(join(s.base, "tasks")));
  // no commit, no branch, no worktree: only the runtime's own state files appear
  assert.equal(git(s.root, "rev-list", "--count", "HEAD"), "1");
  assert.equal(git(s.root, "branch", "--format=%(refname:short)"), "main");
  assert.equal(git(s.root, "worktree", "list").split("\n").length, 1);
});

test("TC-383-21: a design result without the `design` section does not move the DesignTask", () => {
  const s = designSetup();
  const r = taskRunByType(
    {
      cwd: s.root,
      gh: s.gh,
      reports: stepReports,
      state: engineDeps(),
      runAgent: designer([{ other: "only notes" }]),
    },
    3,
  );
  // The step contract refuses a designer PASSED without its `design` section: the run stops here.
  assert.equal(r.state, "BLOCKED");
  assert.match(r.error?.message ?? "", /claims do not match/);
  assert.equal(r.review, undefined);
  assert.notEqual(s.project.byNumber(3).status, "In review");
  assert.ok(!(s.w.bodies.get(3) ?? "").includes("omi:section="));
});

test("TC-383-22: `task start` refuses a DesignTask before any worktree or branch exists", () => {
  const s = designSetup();
  assert.throws(
    () => taskStart({ cwd: s.root, gh: s.gh, state: engineDeps() }, 3),
    (e: { code?: string; message: string }) =>
      e.code === "POLICY_VIOLATION" && /omi task run 3/.test(e.message),
  );
  assert.equal(git(s.root, "branch", "--list").includes("task"), false);
});

test("TC-383-23: a v2 DevTask/QATask is not run read-only; a Bug is refused with a clear message", () => {
  for (const type of ["DevTask", "QATask"]) {
    const s = designSetup(ticketOf(type, "## Objective\nx"));
    const packets: TaskPacket[] = [];
    // The runner is injected: reaching it (or a gate on the type's own rules) proves taskRun was taken,
    // never the design path (which would have produced a `design` section and a move).
    try {
      taskRunByType(
        {
          cwd: s.root,
          gh: s.gh,
          reports: stepReports,
          state: engineDeps(),
          runAgent: designer([{}, {}], packets),
        },
        3,
      );
    } catch {
      // DoR / setup of the fake repo may refuse: not the design path either way
    }
    assert.ok(!(s.w.bodies.get(3) ?? "").includes("omi:section=design"), type);
    assert.notEqual(s.project.byNumber(3).status, "In review", type);
  }
  const b = designSetup(ticketOf("Bug", "## Objective\nx"));
  assert.throws(
    () =>
      taskRunByType(
        {
          cwd: b.root,
          gh: b.gh,
          reports: stepReports,
          state: engineDeps(),
          runAgent: designer([]),
        },
        3,
      ),
    (e: { code?: string; message: string }) =>
      e.code === "POLICY_VIOLATION" && /child DevTask/.test(e.message),
  );
});

const config = parseConfig({
  github: { owner: "o", repo: "r", projectNumber: 2, model: "v2" },
});

test("TC-383-24: planFor v2 uses the native type, native parent Bug, legacy label fallback, missing type", () => {
  const dev = ticketOf("DevTask", "## Objective\nx");
  const w = world([
    { number: 5, title: "Bug-0005-b", type: "Bug", body: "x" },
    PARENT,
    dev,
    ticketOf("DevTask", "x", { number: 6, parent: 5 }),
    ticketOf("QATask", "x", { number: 7, parent: 5 }),
    // a native type that does not run, with a legacy label: keeps the legacy analysis plan
    ticketOf("UserStory", "x", { number: 8, labels: ["type:feature"] }),
    ticketOf("DevTask", "x", { number: 9, type: null as unknown as string }),
  ]);
  const plan = (n: number) => planFor(config, fetchTicket(config, n, w.run), w.run);
  const d = plan(3);
  assert.ok(d.kind === "delivery" && d.workflow === "Feature Implementation");
  const fix = plan(6);
  assert.ok(fix.kind === "delivery" && fix.workflow === "Bug Resolution");
  const retest = plan(7);
  assert.ok(retest.kind === "qa" && retest.retest);
  assert.equal(plan(8).kind, "analysis");
  assert.throws(
    () => plan(9),
    (e: { code?: string }) => e.code === "TICKET_INVALID",
  );
});

test("TC-383-25: runTypeOf records v2 runs as dev-task/test-task and nothing for other types", () => {
  const w = world([
    PARENT,
    ticketOf("DesignTask", "x", { number: 3 }),
    ticketOf("DevTask", "x", { number: 4 }),
    ticketOf("QATask", "x", { number: 5 }),
    ticketOf("Bug", "x", { number: 6 }),
  ]);
  const t = (n: number) => fetchTicket(config, n, w.run);
  assert.equal(runTypeOf(t(3), config), "dev-task");
  assert.equal(runTypeOf(t(4), config), "dev-task");
  assert.equal(runTypeOf(t(5), config), "test-task");
  assert.equal(runTypeOf(t(6), config), undefined);
  assert.equal(typeOfV2(t(6)), "Bug");
});
