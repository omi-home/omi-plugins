// Check supervisor (spec §14 stop-processes, #36 carried finding): runs one shell command and,
// on timeout, kills its whole process tree, which spawnSync alone cannot do (it only kills the
// shell). Usage: node supervise.ts <timeoutMs> <command>. Exit 124 = timed out.
import { spawn, spawnSync } from "node:child_process";
import os from "node:os";

// Not importable: running this module starts the command. checks.ts mirrors the exit code.
const TIMEOUT_EXIT = 124;

const [ms, cmd] = process.argv.slice(2);
const win = process.platform === "win32";
// POSIX: own process group, so one kill reaches every descendant.
const child = spawn(cmd as string, {
  shell: true,
  stdio: "inherit",
  detached: !win,
  windowsHide: true,
});
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (win) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } else {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      // group already gone
    }
  }
}, Number(ms));
child.on("error", () => process.exit(127));
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  if (timedOut) process.exit(TIMEOUT_EXIT);
  // Exited on a signal: report the shell convention 128+n, not a generic 1.
  const sig = signal ? (os.constants.signals[signal] ?? 0) : 0;
  process.exit(code ?? (sig ? 128 + sig : 1));
});
