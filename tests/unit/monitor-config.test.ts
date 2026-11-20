// DevTask-0095 #284: `omi config get|set`, the json envelope's protocolVersion, monitor JSON Schemas.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../../runtime/cli/main.ts";
import {
  Envelope,
  MONITOR_PROTOCOL_VERSION,
  MONITOR_SCHEMAS,
  renderSchema,
} from "../../runtime/monitor/protocol.ts";
import { schemaFile, writeSchemas } from "../../runtime/monitor/schemas.ts";

// Regenerate with `npm test -- --test-update-snapshots tests/unit/monitor-config.test.ts`.
const UPDATE =
  process.env.OMI_UPDATE_SCHEMAS === "1" || process.execArgv.includes("--test-update-snapshots");

const bin = fileURLToPath(new URL("../../bin/omi", import.meta.url));

const YAML = `# OMI settings
github:
  owner: acme # the org
  repo: app
  projectNumber: 2
checks:
  test:
    run: npm test # gate
`;

function workspace() {
  const ws = mkdtempSync(join(tmpdir(), "omi-config-"));
  mkdirSync(join(ws, ".omi-plugins"));
  mkdirSync(join(ws, "repo", ".git"), { recursive: true });
  writeFileSync(join(ws, ".omi-plugins", "omi.config.yaml"), YAML);
  return ws;
}
const file = (ws: string) => join(ws, ".omi-plugins", "omi.config.yaml");

const set = (ws: string, input: unknown, ...flags: string[]) => {
  const r = spawnSync(process.execPath, [bin, "config", "set", "--output", "json", ...flags], {
    cwd: ws,
    input: JSON.stringify(input),
    encoding: "utf8",
  });
  return {
    code: r.status,
    out: JSON.parse(r.stdout) as {
      data: { changed: boolean; etag: string };
      error: { code: string };
    },
  };
};

test("envelope carries protocolVersion, success and failure", () => {
  const ok = JSON.parse(main(["version", "--output", "json"]).stdout);
  assert.equal(ok.protocolVersion, MONITOR_PROTOCOL_VERSION);
  Envelope.parse(ok);
  const bad = JSON.parse(main(["nope", "--output", "json"]).stdout);
  assert.equal(bad.protocolVersion, MONITOR_PROTOCOL_VERSION);
  Envelope.parse(bad);
});

test("config get: whole config with defaults, one path, etag", () => {
  const ws = workspace();
  const all = JSON.parse(main(["config", "get", "--output", "json"], ws).stdout);
  assert.equal(all.data.value.git.baseBranch, "develop");
  assert.match(all.data.etag, /^[0-9a-f]{64}$/);
  const one = JSON.parse(main(["config", "get", "checks.test.run", "--output", "json"], ws).stdout);
  assert.equal(one.data.value, "npm test");
  const missing = main(["config", "get", "nope.x", "--output", "json"], ws);
  assert.equal(missing.code, 2);
  assert.equal(JSON.parse(missing.stdout).error.code, "USAGE_INVALID");
});

test("config set: valid edit keeps comments and writes atomically", () => {
  const ws = workspace();
  const r = set(ws, {
    changes: [
      { path: "git.baseBranch", value: "dev" },
      { path: "github.repo", value: "web" },
    ],
  });
  assert.equal(r.code, 0, JSON.stringify(r.out));
  assert.equal(r.out.data.changed, true);
  const text = readFileSync(file(ws), "utf8");
  assert.match(text, /# OMI settings/);
  assert.match(text, /owner: acme # the org/);
  assert.match(text, /repo: web/);
  assert.match(text, /baseBranch: dev/);
  assert.deepEqual(readdirSync(join(ws, ".omi-plugins")), ["omi.config.yaml"]); // no temp file left
  assert.equal(
    set(ws, { changes: [{ path: "git.baseBranch", value: "dev" }] }).out.data.changed,
    false,
  );
});

test("config set: unknown field or wrong type is CONFIG_INVALID and the file is unchanged", () => {
  const ws = workspace();
  for (const change of [
    { path: "bogus", value: 1 },
    { path: "git.nope", value: 1 },
    { path: "github.projectNumber", value: "two" },
  ]) {
    const r = set(ws, { changes: [change] });
    assert.equal(r.code, 1);
    assert.equal(r.out.error.code, "CONFIG_INVALID");
    assert.equal(readFileSync(file(ws), "utf8"), YAML);
  }
  assert.equal(
    set(ws, { changes: [{ path: "a", value: 1, extra: true }] }).out.error.code,
    "CONFIG_INVALID",
  );
  assert.equal(set(ws, { nope: 1 }).out.error.code, "CONFIG_INVALID");
  assert.equal(readFileSync(file(ws), "utf8"), YAML);
});

test("config set: --if-match mismatch is CONFIG_CONFLICT, a matching etag passes", () => {
  const ws = workspace();
  const etag = JSON.parse(main(["config", "get", "--output", "json"], ws).stdout).data
    .etag as string;
  const stale = set(
    ws,
    { changes: [{ path: "git.baseBranch", value: "dev" }] },
    "--if-match",
    "0".repeat(64),
  );
  assert.equal(stale.out.error.code, "CONFIG_CONFLICT");
  assert.equal(readFileSync(file(ws), "utf8"), YAML);
  const fresh = set(
    ws,
    { changes: [{ path: "git.baseBranch", value: "dev" }] },
    "--if-match",
    etag,
  );
  assert.equal(fresh.code, 0);
  assert.notEqual(fresh.out.data.etag, etag);
});

test("config set: changing checks or setup needs --confirm-commands", () => {
  const ws = workspace();
  const change = { changes: [{ path: "checks.test.run", value: "rm -rf /tmp/x" }] };
  const denied = set(ws, change);
  assert.equal(denied.code, 1);
  assert.equal(denied.out.error.code, "POLICY_VIOLATION");
  assert.equal(readFileSync(file(ws), "utf8"), YAML);
  assert.equal(
    set(ws, { changes: [{ path: "setup", value: { run: "npm ci" } }] }).out.error.code,
    "POLICY_VIOLATION",
  );
  assert.equal(set(ws, change, "--confirm-commands").code, 0);
  assert.match(readFileSync(file(ws), "utf8"), /run: rm -rf \/tmp\/x # gate/);
});

test("config set: --body-file input and output redaction", () => {
  const ws = workspace();
  const body = join(ws, "in.json");
  writeFileSync(body, JSON.stringify({ changes: [{ path: "git.baseBranch", value: "dev" }] }));
  const r = main(["config", "set", "--body-file", body, "--output", "json"], ws);
  assert.equal(r.code, 0, r.stdout);
  const g = main(["config", "get", "checks.test", "--output", "json"], ws);
  assert.ok(!g.stdout.includes("C:\\Users\\"));
});

test("committed monitor schemas match the zod contracts", () => {
  if (UPDATE) writeSchemas();
  for (const name of Object.keys(MONITOR_SCHEMAS)) {
    assert.ok(
      existsSync(schemaFile(name)),
      `schemas/monitor/${name}.schema.json missing: run OMI_UPDATE_SCHEMAS=1 npm test`,
    );
    assert.equal(
      readFileSync(schemaFile(name), "utf8").replace(/\r\n/g, "\n"),
      renderSchema(name),
      `${name} schema drifted: regenerate with OMI_UPDATE_SCHEMAS=1 npm test`,
    );
  }
});
