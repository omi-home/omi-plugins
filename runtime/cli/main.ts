// OMI CLI entry. Pure function of argv/cwd → {code, stdout, stderr}; bin/omi does the I/O.
// Everything leaving the process goes through redact.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ERROR_CODES, OmiError } from "../core/errors/errors.ts";
import { redact, redactDeep } from "../reporting/redact.ts";
import { cleanupApply, cleanupScan, type ScanResult } from "./cleanup.ts";
import { type Check, doctor } from "./doctor.ts";
import {
  prCreate,
  prMerge,
  prValidate,
  taskFinalize,
  taskRun,
  taskStart,
  taskStatus,
  ticketValidate,
} from "./task.ts";

const humanScan = (s: ScanResult) => [
  ...s.runs.map(
    (r) =>
      `#${String(r.issue).padEnd(5)} ${r.state.padEnd(16)} ${[
        r.mergedPr ? `merged PR #${r.mergedPr}` : "not merged",
        r.worktree ? `worktree${r.worktree.exists ? "" : " (missing)"}` : "no worktree",
        r.pendingReports ? `${r.pendingReports} pending report(s)` : "",
        r.openAttempts ? `${r.openAttempts} open attempt(s)` : "",
        r.leased ? "leased (running)" : "",
      ]
        .filter(Boolean)
        .join(", ")}`,
  ),
  ...s.orphans.map((p) => `orphan    ${p} (not owned: left alone)`),
  ...s.prunable.map((p) => `prunable  ${p}`),
];

export const HELP = `Usage: omi <command> [--output human|json]

Commands:
  doctor                 Check tools, repository, AGENTS.md, .omi/config.yaml and GitHub access
  ticket validate <n>    Check Issue #n against the ticket-first gates (no changes)
  task start <n>         Validate Issue #n, create or reuse its run and worktree, mark it In Progress
  task status <n>        Show the local run, worktree and transitions of Issue #n
  task run <n>           Start Issue #n and drive Engineer → checks → Reviewer (→ Architect) until
                         it needs a person (In QA, Waiting PO, Blocked). Runs agents: spends tokens.
                         --from-source loads the agents from this checkout instead of the installed plugin
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
  cleanup scan           Inventory open runs, owned worktrees, merged-but-uncleaned tasks, unposted
                         reports, attempts left open by a crash, orphan and prunable worktrees
  cleanup apply --safe   Recover crashed attempts, post pending reports, finalize merged tasks and
                         prune missing worktrees; orphans are reported, never removed
  version                Print the OMI version
  help                   Show this help

Exit codes: 0 ok, 1 failed check or error, 2 usage error, 75 transient error (retry)
`;

export const EXIT = { ok: 0, failed: 1, usage: 2, transient: 75 } as const;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

const VERSION: string = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
).version;

/** 0 when nothing failed; 75 when every failure is transient (retry helps); else 1. */
const checksExit = (checks: Check[]) => {
  const failed = checks.filter((c) => c.status === "fail");
  if (!failed.length) return EXIT.ok;
  return failed.every((c) => c.code && ERROR_CODES[c.code].transient)
    ? EXIT.transient
    : EXIT.failed;
};

const issueArg = (a: string | undefined) => {
  const m = /^#?(\d+)$/.exec(a ?? "");
  if (!m || Number(m[1]) < 1) throw new OmiError("USAGE_INVALID", "expected an issue number");
  return Number(m[1]);
};

/** Subcommands: <group> <action> <issue>. */
const NESTED = new Set([
  "ticket validate",
  "task start",
  "task status",
  "task run",
  "task finalize",
  "pr create",
  "pr validate",
  "pr merge",
]);
/** Subcommands without an issue: <group> <action>. */
const REPO_WIDE = new Set(["cleanup scan", "cleanup apply"]);

const lines = (l: string[]) => l.map((s) => `${s}\n`).join("");

const humanChecks = (checks: Check[]) =>
  checks
    .map((c) => `${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(18)} ${c.detail}\n`)
    .join("");

export function main(argv: string[], cwd = process.cwd()): CliResult {
  // Decided before parsing so that usage errors are structured too.
  const json = argv.some(
    (a, i) => a === "--output=json" || (a === "json" && argv[i - 1] === "--output"),
  );
  let command = "";
  const envelope = (body: object) =>
    `${JSON.stringify(redactDeep({ ok: false, command, ...body }))}\n`;
  const ok = (data: unknown, human: string, code: number = EXIT.ok): CliResult => ({
    code,
    stdout: json ? envelope({ ok: code === EXIT.ok, data }) : redact(human),
    stderr: "",
  });

  try {
    let parsed: ReturnType<typeof parse>;
    try {
      parsed = parse(argv);
    } catch (e) {
      throw new OmiError("USAGE_INVALID", (e as Error).message);
    }
    const { values, positionals } = parsed;
    if (values.output !== "human" && values.output !== "json") {
      throw new OmiError("USAGE_INVALID", "--output must be human or json");
    }
    command = values.help ? "help" : (positionals[0] ?? "");
    let rest = positionals.slice(1);
    if (
      !values.help &&
      (NESTED.has(`${command} ${rest[0]}`) || REPO_WIDE.has(`${command} ${rest[0]}`))
    ) {
      command = `${command} ${rest[0]}`;
      rest = rest.slice(1);
    } else if (["ticket", "task", "pr", "cleanup"].includes(command)) {
      throw new OmiError("USAGE_INVALID", `unknown ${command} action: ${rest[0] ?? "(none)"}`);
    }
    const issue = NESTED.has(command) ? issueArg(rest.shift()) : 0;
    if (rest.length) throw new OmiError("USAGE_INVALID", `unexpected argument: ${rest[0]}`);

    switch (command) {
      case "help":
        return ok({ help: HELP }, HELP);
      case "version":
        return ok({ omi: VERSION }, `omi ${VERSION}\n`);
      case "doctor": {
        const checks = doctor(cwd);
        return ok({ checks }, humanChecks(checks), checksExit(checks));
      }
      case "ticket validate": {
        const checks = ticketValidate({ cwd }, issue);
        return ok({ issue, checks }, humanChecks(checks), checksExit(checks));
      }
      case "task start": {
        const r = taskStart({ cwd }, issue);
        const human = [
          `run       ${r.run.id} (${r.run.state})`,
          `worktree  ${r.workspace.path}${r.workspace.reused ? " (reused)" : ""}${r.workspace.dirty ? " (dirty)" : ""}`,
          `branch    ${r.workspace.branch} @ base ${r.workspace.baseSha.slice(0, 12)}`,
          ...r.status.map((c) => `status    ${c.issue}: ${c.from ?? "unset"} → ${c.to}`),
        ];
        return ok(r, lines(human));
      }
      case "task status": {
        const st = taskStatus({ cwd }, issue);
        const human = st.run
          ? [
              `run       ${st.run.id} (${st.run.state})`,
              `worktree  ${st.worktree ? `${st.worktree.path}${st.worktree.exists ? "" : " (missing)"}` : "none"}`,
              `branch    ${st.branch ?? "none"}`,
              ...st.transitions.map((t) => `  ${t.from ?? "-"} → ${t.to} (${t.event})`),
            ]
          : [`no run for issue #${issue}`];
        return ok(st, lines(human));
      }
      case "task run": {
        const r = taskRun({ cwd, fromSource: values["from-source"] }, issue);
        const human = [
          `run       ${r.run.id} (${r.state}, round ${r.round})`,
          ...(r.status
            ? [`status    ${r.status.issue}: ${r.status.from ?? "unset"} → ${r.status.to}`]
            : []),
        ];
        return ok(r, lines(human));
      }
      case "pr create": {
        const file = values["body-file"];
        let body: string | undefined;
        try {
          body = file ? readFileSync(resolve(cwd, file), "utf8") : undefined;
        } catch {
          throw new OmiError("USAGE_INVALID", `cannot read --body-file ${file}`);
        }
        const r = prCreate({ cwd, title: values.title, body }, issue);
        const human = [
          `pr        ${r.pr.url}${r.created ? "" : " (existing)"}`,
          ...r.checks.map(
            (c) => `${c.status.toUpperCase().padEnd(5)} ${c.name.padEnd(10)} ${c.detail}`,
          ),
          ...(r.status
            ? [`status    ${r.status.issue}: ${r.status.from ?? "unset"} → ${r.status.to}`]
            : []),
        ];
        return ok(r, lines(human));
      }
      case "task finalize": {
        const r = taskFinalize({ cwd, dryRun: values["dry-run"] }, issue);
        const human = [
          `run       ${r.run.id} (${r.run.state})`,
          ...(r.cleanup?.steps.map(
            (s) => `${s.status.toUpperCase().padEnd(7)} ${s.name.padEnd(22)} ${s.detail ?? ""}`,
          ) ?? []),
          ...r.status.map((c) => `status    ${c.issue}: ${c.from ?? "unset"} → ${c.to}`),
        ];
        return ok(r, lines(human), r.cleanup?.state === "CLEANUP_FAILED" ? EXIT.failed : EXIT.ok);
      }
      case "cleanup scan": {
        const r = cleanupScan({ cwd });
        return ok(r, lines(humanScan(r)));
      }
      case "cleanup apply": {
        const r = cleanupApply({ cwd, safe: values.safe });
        const human = [
          ...r.outcomes.map(
            (o) =>
              `#${String(o.issue).padEnd(5)} ${o.error ? `FAIL ${o.error.code}: ${o.error.message}` : o.actions.join("; ")}`,
          ),
          ...(r.pruned ? ["git worktree prune"] : []),
          ...r.scan.orphans.map((p) => `orphan    ${p} (not owned: left alone)`),
        ];
        return ok(r, lines(human), r.outcomes.some((o) => o.error) ? EXIT.failed : EXIT.ok);
      }
      case "pr validate": {
        const r = prValidate({ cwd }, issue);
        return ok(r, `pr        ${r.pr ?? "none"}\n${humanChecks(r.checks)}`, checksExit(r.checks));
      }
      case "pr merge": {
        const r = prMerge({ cwd }, issue);
        const human = [
          `merged    ${r.receipt.url} (${r.receipt.headSha.slice(0, 12)} → ${r.receipt.mergeCommit?.slice(0, 12) ?? "?"})`,
        ];
        return ok(r, humanChecks(r.checks) + lines(human));
      }
      case "":
        throw new OmiError("USAGE_INVALID", "missing command (see `omi help`)");
      default:
        throw new OmiError("USAGE_INVALID", `unknown command: ${command} (see \`omi help\`)`);
    }
  } catch (e) {
    const err = e instanceof OmiError ? e : new OmiError("INTERNAL", "unexpected error");
    const code =
      err.code === "USAGE_INVALID" ? EXIT.usage : err.transient ? EXIT.transient : EXIT.failed;
    return json
      ? { code, stdout: envelope({ error: err.toJSON() }), stderr: "" }
      : { code, stdout: "", stderr: `omi: ${err.code}: ${err.message}\n` };
  }
}

const parse = (args: string[]) =>
  parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      output: { type: "string", default: "human" },
      help: { type: "boolean", short: "h" },
      "from-source": { type: "boolean" },
      title: { type: "string" },
      "body-file": { type: "string" },
      "dry-run": { type: "boolean" },
      safe: { type: "boolean" },
    },
  });
