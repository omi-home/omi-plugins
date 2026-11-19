// `omi doctor`: deterministic environment/repository checks (spec §15, ADR-0001 D4/D5, T0.4).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { type GhRunner, graphql, spawnGh } from "../adapters/github/client.ts";
import { loadConfig, type OmiConfig } from "../core/config.ts";
import { parseContext } from "../core/context-usage.ts";
import type { Check } from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";
import { CONFIG_FILE, locate, STATE_FILE, WORKSPACE_DIR } from "../core/workspace.ts";
import { openState } from "../persistence/db.ts";
import { openRuns, ownedRefs } from "../persistence/repository.ts";
import { same } from "../resources/worktree.ts";
import { memoryDir, OLD_LAYOUT, SETTINGS } from "./workspace.ts";

export type { Check };

const MIN_NODE = "22.18.0";
/** First Claude Code release that reads AGENTS.md natively (T0.4). */
const MIN_CLAUDE = "2.1.277";

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

const semver = (s: string) => /(\d+)\.(\d+)\.(\d+)/.exec(s)?.slice(1).map(Number);

export function atLeast(version: string, min: string): boolean {
  const [a, b] = [semver(version), semver(min)];
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return (a[i] as number) > (b[i] as number);
  }
  return true;
}

function toolVersion(name: string, cmd: string, min: string | undefined, cwd: string): Check {
  const r = run(cmd, ["--version"], cwd);
  const v = semver(r.out)?.join(".");
  if (!r.ok || !v) {
    // Node spawns no .cmd/.ps1 without a shell (an npm-installed CLI on Windows): OMI cannot run it.
    const shim =
      process.platform === "win32" &&
      run("where.exe", [cmd], cwd)
        .out.split(/\r?\n/)
        .find((f) => /\.(cmd|bat|ps1)$/i.test(f));
    return {
      name,
      status: "fail",
      detail: shim
        ? `only a script shim is on PATH (${shim}): OMI needs a native ${cmd}.exe`
        : `${cmd} not found on PATH`,
    };
  }
  if (min && !atLeast(v, min)) return { name, status: "fail", detail: `${v} < required ${min}` };
  return { name, status: "pass", detail: v };
}

/** CLAUDE.md files at or above the repo root silently disable AGENTS.md (T0.4). */
function instructions(repoRoot: string): Check {
  const shadows: string[] = [];
  for (let dir = repoRoot; ; dir = dirname(dir)) {
    for (const f of ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) {
      if (existsSync(join(dir, f))) shadows.push(join(dir, f));
    }
    if (dirname(dir) === dir) break;
  }
  if (shadows.length) {
    return {
      name: "instructions",
      status: "warn",
      detail: `AGENTS.md is ignored while these exist: ${shadows.join(", ")}`,
    };
  }
  if (!existsSync(join(repoRoot, "AGENTS.md"))) {
    return { name: "instructions", status: "warn", detail: "no AGENTS.md at repository root" };
  }
  return { name: "instructions", status: "pass", detail: "AGENTS.md" };
}

/** `/context` lists AGENTS.md as a Project memory file when the builtin cc-plugin-agents-md loads it. */
export const agentsMdInContext = (contextText: string) =>
  /^\|\s*Project\s*\|[^|\n]*AGENTS\.md\s*\|/im.test(contextText);

/**
 * Whether Claude Code actually loads AGENTS.md here (carried CR-003 of #23): `/context` through
 * `claude -p` is a local command (no model call, no tokens). The prompt goes through stdin: a Git
 * Bash shell would rewrite a `/context` argument into a Windows path.
 */
function agentsMdLoaded(repoRoot: string): Check[] {
  const r = spawnSync("claude", ["-p"], {
    cwd: repoRoot,
    input: "/context",
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  if (r.status !== 0) {
    return [
      {
        name: "agents-md",
        status: "warn",
        detail: "could not run `claude -p /context` to verify",
      },
    ];
  }
  return [
    agentsMdInContext(r.stdout ?? "")
      ? { name: "agents-md", status: "pass", detail: "Claude Code loads AGENTS.md" }
      : {
          name: "agents-md",
          status: "warn",
          detail:
            "AGENTS.md is not in Claude Code's memory files: is builtin cc-plugin-agents-md off?",
        },
    contextSummary(r.stdout ?? ""),
  ];
}

/** Start-of-session context here (DevTask-0066 #201): a number and a pointer, never a target. */
export function contextSummary(contextText: string): Check {
  try {
    const { total } = parseContext(contextText);
    return {
      name: "context",
      status: "pass",
      detail: `${(total / 1000).toFixed(1)}k tokens at session start: \`omi context plan\` classifies them`,
    };
  } catch {
    return { name: "context", status: "warn", detail: "could not read `/context` output" };
  }
}

const inside = (dir: string, root: string) => {
  const rel = relative(root, dir);
  return !rel.startsWith("..") && !isAbsolute(rel);
};

/**
 * Workspace layout (ADR-0002 D1, DevTask-0056 #169): the repo holds no OMI file, the machine's
 * profiles never sit in the repo, and nothing is left of the old layout (state in the git dir,
 * runs on `.omi-worktrees/`).
 */
export function layout(workspace: string, repoRoot: string): Check[] {
  const checks: Check[] = [];
  const old = OLD_LAYOUT.filter((f) => existsSync(join(repoRoot, f)));
  checks.push(
    inside(workspace, repoRoot)
      ? {
          name: "layout",
          status: "warn",
          detail: `${WORKSPACE_DIR}/ is inside the repo: run \`omi workspace migrate\``,
        }
      : old.length
        ? {
            name: "layout",
            status: "warn",
            detail: `the repo still holds ${old.join(", ")}: remove them in a task PR (ADR-0002 D1)`,
          }
        : { name: "layout", status: "pass", detail: `workspace ${workspace}` },
  );

  // The OMI plugin's own repo ships an empty sample (no profile) for `workspace init`.
  const tracked = run(
    "git",
    ["ls-files", "--", "*omi.config.json", ":(exclude)templates/workspace/.omi-plugins/"],
    repoRoot,
  );
  const profiles = join(workspace, WORKSPACE_DIR, "omi.config.json");
  checks.push(
    tracked.ok && tracked.out
      ? { name: "profiles-file", status: "fail", detail: `tracked in the repo: ${tracked.out}` }
      : inside(workspace, repoRoot) && existsSync(profiles)
        ? { name: "profiles-file", status: "fail", detail: `${profiles} is inside the repo` }
        : { name: "profiles-file", status: "pass", detail: "omi.config.json outside the repo" },
  );

  const common = run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot);
  const oldState = common.ok ? join(common.out, "omi", "state.sqlite") : undefined;
  const state = join(workspace, STATE_FILE);
  let stale: string[] = [];
  if (existsSync(state)) {
    const db = openState(state);
    try {
      stale = openRuns(db)
        .filter((r) =>
          ownedRefs(db, r.id, "worktree").some((p) => /[\\/]\.omi-worktrees[\\/]/.test(p)),
        )
        .map((r) => `#${r.issue}`);
    } finally {
      db.close();
    }
  }
  checks.push(
    stale.length
      ? {
          name: "legacy-runs",
          status: "warn",
          detail: `open runs on old .omi-worktrees/: ${stale.join(", ")} (finalize them with the previous OMI)`,
        }
      : oldState && existsSync(oldState)
        ? {
            name: "legacy-runs",
            status: "warn",
            detail: `old state ${oldState} is no longer read: run \`omi workspace migrate\` or remove it`,
          }
        : { name: "legacy-runs", status: "pass", detail: "no old-layout state or runs" },
  );
  return checks;
}

/** Claude Code loads only the first 200 lines / 25KB of MEMORY.md: warn with a margin (#180). */
const MEMORY_MAX_LINES = 150;
const MEMORY_MAX_BYTES = 15 * 1024;

/**
 * `memory-dir` (DevTask-0058 #180): the Coordinator's auto memory lives in the workspace, set by
 * `autoMemoryDirectory` in its `.claude/settings.json`, and its MEMORY.md index stays loadable.
 */
export function memoryDirCheck(workspace: string): Check {
  let dir: unknown;
  try {
    dir = JSON.parse(readFileSync(join(workspace, SETTINGS), "utf8")).autoMemoryDirectory;
  } catch {
    // Missing or unreadable settings: not set.
  }
  if (typeof dir !== "string" || !isAbsolute(dir) || !inside(resolve(dir), workspace)) {
    return {
      name: "memory-dir",
      status: "warn",
      detail: `set "autoMemoryDirectory": ${JSON.stringify(memoryDir(workspace))} in ${join(workspace, SETTINGS)}`,
    };
  }
  let index = "";
  try {
    index = readFileSync(join(dir, "MEMORY.md"), "utf8");
  } catch {
    // No memory yet.
  }
  const lines = index ? index.replace(/\r?\n$/, "").split(/\r?\n/).length : 0;
  const bytes = Buffer.byteLength(index);
  return lines > MEMORY_MAX_LINES || bytes > MEMORY_MAX_BYTES
    ? {
        name: "memory-dir",
        status: "warn",
        detail: `MEMORY.md has ${lines} lines / ${bytes} bytes (keep ≤ ${MEMORY_MAX_LINES} lines and ≤ ${MEMORY_MAX_BYTES} bytes): merge or prune memories`,
      }
    : { name: "memory-dir", status: "pass", detail: dir };
}

export const COORDINATOR = "omi-coordinator";
const OLD_PLUGIN = "omi-engineering";

/**
 * `coordinator-plugin` (Feature-0026 #187): the workspace enables `omi-coordinator@<marketplace>`
 * and Claude Code has it installed for this workspace (user scope, or project scope here); the old
 * single plugin `omi-engineering` is no longer enabled. Reads `installed_plugins.json` (version 2:
 * `{plugins: {"<name>@<marketplace>": [{scope, projectPath?}]}}`) under the Claude config dir.
 */
export function coordinatorPluginCheck(
  workspace: string,
  configDir = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
): Check {
  const json = (file: string) => {
    try {
      return JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined; // missing or unreadable: nothing enabled / installed
    }
  };
  const warn = (detail: string): Check => ({ name: "coordinator-plugin", status: "warn", detail });
  const enabled = Object.entries(json(join(workspace, SETTINGS))?.enabledPlugins ?? {})
    .filter(([, on]) => on === true)
    .map(([id]) => id);
  const old = enabled.filter((id) => id.startsWith(`${OLD_PLUGIN}@`));
  if (old.length) {
    return warn(`${old.join(", ")} is the old plugin: enable ${COORDINATOR}@omi-plugins instead`);
  }
  const id = enabled.find((x) => x.startsWith(`${COORDINATOR}@`));
  if (!id) return warn(`enable "${COORDINATOR}@omi-plugins" in ${join(workspace, SETTINGS)}`);
  const installs: { scope?: string; projectPath?: string }[] =
    json(join(configDir, "plugins", "installed_plugins.json"))?.plugins?.[id] ?? [];
  const here = installs.some(
    (i) => i.scope === "user" || (i.projectPath !== undefined && same(i.projectPath, workspace)),
  );
  return here
    ? { name: "coordinator-plugin", status: "pass", detail: id }
    : warn(`${id} is enabled but not installed: claude plugin install ${id} --scope project`);
}

const ENV_QUERY = `query($owner:String!,$repo:String!,$number:Int!){
  viewer{login}
  rateLimit{limit remaining resetAt}
  repository(owner:$owner,name:$repo){visibility viewerPermission defaultBranchRef{name}}
  repositoryOwner(login:$owner){
    ... on Organization{projectV2(number:$number){title closed}}
    ... on User{projectV2(number:$number){title closed}}
  }
}`;

const Project = z.strictObject({ title: z.string(), closed: z.boolean() }).nullable();
const EnvData = z.strictObject({
  viewer: z.strictObject({ login: z.string() }),
  rateLimit: z.strictObject({ limit: z.int(), remaining: z.int(), resetAt: z.string() }),
  repository: z
    .strictObject({
      visibility: z.enum(["PUBLIC", "PRIVATE", "INTERNAL"]),
      viewerPermission: z.enum(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]).nullable(),
      defaultBranchRef: z.strictObject({ name: z.string() }).nullable(),
    })
    .nullable(),
  repositoryOwner: z.strictObject({ projectV2: Project.optional() }).nullable(),
});

const failed = (name: string, e: unknown): Check => {
  const err = e instanceof OmiError ? e : new OmiError("INTERNAL", `${name} check crashed`);
  return { name, status: "fail", detail: err.message, code: err.code };
};

/** Auth, permissions, Project access and rate limit in one GraphQL round trip (CR-001/CR-002). */
export function github(config: OmiConfig | undefined, run: GhRunner = spawnGh): Check[] {
  if (!config) {
    try {
      const v = graphql(
        "{viewer{login}}",
        {},
        z.strictObject({ viewer: z.strictObject({ login: z.string() }) }),
        "github-auth",
        run,
      );
      return [
        { name: "github-auth", status: "pass", detail: `authenticated as ${v.viewer.login}` },
      ];
    } catch (e) {
      return [failed("github-auth", e)];
    }
  }
  const { owner, repo, projectNumber, privateRepoRiskAccepted } = config.github;
  let d: z.infer<typeof EnvData>;
  try {
    d = graphql(ENV_QUERY, { owner, repo, number: projectNumber }, EnvData, "github", run);
  } catch (e) {
    return [failed("github-auth", e)];
  }
  const checks: Check[] = [
    { name: "github-auth", status: "pass", detail: `authenticated as ${d.viewer.login}` },
    d.rateLimit.remaining < d.rateLimit.limit / 10
      ? {
          name: "github-rate-limit",
          status: "warn",
          detail: `${d.rateLimit.remaining}/${d.rateLimit.limit} left until ${d.rateLimit.resetAt}`,
        }
      : {
          name: "github-rate-limit",
          status: "pass",
          detail: `${d.rateLimit.remaining}/${d.rateLimit.limit}`,
        },
  ];
  const p = d.repositoryOwner?.projectV2;
  checks.push(
    !p
      ? {
          name: "github-project",
          status: "fail",
          code: "CONFIG_INVALID",
          detail: `${owner} Project #${projectNumber} not found or not accessible (token needs the project scope)`,
        }
      : p.closed
        ? {
            name: "github-project",
            status: "fail",
            code: "CONFIG_INVALID",
            detail: `Project #${projectNumber} "${p.title}" is closed`,
          }
        : { name: "github-project", status: "pass", detail: `#${projectNumber} ${p.title}` },
  );
  const r = d.repository;
  if (!r) {
    checks.push({
      name: "github-repo",
      status: "fail",
      code: "CONFIG_INVALID",
      detail: `cannot read ${owner}/${repo}`,
    });
    return checks;
  }
  const perm = r.viewerPermission ?? "NONE";
  const branch = r.defaultBranchRef?.name ?? "";
  const isPublic = r.visibility === "PUBLIC";
  checks.push(
    ["ADMIN", "MAINTAIN", "WRITE"].includes(perm)
      ? { name: "github-permission", status: "pass", detail: perm.toLowerCase() }
      : {
          name: "github-permission",
          status: "fail",
          code: "GITHUB_AUTH",
          detail: `${perm.toLowerCase()} on ${owner}/${repo}: write access needed for branches, comments and PRs`,
        },
    {
      name: "github-visibility",
      status: isPublic || privateRepoRiskAccepted ? "pass" : "warn",
      detail: isPublic
        ? "public: server-side branch protection available"
        : `${r.visibility.toLowerCase()}: no server-side branch protection on GitHub Free${privateRepoRiskAccepted ? " (risk accepted)" : "; set github.privateRepoRiskAccepted after PO approval"}`,
    },
    {
      name: "default-branch",
      status: branch === config.git.baseBranch ? "pass" : "warn",
      detail:
        branch === config.git.baseBranch
          ? branch
          : `default is '${branch}', expected '${config.git.baseBranch}': PRs will not close issues`,
    },
  );
  return checks;
}

export function doctor(cwd: string): Check[] {
  const checks: Check[] = [
    atLeast(process.versions.node, MIN_NODE)
      ? { name: "node", status: "pass", detail: process.versions.node }
      : { name: "node", status: "fail", detail: `${process.versions.node} < required ${MIN_NODE}` },
    toolVersion("git", "git", undefined, cwd),
    toolVersion("gh", "gh", undefined, cwd),
    toolVersion("claude", "claude", MIN_CLAUDE, cwd),
  ];

  let loc: { workspace: string; root: string } | undefined;
  let locErr: unknown;
  try {
    loc = locate(cwd);
  } catch (e) {
    locErr = e;
  }
  const top = run("git", ["rev-parse", "--show-toplevel"], cwd);
  const repoRoot = loc?.root ?? (top.ok ? top.out : undefined);
  if (!repoRoot) {
    checks.push({ name: "repository", status: "fail", detail: "not inside a git repository" });
    return checks;
  }
  // The Coordinator's AGENTS.md lives at the workspace root (ADR-0002 D1).
  const home = loc?.workspace ?? repoRoot;
  const instr = instructions(home);
  checks.push({ name: "repository", status: "pass", detail: repoRoot }, instr);
  if (instr.status === "pass") checks.push(...agentsMdLoaded(home));

  let config: OmiConfig | undefined;
  try {
    if (!loc) throw locErr;
    config = loadConfig(loc.workspace);
    checks.push({ name: "config", status: "pass", detail: join(loc.workspace, CONFIG_FILE) });
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", "config check crashed");
    const issues = (err.details as { issues?: { path: string; message: string }[] })?.issues;
    checks.push({
      name: "config",
      status: "fail",
      detail: [err.message, ...(issues ?? []).map((i) => `${i.path}: ${i.message}`)].join("; "),
    });
  }
  if (loc)
    checks.push(
      ...layout(loc.workspace, repoRoot),
      memoryDirCheck(loc.workspace),
      coordinatorPluginCheck(loc.workspace),
    );

  checks.push(...github(config));
  return checks;
}
