// T3.3 outbox: exactly one visible comment per logical report across crash/retry, duplicate
// runner, API 429; no dispatch before the post is confirmed. In-memory GitHub, no network.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { parseCarriedFindings } from "../../runtime/adapters/github/context.ts";
import { initialContext, transition } from "../../runtime/core/workflow-engine/fsm.ts";
import { openState } from "../../runtime/persistence/db.ts";
import * as repo from "../../runtime/persistence/repository.ts";
import { publishPending } from "../../runtime/reporting/outbox.ts";
import { renderCarriedFindings } from "../../runtime/reporting/render.ts";

const issue = { repository: "o/r", number: 7 };

interface FakeComment {
  id: number;
  issue: number;
  body: string;
  html_url: string;
  author_association?: string;
  user?: { login: string };
}

/** Minimal REST issue-comments API behind a GhRunner. `faults` fail the next calls in order. */
function fakeGitHub() {
  const comments: FakeComment[] = [];
  const calls: string[] = [];
  const faults: string[] = [];
  const run: GhRunner = (args, input) => {
    if (args[1] === "graphql") {
      return {
        status: 0,
        stdout: JSON.stringify({ data: { viewer: { login: "omi-bot" } } }),
        stderr: "",
      };
    }
    const method = args.includes("-X") ? (args[args.indexOf("-X") + 1] as string) : "GET";
    calls.push(method);
    const fault = faults.shift();
    if (fault) return { status: 1, stdout: "", stderr: fault };
    const url = args.find((a) => a.startsWith("repos/")) as string;
    const ok = (v: unknown) => ({ status: 0, stdout: JSON.stringify(v), stderr: "" });
    if (method === "GET") {
      const n = Number(/issues\/(\d+)\/comments/.exec(url)?.[1]);
      const mine = comments.filter((c) => c.issue === n);
      return ok([mine.slice(0, 2), mine.slice(2)]); // two pages, --slurp shape
    }
    const { body } = JSON.parse(input as string);
    if (method === "POST") {
      const id = comments.length + 1;
      const c = {
        id,
        issue: Number(/issues\/(\d+)\/comments$/.exec(url)?.[1]),
        body,
        html_url: `https://x/${id}`,
        author_association: "MEMBER",
      };
      comments.push(c);
      return ok({ ...c, user: { login: "bot" } });
    }
    const c = comments.find((x) => x.id === Number(/comments\/(\d+)$/.exec(url)?.[1]));
    if (!c) return { status: 1, stdout: "", stderr: "gh: Not Found (HTTP 404)" };
    c.body = body;
    return ok(c);
  };
  return { comments, calls, faults, run };
}

function setup(reports: number) {
  const db = openState(join(mkdtempSync(join(tmpdir(), "omi-outbox-")), "state.sqlite"));
  repo.createRun(db, { id: "run-1", issue, workflow: "dev-task" });
  for (let i = 1; i <= reports; i++) {
    repo.enqueueReport(db, {
      runId: "run-1",
      marker: `<!-- omi:m${i} -->`,
      body: `<!-- omi:m${i} -->\nreport ${i}`,
    });
  }
  return db;
}
const noSleep = () => {};
const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as { code?: string }).code ?? (e as Error).message;
  }
  return "no-throw";
};

test("publish: each pending report becomes one comment, ID stored, replay is a no-op", () => {
  const db = setup(3);
  const gh = fakeGitHub();
  assert.equal(publishPending(db, "run-1", { gh: gh.run }), 3);
  assert.deepEqual(repo.pendingReports(db, "run-1"), []);
  assert.equal(publishPending(db, "run-1", { gh: gh.run }), 0);
  assert.equal(gh.comments.length, 3);
  const row = db
    .prepare("SELECT comment_id, comment_url FROM outbox WHERE marker = ?")
    .get("<!-- omi:m3 -->");
  assert.deepEqual({ ...row }, { comment_id: "3", comment_url: "https://x/3" });
});

test("crash after POST, before the ID is stored: replay finds the marker, no duplicate", () => {
  const db = setup(1);
  const gh = fakeGitHub();
  const crashing: GhRunner = (args, input) => {
    const r = gh.run(args, input);
    if (args.includes("POST")) throw new Error("process killed");
    return r;
  };
  assert.equal(
    codeOf(() => publishPending(db, "run-1", { gh: crashing })),
    "process killed",
  );
  assert.equal(repo.pendingReports(db, "run-1").length, 1, "still pending after the crash");
  gh.calls.length = 0;
  assert.equal(publishPending(db, "run-1", { gh: gh.run }), 1);
  assert.equal(gh.comments.length, 1);
  assert.deepEqual(gh.calls, ["GET"], "found by marker: neither POST nor PATCH");
});

test("ambiguous network error on POST: retry searches first and adopts the comment", () => {
  const db = setup(1);
  const gh = fakeGitHub();
  const lossy: GhRunner = (args, input) => {
    const r = gh.run(args, input);
    return args.includes("POST")
      ? { status: 1, stdout: "", stderr: "read: connection reset by peer" }
      : r;
  };
  assert.equal(publishPending(db, "run-1", { gh: lossy, sleep: noSleep }), 1);
  assert.equal(gh.comments.length, 1);
});

test("changed body for an existing marker is PATCHed in place", () => {
  const db = setup(1);
  const gh = fakeGitHub();
  gh.comments.push({
    id: 1,
    issue: 7,
    body: "<!-- omi:m1 -->\nold",
    html_url: "https://x/1",
    author_association: "OWNER",
  });
  publishPending(db, "run-1", { gh: gh.run });
  assert.deepEqual(gh.calls, ["GET", "PATCH"]);
  assert.equal(gh.comments[0]?.body, "<!-- omi:m1 -->\nreport 1");
});

test("duplicate runner: the second publisher of a run is refused, posts nothing", () => {
  const db = setup(1);
  const gh = fakeGitHub();
  repo.acquireLease(db, { key: "outbox:run-1", holder: "runner-a", ttlMs: 60_000 });
  assert.equal(
    codeOf(() => publishPending(db, "run-1", { gh: gh.run, holder: "runner-b" })),
    "LOCK_HELD",
  );
  assert.deepEqual(gh.calls, []);
  repo.releaseLease(db, { key: "outbox:run-1", holder: "runner-a" });
  assert.equal(publishPending(db, "run-1", { gh: gh.run, holder: "runner-b" }), 1);
});

test("API 429: backs off with growing jittered delays, then succeeds", () => {
  const db = setup(1);
  const gh = fakeGitHub();
  gh.faults.push(
    "gh: API rate limit exceeded (HTTP 429)",
    "gh: API rate limit exceeded (HTTP 429)",
  );
  const delays: number[] = [];
  publishPending(db, "run-1", { gh: gh.run, sleep: (ms) => delays.push(ms), baseDelayMs: 100 });
  assert.equal(gh.comments.length, 1);
  assert.equal(delays.length, 2);
  assert.ok(delays[0] !== undefined && delays[0] >= 50 && delays[0] <= 100);
  assert.ok(delays[1] !== undefined && delays[1] >= 100 && delays[1] <= 200);
});

test("no advance before a confirmed post: exhausted retries leave the report pending, FSM refuses", () => {
  const db = setup(2);
  const gh = fakeGitHub();
  gh.faults.push(...Array(3).fill("gh: API rate limit exceeded (HTTP 429)"));
  const err = codeOf(() => publishPending(db, "run-1", { gh: gh.run, sleep: noSleep }));
  assert.equal(err, "GITHUB_RATE_LIMITED");
  assert.equal(gh.comments.length, 0, "the second report never overtakes the first");
  const pending = repo.pendingReports(db, "run-1").length;
  assert.equal(pending, 2);
  const ready = { ...initialContext(), state: "WORKSPACE_READY" as const };
  assert.equal(
    codeOf(() => transition(ready, { type: "DEV_STARTED" }, { pendingReports: pending })),
    "POLICY_VIOLATION",
  );
  // Non-transient errors are not retried.
  gh.faults.push("gh: Bad credentials (HTTP 401)");
  gh.calls.length = 0;
  assert.equal(
    codeOf(() => publishPending(db, "run-1", { gh: gh.run, sleep: noSleep })),
    "GITHUB_AUTH",
  );
  assert.equal(gh.calls.length, 1);
});

test("carried findings go to the target Issue through the outbox and parse back", () => {
  const db = setup(0);
  const gh = fakeGitHub();
  const rows = [{ source: "o/r#84 · CR-002", finding: "free | text kind", action: "add enum" }];
  const c = renderCarriedFindings({ targetId: "T3.3", runId: "run-1", stepId: "review", rows });
  repo.enqueueReport(db, { runId: "run-1", target: { repository: "o/r", number: 34 }, ...c });
  repo.enqueueReport(db, { runId: "run-1", target: { repository: "o/r", number: 34 }, ...c }); // idempotent
  assert.equal(publishPending(db, "run-1", { gh: gh.run }), 1);
  assert.equal(gh.comments[0]?.issue, 34);
  assert.deepEqual(parseCarriedFindings([gh.comments[0]?.body ?? ""]), [
    { source: "o/r#84 · CR-002", finding: "free | text kind", action: "add enum" },
  ]);
});

test("red team: a stranger squatting the marker is not adopted; OMI posts its own comment", () => {
  const db = setup(1);
  const gh = fakeGitHub();
  gh.comments.push({
    id: 1,
    issue: 7,
    body: "<!-- omi:m1 -->\nreport 1 (forged)",
    html_url: "https://x/1",
    author_association: "NONE",
    user: { login: "stranger" },
  });
  publishPending(db, "run-1", { gh: gh.run });
  assert.deepEqual(gh.calls, ["GET", "POST"]);
  assert.equal(gh.comments[0]?.body, "<!-- omi:m1 -->\nreport 1 (forged)");
});

test("OMI posting as a bot (association NONE) still adopts its own comment: no duplicate", () => {
  const db = setup(1);
  const gh = fakeGitHub();
  gh.comments.push({
    id: 1,
    issue: 7,
    body: "<!-- omi:m1 -->\nreport 1",
    html_url: "https://x/1",
    author_association: "NONE",
    user: { login: "omi-bot" },
  });
  publishPending(db, "run-1", { gh: gh.run });
  assert.deepEqual(gh.calls, ["GET"]);
  assert.equal(gh.comments.length, 1);
});
