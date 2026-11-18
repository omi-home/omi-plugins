// DevTask-0035 #70: `omi release check|tag` against a fake GitHub and a real local git origin.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { prBody } from "../../runtime/adapters/github/pr.ts";
import { newer, releaseCheck, releaseTag } from "../../runtime/cli/release.ts";

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** origin with main = init, develop = init + a release of plugin `p` at `version`. */
function repo(version = "0.2.0", pkg = version, changelog = `## [${version}] - 2026-11-18`) {
  const base = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-rel-")));
  git(base, "init", "-q", "--bare", "-b", "main", "origin.git");
  git(base, "clone", "-q", "origin.git", "repo");
  const root = join(base, "repo");
  git(root, "config", "user.email", "t@example.invalid");
  git(root, "config", "user.name", "t");
  mkdirSync(join(root, ".omi"));
  writeFileSync(
    join(root, ".omi", "config.yaml"),
    "github:\n  owner: o\n  repo: repo\n  projectNumber: 2\n",
  );
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "init");
  git(root, "push", "-q", "origin", "main");
  mkdirSync(join(root, ".claude-plugin"));
  writeFileSync(
    join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "p", version }),
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: pkg }));
  writeFileSync(join(root, "CHANGELOG.md"), `# Changelog\n\n${changelog}\n`);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "release");
  git(root, "push", "-q", "origin", "HEAD:develop");
  return root;
}

function fakeGh(o: { open?: number; merged?: string; state?: "OPEN" | "CLOSED" } = {}) {
  const calls: string[][] = [];
  const ok = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const run: GhRunner = (args) => {
    calls.push(args);
    if (args[0] === "issue") return { status: 0, stdout: "", stderr: "" };
    const query = (args[3] ?? "").slice("query=".length);
    const n = Number(/number=(\d+)/.exec(args.join(" "))?.[1]);
    if (query.includes("viewerPermission")) {
      const pr = o.merged && {
        id: "PR",
        number: 9,
        url: "https://github.com/o/repo/pull/9",
        state: "MERGED",
        isDraft: false,
        merged: true,
        mergedAt: "2026-11-18T00:00:00Z",
        mergeable: "UNKNOWN",
        reviewDecision: null,
        baseRefName: "main",
        headRefName: "develop",
        headRefOid: o.merged,
        body: prBody("o/repo", 7),
        mergeCommit: { oid: o.merged },
        labels: { nodes: [] },
        commits: { nodes: [] },
      };
      return ok({
        repository: {
          isPrivate: false,
          viewerPermission: "WRITE",
          squashMergeAllowed: true,
          mergeCommitAllowed: true,
          rebaseMergeAllowed: false,
          ref: null,
          pullRequests: { nodes: pr ? [pr] : [] },
        },
      });
    }
    const item = { id: `ITEM_${n}`, project: { number: 2, owner: { login: "o" } } };
    if (query.includes("blockedBy")) {
      const milestone = n === 1;
      return ok({
        repository: {
          issue: {
            number: n,
            title: milestone ? "Milestone-0001-M" : "Release-0001-R",
            state: milestone ? "OPEN" : (o.state ?? "OPEN"),
            body: "",
            issueType: null,
            labels: {
              totalCount: 1,
              nodes: [{ name: milestone ? "type:milestone" : "type:release" }],
            },
            parent: milestone
              ? null
              : { number: 1, state: "OPEN", repository: { nameWithOwner: "o/repo" } },
            subIssuesSummary: milestone
              ? { total: 3, completed: 3 - (o.open ?? 1) }
              : { total: 0, completed: 0 },
            blockedBy: { totalCount: 0, nodes: [] },
            projectItems: {
              totalCount: 1,
              nodes: [{ ...item, isArchived: false, fieldValueByName: null }],
            },
          },
        },
      });
    }
    if (query.includes('field(name:"Status")')) {
      const options = ["In Progress", "In Review", "Done"].map((name) => ({ id: name, name }));
      return ok({ repositoryOwner: { projectV2: { id: "P", field: { id: "F", options } } } });
    }
    if (query.includes("updateProjectV2ItemFieldValue")) {
      return ok({ updateProjectV2ItemFieldValue: { projectV2Item: { id: "x" } } });
    }
    return ok({
      repository: {
        issue: {
          number: n,
          parent: null,
          projectItems: { nodes: [{ ...item, fieldValueByName: { name: "In Review" } }] },
        },
      },
    });
  };
  return { run, calls };
}

const summary = (checks: { name: string; status: string }[]) =>
  checks.map((c) => `${c.name}:${c.status}`);

test("newer compares X.Y.Z numerically", () => {
  assert.equal(newer("0.10.0", "0.9.9"), true);
  assert.equal(newer("1.0.0", "1.0.0"), false);
  assert.equal(newer("1.0.0-rc.1", "0.9.0"), true);
  assert.equal(newer("x", "0.1.0"), false);
});

test("release check: green when develop carries a new, consistent, changelogged version", () => {
  const root = repo();
  assert.deepEqual(summary(releaseCheck({ cwd: root, gh: fakeGh().run }, 7)), [
    "state:pass",
    "version:pass",
    "changelog:pass",
    "tag:pass",
    "ahead:pass",
    "milestone:pass",
  ]);
});

test("release check: version mismatch, missing changelog, open Milestone work fail", () => {
  const root = repo("0.2.0", "0.1.0", "## [Unreleased]");
  const checks = releaseCheck({ cwd: root, gh: fakeGh({ open: 2 }).run }, 7);
  assert.deepEqual(summary(checks), [
    "state:pass",
    "version:fail",
    "changelog:fail",
    "tag:pass",
    "ahead:pass",
    "milestone:fail",
  ]);
});

test("release check: an existing or newer tag blocks the version", () => {
  const root = repo();
  git(root, "tag", "p--v0.2.0", "origin/main");
  git(root, "tag", "-a", "p--v0.3.0", "origin/main", "-m", "x");
  git(root, "push", "-q", "origin", "--tags");
  const tag = releaseCheck({ cwd: root, gh: fakeGh().run }, 7).find((c) => c.name === "tag");
  assert.equal(tag?.status, "fail");
  assert.match(tag?.detail ?? "", /already exists/);
  git(root, "push", "-q", "origin", ":refs/tags/p--v0.2.0");
  const older = releaseCheck({ cwd: root, gh: fakeGh().run }, 7).find((c) => c.name === "tag");
  assert.match(older?.detail ?? "", /not newer than the latest release 0\.3\.0/);
});

test("release tag: tags the merge commit, pushes, closes the Issue; re-run is a no-op", () => {
  const root = repo();
  const sha = git(root, "rev-parse", "origin/develop");
  const gh = fakeGh({ merged: sha });
  const r = releaseTag({ cwd: root, gh: gh.run }, 7);
  assert.equal(r.tag, "p--v0.2.0");
  assert.equal(r.created, true);
  assert.equal(r.closed, true);
  assert.equal(git(root, "ls-remote", "origin", "refs/tags/p--v0.2.0^{}").split("\t")[0], sha);
  assert.ok(gh.calls.some((a) => a[0] === "issue" && a[1] === "close" && a[2] === "7"));

  const again = releaseTag({ cwd: root, gh: fakeGh({ merged: sha, state: "CLOSED" }).run }, 7);
  assert.equal(again.created, false);
  assert.equal(again.closed, false);
});

test("release tag: refused without a merged release PR or when the tag points elsewhere", () => {
  const root = repo();
  const code = (fn: () => unknown) => {
    try {
      fn();
    } catch (e) {
      return (e as { code: string }).code;
    }
    return "no-throw";
  };
  assert.equal(
    code(() => releaseTag({ cwd: root, gh: fakeGh().run }, 7)),
    "POLICY_VIOLATION",
  );
  git(root, "tag", "p--v0.2.0", "origin/main");
  git(root, "push", "-q", "origin", "--tags");
  const sha = git(root, "rev-parse", "origin/develop");
  assert.equal(
    code(() => releaseTag({ cwd: root, gh: fakeGh({ merged: sha }).run }, 7)),
    "POLICY_VIOLATION",
  );
});
