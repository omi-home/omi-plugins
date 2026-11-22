// Task workspace manager (spec §7, ADR-0002 D2/D3): one owned branch + clone per run, cut from a
// freshly fetched origin/<base>, next to the OMI workspace, reused on repeated starts.
//
// Ownership is recorded twice: SQLite `resource_owner` (claimed BEFORE any git mutation, so a
// crash mid-setup is recoverable) and a marker in the worktree's private git dir
// (`<git-dir>/omi-owner.json`). The marker never sits in the working tree, so it needs no
// `.git/info/exclude` entry and never makes the clone dirty (T0.3/T0.8).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import { titleType } from "../github/application/hierarchy.ts";
import {
  acquireLease,
  claimResource,
  ownedRefs,
  releaseLease,
  resourceOwner,
} from "../persistence/repository.ts";
import type { OmiConfig } from "../shared/config.ts";
import { type IssueType, parseContract, SCHEMA_VERSION } from "../shared/contracts.ts";
import { type ErrorCode, OmiError } from "../shared/errors/errors.ts";
import { classify } from "../shared/github/client.ts";
import type { Db } from "../shared/sqlite/db.ts";

export const OwnerMarker = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  repository: z.string(),
  issue: z.int().positive(),
  branch: z.string(),
  baseSha: z.string().regex(/^[0-9a-f]{40}$/),
  runId: z.string(),
  createdAt: z.iso.datetime(),
});
export type OwnerMarker = z.infer<typeof OwnerMarker>;

export interface Workspace {
  path: string;
  branch: string;
  baseSha: string;
  reused: boolean;
  dirty: boolean;
}

const MARKER = "omi-owner.json";
const LEASE_MS = 120_000;

const PREFIX: Partial<Record<IssueType, string>> = {
  "documentation-task": "docs",
  "test-task": "test",
  "devops-task": "chore",
};
/** Prefix taken from the owning ancestor: tasks that fix a Bug (PO 2026-11-18, #132). */
const PARENT_PREFIX: Partial<Record<IssueType, string>> = { bug: "bugfix" };

/**
 * `<prefix>/<issue>-<slug>` (spec §7); slug is ASCII, at most 40 chars, without the title's
 * `<IssueType>-<NNNN>-` prefix (already in the issue number). `owner` is the nearest non-task
 * ancestor's type; it only changes the prefix (PARENT_PREFIX), not the run's workflow.
 */
export function branchName(
  type: IssueType,
  issue: number,
  title: string,
  owner?: IssueType,
): string {
  const slug = title
    .replace(new RegExp(`^${titleType(type)}-\\d{4}-`), "")
    .replace(/[đĐ]/g, "d") // NFKD does not decompose đ
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  const prefix = (owner && PARENT_PREFIX[owner]) ?? PREFIX[type] ?? "feature";
  return `${prefix}/${issue}${slug ? `-${slug}` : ""}`;
}

export function git(args: string[], cwd: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }).trim();
  } catch (e) {
    const err = e as { stderr?: string; code?: string };
    if (args[0] === "fetch") {
      if (/couldn't find remote ref/i.test(err.stderr ?? "")) {
        throw new OmiError(
          "CONFIG_INVALID",
          `origin has no branch ${args.at(-1)?.split(":")[0]?.replace("+refs/heads/", "")}`,
        );
      }
      throw classify({ stderr: err.stderr ?? "", error: e as Error }, "git fetch");
    }
    if (args[0] === "push") {
      // The remote's own words are the only reason a person gets (GH013 push protection, hooks,
      // rules): keep them whole. OmiError redacts the message.
      const said = (err.stderr ?? "").trim().slice(-2000) || "no output";
      const code: ErrorCode =
        /\[remote rejected\]|\[rejected\]|hook declined|GH0\d\d|protected branch/i.test(said)
          ? "POLICY_VIOLATION"
          : /Authentication failed|Permission to \S+ denied|could not read Username|terminal prompts disabled/i.test(
                said,
              )
            ? "GITHUB_AUTH"
            : classify({ stderr: said, error: e as Error }, "git push").code;
      throw new OmiError(code, `git push failed:\n${said}`);
    }
    const first = (err.stderr ?? "").trim().split(/\r?\n/)[0] ?? "";
    throw new OmiError("INTERNAL", `git ${args[0]} failed: ${first}`);
  }
}
export const tryGit = (args: string[], cwd: string) => {
  try {
    return git(args, cwd);
  } catch {
    return undefined;
  }
};

/** Canonical absolute path; case-insensitive on Windows, where git prints `E:/x` style. */
const canon = (p: string) => {
  const r = resolve(p);
  return process.platform === "win32" ? r.toLowerCase() : r;
};
export const same = (a: string, b: string) => canon(a) === canon(b);

export interface Listed {
  path: string;
  branch?: string;
  prunable: boolean;
  locked: boolean;
}

export function listWorktrees(repoRoot: string): Listed[] {
  return git(["worktree", "list", "--porcelain"], repoRoot)
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const lines = block.split(/\r?\n/);
      const val = (k: string) =>
        lines.find((l) => l === k || l.startsWith(`${k} `))?.slice(k.length + 1);
      return {
        path: resolve(val("worktree") ?? ""),
        branch: val("branch")?.replace(/^refs\/heads\//, ""),
        prunable: lines.some((l) => l === "prunable" || l.startsWith("prunable ")),
        locked: lines.some((l) => l === "locked" || l.startsWith("locked ")),
      };
    });
}

/** `<workspace>-task-<runId>/` (ADR-0002 D2): sibling of the workspace, one per run. */
export const taskWorkspaceRoot = (workspace: string, runId: string) => `${workspace}-task-${runId}`;

const markerFile = (wt: string) => {
  const gitDir = git(["rev-parse", "--git-dir"], wt);
  return join(resolve(wt, gitDir), MARKER);
};

export function readMarker(wt: string): OwnerMarker | undefined {
  const file = markerFile(wt);
  if (!existsSync(file)) return undefined;
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new OmiError("OWNERSHIP_MISMATCH", "ownership marker is not valid JSON", { path: wt });
  }
  return parseContract(OwnerMarker, data, "ownership marker");
}

/**
 * Creates or reuses the task workspace for `issue` (ADR-0002 D3): `<workspace>-task-<runId>/<repo>/`
 * is a full clone of the local repo on a new branch cut from a freshly fetched origin/<base>,
 * with `origin` pointing at GitHub. The local base branch is never touched (Spike-0009 Q7: the
 * clone starts from the fetched origin/<base> commit, not the local branch). Idempotent for the
 * same run; anything not provably ours is OWNERSHIP_MISMATCH.
 */
export function ensureTaskWorkspace(
  db: Db,
  o: {
    repoRoot: string;
    workspace: string;
    config: OmiConfig;
    issue: number;
    branch: string;
    runId: string;
  },
): Workspace {
  const { config, issue, branch, runId } = o;
  const repository = `${config.github.owner}/${config.github.repo}`;
  if (tryGit(["check-ref-format", "--branch", branch], o.repoRoot) === undefined) {
    throw new OmiError("USAGE_INVALID", `invalid branch name: ${branch}`);
  }
  if ([config.git.baseBranch, config.git.releaseBranch].includes(branch)) {
    throw new OmiError("POLICY_VIOLATION", `task work never happens on ${branch}`);
  }
  const repoRoot = realpathSync.native(o.repoRoot);
  // A resumed run keeps the clone it (or the run it adopted) already owns.
  const path =
    ownedRefs(db, runId, "worktree")[0] ??
    join(taskWorkspaceRoot(realpathSync.native(o.workspace), runId), basename(repoRoot));
  const lease = `worktree:${repository}#${issue}`;
  acquireLease(db, { key: lease, holder: runId, ttlMs: LEASE_MS });
  try {
    if (existsSync(path)) {
      return reuse(db, path, { repository, issue, branch, runId, base: config.git.baseBranch });
    }
    if (existsSync(dirname(path)) && lstatSync(dirname(path)).isSymbolicLink()) {
      throw new OmiError("OWNERSHIP_MISMATCH", "task workspace root is a symlink", {
        path: dirname(path),
      });
    }
    // Claim first: after a crash below, the next start can prove the leftovers are ours.
    claimResource(db, { runId, kind: "branch", ref: branch });
    claimResource(db, { runId, kind: "worktree", ref: path });

    const base = config.git.baseBranch;
    git(
      ["fetch", "--quiet", "origin", `+refs/heads/${base}:refs/remotes/origin/${base}`],
      repoRoot,
    );
    const baseSha = tryGit(
      ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${base}^{commit}`],
      repoRoot,
    );
    if (!baseSha) throw new OmiError("CONFIG_INVALID", `origin/${base} does not exist`);
    const origin = git(["remote", "get-url", "origin"], repoRoot);

    mkdirSync(dirname(path), { recursive: true });
    // A local clone shares (hardlinks) every object, so the fetched base commit is there.
    git(["clone", "--quiet", "--no-checkout", repoRoot, path], dirname(path));
    git(["switch", "--quiet", "--no-track", "-c", branch, baseSha], path);
    git(["remote", "set-url", "origin", origin], path);
    git(["update-ref", `refs/remotes/origin/${base}`, baseSha], path);
    // A clone (unlike a worktree) does not share the repo's local config: commit as the repo does.
    for (const key of ["user.name", "user.email"]) {
      const value = tryGit(["config", "--get", key], repoRoot);
      if (value) git(["config", key, value], path);
    }
    const marker: OwnerMarker = {
      schemaVersion: SCHEMA_VERSION,
      repository,
      issue,
      branch,
      baseSha,
      runId,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(
      markerFile(path),
      `${JSON.stringify(marker, null, 2)}
`,
    );
    return { path, branch, baseSha, reused: false, dirty: false };
  } finally {
    releaseLease(db, { key: lease, holder: runId });
  }
}

function reuse(
  db: Db,
  path: string,
  o: { repository: string; issue: number; branch: string; runId: string; base: string },
): Workspace {
  if (lstatSync(path).isSymbolicLink()) {
    throw new OmiError("OWNERSHIP_MISMATCH", "task workspace path is a symlink", { path });
  }
  const top = tryGit(["rev-parse", "--show-toplevel"], path);
  if (!top || !same(top, path)) {
    throw new OmiError("OWNERSHIP_MISMATCH", "task workspace exists but is not a clone", { path });
  }
  const on = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"], path);
  if (on !== o.branch) {
    throw new OmiError(
      "OWNERSHIP_MISMATCH",
      `task workspace is on ${on ?? "a detached HEAD"}, expected ${o.branch}`,
      { path },
    );
  }
  let marker = readMarker(path);
  if (!marker) {
    // Crash between the clone and the marker write: only adopt what SQLite says we claimed.
    if (resourceOwner(db, "worktree", path) !== o.runId) {
      throw new OmiError("OWNERSHIP_MISMATCH", "task workspace has no OMI ownership marker", {
        path,
      });
    }
    const baseSha = git(["merge-base", o.branch, `refs/remotes/origin/${o.base}`], path);
    marker = {
      schemaVersion: SCHEMA_VERSION,
      repository: o.repository,
      issue: o.issue,
      branch: o.branch,
      baseSha,
      runId: o.runId,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(
      markerFile(path),
      `${JSON.stringify(marker, null, 2)}
`,
    );
  }
  if (
    marker.repository !== o.repository ||
    marker.issue !== o.issue ||
    marker.branch !== o.branch
  ) {
    throw new OmiError("OWNERSHIP_MISMATCH", "task workspace belongs to another task", {
      path,
      owner: `${marker.repository}#${marker.issue}`,
    });
  }
  if (marker.runId !== o.runId) {
    // Same task resumed by a new run (one live run per Issue): the marker follows the owner.
    writeFileSync(
      markerFile(path),
      `${JSON.stringify({ ...marker, runId: o.runId }, null, 2)}
`,
    );
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=all"], path) !== "";
  return { path, branch: o.branch, baseSha: marker.baseSha, reused: true, dirty };
}
