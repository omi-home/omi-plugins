// DevTask-0045 #128: parent → child matrix, depth, cycles, title ↔ type label.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { IssueType } from "../../runtime/core/contracts.ts";
import {
  hierarchyChecks,
  type Link,
  loadHierarchy,
  titleCheck,
  titleType,
} from "../../runtime/core/hierarchy.ts";

const h = loadHierarchy();
const chain = (...types: IssueType[]): Link[] => types.map((type, i) => ({ number: i + 1, type }));
const verdict = (self: Link, up: Link[]) => {
  const [c] = hierarchyChecks(self, up, h);
  return `${c?.status}${c?.status === "fail" ? `: ${c.detail}` : ""}`;
};

test("6-level tree is valid; a seventh level exceeds the depth", () => {
  const [self, ...up] = chain(
    "dev-task",
    "dev-task",
    "change-request",
    "feature",
    "milestone",
    "epic",
  );
  assert.equal(verdict(self as Link, up), "pass");
  const [s7, ...up7] = chain(
    "dev-task",
    "dev-task",
    "dev-task",
    "change-request",
    "feature",
    "milestone",
    "epic",
  );
  assert.match(verdict(s7 as Link, up7), /depth 7 exceeds 6/);
});

test("invalid parent: wrong type pair is refused", () => {
  const [self, ...up] = chain("feature", "dev-task");
  assert.match(verdict(self as Link, up), /#1 \(feature\) cannot be a child of #2 \(dev-task\)/);
  const [bugTask, ...bugUp] = chain("dev-task", "bug", "feature");
  assert.equal(verdict(bugTask as Link, bugUp), "pass");
});

test("cycle: an Issue that is its own ancestor", () => {
  assert.match(
    verdict({ number: 1, type: "dev-task" }, [
      { number: 2, type: "dev-task" },
      { number: 1, type: "dev-task" },
    ]),
    /cycle: #1/,
  );
});

test("every type's children are known types; the matrix covers today's tree", () => {
  for (const [parent, kids] of [
    ["epic", "milestone"],
    ["milestone", "feature"],
    ["milestone", "dev-task"],
    ["feature", "spike"],
    ["feature", "documentation-task"],
    ["dev-task", "dev-task"],
  ] as const) {
    assert.ok(h.children[parent]?.includes(kids), `${parent} → ${kids}`);
  }
});

test("title prefix must match the type label", () => {
  assert.equal(titleType("dev-task"), "DevTask");
  assert.equal(titleType("fr"), "FunctionalRequirement");
  assert.equal(titleType("change-request"), "ChangeRequest");
  assert.equal(titleCheck("DevTask-0045-Ma trận", "dev-task").status, "pass");
  assert.equal(titleCheck("Feature-0045-Ma trận", "dev-task").status, "fail");
  assert.equal(titleCheck("DevTask-45-x", "dev-task").status, "fail");
  assert.equal(titleCheck("Ma trận", "dev-task").status, "fail");
});
