import assert from "node:assert/strict";
import { test } from "node:test";
import { scanImports } from "../../../runtime/architecture/adapters/imports.ts";

const specs = (src: string) => scanImports(src).map((s) => s.specifier);

test("static forms: import from, side effect, type, export from, export *, dynamic, require", () => {
  const src = `
import a from "./a.ts";
import { b, c as d } from './b.ts';
import * as ns from "./ns.ts";
import type { T } from "./t.ts";
import "./side.ts";
export { x } from "./x.ts";
export * from "./star.ts";
export * as y from "./y.ts";
export type { Z } from "./z.ts";
const e = await import("./dyn.ts");
const f = require("./req.cjs");
import {
  m,
  n,
} from "./multi.ts"
`;
  assert.deepEqual(specs(src), [
    "./a.ts",
    "./b.ts",
    "./ns.ts",
    "./t.ts",
    "./side.ts",
    "./x.ts",
    "./star.ts",
    "./y.ts",
    "./z.ts",
    "./dyn.ts",
    "./req.cjs",
    "./multi.ts",
  ]);
});

test("line numbers point at the specifier", () => {
  const r = scanImports(`// c\n\nimport {\n a } from "./a.ts";\nimport("./b.ts");`);
  assert.deepEqual(r, [
    { specifier: "./a.ts", line: 4 },
    { specifier: "./b.ts", line: 5 },
  ]);
});

test("imports inside comments, strings and templates are ignored", () => {
  const src = [
    '// import x from "./line-comment.ts"',
    '/* import y from "./block.ts"\n   require("./block2.ts") */',
    'const s = "import z from \\"./in-string.ts\\"";',
    "const s2 = 'require(\"./single.ts\")';",
    'const t = `import w from "./template.ts" ${1 + 1}`;',
    'const re = /import\\("x"\\)\\/"/;',
    'import real from "./real.ts";',
  ].join("\n");
  assert.deepEqual(specs(src), ["./real.ts"]);
});

test("template expressions are scanned, nested templates and braces handled", () => {
  const src =
    'const a = `x ${ {k: `in ${ import("./deep.ts") } `}.k } y`;\nimport r from "./after.ts";';
  assert.deepEqual(specs(src), ["./deep.ts", "./after.ts"]);
});

test("dynamic import with a non-literal argument and member calls are ignored", () => {
  const src = `
import(name);
import(\`./\${x}.ts\`);
obj.require("./nope.ts");
const o = { import: "./nope2.ts" };
console.log(import.meta.url);
export const v = 1;
export function f() { return "./nope3.ts"; }
`;
  assert.deepEqual(specs(src), []);
});

test("bare and node: specifiers are returned as written", () => {
  assert.deepEqual(specs(`import fs from "node:fs";\nimport { z } from "zod";`), [
    "node:fs",
    "zod",
  ]);
});

test("division is not a regex and an unterminated string does not swallow the file", () => {
  assert.deepEqual(specs(`const a = b / c; const d = e / f;\nimport x from "./x.ts";`), ["./x.ts"]);
  assert.deepEqual(specs(`const bad = "oops\nimport x from "./x.ts";`), ["./x.ts"]);
});
