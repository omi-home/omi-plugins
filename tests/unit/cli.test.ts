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
  task run <n>           Start Issue #n and drive its planned Engineer (label role:*) → checks → Code
                         Reviewer (→ Security Reviewer when risk:high/security or asked) (→ Architect)
                         → release validation (→ Manual QA for bugs, ui, qa:manual) until In Review
                         or it needs a person (Waiting PO, Blocked). Runs agents: spends tokens.
                         --from-source loads the agents from this checkout instead of the installed plugin
  task analyze <n>       Feature / Change Request / FR / NFR #n: BA (→ UI/UX with label ui) (→ Architect)
                         write their sections into the Issue body, then Waiting PO. No worktree.
                         Runs agents: spends tokens. --from-source as for task run
  task unblock <n>       Clear a BLOCKED run of Issue #n (a person decided): resume it through the FSM,
                         post one report (who, --reason <text>); the next \`task run\` re-runs the step
                         that reported BLOCKED
  task finalize <n>      After Issue #n's PR is merged: verify the merge receipt, clean the owned
                         worktree, branch and temp dirs safely (no --force), post one cleanup report,
                         then Done + parent roll-up. --dry-run shows the cleanup plan only
  pr create <n>          Push Issue #n's task branch, create or reuse its PR → develop (Release: develop →
                         main) and verify base, head and the one primary Issue; marks it In Review.
                         --title <text> (default: Issue title), --body-file <path> (extra PR description)
  pr validate <n>        Read-only merge eligibility of Issue #n's task PR: state, base, primary
                         Issue, tip, conflicts, CI, reviews, merge method, protection, risk
  pr merge <n>           Merge Issue #n's task PR when every gate passes (configured method, pinned
                         to the validated head); risk:high goes to Waiting PO and is not merged
  issue create           Create an Issue: --type <OMI type> --title <text> --body-file <path>
                         [--parent <n|owner/repo#n>]. Numbered <IssueType>-<NNNN>- per type, linked
                         as a sub-issue (hierarchy matrix checked first), added to the Project.
                         Re-running with the same type and title completes the same Issue
  issue depend <n> --on <m|owner/repo#m>
                         Record that Issue #n is blocked by #m (native dependency; another repo is
                         fine). Refuses cycles; re-running is a no-op. \`ticket validate\` then holds
                         #n until #m is closed
  issue findings <n>     List the findings other tasks carried over to Issue #n
                         (<!-- omi:carried-findings=... --> comments: source | finding | action)
  issue section get <n> <name>   Print the <!-- omi:section=<name> --> section of Issue #n
  issue section set <n> <name>   Replace (or append) that section with --body-file <path>
  github project init [--title <text>]
                         Bootstrap this repo into OMI: find or create the Project (title, default: repo
                         name), link it, write .omi/config.yaml and install templates/github/ into .github/
                         where missing. Re-running changes nothing; never overwrites a file
  github project plan    Diff the Project's custom fields (config/github/project.yaml), views, built-in
                         workflows and Insights (views.yaml) and list items whose Status their type does
                         not use (status-transitions.yaml). Read-only; exits 1 while anything is pending,
                         manual or drifting. \`project plan\` is an alias
  github project apply   Create missing fields, options and views (by name + layout); never deletes. View
                         filters/grouping/sort, workflows, iteration fields and conflicts are printed as
                         manual steps (exit 1); Insights as unsupported. \`project apply\` is an alias
  github project validate
                         The same diff as checks (extra fields/views and Insights: warnings)
  github repo plan       Diff the repository's labels, main/develop protection and merge methods against
                         config/github/repository.yaml. Read-only; exits 1 while anything differs
  github repo apply --approved-plan <file>
                         Apply exactly the plan the PO approved (\`github repo plan --output json\`
                         saved to <file>): adds labels, tightens protection, sets merge methods; never
                         deletes or loosens. Refused when the plan changed since approval
  github repo validate   The same diff as checks (private repo on Free: protection unsupported, D5)
  handoff show           Print the newest session handoff (comment opening <!-- omi:handoff=... -->)
                         found in the repository; none is not an error
  handoff post --body-file <path> [--milestone <n>]
                         Post the handoff on the active Milestone (the one open Milestone In Progress or
                         In Review) with marker <date>-s<N>; the same text again changes nothing, a text
                         opening with an existing marker updates that comment. Redacted
  cleanup scan           Inventory open runs, owned worktrees, merged-but-uncleaned tasks, unposted
                         reports, attempts left open by a crash, orphan and prunable worktrees
  cleanup apply --safe   Recover crashed attempts, post pending reports, finalize merged tasks and
                         prune missing worktrees; orphans are reported, never removed
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
  [["issue"], 2, "USAGE_INVALID"],
  [["issue", "create", "--title", "x"], 2, "USAGE_INVALID"], // no --type
  [["issue", "create", "--type", "bogus", "--title", "x"], 2, "USAGE_INVALID"],
  [["issue", "create", "--type", "dev-task", "--body-file", "nope.md"], 2, "USAGE_INVALID"],
  [["issue", "section", "bogus", "5", "x"], 2, "USAGE_INVALID"],
  [["issue", "section", "get", "5", "Bad Name"], 2, "USAGE_INVALID"],
  [["issue", "section", "set", "5", "x", "--body-file", "nope.md"], 2, "USAGE_INVALID"],
  [["issue", "section", "get", "5", "x"], 1, "CONFIG_INVALID"], // not a git repository
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
