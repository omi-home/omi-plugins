import assert from "node:assert/strict";
import { symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { main } from "../../../runtime/cli/main.ts";
import { makeRepo, validContract } from "./helpers.ts";

const GOOD = {
  "src/kernel/k.ts": "export const k = 1;\n",
  "src/billing/domain/a.ts": 'import { k } from "../../kernel/k.ts";\nexport const a = k;\n',
  "src/billing/adapters/b.ts": 'import { a } from "../domain/a.ts";\nexport const b = a;\n',
  "src/orders/domain/o.ts": "export const o = 1;\n",
  "src/reports/domain/r.ts": "export const r = 1;\n",
  "tests/unit/a.test.ts": 'import "../../src/billing/domain/a.ts";\n',
};

const check = (dir: string, ...extra: string[]) =>
  main(["arch", "check", "--repo", dir, ...extra], dir);

test("a valid repo passes: exit 0, text and json (ArchReport in the envelope)", () => {
  const { dir, cleanup } = makeRepo(GOOD);
  try {
    const t = check(dir);
    assert.equal(t.code, 0);
    assert.match(t.stdout, /no violations/);
    const j = check(dir, "--output", "json");
    assert.equal(j.code, 0);
    const env = JSON.parse(j.stdout);
    assert.equal(env.data.passed, true);
    assert.equal(env.data.schemaVersion, 1);
    assert.equal(env.data.contractPath, "omi-architecture.yaml");
    assert.equal(env.data.filesScanned, 6);
    assert.equal(check(dir, "--output", "text").code, 0);
  } finally {
    cleanup();
  }
});

test("the three violation kinds fail with ARCH_VIOLATION, exit 1 and a fix, sorted", () => {
  const { dir, cleanup } = makeRepo({
    ...GOOD,
    "src/billing/domain/bad.ts": 'import { b } from "../adapters/b.ts";\nimport "node:fs";\n', // layer + forbidden
    "src/orders/domain/x.test.ts": "export {};\n", // placement
    "src/mystery/m.ts": "export {};\n", // undeclared-module
    "src/reports/domain/cross.ts": 'import "../../billing/domain/a.ts";\n', // boundary
  });
  try {
    const r = check(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /ARCH_VIOLATION/);
    assert.match(r.stderr, /src\/billing\/domain\/bad\.ts:1 \[layer\] .* Sửa: /);
    assert.match(r.stderr, /src\/billing\/domain\/bad\.ts:2 \[forbidden-package\]/);
    assert.match(r.stderr, /src\/orders\/domain\/x\.test\.ts \[placement\]/);
    assert.match(r.stderr, /src\/mystery\/m\.ts \[undeclared-module\]/);
    assert.match(r.stderr, /src\/reports\/domain\/cross\.ts:1 \[boundary\]/);

    const j = main(["arch", "check", "--repo", dir, "--output", "json"], dir);
    assert.equal(j.code, 1);
    const env = JSON.parse(j.stdout);
    assert.equal(env.error.code, "ARCH_VIOLATION");
    const report = env.error.details;
    assert.equal(report.passed, false);
    const paths = report.violations.map((v: { path: string }) => v.path);
    assert.deepEqual(paths, [...paths].sort());
    assert.equal(JSON.stringify(check(dir)), JSON.stringify(r), "deterministic");
  } finally {
    cleanup();
  }
});

test("missing contract, invalid YAML and invalid contract are CONTRACT_INVALID with distinct messages", () => {
  const { dir, cleanup } = makeRepo({ ...GOOD });
  try {
    const missing = check(dir, "--contract", "nope.yaml");
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /CONTRACT_INVALID: architecture contract not found/);

    writeFileSync(join(dir, "broken.yaml"), "a: [unclosed\n");
    assert.match(
      check(dir, "--contract", "broken.yaml").stderr,
      /CONTRACT_INVALID: .* not valid YAML/,
    );

    writeFileSync(join(dir, "bad.yaml"), "schemaVersion: 1\nunknownField: true\n");
    assert.match(check(dir, "--contract", "bad.yaml").stderr, /CONTRACT_INVALID: .* invalid/);
  } finally {
    cleanup();
  }
});

test("--contract and --scope paths with .., absolute or drive are refused", () => {
  const { dir, cleanup } = makeRepo({ ...GOOD });
  try {
    for (const p of [
      "../omi-architecture.yaml",
      "/etc/passwd",
      "C:/x.yaml",
      "C:\\x.yaml",
      "a/../b.yaml",
    ]) {
      const r = check(dir, "--contract", p);
      assert.equal(r.code, 2, p);
      assert.match(r.stderr, /USAGE_INVALID/);
      const s = main(["arch", "show", "--repo", dir, "--scope", p], dir);
      assert.equal(s.code, 2, p);
    }
  } finally {
    cleanup();
  }
});

test("a sourceRoot that is missing is a contract error", () => {
  const c = { ...validContract(), sourceRoots: ["lib"] };
  const { dir, cleanup } = makeRepo({ ...GOOD }, c);
  try {
    assert.match(check(dir).stderr, /CONTRACT_INVALID: sourceRoots entry lib is missing/);
  } finally {
    cleanup();
  }
});

test("symlinks are not followed: a linked file or directory is not scanned", (t) => {
  const { dir, cleanup } = makeRepo({
    ...GOOD,
    "outside/evil.ts": 'import "../src/reports/domain/r.ts";\nimport "node:fs";\n',
    "outside/dir/e2.ts": "export {};\n",
  });
  try {
    try {
      symlinkSync(join(dir, "outside", "evil.ts"), join(dir, "src/billing/domain/link.ts"), "file");
      symlinkSync(join(dir, "outside", "dir"), join(dir, "src/billing/linkdir"), "dir");
    } catch {
      t.skip("symlinks not permitted on this machine");
      return;
    }
    const r = check(dir, "--output", "json");
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(JSON.parse(r.stdout).data.filesScanned, 6);
  } finally {
    cleanup();
  }
});

test("a symlinked sourceRoot is refused, not followed", (t) => {
  const { dir, cleanup } = makeRepo(
    { "real/x.ts": "export {};\n" },
    { ...validContract(), sourceRoots: ["src"] },
  );
  try {
    try {
      symlinkSync(join(dir, "real"), join(dir, "src"), "dir");
    } catch {
      t.skip("symlinks not permitted on this machine");
      return;
    }
    assert.match(check(dir).stderr, /sourceRoots entry src is symlink/);
  } finally {
    cleanup();
  }
});

test("a symlinked PARENT directory cannot pull files from outside the repo (SEC-001)", (t) => {
  const outside = makeRepo({ "billing/x.ts": "export {};\n", "conf/c.yaml": "a: 1\n" });
  const { dir, cleanup } = makeRepo(
    { "src/kernel/k.ts": "export {};\n" },
    { ...validContract(), sourceRoots: ["src/kernel", "lnk/billing"] },
  );
  try {
    try {
      symlinkSync(outside.dir, join(dir, "lnk"), "dir");
    } catch {
      t.skip("symlinks not permitted on this machine");
      return;
    }
    const root = check(dir);
    assert.equal(root.code, 1);
    assert.match(root.stderr, /sourceRoots entry lnk\/billing is outside repo/);
    const contract = check(dir, "--contract", "lnk/conf/c.yaml");
    assert.equal(contract.code, 1);
    assert.match(contract.stderr, /CONTRACT_INVALID/);
    assert.doesNotMatch(contract.stderr, /a: 1/);
  } finally {
    cleanup();
    outside.cleanup();
  }
});

test("control characters in a specifier never reach the output (SEC-002)", () => {
  const { dir, cleanup } = makeRepo({
    ...GOOD,
    "src/billing/domain/esc.ts": 'import "./\x1b[31mred.ts";\n',
  });
  try {
    const r = check(dir);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /unresolved-import/);
    assert.ok(!r.stderr.includes("\x1b"));
  } finally {
    cleanup();
  }
});

test("--output with a bad value names human, text and json (CR-001)", () => {
  const { dir, cleanup } = makeRepo(GOOD);
  try {
    assert.match(check(dir, "--output", "xml").stderr, /--output must be human, text or json/);
  } finally {
    cleanup();
  }
});

test("imports inside comments, strings and templates are ignored by the check", () => {
  const { dir, cleanup } = makeRepo({
    ...GOOD,
    "src/billing/domain/quiet.ts": [
      '// import "node:fs";',
      '/* import x from "../adapters/b.ts" */',
      'export const s = "import \\"node:fs\\"";',
      'export const t = `require("../adapters/b.ts")`;',
    ].join("\n"),
  });
  try {
    assert.equal(check(dir).code, 0);
  } finally {
    cleanup();
  }
});

test("arch show: all modules, or the scope's modules plus their dependsOn", () => {
  const { dir, cleanup } = makeRepo({ ...GOOD });
  try {
    const all = JSON.parse(main(["arch", "show", "--repo", dir, "--output", "json"], dir).stdout);
    assert.equal(all.data.contractPath, "omi-architecture.yaml");
    assert.equal(all.data.modules.length, 4);
    assert.equal(all.data.layers.length, 4);
    assert.equal(all.data.placement.length, 1);
    const scoped = JSON.parse(
      main(["arch", "show", "--repo", dir, "--scope", "src/orders/domain", "--output", "json"], dir)
        .stdout,
    );
    assert.deepEqual(scoped.data.modules.map((m: { id: string }) => m.id).sort(), [
      "billing",
      "orders",
    ]);
  } finally {
    cleanup();
  }
});

test("omi-plugins itself passes arch check in under 2 seconds", () => {
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const start = performance.now();
  const r = main(["arch", "check", "--repo", root], root);
  const ms = performance.now() - start;
  assert.equal(r.code, 0, r.stderr);
  assert.ok(ms < 2000, `took ${ms}ms`);
});
