// Shared by `cleanup scan`, `status` and `watch` (DevTask-0086 #264): is the omi process that
// opened an attempt still alive? Pure apart from the injected `kill` probe (default process.kill).

export type AttemptLiveness = "running" | "crashed" | "unknown";

export type PidProbe = (pid: number, signal: 0) => unknown;

/** True/false = process exists / is gone; null = cannot tell. */
export function pidAlive(pid: number, kill: PidProbe = process.kill): boolean | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return false;
    // EPERM: the process exists but belongs to someone else (Linux and Windows alike).
    if (code === "EPERM") return true;
    return null;
  }
}

/**
 * An open attempt whose PID is dead is `crashed`; no PID (attempt from before the column) or an
 * unreadable probe is `unknown`, never reported as crashed. A finished attempt is not judged.
 */
export function attemptLiveness(
  a: { pid: number | null; finishedAt?: string | null },
  kill: PidProbe = process.kill,
): AttemptLiveness {
  if (a.finishedAt) return "running";
  if (a.pid === null) return "unknown";
  const alive = pidAlive(a.pid, kill);
  return alive === null ? "unknown" : alive ? "running" : "crashed";
}

export const CRASHED_HINT = "omi cleanup apply --safe";
