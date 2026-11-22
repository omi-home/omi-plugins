// `omi arch check` (Feature-0043 #321): read the contract, scan the source roots and tests, apply
// the pure rules. Deterministic, no child process, no network.
import { lstatSync, readFileSync } from "node:fs";
import { extname, resolve } from "node:path";
import { OmiError } from "../../shared/errors/errors.ts";
import { type ArchOptions, contractPath, loadContract, repoDir } from "../application/arch.ts";
import type { ArchReport } from "../domain/contract.ts";
import { matchAny } from "../domain/glob.ts";
import {
  buildReport,
  checkArchitecture,
  formatViolation,
  type ImportRef,
} from "../domain/rules.ts";
import { scanImports } from "./imports.ts";
import { isRegularFile, scanTree } from "./scan.ts";

const MAX_SOURCE_BYTES = 2_000_000;
const TESTS_ROOT = "tests";

export function archCheck(o: ArchOptions): ArchReport {
  const dir = repoDir(o);
  const rel = contractPath(o);
  const c = loadContract(dir, rel);

  const files = new Set<string>();
  for (const root of c.sourceRoots) {
    const r = scanTree(dir, root);
    if (r.state !== "ok") {
      throw new OmiError(
        "CONTRACT_INVALID",
        `sourceRoots entry ${root} is ${r.state.replace("-", " ")}`,
      );
    }
    for (const f of r.files) files.add(f);
  }
  for (const f of scanTree(dir, TESTS_ROOT).files) files.add(f);

  const scanned = [...files].filter((f) => !matchAny(c.ignore, f)).sort();
  const imports: ImportRef[] = [];
  if (c.stack.importParser === "ts-js") {
    for (const file of scanned) {
      if (!c.stack.extensions.includes(extname(file))) continue;
      let src: string;
      try {
        if (lstatSync(resolve(dir, file)).size > MAX_SOURCE_BYTES) continue;
        src = readFileSync(resolve(dir, file), "utf8");
      } catch {
        continue;
      }
      for (const s of scanImports(src))
        imports.push({ file, specifier: s.specifier, line: s.line });
    }
  }
  const violations = checkArchitecture({
    files: scanned,
    imports,
    contract: c,
    isFile: (p) => isRegularFile(dir, p),
  });
  return buildReport(rel, scanned.length, violations);
}

/** The failure `omi arch check` ends with: every violation as one line, the report as details. */
export function violationError(r: ArchReport): OmiError {
  return new OmiError(
    "ARCH_VIOLATION",
    `${r.violations.length}${r.truncated ? "+" : ""} architecture violation(s) in ${r.filesScanned} file(s):\n${r.violations.map(formatViolation).join("\n")}`,
    r,
  );
}
