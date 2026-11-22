// `omi doctor` architecture check (Feature-0043 #321): warn without contract, fail on an invalid
// contract or violations (first 5 shown), warn while `legacy` remains, pass when clean.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { architectureCheck } from "../../../runtime/workspace/cli/doctor.ts";
import { makeRepo, validContract } from "../../unit/architecture/helpers.ts";

const GOOD = {
  "src/kernel/k.ts": "export const k = 1;\n",
  "src/billing/domain/a.ts": 'import { k } from "../../kernel/k.ts";\nexport const a = k;\n',
};

test("no contract: warn pointing at the runbook", () => {
  const dir = mkdtempSync(join(tmpdir(), "omi-doc-"));
  try {
    const c = architectureCheck(dir);
    assert.equal(c.status, "warn");
    assert.match(c.detail, /docs\/runbooks\/architecture-contract\.md/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid contract: fail CONTRACT_INVALID", () => {
  const { dir, cleanup } = makeRepo(GOOD, { schemaVersion: 1, nope: true });
  try {
    const c = architectureCheck(dir);
    assert.equal(c.status, "fail");
    assert.equal(c.code, "CONTRACT_INVALID");
  } finally {
    cleanup();
  }
});

test("violations: fail ARCH_VIOLATION with the first 5 only", () => {
  const files: Record<string, string> = { ...GOOD };
  for (let i = 0; i < 8; i++) files[`src/mystery/m${i}.ts`] = "export {};\n";
  const { dir, cleanup } = makeRepo(files);
  try {
    const c = architectureCheck(dir);
    assert.equal(c.status, "fail");
    assert.equal(c.code, "ARCH_VIOLATION");
    assert.equal(c.detail.match(/\[undeclared-module\]/g)?.length, 5);
    assert.match(c.detail, /and 3 more/);
  } finally {
    cleanup();
  }
});

test("clean with legacy left: warn; clean without legacy: pass", () => {
  const legacy = makeRepo({ ...GOOD, "src/old/o.ts": "export {};\n" });
  const none = makeRepo(GOOD, { ...validContract(), legacy: [] });
  try {
    assert.equal(architectureCheck(legacy.dir).status, "warn");
    assert.match(architectureCheck(legacy.dir).detail, /legacy/);
    assert.equal(architectureCheck(none.dir).status, "pass");
  } finally {
    legacy.cleanup();
    none.cleanup();
  }
});
