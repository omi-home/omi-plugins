// The runtime's commit guard (#262) refuses `.omi-plugins/` at the repo root and any untracked one,
// but lets an already tracked template under `templates/` through (carried finding, run 329).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { commitWork, unsafeReason } from "../../../runtime/task-run/adapters/commit.ts";

const TEMPLATE = "templates/workspace/.omi-plugins/omi.config.yaml";
const git = (cwd: string, ...a: string[]) =>
  execFileSync("git", a, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const put = (dir: string, rel: string, body: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), body);
};
const info = {
  type: "dev-task",
  title: "t",
  issue: 1,
  round: 1,
  attempt: 1,
  stepId: "implement",
  scope: "backend",
  model: "m",
};

function repoWithTemplate() {
  const dir = mkdtempSync(join(tmpdir(), "omi-commit-"));
  git(dir, "init", "-q", "-b", "develop");
  git(dir, "config", "user.email", "t@example.invalid");
  git(dir, "config", "user.name", "t");
  put(dir, TEMPLATE, "a: 1\n");
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "base");
  return dir;
}

test("unsafeReason: .omi-plugins/ at the root is refused, nested only when tracked", () => {
  assert.equal(unsafeReason(".omi-plugins/omi.config.yaml"), "inside .omi-plugins/");
  assert.equal(unsafeReason(".omi-plugins/omi.config.yaml", true), "inside .omi-plugins/");
  assert.equal(unsafeReason(TEMPLATE), "inside .omi-plugins/");
  assert.equal(unsafeReason(TEMPLATE, true), undefined);
  assert.equal(unsafeReason("a/.git/config", true), "inside .git/");
  assert.equal(unsafeReason(".env"), "looks like a secret file");
  assert.equal(unsafeReason("src/ok.ts"), undefined);
});

test("commitWork: a tracked template under templates/ can be edited and committed", () => {
  const dir = repoWithTemplate();
  put(dir, TEMPLATE, "a: 2\n");
  const sha = commitWork(dir, info);
  assert.match(String(sha), /^[0-9a-f]{7,40}$/);
  assert.equal(git(dir, "show", `HEAD:${TEMPLATE}`), "a: 2");
});

test("commitWork: an untracked .omi-plugins/ file, at the root or nested, is still refused", () => {
  const dir = repoWithTemplate();
  put(dir, ".omi-plugins/omi.config.yaml", "x: 1\n");
  put(dir, "docs/.omi-plugins/new.yaml", "x: 1\n");
  assert.throws(() => commitWork(dir, info), {
    code: "POLICY_VIOLATION",
    message:
      /\.omi-plugins\/omi\.config\.yaml \(inside \.omi-plugins\/\).*docs\/\.omi-plugins\/new\.yaml/,
  });
  assert.equal(git(dir, "status", "--porcelain").includes("A "), false, "nothing was staged");
});
