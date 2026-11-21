// Pure architecture rules: (files, imports, contract) → violations. No I/O: the caller injects
// `isFile` to resolve relative imports.
import {
  type ArchitectureContract,
  type ArchReport,
  type ArchViolation,
  MAX_VIOLATIONS,
} from "./contract.ts";
import { matchAny } from "./glob.ts";

type Layer = ArchitectureContract["layers"][number];
type ArchModule = ArchitectureContract["modules"][number];

export interface ImportRef {
  /** Repo-relative posix path of the importing file. */
  file: string;
  specifier: string;
  line: number;
}

export interface ArchInput {
  /** Every scanned file (source roots and tests), repo-relative posix. */
  files: readonly string[];
  imports: readonly ImportRef[];
  contract: ArchitectureContract;
  /** True when the repo-relative path is a regular file. */
  isFile: (path: string) => boolean;
}

export type Placed =
  | { kind: "ignored" }
  | { kind: "entrypoint"; mayImport: "cli" | "any" }
  | { kind: "legacy"; issue: number }
  | { kind: "module"; module: ArchModule; layer: Layer | null }
  | { kind: "test" }
  | { kind: "undeclared" };

const within = (path: string, root: string) => path === root || path.startsWith(`${root}/`);

/** Order: ignore, entrypoint, legacy, module; files outside the source roots are tests. */
export function classify(path: string, c: ArchitectureContract): Placed {
  if (matchAny(c.ignore, path)) return { kind: "ignored" };
  const ep = c.entrypoints.find((e) => e.path === path);
  if (ep) return { kind: "entrypoint", mayImport: ep.mayImport };
  if (!c.sourceRoots.some((r) => within(path, r))) return { kind: "test" };
  const legacy = c.legacy.find((l) => within(path, l.path));
  if (legacy) return { kind: "legacy", issue: legacy.issue };
  const module = c.modules.find((m) => within(path, m.path));
  if (!module) return { kind: "undeclared" };
  const rest = path.slice(module.path.length + 1);
  const dir = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : "";
  return { kind: "module", module, layer: c.layers.find((l) => l.dir === dir) ?? null };
}

/** Posix join + normalize of `dir` and a relative specifier; null when it leaves the repo. */
export function resolveRelative(fromFile: string, specifier: string): string | null {
  const out = fromFile.split("/").slice(0, -1);
  for (const seg of specifier.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") {
      if (!out.length) return null;
      out.pop();
    } else out.push(seg);
  }
  return out.join("/");
}

export const isRelativeSpecifier = (s: string) => s === "." || s === ".." || /^\.\.?\//.test(s);

function candidates(p: string, exts: readonly string[]): string[] {
  const swapped: string[] = [];
  const m = /\.(js|mjs|cjs)$/.exec(p);
  if (m) {
    const to = { js: ".ts", mjs: ".mts", cjs: ".cts" }[m[1] as "js" | "mjs" | "cjs"];
    swapped.push(p.slice(0, -m[0].length) + to);
  }
  return [p, ...swapped, ...exts.map((e) => p + e), ...exts.map((e) => `${p}/index${e}`)];
}

const pkgName = (s: string) => s.replace(/^node:/, "");
const forbids = (list: readonly string[], spec: string) =>
  list.some((f) => pkgName(spec) === pkgName(f) || pkgName(spec).startsWith(`${pkgName(f)}/`));

const cut = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** C0/C1 control characters (ANSI escapes, newlines) from source text become `?`: output stays one safe line. */
export function stripControl(s: string): string {
  let out = "";
  for (const ch of s) {
    const c = ch.codePointAt(0) as number;
    out += c < 0x20 || (c >= 0x7f && c <= 0x9f) ? "?" : ch;
  }
  return out;
}

export function checkArchitecture(input: ArchInput): ArchViolation[] {
  const { contract: c } = input;
  const out: ArchViolation[] = [];
  const add = (v: ArchViolation) =>
    out.push({
      ...v,
      path: stripControl(v.path),
      message: cut(stripControl(v.message)),
      fix: cut(stripControl(v.fix)),
    });

  for (const file of input.files) {
    const p = classify(file, c);
    if (p.kind === "ignored") continue;
    if (p.kind === "undeclared") {
      add({
        rule: "undeclared-module",
        path: file,
        message: `${file} nằm dưới sourceRoots nhưng không thuộc module, legacy hay ignore nào trong contract.`,
        fix: "Thêm module vào contract (Architect) hoặc chuyển file vào module đã khai báo.",
      });
    } else if (p.kind === "module" && !p.module.shared && !p.layer) {
      add({
        rule: "undeclared-layer",
        path: file,
        message: `${file} thuộc module ${p.module.id} nhưng không nằm trong thư mục lớp nào (${c.layers.map((l) => l.dir).join(", ")}).`,
        fix: `Chuyển file vào ${p.module.path}/<lớp>/ với lớp là một trong: ${c.layers.map((l) => l.dir).join(", ")}.`,
      });
    }
    for (const pl of c.placement) {
      if (matchAny([pl.pattern], file) && !matchAny(pl.allowedIn, file)) {
        add({
          rule: "placement",
          path: file,
          message: `${file} khớp ${pl.pattern} nhưng nằm sai chỗ. ${pl.message}`,
          fix: `Chuyển file vào một trong: ${pl.allowedIn.join(", ")}.`,
        });
      }
    }
  }

  const fileSet = new Set(input.files);
  for (const imp of input.imports) {
    const from = classify(imp.file, c);
    if (from.kind === "ignored") continue;
    if (!isRelativeSpecifier(imp.specifier)) {
      if (
        from.kind === "module" &&
        from.layer &&
        forbids(from.layer.forbidPackages, imp.specifier)
      ) {
        add({
          rule: "forbidden-package",
          path: imp.file,
          line: imp.line,
          message: `lớp ${from.layer.name} không được import package ${imp.specifier}.`,
          fix: `Bỏ import ${imp.specifier} khỏi lớp ${from.layer.name}: đưa phần phụ thuộc vào adapters và truyền qua port.`,
        });
      }
      continue;
    }
    const base = resolveRelative(imp.file, imp.specifier);
    const target =
      base === null
        ? undefined
        : candidates(base, c.stack.extensions).find((t) => fileSet.has(t) || input.isFile(t));
    if (target === undefined) {
      add({
        rule: "unresolved-import",
        path: imp.file,
        line: imp.line,
        message: `import "${imp.specifier}" ${base === null ? "ra ngoài repo" : "không resolve được tới file nào trong repo"}.`,
        fix: "Sửa đường dẫn import trỏ tới file có thật trong repo.",
      });
      continue;
    }
    const to = classify(target, c);
    if (from.kind === "entrypoint") {
      if (
        from.mayImport === "cli" &&
        to.kind === "module" &&
        !to.module.shared &&
        to.layer?.name !== "cli"
      ) {
        add({
          rule: "layer",
          path: imp.file,
          line: imp.line,
          message: `entrypoint chỉ được import lớp cli của module, không import ${to.layer?.name ?? "file ngoài lớp"} (${target}).`,
          fix: `Route lệnh qua ${to.module.path}/cli/ thay vì import trực tiếp ${target}.`,
        });
      }
      continue;
    }
    if (from.kind !== "module" || to.kind !== "module") continue;
    const m = from.module;
    const t = to.module;
    if (t.id !== m.id) {
      if (!t.shared && !m.dependsOn.includes(t.id)) {
        add({
          rule: "boundary",
          path: imp.file,
          line: imp.line,
          message: `module ${m.id} không được import module ${t.id} (${target}) vì ${t.id} không có trong dependsOn của ${m.id}.`,
          fix: `Thêm ${t.id} vào dependsOn của ${m.id} trong contract (Architect, không tạo chu trình) hoặc bỏ import và truyền phụ thuộc từ cli.`,
        });
        continue;
      }
      if (t.shared) continue;
    }
    if (
      from.layer &&
      to.layer &&
      to.layer.name !== from.layer.name &&
      !from.layer.mayImport.includes(to.layer.name)
    ) {
      add({
        rule: "layer",
        path: imp.file,
        line: imp.line,
        message: `${from.layer.name} không được import ${to.layer.name} (${target}).`,
        fix: `Đưa phụ thuộc thành port trong lớp được phép (${[from.layer.name, ...from.layer.mayImport].join(", ")}) và truyền từ cli.`,
      });
    }
  }
  return out;
}

const cmp = (a: string | number, b: string | number) => (a < b ? -1 : a > b ? 1 : 0);

export function buildReport(
  contractPath: string,
  filesScanned: number,
  violations: readonly ArchViolation[],
): ArchReport {
  const sorted = [...violations].sort(
    (a, b) =>
      cmp(a.path, b.path) ||
      cmp(a.line ?? 0, b.line ?? 0) ||
      cmp(a.rule, b.rule) ||
      cmp(a.message, b.message),
  );
  return {
    schemaVersion: 1,
    contractPath,
    passed: sorted.length === 0,
    filesScanned,
    violations: sorted.slice(0, MAX_VIOLATIONS),
    truncated: sorted.length > MAX_VIOLATIONS,
  };
}

/** `path:line [rule] message Sửa: fix` */
export const formatViolation = (v: ArchViolation): string =>
  `${v.path}${v.line ? `:${v.line}` : ""} [${v.rule}] ${v.message} Sửa: ${v.fix}`;
