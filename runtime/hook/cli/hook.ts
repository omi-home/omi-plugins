// `omi hook <event>` (DevTask-0061 #194, ADR-0003 D6): the Coordinator plugin's hooks. Claude Code
// pipes the hook input JSON on stdin; `pre-tool-use` blocks with exit 2 + a reason on stderr
// (verified in Spike-0010 #185), `session-start` prints a short summary that is added to context.
// A hook must never break the session: outside an OMI workspace, on bad input or on any error
// it lets the call through (fail-open) — the CLI gates (`omi pr merge`, protection) still hold.
import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { listHandoffs } from "../../handoff/adapters/handoff.ts";
import { loadConfig } from "../../shared/config.ts";
import type { GhRunner } from "../../shared/github/client.ts";
import { locate } from "../../shared/workspace.ts";
import { status } from "../../task-run/cli/status.ts";

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

const GIT_ESCAPE_REASON = "OMI: agents run git only on paths inside their task workspace.";
/** Long git options refused in any form (`--opt=v`, `--opt v`, unambiguous abbreviations). */
const GIT_REFUSED_OPTIONS = [
  "--no-index",
  "--git-dir",
  "--work-tree",
  "--namespace",
  "--exec-path",
  "--output",
];
/** Shell expansion and redirect characters: nothing may rewrite an argument after the hook read it. */
const GIT_SHELL_CHARS = /[$`{}*?[<>]/;

/** The word `git` (also `git.exe`, `/usr/bin/git`, `\git`, any case), not `github`/`.gitignore`/`digit`. */
const GIT_WORD = /(?<![\w.-])git(?:\.exe)?(?![\w-])/i;
/** A word that changes the working directory. */
const CD_WORD =
  /(?<![\w.-])(?:cd|chdir|sl|pushd|popd|set-location|push-location|pop-location)(?![\w-])/;

const normPath = (p: string) => p.replaceAll("\\", "/").replace(/\/+$/, "");

/**
 * An argument that can leave the workspace: a `..` path component (also after `:` or `=`, as in
 * `HEAD:../x` and `--opt=../x`; a range `a..b` is one component), an absolute path (`/`, `\\`, `X:`)
 * or a leading `~`. Applies to the whole token and, for an option, to its `=value`.
 */
const argEscapes = (t: string) => {
  const eq = t.startsWith("-") ? t.indexOf("=") : -1;
  const values = eq > 0 ? [t, t.slice(eq + 1)] : [t];
  return t.split(/[\\/:=]/).includes("..") || values.some((v) => /^(?:[\\/]|[A-Za-z]:|~)/.test(v));
};

const unquote = (s: string) => s.replace(/["']/g, "");

/** A `cd`-like segment; the new directory is not followed (see agentPreToolUse). */
const isCd = (s: string) => /^(?:cd|chdir|sl|pushd|Set-Location)(?:\s|$)/i.test(s);

/** Does this `cd` segment (run in a command that also runs git) point anywhere but a plain relative path? */
function cdEscapes(seg: string, s: string, bash: boolean): boolean {
  if (GIT_SHELL_CHARS.test(seg) || (bash && seg.includes("\\"))) return true;
  const args = unquote(s).split(/\s+/).slice(1).filter(Boolean);
  const dirs = args.filter((a) => !/^-[A-Za-z]/.test(a));
  return dirs.length === 0 || dirs.some((a) => a === "-" || argEscapes(a));
}

/**
 * Token ban for one `git` segment (raw `seg`, `s` without `VAR=x` prefix). `repo` is the one
 * directory `-C` may name; unknown, any plain relative path (inside the workspace) is accepted.
 */
function gitEscapes(seg: string, s: string, bash: boolean, repo: string | undefined): boolean {
  const prefix = seg.slice(0, seg.length - s.length);
  if (/(?:^|\s)GIT_\w*=/i.test(prefix)) return true;
  if (GIT_SHELL_CHARS.test(seg) || (bash && seg.includes("\\"))) return true;
  const repoOk = (v: string) => {
    const val = normPath(v);
    return repo === undefined ? val !== "" && !argEscapes(val) : val === normPath(repo);
  };
  const tokens = unquote(s).split(/\s+/).filter(Boolean);
  let subcommand = false;
  for (let i = 1; i < tokens.length; i++) {
    const t = tokens[i] as string;
    if (!subcommand) {
      if (t === "-C") {
        const v = tokens[++i];
        if (v === undefined || !repoOk(v)) return true;
        continue;
      }
      if (t.startsWith("-")) return true; // only `-C <repo>` is a grant before the subcommand
      subcommand = true;
    } else {
      const attached = /^-[A-Za-z](.+)$/.exec(t)?.[1]; // `-O/etc/x`, `-O../x`
      if (attached !== undefined && argEscapes(attached)) return true;
    }
    const name = t.startsWith("--") ? (t.split("=")[0] as string) : "";
    if (name.length >= 3 && GIT_REFUSED_OPTIONS.some((b) => b === name || b.startsWith(name))) {
      return true;
    }
    if (argEscapes(t)) return true;
  }
  return false;
}

/**
 * Why an agent may not run this tool call, or null (ADR-0003 D6, DevTask-0064 #198): `git push`,
 * any `gh` command, git on a path outside the task workspace, and a file tool writing outside it.
 * The workspace is `CLAUDE_PROJECT_DIR` (Claude Code sets it to the agent's cwd, verified on
 * 2.1.325), else `cwd`. `repo` (env `OMI_REPO`, written to the workspace settings by the runtime)
 * is the task's repository as `git -C <repo>` names it.
 *
 * Git paths follow a TOKEN BAN, not a shell simulation (PO decision 2026-11-23, DevTask-0136 #393
 * lost four review rounds to a hand-written `cd`/subshell/glob/symlink parser). In every `git`
 * segment (also `git.exe`, after `VAR=x`) the whole command is refused when an argument has a `..`
 * path component, is absolute (`/`, `\\`, `X:`) or starts with `~`, when the segment holds a shell
 * expansion, glob or redirect character, or when it uses `--no-index`, `-c`, `--git-dir`,
 * `--work-tree`, `--namespace`, `--exec-path`, `--output`, or `-C` with anything but the task repo.
 * Without `..`, an absolute path or `~` an argument stays under the cwd, so no `cd` is followed
 * (a `cd` in a command that runs git is held to the same ban). Refs such as `origin/develop...HEAD`,
 * `HEAD~1` and `abc123:path` stay valid. No realpath/symlink logic.
 * ponytail: shell segments split on ; & | and newlines; a write through a shell redirect or an
 * interpreter is not seen (the agent env has no GitHub token, so a push cannot authenticate).
 */
export function agentPreToolUse(
  input: HookInput,
  workspace = process.env.CLAUDE_PROJECT_DIR ?? input.cwd,
  repo = process.env.OMI_REPO,
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
  const segments = (input.tool_input?.command ?? "")
    .split(/[;&|\n\r]+/)
    .map((x) => x.trim())
    .map((seg) => ({ seg, s: seg.replace(/^(?:\w+=[^\s"'`\\]*\s+)+/, "") })); // `s` without `VAR=value` prefixes
  const isGit = (s: string) => /^git(?:\.exe)?(?:\s|$)/.test(s);
  const rawCommand = input.tool_input?.command ?? "";
  // The shell removes quotes, backslashes and (PowerShell) backticks after the hook read the text,
  // so `g''it` is `git`: look for the git word in a copy without them.
  const plainText = (t: string) => t.replace(/["'`\\]/g, "");
  const hasGitWord = (t: string) => GIT_WORD.test(t) || GIT_WORD.test(plainText(t));
  const mentionsGit = hasGitWord(rawCommand);
  // PowerShell is denied by the harness allowlist; as hardening, with git in the command a
  // PowerShell segment may not hold a variable, a location method or a `::` accessor.
  const psHidden = (t: string) =>
    tool === "PowerShell" && /\$|SetLocation|PushLocation|::/i.test(t);
  // Fail closed: a git word anywhere means every segment holding it must itself be a plain
  // lowercase `git` command (no wrapper such as timeout/env/command, no then/do/else), no segment
  // may start with `(`, `{`, `!` or be a lone `}`/`)`, and the only directory change allowed is a
  // plain leading `cd <dir>` (no wrapper, popd, source/`.`/eval, CDPATH/OLDPWD).
  if (
    mentionsGit &&
    (/(?:^|[\s;&|(){}!])(?:then|do|else)(?:\s|$)/i.test(rawCommand) ||
      /CDPATH|OLDPWD/i.test(rawCommand) ||
      segments.some(({ seg, s }) => {
        if (/^[({!]/.test(seg) || seg === "}" || seg === ")") return true;
        if (psHidden(seg)) return true;
        if (hasGitWord(s) && !isGit(s)) return true;
        if (isGit(s)) return false;
        if (/^(?:builtin|command|eval|exec|source|\.)(?:\s|$)/i.test(s)) return true;
        const cds = seg.match(new RegExp(CD_WORD.source, "gi")) ?? [];
        if (cds.length === 0) return false;
        return !(cds.length === 1 && seg === s && isCd(seg));
      }))
  ) {
    const gh = segments.some(({ s }) => /^gh(?:\.exe)?(?:\s|$)/.test(s));
    if (!gh) return GIT_ESCAPE_REASON;
  }
  const bash = tool === "Bash";
  for (const { seg, s } of segments) {
    if (mentionsGit && isCd(s) && cdEscapes(seg, s, bash)) return GIT_ESCAPE_REASON;
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
    if (isGit(s) && gitEscapes(seg, s, bash, repo)) return GIT_ESCAPE_REASON;
  }
  return null;
}

/** Short context for a new, resumed or compacted Coordinator session; never throws. */
export function sessionStart(
  input: HookInput,
  deps: {
    cleanupScan: (o: { cwd: string; gh?: GhRunner }) => { runs: unknown[] };
    gh?: GhRunner;
  },
): string {
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
    const h = listHandoffs(loadConfig(workspace), deps.gh)[0];
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
    const r = status({
      cwd: workspace,
      milestone,
      cleanupScan: deps.cleanupScan,
      ...(deps.gh ? { gh: deps.gh } : {}),
    });
    const counts = Object.entries(r.byStatus).map(([k, v]) => `${k} ${v.length}`);
    out.push(`Milestone #${r.milestone.number} ${r.milestone.title}: ${counts.join(", ")}.`);
    const open = r.cleanup.ok ? r.cleanup.value.runs.length : 0;
    if (open) out.push(`Open local runs: ${open} (omi cleanup scan).`);
  } catch (e) {
    out.push(`Milestone status: unavailable (${(e as Error).message.slice(0, 120)}).`);
  }
  return `${out.join("\n")}\n`;
}
