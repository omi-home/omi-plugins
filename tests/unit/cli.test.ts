// T2.1 CLI golden output and exit-code matrix, through the real bin/omi launcher.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { atLeast } from "../../runtime/cli/doctor.ts";
import { HELP } from "../../runtime/cli/main.ts";

const bin = fileURLToPath(new URL("../../bin/omi", import.meta.url));
const VERSION = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
  .version as string;

const omi = (args: string[], cwd = tmpdir()) => {
  const r = spawnSync(process.execPath, [bin, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
};

test("golden: help and version, human and json", () => {
  assert.deepEqual(omi(["--help"]), { code: 0, stdout: HELP, stderr: "" });
  assert.deepEqual(omi(["version"]), { code: 0, stdout: `omi ${VERSION}\n`, stderr: "" });
  assert.deepEqual(omi(["version", "--output", "json"]), {
    code: 0,
    stdout: `{"ok":true,"command":"version","data":{"omi":"${VERSION}"}}\n`,
    stderr: "",
  });
  assert.equal(
    omi(["help"]).stdout,
    `Usage: omi <command> [--output human|json]

Commands:
  doctor                 Check tools, repository, AGENTS.md, .omi/config.yaml and GitHub access
  ticket validate <n>    Check Issue #n against the ticket-first gates (no changes)
  task start <n>         Validate Issue #n, create or reuse its run and worktree, mark it In Progress
  task status <n>        Show the local run, worktree and transitions of Issue #n
  task run <n>           Start Issue #n and drive Engineer → checks → Reviewer (→ Architect) until
                         it needs a person (In QA, Waiting PO, Blocked). Runs agents: spends tokens.
                         --from-source loads the agents from this checkout instead of the installed plugin
  pr create <n>          Push Issue #n's task branch, create or reuse its PR → develop (Release: develop →
                         main) and verify base, head and the one primary Issue; marks it In Review.
                         --title <text> (default: Issue title), --body-file <path> (extra PR description)
  version                Print the OMI version
  help                   Show this help

Exit codes: 0 ok, 1 failed check or error, 2 usage error, 75 transient error (retry)
`,
  );
});

const matrix: [string[], number, string | null][] = [
  [["--help"], 0, null],
  [["-h"], 0, null],
  [["help"], 0, null],
  [["version"], 0, null],
  [["version", "--output=json"], 0, null],
  [[], 2, "USAGE_INVALID"],
  [["bogus"], 2, "USAGE_INVALID"],
  [["version", "extra"], 2, "USAGE_INVALID"],
  [["version", "--bogus"], 2, "USAGE_INVALID"],
  [["version", "--output", "xml"], 2, "USAGE_INVALID"],
  [["doctor"], 1, null], // tmpdir is not a git repository
  [["task"], 2, "USAGE_INVALID"],
  [["task", "bogus", "5"], 2, "USAGE_INVALID"],
  [["task", "start"], 2, "USAGE_INVALID"],
  [["task", "start", "abc"], 2, "USAGE_INVALID"],
  [["ticket", "validate", "0"], 2, "USAGE_INVALID"],
  [["task", "start", "5", "extra"], 2, "USAGE_INVALID"],
  [["task", "status", "#5"], 1, "CONFIG_INVALID"], // not a git repository
];

test("exit-code matrix", () => {
  for (const [args, code, error] of matrix) {
    const human = omi(args);
    assert.equal(human.code, code, `omi ${args.join(" ")}`);
    if (error) {
      assert.equal(human.stdout, "");
      assert.match(human.stderr, new RegExp(`^omi: ${error}: `));
    }
    // An invalid --output value cannot select JSON, so that row is human-only.
    if (args.some((a) => a.startsWith("--output") && a !== "--output=json")) continue;
    const out = args.includes("--output=json") ? args : [...args, "--output", "json"];
    const json = omi(out);
    assert.equal(json.code, code, `omi ${out.join(" ")}`);
    assert.equal(json.stderr, "");
    const doc = JSON.parse(json.stdout);
    assert.equal(doc.ok, code === 0);
    if (error) assert.equal(doc.error.code, error);
  }
});

test("usage errors redact echoed arguments", () => {
  const tok = `ghp_${"t".repeat(36)}`;
  const r = omi([tok, "--output", "json"]);
  assert.equal(r.code, 2);
  assert.ok(!r.stdout.includes(tok), r.stdout);
});

test("atLeast compares semver numerically", () => {
  assert.ok(atLeast("2.1.325 (Claude Code)", "2.1.277"));
  assert.ok(atLeast("22.18.0", "22.18.0"));
  assert.ok(!atLeast("2.1.99", "2.1.277"));
  assert.ok(!atLeast("garbage", "1.0.0"));
});
