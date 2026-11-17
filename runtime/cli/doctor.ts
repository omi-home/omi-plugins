// `omi doctor`: deterministic environment/repository checks (spec §15, ADR-0001 D4/D5, T0.4).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type GhRunner, graphql, spawnGh } from "../adapters/github/client.ts";
import { loadConfig, type OmiConfig } from "../core/config.ts";
import type { Check } from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";

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
  if (!r.ok || !v) return { name, status: "fail", detail: `${cmd} not found on PATH` };
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

function workflows(): Check {
  const settings = join(
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"),
    "settings.json",
  );
  let enabled = false;
  try {
    enabled = JSON.parse(readFileSync(settings, "utf8")).enableWorkflows === true;
  } catch {
    // Missing or unreadable settings: workflows are off.
  }
  return enabled
    ? { name: "workflows", status: "pass", detail: "workflow adapter enabled" }
    : {
        name: "workflows",
        status: "warn",
        detail: "enableWorkflows is off: workflow adapter disabled, direct dispatch unaffected",
      };
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
    toolVersion("claude", "claude", MIN_CLAUDE, cwd),
    workflows(),
  ];

  const top = run("git", ["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) {
    checks.push({ name: "repository", status: "fail", detail: "not inside a git repository" });
    return checks;
  }
  const repoRoot = top.out;
  checks.push({ name: "repository", status: "pass", detail: repoRoot }, instructions(repoRoot));

  let config: OmiConfig | undefined;
  try {
    config = loadConfig(repoRoot);
    checks.push({ name: "config", status: "pass", detail: ".omi/config.yaml" });
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", "config check crashed");
    const issues = (err.details as { issues?: { path: string; message: string }[] })?.issues;
    checks.push({
      name: "config",
      status: "fail",
      detail: [err.message, ...(issues ?? []).map((i) => `${i.path}: ${i.message}`)].join("; "),
    });
  }

  checks.push(...github(config));
  return checks;
}
