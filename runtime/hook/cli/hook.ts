// `omi hook <event>` (DevTask-0061 #194, ADR-0003 D6): the Coordinator plugin's hooks. Claude Code
// pipes the hook input JSON on stdin; `pre-tool-use` blocks with exit 2 + a reason on stderr
// (verified in Spike-0010 #185), `session-start` prints a short summary that is added to context.
// A hook must never break the session: outside an OMI workspace, on bad input or on any error
// it lets the call through (fail-open) — the CLI gates (`omi pr merge`, protection) still hold.
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { status } from "../../cleanup/cli/status.ts";
import { listHandoffs } from "../../handoff/adapters/handoff.ts";
import { loadConfig } from "../../shared/config.ts";
import type { GhRunner } from "../../shared/github/client.ts";
import { locate } from "../../shared/workspace.ts";

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

const WRITE_TOOLS = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/**
 * Why an agent may not run this tool call, or null (ADR-0003 D6, DevTask-0064 #198): `git push`,
 * any `gh` command, and a file tool writing outside the task workspace. The workspace is
 * `CLAUDE_PROJECT_DIR` (Claude Code sets it to the agent's cwd, verified on 2.1.325), else `cwd`.
 * ponytail: shell segments split on ; & | and newlines; a write through a shell redirect or an
 * interpreter is not seen (the agent env has no GitHub token, so a push cannot authenticate).
 */
export function agentPreToolUse(
  input: HookInput,
  workspace = process.env.CLAUDE_PROJECT_DIR ?? input.cwd,
): string | null {
  if (!workspace) return null;
  const tool = input.tool_name ?? "";
  if (WRITE_TOOLS.includes(tool)) {
    const file = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (file && !inside(resolve(input.cwd ?? workspace, file), resolve(workspace))) {
      return `OMI: an agent writes only inside its task workspace (${workspace}).`;
    }
    return null;
  }
  if (tool !== "Bash" && tool !== "PowerShell") return null;
  for (const seg of (input.tool_input?.command ?? "").split(/[;&|\n]+/)) {
    const s = seg.trim().replace(/^(?:\w+=\S*\s+)+/, ""); // drop `VAR=x` prefixes
    if (/^gh(?:\.exe)?(?:\s|$)/.test(s)) {
      return "OMI: agents do not call GitHub (gh). Report the result; the OMI CLI posts it.";
    }
    if (/^git(?:\.exe)?(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+push\b/.test(s)) {
      return "OMI: agents never push. Commit in the clone; the OMI CLI pushes (omi pr create).";
    }
    // Check the raw segment and the segment with shell quotes/escapes removed (the shell strips
    // them, so `git diff "--output=x"` is `--output=x`).
    const unquoted = s.replace(/["'\\]/g, "");
    const refused = [s, unquoted].some((t) => {
      const head = /^git(?:\.exe)?(?:\s+-[Cc]\s+(?:"[^"]*"|'[^']*'|\S+))*\s+/.exec(t);
      return (
        head &&
        (/^difftool\b/.test(t.slice(head[0].length)) ||
          /(?:^|\s)--(?:ext-diff|extcmd|output)(?:[=\s]|$)/.test(t))
      );
    });
    if (refused) {
      return "OMI: agents run git read-only; difftool, --ext-diff, --extcmd/-x and --output are refused.";
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
