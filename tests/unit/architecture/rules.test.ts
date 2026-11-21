import assert from "node:assert/strict";
import { test } from "node:test";
import { ArchitectureContract } from "../../../runtime/architecture/domain/contract.ts";
import {
  buildReport,
  checkArchitecture,
  formatViolation,
  type ImportRef,
} from "../../../runtime/architecture/domain/rules.ts";
import { validContract } from "./helpers.ts";

const contract = ArchitectureContract.parse(validContract());

const run = (files: string[], imports: ImportRef[], extra: Partial<typeof contract> = {}) =>
  checkArchitecture({
    files,
    imports,
    contract: { ...contract, ...extra },
    isFile: () => false,
  });

const imp = (file: string, specifier: string, line = 1): ImportRef => ({ file, specifier, line });

test("a valid layout passes", () => {
  const files = [
    "src/kernel/x.ts",
    "src/billing/domain/a.ts",
    "src/billing/adapters/b.ts",
    "src/billing/cli/c.ts",
    "src/orders/domain/o.ts",
    "src/old/legacy.ts",
    "src/main.ts",
    "tests/unit/a.test.ts",
  ];
  const v = run(files, [
    imp("src/billing/adapters/b.ts", "../domain/a.ts"),
    imp("src/billing/cli/c.ts", "../adapters/b.ts"),
    imp("src/billing/domain/a.ts", "../../kernel/x.ts"),
    imp("src/orders/domain/o.ts", "../../billing/domain/a.ts"),
    imp("src/billing/domain/a.ts", "../../old/legacy.ts"), // new module → legacy is fine
    imp("src/main.ts", "./billing/cli/c.ts"),
    imp("tests/unit/a.test.ts", "../../src/billing/domain/a.ts"),
  ]);
  assert.deepEqual(v, []);
});

test("layer: domain must not import adapters; message names file, rule and the fix", () => {
  const files = ["src/billing/domain/fsm.ts", "src/billing/adapters/git.ts"];
  const [v] = run(files, [imp("src/billing/domain/fsm.ts", "../adapters/git.ts", 3)]);
  assert.equal(v?.rule, "layer");
  assert.equal(v?.path, "src/billing/domain/fsm.ts");
  assert.equal(v?.line, 3);
  const line = formatViolation(v as NonNullable<typeof v>);
  assert.match(line, /^src\/billing\/domain\/fsm\.ts:3 \[layer\] /);
  assert.match(line, /src\/billing\/adapters\/git\.ts/);
  assert.match(line, /Sửa: /);
});

test("boundary: a module may import another only through dependsOn", () => {
  const files = ["src/billing/domain/a.ts", "src/reports/domain/r.ts", "src/kernel/k.ts"];
  const v = run(files, [
    imp("src/billing/domain/a.ts", "../../reports/domain/r.ts", 2),
    imp("src/kernel/k.ts", "../billing/domain/a.ts", 4),
  ]);
  assert.deepEqual(
    v.map((x) => [x.rule, x.path]),
    [
      ["boundary", "src/billing/domain/a.ts"],
      ["boundary", "src/kernel/k.ts"],
    ],
  );
  assert.match(v[0]?.fix ?? "", /dependsOn/);
});

test("layer rule also applies across modules in dependsOn", () => {
  const files = ["src/orders/domain/o.ts", "src/billing/adapters/b.ts"];
  const v = run(files, [imp("src/orders/domain/o.ts", "../../billing/adapters/b.ts")]);
  assert.equal(v[0]?.rule, "layer");
});

test("forbidden-package: node: and bare specifiers are checked against forbidPackages only", () => {
  const files = ["src/billing/domain/a.ts", "src/billing/adapters/b.ts"];
  const v = run(files, [
    imp("src/billing/domain/a.ts", "node:fs", 5),
    imp("src/billing/domain/a.ts", "node:fs/promises", 6),
    imp("src/billing/domain/a.ts", "zod", 7),
    imp("src/billing/adapters/b.ts", "node:fs", 8),
  ]);
  assert.deepEqual(
    v.map((x) => [x.rule, x.line]),
    [
      ["forbidden-package", 5],
      ["forbidden-package", 6],
    ],
  );
});

test("placement: a file matching a pattern outside allowedIn is rejected", () => {
  const v = run(["src/billing/domain/a.test.ts"], []);
  assert.equal(v[0]?.rule, "placement");
  assert.match(v[0]?.message ?? "", /Tests live under tests/);
  assert.match(v[0]?.fix ?? "", /tests\/\*\*/);
});

test("undeclared-module and undeclared-layer", () => {
  const v = run(["src/mystery/a.ts", "src/billing/loose.ts", "src/kernel/ok.ts"], []);
  assert.deepEqual(
    v.map((x) => x.rule),
    ["undeclared-module", "undeclared-layer"],
  );
  assert.match(v[0]?.fix ?? "", /thêm module vào contract/i);
});

test("ignore and legacy exempt files from module and layer rules", () => {
  const files = ["src/gen/x.ts", "src/old/deep/y.ts", "src/billing/adapters/b.ts"];
  const v = run(
    files,
    [
      imp("src/old/deep/y.ts", "../../billing/adapters/b.ts"),
      imp("src/gen/x.ts", "../billing/adapters/b.ts"),
    ],
    { ignore: ["src/gen/**"] },
  );
  assert.deepEqual(v, []);
});

test("unresolved-import: missing file and escaping the repo; .js maps to .ts; index files", () => {
  const files = [
    "src/billing/domain/a.ts",
    "src/billing/domain/b.ts",
    "src/billing/domain/sub/index.ts",
  ];
  const v = run(files, [
    imp("src/billing/domain/a.ts", "./b.js"),
    imp("src/billing/domain/a.ts", "./sub"),
    imp("src/billing/domain/a.ts", "./missing.ts", 3),
    imp("src/billing/domain/a.ts", "../../../../../outside.ts", 4),
  ]);
  assert.deepEqual(
    v.map((x) => [x.rule, x.line]),
    [
      ["unresolved-import", 3],
      ["unresolved-import", 4],
    ],
  );
  assert.match(v[1]?.message ?? "", /ra ngoài repo/);
});

test("entrypoint with mayImport cli only reaches the cli layer", () => {
  const files = ["src/main.ts", "src/billing/cli/c.ts", "src/billing/domain/a.ts"];
  const v = run(files, [
    imp("src/main.ts", "./billing/cli/c.ts", 1),
    imp("src/main.ts", "./billing/domain/a.ts", 2),
  ]);
  assert.deepEqual(
    v.map((x) => [x.rule, x.line]),
    [["layer", 2]],
  );
});

test("report: sorted by path, line, rule; truncated at 500; passed reflects violations", () => {
  const mk = (path: string, line: number, rule: "layer" | "boundary") => ({
    rule,
    path,
    line,
    message: "m",
    fix: "f",
  });
  const r = buildReport("c.yaml", 3, [
    mk("b.ts", 1, "layer"),
    mk("a.ts", 9, "layer"),
    mk("a.ts", 9, "boundary"),
  ]);
  assert.deepEqual(
    r.violations.map((v) => `${v.path}:${v.line}:${v.rule}`),
    ["a.ts:9:boundary", "a.ts:9:layer", "b.ts:1:layer"],
  );
  assert.equal(r.passed, false);
  const many = buildReport(
    "c.yaml",
    1,
    Array.from({ length: 501 }, (_, i) => mk("a.ts", i + 1, "layer")),
  );
  assert.equal(many.violations.length, 500);
  assert.equal(many.truncated, true);
  assert.equal(buildReport("c.yaml", 1, []).passed, true);
});
