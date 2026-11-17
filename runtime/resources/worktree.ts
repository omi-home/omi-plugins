// Task worktree manager (spec §7): one owned branch + worktree per Issue, cut from a freshly
// fetched origin/<base>, outside the main checkout, reused on repeated starts.
//
// Ownership is recorded twice: SQLite `resource_owner` (claimed BEFORE any git mutation, so a
// crash mid-setup is recoverable) and a marker in the worktree's private git dir
// (`<git-dir>/omi-owner.json`). The marker never sits in the working tree, so it needs no
// `.git/info/exclude` entry and never blocks `git worktree remove` (T0.3/T0.8).
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { z } from "zod";
import { classify } from "../adapters/github/client.ts";
import type { OmiConfig } from "../core/config.ts";
import { type IssueType, parseContract, SCHEMA_VERSION } from "../core/contracts.ts";
import { OmiError } from "../core/errors/errors.ts";
import type { Db } from "../persistence/db.ts";
import {
  acquireLease,
  claimResource,
  releaseLease,
  resourceOwner,
} from "../persistence/repository.ts";

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
  bug: "bugfix",
  "documentation-task": "docs",
  "test-task": "test",
  "devops-task": "chore",
};

/** `<prefix>/<issue>-<slug>` (spec §7); slug is ASCII, at most 40 chars. */
export function branchName(type: IssueType, issue: number, title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .slice(0, 40)
    .replace(/^-+|-+$/g, "");
  return `${PREFIX[type] ?? "feature"}/${issue}${slug ? `-${slug}` : ""}`;
}

function git(args: string[], cwd: string): string {
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
    const first = (err.stderr ?? "").trim().split(/\r?\n/)[0] ?? "";
    throw new OmiError("INTERNAL", `git ${args[0]} failed: ${first}`);
  }
}
const tryGit = (args: string[], cwd: string) => {
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
const same = (a: string, b: string) => canon(a) === canon(b);

interface Listed {
  path: string;
  branch?: string;
  prunable: boolean;
}

function listWorktrees(repoRoot: string): Listed[] {
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
      };
    });
}

/**
 * Resolves the worktree path for an Issue: `<worktreeRoot>/<repo>/<issue>` relative to the main
 * checkout, through the real path of the nearest existing ancestor (symlinks/junctions in the
 * root are normalized), and never inside the main checkout.
 */
export function worktreePath(repoRoot: string, config: OmiConfig, issue: number): string {
  const root = realpathSync.native(repoRoot);
  const wanted = resolve(root, config.git.worktreeRoot, config.github.repo, String(issue));
  let existing = wanted;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  // The target itself must not be a link: we would operate on whatever it points at.
  if (!rest.length && lstatSync(existing).isSymbolicLink()) {
    throw new OmiError("OWNERSHIP_MISMATCH", "worktree path is a symlink", { path: wanted });
  }
  const path = rest.length
    ? join(realpathSync.native(existing), ...rest)
    : realpathSync.native(existing);
  const rel = relative(root, path);
  if (!rel || (!rel.startsWith("..") && !isAbsolute(rel))) {
    throw new OmiError("CONFIG_INVALID", "git.worktreeRoot must be outside the main checkout");
  }
  return path;
}

const markerFile = (wt: string) => {
  const gitDir = git(["rev-parse", "--git-dir"], wt);
  return join(resolve(wt, gitDir), MARKER);
};

function readMarker(wt: string): OwnerMarker | undefined {
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
 * Creates or reuses the task worktree for `issue`. Idempotent for the same run: a second start
 * returns the existing workspace with its original base SHA. Anything not provably ours
 * (foreign directory, branch checked out elsewhere, other marker) is OWNERSHIP_MISMATCH.
 */
export function ensureWorktree(
  db: Db,
  o: { repoRoot: string; config: OmiConfig; issue: number; branch: string; runId: string },
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
  const path = worktreePath(repoRoot, config, issue);
  const lease = `worktree:${repository}#${issue}`;
  acquireLease(db, { key: lease, holder: runId, ttlMs: LEASE_MS });
  try {
    const listed = listWorktrees(repoRoot);
    const here = listed.find((w) => same(w.path, path));
    const elsewhere = listed.find((w) => w.branch === branch && !same(w.path, path));
    if (elsewhere) {
      throw new OmiError(
        "OWNERSHIP_MISMATCH",
        `branch ${branch} is checked out in another worktree`,
        {
          path: elsewhere.path,
        },
      );
    }
    if (here)
      return reuse(db, here, { repository, issue, branch, runId, base: config.git.baseBranch });
    if (existsSync(path)) {
      throw new OmiError(
        "OWNERSHIP_MISMATCH",
        "worktree path exists but is not a registered worktree",
        {
          path,
        },
      );
    }

    const branchExists = tryGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`],
      repoRoot,
    );
    if (branchExists !== undefined && resourceOwner(db, "branch", branch) !== runId) {
      throw new OmiError(
        "OWNERSHIP_MISMATCH",
        `branch ${branch} already exists and is not owned by this run`,
      );
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

    mkdirSync(dirname(path), { recursive: true });
    git(
      branchExists !== undefined
        ? ["worktree", "add", path, branch]
        : ["worktree", "add", "--no-track", "-b", branch, path, baseSha],
      repoRoot,
    );
    const marker: OwnerMarker = {
      schemaVersion: SCHEMA_VERSION,
      repository,
      issue,
      branch,
      // A recovered branch keeps the commit it was cut from.
      baseSha:
        branchExists !== undefined ? git(["merge-base", branch, baseSha], repoRoot) : baseSha,
      runId,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(markerFile(path), `${JSON.stringify(marker, null, 2)}\n`);
    return { path, branch, baseSha: marker.baseSha, reused: false, dirty: false };
  } finally {
    releaseLease(db, { key: lease, holder: runId });
  }
}

function reuse(
  db: Db,
  w: Listed,
  o: { repository: string; issue: number; branch: string; runId: string; base: string },
): Workspace {
  if (w.prunable || !existsSync(w.path)) {
    throw new OmiError(
      "OWNERSHIP_MISMATCH",
      "registered worktree is missing on disk: run git worktree prune",
      {
        path: w.path,
      },
    );
  }
  if (w.branch !== o.branch) {
    throw new OmiError(
      "OWNERSHIP_MISMATCH",
      `worktree is on ${w.branch ?? "a detached HEAD"}, expected ${o.branch}`,
      {
        path: w.path,
      },
    );
  }
  let marker = readMarker(w.path);
  if (!marker) {
    // Crash between `worktree add` and the marker write: only adopt what SQLite says we claimed.
    if (resourceOwner(db, "worktree", w.path) !== o.runId) {
      throw new OmiError("OWNERSHIP_MISMATCH", "worktree has no OMI ownership marker", {
        path: w.path,
      });
    }
    const baseSha = git(["merge-base", o.branch, `refs/remotes/origin/${o.base}`], w.path);
    marker = {
      schemaVersion: SCHEMA_VERSION,
      repository: o.repository,
      issue: o.issue,
      branch: o.branch,
      baseSha,
      runId: o.runId,
      createdAt: new Date().toISOString(),
    };
    writeFileSync(markerFile(w.path), `${JSON.stringify(marker, null, 2)}\n`);
  }
  if (
    marker.repository !== o.repository ||
    marker.issue !== o.issue ||
    marker.branch !== o.branch
  ) {
    throw new OmiError("OWNERSHIP_MISMATCH", "worktree belongs to another task", {
      path: w.path,
      owner: `${marker.repository}#${marker.issue}`,
    });
  }
  if (marker.runId !== o.runId) {
    // Same task resumed by a new run (one live run per Issue): the marker follows the owner.
    writeFileSync(
      markerFile(w.path),
      `${JSON.stringify({ ...marker, runId: o.runId }, null, 2)}\n`,
    );
  }
  const dirty = git(["status", "--porcelain", "--untracked-files=all"], w.path) !== "";
  return { path: w.path, branch: o.branch, baseSha: marker.baseSha, reused: true, dirty };
}
