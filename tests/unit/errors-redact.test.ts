import assert from "node:assert/strict";
import { test } from "node:test";
import { parseContract, StepResult } from "../../runtime/core/contracts.ts";
import { isTransient, OmiError } from "../../runtime/core/errors/errors.ts";
import { redact } from "../../runtime/reporting/redact.ts";

const cases: [string, string][] = [
  [`ghp_${"a".repeat(36)}`, "[REDACTED:github-token]"],
  [`github_pat_${"B".repeat(40)}`, "[REDACTED:github-token]"],
  [`sk-ant-api03-${"x".repeat(30)}`, "[REDACTED:anthropic-key]"],
  ["Authorization: Bearer abc.def.ghi123", "Authorization: Bearer [REDACTED]"],
  ["https://user:hunter2@github.com/o/r.git", "https://[REDACTED]@github.com/o/r.git"],
  [`{"password": "hunter2"}`, `{"password": "[REDACTED]"}`],
  ["api_key=abc123", "api_key=[REDACTED]"],
  ["C:\\Users\\alice\\repo", "C:\\Users\\<user>\\repo"],
  ["/home/alice/repo", "/home/<user>/repo"],
];

test("redact: known credential formats and user paths", () => {
  for (const [input, expected] of cases) assert.equal(redact(`x ${input} y`), `x ${expected} y`);
  assert.equal(redact("plain text, commit abcdef1"), "plain text, commit abcdef1");
});

test("OmiError redacts message and nested details", () => {
  const tok = `ghp_${"z".repeat(36)}`;
  const e = new OmiError("GITHUB_AUTH", `bad token ${tok}`, { headers: [`token ${tok}`] });
  const json = JSON.stringify(e);
  assert.ok(!json.includes(tok), json);
  assert.equal(e.toJSON().transient, false);
});

test("validation errors never echo input values", () => {
  const tok = `ghp_${"q".repeat(36)}`;
  assert.throws(
    () => parseContract(StepResult, { schemaVersion: 1, summary: 42, stepId: tok }, "step"),
    (e) => !JSON.stringify(e).includes(tok),
  );
});

test("transient errors are retries, not review rounds", () => {
  assert.equal(isTransient(new OmiError("NETWORK", "reset")), true);
  assert.equal(isTransient(new OmiError("GITHUB_RATE_LIMITED", "429")), true);
  assert.equal(isTransient(new OmiError("POLICY_VIOLATION", "no")), false);
  assert.equal(isTransient(new Error("plain")), false);
});
