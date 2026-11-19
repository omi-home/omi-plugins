// `omi workspace init` (DevTask-0053 #166, ADR-0002 D1): builds `<name>-workspace/` next to the
// repo with `.claude/`, `.omi-plugins/` and the Coordinator's AGENTS.md from templates/workspace/,
// and clones the repo into `<workspace>/<repo>/`. Re-running never overwrites a file.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_PATH, readConfigData } from "../core/config.ts";
import { OmiError } from "../core/errors/errors.ts";
import { findWorkspace, mainCheckout, STATE_FILE } from "../core/workspace.ts";
import { openState } from "../persistence/db.ts";
import { openRuns } from "../persistence/repository.ts";
import { files } from "./init.ts";

const TEMPLATES = fileURLToPath(new URL("../../templates/workspace/", import.meta.url));

export interface WorkspaceItem {
  path: string;
  result: "created" | "kept";
}

export interface WorkspaceInitResult {
  workspace: string;
  repo: string;
  items: WorkspaceItem[];
}

/** The Coordinator session's settings in the workspace (relative to it). */
export const SETTINGS = ".claude/settings.json";
/** Absolute `autoMemoryDirectory` of the Coordinator (DevTask-0058 #180). */
export const memoryDir = (workspace: string) =>
  join(workspace, ".claude", "agent-memory", "coordinator");

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const isUrl = (s: string) => /^(?:[a-z][\w+.-]*:\/\/|git@)/i.test(s);

export function workspaceInit(o: {
  cwd: string;
  name?: string;
  repo?: string;
  /** Target workspace directory (migrate); default: found above cwd, else next to the repo. */
  workspace?: string;
}): WorkspaceInitResult {
  const here = mainCheckout(o.cwd);
  const source = o.repo === undefined ? here : isUrl(o.repo) ? o.repo : resolve(o.cwd, o.repo);
  if (!source) {
    throw new OmiError("USAGE_INVALID", "--repo <path|url> is required outside a git repository");
  }
  const repoName = basename(source.replace(/[\\/]+$/, "")).replace(/\.git$/, "");
  const name = o.name ?? repoName;
  if (!/^[\w.-]+$/.test(name) || !/^[\w.-]+$/.test(repoName)) {
    throw new OmiError("USAGE_INVALID", "workspace and repo names may use letters, digits, _ . -");
  }
  // Inside an existing workspace re-run in place; else next to the repo (or in cwd for --repo).
  const workspace =
    o.workspace ??
    findWorkspace(o.cwd) ??
    join(o.repo === undefined ? dirname(source) : resolve(o.cwd), `${name}-workspace`);
  const items: WorkspaceItem[] = [];

  const target = join(workspace, repoName);
  if (existsSync(join(target, ".git"))) {
    items.push({ path: repoName, result: "kept" });
  } else {
    if (existsSync(target) && readdirSync(target).length) {
      throw new OmiError("CONFIG_INVALID", `${target} exists and is not a git repository`);
    }
    // A clone of a local checkout must still push to GitHub, not to that checkout.
    let origin: string | undefined;
    if (!isUrl(source)) {
      try {
        origin = git(source, ["remote", "get-url", "origin"]);
      } catch {
        origin = undefined;
      }
    }
    mkdirSync(workspace, { recursive: true });
    try {
      git(workspace, ["clone", source, repoName]);
      if (origin) git(target, ["remote", "set-url", "origin", origin]);
    } catch (e) {
      throw new OmiError("CONFIG_INVALID", `could not clone the repo into ${target}`, {
        git: String((e as { stderr?: unknown }).stderr ?? (e as Error).message).trim(),
      });
    }
    items.push({ path: repoName, result: "created" });
  }

  for (const f of files(TEMPLATES)) {
    const to = join(workspace, f);
    if (existsSync(to)) {
      items.push({ path: f, result: "kept" });
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    // The Coordinator's auto memory stays in the workspace, not in ~/.claude/projects (#180).
    const body =
      f === SETTINGS
        ? `${JSON.stringify(
            {
              autoMemoryDirectory: memoryDir(workspace),
              ...JSON.parse(readFileSync(join(TEMPLATES, f), "utf8")),
            },
            null,
            2,
          )}\n`
        : readFileSync(join(TEMPLATES, f));
    writeFileSync(to, body);
    items.push({ path: f, result: "created" });
  }
  return { workspace, repo: target, items };
}

export interface MigrateResult {
  workspace: string;
  dryRun: boolean;
  /** What was (or would be) done, in order. */
  actions: string[];
  /** Old-layout paths still in the repo: the person removes them in a normal task PR. */
  remove: string[];
}

/** Files the old layout kept in the target repo (ADR-0002 D1: none belong there). */
export const OLD_LAYOUT = [".omi", "AGENTS.md", ".claude", "CLAUDE.md"];

/**
 * `omi workspace migrate` (DevTask-0056 #169): from a repo on the old layout (`.omi/config.yaml`,
 * state in the git dir, task worktrees) build `<name>-workspace/` next to it through
 * `workspace init`, then carry the config and the state over. Refused while a run is open or a
 * task worktree is left. Never deletes anything in the repo; re-running keeps what exists.
 */
export function workspaceMigrate(o: {
  cwd: string;
  name?: string;
  dryRun?: boolean;
}): MigrateResult {
  const root = mainCheckout(o.cwd);
  if (!root) throw new OmiError("USAGE_INVALID", "run workspace migrate inside the repo");
  const oldConfig = join(root, ".omi", "config.yaml");
  if (!existsSync(oldConfig)) {
    throw new OmiError("CONFIG_INVALID", "no .omi/config.yaml in the repo: nothing to migrate");
  }
  const oldState = join(
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    "omi",
    "state.sqlite",
  );
  if (existsSync(oldState)) {
    const db = openState(oldState);
    try {
      const open = openRuns(db);
      if (open.length) {
        throw new OmiError(
          "POLICY_VIOLATION",
          `finish or finalize the open runs first: ${open.map((r) => `#${r.issue} (${r.state})`).join(", ")}`,
        );
      }
    } finally {
      db.close();
    }
  }
  const worktrees = git(root, ["worktree", "list", "--porcelain"])
    .split(/\r?\n/)
    .filter((l) => l.startsWith("worktree "))
    .slice(1);
  if (worktrees.length) {
    throw new OmiError(
      "POLICY_VIOLATION",
      `clean up the task worktrees first: ${worktrees.map((l) => l.slice(9)).join(", ")}`,
    );
  }

  const name = o.name ?? basename(root);
  const workspace = join(dirname(root), `${name}-workspace`);
  const newConfig = join(workspace, CONFIG_PATH);
  const newState = join(workspace, STATE_FILE);
  const remove = OLD_LAYOUT.filter((f) => existsSync(join(root, f)));
  const configured = existsSync(newConfig) && readConfigData(workspace) !== null;
  const actions = [
    `workspace init ${workspace} (clone of ${root})`,
    configured ? `keep ${newConfig}` : `copy .omi/config.yaml → ${newConfig}`,
    existsSync(newState) || !existsSync(oldState)
      ? `keep state (${existsSync(newState) ? newState : "no old state"})`
      : `copy ${oldState} → ${newState}`,
  ];
  if (o.dryRun) return { workspace, dryRun: true, actions, remove };

  workspaceInit({ cwd: root, repo: root, name, workspace });
  if (!configured) writeFileSync(newConfig, readFileSync(oldConfig));
  if (!existsSync(newState) && existsSync(oldState)) {
    // A consistent copy, WAL included, without touching the old file.
    const db = openState(oldState);
    try {
      db.prepare("VACUUM INTO ?").run(newState);
    } finally {
      db.close();
    }
  }
  return { workspace, dryRun: false, actions, remove };
}
