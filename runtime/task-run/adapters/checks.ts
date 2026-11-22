// Deterministic gate (spec §10): configured format/lint/build/test/scan commands run in the task
// worktree before each cognitive review. Full output goes to a retained log file; the result
// carries only a short, redacted tail. No LLM involved.
import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, mkdirSync, openSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OmiConfig } from "../../shared/config.ts";
import { type CheckOutcome, GateCheck } from "../../shared/contracts.ts";
import { PLUGIN_ROOT } from "../../shared/plugin-paths.ts";
import { commandEnv } from "../../shared/process/command-env.ts";
import { redact } from "../../shared/redact.ts";
import type { GateResult } from "../domain/run.ts";

export type { GateResult };

export const SUMMARY_LINES = 20;
export const SUMMARY_CHARS = 2000;
const TAIL_BYTES = 16 * 1024;

/** 127: POSIX sh "command not found"; 9009: cmd.exe "is not recognized". */
const MISSING_TOOL = new Set([127, 9009]);
const SUPERVISOR = join(PLUGIN_ROOT, "runtime", "shared", "process", "supervise.ts");
/** supervise.ts exit code after it killed the command's process tree. */
const TIMEOUT_EXIT = 124;
/** Grace for the supervisor itself on top of the check's own timeout. */
const SUPERVISOR_GRACE_MS = 15_000;

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

export interface CommandResult {
  outcome: CheckOutcome;
  exitCode: number | null;
  durationMs: number;
  /** Last lines of output (redacted); empty on pass. */
  summary: string;
}

/** Slack for a timer that fires a little early against the caller's clock. */
const TIMER_SLACK_MS = 50;

/**
 * A check timed out: spawnSync gave up, or supervise.ts exited 124 after the deadline. The duration
 * guard keeps a command that itself exits 124 (e.g. `timeout`) a plain failure; it must be measured
 * with a monotonic clock, since a wall clock stepping back once made a real timeout look like a
 * failure (#366: status 124 with Date.now() durationMs 1211 for a 2 s timeout).
 */
export function isTimeout(
  status: number | null,
  error: NodeJS.ErrnoException | undefined,
  durationMs: number,
  timeoutMs: number,
): boolean {
  return (
    error?.code === "ETIMEDOUT" ||
    (status === TIMEOUT_EXIT && durationMs >= timeoutMs - TIMER_SLACK_MS)
  );
}

/** Runs one configured command under supervise.ts, full output to `logPath`. */
export function runCommand(
  cmd: { run: string; timeoutSec: number },
  cwd: string,
  logPath: string,
  /** Env of the command; defaults to the host's without the master key and auth variables. */
  env: NodeJS.ProcessEnv = commandEnv(process.env),
): CommandResult {
  const fd = openSync(logPath, "w");
  const started = performance.now(); // monotonic: Date.now() can step back on VMs and CI runners
  let r: ReturnType<typeof spawnSync>;
  try {
    r = spawnSync(process.execPath, [SUPERVISOR, String(cmd.timeoutSec * 1000), cmd.run], {
      cwd,
      env,
      stdio: ["ignore", fd, fd], // to disk, not memory: output size never hits maxBuffer
      timeout: cmd.timeoutSec * 1000 + SUPERVISOR_GRACE_MS,
      windowsHide: true,
    });
  } finally {
    closeSync(fd);
  }
  const durationMs = Math.round(performance.now() - started);
  const timedOut = isTimeout(
    r.status,
    r.error as NodeJS.ErrnoException | undefined,
    durationMs,
    cmd.timeoutSec * 1000,
  );
  const base = !timedOut && r.status === 0 ? "" : tail(logPath);
  // Evidence for abnormal ends (signal, no exit code): the real status/signal/duration.
  const summary =
    !timedOut && r.status !== 0 && (r.status === null || r.signal)
      ? `${base}\n[supervisor status=${r.status} signal=${r.signal} durationMs=${durationMs}]`.trim()
      : base;
  const outcome: CheckOutcome = timedOut
    ? "timeout"
    : r.status === 0
      ? "pass"
      : (r.status !== null && MISSING_TOOL.has(r.status)) || NOT_FOUND.test(summary)
        ? "missing-tool"
        : "fail";
  return { outcome, exitCode: r.status, durationMs, summary };
}

const ARCH_TIMEOUT_SEC = 120;

/**
 * Built-in architecture check: when `checks.architecture` is not configured and the worktree has a
 * contract file (a symlink too, so the check reports it as invalid), run `omi arch check` on it.
 */
function architectureCommand(o: {
  worktree: string;
  architecture?: OmiConfig["architecture"];
  pluginRoot?: string;
}): { run: string; timeoutSec: number } | undefined {
  const contract = o.architecture?.contract ?? "omi-architecture.yaml";
  try {
    lstatSync(join(o.worktree, contract));
  } catch {
    return undefined;
  }
  const omi = join(o.pluginRoot ?? PLUGIN_ROOT, "bin", "omi");
  return {
    run: `node ${JSON.stringify(omi)} arch check --repo . --contract ${JSON.stringify(contract)}`,
    timeoutSec: ARCH_TIMEOUT_SEC,
  };
}

/**
 * Runs every configured check in GateCheck order; a failure does not stop later checks, so the
 * Engineer gets every problem in one validation-fix round.
 * Each command runs under supervise.ts, which kills the whole process tree on timeout
 * (taskkill /T on Windows, the process group on POSIX), so no grandchild outlives its check.
 */
export function runChecks(o: {
  worktree: string;
  checks: OmiConfig["checks"];
  /** Where the contract is; unset means omi-architecture.yaml. */
  architecture?: OmiConfig["architecture"];
  /** Plugin root holding bin/omi; default: this plugin. */
  pluginRoot?: string;
  logDir: string;
  /** Already filtered by `commandEnv`; default filters the host's env with the default key name. */
  env?: NodeJS.ProcessEnv;
}): {
  passed: boolean;
  results: GateResult[];
} {
  mkdirSync(o.logDir, { recursive: true });
  const results = GateCheck.options.map((name): GateResult => {
    const cmd = o.checks[name] ?? (name === "architecture" ? architectureCommand(o) : undefined);
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
    return { name, ...runCommand(cmd, o.worktree, logPath, o.env), logPath };
  });
  return { passed: results.every((r) => r.outcome === "pass" || r.outcome === "skipped"), results };
}
