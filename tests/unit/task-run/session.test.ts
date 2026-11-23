import assert from "node:assert/strict";
import { test } from "node:test";
import type { AgentObservation } from "../../../runtime/harness/domain/harness.ts";
import { resumeNotLoaded } from "../../../runtime/task-run/application/session.ts";

function obs(o: Partial<AgentObservation> & { turns?: number }): AgentObservation {
  const { turns, ...rest } = o;
  return {
    actualModel: "m",
    actualEffort: "unknown",
    thinkingObserved: false,
    isError: true,
    result: "x",
    permissionDenials: [],
    ...(turns === undefined ? {} : { usage: { inputTokens: 1, outputTokens: 1, numTurns: turns } }),
    ...rest,
  };
}

test("resumeNotLoaded: error without usage is a lost session", () => {
  assert.equal(resumeNotLoaded(obs({})), true);
});

test("resumeNotLoaded: error with zero turns is a lost session", () => {
  assert.equal(resumeNotLoaded(obs({ turns: 0 })), true);
});

test("resumeNotLoaded: the host's 'no conversation found' message is a lost session", () => {
  assert.equal(
    resumeNotLoaded(obs({ turns: 12, result: "No conversation found with session ID abc" })),
    true,
  );
});

test("resumeNotLoaded: an ordinary agent error mentioning session/oauth is not", () => {
  assert.equal(
    resumeNotLoaded(
      obs({ turns: 12, result: "fixing the session token refresh in auth.ts failed (oauth)" }),
    ),
    false,
  );
});

test("resumeNotLoaded: a run that did not error is never a lost session", () => {
  assert.equal(resumeNotLoaded(obs({ isError: false })), false);
});
