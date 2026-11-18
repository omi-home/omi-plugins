// DevTask-0031 #63: `omi github project init` on a fresh checkout against a fake gh: creates the
// Project once, links once (by node ID), writes config + templates without overwriting; a re-run
// changes nothing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { GhRunner } from "../../runtime/adapters/github/client.ts";
import { projectInit } from "../../runtime/cli/init.ts";
import { loadConfig } from "../../runtime/core/config.ts";
import type { OmiError } from "../../runtime/core/errors/errors.ts";

function checkout(remote = "git@github.com:acme/app.git") {
  const dir = mkdtempSync(join(tmpdir(), "omi-init-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: dir });
  return dir;
}

interface P {
  id: string;
  number: number;
  title: string;
}

function fakeGh(projects: P[] = [], linked: string[] = []) {
  const calls: string[] = [];
  const out = (data: unknown) => ({ status: 0, stdout: JSON.stringify({ data }), stderr: "" });
  const arg = (args: string[], k: string) =>
    args.find((a) => a.startsWith(`${k}=`))?.slice(k.length + 1) ?? "";
  const run: GhRunner = (args) => {
    const q = arg(args, "query");
    if (args[0] === "project" && args[1] === "create") {
      const title = args[args.indexOf("--title") + 1] as string;
      projects.push({ id: "PVT7", number: 7, title });
      calls.push(`create ${title}`);
      return { status: 0, stdout: "{}", stderr: "" };
    }
    if (args[0] === "project" && args[1] === "link") {
      linked.push(projects.find((p) => p.number === Number(args[2]))?.id ?? "?");
      calls.push(`link ${args[2]} ${args[args.indexOf("--repo") + 1]}`);
      return { status: 0, stdout: "{}", stderr: "" };
    }
    if (q.includes("projectsV2(first:100,query")) {
      const hits = projects.filter((p) => p.title.includes(arg(args, "q")));
      return out({ repositoryOwner: { projectsV2: { nodes: hits } } });
    }
    if (q.includes("repository(owner")) {
      return out({ repository: { projectsV2: { nodes: linked.map((id) => ({ id })) } } });
    }
    if (q.includes("projectV2(number")) {
      const p = projects.find((x) => x.number === Number(arg(args, "number"))) ?? null;
      return out({ repositoryOwner: { projectV2: p } });
    }
    throw new Error(`unexpected gh ${args.join(" ").slice(0, 80)}`);
  };
  return { run, calls };
}

test("fresh repo: create + link + config + templates; second run writes nothing", () => {
  const dir = checkout();
  mkdirSync(join(dir, ".github"));
  writeFileSync(join(dir, ".github", "PULL_REQUEST_TEMPLATE.md"), "ours\n");
  const gh = fakeGh();

  const r = projectInit({ cwd: dir, title: "App delivery" }, gh.run);
  assert.deepEqual(gh.calls, ["create App delivery", "link 7 acme/app"]);
  assert.equal(r.config, "created");
  assert.deepEqual(loadConfig(dir).github, {
    owner: "acme",
    repo: "app",
    projectNumber: 7,
    privateRepoRiskAccepted: false,
  });
  assert.ok(r.templates.copied.includes(".github/ISSUE_TEMPLATE/dev-task.yml"));
  assert.deepEqual(r.templates.kept, [".github/PULL_REQUEST_TEMPLATE.md"]);
  assert.equal(readFileSync(join(dir, ".github", "PULL_REQUEST_TEMPLATE.md"), "utf8"), "ours\n");

  const again = projectInit({ cwd: dir }, gh.run);
  assert.equal(gh.calls.length, 2, "no second create or link");
  assert.deepEqual(again.project, { number: 7, title: "App delivery", created: false });
  assert.equal(again.config, "kept");
  assert.deepEqual(again.templates.copied, []);
});

test("existing Project reused by exact title (default: repo name); link compares node IDs", () => {
  const dir = checkout();
  // Linked to another owner's Project #3: same number, different ID → still linked here.
  const gh = fakeGh(
    [
      { id: "A", number: 3, title: "app" },
      { id: "B", number: 4, title: "app old" },
    ],
    ["USER3"],
  );
  const r = projectInit({ cwd: dir }, gh.run);
  assert.deepEqual(gh.calls, ["link 3 acme/app"]);
  assert.equal(r.project.created, false);
});

test("a repo name YAML would read as a number stays a string in the config", () => {
  const dir = checkout("https://github.com/acme/2048.git");
  projectInit({ cwd: dir }, fakeGh([{ id: "A", number: 1, title: "2048" }]).run);
  assert.equal(loadConfig(dir).github.repo, "2048");
});

test("refused, nothing written: ambiguous title, missing configured Project, other title", () => {
  const twice = checkout();
  const dup = fakeGh([
    { id: "A", number: 1, title: "app" },
    { id: "B", number: 2, title: "app" },
  ]);
  assert.throws(
    () => projectInit({ cwd: twice }, dup.run),
    (e: OmiError) => e.code === "CONFIG_INVALID" && /2 Projects/.test(e.message),
  );
  assert.throws(
    () => projectInit({ cwd: twice, title: " " }, dup.run),
    (e: OmiError) => e.code === "USAGE_INVALID",
  );
  assert.equal(existsSync(join(twice, ".omi")), false);

  const gone = checkout();
  mkdirSync(join(gone, ".omi"));
  writeFileSync(
    join(gone, ".omi", "config.yaml"),
    "github:\n  owner: acme\n  repo: app\n  projectNumber: 9\n",
  );
  assert.throws(
    () => projectInit({ cwd: gone }, fakeGh().run),
    (e: OmiError) => e.code === "CONFIG_INVALID" && /#9/.test(e.message),
  );
  assert.throws(
    () =>
      projectInit(
        { cwd: gone, title: "Other" },
        fakeGh([{ id: "A", number: 9, title: "app" }]).run,
      ),
    (e: OmiError) => e.code === "CONFIG_INVALID" && /'app', not 'Other'/.test(e.message),
  );
  assert.equal(existsSync(join(gone, ".github")), false);
});
