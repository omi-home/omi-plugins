// Typed architecture contract (Feature-0043 #321). Every object is strict: unknown fields are
// rejected. Paths are posix, relative to the repo root, and can never climb out of it.
import { z } from "zod";
import {
  ArchitectureExcerpt,
  ArchModule,
  Glob,
  Layer,
  ModuleId,
  Placement,
  RelPath,
} from "../../shared/contracts.ts";

// The building blocks live in the shared kernel (the task packet carries an excerpt of the contract).
export { ArchitectureExcerpt, ArchModule, Glob, Layer, ModuleId, Placement, RelPath };

const text = (max: number) => z.string().min(1).max(max);

export const ArchitectureContract = z
  .strictObject({
    schemaVersion: z.literal(1),
    stack: z.strictObject({
      languages: z.array(text(40)).min(1),
      importParser: z.enum(["ts-js", "none"]),
      extensions: z
        .array(z.string().regex(/^\.[A-Za-z0-9]{1,10}$/))
        .default([".ts", ".js", ".mts", ".mjs"]),
    }),
    sourceRoots: z.array(RelPath).min(1),
    layers: z.array(Layer).min(1),
    modules: z.array(ArchModule).min(1),
    entrypoints: z
      .array(z.strictObject({ path: RelPath, mayImport: z.enum(["cli", "any"]) }))
      .default([]),
    placement: z.array(Placement).default([]),
    ignore: z.array(Glob).default([]),
    legacy: z
      .array(
        z.strictObject({ path: RelPath, issue: z.number().int().positive(), reason: text(200) }),
      )
      .default([]),
  })
  .superRefine((c, ctx) => {
    const bad = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });

    const layerNames = new Set<string>();
    const layerDirs = new Set<string>();
    c.layers.forEach((l, i) => {
      if (layerNames.has(l.name)) bad(["layers", i, "name"], "duplicate layer name");
      if (layerDirs.has(l.dir)) bad(["layers", i, "dir"], "duplicate layer dir");
      layerNames.add(l.name);
      layerDirs.add(l.dir);
    });
    c.layers.forEach((l, i) => {
      l.mayImport.forEach((n, j) => {
        if (!layerNames.has(n)) bad(["layers", i, "mayImport", j], `undeclared layer: ${n}`);
      });
    });

    const byId = new Map(c.modules.map((m) => [m.id, m]));
    const paths = new Set<string>();
    const ids = new Set<string>();
    c.modules.forEach((m, i) => {
      if (ids.has(m.id)) bad(["modules", i, "id"], `duplicate module id: ${m.id}`);
      if (paths.has(m.path)) bad(["modules", i, "path"], `duplicate module path: ${m.path}`);
      ids.add(m.id);
      paths.add(m.path);
    });
    c.modules.forEach((a, i) => {
      for (const b of c.modules) {
        if (a !== b && a.path !== b.path && a.path.startsWith(`${b.path}/`)) {
          bad(["modules", i, "path"], `${a.path} is nested inside module ${b.id} (${b.path})`);
        }
      }
      a.dependsOn.forEach((d, j) => {
        const dep = byId.get(d);
        if (!dep) bad(["modules", i, "dependsOn", j], `undeclared module: ${d}`);
        else if (a.shared && !dep.shared) {
          bad(
            ["modules", i, "dependsOn", j],
            `shared module ${a.id} may only depend on shared modules`,
          );
        }
      });
    });

    // Cycle in dependsOn: depth-first search, report once per module on the cycle's entry.
    const state = new Map<string, 1 | 2>();
    const visit = (id: string, trail: string[]): void => {
      if (state.get(id) === 2) return;
      if (state.get(id) === 1) {
        const at = c.modules.findIndex((m) => m.id === id);
        bad(
          ["modules", at, "dependsOn"],
          `dependsOn cycle: ${[...trail.slice(trail.indexOf(id)), id].join(" -> ")}`,
        );
        return;
      }
      state.set(id, 1);
      for (const d of byId.get(id)?.dependsOn ?? []) if (byId.has(d)) visit(d, [...trail, id]);
      state.set(id, 2);
    };
    for (const m of c.modules) visit(m.id, []);
  });
export type ArchitectureContract = z.infer<typeof ArchitectureContract>;

export const ArchRule = z.enum([
  "boundary",
  "layer",
  "forbidden-package",
  "placement",
  "undeclared-module",
  "undeclared-layer",
  "unresolved-import",
]);
export type ArchRule = z.infer<typeof ArchRule>;

export const ArchViolation = z.strictObject({
  rule: ArchRule,
  path: RelPath,
  line: z.number().int().positive().optional(),
  message: text(500),
  fix: text(500),
});
export type ArchViolation = z.infer<typeof ArchViolation>;

export const MAX_VIOLATIONS = 500;

export const ArchReport = z.strictObject({
  schemaVersion: z.literal(1),
  contractPath: RelPath,
  passed: z.boolean(),
  filesScanned: z.number().int().nonnegative(),
  violations: z.array(ArchViolation).max(MAX_VIOLATIONS),
  truncated: z.boolean(),
});
export type ArchReport = z.infer<typeof ArchReport>;
