import assert from "node:assert/strict";
import { test } from "node:test";
import { parseContract, StepResult } from "../../../runtime/shared/contracts.ts";
import { isTransient, OmiError } from "../../../runtime/shared/errors/errors.ts";
import { redact, redactDeep, registerSecret } from "../../../runtime/shared/redact.ts";
import { cutAt } from "../../../runtime/shared/text.ts";

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

test("redact: prose with token/Bearer/Basic is untouched, secret-looking values are not", () => {
  for (const prose of [
    "the profile's token management is documented",
    "Bearer authentication. Basic configuration needed",
    "each token expires quickly",
  ]) {
    assert.equal(redact(prose), prose);
  }
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc123def";
  assert.equal(redact(`Bearer ${jwt}`), "Bearer [REDACTED]");
  assert.equal(redact("token abcd1234efgh"), "token [REDACTED]");
  assert.equal(redact(`token ghp_${"a".repeat(30)}`), "token [REDACTED:github-token]");
});

test("cutAt never splits a surrogate pair", () => {
  assert.equal(cutAt("ab😀cd", 3), "ab");
  assert.equal(cutAt("ab😀cd", 4), "ab😀");
  assert.equal(cutAt("abc", 10), "abc");
});

test("registerSecret: registered values are scrubbed; values below the minimum are ignored", () => {
  const secret = "omi-canary-unit-a1b2c3d4";
  registerSecret(secret);
  assert.equal(redact(`x ${secret} y`), "x [REDACTED:secret] y");
  assert.ok(!JSON.stringify(redactDeep({ a: [`n ${secret}`] })).includes(secret));
  registerSecret("abc12");
  assert.equal(redact("abc12 xyz"), "abc12 xyz");
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
