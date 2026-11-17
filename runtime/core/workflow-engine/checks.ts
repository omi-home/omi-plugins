// Deterministic gate (spec §10): configured format/lint/build/test/scan commands run in the task
// worktree before each cognitive review. Full output goes to a retained log file; the result
// carries only a short, redacted tail. No LLM involved.
import { spawnSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { redact } from "../../reporting/redact.ts";
import type { OmiConfig } from "../config.ts";
import { GateCheck } from "../contracts.ts";

export type CheckOutcome = "pass" | "fail" | "timeout" | "missing-tool" | "skipped";

export interface GateResult {
  name: GateCheck;
  outcome: CheckOutcome;
  exitCode: number | null;
  durationMs: number;
  /** Last lines of output, redacted and bounded by SUMMARY_CHARS. */
  summary: string;
  /** Full output, kept for the run's evidence; null when skipped. */
  logPath: string | null;
}

export const SUMMARY_LINES = 20;
export const SUMMARY_CHARS = 2000;
const TAIL_BYTES = 16 * 1024;

/** 127: POSIX sh "command not found"; 9009: cmd.exe "is not recognized". */
const MISSING_TOOL = new Set([127, 9009]);
/** cmd.exe /c exits 1 for an unknown command; only its own message tells. */
const NOT_FOUND = /^'[^']+' is not recognized as an internal or external command/m;

function tail(file: string): string {
  const size = statSync(file).size;
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, len, size - len);
  } finally {
    closeSync(fd);
  }
  const lines = redact(buf.toString("utf8")).trimEnd().split(/\r?\n/).slice(-SUMMARY_LINES);
  const text = lines.join("\n");
  return text.length > SUMMARY_CHARS ? `…${text.slice(-(SUMMARY_CHARS - 1))}` : text;
}

/**
 * Runs every configured check in GateCheck order; a failure does not stop later checks, so the
 * Engineer gets every problem in one validation-fix round.
 * ponytail: on timeout only the shell is killed; a grandchild it spawned may outlive it until
 * the cleanup step (spec §14 stop-processes) owns process trees.
 */
export function runChecks(o: { worktree: string; checks: OmiConfig["checks"]; logDir: string }): {
  passed: boolean;
  results: GateResult[];
} {
  mkdirSync(o.logDir, { recursive: true });
  const results = GateCheck.options.map((name): GateResult => {
    const cmd = o.checks[name];
    if (!cmd) {
      return {
        name,
        outcome: "skipped",
        exitCode: null,
        durationMs: 0,
        summary: "",
        logPath: null,
      };
    }
    const logPath = join(o.logDir, `${name}.log`);
    const fd = openSync(logPath, "w");
    const started = Date.now();
    let r: ReturnType<typeof spawnSync>;
    try {
      r = spawnSync(cmd.run, {
        cwd: o.worktree,
        shell: true,
        stdio: ["ignore", fd, fd], // to disk, not memory: output size never hits maxBuffer
        timeout: cmd.timeoutSec * 1000,
        windowsHide: true,
      });
    } finally {
      closeSync(fd);
    }
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
    const summary = !timedOut && r.status === 0 ? "" : tail(logPath);
    const outcome: CheckOutcome = timedOut
      ? "timeout"
      : r.status === 0
        ? "pass"
        : (r.status !== null && MISSING_TOOL.has(r.status)) || NOT_FOUND.test(summary)
          ? "missing-tool"
          : "fail";
    return {
      name,
      outcome,
      exitCode: r.status,
      durationMs: Date.now() - started,
      summary,
      logPath,
    };
  });
  return { passed: results.every((r) => r.outcome === "pass" || r.outcome === "skipped"), results };
}
