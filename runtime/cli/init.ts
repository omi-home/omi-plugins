// `omi github project init` (DevTask-0031 #63): bootstrap a repository into OMI. Finds or creates
// the Project (by title), links it to the repo, writes the github section of the workspace's
// .omi-plugins/omi.config.yaml and installs the Issue
// Forms / PR template from templates/github/. Read → diff → write: re-running changes nothing and
// never overwrites a file. Fields, views, labels and protection follow with
// `github project apply` and `github repo plan/apply` (see skills/omi-start).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { locate } from "../core/workspace.ts";
import { issueTypeApply } from "../github/adapters/issue-types.ts";
import {
  findOrCreateProject,
  linkProject,
  type ProjectRef,
  projectByNumber,
} from "../github/adapters/project.ts";
import { CONFIG_PATH, loadConfig, readConfigData } from "../shared/config.ts";
import { OmiError } from "../shared/errors/errors.ts";
import { type GhRunner, spawnGh } from "../shared/github/client.ts";
import { TEMPLATES_DIR } from "../shared/plugin-paths.ts";

const TEMPLATES = join(TEMPLATES_DIR, "github");

export interface InitResult {
  root: string;
  owner: string;
  repo: string;
  project: { number: number; title: string; created: boolean };
  linked: boolean;
  config: "created" | "kept";
  templates: { copied: string[]; kept: string[] };
  /** Model v2 only: issue types written, and what is left after (needs a person). */
  issueTypes?: { applied: string[]; manual: string[] };
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
export const files = (dir: string): string[] =>
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
  const { root, workspace } = locate(o.cwd);
  // A missing file or the comment-only template from `workspace init` is not a config yet.
  const data = readConfigData(workspace);
  const hasConfig = data !== undefined && data !== null;
  const existing = hasConfig ? loadConfig(workspace).github : undefined;
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
  // Model v2: the organization's issue types first (a personal account or a missing admin:org
  // scope is refused before anything is linked or written); a second run writes nothing.
  const issueTypes =
    existing?.model === "v2" ? issueTypeApply({ github: existing }, run) : undefined;
  const linked = linkProject(owner, repo, project, run);

  if (!hasConfig) {
    const file = join(workspace, CONFIG_PATH);
    const template = existsSync(file) ? readFileSync(file, "utf8") : "";
    mkdirSync(dirname(file), { recursive: true });
    // JSON strings are valid YAML: a repo named 2048 or true stays a string.
    writeFileSync(
      file,
      `# Written by \`omi github project init\`. Add this repo's checks (lint/build/test commands)
# before \`omi task run\`; see runtime/shared/config.ts for every setting and its default.
github:
  owner: ${JSON.stringify(owner)}
  repo: ${JSON.stringify(repo)}
  projectNumber: ${project.number}
${existsSync(join(root, "package-lock.json")) ? "setup: { run: npm ci }\n" : ""}${template}`,
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
    ...(issueTypes
      ? {
          issueTypes: {
            applied: issueTypes.applied.map((a) =>
              a.kind === "create-issue-type"
                ? `create ${a.type.name}`
                : a.kind === "update-issue-type"
                  ? `update ${a.name}`
                  : a.name,
            ),
            manual: issueTypes.plan.actions.map((a) =>
              a.kind === "create-issue-type" ? `create ${a.type.name}` : a.name,
            ),
          },
        }
      : {}),
  };
}
