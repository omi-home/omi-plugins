// `omi arch check` / `omi arch show` output (Feature-0043 #321). The logic is in application/arch.ts
// and adapters/check.ts; this is the entry point the composition root routes to.
import type { ArchReport } from "../domain/contract.ts";
import { formatViolation } from "../domain/rules.ts";

export { archCheck, violationError } from "../adapters/check.ts";
export { archShow } from "../application/arch.ts";

export const humanReport = (r: ArchReport): string =>
  r.passed
    ? `arch      ${r.filesScanned} file(s) checked against ${r.contractPath}: no violations\n`
    : `${r.violations.map((v) => `${formatViolation(v)}\n`).join("")}arch      ${r.violations.length} violation(s)${r.truncated ? " (truncated)" : ""}\n`;
