// Task clone setup (#261): the repo's optional `setup` command (e.g. `npm ci`) runs in a new task
// clone before any agent or check, so tools like biome/tsc exist. A reused clone runs it again only
// when a lockfile (or the command itself) changed since the last successful setup. No LLM involved.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { OmiConfig } from "../../shared/config.ts";
import { OmiError } from "../../shared/errors/errors.ts";
import { redact } from "../../shared/redact.ts";
import { runCommand } from "./checks.ts";

/** Files that declare the dependencies; a change in any of them invalidates the last setup. */
export const LOCKFILES = [
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
];
const STATE = "omi-setup.json";
const MAX_LOG_BYTES = 1024 * 1024;

export interface SetupResult {
  status: "skipped" | "unchanged" | "done";
  durationMs: number;
  logPath: string | null;
}

/** Hash of the setup command and every lockfile present in the clone. */
export function setupFingerprint(worktree: string, run: string): string {
  const h = createHash("sha256").update(`run:${run}\n`);
  for (const f of LOCKFILES) {
    const p = join(worktree, f);
    if (existsSync(p)) h.update(`${f}:`).update(readFileSync(p)).update("\n");
  }
  return h.digest("hex");
}

/** The state lives in the clone's private git dir, never in the working tree. */
const stateFile = (gitDir: string) => join(resolve(gitDir), STATE);

function readState(file: string): string | undefined {
  try {
    const v = (JSON.parse(readFileSync(file, "utf8")) as { fingerprint?: unknown }).fingerprint;
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `config.setup` in `worktree` unless it is unset (`skipped`) or already done for the current
 * fingerprint (`unchanged`). Failure or timeout: the redacted log is kept in `logDir` and an
 * OmiError SETUP_FAILED stops the start; nothing is recorded, so the next start retries.
 */
export function runSetup(o: {
  worktree: string;
  /** Absolute git dir of the clone (holds the state file). */
  gitDir: string;
  setup: OmiConfig["setup"];
  logDir: string;
  /** Already filtered by `commandEnv`; default filters the host's env with the default key name. */
  env?: NodeJS.ProcessEnv;
}): SetupResult {
  if (!o.setup) return { status: "skipped", durationMs: 0, logPath: null };
  const fingerprint = setupFingerprint(o.worktree, o.setup.run);
  const file = stateFile(o.gitDir);
  if (readState(file) === fingerprint) return { status: "unchanged", durationMs: 0, logPath: null };

  mkdirSync(o.logDir, { recursive: true });
  const logPath = join(o.logDir, "setup.log");
  const r = runCommand(o.setup, o.worktree, logPath, o.env);
  // Evidence is kept redacted: rewrite the raw log (bounded) before anything else reads it.
  const raw = readFileSync(logPath);
  writeFileSync(logPath, redact(raw.subarray(-MAX_LOG_BYTES).toString("utf8")));
  if (r.outcome !== "pass") {
    const why =
      r.outcome === "timeout"
        ? `timed out after ${o.setup.timeoutSec}s`
        : r.outcome === "missing-tool"
          ? "command not found"
          : `exited with code ${r.exitCode}`;
    throw new OmiError("SETUP_FAILED", `setup \`${o.setup.run}\` ${why}`, {
      outcome: r.outcome,
      exitCode: r.exitCode,
      logPath,
      summary: r.summary,
    });
  }
  writeFileSync(file, `${JSON.stringify({ fingerprint, at: new Date().toISOString() })}\n`);
  return { status: "done", durationMs: r.durationMs, logPath };
}
