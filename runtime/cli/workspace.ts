// `omi workspace init` (DevTask-0053 #166, ADR-0002 D1): builds `<name>-workspace/` next to the
// repo with `.claude/`, `.omi-plugins/` and the Coordinator's AGENTS.md from templates/workspace/,
// and clones the repo into `<workspace>/<repo>/`. Re-running never overwrites a file.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OmiError } from "../core/errors/errors.ts";
import { findWorkspace, mainCheckout } from "../core/workspace.ts";
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

const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

const isUrl = (s: string) => /^(?:[a-z][\w+.-]*:\/\/|git@)/i.test(s);

export function workspaceInit(o: {
  cwd: string;
  name?: string;
  repo?: string;
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
    writeFileSync(to, readFileSync(join(TEMPLATES, f)));
    items.push({ path: f, result: "created" });
  }
  return { workspace, repo: target, items };
}
