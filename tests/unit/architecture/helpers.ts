import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stringify } from "yaml";

export const validContract = () => ({
  schemaVersion: 1,
  stack: { languages: ["typescript"], importParser: "ts-js" },
  sourceRoots: ["src"],
  layers: [
    { name: "domain", dir: "domain", mayImport: [], forbidPackages: ["node:fs"] },
    { name: "application", dir: "application", mayImport: ["domain"] },
    { name: "adapters", dir: "adapters", mayImport: ["application", "domain"] },
    { name: "cli", dir: "cli", mayImport: ["adapters", "application", "domain"] },
  ],
  modules: [
    { id: "kernel", path: "src/kernel", description: "shared", shared: true },
    { id: "billing", path: "src/billing", description: "billing", dependsOn: ["kernel"] },
    { id: "orders", path: "src/orders", description: "orders", dependsOn: ["billing"] },
    { id: "reports", path: "src/reports", description: "reports" },
  ],
  entrypoints: [{ path: "src/main.ts", mayImport: "cli" }],
  placement: [
    {
      pattern: "**/*.test.ts",
      allowedIn: ["tests/**"],
      message: "Tests live under tests/.",
    },
  ],
  legacy: [{ path: "src/old", issue: 1, reason: "to be moved" }],
});

/** A temp repo with the given files (contract written to omi-architecture.yaml unless given). */
export function makeRepo(files: Record<string, string>, contract: unknown = validContract()) {
  const dir = mkdtempSync(join(tmpdir(), "omi-arch-"));
  const all = { "omi-architecture.yaml": stringify(contract), ...files };
  for (const [p, body] of Object.entries(all)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
