// `omi release check|tag <n>` (DevTask-0035 #70, spec §19): the deterministic part of a release.
// check: read-only gate on the Release Issue and what `develop` would ship (versions agree,
// changelog entry, tag free and newer, Milestone work closed). tag: after the PO merged the
// release PR, tag its merge commit `<plugin>--v<version>` (Claude Code's convention, the ref users
// pin with `marketplace add owner/repo#<tag>`), push it, close the Release Issue and roll up.
import { prFacts } from "../adapters/github/merge.ts";
import { markedPrimaries } from "../adapters/github/pr.ts";
import { type FinishChange, markFinished } from "../github/adapters/project.ts";
import { labelType } from "../github/application/hierarchy.ts";
import type { Check } from "../shared/contracts.ts";
import { OmiError } from "../shared/errors/errors.ts";
import type { GhRunner } from "../shared/github/client.ts";
import { classify, spawnGh } from "../shared/github/client.ts";
import { git } from "../task-run/adapters/worktree.ts";
import { fetchTicket } from "../ticket/adapters/ticket.ts";
import { repo } from "./task.ts";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Is `a` a later version than `b`? X.Y.Z numerically; on equal cores a release beats its
 * prereleases. ponytail: prereleases compare as numeric-aware strings, not by semver identifiers.
 */
export function newer(a: string, b: string): boolean {
  const [x, y] = [SEMVER.exec(a), SEMVER.exec(b)];
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) {
    const d = Number(x[i]) - Number(y[i]);
    if (d) return d > 0;
  }
  if (!x[4] || !y[4]) return !x[4] && Boolean(y[4]);
  return x[4].localeCompare(y[4], "en", { numeric: true }) > 0;
}

export const tagName = (plugin: string, version: string) => `${plugin}--v${version}`;

/** `<plugin>--v<version>` tags on origin: tag → commit (peeled). */
function remoteTags(root: string, plugin: string): Map<string, string> {
  const out = git(["ls-remote", "--tags", "origin", `refs/tags/${plugin}--v*`], root);
  const tags = new Map<string, string>();
  for (const line of out.split("\n").filter(Boolean)) {
    const [sha, ref] = line.split("\t") as [string, string];
    const name = ref.replace(/^refs\/tags\//, "");
    // Annotated tags list twice; the peeled `^{}` line is the commit.
    if (name.endsWith("^{}")) tags.set(name.slice(0, -3), sha);
    else if (!tags.has(name)) tags.set(name, sha);
  }
  return tags;
}

function manifest(root: string, rev: string): { name: string; version: string; pkg: string } {
  const read = (path: string) => {
    try {
      return JSON.parse(git(["show", `${rev}:${path}`], root)) as Record<string, unknown>;
    } catch {
      throw new OmiError("CONFIG_INVALID", `cannot read ${path} at ${rev}`);
    }
  };
  const plugin = read(".claude-plugin/plugin.json");
  if (!PLUGIN_NAME.test(String(plugin.name ?? ""))) {
    throw new OmiError("CONFIG_INVALID", `plugin.json name at ${rev} is not a plugin name`);
  }
  return {
    name: String(plugin.name ?? ""),
    version: String(plugin.version ?? ""),
    pkg: String(read("package.json").version ?? ""),
  };
}

const versionProblem = (m: { version: string; pkg: string }) =>
  !SEMVER.test(m.version)
    ? `plugin.json version "${m.version}" is not semver X.Y.Z`
    : m.pkg !== m.version
      ? `plugin.json ${m.version} ≠ package.json ${m.pkg}`
      : undefined;

/** Highest released version among the `<plugin>--v*` tags, except `skip`. */
const latestOf = (tags: Map<string, string>, plugin: string, skip?: string) =>
  [...tags.keys()]
    .filter((t) => t !== skip)
    .map((t) => t.slice(`${plugin}--v`.length))
    .reduce<string | undefined>((a, v) => (!a || newer(v, a) ? v : a), undefined);

const pass = (name: string, detail: string): Check => ({ name, status: "pass", detail });
const fail = (name: string, detail: string): Check => ({
  name,
  status: "fail",
  code: "POLICY_VIOLATION",
  detail,
});

function releaseTicket(cwd: string, issue: number, gh: GhRunner) {
  const { root, config } = repo(cwd);
  const ticket = fetchTicket(config, issue, gh);
  if (labelType(ticket.labels.nodes) !== "release") {
    throw new OmiError("TICKET_INVALID", `#${issue} is not a Release Issue (label type:release)`);
  }
  return { root, config, ticket };
}

/**
 * `omi release check <n>`: may `develop` be released under Release Issue #n? Writes nothing on
 * GitHub or in the working tree; only fetches `develop` and `main` to read what they hold.
 */
export function releaseCheck(deps: { cwd: string; gh?: GhRunner }, issue: number): Check[] {
  const gh = deps.gh ?? spawnGh;
  const { root, config, ticket } = releaseTicket(deps.cwd, issue, gh);
  const { baseBranch: head, releaseBranch: base } = config.git;
  const checks: Check[] = [
    ticket.state === "OPEN" ? pass("state", "open") : fail("state", `#${issue} is closed`),
  ];
  git(["fetch", "--quiet", "origin", head, base], root);
  const rev = `origin/${head}`;
  const m = manifest(root, rev);
  const problem = versionProblem(m);
  checks.push(
    problem ? fail("version", problem) : pass("version", `${m.name} ${m.version} on ${rev}`),
  );
  let changelog = "";
  try {
    changelog = git(["show", `${rev}:CHANGELOG.md`], root);
  } catch {}
  const heading = `## [${m.version}]`;
  checks.push(
    changelog.split("\n").some((l) => l.startsWith(heading))
      ? pass("changelog", heading)
      : fail("changelog", `CHANGELOG.md on ${rev} has no "${heading}" section`),
  );
  const tags = remoteTags(root, m.name);
  const tag = tagName(m.name, m.version);
  const latest = latestOf(tags, m.name);
  checks.push(
    tags.has(tag)
      ? fail("tag", `${tag} already exists on origin: bump the version`)
      : latest && !newer(m.version, latest)
        ? fail("tag", `${m.version} is not newer than the latest release ${latest}`)
        : pass("tag", `${tag} free${latest ? ` (latest ${latest})` : " (first release)"}`),
  );
  // Trees, not commits: after a squash-merged release develop keeps commits main lacks.
  const tree = (r: string) => git(["rev-parse", `${r}^{tree}`], root);
  checks.push(
    tree(`origin/${base}`) === tree(rev)
      ? fail("ahead", `${head} has no change that ${base} lacks`)
      : pass("ahead", `${head} differs from ${base}`),
  );
  if (!ticket.parent) {
    checks.push(fail("milestone", `#${issue} has no parent Milestone`));
  } else {
    const parent = fetchTicket(config, ticket.parent.number, gh);
    const open = parent.subIssuesSummary.total - parent.subIssuesSummary.completed;
    // The Release Issue itself is the one open child the Milestone may still have.
    checks.push(
      labelType(parent.labels.nodes) !== "milestone"
        ? fail("milestone", `parent #${parent.number} is not a Milestone`)
        : open > (ticket.state === "OPEN" ? 1 : 0)
          ? fail("milestone", `#${parent.number} still has ${open} open sub-issue(s)`)
          : pass("milestone", `#${parent.number} work closed`),
    );
  }
  return checks;
}

export interface TagResult {
  tag: string;
  commit: string;
  pr: string;
  created: boolean;
  closed: boolean;
  changes: FinishChange[];
  held?: string;
}

/**
 * `omi release tag <n>`: after the PO merged Release Issue #n's PR (develop → main), tag the
 * merge commit, push the tag, close the Issue and roll up. Re-running changes nothing.
 */
export function releaseTag(deps: { cwd: string; gh?: GhRunner }, issue: number): TagResult {
  const gh = deps.gh ?? spawnGh;
  const { root, config, ticket } = releaseTicket(deps.cwd, issue, gh);
  const { baseBranch: head, releaseBranch: base } = config.git;
  const primary = `${config.github.owner}/${config.github.repo}#${issue}`;
  const pr = prFacts(config, { head, base, states: ["MERGED"] }, gh).prs.find(
    (p) => p.baseRefName === base && markedPrimaries(p.body).includes(primary),
  );
  if (!pr) {
    throw new OmiError("POLICY_VIOLATION", `no merged ${head} → ${base} PR for ${primary}`);
  }
  const commit = pr.mergeCommit?.oid;
  if (!commit) throw new OmiError("POLICY_VIOLATION", `${pr.url} has no merge commit`);
  git(["fetch", "--quiet", "origin", base], root);
  const m = manifest(root, commit);
  const problem = versionProblem(m);
  if (problem) throw new OmiError("CONFIG_INVALID", `${problem} at ${commit.slice(0, 12)}`);
  const tag = tagName(m.name, m.version);
  const tags = remoteTags(root, m.name);
  const existing = tags.get(tag);
  const latest = latestOf(tags, m.name, tag);
  if (!existing && latest && !newer(m.version, latest)) {
    throw new OmiError("POLICY_VIOLATION", `${m.version} is not newer than the latest ${latest}`);
  }
  if (existing && existing !== commit) {
    throw new OmiError("POLICY_VIOLATION", `${tag} already points at ${existing.slice(0, 12)}`);
  }
  if (!existing) {
    let local = "";
    try {
      local = git(["rev-parse", `refs/tags/${tag}^{commit}`], root);
    } catch {}
    if (local && local !== commit) {
      throw new OmiError("POLICY_VIOLATION", `local tag ${tag} points at ${local.slice(0, 12)}`);
    }
    if (!local) git(["tag", "-a", tag, commit, "-m", `${m.name} v${m.version}`], root);
    git(["push", "--quiet", "origin", `refs/tags/${tag}`], root);
  }
  const close = ticket.state === "OPEN";
  if (close) {
    const r = gh(["issue", "close", String(issue), "--repo", primary.split("#")[0] as string]);
    if (r.status !== 0) throw classify(r, "close release issue");
  }
  const fin = markFinished(config, issue, gh);
  return { tag, commit, pr: pr.url, created: !existing, closed: close, ...fin };
}
