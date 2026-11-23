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
import { main } from "../../../runtime/cli/main.ts";
import { schemaFile } from "../../../runtime/monitor/adapters/schemas.ts";
import {
  Envelope,
  MONITOR_PROTOCOL_VERSION,
  MONITOR_SCHEMAS,
  renderSchema,
} from "../../../runtime/monitor/domain/protocol.ts";

const bin = fileURLToPath(new URL("../../../bin/omi", import.meta.url));

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

test("config set: changing checks, setup or regression needs --confirm-commands", () => {
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

test("config set: changing regression.command needs --confirm-commands", () => {
  const ws = workspace();
  const change = { changes: [{ path: "regression.command", value: "node --test {files}" }] };
  const denied = set(ws, change);
  assert.equal(denied.code, 1);
  assert.equal(denied.out.error.code, "POLICY_VIOLATION");
  assert.equal(readFileSync(file(ws), "utf8"), YAML);
  assert.equal(set(ws, change, "--confirm-commands").code, 0);
  assert.match(readFileSync(file(ws), "utf8"), /node --test \{files\}/);
});

test("config set: --body-file input and output redaction", () => {
  const ws = workspace();
  const body = join(ws, "in.json");
  writeFileSync(body, JSON.stringify({ changes: [{ path: "git.baseBranch", value: "dev" }] }));
  const r = main(["config", "set", "--body-file", body, "--output", "json"], ws);
  assert.equal(r.code, 0, r.stdout);
  const tok = `ghp_${"a1B2".repeat(8)}`;
  const s = main(
    ["config", "set", "--body-file", body, "--confirm-commands", "--output", "json"],
    ws,
  );
  assert.equal(s.code, 0);
  writeFileSync(file(ws), YAML.replace("npm test", `curl http://h/${tok}`));
  for (const args of [["--output", "json"], []]) {
    const g = main(["config", "get", "checks.test", ...args], ws);
    assert.ok(!g.stdout.includes(tok), g.stdout);
    assert.match(g.stdout, /REDACTED/);
  }
});

test("config set: unset under a missing parent is a no-op; a path through a scalar is CONFIG_INVALID", () => {
  const ws = workspace();
  const unset = set(ws, { changes: [{ path: "git.baseBranch", unset: true }] });
  assert.equal(unset.code, 0, JSON.stringify(unset.out));
  assert.equal(unset.out.data.changed, false);
  assert.equal(readFileSync(file(ws), "utf8"), YAML);
  const scalar = set(ws, { changes: [{ path: "github.owner.x", value: 1 }] });
  assert.equal(scalar.code, 1);
  assert.equal(scalar.out.error.code, "CONFIG_INVALID");
  assert.equal(readFileSync(file(ws), "utf8"), YAML);
});

test("committed monitor schemas match the zod contracts", () => {
  for (const name of Object.keys(MONITOR_SCHEMAS)) {
    assert.ok(
      existsSync(schemaFile(name)),
      `schemas/monitor/${name}.schema.json missing: run npm run schemas:monitor`,
    );
    assert.equal(
      readFileSync(schemaFile(name), "utf8").replace(/\r\n/g, "\n"),
      renderSchema(name),
      `${name} schema drifted: regenerate with npm run schemas:monitor`,
    );
  }
});
