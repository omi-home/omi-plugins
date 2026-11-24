import assert from "node:assert/strict";
import { test } from "node:test";
import { PLAN_KINDS, planTitle } from "../../../runtime/github/application/qa-plan.ts";

const CLOSING = /\b(close[sd]?|fix(e[sd])?|resolve[sd]?)\b[:\s]*(\S+\/\S+)?#\d+/i;

test("TC-426-01: no planned task title has a GitHub closing keyword before #<n>", () => {
  for (const kind of PLAN_KINDS) {
    const title = `DevTask-0148-${planTitle(426, kind)}`;
    assert.doesNotMatch(title, CLOSING, title);
  }
  assert.equal(planTitle(426, "fix"), "Sửa Bug #426");
});
