// Timeout classification of a check (#366): status 124 after the deadline (monotonic clock) is a
// timeout; a command that itself exits 124 well before the deadline stays a plain failure.
import assert from "node:assert/strict";
import { test } from "node:test";
import { isTimeout } from "../../../runtime/task-run/adapters/checks.ts";

test("status 124 at or past the deadline is a timeout, with slack for an early timer", () => {
  assert.equal(isTimeout(124, undefined, 2000, 2000), true);
  assert.equal(isTimeout(124, undefined, 2400, 2000), true);
  assert.equal(isTimeout(124, undefined, 1990, 2000), true);
});

test("a command exiting 124 by itself long before the deadline is not a timeout", () => {
  assert.equal(isTimeout(124, undefined, 300, 2000), false);
});

test("spawnSync ETIMEDOUT is a timeout", () => {
  const e = Object.assign(new Error("t"), { code: "ETIMEDOUT" });
  assert.equal(isTimeout(null, e, 2500, 2000), true);
});

test("other statuses are not timeouts", () => {
  for (const s of [0, 1, 127, 137, null]) assert.equal(isTimeout(s, undefined, 5000, 2000), false);
});
