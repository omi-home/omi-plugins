// `omi doctor`: deterministic environment/repository checks (idea §15, ADR-0001 D4/D5, T0.4).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, type OmiConfig } from "../core/config.ts";
import type { CheckStatus } from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

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

function githubRepo(config: OmiConfig, cwd: string): Check[] {
  const { owner, repo, privateRepoRiskAccepted } = config.github;
  const r = run(
    "gh",
    ["repo", "view", `${owner}/${repo}`, "--json", "visibility,defaultBranchRef"],
    cwd,
  );
  if (!r.ok) {
    return [{ name: "github-repo", status: "fail", detail: `cannot read ${owner}/${repo}` }];
  }
  const info = JSON.parse(r.out) as { visibility: string; defaultBranchRef?: { name: string } };
  const isPublic = info.visibility === "PUBLIC";
  const branch = info.defaultBranchRef?.name ?? "";
  return [
    {
      name: "github-visibility",
      status: isPublic || privateRepoRiskAccepted ? "pass" : "warn",
      detail: isPublic
        ? "public: server-side branch protection available"
        : `${info.visibility.toLowerCase()}: no server-side branch protection on GitHub Free${privateRepoRiskAccepted ? " (risk accepted)" : "; set github.privateRepoRiskAccepted after PO approval"}`,
    },
    {
      name: "default-branch",
      status: branch === config.git.baseBranch ? "pass" : "warn",
      detail:
        branch === config.git.baseBranch
          ? branch
          : `default is '${branch}', expected '${config.git.baseBranch}': PRs will not close issues`,
    },
  ];
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

  const auth = run("gh", ["auth", "status", "--hostname", "github.com"], cwd);
  checks.push(
    auth.ok
      ? { name: "github-auth", status: "pass", detail: "gh authenticated to github.com" }
      : {
          name: "github-auth",
          status: "fail",
          detail: "gh not authenticated: run `gh auth login`",
        },
  );
  if (auth.ok && config) checks.push(...githubRepo(config, cwd));
  return checks;
}
