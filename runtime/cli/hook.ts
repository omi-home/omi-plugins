// `omi hook <event>` (DevTask-0061 #194, ADR-0003 D6): the Coordinator plugin's hooks. Claude Code
// pipes the hook input JSON on stdin; `pre-tool-use` blocks with exit 2 + a reason on stderr
// (verified in Spike-0010 #185), `session-start` prints a short summary that is added to context.
// A hook must never break the session: outside an OMI workspace, on bad input or on any error
// it lets the call through (fail-open) — the CLI gates (`omi pr merge`, protection) still hold.
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import type { GhRunner } from "../adapters/github/client.ts";
import { listHandoffs } from "../adapters/github/handoff.ts";
import { loadConfig } from "../core/config.ts";
import { locate } from "../core/workspace.ts";
import { status } from "./status.ts";

export interface HookInput {
  cwd?: string;
  tool_name?: string;
  tool_input?: { file_path?: string; notebook_path?: string; command?: string };
  source?: string;
}

const inside = (file: string, dir: string) => {
  const rel = relative(dir, file);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

const branchOf = (dir: string) => {
  try {
    return execFileSync("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], {
      cwd: dir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return undefined;
  }
};

/**
 * Why the Coordinator may not run this tool call, or null. Blocks: editing a file in the main
 * repository of the workspace, `git commit` on the base or release branch, `git push` to them,
 * and `--force` on git/gh.
 * ponytail: shell segments are split on ; & | and newlines, `cd <dir>` / `git -C <dir>` are the
 * only directory changes followed; a subshell or alias can slip by (server protection remains).
 */
export function preToolUse(input: HookInput): string | null {
  const cwd = input.cwd ?? process.cwd();
  let loc: { workspace: string; root: string };
  try {
    loc = locate(cwd);
  } catch {
    return null; // not an OMI workspace: nothing to enforce
  }
  const tool = input.tool_name ?? "";
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (file && inside(resolve(cwd, file), loc.root)) {
      return `OMI: the Coordinator does not edit the main repository (${loc.root}). Run the change as a task: omi task start <n> / omi task run <n>.`;
    }
    return null;
  }
  if (tool !== "Bash" && tool !== "PowerShell") return null;
  const { git } = loadConfig(loc.workspace);
  const protectedRefs = [git.baseBranch, git.releaseBranch];
  let dir = cwd;
  for (const seg of (input.tool_input?.command ?? "").split(/[;&|\n]+/)) {
    const s = seg.trim();
    const cd = /^(?:cd|Set-Location|pushd)\s+["']?([^"'\s]+)["']?$/.exec(s);
    if (cd?.[1]) {
      dir = resolve(dir, cd[1]);
      continue;
    }
    if (!/^(?:git|gh)\b/.test(s)) continue;
    if (/\s--force(?:-with-lease|-if-includes)?\b/.test(s) || /^git\s+push\b.*\s-f\b/.test(s)) {
      return "OMI: --force is never used (git/gh). Fix the cause; history is not rewritten.";
    }
    const at = /^git\s+-C\s+["']?([^"'\s]+)["']?/.exec(s)?.[1];
    const target = at ? resolve(dir, at) : dir;
    if (/^git(?:\s+-C\s+\S+)?\s+commit\b/.test(s)) {
      const branch = branchOf(target);
      if (branch && protectedRefs.includes(branch)) {
        return `OMI: no commit on ${branch}. Work happens on a task branch in a task workspace (omi task start <n>).`;
      }
    }
    const push = /^git(?:\s+-C\s+\S+)?\s+push\b(.*)$/.exec(s)?.[1] ?? "";
    const named = push.split(/\s+/).map((w) => w.replace(/^\+/, "").split(":").at(-1));
    if (protectedRefs.some((b) => named.includes(b))) {
      return "OMI: no direct push to the base or release branch. Use omi pr create <n> and omi pr merge <n>.";
    }
  }
  return null;
}

/** Short context for a new, resumed or compacted Coordinator session; never throws. */
export function sessionStart(input: HookInput, gh?: GhRunner): string {
  const cwd = input.cwd ?? process.cwd();
  let workspace: string;
  try {
    workspace = locate(cwd).workspace;
  } catch {
    return "";
  }
  const out = ["OMI Coordinator session (summary from omi; details: /omi-resume)."];
  let milestone: number | undefined;
  try {
    const h = listHandoffs(loadConfig(workspace), gh)[0];
    if (h) {
      milestone = h.issue;
      out.push(`Latest handoff: ${h.marker} on #${h.issue} ${h.title} — ${h.url}`);
      const body = h.body.split("\n").filter((l) => l.trim() && !l.startsWith("<!--"));
      out.push(...body.slice(0, 20).map((l) => l.slice(0, 200)));
    } else out.push("Latest handoff: none found.");
  } catch (e) {
    out.push(`Latest handoff: unavailable (${(e as Error).message.slice(0, 120)}).`);
  }
  try {
    const r = status({ cwd: workspace, milestone, ...(gh ? { gh } : {}) });
    const counts = Object.entries(r.byStatus).map(([k, v]) => `${k} ${v.length}`);
    out.push(`Milestone #${r.milestone.number} ${r.milestone.title}: ${counts.join(", ")}.`);
    const open = r.cleanup.ok ? r.cleanup.value.runs.length : 0;
    if (open) out.push(`Open local runs: ${open} (omi cleanup scan).`);
  } catch (e) {
    out.push(`Milestone status: unavailable (${(e as Error).message.slice(0, 120)}).`);
  }
  return `${out.join("\n")}\n`;
}
