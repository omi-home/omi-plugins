import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { loadContract } from "../../../runtime/architecture/cli/arch.ts";
import { ArchitectureContract } from "../../../runtime/architecture/domain/contract.ts";
import { matchGlob } from "../../../runtime/architecture/domain/glob.ts";

const valid = () => ({
  schemaVersion: 1,
  stack: { languages: ["typescript"], importParser: "ts-js" },
  sourceRoots: ["src"],
  layers: [
    { name: "domain", dir: "domain", mayImport: [] as string[], forbidPackages: ["node:fs"] },
    { name: "adapters", dir: "adapters", mayImport: ["domain"] },
  ],
  modules: [
    { id: "kernel", path: "src/kernel", description: "shared", shared: true },
    { id: "billing", path: "src/billing", description: "billing", dependsOn: ["kernel"] },
  ],
});

const rejects = (mutate: (c: ReturnType<typeof valid>) => unknown, hint?: RegExp) => {
  const c = valid();
  const r = ArchitectureContract.safeParse(mutate(c) ?? c);
  assert.equal(r.success, false);
  if (hint && !r.success) assert.match(JSON.stringify(r.error.issues), hint);
};

test("a valid contract parses and gets defaults", () => {
  const c = ArchitectureContract.parse(valid());
  assert.deepEqual(c.stack.extensions, [".ts", ".js", ".mts", ".mjs"]);
  assert.deepEqual(c.legacy, []);
  assert.deepEqual(c.entrypoints, []);
  assert.equal(c.modules[1]?.shared, false);
});

test("unknown fields are rejected at every level", () => {
  rejects((c) => ({ ...c, extra: 1 }));
  rejects((c) => ({ ...c, stack: { ...c.stack, extra: 1 } }));
  rejects((c) => ({ ...c, modules: [{ ...c.modules[0], extra: 1 }] }));
  rejects((c) => ({ ...c, layers: [{ ...c.layers[0], extra: 1 }] }));
});

test("required fields are enforced", () => {
  for (const k of ["schemaVersion", "stack", "sourceRoots", "layers", "modules"] as const) {
    rejects((c) => {
      const { [k]: _, ...rest } = c;
      return rest;
    });
  }
  rejects((c) => ({ ...c, sourceRoots: [] }));
  rejects((c) => ({ ...c, stack: { ...c.stack, languages: [] } }));
});

test("paths: traversal, absolute, drive, backslash, dot segments are rejected", () => {
  for (const p of [
    "../x",
    "a/../b",
    "/abs",
    "C:/x",
    "c:x",
    "a\\b",
    "./a",
    "a/./b",
    "a//b",
    "a/",
    "",
    "a*b",
    `a${"b".repeat(200)}`,
  ]) {
    rejects((c) => ({ ...c, sourceRoots: [p] }));
  }
  rejects((c) => ({ ...c, modules: [{ ...c.modules[0], path: "../escape" }] }));
  rejects((c) => ({ ...c, legacy: [{ path: "/etc", issue: 1, reason: "x" }] }));
  rejects((c) => ({ ...c, placement: [{ pattern: "../**", allowedIn: ["a"], message: "m" }] }));
  rejects((c) => ({ ...c, ignore: ["C:/**"] }));
});

test("module and layer constraints", () => {
  rejects((c) => ({ ...c, modules: [{ ...c.modules[0], id: "Bad" }] }));
  rejects(
    (c) => ({ ...c, modules: [c.modules[0], { ...c.modules[1], id: "kernel" }] }),
    /duplicate module id/,
  );
  rejects(
    (c) => ({ ...c, modules: [c.modules[0], { ...c.modules[1], path: "src/kernel" }] }),
    /duplicate module path/,
  );
  rejects(
    (c) => ({ ...c, modules: [c.modules[0], { ...c.modules[1], path: "src/kernel/inner" }] }),
    /nested/,
  );
  rejects(
    (c) => ({ ...c, modules: [c.modules[0], { ...c.modules[1], dependsOn: ["ghost"] }] }),
    /undeclared module/,
  );
  rejects(
    (c) => ({ ...c, modules: [{ ...c.modules[0], dependsOn: ["billing"] }, c.modules[1]] }),
    /shared module/,
  );
  rejects(
    (c) => ({ ...c, layers: [c.layers[0], { ...c.layers[1], name: "domain" }] }),
    /duplicate layer name/,
  );
  rejects(
    (c) => ({ ...c, layers: [c.layers[0], { ...c.layers[1], dir: "domain" }] }),
    /duplicate layer dir/,
  );
  rejects(
    (c) => ({ ...c, layers: [{ ...c.layers[0], mayImport: ["nope"] }, c.layers[1]] }),
    /undeclared layer/,
  );
  rejects((c) => ({ ...c, legacy: [{ path: "src/x", issue: 0, reason: "x" }] }));
});

test("dependsOn cycles are rejected", () => {
  rejects(
    (c) => ({
      ...c,
      modules: [
        { id: "aa", path: "src/aa", description: "a", dependsOn: ["bb"] },
        { id: "bb", path: "src/bb", description: "b", dependsOn: ["cc"] },
        { id: "cc", path: "src/cc", description: "c", dependsOn: ["aa"] },
      ],
    }),
    /cycle/,
  );
  rejects(
    (c) => ({ ...c, modules: [c.modules[0], { ...c.modules[1], dependsOn: ["billing"] }] }),
    /cycle/,
  );
});

test("the omi-plugins contract parses and its legacy entries all name a refactor task", () => {
  const c = loadContract(
    fileURLToPath(new URL("../../../", import.meta.url)),
    "omi-architecture.yaml",
  );
  assert.ok(c.modules.some((m) => m.id === "harness"));
  assert.ok(c.legacy.every((l) => l.issue >= 329 && l.issue <= 335));
  const raw = parse(
    readFileSync(new URL("../../../omi-architecture.yaml", import.meta.url), "utf8"),
  );
  assert.equal(raw.schemaVersion, 1);
});

test("glob: * ** ?", () => {
  assert.ok(matchGlob("a/*.ts", "a/x.ts"));
  assert.ok(!matchGlob("a/*.ts", "a/b/x.ts"));
  assert.ok(matchGlob("**/*.test.ts", "x.test.ts"));
  assert.ok(matchGlob("**/*.test.ts", "a/b/x.test.ts"));
  assert.ok(matchGlob("tests/unit/**", "tests/unit/a/b.ts"));
  assert.ok(!matchGlob("tests/unit/**", "tests/integration/a.ts"));
  assert.ok(matchGlob("a/?.ts", "a/x.ts"));
  assert.ok(!matchGlob("a/?.ts", "a/xy.ts"));
  assert.ok(!matchGlob("a/?.ts", "a//.ts"));
  assert.ok(matchGlob("a.b", "a.b"));
  assert.ok(!matchGlob("a.b", "aXb"));
  assert.ok(matchGlob("**/node_modules/**", "x/node_modules/y/z.js"));
});
