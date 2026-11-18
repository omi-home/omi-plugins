// DevTask-0031 #63: `omi github project init` on a fresh checkout against a fake gh: creates the
// Project once, links once, writes config + templates without overwriting; re-run changes nothing.
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

function checkout() {
  const dir = mkdtempSync(join(tmpdir(), "omi-init-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["remote", "add", "origin", "git@github.com:acme/app.git"], { cwd: dir });
  return dir;
}

function fakeGh(projects: { number: number; title: string }[] = []) {
  const calls: string[] = [];
  const linked: number[] = [];
  const out = (data: unknown) => ({ status: 0, stdout: JSON.stringify(data), stderr: "" });
  const run: GhRunner = (args) => {
    const q = args.find((a) => a.startsWith("query=")) ?? "";
    if (args[0] === "project" && args[1] === "list") return out({ projects, totalCount: 0 });
    if (args[0] === "project" && args[1] === "create") {
      const p = { number: 7, title: args[args.indexOf("--title") + 1] as string };
      projects.push(p);
      calls.push(`create ${p.title}`);
      return out({ ...p, url: "u", id: "PVT" });
    }
    if (args[0] === "project" && args[1] === "link") {
      linked.push(Number(args[2]));
      calls.push(`link ${args[2]} ${args[args.indexOf("--repo") + 1]}`);
      return out({});
    }
    if (q.includes("projectsV2(first:100)")) {
      return out({
        data: { repository: { projectsV2: { nodes: linked.map((number) => ({ number })) } } },
      });
    }
    if (q.includes("projectV2(number")) {
      const n = Number(args.find((a) => a.startsWith("number="))?.slice(7));
      const p = projects.find((x) => x.number === n) ?? null;
      return out({ data: { repositoryOwner: { projectV2: p } } });
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

test("an existing Project with the title is reused (default title: repo name)", () => {
  const dir = checkout();
  const gh = fakeGh([{ number: 3, title: "app" }]);
  const r = projectInit({ cwd: dir }, gh.run);
  assert.deepEqual(gh.calls, ["link 3 acme/app"]);
  assert.equal(r.project.created, false);
});

test("ambiguous title or a configured Project that does not exist: refused, nothing written", () => {
  const twice = checkout();
  assert.throws(
    () =>
      projectInit(
        { cwd: twice },
        fakeGh([
          { number: 1, title: "app" },
          { number: 2, title: "app" },
        ]).run,
      ),
    (e: OmiError) => e.code === "CONFIG_INVALID" && /2 Projects/.test(e.message),
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
  assert.equal(existsSync(join(gone, ".github")), false);
});
