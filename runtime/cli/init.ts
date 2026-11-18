// `omi github project init` (DevTask-0031 #63): bootstrap a repository into OMI. Finds or creates
// the Project (by title), links it to the repo, writes .omi/config.yaml and installs the Issue
// Forms / PR template from templates/github/. Read → diff → write: re-running changes nothing and
// never overwrites a file. Fields, views, labels and protection follow with
// `github project apply` and `github repo plan/apply` (see skills/omi-start).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type GhRunner, spawnGh } from "../adapters/github/client.ts";
import {
  findOrCreateProject,
  linkProject,
  type ProjectRef,
  projectByNumber,
} from "../adapters/github/project.ts";
import { CONFIG_PATH, loadConfig } from "../core/config.ts";
import { OmiError } from "../core/errors/errors.ts";

const TEMPLATES = fileURLToPath(new URL("../../templates/github/", import.meta.url));

export interface InitResult {
  root: string;
  owner: string;
  repo: string;
  project: { number: number; title: string; created: boolean };
  linked: boolean;
  config: "created" | "kept";
  templates: { copied: string[]; kept: string[] };
}

const git = (cwd: string, ...args: string[]) => {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    throw new OmiError("CONFIG_INVALID", `git ${args.join(" ")} failed: not a GitHub checkout?`);
  }
};

/** owner/repo of the `origin` remote (https or ssh GitHub URL). */
export function originRepo(url: string): { owner: string; repo: string } {
  const m = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!m?.[1] || !m[2]) throw new OmiError("CONFIG_INVALID", "origin is not a GitHub repository");
  return { owner: m[1], repo: m[2] };
}

/** Every file under `dir`, as paths relative to it with `/` separators. */
const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => relative(dir, join(d.parentPath, d.name)).replaceAll("\\", "/"))
    .sort();

export function projectInit(
  o: { cwd: string; title?: string },
  run: GhRunner = spawnGh,
): InitResult {
  if (o.title !== undefined && !o.title.trim()) {
    throw new OmiError("USAGE_INVALID", "--title must not be empty");
  }
  const root = git(o.cwd, "rev-parse", "--show-toplevel");
  const hasConfig = existsSync(join(root, CONFIG_PATH));
  const existing = hasConfig ? loadConfig(root).github : undefined;
  const { owner, repo } = existing ?? originRepo(git(root, "remote", "get-url", "origin"));

  let project: ProjectRef & { created: boolean };
  if (existing) {
    const p = projectByNumber(owner, existing.projectNumber, run);
    if (!p) {
      throw new OmiError(
        "CONFIG_INVALID",
        `Project #${existing.projectNumber} of ${CONFIG_PATH} not found for ${owner}`,
      );
    }
    if (o.title !== undefined && o.title !== p.title) {
      throw new OmiError(
        "CONFIG_INVALID",
        `${CONFIG_PATH} already names Project #${p.number} '${p.title}', not '${o.title}'`,
      );
    }
    project = { ...p, created: false };
  } else {
    project = findOrCreateProject(owner, o.title ?? repo, run);
  }
  const linked = linkProject(owner, repo, project, run);

  if (!hasConfig) {
    mkdirSync(join(root, ".omi"), { recursive: true });
    // JSON strings are valid YAML: a repo named 2048 or true stays a string.
    writeFileSync(
      join(root, CONFIG_PATH),
      `# Written by \`omi github project init\`. Add this repo's checks (lint/build/test commands)
# before \`omi task run\`; see runtime/core/config.ts for every setting and its default.
github:
  owner: ${JSON.stringify(owner)}
  repo: ${JSON.stringify(repo)}
  projectNumber: ${project.number}
`,
    );
  }

  const templates: InitResult["templates"] = { copied: [], kept: [] };
  for (const f of files(TEMPLATES)) {
    const to = join(root, ".github", f);
    if (existsSync(to)) {
      templates.kept.push(`.github/${f}`);
      continue;
    }
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, readFileSync(join(TEMPLATES, f)));
    templates.copied.push(`.github/${f}`);
  }

  return {
    root,
    owner,
    repo,
    project: { number: project.number, title: project.title, created: project.created },
    linked,
    config: hasConfig ? "kept" : "created",
    templates,
  };
}
