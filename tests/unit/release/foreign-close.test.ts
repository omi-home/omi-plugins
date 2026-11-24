// Bug-0017 #426 / DevTask-0149 #431: a task PR must not close an Issue other than its primary.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  foreignCloseCheck,
  foreignClosingRefs,
  prBody,
} from "../../../runtime/release/adapters/pr.ts";

const primary = "o/repo#423";

test("TC-426-02: title `DevTask-0147-Fix #410` of the PR for #423 is refused", () => {
  const c = foreignCloseCheck(
    { title: "DevTask-0147-Fix #410", body: prBody("o/repo", 423) },
    primary,
  );
  assert.equal(c.name, "pr-foreign-close");
  assert.equal(c.status, "fail");
  assert.match(c.detail ?? "", /o\/repo#410/);
});

test("TC-426-03: `Closes #423` (the primary) is accepted", () => {
  const c = foreignCloseCheck(
    { title: "DevTask-0147-Sửa Bug #410", body: prBody("o/repo", 423, "Refs #410") },
    primary,
  );
  assert.equal(c.status, "pass");
});

test("TC-426-04: keyword variants, colon, cross-repo and URL forms are foreign", () => {
  for (const text of [
    "closes #1",
    "FIXED: #1",
    "Resolves   #1",
    "fix other/x#1",
    "resolved https://github.com/other/x/issues/1",
  ]) {
    assert.equal(foreignClosingRefs(text, primary).length, 1, text);
  }
  assert.deepEqual(foreignClosingRefs("Closes o/repo#423 and fix #423", primary), []);
  assert.equal(foreignClosingRefs("prefix #1, fixture #2", primary).length, 0);
});
