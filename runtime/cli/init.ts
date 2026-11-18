// `omi github project init` (DevTask-0031 #63): bootstrap a repository into OMI. Finds or creates
// the Project (by title), links it to the repo, writes .omi/config.yaml and installs the Issue
// Forms / PR template from templates/github/. Read → diff → write: re-running changes nothing and
// never overwrites a file. Fields, views, labels and protection follow with
// `github project apply` and `github repo plan/apply` (see skills/omi-start).
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { type GhRunner, graphql, spawnGh } from "../adapters/github/client.ts";
import { OWNER_PROJECT } from "../adapters/github/project.ts";
import { CONFIG_PATH, loadConfig } from "../core/config.ts";
import { parseContract } from "../core/contracts.ts";
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

const ghJson = <S extends z.ZodType>(run: GhRunner, args: string[], schema: S, what: string) => {
  const r = run(args);
  if (r.status !== 0) {
    throw new OmiError(
      /HTTP 40[13]|scope|auth/i.test(r.stderr) ? "GITHUB_AUTH" : "INTERNAL",
      `${what}: ${r.stderr.trim().split(/\r?\n/)[0] ?? "gh failed"}`,
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(r.stdout);
  } catch {
    throw new OmiError("INTERNAL", `${what}: gh printed no JSON`);
  }
  return parseContract(schema, body, what) as z.infer<S>;
};

const Proj = z.looseObject({ number: z.int(), title: z.string() });

const PROJECT = `query($owner:String!,$number:Int!){ ${OWNER_PROJECT("number title")} }`;
const ProjectData = z.strictObject({
  repositoryOwner: z.strictObject({ projectV2: Proj.nullable().optional() }).nullable(),
});
const LINKED = `query($owner:String!,$repo:String!){ repository(owner:$owner,name:$repo){ projectsV2(first:100){ nodes{ number } } } }`;
const Linked = z.strictObject({
  repository: z
    .strictObject({
      projectsV2: z.strictObject({ nodes: z.array(z.strictObject({ number: z.int() })) }),
    })
    .nullable(),
});

function findOrCreate(owner: string, title: string, run: GhRunner) {
  // ponytail: first 100 Projects of the owner; paginate if an owner ever has more.
  const list = ghJson(
    run,
    ["project", "list", "--owner", owner, "--format", "json", "--limit", "100"],
    z.looseObject({ projects: z.array(Proj) }),
    "list projects",
  ).projects.filter((p) => p.title === title);
  if (list.length > 1) {
    throw new OmiError(
      "CONFIG_INVALID",
      `${list.length} Projects of ${owner} are titled '${title}': set github.projectNumber in ${CONFIG_PATH}`,
    );
  }
  if (list[0]) return { number: list[0].number, title, created: false };
  const p = ghJson(
    run,
    ["project", "create", "--owner", owner, "--title", title, "--format", "json"],
    Proj,
    "create project",
  );
  return { number: p.number, title: p.title, created: true };
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
  const root = git(o.cwd, "rev-parse", "--show-toplevel");
  const hasConfig = existsSync(join(root, CONFIG_PATH));
  const existing = hasConfig ? loadConfig(root).github : undefined;
  const { owner, repo } = existing ?? originRepo(git(root, "remote", "get-url", "origin"));

  let project: InitResult["project"];
  if (existing) {
    const p = graphql(
      PROJECT,
      { owner, number: existing.projectNumber },
      ProjectData,
      "project",
      run,
    ).repositoryOwner?.projectV2;
    if (!p) {
      throw new OmiError(
        "CONFIG_INVALID",
        `Project #${existing.projectNumber} of ${CONFIG_PATH} not found for ${owner}`,
      );
    }
    project = { number: p.number, title: p.title, created: false };
  } else {
    project = findOrCreate(owner, o.title ?? repo, run);
  }

  const linked = graphql(LINKED, { owner, repo }, Linked, "linked projects", run).repository;
  if (!linked) throw new OmiError("CONFIG_INVALID", `repository ${owner}/${repo} not found`);
  const link = !linked.projectsV2.nodes.some((n) => n.number === project.number);
  if (link) {
    const r = run([
      "project",
      "link",
      String(project.number),
      "--owner",
      owner,
      "--repo",
      `${owner}/${repo}`,
    ]);
    if (r.status !== 0) {
      throw new OmiError("GITHUB_AUTH", `link project: ${r.stderr.trim().split(/\r?\n/)[0] ?? ""}`);
    }
  }

  if (!hasConfig) {
    mkdirSync(join(root, ".omi"), { recursive: true });
    writeFileSync(
      join(root, CONFIG_PATH),
      `# Written by \`omi github project init\`. Add this repo's checks (lint/build/test commands)
# before \`omi task run\`; see runtime/core/config.ts for every setting and its default.
github:
  owner: ${owner}
  repo: ${repo}
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
    project,
    linked: link,
    config: hasConfig ? "kept" : "created",
    templates,
  };
}
