// `omi arch check` / `omi arch show` (Feature-0043 #321): read the contract, scan the source roots
// and tests, apply the pure rules. Deterministic, no child process, no network.
import { lstatSync, readFileSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { parseContract } from "../../core/contracts.ts";
import { OmiError } from "../../core/errors/errors.ts";
import { scanImports } from "../adapters/imports.ts";
import { isRegularFile, scanTree } from "../adapters/scan.ts";
import {
  ArchitectureContract,
  ArchitectureExcerpt,
  type ArchReport,
  RelPath,
} from "../domain/contract.ts";
import { matchAny } from "../domain/glob.ts";
import {
  buildReport,
  checkArchitecture,
  formatViolation,
  type ImportRef,
} from "../domain/rules.ts";

export const DEFAULT_CONTRACT = "omi-architecture.yaml";
const MAX_CONTRACT_BYTES = 1_000_000;
const MAX_SOURCE_BYTES = 2_000_000;
const TESTS_ROOT = "tests";

export interface ArchOptions {
  cwd: string;
  /** Repo root, relative to cwd or absolute (default: cwd). */
  repo?: string;
  /** Contract file relative to the repo root (default omi-architecture.yaml). */
  contract?: string;
}

function repoDir(o: ArchOptions): string {
  const dir = o.repo ? resolve(o.cwd, o.repo) : resolve(o.cwd);
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new OmiError("USAGE_INVALID", `--repo is not a directory: ${o.repo ?? "."}`);
  }
  return dir;
}

function contractPath(o: ArchOptions): string {
  const p = o.contract ?? DEFAULT_CONTRACT;
  if (!RelPath.safeParse(p).success || isAbsolute(p)) {
    throw new OmiError("USAGE_INVALID", "--contract must be a relative posix path inside the repo");
  }
  return p;
}

/** Reads and validates the contract. Missing and invalid are both CONTRACT_INVALID, told apart by message. */
export function loadContract(dir: string, rel: string): ArchitectureContract {
  const file = resolve(dir, rel);
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(file);
  } catch {
    throw new OmiError("CONTRACT_INVALID", `architecture contract not found: ${rel}`);
  }
  if (!st.isFile() || st.size > MAX_CONTRACT_BYTES) {
    throw new OmiError(
      "CONTRACT_INVALID",
      `architecture contract ${rel} must be a regular file (no symlink) under 1 MB`,
    );
  }
  let data: unknown;
  try {
    data = parse(readFileSync(file, "utf8"));
  } catch {
    throw new OmiError("CONTRACT_INVALID", `architecture contract ${rel} is not valid YAML`);
  }
  try {
    return parseContract(ArchitectureContract, data, `architecture contract ${rel}`);
  } catch (e) {
    if (e instanceof OmiError && Array.isArray((e.details as { issues?: unknown[] })?.issues)) {
      const issues = (e.details as { issues: { path: string; message: string }[] }).issues;
      const first = issues
        .slice(0, 5)
        .map((i) => `${i.path || "(root)"}: ${i.message}`)
        .join("; ");
      throw new OmiError(e.code, `${e.message}: ${first}`, e.details);
    }
    throw e;
  }
}

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

export const humanReport = (r: ArchReport): string =>
  r.passed
    ? `arch      ${r.filesScanned} file(s) checked against ${r.contractPath}: no violations\n`
    : `${r.violations.map((v) => `${formatViolation(v)}\n`).join("")}arch      ${r.violations.length} violation(s)${r.truncated ? " (truncated)" : ""}\n`;

const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export interface ShowOptions extends ArchOptions {
  scope?: string[];
}

/** The modules touching `scope` plus their dependsOn (all when scope is empty), max 30. */
export function archShow(o: ShowOptions): ArchitectureExcerpt {
  const dir = repoDir(o);
  const rel = contractPath(o);
  const scope = o.scope ?? [];
  for (const s of scope) {
    if (!RelPath.safeParse(s).success) {
      throw new OmiError("USAGE_INVALID", "--scope must be a relative posix path inside the repo");
    }
  }
  const c = loadContract(dir, rel);
  const touched = c.modules.filter((m) => !scope.length || scope.some((s) => overlaps(s, m.path)));
  const picked = new Set(touched.flatMap((m) => [m.id, ...m.dependsOn]));
  return ArchitectureExcerpt.parse({
    contractPath: rel,
    layers: c.layers,
    modules: c.modules.filter((m) => picked.has(m.id)).slice(0, 30),
    placement: c.placement,
  });
}
