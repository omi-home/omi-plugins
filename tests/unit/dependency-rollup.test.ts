// DevTask-0029 #60: completion roll-up policy (accepted children only) and `omi issue depend`
// against a fake dependency graph: cycles, other repositories, re-run, unverifiable graphs.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { addDependency } from "../../runtime/adapters/github/dependency.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";
import { type Child, rollUp } from "../../runtime/core/hierarchy.ts";

const kid = (ref: string, over: Partial<Child> = {}): Child => ({
  ref,
  state: "CLOSED",
  stateReason: "COMPLETED",
  status: "Done",
  ...over,
});

test("rollUp: only closed and accepted children; cancelled ones allowed but not alone", () => {
  assert.deepEqual(rollUp([kid("#1"), kid("#2", { status: "Cancelled" })], 2), { ready: true });
  assert.deepEqual(
    rollUp([kid("#1"), kid("o/x#9", { status: null, stateReason: "DUPLICATE" })], 2),
    { ready: true },
    "outside the Project: judged by close reason",
  );
  const no = (children: Child[], total = children.length) => {
    const r = rollUp(children, total);
    return r.ready ? "ready" : r.reason;
  };
  assert.equal(no([kid("#1"), kid("#2", { state: "OPEN", stateReason: null })]), "open: #2");
  assert.equal(
    no([kid("#1"), kid("#2", { status: "In QA" }), kid("#3", { status: null, stateReason: null })]),
    "closed but not accepted: #2 (In QA), #3 (no reason)",
  );
  assert.equal(
    no([
      kid("#1", { status: "Cancelled" }),
      kid("#2", { status: null, stateReason: "NOT_PLANNED" }),
    ]),
    "every child is cancelled: a person decides",
  );
  assert.equal(
    no([kid("#1"), kid("#2", { status: "unknown" })]),
    "closed but not accepted: #2 (unknown)",
    "Status unreadable or not an OMI option: never accepted",
  );
  assert.equal(no([kid("#1")], 101), "100 child(ren) not verified");
  assert.equal(no([]), "no children");
});

/** Issues by "owner/repo#n" → what they are blocked by. */
function fakeGraph(edges: Record<string, string[]>, totals: Record<string, number> = {}) {
  const added: string[] = [];
  const ref = (k: string) => {
    const [repo, n] = k.split("#");
    return { number: Number(n), repository: { nameWithOwner: repo } };
  };
  const run: GhRunner = (args) => {
    const v = (k: string) => args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
    if (v("query").includes("addBlockedBy")) {
      const [i, b] = [v("i"), v("b")];
      edges[i] = [...(edges[i] ?? []), b];
      added.push(`${i}<-${b}`);
      return { status: 0, stdout: JSON.stringify({ data: {} }), stderr: "" };
    }
    const k = `${v("owner")}/${v("repo")}#${v("number")}`;
    const issue =
      k in edges || Object.values(edges).flat().includes(k)
        ? {
            id: k,
            ...ref(k),
            blockedBy: {
              totalCount: totals[k] ?? (edges[k] ?? []).length,
              nodes: (edges[k] ?? []).map(ref),
            },
          }
        : null;
    return { status: 0, stdout: JSON.stringify({ data: { repository: { issue } } }), stderr: "" };
  };
  return { run, added };
}
const at = (k: string) => {
  const [owner = "", rest = ""] = k.split("/");
  const [repo = "", n] = rest.split("#");
  return { owner, repo, number: Number(n) };
};

test("depend: adds once (other repo fine); re-run is a no-op", () => {
  const g = fakeGraph({ "o/a#1": [], "x/b#7": [] });
  assert.deepEqual(addDependency(at("o/a#1"), at("x/b#7"), g.run), {
    issue: "o/a#1",
    blockedBy: "x/b#7",
    added: true,
  });
  assert.equal(addDependency(at("o/a#1"), at("x/b#7"), g.run).added, false);
  assert.deepEqual(g.added, ["o/a#1<-x/b#7"]);
});

test("depend: a cycle through another repository is refused before any write", () => {
  // #1 ← #2 ← x/b#3 already; adding #3 ← #1 would close the loop.
  const g = fakeGraph({ "o/a#1": ["o/a#2"], "o/a#2": ["x/b#3"], "x/b#3": [] });
  assert.throws(
    () => addDependency(at("x/b#3"), at("o/a#1"), g.run),
    (e: OmiError) =>
      e.code === "POLICY_VIOLATION" && e.message.includes("cycle: x/b#3 → o/a#1 → o/a#2 → x/b#3"),
  );
  assert.throws(
    () => addDependency(at("o/a#1"), at("o/a#1"), g.run),
    (e: OmiError) => e.code === "USAGE_INVALID",
  );
  assert.deepEqual(g.added, []);
});

test("depend: missing Issue or more blockers than OMI reads: refused, nothing written", () => {
  const g = fakeGraph({ "o/a#1": [], "o/a#2": [] }, { "o/a#2": 60 });
  assert.throws(
    () => addDependency(at("o/a#1"), at("o/a#9"), g.run),
    (e: OmiError) => e.code === "TICKET_INVALID",
  );
  assert.throws(
    () => addDependency(at("o/a#1"), at("o/a#2"), g.run),
    (e: OmiError) => e.code === "POLICY_VIOLATION" && /not verified/.test(e.message),
  );
  assert.deepEqual(g.added, []);
});
