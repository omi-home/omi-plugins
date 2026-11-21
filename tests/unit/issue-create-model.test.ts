// DevTask-0102 #311 (carried from DevTask-0101 #310 CR-002): `issue create --type` is checked
// against the workspace's model before anything reaches GitHub.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { main } from "../../runtime/cli/main.ts";

function workspace(model?: string) {
  const ws = mkdtempSync(join(tmpdir(), "omi-create-"));
  mkdirSync(join(ws, ".omi-plugins"));
  mkdirSync(join(ws, "repo", ".git"), { recursive: true });
  writeFileSync(
    join(ws, ".omi-plugins", "omi.config.yaml"),
    `github:\n  owner: acme\n  repo: app\n  projectNumber: 2\n${model ? `  model: ${model}\n` : ""}`,
  );
  writeFileSync(join(ws, "body.md"), "## Objective\nx\n");
  return ws;
}

const create = (ws: string, type: string) =>
  main(
    [
      "issue",
      "create",
      "--type",
      type,
      "--title",
      "T",
      "--body-file",
      "body.md",
      "--output",
      "json",
    ],
    ws,
  );

test("legacy: a native type name is a usage error listing the legacy types, nothing written", () => {
  const r = create(workspace(), "DevTask");
  assert.equal(r.code, 2);
  const err = JSON.parse(r.stdout).error as { code: string; message: string };
  assert.equal(err.code, "USAGE_INVALID");
  assert.match(err.message, /dev-task/);
  assert.match(err.message, /legacy/);
  assert.doesNotMatch(err.message, /label type/);
});

test("an unknown name is refused in either model", () => {
  for (const model of [undefined, "v2"]) {
    const r = create(workspace(model), "Spike");
    assert.equal(r.code, 2);
    assert.equal(JSON.parse(r.stdout).error.code, "USAGE_INVALID");
  }
});
