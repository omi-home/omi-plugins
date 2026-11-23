// TestTask-0003 #399: QA verification of Bug-0012 #391 (reviewer shell readers read outside the
// task workspace). Test case codes `TC-391-<n>` (ChangeRequest-0013 #302 §3.2). The workspace and
// repo are passed explicitly: the tests never read CLAUDE_PROJECT_DIR / OMI_REPO from the environment.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { LaunchRequest } from "../../../runtime/harness/domain/harness.ts";
import { agentPreToolUse } from "../../../runtime/hook/cli/hook.ts";
import type { Role } from "../../../runtime/shared/contracts.ts";
import { prepareAgent } from "../../../runtime/task-run/application/slice.ts";

const pluginRoot = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
const SHELL_READERS = /^Bash\((?:cat|grep|head|tail|wc)(?:[ )])/;

/** The `--allowedTools` rules prepareAgent grants a role, captured through a fake harness. */
function granted(role: Role, edits = false): string[] {
  let request: LaunchRequest | undefined;
  const taskRoot = mkdtempSync(join(tmpdir(), "omi-tc391-"));
  prepareAgent({
    harness: {
      launch: (r) => {
        request = r;
        return { command: "x", args: [], cwd: taskRoot, env: {}, configDir: taskRoot, stdin: "" };
      },
    },
    roleFiles: { writeRoleFiles: () => undefined },
    pluginRoot,
    role,
    category: "review",
    edits,
    checks: [],
    taskRoot,
    worktree: join(taskRoot, "app"),
    prompt: "p",
  });
  return request?.allowedTools ?? [];
}

const ws = realpathSync.native(mkdtempSync(join(tmpdir(), "omi-tc391-ws-")));
const REASON = "OMI: agents run git only on paths inside their task workspace.";
const bash = (command: string, repo = "app") =>
  agentPreToolUse({ cwd: ws, tool_name: "Bash", tool_input: { command } }, ws, repo);

test("TC-391-01: code-reviewer and security-reviewer get no cat/grep/head/tail/wc rule", () => {
  for (const role of ["code-reviewer", "security-reviewer"] as const) {
    const rules = granted(role);
    assert.ok(rules.length > 0, `${role}: has read-only git rules`);
    assert.deepEqual(
      rules.filter((r) => SHELL_READERS.test(r)),
      [],
      role,
    );
    assert.ok(rules.includes("Bash(git diff *)"), `${role}: read-only git stays`);
  }
});

test("TC-391-02: the hook refuses git forms that read outside the workspace", () => {
  for (const c of [
    "git diff --no-index /dev/null x",
    "git diff a/../../x y",
    "timeout 5 git diff ~/x y",
    '"C:\\Git\\bin\\git.exe" diff --no-index /dev/null x',
  ]) {
    assert.equal(bash(c), REASON, c);
  }
});

test("TC-391-03: the hook still allows ordinary read-only git", () => {
  for (const c of ["git diff origin/develop...HEAD", "git show abc123:runtime/a.ts"]) {
    assert.equal(bash(c), null, c);
  }
});

test("TC-391-04: steps to reproduce - a reviewer cannot read a secret file by shell or git", () => {
  // Bug-0012 steps: `cat ~/.ssh/id_rsa`, `grep -r token <dir outside the workspace>`. They are not
  // granted (TC-391-01); the granted git route to the same files is refused too.
  const rules = granted("code-reviewer");
  for (const c of ["cat ~/.ssh/id_rsa", `grep -r token ${tmpdir()}`]) {
    assert.ok(!rules.some((r) => r.startsWith(`Bash(${c.split(" ")[0]}`)), c);
  }
  for (const c of [
    "git diff --no-index /dev/null ~/.ssh/id_rsa",
    "git show HEAD:../../.ssh/id_rsa",
    "git -C /tmp log",
  ]) {
    assert.equal(bash(c), REASON, c);
  }
});
