// `omi doctor`: deterministic environment/repository checks (spec §15, ADR-0001 D4/D5, T0.4).
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import {
  agentEnv,
  atLeast,
  detectQuota,
  HARNESSES,
  observeRun,
  selectionEnv,
  versionRefusal,
} from "../adapters/claude/launch.ts";
import {
  ADMIN_ORG_HINT,
  hasAdminOrg,
  issueTypePlan,
  tokenScopes,
} from "../adapters/github/issue-types.ts";
import { sayIssueType } from "../adapters/github/project-fields.ts";
import { archCheck, DEFAULT_CONTRACT, loadContract } from "../architecture/cli/arch.ts";
import { formatViolation } from "../architecture/domain/rules.ts";
import { parseContext } from "../core/context-usage.ts";
import { issueTypeWrites } from "../core/issue-type-config.ts";
import {
  CONFIG_FILE,
  locate,
  PROFILES_FILE,
  STATE_FILE,
  WORKSPACE_DIR,
} from "../core/workspace.ts";
import { openRuns, ownedRefs } from "../persistence/repository.ts";
import {
  keyEnvName,
  loadProfiles,
  profileSecretResolver,
} from "../profile/adapters/profile-config.ts";
import { listProfileRecords } from "../profile/adapters/profiles.ts";
import { keyFingerprint, loadMasterKey } from "../profile/domain/secrets.ts";
import type { Selection } from "../profile/domain/selection.ts";
import { same } from "../resources/worktree.ts";
import { loadConfig, type OmiConfig, workflowModel } from "../shared/config.ts";
import type { Check } from "../shared/contracts.ts";
import { OmiError } from "../shared/errors/errors.ts";
import { type GhRunner, graphql, spawnGh } from "../shared/github/client.ts";
import { redact } from "../shared/redact.ts";
import { openState } from "../shared/sqlite/db.ts";
import { memoryDir, OLD_LAYOUT, SETTINGS } from "./workspace.ts";

export type { Check };

const MIN_NODE = "22.18.0";

function run(cmd: string, args: string[], cwd: string) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout: 30_000 });
  return { ok: r.status === 0, out: (r.stdout ?? "").trim() };
}

const semver = (s: string) => /(\d+)\.(\d+)\.(\d+)/.exec(s)?.slice(1).map(Number);

/** Claude Code inside the range the harness registry verified (#219); `omi task run` refuses others. */
export function harnessCheck(t: Check): Check {
  if (t.status === "fail") return t;
  const why = versionRefusal(t.detail);
  const { min, below } = HARNESSES.claudecode;
  return why
    ? { ...t, status: "fail", detail: why }
    : { ...t, detail: `${t.detail} (verified >=${min} <${below})` };
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
  const profiles = join(workspace, PROFILES_FILE);
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
  if (workflowModel(config) === "v2") checks.push(...issueTypeChecks(config, run));
  return checks;
}

/**
 * Model v2 (DevTask-0101 #310): the organization's native issue types match config/github/
 * issue-types.yaml, and while any is missing or different the token has `admin:org`, which
 * `omi github project apply` needs to write them.
 */
export function issueTypeChecks(config: OmiConfig, run: GhRunner = spawnGh): Check[] {
  let plan: ReturnType<typeof issueTypePlan>;
  try {
    plan = issueTypePlan(config, run);
  } catch (e) {
    return [failed("issue-types", e)];
  }
  const writes = issueTypeWrites(plan);
  const missing = plan.actions.filter((a) => a.kind === "create-issue-type");
  const checks: Check[] = [];
  if (!plan.actions.length) {
    checks.push({
      name: "issue-types",
      status: "pass",
      detail: "as in config/github/issue-types.yaml",
    });
  } else {
    const detail = `${plan.actions.map(sayIssueType).join("; ")}: run \`omi github project apply\``;
    checks.push(
      missing.length
        ? { name: "issue-types", status: "fail", code: "POLICY_VIOLATION", detail }
        : { name: "issue-types", status: "warn", detail },
    );
  }
  if (writes.length) {
    const has = hasAdminOrg(tokenScopes(run));
    checks.push(
      has === undefined
        ? {
            name: "admin-org-scope",
            status: "warn",
            detail: `cannot read the token's scopes; creating issue types needs admin:org (\`${ADMIN_ORG_HINT}\`)`,
          }
        : has
          ? { name: "admin-org-scope", status: "pass", detail: "token has admin:org" }
          : {
              name: "admin-org-scope",
              status: "fail",
              code: "GITHUB_AUTH",
              detail: `token lacks admin:org, needed to write issue types: run \`${ADMIN_ORG_HINT}\``,
            },
    );
  }
  return checks;
}

/**
 * Static checks of the machine's execution profiles (DevTask-0073 #216): the file parses and every
 * profile not `disabled` has its secret env set. A real probe is `omi doctor --probe` (#219).
 */
export function profilesCheck(workspace: string, env: NodeJS.ProcessEnv = process.env): Check[] {
  let profiles: ReturnType<typeof loadProfiles>;
  try {
    profiles = loadProfiles(workspace);
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", "profiles check crashed");
    const issues = (err.details as { issues?: { path: string; message: string }[] })?.issues;
    return [
      {
        name: "profiles",
        status: "fail",
        detail: [err.message, ...(issues ?? []).map((i) => `${i.path}: ${i.message}`)].join("; "),
      },
    ];
  }
  const active = profiles.filter((p) => !p.disabled);
  const keyEnv = keyEnvName(workspace);
  // Fingerprints the sealed tokens were written with; only the fingerprint is read, never a token.
  const sealedPrints = new Set<string>();
  const stateFile = join(workspace, STATE_FILE);
  if (existsSync(stateFile)) {
    try {
      const db = openState(stateFile);
      try {
        for (const r of listProfileRecords(db)) {
          if (r.sealed) sealedPrints.add(r.sealed.keyFingerprint);
        }
      } finally {
        db.close();
      }
    } catch {
      // an unreadable state is reported by the state check
    }
  }
  const keyCheck: Check = (() => {
    try {
      const fingerprint = keyFingerprint(loadMasterKey(env, keyEnv));
      if (sealedPrints.size && !sealedPrints.has(fingerprint)) {
        return {
          name: "master key",
          status: "fail" as const,
          detail: `wrong key: ${keyEnv} (fingerprint ${fingerprint}) did not seal the stored tokens: set the right key, or re-enter the tokens with \`omi profile set-token\``,
        };
      }
      if (sealedPrints.size > 1) {
        return {
          name: "master key",
          status: "warn" as const,
          detail: `${keyEnv} set, fingerprint ${fingerprint}; some stored tokens were sealed with another key: run \`omi secret rotate-key\` or re-enter them`,
        };
      }
      return {
        name: "master key",
        status: "pass" as const,
        detail: `${keyEnv} set, fingerprint ${fingerprint}`,
      };
    } catch (e) {
      const detail = e instanceof OmiError ? e.message : "master key check crashed";
      return {
        name: "master key",
        // Without any stored token nothing needs the key yet.
        status: active.length || sealedPrints.size ? ("fail" as const) : ("warn" as const),
        detail,
      };
    }
  })();
  if (!active.length) {
    return [
      keyCheck,
      {
        name: "profiles",
        status: "pass",
        detail: `no active profile in ${PROFILES_FILE}: steps use agents.routing`,
      },
    ];
  }
  const resolve = profileSecretResolver(workspace, env);
  return [
    keyCheck,
    ...active.flatMap((p): Check[] => [
      (() => {
        try {
          resolve(p); // decrypts: right key, untouched ciphertext; the value is never shown
          return {
            name: `profile ${p.name}`,
            status: "pass" as const,
            detail: `${p.auth.type}, token decrypts`,
          };
        } catch (e) {
          return {
            name: `profile ${p.name}`,
            status: "fail" as const,
            detail: `${e instanceof OmiError ? e.message : "token check crashed"} (or mark the profile disabled)`,
          };
        }
      })(),
      ...(p.auth.type === "gateway"
        ? [
            {
              name: `gateway ${p.name}`,
              status: "warn" as const,
              detail: [
                `${p.auth.baseUrl} is a third party: it sees the code and prompts and may alter model output (zero-width watermark, Spike-0009); OMI blocks zero-width characters`,
                ...(p.auth.scheme === "bearer" ? ["scheme bearer is not verified yet"] : []),
              ].join("; "),
            },
          ]
        : []),
    ]),
  ];
}

/** One HTTP GET: status and body (0 = no response). */
export type HttpGet = (
  url: string,
  headers: Record<string, string>,
) => { status: number; body: string };

/**
 * A synchronous GET through a child `node` (the CLI is synchronous); headers travel in the
 * child's env, never on its command line.
 */
const httpGet: HttpGet = (url, headers) => {
  const script =
    "fetch(process.env.OMI_URL,{headers:JSON.parse(process.env.OMI_HEADERS)}).then(async r=>process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}))).catch(e=>process.stdout.write(JSON.stringify({status:0,body:String(e)})))";
  const r = spawnSync(process.execPath, ["-e", script], {
    env: { ...agentEnv(process.env), OMI_URL: url, OMI_HEADERS: JSON.stringify(headers) },
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  });
  try {
    return JSON.parse(r.stdout) as { status: number; body: string };
  } catch {
    return { status: 0, body: r.stderr || "no response" };
  }
};

/** Runs `claude` with these args/env/stdin in `cwd` and returns its stream-json stdout. */
export type ClaudeRun = (o: {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
}) => string;

const claudeRun: ClaudeRun = (o) =>
  spawnSync(HARNESSES.claudecode.command, o.args, {
    cwd: o.cwd,
    env: o.env,
    input: o.stdin,
    encoding: "utf8",
    timeout: 120_000,
    windowsHide: true,
  }).stdout ?? "";

/**
 * `omi doctor --probe` (#219), spends tokens: every profile not `disabled` gets one short
 * `claude -p` run on its first model and effort, in an empty dir with a fresh config dir, checking
 * auth and the `message.model` the host saw. A gateway first lists its models with
 * `GET /v1/models` (free); a missing model or an error stops there. Details are redacted.
 */
export function probeProfiles(
  workspace: string,
  env: NodeJS.ProcessEnv = process.env,
  io: { http?: HttpGet; claude?: ClaudeRun } = {},
): Check[] {
  const checks: Check[] = [];
  const resolve = profileSecretResolver(workspace, env);
  for (const p of loadProfiles(workspace).filter((x) => !x.disabled)) {
    const name = `probe ${p.name}`;
    let secret: string | undefined;
    // A gateway may echo the key back in an error body: drop the known value, then the patterns.
    const fail = (detail: string) =>
      checks.push({
        name,
        status: "fail",
        detail: redact(secret ? detail.replaceAll(secret, "[REDACTED]") : detail),
      });
    try {
      secret = resolve(p);
    } catch (e) {
      fail(e instanceof OmiError ? e.message : "token cannot be read");
      continue;
    }
    const token = secret;
    const [model, effort] = [p.models[0] as string, p.efforts[0] as Selection["effort"]];
    if (p.auth.type === "gateway") {
      const auth: Record<string, string> =
        p.auth.scheme === "x-api-key"
          ? { "x-api-key": token }
          : { authorization: `Bearer ${token}` };
      const r = (io.http ?? httpGet)(`${p.auth.baseUrl.replace(/\/+$/, "")}/v1/models`, {
        ...auth,
        "anthropic-version": "2023-06-01",
      });
      if (r.status !== 200) {
        fail(
          `GET /v1/models → ${r.status || "no response"}${r.status === 402 ? " (out of credit)" : ""}: ${r.body.slice(0, 200)}`,
        );
        continue;
      }
      let ids: string[] = [];
      try {
        ids =
          (JSON.parse(r.body) as { data?: { id?: string }[] }).data?.map((m) => String(m.id)) ?? [];
      } catch {
        // an unreadable list is reported as missing models below
      }
      const missing = p.models.filter((m) => !ids.includes(m));
      if (missing.length) {
        fail(`gateway does not list ${missing.join(", ")}`);
        continue;
      }
    }
    const dir = mkdtempSync(join(tmpdir(), "omi-probe-"));
    try {
      const sel: Selection = {
        profile: p,
        model,
        effort,
        reason: "omi doctor --probe",
        secret: () => token,
      };
      const out = (io.claude ?? claudeRun)({
        args: [
          "-p",
          "--model",
          model,
          "--effort",
          effort,
          "--no-session-persistence",
          "--output-format",
          "stream-json",
          "--verbose",
        ],
        env: { ...selectionEnv(sel, env), CLAUDE_CONFIG_DIR: join(dir, "config") },
        cwd: dir,
        stdin: "Reply with OK only.",
      });
      const quota = detectQuota(out);
      if (quota) {
        fail(`out of quota (${quota.signal})`);
        continue;
      }
      let obs: ReturnType<typeof observeRun>;
      try {
        obs = observeRun(out);
      } catch {
        fail("claude produced no result: is it installed and in the verified range?");
        continue;
      }
      if (obs.isError) {
        fail(`run failed: ${obs.result.slice(0, 200)}`);
        continue;
      }
      if (obs.actualModel !== model) {
        fail(`asked ${model}, the host saw ${obs.actualModel}`);
        continue;
      }
      checks.push({
        name,
        status: "pass",
        detail: `auth ok, message.model ${model}, effort ${effort} ${obs.thinkingObserved ? "(thinking seen)" : "(no thinking block)"}`,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return checks.length
    ? checks
    : [{ name: "probe", status: "pass", detail: `no active profile in ${PROFILES_FILE}` }];
}

const ARCH_RUNBOOK = "docs/runbooks/architecture-contract.md";
const ARCH_SHOWN = 5;

/**
 * `architecture` (Feature-0043 #321): no contract is a warning pointing at the runbook; an invalid
 * contract or any violation fails; a contract that still lists `legacy` folders warns.
 */
export function architectureCheck(repoRoot: string, config?: OmiConfig): Check {
  const name = "architecture";
  const rel = config?.architecture?.contract ?? DEFAULT_CONTRACT;
  try {
    lstatSync(join(repoRoot, rel));
  } catch {
    return {
      name,
      status: "warn",
      detail: `no architecture contract at ${rel}: see ${ARCH_RUNBOOK} to enable it`,
    };
  }
  try {
    const contract = loadContract(repoRoot, rel);
    const report = archCheck({ cwd: repoRoot, repo: ".", contract: rel });
    if (!report.passed) {
      const first = report.violations.slice(0, ARCH_SHOWN).map(formatViolation).join("\n");
      const more = report.violations.length - ARCH_SHOWN;
      return {
        name,
        status: "fail",
        code: "ARCH_VIOLATION",
        detail: `${report.violations.length}${report.truncated ? "+" : ""} violation(s):\n${first}${more > 0 ? `\n… and ${more}${report.truncated ? "+" : ""} more: run \`omi arch check\`` : ""}`,
      };
    }
    return contract.legacy.length
      ? {
          name,
          status: "warn",
          detail: `${rel} still lists ${contract.legacy.length} legacy folder(s): move them and remove the entries`,
        }
      : {
          name,
          status: "pass",
          detail: `${report.filesScanned} file(s) checked against ${rel}`,
        };
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", "architecture check crashed");
    return {
      name,
      status: "fail",
      detail: redact(err.message),
      code: err.code,
    };
  }
}

export function doctor(cwd: string): Check[] {
  const checks: Check[] = [
    atLeast(process.versions.node, MIN_NODE)
      ? { name: "node", status: "pass", detail: process.versions.node }
      : { name: "node", status: "fail", detail: `${process.versions.node} < required ${MIN_NODE}` },
    toolVersion("git", "git", undefined, cwd),
    toolVersion("gh", "gh", undefined, cwd),
    harnessCheck(toolVersion("claude", "claude", undefined, cwd)),
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
    checks.push({ name: "model", status: "pass", detail: workflowModel(config) });
    checks.push({
      name: "setup",
      status: "pass",
      detail: config.setup
        ? `${config.setup.run} (timeout ${config.setup.timeoutSec}s)`
        : "not configured: task clones get no dependency install",
    });
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
      ...profilesCheck(loc.workspace),
      memoryDirCheck(loc.workspace),
      coordinatorPluginCheck(loc.workspace),
    );

  checks.push(architectureCheck(repoRoot, config));
  checks.push(...github(config));
  return checks;
}
