// OMI workspace (ADR-0002 D1): `<name>-workspace/{.claude/, .omi-plugins/, AGENTS.md, <repo>/}`.
// Config and state live in `.omi-plugins/`, outside the target repo.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { OmiError } from "./errors/errors.ts";

export const WORKSPACE_DIR = ".omi-plugins";
export const CONFIG_FILE = `${WORKSPACE_DIR}/omi.config.yaml`;
export const STATE_FILE = `${WORKSPACE_DIR}/state.sqlite`;

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** Nearest directory at or above `from` holding `.omi-plugins/`, or undefined. */
export function findWorkspace(from: string): string | undefined {
  for (let dir = resolve(from); ; dir = dirname(dir)) {
    if (isDir(join(dir, WORKSPACE_DIR))) return dir;
    if (dirname(dir) === dir) return undefined;
  }
}

const NO_WORKSPACE = (from: string) =>
  new OmiError(
    "CONFIG_INVALID",
    `no OMI workspace (${WORKSPACE_DIR}/) at or above ${from}: run \`omi workspace init\``,
  );

/** Main checkout of the repository containing `cwd` (also from inside a task worktree). */
export function mainCheckout(cwd: string): string | undefined {
  try {
    const common = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
    return dirname(resolve(common));
  } catch {
    return undefined;
  }
}

/**
 * Workspace and repo for `cwd`: inside the repo (or a task worktree of it) the workspace is the
 * nearest `.omi-plugins/` above the main checkout; at the workspace root the repo is its only
 * git child directory.
 */
export function locate(cwd: string): { workspace: string; root: string } {
  const root = mainCheckout(cwd);
  // Inside a task workspace clone `<workspace>-task-<runId>/<repo>/`: the workspace's own repo.
  const task = root ? /^(.+)-task-[^\\/]+$/.exec(dirname(root)) : null;
  if (root && task?.[1] && isDir(join(task[1], WORKSPACE_DIR))) {
    // (A checkout that is its own workspace, as in tests, is its own main checkout.)
    return {
      workspace: task[1],
      root: mainCheckout(task[1]) ?? join(task[1], basename(root)),
    };
  }
  if (root) {
    const workspace = findWorkspace(root);
    if (!workspace) throw NO_WORKSPACE(root);
    return { workspace, root };
  }
  const workspace = findWorkspace(cwd);
  if (!workspace) throw NO_WORKSPACE(resolve(cwd));
  const repos = readdirSync(workspace, { withFileTypes: true })
    .filter(
      (d) =>
        d.isDirectory() && !d.name.startsWith(".") && existsSync(join(workspace, d.name, ".git")),
    )
    .map((d) => join(workspace, d.name));
  if (repos.length !== 1) {
    throw new OmiError(
      "CONFIG_INVALID",
      `workspace ${workspace} must hold exactly one repo, found ${repos.length}: run omi inside the repo`,
    );
  }
  return { workspace, root: repos[0] as string };
}
