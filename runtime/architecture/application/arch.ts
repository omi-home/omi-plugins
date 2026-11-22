// The contract of a repo, read and validated, and `omi arch show` (Feature-0043 #321): the library
// other modules use (the task packet's excerpt, `omi doctor`). `omi arch check` is in
// ../adapters/check.ts. Deterministic, no child process, no network.
import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parse } from "yaml";
import { parseContract } from "../../shared/contracts.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { ArchitectureContract, ArchitectureExcerpt, RelPath } from "../domain/contract.ts";
import { insideRepo } from "./repo-path.ts";

export const DEFAULT_CONTRACT = "omi-architecture.yaml";
const MAX_CONTRACT_BYTES = 1_000_000;

export interface ArchOptions {
  cwd: string;
  /** Repo root, relative to cwd or absolute (default: cwd). */
  repo?: string;
  /** Contract file relative to the repo root (default omi-architecture.yaml). */
  contract?: string;
}

export function repoDir(o: ArchOptions): string {
  const dir = o.repo ? resolve(o.cwd, o.repo) : resolve(o.cwd);
  try {
    if (!lstatSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new OmiError("USAGE_INVALID", `--repo is not a directory: ${o.repo ?? "."}`);
  }
  return dir;
}

export function contractPath(o: ArchOptions): string {
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
  if (!st.isFile() || st.size > MAX_CONTRACT_BYTES || !insideRepo(dir, rel)) {
    throw new OmiError(
      "CONTRACT_INVALID",
      `architecture contract ${rel} must be a regular file (no symlink, inside the repo) under 1 MB`,
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

const overlaps = (a: string, b: string) =>
  a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

export interface ShowOptions extends ArchOptions {
  scope?: string[];
}

export const MAX_EXCERPT_MODULES = 30;

/**
 * The modules touching `scope` plus their dependsOn (all when scope is empty), max 30. Cut order:
 * touched modules first, then their dependencies, so the cut never drops a module the scope touches.
 */
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
  const touchedIds = new Set(touched.map((m) => m.id));
  const deps = new Set(touched.flatMap((m) => m.dependsOn));
  const modules = [
    ...c.modules.filter((m) => touchedIds.has(m.id)),
    ...c.modules.filter((m) => deps.has(m.id) && !touchedIds.has(m.id)),
  ].slice(0, MAX_EXCERPT_MODULES);
  return ArchitectureExcerpt.parse({
    contractPath: rel,
    layers: c.layers,
    modules,
    placement: c.placement,
  });
}
