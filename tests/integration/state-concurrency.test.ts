// T2.2 concurrent calls: separate OS processes race on one fresh state file (migration, run
// creation, lease). Exactly one wins each race; the rest get typed errors, never busy failures.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const repoUrl = pathToFileURL(
  join(import.meta.dirname, "../../runtime/persistence/repository.ts"),
).href;
const dbUrl = pathToFileURL(join(import.meta.dirname, "../../runtime/persistence/db.ts")).href;

const CHILD = `
import { openState } from ${JSON.stringify(dbUrl)};
import * as repo from ${JSON.stringify(repoUrl)};
const [file, me] = process.argv.slice(1);
const out = {};
const attempt = (name, fn) => { try { fn(); out[name] = "ok"; } catch (e) { out[name] = e.code ?? String(e); } };
let db;
attempt("open", () => { db = openState(file); });
const issue = { repository: "o/r", number: 1 };
attempt("run", () => repo.createRun(db, { id: "run-" + me, issue, workflow: "dev-task" }));
attempt("lease", () => repo.acquireLease(db, { key: "issue:o/r#1", holder: me, ttlMs: 60000 }));
console.log(JSON.stringify(out));
`;

const child = (file: string, me: string) =>
  new Promise<Record<string, string>>((resolve, reject) => {
    const p = spawn(process.execPath, ["--input-type=module", "-e", CHILD, file, me]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => {
      out += d;
    });
    p.stderr.on("data", (d) => {
      err += d;
    });
    p.on("close", (c) => (c === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
  });

test("8 processes race on a fresh database: one run, one lease, no busy errors", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "omi-race-")), "state.sqlite");
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => child(file, `p${i}`)));
  assert.ok(
    results.every((r) => r.open === "ok"),
    JSON.stringify(results),
  );
  const count = (k: string, v: string) => results.filter((r) => r[k] === v).length;
  assert.equal(count("run", "ok"), 1, JSON.stringify(results));
  assert.equal(count("run", "OWNERSHIP_MISMATCH"), 7);
  assert.equal(count("lease", "ok"), 1);
  assert.equal(count("lease", "LOCK_HELD"), 7);
});
